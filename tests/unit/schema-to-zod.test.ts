import { describe, expect, it } from "vitest";
import { jsonSchemaToZod } from "../../src/protocol/schema-to-zod.js";
import { createToolNameMap, sanitizeMcpName } from "../../src/protocol/tool-names.js";

describe("jsonSchemaToZod", () => {
  it("converts required object fields without dropping enums", () => {
    const converted = jsonSchemaToZod({
      type: "object",
      properties: {
        path: { type: "string", description: "file path" },
        mode: { type: "string", enum: ["read", "stat"] },
      },
      required: ["path"],
      additionalProperties: false,
    });
    expect(converted.lossless).toBe(true);
    expect(converted.schema.parse({ path: "a.txt", mode: "read" })).toEqual({ path: "a.txt", mode: "read" });
    expect(() => converted.schema.parse({ path: "a.txt", mode: "write" })).toThrow();
    expect(() => converted.schema.parse({})).toThrow();
  });

  it("resolves local $ref and refuses remote refs", () => {
    const local = jsonSchemaToZod({
      type: "object",
      properties: { item: { $ref: "#/$defs/item" } },
      $defs: { item: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } },
    });
    expect(local.schema.parse({ item: { n: 3 } })).toEqual({ item: { n: 3 } });

    const remote = jsonSchemaToZod({
      type: "object",
      properties: { item: { $ref: "https://example.invalid/schema.json" } },
    });
    expect(remote.lossless).toBe(false);
  });
});

describe("tool names", () => {
  it("maps illegal and colliding names back to the original Droid name", () => {
    const map = createToolNameMap(["Read File", "Read_File", "9start"]);
    expect(sanitizeMcpName("Read File")).toBe("Read_File");
    expect(map.toOriginal(map.toMcp("Read File"))).toBe("Read File");
    expect(map.toOriginal(map.toMcp("Read_File"))).toBe("Read_File");
    expect(map.toMcp("Read File")).not.toBe(map.toMcp("Read_File"));
  });
});
