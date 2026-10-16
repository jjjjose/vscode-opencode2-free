import type { ModelCatalog } from '../zen/catalog';

export interface ModelSelection {
  id: string;
  modelId: string;
  effort?: string;
}

/** IDs locales opacos: nunca se envían al proveedor como IDs de modelo. */
export function modelSelections(catalog: ModelCatalog): ModelSelection[] {
  const ids = catalog.list();
  const reserved = new Set(ids);
  const selections: ModelSelection[] = [];
  for (const modelId of ids) {
    selections.push({ id: modelId, modelId });
    const metadata = catalog.metadata(modelId);
    if (metadata?.reasoning === false) continue;
    for (const effort of new Set(metadata?.effortValues ?? [])) {
      if (typeof effort !== 'string' || effort.trim().length === 0) continue;
      let id = `opencode-free:variant:${JSON.stringify([modelId, effort])}`;
      while (reserved.has(id)) id = `:${id}`;
      reserved.add(id);
      selections.push({ id, modelId, effort });
    }
  }
  return selections;
}

/** Resolver contra el catálogo actual evita reutilizar variantes retiradas. */
export function resolveModelSelection(catalog: ModelCatalog, id: string): ModelSelection {
  const selection = modelSelections(catalog).find(entry => entry.id === id);
  if (!selection) {
    throw new Error('OpenCode Free: el modelo o la variante seleccionada ya no está disponible. Selecciona otra opción en el selector de modelos.');
  }
  return selection;
}
