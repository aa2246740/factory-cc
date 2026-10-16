#!/usr/bin/env -S node --import tsx
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { SdkRuntime } from "../src/runtime/sdk-runtime.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logging.js";
import { SessionStore } from "../src/sessions/store.js";
import { publicSelection } from "../src/upstream/providers.js";
import { summarizeUsage, type UsageLedgerEvent } from "../src/runtime/usage.js";
import type { ContentBlock, Message, ToolDefinition } from "../src/types.js";
import { resolveSelection } from "./e2e-lib.js";
import { ownDirectory, removeOwnedDirectory } from "./verify-relay.js";
import { trackOwnedProcesses } from "./e2e-processes.js";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: node --import tsx scripts/verify-native-schema.ts [--summary <new.json>]\nReal official Claude SDK BYOK schema-revision and cache probe; synthetic host fixture, not a Factory workflow. Requires explicit BRIDGE_UPSTREAM_BASE_URL, BRIDGE_UPSTREAM_MODEL, BRIDGE_UPSTREAM_TOKEN_ENV and BRIDGE_CLAUDE_EXECUTABLE. Uses fresh isolated directories and never reads subscription credentials. Existing evidence is never overwritten.");
  process.exit(0);
}
if (argv.length > 2 || (argv.length === 2 && argv[0] !== "--summary") || (argv.length === 1 && argv[0]!.startsWith("--"))) throw new Error("Use --summary <new.json> or --help.");
const output = resolve((argv[0] === "--summary" ? argv[1] : argv[0]) ?? "evidence/native-schema-validation-2026-10-16.json");
if (existsSync(output)) throw new Error("Evidence already exists; select a new path instead of overwriting it.");
const selection = await resolveSelection();
const workspace = ownDirectory("relay-e2e-ws-");
const data = ownDirectory("relay-verify-private-");
const tracker = trackOwnedProcesses();
const config = loadConfig({ mode: "sdk", authMode: "byok", permissionMode: "bypass", dataDir: data.path,
  clientToken: randomUUID(), adminToken: randomUUID(), sdkCwd: workspace.path, persistSessions: true,
  requestTimeoutMs: 180_000, toolWaitMs: 180_000, maxTurns: 20,
  upstreamBaseUrl: selection.provider.baseUrl, upstreamModel: selection.provider.model, upstreamTokenEnv: selection.provider.tokenEnv });
const runtime = new SdkRuntime(config, createLogger(config.logDir));
const session = new SessionStore(join(data.path, "sessions"), true, 1).create({ role: "chat", model: "relay-chat", toolNames: ["FactoryRevisionProbe"] });
const messages: Message[] = [];
const turns: Record<string, unknown>[] = [];
const checks: Record<string, boolean> = {};
const report: Record<string, unknown> = { suite: "native-schema-revision", status: "FAIL", startedAt: new Date().toISOString(),
  scope: "Real unmodified Claude Code and official SDK with isolated BYOK; synthetic host MCP fixture, not a real Factory command",
  authentication: { mode: "isolated BYOK", subscriptionCredentialsRead: false, ...publicSelection(selection) }, turns, checks };
const v1: ToolDefinition = { name: "FactoryRevisionProbe", description: "FactoryRevisionProbe version one: accepts a string value and returns a fixture receipt. Call only once per user request.",
  input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } };
const v2: ToolDefinition = { name: "FactoryRevisionProbe", description: "FactoryRevisionProbe version two: the original string version is retired. Accepts an integer value at least 100 and exactly two items. Call only once per user request.",
  input_schema: { type: "object", properties: { value: { type: "integer", minimum: 100 }, items: { type: "array", minItems: 2, maxItems: 2 } }, required: ["value", "items"], additionalProperties: false } };

function transcriptCalls(): Array<{ name: string; id: string; input: unknown }> {
  const result: Array<{ name: string; id: string; input: unknown }> = [];
  const scan = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) scan(path);
      else if (entry.name === `${session.sdkSessionId}.jsonl`) for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
        const row = JSON.parse(line);
        if (row.type !== "assistant" || !Array.isArray(row.message?.content)) continue;
        for (const block of row.message.content) if (block.type === "tool_use") result.push({ name: block.name, id: block.id, input: block.input });
      }
    }
  };
  scan(join(data.path, "claude-config", "projects"));
  return result;
}
async function send(content: string | ContentBlock[], tool: ToolDefinition, label: string) {
  messages.push({ role: "user", content });
  const turn = await runtime.handle({ role: "chat", session, headers: {}, request: {
    model: "relay-chat", max_tokens: 2048, system: "This is a bounded integration test. Use only the advertised FactoryRevisionProbe. Do not access files, shell, other tools, agents or skills. After its receipt, answer exactly the requested marker.",
    messages, tools: [tool],
  } });
  session.sdkSessionId = turn.sdkSessionId;
  session.pendingToolIds = turn.pendingToolIds;
  messages.push({ role: "assistant", content: turn.response.content });
  turns.push({ label, sdkSessionId: turn.sdkSessionId, response: turn.response, events: turn.events });
  console.log(JSON.stringify({ stage: label, stopReason: turn.response.stop_reason, sdkSessionId: turn.sdkSessionId }));
  return turn;
}
try {
  for (const [index, tool, value, marker] of [[1, v1, "before", "SCHEMA_V1_OK"], [2, v2, 137, "SCHEMA_V2_OK"], [3, v2, 138, "SCHEMA_V2_STABLE_OK"]] as const) {
    const before = transcriptCalls().length;
    const called = await send(`Call the currently available FactoryRevisionProbe once with value ${JSON.stringify(value)}${index > 1 ? ' and items ["a", "b"]' : ""}. After the receipt answer exactly ${marker}.`, tool, `turn-${index}-tool`);
    const uses = called.response.content.filter((block) => block.type === "tool_use");
    if (uses.length !== 1 || uses[0]!.type !== "tool_use") throw new Error(`Expected one real MCP call on turn ${index}`);
    const use = uses[0]!;
    checks[`turn${index}ExactHostArguments`] = use.name === "FactoryRevisionProbe" && isDeepStrictEqual(use.input, index === 1 ? { value } : { value, items: ["a", "b"] });
    const finished = await send([{ type: "tool_result", tool_use_id: use.id, content: `Fixture accepted ${JSON.stringify(use.input)}. Reply ${marker}.` }], tool, `turn-${index}-complete`);
    checks[`turn${index}Completion`] = finished.response.stop_reason === "end_turn" && finished.response.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("").trim() === marker;
    const newCalls = transcriptCalls().slice(before);
    checks[`turn${index}FirstInvocationCorrectRevision`] = newCalls.length === 1 && (index === 1 ? newCalls[0]!.name === "mcp__droid__FactoryRevisionProbe" : newCalls[0]!.name.startsWith("mcp__droid__droid_revision_FactoryRevisionP_"));
    report[`turn${index}NativeCalls`] = newCalls;
  }
  const ids = new Set(turns.map((turn) => turn.sdkSessionId));
  checks.sameNativeSession = ids.size === 1 && Boolean(session.sdkSessionId);
  const events = [...new Map(turns.flatMap((turn) => Array.isArray(turn.events) ? turn.events as Array<{ type: string; data?: Record<string, unknown> }> : []).map((event) => [JSON.stringify(event), event])).values()];
  checks.oneNativeQuery = events.filter((event) => event.type === "sdk_query_start").length === 1;
  checks.schemaRevisionVisibilityConfirmed = events.some((event) => event.type === "droid_catalog_updated" && event.data?.schemaVisibility === "revision_name_confirmed");
  checks.noUnnecessaryCatalogRefresh = events.filter((event) => event.type === "droid_catalog_updated").length === 1;
  const usagePath = join(config.logDir, "usage.jsonl");
  const usageRows = existsSync(usagePath) ? readFileSync(usagePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as UsageLedgerEvent) : [];
  report.usage = summarizeUsage(usageRows);
  checks.stableTurnReportsCacheReads = turns.slice(4).some((turn) => Number((turn.response as { usage?: { cache_read_input_tokens?: number } })?.usage?.cache_read_input_tokens) > 0);
  report.runtimeBeforeCleanup = runtime.describe();
  checks.noPendingHostCalls = runtime.pendingHostCalls(session.bridgeSessionId).length === 0;
  report.status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  await runtime.close();
  const cleanup = { processes: await tracker.close(), directoriesRemoved: [removeOwnedDirectory(workspace), removeOwnedDirectory(data)] };
  report.cleanup = cleanup;
  checks.ownedProcessCleanupComplete = cleanup.processes.complete;
  checks.ownedDirectoriesRemoved = cleanup.directoriesRemoved.every(Boolean);
  if (!checks.ownedProcessCleanupComplete || !checks.ownedDirectoriesRemoved) report.status = "FAIL";
  report.runtimeAfterCleanup = runtime.describe();
  report.finishedAt = new Date().toISOString();
  const secret = process.env[selection.provider.tokenEnv];
  let serialized = JSON.stringify(report, null, 2);
  if (secret) serialized = serialized.split(secret).join("[REDACTED]");
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, `${serialized}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, output, checks, error: report.error, cleanup: report.cleanup }));
}
if (report.status !== "PASS") process.exitCode = 1;
