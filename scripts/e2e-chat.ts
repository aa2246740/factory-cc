import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicSelection } from "../src/upstream/providers.js";
import { resolveSelection, rolesSeen, runDroid, startSdkBridge } from "./e2e-lib.js";
import { redactText, writeJson } from "./lib.js";

export async function runE2eChat(): Promise<number> {
  const evidence = join(process.cwd(), "evidence", "local", `e2e-chat-${stamp()}`);
  mkdirSync(evidence, { recursive: true });
  const selection = await resolveSelection();
  writeJson(join(evidence, "upstream.json"), publicSelection(selection));
  const isolated = await startSdkBridge(18793, join(evidence, "bridge-data"), selection);
  try {
    writeFileSync(join(isolated.workspace, "README.md"), "# Chat probe\nReply with RELAY_CHAT_OK.\n");

    const captured = await runDroid(
      ["exec", "--output-format", "json", "-m", "relay-chat", "--auto", "high", "Reply with exactly the token RELAY_CHAT_OK and nothing else."],
      { home: isolated.home, token: isolated.token, cwd: isolated.workspace, timeoutMs: 180_000 },
    );

    const health = await fetch(`${isolated.app.url}/healthz`).then((res) => res.json()) as Record<string, unknown>;
    const runtime = await fetch(`${isolated.app.url}/internal/runtime`, {
      headers: { authorization: `Bearer ${isolated.config.adminToken}` },
    }).then((res) => res.json()) as Record<string, unknown>;
    let result: Record<string, unknown> | undefined;
    try { result = JSON.parse(captured.stdout) as Record<string, unknown>; } catch { /* malformed output fails acceptance */ }
    const textHit = result?.result === "RELAY_CHAT_OK";
    const bridgeHit = isolated.app.records.some((record) => record.authOk && record.role === "chat");
    const status = captured.code === 0 && !captured.timedOut && result?.is_error === false && textHit && bridgeHit ? "PASS" : "FAIL";
    const report = {
      suite: "e2e-chat",
      status,
      nonClaudeModel: true,
      provider: selection.provider.id,
      model: selection.provider.model,
      baseUrl: selection.provider.baseUrl,
      tokenEnv: selection.provider.tokenEnv,
      droid: { code: captured.code, stdout: redactText(captured.stdout).slice(0, 20_000), stderr: redactText(captured.stderr).slice(0, 20_000) },
      roles: rolesSeen(isolated.app),
      requests: isolated.app.records.length,
      health,
      runtime,
      notes: [
        textHit ? "Droid result exactly matched RELAY_CHAT_OK" : "Droid final result did not match the expected marker",
        "Claude login unused. Official Anthropic billing unused.",
      ],
    };
    writeJson(join(evidence, "result.json"), report);
    writeJson(join(process.cwd(), "evidence/e2e-chat.json"), report);
    console.log(JSON.stringify(report, null, 2));
    return status === "PASS" ? 0 : 1;
  } finally {
    await isolated.close();
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runE2eChat().then((code) => process.exit(code)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
