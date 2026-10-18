import { readClaudeConfig, assertClaudeCredential, claudeConfigModels, claudeConfigSummary, claudeConfigNeedsLogin, CLAUDE_LOGIN_REQUIRED } from "../src/upstream/claude-config.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildChildEnv, classifyAuth, maskEmail, parseAuthMode, type AuthMode } from "../src/upstream/auth-env.js";
import { execFileAsync, runCapture, writeJson } from "./lib.js";

export interface DoctorSdkQuery {
  accountInfo?: () => Promise<Record<string, unknown>>;
  close?: () => void;
}

export interface DoctorSdk {
  query(args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }): DoctorSdkQuery;
}

async function versionOf(bin: string, args = ["--version"]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 10_000 });
    return (stdout || stderr).trim().split("\n")[0] ?? "unknown";
  } catch (error) {
    return error instanceof Error ? `missing: ${error.message}` : "missing";
  }
}

function parseArgs(argv: string[]): { auth?: AuthMode; help: boolean } {
  let auth: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--auth") throw new Error("Unknown doctor option. Use --auth claude-config, --auth subscription or --auth anthropic-api.");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error("Missing value for --auth.");
    if (auth !== undefined) throw new Error("Duplicate option --auth.");
    auth = value;
  }
  return { auth: auth === undefined ? undefined : parseAuthMode(auth), help: false };
}

function safeText(error: unknown): string {
  const message = error instanceof Error ? error.message : "auth check failed";
  if (/sk-ant-|Bearer |AKIA[0-9A-Z]{8}/.test(message)) return "auth check failed; the error text was withheld because it looked like a credential.";
  return message;
}

/** Never resolves and never yields, so the CLI receives no user prompt and spends no tokens. */
function closedPrompt(): AsyncIterable<unknown> {
  return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }) };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * `--auth subscription` and `--auth anthropic-api` preflight the environment, open an SDK
 * query that never yields a prompt, and print masked accountInfo. The SDK loader is
 * injectable so tests never start a real CLI. Other invocations keep the offline report.
 */
export async function runDoctor(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: { loadSdk?: () => Promise<DoctorSdk> } = {},
): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: npm run doctor -- [--auth claude-config|subscription|anthropic-api]\nThe auth check sends no prompt. It prints names and a masked email only.");
    return 0;
  }
  if (args.auth === "claude-config" || args.auth === "subscription" || args.auth === "anthropic-api") {
    return authDryRun(args.auth, env, deps.loadSdk ?? defaultLoadSdk);
  }

  const node = process.version;
  const droid = await versionOf("droid");
  const claude = await versionOf("claude");
  const git = await versionOf("git");
  const commit = await runCapture("git", ["rev-parse", "HEAD"]);
  const sdkPath = join(process.cwd(), "node_modules/@anthropic-ai/claude-agent-sdk/package.json");
  const sdkVersion = existsSync(sdkPath) ? (JSON.parse(readFileSync(sdkPath, "utf8")).version as string) : "not-installed";
  const claudeCredPresent = existsSync(join(homedir(), ".claude")) || existsSync(join(homedir(), ".config/claude"));
  const factoryHomePresent = existsSync(join(homedir(), ".factory"));

  const report = {
    at: new Date().toISOString(),
    os: `${process.platform} ${process.arch}`,
    node,
    git: git,
    commit: commit.stdout.trim(),
    droid,
    claude,
    sdkVersion,
    bridgeMode: env.BRIDGE_MODE ?? "unset",
    bridgeAuth: args.auth ?? env.BRIDGE_AUTH ?? "byok",
    bridgePermission: env.BRIDGE_PERMISSION ?? "default",
    endpoints: {
      healthz: "GET /healthz",
      messages: "POST /v1/messages",
    },
    auth: {
      anthropicApiKey: env.ANTHROPIC_API_KEY ? "set" : "unset",
      factoryApiKey: env.FACTORY_API_KEY ? "set" : "unset",
      bridgeClientToken: env.BRIDGE_CLIENT_TOKEN ? "set" : "unset",
      minimaxCnApiKey: env.MINIMAXCN_API_KEY ? "set" : "unset",
      glmCnApiKey: env.GLM_CN_API_KEY ? "set" : "unset",
      zaiCodingPlanKey: env.ZAI_CODING_PLAN_KEY ? "set" : "unset",
      openrouterFreeKey: env.OPENROUTER_ONLYUSE_FREEMODEL_API_KEY ? "set" : "unset",
      claudeConfigDirExists: claudeCredPresent,
      defaultFactoryDirExists: factoryHomePresent,
      tokensRead: false,
    },
    notes: [
      "Doctor never reads Claude or Factory credential files and never prints secret values.",
      "GET /healthz returns only ok and mode. Runtime details are GET /internal/runtime with the admin token.",
      "BRIDGE_AUTH=byok is the default and points Claude Code at an explicit upstream. subscription, anthropic-api and cloud refuse conflicting variables. inherit copies the shell environment.",
      "anthropic-api, cloud and subscription are not live-verified yet. Run npm run doctor -- --auth subscription before the first real query; that check sends no prompt.",
      "Official Claude login is unused in cloud BYOK tests.",
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  writeJson(join(process.cwd(), "evidence/doctor.json"), report);
  return 0;
}

async function authDryRun(auth: "claude-config" | "subscription" | "anthropic-api", env: NodeJS.ProcessEnv, loadSdk: () => Promise<DoctorSdk>): Promise<number> {
  let query: DoctorSdkQuery | undefined;
  let sdkStarted = false;
  let classification: ReturnType<typeof classifyAuth> | undefined;
  try {
    const bridgeListen = `${env.BRIDGE_HOST ?? "127.0.0.1"}:${env.BRIDGE_PORT ?? "18787"}`;
    const config = auth === "claude-config" ? readClaudeConfig(env, bridgeListen) : undefined;
    if (config) {
      assertClaudeCredential(config);
      const catalog = claudeConfigModels(config);
      console.log(claudeConfigSummary(config, catalog.models, catalog.defaultModel));
    }
    const childEnv = buildChildEnv(auth, env, undefined, { bridgeListen, claudeConfig: config });
    sdkStarted = true;
    const sdk = await loadSdk();
    query = sdk.query({
      prompt: closedPrompt(),
      options: { settingSources: [], strictMcpConfig: true, env: childEnv,
        ...(config?.helper ? { settings: { apiKeyHelper: config.helper } } : auth === "anthropic-api" && env.BRIDGE_API_KEY_HELPER?.trim() ? { settings: { apiKeyHelper: env.BRIDGE_API_KEY_HELPER.trim() } } : {}) },
    });
    if (!query.accountInfo) throw new Error(`The SDK query does not expose accountInfo(); BRIDGE_AUTH=${auth} cannot be checked.`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const info = await Promise.race([
      query.accountInfo(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("accountInfo timed out after 15s")), 15_000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    const observed = {
      subscriptionType: stringField(info, "subscriptionType"),
      apiKeySource: stringField(info, "apiKeySource"),
      tokenSource: stringField(info, "tokenSource"),
    };
    classification = classifyAuth(observed);
    if (config && claudeConfigNeedsLogin(config) && classification.kind === "unknown") throw new Error(CLAUDE_LOGIN_REQUIRED);
    const report = {
      ok: true,
      auth,
      email: maskEmail(stringField(info, "email")) ?? null,
      subscriptionType: observed.subscriptionType ?? null,
      apiKeySource: observed.apiKeySource ?? null,
      tokenSource: observed.tokenSource ?? null,
      classification,
      promptSent: false,
    };
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, auth, message: auth === "claude-config" && sdkStarted && !(error instanceof Error && error.message === CLAUDE_LOGIN_REQUIRED) ? "Claude Code auth check failed; no prompt sent." : safeText(error), ...(classification ? { classification } : {}), promptSent: false }));
    return 1;
  } finally {
    try { query?.close?.(); } catch { /* already closed */ }
  }
}

async function defaultLoadSdk(): Promise<DoctorSdk> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk as unknown as DoctorSdk;
}

function isEntrypoint(): boolean {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1]!)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  runDoctor().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(safeText(error));
    process.exitCode = 1;
  });
}
