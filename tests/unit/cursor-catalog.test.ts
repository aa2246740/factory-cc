import { describe, expect, it } from "vitest";
import { cursorMenuFromCatalog, formatCursorCatalog } from "../../src/runtime/cursor/catalog.js";
import { cursorCatalogFixture, cursorLiveCatalogFixture } from "../../src/runtime/cursor/fixture.js";
import { standardContextValue } from "../../src/runtime/cursor/pins.js";
import { validateModels } from "../../src/models.js";

const params = (id: string) => cursorMenuFromCatalog(cursorCatalogFixture, "default").find((model) => model.model === id)?.cursor?.params;

describe("Cursor catalog menu", () => {
  it("defaults to Composer 2.5 and Grok 4.7 with an explicit full parameter set", () => {
    const menu = validateModels(cursorMenuFromCatalog(cursorCatalogFixture, "default"));
    expect(menu.map((model) => [model.id, model.displayName])).toEqual([
      ["cursor:composer-2.5", "Cursor · Composer 2.5"],
      ["cursor:grok-4.7", "Cursor · Grok 4.7"],
    ]);
    expect(params("composer-2.5")).toEqual([{ id: "fast", value: "false" }]);
    expect(params("grok-4.7")).toEqual([
      { id: "effort", value: "high" },
      { id: "context", value: "standard" },
      { id: "fast", value: "false" },
    ]);
    expect(JSON.stringify(menu.map((model) => model.cursor?.params))).not.toMatch(/500k/);
    expect(menu.every((model) => model.provider === "cursor" && model.cursor?.params.length === (model.model === "composer-2.5" ? 1 : 3))).toBe(true);
  });

  it("keeps first-party and named escape hatches apart", () => {
    const first = cursorMenuFromCatalog(cursorCatalogFixture, "first-party");
    expect(first.map((model) => model.model)).toEqual(["composer-2.5", "grok-4.5", "grok-4.6", "grok-4.7"]);
    expect(first.every((model) => model.cursor?.params.every((param) => param.value !== "true" && param.value !== "500k" && param.value !== "low"))).toBe(true);
    expect(() => cursorMenuFromCatalog(cursorCatalogFixture, "first-party")).not.toThrow();
    expect(() => cursorMenuFromCatalog(cursorCatalogFixture, "claude-opus-4-8,gpt-5.4")).not.toThrow();
    const named = cursorMenuFromCatalog(cursorCatalogFixture, "claude-opus-4-8,composer-2.5-fast");
    expect(named.map((model) => model.model)).toEqual(["claude-opus-4-8", "composer-2.5"]);
    expect(named[0]?.cursor?.params).toEqual([
      { id: "effort", value: "high" },
      { id: "context", value: "standard" },
      { id: "fast", value: "false" },
    ]);
    expect(named[1]?.cursor?.params).toEqual([{ id: "fast", value: "true" }]);
    expect(named[1]?.id).toBe("cursor:composer-2.5.fast-true");
    expect(() => cursorMenuFromCatalog(cursorCatalogFixture, "claude-opus-4-8[context=1m,effort=low,fast=false]")).not.toThrow();
    expect(cursorMenuFromCatalog(cursorCatalogFixture, "claude-opus-4-8[context=1m,effort=low,fast=false]")[0]?.cursor?.params).toEqual([
      { id: "effort", value: "low" },
      { id: "context", value: "1m" },
      { id: "fast", value: "false" },
    ]);
  });

  it("pins the live Grok 4.7 ids instead of the default 500k Fast variant", () => {
    const menu = validateModels(cursorMenuFromCatalog(cursorLiveCatalogFixture, "default"));
    expect(menu.map((model) => [model.id, model.displayName])).toEqual([
      ["cursor:composer-2.5", "Cursor · Composer 2.5"],
      ["cursor:grok-4.7", "Cursor · Grok 4.7"],
    ]);
    expect(menu[0]?.cursor?.params).toEqual([{ id: "fast", value: "false" }]);
    expect(menu[1]?.cursor?.params).toEqual([
      { id: "context", value: "256k" },
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "false" },
    ]);
    expect(JSON.stringify(menu[1]?.cursor?.params)).not.toMatch(/500k|"true"/);
    expect(standardContextValue([{ value: "500k" }, { value: "256k" }])).toBe("256k");
  });

  it("rejects auto, unknown ids, and unpinned parameters; first-party stays on Cursor's own models", () => {
    const first = cursorMenuFromCatalog(cursorCatalogFixture, "first-party").map((model) => model.model);
    expect(first).not.toEqual(expect.arrayContaining(["claude-opus-4-8", "gpt-5.4", "auto"]));
    expect(() => cursorMenuFromCatalog(cursorCatalogFixture, "auto")).toThrow(/Auto/);
    expect(() => cursorMenuFromCatalog(cursorCatalogFixture, "no-such-model")).toThrow(/no model/);
    expect(() => cursorMenuFromCatalog(cursorCatalogFixture, "mystery-model")).toThrow(/no pin/);
    expect(() => cursorMenuFromCatalog(cursorCatalogFixture, "all")).toThrow(/whole catalog/);
    expect(() => cursorMenuFromCatalog(cursorCatalogFixture, "composer-2.5,composer-2.5")).toThrow(/unique/);
    expect(formatCursorCatalog(cursorCatalogFixture, "grok-4.7")).toContain("grok-4.7");
    expect(formatCursorCatalog(cursorCatalogFixture, "grok-4.7")).not.toContain("composer-2.5");
  });
});
