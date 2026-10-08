---
description: "将 Switchboard 添加到基于 web 的 profile，默认禁用会话上传、包清单报告和 Session 遥测。"
kind: "package-bundle"
---

# @switchboard/bundle

[English](README.md) | 中文

## 概述

为基于 web 的 profile 添加 Switchboard 侧栏页面和 Host 连接检查。此可选 bundle 在组合配置中禁用 DeepSeek 会话日志上传、DeepSeek 包清单报告和 OpenTelemetry Session 遥测。它不阻止后续 profile 或命令行覆盖。

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

从已构建的仓库根目录运行。指定的 home 将此开发 profile 与 `~/.dsh` 隔离；第一个命令创建 profile 而不启动服务器。如果 profile 已存在，请跳过该命令。

```sh
export DSH_HOME="$HOME/.switchboard-dev/dsh-home"
pnpm dsh --profile switchboard --from-default-profile web --dump-config
pnpm dsh plugin --profile switchboard add "$PWD/packages/bundle"
pnpm dsh --profile switchboard --dump-config
pnpm dsh --profile switchboard --host 127.0.0.1 --port 3091 --no-open
```

打开最后一个命令输出的认证 URL。点击 **Switchboard** 即可看到 **Connected**、成功的 Ping 和三个工作区占位区域。使用 Ctrl-C 停止服务器。`--dump-config` 显示 `switchboard-core`、`switchboard-ui`、`session-log-deepseek.config.enabled: false`、`plugin-package-inventory-deepseek.config.enabled: false` 和 `session-telemetry-otel.disabled: true`。

此 bundle 还挂载 [Council](../council/README.zh.md) 和配置为 `permissionMode: plan` 的专用 `claude-code-council` 提供方。打开 **Council** 可使用[议事厅界面](../ui/README.zh.md)；原生 Codex 席位仍不可用。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

清单中的 `dsh.bundle.patch` 指向 [cordis.patch.yml](cordis.patch.yml)。组合器插入 [core](../core/README.zh.md) 和 [UI](../ui/README.zh.md) 行，并按 id 覆盖三个现有隐私配置行。本包将插入的插件声明为依赖，以便 profile 解析其裸包名。Profile、home 和命令行 patch 层均可覆盖这些默认值。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Switchboard 包](../../README.md) — 包结构与许可证。

<a id="model-experience"></a>
## 模型体验

无，因为此 bundle 只组合插件；Council 包负责自己的模型请求。

#### KV 缓存影响

组合本身没有影响；Council 调用的 token 影响由其所属包记录。

## 已知限制与待办工作
<a id="known-limitations-and-deferred-work"></a>

- **基于 web 的 profile** — UI 需要 web 组合中的传输、语言、布局和插槽所有者。
- **默认值并非网络防火墙** — 这三项覆盖不会禁用所有上游网络功能，后续配置层也可重新启用它们。

<a id="dev-note"></a>
### 开发备注

无。
