import { describe, expect, it } from "vitest";
import { retainToolUseAliases, nativeToolUseId, requestWithNativeToolIds } from "../../src/protocol/desktop-tool-ids.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import type { MessagesRequest } from "../../src/types.js";

describe("desktop/native tool ID boundary", () => {
  it("translates identities while preserving exact arguments, results, and user text", () => {
    const input = { toolCallId: "call_external_host_id_2", action: "status" };
    const original = assistantMessage("offline", [{ type: "tool_use", id: "toolu_script", name: "WaitForScript", input }], "tool_use");
    const desktopId = "call_0123456789abcdef_0";
    const aliases = { [desktopId]: "toolu_script" };
    const desktopContent = original.content.map((block) => block.type === "tool_use" ? { ...block, id: desktopId } : block);
    const result = [{ type: "text", text: "Exact actual script output." }];
    const request: MessagesRequest = { model: "offline", max_tokens: 1, messages: [
      { role: "assistant", content: desktopContent },
      { role: "user", content: [{ type: "tool_result", tool_use_id: desktopId, content: result }] },
    ] };
    expect(requestWithNativeToolIds(request, aliases).messages).toEqual([
      { role: "assistant", content: original.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_script", content: result }] },
    ]);
    expect(request.messages[0].content).toEqual(desktopContent);
    expect(nativeToolUseId("unpublished", aliases)).toBe("unpublished");
    expect(nativeToolUseId("constructor", aliases)).toBe("constructor");
  });

  it("bounds completed aliases without evicting an outstanding native callback", () => {
    const aliases = Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`call_old_${index}`, `native-${index}`]));
    const retained = retainToolUseAliases({ ...aliases, call_new: "new-native" }, ["native-0", "new-native"]);
    expect(Object.keys(retained)).toHaveLength(1024);
    expect(retained.call_old_0).toBe("native-0");
    expect(retained.call_old_1).toBeUndefined();
    expect(Object.values(retained)).toContain("new-native");
    expect(Object.keys(aliases)).toHaveLength(1024);
  });
});
