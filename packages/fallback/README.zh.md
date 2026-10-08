---
description: "配置原生请求重试耗尽后从 DeepSeek 到 OpenRouter 的回合内回退，并在会话日志中检查实际提供方归属。"
kind: "package-reference"
---

# @switchboard/fallback

[English](README.md) | 中文

## 概述

当 DeepSeek 因暂时性故障耗尽原生恢复机制时，通过 OpenRouter 继续智能体回合。除非用户选择其他模型，否则下一回合重新尝试主路由。回退可能将对话历史发送给另一提供方并产生费用；配额耗尽触发的切换需要显式启用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

将此 Host 插件与智能体注册表、循环、原生重试插件及已配置的提供方适配器一同挂载。此包不注册适配器或配置凭据；请通过 dsh 的 `llm-pi-ai` 包 配置 OpenRouter。

```yaml
- name: '@switchboard/fallback'
  config:
    enabled: true
    primaryProviders: [deepseek-official]
    fallbackProvider: openrouter
    modelMap:
      deepseek-v4-flash: deepseek/deepseek-v4-flash
      deepseek-v4-pro: deepseek/deepseek-v4-pro
    fallbackOnQuota: false
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 安装回退监听器。 |
| `primaryProviders` | `['deepseek-official']` | 允许回退的源提供方路由。 |
| `fallbackProvider` | `'openrouter'` | 已注册的替代路由。 |
| `modelMap` | 上述两项 | 精确的源模型到目标模型映射；未映射的模型不会回退。 |
| `fallbackOnQuota` | `false` | 也允许因 `QUOTA` 回退。 |

原生恢复先运行。下游重试决定优先，包括无限原生重试策略。终止性的 `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT` 和 `EMPTY_RESPONSE` 故障允许每个智能体回合回退一次。`AUTH`、`INVALID_REQUEST`、`ABORTED` 和 `CONTEXT_WINDOW_EXCEEDED` 绝不触发回退。替代请求失败时使用其提供方自身的原生重试策略，但同一回合不能再次触发回退。

回退移除 `stop` 和 `reasoningEffort`：pi-ai 拒绝停止序列，而推理强度标识属于具体模型。温度和显式输出 token 上限保持不变。下一回合仅在最终路由为原始主路由时恢复主请求的停止序列；显式模型选择保留优先权。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

[插件](src/index.ts) 包裹 `agent/request-error` 和 `agent/request`。待处理决定会在本回合剩余期间替换选定路由。恢复监听器在下一回合于现有模型选择监听器内部运行，因此模型选择保留优先权。智能体或插件释放时移除待处理状态和监听器。

核心记录替代请求头，并将助手响应归属于实际提供方和模型。插件在安排回退时发出进程内 `switchboard/fallback` Cordis 事件和 info 日志，不追加自定义会话事件。事件携带会话标识、回合、步骤、源路由、目标路由和故障代码。它表示已安排一次尝试，而非恢复成功。同步通知观察者的异常会被记录，且不会阻止替代请求。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Switchboard 包](../../README.md) — 包结构与许可证。

-----

<a id="model-experience"></a>
## 模型体验

### 替代请求

#### 模型看到什么

替代提供方收到循环重建的对话历史和工具。失败的 `assistant/attempt` 事件仅留在日志中；此插件不添加提示文本或工具定义。在回退生效的回合内，若实际路由与上一次请求相同，`agent/pre-step` 会移除模型选择通知，保留所有其他消息。下一回合真正切回主路由时仍保留切换通知。

#### Token 影响

回退在另一提供方重复请求，消耗该提供方的输入和输出 token，此外主请求失败尝试也可能产生用量。

#### KV 缓存影响

切换提供方或模型不会保留提供方侧缓存复用。后续回合恢复主路由也会改变请求路由；缓存是否可用由提供方决定。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 回退状态仅属于存活的智能体，不持久化。重启、恢复会话或卸载插件不会恢复之前记住的主路由；调用方必须在创建智能体时提供所需路由。
- 直接调用 `ctx.llm.stream()`，包括辅助标题或压缩请求，不经过智能体恢复，因此不会回退。
- 提供方注册、凭据、模型可用性、图像兼容性和输出 token 容量由部署方负责。假适配器测试不验证 OpenRouter 的实时可用性。
- 模型选择监听器必须在恢复开始前安装，上游智能体设置即如此。后安装的路由包裹器必须保留插件的回合内替换。
- 应用事件和 info 日志不是持久化的回退原因记录，也不是 UI 通知。持久化归属信息由核心请求头和助手消息提供。

### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
