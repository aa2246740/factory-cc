import { factoryHookFailureMessage, factoryHookMain } from "../src/control/factory-hooks.js";

factoryHookMain().catch((error: unknown) => {
  // Hook input, HTTP response bodies, and private configuration may contain
  // credentials or tool output. Only a fixed error reaches Factory's transcript.
  process.stderr.write(`${factoryHookFailureMessage(error)}\n`);
  process.exitCode = 1;
});
