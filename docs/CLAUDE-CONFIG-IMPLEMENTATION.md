# claude-config 离线实施报告

`npm run local -- /path/to/project` 默认跟随 Claude Code 的认证与模型路由。server 的 `BRIDGE_AUTH` 默认仍是 `byok`。

## 文件与设计

- `src/upstream/claude-config.ts:24`：只读选定目录的 settings.json，校验 JSON，记录忽略项的名字，丢弃 literal credential，只保留允许的 env 和 helper。
- `src/upstream/claude-config.ts:36`：settings 与 shell 同时含同一个凭证名时保守拒绝，不读取存储 token 来比较。改用另一个专用变量配合 `--key-env`。其它同名允许字段只在值不同时拒绝。
- `src/upstream/claude-config.ts:73`：启动时输入或指定环境变量的密钥回填到 settings 原来的凭证名，并保留 sk-ant- 主机检查。
- `src/upstream/claude-config.ts:95`：四种模型映射生成 alias 请求项，ANTHROPIC_MODEL 选默认项或增加具体 ID。
- `src/upstream/claude-config.ts:107`：stdout 摘要只显示目标 origin、凭证来源和配置名，不显示 helper 或密钥。
- `src/upstream/auth-env.ts:19`：新增模式；`:177` 以 baseEnv 加已解析允许字段构造 child env，保留 bridge-loop 检查。
- `src/config.ts:101`：启动时读取一次，后续 query 复用内存结果；claudeConfig 属性不可枚举，避免 JSON 序列化意外携带秘密。
- `src/index.ts:99`：server preflight 复用同一份解析结果，upstream.json 仍只写模式元数据。
- `src/runtime/sdk-runtime.ts:660`：child env 复用解析结果；`:703` 把 helper 原样传入 options.settings；`:743` 在 prompt 入队前调用 accountInfo 并拒绝失败、超时或未确认的纯登录；`:1130` 清理 SDK 错误里的 helper、密钥与 OAuth token。
- `src/models.ts:21`：增加 Fable 显示名，claude-config 使用 Claude 别名显示名。
- `scripts/local.ts:72`：默认 claude-config；`:269` 解析设置、隐藏输入或 --key-env 替代凭证、生成模型目录并打印摘要。显式 byok 保留偏好与原流程。
- `scripts/doctor.ts:128`：共用解析与摘要，fake SDK 可注入；真实使用时仅做 accountInfo dry-run，关闭 query，不发送 prompt。拒绝时也输出 promptSent: false。
- `scripts/configure-droid.ts:174`：接受新模式并保留默认 Claude 模型目录。
- `tests/unit/claude-config.test.ts`：设置、环境、模型与 server 配置测试。
- `tests/sdk-runtime/auth-gate.test.ts`：helper 透传、SDK 隔离、首条 prompt 与错误脱敏测试。
- `tests/unit/local.test.ts`：默认入口、秘密不落盘、隐藏提问、拒绝无状态、模型覆盖测试；原 BYOK 测试改为显式 --auth byok。ps 读取用固定 fixture 替代，不查看用户进程。
- `tests/unit/doctor-auth.test.ts`：六种 claude-config dry-run fixture。
- `README.md:18`、`AGENTS.md:12` 和 local help：更新默认路径、明确 BYOK 入口与隔离边界。

## 安装版 SDK 与 CLI 的静态检查

检查对象为 node_modules 中的 `@anthropic-ai/claude-agent-sdk` 0.3.300，以及随包安装的 darwin-arm64 Claude Code 2.1.300。只读取源文本和二进制内嵌 JavaScript，没有执行 CLI 或 helper。

SDK `sdk.mjs` 中：

- `cw` 把对象 settings 序列化为 JSON，独立传递 settingSources（字符偏移 1251577 附近）。
- transport 将 `this.options.settings` 放入额外参数，`DY` 和 `H_` 构造 `--settings` 参数（1174191、1174285 附近）。这段不以 settingSources 非空为条件。
- 设置合并器 `Dx` 始终把 flagSettings 和 policySettings 加入 allowedSources，`FZ` 从 flagInline 解析 SDK inline settings。

安装的 `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` 内嵌源中：

- byte offset 213486070 附近注册 `--settings <file-or-json>`。
- byte offset 194912063 的 `Fo` 和 195336728 的 `Udn` 都无条件加入 flagSettings。
- byte offset 195344061 的 `zht` 解析 flagInline；195381008 附近在 flagSettings 分支合并 inline settings。

结论：空 `settingSources` 关闭文件设置来源，但不排除 `options.settings` 对应的 flag-settings 层。helper 可按指定方案传入，strictMcpConfig 和 settingSources 无需放宽。

## 新增测试（44 项，每行一项）

1. 允许字段透传，hooks、permissions、plugins、MCP 和未知 env 只记录名字。
2. 丢弃 settings ANTHROPIC_AUTH_TOKEN，要求替代凭证且不保留字面量。
3. 丢弃 settings ANTHROPIC_API_KEY，要求替代凭证且不保留字面量。
4. helper 覆盖 literal 凭证，摘要显示非秘密提示。
5. shell 与 settings 的路由值冲突拒绝，相同值接受。
6. shell 与 literal credential 同名时不检查存储值而拒绝。
7. settings 或 shell 的 BEDROCK switch 拒绝。
8. settings 或 shell 的 VERTEX switch 拒绝。
9. settings 或 shell 的 FOUNDRY switch 拒绝。
10. settings 或 shell 的 MANTLE switch 拒绝。
11. malformed JSON、不可读文件类型与无效 env 拒绝，不回显内容。
12. 仅使用指定根的 settings.json，缺文件走登录，不读 settings.local.json 或 .claude.json。
13. file URL 拒绝。
14. 带 userinfo 的 URL 拒绝。
15. 无效 URL 拒绝。
16. 默认 bridge 地址回环拒绝。
17. 指定 bridge listen 地址回环拒绝。
18. 替代密钥及 shell sk-ant- 密钥对第三方主机拒绝。
19. 四种模型映射包含 Fable，映射 ID 选 alias，未匹配 ID 增加具体项。
20. 无 slot 时保留三个别名，启动后不重读设置，config JSON 不包含解析秘密。
21. server 的 BRIDGE_AUTH=claude-config 只解析一次，未设模式仍为 byok。
22. helper 模式接受 unknown 分类，原样传递 settings 并保留 SDK 隔离。
23. helper 模式接受 subscription 分类，原样传递 settings 并保留 SDK 隔离。
24. helper 模式接受 anthropic-api 分类，原样传递 settings 并保留 SDK 隔离。
25. 纯登录遇到 unknown 拒绝，prompt 数为零。
26. 纯登录接受 subscription，发送一条 prompt。
27. 纯登录接受 anthropic-api，发送一条 prompt。
28. gateway 模式接受成功返回的 unknown 分类并记录。
29. credential 模式接受成功返回的 unknown 分类并记录。
30. SDK 启动错误中的 helper 和替代密钥被脱敏。
31. helper 模式 accountInfo 抛错时拒绝，prompt 数为零。
32. helper 模式 accountInfo 超时时拒绝，prompt 数为零。
33. helper 模式缺少 accountInfo 时拒绝，prompt 数为零。
34. launcher 默认 claude-config，生成映射 alias，摘要及项目状态不含秘密。
35. launcher 用 --key-env 替代 literal，沿用原凭证名且不落盘或传给 Droid。
36. launcher 遇到 literal 时调用隐藏提问，提问失败前不创建状态。
37. launcher 设置冲突时拒绝，不创建状态或启动 Droid。
38. claude-config 的 --models 和 --model 显式覆盖生效。
39. doctor helper fixture 原样传递 helper，保留隔离、打印分类、不发送 prompt。
40. doctor gateway fixture 接受 unknown 分类，不发送 prompt。
41. doctor login fixture 接受订阅，不发送 prompt。
42. doctor unknown 纯登录 fixture 拒绝，不发送 prompt。
43. doctor literal fixture 在 SDK 加载前拒绝，不泄露字面量。
44. doctor accountInfo 抛错 fixture 拒绝并隐藏 helper 错误内容。

功能与测试提交：`24f8b9c`（`Add isolated Claude config auth mode`）。

## 验证结果

- `npm test`：715 passed，3 skipped，共 718 项；59 个测试文件通过，1 个既有文件跳过。
- `npm run build`：通过。
- `npx tsc --noEmit -p tsconfig.json`：通过。
- `git diff --check`：通过。

测试使用临时 HOME 或 CLAUDE_CONFIG_DIR、fake SDK、假 Droid runner 和回环 HTTP fixture。依赖用 `npm ci --ignore-scripts --offline` 安装，没有联网下载或执行安装脚本。

未运行真实 local、server、doctor、Claude、Droid、helper、e2e、上游 probe 或 verify。未读取用户真实 Claude、Factory、keychain 或 .env 文件。真实登录、gateway、helper 执行与端到端会话仍未验证。
