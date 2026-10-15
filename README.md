# Relay Bridge

把 Factory Droid CLI 的 BYOK 自定义模型接到**官方 Claude Agent SDK** 和**未修改的 Claude Code**。Droid 继续负责任务、审批和工具执行；模型推理在 Claude Code 里发生。

没有 Factory 凭证。默认 `BRIDGE_AUTH=byok`：`sdk` 把 Claude Code 指到 MiniMax / GLM 的 Anthropic 兼容端点（会改写 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，`ANTHROPIC_API_KEY` 为空）。`BRIDGE_AUTH=subscription` 不改写这三个变量，供本机 Claude 登录使用。`mock` / `fake` 协议测试可跑。

接入方式对齐 T3 Code：`systemPrompt` 用 `claude_code` 预设再追加 Droid 说明；Claude Code 自己执行内置工具；只有 Mission 等 Droid 专有工具走 MCP。见 `docs/T3-ALIGNMENT.md`。

## 能做什么

- `POST /v1/messages`：Anthropic Messages JSON 与 SSE
- 原生 `tool_use` / `tool_result` 跨 HTTP 请求接力（先结束本次响应，SDK 回调继续等）
- Claude Code 内置 Read/Edit/Bash 自己执行；只有 Mission 等 Droid 专有工具按当前请求注册为 MCP
- 干净 HOME 下探测 `FACTORY_AIRGAP_ENABLED=1`
- Tiny Tasks 验收夹具（参考实现，不是 Mission 产物）

## 运行

```bash
npm install
export BRIDGE_MODE=mock
export BRIDGE_CLIENT_TOKEN="$(openssl rand -hex 24)"
npm start
```

默认监听 `http://127.0.0.1:18787`。`GET /healthz` 探活，不要用 `/v1/models`。

给隔离的 Droid HOME 写入自定义模型（不改你原来的 `~/.factory`）：

```bash
tsx scripts/configure-droid.ts --home /tmp/droid-home --base-url http://127.0.0.1:18787
FACTORY_AIRGAP_ENABLED=1 HOME=/tmp/droid-home BRIDGE_CLIENT_TOKEN=$BRIDGE_CLIENT_TOKEN \
  droid exec -m relay-probe "RELAY_TEXT_PROBE"
```

撤销配置：

```bash
tsx scripts/configure-droid.ts --settings /tmp/droid-home/.factory/settings.json --revert
```

## 测试

| 命令 | 含义 | 无凭证时 |
|---|---|---|
| `npm test` | unit + protocol + fake SDK + resilience + T3 prompt/tools/auth/usage | 应通过 |
| `npm run test:protocol` | Messages / SSE / 401 | 应通过 |
| `npm run test:sdk-probes` | 跨请求工具接力 | 应通过（fake runtime） |
| `npm run test:g0` | 公共 CLI airgap 矩阵 | 记录真实退出码 |
| `npm run probe:upstream` | MiniMax → GLM → OpenRouter 工具调用探针 | 需 BYOK 密钥 |
| `npm run test:e2e:chat` | 经 Bridge 的 Droid 普通对话 | MiniMax-M2.5 已 PASS |
| `npm run test:e2e:mission` | Mission 三角色 + Tiny Tasks 验收全绿 | MiniMax-M2.5 已 PASS（484s / 118 请求，无短超时） |
| `npm run test:resilience` | 重试 / 取消 / 图片 | 应通过 |
| `npm run doctor` | 脱敏诊断 | 应通过 |
| `npm run evidence:pack` | SHA-256 清单 | 应通过 |
| `npm run tiny-tasks:test` | 夹具验收点 | 应通过 |

真实 SDK 探针在登录完成后才会跑。禁止把未跑的测试标绿。

## 模式

- `BRIDGE_MODE=mock`：固定文本/只读工具探针，零模型费用
- `BRIDGE_MODE=fake`：进程内 query 替身，证明邮箱接力
- `BRIDGE_MODE=sdk`：官方 SDK + 已安装 `claude`。`BRIDGE_AUTH=byok` 用 MiniMax/GLM 兼容端点；`BRIDGE_AUTH=subscription` 用本机登录。禁止把 `ANTHROPIC_BASE_URL` 指回 Bridge。

## 文档

- `docs/ARCHITECTURE.md`
- `docs/COMPATIBILITY.md`
- `docs/AUTH-AND-AIRGAP.md`
- `docs/G0-AIRGAP.md`（G0 跑完后生成）
- `docs/LIMITATIONS.md`
- `docs/SOURCES.md`
- `docs/T3-ALIGNMENT.md`
- `REPORT.md`
