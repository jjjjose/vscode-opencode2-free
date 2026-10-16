import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ZenClient } from '../src/zen/client';
import { ZenError } from '../src/zen/errors';
import { deriveRequestIDs } from '../src/zen/ids';
import type { ChatStreamEvent } from '../src/zen/streaming';
import { MockZen } from './helpers/mock-zen';

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function collect(events: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('ZenClient', () => {
  let server: MockZen;
  let client: ZenClient;

  beforeEach(async () => {
    server = new MockZen();
    await server.start();
    client = new ZenClient(noopLog, { baseUrl: server.baseUrl });
  });

  afterEach(async () => {
    await server.stop();
  });

  const ids = () => deriveRequestIDs([{ role: 'user', content: 'prueba' }]);
  const body = () => ({ model: 'big-pickle', stream: true, messages: [{ role: 'user', content: 'hola' }] });

  it('hace streaming de texto y termina con done', async () => {
    const events = await collect(client.streamChat(body(), { ids: ids(), retryInitialDelayMs: 5 }));
    expect(events).toEqual([
      { type: 'text', delta: 'hola' },
      { type: 'text', delta: ' mundo' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('envía la credencial anónima y las cabeceras de correlación', async () => {
    await collect(client.streamChat(body(), { ids: ids(), retryInitialDelayMs: 5 }));
    const request = server.requests.find((entry) => entry.path === '/v1/chat/completions');
    expect(request).toBeDefined();
    expect(request?.headers.authorization).toBe('Bearer public');
    expect(String(request?.headers['x-opencode-session'])).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(request?.headers['x-opencode-client']).toBe('cli');
    expect(request?.headers.accept).toBe('text/event-stream');
  });

  it('reintenta 429 y completa cuando el servicio se recupera', async () => {
    await server.stop();
    server = new MockZen({
      chatScripts: [
        { status: 429, headers: { 'retry-after': '0' }, errorBody: { error: { message: 'rate limited' } } },
        { chunks: [{ choices: [{ index: 0, delta: { content: 'vale' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'] },
      ],
    });
    await server.start();
    client = new ZenClient(noopLog, { baseUrl: server.baseUrl });

    const events = await collect(client.streamChat(body(), { ids: ids(), retryInitialDelayMs: 5 }));
    expect(server.chatRequestCount).toBe(2);
    expect(events).toContainEqual({ type: 'text', delta: 'vale' });
  });

  it('no reintenta errores deterministas (403 FreeTierError)', async () => {
    await server.stop();
    server = new MockZen({
      chatScripts: [
        {
          status: 403,
          errorBody: { error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode" } },
        },
      ],
    });
    await server.start();
    client = new ZenClient(noopLog, { baseUrl: server.baseUrl });

    await expect(collect(client.streamChat(body(), { ids: ids(), retryInitialDelayMs: 5 }))).rejects.toMatchObject({
      kind: 'free-tier',
    });
    expect(server.chatRequestCount).toBe(1);
  });

  it('clasifica el bloqueo regional conservando el mensaje upstream', async () => {
    await server.stop();
    server = new MockZen({
      chatScripts: [
        { status: 403, errorBody: { error: { type: 'RegionError', message: 'This model is not available in your country' } } },
      ],
    });
    await server.start();
    client = new ZenClient(noopLog, { baseUrl: server.baseUrl });

    const error = await collect(client.streamChat(body(), { ids: ids(), retryInitialDelayMs: 5 })).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ZenError);
    expect((error as ZenError).kind).toBe('region');
    expect((error as ZenError).message).toContain('not available in your country');
  });

  it('aplica el vigilante del primer evento', async () => {
    await server.stop();
    server = new MockZen({ chatScripts: [{ hangAfterHeaders: true }] });
    await server.start();
    client = new ZenClient(noopLog, { baseUrl: server.baseUrl });

    const error = await collect(
      client.streamChat(body(), { ids: ids(), firstEventTimeoutMs: 120, idleTimeoutMs: 120, retryInitialDelayMs: 5 }),
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ZenError);
    expect((error as ZenError).kind).toBe('timeout');
  });

  it('detecta un cierre prematuro sin [DONE] ni finish_reason', async () => {
    await server.stop();
    server = new MockZen({
      chatScripts: [
        {
          chunks: [{ choices: [{ index: 0, delta: { content: 'parcial' } }] }],
          closeAfterChunks: 1,
        },
      ],
    });
    await server.start();
    client = new ZenClient(noopLog, { baseUrl: server.baseUrl });

    const error = await collect(
      client.streamChat(body(), { ids: ids(), firstEventTimeoutMs: 1000, idleTimeoutMs: 1000, retryInitialDelayMs: 5 }),
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ZenError);
    expect((error as ZenError).kind).toBe('transport');
  });

  it('la cancelación por AbortSignal termina en silencio', async () => {
    await server.stop();
    server = new MockZen({ chatScripts: [{ hangAfterHeaders: true }] });
    await server.start();
    client = new ZenClient(noopLog, { baseUrl: server.baseUrl });

    const controller = new AbortController();
    const promise = collect(
      client.streamChat(body(), { ids: ids(), signal: controller.signal, retryInitialDelayMs: 5 }),
    ).catch((err: unknown) => err);
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result).toBeInstanceOf(ZenError);
    expect((result as ZenError).kind).toBe('aborted');
  });
});
