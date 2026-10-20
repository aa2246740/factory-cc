import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { CursorSdkRuntime } from "./cursor/sdk-runtime.js";
import { FakeRuntime } from "./fake-runtime.js";
import { MockRuntime } from "./mock-runtime.js";
import { RouterRuntime } from "./router-runtime.js";
import { SdkRuntime } from "./sdk-runtime.js";
import type { BridgeRuntime } from "./types.js";

export function createRuntime(config: BridgeConfig, logger: Logger, canaryPath: string): BridgeRuntime {
  if (config.mode === "mock") return new MockRuntime(canaryPath);
  if (config.mode === "fake") return new FakeRuntime();
  const claude = new SdkRuntime(config, logger);
  const cursorModels = (config.models ?? []).filter((model) => model.provider === "cursor");
  if (!cursorModels.length) return claude;
  return new RouterRuntime(claude, new CursorSdkRuntime(config, logger));
}
