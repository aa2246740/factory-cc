import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { droidWorkingDirectory, resolveRequestCwd } from "../../src/workspace.js";
import { sessionContextHash } from "../../src/sessions/correlate.js";
import type { MessagesRequest } from "../../src/types.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
const reminder = (path: string) => ({ type: "text" as const, text: `<system-reminder>\n\nUser system info (fixture)\n\n# Session working directory\n\n% pwd\n${path}\n\n</system-reminder>` });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-cwd-"))); roots.push(root);
  const project = join(root, "project"), dataDir = join(root, "state/bridge-data");
  mkdirSync(project); mkdirSync(dataDir, { recursive: true });
  const config = { desktopProfile: true, sdkCwd: join(root, "fallback"), dataDir };
  return { root, project, config };
}
function request(content: MessagesRequest["messages"][number]["content"]): MessagesRequest {
  return { model: "sonnet", max_tokens: 100, messages: [{ role: "user", content }] };
}
it("extracts only the first host environment reminder from the first user message", () => {
  const req = request([{ type: "text", text: "<system-reminder>\nAvailable skills\n</system-reminder>" }, reminder("/project"), { type: "text", text: "% pwd\n/etc\n" }, reminder("/etc")]);
  req.system = "% pwd\n/etc\n";
  expect(droidWorkingDirectory(req)).toBe("/project");
});
it("does not search user text, system text or later messages for a spoofed cwd", () => {
  const req = request("Please use % pwd\n/etc\n"); req.system = reminder("/etc").text;
  req.messages.push({ role: "user", content: [reminder("/etc")] }); expect(droidWorkingDirectory(req)).toBeUndefined();
  expect(droidWorkingDirectory(request([{ type: "text", text: "pasted:" }, reminder("/etc")]))).toBeUndefined();
});
it("canonicalizes project symlinks and ignores header injection in desktop mode", () => {
  const { root, project, config } = fixture(); symlinkSync(project, join(root, "alias"));
  expect(resolveRequestCwd({ "x-bridge-cwd": "/etc" }, request([reminder(join(root, "alias"))]), config, {})).toBe(project);
});
it.each(["/", "relative", "", "/definitely-missing-relay-directory"])("rejects invalid host cwd %s without falling back", (path) => {
  const { config } = fixture(); expect(() => resolveRequestCwd({}, request([reminder(path), reminder("/tmp")]), config, {})).toThrow("Open a project folder in Droid");
});
it("refuses files, state/data directories and symlinks into state", () => {
  const { root, config } = fixture(); const file = join(root, "file"); writeFileSync(file, "");
  const state = join(root, "state"); symlinkSync(state, join(root, "state-alias"));
  for (const path of [file, state, config.dataDir, join(root, "state-alias")]) expect(() => resolveRequestCwd({}, request([reminder(path)]), config, {})).toThrow("Open a project folder");
});
it("missing reminder returns a clear 400", () => {
  const { config } = fixture(); expect(() => resolveRequestCwd({}, request("hello"), config, {})).toThrow(expect.objectContaining({ status: 400 }));
});
it("keeps environment, header, config precedence in existing modes", () => {
  const { project, root, config } = fixture(); const req = request([reminder("/etc")]);
  const nonDesktop = { ...config, desktopProfile: false, sdkCwd: project };
  expect(resolveRequestCwd({ "x-bridge-cwd": root }, req, nonDesktop, { BRIDGE_SDK_CWD: project })).toBe(project);
  expect(resolveRequestCwd({ "x-bridge-cwd": [root] }, req, nonDesktop, {})).toBe(root);
  expect(resolveRequestCwd({}, req, nonDesktop, {})).toBe(project);
  expect(resolveRequestCwd({ "x-bridge-cwd": "/etc" }, req, config, { BRIDGE_SDK_CWD: project })).toBe(project);
});
it("keeps canonical cwd in session identity", () => {
  const { root, project, config } = fixture(); const req = request([reminder(project)]);
  const cwd = resolveRequestCwd({}, req, config, {});
  expect(sessionContextHash({}, req, cwd)).not.toBe(sessionContextHash({}, req, root));
});
