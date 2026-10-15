import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileAsync, runCapture, writeJson } from "./lib.js";

async function versionOf(bin: string, args = ["--version"]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 10_000 });
    return (stdout || stderr).trim().split("\n")[0] ?? "unknown";
  } catch (error) {
    return error instanceof Error ? `missing: ${error.message}` : "missing";
  }
}

async function main(): Promise<void> {
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
    bridgeMode: process.env.BRIDGE_MODE ?? "unset",
    bridgeAuth: process.env.BRIDGE_AUTH ?? "byok",
    bridgePermission: process.env.BRIDGE_PERMISSION ?? "default",
    endpoints: {
      healthz: "GET /healthz",
      messages: "POST /v1/messages",
    },
    auth: {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ? "set" : "unset",
      factoryApiKey: process.env.FACTORY_API_KEY ? "set" : "unset",
      bridgeClientToken: process.env.BRIDGE_CLIENT_TOKEN ? "set" : "unset",
      minimaxCnApiKey: process.env.MINIMAXCN_API_KEY ? "set" : "unset",
      glmCnApiKey: process.env.GLM_CN_API_KEY ? "set" : "unset",
      zaiCodingPlanKey: process.env.ZAI_CODING_PLAN_KEY ? "set" : "unset",
      openrouterFreeKey: process.env.OPENROUTER_ONLYUSE_FREEMODEL_API_KEY ? "set" : "unset",
      claudeConfigDirExists: claudeCredPresent,
      defaultFactoryDirExists: factoryHomePresent,
      tokensRead: false,
    },
    notes: [
      "Doctor never reads Claude or Factory credential files and never prints secret values.",
      "BRIDGE_AUTH=byok (default) points Claude Code at MiniMax/GLM. BRIDGE_AUTH=subscription does not override ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY.",
      "Official Claude login is unused in cloud BYOK tests.",
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  writeJson(join(process.cwd(), "evidence/doctor.json"), report);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
