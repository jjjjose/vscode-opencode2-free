# OpenCode Free Chat

[English](./README.md) | [Español](./README.es.md) | **中文**

VS Code 扩展，将免费的 **OpenCode Zen** 模型添加到 VS Code 原生聊天模型选择器（Copilot Chat）中，无需 API 密钥：它使用 OpenCode 的公共匿名 *lane*（`Bearer public`），与 OpenCode CLI 采用相同的协议。

```
VS Code 聊天 ──▶ LanguageModelChatProvider ──▶ Zen 客户端（流式传输、取消）
                                                        │
                                                        ▼
                                          https://opencode.ai/zen/v1
```

## 要求

- VS Code **1.106** 或更高版本。
- 用于选择模型的内置聊天面板（Copilot Chat）。

## 使用方法

1. 打开聊天（macOS 上为 `⌃⌘I`）。
2. 在模型选择器中，选择 **OpenCode Free** 提供程序下的任意模型（例如 `big-pickle`、`mimo-v2.6-flash-free`、`deepseek-v4.1-flash-free`）。
3. 正常对话即可：流式传输、多轮对话、图片（在支持的模型上）和工具（智能体模式）都通过 VS Code 标准 API 工作。

无需任何配置。模型目录每 5 分钟自动刷新。lane 返回的用量（输入、输出和缓存 token）会转发给聊天，因此上下文计量和自动压缩对这些模型同样有效。

### 智能体会话（Copilot CLI）

智能体会话不会直接使用你输入窗口的提供程序：智能体宿主发布**单个服务窗口**的 BYOK 模型（第一个拥有可用模型的窗口）。因此，要在智能体会话选择器中看到「OpenCode Free」：

1. 将扩展安装到常规配置文件（VSIX 或 Marketplace），而不能只按 **F5**：开发窗口不会向智能体宿主提供模型。
2. 安装或更新后重新加载窗口：扩展加载时宿主才会发布模型。
3. 在 **OpenCode Free** 分组下选择模型。其他扩展可能在别的分组中提供相同的模型名称，选择时请注意分组。
4. **如果某个回合立刻以「No response was returned」结束**，且「OpenCode Free」输出通道中**没有**任何 `petición →` 行，说明该回合在到达提供程序*之前*就被拦截了。这是 VS Code 智能体宿主的已知限制（[vscode#336797](https://github.com/microsoft/vscode/issues/336797)、[vscode#336980](https://github.com/microsoft/vscode/issues/336980)）：静态上下文检查（系统提示词 + 工具定义）会与模型的预算比较，当 MCP 服务器很多时，仅定义本身就会超出预算（[copilot-cli#5151](https://github.com/github/copilot-cli/issues/5151)）。这些会话的可选方案：选择免费的大窗口模型（例如 **Space Bunny**、**LongCat 2.5 Preview**、**Nemotron 3.5 Super VL** 或 **Cat Jam**，约 1M token）、停用不需要的 MCP 服务器（GitHub MCP 通常贡献的定义最多），或使用该窗口的聊天/智能体（工具会被延迟下发）。通道中缺少 `petición →` 可以区分这种情况：没有该行说明拦截来自宿主。选择器会在详情中用「⚠」标记窗口紧张的模型（悬停提示会解释原因），命令 `OpenCode Free: El agente no responde` 提供快捷操作：选择模型、打开工具选择器或查看日志。

此外，lane 上游会拒绝携带超过 128 个工具的请求：如果会话提供的工具更多，扩展会裁剪末尾的工具直至 128 个（在确保 `bash`+`read` 存根之后），并在通道中记录此次调整（`ajuste de herramientas: …`）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `OpenCode Free: Gestionar` | 快速选择（也是模型选择器中的管理按钮）。 |
| `OpenCode Free: Actualizar modelos` | 立即强制刷新模型目录。 |
| `OpenCode Free: Mostrar diagnóstico` | 将目录、各模型的判定和设置转储到输出通道。 |
| `OpenCode Free: El agente no responde` | 智能体会话卡住（静态上下文）指南，附快捷操作：选择模型、打开工具选择器、查看日志。 |
| `OpenCode Free: Mostrar registros` | 打开「OpenCode Free」输出通道。 |

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `opencode-free.catalog.refreshMinutes` | `5` | 模型目录刷新间隔（分钟）。 |
| `opencode-free.request.firstEventTimeoutSeconds` | `30` | 等待 Zen 响应（响应头和首个事件）的最长时间。 |
| `opencode-free.request.idleTimeoutSeconds` | `120` | 中止前允许的流最大空闲时长。 |
| `opencode-free.request.maxRetries` | `3` | 在收到任何内容**之前**针对 429/故障的重试次数。 |
| `opencode-free.debug` | `false` | 详细日志（不记录对话内容）。 |

## 工作原理

### 模型发现

动态目录，没有模型名单，也没有限额覆盖：

1. **S1 — 实时目录**：`GET {zen}/v1/models`，使用 `Authorization: Bearer public`。
2. **S2 — 元数据**：`https://models.dev/api.json` 提供价格、上下文/输出限额、推理能力和模态。明确的判定优先：如果某模型被标为付费，即使名称带 `-free` 也不会宣传为免费。缓存存放于扩展的全局存储，有效期 7 天。
3. **目录缓存**：网络故障时保留最后一次有效列表（最长 7 天）。一次有效刷新无需重装即可纳入新增、移除和修改；有效的空列表会撤下所有模型；格式错误的响应则保留上一次列表。

OpenCode 自带的元数据（如存在）优先于 models.dev。它会发布名称、声明的家族/版本、最大输入、输出和能力。总上下文显示在悬停提示中。元数据变化会更新选择器，即使标识符没有变化。声明为非 OpenAI 兼容的适配器会因兼容性被排除；若未声明，则尝试 Chat Completions，不被支持时保留服务返回的错误。

在缺少限额时——仅限元数据仍在加载的过渡阶段——会使用明确标注为估算值的回退数据：8192 上下文 token 和 2048 输出 token。元数据加载完成后，不在其中出现的模型**不会**出现在选择器中：宁可不公布虚构的限额，因为不真实的预算会让 VS Code 智能体模式以「静态上下文超限」中止回合（在诊断中显示为 `metadata_model_missing`）。没有独立的输入限额时使用上下文窗口。绝不虚构变体或能力。token 计数为近似值（UTF-8 字节数/4、消息开销以及每张图片 1536 token 的预留），并非按模型的精确分词器。

### 匿名「lane」

服务要求一种复制 OpenCode CLI 的具体格式（该矩阵已在参考项目 [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) 上验证，本项目据此调整协议）：

- **规范**会话 id：`ses_` + 12 位十六进制 + 14 位 base62，毫秒时钟倒序放入前 12 位十六进制。每次对话铸造一次（由首个回合派生）并复用以保持缓存亲和性。
- 请求体包含 `stream: true` 和智能体形式的 `tools` 数组：始终添加 `bash` 和 `read` 存根（"Reserved for the host runtime; do not call it."）。当请求本身不带自有工具时发送 `tool_choice: "none"`，使模型永不调用它们；当聊天处于智能体模式时，会转发 VS Code 的真实工具，并**丢弃**对未声明名称的调用（包括存根）。
- 与 CLI 完全相同的关联请求头（`x-opencode-client: cli`、`x-opencode-session`、`x-session-affinity`、`X-Session-Id`、`x-opencode-request`、`x-opencode-project`、`user-agent: opencode/…`）。

> 这些要求来自对参考客户端的观察，而不是已发布的契约：OpenCode 可能随时更改它们。若发生这种情况，扩展会以清晰的错误信息失败。

### 健壮性

- 对 429/5xx 采用指数退避 + 抖动**重试**，遵守 `Retry-After`，且仅在内容到达之前重试（部分响应绝不重放）。
- **存活看门狗**：到响应头/首个事件的最长时间，以及响应体的最大空闲时长。
- **取消**：VS Code 的 `CancellationToken` 中止链式 HTTP 请求。
- **类型化错误**：`LanguageModelError.Blocked`（区域/层级）、`RateLimited`（可用时带 `Retry-After`）、`NotFound`，以及带建议操作的西班牙语错误信息。

## 诊断

如果某项功能不出现出错：

1. `OpenCode Free: Mostrar diagnóstico` —— 目录状态、各模型的判定和设置。
2. `OpenCode Free: Mostrar registros` —— 请求轨迹（模型、耗时、token、错误）。启用 `opencode-free.debug` 可查看更多细节。绝不记录消息内容。
3. 如果某个模型返回 403/429，请在选择器中换一个试试：免费 lane 拥挤，部分模型对区域敏感。

## 开发

```bash
npm install
npm run compile      # tsc → out/
npm test             # vitest：动态目录、SSE、客户端、转换与集成测试
node scripts/smoke.mjs big-pickle   # 对 opencode.ai 的真实运行（需要网络）
```

要在 VS Code 中试用：打开本文件夹并按 **F5**（「运行扩展（Extension Development Host）」启动配置）。在新窗口中打开聊天并选择一个「OpenCode Free」模型。开发宿主为该窗口的聊天提供服务；**智能体会话**要求扩展安装在常规配置文件中（见「智能体会话」）。

打包：执行 `npx vsce package` 并安装生成的 `.vsix`。

## 已知限制

- 仅实现 **Chat Completions** 协议；按声明的适配器过滤，不使用名称名单。
- 没有推理力度选择器：带推理的模型使用其默认行为（推理内容不在聊天中显示）。
- VS Code 稳定版 API 仍不允许提供程序上报 token 用量；实际用量只保存在日志中。
- 匿名 lane 是没有服务水平协议的公共服务：可能限流、按区域封锁或下线模型。

## 法律声明

本项目与 OpenCode 无关联。它使用 OpenCode CLI 自身所使用的公共匿名访问；大量使用前请查阅 OpenCode Zen 的服务条款。

## 许可证

MIT。协议和设计的部分内容改编自 [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)（MIT，© 2026 FishBottle7）和 opencode2api。参见 `LICENSE`。
