import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createBridgeApp, listen } from "./http/app.js";
import { createLogger } from "./logging.js";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const logger = createLogger(config.logDir);
  writeFileSync(
    join(config.dataDir, "runtime.env"),
    [
      `BRIDGE_MODE=${config.mode}`,
      `BRIDGE_HOST=${config.host}`,
      `BRIDGE_PORT=${config.port}`,
      `BRIDGE_CLIENT_TOKEN set`,
    ].join("\n"),
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
