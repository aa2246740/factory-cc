import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isLoopbackHost, loadConfig } from "./config.js";
import { createBridgeApp, listen, type BridgeApp } from "./http/app.js";
import { createLogger, type Logger } from "./logging.js";
import { preflightAuth } from "./upstream/auth-env.js";
import { publicSelection, selectionFromConfig } from "./upstream/providers.js";

export function installShutdownHandlers(
  app: Pick<BridgeApp, "close" | "server">,
  logger: Logger,
  timeoutMs = 10_000,
): () => void {
  let shuttingDown = false;
  let deadline: NodeJS.Timeout | undefined;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exitCode ??= 0;
    logger.info("shutdown_started", { signal });
    // The official SDK closes stdin, then allows 2s before SIGTERM and 5s more
    // before SIGKILL. Do not exit immediately when its synchronous close returns.
    // Keep the deadline unref'ed so a fully drained process exits naturally.
    deadline = setTimeout(() => {
      logger.error("shutdown_timeout", { timeoutMs });
      app.server.closeAllConnections();
      process.exit(1);
    }, timeoutMs);
    deadline.unref();
    void (async () => {
      try {
        await app.close();
        logger.info("shutdown_complete", { signal });
      } catch (error) {
        process.exitCode = 1;
        logger.error("shutdown_failed", { message: error instanceof Error ? error.message : String(error) });
        app.server.closeAllConnections();
      }
    })();
  };
  const onInterrupt = (): void => shutdown("SIGINT");
  const onTerminate = (): void => shutdown("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  return () => {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    if (deadline) clearTimeout(deadline);
  };
}

function envProvided(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value !== "";
}

/** Atomic 0600 write that refuses to follow a symlink, matching scripts/local.ts privateWrite. */
function privateTokenFile(path: string, token: string): void {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Refusing to replace ${path}: not a regular file.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const logger = createLogger(config.logDir);
  if (config.mode === "sdk") {
    const bridgeListen = `${config.host}:${config.port}`;
    if (config.authMode === "byok") {
      const selected = selectionFromConfig({
        baseUrl: config.upstreamBaseUrl,
        model: config.upstreamModel,
        tokenEnv: config.upstreamTokenEnv,
      });
      if (!selected) {
        throw new Error("BYOK requires explicit BRIDGE_UPSTREAM_BASE_URL, BRIDGE_UPSTREAM_MODEL and BRIDGE_UPSTREAM_TOKEN_ENV; automatic credential discovery is disabled.");
      }
      preflightAuth(config.authMode, process.env, selected, { bridgeListen });
      config.upstreamBaseUrl = selected.provider.baseUrl;
      config.upstreamModel = selected.provider.model;
      config.upstreamTokenEnv = selected.provider.tokenEnv;
      writeFileSync(join(config.dataDir, "upstream.json"), `${JSON.stringify(publicSelection(selected), null, 2)}\n`);
      logger.info("upstream", publicSelection(selected));
    } else {
      // Fail closed before listen. The same checks run again for each query.
      preflightAuth(config.authMode, process.env, undefined, { bridgeListen });
      const record = { authMode: config.authMode, overridesAnthropicEnv: false };
      writeFileSync(join(config.dataDir, "upstream.json"), `${JSON.stringify(record, null, 2)}\n`);
      logger.info("upstream", record);
    }
    if (!envProvided("BRIDGE_ADMIN_TOKEN")) {
      const adminPath = join(config.dataDir, "admin-token");
      privateTokenFile(adminPath, config.adminToken);
      console.log(`Admin token file: ${adminPath}`);
    }
    if (!envProvided("BRIDGE_HOOK_TOKEN")) {
      const hookPath = join(config.dataDir, "hook-token");
      privateTokenFile(hookPath, config.hookToken);
      console.log(`Hook token file: ${hookPath}`);
    }
  }
  if (!isLoopbackHost(config.host)) {
    const warning = "Remote access serves the operator's credentials to other clients. The operator is responsible for terms compliance.";
    logger.warn("remote_exposure", { host: config.host });
    console.warn(warning);
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
  const removeShutdownHandlers = installShutdownHandlers(app, logger);
  try {
    await listen(app, config);
  } catch (error) {
    await app.close().catch(() => undefined);
    removeShutdownHandlers();
    throw error;
  }
  logger.info("listening", { url: app.url, mode: config.mode });
  console.log(`Relay Bridge listening on ${app.url} mode=${config.mode}`);
  console.log("Health: GET /healthz");
  console.log("Messages: POST /v1/messages");
}

function isEntrypoint(): boolean {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1]!)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
