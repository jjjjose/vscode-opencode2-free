import { describe, expect, it } from 'vitest';

import { convertMessages } from '../src/provider/message-converter';

const USER = 1;
const ASSISTANT = 2;
const SYSTEM = 3;

type FakeMessage = { role: number; content: unknown[]; name?: string };

const text = (value: string) => ({ value });
const image = (mimeType = 'image/png') => ({ mimeType, data: new Uint8Array([1, 2, 3]) });
const toolCall = (callId: string, name: string, input: object) => ({ callId, name, input });
const toolResult = (callId: string, content: unknown[]) => ({ callId, content });
const jsonData = (value: unknown) => ({
  mimeType: 'application/json',
  data: new TextEncoder().encode(JSON.stringify(value)),
});

const message = (role: number, content: unknown[], name?: string): FakeMessage =>
  name !== undefined ? { role, content, name } : { role, content };

const convert = (messages: FakeMessage[], supportsImages = false) =>
  convertMessages(messages as never, { modelId: 'big-pickle', supportsImages });

describe('convertMessages', () => {
  it('convierte texto de usuario y assistant', () => {
    const result = convert([
      message(USER, [text('hola')]),
      message(ASSISTANT, [text('qué tal'), text(' ¿en qué ayudo?')]),
    ]);
    expect(result.messages).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'qué tal ¿en qué ayudo?' },
    ]);
  });

  it('reúne los mensajes de sistema en el slot system', () => {
    const result = convert([
      message(SYSTEM, [text('eres un asistente útil')]),
      message(SYSTEM, [text('cita fuentes')]),
      message(USER, [text('hola')]),
    ]);
    expect(result.system).toBe('eres un asistente útil\n\ncita fuentes');
    expect(result.messages).toEqual([{ role: 'user', content: 'hola' }]);
  });

  it('serializa las llamadas de herramientas del historial', () => {
    const result = convert([
      message(ASSISTANT, [text('miro el archivo'), toolCall('call_1', 'read_file', { path: 'a.txt' })]),
    ]);
    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: 'miro el archivo',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
      },
    ]);
  });

  it('emite el resultado de herramienta como mensaje tool pegado al assistant', () => {
    const result = convert([
      message(ASSISTANT, [toolCall('call_9', 'read_file', {})]),
      message(USER, [toolResult('call_9', [text('contenido del archivo')])]),
    ]);
    expect(result.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_9', content: 'contenido del archivo' },
    ]);
  });

  it('sustituye un resultado vacío por un marcador estable', () => {
    const result = convert([message(USER, [toolResult('call_2', [])])]);
    expect(result.messages).toEqual([{ role: 'tool', tool_call_id: 'call_2', content: '(sin salida)' }]);
  });

  it('envía imágenes como image_url con data URL cuando el modelo las admite', () => {
    const result = convert([message(USER, [text('mira'), image()])], true);
    const content = (result.messages[0] as { content: unknown[] }).content;
    expect(content).toEqual([
      { type: 'text', text: 'mira' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ]);
  });

  it('sustituye imágenes por texto cuando el modelo no admite visión', () => {
    const result = convert([message(USER, [text('mira'), image()])], false);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: 'mira[imagen omitida: el modelo big-pickle no admite entrada de imagen]',
    });
  });

  it('decodifica contenidos de datos no-imagen como texto', () => {
    const result = convert([message(USER, [jsonData({ a: 1 })])]);
    expect(result.messages[0]).toEqual({ role: 'user', content: '{"a":1}' });
  });

  it('descarta mensajes assistant vacíos y conserva el nombre cuando existe', () => {
    const result = convert([
      message(ASSISTANT, []),
      message(USER, [text('hola')], 'usuario'),
    ]);
    expect(result.messages).toEqual([{ role: 'user', content: 'hola', name: 'usuario' }]);
  });
});
