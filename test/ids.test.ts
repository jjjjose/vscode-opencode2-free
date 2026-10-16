import { describe, expect, it } from 'vitest';

import {
  canonicalSessionID,
  deriveRequestIDs,
  disguiseHeaders,
  invertedTimestampHex,
  opencodeUserAgent,
} from '../src/zen/ids';

describe('ids del lane anónimo', () => {
  it('genera ids de sesión con la forma canónica exigida', () => {
    const session = canonicalSessionID('seed-conversación');
    expect(session).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it('los 12 hex codifican el reloj invertido con contador 1 en los bits bajos', () => {
    const hex = invertedTimestampHex(1_700_000_000_000);
    expect(hex).toMatch(/^[0-9a-f]{12}$/);
    // contador 1 → bits bajos invertidos = 0xffe (consecuencia estructural)
    expect(hex.endsWith('ffe')).toBe(true);
  });

  it('memoiza la sesión por señal de conversación', () => {
    const first = canonicalSessionID('una conversación distinta');
    const second = canonicalSessionID('una conversación distinta');
    const other = canonicalSessionID('otra conversación');
    expect(first).toBe(second);
    expect(other).not.toBe(first);
  });

  it('deja pasar ids canónicos ya existentes sin cambiarlos', () => {
    const official = 'ses_0e3ac3f8bd16XyzAbC12345678';
    expect(canonicalSessionID(official)).toBe(official);
  });

  it('deriva ids estables por conversación y petición nueva cada vez', () => {
    const messages = [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'qué tal' }];
    const first = deriveRequestIDs(messages);
    const second = deriveRequestIDs(messages);
    expect(first.session).toBe(second.session);
    expect(first.request).not.toBe(second.request);
    expect(first.project).toBe(second.project);
    expect(first.session).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it('conversaciones con distinto primer turno obtienen sesiones distintas', () => {
    const a = deriveRequestIDs([{ role: 'user', content: 'primera conversación' }]);
    const b = deriveRequestIDs([{ role: 'user', content: 'segunda conversación' }]);
    expect(a.session).not.toBe(b.session);
  });

  it('envía el juego completo de cabeceras de correlación', () => {
    const headers = disguiseHeaders(deriveRequestIDs([{ role: 'user', content: 'x' }]));
    expect(headers['x-opencode-client']).toBe('cli');
    expect(headers['user-agent']).toBe(opencodeUserAgent());
    expect(headers['x-opencode-session']).toMatch(/^ses_/);
    expect(headers['x-session-affinity']).toMatch(/^ses_/);
    expect(headers['X-Session-Id']).toMatch(/^ses_/);
    expect(headers['x-opencode-request']).toMatch(/^req_/);
    expect(headers['x-opencode-project']).toMatch(/^prj_/);
  });
});
