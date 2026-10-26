import { once } from "node:events";
import { ChildProcess } from "node:child_process";
import type { SdkHandle, SdkUserInput } from "../../src/runtime/sdk-runtime.js";

/** Fake protocol, real OS child; close intentionally does not terminate it. */
export class ProcessSdk implements SdkHandle {
  cooperative = false;
  retainHistory = true;
  readonly spawnedPids: number[] = [];
  readonly children: ChildProcess[] = [];
  readonly options: Record<string, unknown>[] = [];
  readonly handlers = new Map<string, (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>>();
  account: "ok" | "timeout" | "rejected" = "ok";
  mode: "success" | "hang" | "error" | "retry" | "tool" = "success";
  error = "API Error: Request rejected (429) rate_limit_error retry-after: 7";
  result = "ok";
  failAfterTool = false;
  retryWhileTool = false;
  hostToolInvocations = 0;
  readonly inputs: SdkUserInput[] = [];
  closeCalls = 0;
  accountCalls = 0;

  tool() { return {}; }
  createSdkMcpServer(options: Record<string, unknown>): unknown {
    return { ...options, instance: {
      isConnected: () => false, sendToolListChanged() {},
      server: { setRequestHandler() {}, async sendToolListChanged() {} },
      registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>) => {
        this.handlers.set(name, handler);
        return { update() {}, remove: () => this.handlers.delete(name) };
      },
    } };
  }
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }) {
    this.options.push(args.options);
    const hook = args.options.spawnClaudeCodeProcess;
    if (typeof hook !== "function") throw new Error("Missing owned spawn hook");
    const script = `process.stdin.resume(); ${this.cooperative ? "process.stdin.on('end',()=>process.exit(0));" : ""} setInterval(()=>{},1000); console.log('ready')`;
    const child: unknown = hook({ command: process.execPath, args: ["-e", script], env: process.env, signal: new AbortController().signal });
    if (!(child instanceof ChildProcess)) throw new Error("Expected a real child process");
    this.children.push(child);
    this.spawnedPids.push(child.pid!);
    if (!this.retainHistory) { this.children.splice(0, Math.max(0, this.children.length - 4)); this.options.splice(0, Math.max(0, this.options.length - 4)); }
    const ready = once(child.stdout!, "data");
    const self = this;
    const mode = this.mode;
    const nativeId = typeof args.options.resume === "string" ? args.options.resume : `native-${this.spawnedPids.length}`;
    return {
      close() { self.closeCalls++; },
      async accountInfo() {
        self.accountCalls++;
        await ready;
        if (self.account === "timeout") return new Promise<Record<string, unknown>>(() => undefined);
        return self.account === "rejected" ? { apiKeySource: "ANTHROPIC_API_KEY" } : { subscriptionType: "max" };
      },
      async *[Symbol.asyncIterator]() {
        await ready;
        for await (const input of args.prompt) {
          self.inputs.push(input);
          if (!self.retainHistory) self.inputs.splice(0, Math.max(0, self.inputs.length - 4));
          yield { type: "system", subtype: "init", session_id: nativeId };
          if (mode === "hang") { await once(child, "exit"); return; }
          if (mode === "retry") { yield { type: "system", subtype: "api_retry", error_status: 529, attempt: 1, max_retries: 10, retry_delay_ms: 2500, session_id: nativeId }; await once(child, "exit"); return; }
          if (mode === "error") { yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [self.error], session_id: nativeId }; continue; }
          if (mode === "tool") {
            const name = [...self.handlers.keys()][0]!;
            const id = `tool-${child.pid}`;
            yield { type: "assistant", session_id: nativeId, message: { id: `message-${child.pid}`, content: [{ type: "tool_use", id, name: `mcp__droid__${name}`, input: {} }] } };
            self.hostToolInvocations++;
            const result = self.handlers.get(name)!({}, { toolUseId: id });
            if (self.retryWhileTool) yield { type: "system", subtype: "api_retry", error_status: 529, attempt: 1, max_retries: 10, retry_delay_ms: 2500, session_id: nativeId };
            await result;
            if (self.failAfterTool) { yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [self.error], session_id: nativeId }; continue; }
          }
          yield { type: "result", subtype: "success", is_error: false, result: self.result, session_id: nativeId };
        }
      },
    };
  }
}
