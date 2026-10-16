import type { ZenUsage } from '../zen/streaming';

/**
 * Payload del part `usage` que VS Code interpreta (mime «usage»): el parser
 * del chat lee `prompt_tokens`/`completion_tokens` (los detalles aportan la
 * caché de lectura y, si vinieran, los tokens de razonamiento). Se incluye
 * también `total_tokens`, con la misma forma que reportan otros proveedores
 * BYOK. Es una función pura para poder probarla sin el módulo `vscode`.
 */

export interface UsagePayload {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

export function toUsagePayload(usage: ZenUsage | undefined): UsagePayload | undefined {
  if (usage === undefined) return undefined;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (input <= 0 && output <= 0) return undefined;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(usage.cacheReadTokens !== undefined && usage.cacheReadTokens > 0
      ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }
      : {}),
  };
}
