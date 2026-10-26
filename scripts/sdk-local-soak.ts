import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { createBridgeApp, listen } from "../src/http/app.js";
import { SdkRuntime } from "../src/runtime/sdk-runtime.js";
import { createLogger, type Logger } from "../src/logging.js";
import { forbiddenNamesIn } from "../src/upstream/auth-env.js";
import { installShutdownHandlers } from "../src/index.js";
import { processTable } from "../src/runtime/owned-processes.js";

// Real unmodified SDK/CLI, deterministic localhost provider, no paid key.
const root = resolve(process.env.BRIDGE_SOAK_DIR ?? `tmp/sdk-local-soak-${Date.now()}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
const pidFile = process.env.BRIDGE_EVIDENCE_PIDS ?? join(root, "PIDS.txt");
appendFileSync(pidFile, `${process.pid} sdk-local-runner\n`);
const cliHome = join(root, "home"); mkdirSync(cliHome, { recursive: true });
for (const key of forbiddenNamesIn("byok", process.env)) delete process.env[key];
process.env.HOME = cliHome;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.BRIDGE_LOCAL_FIXTURE_KEY = "offline-placeholder-never-a-real-key";
let mode: "success" | "hang" | 429 | 529 = "success";
let providerRequests = 0;
const gateway = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const metadata: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  appendFileSync(join(root, "gateway-metadata.jsonl"), `${JSON.stringify({ mode, stream: metadata && typeof metadata === "object" && "stream" in metadata ? metadata.stream : undefined })}\n`);
  if (req.url?.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":10}'); return; }
  providerRequests++;
  if (typeof mode === "number") {
    res.writeHead(mode, { "content-type": "application/json", "retry-after": "1", "x-should-retry": "false" });
    res.end(JSON.stringify({ type: "error", error: { type: mode === 429 ? "rate_limit_error" : "overloaded_error", message: "Local deterministic fixture", retry_after: 1 } })); return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit("message_start", { type: "message_start", message: { id: `msg_fixture_${providerRequests}`, type: "message", role: "assistant", model: "local-fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: mode === "hang" ? "waiting" : "OK" } });
  if (mode === "hang") {
    const timer = setInterval(() => emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " more streaming fixture text ".repeat(100) } }), 100);
    res.once("close", () => clearInterval(timer)); return;
  }
  emit("content_block_stop", { type: "content_block_stop", index: 0 });
  emit("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  emit("message_stop", { type: "message_stop" }); res.end();
});
await new Promise<void>((done, fail) => { gateway.once("error", fail); gateway.listen(0, "127.0.0.1", done); });
const address = gateway.address(); assert(address && typeof address === "object");
const config = loadConfig({ port: 18797, mode: "sdk", authMode: "byok", dataDir: join(root, "data"), sdkCwd: root,
  clientToken: "local-client", adminToken: "local-admin", hookToken: "local-hook", maxSessions: 2, permissionMode: "bypass", requestTimeoutMs: 90_000,
  upstreamBaseUrl: `http://127.0.0.1:${address.port}`, upstreamModel: "local-fixture", upstreamTokenEnv: "BRIDGE_LOCAL_FIXTURE_KEY" });
const base = createLogger(config.logDir);
const pids = new Set<number>();
const roots = new Set<number>();
const logger: Logger = { info(event, data) { if ((event === "sdk_process_spawned" || event === "owned_process_observed") && typeof data?.pid === "number") { pids.add(data.pid); if (event === "sdk_process_spawned") roots.add(data.pid); appendFileSync(pidFile, `${data.pid} ${event}\n`); } base.info(event, data); }, warn: base.warn, error: base.error };
const runtime = new SdkRuntime(config, logger);
const app = createBridgeApp(config, logger, "", runtime);
const removeShutdown = installShutdownHandlers(app, logger);
const statuses: Array<Record<string, unknown>> = [];
const deadline = setTimeout(() => { void app.close(); gateway.closeAllConnections(); }, 5 * 60_000);
const post = (label: string, stream = false, signal?: AbortSignal) => fetch(`${app.url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer local-client", "content-type": "application/json", "x-bridge-session": label },
  body: JSON.stringify({ model: "relay-chat", max_tokens: 16, stream, messages: [{ role: "user", content: label }] }), signal: signal ?? AbortSignal.timeout(95_000) });
try {
  await listen(app, config);
  for (const label of ["warm-1", "warm-2", "warm-3"]) {
    const response = await fetch(`${app.url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer local-client", "content-type": "application/json", "x-bridge-session": "warm" },
      body: JSON.stringify({ model: "relay-chat", max_tokens: 16, messages: [{ role: "user", content: label }] }), signal: AbortSignal.timeout(90_000) });
    assert.equal(response.status, 200); assert((await response.text()).includes('"text":"OK"'));
  }
  assert.equal(roots.size, 1, "three warm turns must reuse one real CLI");
  const warmSession = app.store.list()[0]!;
  await runtime.cancel(warmSession.bridgeSessionId, "warm-complete");
  for (const status of [429, 529] as const) {
    mode = status;
    const response = await post(`error-${status}`);
    const body: unknown = await response.json();
    statuses.push({ expected: status, actual: response.status, retryAfter: response.headers.get("retry-after"), body });
    writeFileSync(join(root, "error-cases.json"), JSON.stringify(statuses, null, 2));
    console.log(JSON.stringify(statuses.at(-1)));
    assert.equal(response.status, status);
    assert.equal(runtime.describe().slotsInUse, 0);
    mode = "success";
    const retried = await post(`error-${status}`);
    assert.equal(retried.status, 200); assert((await retried.text()).includes('"text":"OK"'));
    await runtime.cancel(app.store.list().find((item) => item.droidSessionId === `error-${status}`)!.bridgeSessionId, "retry-complete");
  }
  mode = "hang";
  const controller = new AbortController();
  const response = await post("cancel-after-content", true, AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]));
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(); assert(!(await reader.read()).done); controller.abort(); await reader.cancel().catch(() => undefined);
  const until = Date.now() + 10_000;
  while (Number(runtime.describe().slotsInUse) && Date.now() < until) await new Promise((done) => setTimeout(done, 40));
  assert.equal(runtime.describe().slotsInUse, 0);
} finally {
  clearTimeout(deadline); await app.close(); removeShutdown(); gateway.closeAllConnections(); await new Promise<void>((done) => gateway.close(() => done()));
}
const rows = await processTable();
const leaked = [...pids].filter((pid) => rows.has(pid) && !rows.get(pid)!.state.startsWith("Z"));
const report = { realSdk: true, provider: "localhost fixture", warmTurns: 3, errorCases: statuses, cancelAfterContent: true, realCliProcesses: roots.size, observedOwnedPids: pids.size, leakedProcesses: leaked.length, slotsAfterClose: runtime.describe().slotsInUse, providerRequests };
writeFileSync(join(root, "result.json"), `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report));
assert.equal(leaked.length, 0);
