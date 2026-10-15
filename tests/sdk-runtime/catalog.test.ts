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
    expect(updated[0]).toMatchObject({ name: "FactoryFreshTool", description: "Changed description", inputSchema: { additionalProperties: false, properties: { value: { type: "integer" } } } });
    const valid = await client.callTool({ name: "FactoryFreshTool", arguments: { value: 7 } });
    expect(valid.isError).not.toBe(true);
    expect(valid.content).toEqual([{ type: "text", text: '{"value":7}' }]);
    const invalid = await client.callTool({ name: "FactoryFreshTool", arguments: { value: "old schema", extra: true } });
    expect(invalid.isError).toBe(true);
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

  it("can publish the first tool after connecting with an empty catalog", async () => {
    const { catalog, client } = await connected();
    await catalog.update([definition("FirstTool")]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["FirstTool"]);
  });

  it("rejects an unsupported update before mutating the previous catalog", async () => {
    const { catalog, client } = await connected([definition("ExistingTool")]);
    await expect(catalog.update([{ name: "Unsupported", input_schema: { type: "object", if: { required: ["x"] }, then: { required: ["y"] } } }])).rejects.toMatchObject({ code: "unsupported_tool_schema" });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ExistingTool"]);
    await expect(catalog.update([{ name: "RootUnion", input_schema: { oneOf: [{ type: "object", properties: { x: { type: "string" } } }, { type: "object", properties: { y: { type: "number" } } }] } }])).rejects.toMatchObject({ status: 422, code: "unsupported_tool_schema" });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ExistingTool"]);
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
