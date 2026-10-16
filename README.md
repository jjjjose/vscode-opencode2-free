# OpenCode Free Chat

**English** | [Español](./README.es.md) | [中文](./README.zh.md)

VS Code extension that brings free **OpenCode Zen** models to the native chat model picker (Copilot Chat), with no API keys: it uses OpenCode's public anonymous *lane* (`Bearer public`), speaking the same protocol as the OpenCode CLI.

```
VS Code chat ──▶ LanguageModelChatProvider ──▶ Zen client (streaming, cancellation)
                                                        │
                                                        ▼
                                          https://opencode.ai/zen/v1
```

## Requirements

- VS Code **1.106** or later.
- The built-in chat panel (Copilot Chat) to pick a model.

## Usage

1. Open the chat (`⌃⌘I` on macOS).
2. In the model picker, choose any model under the **OpenCode Free** provider (e.g. `big-pickle`, `mimo-v2.6-flash-free`, `deepseek-v4.1-flash-free`).
3. Chat as usual: streaming, multi-turn, images (on models that support them) and tools (agent mode) all work through the standard VS Code API.

There is nothing to configure. The catalog refreshes itself every 5 minutes. The usage reported by the lane (input, output and cache tokens) is forwarded to the chat, so the context meter and auto-compaction work with these models too.

### Reasoning variants

When the catalog declares reasoning levels, the picker includes entries such as `Model (low)` or `Model (max)`. Select one to send that level; the entry without a suffix uses the provider default. Names and levels come dynamically from OpenCode/models.dev metadata, with no fixed list or invented levels for models that do not declare them.

Each refresh automatically adds or removes variants. Use **OpenCode Free: Actualizar modelos** to refresh immediately. Network failures retain the last valid cache. If a selected variant disappears after a successful refresh, the extension asks you to choose another before sending the request.

### Agent sessions (Copilot CLI)

Agent sessions do not use the providers of the window you type in directly: the agent host publishes the BYOK models of a **single serving window** (the first one with available models). That is why, to see "OpenCode Free" in the agent session picker:

1. Install the extension in your normal profile (VSIX or Marketplace), not just with **F5**: development windows do not serve models to the agent host.
2. Reload the window after installing or updating: the host publishes the models when the extension loads.
3. Pick the model under the **OpenCode Free** group. Other extensions may offer the same model names in a different group, so check the group when selecting.
4. **If a turn ends instantly with "No response was returned"** and the "OpenCode Free" output channel shows **no** `petición →` line, the turn was blocked *before* reaching the provider. This is a known limitation of the VS Code agent host ([vscode#336797](https://github.com/microsoft/vscode/issues/336797), [vscode#336980](https://github.com/microsoft/vscode/issues/336980)): the static context check (system prompt + tool definitions) is compared against the model's budget and, with many MCP servers, the definitions alone exceed it ([copilot-cli#5151](https://github.com/github/copilot-cli/issues/5151)). Options for those sessions: pick a free large-window model (e.g. **Space Bunny**, **LongCat 2.5 Preview**, **Nemotron 3.5 Super VL** or **Cat Jam**, ~1M tokens), disable MCP servers you don't use (the GitHub MCP usually contributes the most definitions), or use that window's chat/agent, where tools are deferred. The absence of `petición →` in the channel distinguishes this case from the provider: no line means the cut comes from the host. The picker flags tight-window models with "⚠" in the details (the tooltip explains why) and the `OpenCode Free: El agente no responde` command offers the shortcuts: pick a model, open the tool picker or view the log.

Also, the lane upstream rejects requests with more than 128 tools: if the session provides more, the extension trims the last ones down to 128 (after securing the `bash`+`read` stubs) and logs the adjustment in the channel (`ajuste de herramientas: …`).

## Commands

| Command | What it does |
| --- | --- |
| `OpenCode Free: Gestionar` | Quick pick (also the manage button in the model picker). |
| `OpenCode Free: Actualizar modelos` | Forces an immediate catalog refresh. |
| `OpenCode Free: Mostrar diagnóstico` | Dumps the catalog, per-model decisions and settings to the output channel. |
| `OpenCode Free: El agente no responde` | Guide to the agent-session stall (static context) with shortcuts: pick a model, open the tool picker and view the log. |
| `OpenCode Free: Mostrar registros` | Opens the "OpenCode Free" output channel. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `opencode-free.catalog.refreshMinutes` | `5` | Catalog refresh cadence (minutes). |
| `opencode-free.request.firstEventTimeoutSeconds` | `30` | Maximum wait for Zen to respond (headers and first event). |
| `opencode-free.request.idleTimeoutSeconds` | `120` | Maximum stream inactivity before aborting. |
| `opencode-free.request.maxRetries` | `3` | Retries on 429/failures **before** any content is received. |
| `opencode-free.debug` | `false` | Verbose logging (no conversation content). |

## How it works

### Model discovery

A dynamic catalog, with no model lists or limit overrides:

1. **S1 — live catalog**: `GET {zen}/v1/models` with `Authorization: Bearer public`.
2. **S2 — metadata**: `https://models.dev/api.json` provides pricing, context/output limits, reasoning and modalities. An explicit verdict wins: if a model appears as paid, it is not advertised as free even if it is called `-free`. The cache lives in the extension's global storage with a 7-day expiry.
3. **Catalog cache**: the last valid listing survives network failures (up to 7 days). A valid refresh incorporates additions, removals and changes without reinstalling. A valid empty listing withdraws every model; a malformed response keeps the previous one.

OpenCode's own metadata, when available, takes precedence over models.dev. It publishes the name, declared family/version, max input, output and capabilities. Total context appears in the tooltip. Metadata changes update the picker even when identifiers do not change. Adapters declared as anything other than OpenAI-compatible are excluded for compatibility; with no declaration, Chat Completions is attempted and the service's own error is kept when it is not supported.

When limits are missing — only during the transient phase in which metadata is still loading — an explicitly estimated fallback of 8192 context tokens and 2048 output tokens is used. Once metadata has loaded, a model that does not appear in it **is not exposed** in the picker: it is better not to advertise invented limits, because an unrealistic budget makes VS Code agent mode abort turns with "static context exceeded" (surfaced in diagnostics as `metadata_model_missing`). When there is no independent input limit, the context window is used. Variants and capabilities are never invented. Token counting is approximate (UTF-8 bytes/4, message overhead and a 1536-token reserve per image), not an exact per-model tokenizer.

### The anonymous "lane"

The service requires a concrete shape that replicates the OpenCode CLI (a matrix verified against the reference project [opencode2dsh](https://github.com/FishBottle7/opencode2dsh), from which this project adapts the protocol):

- A **canonical** session id `ses_` + 12 hex + 14 base62, with the millisecond clock reversed into the 12 hex. It is minted once per conversation (derived from the first turn) and reused to preserve cache affinity.
- A body with `stream: true` and an agent-shaped `tools` array: the `bash` and `read` stubs are always added ("Reserved for the host runtime; do not call it."). When the request carries no tools of its own, `tool_choice: "none"` is sent so the model never invokes them; when the chat is in agent mode, the real VS Code tools are forwarded and calls to undeclared names are **dropped** (stubs included).
- Correlation headers identical to the CLI's (`x-opencode-client: cli`, `x-opencode-session`, `x-session-affinity`, `X-Session-Id`, `x-opencode-request`, `x-opencode-project`, `user-agent: opencode/…`).

> These requirements are observations from the reference client, not a published contract: OpenCode may change them at any time. The extension fails with clear messages if that happens.

### Robustness

- **Retries** with exponential backoff + jitter on 429/5xx, honoring `Retry-After`, and only before content arrives (a partial response is never replayed).
- **Liveness watchdogs**: a maximum time to headers/first event, and a maximum body inactivity.
- **Cancellation**: VS Code's `CancellationToken` aborts the chained HTTP request.
- **Typed errors**: `LanguageModelError.Blocked` (region/tier), `RateLimited` (with `Retry-After` when available), `NotFound`, and Spanish messages with the recommended action.

## Diagnostics

If something is missing or fails:

1. `OpenCode Free: Mostrar diagnóstico` — catalog state, per-model decisions and settings.
2. `OpenCode Free: Mostrar registros` — request trace (model, timings, tokens, errors). With `opencode-free.debug` enabled there is more detail. Message content is never logged.
3. If a specific model returns 403/429, try another one from the picker: the free lane is contended and some models are region-sensitive.

## Development

```bash
npm install
npm run compile      # tsc → out/
npm test             # vitest: dynamic catalog, SSE, client, conversion and integration
node scripts/smoke.mjs big-pickle   # live run against opencode.ai (requires network)
```

To try it in VS Code: open this folder and press **F5** ("Run Extension (Extension Development Host)" launch configuration). In the new window, open the chat and pick an "OpenCode Free" model. The development host serves the chat of that window; **agent sessions** require the extension installed in your profile (see "Agent sessions").

To package: `npx vsce package` and install the generated `.vsix`.

## Known limitations

- Only the **Chat Completions** protocol is implemented; filtering by declared adapter, with no name lists.
- There is no reasoning-effort picker: reasoning models use their default behavior (reasoning content is not shown in chat).
- VS Code's stable API still does not let a provider report token usage; actual usage lives in the logs.
- The anonymous lane is a public service with no service-level agreement: it may rate-limit, block by region or retire models.

## Legal notice

This project is not affiliated with OpenCode. It uses the same public anonymous access that the OpenCode CLI itself uses; review OpenCode Zen's terms of service before heavy use.

## License

MIT. Parts of the protocol and the design are adapted from [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) (MIT, © 2026 FishBottle7) and from opencode2api. See `LICENSE`.
