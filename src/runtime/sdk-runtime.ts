import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { collectToolResults, lastUserText, systemText, textFromBlocks } from "../protocol/content.js";
import { assistantMessage, estimatedUsage } from "../protocol/messages.js";
import { createToolNameMap, mcpQualifiedName, type ToolNameMap } from "../protocol/tool-names.js";
import { jsonSchemaToZod, zodObjectShape } from "../protocol/schema-to-zod.js";
import { ToolMailbox } from "../relay/mailbox.js";
import { toolUseId } from "../relay/ids.js";
import type { BridgeConfig } from "../config.js";
import type { ContentBlock } from "../types.js";
import { BridgeError } from "../types.js";
import type { Logger } from "../logging.js";
import { maybeForceMissionSpawn, orchestratorAppendix, roleAppendix } from "./mission-tools.js";
import type { BridgeRuntime, RuntimeEvent, RuntimeRequest, RuntimeTurn } from "./types.js";
import {
  publicSelection,
  sdkEnv,
  selectUpstream,
  selectionFromConfig,
  type UpstreamSelection,
} from "../upstream/providers.js";

interface SdkHandle {
  query: (args: Record<string, unknown>) => AsyncIterable<Record<string, unknown>> & {
    interrupt?: () => Promise<unknown>;
    close?: () => void;
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

interface PendingTurn {
  resolve: (turn: RuntimeTurn) => void;
  reject: (error: Error) => void;
}

interface LiveSdk {
  mailbox: ToolMailbox;
  events: RuntimeEvent[];
  cancelled: boolean;
  started: boolean;
  sdkSessionId?: string;
  names?: ToolNameMap;
  abort?: AbortController;
  query?: ReturnType<SdkHandle["query"]>;
  waiters: PendingTurn[];
  loop?: Promise<void>;
}

/**
 * Official Claude Agent SDK adapter.
 * Built-in tools are removed (`tools: []`). Only MCP tools from the current
 * Droid request are registered; those handlers wait on the mailbox.
 * The query iterator is consumed in the background so returning tool_use
 * does not abandon the SDK session.
 */
export class SdkRuntime implements BridgeRuntime {
  readonly kind = "sdk" as const;
  private sdk: SdkHandle | undefined;
  private selection: UpstreamSelection | undefined;
  private readonly lives = new Map<string, LiveSdk>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
  ) {}

  describe(): Record<string, unknown> {
    return this.selection ? publicSelection(this.selection) : { kind: "sdk", selected: false };
  }

  async ensureSelection(): Promise<UpstreamSelection> {
    if (this.selection) return this.selection;
    const fromConfig = selectionFromConfig({
      baseUrl: this.config.upstreamBaseUrl,
      model: this.config.upstreamModel,
      tokenEnv: this.config.upstreamTokenEnv,
    });
    if (fromConfig) {
      this.selection = fromConfig;
      return fromConfig;
    }
    const { selection, attempts } = await selectUpstream();
    this.logger.info("upstream-select", {
      attempts: attempts.map((item) => ({
        provider: item.provider,
        baseUrl: item.baseUrl,
        model: item.model,
        tokenEnv: item.tokenEnv,
        ok: item.ok,
        status: item.status,
        error: item.error,
        toolName: item.toolName,
      })),
    });
    if (!selection) {
      throw new BridgeError(401, "blocked_auth", "no usable MiniMax/GLM/OpenRouter BYOK upstream");
    }
    this.selection = selection;
    return selection;
  }

  async handle(input: RuntimeRequest): Promise<RuntimeTurn> {
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
      if (!live.started) {
        return this.startAndWait(input, live);
      }
      return this.waitForTurn(live, input, this.config.requestTimeoutMs);
    }

    const forced = maybeForceMissionSpawn(input.session.notes, input.request.tools, lastUserText(input.request.messages));
    if (forced) {
      const id = toolUseId();
      live.mailbox.registerCall({
        callId: id,
        originalName: forced.name,
        mcpName: forced.name,
        input: forced.input,
      });
      live.events.push({ at: now(), type: "synthesized_mission_spawn", data: { name: forced.name, id } });
      return {
        response: assistantMessage(
          input.request.model,
          [{ type: "tool_use", id, name: forced.name, input: forced.input }],
          "tool_use",
          estimatedUsage(input.request, 32),
        ),
        pendingToolIds: [id],
        events: [...live.events],
        notes: ["sdk-mission-spawn"],
      };
    }

    return this.startAndWait(input, live);
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    const live = this.lives.get(sessionId);
    if (!live) return;
    live.cancelled = true;
    live.mailbox.cancel(reason);
    live.abort?.abort();
    try {
      await live.query?.interrupt?.();
    } catch {
      // ignore
    }
    live.query?.close?.();
    for (const waiter of live.waiters.splice(0)) {
      waiter.reject(new BridgeError(499, "cancelled", reason));
    }
  }

  async deliverResults(
    sessionId: string,
    results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>,
  ): Promise<Array<"accepted" | "duplicate">> {
    const live = this.live(sessionId);
    return results.map((result) => live.mailbox.submitResult(result));
  }

  private async startAndWait(input: RuntimeRequest, live: LiveSdk): Promise<RuntimeTurn> {
    if (!live.started) {
      await this.startQuery(input, live);
    }
    return this.waitForTurn(live, input, this.config.requestTimeoutMs);
  }

  private async startQuery(input: RuntimeRequest, live: LiveSdk): Promise<void> {
    const sdk = await this.loadSdk();
    const selection = await this.ensureSelection();
    const tools = input.request.tools ?? [];
    const names = createToolNameMap(tools.map((t) => t.name));
    live.names = names;

    const mcpTools = tools.map((definition) => {
      const converted = jsonSchemaToZod(definition.input_schema);
      const mcpName = names.toMcp(definition.name);
      return sdk.tool(
        mcpName,
        definition.description ?? definition.name,
        zodObjectShape(converted.schema),
        async (args: Record<string, unknown>, extra?: unknown) => {
          const callId = extractCallId(extra) ?? fallbackCallId(live, definition.name);
          if (!live.mailbox.hasCall(callId)) {
            live.mailbox.registerCall({
              callId,
              originalName: definition.name,
              mcpName,
              input: args,
            });
          }
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
    const configDir = join(this.config.dataDir, "claude-config");
    mkdirSync(configDir, { recursive: true });
    const env = sdkEnv(selection, `${this.config.host}:${this.config.port}`);
    env.CLAUDE_CONFIG_DIR = configDir;

    const abort = new AbortController();
    live.abort = abort;
    const options: Record<string, unknown> = {
      tools: [],
      settingSources: [],
      includePartialMessages: false,
      cwd: this.config.sdkCwd,
      persistSession: this.config.persistSessions,
      maxTurns: this.config.maxTurns,
      mcpServers: { droid: server },
      allowedTools,
      env,
      model: selection.provider.model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      abortController: abort,
      systemPrompt: {
        type: "custom",
        prompt: buildSystemPrompt(input),
      },
      canUseTool: async () => ({ behavior: "allow", updatedInput: undefined }),
    };
    if (this.config.claudeExecutable) options.pathToClaudeCodeExecutable = this.config.claudeExecutable;

    const prompt = buildPrompt(input);
    live.started = true;
    live.events.push({
      at: now(),
      type: "sdk_query_start",
      data: {
        provider: selection.provider.id,
        model: selection.provider.model,
        baseUrl: selection.provider.baseUrl,
        toolCount: tools.length,
      },
    });

    try {
      const iterator = sdk.query({ prompt, options });
      live.query = iterator;
      live.loop = this.consume(live, input, iterator);
    } catch (error) {
      live.started = false;
      throw mapSdkError(error);
    }
  }

  private async consume(
    live: LiveSdk,
    input: RuntimeRequest,
    iterator: AsyncIterable<Record<string, unknown>>,
  ): Promise<void> {
    const blocks: ContentBlock[] = [];
    const pending: string[] = [];
    try {
      for await (const message of iterator) {
        if (live.cancelled) break;
        live.events.push({ at: now(), type: String(message.type ?? "sdk"), data: summarizeSdk(message) });
        if (typeof message.session_id === "string") live.sdkSessionId = message.session_id;

        const extracted = extractToolUses(message);
        for (const use of extracted) {
          const stripped = use.name.replace(/^mcp__droid__/, "");
          const original = live.names?.toOriginal(stripped) ?? stripped;
          if (!live.mailbox.hasCall(use.id)) {
            live.mailbox.registerCall({
              callId: use.id,
              originalName: original,
              mcpName: use.name,
              input: use.input,
            });
          }
          pending.push(use.id);
          blocks.push({ type: "tool_use", id: use.id, name: original, input: use.input as never });
        }
        if (extracted.length > 0) {
          this.publish(live, {
            response: assistantMessage(input.request.model, [...blocks], "tool_use", estimatedUsage(input.request, 48)),
            pendingToolIds: [...pending],
            events: [...live.events],
            notes: ["sdk: returned tool_use while query remains alive"],
          });
          blocks.length = 0;
          pending.length = 0;
          continue;
        }

        const text = extractText(message);
        if (text && message.type === "assistant") {
          blocks.push({ type: "text", text });
        }
        if (message.type === "result") {
          const finalBlocks = blocks.length
            ? [...blocks]
            : [{ type: "text" as const, text: text || extractText(message) || "sdk result" }];
          this.publish(live, {
            response: assistantMessage(input.request.model, finalBlocks, "end_turn", estimatedUsage(input.request, 48)),
            pendingToolIds: [],
            events: [...live.events],
          });
          blocks.length = 0;
        }
      }
    } catch (error) {
      const mapped = mapSdkError(error);
      this.logger.error("sdk-loop", { message: mapped.message, code: mapped.code });
      for (const waiter of live.waiters.splice(0)) waiter.reject(mapped);
      return;
    }

    if (live.waiters.length > 0 && blocks.length > 0) {
      this.publish(live, {
        response: assistantMessage(input.request.model, blocks, "end_turn", estimatedUsage(input.request, 48)),
        pendingToolIds: pending,
        events: [...live.events],
      });
    }
  }

  private publish(live: LiveSdk, turn: RuntimeTurn): void {
    const waiter = live.waiters.shift();
    if (waiter) waiter.resolve(turn);
    else live.events.push({ at: now(), type: "orphaned_turn", data: { stop: turn.response.stop_reason } });
  }

  private waitForTurn(live: LiveSdk, input: RuntimeRequest, timeoutMs: number): Promise<RuntimeTurn> {
    return new Promise<RuntimeTurn>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = live.waiters.findIndex((item) => item.reject === rejectTurn);
        if (idx >= 0) live.waiters.splice(idx, 1);
        reject(new BridgeError(504, "sdk_turn_timeout", "SDK turn timed out"));
      }, timeoutMs);
      const rejectTurn = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      live.waiters.push({
        resolve: (turn) => {
          clearTimeout(timer);
          resolve({ ...turn, events: [...live.events] });
        },
        reject: rejectTurn,
      });
      if (live.cancelled) {
        rejectTurn(new BridgeError(499, "cancelled", "sdk session cancelled"));
      }
      void live.loop?.catch(rejectTurn);
      void input;
    });
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
      live = { mailbox: new ToolMailbox(), events: [], cancelled: false, started: false, waiters: [] };
      this.lives.set(sessionId, live);
    }
    return live;
  }
}

function buildPrompt(input: RuntimeRequest): string {
  const user = lastUserText(input.request.messages);
  const results = collectToolResults(input.request.messages);
  const resultText = results
    .map((result) => {
      const body = typeof result.content === "string" ? result.content : textFromBlocks(result.content);
      return `${result.tool_use_id}: ${body}`;
    })
    .join("\n");
  const role = input.role === "unknown" ? "" : `Role tag: ${input.role}.`;
  return [role, user, resultText ? `Prior tool results:\n${resultText}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

function buildSystemPrompt(input: RuntimeRequest): string {
  return [
    "You are running inside Relay Bridge.",
    "Claude Code built-in file tools are disabled. Use only the provided Droid MCP tools.",
    "Never invent a tool name that is not in the current tool list.",
    input.role !== "unknown" ? `Your Droid role is ${input.role}.` : "",
    roleAppendix(input.role),
    orchestratorAppendix(input.role, input.request.tools),
    systemText(input.request.system),
  ]
    .filter(Boolean)
    .join("\n");
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

function mapSdkError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/auth|login|unauthorized|api key|credit|billing|quota|balance|429/i.test(message)) {
    return new BridgeError(401, "blocked_auth", message);
  }
  return new BridgeError(502, "sdk_error", message);
}

function now(): string {
  return new Date().toISOString();
}
