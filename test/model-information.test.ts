import { describe, it, expect } from 'vitest';

import type { ModelCatalog } from '../src/zen/catalog';
import {
  AGENT_COMFORTABLE_CONTEXT,
  buildModelInformation,
  formatContextSize,
  publishedWindows,
} from '../src/provider/model-information';

interface Entry {
  limits: { contextWindow?: number; maxInput?: number; maxOutput?: number };
  name: string;
  toolCalling: boolean;
}

function fakeCatalog(entries: Record<string, Entry>): ModelCatalog {
  return {
    list: () => Object.keys(entries),
    limits: (id: string) => entries[id]?.limits,
    metadata: (id: string) => ({ name: entries[id]?.name, toolCalling: entries[id]?.toolCalling }),
    modalities: () => undefined,
    source: () => 'prueba',
  } as unknown as ModelCatalog;
}

describe('información de modelos publicada en el selector', () => {
  it('formatea ventanas en estilo compacto', () => {
    expect(formatContextSize(8_192)).toBe('8K');
    expect(formatContextSize(200_000)).toBe('200K');
    expect(formatContextSize(262_144)).toBe('262K');
    expect(formatContextSize(1_000_000)).toBe('1M');
    expect(formatContextSize(1_048_576)).toBe('1M');
  });

  it('deriva entrada/salida efectivas de los límites', () => {
    expect(publishedWindows({ contextWindow: 200_000, maxInput: 160_000, maxOutput: 32_000 })).toMatchObject({
      contextWindow: 200_000,
      maxInput: 160_000,
      maxOutput: 32_000,
      estimated: false,
    });
    expect(publishedWindows({ contextWindow: 100_000 }).maxInput).toBe(100_000);
    expect(publishedWindows(undefined).contextWindow).toBe(8_192);
  });

  it('avisa en el selector los modelos con ventana justa para agentes', () => {
    const catalog = fakeCatalog({
      'chico-free': { limits: { contextWindow: 200_000, maxOutput: 32_000 }, name: 'Chico', toolCalling: true },
      'grande-free': { limits: { contextWindow: 1_048_576, maxOutput: 32_000 }, name: 'Grande', toolCalling: true },
    });
    const [chico, grande] = buildModelInformation(catalog);
    expect(chico.detail).toContain('⚠');
    expect(chico.detail).toContain('1M');
    expect(chico.tooltip).toContain('No response was returned');
    expect(grande.detail).toContain('recomendado');
    expect(grande.tooltip).toContain('ventana amplia');
    expect(AGENT_COMFORTABLE_CONTEXT).toBeLessThan(1_048_576);
  });

  it('sin herramientas no añade notas de agente', () => {
    const catalog = fakeCatalog({
      'sin-tools-free': { limits: { contextWindow: 200_000 }, name: 'Sin tools', toolCalling: false },
    });
    const [model] = buildModelInformation(catalog);
    expect(model.detail).toBe('contexto 200K');
    expect(model.tooltip).not.toContain('Sesiones de agente');
  });
});
