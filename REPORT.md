# Relay Bridge 报告

版本：2026-10-15。仓库当前 commit 见 `evidence/g0-install/commit.txt`。未创建 PR（新仓库，按要求提交 `main`）。

## 五个问题（先答）

1. **本次安装的公共 Droid CLI 是否识别 `FACTORY_AIRGAP_ENABLED`？**  
   **是。** `0.241.1` 二进制含该变量名。`FACTORY_AIRGAP_ENABLED=1 droid doctor` 写明 Airgap Mode 禁止 hosted connectivity / authentication / release requests。无自定义模型时 `droid exec` 报：Airgap Mode 已启用，默认模型走 Factory LLM 代理，必须配置 BYOK。证据：`evidence/g0-install/droid-doctor-airgap.txt`、`evidence/g0-controls/no-models-airgap.stderr.txt`、`docs/G0-AIRGAP.md`。

2. **没有 Factory 凭证的干净 HOME 里，普通对话/exec 能否打到本地 BYOK？**  
   **能（本版本 `droid exec -m <customModel>`）。** 隔离 HOME、无 `FACTORY_API_KEY`，请求落到 `POST /v1/messages`，`user-agent: factory-cli/0.241.1`。无自定义模型且无 airgap 时则必须登录。证据：`evidence/g0-2026-10-15T02-20-53-209Z/`、`evidence/g0-controls/no-models-no-airgap.stderr.txt`。

3. **同一条件下 Mission 三个角色能否真正跑起来？**  
   **不能据此宣称三角色完整可用。** `--mission` 发出了 **orchestrator** 初始请求（`X-Bridge-Role: orchestrator`，工具含 `ProposeMission` / `StartMissionRun` / `Task`）。**没有** Worker / Validator 请求。mock 在第一轮返回文本，不会冒充 Mission 控制工具。完整 scrutiny / user-testing / 返工：**未跑真实 Claude**。证据：`evidence/g0-supplemental/result.json`。

4. **有没有 Factory 服务连接尝试？**  
   **未做全流量旁路，不能写成零遥测。** airgap 下 doctor 跳过 hosted 检查；无 airgap 且无模型时出现 Factory 登录失败。覆盖范围：doctor + 本机 Bridge 访问日志。官方 airgap 文档也写明隔离要靠网络策略。

5. **哪些是已获授权的用法，哪些只是观察？**  
   **已按官方安装器安装公共 CLI / Claude Code / SDK，并只用公开接口。** 企业 airgap **构建**由 [S10] 确认，且写明不走公共下载。公开 CLI 上 `FACTORY_AIRGAP_ENABLED=1` **只有本次版本的实验结果**，公开文档未把它等同企业授权。Anthropic 登录/API：**未提供，未使用，未购买。**

## 产品结论（给使用者）

- **普通对话：** mock / protocol 链路可用；Droid 已对本地 Bridge 发 Messages 并执行自己的 `Read`。真实 Claude Code 推理：**不能用**（`BLOCKED_AUTH`）。
- **Mission：** 只能证明 orchestrator **会发出**第一包 BYOK 请求。Worker、Validator、scrutiny、user-testing、返工：**不能用 / 未跑通**。
- **额外 Factory 订阅：** 本轮 mock 与 airgap 实验 **没有**购买、充值或 Extra Usage。完整真实模型仍要用户本人完成官方 Claude 登录或既有授权，不能拿 API 冒充订阅验收。
- **差异：** 无 GUI TUI 验收；无 OS 级双用户隔离；`tool_choice` / 精确 token / signed thinking 未映射；公开 airgap 旗标 ≠ 企业构建授权。

## 分项状态

| 项 | 状态 | 证据 |
|---|---|---|
| Linux 环境 | **PASS** | `evidence/g0-install/uname.txt`，Ubuntu x64 |
| 安装 Droid / Claude Code | **PASS** | Droid 0.241.1，Claude 2.1.292；`evidence/g0-install/` |
| 公共 CLI airgap 无 Factory 登录（识别变量） | **PASS** | `droid-doctor-airgap.txt`，controls |
| 公共 CLI airgap + BYOK 普通 exec | **PASS** | G0 A1，localhost `/v1/messages` |
| 公共 CLI 无 airgap 无模型（认证门） | **PASS** | `no-models-no-airgap.stderr.txt` |
| 错误本地令牌走 BYOK | **PASS** | A2 → HTTP 401，无 session |
| 只读工具往返（Droid 执行 Read） | **PASS** | supplemental A3b canary `RELAY_CANARY_G0FIXED` |
| 公共 CLI airgap Mission 初始请求 | **PASS** | A4 / supplemental，orchestrator 1 次 |
| 公共 CLI airgap Mission 三角色完整 | **FAIL** | 未观测到 worker/validator 请求 |
| 官方 Claude Code 认证 | **BLOCKED_AUTH** | 未提供登录；doctor 未读 token |
| SDK 单工具跨请求接力（fake runtime） | **PASS** | `tests/sdk-probes/cross-request-relay.test.ts`（22 测全过） |
| SDK 单工具跨请求接力（真 Claude） | **BLOCKED_AUTH** | `npm run test:e2e:chat` 退出码 2 |
| 普通对话 C01–C10 真实验收 | **BLOCKED_AUTH** | 无 Claude；TUI 未测 |
| Orchestrator 真实链 | **BLOCKED_AUTH** | 仅 mock 初始包 |
| Worker 真实链 | **BLOCKED_AUTH** | 无请求 |
| Validator / scrutiny | **BLOCKED_AUTH** | 无请求 |
| Validator / user-testing | **BLOCKED_AUTH** | 无请求 |
| 完整 Mission Tiny Tasks | **BLOCKED_AUTH** | 夹具自测通过，Mission 未代写验收 |
| 发现失败 → 返工 → 再验证 | **NOT_RUN** | 需要真实 Mission |
| 并发与取消（进程内） | **PASS** | `tests/sdk-probes` + `tests/resilience` |
| 重启/历史恢复（真实 SDK） | **NOT_RUN** | 仅有 JSONL 骨架 |
| 订阅认证路径 | **BLOCKED_AUTH** | |
| API 认证路径 | **BLOCKED_AUTH** | 禁止自动花付费 API |
| Factory 授权依据 | **UNSUPPORTED_OBSERVED**（公开旗标） / 文档仅企业构建 | `docs/AUTH-AND-AIRGAP.md` |
| Anthropic 授权依据 | **BLOCKED_AUTH** | 用户未登录 |
| unit / protocol / fake / resilience | **PASS** | `npx vitest run` 22/22 |
| Tiny Tasks 夹具验收点 | **PASS** | `fixtures/tiny-tasks` 6/6 |
| Playwright 浏览器套件 | **NOT_RUN** | 断言清单已锁定，未装浏览器跑 GUI |
| `npm run test:e2e:chat` | **BLOCKED_AUTH** | 退出码 2 |
| `npm run test:e2e:mission` | **BLOCKED_AUTH** | 退出码 2 |
| 网络零遥测 | **NOT_RUN** | 无完整 egress 捕获 |

## 实现说明（短）

Relay Bridge 监听 `127.0.0.1:18787`，提供 `GET /healthz` 与 `POST /v1/messages`（JSON/SSE）。`mock` 零模型费用；`fake` 证明 mailbox 在返回 `tool_use` 后仍等待第二次 HTTP 的 `tool_result`；`sdk` 对接官方 `@anthropic-ai/claude-agent-sdk@0.3.300`，`tools: []`，只注册 Droid 当前工具对应的 MCP，回调只转交。未修改 Droid / Claude 二进制。

## 最少启动命令

```bash
npm install
export BRIDGE_MODE=mock
export BRIDGE_CLIENT_TOKEN="$(openssl rand -hex 24)"
npm start
# 另一个隔离 HOME：
tsx scripts/configure-droid.ts --home /tmp/droid-home --base-url http://127.0.0.1:18787
FACTORY_AIRGAP_ENABLED=1 HOME=/tmp/droid-home BRIDGE_CLIENT_TOKEN=$BRIDGE_CLIENT_TOKEN \
  droid exec -m relay-probe "RELAY_TEXT_PROBE"
```

真实 Claude：由用户本人用官方 `claude` 登录后设 `BRIDGE_MODE=sdk`。不要把密钥提交进仓库。
