/**
 * Playwright assertions for the locked Tiny Tasks acceptance points.
 * Run with: npx playwright test --config fixtures/tiny-tasks/playwright.config.ts
 * If browsers are missing this file is still the required assertion source.
 */
export const acceptancePoints = [
  "create 买牛奶 and 检查报告, complete one",
  "all / active / completed filters and counts",
  "edit Chinese title without changing completion",
  "reload keeps titles and completion",
  "delete completed task; empty completed state",
  "reject whitespace-only names",
];
