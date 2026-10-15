# Relay Bridge

把 Factory Droid CLI 的 BYOK 自定义模型接到**官方 Claude Agent SDK** 和**未修改的 Claude Code**。Droid 继续负责任务、审批和工具执行；模型推理在 Claude Code 里发生。

当前环境没有 Anthropic 登录，也没有 Factory 凭证。`mock` / `fake` 协议测试可跑；真实 Claude 与完整 Mission 标为 `BLOCKED_AUTH`。

## 能做什么

- `POST /v1/messages`：Anthropic Messages JSON 与 SSE
- 原生 `tool_use` / `tool_result` 跨 HTTP 请求接力（先结束本次响应，SDK 回调继续等）
- 按 Droid 当前请求动态注册 MCP 工具；Claude Code 内置工具用 `tools: []` 去掉
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
| `npm test` | unit + protocol + fake SDK + resilience | 应通过 |
| `npm run test:protocol` | Messages / SSE / 401 | 应通过 |
| `npm run test:sdk-probes` | 跨请求工具接力 | 应通过（fake runtime） |
| `npm run test:g0` | 公共 CLI airgap 矩阵 | 记录真实退出码 |
| `npm run test:e2e:chat` | 真实对话 C01–C10 | 退出码 2 `BLOCKED_AUTH` |
| `npm run test:e2e:mission` | Mission 三角色 | 退出码 2 `BLOCKED_AUTH` |
| `npm run test:resilience` | 重试 / 取消 / 图片 | 应通过 |
| `npm run doctor` | 脱敏诊断 | 应通过 |
| `npm run evidence:pack` | SHA-256 清单 | 应通过 |
| `npm run tiny-tasks:test` | 夹具验收点 | 应通过 |

真实 SDK 探针在登录完成后才会跑。禁止把未跑的测试标绿。

## 模式

- `BRIDGE_MODE=mock`：固定文本/只读工具探针，零模型费用
- `BRIDGE_MODE=fake`：进程内 query 替身，证明邮箱接力
- `BRIDGE_MODE=sdk`：官方 SDK + 已安装 `claude`。需要用户本人官方登录

## 文档

- `docs/ARCHITECTURE.md`
- `docs/COMPATIBILITY.md`
- `docs/AUTH-AND-AIRGAP.md`
- `docs/G0-AIRGAP.md`（G0 跑完后生成）
- `docs/LIMITATIONS.md`
- `docs/SOURCES.md`
- `REPORT.md`
