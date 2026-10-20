import { BridgeError } from "../types.js";
import { sessionProvider } from "../sessions/correlate.js";
import type { ModelProvider } from "../models.js";
import type { ContentBlock } from "../types.js";
import type { BridgeRuntime, RuntimeControl, RuntimeHostCall, RuntimeHostCompletion, RuntimeHostEnd, RuntimeRequest, RuntimeTurn, StreamSink } from "./types.js";

/**
 * One BridgeRuntime for the process. Each session stays on the runtime that
 * created it. A session id with no owner is treated like a runtime that has
 * no live agent: only the Claude runtime is asked, never both.
 */
export class RouterRuntime implements BridgeRuntime {
  readonly kind = "sdk" as const;
  private readonly owners = new Map<string, ModelProvider>();

  constructor(
    private readonly claude: BridgeRuntime,
    private readonly cursor?: BridgeRuntime,
  ) {}

  async handle(input: RuntimeRequest, sink?: StreamSink): Promise<RuntimeTurn> {
    const provider = sessionProvider(input.session);
    this.owners.set(input.session.bridgeSessionId, provider);
    return this.runtime(provider).handle(input, sink);
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    await this.owner(sessionId).cancel(sessionId, reason);
  }

  async interrupt(sessionId: string, reason: string): Promise<boolean> {
    const runtime = this.owner(sessionId);
    return runtime.interrupt ? runtime.interrupt(sessionId, reason) : false;
  }

  pendingHostCalls(sessionId: string): RuntimeHostCall[] {
    return this.owner(sessionId).pendingHostCalls?.(sessionId) ?? [];
  }

  async deliverResults(sessionId: string, results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>): Promise<Array<"accepted" | "duplicate">> {
    return this.owner(sessionId).deliverResults(sessionId, results);
  }

  async completeHostTool(sessionId: string, completion: RuntimeHostCompletion): Promise<"accepted" | "duplicate"> {
    const runtime = this.owner(sessionId);
    if (!runtime.completeHostTool) throw new BridgeError(409, "interrupted_tool_roundtrip", "This runtime cannot complete a host tool");
    return runtime.completeHostTool(sessionId, completion);
  }

  async endHostSession(sessionId: string, reason: string): Promise<RuntimeHostEnd> {
    const runtime = this.owner(sessionId);
    return runtime.endHostSession ? runtime.endHostSession(sessionId, reason) : { resumable: false };
  }

  setControl(control: RuntimeControl | undefined): void {
    this.claude.setControl?.(control);
    this.cursor?.setControl?.(control);
  }

  describe(): Record<string, unknown> {
    return { ...(this.claude.describe?.() ?? { kind: "sdk" }), cursor: this.cursor?.describe?.() ?? { enabled: false } };
  }

  async close(): Promise<void> {
    await this.claude.close?.();
    await this.cursor?.close?.();
  }

  private owner(sessionId: string): BridgeRuntime {
    return this.runtime(this.owners.get(sessionId) ?? "claude");
  }

  private runtime(provider: ModelProvider): BridgeRuntime {
    if (provider === "cursor") {
      if (!this.cursor) throw new BridgeError(400, "cursor_unavailable", "No Cursor runtime is configured for this model.");
      return this.cursor;
    }
    return this.claude;
  }
}
