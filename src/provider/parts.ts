import type * as vscode from 'vscode';

/**
 * Predicados estructurales para las partes de `LanguageModelChatRequestMessage`.
 *
 * Se evitan `instanceof` a propósito: los objetos reales llegan del extension
 * host, pero la lógica del convertidor debe poder probarse en Node puro con
 * dobles simples. Las formas reales (extHostTypeConverters) son:
 *  - texto:          LanguageModelTextPart { value: string }
 *  - datos:          LanguageModelDataPart { data: Uint8Array, mimeType: string }
 *  - llamada:        LanguageModelToolCallPart { callId, name, input }
 *  - resultado:      LanguageModelToolResultPart { callId, content: [...] }
 */

export interface TextPartLike {
  value: string;
}

export interface DataPartLike {
  mimeType: string;
  data: Uint8Array;
}

export interface ToolCallPartLike {
  callId: string;
  name: string;
  input: object;
}

export interface ToolResultPartLike {
  callId: string;
  content: readonly unknown[];
  isError?: boolean;
}

export function isDataPart(part: unknown): part is DataPartLike {
  if (typeof part !== 'object' || part === null) return false;
  const candidate = part as { mimeType?: unknown; data?: unknown };
  return (
    typeof candidate.mimeType === 'string' &&
    candidate.data !== undefined &&
    candidate.data !== null &&
    typeof (candidate.data as { byteLength?: unknown }).byteLength === 'number'
  );
}

export function isToolResultPart(part: unknown): part is ToolResultPartLike {
  if (typeof part !== 'object' || part === null) return false;
  const candidate = part as { callId?: unknown; content?: unknown; name?: unknown };
  return typeof candidate.callId === 'string' && Array.isArray(candidate.content) && candidate.name === undefined;
}

export function isToolCallPart(part: unknown): part is ToolCallPartLike {
  if (typeof part !== 'object' || part === null) return false;
  const candidate = part as { callId?: unknown; name?: unknown };
  return typeof candidate.callId === 'string' && typeof candidate.name === 'string';
}

export function isTextPart(part: unknown): part is TextPartLike {
  if (typeof part !== 'object' || part === null) return false;
  const candidate = part as { value?: unknown; mimeType?: unknown };
  return typeof candidate.value === 'string' && candidate.mimeType === undefined;
}

/** Decodifica el contenido de una DataPart no-imagen como texto. */
export function dataPartToString(part: DataPartLike): string | undefined {
  if (!part.mimeType.startsWith('text/') && !/^application\/(?:json|xml|[^;]+\+json|[^;]+\+xml)(?:;|$)/i.test(part.mimeType)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(part.data);
  } catch {
    return undefined;
  }
}

/** Convierte una DataPart de imagen en URL de datos. */
export function dataPartToDataUrl(part: DataPartLike): string {
  return `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`;
}

export function roleOf(message: vscode.LanguageModelChatRequestMessage): 'system' | 'user' | 'assistant' {
  // El host puede entregar rol System (=3) aunque los tipos estables solo
  // declaren User/Assistant; se maneja de forma defensiva.
  const role = message.role as number;
  if (role === 3) return 'system';
  if (role === 2) return 'assistant';
  return 'user';
}
