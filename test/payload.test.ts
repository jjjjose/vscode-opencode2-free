import { describe, expect, it } from 'vitest';

import { appendGateTools, buildChatBody, ensureFreeLaneShape, FREE_LANE_GATE_TOOL_NAMES } from '../src/zen/payload';

const wireUser = [{ role: 'user' as const, content: 'hola' }];

describe('forma del lane gratuito', () => {
  it('siempre incluye los stubs bash+read que exige la comprobación del lane', () => {
    const body = buildChatBody({ model: 'big-pickle', messages: wireUser, tools: [], toolChoice: 'auto' });
    const tools = body.tools as Array<{ function: { name: string } }>;
    const names = tools.map((tool) => tool.function.name);
    for (const gate of FREE_LANE_GATE_TOOL_NAMES) expect(names).toContain(gate);
    // Sin herramientas propias, el modelo no debe invocar los stubs.
    expect(body.tool_choice).toBe('none');
    expect(body.stream).toBe(true);
    expect(body.model).toBe('big-pickle');
  });

  it('conserva las herramientas propias y agrega solo los stubs que falten', () => {
    const body = buildChatBody({
      model: 'big-pickle',
      messages: wireUser,
      tools: [
        { name: 'read_file', description: 'lee', inputSchema: { type: 'object' } },
        { name: 'bash', description: 'propia', inputSchema: { type: 'object' } },
      ],
      toolChoice: 'auto',
    });
    const tools = body.tools as Array<{ function: { name: string } }>;
    const names = tools.map((tool) => tool.function.name);
    expect(names.filter((name) => name === 'bash')).toHaveLength(1);
    expect(names).toContain('read');
    expect(names).toContain('read_file');
    expect(body.tool_choice).toBe('auto');
  });

  it('respeta el modo Required de VS Code', () => {
    const body = buildChatBody({
      model: 'big-pickle',
      messages: wireUser,
      tools: [{ name: 'read_file', description: 'lee' }],
      toolChoice: 'required',
    });
    expect(body.tool_choice).toBe('required');
  });

  it('coloca el prompt de sistema delante de los mensajes', () => {
    const body = buildChatBody({
      model: 'big-pickle',
      system: 'eres un asistente',
      messages: wireUser,
      tools: [],
      toolChoice: 'auto',
    });
    const messages = body.messages as Array<{ role: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'eres un asistente' });
  });

  it('appendGateTools no duplica stubs presentes', () => {
    const existing = FREE_LANE_GATE_TOOL_NAMES.map((name) => ({
      type: 'function' as const,
      function: { name, description: '', parameters: {} },
    }));
    const { tools, injected } = appendGateTools(existing);
    expect(tools).toHaveLength(existing.length);
    expect(injected).toHaveLength(0);
  });

  it('ensureFreeLaneShape reescribe cuerpos ajenos sin la forma correcta', () => {
    const payload = { messages: [{ role: 'user', content: 'x' }] };
    const shaped = ensureFreeLaneShape(payload) as Record<string, unknown>;
    expect(shaped).toBeDefined();
    const tools = shaped.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name)).toEqual([...FREE_LANE_GATE_TOOL_NAMES]);
    expect(shaped.tool_choice).toBe('none');
    // Un cuerpo ya correcto no se reescribe.
    expect(ensureFreeLaneShape(shaped)).toBeUndefined();
  });

  it('nunca envía más de 128 herramientas: recorta por el final y conserva los stubs', () => {
    const many = Array.from({ length: 128 }, (_, i) => ({ name: `probe_${i}`, description: '', inputSchema: { type: 'object' } }));
    let adjustment: { declared: number; final: number; injected: string[]; dropped: string[] } | undefined;
    const body = buildChatBody({
      model: 'cat-jam-free',
      messages: wireUser,
      tools: many,
      toolChoice: 'auto',
      onToolsAdjusted: (info) => {
        adjustment = info;
      },
    });
    const tools = body.tools as Array<{ function: { name: string } }>;
    expect(tools).toHaveLength(128);
    const names = tools.map((tool) => tool.function.name);
    for (const gate of FREE_LANE_GATE_TOOL_NAMES) expect(names).toContain(gate);
    expect(adjustment).toEqual({ declared: 128, final: 128, injected: ['bash', 'read'], dropped: ['probe_126', 'probe_127'] });
  });

  it('con bash+read presentes no recorta cuando está justo en el límite', () => {
    const tools = [
      ...FREE_LANE_GATE_TOOL_NAMES.map((name) => ({ name, description: '', inputSchema: { type: 'object' } })),
      ...Array.from({ length: 126 }, (_, i) => ({ name: `probe_${i}`, description: '', inputSchema: { type: 'object' } })),
    ];
    const body = buildChatBody({ model: 'cat-jam-free', messages: wireUser, tools, toolChoice: 'auto' });
    expect((body.tools as unknown[]).length).toBe(128);
  });
});
