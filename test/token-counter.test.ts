import { describe, expect, it } from 'vitest';

import { countTokensForMessage, countTokensForText } from '../src/provider/token-counter';

describe('token-counter', () => {
  it('estima ~4 caracteres por token', () => {
    expect(countTokensForText('')).toBe(0);
    expect(countTokensForText('1234')).toBe(1);
    expect(countTokensForText('x'.repeat(40))).toBe(10);
  });

  it('suma texto, llamadas y resultados de herramientas', () => {
    const message = {
      role: 1,
      name: undefined,
      content: [
        { value: 'x'.repeat(8) },
        { callId: 'c1', name: 'read_file', input: { path: 'a' } },
        { callId: 'c2', content: [{ value: 'y'.repeat(8) }] },
      ],
    };
    const tokens = countTokensForMessage(message as never);
    expect(tokens).toBeGreaterThanOrEqual(4);
  });

  it('reserva presupuesto para imágenes sin tokenizar el binario', () => {
    const message = {
      role: 1,
      name: undefined,
      content: [{ mimeType: 'image/png', data: new Uint8Array(1000) }],
    };
    const tokens = countTokensForMessage(message as never);
    expect(tokens).toBeGreaterThanOrEqual(1536);
  });
});
