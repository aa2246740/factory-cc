import { mkdirSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createBridgeApp, listen } from "../src/http/app.js";
import { createLogger } from "../src/logging.js";
import { redactText, runCapture, writeJson } from "./lib.js";

interface CaseResult {
  id: string;
  purpose: string;
  factoryCreds: "none";
  airgap: boolean;
  token: "valid" | "invalid" | "n/a";
  command: string[];
  code: number;
  stdout: string;
  stderr: string;
  bridgeRequests: number;
  notes: string[];
}

async function main(): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const evidenceDir = join(process.cwd(), "evidence", `g0-${runId}`);
  mkdirSync(evidenceDir, { recursive: true });

  const token = "probe-token-not-an-anthropic-key";
  const config = loadConfig({
    mode: "mock",
    host: "127.0.0.1",
    port: 18787,
    clientToken: token,
    dataDir: join(evidenceDir, "bridge-data"),
    persistSessions: true,
  });
  const logger = createLogger(config.logDir);
  const app = createBridgeApp(config, logger, join(evidenceDir, "CANARY.txt"));
  writeFileSync(join(evidenceDir, "CANARY.txt"), "RELAY_CANARY_G0FIXED\n");
  await listen(app, config);

  const results: CaseResult[] = [];
  const home = mkdtempSync(join(tmpdir(), "relay-g0-home-"));
  mkdirSync(join(home, ".factory"), { recursive: true });
  writeFileSync(
    join(home, ".factory/settings.json"),
    JSON.stringify(
      {
        customModels: [
          {
            model: "relay-probe",
            displayName: "Relay Probe",
            baseUrl: "http://127.0.0.1:18787",
            apiKey: "${BRIDGE_CLIENT_TOKEN}",
            provider: "anthropic",
            authMode: "bearer",
            maxOutputTokens: 4096,
            extraHeaders: { "X-Bridge-Role": "chat" },
          },
        ],
        missionModelSettings: { skipScrutiny: false, skipUserTesting: false },
      },
      null,
      2,
    ),
  );

  const workspace = mkdtempSync(join(tmpdir(), "relay-g0-ws-"));
  writeFileSync(join(workspace, "CANARY.txt"), "RELAY_CANARY_G0FIXED\n");
  writeFileSync(join(workspace, "MISSION.md"), "# Probe\nReply with the word ping.\n");

  const baseEnv = {
    ...process.env,
    HOME: home,
    BRIDGE_CLIENT_TOKEN: token,
    FACTORY_API_KEY: "",
  };
  delete (baseEnv as { FACTORY_API_KEY?: string }).FACTORY_API_KEY;

  async function runCase(
    id: string,
    purpose: string,
    airgap: boolean,
    envExtra: NodeJS.ProcessEnv,
    args: string[],
    tokenState: CaseResult["token"],
  ): Promise<void> {
    const before = app.records.length;
    const env = { ...baseEnv, ...envExtra };
    if (airgap) env.FACTORY_AIRGAP_ENABLED = "1";
    else delete env.FACTORY_AIRGAP_ENABLED;
    const captured = await runCapture("droid", args, { cwd: workspace, env, timeoutMs: 40_000 });
    results.push({
      id,
      purpose,
      factoryCreds: "none",
      airgap,
      token: tokenState,
      command: ["droid", ...args],
      code: captured.code,
      stdout: redactText(captured.stdout).slice(0, 20_000),
      stderr: redactText(captured.stderr).slice(0, 20_000),
      bridgeRequests: app.records.length - before,
      notes: [],
    });
  }

  await runCase("A0", "public CLI auth gate without airgap", false, {}, ["exec", "-m", "relay-probe", "RELAY_TEXT_PROBE"], "valid");
  await runCase("A1", "airgap env + mock BYOK text", true, {}, ["exec", "-m", "relay-probe", "RELAY_TEXT_PROBE"], "valid");
  await runCase(
    "A2",
    "airgap + wrong local token",
    true,
    { BRIDGE_CLIENT_TOKEN: "wrong-token" },
    ["exec", "-m", "relay-probe", "RELAY_TEXT_PROBE"],
    "invalid",
  );
  await runCase(
    "A3",
    "airgap + readonly tool roundtrip",
    true,
    {},
    ["exec", "-m", "relay-probe", "--list-tools"],
    "valid",
  );
  await runCase(
    "A3b",
    "airgap + tool probe prompt",
    true,
    {},
    ["exec", "-m", "relay-probe", "RELAY_TOOL_PROBE read CANARY.txt RELAY_CANARY_G0FIXED CANARY_PATH=CANARY.txt"],
    "valid",
  );
  await runCase(
    "A4",
    "airgap Mission initial request only",
    true,
    {},
    ["exec", "--mission", "-m", "relay-probe", "--worker-model", "relay-probe", "--validator-model", "relay-probe", "--auto", "high", "-f", "MISSION.md"],
    "valid",
  );

  const help = await runCapture("droid", ["exec", "--help"], { env: { ...baseEnv, FACTORY_AIRGAP_ENABLED: "1" } });
  writeFileSync(join(evidenceDir, "droid-exec-help.txt"), help.stdout + help.stderr);
  writeJson(join(evidenceDir, "cases.json"), results);
  writeJson(join(evidenceDir, "bridge-requests.json"), app.records);

  const md = renderReport(results, { home, workspace, droid: await droidVersion(), settings: join(home, ".factory/settings.json") });
  writeFileSync(join(evidenceDir, "G0-AIRGAP.md"), md);
  writeFileSync(join(process.cwd(), "docs/G0-AIRGAP.md"), md);
  await app.close();
  console.log(md);
}

async function droidVersion(): Promise<string> {
  const r = await runCapture("droid", ["--version"]);
  return (r.stdout || r.stderr).trim();
}

function renderReport(results: CaseResult[], meta: { home: string; workspace: string; droid: string; settings: string }): string {
  const lines = [
    "# G0 Airgap + BYOK probe",
    "",
    `- Date (UTC): ${new Date().toISOString()}`,
    `- Droid: ${meta.droid}`,
    `- Isolated HOME: ${meta.home}`,
    `- Isolated workspace: ${meta.workspace}`,
    `- Settings: ${meta.settings}`,
    `- Factory credentials: none`,
    `- Claude/Anthropic credentials: unused (mock mode)`,
    "",
    "## Cases",
    "",
  ];
  for (const item of results) {
    lines.push(`### ${item.id} — ${item.purpose}`);
    lines.push("");
    lines.push(`- airgap env: ${item.airgap}`);
    lines.push(`- token: ${item.token}`);
    lines.push(`- command: \`${item.command.join(" ")}\``);
    lines.push(`- exit: ${item.code}`);
    lines.push(`- bridge requests this case: ${item.bridgeRequests}`);
    lines.push("");
    lines.push("stdout (redacted):");
    lines.push("```");
    lines.push(item.stdout.trim() || "(empty)");
    lines.push("```");
    lines.push("stderr (redacted):");
    lines.push("```");
    lines.push(item.stderr.trim() || "(empty)");
    lines.push("```");
    lines.push("");
  }
  lines.push("## Authorization notes");
  lines.push("");
  lines.push("- Official airgap documentation describes an enterprise-only build, not this public CLI flag.");
  lines.push("- Observed skip-login or BYOK behavior is an experiment result for this installed version only.");
  lines.push("- This report does not claim official authorization for public CLI airgap use.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

if (!existsSync(join(process.cwd(), "src/index.ts"))) {
  console.error("run from repo root");
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
