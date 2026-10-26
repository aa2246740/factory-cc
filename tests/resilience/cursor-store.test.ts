import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("prunes one real SQLite agent's runs/events/checkpoints and preserves its neighbor", async () => {
  // The shipped CJS boundary is the one used by production sdk-load.ts.
  const sqlite = createRequire(import.meta.url)("@cursor/sdk/sqlite") as typeof import("@cursor/sdk/sqlite");
  const root = mkdtempSync(join(tmpdir(), "relay-cursor-sqlite-"));
  const store = await sqlite.SqliteLocalAgentStore.open({ workspaceRef: root, stateRoot: join(root, "store") });
  try {
    for (const agentId of ["expired", "retained"]) await store.agents.create({ agent: { agentId, cwd: root, status: "idle", createdAt: 1, updatedAt: 1 } });
    await store.runs.create({ run: { runId: "run-expired", agentId: "expired", turnNumber: 1, status: "finished", createdAt: 1, updatedAt: 1 } });
    await store.runEvents.append({ runId: "run-expired", eventType: "turn-ended", payload: { done: true } });
    const blobId = "0".repeat(64);
    await store.checkpoints.create({ agentId: "expired", blobId, data: new Uint8Array([1, 2, 3]) });
    expect((await store.runEvents.list({ runId: "run-expired" })).items).toHaveLength(1);
    await store.agents.delete({ filter: { agentIds: ["expired"] } });
    expect(await store.agents.get({ agentId: "expired" })).toBeNull();
    expect((await store.agents.get({ agentId: "retained" }))?.agentId).toBe("retained");
    expect((await store.runs.list({ filter: { agentIds: ["expired"] } })).items).toHaveLength(0);
    expect((await store.runEvents.list({ runId: "run-expired" })).items).toHaveLength(0);
    expect(await store.checkpoints.get({ agentId: "expired", blobId })).toBeNull();
  } finally { await store.dispose(); }
});
