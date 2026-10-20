/**
 * The only place that decides which Cursor parameter values go on the menu.
 * The SDK uses each parameter's first allowed value when a selection omits it,
 * so every menu entry is built by filling every parameter from this table.
 * Change the defaults here; do not scatter fast/effort/context literals.
 * `effort` is also the pin for the live Grok 4.7 parameter id `reasoning_effort`.
 */
export const CURSOR_MENU_PINS = {
  fast: "false",
  effort: "high",
} as const;

/** Default Droid menu: Composer 2.5 and Grok 4.7, Fast off, Grok on the non-500k context. */
export const CURSOR_DEFAULT_MODEL_IDS = ["composer-2.5", "grok-4.7"] as const;

/** Opt-in first-party set. Fast and 500k stay out unless a spec names them. */
export const CURSOR_FIRST_PARTY_IDS = ["composer-2.5", "grok-4.5", "grok-4.6", "grok-4.7"] as const;

const LONG_CONTEXT = /500k/i;

export function isLongContextValue(value: { value: string; displayName?: string }): boolean {
  return LONG_CONTEXT.test(value.value) || LONG_CONTEXT.test(value.displayName ?? "");
}

/**
 * Prefer the value named "standard".
 * The live Grok 4.7 catalog has no such value: its choices are `256k` and `500k`, so this returns `256k`.
 */
export function standardContextValue(values: ReadonlyArray<{ value: string; displayName?: string }>): string | undefined {
  const usable = values.filter((value) => !isLongContextValue(value));
  return usable.find((value) => value.value === "standard")?.value ?? usable[0]?.value;
}
