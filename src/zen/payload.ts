/**
 * Construcción del cuerpo de la petición a POST {zen}/v1/chat/completions.
 *
 * Incluye la «forma» que el lane anónimo exige (matriz verificada por
 * opencode2dsh, issue #56, 2026-10-11): una petición pasa con HTTP 200 solo si
 *   1. lleva un id de sesión canónico en una cabecera de sesión,
 *   2. el cuerpo pide `stream: true` (sin stream responde 403),
 *   3. el array `tools` tiene forma de agente: `bash`+`read` pasan (200);
 *      `bash` o `shell` solos, y N nombres conocidos sin bash/shell, dan 403.
 *      Además, el upstream rechaza más de 128 herramientas por petición: el
 *      total del wire se recorta por el final para no pasarse (se registra).
 * Los esquemas y descripciones no se inspeccionan.
 *
 * La receta adoptada es el par `bash`+`read`: mínimo, con nombres del host y
 * válido en el lane de chat. Cuando la petición no trae herramientas propias
 * se usa `tool_choice: "none"` para que el modelo nunca invoque los stubs.
 *
 * Estos requisitos son observaciones del proyecto de referencia, no un
 * contrato publicado por OpenCode; pueden cambiar sin aviso.
 */

export const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'read'] as const;
export type FreeLaneGateToolName = (typeof FREE_LANE_GATE_TOOL_NAMES)[number];

/** Tope de herramientas del wire: el upstream del lane rechaza más de 128. */
export const MAX_WIRE_TOOLS = 128;

export interface ToolsAdjustment {
  declared: number;
  final: number;
  injected: string[];
  dropped: string[];
}

export interface WireToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type WireUserPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | WireUserPart[]; name?: string }
  | {
      role: 'assistant';
      content: string | null;
      name?: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string | WireUserPart[] };

export interface ChatBodyInput {
  model: string;
  /** Nivel publicado por el catálogo; se omite para la variante predeterminada. */
  reasoningEffort?: string;
  system?: string;
  messages: WireMessage[];
  /** Herramientas declaradas por el cliente (VS Code). */
  tools: Array<{ name: string; description: string; inputSchema?: object }>;
  toolChoice: 'auto' | 'required' | 'none';
  /** Tope de herramientas del wire (por defecto {@link MAX_WIRE_TOOLS}). */
  maxTools?: number;
  /** Notifica inyecciones/recortes aplicados al array de herramientas. */
  onToolsAdjusted?: (info: ToolsAdjustment) => void;
}

/** Stub sintético que satisface la comprobación de forma del lane. */
export function freeLaneGateTool(name: FreeLaneGateToolName): WireToolDef {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  };
}

/**
 * Añade los stubs que falten (por nombre) al array de herramientas y recorta
 * las últimas si el total excediera el tope del wire. Devuelve los stubs
 * inyectados y los nombres recortados para poder registrarlo.
 */
export function appendGateTools(
  tools: WireToolDef[],
  limit = MAX_WIRE_TOOLS,
): { tools: WireToolDef[]; injected: string[]; dropped: string[] } {
  const names = new Set(tools.map((tool) => tool.function.name));
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name));
  const capacity = Math.max(0, limit - missing.length);
  const kept = tools.length > capacity ? tools.slice(0, capacity) : tools;
  const dropped = tools.length > capacity ? tools.slice(capacity).map((tool) => tool.function.name) : [];
  return { tools: [...kept, ...missing.map((name) => freeLaneGateTool(name))], injected: [...missing], dropped };
}

/** Reescribe un cuerpo chat-completions para satisfacer la comprobación de
 *  forma. Devuelve undefined si el cuerpo ya la satisface o no es un cuerpo
 *  chat-completions (el llamador conserva el original). */
export function ensureFreeLaneShape(payload: unknown, limit = MAX_WIRE_TOOLS): unknown | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body.messages)) return undefined;
  const tools = Array.isArray(body.tools) ? (body.tools as WireToolDef[]) : [];
  const { tools: nextTools, injected, dropped } = appendGateTools(tools, limit);
  if (injected.length === 0 && dropped.length === 0) return undefined;
  const next: Record<string, unknown> = { ...body };
  next.tools = nextTools;
  if (tools.length === 0 && next.tool_choice === undefined) next.tool_choice = 'none';
  return next;
}

/** Construye el cuerpo final de la petición. */
export function buildChatBody(input: ChatBodyInput): Record<string, unknown> {
  const userTools: WireToolDef[] = input.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
    },
  }));
  const { tools, injected, dropped } = appendGateTools(userTools, input.maxTools ?? MAX_WIRE_TOOLS);
  if (input.onToolsAdjusted !== undefined && (injected.length > 0 || dropped.length > 0)) {
    input.onToolsAdjusted({ declared: input.tools.length, final: tools.length, injected, dropped });
  }

  const messages: unknown[] = [];
  if (input.system !== undefined && input.system.length > 0) {
    messages.push({ role: 'system', content: input.system });
  }
  messages.push(...input.messages);

  return {
    model: input.model,
    ...(input.reasoningEffort !== undefined ? { reasoning_effort: input.reasoningEffort } : {}),
    stream: true,
    stream_options: { include_usage: true },
    messages,
    tools,
    // Sin herramientas propias el modelo no debe invocar los stubs.
    tool_choice: input.tools.length === 0 ? 'none' : input.toolChoice,
  };
}
