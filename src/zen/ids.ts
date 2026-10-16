import { createHash, randomBytes } from 'node:crypto';

/**
 * Identificadores de correlación del lane anónimo de OpenCode Zen.
 *
 * Puerto del comportamiento verificado en opencode2dsh (MIT,
 * https://github.com/FishBottle7/opencode2dsh, packages/plugin/src/adapter/ids.ts),
 * a su vez derivado de opencode2api. Resumen de la evidencia recogida ahí:
 *
 * - El lane gratuito exige un id de sesión con forma canónica
 *   `ses_` + 12 hex + 14 base62; cualquier otra forma responde 403
 *   FreeTierError.
 * - Los 12 caracteres hex no son arbitrarios: codifican el reloj en
 *   milisegundos invertido bit a bit (con un contador en los 12 bits bajos),
 *   y el lane decodifica y valida que el contador esté en [0, 63].
 *   Un prefijo derivado de un hash es rechazado casi siempre.
 *
 * Estas son observaciones del proyecto de referencia, no un contrato
 * documentado por OpenCode; el comportamiento del servicio puede cambiar.
 */

export interface RequestIDs {
  session: string;
  request: string;
  project: string;
  parentSession: string;
}

/** sha256("prefix\0value") truncado a 12 bytes: estable y no reversible. */
export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest();
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`;
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`;
}

/**
 * La señal de conversación: JSON del contenido del primer mensaje de usuario.
 * Usar el primer turno mantiene estable una conversación multivuelta y separa
 * conversaciones con comienzos distintos.
 */
export function conversationSeed(messages: Array<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const encoded = JSON.stringify(message.content ?? null);
    if (encoded !== 'null' && encoded.length > 0) return encoded;
  }
  return '';
}

/**
 * Deriva los ids de correlación de una petición. En este adaptador no hay
 * cabeceras entrantes de OpenCode: la semilla es la propia conversación.
 */
export function deriveRequestIDs(messages: Array<{ role: string; content: unknown }>): RequestIDs {
  let signal = conversationSeed(messages);
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16);
  return {
    session: canonicalSessionID(signal),
    request: randomID('req', 16),
    project: stableID('prj', 'vscode-opencode-free:default-project'),
    parentSession: '',
  };
}

const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62Fixed(value: bigint, width: number): string {
  const base = 62n;
  let n = value;
  const out = new Array<string>(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base));
    n /= base;
  }
  return out.join('');
}

/**
 * Los 12 caracteres hex que emite un cliente genuino de OpenCode: reloj en
 * milisegundos + secuencia por milisegundo en los 12 bits bajos, todo
 * invertido bit a bit. Se acuña siempre con contador 1: esta extensión es la
 * única escritora de sus sesiones.
 */
export function invertedTimestampHex(now: number = Date.now()): string {
  const current = BigInt(now) * 0x1000n + 1n;
  const inverted = ~current & 0xffffffffffffn;
  return inverted.toString(16).padStart(12, '0');
}

/**
 * Sesión sintetizada, memoizada por señal de conversación. El reloj debe
 * acuñarse UNA vez por conversación: el upstream agrupa cuota y caché de
 * prompts por sesión, así que un reloj nuevo por petición rompería el
 * reuso de caché entre turnos.
 */
const SESSION_MEMO_LIMIT = 1024;
const sessionMemo = new Map<string, string>();

export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal;

  const memoized = sessionMemo.get(signal);
  if (memoized !== undefined) return memoized;

  const sum = createHash('sha256').update('ses\x00' + signal).digest();
  const timePart = invertedTimestampHex();
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14);
  const session = `ses_${timePart}${randomPart}`;

  // Evicción FIFO del más antiguo: 1024 conversaciones vivas exceden
  // cualquier ventana realista; recuñar solo cuesta afinidad de caché.
  if (sessionMemo.size >= SESSION_MEMO_LIMIT) {
    const oldest = sessionMemo.keys().next();
    if (!oldest.done) sessionMemo.delete(oldest.value);
  }
  sessionMemo.set(signal, session);
  return session;
}

/** User-agent idéntico a la CLI de OpenCode (valores de runtime Node). */
export function opencodeUserAgent(): string {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`;
}

/**
 * Conjunto completo de cabeceras de correlación que acompañan cada petición
 * al lane anónimo.
 */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  };
}
