import { factoryHookMain } from "../src/control/factory-hooks.js";

factoryHookMain().catch(() => {
  // Hook input, HTTP response bodies, and private configuration may contain
  // credentials or tool output. Only a fixed error reaches Factory's transcript.
  process.stderr.write("Factory lifecycle bridge unavailable; event delivery failed.\n");
  process.exitCode = 1;
});
