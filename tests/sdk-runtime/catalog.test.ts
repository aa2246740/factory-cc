import { afterEach, describe, expect, it, vi } from "vitest";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { DroidMcpCatalog, StableDroidToolNames } from "../../src/runtime/droid-mcp-catalog.js";
import type { ToolDefinition } from "../../src/types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).map((close) => close())); });
const definition = (name: string, type: "string" | "integer" = "string"): ToolDefinition => ({
  name, description: `Description of ${name}`,
  input_schema: { type: "object", properties: { value: { type } }, required: ["value"], additionalProperties: false },
});
async function connected(initial: ToolDefinition[] = [], handler = async (_name: string, args: Record<string, unknown>) => ({ content: [{ type: "text", text: JSON.stringify(args) }] })) {
  // Real official SDK server + real MCP transport, with no CLI, model or network.
  const server = createSdkMcpServer({ name: "droid", version: "test", tools: [], alwaysLoad: true });
  const catalog = new DroidMcpCatalog(server, handler);
  await catalog.update(initial);
  const client = new Client({ name: "offline-catalog-test", version: "test" });
  let notifications = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { notifications++; });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.instance.close(); });
  return { catalog, client, notifications: () => notifications };
}

describe("mutable official SDK MCP server", () => {
  it("publishes additions, description and schema changes, and removals through list_changed", async () => {
    const { catalog, client, notifications } = await connected([definition("ToolSearch")]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ToolSearch"]);
    await catalog.update([definition("ToolSearch"), definition("FactoryFreshTool")]);
    await vi.waitFor(() => expect(notifications()).toBeGreaterThan(0));
    const added = (await client.listTools()).tools.find((tool) => tool.name === "FactoryFreshTool")!;
    expect(added.inputSchema).toMatchObject({ type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "string" } } });
    expect(added._meta).toMatchObject({ "anthropic/alwaysLoad": true });
    await catalog.update([{ ...definition("FactoryFreshTool", "integer"), description: "Changed description" }]);
    const updated = (await client.listTools()).tools;
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ name: catalog.names.toMcp("FactoryFreshTool"), description: "Changed description", inputSchema: { additionalProperties: false, properties: { value: { type: "integer" } } } });
    const valid = await client.callTool({ name: catalog.names.toMcp("FactoryFreshTool"), arguments: { value: 7 } });
    expect(valid.isError).not.toBe(true);
    expect(valid.content).toEqual([{ type: "text", text: '{"value":7}' }]);
    const invalid = await client.callTool({ name: catalog.names.toMcp("FactoryFreshTool"), arguments: { value: "old schema", extra: true } });
    expect(invalid.isError).toBe(true);
    expect((await client.callTool({ name: "FactoryFreshTool", arguments: { value: 7 } })).isError).toBe(true);
    const removed = await client.callTool({ name: "ToolSearch", arguments: { value: "gone" } });
    expect(removed.isError).toBe(true);
  });

  it("keeps an already-running callback alive when its tool is removed", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const started = vi.fn();
    const { catalog, client } = await connected([definition("OldTool")], async (_name, args) => {
      started(); await pending;
      return { content: [{ type: "text", text: JSON.stringify(args) }] };
    });
    const call = client.callTool({ name: "OldTool", arguments: { value: "pending-value" } });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    await catalog.update([]);
    expect((await client.listTools()).tools).toEqual([]);
    finish();
    expect((await call).content).toEqual([{ type: "text", text: '{"value":"pending-value"}' }]);
    expect((await client.callTool({ name: "OldTool", arguments: { value: "new-call" } })).isError).toBe(true);
  });

  it("keeps a live old-revision callback while preventing new invocations of its retired name", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const entered = vi.fn();
    const { catalog, client } = await connected([definition("ChangedTool")], async (_name, args) => {
      entered(args);
      if (args.value === "pending") await pending;
      return { content: [{ type: "text", text: JSON.stringify(args) }] };
    });
    const oldCall = client.callTool({ name: "ChangedTool", arguments: { value: "pending" } });
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    await catalog.update([definition("ChangedTool", "integer")]);
    expect((await client.callTool({ name: "ChangedTool", arguments: { value: "new stale call" } })).isError).toBe(true);
    finish();
    expect((await oldCall).content).toEqual([{ type: "text", text: '{"value":"pending"}' }]);
    expect((await client.callTool({ name: catalog.names.toMcp("ChangedTool"), arguments: { value: 9 } })).content).toEqual([{ type: "text", text: '{"value":9}' }]);
    expect(entered).toHaveBeenCalledTimes(2);
  });

  it("can publish the first tool after connecting with an empty catalog", async () => {
    const { catalog, client } = await connected();
    await catalog.update([definition("FirstTool")]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["FirstTool"]);
  });

  it("rejects an unsupported update before mutating the previous catalog", async () => {
    const { catalog, client } = await connected([definition("ExistingTool")]);
    await expect(catalog.update([{ name: "Unsupported", input_schema: { type: "object", unsupportedValidation: true } }])).rejects.toMatchObject({ code: "unsupported_tool_schema" });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ExistingTool"]);
    await expect(catalog.update([{ name: "RootUnion", input_schema: { oneOf: [{ type: "string" }, { type: "number" }] } }])).rejects.toMatchObject({ status: 422, code: "unsupported_tool_schema" });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ExistingTool"]);
  });

  it("advertises and enforces conditional and composed schemas through the real MCP transport", async () => {
    const schema = { type: "object", properties: { mode: { enum: ["read", "write"] }, body: { type: "string" }, items: { type: "array", minItems: 2 } },
      required: ["mode"], if: { properties: { mode: { const: "write" } } }, then: { required: ["body"] }, additionalProperties: false };
    const { catalog, client } = await connected([{ name: "ConditionalTool", input_schema: schema }]);
    expect((await client.listTools()).tools[0]?.inputSchema).toMatchObject(schema);
    expect((await client.callTool({ name: "ConditionalTool", arguments: { mode: "write" } })).isError).toBe(true);
    expect((await client.callTool({ name: "ConditionalTool", arguments: { mode: "read", items: [] } })).isError).toBe(true);
    const args = { mode: "write", body: "unchanged" };
    expect((await client.callTool({ name: "ConditionalTool", arguments: args })).content).toEqual([{ type: "text", text: JSON.stringify(args) }]);
    expect(catalog.hasVersion("ConditionalTool", "ConditionalTool")).toBe(true);
  });

  it("preserves nested reserved JSON keys through official MCP validation", async () => {
    const { client } = await connected([{ name: "OpenPayload", input_schema: { type: "object", properties: {} } }]);
    const args = JSON.parse('{"payload":{"__proto__":{"marker":"keep"},"constructor":"ordinary data"},"constructor":"also data"}');
    expect((await client.callTool({ name: "OpenPayload", arguments: args })).content).toEqual([{ type: "text", text: JSON.stringify(args) }]);
  });

  it("changes the visible revision for descriptions and schemas but ignores object-key order", async () => {
    const initial = definition("VersionedTool");
    const { catalog, client } = await connected([initial]);
    const next = { ...initial, description: "A changed tool contract" };
    await catalog.update([next]);
    const revision = catalog.names.toMcp(initial.name);
    expect(revision).not.toBe(initial.name);
    expect(catalog.names.toOriginal(initial.name)).toBe(initial.name);
    expect(catalog.names.toOriginal(revision)).toBe(initial.name);
    expect(catalog.hasVersion(initial.name, initial.name)).toBe(false);
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([revision]);
    expect(await catalog.update([{ input_schema: next.input_schema, description: next.description, name: next.name }])).toBe(false);
    expect(catalog.names.toMcp(initial.name)).toBe(revision);
  });

  it("keeps the current revision when an idle native query recreates its MCP server", async () => {
    const original = definition("ResumeTool");
    const names = new StableDroidToolNames();
    const create = async (tool: ToolDefinition) => {
      const server = createSdkMcpServer({ name: "droid", version: "test", tools: [] });
      const catalog = new DroidMcpCatalog(server, async () => ({ content: [] }), names);
      await catalog.update([tool]);
      return catalog;
    };
    await create(original);
    expect(names.toMcp(original.name)).toBe(original.name);
    await create(original);
    expect(names.toMcp(original.name)).toBe(original.name);
    const changed = definition("ResumeTool", "integer");
    await create(changed);
    const revision = names.toMcp(original.name);
    expect(revision).not.toBe(original.name);
    await create(changed);
    expect(names.toMcp(original.name)).toBe(revision);
  });

  it("keeps encoded names deterministic and collision-safe across reordering and removal", () => {
    const originals = ["Task", "a.b", "a b", "a_b", "droid_encoded_reserved", "工具", "x".repeat(100)];
    const first = new StableDroidToolNames();
    const mapping = new Map(originals.map((name) => [name, first.toMcp(name)]));
    const reordered = new StableDroidToolNames();
    for (const name of [...originals].reverse()) expect(reordered.toMcp(name)).toBe(mapping.get(name));
    expect(new Set(mapping.values()).size).toBe(originals.length);
    for (const [original, name] of mapping) {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(first.toOriginal(name)).toBe(original);
      expect(first.toMcp(original)).toBe(name);
    }
  });
});
