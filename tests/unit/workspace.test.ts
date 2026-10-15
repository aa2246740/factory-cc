import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalWorkspacePath } from "../../src/workspace.js";
import { loadConfig } from "../../src/config.js";
import { resolveSession, sessionContextHash } from "../../src/sessions/correlate.js";
import { SessionStore } from "../../src/sessions/store.js";
import type { MessagesRequest } from "../../src/types.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "relay-workspace-")));
  directories.push(directory);
  const physical = join(directory, "project");
  const alias = join(directory, "alias");
  const other = join(directory, "other");
  mkdirSync(physical); mkdirSync(other);
  symlinkSync(physical, alias, "junction");
  return { directory, physical, alias, other };
}

describe("workspace identity", () => {
  it("canonicalizes existing aliases in configuration and keeps missing-workspace compatibility", () => {
    const f = fixture();
    expect(canonicalWorkspacePath(f.alias)).toBe(f.physical);
    expect(loadConfig({ dataDir: join(f.directory, "data"), sdkCwd: f.alias }).sdkCwd).toBe(f.physical);
    const absent = join(f.directory, "missing", "future-workspace");
    expect(canonicalWorkspacePath(absent)).toBe(resolve(absent));
    const file = join(f.directory, "file");
    writeFileSync(file, "not a directory");
    expect(canonicalWorkspacePath(join(file, "nested"))).toBe(join(file, "nested"));
  });

  it.skipIf(process.platform === "win32")("propagates filesystem errors other than missing paths, including symlink loops", () => {
    const f = fixture();
    const loop = join(f.directory, "loop");
    symlinkSync(loop, loop);
    expect(() => canonicalWorkspacePath(loop)).toThrowError(expect.objectContaining({ code: "ELOOP" }));
  });

  it("continues the same host session across alias and physical paths without accepting another workspace", () => {
    const f = fixture();
    const request: MessagesRequest = { model: "test", max_tokens: 100, messages: [{ role: "user", content: "same host" }] };
    const store = new SessionStore(join(f.directory, "sessions"), false, 5);
    const record = store.create({ role: "chat", model: "test", toolNames: [], contextHash: sessionContextHash({ "x-bridge-role": "chat" }, request, f.alias) });
    store.update(record.bridgeSessionId, { factorySessionId: "factory-one", factoryCwd: f.physical });
    const headers = { "x-bridge-role": "chat", "x-bridge-session": record.bridgeSessionId };
    expect(sessionContextHash(headers, request, f.alias)).toBe(sessionContextHash(headers, request, f.physical));
    expect(resolveSession([record], headers, request, { cwd: f.physical, hostSessionId: "factory-one" }).match).toBe(record);
    expect(resolveSession([record], headers, request, { cwd: f.alias, hostSessionId: "factory-one" }).match).toBe(record);
    expect(() => resolveSession([record], headers, request, { cwd: f.other, hostSessionId: "factory-one" }))
      .toThrowError(expect.objectContaining({ code: "cross_host_session" }));
  });
});
