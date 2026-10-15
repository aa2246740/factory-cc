import { probeProvider, publicSelection, selectionFromConfig } from "../src/upstream/providers.js";
import { BLOCKED_AUTH_EXIT } from "./lib.js";

const suite = process.argv[2] ?? "e2e-chat";

if (!["e2e-chat", "e2e-mission", "probe"].includes(suite)) {
  console.error(`Unknown gated suite: ${suite}`);
  process.exit(1);
}

const selection = selectionFromConfig({
  baseUrl: process.env.BRIDGE_UPSTREAM_BASE_URL,
  model: process.env.BRIDGE_UPSTREAM_MODEL,
  tokenEnv: process.env.BRIDGE_UPSTREAM_TOKEN_ENV,
});

if (!selection) {
  console.error(`BLOCKED_AUTH: ${suite} needs explicit BRIDGE_UPSTREAM_BASE_URL, BRIDGE_UPSTREAM_MODEL and BRIDGE_UPSTREAM_TOKEN_ENV with a nonempty BYOK key; automatic provider discovery is disabled.`);
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
  const result = await probeProvider(selection.provider, selection.provider.model);
  console.log(JSON.stringify({ selected: publicSelection(selection), ...result }, null, 2));
  process.exit(result.ok ? 0 : 1);
}
