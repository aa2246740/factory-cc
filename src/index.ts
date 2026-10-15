import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createBridgeApp, listen } from "./http/app.js";
import { createLogger } from "./logging.js";
import { publicSelection, selectUpstream, selectionFromConfig } from "./upstream/providers.js";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const logger = createLogger(config.logDir);
  if (config.mode === "sdk" && config.authMode === "subscription") {
    writeFileSync(
      join(config.dataDir, "upstream.json"),
      `${JSON.stringify({ authMode: "subscription", overridesAnthropicEnv: false }, null, 2)}\n`,
    );
    logger.info("upstream", { authMode: "subscription", overridesAnthropicEnv: false });
  } else if (config.mode === "sdk") {
    const preset = selectionFromConfig({
      baseUrl: config.upstreamBaseUrl,
      model: config.upstreamModel,
      tokenEnv: config.upstreamTokenEnv,
    });
    const selected = preset ?? (await selectUpstream()).selection;
    if (!selected) {
      throw new Error("BRIDGE_MODE=sdk needs a working MiniMax/GLM/OpenRouter BYOK probe");
    }
    config.upstreamBaseUrl = selected.provider.baseUrl;
    config.upstreamModel = selected.provider.model;
    config.upstreamTokenEnv = selected.provider.tokenEnv;
    writeFileSync(join(config.dataDir, "upstream.json"), `${JSON.stringify(publicSelection(selected), null, 2)}\n`);
    logger.info("upstream", publicSelection(selected));
  }
  writeFileSync(
    join(config.dataDir, "runtime.env"),
    [
      `BRIDGE_MODE=${config.mode}`,
      `BRIDGE_HOST=${config.host}`,
      `BRIDGE_PORT=${config.port}`,
      `BRIDGE_CLIENT_TOKEN set`,
      `BRIDGE_AUTH=${config.authMode}`,
      `BRIDGE_PERMISSION=${config.permissionMode}`,
      config.upstreamModel ? `BRIDGE_UPSTREAM_MODEL=${config.upstreamModel}` : "",
      config.upstreamBaseUrl ? `BRIDGE_UPSTREAM_BASE_URL=${config.upstreamBaseUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const app = createBridgeApp(config, logger, join(config.sandboxDir, "CANARY.txt"));
  await listen(app, config);
  logger.info("listening", { url: app.url, mode: config.mode });
  console.log(`Relay Bridge listening on ${app.url} mode=${config.mode}`);
  console.log("Health: GET /healthz");
  console.log("Messages: POST /v1/messages");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
