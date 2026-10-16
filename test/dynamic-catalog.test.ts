import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalog } from '../src/zen/catalog';
import { buildModelInformation } from '../src/provider/model-information';

describe('catálogo dinámico y límites publicados', () => {
  it('recupera catálogo y metadatos en un arranque sin red', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dynamic-catalog-'));
    try {
      const cachePath = join(directory, 'metadata.json');
      const online = new ModelCatalog({ cachePath, fetchImpl: async url => Response.json(String(url).includes('models.dev')
        ? { opencode: { models: { 'a-free': { name: 'Modelo en caché', cost: { input: 0, output: 0 }, limit: { context: 200000, input: 160000, output: 32000 } } } } }
        : { data: [{ id: 'a-free' }] }) });
      await online.refreshOnce();
      const offline = new ModelCatalog({ cachePath, fetchImpl: async () => { throw new Error('offline'); } });
      await offline.refreshOnce();
      expect(offline.list()).toEqual(['a-free']);
      expect(buildModelInformation(offline)[0]).toMatchObject({ name: 'Modelo en caché', maxInputTokens: 160000 });
      expect(offline.snapshot().status).toBe('stale');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('el timeout aborta fetch y también limita un cuerpo que no termina', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const catalog = new ModelCatalog({ fetchImpl: async (_url, init) => {
        signals.push(init!.signal!);
        return new Response(new ReadableStream({ start() { /* no termina */ } }));
      } });
      const pending = catalog.refreshOnce();
      await vi.advanceTimersByTimeAsync(30001);
      await pending;
      expect(signals).toHaveLength(2);
      expect(signals.every(signal => signal.aborted)).toBe(true);
      expect(catalog.snapshot().status).toBe('error');
    } finally { vi.useRealTimers(); }
  });
  it('reconcilia altas, bajas, nombres y límites sin cambiar código ni reiniciar', async () => {
    let ids = ['a-free'];
    let input = 160000;
    let broken = false;
    const modelEntry = (name: string) => ({ name, family: 'familia', cost: { input: 0, output: 0 }, tool_call: true,
      limit: { context: 200000, input, output: 32000 } });
    const catalog = new ModelCatalog({ fetchImpl: async (url) => {
      if (broken) throw new Error('offline');
      if (String(url).includes('models.dev')) return Response.json({ opencode: { models: Object.fromEntries(ids.map(id => [id, modelEntry(`Modelo ${id}`)])) } });
      return Response.json({ data: ids.map(id => ({ id })) });
    } });
    await catalog.refreshOnce();
    const before = catalog.signature();
    expect(buildModelInformation(catalog)[0]).toMatchObject({ name: 'Modelo a-free', family: 'familia', maxInputTokens: 160000, maxOutputTokens: 32000 });
    input = 120000;
    await catalog.refreshOnce();
    expect(catalog.signature()).not.toBe(before);
    expect(buildModelInformation(catalog)[0].maxInputTokens).toBe(120000);
    ids = ['b-free'];
    await catalog.refreshOnce();
    expect(catalog.list()).toEqual(['b-free']);
    broken = true;
    await catalog.refreshOnce();
    expect(catalog.list()).toEqual(['b-free']);
    expect(catalog.snapshot().status).toBe('stale');
    broken = false;
    ids = [];
    await catalog.refreshOnce();
    expect(catalog.list()).toEqual([]);
  });

  it('no expone modelos ausentes de los metadatos ya cargados', async () => {
    const catalog = new ModelCatalog({ fetchImpl: async url => Response.json(String(url).includes('models.dev')
      ? { opencode: { models: { 'con-datos-free': { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 } } } } }
      : { data: [{ id: 'con-datos-free' }, { id: 'sin-datos-free' }] }) });
    await catalog.refreshOnce();
    expect(catalog.list()).toEqual(['con-datos-free']);
    expect(catalog.decision('sin-datos-free').source).toBe('metadata_model_missing');
  });

  it('prioriza campos de OpenCode y completa los ausentes con models.dev', async () => {
    const catalog = new ModelCatalog({ fetchImpl: async url => Response.json(String(url).includes('models.dev')
      ? { opencode: { models: { 'a-free': { cost: { input: 0, output: 0 }, tool_call: true, limit: { context: 100000, output: 8000 } } } } }
      : { data: [{ id: 'a-free', name: 'Nombre vivo', limit: { context: 200000, input: 150000 } }] }) });
    await catalog.refreshOnce();
    expect(buildModelInformation(catalog)[0]).toMatchObject({ name: 'Nombre vivo', maxInputTokens: 150000, maxOutputTokens: 8000, capabilities: { toolCalling: true } });
  });

  it('una respuesta malformada no elimina modelos conocidos', async () => {
    let malformed = false;
    const catalog = new ModelCatalog({ fetchImpl: async url => Response.json(String(url).includes('models.dev') ? {} : malformed ? { error: 'bad' } : { data: [{ id: 'a-free' }] }) });
    await catalog.refreshOnce();
    malformed = true;
    await catalog.refreshOnce();
    expect(catalog.list()).toEqual(['a-free']);
  });
});
