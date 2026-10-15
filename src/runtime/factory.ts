import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { FakeRuntime } from "./fake-runtime.js";
import { MockRuntime } from "./mock-runtime.js";
import { SdkRuntime } from "./sdk-runtime.js";
import type { BridgeRuntime } from "./types.js";

export function createRuntime(config: BridgeConfig, logger: Logger, canaryPath: string): BridgeRuntime {
  if (config.mode === "mock") return new MockRuntime(canaryPath);
  if (config.mode === "fake") return new FakeRuntime();
  return new SdkRuntime(config, logger);
}
