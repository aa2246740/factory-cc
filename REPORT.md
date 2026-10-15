# Relay Bridge 报告（T3 对齐）

版本：2026-10-15。提交在 `main`。未创建 PR。未改 Droid / Claude Code 二进制。未打印、未提交密钥。`.cursor/CLOUD.md` 与 hooks 仍为 Grok-only。

本轮按 Cola 决定：**按 T3 Code 方式重做 Relay Bridge**（最稳、最不像套壳），再用 MiniMax-M2.5（GLM 回退未触发）无短超时重跑全部测试 + Tiny Tasks Mission e2e。

上游：

- **provider:** MiniMax China Anthropic-compatible
- **baseUrl:** `https://api.minimaxi.com/anthropic`
- **model:** `MiniMax-M2.5`
- **tokenEnv:** `MINIMAXCN_API_KEY`（只记变量名）
- GLM / OpenRouter：**未使用**（MiniMax 全程可用）

## 原先怎么设 system prompt 和 tools（改之前）

`SdkRuntime.startQuery` **整段替换**系统提示，并 **关掉** Claude Code 内置工具：

- `systemPrompt: { type: "custom", prompt: buildSystemPrompt(...) }`：完整覆盖，不用 `claude_code` 预设。
- 自定义正文以 “You are running inside Relay Bridge” / “Claude Code built-in file tools are disabled.” 开头；Droid 的 `system`、角色、Mission 附录都塞进同一段（动态前缀，缓存差）。
- `tools: []`：去掉 Read / Edit / Bash / Grep / Glob。Droid 每个工具都注册成 MCP，停在 mailbox。Claude Code **自己不执行**文件/shell。
- `includePartialMessages: false`：HTTP SSE 等整包结束后一次倒出。
- `canUseTool` 恒 `allow`。
- `sdkEnv` **总是**改写 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`，并清空 `ANTHROPIC_API_KEY`。

## 现在怎么设（对齐 T3）

| 杠杆 | 行为 |
|---|---|
| System prompt | `{ type: "preset", preset: "claude_code", append: STABLE_DROID_APPEND, snapshot: true, excludeDynamicSections: true }`。角色 / 用户 / Droid `system` / 工作区路径放在 **user prompt 末尾**。 |
| Tools | `{ type: "preset", preset: "claude_code" }`。Read/Edit/Write/Bash/Glob/Grep 由 **未修改的 Claude Code 自己执行**。`allowedTools` 含全部内置名 + Droid MCP。 |
| Droid 工具共存 | 进程内 MCP `droid` **只暴露** Factory 专有名：`StartMissionRun`、`ProposeMission`、`EndFeatureRun`、`DismissHandoffItems`、`TaskOutput`、`TaskStop`。Droid 的 Read/Execute/Create 等视为已被 Claude 覆盖，不注册 MCP。 |
| Droid UI | 内置调用以实时文本痕迹 `[Read] path` / `[Bash] …` 出现在 SSE 里。**绝不**把内置调用回写成 Droid `tool_use`（会让 Droid 再跑一遍并卡死 mailbox）。专有工具仍回原生 `tool_use`，由 Droid 执行。 |
| 权限 | `BRIDGE_PERMISSION=ask` 时 `canUseTool` 把 Bash→Execute、Write→Create/Edit 回传给 Droid。BYOK e2e 用 `bypass`（SDK 会提示 `canUseTool` 被 `bypassPermissions` 阴影掉，属预期）。 |
| 流式 | `includePartialMessages: true`；token delta 以 Anthropic `content_block_delta` 边生成边推给 Droid。 |
| 鉴权 | `BRIDGE_AUTH=subscription` **不设置、不覆盖** `ANTHROPIC_BASE_URL` / `AUTH_TOKEN` / `API_KEY`（Cola 本机登录）。默认 `byok` 仍注入 MiniMax/GLM。 |
| 缓存 | 稳定 append 固定在前。动态内容在 user 末尾。每条 SDK usage 记 `cache_creation_input_tokens`、`cache_read_input_tokens`。 |
| Factory 账本 | `PostToolUse`（Write/Edit/Bash）在 hook **运行时**查找 mission 目录，把带 `assertions` 的 `validation-state.json`（以及合法 `features.json`）拷进 Factory mission 目录。避免 Claude Code 写到 cwd / 过期 `/tmp` 后 Droid 读不到。 |

详见 `docs/T3-ALIGNMENT.md`。

## 本轮 Mission e2e（T3 路径，无短超时）

- **结果：PASS**（非 Claude 模型）
- **时长：** 306 秒
- **HTTP 请求：** 17（内置工具不再打回 Droid；上一版非 T3 长跑是 118 次）
- **角色：** orchestrator + worker + validator
- **Droid 退出码：** 0；stdout 含 `[Read]/[Edit]/[Write]/[Glob]` 痕迹与 Mission complete
- **校验：** VAL-FILTER-001 / VAL-COUNTS-001 均为 passed（写在 Factory mission 目录）
- **特性：** fix-completed-filter-defect、scrutiny-validator-fix-defect、user-testing-validator-fix-defect 均为 completed
- **验收：** `npm test` 6/6
- **missionState：** completed
- 证据：`evidence/e2e-mission.json`、`evidence/e2e-mission-2026-10-15T05-22-07-808Z/`

首次 T3 重跑（修复同步前）曾 FAIL：三角色与验收已绿，但 validator 把带 assertions 的 `validation-state.json` 写到上一轮残留 `/tmp/relay-e2e-ws-…`，mission 目录仍是 pending。随后改为 hook 运行时查找目录 + 工作区附录放在 prompt 末尾。第二次无超时重跑 PASS。失败现场：`evidence/e2e-mission-2026-10-15T05-10-21-323Z/`。

## 缓存数字（MiniMax，**不能代表 Claude**）

本轮 PASS 的 `usage.jsonl` 汇总：

| 字段 | 数值 |
|---|---|
| input_tokens | 1_788_772 |
| output_tokens | 64_422 |
| cache_creation_input_tokens | 49_331 |
| cache_read_input_tokens | 2_497_868 |
| cache_hit_ratio | **0.5761**（cache_read / (input + cache_create + cache_read)） |
| usage 行数 | 269 |
| representativeOfClaude | **false** |

首次 T3 FAIL 那次（411s / 23 HTTP）hit_ratio 0.5439，同样 **不是** Claude prompt cache。MiniMax 兼容字段有值，只能说明 Bridge 已按请求记账；Cola 本机订阅路径上的命中率要以 Claude 为准。

## 五个问题（沿用）

1. **公共 Droid CLI 是否识别 `FACTORY_AIRGAP_ENABLED`？**  
   **是。** `0.241.1` 二进制含该变量。airgap 下 doctor 禁止 hosted 连接。证据：`docs/G0-AIRGAP.md`。

2. **干净 HOME 里普通对话/exec 能否打到本地 BYOK？**  
   **能。** 隔离 HOME、无 `FACTORY_API_KEY`，`droid exec -m relay-chat` 落到本机 `POST /v1/messages`，再经 Bridge 打 MiniMax。

3. **Mission 三个角色能否真正跑起来？**  
   **能（T3 路径，非 Claude 模型）。** `StartMissionRun` 仍是阻塞 runner，文件齐了才拉 Worker/Validator。T3 之后文件由 Claude Code 自己写；Bridge 只在文件齐时合成 `StartMissionRun`，并把 Factory 账本同步回 mission 目录。306 秒、17 次 HTTP、校验与三特性全绿。

4. **有没有 Factory 服务连接尝试？**  
   **未做全流量旁路，不能写成零遥测。**

5. **哪些是已获授权的用法？**  
   公开安装器 + 公开 Messages / Agent SDK。官方 Claude 登录/API：**未使用。** MiniMax 是 Runtime Secrets 的兼容端点。

## 分项状态

| 项 | 状态 | 证据 |
|---|---|---|
| Linux 环境 | **PASS** | Ubuntu x64 |
| 安装 Droid / Claude Code | **PASS** | Droid 0.241.1，Claude 2.1.292 |
| MiniMax 小工具调用探针 | **PASS**（非 Claude） | `evidence/upstream-probe.json` |
| GLM 回退探针 | **NOT_RUN** | MiniMax 已成功 |
| OpenRouter 免费回退 | **NOT_RUN** | MiniMax 已成功 |
| 公共 CLI airgap + BYOK exec | **PASS** | G0 A1 |
| 错误本地令牌 | **PASS** | A2 → 401 |
| 只读工具往返 | **PASS** | supplemental A3b |
| unit / protocol / fake / resilience / sdk-probes | **PASS** | `npx vitest run` **41/41** |
| Tiny Tasks 夹具自测 | **PASS** | `fixtures/tiny-tasks` 6/6 |
| 普通对话 e2e（Droid → Bridge → MiniMax） | **PASS**（非 Claude） | `evidence/e2e-chat.json`，1 次请求，stdout `RELAY_CHAT_OK`，退出码 0 |
| Mission 三角色 e2e（T3 + MiniMax，无短超时） | **PASS**（非 Claude） | 17 请求 / 306s / 校验全绿 / 三特性 completed |
| Mission 代写 Tiny Tasks 至验收全绿 | **PASS**（非 Claude） | 验收 6/6；stdout 含 Claude Code 工具痕迹 |
| 发现失败 → 返工 → 再验证 | **PASS**（非 Claude） | scrutiny + user-testing completed |
| 官方 Claude 认证 / 账单 | **BLOCKED_AUTH** | 未登录，未使用 |
| Playwright GUI | **NOT_RUN** | |
| 网络零遥测 | **NOT_RUN** | |
| Factory 授权依据 | **UNSUPPORTED_OBSERVED** | 公开 airgap 旗标 |
| Anthropic 授权依据 | **BLOCKED_AUTH** | 官方 Claude 未用 |

## 仍与 T3 不同的地方

- Relay Bridge 仍是 Droid 前面的 Anthropic Messages 代理，不是 T3 自己的 UI。
- Mission 在文件齐后仍会 **合成** `StartMissionRun`（Factory 阻塞 runner 需要）。
- 云上测试是 MiniMax-M2.5 BYOK，不是 Claude 订阅。缓存命中率 **不能代表 Claude**。
- BYOK 仍隔离 `CLAUDE_CONFIG_DIR`；`subscription` 不隔离、不改 `ANTHROPIC_*`。
- 不在 exclusive 列表里的 Droid 插件不会变成 MCP。
- Token 计数仍 HTTP 501。
- e2e 的 `bypassPermissions` 下 `canUseTool` 不会被调用（SDK 警告 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`）。Cola 本机 `BRIDGE_AUTH=subscription` 默认 `ask`，那时才会把写/shell 审批回传 Droid。
- Factory `validation-state.json` 同步是 Bridge 侧账本，不是 T3 功能。

## 最少启动命令

```bash
npm install
npx tsx scripts/probe-upstream.ts
export BRIDGE_MODE=sdk
export BRIDGE_AUTH=byok          # 云测；本机 Claude 登录用 subscription
export BRIDGE_CLIENT_TOKEN="$(openssl rand -hex 24)"
npm start
tsx scripts/configure-droid.ts --home /tmp/droid-home --base-url http://127.0.0.1:18787
FACTORY_AIRGAP_ENABLED=1 HOME=/tmp/droid-home BRIDGE_CLIENT_TOKEN=$BRIDGE_CLIENT_TOKEN \
  droid exec -m relay-chat --auto high "Reply with RELAY_CHAT_OK"
```

不要把密钥提交进仓库。不要把 `ANTHROPIC_BASE_URL` 指回 Bridge。
