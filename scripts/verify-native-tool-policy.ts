#!/usr/bin/env -S node --import tsx
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beginFactoryLaunch, endFactoryLaunch, resolveSelection, runDroid, startSdkBridge } from "./e2e-lib.js";
import { saveVerificationSummary, verificationArgs } from "./verification-args.js";

export function transcriptTools(directory: string): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && statSync(path).size < 20_000_000) {
        for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
          const row = JSON.parse(line) as { message?: { content?: Array<Record<string, unknown>> } };
          if (Array.isArray(row.message?.content)) result.push(...row.message.content.filter((block) => block.type === "tool_use" || block.type === "tool_result"));
        }
      }
    }
  };
  walk(join(directory, "projects"));
  return result;
}

export async function verifyNativeToolPolicy(): Promise<Record<string, unknown>> {
  const directory = resolve("evidence/local", `verify-native-policy-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(directory, { recursive: true });
  const isolated = await startSdkBridge(0, join(directory, "bridge"), await resolveSelection());
  const results: Array<Record<string, unknown>> = [];
  const report: Record<string, unknown> = { schemaVersion: 1, recordedAt: new Date().toISOString(), directory, actions: results };
  try {
    writeFileSync(join(isolated.workspace, "fixture.txt"), "READ_POLICY_NONCE_98371\n");
    const run = async (name: string, tools: string, prompt: string, sessionId?: string) => {
      const launchId = await beginFactoryLaunch(isolated);
      const args = ["exec", "--model", "relay-chat", "--auto", "high", "--output-format", "json", "--only-tools", tools,
        ...(sessionId ? ["--session-id", sessionId] : []), prompt];
      const captured = await runDroid(args, { home: isolated.home, token: isolated.token, cwd: isolated.workspace, timeoutMs: 600_000, launchId });
      await endFactoryLaunch(isolated, launchId, captured.code !== 0);
      let result: Record<string, unknown> = {};
      try { result = JSON.parse(captured.stdout.trim()) as Record<string, unknown>; } catch { /* preserved output explains failure */ }
      results.push({ name, args, ...captured, result, nativeTools: transcriptTools(join(directory, "bridge/claude-config")),
        forbiddenFileExists: existsSync(join(isolated.workspace, "forbidden.txt")), allowedFileExists: existsSync(join(isolated.workspace, "allowed.txt")),
        allowedFileContent: existsSync(join(isolated.workspace, "allowed.txt")) ? readFileSync(join(isolated.workspace, "allowed.txt"), "utf8") : null,
        sdkSessions: isolated.app.store.list().map((session) => ({ id: session.bridgeSessionId, sdkSessionId: session.sdkSessionId, state: session.state })) });
      return typeof result.session_id === "string" ? result.session_id : undefined;
    };
    const sessionId = await run("read-only-denial", "Read", "This is a disposable permission-boundary verification. Use your native Bash tool exactly once to execute: printf NATIVE_POLICY_VIOLATION > forbidden.txt . If the tool is denied, report that denial and stop; do not try alternate tools. Then use Read to read fixture.txt and quote its contents. Do not inspect environment variables or credentials.");
    if (!sessionId) throw new Error("First real Droid invocation did not return its session ID");
    await run("expanded-permission", "Read,Execute", "The current host tool set now includes Execute. Use native Bash exactly once: printf NATIVE_POLICY_ALLOWED > allowed.txt . Then reply ALLOWED_DONE only.", sessionId);
    rmSync(join(isolated.workspace, "forbidden.txt"), { force: true });
    await run("permission-revoked", "Read", "The host now authorizes Read only. For this disposable regression test attempt native Bash exactly once: printf NATIVE_POLICY_VIOLATION > forbidden.txt . If denied stop and report DENIED as your final line. Do not use alternate tools.", sessionId);
    report.runtime = isolated.app.runtimeStatus();
    report.nativeUsage = existsSync(join(directory, "bridge/logs/turns.jsonl")) ? readFileSync(join(directory, "bridge/logs/turns.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => { const turn = JSON.parse(line); return { session: turn.session, sdkSessionId: turn.sdkSessionId, usage: turn.usage }; }) : [];
  } finally {
    await isolated.close();
    report.processCleanup = isolated.processCleanup;
    rmSync(isolated.home, { recursive: true, force: true });
    rmSync(isolated.workspace, { recursive: true, force: true });
    report.ownedDirectoriesRemoved = !existsSync(isolated.home) && !existsSync(isolated.workspace);
    const latestBashWasDenied = (action: Record<string, unknown> | undefined): boolean => {
      const blocks = (action?.nativeTools ?? []) as Array<Record<string, unknown>>;
      const use = blocks.filter((block) => block.type === "tool_use" && block.name === "Bash").at(-1);
      return Boolean(use && blocks.some((block) => block.type === "tool_result" && block.tool_use_id === use.id && block.is_error === true
        && JSON.stringify(block.content).includes("BRIDGE_HOST_TOOL_NOT_ADVERTISED")));
    };
    const ids = results.flatMap((action) => (action.sdkSessions as Array<{ sdkSessionId?: string }>).map((session) => session.sdkSessionId));
    const checks = {
      allDroidActionsSucceeded: results.length === 3 && results.every((action) => action.code === 0 && !action.timedOut),
      readOnlyWriteBlocked: results[0]?.forbiddenFileExists === false && latestBashWasDenied(results[0]),
      expandedWriteCompleted: results[1]?.allowedFileContent === "NATIVE_POLICY_ALLOWED",
      revokedWriteBlocked: results[2]?.forbiddenFileExists === false && latestBashWasDenied(results[2]),
      sameNativeSession: ids.length >= 3 && ids.every((id) => Boolean(id) && id === ids[0]),
      processCleanupComplete: isolated.processCleanup?.complete === true,
      ownedDirectoriesRemoved: report.ownedDirectoriesRemoved === true,
    };
    report.checks = checks;
    report.status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
    writeFileSync(join(directory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (async () => {
    const args = verificationArgs(process.argv.slice(2));
    if (args.help) {
      console.log("Usage: tsx scripts/verify-native-tool-policy.ts [--summary <new.json>]\nRuns real isolated Droid/Claude BYOK: Read-only denial, Execute expansion, then revocation in the same native session. Requires explicit BRIDGE_UPSTREAM_BASE_URL, BRIDGE_UPSTREAM_MODEL, BRIDGE_UPSTREAM_TOKEN_ENV. --help performs no launch, credential access, or model call.");
      return;
    }
    const report = await verifyNativeToolPolicy();
    saveVerificationSummary(args.summary, report);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "PASS") process.exitCode = 1;
  })().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Native policy verification failed"); process.exitCode = 1; });
}
