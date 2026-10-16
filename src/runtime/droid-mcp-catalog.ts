import { createHash } from "node:crypto";
import type { Json, ToolDefinition } from "../types.js";
import { BridgeError } from "../types.js";
import type { ToolNameMap } from "../protocol/tool-names.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { jsonSchemaToZod, toolJsonSchema, zodToolInputSchema } from "../protocol/schema-to-zod.js";

export type DroidMcpHandler = (name: string, args: Record<string, unknown>, extra?: unknown, mcpName?: string) => Promise<unknown>;
interface RegisteredTool {
  update(updates: { description?: string; _meta?: Record<string, unknown> }): void;
  remove(): void;
}
interface PublicMcpServer {
  registerTool(name: string, config: { description: string; inputSchema: unknown; _meta: Record<string, unknown> }, handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>): RegisteredTool;
  sendToolListChanged(): void | Promise<void>;
  isConnected?(): boolean;
  server?: { sendToolListChanged(): Promise<void>; setRequestHandler(schema: typeof ListToolsRequestSchema, handler: () => unknown): void };
}
interface Entry { definition: ToolDefinition; registration: RegisteredTool; fingerprint: string; mcpName: string; advertisedSchema: Record<string, Json> }

/** Names do not depend on the current catalog's order, additions or removals. */
export class StableDroidToolNames implements ToolNameMap {
  private readonly forward = new Map<string, string>();
  private readonly reverse = new Map<string, string>();
  private readonly fingerprints = new Map<string, string>();
  toMcp(original: string): string {
    const existing = this.forward.get(original);
    if (existing) return existing;
    const prefix = "droid_encoded_";
    const name = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(original) && !original.startsWith(prefix) && !original.startsWith("droid_revision_")
      ? original
      : `${prefix}${createHash("sha256").update(original).digest("hex").slice(0, 48)}`;
    const owner = this.reverse.get(name);
    if (owner && owner !== original) throw new BridgeError(422, "tool_name_collision", "Droid tool names could not be represented unambiguously");
    this.forward.set(original, name);
    this.reverse.set(name, original);
    return name;
  }
  /** Stage revisions without mutating the active namespace during validation. */
  revised(original: string, fingerprint: string): string {
    const hint = original.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 16) || "tool";
    return `droid_revision_${hint}_${createHash("sha256").update(original).update("\0").update(fingerprint).digest("hex").slice(0, 32)}`;
  }
  activate(original: string, name: string, fingerprint: string): void {
    const owner = this.reverse.get(name);
    if (owner && owner !== original) throw new BridgeError(422, "tool_name_collision", "Droid tool names could not be represented unambiguously");
    this.forward.set(original, name);
    this.reverse.set(name, original);
    this.fingerprints.set(original, fingerprint);
  }
  forDefinition(original: string, fingerprint: string): string | undefined {
    return this.fingerprints.get(original) === fingerprint ? this.forward.get(original) : undefined;
  }
  known(original: string): boolean { return this.forward.has(original); }
  toOriginal(name: string): string | undefined { return this.reverse.get(name); }
  originals(): string[] { return [...this.forward.keys()]; }
}

/** Mutates the official server instance; never swaps a server with live callbacks. */
export class DroidMcpCatalog {
  readonly server: Record<string, unknown>;
  readonly names: StableDroidToolNames;
  private readonly instance: PublicMcpServer;
  private readonly entries = new Map<string, Entry>();

  constructor(server: unknown, private readonly handler: DroidMcpHandler, names = new StableDroidToolNames()) {
    this.server = server as Record<string, unknown>;
    const instance = this.server?.instance as PublicMcpServer | undefined;
    if (!instance || typeof instance.registerTool !== "function" || typeof instance.sendToolListChanged !== "function" || typeof instance.server?.setRequestHandler !== "function") {
      throw new BridgeError(503, "dynamic_tools_unavailable", "The SDK MCP server does not expose registerTool, ListToolsRequest handling and tools/list_changed; refusing a stale tool catalog");
    }
    this.instance = instance;
    this.names = names;
    // McpServer installs its tools capability on the first registration. Prime
    // those public handlers before connecting even when Droid advertises none;
    // no bootstrap tool is ever visible to the client or executable by a model.
    const bootstrap = instance.registerTool("droid_catalog_bootstrap", {
      description: "Catalog initialization", inputSchema: zodToolInputSchema(jsonSchemaToZod({ type: "object", properties: {} }).schema), _meta: {},
    }, async () => { throw new BridgeError(409, "tool_not_advertised", "Catalog initialization is not an advertised tool"); });
    bootstrap.remove();
    // Public low-level MCP API keeps JSON Schema exact. The high-level helper
    // substitutes {} for validators that are not ZodObject and that object
    // parser drops reserved JSON keys. Tool calls still use official registerTool.
    instance.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...this.entries.values()].map((entry) => ({
      name: entry.mcpName, description: entry.definition.description ?? entry.definition.name,
      inputSchema: structuredClone(entry.advertisedSchema), _meta: { "anthropic/alwaysLoad": true },
    })) }));
  }

  has(original: string): boolean { return this.entries.has(original); }
  hasVersion(original: string, mcpName: string): boolean { return this.entries.get(original)?.mcpName === mcpName; }
  definitions(): ToolDefinition[] { return [...this.entries.values()].map((entry) => entry.definition); }

  async update(definitions: ToolDefinition[]): Promise<boolean> {
    const next = new Map<string, { definition: ToolDefinition; fingerprint: string; schema: unknown; mcpName: string; advertisedSchema: Record<string, Json> }>();
    // Validate the complete replacement before altering the live namespace.
    for (const definition of definitions) {
      if (next.has(definition.name)) throw new BridgeError(422, "duplicate_tool_name", definition.name);
      const fingerprint = canonicalJson(definition);
      const previous = this.entries.get(definition.name);
      let schema: unknown;
      let advertisedSchema = previous?.advertisedSchema;
      if (!previous || fingerprint !== previous.fingerprint) {
        try {
          const converted = jsonSchemaToZod(definition.input_schema);
          if (!converted.lossless) throw new BridgeError(422, "unsupported_tool_schema", `${definition.name}: ${converted.notes.join("; ")}`);
          schema = zodToolInputSchema(converted.schema);
          advertisedSchema = toolJsonSchema(converted.schema);
        } catch (error) {
          if (error instanceof BridgeError) throw error;
          throw new BridgeError(422, "unsupported_tool_schema", `${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const mcpName = previous?.fingerprint === fingerprint ? previous.mcpName
        : this.names.forDefinition(definition.name, fingerprint) ?? (this.names.known(definition.name) ? this.names.revised(definition.name, fingerprint)
        : this.names.toMcp(definition.name));
      next.set(definition.name, { definition: structuredClone(definition), fingerprint, schema, mcpName, advertisedSchema: advertisedSchema! });
    }
    let changed = false;
    try {
      for (const [original, entry] of this.entries) {
        if (!next.has(original)) {
          entry.registration.remove();
          this.entries.delete(original);
          changed = true;
        }
      }
      for (const [original, candidate] of next) {
        const previous = this.entries.get(original);
        if (previous?.fingerprint === candidate.fingerprint) continue;
        // Version every changed definition. The CLI reports tool names but no
        // schema digest; a new name makes its existing refresh barrier confirm
        // this exact schema/description revision before the callback resumes.
        previous?.registration.remove();
        const registration = this.instance.registerTool(candidate.mcpName, {
          description: candidate.definition.description ?? original,
          inputSchema: candidate.schema,
          _meta: { "anthropic/alwaysLoad": true },
        }, async (args, extra) => {
          if (!this.hasVersion(original, candidate.mcpName)) throw new BridgeError(409, "tool_not_advertised", `Droid no longer advertises this version of ${original}`);
          return this.handler(original, args, extra, candidate.mcpName);
        });
        if (typeof registration?.remove !== "function" || typeof registration.update !== "function") throw new Error("RegisteredTool.update/remove are unavailable");
        this.names.activate(original, candidate.mcpName, candidate.fingerprint);
        this.entries.set(original, { definition: candidate.definition, registration, fingerprint: candidate.fingerprint, mcpName: candidate.mcpName, advertisedSchema: candidate.advertisedSchema });
        changed = true;
      }
      if (changed && this.instance.isConnected?.() !== false) {
        // The high-level convenience method returns void; await the public
        // underlying notification when available, before releasing ToolSearch.
        if (this.instance.server?.sendToolListChanged) await this.instance.server.sendToolListChanged();
        else await this.instance.sendToolListChanged();
      }
      return changed;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(502, "tool_catalog_update_failed", error instanceof Error ? error.message : String(error));
    }
  }
}

/** Object-key ordering is not a catalog change and must not invalidate caches. */
function canonicalJson(value: unknown): string {
  const canonical = (node: unknown): unknown => Array.isArray(node) ? node.map(canonical)
    : node && typeof node === "object" ? Object.fromEntries(Object.entries(node).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)])) : node;
  return JSON.stringify(canonical(value));
}
