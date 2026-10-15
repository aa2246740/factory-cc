import { defineConfig } from "vitest/config";

export default defineConfig({
  server: { host: "127.0.0.1", port: 18788 },
  test: {
    environment: "jsdom",
    exclude: ["tests/playwright.acceptance.spec.ts", "node_modules/**"],
  },
});
