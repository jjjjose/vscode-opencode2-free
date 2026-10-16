import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelCatalog } from '../src/zen/catalog';
import { buildModelInformation } from '../src/provider/model-information';
import { modelSelections, resolveModelSelection } from '../src/provider/model-variants';

describe('variantes dinámicas', () => {
  it('normaliza niveles, conserva capacidades y elimina opciones ausentes', async () => {
    let options: unknown = [{ type: 'effort', values: ['low', '', ' ', null, 3, 'low', 'nuevo/#'] }];
    const catalog = new ModelCatalog({ fetchImpl: async url => Response.json(String(url).includes('models.dev')
      ? { opencode: { models: { 'a-free': { name: 'A', cost: { input: 0, output: 0 }, reasoning: true,
        reasoning_options: options, tool_call: true, modalities: { input: ['text', 'image'] },
        limit: { context: 100000, output: 8000 } } } } }
      : { data: [{ id: 'a-free' }] }) });
    await catalog.refreshOnce();
    const models = buildModelInformation(catalog);
    expect(models.map(model => model.name)).toEqual(['A', 'A (low)', 'A (nuevo/#)']);
    expect(new Set(models.map(model => model.id)).size).toBe(3);
    expect(models[2]).toMatchObject({ maxInputTokens: 100000, maxOutputTokens: 8000,
      capabilities: { imageInput: true, toolCalling: true } });
    expect(resolveModelSelection(catalog, models[2].id)).toMatchObject({ modelId: 'a-free', effort: 'nuevo/#' });
    options = undefined;
    await catalog.refreshOnce();
    expect(buildModelInformation(catalog).map(model => model.name)).toEqual(['A']);
    expect(() => resolveModelSelection(catalog, models[2].id)).toThrow('ya no está disponible');
  });

  it('prioriza niveles de Zen incluso cuando retira todos los niveles', async () => {
    let values = ['zen-nuevo'];
    const catalog = new ModelCatalog({ fetchImpl: async url => Response.json(String(url).includes('models.dev')
      ? { opencode: { models: { 'a-free': { cost: { input: 0, output: 0 }, reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['secundario'] }] } } } }
      : { data: [{ id: 'a-free', reasoning_options: [{ type: 'effort', values }] }] }) });
    await catalog.refreshOnce();
    expect(modelSelections(catalog).map(model => model.effort)).toEqual([undefined, 'zen-nuevo']);
    values = [];
    await catalog.refreshOnce();
    expect(modelSelections(catalog)).toEqual([{ id: 'a-free', modelId: 'a-free' }]);
  });

  it('recupera las variantes de la caché y las reemplaza al volver la red', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'variant-cache-'));
    try {
      const cachePath = join(directory, 'metadata.json');
      let values = ['low', 'max'];
      let offline = false;
      const fetchImpl: typeof fetch = async url => {
        if (offline) throw new Error('offline');
        return Response.json(String(url).includes('models.dev')
          ? { opencode: { models: { 'a-free': { cost: { input: 0, output: 0 },
            reasoning_options: [{ type: 'effort', values }] } } } }
          : { data: [{ id: 'a-free' }] });
      };
      const first = new ModelCatalog({ cachePath, fetchImpl });
      await first.refreshOnce();
      offline = true;
      const restored = new ModelCatalog({ cachePath, fetchImpl });
      await restored.refreshOnce();
      expect(modelSelections(restored)).toEqual(modelSelections(first));
      offline = false;
      values = ['future'];
      await restored.refreshOnce();
      expect(modelSelections(restored).map(model => model.effort)).toEqual([undefined, 'future']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
