import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import { OwnedProcesses, processTable } from "../src/runtime/owned-processes.js";
import { cursorMenuFromCatalog } from "../src/runtime/cursor/catalog.js";
import { cursorLiveCatalogFixture } from "../src/runtime/cursor/fixture.js";
import { missionSnapshot, hasCompletedWorkerHandoffs, readMissionHandoffs } from "./e2e-mission.js";
import { configureDroid } from "./configure-droid.js";
import { readClaudeConfig } from "../src/upstream/claude-config.js";
import { installFactoryHooks } from "../src/control/factory-hooks.js";

// Explicitly opt in: this spends the user's configured Claude/Cursor quota.
assert(process.argv.includes("--run"), "Pass --run to use the configured providers; --mission also exercises a tiny Droid Mission");
const repo = process.cwd();
const root = resolve(process.env.BRIDGE_LIVE_DIR ?? `tmp/live-stability-${Date.now()}`);
assert(!existsSync(root) || readdirSync(root).length === 0, "Provider acceptance requires a fresh, empty output directory");
const evidence = process.env.BRIDGE_EVIDENCE_DIR ?? root;
mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(evidence, { recursive: true, mode: 0o700 });
const pidFile = join(evidence, "PIDS.txt");
const evidenceFile = join(evidence, "EVIDENCE.md");
appendFileSync(pidFile, `${process.pid} live-runner\n`);
const started = Date.now();
const deadline = started + 25 * 60_000;
const realHome = homedir();
const home = join(root, "bridge-home"), droidHome = join(root, "droid-home"), workspace = join(root, "workspace");
for (const dir of [home, droidHome, workspace]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const token = randomBytes(24).toString("hex"), admin = randomBytes(24).toString("hex"), hook = randomBytes(24).toString("hex");
const secrets = [token, admin, hook];
const safe = (text: string) => secrets.reduce((s, key) => s.split(key).join("[redacted]"), text)
  .replace(/[A-Za-z0-9._%+*-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
  .replace(/(?:sk-ant-|sk-)[A-Za-z0-9_-]{8,}/g, "[redacted]");
const results: Array<Record<string, unknown>> = [];
function note(step: string, detail: Record<string, unknown>) {
  const row = { step, ...detail }; results.push(row);
  const text = safe(JSON.stringify(row));
  appendFileSync(evidenceFile, `\nLIVE ${text}\n`); console.log(text);
}
const owned = new OwnedProcesses({
  info(event, data) { if (typeof data?.pid === "number") appendFileSync(pidFile, `${data.pid} ${event}\n`); },
  warn(event, data) { appendFileSync(join(root, "process-events.jsonl"), `${JSON.stringify({ event, ...data })}\n`); },
  error(event, data) { appendFileSync(join(root, "process-events.jsonl"), `${JSON.stringify({ event, ...data })}\n`); },
});
const menuFile = join(root, "cursor-menu.json");
const menu = cursorMenuFromCatalog(cursorLiveCatalogFixture, "default").filter((item) => item.id === "cursor:composer-2.5");
writeFileSync(menuFile, JSON.stringify(menu), { mode: 0o600 });
const url = "http://127.0.0.1:18797";
// Separate CLI state from authentication. The wrapper runs only the existing
// helper in its original HOME; no key or original helper command is copied.
const claudeDir = join(home, ".claude"); mkdirSync(claudeDir);
const originalConfig = readClaudeConfig({ HOME: realHome, PATH: process.env.PATH }, "127.0.0.1:18797");
assert(originalConfig.helper, "Live isolation requires an existing helper, not stored Claude login tokens");
const helperWrapper = join(root, "read-only-helper.mjs");
writeFileSync(helperWrapper, `#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {readClaudeConfig} from ${JSON.stringify('file://' + join(repo, 'dist/upstream/claude-config.js'))};
const c=readClaudeConfig({HOME:${JSON.stringify(realHome)},PATH:process.env.PATH},'127.0.0.1:18797');
if(!c.helper)process.exit(1);
const r=spawnSync('/bin/sh',['-c',c.helper],{env:{...process.env,HOME:${JSON.stringify(realHome)}},stdio:['ignore','pipe','pipe'],timeout:10000});
if(r.status===0)process.stdout.write(r.stdout);
process.exit(r.status===0?0:1);
`, { mode: 0o700 });
const publicEnv = Object.fromEntries(Object.entries(originalConfig.env).filter(([key]) => !/TOKEN|KEY|CLAUDE_CONFIG_DIR/.test(key)));
writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ apiKeyHelper: helperWrapper, env: publicEnv }), { mode: 0o600 });
const configEnv: NodeJS.ProcessEnv = {
  HOME: home, PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR,
  CLAUDE_CONFIG_DIR: claudeDir,
  BRIDGE_MODE: "sdk", BRIDGE_AUTH: "claude-config", BRIDGE_DESKTOP: "1", BRIDGE_PERMISSION: "ask", BRIDGE_PORT: "18797", BRIDGE_HOST: "127.0.0.1",
  BRIDGE_MODELS: "haiku", BRIDGE_CURSOR_MODELS_FILE: menuFile,
  BRIDGE_CURSOR_AUTH_FILE: join(realHome, "Library/Application Support/factory-cc/bridge-data/cursor-auth.json"),
  BRIDGE_CLIENT_TOKEN: token, BRIDGE_ADMIN_TOKEN: admin, BRIDGE_HOOK_TOKEN: hook,
  BRIDGE_REQUEST_TIMEOUT_MS: "180000", BRIDGE_MAX_SESSIONS: process.argv.includes("--mission") ? "4" : "1", BRIDGE_LOG_MAX_BYTES: "1048576",
};
const droidEnv = { ...configEnv, HOME: droidHome, FACTORY_HOME_OVERRIDE: droidHome, FACTORY_AIRGAP_ENABLED: "1", BRIDGE_CONTROL_URL: url };
let bridge: ChildProcess | undefined;
let bridgeOwner = "";
let dataDir = "";
const allPids = new Set<number>();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const statusSchema = z.object({ processes: z.object({ ownedTrees: z.number(), liveProcesses: z.number(), stoppingTrees: z.number() }).passthrough().optional(), slotsInUse: z.number().optional(), cursor: z.object({ agents: z.number(), slotsInUse: z.number().optional() }).passthrough().optional() }).passthrough();
async function runtime() {
  const response = await fetch(`${url}/internal/runtime`, { headers: { authorization: `Bearer ${admin}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); return statusSchema.parse(await response.json());
}
function collectPids() {
  const file = join(dataDir, "logs/bridge.jsonl");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const item = z.object({ event: z.string(), data: z.object({ pid: z.number().optional() }).passthrough().optional() }).parse(JSON.parse(line));
      if (["sdk_process_spawned", "owned_process_observed"].includes(item.event) && item.data?.pid && !allPids.has(item.data.pid)) {
        allPids.add(item.data.pid); appendFileSync(pidFile, `${item.data.pid} ${item.event}\n`);
      }
    } catch { /* Partial append. */ }
  }
}
async function startBridge(label: string, timeoutMs = 60000) {
  // A foreign listener is a hard stop. Never signal it or use another port.
  const net = await import("node:net");
  await new Promise<void>((done, fail) => { const server = net.createServer(); server.once("error", fail); server.listen(18797, "127.0.0.1", () => server.close(() => done())); });
  dataDir = join(root, "states", label, "bridge-data");
  bridgeOwner = `bridge-${label}`;
  bridge = owned.spawn(bridgeOwner, { command: process.execPath, args: [join(repo, "dist/index.js")], cwd: repo,
    env: { ...configEnv, BRIDGE_DATA_DIR: dataDir, BRIDGE_SDK_START_TIMEOUT_MS: String(timeoutMs) } });
  for (const [stream, name] of [[bridge.stdout, "stdout"], [bridge.stderr, "stderr"]] as const) stream?.on("data", (chunk: Buffer) => appendFileSync(join(root, `${label}.${name}.log`), safe(chunk.toString("utf8")), { mode: 0o600 }));
  for (let until = Date.now() + 20000; Date.now() < until;) {
    try { if ((await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Startup. */ }
    if (bridge.exitCode !== null || bridge.signalCode !== null) throw new Error(`isolated bridge exited during ${label}`);
    await pause(100);
  }
  throw new Error("isolated bridge did not listen");
}
async function stopBridge(label: string) {
  collectPids();
  bridge?.kill("SIGTERM");
  if (bridge && bridge.exitCode === null && bridge.signalCode === null) await Promise.race([once(bridge, "exit"), pause(12000)]);
  // Verify bridge shutdown itself first; supervisor cleanup is reported separately.
  const rows = await processTable();
  const surviving = [...allPids].filter((pid) => rows.has(pid) && !rows.get(pid)!.state.startsWith("Z"));
  note(label, { bridgeExit: bridge?.exitCode, childrenRemainingBeforeHarnessCleanup: surviving.length });
  await owned.stop(bridgeOwner);
  assert.equal(surviving.length, 0, "bridge SIGTERM must clean its children without harness help");
}
async function post(model: string, label: string, messages = [{ role: "user", content: "Reply with exactly OK. Do not use tools." }]) {
  const before = Date.now();
  const response = await fetch(`${url}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-bridge-session": label },
    body: JSON.stringify({ model, max_tokens: 32, messages }), signal: AbortSignal.timeout(Math.min(200000, deadline - Date.now())) });
  const body = z.record(z.string(), z.unknown()).parse(await response.json());
  collectPids();
  note(label, { status: response.status, elapsedMs: Date.now() - before, errorType: body.error && typeof body.error === "object" && "type" in body.error ? body.error.type : undefined,
    retryAfter: response.headers.get("retry-after"), runtime: await runtime() });
  return { response, body };
}
async function command(owner: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<{ code: number | null; text: string; timedOut: boolean }> {
  const child = owned.spawn(owner, { command, args, cwd, env });
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => { text = (text + safe(chunk.toString("utf8"))).slice(-1024 * 1024); });
  child.stderr?.on("data", (chunk: Buffer) => { text = (text + safe(chunk.toString("utf8"))).slice(-1024 * 1024); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void owned.stop(owner); }, timeout);
  try { await once(child, "exit"); }
  finally { clearTimeout(timer); await owned.stop(owner); }
  writeFileSync(join(root, `${owner}.log`), text, { mode: 0o600 });
  return { code: child.exitCode, text, timedOut };
}
let closing = false;
async function cleanup() {
  if (closing) return; closing = true;
  collectPids();
  bridge?.kill("SIGTERM");
  await owned.close();
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => { void cleanup().finally(() => { process.exitCode = 1; }); });
const hardTimer = setTimeout(() => { void cleanup(); }, 25 * 60_000);
try {
  if (!process.argv.includes("--mission-only")) {
  await startBridge("forced-timeout", 1);
  const forced = await post("haiku", "forced-sdk-start-timeout");
  assert.equal(forced.response.status, 503);
  assert.equal(forced.body.error && typeof forced.body.error === "object" && "type" in forced.body.error ? forced.body.error.type : "", "sdk_start_timeout");
  assert.equal((await runtime()).processes?.ownedTrees, 0);
  await stopBridge("forced-timeout-SIGTERM");
  allPids.clear();
  }
  await startBridge("normal");
  const unauthorized = await fetch(`${url}/internal/runtime`, { signal: AbortSignal.timeout(3000) });
  assert.equal(unauthorized.status, 401);
  const claude = await post("haiku", "real-claude-short");
  assert([200, 429, 529].includes(claude.response.status), "Claude must run or report a proper upstream backoff error");
  if (!process.argv.includes("--mission-only")) {
  for (let index = 0; index < 8; index++) assert.equal((await post("cursor:composer-2.5", `cursor-short-${index}`)).response.status, 200);
  // Cancel only after real stream bytes arrive, proving the disconnect path.
  const abort = new AbortController();
  const stream = await fetch(`${url}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-bridge-session": "cursor-cancel" },
    body: JSON.stringify({ model: "cursor:composer-2.5", max_tokens: 4096, stream: true, messages: [{ role: "user", content: "Print the integers from 1 through 10000, one per line." }] }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]) });
  assert.equal(stream.status, 200); const reader = stream.body!.getReader(); assert(!(await reader.read()).done); abort.abort(); await reader.cancel().catch(() => undefined);
  for (let until = Date.now() + 15000; Date.now() < until && (await runtime()).cursor?.agents !== 0;) await pause(100);
  note("cursor-disconnect", { runtime: await runtime() });
  assert.equal((await runtime()).cursor?.agents, 0);

  }
  const settings = join(droidHome, ".factory/settings.json");
  configureDroid(["--settings", settings, "--base-url", url, "--auth", "claude-config", "--manifest", join(root, "models.env")], { HOME: droidHome, BRIDGE_CLIENT_TOKEN: token },
    [{ id: "haiku", model: "haiku", displayName: "Claude Haiku" }, ...menu]);
  installFactoryHooks({ hooksPath: join(workspace, ".factory/hooks.json"), configPath: join(droidHome, ".factory/relay-hooks.json"), url, hookToken: hook });
  if (!process.argv.includes("--mission-only")) {
  const launchRes = await fetch(`${url}/internal/launches`, { method: "POST", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ cwd: workspace }) });
  const launchId = z.object({ launchId: z.string() }).parse(await launchRes.json()).launchId;
  const launchEnv = { ...droidEnv, BRIDGE_FACTORY_LAUNCH_ID: launchId };
  const droid = await command("droid-short", "droid", ["exec", "--settings", settings, "--output-format", "json", "-m", "cursor:composer-2.5", "--auto", "high", "Reply with exactly DROID_OK. Do not use tools."], workspace, launchEnv, 180000);
  note("droid-short", { exit: droid.code, timedOut: droid.timedOut, observedExpectedReply: droid.text.includes("DROID_OK") });
  assert.equal(droid.code, 0); assert(droid.text.includes("DROID_OK"));
  await fetch(`${url}/internal/launches/${launchId}/end`, { method: "POST", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${admin}` } });

  }
  if (process.argv.includes("--mission") && claude.response.status === 200) {
    const mission = join(root, "mission-fixture"); mkdirSync(mission);
    const packageSource = '{"type":"module","scripts":{"test":"node --test sum.test.js"}}\n';
    const testSource = 'import {test} from "node:test";import assert from "node:assert/strict";import {sum} from "./sum.js";test("addition",()=>assert.equal(sum(2,3),5));\n';
    writeFileSync(join(mission, "package.json"), packageSource);
    writeFileSync(join(mission, "sum.js"), 'export const sum = (a,b) => a-b;\n');
    writeFileSync(join(mission, "sum.test.js"), testSource);
    writeFileSync(join(mission, "MISSION.md"), 'Fix sum.js to add two numbers. Use the normal Factory Mission workflow, one implementation feature, a Cursor Composer worker and Composer validation. Run npm test; preserve tests/package.json. Complete scrutiny and user testing. Do not stop after planning. No dependencies, UI or services.\n');
    installFactoryHooks({ hooksPath: join(mission, ".factory/hooks.json"), configPath: join(droidHome, ".factory/relay-hooks.json"), url, hookToken: hook });
    await command("mission-git-init", "git", ["init"], mission, droidEnv, 10000);
    await command("mission-git-add", "git", ["add", "."], mission, droidEnv, 10000);
    await command("mission-git-commit", "git", ["-c", "user.name=Bridge Test", "-c", "user.email=fixture@invalid.example", "commit", "-m", "Create Mission fixture\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"], mission, droidEnv, 10000);
    const response = await fetch(`${url}/internal/launches`, { method: "POST", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ cwd: mission }) });
    const missionLaunch = z.object({ launchId: z.string() }).parse(await response.json()).launchId;
    const run = await command("droid-mission", "droid", ["exec", "--settings", settings, "--mission", "--output-format", "json", "-m", "haiku", "--worker-model", "cursor:composer-2.5", "--validator-model", "cursor:composer-2.5", "--auto", "high", "-f", "MISSION.md"], mission, { ...droidEnv, BRIDGE_FACTORY_LAUNCH_ID: missionLaunch }, 15 * 60_000);
    await fetch(`${url}/internal/launches/${missionLaunch}/${run.timedOut ? "cancel" : "end"}`, { method: "POST", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${admin}` } });
    const test = await command("mission-product-test", process.execPath, ["--test", "sum.test.js"], mission, droidEnv, 10000);
    const snapshot = missionSnapshot(join(droidHome, ".factory"));
    const gates = {
      droidSuccessful: run.code === 0 && !run.timedOut,
      missionCompleted: snapshot.missionDirs.length === 1 && snapshot.missionState === "completed" && !snapshot.errors.length,
      featuresDone: snapshot.features.length > 0 && snapshot.features.every((feature) => feature.status === "completed"),
      validatorsCompleted: ["scrutiny-validator", "user-testing-validator"].every((skill) => snapshot.features.some((feature) => feature.skillName === skill && feature.status === "completed")),
      handoffsObserved: hasCompletedWorkerHandoffs(snapshot, readMissionHandoffs(snapshot)),
      validationGreen: snapshot.validation.length > 0 && snapshot.validation.every((item) => item.status === "passed"),
      productTests: test.code === 0,
      testsPreserved: readFileSync(join(mission, "sum.test.js"), "utf8") === testSource && readFileSync(join(mission, "package.json"), "utf8") === packageSource,
    };
    note("claude-cursor-mission", { exit: run.code, timedOut: run.timedOut, gates, status: Object.values(gates).every(Boolean) ? "PASS" : "FAIL" });
    assert(Object.values(gates).every(Boolean), "Mission requires real completed workers, validators, handoffs and passing product tests");
  } else if (process.argv.includes("--mission")) note("claude-cursor-mission", { status: "BLOCKED_UPSTREAM", upstreamStatus: claude.response.status });
  await stopBridge("normal-SIGTERM");
} finally {
  clearTimeout(hardTimer); await cleanup();
  const final = await processTable();
  const remaining = [...allPids].filter((pid) => final.has(pid) && !final.get(pid)!.state.startsWith("Z"));
  const net = await import("node:net");
  const portFree = await new Promise<boolean>((done) => { const server = net.createServer(); server.once("error", () => done(false)); server.listen(18797, "127.0.0.1", () => server.close(() => done(true))); });
  note("cleanup", { leakedProcesses: remaining.length, port18797Free: portFree, elapsedMs: Date.now() - started });
  writeFileSync(join(root, "result.json"), JSON.stringify(results, null, 2));
  assert.equal(remaining.length, 0); assert(portFree);
}
