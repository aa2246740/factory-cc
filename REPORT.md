# Relay Bridge 报告

版本：2026-10-15。提交在 `main`。未创建 PR。

本轮按 Cola 决定走 **BYOK 非 Claude 模型**（不使用官方 Claude 登录/账单）。上游探测与 e2e 使用的提供商/模型：

- **provider:** MiniMax China Anthropic-compatible
- **baseUrl:** `https://api.minimaxi.com/anthropic`
- **model:** `MiniMax-M2.5`
- **tokenEnv:** `MINIMAXCN_API_KEY`（只记录环境变量名，不写密钥）
- Claude Code 注入：`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，`ANTHROPIC_API_KEY` 为空；全部模型槽位指向 `MiniMax-M2.5`
- GLM / OpenRouter 未使用（MiniMax 工具调用探针一次通过）

## 五个问题（先答）

1. **本次安装的公共 Droid CLI 是否识别 `FACTORY_AIRGAP_ENABLED`？**  
   **是。** `0.241.1` 二进制含该变量名。`FACTORY_AIRGAP_ENABLED=1 droid doctor` 写明 Airgap Mode 禁止 hosted connectivity / authentication / release requests。无自定义模型时 `droid exec` 报：必须配置 BYOK。证据：`evidence/g0-install/`、`docs/G0-AIRGAP.md`。

2. **没有 Factory 凭证的干净 HOME 里，普通对话/exec 能否打到本地 BYOK？**  
   **能。** 隔离 HOME、无 `FACTORY_API_KEY`，`droid exec -m relay-chat` 请求落到本机 `POST /v1/messages`。本轮 sdk 模式再经 Bridge 打到 MiniMax。证据：G0 A1；`evidence/e2e-chat.json`。

3. **同一条件下 Mission 三个角色能否真正跑起来？**  
   **能（非 Claude 模型，经 Bridge）。** 根因不是“第一包必须立刻 StartMissionRun”，而是 Droid 的 `StartMissionRun` 是**阻塞式 runner**：必须先有合法 `features.json`、校验合同、`AGENTS.md`、`services.yaml`，以及带 YAML `name`/`description` 的 `skills/<skill>/SKILL.md`。满足后 Bridge 返回原生 `StartMissionRun`，公共 Droid 会拉起 Worker 与 Validator。本轮观测到 `orchestrator` + `worker` + `validator` 共 109 次 `/v1/messages`。证据：`evidence/e2e-mission.json`。

4. **有没有 Factory 服务连接尝试？**  
   **未做全流量旁路，不能写成零遥测。** airgap 下 doctor 跳过 hosted 检查。官方 airgap 文档也写明隔离要靠网络策略。

5. **哪些是已获授权的用法，哪些只是观察？**  
   **已按官方安装器安装公共 CLI / Claude Code / SDK，并用公开 Messages / Agent SDK 接口。** 企业 airgap **构建**仍只在官方文档里。公开 CLI 上 `FACTORY_AIRGAP_ENABLED=1` 仍是本版本观察。官方 Claude 登录/API：**未使用。** MiniMax BYOK 是 Runtime Secrets 提供的兼容端点。

## 产品结论

- **普通对话：** mock / protocol 可用；**sdk + MiniMax-M2.5** 的 Droid exec 已跑通（非 Claude 模型 PASS）。
- **Mission：** 三角色请求已经 Bridge 出现（非 Claude 模型 PASS）。Droid 进程在约 8 分钟超时后被结束（退出码 143），不宣称 Tiny Tasks 验收已被 Mission 完整代写完毕。
- **未购买、未充值、未开官方 Claude 账单。** 未回退到 Factory 托管模型。
- **Grok-only 规则保持：** `.cursor/CLOUD.md` 与 hooks 未改。

## 分项状态

| 项 | 状态 | 证据 |
|---|---|---|
| Linux 环境 | **PASS** | Ubuntu x64 |
| 安装 Droid / Claude Code | **PASS** | Droid 0.241.1，Claude 2.1.292 |
| MiniMax 小工具调用探针 | **PASS**（非 Claude） | `evidence/upstream-probe.json`，`stop_reason=tool_use`，`relay_probe` |
| GLM 回退探针 | **NOT_RUN** | MiniMax 已成功 |
| OpenRouter 免费回退 | **NOT_RUN** | MiniMax 已成功 |
| 公共 CLI airgap + BYOK exec | **PASS** | G0 A1 |
| 错误本地令牌 | **PASS** | A2 → 401 |
| 只读工具往返 | **PASS** | supplemental A3b |
| 普通对话 e2e（Droid → Bridge → MiniMax） | **PASS**（非 Claude） | `evidence/e2e-chat.json`，2 次 chat 请求，退出码 0 |
| Mission 三角色 e2e（Droid → Bridge → MiniMax） | **PASS**（非 Claude） | `evidence/e2e-mission.json`，orchestrator/worker/validator，109 请求 |
| 官方 Claude 认证 / 账单 | **BLOCKED_AUTH** | 未登录，未使用 |
| SDK 跨请求接力（fake） | **PASS** | `tests/sdk-probes` |
| unit / protocol / fake / resilience | **PASS** | `npx vitest run` 28/28 |
| Tiny Tasks 夹具自测 | **PASS** | `fixtures/tiny-tasks` 6/6 |
| Mission 代写 Tiny Tasks 至验收全绿 | **NOT_RUN** | 三角色已出现；exec 超时 143，未等 runner 收尾 |
| 发现失败 → 返工 → 再验证 | **NOT_RUN** | 需要完整 runner 收尾 |
| Playwright GUI | **NOT_RUN** | |
| 网络零遥测 | **NOT_RUN** | |
| Factory 授权依据 | **UNSUPPORTED_OBSERVED** | 公开 airgap 旗标 |
| Anthropic 授权依据 | **BLOCKED_AUTH** | 官方 Claude 未用 |

## 根因（Mission Worker/Validator 从不启动）

1. 第一包若只回纯文本，Droid 不会调用 `StartMissionRun`（G0 mock）。
2. 第一包若过早合成 `StartMissionRun`，Droid 返回错误：`features.json must exist with at least one feature`。
3. `StartMissionRun` 是阻塞调用：文件齐了才会按序拉起 Worker，并在 handoff / 暂停 / 全部完成后才把 `tool_result` 还给编排器。
4. `SKILL.md` 必须有 YAML `name` 与 `description`，否则 `worker skills are not ready`。
5. SDK 若在返回 `tool_use` 后丢掉 query 迭代器，后续编排会卡死；现已后台保活。

## 最少启动命令

```bash
npm install
npx tsx scripts/probe-upstream.ts
export BRIDGE_MODE=sdk
export BRIDGE_CLIENT_TOKEN="$(openssl rand -hex 24)"
npm start
tsx scripts/configure-droid.ts --home /tmp/droid-home --base-url http://127.0.0.1:18787
FACTORY_AIRGAP_ENABLED=1 HOME=/tmp/droid-home BRIDGE_CLIENT_TOKEN=$BRIDGE_CLIENT_TOKEN \
  droid exec -m relay-chat --auto high "Reply with RELAY_CHAT_OK"
```

不要把密钥提交进仓库。不要把 `ANTHROPIC_BASE_URL` 指回 Bridge。
