import { describe, expect, it } from 'vitest';

import { mapChatCompletionChunk, SseDecoder } from '../src/zen/streaming';

describe('SseDecoder', () => {
  it('acumula fragmentos partidos a mitad de un evento', () => {
    const decoder = new SseDecoder();
    expect(decoder.push('data: {"a"')).toEqual([]);
    expect(decoder.push(': 1}\n\n')).toEqual(['{"a": 1}']);
  });

  it('maneja varias cargas en un solo fragmento', () => {
    const decoder = new SseDecoder();
    const payloads = decoder.push('data: uno\n\ndata: dos\n\n');
    expect(payloads).toEqual(['uno', 'dos']);
  });

  it('respeta CRLF y los comentarios del keep-alive', () => {
    const decoder = new SseDecoder();
    const payloads = decoder.push(': keep-alive\r\n\r\ndata: {"ok":true}\r\n\r\n');
    expect(payloads).toEqual(['{"ok":true}']);
  });

  it('une eventos multilínea con saltos', () => {
    const decoder = new SseDecoder();
    const payloads = decoder.push('data: línea1\ndata: línea2\n\n');
    expect(payloads).toEqual(['línea1\nlínea2']);
  });

  it('flush vacía un evento pendiente sin línea en blanco final', () => {
    const decoder = new SseDecoder();
    decoder.push('data: pendiente');
    expect(decoder.flush()).toEqual(['pendiente']);
    expect(decoder.flush()).toEqual([]);
  });
});

describe('mapChatCompletionChunk', () => {
  it('mapea texto, razonamiento y finish_reason', () => {
    const mapped = mapChatCompletionChunk({
      choices: [{ index: 0, delta: { content: 'hola', reasoning_content: 'pienso' }, finish_reason: 'stop' }],
    });
    expect(mapped.events).toEqual([
      { type: 'text', delta: 'hola' },
      { type: 'reasoning', delta: 'pienso' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('mapea deltas de llamadas a herramientas con índice', () => {
    const mapped = mapChatCompletionChunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path"' } },
              { index: 1, function: { arguments: '{"x"' } },
            ],
          },
        },
      ],
    });
    expect(mapped.events).toEqual([
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read_file', argumentsDelta: '{"path"' },
      { type: 'tool-call-delta', index: 1, id: undefined, name: undefined, argumentsDelta: '{"x"' },
    ]);
  });

  it('mapea usage incluyendo tokens cacheados', () => {
    const mapped = mapChatCompletionChunk({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } },
    });
    expect(mapped.events).toEqual([
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 } },
    ]);
  });

  it('detecta objetos de error dentro del stream', () => {
    const mapped = mapChatCompletionChunk({ error: { type: 'rate_limit', message: 'too many' } });
    expect(mapped.errorText).toContain('too many');
  });
});
