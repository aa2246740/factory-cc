# Relay Bridge

把 Factory Droid 的 BYOK 自定义模型接到**官方 Claude Agent SDK 和未修改的 Claude Code**。Claude Code 保留原生 system prompt、内置工具和会话；Droid 通过命名空间 MCP 执行自己的 skills、任务、插件工具与 Mission 生命周期操作。

`sdk` 模式为每个会话保持一个持续的 streaming-input `query()`，后续只追加新输入；工具结果交回原 MCP callback。`BRIDGE_AUTH` 只能是 `byok`（默认）、`subscription`、`anthropic-api`、`cloud`、`inherit`。Bridge 按这个声明组装 Claude Code 的环境，对不上就拒绝启动，错误里只有变量名。`subscription`、`anthropic-api`、`cloud` 都还没有用真实账号验证过。第一次先跑 `npm run doctor -- --auth subscription`，这条检查不发送 prompt。

这是借鉴 T3 的 SDK 集成方式，不是官方支持、授权或账号状态保证。GLM 等第三方兼容端点的结果不能代表 Claude 模型。见 [接入说明](docs/T3-ALIGNMENT.md) 和 [限制](docs/LIMITATIONS.md)。

## 已有 Claude Code 和 Droid：直接启动

需要 Node.js 22+。两个 CLI 不用重装；在本仓库运行：

```bash
npm ci
npm run local -- /你的项目路径
```

按提示选择 Anthropic 兼容接口地址、模型和输入自己的 API Key，随后自动打开 Droid。国际 Z.AI 默认地址是 `https://api.z.ai/api/anthropic`，默认模型 `glm-5.2`；中国区智谱使用 `https://open.bigmodel.cn/api/anthropic`。Key 必须属于所选服务。Key 输入不回显、不保存在配置文件里，下次启动重新输入。

这一个命令会启动 Bridge，配置独立的 Droid 数据目录和真实模型列表，安装生命周期 hooks 和 `relay-droid` skill。以后继续运行 `npm run local -- /你的项目路径` 即可。退出 Droid 时会停止本次服务并移除自己的 hooks，保留项目原有 hooks。

当前入口仍由这个项目参数固定工作目录；Droid hook 报告的目录用于核对会话归属，尚未实现全局安装后自动跟随 Droid 的项目目录。

`/model` 现在列真实模型，不再把 Relay Chat、Orchestrator、Worker 等内部角色当成模型。普通聊天在这里选模型；Mission 在自己的 Orchestrator、Worker、Validator 设置里，从同一列表分别选择。已经保存的不同角色选择会保留。

例如让同一个 BYOK 端点提供两个实际模型：

```bash
npm run local -- /你的项目路径 --models glm-5.2,glm-4.7 --model glm-5.2
```

菜单显示 GLM-5.2、GLM-4.7，请求实际进入相应模型。模型清单会记住，下次无需重复输入。空闲时可在同一对话切换，使用官方 Claude SDK 的 `resume` 保留原生会话；有未完成工具、审批或后台任务时先完成当前工作。更换模型可能不能复用前一个模型的推理缓存，不保证跨模型缓存命中。

Claude 接入使用 `sonnet`、`opus`、`haiku` 或有权限的具体版本 ID。`subscription` 和 `anthropic-api` 的默认显示名是 Claude Sonnet、Claude Opus、Claude Haiku。模型清单是明确配置的选项，不是自动枚举账号权益。`npm run local -- /你的项目路径 --auth subscription` 或 `--auth anthropic-api` 会跳过端点和密钥提问，默认这三个别名，并且不隔离 `CLAUDE_CONFIG_DIR`。如果环境里的 `BRIDGE_AUTH` 和 `--auth` 不一致，启动直接失败，不会悄悄退回 BYOK。BYOK 密钥以 `sk-ant-` 开头、而上游主机不是 `anthropic.com` 时也会拒绝。

需要允许原生工具操作时，打开启动时显示的控制页；管理员令牌保存在同时显示的私有文件中。默认仍逐次审批。接口地址和模型可记住，上游 Key 不落盘；不会使用你的 Claude 订阅登录。

更多参数见 `npm run local -- --help`。首次不需要手工修改下面的环境变量或 settings。

[历史入口实测记录](evidence/local-entry-validation-2026-10-16-r2.json)：旧版角色菜单时期的真实 Linux PTY、GLM BYOK 对话和正常退出记录。当前模型选择设计已按上述方式替换。

[查看当前模型选择设计与真实截图](docs/ACTUAL-MODEL-SELECTION.md)：真实模型菜单、同对话切换、Mission 各角色选择，以及保留的失败和修复记录。

[历史文件读写截图](docs/LOCAL-VISUAL-PROOF.md)：旧菜单时期的 Claude Code 原生 Write 审批、磁盘结果和实际 BYOK 上游。

## 手工运行与诊断

需要 Node.js 22+；真实模式还需要已安装的官方 `claude` 和 `droid`。

先配置一个独立 Droid settings 文件，再启动零模型费用的协议模式：

```bash
npm ci
umask 077
mkdir -p tmp/relay-local
export BRIDGE_CLIENT_TOKEN="$(openssl rand -hex 24)"
export BRIDGE_ADMIN_TOKEN="$(openssl rand -hex 24)"
export BRIDGE_HOOK_TOKEN="$(openssl rand -hex 24)"
printf 'export BRIDGE_CLIENT_TOKEN=%s\nexport BRIDGE_ADMIN_TOKEN=%s\nexport BRIDGE_HOOK_TOKEN=%s\n' "$BRIDGE_CLIENT_TOKEN" "$BRIDGE_ADMIN_TOKEN" "$BRIDGE_HOOK_TOKEN" > tmp/relay-local/tokens.env
npm run configure-droid -- --settings "$PWD/tmp/relay-local/settings.json" --base-url http://127.0.0.1:18787 --model glm-5.2
BRIDGE_MODE=mock BRIDGE_MODELS=glm-5.2 npm start
```

脚本将 token 的**真实字面值**写入 JSON，不使用 `${BRIDGE_CLIENT_TOKEN}` 占位符。配置和备份权限为 `0600`，缺少 token 时拒绝修改。`BRIDGE_CLIENT_TOKEN`、`BRIDGE_ADMIN_TOKEN`、`BRIDGE_HOOK_TOKEN` 必须互不相同，否则启动直接失败。默认只监听回环地址（`127.0.0.1`、`localhost`、`::1` 或任意 `127.x.x.x`）。非 `subscription` 模式若要监听其他地址，必须另外设置 `BRIDGE_ALLOW_REMOTE=1`；这会把本进程的凭证提供给其他客户端，操作者自己负责服务条款。`subscription` 不允许暴露给其他机器或他人。`GET /healthz` 只返回 `{ "ok": true, "mode" }`；运行细节在带管理员令牌的 `GET /internal/runtime`。`POST /v1/messages` 接收 JSON 或 SSE 请求。未设置管理员令牌或 hook 令牌时，`sdk` 模式会把生成值写到数据目录的 `admin-token` 和 `hook-token`（权限 `0600`），启动日志只打印路径。

另一个终端也先进入本仓库，加载同一份私有令牌文件，再使用该配置；`tmp/` 已被 Git 忽略。不要重新生成令牌或提交该文件：

```bash
source tmp/relay-local/tokens.env
FACTORY_AIRGAP_ENABLED=1 droid exec --settings "$PWD/tmp/relay-local/settings.json" -m glm-5.2 "RELAY_TEXT_PROBE"
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
export BRIDGE_MODELS=glm-5.2
export BRIDGE_UPSTREAM_TOKEN_ENV=GLM_CN_API_KEY
export BRIDGE_MODEL_ID=glm-5.2
npm start
```

BYOK 的 endpoint、model、key 变量必须全部明确配置；缺失或错误时直接失败，不探测其他环境密钥。除 `inherit` 外，Claude Code 子进程只拿到一份允许名单（`PATH`、`HOME`、代理、CA、locale 等），不再继承整个父进程环境。额外变量用 `BRIDGE_ENV_PASSTHROUGH=NAME1,NAME2`，但当前模式禁止的名字会直接报错。`subscription` 见到 `ANTHROPIC_API_KEY` 会建议改用 `anthropic-api`，见到 `CLAUDE_CODE_USE_*` 会建议改用 `cloud`。

手工配置时，`subscription` 和 `anthropic-api` 用 `BRIDGE_MODELS=sonnet,opus,haiku`。`cloud` 和 `byok` 必须自己写模型。`configure-droid --auth` 接受全部五种模式。这些路径只做过离线测试，没有用真实订阅、官方 API 或云厂商账号验证。先跑 `npm run doctor -- --auth subscription`。

国际 Z.AI 对应 `https://api.z.ai/api/anthropic` 和 `ZAI_CODING_PLAN_KEY`；请同时更改端点和变量名，密钥必须属于对应服务。这里传给 `BRIDGE_UPSTREAM_TOKEN_ENV` 的是环境变量名，真实密钥留在该变量中。

`ask` 是默认权限策略。需要审批的原生工具会暂停在 SDK `canUseTool` 回调；打开 `http://127.0.0.1:18787/control`，输入 `BRIDGE_ADMIN_TOKEN` 后查看准确参数并选择允许一次或拒绝。批准后由 Claude Code 执行。CLI 也可用 `npm run control -- approvals`、`approve <id>`、`deny <id>` 和 `cancel <sessionId>`。过期、取消、旧会话或重复审批均不能重新执行工具。`BRIDGE_PERMISSION=bypass` 仍须显式设置。

安装 Factory 官方生命周期 hooks，并从拥有取消权限的 wrapper 启动：

```bash
# 在第二个终端，从本仓库运行；PROJECT 与启动 Bridge 时相同。
source tmp/relay-local/tokens.env
export PROJECT=/absolute/path/to/project
npm run configure-hooks -- --hooks "$PROJECT/.factory/hooks.json" --config "$PWD/tmp/relay-local/hooks-control.json"
npm run run-droid -- --cwd "$PROJECT" --airgap 1 -- exec --settings "$PWD/tmp/relay-local/settings.json" -m glm-5.2 "检查这个项目"
# 撤销只删除本 Bridge 的 hook，不覆盖后来添加的用户 hook。
npm run configure-hooks -- --hooks "$PROJECT/.factory/hooks.json" --config "$PWD/tmp/relay-local/hooks-control.json" --remove
```

`configure-hooks` 读取 `BRIDGE_HOOK_TOKEN`，它必须和正在运行的 Bridge 一致，用法和 `BRIDGE_ADMIN_TOKEN` 相同。这个令牌只接受 `POST /internal/host-events`；其他 `/internal/*` 只接受管理员令牌。Bridge 与 wrapper 需共享同一组 `BRIDGE_ADMIN_TOKEN` / `BRIDGE_CLIENT_TOKEN` / `BRIDGE_HOOK_TOKEN`，并把 `BRIDGE_SDK_CWD` 指向目标项目。wrapper 保留 `HOME`，通过 `FACTORY_HOME_OVERRIDE` 隔离 Factory 数据；退出或取消时只清理本次启动拥有的会话。交互启动请使用 wrapper：Factory UI 的退出 hook 无法继承 Agent 进程里的会话绑定，需要本次启动的身份才能准确结束对应会话。进程被强制杀死、来不及发送结束事件时，应使用控制页取消遗留会话。

`BRIDGE_REQUEST_TIMEOUT_MS`（默认 10 分钟）现在是**空闲**期限，不再是单次响应的绝对期限：每条 SDK 消息、文本增量或工具事件都会重新计时，只有持续没有进展才超时；等待控制页审批期间暂停计时，审批自己的期限是 `BRIDGE_APPROVAL_TIMEOUT_MS`（默认 30 分钟）。另有绝对上限 `BRIDGE_TURN_MAX_MS`（默认 2 小时）。超时先调用 SDK `interrupt()`：5 秒内收尾则会话回到 IDLE 并可续接，否则标记 FAILED 并终止进程。流式响应立即发送 `message_start`，之后每 15 秒发送一次 `event: ping`。注意：原生工具若长时间既不输出也不结束（例如跑超过 10 分钟的测试），同样算空闲，需要时调大该值。会话停在外部工具往返上、Droid 一直没有回传结果时，空闲 30 分钟后过期（`BRIDGE_TOOL_WAIT_TIMEOUT_MS`；`BRIDGE_TOOL_WAIT_MS` 仍是单个工具 8 小时的绝对上限）。长时间不返回的 Mission 工具需要调大前者。过期、被取消或 Bridge 重启后，该会话标记为中断并释放名额，其工具调用不会重放；Droid 之后再回传同一个结果得到 409，新的文本消息则新建会话，并把此前历史作为参考导入。官方结束事件会提前释放会话，无需等计时器。

在目标项目安装自定义 Agent 生成入口：

```bash
npm run generate-droid -- --cwd "$PROJECT" --install-command
```

这会同时安装 `/relay-droid` 命令和 Factory 可发现的 `relay-droid` skill。重启 Droid 后，可以直接说“帮我创建一个只读的 JSON 检查子 Agent，名字叫 json-auditor”，由 Droid 根据 skill 描述选择本地 BYOK 生成器。生成配置后停止；需要执行时再单独提出要求，已有 Agent 继续通过 Factory `Task` 调用。普通对话、Mission、Agent Readiness 不需要先创建 Agent。

安装器可重复运行，也能为此前只安装了命令的项目补上 skill；不同内容的已有文件或符号链接会报错，不覆盖用户配置。命令引用当前仓库的位置，移动仓库后需检查安装路径。Factory 自带 `/droids` 管理菜单保持原样，手动进入其中的托管生成仍需要 Factory 授权；skill 不拦截该菜单。显式 `/relay-droid --name json-auditor --description "Read JSON fixtures"` 仍可使用。

自然语言 skill 通过原生 Bash 调用生成器时，使用当前会话的实际模型。Factory 显式 `/relay-droid` shell 命令继承启动时的 `BRIDGE_MODEL_ID`，不会跟随之后的 `/model` 变化；手工 wrapper 启动也应在第二个终端设置该变量。生成器的 `--model` 参数指定的是新建 Agent 的模型，默认 `inherit`，不是生成本次定义所用的模型。

[自然语言入口验收](evidence/relay-droid-discovery-validation-2026-10-16.json)记录了真实 Droid 无命令提示的创建、后续独立 Task 调用、普通聊天负例及正常退出；只使用隔离 BYOK，保留失败记录和修复后的证据。

## 会话与工具

- 优先使用响应中的 `X-Bridge-Session`；也接受 `X-Session-Id` 或 metadata 的 `session_id` / `sessionId`。`user_id` 不作为会话 ID。
- 未提供 ID 时，续接唯一完整历史前缀或所属 pending tool。Factory 压缩改写前缀时，还允许已认证的同一 Factory 会话、同一工作目录、无 pending 工具且最后完整 user/assistant 回合精确匹配的续接；重复短提示不会合并会话。
- 配置 `BRIDGE_MODELS` 或使用 `local` 时，空闲会话支持真实模型切换：关闭旧 query、等待其消费循环退出，再用同一个 SDK session ID 恢复；只追加新输入，不回放完整历史。关闭持久化、缺少 checkpoint 或存在未完成工作时明确拒绝切换，旧会话可继续；无法安全关闭旧 query 则终止。未配置 catalog 的旧手工接入保留固定模型行为，`GET /v1/models` 不宣称其支持模型切换。
- 角色配置标签、工作目录或执行策略改变仍返回 409，需新建会话。工具目录不属于会话身份：保留同一个 SDK MCP server 实例，按请求动态增删工具和更新 schema，并发送 `tools/list_changed`；等待 SDK `mcpServerStatus` 确认工具名称列表后再继续。schema 或描述改变时使用带版本的 MCP 名称，因此名称确认也确认了本次 schema 版本；JSON Schema 的完整约束经公开 MCP 接口提供，并由 Ajv 校验而不改写参数。真实 BYOK 同名 schema 更新后首次调用已通过。未变化的定义和恢复后的目录保持名称稳定，避免无谓破坏缓存；实际目录变化仍可能造成缓存 miss。
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
