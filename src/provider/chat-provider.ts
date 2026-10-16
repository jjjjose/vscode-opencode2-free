import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

import type { LoggerLike } from '../log';
import { deriveRequestIDs } from '../zen/ids';
import { buildChatBody, type WireMessage } from '../zen/payload';
import { ZenError } from '../zen/errors';
import type { ZenClient } from '../zen/client';
import type { ModelCatalog } from '../zen/catalog';
import { buildModelInformation, isVisionModel } from './model-information';
import { convertMessages } from './message-converter';
import { aggregateStream } from './response-aggregator';
import { countTokensForMessage, countTokensForText } from './token-counter';
import { toUsagePayload } from './usage';
import { resolveModelSelection } from './model-variants';

/**
 * Proveedor de modelos OpenCode Free para el selector de chat de VS Code.
 *
 * Implementa el contrato estable `LanguageModelChatProvider` (VS Code ≥1.106):
 * descubrir modelos, responder en streaming respetando la cancelación, y
 * contar tokens. La ejecución de herramientas la mantiene VS Code; aquí solo
 * se reenvían las definiciones y se reportan las llamadas del modelo.
 */

export interface RequestTuning {
  firstEventTimeoutMs: number;
  idleEventTimeoutMs: number;
  maxRetries: number;
}

export interface ProviderOptions {
  catalog: ModelCatalog;
  client: ZenClient;
  log: LoggerLike;
  getTuning: () => RequestTuning;
}

export class OpenCodeFreeChatProvider implements vscode.LanguageModelChatProvider {
  readonly #catalog: ModelCatalog;
  readonly #client: ZenClient;
  readonly #log: LoggerLike;
  readonly #getTuning: () => RequestTuning;

  readonly #onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this.#onDidChange.event;

  #signature: string;

  constructor(options: ProviderOptions) {
    this.#catalog = options.catalog;
    this.#client = options.client;
    this.#log = options.log;
    this.#getTuning = options.getTuning;
    this.#signature = this.#catalog.signature();
  }

  /**
   * Refresca el selector solo cuando la lista expuesta cambió de verdad
   * (evita tormentas de relecturas cada ciclo del catálogo).
   */
  notifyCatalogRefresh(): void {
    const next = this.#catalog.signature();
    if (next === this.#signature) return;
    this.#signature = next;
    this.#log.info(`catálogo actualizado: ${this.#catalog.snapshot().exposed} modelos disponibles`);
    this.#onDidChange.fire();
  }

  dispose(): void {
    this.#onDidChange.dispose();
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (token.isCancellationRequested) return [];
    // En modo silencioso se responde al instante (lista en caché/estática);
    // en modo interactivo se espera (acotadamente) al primer fetch en vivo.
    if (!options.silent) {
      await this.#catalog.warm(4_000);
    }
    if (token.isCancellationRequested) return [];
    return buildModelInformation(this.#catalog);
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) return;

    const selection = resolveModelSelection(this.#catalog, model.id);
    const supportsImages = isVisionModel(selection.modelId, this.#catalog.modalities(selection.modelId));
    const conversation = convertMessages(messages, { modelId: selection.modelId, supportsImages });

    if (conversation.messages.length === 0) {
      throw new Error('OpenCode Free: no hay mensajes que enviar.');
    }

    const declaredTools = (options.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    }));
    const declaredNames = new Set(declaredTools.map((tool) => tool.name));
    const toolChoice: 'auto' | 'required' =
      options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';

    const requestId = randomUUID();
    const body = buildChatBody({
      model: selection.modelId,
      reasoningEffort: selection.effort,
      ...(conversation.system !== undefined ? { system: conversation.system } : {}),
      messages: conversation.messages,
      tools: declaredTools,
      toolChoice,
      onToolsAdjusted: (info) => {
        const notes = [`herramientas=${info.declared} → ${info.final} en la petición`];
        if (info.injected.length > 0) notes.push(`stubs=${info.injected.join('+')}`);
        if (info.dropped.length > 0) notes.push(`recortadas=${info.dropped.join(', ')}`);
        this.#log.info(`[${requestId}] ajuste de herramientas: ${notes.join(' · ')}`);
      },
    });

    const ids = deriveRequestIDs(
      conversation.messages.map((message: WireMessage) => ({
        role: message.role,
        content: 'content' in message ? message.content : '',
      })),
    );

    const tuning = this.#getTuning();
    const controller = new AbortController();
    const cancelSubscription = token.onCancellationRequested(() => controller.abort());

    const startedAt = Date.now();
    let reportedParts = 0;
    const report = (part: vscode.LanguageModelResponsePart): void => { progress.report(part); reportedParts++; };
    let firstByteLogged = false;

    try {
      this.#log.info(
        `[${requestId}] petición → proveedor=opencode-free modelo=${selection.modelId} variante=${selection.effort ?? 'predeterminada'} mensajes=${conversation.messages.length} herramientas=${declaredTools.length}`,
      );
      this.#log.debug(`[${requestId}] estructura=${JSON.stringify(messages.map(message => ({
        role: message.role,
        parts: message.content.map(part => {
          const value = part as unknown as { value?: unknown; mimeType?: string; callId?: string; content?: unknown[]; audience?: number[] };
          return { type: value.mimeType ? 'data' : value.callId ? value.content ? 'tool-result' : 'tool-call' : typeof value.value === 'string' ? 'text' : 'other',
            chars: typeof value.value === 'string' ? value.value.length : undefined, mimeType: value.mimeType, audience: value.audience };
        }),
      })))}`);
      const events = this.#client.streamChat(body, {
        ids,
        signal: controller.signal,
        firstEventTimeoutMs: tuning.firstEventTimeoutMs,
        idleTimeoutMs: tuning.idleEventTimeoutMs,
        maxRetries: tuning.maxRetries,
      });

      const summary = await aggregateStream(events, declaredNames, {
        text: (delta) => {
          if (!firstByteLogged) {
            firstByteLogged = true;
            this.#log.debug(`primer texto a los ${Date.now() - startedAt} ms`);
          }
          report(new vscode.LanguageModelTextPart(delta));
        },
        toolCall: (call) => report(new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input)),
        note: (text) => report(new vscode.LanguageModelTextPart(text)),
        usage: (measured) => {
          // El chat usa este part (mime «usage») para el medidor de contexto
          // y la compactación; la forma imita el uso estilo OpenAI.
          const payload = toUsagePayload(measured);
          if (payload !== undefined) report(vscode.LanguageModelDataPart.json(payload, 'usage'));
        },
      });

      const usage = summary.usage;
      this.#log.info(
        `[${requestId}] respuesta ← ${Date.now() - startedAt} ms · partes=${reportedParts} · texto=${summary.textLength} car. · razonamiento=${summary.reasoningLength} car. · herramientas=${summary.toolCalls.length}` +
          (summary.dropped.length > 0 ? ` · descartadas=${summary.dropped.map((entry) => entry.name || '(sin nombre)').join(',')}` : '') +
          (usage ? ` · tokens=${usage.inputTokens}/${usage.outputTokens}${usage.cacheReadTokens !== undefined ? ` · caché=${usage.cacheReadTokens}` : ''}` : '') +
          (summary.finishReason !== null ? ` · fin=${summary.finishReason}` : ''),
      );
      if (summary.finishReason === 'length' && summary.textLength > 0) {
        this.#log.warn('la respuesta llegó al límite de tokens de salida del modelo (respuesta truncada)');
      }
    } catch (err) {
      this.#log.info(`[${requestId}] fin con error · partes=${reportedParts} · cancelado=${token.isCancellationRequested} · duración=${Date.now() - startedAt}ms`);
      if (controller.signal.aborted && token.isCancellationRequested) return;
      if (err instanceof ZenError) {
        this.#log.error(`[${requestId}] error del lane anónimo (${err.kind}): ${err.message}`);
        throw toLanguageModelError(err);
      }
      this.#log.error(`[${requestId}] ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      cancelSubscription.dispose();
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') return countTokensForText(text);
    return countTokensForMessage(text);
  }
}

/**
 * Traduce un ZenError a los errores que VS Code sabe interpretar.
 * `RateLimited` existe en runtime aunque no en los tipos estables: se accede
 * de forma defensiva para conservar Retry-After cuando esté disponible.
 */
function toLanguageModelError(err: ZenError): Error {
  const message = err.message;
  switch (err.kind) {
    case 'region':
    case 'free-tier':
      return vscode.LanguageModelError.Blocked(message);
    case 'not-found':
      return vscode.LanguageModelError.NotFound(message);
    case 'rate-limit': {
      const ctor = (vscode.LanguageModelError as unknown as {
        RateLimited?: (message?: string, retryAfter?: number) => Error;
      }).RateLimited;
      if (typeof ctor === 'function') {
        const retryAfterSeconds =
          err.retryAfterMs !== undefined ? Math.max(1, Math.ceil(err.retryAfterMs / 1000)) : undefined;
        return ctor(message, retryAfterSeconds);
      }
      return new vscode.LanguageModelError(message);
    }
    default:
      return new vscode.LanguageModelError(message);
  }
}
