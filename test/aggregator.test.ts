import { describe, expect, it } from 'vitest';

import { ZenError } from '../src/zen/errors';
import type { ChatStreamEvent, ZenUsage } from '../src/zen/streaming';
import { aggregateStream, type AggregatedToolCall } from '../src/provider/response-aggregator';

function events(list: ChatStreamEvent[]): AsyncIterable<ChatStreamEvent> {
  return (async function* () {
    for (const event of list) yield event;
  })();
}

function makeSink() {
  const texts: string[] = [];
  const calls: AggregatedToolCall[] = [];
  const notes: string[] = [];
  const usages: ZenUsage[] = [];
  return {
    sink: {
      text: (delta: string) => texts.push(delta),
      toolCall: (call: AggregatedToolCall) => calls.push(call),
      note: (note: string) => notes.push(note),
      usage: (usage: ZenUsage) => usages.push(usage),
    },
    texts,
    calls,
    notes,
    usages,
  };
}

describe('aggregateStream', () => {
  it('reenvía el texto en orden y resume longitudes', async () => {
    const { sink, texts } = makeSink();
    const summary = await aggregateStream(
      events([
        { type: 'text', delta: 'hola ' },
        { type: 'reasoning', delta: 'pensando…' },
        { type: 'text', delta: 'mundo' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
        { type: 'done', finishReason: 'stop' },
      ]),
      new Set(['read_file']),
      sink,
    );
    expect(texts.join('')).toBe('hola mundo');
    expect(summary.textLength).toBe(10);
    expect(summary.reasoningLength).toBe(9);
    expect(summary.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(summary.finishReason).toBe('stop');
  });

  it('acumula llamadas partidas en deltas y valida los argumentos', async () => {
    const { sink, calls } = makeSink();
    const summary = await aggregateStream(
      events([
        { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'read_file', argumentsDelta: '{"path":' },
        { type: 'tool-call-delta', index: 0, argumentsDelta: '"a.txt"}' },
        { type: 'done', finishReason: 'tool_calls' },
      ]),
      new Set(['read_file']),
      sink,
    );
    expect(calls).toEqual([{ callId: 'call_a', name: 'read_file', input: { path: 'a.txt' } }]);
    expect(summary.toolCalls).toHaveLength(1);
    expect(summary.dropped).toHaveLength(0);
  });

  it('descarta llamadas a herramientas no declaradas (incluidos los stubs del lane)', async () => {
    const { sink, calls, notes } = makeSink();
    const error = await aggregateStream(
      events([
        { type: 'tool-call-delta', index: 0, id: 'call_b', name: 'bash', argumentsDelta: '{"command":"ls"}' },
        { type: 'done', finishReason: 'tool_calls' },
      ]),
      new Set(['read_file']),
      sink,
    ).catch(error => error);
    expect(calls).toHaveLength(0);
    expect(error).toMatchObject({ kind: 'empty-response', message: expect.stringContaining('no disponible') });
    expect(notes).toHaveLength(0);
  });

  it('descarta argumentos JSON inválidos sin propagar la llamada', async () => {
    const { sink, notes } = makeSink();
    const error = await aggregateStream(
      events([
        { type: 'tool-call-delta', index: 0, id: 'call_c', name: 'read_file', argumentsDelta: '{"path":' },
        { type: 'done', finishReason: 'tool_calls' },
      ]),
      new Set(['read_file']),
      sink,
    ).catch(error => error);
    expect(error).toMatchObject({ kind: 'empty-response', message: expect.stringContaining('malformada') });
    expect(notes).toHaveLength(0);
  });

  it('una respuesta vacía con finish_reason stop lanza empty-response', async () => {
    const { sink } = makeSink();
    await expect(
      aggregateStream(events([{ type: 'done', finishReason: 'stop' }]), new Set(), sink),
    ).rejects.toMatchObject({ kind: 'empty-response' });
  });

  it('espacios y razonamiento no cuentan como respuesta visible', async () => {
    const { sink } = makeSink();
    await expect(aggregateStream(events([
      { type: 'text', delta: '  \n' },
      { type: 'reasoning', delta: 'pensando' },
      { type: 'done', finishReason: 'stop' },
    ]), new Set(), sink)).rejects.toMatchObject({ kind: 'empty-response', message: expect.stringContaining('razonamiento') });
  });

  it('una respuesta sin contenido por límite de salida produce un error explícito', async () => {
    const { sink, notes } = makeSink();
    const error = await aggregateStream(
      events([{ type: 'reasoning', delta: 'mucho pensar' }, { type: 'done', finishReason: 'length' }]),
      new Set(),
      sink,
    ).catch(error => error);
    expect(error).toMatchObject({ kind: 'empty-response', message: expect.stringContaining('límite') });
    expect(notes).toHaveLength(0);
  });

  it('la llamada sin nombre se descarta como malformada', async () => {
    const { sink, notes } = makeSink();
    const error = await aggregateStream(
      events([
        { type: 'tool-call-delta', index: 0, argumentsDelta: '{}' },
        { type: 'done', finishReason: 'tool_calls' },
      ]),
      new Set(['read_file']),
      sink,
    ).catch(error => error);
    expect(error).toMatchObject({ kind: 'empty-response', message: expect.stringContaining('malformada') });
    expect(notes).toHaveLength(0);
  });

  it('propaga un error de respuesta vacía como ZenError', async () => {
    const { sink } = makeSink();
    const error = await aggregateStream(events([{ type: 'done', finishReason: 'stop' }]), new Set(), sink).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ZenError);
  });

  it('notifica el uso al sink y lo conserva en el resumen', async () => {
    const { sink, usages } = makeSink();
    const summary = await aggregateStream(
      events([
        { type: 'text', delta: 'hola' },
        { type: 'usage', usage: { inputTokens: 300, outputTokens: 12, cacheReadTokens: 128 } },
        { type: 'done', finishReason: 'stop' },
      ]),
      new Set(),
      sink,
    );
    expect(usages).toEqual([{ inputTokens: 300, outputTokens: 12, cacheReadTokens: 128 }]);
    expect(summary.usage).toEqual({ inputTokens: 300, outputTokens: 12, cacheReadTokens: 128 });
  });
});
