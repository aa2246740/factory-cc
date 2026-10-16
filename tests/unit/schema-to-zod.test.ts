import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonSchemaToZod, zodToolInputSchema } from "../../src/protocol/schema-to-zod.js";
import { createToolNameMap, sanitizeMcpName } from "../../src/protocol/tool-names.js";

describe("jsonSchemaToZod", () => {
  it("preserves every argument of the captured Factory Task schema without injecting defaults", () => {
    const converted = jsonSchemaToZod({
      type: "object",
      properties: {
        subagent_type: { type: "string" },
        description: { type: "string" },
        prompt: { type: "string" },
        image_paths: { type: "array", items: { type: "string" } },
        complexity: { type: "string", enum: ["light", "medium", "heavy"] },
        await: { type: "boolean", default: false },
        resume: { type: "string" },
      },
      required: ["subagent_type", "description", "prompt"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });
    const args = {
      subagent_type: "reviewer", description: "review current feature", prompt: "Check the new behavior.",
      image_paths: ["/tmp/diagram.png"], complexity: "heavy", await: true, resume: "task-123",
    };
    const input = zodToolInputSchema(converted.schema);
    expect(converted.lossless).toBe(true);
    expect(input.parse(args)).toEqual(args);
    expect(input.parse({ subagent_type: "reviewer", description: "review", prompt: "check" })).not.toHaveProperty("await");
    expect(input.safeParse({ ...args, complexity: "invalid" }).success).toBe(false);
    expect(input.safeParse({ ...args, unexpected: "reject instead of stripping" }).success).toBe(false);
    expect(z.toJSONSchema(input).additionalProperties).toBe(false);
  });

  it("retains recursive JSONdict_nested values and unknown keys in open objects", () => {
    const converted = jsonSchemaToZod({
      type: "object",
      properties: { handoff: { $ref: "#/definitions/JSONdict_nested" } },
      required: ["handoff"],
      definitions: {
        JSONdict_nested: {
          type: "object",
          additionalProperties: { anyOf: [
            { type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" },
            { type: "array", items: {} }, { $ref: "#/definitions/JSONdict_nested" },
          ] },
        },
      },
    });
    const args = {
      handoff: { summary: "done", checks: { passed: 4, failures: [], more: { evidence: "test.log" } }, flag: true, empty: null },
      future_argument: { default: "ordinary data", arbitrary: [{ nested: "keep me" }] },
    };
    expect(converted.lossless, converted.notes.join("\n")).toBe(true);
    expect(zodToolInputSchema(converted.schema).parse(args)).toEqual(args);
  });

  it("preserves and validates typed additionalProperties at root and nested levels", () => {
    const converted = jsonSchemaToZod({
      type: "object",
      properties: { label: { type: "string" } },
      additionalProperties: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
    });
    const input = zodToolInputSchema(converted.schema);
    const args = { label: "metrics", build: { elapsed: 3, checks: 5 }, test: { passed: 7 } };
    expect(converted.lossless).toBe(true);
    expect(input.parse(args)).toEqual(args);
    expect(input.safeParse({ build: { elapsed: -1 } }).success).toBe(false);
    expect(input.safeParse({ build: { elapsed: "3" } }).success).toBe(false);
    expect(z.toJSONSchema(input).additionalProperties).toMatchObject({ type: "object", additionalProperties: { type: "number", minimum: 0 } });
  });

  it("enforces the captured ToolSearch nullable positive integer constraint", () => {
    const converted = jsonSchemaToZod({
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { anyOf: [{ type: "integer", exclusiveMinimum: 0 }, { type: "null" }] },
      },
      required: ["query"], additionalProperties: false,
    });
    expect(converted.lossless).toBe(true);
    expect(converted.schema.parse({ query: "test", max_results: null })).toEqual({ query: "test", max_results: null });
    expect(converted.schema.safeParse({ query: "test", max_results: 0 }).success).toBe(false);
    expect(converted.schema.safeParse({ query: "test", max_results: 1.5 }).success).toBe(false);
  });

  it("enforces oneOf exclusivity and never downgrades a root union to an empty shape", () => {
    const choice = { oneOf: [{ type: "number" }, { type: "integer" }] };
    const nested = jsonSchemaToZod({ type: "object", properties: { choice }, required: ["choice"] });
    expect(nested.lossless).toBe(true);
    expect(nested.schema.parse({ choice: 1.5 })).toEqual({ choice: 1.5 });
    expect(nested.schema.safeParse({ choice: 1 }).success).toBe(false);
    const root = jsonSchemaToZod({ oneOf: [
      { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
      { type: "object", properties: { b: { type: "string" } }, required: ["b"], additionalProperties: false },
    ] });
    const rootInput = zodToolInputSchema(root.schema);
    expect(rootInput.parse({ a: "valid" })).toEqual({ a: "valid" });
    expect(rootInput.safeParse({ a: "one", b: "two" }).success).toBe(false);
    expect(z.toJSONSchema(rootInput).oneOf).toHaveLength(2);
  });

  it("keeps default as an annotation and does not weaken required fields", () => {
    const converted = jsonSchemaToZod({
      type: "object", properties: { required_value: { type: "string", default: "injected" } }, required: ["required_value"],
    });
    expect(converted.lossless).toBe(true);
    expect(converted.schema.safeParse({}).success).toBe(false);
    expect(converted.notes).toContain("$/properties/required_value: default annotation is not applied to caller arguments");
  });

  it("reports unsupported validation constraints honestly and fails closed on conversion errors", () => {
    const ignored = jsonSchemaToZod({ type: "object", dependencies: { a: ["b"] } });
    expect(ignored.lossless).toBe(true);
    expect(ignored.schema.safeParse({ a: true }).success).toBe(false);
    expect(ignored.schema.parse({ a: true, b: false })).toEqual({ a: true, b: false });
    const conditional = jsonSchemaToZod({ type: "object", if: { required: ["a"] }, then: { required: ["b"] } });
    expect(conditional.lossless).toBe(true);
    expect(conditional.schema.safeParse({ a: true }).success).toBe(false);
    expect(conditional.schema.safeParse({}).success).toBe(true);
    const untyped = jsonSchemaToZod({ properties: { a: { type: "string" } } });
    expect(untyped.lossless).toBe(true);
    expect(() => zodToolInputSchema(untyped.schema)).toThrow();
    const format = jsonSchemaToZod({ type: "object", properties: { value: { type: "string", format: "custom-ignored-format" } } });
    expect(format.lossless).toBe(false);
    const conflictingEnum = jsonSchemaToZod({ type: "object", properties: { value: { type: "string", enum: [1, "allowed"] } } });
    expect(conflictingEnum.lossless).toBe(true);
    expect(conflictingEnum.schema.safeParse({ value: 1 }).success).toBe(false);
    expect(conflictingEnum.schema.safeParse({ value: "allowed" }).success).toBe(true);
  });

  it("prepares draft-07 schema dependencies without changing property dependency arrays", () => {
    const converted = jsonSchemaToZod({
      type: "object", $schema: "http://json-schema.org/draft-07/schema#",
      dependencies: {
        a: { properties: { b: { type: "integer", minimum: 1, default: 3, "x-description": "annotation" } } },
        c: ["d"],
      },
    });
    expect(converted.lossless, converted.notes.join("\n")).toBe(true);
    const input = zodToolInputSchema(converted.schema);
    expect(input.parse({ a: true, b: 2 })).toEqual({ a: true, b: 2 });
    expect(input.safeParse({ a: true, b: 0 }).success).toBe(false);
    expect(input.parse({ a: true })).toEqual({ a: true });
    expect(input.safeParse({ c: true }).success).toBe(false);
    expect(input.parse({ c: true, d: false })).toEqual({ c: true, d: false });
    expect(z.toJSONSchema(input).dependencies).toEqual({
      a: { properties: { b: { type: "integer", minimum: 1 } } },
      c: ["d"],
    });
    expect(converted.notes).toContain("$/dependencies/a/properties/b: default annotation is not applied to caller arguments");
  });

  it("intersects enum and const instead of dropping either constraint", () => {
    const converted = jsonSchemaToZod({
      type: "object",
      properties: { value: { type: "string", enum: ["a", "b"], const: "a" } },
      required: ["value"],
    });
    expect(converted.lossless).toBe(true);
    expect(converted.schema.safeParse({ value: "a" }).success).toBe(true);
    expect(converted.schema.safeParse({ value: "b" }).success).toBe(false);
  });

  it("enforces array bounds without items and counts Unicode scalar values", () => {
    const converted = jsonSchemaToZod({ type: "object", properties: {
      values: { type: "array", minItems: 2, maxItems: 3 },
      glyph: { type: "string", minLength: 1, maxLength: 1 },
    }, required: ["values", "glyph"] });
    expect(converted.lossless).toBe(true);
    expect(converted.schema.safeParse({ values: [], glyph: "a" }).success).toBe(false);
    expect(converted.schema.safeParse({ values: [1, 2, 3, 4], glyph: "a" }).success).toBe(false);
    expect(converted.schema.parse({ values: [1, 2], glyph: "💛" })).toEqual({ values: [1, 2], glyph: "💛" });
  });

  it("composes patternProperties with typed additionalProperties and compares object literals deeply", () => {
    const converted = jsonSchemaToZod({ type: "object", properties: {
      record: { type: "object", patternProperties: { "^n": { type: "number" } }, additionalProperties: { type: "string" } },
      literal: { const: { nested: [1, { flag: true }] } },
    } });
    const valid = { record: { n1: 2, other: "text" }, literal: { nested: [1, { flag: true }] } };
    expect(converted.lossless).toBe(true);
    expect(converted.schema.parse(valid)).toEqual(valid);
    expect(converted.schema.safeParse({ record: { other: 2 } }).success).toBe(false);
    expect(converted.schema.safeParse({ literal: { nested: [1, { flag: false }] } }).success).toBe(false);
  });

  it("resolves complete JSON pointers and intersects ref siblings and multiple compositions", () => {
    const converted = jsonSchemaToZod({ type: "object", $schema: "https://json-schema.org/draft/2020-12/schema", properties: {
      ref: { $ref: "#/$defs/container/properties/value", minimum: 5 },
      combined: { anyOf: [{ type: "number" }], oneOf: [{ type: "integer" }] },
    }, $defs: { container: { type: "object", properties: { value: { type: "number" } } } } });
    expect(converted.lossless, converted.notes.join("\n")).toBe(true);
    expect(converted.schema.parse({ ref: 5, combined: 7 })).toEqual({ ref: 5, combined: 7 });
    expect(converted.schema.safeParse({ ref: 1 }).success).toBe(false);
    expect(converted.schema.safeParse({ ref: { value: 5 } }).success).toBe(false);
    expect(converted.schema.safeParse({ combined: 1.5 }).success).toBe(false);
  });

  it("supports 2020 unevaluated properties and refuses unknown assertions without dropping them", () => {
    const converted = jsonSchemaToZod({ type: "object", $schema: "https://json-schema.org/draft/2020-12/schema",
      allOf: [{ properties: { a: { type: "string" } } }], unevaluatedProperties: false });
    expect(converted.lossless, converted.notes.join("\n")).toBe(true);
    expect(converted.schema.safeParse({ a: "yes" }).success).toBe(true);
    expect(converted.schema.safeParse({ a: "yes", extra: true }).success).toBe(false);
    expect(jsonSchemaToZod({ type: "object", unknownValidation: true }).lossless).toBe(false);
  });

  it("preserves nested reserved JSON keys and rejects an unrepresentable explicit root parameter", () => {
    const converted = jsonSchemaToZod({ type: "object", properties: {} });
    const root = JSON.parse('{"__proto__":{"retained":true}}');
    expect(converted.schema.parse(root)).toEqual(root);
    const nested = JSON.parse('{"data":{"__proto__":{"retained":true},"constructor":"data"}}');
    expect(converted.schema.parse(nested)).toEqual(nested);
    const declared = jsonSchemaToZod(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'));
    expect(declared.lossless).toBe(false);
    expect(declared.notes.join("\n")).toContain("official MCP transport cannot preserve");
  });

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
