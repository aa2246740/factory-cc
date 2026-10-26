import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { OwnedProcesses, processTable } from "../../src/runtime/owned-processes.js";

const pools: OwnedProcesses[] = [];
const extras: ChildProcess[] = [];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  for (const child of extras.splice(0)) { child.kill("SIGKILL"); await once(child, "exit"); }
});
function pool() {
  const owned = new OwnedProcesses(logger, { graceMs: 250, termMs: 200, killMs: 1000 }, 50);
  pools.push(owned); return owned;
}
function start(owned: OwnedProcesses, owner: string, script: string) {
  return owned.spawn(owner, { command: process.execPath, args: ["-e", script], env: process.env });
}

it("verifies a cooperative child exits after stdin EOF", async () => {
  const owned = pool();
  const child = start(owned, "graceful", "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); console.log('ready');");
  await once(child.stdout!, "data");
  await owned.stop("graceful");
  expect(child.exitCode).toBe(0);
  expect(owned.size).toBe(0);
  expect(logger.warn.mock.calls.some(([event, data]) => event === "sdk_process_signal" && data.owner === "graceful")).toBe(false);
});

it("kills a TERM-resistant process tree, including descendants after root exit", async () => {
  const owned = pool();
  const child = start(owned, "tree", `
    const {spawn}=require('node:child_process');
    const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready')"],{stdio:['ignore','pipe','ignore']});
    c.stdout.once('data',()=>console.log(c.pid));
    process.stdin.resume();
    process.on('SIGTERM',()=>process.exit(0));
  `);
  const [raw] = await once(child.stdout!, "data");
  const descendant = Number(String(raw).trim());
  expect(descendant).toBeGreaterThan(1);
  await owned.scan();
  await owned.stop("tree");
  const rows = await processTable();
  expect(rows.get(descendant)?.state.startsWith("Z") ?? true).toBe(true);
  expect(owned.describe()).toMatchObject({ ownedTrees: 0, liveProcesses: 0 });
  expect(logger.warn).toHaveBeenCalledWith("sdk_process_signal", expect.objectContaining({ owner: "tree", signal: "SIGKILL" }));
});

it("reaps an unowned registered tree and never signals a foreign sibling", async () => {
  const foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1000); console.log('ready')"], { stdio: ["ignore", "pipe", "ignore"] });
  extras.push(foreign);
  await once(foreign.stdout!, "data");
  const owned = pool();
  const child = start(owned, "orphan", "setInterval(()=>{},1000); console.log('ready');");
  await once(child.stdout!, "data");
  await owned.reap(new Set());
  expect(owned.describe()).toMatchObject({ ownedTrees: 0, reaperKills: 1 });
  expect(foreign.exitCode).toBeNull();
  expect((await processTable()).has(foreign.pid!)).toBe(true);
});

it("keeps a live owner's tree and makes concurrent stop idempotent", async () => {
  const owned = pool();
  const child = start(owned, "owned", "setInterval(()=>{},1000); console.log('ready');");
  await once(child.stdout!, "data");
  await owned.reap(new Set(["owned"]));
  expect(owned.size).toBe(1);
  await Promise.all([owned.stop("owned"), owned.stop("owned"), owned.close()]);
  expect(child.signalCode).toBe("SIGTERM");
  expect(owned.size).toBe(0);
  await sleep(5);
});
