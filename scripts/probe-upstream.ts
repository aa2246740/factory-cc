import { join } from "node:path";
import { publicSelection, selectUpstream } from "../src/upstream/providers.js";
import { writeJson } from "./lib.js";

async function main(): Promise<void> {
  const { selection, attempts } = await selectUpstream();
  const report = {
    at: new Date().toISOString(),
    selected: selection ? publicSelection(selection) : null,
    attempts: attempts.map((item) => ({
      provider: item.provider,
      label: item.label,
      baseUrl: item.baseUrl,
      model: item.model,
      tokenEnv: item.tokenEnv,
      ok: item.ok,
      status: item.status,
      stopReason: item.stopReason,
      toolName: item.toolName,
      error: item.error,
    })),
    notes: [
      "Probe never prints secret values.",
      "Claude Code env uses ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN with ANTHROPIC_API_KEY empty.",
      "ANTHROPIC_BASE_URL is never the Relay Bridge listen address.",
    ],
  };
  writeJson(join(process.cwd(), "evidence/upstream-probe.json"), report);
  console.log(JSON.stringify(report, null, 2));
  if (!selection) process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
