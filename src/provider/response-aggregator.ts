import { ZenError } from '../zen/errors';
import type { ChatStreamEvent, ZenUsage } from '../zen/streaming';

/**
 * Acumulador de un stream de chat: reenvía el texto a medida que llega,
 * reúne las llamadas a herramientas (que llegan partidas en deltas) y, al
 * terminar, las valida contra las herramientas declaradas por el cliente.
 *
 * Seguridad/protocolo: las llamadas cuyo nombre no esté declarado se
 * descartan (incluye los stubs de forma del lane y nombres alucinados, que
 * VS Code rechazaría igualmente). Los argumentos se validan como JSON
 * completo antes de reportar la llamada.
 */

export interface AggregatedToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface DroppedToolCall {
  name: string;
  reason: 'unknown-tool' | 'invalid-arguments' | 'unnamed';
}

export interface AggregatedSummary {
  textLength: number;
  reasoningLength: number;
  toolCalls: AggregatedToolCall[];
  dropped: DroppedToolCall[];
  finishReason: string | null;
  usage?: ZenUsage;
}

export interface AggregateSink {
  /** Texto visible, en el orden del stream. */
  text(delta: string): void;
  /** Llamada completa y validada. */
  toolCall(call: AggregatedToolCall): void;
  /** Nota legible para el usuario (p. ej. respuesta truncada sin contenido). */
  note(text: string): void;
  /** Uso reportado por el proveedor (suele llegar al cierre del stream). */
  usage?(usage: ZenUsage): void;
}

interface PendingToolCall {
  index: number;
  id?: string;
  name?: string;
  args: string;
}

export async function aggregateStream(
  events: AsyncIterable<ChatStreamEvent>,
  declaredToolNames: ReadonlySet<string>,
  sink: AggregateSink,
): Promise<AggregatedSummary> {
  const pending = new Map<number, PendingToolCall>();
  let textLength = 0;
  let hasVisibleText = false;
  let reasoningLength = 0;
  let finishReason: string | null = null;
  let usage: ZenUsage | undefined;

  for await (const event of events) {
    switch (event.type) {
      case 'text':
        hasVisibleText ||= event.delta.trim().length > 0;
        textLength += event.delta.length;
        sink.text(event.delta);
        break;
      case 'reasoning':
        reasoningLength += event.delta.length;
        break;
      case 'tool-call-delta': {
        let entry = pending.get(event.index);
        if (entry === undefined) {
          entry = { index: event.index, args: '' };
          pending.set(event.index, entry);
        }
        if (entry.id === undefined && event.id !== undefined) entry.id = event.id;
        if (event.name !== undefined) {
          entry.name = entry.name === undefined ? event.name : entry.name + event.name;
        }
        if (event.argumentsDelta.length > 0) entry.args += event.argumentsDelta;
        break;
      }
      case 'usage':
        usage = event.usage;
        sink.usage?.(event.usage);
        break;
      case 'done':
        finishReason = event.finishReason;
        break;
    }
  }

  const toolCalls: AggregatedToolCall[] = [];
  const dropped: DroppedToolCall[] = [];

  const ordered = [...pending.values()].sort((left, right) => left.index - right.index);
  for (const entry of ordered) {
    const name = (entry.name ?? '').trim();
    if (name.length === 0) {
      dropped.push({ name: '', reason: 'unnamed' });
      continue;
    }
    if (!declaredToolNames.has(name)) {
      dropped.push({ name, reason: 'unknown-tool' });
      continue;
    }
    let input: Record<string, unknown>;
    const raw = entry.args.trim();
    if (raw.length === 0) {
      input = {};
    } else {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        } else {
          dropped.push({ name, reason: 'invalid-arguments' });
          continue;
        }
      } catch {
        dropped.push({ name, reason: 'invalid-arguments' });
        continue;
      }
    }
    const call: AggregatedToolCall = {
      callId: entry.id !== undefined && entry.id.length > 0 ? entry.id : `call_${entry.index}`,
      name,
      input,
    };
    toolCalls.push(call);
    sink.toolCall(call);
  }

  const summary: AggregatedSummary = {
    textLength,
    reasoningLength,
    toolCalls,
    dropped,
    finishReason,
    ...(usage !== undefined ? { usage } : {}),
  };

  const empty = !hasVisibleText && toolCalls.length === 0;
  if (empty) {
    if (finishReason === 'length') {
      throw new ZenError('empty-response', 'La respuesta alcanzó el límite de tokens de salida sin producir contenido. Reintenta o usa otro modelo.');
    } else if (dropped.some((entry) => entry.reason === 'unknown-tool')) {
      throw new ZenError('empty-response', 'El modelo intentó invocar una herramienta no disponible y no produjo una respuesta útil. Reintenta la petición.');
    } else if (dropped.length > 0) {
      throw new ZenError('empty-response', 'El modelo devolvió una llamada a herramienta malformada y no produjo una respuesta útil. Reintenta la petición.');
    } else {
      throw new ZenError('empty-response', reasoningLength > 0
        ? 'El modelo produjo razonamiento pero ninguna respuesta visible ni llamada a herramienta.'
        : 'El modelo devolvió una respuesta vacía (sin texto visible ni llamadas a herramientas).');
    }
  }

  return summary;
}
