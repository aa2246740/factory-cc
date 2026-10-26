import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { createBridgeApp, listen } from "../src/http/app.js";
import { createLogger, type Logger } from "../src/logging.js";
import { SdkRuntime } from "../src/runtime/sdk-runtime.js";
import { ProcessSdk } from "../tests/helpers/process-sdk.js";
import { installShutdownHandlers } from "../src/index.js";
import { processTable } from "../src/runtime/owned-processes.js";

// Deliberately offline: real OS children, fake SDK protocol. Use live-stability
// separately for the paid/authenticated SDK and Droid paths.
const count = Number(process.argv[2] ?? 500);
assert(Number.isInteger(count) && count >= 10 && count <= 5000, "session count must be 10..5000");
const root = resolve(process.env.BRIDGE_SOAK_DIR ?? `tmp/soak-${Date.now()}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
const pidFile = process.env.BRIDGE_EVIDENCE_PIDS ?? join(root, "PIDS.txt");
appendFileSync(pidFile, `${process.pid} soak-runner\n`);
process.env.BRIDGE_LOG_MAX_BYTES = "65536";
process.env.BRIDGE_SOAK_KEY = "offline-placeholder";
const config = loadConfig({ port: 18797, mode: "sdk", authMode: "byok", dataDir: join(root, "data"), clientToken: "soak-client", adminToken: "soak-admin", hookToken: "soak-hook",
  sdkCwd: root, permissionMode: "bypass", maxSessions: 4, sessionMaxRecords: 32, persistSessions: true,
  upstreamBaseUrl: "https://offline.invalid/anthropic", upstreamModel: "offline", upstreamTokenEnv: "BRIDGE_SOAK_KEY", requestTimeoutMs: 5000 });
const base = createLogger(config.logDir);
const logger: Logger = {
  info(event, data) { if ((event === "sdk_process_spawned" || event === "owned_process_observed") && typeof data?.pid === "number") appendFileSync(pidFile, `${data.pid} ${event}\n`); base.info(event, data); },
  warn: base.warn, error: base.error,
};
const sdk = new ProcessSdk(); sdk.cooperative = true; sdk.retainHistory = false;
const runtime = new SdkRuntime(config, logger, sdk);
const app = createBridgeApp(config, logger, "", runtime);
const removeShutdown = installShutdownHandlers(app, logger);
const started = Date.now();
const heap: number[] = [];
let errors = 0;
let verifiedDeaths = 0;
const deadline = setTimeout(() => { errors++; void app.close(); app.server.closeAllConnections(); }, 10 * 60_000);
try {
  await listen(app, config);
  for (let index = 0; index < count; index++) {
    sdk.mode = index % 17 === 0 ? "error" : "success";
    const response = await fetch(`${app.url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer soak-client", "content-type": "application/json", "x-bridge-session": `soak-${index}` },
      body: JSON.stringify({ model: "relay-chat", max_tokens: 16, messages: [{ role: "user", content: `turn ${index}` }] }), signal: AbortSignal.timeout(10_000) });
    const body: unknown = await response.json();
    assert.equal(response.status, sdk.mode === "error" ? 429 : 200);
    if (response.status === 200) assert(JSON.stringify(body).includes('"text":"ok"'));
    const record = app.store.list().find((item) => item.droidSessionId === `soak-${index}`)!;
    if (index % 3 === 0) await runtime.endHostSession(record.bridgeSessionId, "soak-session-end");
    else if (index % 3 === 1) await runtime.cancel(record.bridgeSessionId, "soak-cancel");
    // Every third success is kept idle, forcing real slot-pressure eviction.
    await runtime.maintain();
    app.store.prune(new Set(app.store.list().filter((s) => runtime.pendingHostCalls(s.bridgeSessionId).length).map((s) => s.bridgeSessionId)));
    if (index % 25 === 0) {
      globalThis.gc?.(); heap.push(process.memoryUsage().heapUsed);
      assert(Number(runtime.describe().slotsInUse) <= 4);
      const logs = readdirSync(config.logDir).filter((file) => /\.jsonl(?:\.1)?$/.test(file));
      for (const file of logs) assert(statSync(join(config.logDir, file)).size <= 65536);
    }
  }
} catch (error) { errors++; throw error; }
finally { clearTimeout(deadline); await app.close(); removeShutdown(); }
const rows = await processTable();
const remaining = sdk.spawnedPids.filter((pid) => { const row = rows.get(pid); return row && !row.state.startsWith("Z"); });
verifiedDeaths = sdk.spawnedPids.length - remaining.length;
assert.equal(remaining.length, 0, "no owned child process may survive");
assert.equal(runtime.describe().slotsInUse, 0);
assert(app.store.list().length <= 36);
// With forced GC this compares retained heap; without it the number is an upper
// bound on allocation, not evidence of a memory leak or a speedup.
const growth = Math.max(0, (heap.at(-1) ?? 0) - (heap[Math.min(2, heap.length - 1)] ?? 0));
assert(growth < 8 * 1024 * 1024, "retained heap grew beyond the accelerated soak budget");
const steadyGrowth = Math.max(0, (heap.at(-1) ?? 0) - (heap[Math.min(20, heap.length - 1)] ?? 0));
if (count >= 750) assert(steadyGrowth < 2 * 1024 * 1024, "heap did not settle after the bounded 500-record request index warmed");
const report = { sessions: count, errors, childProcesses: sdk.spawnedPids.length, verifiedDeaths, leakedProcesses: remaining.length, slotsAfterClose: runtime.describe().slotsInUse,
  retainedSessions: app.store.list().length, gc: Boolean(globalThis.gc), heapSamples: heap, heapGrowthBytes: growth, steadyHeapGrowthBytes: steadyGrowth, elapsedMs: Date.now() - started };
writeFileSync(join(root, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
