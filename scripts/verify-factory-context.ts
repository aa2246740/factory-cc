#!/usr/bin/env -S node --import tsx
/** Real Factory JSON-RPC compaction acceptance. No provider/Factory responses are mocked. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beginFactoryLaunch, droidEnv, endFactoryLaunch, resolveSelection, startSdkBridge } from "./e2e-lib.js";

type Envelope = { type?: string; id?: string; method?: string; result?: any; error?: unknown; params?: any };

export class FactoryRpc {
  readonly events: Envelope[] = [];
  readonly actions: unknown[] = [];
  readonly child: ChildProcessWithoutNullStreams;
  stderr = "";
  private output = "";
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: "pipe" });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.output += chunk.toString();
      for (;;) {
        const index = this.output.indexOf("\n");
        if (index < 0) break;
        const line = this.output.slice(0, index); this.output = this.output.slice(index + 1);
        if (!line.trim()) continue;
        let event: Envelope;
        try { event = JSON.parse(line); }
        catch { this.stderr += `\nNon-JSON stdout: ${line}`; continue; }
        this.events.push(event);
        const pending = event.type === "response" && event.id ? this.pending.get(event.id) : undefined;
        if (pending) {
          clearTimeout(pending.timer); this.pending.delete(event.id!);
          if (event.error) pending.reject(new Error(JSON.stringify(event.error)));
          else pending.resolve(event.result);
        }
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk}`.slice(-1_000_000); });
    this.child.on("error", (error) => this.rejectPending(error));
    this.child.on("exit", (code, signal) => this.rejectPending(new Error(`Factory exited ${code}/${signal}`)));
  }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  request(method: string, params: unknown, timeoutMs = 600_000): Promise<any> {
    const id = randomUUID();
    const request = { jsonrpc: "2.0", factoryApiVersion: "1.0.0", type: "request", id, method, params };
    this.actions.push(request);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }
  async turn(text: string): Promise<Envelope[]> {
    const from = this.events.length;
    const messageId = randomUUID();
    await this.request("droid.add_user_message", { messageId, text });
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const turn = this.events.slice(from);
      const completed = turn.find((event) => event.params?.notification?.type === "agent_turn_completed"
        && event.params.notification.turnId === messageId);
      if (completed) {
        if (completed.params.notification.reason !== "completed") throw new Error(`Turn ended: ${JSON.stringify(completed.params.notification)}`);
        return turn;
      }
      if (this.child.exitCode !== null) throw new Error(`Factory exited during turn: ${this.child.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for Factory agent_turn_completed");
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    const deadline = Date.now() + 3_000;
    while (this.child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.child.exitCode === null) {
      try { process.kill(process.platform === "win32" ? this.child.pid! : -this.child.pid!, "SIGTERM"); } catch { /* exited */ }
    }
  }
}

export function assistantText(events: Envelope[]): string {
  return events.flatMap((event) => {
    const notice = event.params?.notification;
    return notice?.type === "assistant_text_delta" ? [notice.textDelta] : [];
  }).join("");
}

function walk(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]); }
  catch { return []; }
}

export function writeContextEvidence(path: string, value: unknown, secrets: string[] = [], exclusive = false): void {
  let text = JSON.stringify(value, null, 2);
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]");
  writeFileSync(path, `${text}\n`, { mode: 0o600, flag: exclusive ? "wx" : "w" });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(`Usage: node --import tsx scripts/verify-factory-context.ts [--auto] [--same-worker-handoff] [--summary NEW.json]

Drive real Factory stream-jsonrpc, official Claude Code and an explicitly selected
BYOK endpoint. Verifies Factory manual current-session compaction, native session
continuity/cache reporting, official handoff close/load, and exact random-value recall.

  --auto             Also lower Factory's public compactionTokenLimit to 12000
                     for one bounded automatic-compaction probe, then restore it.
  --same-worker-handoff  Load the official handoff in the current RPC worker to
                        verify authenticated previous-session lifecycle transfer.
  --summary NEW.json  Write a new sanitized shareable summary; refuses overwrite.
  --help             Print this help without credentials, processes or model calls.

Requires BRIDGE_UPSTREAM_BASE_URL, BRIDGE_UPSTREAM_MODEL, BRIDGE_UPSTREAM_TOKEN_ENV,
plus installed droid/claude (or BRIDGE_DROID_EXECUTABLE/BRIDGE_CLAUDE_EXECUTABLE).
Uses isolated temporary directories, preserves proxy/CA env, never reads real auth.
Raw synthetic RPC evidence remains under evidence/local; owned processes and homes
are cleaned up. Factory default-threshold automatic compaction is not claimed.`);
    return;
  }
  let auto = false;
  let sameWorkerHandoff = false;
  let summaryPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--auto") auto = true;
    else if (args[i] === "--same-worker-handoff") sameWorkerHandoff = true;
    else if (args[i] === "--summary" && args[i + 1]) summaryPath = resolve(args[++i]!);
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  if (summaryPath && existsSync(summaryPath)) throw new Error("Refusing to overwrite previous verification evidence");
  const selection = await resolveSelection();
  const root = resolve("evidence/local", `factory-context-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`);
  mkdirSync(root, { recursive: true });
  const bridge = await startSdkBridge(0, join(root, "bridge"), selection);
  const ownedDirectories = [bridge.home, bridge.workspace].map((path) => ({ path, stat: lstatSync(path) }));
  const hookMetadata: unknown[] = [];
  bridge.app.server.prependListener("request", (request) => {
    if (request.url !== "/internal/host-events") return;
    let body = "";
    request.on("data", (chunk: Buffer) => { if (body.length < 4 * 1024 * 1024) body += chunk; });
    request.on("end", () => {
      try {
        const event = JSON.parse(body).event;
        if (event.hook_event_name === "SessionStart" || event.hook_event_name === "SessionEnd") {
          hookMetadata.push({ keys: Object.keys(event), ...Object.fromEntries(Object.entries(event).filter(([key]) =>
            ["hook_event_name", "session_id", "source", "reason", "parent_session_id", "previous_session_id", "permission_mode"].includes(key))) });
        }
      } catch { /* Hook acceptance is independently checked by production handlers. */ }
    });
  });
  const launch = await beginFactoryLaunch(bridge);
  const createRpc = () => new FactoryRpc(process.env.BRIDGE_DROID_EXECUTABLE ?? "droid", ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc", "--settings", bridge.settingsPath, "--cwd", bridge.workspace], bridge.workspace, droidEnv(bridge.home, bridge.token, launch));
  let rpc = createRpc();
  const clients = [rpc];
  const marker = `CONTEXT_${randomUUID().replaceAll("-", "")}`;
  const summary: Record<string, any> = { recordedAt: new Date().toISOString(), status: "FAIL", surface: "real Factory droid.compact_session (same-session and handoff)", model: selection.provider.model, output: root, checks: {}, steps: [], automaticProbeRequested: auto, handoffLifecycle: sameWorkerHandoff ? "same-worker-load-with-authenticated-previous-session-transfer" : "close-old-session-and-load-in-new-worker", limitations: ["Default production-threshold automatic compaction is separate from an optional lowered-threshold probe.", "Uses authorized non-Claude BYOK; no subscription-account policy assurance.", "Missing provider cache-create fields remain unknown, not zero cost or an exact hit ratio."] };
  const snapshot = () => bridge.app.store.list().map(({ bridgeSessionId, factorySessionId, sdkSessionId, state, historyMessageHashes, hostEnded }) => ({ bridgeSessionId, factorySessionId, sdkSessionId, state, historyMessageCount: historyMessageHashes?.length, hostEnded }));
  const latestMainRequest = () => bridge.app.records.filter((record) => record.authOk && record.toolNames && record.toolNames.length > 0).at(-1)?.sessionHint;
  try {
    const initialized = await rpc.request("droid.initialize_session", { machineId: "relay-context-verifier", cwd: bridge.workspace, modelId: "custom:Relay-chat-0", autonomyLevel: "high", interactionMode: "auto", disableBuiltinSkills: true, autoRejectPermissionRequests: true });
    summary.factorySessionId = initialized.sessionId;
    console.log(`Factory context verification started: ${root}`);
    summary.steps.push({ action: "initialize", sessionId: initialized.sessionId, settings: initialized.settings });
    const initial = await rpc.turn(`This disposable test checks memory through Factory compaction. Remember the exact verification value ${marker}. The project decision is to use port 43127 and keep retries at 3. Do not write any files or call tools. Reply CONTEXT_STORED only.`);
    summary.steps.push({ action: "remember", response: assistantText(initial), sessions: snapshot() });
    summary.checks.stored = assistantText(initial).trim() === "CONTEXT_STORED";
    const initialNative = bridge.app.store.list().find((session) => session.factorySessionId === initialized.sessionId && session.toolNames.length > 0);
    if (!initialNative?.sdkSessionId) throw new Error("Initial Factory turn has no authenticated native checkpoint");
    if (auto) {
      await rpc.request("droid.update_session_settings", { compactionTokenLimit: 12000, compactionThresholdCheckEnabled: true });
      const automatic = await rpc.turn("Without tools, repeat only the stored verification value, port, and retries as VALUE|PORT|RETRIES.");
      const boundaries = automatic.filter((event) => event.params?.notification?.type === "session_compacted"
        || (event.params?.notification?.type === "droid_working_state_changed" && event.params.notification.newState === "compacting_conversation"));
      summary.steps.push({ action: "automatic-compact-lowered-threshold", threshold: 12000, boundaries, response: assistantText(automatic), sessions: snapshot() });
      summary.checks.automaticBoundaryObserved = boundaries.some((event) => event.params?.notification?.type === "session_compacted"
        && event.params.notification.removedCount > 0);
      summary.checks.automaticTurnResponse = assistantText(automatic).trim() === `${marker}|43127|3`;
      await rpc.request("droid.update_session_settings", { compactionTokenLimit: 200000 });
      // Factory may compact after producing that turn's response. Only a new
      // request after the observed boundary proves post-compaction recall.
      const afterAuto = await rpc.turn("The automatic boundary has finished. Without tools or files, recall the earlier exact verification value, port, and retries as VALUE|PORT|RETRIES only.");
      summary.steps.push({ action: "recall-after-automatic-boundary", response: assistantText(afterAuto), sessions: snapshot() });
      summary.checks.automaticPostBoundaryRecall = assistantText(afterAuto).trim() === `${marker}|43127|3`;
      const autoNative = bridge.app.store.list().filter((session) => session.factorySessionId === initialized.sessionId && session.toolNames.length > 0);
      summary.checks.automaticNativeContinued = autoNative.length === 1 && autoNative[0]?.sdkSessionId === initialNative.sdkSessionId
        && latestMainRequest() === initialNative.bridgeSessionId;
    }
    const compact = await rpc.request("droid.compact_session", { customInstructions: "Retain the exact verification value, port number, and retry count. Preserve no-tool restriction. Keep the summary short." });
    summary.steps.push({ action: "compact-current", result: compact, sessions: snapshot() });
    summary.checks.currentCompacted = compact.newSessionId === initialized.sessionId && compact.removedCount > 0;
    const recall = await rpc.turn("Without using tools or reading files, recall the earlier exact verification value, port, and retries. Reply as VALUE|PORT|RETRIES with no prose.");
    summary.steps.push({ action: "recall-current", response: assistantText(recall), sessions: snapshot() });
    summary.checks.currentRecall = assistantText(recall).trim() === `${marker}|43127|3`;
    const currentNative = bridge.app.store.list().filter((session) => session.factorySessionId === initialized.sessionId && session.toolNames.length > 0);
    summary.checks.currentNativeContinued = currentNative.length === 1 && currentNative[0]?.sdkSessionId === initialNative.sdkSessionId
      && latestMainRequest() === initialNative.bridgeSessionId;
    summary.currentNativeUsage = currentNative[0] ? structuredClone(currentNative[0].usage) : undefined;
    if (summary.currentNativeUsage && !summary.currentNativeUsage.knownFields?.includes("cache_creation_input_tokens")) {
      summary.currentNativeUsage.cache_creation_input_tokens = null;
    }
    const handoff = await rpc.request("droid.compact_session", { mode: "handoff", customInstructions: "Retain the exact verification value, port number, and retry count. Keep the summary short." });
    summary.steps.push({ action: "compact-handoff", result: handoff, sessions: snapshot() });
    summary.checks.handoffCreated = handoff.newSessionId !== initialized.sessionId && handoff.removedCount > 0;
    if (!sameWorkerHandoff) {
      // The default driver explicitly ends the old owner. The optional same-
      // worker regression instead requires the authenticated compact lifecycle
      // relation to retire the previous session before accepting the new one.
      await rpc.request("droid.close_session", { reason: "other" }, 30_000);
      await rpc.close();
      rpc = createRpc(); clients.push(rpc);
    }
    await rpc.request("droid.load_session", { sessionId: handoff.newSessionId, loadAllMessages: true, disableBuiltinSkills: true, autoRejectPermissionRequests: true });
    const recallHandoff = await rpc.turn("Without using tools or reading files, recall the earlier exact verification value, port, and retries. Reply as VALUE|PORT|RETRIES with no prose.");
    summary.steps.push({ action: "recall-handoff", response: assistantText(recallHandoff), sessions: snapshot() });
    summary.checks.handoffRecall = assistantText(recallHandoff).trim() === `${marker}|43127|3`;
    const handoffNative = bridge.app.store.list().find((session) => session.factorySessionId === handoff.newSessionId && session.toolNames.length > 0);
    summary.checks.handoffNativeIsolated = Boolean(handoffNative?.sdkSessionId && handoffNative.sdkSessionId !== initialNative.sdkSessionId);
    summary.status = Object.values(summary.checks).every(Boolean) ? "PASS" : "FAIL";
    await rpc.request("droid.close_session", { reason: "other" }, 30_000);
  } catch (error) { summary.error = error instanceof Error ? error.message : String(error); }
  finally {
    await rpc.close();
    await endFactoryLaunch(bridge, launch, summary.status !== "PASS").catch((error) => { summary.launchCleanupError = String(error); });
    summary.runtimeBeforeClose = bridge.app.runtimeStatus();
    summary.sessions = snapshot();
    summary.requests = bridge.app.records;
    summary.hookMetadata = hookMetadata;
    summary.generatedTitles = clients.flatMap((client) => client.events.filter((event) =>
      event.params?.notification?.type === "session_title_updated").map((event) => event.params.notification));
    // Owned Factory transcripts contain only synthetic inputs. Never inspect another home.
    const files = walk(bridge.factoryHome).filter((path) => /\.jsonl$/.test(path) && path.includes("/sessions/"));
    summary.factoryTranscriptFiles = files.map((path) => ({ path, bytes: readFileSync(path).length }));
    const transcripts = files.map((path) => ({ path, rows: readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) }));
    summary.compactionStates = transcripts.flatMap((file) => file.rows.filter((row) => row.type === "compaction_state")
      .map(({ id, timestamp, summaryTokens, summaryKind, removedCount, summaryText }) => ({ id, timestamp, summaryTokens, summaryKind, removedCount,
        retainedVerificationValue: typeof summaryText === "string" && summaryText.includes(marker), retainedPort: typeof summaryText === "string" && summaryText.includes("43127"),
        summaryChars: typeof summaryText === "string" ? summaryText.length : 0 })));
    await bridge.close();
    summary.cleanup = bridge.processCleanup;
    if (!bridge.processCleanup?.complete || summary.launchCleanupError) summary.status = "FAIL";
    const secrets = [bridge.token, bridge.config.adminToken, process.env[selection.provider.tokenEnv]].filter((value): value is string => Boolean(value));
    const save = (path: string, value: unknown) => writeContextEvidence(path, value, secrets);
    save(join(root, "rpc.json"), clients.map((client) => ({ actions: client.actions, events: client.events, stderr: client.stderr })));
    save(join(root, "factory-transcripts.json"), transcripts);
    summary.removedOwnedDirectories = [];
    for (const { path, stat } of ownedDirectories) {
      try {
        const current = lstatSync(path);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("Owned directory identity changed");
        rmSync(path, { recursive: true }); summary.removedOwnedDirectories.push(path);
      } catch (error) { summary.status = "FAIL"; summary.directoryCleanupError = String(error); }
    }
    save(join(root, "result.json"), summary);
    if (summaryPath) writeContextEvidence(summaryPath, summary, secrets, true);
    console.log(JSON.stringify({ status: summary.status, output: root, checks: summary.checks, error: summary.error, cleanup: summary.cleanup }, null, 2));
    if (summary.status !== "PASS") process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
