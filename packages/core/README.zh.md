---
description: "保存限定作用域的 Flow，验证启动条件，并跟踪带人工审批检查点的持久化运行。"
kind: "package-reference"
---

# @switchboard/core

[English](README.md) | 中文

## 概述

保存由限定作用域的 Agent、验证命令和人工审批组成的配方。在执行前预览启动错误，跟踪持久化进度，并取消拥有的 Agent 和进程。配方支持并发副本和有界审查循环。每次运行保留配方与输入，后续编辑不会改变活动任务。

检查浏览器连接并使用可选的 OpenAI 转录和回复朗读。默认使用浏览器识别，无需 OpenAI 密钥；回复朗读默认关闭。OpenAI 请求使用 Host 的 `OPENAI_API_KEY`，该值不会出现在 Remote 响应中。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在基于 web 的 profile 中使用 [Switchboard bundle](../bundle/README.zh.md)。其 patch 挂载 `switchboard-core`；现有 UI 挂载机制安装生成的 Remote 贡献。存储通过配置的后端使用 `switchboard` domain。运行 Agent 还需要 Agent preset、agents、tools、system prompts 和 LLM adapter；检查与 Git 审计需要 shell executor。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxAgents` | `64` | 每次运行的估算及实际 Agent 启动上限。 |
| `automationPollMs` | `15000` | 服务端日历轮询间隔，1000–60000 毫秒。 |
| `commandTimeoutMs` | `120000` | 每条检查命令、Git 审计及 Host 关闭等待的截止时间。 |
| `outputBytes` | `32768` | 每次尝试及合并块保留的 UTF-8 输出字节数，也是 Git 审计输出预算。 |
| `maxRunMinutes` | `60` | 包含人工等待的运行截止时间；配方可缩短此限制。 |
| `agentPreset` | 组合默认值 | 为每个根 Agent 挂载的常驻组合。 |
| `routerProvider` / `routerModel` | `openrouter` / `typesafe/jev-router` | Jev 路由；模型 id 尚未验证，目录检查失败会明确报告。 |
| `fallbackRouterProvider` / `fallbackRouterModel` | `deepseek-official` / `deepseek-v4-flash` | 请求前可用性检查失败，或已计量的传输/JSON 失败后的无工具回退。 |
| `productionTerms` / `productionWriteTerms` | `prod, production` / `write, writes, migrate, migration, delete, deploy, update, insert, drop, apply` | 不区分大小写的完整词匹配；两个列表各匹配一项时路由到 You。 |
| `graphMaxCostTokens` / `graphTimeoutMs` | `100000` / `600000` | 卡片累计 token 上限及活动执行截止时间。 |
| `graphMemoryRoot` | `$DSH_HOME/switchboard/memory`（或 `~/.dsh/switchboard/memory`） | 三个初始图的记忆父目录。 |

Graphs 使用独立的 `switchboard_graphs` 存储域。空图存储会加入 [Billing](examples/graphs/billing.json)、[Code](examples/graphs/code.json) 和 [Research](examples/graphs/research.json)。Remote 提供 `graphs.list/get/save/delete/memory`、`cards.create/list/get/approve/reject/reroute`、`router.test` 以及不带点号的 `followCards` 流。创建卡片接受 `title`、`body`、`source` 和可选的绝对 `workspace`；分派节点需要工作区，并将其传给 Flow 声明的 `workspace` 输入。`graphs.memory` 返回有界的 Markdown 笔记，目录不存在时创建它，不调用模型。图中的 Flow 快照会在预检前绑定 `{{inputs.workspace}}` cwd 模板；两个原始示例流程也会绑定 `/workspace` 占位符，但不更改保存的配方。节点 cwd 目标必须解析到规范化的卡片工作区内部。每次启动都会重新检查原始路径绑定，并使用保留的规范 cwd 执行。

Jev 接收卡片及领域描述，每个路由允许一次严格 JSON 解析重试。未知目标或低于 0.70 的置信度会交给 You。生产写入规则在模型及明确人工路由之前执行；批准只记录人工解决，不授权生产写入。Lead 可以读取平面 Markdown 记忆、追加笔记、分派列出的节点、询问相邻 lead、退回 Jev 或完成。分派、询问及退回共享五次跳转；累计 token 和访问过的图中最低上限在重新路由后保留。每个已结束的 dsh 请求都必须报告用量；缺少计数会停止工具及后续推理，并交给 You。路由器报错、回答不完整或缺少结束标记时，若未报告用量，也禁止回退。图的日志记录及清理会保留用量缺失和预算错误，不会因此允许回退。观测到的卡片用量会在后续工作前持久化为检查点，包括记忆操作和 Council 主席重试。失败、预算耗尽或执行中断也需要 You。失败节点及 Flow 人工检查点不会自动重放。

Host 启动时会向空的流程存储写入 [fix-bug-with-review](examples/fix-bug-with-review.json) 和 [company-research](examples/company-research.json)，发布的模块也通过 `exampleFlows` 导出这两个示例。启动时会将未修改的版本 1 种子迁移为绑定工作区的版本 2 配方；保留用户编辑和部分删除。将必填 `workspace` 输入设为现有绝对目录，选择 dsh 模型或配置默认模型，并按工作区定制检查。输入声明 `name`、`type`（`string`、`number`、`boolean` 或 `path`）、可选 `default` 及可选 `required`（除非明确为 false，否则为 true）。Agent 和检查的 cwd 接受 `{{inputs.workspace}}`，可附加相对子路径。预检解析此绑定中的符号链接，并要求每个 Agent/检查的 cwd 位于规范工作区内；运行记录保存规范 cwd 和工作区输入。尚不存在的后代路径通过最近的现有祖先进行检查。执行器在入队前、检查点后以及每次 Agent 或检查命令启动前重新检查路径目标；目标改变会使运行失败。其他 cwd 模板及父目录遍历会被拒绝。作用域路径是相对 cwd 的文件或目录，不是 glob；命令必须精确匹配。

经过认证的 `switchboard` Remote 命名空间以带点的方法键暴露 `flows.list/get/save/delete/validate/preflight` 和 `runs.start/get/list/cancel/approveGate`，例如 `ctx.remote.switchboard['flows.list']()`。流名为 `followRuns`，因为当前 Typert stream 装饰器不能将方法重命名为带点的键。调用使用标准 Remote 结果包装。`followRuns(runId)` 先发送快照，再发送持久化替换更新；慢速读取者合并更新，但保留完整时间线。断开订阅不会取消运行。`ping()` 仍然可用。

自动化在同一存储 domain 中持久化具名计划和触发日志。`automations.list/get/save/delete/setEnabled/runNow/stats` 是带点的 Remote 键。Save 接收可编辑字段（创建时可省略 `id`，以及 `name`、`flowId`、基本类型 `inputs`、`schedule`、`enabled`）；时间戳由 Host 管理。Cron 通过 MIT 许可的 Croner 使用五个字段及显式 IANA 时区。每日 `0 2 * * *` 规则在该时区 02:00 运行；Croner 将春季不存在的时间向后移动，并选择秋季回拨时的较晚一次。手动计划仅通过 `runNow` 触发，暂停时也可调用。计时准入使用 `ctx.interval`，需要 timer 服务，而非打开的浏览器或活动 Session。

如果创建或上次触发以来错过任何计划时间，启动时仅补运行一次。自动准入等待 Flow 运行前检查通过，包括代理、预设和提供者可用性。调度器预检失败时保持日志不变；执行器准入失败时记录失败触发。两者均保留水位，并以固定 `automationPollMs` 间隔退避重试。暂停或编辑时间规则会重置水位；启用时不补跑暂停期间。已准入的运行和重叠跳过会推进水位；被拒绝的准入不会。排队中、运行中或等待人工处理的前次运行会阻止重叠，并记录 `skipped`。手动准入错误记录为失败触发。删除自动化移除计划及触发日志，但保留 Flow 运行且不取消它们。Stats 默认返回最新的 20 行（最多 100 行）；生成的客户端要求保留两个位置参数，因此使用 `ctx.remote.switchboard['automations.stats'](id, undefined)` 选择默认值。统计中的 `pending` 行表示尚无 FlowRun 的预留；仅排队中、运行中或等待人工处理的行可以订阅。列按当前 Flow 排列，追加仅存在于历史中的区块。单元格汇总所有副本的最新轮次；失败或反驳后的成功重试显示为 `recovered`。

普通边确定稳定的拓扑执行顺序；独立块串行运行，`copies` 和 `concurrency` 控制块内并行 Agent。每个循环最多额外执行 `maxRounds` 轮目标到来源的有序片段。最终答案以 `REFUTED` 开头会触发 refuted 循环，即使保留的输出已截断。输出引用使用最近完成的结果，在首次结果出现前展开为空文本，使构建者能接收上一轮审查。拒绝人工检查点会使运行失败；批准后继续执行。匹配循环耗尽会失败，不会继续进入审批。

Flow Agent 使用其 preset 的工具，并采用原生工具呈现，即使 preset 选择了 PTC。工具限制在 `write` 为空时移除写入工具，在 `commands` 为空时移除 shell，在 `web` 为 false 时移除 web 工具。执行守卫拒绝未列出的工具、路径、命令、后台 shell 启动、cwd 覆盖和 sandbox 升级。路径不能包含 `..` 段。存在的祖先路径会解析符号链接，最终目标必须位于授权根目录及 cwd 内。Git 工作区使用 porcelain-status 审计及不跟随符号链接的元数据快照；其他目录使用元数据快照。快照包含目录的存在状态和权限，但不包含目录时间戳。作用域外的更改使运行失败，但不会回滚。

在基于 web 的 profile 中使用 [Switchboard bundle](../bundle/README.zh.md)。其 patch 将此插件挂载为 `switchboard-core`。该行的语音设置选择默认值；Voice 页面可在当前浏览器会话中覆盖供应商选择。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sttProvider` | `browser` | 识别：`browser` 或 `openai`。 |
| `ttsProvider` | `off` | 回复朗读：`off`、`browser` 或 `openai`。 |
| `transcriptionModel` | `gpt-4o-transcribe` | OpenAI 识别模型；不自动回退模型。 |
| `speechModel` | `gpt-4o-mini-tts` | OpenAI 合成模型。 |
| `speechVoice` | `alloy` | OpenAI 合成音色。 |
| `maxAudioBytes` | `10485760` | 音频限制，最多 10 MiB。 |
| `maxDurationSeconds` | `60` | 浏览器按住操作的生命周期，最多 120 秒。 |
| `timeoutMs` | `45000` | OpenAI 请求时限。 |

认证 Remote 仅显示密钥是否存在，不返回其值。转录接收有界的规范 base64 音频；合成接收 1–4096 个字符并返回有界 MP3 音频。HTTP 429 显示“OpenAI speech quota exceeded — switch to Browser in Voice settings”。不会返回供应商原始错误。如果成功响应中的转录或音频包含本次请求所捕获并去除首尾空白的完整凭据，即使请求期间环境变量发生变化，也会拒绝该响应。

订阅功能仅公开 ChatGPT、Claude Pro/Max、GitHub Copilot、Kimi、Meta 和 xAI 的凭据存在状态。登录通过 Host 授权运行已安装的 pi-ai OAuth 流程；关闭流会取消会话。Host 取消和关闭会等待已排队的凭据写入；已接纳的授权会保留，不会回滚。在等待期间取消会阻止路由启用。查询参数不在提供方公开授权允许列表中的链接不会发送。授权保存后，适配器通过带修订检查的实时配置设置添加缺失的目录路由，不设置 `apiKeyEnv`，也不需要重启。现有路由覆盖保持不变；使用订阅前，须在 Models 设置中移除 API 密钥引用。退出登录会删除本地授权并保留路由，不会撤销提供方账户。已登录仅表示存有授权，不代表已验证订阅资格或令牌有效性。[订阅适配器](src/subscriptions-adapter.ts) 包含订阅功能对 dsh 的所有调用；帧仅包含链接、用户验证码、固定问题及安全状态，不含令牌、粘贴的答案或原始提供方错误。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[Host 服务](src/index.ts) 在接受请求前打开带版本的存储 domain。[执行器](src/engine.ts) 先记录检查点再广播 domain 更改，并负责取消直至所有子任务结束。[运行时适配器](src/runtime.ts) 为每个副本组合全新的根 Session，通过规范 setter 记录 sandbox 和审批设置，将 followup 驱动至 idle，检查持久化 turn 结果，并始终释放句柄。dsh token 总数来自已提交的 Assistant message/attempt usage，不重复计算实时流计数器。

已保存的运行保留尝试、截断输出、Session id、可用 usage 和有序时间线。崩溃后不重放活动任务：恢复时 queued/running 记录变为 failed，除非持久化的取消意图使其变为 cancelled。未取消的人工检查点在正常关闭后保留原始截止时间：恢复时使过期运行失败，并为其余运行恢复等待计时器。取消和批准在持久化前预留每次运行的状态转换；重叠的批准请求会被拒绝。关闭前请求取消的运行保持 cancelled，包括人工检查点处的运行。关闭会等待待处理的状态转换和子任务清理，若超过 `commandTimeoutMs` 则拒绝；恢复会完成已持久化的取消意图，不恢复审批。删除 Flow 会保留运行记录及其中嵌入的配方。[Schema](src/storage.ts) 拒绝无效的持久化记录。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Switchboard 包](../../README.md) — 包结构与许可证。

<a id="model-experience"></a>
## 模型体验

### 限定作用域的 Agent 请求

#### 模型看到什么

可选的工具运行时提供 `run_flow`，接受已保存的配方名称和基本类型输入。它检查启动条件并立即返回运行 id；持久化结果元数据让浏览器重建聊天卡片。只有用户直接请求时才应启动已保存的 Flow，其声明的作用域可能允许写入和命令。布局位置独立存储于 `switchboard_layout`。每个 dsh 副本接收展开的配方提示词及允许的工具 schema。作用域段落在 `Flow step scope: ` 后包含配方的 JSON 作用域，并附带下方固定说明。原生 provider 在用户提示词中接收展开后的任务、`Scope: ` 及该 JSON；其自身配置负责工具访问与权限。

##### 作用域说明

```markdown
Use only the listed paths and exact commands. A review that rejects the work must start its final answer with REFUTED.
```

#### Token 影响

`run_flow` 工具可见时，其 schema 会增加提示词 token；结果仅包含运行标识和名称，不包含执行记录。路由调用不带工具，准确的请求及已完成的回答保存在 `switchboard` 域的 `router_calls` 表中，以调用 Session id 为键并关联图卡片 id（预览没有卡片）。这些记录不写入 dsh 自定义 Session 事件，也不会发回路由模型。Lead 接收六个限定作用域的工具及领域指令；节点结果和记忆读取进入正常 Session 工具历史。路由预览消耗 token，但不创建卡片。每次 lead 调用使用新 Session，并明确读取持久记忆。每个 Agent 副本和循环重试创建独立模型对话。模板展开包含由 `outputBytes` 限制的最近保留输出；准入检查在初始及输出展开后均拒绝超过 64 KiB 的提示词。作用域文本和可用工具 schema 会在用户提示词限制之外增加请求 token。

#### KV 缓存影响

副本使用独立 Session。重复的部署文本可能共享 provider 管理的前缀，但作用域、允许的工具、输入或引用输出发生变化会改变请求 token；本包不保证缓存复用。

## 已知限制与待办工作
<a id="known-limitations-and-deferred-work"></a>

- **原生 provider** — `claude-code` 和 `codex` 使用配置的具名 `ctx.subagents` provider（`provider` 选择实例）。拒绝每次调用的模型覆盖。这些 provider 不能执行每次调用的 read/command/web/tool 限制；preflight 会警告，运行后会审计写入。启用此类配方前须配置具名 provider 的原生 sandbox 和权限。
- **Usage** — 尝试缺少 usage 表示不可用，而非零成本。运行 token 总数只包含观测到的 dsh usage；Claude Code/Codex 没有 token 计量。已提交 usage 达到上限时会停止后续任务，在途请求可能导致超限；此限制无法约束未报告的原生 usage。
- **文件系统审计** — 运行后检测不是回滚或隔离。并发外部编辑可能导致审计失败。元数据快照无法检测两次快照间临时创建后删除的活动；操作系统 sandbox 执行仍依赖配置的 dsh 执行 provider。检查命令是受信任的 Host 命令，而非 Agent 作用域工具。
- **自动化准入** — 触发预留先提交，再启动运行；仅在执行器准入或重叠跳过后推进水位。恢复时消耗被中断的预留，运行存在时记录已启动准入，否则记录准入失败，不重放不确定的副作用；这不是恰好一次执行。触发日志没有大小上限。单一准入队列串行处理预检与编辑；缓慢预检会延迟其他计划。
- **持久化** — 被中断的副作用不会自动重试。没有多 Host 调度器、运行保留策略或美元价格估算。生成的传输是扁平结构；流的名称为 `followRuns` 而非 `runs.follow`。

- **供应商访问** — OpenAI 语音需要 Host 凭据和配额；Ping 成功并不验证这些条件。真实音频质量和供应商可用性需要实时语音检查。
- **Graph memory** — 以目录为锚点的访问需要 Linux procfs。读取和追加会验证授权目录的规范路径及设备/inode，拒绝被替换的目录，并通过其打开的描述符访问笔记；不支持的主机会拒绝访问。
- **Graphs** — 只有 dsh lead 可以接收限定作用域的编排工具。Claude Code lead 会明确失败；原生节点及 Council 席位因不能执行卡片 token 上限而被排除。图规则和生产关键词检测不能代替操作系统 sandbox 或只读生产凭据。Council 卡片使用带计量 LLM 席位的 quick 模式。在途调用可能导致卡片超出 token 上限。模型目录检查不验证凭据或远程可用性。

<a id="dev-note"></a>
### 开发备注

无。
