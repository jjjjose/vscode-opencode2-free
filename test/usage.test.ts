import { describe, expect, it } from 'vitest';

import { toUsagePayload } from '../src/provider/usage';

describe('payload de uso para VS Code', () => {
  it('mapea entrada/salida y caché de lectura', () => {
    expect(toUsagePayload({ inputTokens: 300, outputTokens: 12, cacheReadTokens: 128 })).toEqual({
      prompt_tokens: 300,
      completion_tokens: 12,
      total_tokens: 312,
      prompt_tokens_details: { cached_tokens: 128 },
    });
  });

  it('omite los detalles de caché cuando no hay dato', () => {
    const payload = toUsagePayload({ inputTokens: 10, outputTokens: 5 });
    expect(payload).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(payload !== undefined && 'prompt_tokens_details' in payload).toBe(false);
  });

  it('no produce payload sin uso o con ceros', () => {
    expect(toUsagePayload(undefined)).toBeUndefined();
    expect(toUsagePayload({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  });
});
