import type { CursorCatalogItem } from "./catalog.js";

/**
 * Parameter ids and values copied from `Cursor.models.list()` on 2026-10-20.
 * Composer’s default variant is Fast. Grok 4.7’s default variant is 500k + Fast.
 * The menu must not follow either variant. No account data is stored here.
 */
export const cursorLiveCatalogFixture: CursorCatalogItem[] = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    aliases: ["composer-latest", "composer", "composer-2-5"],
    parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true", displayName: "Fast" }] }],
    variants: [
      { params: [{ id: "fast", value: "true" }], displayName: "Composer 2.5 Fast", isDefault: true },
      { params: [{ id: "fast", value: "false" }], displayName: "Composer 2.5" },
    ],
  },
  {
    id: "grok-4.7",
    displayName: "Grok 4.7",
    parameters: [
      { id: "context", displayName: "Context", values: [{ value: "256k", displayName: "256K" }, { value: "500k", displayName: "500K" }] },
      { id: "reasoning_effort", displayName: "Effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
      { id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true", displayName: "Fast" }] },
    ],
    variants: [
      {
        params: [{ id: "context", value: "500k" }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" }],
        displayName: "Grok 4.7 High Fast",
        isDefault: true,
      },
    ],
  },
];

/**
 * Hand-written stand-in for `Cursor.models.list()`. Parameter order is the
 * dangerous one: `fast` lists true first, Grok effort lists low first, and
 * context lists 500k first. The menu must not follow that order.
 * The default Grok variant is also the long-context one, and is not selected.
 */
export const cursorCatalogFixture: CursorCatalogItem[] = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    aliases: ["composer-2"],
    parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "true", displayName: "Fast" }, { value: "false" }] }],
    variants: [
      { params: [{ id: "fast", value: "true" }], displayName: "Composer 2.5 Fast", isDefault: true },
      { params: [{ id: "fast", value: "false" }], displayName: "Composer 2.5" },
    ],
  },
  {
    id: "grok-4.7",
    displayName: "Grok 4.7",
    parameters: [
      { id: "effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
      { id: "context", values: [{ value: "500k", displayName: "500k" }, { value: "standard", displayName: "Standard" }] },
      { id: "fast", values: [{ value: "true", displayName: "Fast" }, { value: "false" }] },
    ],
    variants: [
      {
        params: [{ id: "effort", value: "low" }, { id: "context", value: "500k" }, { id: "fast", value: "true" }],
        displayName: "Grok 4.7 500k Fast",
        isDefault: true,
      },
    ],
  },
  {
    id: "grok-4.6",
    displayName: "Grok 4.6",
    aliases: ["cursor-grok-4.6"],
    parameters: [
      { id: "effort", values: [{ value: "low" }, { value: "high" }] },
      { id: "fast", values: [{ value: "true" }, { value: "false" }] },
    ],
  },
  {
    id: "grok-4.5",
    displayName: "Grok 4.5",
    aliases: ["cursor-grok-4.5"],
    parameters: [
      { id: "fast", values: [{ value: "true" }, { value: "false" }] },
    ],
  },
  {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    parameters: [
      { id: "effort", values: [{ value: "low" }, { value: "high" }] },
      { id: "context", values: [{ value: "500k" }, { value: "1m" }, { value: "standard" }] },
      { id: "fast", values: [{ value: "true" }, { value: "false" }] },
    ],
  },
  { id: "gpt-5.4", displayName: "GPT-5.4", parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }] },
  { id: "auto", displayName: "Auto", parameters: [] },
  {
    id: "mystery-model",
    displayName: "Mystery",
    parameters: [{ id: "temperature-bucket", values: [{ value: "first" }, { value: "second" }] }],
  },
];
