import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { collectToolResults, textFromBlocks } from "../protocol/content.js";
import { assistantMessage, estimatedUsage } from "../protocol/messages.js";
import { createToolNameMap, mcpQualifiedName, type ToolNameMap } from "../protocol/tool-names.js";
import { jsonSchemaToZod, zodObjectShape } from "../protocol/schema-to-zod.js";
import { ToolMailbox } from "../relay/mailbox.js";
import { toolUseId } from "../relay/ids.js";
import type { BridgeConfig } from "../config.js";
import type { ContentBlock, Usage } from "../types.js";
import { BridgeError } from "../types.js";
import type { Logger } from "../logging.js";
import { maybeForceStartWhenReady, missionDirReady } from "./mission-tools.js";
import {
  claudeToolTraceDetail,
  isDroidMcpName,
  isReadOnlyBuiltin,
  mapPermissionToDroidTool,
  selectDroidMcpTools,
} from "./droid-tools.js";
import { buildDynamicUserPrompt, buildPresetSystemPrompt, describePromptLayout } from "./system-prompt.js";
import {
  cacheHitRatio,
  emptyUsage,
  extractUsage,
  subtractUsage,
  toResponseUsage,
  writeUsageLine,
  type UsageSnapshot,
} from "./usage.js";
import type { BridgeRuntime, RuntimeEvent, RuntimeRequest, RuntimeTurn, StreamSink } from "./types.js";
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
  advertised: string[];
  abort?: AbortController;
  query?: ReturnType<SdkHandle["query"]>;
  waiters: PendingTurn[];
  loop?: Promise<void>;
  sink?: StreamSink;
  lastUsage: UsageSnapshot;
  streamed: string;
}

/**
 * T3-style Claude Agent SDK adapter.
 * systemPrompt: preset `claude_code` + stable Droid append.
 * Built-in Read/Edit/Bash stay enabled and execute inside Claude Code.
 * Only Factory-exclusive tools go through MCP → mailbox → Droid.
 */
export class SdkRuntime implements BridgeRuntime {
  readonly kind = "sdk" as const;
  private sdk: SdkHandle | undefined;
  private selection: UpstreamSelection | undefined;
  private readonly failedProviders: string[] = [];
  private readonly lives = new Map<string, LiveSdk>();
  private readonly usageFile: string;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
  ) {
    this.usageFile = join(config.logDir, "usage.jsonl");
  }

  describe(): Record<string, unknown> {
    return {
      kind: "sdk",
      authMode: this.config.authMode,
      permissionMode: this.config.permissionMode,
      prompt: describePromptLayout(),
      tools: "preset:claude_code + droid-exclusive MCP",
      includePartialMessages: true,
      overridesAnthropicEnv: this.config.authMode !== "subscription",
      upstream: this.selection ? publicSelection(this.selection) : this.config.authMode === "subscription"
        ? { provider: "subscription", model: process.env.ANTHROPIC_MODEL ?? "local-login" }
        : { selected: false },
    };
  }

  async ensureSelection(): Promise<UpstreamSelection | undefined> {
    if (this.config.authMode === "subscription") return undefined;
    if (this.selection) return this.selection;
    const fromConfig = selectionFromConfig({
      baseUrl: this.config.upstreamBaseUrl,
      model: this.config.upstreamModel,
      tokenEnv: this.config.upstreamTokenEnv,
    });
    if (fromConfig && !this.failedProviders.includes(fromConfig.provider.id)) {
      this.selection = fromConfig;
      return fromConfig;
    }
    const { selection, attempts } = await selectUpstream({
      providerIds: this.failedProviders,
    });
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

  async handle(input: RuntimeRequest, sink?: StreamSink): Promise<RuntimeTurn> {
    const live = this.live(input.session.bridgeSessionId);
    live.sink = sink;
    live.advertised = (input.request.tools ?? []).map((tool) => tool.name);
    const results = collectToolResults(input.request.messages);

    if (results.length > 0) {
      const blob = JSON.stringify(input.request.messages);
      const forced = maybeForceStartWhenReady(
        input.session.notes,
        input.request.tools,
        blob,
        process.env.BRIDGE_DROID_HOME,
      );
      for (const result of results) {
        if (live.mailbox.hasCall(result.tool_use_id)) {
          live.mailbox.submitResult(result);
          live.events.push({ at: now(), type: "tool_result_to_sdk", data: { id: result.tool_use_id } });
        } else if (!forced) {
          throw new BridgeError(409, "unknown_tool_use_id", result.tool_use_id);
        }
      }
      if (forced) {
        await this.parkQuery(live, "mission-files-ready");
        return this.synthesizedSpawn(input, live, forced, "sdk-mission-start-when-ready");
      }
      if (!live.started) {
        return this.startAndWait(input, live);
      }
      return this.waitForTurn(live, input, this.config.requestTimeoutMs);
    }

    if (process.env.BRIDGE_WAIT_FOR_MISSION_DIR === "1" && process.env.BRIDGE_DROID_HOME) {
      await waitFor(() => missionDirReady(process.env.BRIDGE_DROID_HOME), 20_000);
    }
    const forced = maybeForceStartWhenReady(
      input.session.notes,
      input.request.tools,
      JSON.stringify(input.request.messages),
      process.env.BRIDGE_DROID_HOME,
    );
    if (forced) {
      await this.parkQuery(live, "mission-files-ready-first-turn");
      return this.synthesizedSpawn(input, live, forced, "sdk-mission-start-when-ready");
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

  private synthesizedSpawn(
    input: RuntimeRequest,
    live: LiveSdk,
    forced: { name: string; input: Record<string, import("../types.js").Json> },
    note: string,
  ): RuntimeTurn {
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
      notes: [note],
    };
  }

  private async parkQuery(live: LiveSdk, reason: string): Promise<void> {
    live.events.push({ at: now(), type: "sdk_query_park", data: { reason } });
    try {
      live.abort?.abort();
      await live.query?.interrupt?.();
    } catch {
      // query may already be finished
    }
    live.query?.close?.();
    live.started = false;
    live.query = undefined;
    live.loop = undefined;
    live.abort = undefined;
    for (const waiter of live.waiters.splice(0)) {
      waiter.reject(new BridgeError(499, "cancelled", reason));
    }
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
    const droidTools = selectDroidMcpTools(input.request.tools);
    const names = createToolNameMap(droidTools.map((t) => t.name));
    live.names = names;

    const mcpTools = droidTools.map((definition) => {
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

    const allowedTools = droidTools.map((t) => mcpQualifiedName("droid", names.toMcp(t.name)));
    const cwd = resolveCwd(input, this.config);
    const env = sdkEnv(selection, `${this.config.host}:${this.config.port}`, this.config.authMode);
    if (this.config.authMode !== "subscription") {
      const configDir = join(this.config.dataDir, "claude-config");
      mkdirSync(configDir, { recursive: true });
      env.CLAUDE_CONFIG_DIR = configDir;
    }

    const abort = new AbortController();
    live.abort = abort;
    const options: Record<string, unknown> = {
      tools: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
      cwd,
      persistSession: this.config.persistSessions,
      maxTurns: Math.max(this.config.maxTurns, 80),
      mcpServers: { droid: server },
      allowedTools,
      env,
      permissionMode: this.config.permissionMode === "ask" ? "default" : "bypassPermissions",
      allowDangerouslySkipPermissions: this.config.permissionMode !== "ask",
      abortController: abort,
      systemPrompt: buildPresetSystemPrompt(),
      canUseTool: async (toolName: string, toolInput: Record<string, unknown>) =>
        this.canUseTool(live, input, toolName, toolInput),
    };
    if (selection) options.model = selection.provider.model;
    else if (process.env.ANTHROPIC_MODEL) options.model = process.env.ANTHROPIC_MODEL;
    if (this.config.claudeExecutable) options.pathToClaudeCodeExecutable = this.config.claudeExecutable;

    const prompt = buildDynamicUserPrompt(input);
    live.started = true;
    live.events.push({
      at: now(),
      type: "sdk_query_start",
      data: {
        authMode: this.config.authMode,
        provider: selection?.provider.id ?? "subscription",
        model: selection?.provider.model ?? process.env.ANTHROPIC_MODEL ?? "local-login",
        baseUrl: selection?.provider.baseUrl ?? "(not overridden)",
        droidMcp: droidTools.map((t) => t.name),
        cwd,
        prompt: describePromptLayout(),
      },
    });

    try {
      const iterator = sdk.query({ prompt, options });
      live.query = iterator;
      live.loop = this.consume(live, input, iterator);
    } catch (error) {
      live.started = false;
      if (await this.failover(error)) {
        await this.startQuery(input, live);
        return;
      }
      throw mapSdkError(error);
    }
  }

  private async canUseTool(
    live: LiveSdk,
    input: RuntimeRequest,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<{ behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }> {
    if (isDroidMcpName(toolName) || this.config.permissionMode !== "ask" || isReadOnlyBuiltin(toolName)) {
      return { behavior: "allow", updatedInput: toolInput };
    }
    const mapped = mapPermissionToDroidTool(toolName, live.advertised);
    if (!mapped) {
      live.events.push({ at: now(), type: "permission_passthrough", data: { toolName } });
      return { behavior: "allow", updatedInput: toolInput };
    }
    const id = toolUseId();
    live.mailbox.registerCall({
      callId: id,
      originalName: mapped,
      mcpName: toolName,
      input: toolInput,
    });
    live.sink?.toolTrace("permission", `${mapped} for ${toolName}`);
    this.publish(live, {
      response: assistantMessage(
        input.request.model,
        [{ type: "tool_use", id, name: mapped, input: (toolInput ?? {}) as never }],
        "tool_use",
        estimatedUsage(input.request, 16),
      ),
      pendingToolIds: [id],
      events: [...live.events],
      notes: [`canUseTool surfaced ${toolName} as Droid ${mapped}`],
    });
    const result = await live.mailbox.wait(id, this.config.toolWaitMs);
    if (result.isError) {
      return { behavior: "deny", message: "Droid denied this tool" };
    }
    return { behavior: "allow", updatedInput: toolInput };
  }

  private async failover(error: unknown): Promise<boolean> {
    if (this.config.authMode === "subscription") return false;
    const mapped = mapSdkError(error);
    if (mapped.code !== "blocked_auth" || !this.selection) return false;
    const from = this.selection.provider.id;
    if (!this.failedProviders.includes(from)) this.failedProviders.push(from);
    this.logger.warn("upstream-failover", { from, error: mapped.message });
    this.selection = undefined;
    this.config.upstreamBaseUrl = undefined;
    this.config.upstreamModel = undefined;
    this.config.upstreamTokenEnv = undefined;
    try {
      await this.ensureSelection();
      return true;
    } catch {
      return false;
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
        this.noteUsage(live, input, message);

        if (message.type === "stream_event") {
          const text = streamTextDelta(message);
          if (text) {
            live.streamed += text;
            live.sink?.textDelta(text);
          }
          continue;
        }

        const extracted = extractToolUses(message);
        const droidUses = extracted.filter((use) => {
          const stripped = use.name.replace(/^mcp__droid__/, "");
          return isDroidMcpName(use.name) || Boolean(live.names?.toOriginal(stripped));
        });
        const builtinUses = extracted.filter((use) => !droidUses.includes(use));

        for (const use of builtinUses) {
          const detail = claudeToolTraceDetail(use.name, use.input);
          live.sink?.toolTrace(use.name, detail);
          live.streamed += `\n[${use.name}] ${detail}\n`;
          live.events.push({ at: now(), type: "claude_code_tool", data: { name: use.name, id: use.id } });
        }

        for (const use of droidUses) {
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
        if (droidUses.length > 0) {
          const text = live.streamed.trim();
          const content: ContentBlock[] = text
            ? [{ type: "text", text }, ...blocks]
            : [...blocks];
          this.publish(live, {
            response: assistantMessage(input.request.model, content, "tool_use", this.turnUsage(live, input)),
            pendingToolIds: [...pending],
            events: [...live.events],
            notes: ["sdk: droid MCP tool_use; Claude Code built-ins already executed"],
          });
          blocks.length = 0;
          pending.length = 0;
          live.streamed = "";
          continue;
        }

        const text = extractText(message);
        if (text && message.type === "assistant" && !live.streamed.includes(text)) {
          blocks.push({ type: "text", text });
          if (!live.streamed) live.sink?.textDelta(text);
        }
        if (message.type === "result") {
          const streamed = live.streamed.trim();
          const finalBlocks = streamed
            ? [{ type: "text" as const, text: streamed }]
            : blocks.length
              ? [...blocks]
              : [{ type: "text" as const, text: text || extractText(message) || "sdk result" }];
          this.publish(live, {
            response: assistantMessage(input.request.model, finalBlocks, "end_turn", this.turnUsage(live, input)),
            pendingToolIds: [],
            events: [...live.events],
          });
          blocks.length = 0;
          live.streamed = "";
        }
      }
    } catch (error) {
      const mapped = mapSdkError(error);
      this.logger.error("sdk-loop", { message: mapped.message, code: mapped.code });
      for (const waiter of live.waiters.splice(0)) waiter.reject(mapped);
      return;
    }

    if (live.waiters.length > 0 && (blocks.length > 0 || live.streamed)) {
      const content: ContentBlock[] = live.streamed.trim()
        ? [{ type: "text", text: live.streamed.trim() }]
        : blocks;
      this.publish(live, {
        response: assistantMessage(input.request.model, content, "end_turn", this.turnUsage(live, input)),
        pendingToolIds: pending,
        events: [...live.events],
      });
    }
  }

  private noteUsage(live: LiveSdk, input: RuntimeRequest, message: Record<string, unknown>): void {
    const extracted = extractUsage(message);
    if (!extracted) return;
    const delta = subtractUsage(extracted, live.lastUsage);
    live.lastUsage = extracted;
    if (
      delta.input_tokens === 0
      && delta.output_tokens === 0
      && delta.cache_creation_input_tokens === 0
      && delta.cache_read_input_tokens === 0
    ) {
      return;
    }
    const usage = toResponseUsage(delta, false);
    live.sink?.usage?.(usage);
    writeUsageLine(this.usageFile, {
      ...delta,
      sessionId: input.session.bridgeSessionId,
      role: input.role,
      model: this.selection?.provider.model ?? process.env.ANTHROPIC_MODEL,
      provider: this.selection?.provider.id ?? this.config.authMode,
    });
    this.logger.info("usage", {
      ...delta,
      cache_hit_ratio: Number(cacheHitRatio(delta).toFixed(4)),
      sessionId: input.session.bridgeSessionId,
      role: input.role,
    });
    live.events.push({ at: now(), type: "usage", data: { ...delta, cache_hit_ratio: cacheHitRatio(delta) } });
  }

  private turnUsage(live: LiveSdk, input: RuntimeRequest): Usage {
    if (live.lastUsage.input_tokens || live.lastUsage.output_tokens) {
      return toResponseUsage(live.lastUsage, false);
    }
    return estimatedUsage(input.request, Math.max(live.streamed.length, 48));
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
      live = {
        mailbox: new ToolMailbox(),
        events: [],
        cancelled: false,
        started: false,
        waiters: [],
        advertised: [],
        lastUsage: emptyUsage(),
        streamed: "",
      };
      this.lives.set(sessionId, live);
    }
    return live;
  }
}

function resolveCwd(input: RuntimeRequest, config: BridgeConfig): string {
  const header = input.headers["x-bridge-cwd"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return process.env.BRIDGE_SDK_CWD || fromHeader || config.sdkCwd;
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

function streamTextDelta(message: Record<string, unknown>): string {
  const event = message.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
  if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return event.delta.text ?? "";
  }
  return "";
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

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return pred();
}
