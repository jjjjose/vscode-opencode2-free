import type * as vscode from 'vscode';

import type { WireMessage, WireUserPart } from '../zen/payload';
import {
  dataPartToDataUrl,
  dataPartToString,
  isDataPart,
  isTextPart,
  isToolCallPart,
  isToolResultPart,
  roleOf,
  type DataPartLike,
} from './parts';

/**
 * Conversión de los mensajes de VS Code al formato chat-completions.
 *
 * Reglas:
 * - Los mensajes con rol System (el host los entrega aunque los tipos
 *   estables no los declaren) se agregan al slot `system` de la petición.
 * - Las imágenes viajan como `image_url` con URL de datos SOLO si el modelo
 *   declara entrada de imagen; si no, se sustituyen por un marcador textual
 *   (el modelo nunca debe recibir una imagen que no puede ver).
 * - Los resultados de herramientas se emiten como mensajes `tool` justo
 *   después del mensaje assistant que contiene su llamada.
 * - Las llamadas de herramientas del historial se reemiten con sus
 *   argumentos serializados.
 */

export interface ConversionOptions {
  modelId: string;
  supportsImages: boolean;
}

export interface ConvertedConversation {
  system?: string;
  messages: WireMessage[];
}

export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: ConversionOptions,
): ConvertedConversation {
  const systemParts: string[] = [];
  const wire: WireMessage[] = [];

  for (const message of messages) {
    const role = roleOf(message);
    if (role === 'system') {
      const text = flattenText(message.content);
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    if (role === 'assistant') {
      const converted = convertAssistant(message, options);
      if (converted !== undefined) wire.push(converted);
      continue;
    }
    convertUser(message, options, wire);
  }

  const system = systemParts.join('\n\n');
  return system.length > 0 ? { system, messages: wire } : { messages: wire };
}

function flattenText(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const part of content) {
    if (isTextPart(part) && part.value.length > 0) parts.push(part.value);
  }
  return parts.join('\n');
}

function convertAssistant(
  message: vscode.LanguageModelChatRequestMessage,
  options: ConversionOptions,
): WireMessage | undefined {
  const textParts: string[] = [];
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

  for (const part of message.content) {
    if (isTextPart(part)) {
      if (part.value.length > 0) textParts.push(part.value);
      continue;
    }
    if (isToolCallPart(part)) {
      toolCalls.push({
        id: part.callId,
        type: 'function',
        function: { name: part.name, arguments: safeJson(part.input) },
      });
      continue;
    }
    // Imágenes y datos en mensajes assistant no son reproducibles: se omiten.
  }

  const text = textParts.join('');
  const hasToolCalls = toolCalls.length > 0;
  if (text.length === 0 && !hasToolCalls) return undefined;

  const converted: Extract<WireMessage, { role: 'assistant' }> = {
    role: 'assistant',
    content: text.length > 0 ? text : null,
    ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
  };
  if (typeof message.name === 'string' && message.name.length > 0) converted.name = message.name;
  void options;
  return converted;
}

function convertUser(
  message: vscode.LanguageModelChatRequestMessage,
  options: ConversionOptions,
  wire: WireMessage[],
): void {
  const textParts: string[] = [];
  const images: WireUserPart[] = [];
  const toolResults: Array<{ callId: string; parts: unknown[] }> = [];

  for (const part of message.content) {
    if (isToolResultPart(part)) {
      toolResults.push({ callId: part.callId, parts: [...part.content] });
      continue;
    }
    if (isDataPart(part)) {
      if (part.mimeType.startsWith('image/')) {
        if (options.supportsImages) {
          images.push({ type: 'image_url', image_url: { url: dataPartToDataUrl(part) } });
        } else {
          textParts.push(`[imagen omitida: el modelo ${options.modelId} no admite entrada de imagen]`);
        }
      } else {
        const decoded = dataPartToString(part);
        if (decoded !== undefined && decoded.length > 0) textParts.push(decoded);
        else if (decoded === undefined) textParts.push(`[adjunto ${part.mimeType} no compatible con este transporte]`);
      }
      continue;
    }
    if (isTextPart(part)) {
      if (part.value.length > 0) textParts.push(part.value);
      continue;
    }
    // Llamadas de herramienta en un mensaje de usuario no deberían existir.
  }

  // Los resultados van primero: deben quedar pegados al assistant que llamó.
  for (const result of toolResults) {
    wire.push({
      role: 'tool',
      tool_call_id: result.callId,
      content: toolResultContent(result.parts, options),
    });
  }

  const hasText = textParts.length > 0;
  const hasImages = images.length > 0;
  if (hasText || hasImages || toolResults.length === 0) {
    const content: string | WireUserPart[] =
      images.length === 0
        ? textParts.join('')
        : [...(hasText ? [{ type: 'text' as const, text: textParts.join('') }] : []), ...images];
    const converted: Extract<WireMessage, { role: 'user' }> = { role: 'user', content };
    if (typeof message.name === 'string' && message.name.length > 0) converted.name = message.name;
    wire.push(converted);
  }
}

/** Contenido de un mensaje `tool`: cadena simple o partes con imagen. */
function toolResultContent(parts: readonly unknown[], options: ConversionOptions): string | WireUserPart[] {
  const textChunks: string[] = [];
  const images: WireUserPart[] = [];
  for (const part of parts) {
    if (isTextPart(part)) {
      if (part.value.length > 0) textChunks.push(part.value);
      continue;
    }
    if (isDataPart(part)) {
      if (part.mimeType.startsWith('image/')) {
        if (options.supportsImages) {
          images.push({ type: 'image_url', image_url: { url: dataPartToDataUrl(part) } });
        } else {
          textChunks.push(`[imagen omitida en el resultado: el modelo ${options.modelId} no admite entrada de imagen]`);
        }
      } else {
        const decoded = dataPartToString(part);
        if (decoded !== undefined && decoded.length > 0) textChunks.push(decoded);
        else if (decoded === undefined) textChunks.push(`[adjunto ${part.mimeType} no compatible con este transporte]`);
      }
      continue;
    }
    if (isToolResultPart(part)) {
      // Resultados anidados
      textChunks.push(toolResultContentToString(part.content, options));
      continue;
    }
    const rough = roughPartText(part);
    if (rough.length > 0) textChunks.push(rough);
  }
  if (images.length === 0) {
    const text = textChunks.join('\n');
    return text.length > 0 ? text : '(sin salida)';
  }
  return [
    ...(textChunks.length > 0 ? [{ type: 'text' as const, text: textChunks.join('\n') }] : []),
    ...images,
  ];
}

function toolResultContentToString(parts: readonly unknown[], options: ConversionOptions): string {
  const content = toolResultContent(parts, options);
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : '[imagen]'))
    .join('\n');
}

function roughPartText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part === undefined || part === null) return '';
  try {
    const json = JSON.stringify(part);
    return json !== undefined ? json.slice(0, 4000) : '';
  } catch {
    return '';
  }
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return '{}';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '{}';
  }
}

export type { DataPartLike };
