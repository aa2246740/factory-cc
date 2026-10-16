import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.js";
import { createBridgeApp, listen } from "../src/http/app.js";
import { createLogger } from "../src/logging.js";
import { trackOwnedProcesses } from "./e2e-processes.js";
import { resolveSelection } from "./e2e-lib.js";
import { verificationArgs, saveVerificationSummary } from "./verification-args.js";

/** A real Chromium DOM driver. No mocked approvals, browser fetch injection, or subscription credentials. */
export async function verifyBrowserControl(summaryPath?: string, connectOnly = false): Promise<Record<string, unknown>> {
  const modulePath = process.env.BRIDGE_BROWSER_MODULE ?? "playwright-core";
  // Optional browser tooling stays outside the production dependency graph.
  const { chromium } = await import(modulePath) as { chromium: any };
  const selection = await resolveSelection();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = resolve("evidence/local", `verify-control-${stamp}`);
  const shots = summaryPath ? join(dirname(summaryPath), `control-browser-${stamp}`) : join(directory, "screenshots");
  const workspace = mkdtempSync(join(tmpdir(), "relay-control-ws-"));
  mkdirSync(directory, { recursive: true }); mkdirSync(shots, { recursive: true });
  const token = randomBytes(24).toString("hex");
  const config = loadConfig({ mode: "sdk", authMode: "byok", permissionMode: "ask", host: "127.0.0.1", port: 0,
    dataDir: join(directory, "bridge-data"), clientToken: token, adminToken: randomBytes(24).toString("hex"), sdkCwd: workspace,
    upstreamBaseUrl: selection.provider.baseUrl, upstreamModel: selection.provider.model, upstreamTokenEnv: selection.provider.tokenEnv,
    requestTimeoutMs: 180_000, persistSessions: true });
  const owned = trackOwnedProcesses();
  const app = createBridgeApp(config, createLogger(config.logDir), join(workspace, "canary.txt"));
  const actions: Array<Record<string, unknown>> = [], screenshots: Array<Record<string, unknown>> = [];
  const requests: Array<{ method: string; path: string; decision?: string; status: number }> = [];
  const report: Record<string, unknown> = { schemaVersion: 1, recordedAt: new Date().toISOString(),
    scope: connectOnly ? "Real Chromium /control DOM connect, refresh and disconnect. No model request is made." : "Real Chromium /control DOM clicks + official Claude Code native Bash against explicit isolated BYOK. /v1/messages fixture supplies the advertised Execute tool; no claim that this is a separate Droid TUI run.",
    modelRequestsStarted: 0,
    connectOnly, driver: "Playwright locator.fill/click; passive browser response listeners; frozen polling in one stale tab only for cancellation race", directory,
    upstream: { baseUrl: selection.provider.baseUrl, model: selection.provider.model }, actions, screenshots, browserRequests: requests };
  let browser: any;
  const capture = async (page: any, name: string) => {
    if (await page.locator("#token").inputValue()) throw new Error("Refusing screenshot with a nonempty token field");
    const path = join(shots, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    screenshots.push({ name, path: relative(process.cwd(), path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
  };
  const connect = async (page: any) => {
    page.on("response", (response: any) => {
      const request = response.request(); const url = new URL(response.url());
      if (url.origin !== app.url || !url.pathname.startsWith("/internal/")) return;
      let decision: string | undefined;
      try { decision = JSON.parse(request.postData() ?? "{}").decision; } catch { /* GET or non-JSON */ }
      requests.push({ method: request.method(), path: url.pathname, ...(decision ? { decision } : {}), status: response.status() });
    });
    await page.goto(`${app.url}/control`);
    await page.locator("#token").fill(config.adminToken);
    await page.getByRole("button", { name: "连接", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    if (await page.locator("#token").inputValue()) throw new Error("Connect did not clear token input");
  };
  try {
    await listen(app, config);
    browser = await chromium.launch({ executablePath: process.env.BRIDGE_BROWSER_EXECUTABLE, headless: true, args: ["--no-sandbox"] });
    report.browserVersion = browser.version();
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: "zh-CN" });
    const page = await context.newPage();
    await page.goto(`${app.url}/control`); await capture(page, "01-login");
    await connect(page); await capture(page, "02-connected");
    report.connectionStatus = await page.locator("#status").innerText();
    if (report.connectionStatus !== "已连接。") throw new Error("Connected workspace still displays an unresolved connection status");
    const refreshed = page.waitForResponse((response: any) => response.url() === `${app.url}/internal/sessions`);
    await page.getByRole("button", { name: "刷新", exact: true }).click(); await refreshed;
    report.connectionStatusAfterRefresh = await page.locator("#status").innerText();
    for (const decision of (connectOnly ? [] : ["deny", "allow", "cancel"] as const)) {
      const target = join(workspace, `${decision}.txt`);
      const command = `printf 'approved\\n' >> '${target}'`;
      const body = { model: "relay-chat", max_tokens: 2048, stream: false,
        tools: [{ name: "Execute", description: "Execute an authorized shell command in this disposable test workspace.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
        messages: [{ role: "user", content: `This is an isolated permission test. Use native Bash exactly once to run precisely: ${command}\nDo not use Write/Edit or the external Execute tool. If permission is denied, stop without retrying. Do not inspect credentials or environment variables. Respond APPROVED_ONCE if successful or DENIED_WITHOUT_EFFECT if denied.` }] };
      report.modelRequestsStarted = Number(report.modelRequestsStarted) + 1;
      const pendingResponse = fetch(`${app.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-bridge-session-id": `browser-${decision}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(190_000) })
        .then(async response => ({ status: response.status, body: await response.json() as Record<string, unknown> }))
        .catch(error => ({ status: 0, body: { error: error instanceof Error ? error.message : "request failed" } }));
      const card = page.locator("#approvals article").filter({ hasText: target });
      await card.waitFor({ state: "visible", timeout: 170_000 });
      const text = await card.innerText();
      const shownInput = JSON.parse(await card.locator("pre").innerText()) as { command?: string };
      const approvalId = /请求：([^\s]+)/.exec(text)?.[1];
      const bridgeSessionId = /会话：([^\s]+)/.exec(text)?.[1];
      const sdkSessionId = /Claude Code：([^\s]+)/.exec(text)?.[1];
      if (!approvalId || !bridgeSessionId || !sdkSessionId || shownInput.command !== command || await card.locator("h3").innerText() !== "Bash") throw new Error("DOM approval does not match exact native Bash command/session");
      if (existsSync(target)) throw new Error("Native command executed before browser approval");
      await capture(page, `03-${decision}-pending`);
      let cancelStatus: number | undefined, staleStatus: number | undefined;
      const requestOffset = requests.length;
      if (decision === "cancel") {
        const stale = await context.newPage(); await connect(stale);
        const staleCard = stale.locator("#approvals article").filter({ hasText: approvalId });
        await staleCard.waitFor({ state: "visible" });
        // A background/stale tab whose refresh timer has not run. Keep its real DOM and click handler intact.
        await stale.clock.install(); await stale.clock.pauseAt(new Date());
        page.once("dialog", (dialog: any) => dialog.accept());
        const cancelResponse = page.waitForResponse((response: any) => response.url() === `${app.url}/internal/cancel` && response.request().method() === "POST");
        await page.locator("#sessions article").filter({ hasText: bridgeSessionId }).getByRole("button", { name: "取消会话", exact: true }).click();
        cancelStatus = (await cancelResponse).status();
        const staleResponse = stale.waitForResponse((response: any) => response.url().endsWith(`/internal/approvals/${approvalId}`) && response.request().method() === "POST");
        await staleCard.getByRole("button", { name: "允许一次", exact: true }).click();
        staleStatus = (await staleResponse).status();
        await stale.locator("#status").filter({ hasText: "请求已结束、过期或被处理" }).waitFor();
        await capture(stale, "04-cancelled-stale-approval-rejected"); await stale.close();
      } else {
        const actionResponse = page.waitForResponse((response: any) => response.url().endsWith(`/internal/approvals/${approvalId}`) && response.request().method() === "POST");
        await card.getByRole("button", { name: decision === "deny" ? "拒绝" : "允许一次", exact: true }).click();
        if ((await actionResponse).status() !== 200) throw new Error("DOM approval action failed");
      }
      const response = await pendingResponse;
      const effect = existsSync(target) ? readFileSync(target, "utf8") : "";
      const posts = requests.slice(requestOffset).filter(row => row.method === "POST" && row.path === `/internal/approvals/${approvalId}`);
      actions.push({ decision, tool: "Bash", exactCommand: shownInput.command === command, bridgeSessionId, sdkSessionId,
        approvalId, approvalPosts: posts, ...(cancelStatus === undefined ? {} : { cancelStatus, staleStatus }), responseStatus: response.status,
        sideEffect: { exists: existsSync(target), content: effect, lines: effect ? effect.split("\n").filter(Boolean).length : 0 },
        passed: posts.length === 1 && (decision === "cancel" ? cancelStatus === 200 && staleStatus === 409 && response.status !== 200 && effect === "" : response.status === 200 && posts[0]?.status === 200 && effect === (decision === "allow" ? "approved\n" : "")) });
      writeFileSync(join(directory, `${decision}-response.json`), JSON.stringify(response, null, 2), { mode: 0o600 });
    }
    await page.getByRole("button", { name: "断开并清除令牌", exact: true }).click();
    await page.locator("#login").waitFor({ state: "visible" });
    report.disconnectClearsInputAndCards = (await page.locator("#token").inputValue()) === "" && await page.locator("#approvals article").count() === 0;
    await capture(page, "05-disconnected");
  } catch (error) {
    report.error = error instanceof Error ? error.message : "Browser control verification failed";
  } finally {
    if (browser) await browser.close();
    await app.close();
    report.processCleanup = await owned.close();
    // Keep sanitized Bridge logs and the captured fixture replies for review,
    // but never retain this run's private Claude configuration after cleanup.
    const privateConfig = join(config.dataDir, "claude-config");
    report.privateConfigExistedBeforeCleanup = existsSync(privateConfig);
    rmSync(privateConfig, { recursive: true, force: true });
    report.privateConfigRemoved = !existsSync(privateConfig);
    rmSync(workspace, { recursive: true, force: true });
    report.workspaceRemoved = !existsSync(workspace);
    const cleanup = report.processCleanup as { complete?: boolean };
    const checks = { actualBrowserConnected: screenshots.some(row => row.name === "02-connected"),
      connectedStatusResolved: report.connectionStatus === "已连接。" && report.connectionStatusAfterRefresh === "已连接。",
      ...(connectOnly ? {} : {
        denyNoWrite: actions.find(row => row.decision === "deny")?.passed === true,
        allowExactlyOneWrite: actions.find(row => row.decision === "allow")?.passed === true,
        cancelRejectsStaleApprovalWithoutWrite: actions.find(row => row.decision === "cancel")?.passed === true,
      }),
      disconnectClearsInputAndCards: report.disconnectClearsInputAndCards === true,
      processCleanupComplete: cleanup.complete === true, privateConfigRemoved: report.privateConfigRemoved === true, workspaceRemoved: report.workspaceRemoved === true };
    report.checks = checks; report.status = !report.error && Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
    writeFileSync(join(directory, "result.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (async () => {
    const argv = process.argv.slice(2);
    if (argv.filter(value => value === "--connect-only").length > 1) throw new Error("--connect-only may be specified once");
    const connectOnly = argv.includes("--connect-only");
    const args = verificationArgs(argv.filter(value => value !== "--connect-only"));
    if (args.help) { console.log("Usage: node --import tsx scripts/verify-browser-control.ts [--summary <new.json>] [--connect-only]\nRequires explicit BRIDGE_UPSTREAM_* BYOK selection and official BRIDGE_CLAUDE_EXECUTABLE. Optional BRIDGE_BROWSER_MODULE points to a playwright-core module installed outside this repo; BRIDGE_BROWSER_EXECUTABLE selects Chromium. Drives actual /control DOM connect, deny, allow, cancel/stale approval and disconnect; preserves screenshots and owned-process cleanup. --connect-only verifies connection text/refresh/disconnect without a model call. --help performs no launch or credential access."); return; }
    const report = await verifyBrowserControl(args.summary, connectOnly); saveVerificationSummary(args.summary, report); console.log(JSON.stringify(report, null, 2));
    if (report.status !== "PASS") process.exitCode = 1;
  })().catch(error => { console.error(error instanceof Error ? error.message : "Browser control verification failed"); process.exitCode = 1; });
}
