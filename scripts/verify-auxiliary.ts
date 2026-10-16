#!/usr/bin/env -S node --import tsx
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beginFactoryLaunch, droidEnv, endFactoryLaunch, resolveSelection, runE2eCommand, startSdkBridge } from "./e2e-lib.js";
import { nativeOutputCapabilities } from "../src/runtime/factory-capabilities.js";
import { transcriptTools } from "./verify-native-tool-policy.js";
import { saveVerificationSummary, verificationArgs } from "./verification-args.js";

/** Real CLI reachability probe. The local Factory API sink refuses every request. */
export async function verifyAuxiliary(): Promise<Record<string, unknown>> {
  const directory = resolve("evidence/local", `verify-auxiliary-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(directory, { recursive: true });
  const sinkRequests: Array<{ method: string; path: string; status: number }> = [];
  const sink = createServer((request, response) => {
    sinkRequests.push({ method: request.method ?? "", path: new URL(request.url ?? "/", "http://localhost").pathname, status: 403 });
    request.resume();
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Factory-hosted model access is not authorized for this isolated BYOK verification." }));
  });
  await new Promise<void>((done) => sink.listen(0, "127.0.0.1", done));
  const address = sink.address();
  if (!address || typeof address === "string") throw new Error("Missing sink address");
  const factoryApi = `http://127.0.0.1:${address.port}`;
  let isolated: Awaited<ReturnType<typeof startSdkBridge>> | undefined;
  const actions: Array<Record<string, unknown>> = [];
  const report: Record<string, unknown> = {
    schemaVersion: 1, recordedAt: new Date().toISOString(), mode: "real-droid-native-sdk-isolated-byok",
    auxiliaryClassifiersVerified: false,
    note: "Factory API base overrides point to an explicit 403 sink. No hosted model is mocked or authorized. This observes only requests that honor those official overrides, not all egress.",
    nativeOutputCapabilities,
  };
  try {
    isolated = await startSdkBridge(0, join(directory, "bridge"), await resolveSelection());
    const active = isolated;
    const executable = process.env.BRIDGE_DROID_EXECUTABLE ?? "droid";
    const run = async (name: string, args: string[], timeoutMs: number) => {
      const before = active.app.records.length;
      const launchId = await beginFactoryLaunch(active);
      const env = { ...droidEnv(active.home, active.token, launchId), FACTORY_API_BASE_URL: factoryApi, FACTORY_API_BASE_URL_EU: factoryApi };
      const command = ["exec", "--settings", active.settingsPath, "--cwd", active.workspace, ...args];
      const result = await runE2eCommand(executable, command, { cwd: active.workspace, env, timeoutMs });
      await endFactoryLaunch(active, launchId, result.code !== 0);
      const action = { name, args, ...result, bridgeRequests: active.app.records.slice(before).map((record) => ({ authOk: record.authOk, role: record.role })) };
      actions.push(action);
      writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(action, null, 2)}\n`);
      return result;
    };
    await run("tool-catalog", ["--model", "relay-chat", "--list-tools"], 60_000);
    await run("auto-model", ["--model", "auto", "--output-format", "json", "Reply AUX_AUTO_OK only. Do not use tools."], 120_000);
    await run("native-command", ["--model", "relay-chat", "--auto", "low", "--output-format", "json", "--only-tools", "Execute", "Use the shell exactly once to execute printf AUX_COMMAND_OK. Then reply AUX_COMMAND_OK only. Do not inspect environment variables or credentials."], 600_000);
    const toolCatalog = String(actions[0]?.stdout ?? "");
    const imageAdvertised = /GenerateImage/.test(toolCatalog);
    report.imageAdvertised = imageAdvertised;
    if (imageAdvertised) {
      await run("image-tool-denial", ["--model", "relay-chat", "--auto", "low", "--output-format", "json", "--only-tools", "GenerateImage", "Call the GenerateImage tool exactly once with prompt 'A plain blue square'. If it fails, report the error accurately and stop. Do not create image files by any other method."], 600_000);
    }
    const specialized = await fetch(`${active.app.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${active.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "shield-risk", max_tokens: 128, messages: [{ role: "user", content: "Synthetic placeholder" }], response_format: { type: "json_schema", json_schema: { strict: true, schema: { type: "object" } } }, logprobs: true, top_logprobs: 2 }),
    });
    report.specializedOutputGuard = { status: specialized.status, body: await specialized.json() };
    report.actions = actions;
    report.sessions = active.app.store.list().map((session) => ({ id: session.bridgeSessionId, state: session.state, sdkSessionId: session.sdkSessionId }));
    report.runtime = active.app.runtimeStatus();
    report.factoryApiSinkRequests = sinkRequests;
    report.onlyToolsLimitation = "Factory Execute is mapped to native Claude Bash; this does not execute Factory command-risk or Droid Shield classifiers. Factory Local Signals requires its separate consent/feature configuration.";
    report.nativeTools = transcriptTools(join(directory, "bridge/claude-config"));
    const turnPath = join(directory, "bridge/logs/turns.jsonl");
    report.nativeUsage = existsSync(turnPath) ? readFileSync(turnPath, "utf8").split("\n").filter(Boolean).map((line) => { const turn = JSON.parse(line); return { sdkSessionId: turn.sdkSessionId, usage: turn.usage }; }) : [];
  } finally {
    await isolated?.close();
    report.processCleanup = isolated?.processCleanup;
    await new Promise<void>((done, reject) => sink.close((error) => error ? reject(error) : done()));
    if (isolated) {
      rmSync(isolated.home, { recursive: true, force: true });
      rmSync(isolated.workspace, { recursive: true, force: true });
      report.ownedDirectoriesRemoved = !existsSync(isolated.home) && !existsSync(isolated.workspace);
    }
    const proof = readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(join(directory, name))).digest("hex") }));
    report.retainedActionEvidence = proof;
    report.evidenceDirectory = directory;
    const native = report.nativeTools as Array<Record<string, unknown>> | undefined;
    const bashUse = native?.find((block) => block.type === "tool_use" && block.name === "Bash");
    const nativeAction = actions.find((action) => action.name === "native-command");
    const auto = actions.find((action) => action.name === "auto-model");
    const checks = {
      toolCatalogRead: actions.find((action) => action.name === "tool-catalog")?.code === 0,
      autoRejectedBeforeInference: auto?.code === 1 && String(auto?.stderr).includes("Invalid model: auto") && (auto?.bridgeRequests as unknown[] | undefined)?.length === 0,
      nativeCommandSucceeded: nativeAction?.code === 0 && (nativeAction.bridgeRequests as unknown[]).length > 0,
      nativeBashResultObserved: Boolean(bashUse && native?.some((block) => block.type === "tool_result" && block.tool_use_id === bashUse.id && block.is_error !== true && JSON.stringify(block.content).includes("AUX_COMMAND_OK"))),
      unsupportedContractRejected: (report.specializedOutputGuard as { status?: number } | undefined)?.status === 422,
      processCleanupComplete: isolated?.processCleanup?.complete === true,
      ownedDirectoriesRemoved: report.ownedDirectoriesRemoved === true,
    };
    report.checks = checks;
    report.status = Object.values(checks).every(Boolean) ? "SCOPED_PASS" : "FAIL";
    writeFileSync(join(directory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (async () => {
    const args = verificationArgs(process.argv.slice(2));
    if (args.help) {
      console.log("Usage: tsx scripts/verify-auxiliary.ts [--summary <new.json>]\nRuns isolated real Droid catalog, Auto rejection, native shell and specialized-output rejection checks. Factory API overrides use a 403 sink; hosted models are not authorized or mocked. SCOPED_PASS does not verify unavailable Factory classifiers. Requires explicit BRIDGE_UPSTREAM_BASE_URL, BRIDGE_UPSTREAM_MODEL, BRIDGE_UPSTREAM_TOKEN_ENV. --help performs no model or credential access.");
      return;
    }
    const report = await verifyAuxiliary();
    saveVerificationSummary(args.summary, report);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "SCOPED_PASS") process.exitCode = 1;
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Auxiliary verification failed");
    process.exitCode = 1;
  });
}
