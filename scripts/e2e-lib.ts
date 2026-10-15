import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import { createBridgeApp, listen, type BridgeApp } from "../src/http/app.js";
import { createLogger } from "../src/logging.js";
import { publicSelection, selectUpstream, selectionFromConfig, type UpstreamSelection } from "../src/upstream/providers.js";
import { runCapture, writeJson } from "./lib.js";

export interface IsolatedBridge {
  app: BridgeApp;
  config: BridgeConfig;
  token: string;
  home: string;
  workspace: string;
  selection: UpstreamSelection;
}

export async function resolveSelection(): Promise<UpstreamSelection> {
  const preset = selectionFromConfig({
    baseUrl: process.env.BRIDGE_UPSTREAM_BASE_URL,
    model: process.env.BRIDGE_UPSTREAM_MODEL,
    tokenEnv: process.env.BRIDGE_UPSTREAM_TOKEN_ENV,
  });
  if (preset) return preset;
  const { selection } = await selectUpstream();
  if (!selection) {
    throw new Error("no usable BYOK upstream (MiniMax / GLM / OpenRouter free)");
  }
  return selection;
}

export async function startSdkBridge(port: number, dataDir: string, selection: UpstreamSelection): Promise<IsolatedBridge> {
  const token = `e2e-${port}-not-an-anthropic-key`;
  const config = loadConfig({
    mode: "sdk",
    host: "127.0.0.1",
    port,
    clientToken: token,
    dataDir,
    persistSessions: true,
    requestTimeoutMs: 180_000,
    maxTurns: 80,
    upstreamBaseUrl: selection.provider.baseUrl,
    upstreamModel: selection.provider.model,
    upstreamTokenEnv: selection.provider.tokenEnv,
  });
  mkdirSync(join(dataDir, "sandbox"), { recursive: true });
  writeFileSync(join(dataDir, "sandbox", "CANARY.txt"), "RELAY_CANARY_E2E\n");
  writeJson(join(dataDir, "upstream.json"), publicSelection(selection));
  const app = createBridgeApp(config, createLogger(config.logDir), join(dataDir, "sandbox", "CANARY.txt"));
  await listen(app, config);
  const home = mkdtempSync(join(tmpdir(), "relay-e2e-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "relay-e2e-ws-"));
  mkdirSync(join(home, ".factory"), { recursive: true });
  process.env.BRIDGE_DROID_HOME = home;
  writeFileSync(
    join(home, ".factory/settings.json"),
    `${JSON.stringify(
      {
        customModels: ["chat", "orchestrator", "worker", "validator"].map((role) => ({
          model: `relay-${role}`,
          displayName: `Relay ${role}`,
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey: "${BRIDGE_CLIENT_TOKEN}",
          provider: "anthropic",
          authMode: "bearer",
          maxOutputTokens: 4096,
          extraHeaders: { "X-Bridge-Role": role },
        })),
        missionModelSettings: { skipScrutiny: false, skipUserTesting: false },
      },
      null,
      2,
    )}\n`,
  );
  return { app, config, token, home, workspace, selection };
}

export function droidEnv(home: string, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    BRIDGE_CLIENT_TOKEN: token,
    FACTORY_AIRGAP_ENABLED: "1",
    FACTORY_API_KEY: "",
  };
  delete env.FACTORY_API_KEY;
  return env;
}

export async function runDroid(
  args: string[],
  opts: { home: string; token: string; cwd: string; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCapture("droid", args, {
    cwd: opts.cwd,
    env: droidEnv(opts.home, opts.token),
    timeoutMs: opts.timeoutMs,
  });
}

export function rolesSeen(app: BridgeApp): string[] {
  return app.records.map((record) => record.role);
}

export function startDroidDaemon(home: string, token: string, port: number): { child: ChildProcess; stop: () => void } {
  const child = spawn("droid", ["daemon", "--host", "127.0.0.1", "--port", String(port)], {
    env: droidEnv(home, token),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    child,
    stop: () => {
      child.kill("SIGTERM");
    },
  };
}

export async function seedMissionPack(home: string, workingDirectory: string, timeoutMs = 45_000): Promise<string | undefined> {
  const pack = join(process.cwd(), "fixtures/mission-pack");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const root = join(home, ".factory/missions");
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        if (!statSync(dir).isDirectory()) continue;
        writeMissionPack(pack, dir, workingDirectory);
        return dir;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

function writeMissionPack(pack: string, dest: string, workingDirectory: string): void {
  const files = [
    "features.json",
    "validation-contract.md",
    "validation-state.json",
    "AGENTS.md",
    "services.yaml",
    "init.sh",
    "skills/backend-worker/SKILL.md",
  ];
  for (const rel of files) {
    const source = join(pack, rel);
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    const text = readFileSync(source, "utf8").replaceAll("{{WORKING_DIRECTORY}}", workingDirectory);
    writeFileSync(target, text);
    if (rel.endsWith(".sh")) chmodSync(target, 0o755);
  }
}
