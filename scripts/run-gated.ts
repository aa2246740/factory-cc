import { hasByokSecrets } from "../src/upstream/providers.js";
import { BLOCKED_AUTH_EXIT } from "./lib.js";

const suite = process.argv[2] ?? "e2e-chat";

if (!hasByokSecrets()) {
  console.error(`BLOCKED_AUTH: ${suite} needs MiniMax/GLM/OpenRouter BYOK secrets or a user Claude login.`);
  console.error("Mock/protocol/fake SDK-probe tests remain available via npm test.");
  process.exit(BLOCKED_AUTH_EXIT);
}

if (suite === "e2e-chat") {
  const { runE2eChat } = await import("./e2e-chat.js");
  process.exit(await runE2eChat());
} else if (suite === "e2e-mission") {
  const { runE2eMission } = await import("./e2e-mission.js");
  process.exit(await runE2eMission());
} else if (suite === "probe") {
  const { run } = await import("node:child_process");
  const child = run("npx tsx scripts/probe-upstream.ts", (error) => {
    process.exit(error ? 1 : 0);
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
} else {
  console.error(`Unknown gated suite: ${suite}`);
  process.exit(1);
}
