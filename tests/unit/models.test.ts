import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { configuredModels, modelsFromIds, parseModelIds, resolveRequestModel, validateModels } from "../../src/models.js";

const dirs: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), "model-catalog-")); dirs.push(path); return path; };
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });

describe("actual inference models", () => {
  it("keeps Claude aliases and BYOK models distinct from Factory roles", () => {
    expect(modelsFromIds(["sonnet", "opus", "haiku"], "subscription").map((model) => model.displayName))
      .toEqual(["Claude Sonnet", "Claude Opus", "Claude Haiku"]);
    expect(modelsFromIds(["sonnet", "opus", "haiku"], "anthropic-api").map((model) => model.displayName))
      .toEqual(["Claude Sonnet", "Claude Opus", "Claude Haiku"]);
    expect(modelsFromIds(["glm-5.2", "glm-4.7"]).map((model) => model.displayName)).toEqual(["GLM-5.2", "GLM-4.7"]);
    expect(modelsFromIds(["sonnet"], "byok")[0]?.model).toBe("sonnet");
  });
  it("rejects empty, duplicate and injected identifiers", () => {
    for (const value of ["", "sonnet,sonnet", "sonnet,", "sonnet\nworker", "$(cmd)"]) expect(() => parseModelIds(value)).toThrow();
    expect(parseModelIds(" sonnet , haiku ")).toEqual(["sonnet", "haiku"]);
    expect(() => validateModels([{ id: "haiku", model: "haiku", displayName: "bad\nname" }])).toThrow();
  });
  it("routes each BYOK request to its selected model on the explicit endpoint", () => {
    vi.stubEnv("CATALOG_TEST_TOKEN", "isolated-test-token");
    const config = loadConfig({ dataDir: directory(), authMode: "byok", models: modelsFromIds(["glm-5.2", "glm-4.7"]),
      upstreamBaseUrl: "https://example.test/anthropic", upstreamModel: "glm-5.2", upstreamTokenEnv: "CATALOG_TEST_TOKEN" });
    const first = resolveRequestModel(config, "glm-5.2"), second = resolveRequestModel(config, "glm-4.7");
    expect(first.selection?.provider.model).toBe("glm-5.2"); expect(second.selection?.provider.model).toBe("glm-4.7");
    expect(first.routeKey).not.toBe(second.routeKey); expect(first.routeKey).not.toContain("isolated-test-token");
    expect(second.selection?.provider.baseUrl).toBe("https://example.test/anthropic");
  });
  it("rejects unconfigured models before credential resolution", () => {
    const config = loadConfig({ dataDir: directory(), authMode: "byok", models: modelsFromIds(["glm-5.2"]), upstreamTokenEnv: "MISSING_TEST_KEY" });
    expect(() => resolveRequestModel(config, "relay-worker")).toThrowError(expect.objectContaining({ code: "unknown_model" }));
  });
  it("resolves subscription aliases without discovering or changing credentials", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "user-setting");
    const config = loadConfig({ dataDir: directory(), authMode: "subscription", models: modelsFromIds(["sonnet", "haiku"], "subscription") });
    expect(resolveRequestModel(config, "haiku")).toMatchObject({ model: "haiku", selection: undefined });
    expect(process.env.ANTHROPIC_MODEL).toBe("user-setting");
  });
  it("gives anthropic-api the subscription catalog and leaves cloud empty without BRIDGE_MODELS", () => {
    vi.stubEnv("BRIDGE_MODELS", "");
    vi.stubEnv("BRIDGE_UPSTREAM_MODEL", "");
    const anthropic = loadConfig({ dataDir: directory(), authMode: "anthropic-api" });
    expect(anthropic.models).toBeUndefined();
    expect(configuredModels(anthropic).map((model) => model.id)).toEqual(["sonnet", "opus", "haiku"]);
    expect(configuredModels(loadConfig({ dataDir: directory(), authMode: "cloud" }))).toEqual([]);
  });
  it("loads an explicit environment catalog with the matching names", () => {
    vi.stubEnv("BRIDGE_MODELS", "sonnet,haiku");
    expect(loadConfig({ dataDir: directory(), authMode: "subscription" }).models).toEqual(modelsFromIds(["sonnet", "haiku"], "subscription"));
  });
});
