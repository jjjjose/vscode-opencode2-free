import type * as vscode from 'vscode';

import type { ModelCatalog } from '../zen/catalog';
import { modelSelections } from './model-variants';

/**
 * Construcción de la información de modelos que VS Code muestra en el
 * selector. Los límites y capacidades vienen de models.dev cuando habla; sin
 * datos se usan valores conservadores documentados.
 */

export const DEFAULT_CONTEXT_WINDOW = 8_192;
export const DEFAULT_MAX_OUTPUT = 2_048;

/**
 * Ventana desde la cual una sesión de agente con muchas herramientas/MCP
 * suele caber. El host compara el contexto estático (prompt de sistema +
 * definiciones de herramientas) contra el presupuesto del modelo *antes* de
 * llamar al proveedor: con el inflado de definiciones actual (copilot-cli#5151)
 * los modelos de 200K–262K se quedan cortos y los de ~1M entran.
 */
export const AGENT_COMFORTABLE_CONTEXT = 524_288;

export interface ModelLimitsLike {
  contextWindow?: number;
  maxInput?: number;
  maxOutput?: number;
}

function validLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Puerta de visión: la declaración de models.dev decide cuando habla; sin
 * datos se conserva el patrón verificado en vivo (familia mimo-v2.6).
 */
export function isVisionModel(_id: string, declaredModalities?: string[]): boolean {
  if (Array.isArray(declaredModalities) && declaredModalities.length > 0) {
    return declaredModalities.includes('image');
  }
  return false;
}

/** Ventana y límites efectivos que se publican para un modelo (misma fórmula que el selector). */
export function publishedWindows(limits: ModelLimitsLike | undefined): {
  contextWindow: number;
  maxInput: number;
  maxOutput: number;
  estimated: boolean;
} {
  const contextWindow = validLimit(limits?.contextWindow) ?? validLimit(limits?.maxInput) ?? DEFAULT_CONTEXT_WINDOW;
  const maxOutput = Math.min(validLimit(limits?.maxOutput) ?? DEFAULT_MAX_OUTPUT, contextWindow);
  const maxInput = Math.min(validLimit(limits?.maxInput) ?? contextWindow, contextWindow);
  const estimated = !validLimit(limits?.contextWindow) || !validLimit(limits?.maxOutput);
  return { contextWindow, maxInput, maxOutput, estimated };
}

/** Formato compacto para el selector: 8K, 200K, 262K, 1M. */
export function formatContextSize(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Math.round((tokens / 1_048_576) * 10) / 10;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function buildModelInformation(catalog: ModelCatalog): vscode.LanguageModelChatInformation[] {
  const models: vscode.LanguageModelChatInformation[] = [];
  for (const selection of modelSelections(catalog)) {
    const { modelId: id, effort } = selection;
    const limits = catalog.limits(id);
    const metadata = catalog.metadata(id);
    const { contextWindow, maxInput, maxOutput, estimated } = publishedWindows(limits);
    const name = metadata?.name ?? id;
    const displayName = metadata?.variant && !name.includes(metadata.variant) ? `${name} (${metadata.variant})` : name;
    const toolCalling = metadata?.toolCalling === true;
    const agentWide = toolCalling && contextWindow >= AGENT_COMFORTABLE_CONTEXT;
    const agentRisky = toolCalling && !agentWide;
    const prettyContext = formatContextSize(contextWindow);
    const detail = agentRisky
      ? `⚠ ${prettyContext} · si el agente no responde, usa un modelo de 1M`
      : `contexto ${prettyContext}${agentWide ? ' · recomendado para sesiones de agente' : ''}`;
    const agentNote = agentWide
      ? ' Sesiones de agente: ventana amplia, opción recomendada cuando la sesión carga muchas herramientas o servidores MCP.'
      : agentRisky
        ? ' Sesiones de agente: con muchas herramientas/MCP el contexto estático (prompt de sistema + definiciones) puede superar esta ventana y el host bloquea el turno antes de llamar al proveedor («No response was returned»). Alternativas: un modelo de 1M de este grupo o desactivar MCP/herramientas en la sesión (comando «OpenCode Free: El agente no responde»).'
        : '';
    models.push({
      id: selection.id,
      name: effort === undefined ? displayName : `${displayName} (${effort})`,
      family: metadata?.family ?? id,
      version: metadata?.version ?? '',
      detail: effort === undefined ? detail : `${effort} · ${detail}`,
      tooltip: `OpenCode Zen · contexto ${contextWindow.toLocaleString('es')} · entrada ${maxInput.toLocaleString('es')} · salida ${maxOutput.toLocaleString('es')} tokens. Fuente: ${catalog.source(id)}. ${estimated ? 'Límites parcialmente estimados (respaldo conservador).' : ''}${!validLimit(limits?.maxInput) ? ' Entrada derivada de la ventana de contexto.' : ''}${agentNote}`,
      maxInputTokens: maxInput,
      maxOutputTokens: maxOutput,
      capabilities: {
        imageInput: isVisionModel(id, catalog.modalities(id)),
        toolCalling,
      },
    });
  }
  return models;
}
