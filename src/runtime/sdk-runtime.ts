import { collectToolResults, lastUserText, systemText, textFromBlocks } from "../protocol/content.js";
import { assistantMessage, estimatedUsage } from "../protocol/messages.js";
import { createToolNameMap, mcpQualifiedName } from "../protocol/tool-names.js";
import { jsonSchemaToZod } from "../protocol/schema-to-zod.js";
import { ToolMailbox } from "../relay/mailbox.js";
import type { BridgeConfig } from "../config.js";
import type { ContentBlock } from "../types.js";
import { BridgeError } from "../types.js";
import type { Logger } from "../logging.js";
import type { BridgeRuntime, RuntimeEvent, RuntimeRequest, RuntimeTurn } from "./types.js";

interface SdkHandle {
  query: (args: Record<string, unknown>) => AsyncIterable<Record<string, unknown>> & {
    interrupt?: () => Promise<unknown>;
  };
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>,
    extras?: Record<string, unknown>,
  ) => unknown;
  createSdkMcpServer: (options: Record<string, unknown>) => unknown;
}

interface LiveSdk {
  mailbox: ToolMailbox;
  events: RuntimeEvent[];
  cancelled: boolean;
  sdkSessionId?: string;
  pending: Promise<void>;
  pushUser?: (text: string) => void;
}

/**
 * Official Claude Agent SDK adapter. Built-in tools are removed (`tools: []`);
 * only MCP tools generated from the current Droid request are registered, and
 * those handlers only wait on the mailbox.
 */
export class SdkRuntime implements BridgeRuntime {
  readonly kind = "sdk" as const;
  private sdk: SdkHandle | undefined;
  private readonly lives = new Map<string, LiveSdk>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
  ) {}

  async handle(input: RuntimeRequest): Promise<RuntimeTurn> {
    const sdk = await this.loadSdk();
    const live = this.live(input.session.bridgeSessionId);
    const results = collectToolResults(input.request.messages);

    if (results.length > 0) {
      for (const result of results) {
        if (!live.mailbox.hasCall(result.tool_use_id)) {
          throw new BridgeError(409, "unknown_tool_use_id", result.tool_use_id);
        }
        live.mailbox.submitResult(result);
        live.events.push({ at: now(), type: "tool_result_to_sdk", data: { id: result.tool_use_id } });
      }
      const text = await this.waitForContinuation(live, input.request.model, 60_000);
      return {
        response: assistantMessage(input.request.model, [{ type: "text", text }], "end_turn", estimatedUsage(input.request, text.length)),
        pendingToolIds: live.mailbox.pendingCalls().map((c) => c.callId),
        events: [...live.events],
      };
    }

    const tools = input.request.tools ?? [];
    const names = createToolNameMap(tools.map((t) => t.name));
    const mcpTools = tools.map((definition) => {
      const converted = jsonSchemaToZod(definition.input_schema);
      const mcpName = names.toMcp(definition.name);
      return sdk.tool(
        mcpName,
        definition.description ?? definition.name,
        converted.schema instanceof Object && "shape" in converted.schema ? (converted.schema as { shape: unknown }).shape : {},
        async (args: Record<string, unknown>, extra?: unknown) => {
          const callId = extractCallId(extra) ?? fallbackCallId(live, definition.name);
          live.mailbox.registerCall({
            callId,
            originalName: definition.name,
            mcpName,
            input: args,
          });
          live.events.push({ at: now(), type: "mcp_handler_wait", data: { callId, name: definition.name } });
          const result = await live.mailbox.wait(callId, this.config.toolWaitMs);
          const text = typeof result.content === "string" ? result.content : textFromBlocks(result.content);
          return {
            content: [{ type: "text", text }],
            isError: Boolean(result.isError),
          };
        },
        { alwaysLoad: true },
      );
    });

    const server = sdk.createSdkMcpServer({
      name: "droid",
      version: "0.1.0",
      tools: mcpTools,
      alwaysLoad: true,
    });

    const allowedTools = tools.map((t) => mcpQualifiedName("droid", names.toMcp(t.name)));
    const prompt = buildPrompt(input);
    const env = sanitizedEnv();
    const options: Record<string, unknown> = {
      tools: [],
      settingSources: [],
      includePartialMessages: true,
      cwd: this.config.sdkCwd,
      persistSession: this.config.persistSessions,
      maxTurns: this.config.maxTurns,
      mcpServers: { droid: server },
      allowedTools,
      env,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: systemText(input.request.system),
      },
    };
    if (this.config.claudeExecutable) options.pathToClaudeCodeExecutable = this.config.claudeExecutable;

    const blocks: ContentBlock[] = [];
    const pending: string[] = [];
    try {
      const iterator = sdk.query({ prompt, options });
      for await (const message of iterator) {
        live.events.push({ at: now(), type: String(message.type ?? "sdk"), data: summarizeSdk(message) });
        if (typeof message.session_id === "string") live.sdkSessionId = message.session_id;
        const extracted = extractToolUses(message);
        for (const use of extracted) {
          const original = names.toOriginal(use.name.replace(/^mcp__droid__/, "")) ?? use.name;
          const id = use.id;
          if (!live.mailbox.hasCall(id)) {
            live.mailbox.registerCall({ callId: id, originalName: original, mcpName: use.name, input: use.input });
          }
          pending.push(id);
          blocks.push({ type: "tool_use", id, name: original, input: use.input as never });
        }
        if (extracted.length > 0) {
          // End this HTTP response now. Do not wait for the SDK query to finish.
          return {
            response: assistantMessage(input.request.model, blocks, "tool_use", estimatedUsage(input.request, 48)),
            pendingToolIds: pending,
            events: [...live.events],
            notes: ["sdk: returned tool_use while query remains alive"],
          };
        }
        const text = extractText(message);
        if (text && message.type === "assistant") {
          blocks.push({ type: "text", text });
        }
        if (message.type === "result") {
          const finalText = blocks.length ? blocks : [{ type: "text" as const, text: extractText(message) || "sdk result" }];
          return {
            response: assistantMessage(input.request.model, finalText, "end_turn", estimatedUsage(input.request, 48)),
            pendingToolIds: [],
            events: [...live.events],
          };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/auth|login|unauthorized|api key|credit|billing/i.test(message)) {
        throw new BridgeError(401, "blocked_auth", message);
      }
      throw new BridgeError(502, "sdk_error", message);
    }

    if (blocks.length === 0) {
      throw new BridgeError(502, "sdk_empty", "SDK produced no assistant content");
    }
    return {
      response: assistantMessage(input.request.model, blocks, "end_turn", estimatedUsage(input.request, 48)),
      pendingToolIds: pending,
      events: [...live.events],
    };
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    const live = this.lives.get(sessionId);
    if (!live) return;
    live.cancelled = true;
    live.mailbox.cancel(reason);
  }

  async deliverResults(
    sessionId: string,
    results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>,
  ): Promise<Array<"accepted" | "duplicate">> {
    const live = this.live(sessionId);
    return results.map((result) => live.mailbox.submitResult(result));
  }

  private async loadSdk(): Promise<SdkHandle> {
    if (this.sdk) return this.sdk;
    try {
      const mod = (await import("@anthropic-ai/claude-agent-sdk")) as Record<string, unknown>;
      if (typeof mod.query !== "function" || typeof mod.tool !== "function" || typeof mod.createSdkMcpServer !== "function") {
        throw new Error("SDK exports missing query/tool/createSdkMcpServer");
      }
      this.sdk = mod as unknown as SdkHandle;
      return this.sdk;
    } catch (error) {
      throw new BridgeError(503, "sdk_unavailable", error instanceof Error ? error.message : String(error));
    }
  }

  private live(sessionId: string): LiveSdk {
    let live = this.lives.get(sessionId);
    if (!live) {
      live = { mailbox: new ToolMailbox(), events: [], cancelled: false, pending: Promise.resolve() };
      this.lives.set(sessionId, live);
    }
    return live;
  }

  private async waitForContinuation(live: LiveSdk, _model: string, timeoutMs: number): Promise<string> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const last = [...live.events].reverse().find((e) => e.type === "assistant_final" || e.type === "result");
      if (last?.data && typeof last.data.text === "string") return last.data.text;
      await new Promise((r) => setTimeout(r, 50));
      if (live.cancelled) throw new BridgeError(499, "cancelled", "sdk session cancelled");
    }
    return "relay-bridge sdk: waiting for continuation; no final assistant text yet";
  }
}

function buildPrompt(input: RuntimeRequest): string {
  const user = lastUserText(input.request.messages);
  const role = input.role === "unknown" ? "" : `Role tag: ${input.role}. `;
  return `${role}${user}`;
}

function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^ANTHROPIC_BASE_URL$/i.test(key)) continue;
    if (/^HTTP_PROXY|HTTPS_PROXY|ALL_PROXY$/i.test(key)) continue;
    env[key] = value;
  }
  env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY ?? "";
  return env;
}

function extractToolUses(message: Record<string, unknown>): Array<{ id: string; name: string; input: unknown }> {
  const content = (message.message as { content?: unknown[] } | undefined)?.content
    ?? (Array.isArray(message.content) ? message.content : []);
  const uses: Array<{ id: string; name: string; input: unknown }> = [];
  for (const raw of content) {
    const block = raw as { type?: string; id?: string; name?: string; input?: unknown };
    if (block.type === "tool_use" && block.id && block.name) {
      uses.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  return uses;
}

function extractText(message: Record<string, unknown>): string {
  if (typeof message.result === "string") return message.result;
  const content = (message.message as { content?: unknown[] } | undefined)?.content
    ?? (Array.isArray(message.content) ? message.content : []);
  return content
    .map((raw) => {
      const block = raw as { type?: string; text?: string };
      return block.type === "text" ? block.text ?? "" : "";
    })
    .join("");
}

function extractCallId(extra: unknown): string | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const rec = extra as Record<string, unknown>;
  for (const key of ["toolUseId", "tool_use_id", "id"]) {
    if (typeof rec[key] === "string") return rec[key] as string;
  }
  const meta = rec.meta as Record<string, unknown> | undefined;
  if (meta && typeof meta.toolUseId === "string") return meta.toolUseId;
  return undefined;
}

function fallbackCallId(live: LiveSdk, name: string): string {
  const pending = live.mailbox.pendingCalls().find((c) => c.originalName === name && !c.delivered);
  if (pending) return pending.callId;
  throw new BridgeError(500, "missing_tool_call_id", `SDK callback for ${name} had no tool_use id`);
}

function summarizeSdk(message: Record<string, unknown>): Record<string, unknown> {
  return {
    type: message.type,
    subtype: message.subtype,
    session_id: message.session_id,
    has_content: Boolean((message.message as { content?: unknown } | undefined)?.content ?? message.content),
  };
}

function now(): string {
  return new Date().toISOString();
}
