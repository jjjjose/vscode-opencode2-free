/**
 * Errores del lane anónimo de OpenCode Zen y su clasificación.
 *
 * La clasificación sigue la matriz verificada en opencode2dsh (MIT):
 * el 403 se usa tanto para región como para la restricción del tier gratuito,
 * y el cuerpo del error trae marcadores distinguibles (RegionError,
 * FreeTierError). Se conserva el mensaje original cuando aporta contexto.
 */

export type ZenErrorKind =
  | 'rate-limit'
  | 'region'
  | 'free-tier'
  | 'auth'
  | 'not-found'
  | 'invalid'
  | 'server'
  | 'timeout'
  | 'transport'
  | 'empty-response'
  | 'aborted'
  | 'unknown';

export interface ZenErrorOptions {
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ZenError extends Error {
  readonly kind: ZenErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: ZenErrorKind, message: string, options: ZenErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ZenError';
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function classifyErrorText(text: string): ZenErrorKind | undefined {
  // El 403 de región y el del tier gratuito son restricciones del cliente,
  // no credenciales inválidas (el lane anónimo no usa clave personal).
  if (/\bRegionError\b|not available in your country/i.test(text)) return 'region';
  if (/\bFreeTierError\b|free tier can only be used from within OpenCode/i.test(text)) return 'free-tier';
  if (/insufficient|quota|billing/i.test(text)) return 'rate-limit';
  if (/\b429\b|rate.?limit/i.test(text)) return 'rate-limit';
  if (/\b(?:401|403)\b/.test(text)) return 'auth';
  if (/\b410\b|deprecated/i.test(text)) return 'not-found';
  if (/\b404\b|model.*not found|unknown model/i.test(text)) return 'not-found';
  if (/\b413\b|payload too large|request body too large/i.test(text)) return 'invalid';
  if (/\b400\b|invalid.?request/i.test(text)) return 'invalid';
  if (/\b5\d\d\b/.test(text)) return 'server';
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return 'timeout';
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|terminated|premature close/i.test(text)) return 'transport';
  return undefined;
}

/** Clasifica una respuesta HTTP no exitosa del lane. */
export function classifyZenHttpError(status: number, bodyText: string): ZenErrorKind {
  const byText = classifyErrorText(bodyText);
  if (byText !== undefined) return byText;
  if (status === 429) return 'rate-limit';
  if (status === 403) return 'free-tier';
  if (status === 401) return 'auth';
  if (status === 404 || status === 410) return 'not-found';
  if (status >= 500) return 'server';
  if (status >= 400) return 'invalid';
  return 'unknown';
}

/** Clasifica un error lanzado fuera de una respuesta HTTP (red, timeout). */
export function classifyTransportError(err: unknown): ZenErrorKind {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/abort/i.test(text)) return 'aborted';
  return classifyErrorText(text) ?? 'transport';
}

/** Mensaje en español con la acción recomendada, conservando el detalle upstream. */
export function describeZenError(kind: ZenErrorKind, status: number | undefined, detail: string): string {
  const trimmed = detail.trim().slice(0, 600);
  const suffix = trimmed.length > 0 ? ` Detalle: ${trimmed}` : '';
  switch (kind) {
    case 'rate-limit':
      return `El lane gratuito de OpenCode Zen está limitado ahora mismo (contención). Espera unos segundos y reintenta.${suffix}`;
    case 'region':
      return `OpenCode Zen ha rechazado la petición por región para este modelo. Prueba con otro modelo disponible en tu zona.${suffix}`;
    case 'free-tier':
      return `OpenCode Zen restringió el uso del tier gratuito desde este cliente.${suffix}`;
    case 'auth':
      return `OpenCode Zen rechazó la petición anónima (${status ?? 'sin estado'}).${suffix}`;
    case 'not-found':
      return `El modelo ya no está disponible en OpenCode Zen. Actualiza el catálogo con «OpenCode Free: Actualizar modelos».${suffix}`;
    case 'invalid': {
      const hint = /maximum number of items is 128|"param"\s*:\s*"tools"/i.test(trimmed)
        ? ' La petición incluyó más herramientas de las que el modelo admite (máximo 128): desactiva servidores MCP o herramientas de la sesión y reintenta.'
        : '';
      return `OpenCode Zen rechazó la petición como inválida.${suffix}${hint}`;
    }
    case 'server':
      return `OpenCode Zen devolvió un error interno (${status ?? 500}). Reintenta en un momento.${suffix}`;
    case 'timeout':
      return `La respuesta de OpenCode Zen agotó el tiempo de espera.${suffix}`;
    case 'transport':
      return `No se pudo conectar con OpenCode Zen (red/proxy).${suffix}`;
    case 'empty-response':
      return `El modelo devolvió una respuesta vacía. Prueba de nuevo o usa otro modelo.${suffix}`;
    case 'aborted':
      return `Petición cancelada.${suffix}`;
    default:
      return `Error al hablar con OpenCode Zen.${suffix}`;
  }
}
