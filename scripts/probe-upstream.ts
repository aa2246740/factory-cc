import { join } from "node:path";
import { probeProvider, publicSelection, selectionFromConfig } from "../src/upstream/providers.js";
import { writeJson } from "./lib.js";

async function main(): Promise<void> {
  const selection = selectionFromConfig({ baseUrl: process.env.BRIDGE_UPSTREAM_BASE_URL,
    model: process.env.BRIDGE_UPSTREAM_MODEL, tokenEnv: process.env.BRIDGE_UPSTREAM_TOKEN_ENV });
  if (!selection) throw new Error("Set explicit BRIDGE_UPSTREAM_BASE_URL, BRIDGE_UPSTREAM_MODEL and BRIDGE_UPSTREAM_TOKEN_ENV; automatic credential discovery is disabled.");
  const result = await probeProvider(selection.provider);
  const attempts = [{ provider: selection.provider.id, ...selection.provider, ...result }];
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
  if (!result.ok) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
