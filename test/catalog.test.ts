import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  decodeModelsDev,
  decide,
  ModelCatalog,
  type ModelPrice,
} from '../src/zen/catalog';
import { MockZen } from './helpers/mock-zen';

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function metadataResponse(models: Record<string, unknown>): () => Promise<Response> {
  const body = JSON.stringify({
    opencode: { id: 'opencode', name: 'OpenCode', models },
  });
  return async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('decide()', () => {
  const price = (overrides: Partial<ModelPrice>): ModelPrice => ({ deprecated: false, ...overrides });

  it('un veredicto de pago manda incluso si el nombre dice "free"', () => {
    const decision = decide('modelo-free', price({ input: 1, output: 2 }), true);
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe('metadata_paid');
  });

  it('coste cero permite aunque el nombre no diga free', () => {
    const decision = decide('modelo', price({ input: 0, output: 0 }), true);
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe('metadata_free');
  });

  it('deprecado niega', () => {
    const decision = decide('modelo-free', price({ deprecated: true, input: 0, output: 0 }), true);
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe('metadata_deprecated');
  });

  it('sin metadatos, el nombre free permite como respaldo (fase pendiente)', () => {
    const decision = decide('cosa-free', undefined, false);
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe('name_free');
  });

  it('con metadatos cargados, un modelo ausente del feed no se expone', () => {
    const decision = decide('cosa-free', undefined, true);
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe('metadata_model_missing');
  });
});

describe('decodeModelsDev', () => {
  it('prefiere la sección opencode y decodifica coste, límites y capacidades', () => {
    const decoded = decodeModelsDev({
      otro: { models: { x: { cost: { input: 5, output: 5 } } } },
      opencode: {
        models: {
          'big-pickle': {
            id: 'big-pickle',
            cost: { input: 0, output: 0 },
            limit: { context: 200000, output: 32000 },
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
            modalities: { input: ['text', 'image'] },
          },
        },
      },
    });
    const entry = decoded.get('big-pickle');
    expect(entry).toBeDefined();
    expect(entry?.input).toBe(0);
    expect(entry?.output).toBe(0);
    expect(entry?.contextWindow).toBe(200000);
    expect(entry?.maxOutput).toBe(32000);
    expect(entry?.reasoning).toBe(true);
    expect(entry?.effortValues).toEqual(['low', 'high']);
    expect(entry?.modalities).toEqual(['text', 'image']);
  });
});

describe('ModelCatalog', () => {
  const servers: MockZen[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop().catch(() => {})));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })));
  });

  async function makeCatalog(options: { chatModels?: string[]; metadata?: Record<string, unknown> } = {}) {
    const server = new MockZen({ models: options.chatModels ?? [] });
    await server.start();
    servers.push(server);
    const dir = await mkdtemp(join(tmpdir(), 'openoc-free-test-'));
    dirs.push(dir);
    // Enrutador: S1 (modelos en vivo) va al servidor simulado; S2 (models.dev)
    // responde con los metadatos declarados por el test.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('models.dev') || url.includes('/api.json')) {
        return metadataResponse(options.metadata ?? {})();
      }
      return globalThis.fetch(input as string, init);
    };
    const catalog = new ModelCatalog({
      zenBaseUrl: server.baseUrl,
      cachePath: join(dir, 'models.dev.cache.json'),
      fetchImpl,
      log: noopLog,
      refreshSeconds: 3600,
    });
    return { catalog, server };
  }

  it('expone S1 ∩ permitidos sin listas fijas y excluye los de pago', async () => {
    const { catalog } = await makeCatalog({
      chatModels: ['big-pickle', 'modelo-pago', 'exo-free', 'nuevo-free'],
      metadata: {
        'big-pickle': { cost: { input: 0, output: 0 } },
        'modelo-pago': { cost: { input: 3, output: 15 } },
        'exo-free': { cost: { input: 0, output: 0 } }, // bloqueado localmente
        'nuevo-free': { cost: { input: 0, output: 0 } },
      },
    });
    await catalog.refreshOnce();
    expect(catalog.list()).toEqual(['big-pickle', 'exo-free', 'nuevo-free']);
    expect(catalog.decision('modelo-pago').source).toBe('metadata_paid');
  });

  it('los modelos solo-Responses quedan fuera del selector', async () => {
    const { catalog } = await makeCatalog({
      chatModels: ['muse-spark-9-contributor-free', 'otro-free'],
      metadata: {
        'muse-spark-9-contributor-free': { cost: { input: 0, output: 0 }, provider: { npm: '@ai-sdk/openai' } },
        'otro-free': { cost: { input: 0, output: 0 } },
      },
    });
    await catalog.refreshOnce();
    expect(catalog.list()).toEqual(['otro-free']);
    expect(catalog.decision('muse-spark-9-contributor-free').source).toBe('unsupported_protocol');
  });

  it('con S1 pendiente no inventa modelos', () => {
    const catalog = new ModelCatalog({ fetchImpl: metadataResponse({}) });
    expect(catalog.list()).toEqual([]);
  });

  it('respeta los metadatos de mimo sin overrides locales', async () => {
    const { catalog } = await makeCatalog({
      chatModels: ['mimo-v2.6-flash-free'],
      metadata: {
        'mimo-v2.6-flash-free': { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 64000 } },
      },
    });
    await catalog.refreshOnce();
    expect(catalog.limits('mimo-v2.6-flash-free')?.contextWindow).toBe(200000);
    expect(catalog.limits('mimo-v2.6-flash-free')?.maxOutput).toBe(64000);
  });

  it('posterga la decisión de un modelo con nombre free sin metadatos', async () => {
    const { catalog } = await makeCatalog({ chatModels: ['desconocido-free'] });
    await catalog.refreshOnce();
    expect(catalog.list()).toContain('desconocido-free');
    expect(catalog.decision('desconocido-free').source).toBe('name_free');
  });

  it('warm() respeta su límite de tiempo', async () => {
    const catalog = new ModelCatalog({
      fetchImpl: () => new Promise(() => {}), // nunca resuelve
      log: noopLog,
      startupRetryMs: 10,
    });
    const started = Date.now();
    await catalog.warm(150);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
