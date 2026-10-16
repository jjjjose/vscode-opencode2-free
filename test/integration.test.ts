import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  chatProviderRegistrations,
  commands,
  configuration,
  Disposable,
  informationMessages,
  LanguageModelChatToolMode,
  LanguageModelDataPart,
  LanguageModelError,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  outputChannels,
  warningMessages,
} from './helpers/mock-vscode';

/**
 * Prueba de integración: ejecuta `activate()` y el proveedor reales con un
 * doble del módulo `vscode` y la red simulada (catálogo + streaming SSE).
 * Verifica el cableado completo: registro del proveedor, catálogo en vivo,
 * conversión de mensajes, petición HTTP con la forma del lane, y el reenvío
 * de texto y llamadas a herramientas a VS Code.
 */

const encoder = new TextEncoder();

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];
let chatQueue: Array<() => Response> = [];
let tempDir: string;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sse(payloads: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const payload of payloads) controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function textScript(text: string): () => Response {
  return () =>
    sse([
      JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
      '[DONE]',
    ]);
}

function toolScript(): () => Response {
  return () =>
    sse([
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }],
      }),
      '[DONE]',
    ]);
}

const liveModels = ['big-pickle', 'modelo-de-pago', 'nuevo-free'];
const metadata = {
  opencode: {
    models: {
      'big-pickle': { tool_call: true, cost: { input: 0, output: 0 }, limit: { context: 100_000, output: 8_000 } },
      'modelo-de-pago': { cost: { input: 3, output: 15 } },
      'nuevo-free': { cost: { input: 0, output: 0 } },
    },
  },
};

function installFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? input);
    calls.push({ url, init });
    if (url.includes('/v1/models')) {
      return json({ object: 'list', data: liveModels.map((id) => ({ id, object: 'model' })) });
    }
    if (url.includes('models.dev') || url.includes('/api.json')) {
      return json(metadata);
    }
    if (url.includes('/v1/chat/completions')) {
      const next = chatQueue.shift();
      if (next !== undefined) return next();
      return textScript('respuesta por defecto')();
    }
    return json({ error: { message: 'ruta no simulada' } }, 404);
  }) as typeof fetch;
}

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => new Disposable(),
};

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('tiempo de espera agotado');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface ProviderLike {
  onDidChangeLanguageModelChatInformation: (listener: () => void) => Disposable;
  provideLanguageModelChatInformation: (
    options: { silent: boolean },
    token: unknown,
  ) => Promise<Array<{ id: string; maxInputTokens: number; maxOutputTokens: number; capabilities: { toolCalling: boolean } }>>;
  provideLanguageModelChatResponse: (
    model: unknown,
    messages: unknown[],
    options: { tools: unknown[]; toolMode: number },
    progress: { report: (part: unknown) => void },
    token: unknown,
  ) => Promise<void>;
  provideTokenCount: (model: unknown, text: string | unknown, token: unknown) => Promise<number>;
}

describe('integración de la extensión (activate + proveedor)', () => {
  let context: { subscriptions: Disposable[]; globalStorageUri: { fsPath: string } };

  beforeEach(async () => {
    chatProviderRegistrations.length = 0;
    commands.executeCommand; // noop
    outputChannels.length = 0;
    informationMessages.length = 0;
    warningMessages.length = 0;
    calls = [];
    chatQueue = [];
    configuration.values = {};
    tempDir = await mkdtemp(join(tmpdir(), 'openoc-free-integration-'));
    context = { subscriptions: [], globalStorageUri: { fsPath: tempDir } };
    installFetch();
  });

  afterEach(async () => {
    for (const disposable of context.subscriptions.splice(0)) {
      try {
        disposable.dispose();
      } catch {
        // los dobles no lanzan; por robustez
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  async function activateExtension(): Promise<{ provider: ProviderLike; fired: () => number }> {
    const { activate } = await import('../src/extension');
    activate(context as never);
    await waitFor(() => chatProviderRegistrations.length === 1);
    const provider = chatProviderRegistrations[0].provider as ProviderLike;
    expect(chatProviderRegistrations[0].vendor).toBe('opencode-free');
    let fired = 0;
    provider.onDidChangeLanguageModelChatInformation(() => {
      fired += 1;
    });
    return { provider, fired: () => fired };
  }

  /** Espera a que el catálogo en vivo sustituya a la lista estática. */
  async function liveModelsOf(
    provider: ProviderLike,
  ): Promise<Array<{ id: string; maxInputTokens: number; maxOutputTokens: number; capabilities: { toolCalling: boolean } }>> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const models = await provider.provideLanguageModelChatInformation({ silent: true }, token);
      if (models.some((model) => model.id === 'nuevo-free')) return models;
      if (Date.now() > deadline) return models;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('registra el proveedor, descubre el catálogo en vivo y notifica el cambio', async () => {
    const { provider, fired } = await activateExtension();

    await waitFor(() => fired() >= 1);
    const models = await liveModelsOf(provider);
    expect(models.map((model) => model.id)).toEqual(['big-pickle', 'nuevo-free']);
    expect(models[0].maxInputTokens).toBe(100_000);
    expect(models[0].maxOutputTokens).toBe(8_000);
    expect(models[0].capabilities.toolCalling).toBe(true);
  });

  it('responde en streaming y envía la forma del lane con tool_choice none', async () => {
    const { provider } = await activateExtension();
    const models = await liveModelsOf(provider);
    chatQueue.push(textScript('hola mundo'));

    const parts: unknown[] = [];
    await provider.provideLanguageModelChatResponse(
      models[0],
      [{ role: 1, content: [new LanguageModelTextPart('saluda')] }],
      { tools: [], toolMode: LanguageModelChatToolMode.Auto },
      { report: (part) => parts.push(part) },
      token,
    );

    const text = parts
      .filter((part): part is LanguageModelTextPart => part instanceof LanguageModelTextPart)
      .map((part) => part.value)
      .join('');
    expect(text).toBe('hola mundo');

    // El uso del stream se reenvía como part «usage» para el medidor de contexto.
    const usagePart = parts.find((part): part is LanguageModelDataPart => part instanceof LanguageModelDataPart);
    expect(usagePart?.mimeType).toBe('usage');
    expect(JSON.parse(new TextDecoder().decode(usagePart?.data ?? new Uint8Array()))).toEqual({
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
    });

    const chatCall = calls.find((call) => call.url.includes('/v1/chat/completions'));
    expect(chatCall).toBeDefined();
    const headers = chatCall?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer public');
    expect(headers['x-opencode-session']).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    const body = JSON.parse(String(chatCall?.init?.body)) as {
      stream: boolean;
      tool_choice: string;
      tools: Array<{ function: { name: string } }>;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.stream).toBe(true);
    expect(body.tool_choice).toBe('none');
    const toolNames = body.tools.map((tool) => tool.function.name);
    expect(toolNames).toContain('bash');
    expect(toolNames).toContain('read');
    expect(body.messages[0]).toEqual({ role: 'user', content: 'saluda' });
  });

  it('reenvía las llamadas a herramientas de VS Code y descarta nombres no declarados', async () => {
    const { provider } = await activateExtension();
    const models = await liveModelsOf(provider);
    chatQueue.push(toolScript());
    chatQueue.push(() =>
      sse([
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'bash', arguments: '{}' } }] },
            },
          ],
        }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        '[DONE]',
      ]),
    );

    const tools = [{ name: 'read_file', description: 'lee un archivo', inputSchema: { type: 'object' } }];

    const parts: unknown[] = [];
    await provider.provideLanguageModelChatResponse(
      models[0],
      [{ role: 1, content: [new LanguageModelTextPart('lee a.txt')] }],
      { tools, toolMode: LanguageModelChatToolMode.Auto },
      { report: (part) => parts.push(part) },
      token,
    );

    const toolCalls = parts.filter((part): part is LanguageModelToolCallPart => part instanceof LanguageModelToolCallPart);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('read_file');
    expect(toolCalls[0].input).toEqual({ path: 'a.txt' });

    const chatCall = calls.filter((call) => call.url.includes('/v1/chat/completions')).at(-1);
    const body = JSON.parse(String(chatCall?.init?.body)) as {
      tool_choice: string;
      tools: Array<{ function: { name: string } }>;
    };
    expect(body.tool_choice).toBe('auto');
    expect(body.tools.map((tool) => tool.function.name).sort()).toEqual(['bash', 'read', 'read_file']);

    // Segunda respuesta: el modelo solo llama al stub `bash` → se descarta y se
    // propaga un error específico en lugar de simular una respuesta correcta.
    const parts2: unknown[] = [];
    await expect(provider.provideLanguageModelChatResponse(
      models[0],
      [{ role: 1, content: [new LanguageModelTextPart('insiste')] }],
      { tools, toolMode: LanguageModelChatToolMode.Auto },
      { report: (part) => parts2.push(part) },
      token,
    )).rejects.toThrow('herramienta no disponible');
    expect(parts2.some((part) => part instanceof LanguageModelToolCallPart)).toBe(false);
    expect(parts2.some((part) => part instanceof LanguageModelTextPart)).toBe(false);
  });

  it('traduce el bloqueo del tier gratuito a LanguageModelError.Blocked', async () => {
    configuration.values['request.maxRetries'] = 0;
    const { provider } = await activateExtension();
    const models = await liveModelsOf(provider);
    chatQueue.push(() =>
      json({ error: { type: 'FreeTierError', message: 'the free tier can only be used from within OpenCode' } }, 403),
    );

    const error = await provider
      .provideLanguageModelChatResponse(
        models[0],
        [{ role: 1, content: [new LanguageModelTextPart('hola')] }],
        { tools: [], toolMode: LanguageModelChatToolMode.Auto },
        { report: () => {} },
        token,
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LanguageModelError);
    expect((error as LanguageModelError).code).toBe('Blocked');
  });

  it('estima tokens y expone el comando de diagnóstico con el estado del catálogo', async () => {
    const { provider } = await activateExtension();
    const models = await liveModelsOf(provider);
    expect(await provider.provideTokenCount(models[0], 'x'.repeat(40), token)).toBe(10);

    await commands.executeCommand('opencode-free.showDiagnostics');
    const dump = outputChannels[0]?.lines.join('\n') ?? '';
    expect(dump).toContain('big-pickle');
    expect(dump).toContain('decisión=');
    expect(dump).toContain('ajustes efectivos');
    expect(informationMessages.some((message) => message.includes('modelos expuestos'))).toBe(true);
  });
});
