import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createBridgeApp, listen } from "../src/http/app.js";
import { createLogger } from "../src/logging.js";
import { runCapture, writeJson } from "./lib.js";

async function main(): Promise<void> {
  const dir = join(process.cwd(), "evidence/g0-supplemental");
  mkdirSync(dir, { recursive: true });
  const token = "probe-token-not-an-anthropic-key";
  const canary = join(dir, "CANARY.txt");
  writeFileSync(canary, "RELAY_CANARY_G0FIXED\n");
  const config = loadConfig({
    mode: "mock",
    host: "127.0.0.1",
    port: 18791,
    clientToken: token,
    dataDir: join(dir, "bridge-data"),
    persistSessions: true,
  });
  const app = createBridgeApp(config, createLogger(config.logDir), canary);
  await listen(app, config);

  const home = mkdtempSync(join(tmpdir(), "relay-g0s-home-"));
  mkdirSync(join(home, ".factory"), { recursive: true });
  const models = ["chat", "orchestrator", "worker", "validator"].map((role) => ({
    model: `relay-${role}`,
    displayName: `Relay ${role}`,
    baseUrl: "http://127.0.0.1:18791",
    apiKey: "${BRIDGE_CLIENT_TOKEN}",
    provider: "anthropic",
    authMode: "bearer",
    maxOutputTokens: 4096,
    extraHeaders: { "X-Bridge-Role": role },
  }));
  writeFileSync(join(home, ".factory/settings.json"), JSON.stringify({ customModels: models, missionModelSettings: { skipScrutiny: false, skipUserTesting: false } }, null, 2));
  const ws = mkdtempSync(join(tmpdir(), "relay-g0s-ws-"));
  writeFileSync(join(ws, "MISSION.md"), "# Probe\nReply with the word ping. Do not spawn workers if you only need to greet.\n");
  writeFileSync(join(ws, "CANARY.txt"), "RELAY_CANARY_G0FIXED\n");

  const env = { ...process.env, HOME: home, BRIDGE_CLIENT_TOKEN: token, FACTORY_AIRGAP_ENABLED: "1" };
  delete (env as { FACTORY_API_KEY?: string }).FACTORY_API_KEY;

  const a3 = await runCapture(
    "droid",
    ["exec", "-m", "relay-chat", `RELAY_TOOL_PROBE read the canary RELAY_CANARY_G0FIXED CANARY_PATH=${canary}`],
    { cwd: ws, env, timeoutMs: 40_000 },
  );
  const a4 = await runCapture(
    "droid",
    [
      "exec",
      "--mission",
      "-m",
      "relay-orchestrator",
      "--worker-model",
      "relay-worker",
      "--validator-model",
      "relay-validator",
      "--auto",
      "high",
      "-f",
      "MISSION.md",
    ],
    { cwd: ws, env, timeoutMs: 40_000 },
  );

  const out = {
    a3: { code: a3.code, stdout: a3.stdout, stderr: a3.stderr },
    a4: { code: a4.code, stdout: a4.stdout, stderr: a4.stderr },
    rolesSeen: app.records.map((r) => r.role),
    requests: app.records,
  };
  writeJson(join(dir, "result.json"), out);
  console.log(JSON.stringify(out, null, 2));
  await app.close();
}

main();
