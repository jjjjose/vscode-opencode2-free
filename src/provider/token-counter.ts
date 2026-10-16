import type * as vscode from 'vscode';
import { dataPartToString, isDataPart, isTextPart, isToolCallPart, isToolResultPart } from './parts';

/**
 * Conteo aproximado de tokens.
 *
 * El lane anónimo no expone un tokenizador, así que se usa la estimación
 * documentada ~4 caracteres por token, aplicada a la representación textual
 * de la entrada (texto, JSON de llamadas y resultados de herramientas y
 * otros datos). Es una estimación deliberada: VS Code la usa para el
 * presupuesto de contexto, no para facturar.
 */

const CHARS_PER_TOKEN = 4;

export function countTokensForText(text: string): number {
  if (text.length === 0) return 0;
  // UTF-8 evita infravalorar CJK y otros alfabetos frente a caracteres ASCII.
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / CHARS_PER_TOKEN));
}

/** Representación textual de una parte desconocida, acotada. */
function partToRoughText(part: unknown): string {
  if (isTextPart(part)) return part.value;
  if (isToolCallPart(part)) return `${part.name} ${safeJson(part.input)}`;
  if (isToolResultPart(part)) return part.content.map(partToRoughText).join('\n');
  if (isDataPart(part)) return part.mimeType.startsWith('image/') ? '' : dataPartToString(part) ?? '';
  if (typeof part === 'string') return part;
  return safeJson(part);
}

export function countTokensForMessage(message: vscode.LanguageModelChatRequestMessage): number {
  let tokens = 4; // delimitadores del mensaje; aproximación, no facturación
  const countPart = (part: unknown): number => {
    if (isToolResultPart(part)) return 4 + part.content.reduce<number>((sum, child) => sum + countPart(child), 0);
    // Reserva explícita: el coste real depende del modelo y resolución.
    if (isDataPart(part) && part.mimeType.startsWith('image/')) return 1536;
    return countTokensForText(partToRoughText(part)) + (isToolCallPart(part) ? 4 : 0);
  };
  for (const part of message.content ?? []) {
    tokens += countPart(part);
  }
  if (typeof message.name === 'string') tokens += countTokensForText(message.name);
  return tokens;
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
