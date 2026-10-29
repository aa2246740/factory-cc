import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopLauncher, desktopPlist, type DesktopDependencies } from "../../scripts/desktop.js";
import { DESKTOP_OUTPUT_MAX_BYTES, restartBackoff, superviseDesktop } from "../../src/desktop-supervisor.js";

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { process.kill(-child.pid!, "SIGTERM"); await once(child, "exit"); }
  }
});
it("waits outside the repository until the external checkout becomes available", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-mount-"));
  const state = join(root, "state's directory"), repo = join(root, "not-mounted");
  mkdirSync(state);
  const install = { version: 1 as const, repo, node: process.execPath, path: "/usr/bin:/bin", port: 18797 };
  const launcher = join(state, "bridge-launcher.sh");
  writeFileSync(launcher, desktopLauncher(install, state));
  for (const name of ["client-token", "admin-token", "hook-token"]) writeFileSync(join(state, name), "fixture");
  const child = spawn("/bin/sh", [launcher], { cwd: state, detached: true, stdio: "ignore" }); children.push(child);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(child.exitCode).toBeNull();
  expect(readFileSync(join(state, "stderr.log"), "utf8")).toContain("desktop_waiting_for_files");
  mkdirSync(join(repo, "dist"), { recursive: true });
  writeFileSync(join(repo, "dist/index.js"), "");
  writeFileSync(join(repo, "dist/desktop-supervisor.js"), "process.exit(0)");
  await once(child, "exit");
  expect(child.exitCode).toBe(0);
  const deps = { home: root } as DesktopDependencies;
  const plist = desktopPlist(deps, install);
  expect(plist).toContain("/bin/sh");
  expect(plist).not.toContain(`<key>WorkingDirectory</key><string>${repo}</string>`);
  expect(plist).toContain("<key>ThrottleInterval</key><integer>30</integer>");
  expect(plist).toContain("<key>ProcessType</key><string>Interactive</string>");
});
it("backs off repeated configuration failures up to 60 seconds", () => {
  expect([1, 2, 3, 4, 5, 9].map(restartBackoff)).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
});
it("caps stdout and stderr generations and stops the child on SIGTERM", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-supervisor-"));
  const repo = join(root, "repo"), state = join(root, "state");
  mkdirSync(join(repo, "dist"), { recursive: true }); mkdirSync(state);
  writeFileSync(join(repo, "dist/index.js"), `
    process.stdout.write('x'.repeat(3*1024*1024));
    process.stderr.write('e'.repeat(3*1024*1024));
    process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);
  `);
  const controller = new AbortController();
  const running = superviseDesktop(repo, state, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  controller.abort();
  await running;
  for (const name of ["stdout.log", "stderr.log"]) {
    expect(statSync(join(state, name)).size).toBeLessThanOrEqual(DESKTOP_OUTPUT_MAX_BYTES);
    expect(statSync(join(state, `${name}.1`)).size).toBeLessThanOrEqual(DESKTOP_OUTPUT_MAX_BYTES);
  }
});
it("bounds shutdown when the bridge ignores SIGTERM", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-supervisor-stuck-"));
  const repo = join(root, "repo"), state = join(root, "state"), ready = join(root, "ready");
  mkdirSync(join(repo, "dist"), { recursive: true }); mkdirSync(state);
  writeFileSync(join(repo, "dist/index.js"), `
    require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));
    process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
  `);
  const controller = new AbortController();
  const running = superviseDesktop(repo, state, controller.signal);
  try {
    for (let until = Date.now() + 5000; !existsSync(ready) && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(ready)).toBe(true);
    const pid = Number(readFileSync(ready, "utf8"));
    controller.abort();
    await running;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(readFileSync(join(state, "stderr.log"), "utf8")).toContain("SIGKILL");
  } finally { controller.abort(); await running; }
});
