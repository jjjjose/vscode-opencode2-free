import type { LoggerLike } from '../log';
import { classifyTransportError, classifyZenHttpError, describeZenError, ZenError } from './errors';
import type { RequestIDs } from './ids';
import { disguiseHeaders } from './ids';
import { ZEN_BASE_URL } from './catalog';
import { mapChatCompletionChunk, SseDecoder, type ChatStreamEvent } from './streaming';

/**
 * Cliente HTTP del lane anónimo: POST {zen}/v1/chat/completions con streaming.
 *
 * Responsabilidades:
 * - Cabeceras de correlación idénticas a la CLI de OpenCode y credencial
 *   anónima `Bearer public`.
 * - Reintentos silenciosos SOLO antes de que llegue contenido (429/5xx/red),
 *   con backoff exponencial, jitter y respeto de Retry-After.
 * - Vigilantes de vida del stream: tiempo al primer evento e inactividad del
 *   cuerpo (una conexión que se queda muda no debe colgar el turno).
 * - Cancelación mediante AbortSignal, encadenada al CancellationToken de VS Code.
 */

const ANONYMOUS_KEY = 'public';
const DEFAULT_FIRST_EVENT_MS = 30_000;
const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_INITIAL_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 20_000;
const DEFAULT_JITTER = 0.2;

export interface ZenStreamOptions {
  signal?: AbortSignal;
  firstEventTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxRetries?: number;
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitterRatio?: number;
  /** Cabeceras de correlación (derivadas de la conversación). */
  ids: RequestIDs;
}

export class ZenClient {
  readonly #log: LoggerLike;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(log: LoggerLike, options: { fetchImpl?: typeof fetch; baseUrl?: string } = {}) {
    this.#log = log;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = (options.baseUrl ?? ZEN_BASE_URL).replace(/\/+$/, '');
  }

  /**
   * Ejecuta la petición y produce los eventos del stream. Lanza ZenError
   * clasificado ante fallos; nunca reintenta después de haber entregado
   * contenido (una respuesta parcial jamás se reproduce).
   */
  async *streamChat(body: Record<string, unknown>, options: ZenStreamOptions): AsyncGenerator<ChatStreamEvent> {
    const url = `${this.#baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      ...disguiseHeaders(options.ids),
      authorization: `Bearer ${ANONYMOUS_KEY}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    const firstEventMs = options.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_MS;
    const initialDelay = options.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_MS;
    const maxDelay = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_MS;
    const jitter = options.retryJitterRatio ?? DEFAULT_JITTER;

    let attempt = 0;
    for (;;) {
      if (options.signal?.aborted) throw new ZenError('aborted', 'Petición cancelada.');

      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });

      let response: Response;
      const startedAt = Date.now();
      let headerTimer: NodeJS.Timeout | undefined;
      try {
        const headerDeadline = new Promise<never>((_, reject) => {
          headerTimer = setTimeout(() => {
            reject(
              new ZenError(
                'timeout',
                describeZenError('timeout', undefined, 'OpenCode Zen no respondió a la conexión (sin cabeceras HTTP).'),
              ),
            );
          }, firstEventMs);
          headerTimer.unref?.();
        });
        response = await Promise.race([
          this.#fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          }),
          headerDeadline,
        ]);
      } catch (err) {
        controller.abort();
        options.signal?.removeEventListener('abort', onAbort);
        if (options.signal?.aborted) throw new ZenError('aborted', 'Petición cancelada.', { cause: err });
        if (err instanceof ZenError) throw err;
        const kind = classifyTransportError(err);
        if (attempt < maxRetries) {
          const delay = this.#backoff(attempt, initialDelay, maxDelay, jitter);
          this.#log.warn(
            `conexión con OpenCode Zen fallida (intento ${attempt + 1}/${maxRetries + 1}); reintento en ${delay} ms`,
          );
          attempt += 1;
          await this.#sleep(delay, options.signal);
          continue;
        }
        throw new ZenError(kind, describeZenError(kind, undefined, err instanceof Error ? err.message : String(err)), {
          cause: err,
        });
      } finally {
        clearTimeout(headerTimer);
      }

      if (!response.ok) {
        options.signal?.removeEventListener('abort', onAbort);
        const detail = await safeText(response);
        const kind = classifyZenHttpError(response.status, detail);
        const retryable = kind === 'rate-limit' || kind === 'server';
        const retryAfterMs = retryAfterMillis(response);
        if (retryable && attempt < maxRetries && !options.signal?.aborted) {
          const delay = Math.min(retryAfterMs ?? this.#backoff(attempt, initialDelay, maxDelay, jitter), 60_000);
          this.#log.warn(
            `OpenCode Zen respondió HTTP ${response.status} (${kind}); reintento ${attempt + 1}/${maxRetries} en ${delay} ms`,
          );
          attempt += 1;
          await this.#sleep(delay, options.signal);
          continue;
        }
        throw new ZenError(kind, describeZenError(kind, response.status, detail), {
          status: response.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      }

      this.#log.debug(`conexión establecida en ${Date.now() - startedAt} ms (intento ${attempt + 1})`);
      try {
        yield* this.#pump(response, options, controller);
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
      }
      return;
    }
  }

  /** Lee el cuerpo SSE aplicando los vigilantes de vida. */
  async *#pump(response: Response, options: ZenStreamOptions, controller: AbortController): AsyncGenerator<ChatStreamEvent> {
    const body = response.body;
    if (body === null) throw new ZenError('transport', describeZenError('transport', response.status, 'respuesta sin cuerpo'));
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const sse = new SseDecoder();
    const firstEventMs = options.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_MS;
    const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;

    let sawAnyEvent = false;
    let lastActivity = Date.now();
    let finishReason: string | null = null;
    let done = false;
    let sawSentinel = false;

    const makeDeadline = (): { promise: Promise<never>; cancel: () => void } => {
      const windowMs = sawAnyEvent ? idleMs : firstEventMs;
      const remaining = Math.max(0, windowMs - (Date.now() - lastActivity));
      let timer: NodeJS.Timeout | undefined;
      const promise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const message = sawAnyEvent
            ? 'El stream de OpenCode Zen dejó de emitir datos (inactividad).'
            : 'OpenCode Zen no envió ningún dato a tiempo.';
          reject(new ZenError('timeout', describeZenError('timeout', undefined, message)));
        }, remaining);
        timer.unref?.();
      });
      return { promise, cancel: () => clearTimeout(timer) };
    };

    /** Interpreta las cargas ya completas; registra finish_reason y [DONE]. */
    const process = (payloads: string[]): ChatStreamEvent[] => {
      const out: ChatStreamEvent[] = [];
      for (const payload of payloads) {
        const mapped = this.#mapPayload(payload);
        if (mapped.done) {
          done = true;
          sawSentinel = true;
          break;
        }
        for (const event of mapped.events) {
          // `finish_reason` se recuerda y se emite una única vez al final del
          // stream, nunca a mitad del cuerpo.
          if (event.type === 'done') {
            finishReason = event.finishReason;
            continue;
          }
          out.push(event);
        }
      }
      return out;
    };

    const emit = (events: ChatStreamEvent[]): ChatStreamEvent[] => {
      for (const event of events) {
        if (event.type !== 'usage') lastActivity = Date.now();
      }
      return events;
    };

    try {
      while (!done) {
        const deadline = makeDeadline();
        let read: { done: boolean; value?: Uint8Array };
        try {
          read = await Promise.race([reader.read(), deadline.promise]);
        } catch (err) {
          if (options.signal?.aborted) throw new ZenError('aborted', 'Petición cancelada.', { cause: err });
          if (err instanceof ZenError) throw err;
          const kind = classifyTransportError(err);
          throw new ZenError(kind, describeZenError(kind, undefined, err instanceof Error ? err.message : String(err)), {
            cause: err,
          });
        } finally {
          deadline.cancel();
        }

        if (read.done) break;
        const text = decoder.decode(read.value, { stream: true });
        for (const event of emit(process(sse.push(text)))) yield event;
      }

      if (!done) {
        const tail = decoder.decode();
        if (tail.length > 0) {
          for (const event of emit(process(sse.push(tail)))) yield event;
        }
      }
      if (!done) {
        for (const event of emit(process(sse.flush()))) yield event;
      }
      if (!sawSentinel && finishReason === null) {
        throw new ZenError(
          'transport',
          describeZenError('transport', undefined, 'la conexión se cerró antes de completar la respuesta'),
        );
      }
      yield { type: 'done', finishReason };
    } finally {
      controller.abort();
      try {
        reader.releaseLock();
      } catch {
        // el lector ya pudo liberarse al abortar; no es un fallo
      }
    }
  }

  /** Interpreta una carga `data:` del SSE. `done` marca el centinela [DONE]. */
  #mapPayload(payload: string): { events: ChatStreamEvent[]; done: boolean } {
    const trimmed = payload.trim();
    if (trimmed === '[DONE]') return { events: [], done: true };
    if (trimmed.length === 0) return { events: [], done: false };
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      this.#log.debug(`chunk SSE no-JSON ignorado (${trimmed.slice(0, 120)})`);
      return { events: [], done: false };
    }
    const mapped = mapChatCompletionChunk(json);
    if (mapped.errorText !== undefined) {
      throw new ZenError('server', describeZenError('server', undefined, mapped.errorText));
    }
    return { events: mapped.events, done: false };
  }

  #backoff(attempt: number, initial: number, max: number, jitter: number): number {
    const base = Math.min(initial * 2 ** attempt, max);
    const noise = base * jitter;
    return Math.max(1, Math.round(base - noise + Math.random() * noise * 2));
  }

  async #sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    if (signal?.aborted) throw new ZenError('aborted', 'Petición cancelada.');
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ZenError('aborted', 'Petición cancelada.'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function retryAfterMillis(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 2000);
  } catch {
    return '';
  }
}
