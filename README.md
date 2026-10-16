# Relay Bridge

把 Factory Droid 的 BYOK 自定义模型接到**官方 Claude Agent SDK 和未修改的 Claude Code**。Claude Code 保留原生 system prompt、内置工具和会话；Droid 通过命名空间 MCP 执行自己的 skills、任务、插件工具与 Mission 生命周期操作。

`sdk` 模式为每个会话保持一个持续的 streaming-input `query()`，后续只追加新输入；工具结果交回原 MCP callback。默认 `BRIDGE_AUTH=byok` 使用你自己的 Anthropic 兼容上游密钥。`subscription` 保留本机 `ANTHROPIC_*` 和 Claude 配置；本轮没有验证真实 Claude 订阅。

这是借鉴 T3 的 SDK 集成方式，不是官方支持、授权或账号状态保证。GLM 等第三方兼容端点的结果不能代表 Claude 模型。见 [接入说明](docs/T3-ALIGNMENT.md) 和 [限制](docs/LIMITATIONS.md)。

## 已有 Claude Code 和 Droid：直接启动

需要 Node.js 22+。两个 CLI 不用重装；在本仓库运行：

```bash
npm ci
npm run local -- /你的项目路径
```

按提示选择 Anthropic 兼容接口地址、模型和输入自己的 API Key，随后自动打开 Droid。国际 Z.AI 默认地址是 `https://api.z.ai/api/anthropic`，默认模型 `glm-5.2`；中国区智谱使用 `https://open.bigmodel.cn/api/anthropic`。Key 必须属于所选服务。Key 输入不回显、不保存在配置文件里，下次启动重新输入。

这一个命令会启动 Bridge，配置独立的 Droid 数据目录、聊天和 Mission 各角色模型，安装生命周期 hooks 和 `relay-droid` skill。以后继续运行 `npm run local -- /你的项目路径` 即可。退出 Droid 时会停止本次服务并移除自己的 hooks，保留项目原有 hooks。

需要允许原生工具操作时，打开启动时显示的控制页；管理员令牌保存在同时显示的私有文件中。默认仍逐次审批。接口地址和模型可记住，上游 Key 不落盘；不会使用你的 Claude 订阅登录。

更多参数见 `npm run local -- --help`。首次不需要手工修改下面的环境变量或 settings。

[入口实测记录](evidence/local-entry-validation-2026-10-16-r2.json)：真实 Linux PTY 从该命令启动、自动选择 Relay Chat、GLM BYOK 对话和正常退出均通过；本轮只核对 Mission 角色配置，没有重新运行完整 Mission。

## 手工运行与诊断

需要 Node.js 22+；真实模式还需要已安装的官方 `claude` 和 `droid`。

先配置一个独立 Droid settings 文件，再启动零模型费用的协议模式：

```bash
npm ci
umask 077
mkdir -p tmp/relay-local
export BRIDGE_CLIENT_TOKEN="$(openssl rand -hex 24)"
export BRIDGE_ADMIN_TOKEN="$(openssl rand -hex 24)"
printf 'export BRIDGE_CLIENT_TOKEN=%s\nexport BRIDGE_ADMIN_TOKEN=%s\n' "$BRIDGE_CLIENT_TOKEN" "$BRIDGE_ADMIN_TOKEN" > tmp/relay-local/tokens.env
npm run configure-droid -- --settings "$PWD/tmp/relay-local/settings.json" --base-url http://127.0.0.1:18787
BRIDGE_MODE=mock npm start
```

脚本将 token 的**真实字面值**写入 JSON，不使用 `${BRIDGE_CLIENT_TOKEN}` 占位符。配置和备份权限为 `0600`，缺少 token 时拒绝修改。默认监听 `http://127.0.0.1:18787`；`GET /healthz` 探活，`POST /v1/messages` 接收 JSON 或 SSE 请求。

另一个终端也先进入本仓库，加载同一份私有令牌文件，再使用该配置；`tmp/` 已被 Git 忽略。不要重新生成令牌或提交该文件：

```bash
source tmp/relay-local/tokens.env
FACTORY_AIRGAP_ENABLED=1 droid exec --settings "$PWD/tmp/relay-local/settings.json" -m relay-probe "RELAY_TEXT_PROBE"
```

撤销配置：

```bash
npm run configure-droid -- --settings "$PWD/tmp/relay-local/settings.json" --revert
```

切换真实 BYOK 前，先在第一个终端用 Ctrl-C 停止 mock 服务。下面以已在环境中配置的中国区 `GLM_CN_API_KEY` 为例，明确固定上游；URL 必须是 Claude Code 可用的 **Anthropic 兼容端点**，不能指回 Bridge。Droid 直接连接模型时使用的 OpenAI-compatible URL 不能照搬到这里。

```bash
source tmp/relay-local/tokens.env
export PROJECT=/absolute/path/to/project
export BRIDGE_MODE=sdk
export BRIDGE_AUTH=byok
export BRIDGE_PERMISSION=ask
export BRIDGE_SDK_CWD="$PROJECT"
export BRIDGE_UPSTREAM_BASE_URL=https://open.bigmodel.cn/api/anthropic
export BRIDGE_UPSTREAM_MODEL=glm-5.2
export BRIDGE_UPSTREAM_TOKEN_ENV=GLM_CN_API_KEY
npm start
```

BYOK 的 endpoint、model、key 变量必须全部明确配置；缺失或错误时直接失败，不探测其他环境密钥。BYOK 子进程清除继承的 OAuth 和 Bedrock/Vertex/Foundry 路由选择，保留代理与 CA；subscription 环境不受此处理。

国际 Z.AI 对应 `https://api.z.ai/api/anthropic` 和 `ZAI_CODING_PLAN_KEY`；请同时更改端点和变量名，密钥必须属于对应服务。这里传给 `BRIDGE_UPSTREAM_TOKEN_ENV` 的是环境变量名，真实密钥留在该变量中。

`ask` 是默认权限策略。需要审批的原生工具会暂停在 SDK `canUseTool` 回调；打开 `http://127.0.0.1:18787/control`，输入 `BRIDGE_ADMIN_TOKEN` 后查看准确参数并选择允许一次或拒绝。批准后由 Claude Code 执行。CLI 也可用 `npm run control -- approvals`、`approve <id>`、`deny <id>` 和 `cancel <sessionId>`。过期、取消、旧会话或重复审批均不能重新执行工具。`BRIDGE_PERMISSION=bypass` 仍须显式设置。

安装 Factory 官方生命周期 hooks，并从拥有取消权限的 wrapper 启动：

```bash
# 在第二个终端，从本仓库运行；PROJECT 与启动 Bridge 时相同。
source tmp/relay-local/tokens.env
export PROJECT=/absolute/path/to/project
npm run configure-hooks -- --hooks "$PROJECT/.factory/hooks.json" --config "$PWD/tmp/relay-local/hooks-control.json"
npm run run-droid -- --cwd "$PROJECT" --airgap 1 -- exec --settings "$PWD/tmp/relay-local/settings.json" -m relay-chat "检查这个项目"
# 撤销只删除本 Bridge 的 hook，不覆盖后来添加的用户 hook。
npm run configure-hooks -- --hooks "$PROJECT/.factory/hooks.json" --config "$PWD/tmp/relay-local/hooks-control.json" --remove
```

Bridge 与 wrapper 需共享同一组 `BRIDGE_ADMIN_TOKEN` / `BRIDGE_CLIENT_TOKEN`，并把 `BRIDGE_SDK_CWD` 指向目标项目。wrapper 保留 `HOME`，通过 `FACTORY_HOME_OVERRIDE` 隔离 Factory 数据；退出或取消时只清理本次启动拥有的会话。交互启动请使用 wrapper：Factory UI 的退出 hook 无法继承 Agent 进程里的会话绑定，需要本次启动的身份才能准确结束对应会话。进程被强制杀死、来不及发送结束事件时，应使用控制页取消遗留会话。

默认单次原生响应期限为 10 分钟（`BRIDGE_REQUEST_TIMEOUT_MS`）；外部工具往返等待为 8 小时（`BRIDGE_TOOL_WAIT_MS`），适用于长 Mission。它们都是明确的时间上限，超时会取消工作；官方结束事件会提前释放会话，无需等计时器。

在目标项目安装自定义 Agent 生成入口：

```bash
npm run generate-droid -- --cwd "$PROJECT" --install-command
```

这会同时安装 `/relay-droid` 命令和 Factory 可发现的 `relay-droid` skill。重启 Droid 后，可以直接说“帮我创建一个只读的 JSON 检查子 Agent，名字叫 json-auditor”，由 Droid 根据 skill 描述选择本地 BYOK 生成器。生成配置后停止；需要执行时再单独提出要求，已有 Agent 继续通过 Factory `Task` 调用。普通对话、Mission、Agent Readiness 不需要先创建 Agent。

安装器可重复运行，也能为此前只安装了命令的项目补上 skill；不同内容的已有文件或符号链接会报错，不覆盖用户配置。命令引用当前仓库的位置，移动仓库后需检查安装路径。Factory 自带 `/droids` 管理菜单保持原样，手动进入其中的托管生成仍需要 Factory 授权；skill 不拦截该菜单。显式 `/relay-droid --name json-auditor --description "Read JSON fixtures"` 仍可使用。

[自然语言入口验收](evidence/relay-droid-discovery-validation-2026-10-16.json)记录了真实 Droid 无命令提示的创建、后续独立 Task 调用、普通聊天负例及正常退出；只使用隔离 BYOK，保留失败记录和修复后的证据。

## 会话与工具

- 优先使用响应中的 `X-Bridge-Session`；也接受 `X-Session-Id` 或 metadata 的 `session_id` / `sessionId`。`user_id` 不作为会话 ID。
- 未提供 ID 时，续接唯一完整历史前缀或所属 pending tool。Factory 压缩改写前缀时，还允许已认证的同一 Factory 会话、同一工作目录、无 pending 工具且最后完整 user/assistant 回合精确匹配的续接；重复短提示不会合并会话。
- 同会话修改模型、角色配置标签、工作目录或执行策略返回 409，需新建会话。工具目录不属于会话身份：保留同一个 SDK MCP server 实例，按请求动态增删工具和更新 schema，并发送 `tools/list_changed`；等待 SDK `mcpServerStatus` 确认工具名称列表后再继续。schema 或描述改变时使用带版本的 MCP 名称，因此名称确认也确认了本次 schema 版本；JSON Schema 的完整约束经公开 MCP 接口提供，并由 Ajv 校验而不改写参数。真实 BYOK 同名 schema 更新后首次调用已通过。未变化的定义和恢复后的目录保持名称稳定，避免无谓破坏缓存；实际目录变化仍可能造成缓存 miss。
- Droid host context 的变化进入 user input，不改写原生 system prefix。若请求同时带 `tool_result` 和补充文本/base64 图片，补充内容以 host continuation 标记并附入本批首个新工具结果，交还真实 MCP callback，不伪造额外用户轮次。混入 document 或其它不支持的 MCP 内容在提交前返回 422，不消耗 pending 工具结果。
- 空闲 CLI 进程按 LRU 有界回收，保留官方 SDK session ID；有持久化 transcript 时使用 SDK `resume`。忙碌会话不会为腾位置而被驱逐。
- 进程重启后，尚未完成的 MCP 工具往返返回 409。没有 native session 的历史导入仅作为参考重建，不等于完整恢复 Claude Code 的内部状态。
- 原生 PreToolUse 每次检查当前 Factory 工具权限，即使启用 bypass。只广告 Read 就不能用 Bash/Write；省略 tools、空列表或 tool_choice:none 不授予工具权限。工具权限可在同一会话增减；原生 Agent/Skill 不得绕开 Factory 的 Task/Skill。Spec 通过已认证 hooks 锁定只读，只有对应 ExitSpecMode 成功回执才解锁。
- 对 Droid 传入的工具，仅明确的文件/命令等价工具由 Claude Code 执行：Read/Edit/Write/Create/LS/Grep/Glob/Execute/Bash/MultiEdit/NotebookEdit。Factory `Skill`、`Task`、`ToolSearch`、`ExitSpecMode`、Mission 控制及其它已声明的插件工具均经 `mcp__droid__*` 交回 Droid，保留 Factory 的 skill 注册表和任务 ID；它们与 Claude 原生 Skill/Agent 分开。
- Factory 提供非空 `system` 时完整保留其角色、skills 和流程指令，不从 header 猜测角色或追加角色模板；`X-Bridge-Role` 仅作为模型配置/session 标签，真实 Task 子 agent 会继承 orchestrator header。只有缺少 host 指令时才用角色辅助，orchestrator 辅助还要求实际存在 Mission 控制工具，`Task` 本身不够。生产 SDK 路径不合成 `StartMissionRun`，也不从残留目录复制 Mission 账本。

## 当前验证范围

2026-10-16 新增真实路径和修复见[本轮入口验收](docs/FACTORY-SURFACES.md)：Factory 自身压缩与 handoff、Spec 只读及退出、自定义 Droid、交互 review、工具权限收回、schema 更新与缓存均有独立证据。所有线上验证仍只使用隔离 GLM BYOK。

本轮[全新 Mission](evidence/mission-final-validation-2026-10-16-r3.json)已连续通过：18 分 46 秒，实际实施、scrutiny、user-testing 三个 feature 完成，5/5 验证通过，原测试和 package.json 保持不变，零运行错误、零遗留进程。它记录了运行时源码指纹；随后三处独立修正及最终验证范围见[汇总](evidence/final-validation-2026-10-16.json)。此前主动中断与环境断连记录仍保留。

2026-10-15 的 GLM-5.2 BYOK 验证包括：Droid → Bridge → Claude Code 普通回答成功；原生 SDK 与 Bridge 各三轮对话保持上下文；原生 Read 与流式痕迹，以及无显式 ID 的完整历史续接保持同一会话和记忆；真实 SDK MCP `TaskOutput` 往返成功，但该项外部工具结果是本地 fixture。Bridge 的原生手动 `/compact` 产生 `compact_boundary`，压缩后的下一轮仍能回忆先前约定的信息。[原生会话验证摘要](evidence/native-session-validation-2026-10-15.json) 保留该轮测量和离线检查结果。

后续[Factory host 验证](evidence/factory-host-validation-2026-10-15.json) 确认了新工具在首次续推可用、真实 `Skill` 完整正文传递、`Task` 子 agent 和 Mission 启动。过程中发现并修复了工具校验前过早转交、标题辅助请求越权执行工具、worker 结束后原生回调悬挂等问题；失败记录仍保留。

历史[完整 Mission 验收](evidence/mission-validation-2026-10-15.json) 为 **PASS_WITH_RECOVERY**：从没有预置 Mission 产物的缺陷项目开始，真实 orchestrator / worker / validator 完成 3 个 feature、5 个验证断言，原始测试和 package.json 保持不变且测试通过。首次达到旧的 20 分钟测试上限后，使用官方 `droid exec --session-id` 续接同一个 Mission，约 130 秒完成收尾；这不是一次连续运行通过。完成时原生运行、待处理工具、审批和 Bridge 错误均为零，所属进程清理完成。新验收脚本默认总期限为 1 小时；不会合成启动或复制账本来制造完成状态。

Factory 生命周期已通过官方 [hooks](https://docs.factory.com/harness/hooks) 接入独立控制通道。`SessionStart` 注册随机 generation 标识，经官方环境文件传给后续 hooks；该标识在进入 Claude 原生提示前移除。`PostToolUse` 保存实际收到的结果，`SessionEnd` 确认结束后释放原生等待；若 Factory 提前结束而跳过 PostToolUse，则中断等待，不伪造成功结果；普通工具仍等下次 HTTP 续接，保证 ToolSearch 新目录和附加内容同时交付。正常会话结束可从原生 checkpoint 恢复，已结束的 worker 不再接受迟到结果。

[控制通道实测](evidence/control-validation-2026-10-15.json) 还确认：原生工具拒绝后无写入，批准后仅执行一次，取消待审批后旧批准返回 409。带 hooks 的正常退出及恢复保留同一原生会话，恢复轮 Claude Code 侧记录 `input_tokens=278`、`cache_read_input_tokens=21760`；旧 generation 的结束事件被拒绝且不影响新会话。真实 Claude 订阅仍未使用。

[自动压缩实测](evidence/auto-compaction-validation-2026-10-15.json) 也已通过：只在独立测试进程中用官方配置降低触发阈值，未发送 `/compact`，原生返回 `trigger: auto`、90,038 → 2,245 tokens，同一会话随后两次正确回忆之前的信息。该测试验证自动压缩链路，不代表默认阈值或真实 Claude 订阅的消耗表现。

上述缓存原始响应中，原生路径后两轮 `input_tokens` 为 211 / 108，`cache_read_input_tokens` 为 21,056 / 21,248；Bridge 为 74 / 98 与 21,248 / 21,312。两条路径各自三轮的 system/tools hash 稳定，工具 schema 相同；当时 Bridge 的稳定 append 多 546 字符。当前 append 和工具目录已经扩展，这些数值保留为该轮测量。上游没有返回 `cache_creation_input_tokens`，因此不报告精确总命中率；SDK `costUSD` 是估算，不是真实账单。详见 [缓存与压缩证据](docs/T3-ALIGNMENT.md#缓存与压缩验证)。

历史 `REPORT.md` 和 `evidence/` 中的 MiniMax Mission PASS 属于旧实现，不能为当前版本的 Mission 背书。旧版混合 usage 账本的命中率也不作为当前准确统计。

## 测试

仓库专用验证入口是 `npm run verify:relay -- --feature chat`。它按[验证 skill](.cursor/skills/verify-relay-bridge/SKILL.md)启动隔离实例、运行只读 doctor，再通过真实 Droid 验证文件读写和同会话恢复，最后清理进程与私有配置并保留脱敏证据。先按 skill 设置明确的 BYOK 上游；`--offline-check` 只检查本地前提，不调用模型。

[本轮 skill 执行记录](evidence/verification-skill-validation-2026-10-16-r2.json)记录最后 BYOK 隔离修正后的真实 chat/resume 结果；独立场景的验证入口和范围见[入口验收](docs/FACTORY-SURFACES.md)。历史误判和失败记录仍保留。

**不能把固定 BYOK 当成 Factory 全部托管模型能力。** [最新入口验收](docs/FACTORY-SURFACES.md)区分实测修复、可用替代入口与独立服务前提；[早期静态清单](evidence/factory-model-surface-2026-10-15.json)不是当前运行通过清单。REA 文件检查不等于完整调用图，隐藏和服务端入口的总数仍未知。

| 命令 | 范围 | 是否调用真实模型 |
|---|---|---|
| `npm test` | unit、protocol、fake relay、SDK adapter 注入事件、resilience | 否 |
| `npm run test:protocol` | Messages、SSE、错误和鉴权 | 否 |
| `npm run test:sdk-probes` | fake runtime 跨请求工具接力 | 否 |
| `npx vitest run tests/sdk-runtime` | 真实 adapter 代码配合注入 SDK 事件；不是在线模型验收 | 否 |
| `npm run test:resilience` | 重试、取消、图片 | 否 |
| `npm run tiny-tasks:test` | Tiny Tasks 参考夹具 | 否 |
| `npm run doctor` | 脱敏诊断 | 否 |
| `npm run verify:relay -- --feature chat` | 真实 CLI 文件操作、会话恢复与清理证据 | 是，隔离 BYOK |
| `npm run verify:spec -- --adversarial-spec` | Spec 只读、真实退出后写入 | 是，隔离 BYOK |
| `npm run verify:custom -- --read-only-custom` | 自定义 Droid、模型选择和工具限制 | 是，隔离 BYOK |
| `npm run verify:context -- --auto` | Factory 压缩、handoff、恢复与自动触发 | 是，隔离 BYOK |
| `npm run verify:native-schema` / `npm run verify:native-policy` | 同会话 schema 版本与工具权限变更 | 是，隔离 BYOK |
| `npm run verify:auxiliary` | 辅助入口可达性和能力拒绝检查 | 是，隔离 BYOK |
| `npm run verify:mission -- --summary evidence/new-mission.json` | 独立新 Mission 验收，不覆盖旧证据 | 是，隔离 BYOK |
| `npm run test:g0` | 安装版本的 Droid airgap 行为 | 以具体探针为准 |
| `npm run probe:upstream` | BYOK 上游工具调用探针 | 是 |
| `npm run test:e2e:chat` / `npm run test:e2e:mission` | 在线对话 / Mission 验收 | 是，另行执行并记录结果 |

更多协议边界见 [Compatibility](docs/COMPATIBILITY.md)。公共 CLI 的 `FACTORY_AIRGAP_ENABLED=1` 是已观察到的技术行为，不等于官方授权声明。
