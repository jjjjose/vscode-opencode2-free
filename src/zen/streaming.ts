/**
 * Lectura del stream SSE de chat-completions y traducción a eventos de alto
 * nivel. El parser es tolerante a fragmentos partidos entre paquetes y a
 * eventos multilínea (spec SSE), e ignora comentarios y campos que no sean
 * `data:`.
 */

export interface ZenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'usage'; usage: ZenUsage }
  | { type: 'done'; finishReason: string | null };

/**
 * Decodificador SSE incremental. Alimentar con texto ya decodificado; devuelve
 * las cargas `data:` completas listas para interpretar.
 */
export class SseDecoder {
  #buffer = '';
  #dataLines: string[] = [];

  push(text: string): string[] {
    this.#buffer += text;
    const payloads: string[] = [];

    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline === -1) break;
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        if (this.#dataLines.length > 0) {
          payloads.push(this.#dataLines.join('\n'));
          this.#dataLines = [];
        }
        continue;
      }
      if (line.startsWith(':')) continue; // comentario
      if (line.startsWith('data:')) {
        let value = line.slice(5);
        if (value.startsWith(' ')) value = value.slice(1);
        this.#dataLines.push(value);
        continue;
      }
      // event:, id:, retry: y otros campos se ignoran
    }
    return payloads;
  }

  /** Vacía un evento pendiente al cerrar el stream (por si faltó la línea en blanco). */
  flush(): string[] {
    if (this.#buffer.length > 0) {
      const line = this.#buffer.replace(/\r$/, '');
      this.#buffer = '';
      if (line.startsWith('data:')) {
        let value = line.slice(5);
        if (value.startsWith(' ')) value = value.slice(1);
        this.#dataLines.push(value);
      }
    }
    if (this.#dataLines.length > 0) {
      const payload = this.#dataLines.join('\n');
      this.#dataLines = [];
      return [payload];
    }
    return [];
  }
}

interface ChatCompletionChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
      tool_calls?: Array<{
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }>;
    };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  error?: unknown;
}

export interface MappedChunk {
  events: ChatStreamEvent[];
  /** Si el cuerpo trae un objeto `error`, se para el stream y se lanza esto. */
  errorText?: string;
}

/** Traduce un chunk JSON de chat-completions a eventos de alto nivel. */
export function mapChatCompletionChunk(json: unknown): MappedChunk {
  if (typeof json !== 'object' || json === null) return { events: [] };
  const chunk = json as ChatCompletionChunk;
  if (chunk.error !== undefined) {
    return { events: [], errorText: describeStreamError(chunk.error) };
  }
  const events: ChatStreamEvent[] = [];
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  if (delta) {
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      events.push({ type: 'text', delta: delta.content });
    }
    const reasoning = typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string'
        ? delta.reasoning
        : undefined;
    if (reasoning !== undefined && reasoning.length > 0) {
      events.push({ type: 'reasoning', delta: reasoning });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = typeof call.index === 'number' && Number.isInteger(call.index) ? call.index : 0;
        const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined;
        const name = typeof call.function?.name === 'string' && call.function.name.length > 0 ? call.function.name : undefined;
        const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
        events.push({ type: 'tool-call-delta', index, id, name, argumentsDelta });
      }
    }
  }
  if (chunk.usage !== undefined && chunk.usage !== null) {
    const usage = mapUsage(chunk.usage);
    if (usage) events.push({ type: 'usage', usage });
  }
  if (choice && typeof choice.finish_reason === 'string') {
    events.push({ type: 'done', finishReason: choice.finish_reason });
  }
  return { events };
}

function mapUsage(usage: NonNullable<ChatCompletionChunk['usage']>): ZenUsage | undefined {
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  const cacheRead = typeof usage.cache_read_input_tokens === 'number'
    ? usage.cache_read_input_tokens
    : typeof usage.prompt_tokens_details?.cached_tokens === 'number'
      ? usage.prompt_tokens_details.cached_tokens
      : undefined;
  const cacheWrite = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(cacheRead !== undefined && cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined && cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

function describeStreamError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: unknown; type?: unknown; code?: unknown };
    const parts = [record.type, record.code, record.message]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (parts.length > 0) return parts.join(' · ');
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
