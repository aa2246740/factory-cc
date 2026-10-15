import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BLOCKED_AUTH_EXIT } from "./lib.js";

const suite = process.argv[2] ?? "e2e-chat";

const hasAnthropic =
  Boolean(process.env.ANTHROPIC_API_KEY) ||
  Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) ||
  existsSync(join(homedir(), ".claude/.credentials.json"));

if (!hasAnthropic) {
  console.error(`BLOCKED_AUTH: ${suite} needs a user-completed official Claude Code login or authorized API credential.`);
  console.error("Mock/protocol/fake SDK-probe tests remain available via npm test.");
  process.exit(BLOCKED_AUTH_EXIT);
}

console.error(`BLOCKED_AUTH: credentials appear present but this environment is forbidden from spending them automatically.`);
process.exit(BLOCKED_AUTH_EXIT);
