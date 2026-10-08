---
description: "使用语音、咨询 Council、编辑 Flow、跟踪运行并设置自动化计划。"
kind: "package-reference"
---

# @switchboard/ui

[English](README.md) | 中文

## 概述

在聊天中按住说话，打开 **Voice** 设置朗读回复。打开 **Council** 选择席位、提问并阅读裁决。打开 **Flows** 编辑画布配方、配置作用域并在预检后启动；在 Flow 侧栏或聊天卡片中跟踪进度与人工检查点。打开 **自动化** 计划保存的 Flow 并查看结果。**Graphs** 将卡片路由到领域 lead、Council 或 You，展示看板和时间线。**Switchboard** 检查 Host 连接并打开全部五个工作区页面；导航、编辑和图表无需模型凭据。

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

在基于 web 的 profile 中使用 [Switchboard bundle](../bundle/README.zh.md)。本包没有配置字段。其 Host 行提供已构建的浏览器贡献；修改浏览器代码后需要重新构建。自动化有英文和中文字典；连接概览保留英文文案。

**Subscriptions** 卡片位于主页及独立侧栏页面。登录 ChatGPT、Claude Pro/Max、GitHub Copilot、Kimi、Meta 或 xAI，按提示选择浏览器或无头方式，再打开链接或复制验证码。仅在出现问题时粘贴重定向地址或代码；GitHub Copilot 可能先询问 Enterprise 域名。完成前保持页面打开；Cancel 或离开页面会取消登录。成功登录后，提供方目录模型会出现在普通聊天模型选择器中。若授权已保存但路由启用失败，可选择 **Enable models**；界面不显示原始提供方诊断。退出登录删除本地授权，而非提供方账户。真实订阅资格和推理需要实际账户；浏览器测试使用模拟 OAuth 交换。

按住聊天麦克风或在编辑器外按住空格，松开后通过普通输入框发送转录。浏览器识别无需 OpenAI 密钥；OpenAI 识别与合成使用 Host 凭据。

开始前需要空白草稿和已打开的 Session。空格键作用于焦点所在的输入框；焦点在输入框外时，作用于当前主 Session。已有草稿不会将录音转交给其他 Session。每次录音属于发起它的 Session。转录完成前切换 Session 会丢弃录音并显示提示，而不是提交。Escape、指针取消、窗口失焦、文档隐藏或所属控件卸载也会丢弃待处理录音；草稿被修改后不再插入或提交。即使 Tab 已移走焦点，松开 Enter 仍会结束麦克风录音。草稿冲突时最终转录仍然可见。浏览器识别显示部分文本；OpenAI 在松开后显示最终文本。仅新完成的轮次朗读最后一条助手文本，并去除围栏和缩进代码块，包括引用或列表中嵌套的代码块；历史、推理、失败轮次和中间消息不会朗读。切换 Session 或卸载播放所属控件会停止朗读并中止待处理的合成请求；迟到的响应不能重新开始播放。移除最后一个 Voice 控件会停止所有播放。

供应商默认值和限制由 [core](../core/README.zh.md) 管理。Voice 设置保留至重新加载，不修改 Host 配置。浏览器语音可能使用浏览器供应商的服务。OpenAI 接收用于识别的音频或用于合成的最终文本。转录历史仅保存在浏览器内存；已提交消息使用普通 Session 持久化。

无密钥浏览器检查需要先运行 `pnpm --filter @switchboard/ui exec playwright install chromium --only-shell` 安装 Chromium。按文档启动未配置模型密钥的 profile 并关闭预览提示后，将 `DSH_URL` 设为认证 URL，从仓库根目录运行 `node packages/ui/tests/web-smoke.mjs "$DSH_URL"`。它检查真实 Host Ping 并将页面无障碍输出与 `tests/expected/page.aria.txt` 比较；可选的第二个参数指定截图路径。在存在空白 **New Session** 且未配置 OpenAI 密钥时，`node packages/ui/tests/voice-web-smoke.mjs "$DSH_URL"` 检查语音设置、输入框麦克风和 `tests/expected/voice.aria.txt`，不采集音频。

打开 **Graphs** 创建卡片、填写工作区路径、查看路由置信度及原因，并跟踪 New、Running、Needs you 和 Done 四列。点击图可查看 lead 记忆笔记及目录、限定作用域的节点及有向 lead 边。编辑图设置可选择保存的 Flow 或明确的 agent-block JSON。Approve 确认人工完成；Reroute 保留累计预算和生产规则。路由预览可能消耗 token，但不创建卡片。离开页面仅断开实时更新，不停止工作。

无密钥 Graphs 浏览器检查使用包含本地 bundle 的 web 派生 profile，在 web 应用参数之前传入 `--patch packages/ui/tests/fixtures/graphs.patch.yml`。此 overlay 将领域存储隔离到 `$DSH_HOME/graphs-ui-smoke/storages`，仅替换外部模型。对其认证 URL 运行 `node packages/ui/tests/graphs-web-smoke.mjs "$DSH_URL" top.png inside.png`。检查路由、记忆、节点分派和生产拒绝后，会恢复 Billing 的 lead 设置。

Council 需要 [Council 引擎](../council/README.zh.md)和至少两个可用席位，其中必须包含配置的主席。不可用席位显示原因且无法选择。Cancel 停止所选会话并显示其终态快照，即使重新连接失败也会保留；离开页面仅断开其流。Retry 重新连接并读取权威快照。New question 清空问题输入框并将焦点移至该输入框。Ask follow-up 将之前的问题和裁决填入可编辑的新问题，不会自动发送。

无密钥自动化浏览器检查使用新启动的、基于 web 的 `dsh` profile，并加载 [bundle 补丁](../bundle/cordis.patch.yml)、[假模型覆盖层](../core/tests/fixtures/automation-web.overlay.yml) 及[页面内目录选择器覆盖层](tests/fixtures/pin-browse-picker.overlay.yml)。测试夹具将 domain 存于 `$DSH_HOME/switchboard-automation-smoke/storages`，与其他本地 profile 分离。运行 `node packages/ui/tests/automations-web-smoke.mjs "$DSH_URL" /tmp/automations.png` 创建手动自动化并执行三次脚本化 Flow 运行；追加 `existing` 可验证保留的夹具而不再创建运行。测试比较本包的 ARIA 预期输出并捕获两种主题。示例以模型审查代替 shell 检查，因此不需要原生 sandbox 后端。

自动化列表显示 Flow 摘要、时间规则、启用/暂停/手动状态及上次结果。选择行后可查看结果条、SVG 时长图和最新在前的停止网格。中位数仅包含已结束的运行；活动运行显示已用时间，跳过和准入失败的时长为零。网格中的亮绿色表示循环后恢复，红色表示失败，提示统计失败运行的停止区块。刷新读取新的计划运行，并重新连接选中活动运行的 `followRuns` 订阅。流结束或失败后一秒重连；待准入预留会轮询，直到 FlowRun 存在。刷新请求在进行中的读取后合并，不丢弃其结果；下一次重试等待这些读取结束。切换选择或卸载页面会中止订阅并清除重试。读取失败时保留已有数据。立即运行和启用要求运行前检查通过，操作旁显示首个错误。抽屉预览运行前检查，并在保存前再次检查；未通过检查的 Flow 仅能以暂停状态保存。声明的输入（包括 `workspace`）显示在 JSON 编辑器中，并作为普通输入值持久化。抽屉保留保存失败的草稿，并约束和恢复焦点；删除需要确认，结果通过应用级提示显示。

Run 输入的 `workspace` 默认使用当前 Session 的工作目录。没有当前 Session 时，须显式输入现有绝对目录。Validate 同时显示结构验证和当前预检诊断。Save 在写入完成前禁用 Refresh 和配方切换。使用 Tab 和 Enter 选择图中的节点或边，即可在检查器中编辑或删除。在节点和边之间切换时会保留最新选择。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[浏览器入口](src/client/index.ts) 挂载 core 和 Council 生成的 Remote 贡献。各展示插件按声明生命周期注入 `sidebar.panellist` 和键控 `main`。[Council 页面](src/client/CouncilPage.tsx) 按序折叠流事件，并读取最终快照以获取投票和主席用量。切换会话会释放跟随流并忽略延迟读取。外围控件使用语义 token；原创 CSS/SVG 议事厅采用固定暗色调、支持减少动态效果，并在议事厅宽度低于 900px 时将席位改为列表布局。

[浏览器入口](src/client/index.ts) 挂载生成的 Remote 方法。[页面和侧栏注册](src/client/flows-presentation.ts) 向组件传递普通命令和框架绑定的可观察数据。XYFlow 按 MIT 许可私有打包；CSS Modules 使用共享主题 token。配方保存和编辑器位置分别写入，活动运行保留其配方快照。引用计数模型在重试间共享 `followRuns` 观察；关闭侧栏会保留卡片订阅，不会取消执行。人工检查点进度使用最近一次访问，包括重复的零轮次记录。聊天卡片来自持久化的 `run_flow` 结果元数据，并遵循原生已完成轮次和工具的展开控件。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Switchboard 包](../../README.md) — 包结构与许可证。

<a id="model-experience"></a>
## 模型体验

通过普通 Conversation 输入框、[Council 引擎的模型请求](../council/README.zh.md#model-experience)和 [core](../core/README.zh.md#model-experience) 间接生效；输入框将最终转录作为用户输入提交，core 将自动化输入渲染为 Flow 提示并记录日志。浏览器不添加独立的模型指令。

#### KV 缓存影响

转录提交追加普通用户输入；页面导航、部分转录、设置、播放和 Ping 结果不会更改聊天模型上下文。提交的 Council 后续提问以可见、可编辑的文本包含之前的问题和裁决。

## 已知限制与待办工作
<a id="known-limitations-and-deferred-work"></a>

- **浏览器支持** — Web Speech 识别和麦克风录音依赖浏览器支持、安全上下文、权限以及供应商可用性。OpenAI 录音没有部分转录。实时音频和播放需要手动检查权限和设备。
- **输入框所有权** — Switchboard 使用单一 `conversation.input.activity` 槽位；同一 profile 不应挂载其他语音输入活动。开始按住前必须发送或清空现有草稿。提交失败由普通输入框处理。
- **引擎元数据** — 席位角色为主席或顾问；主席身份仅在受理后可用。Host 验证是否包含主席。进行中的会话重新连接后显示等待，直到收到新的席位事件；投票和主席 token 用量随最终快照到达。
- **用量** — 原生席位显示用量不可用，不显示零。LLM 总量包括回答、投票和主席调用；不完整的统计会明确标注。不显示美元估算。
- **工作区集成** — Flows 和 Automations 编辑器是独立贡献。Graphs 使用自己的 SVG 画布，在分派前需要明确的卡片工作区路径。聊天、语音及 webhook 调用方可通过 Remote API 创建卡片；未安装自动接入和 Council 的 Send to Graphs 操作。
- **英文文案** — 未提供中文界面翻译。
- **自动化运行管理** — 自动化可以启动运行，但不处理人工检查点或取消运行；请使用 Flow 侧栏或 core Remote API。
- **历史** — 图表显示最近 20 次触发。新的计时触发需要刷新后显示；选中的已知活动运行会流式更新。

- **Session 所属侧栏** — 打开运行会切换到 Conversation，复用已查看的运行 Session，或创建不触发模型轮次的空 Session。侧栏没有分组标题 API，因此 Flows 紧邻 Switchboard。
- **草稿** — 未保存的编辑只存在于挂载的页面中。切换已保存的 Flow 会请求确认；离开页面会丢弃草稿。编辑器保留配方输入和执行限制，但不提供这些字段的编写控件。
- **独立位置存储** — 布局位于独立的 `switchboard_layout` 域中。配方成功保存后，布局仍可能保存失败；草稿会保持未保存状态以供重试。运行图自动布局捕获的配方，不跟随之后的位置编辑。
- **无密钥浏览器验证** — 将 `DSH_HOME` 设置为已初始化的可丢弃 Switchboard 目录后，`node packages/ui/tests/flows-web-smoke.mjs /tmp/switchboard-shots` 会启动真实 profile、替换为脚本模型、比较包内 ARIA 并捕获两种主题。预览将示例的 shell 检查替换为脚本 Agent，因此不验证 shell 执行。夹具保留本地 Session 和运行记录以供检查。

<a id="dev-note"></a>
### 开发备注

无。
