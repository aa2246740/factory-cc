import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { cursorMenuFromCatalog } from "../../src/runtime/cursor/catalog.js";
import { cursorCatalogFixture } from "../../src/runtime/cursor/fixture.js";
import { createRuntime } from "../../src/runtime/factory.js";
import { RouterRuntime } from "../../src/runtime/router-runtime.js";
import { SdkRuntime } from "../../src/runtime/sdk-runtime.js";
import type { BridgeRuntime, RuntimeRequest, RuntimeTurn } from "../../src/runtime/types.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import type { SessionRecord } from "../../src/sessions/state.js";

function session(id: string, provider?: SessionRecord["provider"]): SessionRecord {
  return {
    bridgeSessionId: id, role: "chat", state: "IDLE", model: provider === "cursor" ? "cursor:composer-2.5" : "sonnet",
    ...(provider ? { provider } : {}), toolNames: [], createdAt: "", updatedAt: "", pendingToolIds: [],
    cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: true },
  };
}

function request(record: SessionRecord): RuntimeRequest {
  return { request: { model: record.model, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }, role: "chat", session: record, headers: {} };
}

class ProbeRuntime implements BridgeRuntime {
  readonly kind = "sdk" as const;
  readonly calls: string[] = [];
  constructor(private readonly label: string) {}
  async handle(input: RuntimeRequest): Promise<RuntimeTurn> {
    this.calls.push(`handle:${input.session.bridgeSessionId}`);
    return { response: assistantMessage(input.request.model, [{ type: "text", text: this.label }], "end_turn"), pendingToolIds: [] };
  }
  async cancel(sessionId: string): Promise<void> { this.calls.push(`cancel:${sessionId}`); }
  async interrupt(sessionId: string): Promise<boolean> { this.calls.push(`interrupt:${sessionId}`); return true; }
  pendingHostCalls(sessionId: string) { this.calls.push(`pending:${sessionId}`); return [{ toolUseId: "t", toolName: "Execute", input: {} }]; }
  async deliverResults(sessionId: string) { this.calls.push(`deliver:${sessionId}`); return ["accepted" as const]; }
  async close(): Promise<void> { this.calls.push("close"); }
  describe() { return { kind: this.label }; }
}

describe("RouterRuntime", () => {
  it("routes by session owner and does not ask both runtimes", async () => {
    const claude = new ProbeRuntime("claude");
    const cursor = new ProbeRuntime("cursor");
    const router = new RouterRuntime(claude, cursor);
    await router.handle(request(session("c1")));
    await router.handle(request(session("k1", "cursor")));
    await router.cancel("k1", "stop");
    await router.cancel("missing", "stop");
    await router.interrupt("k1", "stop");
    expect(router.pendingHostCalls("k1")[0]?.toolName).toBe("Execute");
    expect(router.pendingHostCalls("missing")[0]?.toolName).toBe("Execute");
    await router.deliverResults("c1", [{ tool_use_id: "t", content: "ok" }]);
    await router.close();
    expect(claude.calls).toEqual(["handle:c1", "cancel:missing", "pending:missing", "deliver:c1", "close"]);
    expect(cursor.calls).toEqual(["handle:k1", "cancel:k1", "interrupt:k1", "pending:k1", "close"]);
    expect(router.kind).toBe("sdk");
    expect(router.describe()).toMatchObject({ kind: "claude", cursor: { kind: "cursor" } });
  });

  it("keeps a Claude-only process on SdkRuntime", () => {
    const dir = mkdtempSync(join(tmpdir(), "router-factory-"));
    try {
      const logger = createLogger(join(dir, "logs"));
      const plain = loadConfig({ dataDir: dir, mode: "sdk", authMode: "subscription", models: [{ id: "sonnet", model: "sonnet", displayName: "Claude Sonnet" }] });
      expect(createRuntime(plain, logger, join(dir, "canary"))).toBeInstanceOf(SdkRuntime);
      const cursor = cursorMenuFromCatalog(cursorCatalogFixture, "default");
      const mixed = loadConfig({ dataDir: dir, mode: "sdk", authMode: "subscription", models: [{ id: "sonnet", model: "sonnet", displayName: "Claude Sonnet" }, ...cursor] });
      const runtime = createRuntime(mixed, logger, join(dir, "canary"));
      expect(runtime).toBeInstanceOf(RouterRuntime);
      expect(runtime.kind).toBe("sdk");
      expect(runtime.describe?.()).toMatchObject({ kind: "sdk", cursor: { kind: "cursor" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
