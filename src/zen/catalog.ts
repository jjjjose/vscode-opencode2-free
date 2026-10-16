import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { LoggerLike } from '../log';
import { opencodeUserAgent } from './ids';

/**
 * Catálogo de modelos del lane anónimo de OpenCode Zen.
 *
 * Puerto de la cadena de decisión verificada en opencode2dsh (MIT,
 * https://github.com/FishBottle7/opencode2dsh, packages/plugin/src/adapter/catalog.ts):
 *
 *   S1  GET {zen}/v1/models             catálogo en vivo (gratis y de pago)
 *   S2  GET https://models.dev/api.json metadatos de precio y capacidades
 *
 * Expuesto al selector = S1 ∩ permitidos; caché ante fallos de red.
 * Los precios explícitos mandan sobre el nombre: un modelo conocido como de
 * pago nunca se anuncia como gratuito.
 */

export const ZEN_BASE_URL = 'https://opencode.ai/zen';


export function isFreeModel(model: string): boolean {
  return model.toLowerCase().includes('free');
}

export interface AnonymousDecision {
  allowed: boolean;
  source: string;
  known: boolean;
}

export interface ModelPrice {
  name?: string;
  family?: string;
  version?: string;
  variant?: string;
  maxInput?: number;
  toolCalling?: boolean;
  protocol?: string;
  input?: number;
  output?: number;
  deprecated?: boolean;
  reasoning?: boolean;
  effortValues?: string[];
  contextWindow?: number;
  maxOutput?: number;
  modalities?: string[];
}

/**
 * Decisión de acceso anónimo: un veredicto listo de los metadatos (incluida
 * la deprecación) siempre gana. El respaldo por nombre solo actúa mientras los
 * metadatos están pendientes (arranque o descarga lenta); una vez cargados,
 * un modelo ausente del feed NO se expone: preferimos no anunciar límites
 * inventados (un presupuesto irreal hace que el modo agente de VS Code aborte
 * turnos con «contexto estático excedido»).
 */
export function decide(model: string, price: ModelPrice | undefined, ready: boolean): AnonymousDecision {
  const nameFree = isFreeModel(model);
  const fallback = (source: string): AnonymousDecision => {
    if (nameFree) return { allowed: true, source: 'name_free', known: false };
    return { allowed: false, source, known: false };
  };
  if (!ready) return fallback('metadata_pending');
  if (!price) return { allowed: false, source: 'metadata_model_missing', known: false };
  if (price.deprecated) return { allowed: false, source: 'metadata_deprecated', known: true };
  const metadataFree = price.input === 0 && price.output === 0;
  if (metadataFree) {
    return { allowed: true, source: nameFree ? 'name_and_metadata_free' : 'metadata_free', known: true };
  }
  if (price.input === undefined || price.output === undefined) {
    return { allowed: false, source: 'metadata_cost_unknown', known: false };
  }
  return { allowed: false, source: 'metadata_paid', known: true };
}


/** Usa la sección de proveedor OpenCode de models.dev, prefiriendo la clave exacta. */
export function decodeModelsDev(data: unknown): Map<string, ModelPrice> {
  const result = new Map<string, ModelPrice>();
  if (!data || typeof data !== 'object') return result;
  const providers = data as Record<string, { models?: Record<string, Record<string, unknown>>; id?: unknown; name?: unknown }>;
  const keys = Object.keys(providers);
  const rank = (key: string): number => {
    const lower = key.toLowerCase();
    if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 0;
    if (lower.includes('opencode')) return 1;
    return 2;
  };
  keys.sort((left, right) => {
    const leftRank = rank(left);
    const rightRank = rank(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  });
  for (const key of keys) {
    if (rank(key) > 1) continue;
    const provider = providers[key];
    if (!provider || typeof provider !== 'object') continue;
    if (rank(key) === 1) {
      const identity = `${provider.id ?? ''} ${provider.name ?? ''}`.toLowerCase().trim();
      if (!identity.includes('opencode')) continue;
    }
    const models = provider.models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelKey, raw] of Object.entries(models)) {
      if (!raw || typeof raw !== 'object') continue;
      const modelId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : modelKey;
      const cost = (raw.cost ?? {}) as Record<string, unknown>;
      const limit = (raw.limit ?? {}) as Record<string, unknown>;
      const modalities = (raw.modalities ?? {}) as Record<string, unknown>;
      const num = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      const contextWindow = num(limit.context);
      const maxOutput = num(limit.output);
      const inputModalities = decodeModalities(modalities.input);
      result.set(modelId, {
        ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
        ...(typeof raw.family === 'string' ? { family: raw.family } : {}),
        ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
        ...(typeof raw.variant === 'string' ? { variant: raw.variant } : {}),
        ...(num(limit.input) !== undefined ? { maxInput: num(limit.input) } : {}),
        ...(typeof raw.tool_call === 'boolean' ? { toolCalling: raw.tool_call } : {}),
        ...(typeof (raw.provider as { npm?: unknown } | undefined)?.npm === 'string'
          ? { protocol: (raw.provider as { npm: string }).npm } : {}),
        input: num(cost.input),
        output: num(cost.output),
        ...(raw.deprecated !== undefined || raw.status !== undefined || raw.lifecycle !== undefined || raw.deprecated_at !== undefined || raw.retirement_date !== undefined ? { deprecated: metadataDeprecated(raw) } : {}),
        ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
        ...decodeEffortValues(raw.reasoning_options),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutput !== undefined ? { maxOutput } : {}),
        ...(inputModalities !== undefined ? { modalities: inputModalities } : {}),
      });
    }
    if (result.size > 0) return result;
  }
  return result;
}

function metadataDeprecated(model: Record<string, unknown>): boolean {
  if (model.deprecated === true) return true;
  const status = String(model.status ?? model.lifecycle ?? '').toLowerCase();
  if (status === 'deprecated' || status === 'retired' || status === 'disabled') return true;
  return model.deprecated_at != null || model.retirement_date != null;
}

/** models.dev `reasoning_options`: solo las entradas `effort` llevan niveles. */
function decodeEffortValues(raw: unknown): { effortValues?: string[] } {
  if (!Array.isArray(raw)) return {};
  const values: string[] = [];
  for (const option of raw) {
    if (typeof option !== 'object' || option === null) continue;
    const entry = option as { type?: unknown; values?: unknown };
    if (entry.type !== 'effort' || !Array.isArray(entry.values)) continue;
    for (const value of entry.values) {
      if (typeof value === 'string' && value.trim().length > 0 && !values.includes(value)) values.push(value);
    }
  }
  return values.length > 0 ? { effortValues: values } : { effortValues: [] };
}

/** models.dev `modalities.input` (["text","image",...]). */
function decodeModalities(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const kinds: string[] = [];
  for (const kind of input) {
    if (typeof kind === 'string' && kind.length > 0 && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds.length > 0 ? kinds : undefined;
}

export interface CatalogSnapshot {
  status: 'pending' | 'ready' | 'stale' | 'error';
  total: number;
  exposed: number;
  lastRefresh?: string;
}

export interface CatalogOptions {
  /** Cadencia de refresco de S1 en segundos. */
  refreshSeconds?: number;
  /** Ruta del caché de metadatos de models.dev. */
  cachePath?: string;
  /** Overrides de test. */
  zenBaseUrl?: string;
  metadataUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Se dispara tras cada ronda de refresco. */
  onRefresh?: (status: CatalogSnapshot, lastError: string) => void;
  /** Retraso entre reintentos de arranque mientras S1 está vacío (15s por defecto). */
  startupRetryMs?: number;
  log?: LoggerLike;
}

const METADATA_REFRESH_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

export class ModelCatalog {
  #zen: Set<string> = new Set();
  #updatedAt = 0;
  #prices: Map<string, ModelPrice> = new Map();
  #zenMetadata: Map<string, ModelPrice> = new Map();
  #pricesReady = false;
  #lastError = '';
  #zenFailed = false;
  #refreshSeconds: number;
  #cachePath?: string;
  #zenBaseUrl: string;
  #metadataUrl: string;
  #fetch: typeof fetch;
  #now: () => number;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #onRefresh?: (status: CatalogSnapshot, lastError: string) => void;
  #startupRetryMs: number;
  #log?: LoggerLike;
  #refreshing: Promise<void> | null = null;

  constructor(options: CatalogOptions = {}) {
    this.#refreshSeconds = options.refreshSeconds ?? 300;
    this.#cachePath = options.cachePath;
    this.#zenBaseUrl = options.zenBaseUrl ?? ZEN_BASE_URL;
    this.#metadataUrl = options.metadataUrl ?? 'https://models.dev/api.json';
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#onRefresh = options.onRefresh;
    this.#startupRetryMs = options.startupRetryMs ?? 15_000;
    this.#log = options.log;
  }

  /** Arranca el bucle de refresco: S1+S2 inmediatos, reintentos rápidos mientras
   *  S1 esté vacío (la primera descarga compite con la red al arrancar), luego
   *  la cadencia normal. */
  async start(): Promise<void> {
    await this.refreshOnce();
    let attempts = 0;
    while (this.#updatedAt === 0 && attempts < 4 && !this.#stopped) {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, this.#startupRetryMs));
      if (this.#stopped) return;
      await this.refreshOnce();
    }
    if (this.#stopped) return;
    this.#armTimer();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Ajusta la cadencia con el bucle ya arrancado. */
  setRefreshSeconds(seconds: number): void {
    const next = Math.max(1, Math.floor(seconds));
    if (next === this.#refreshSeconds) return;
    this.#refreshSeconds = next;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#armTimer();
    }
  }

  #armTimer(): void {
    this.#timer = setInterval(() => {
      void this.refreshOnce();
    }, this.#refreshSeconds * 1000);
    this.#timer.unref?.();
  }

  /** Una ronda de refresco, deduplicada mientras esté en vuelo. */
  refreshOnce(): Promise<void> {
    if (this.#refreshing === null) {
      this.#refreshing = this.#refreshRound().finally(() => {
        this.#refreshing = null;
      });
    }
    return this.#refreshing;
  }

  async #refreshRound(): Promise<void> {
    await Promise.allSettled([this.refreshZen(), this.refreshMetadata()]);
    if (this.#onRefresh) {
      try {
        this.#onRefresh(this.snapshot(), this.#lastError);
      } catch {
        // los observadores nunca deben romper el bucle de refresco
      }
    }
  }

  async refreshZen(): Promise<void> {
    try {
      if (this.#cachePath && this.#updatedAt === 0) {
        try {
          const cache = JSON.parse(await readFile(`${this.#cachePath}.roster`, 'utf8')) as { ids: string[]; updatedAt: number; metadata?: Array<[string, ModelPrice]> };
          if (Array.isArray(cache.ids) && cache.ids.every(id => typeof id === 'string') &&
              Number.isFinite(cache.updatedAt) && this.#now() - cache.updatedAt < 7 * METADATA_REFRESH_MS) {
            this.#zen = new Set(cache.ids);
            this.#updatedAt = cache.updatedAt;
            if (Array.isArray(cache.metadata)) this.#zenMetadata = new Map(cache.metadata);
          }
        } catch { /* primer arranque o caché inválido */ }
      }
      const ids = await fetchZenModels(this.#zenBaseUrl, this.#fetch, opencodeUserAgent(), metadata => { this.#zenMetadata = metadata; });
      this.#zen = new Set(ids);
      this.#zenFailed = false;
      this.#updatedAt = this.#now();
      this.#lastError = '';
      this.#log?.debug(`catálogo Zen: ${ids.length} modelos en vivo`);
      if (this.#cachePath) {
        try {
          await mkdir(dirname(this.#cachePath), { recursive: true });
          await writeFile(`${this.#cachePath}.roster.tmp`, JSON.stringify({ ids, updatedAt: this.#updatedAt, metadata: [...this.#zenMetadata] }), 'utf8');
          await rename(`${this.#cachePath}.roster.tmp`, `${this.#cachePath}.roster`);
        } catch (error) { this.#log?.warn(`no se pudo guardar el catálogo: ${String(error)}`); }
      }
    } catch (err) {
      this.#zenFailed = true;
      this.#lastError = err instanceof Error ? err.message : String(err);
      this.#log?.warn(`catálogo Zen no disponible: ${this.#lastError}`);
    }
  }

  async refreshMetadata(): Promise<void> {
    // Stale-while-revalidate: un models.dev lento no debe dejar sin
    // capacidades a la primera lectura; el caché en disco sirve de base.
    if (this.#cachePath && !this.#pricesReady) {
      const cached = await loadMetadataCache(this.#cachePath, this.#now).catch(() => null);
      if (cached && cached.size > 0) {
        this.#prices = cached;
        this.#pricesReady = true;
      }
    }
    try {
      const data = await fetchJson(this.#fetch, this.#metadataUrl, { headers: { accept: 'application/json' } });
      const prices = decodeModelsDev(data);
      if (prices.size === 0) throw new Error('models.dev no contiene metadatos de OpenCode');
      this.#prices = prices;
      this.#pricesReady = true;
      this.#log?.debug(`metadatos models.dev: ${prices.size} modelos`);
      if (this.#cachePath) await saveMetadataCache(this.#cachePath, prices, this.#now());
    } catch (err) {
      if (this.#cachePath && !this.#pricesReady) {
        const cached = await loadMetadataCache(this.#cachePath, this.#now).catch(() => null);
        if (cached && cached.size > 0) {
          this.#prices = cached;
          this.#pricesReady = true;
          return;
        }
      }
      this.#lastError = err instanceof Error ? err.message : String(err);
      this.#log?.warn(`metadatos models.dev no disponibles: ${this.#lastError}`);
    }
  }

  /** Espera acotada al primer fetch en vivo, para que la primera lectura del
   *  selector nunca se conteste solo con la lista estática. */
  async warm(ms = 4_000): Promise<void> {
    if (this.#zen.size > 0 || this.#stopped) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
    try {
      await Promise.race([this.refreshOnce().catch(() => {}), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  decision(model: string): AnonymousDecision {
    const protocol = this.metadata(model)?.protocol;
    if (protocol && protocol !== '@ai-sdk/openai-compatible') return { allowed: false, source: 'unsupported_protocol', known: true };
    const entry = this.metadata(model);
    return decide(model, entry, this.#pricesReady || entry !== undefined);
  }

  /** ids expuestos al selector: catálogo dinámico ∩ permitidos. */
  list(): string[] {
    if (this.#zen.size === 0) {
      return [];
    }
    const out: string[] = [];
    for (const model of this.#zen) {
      if (this.decision(model).allowed) out.push(model);
    }
    return out.sort();
  }

  /** Límites declarados por models.dev para un modelo. */
  metadata(model: string): ModelPrice | undefined {
    const remote = this.#zenMetadata.get(model);
    const secondary = this.#prices.get(model);
    if (!remote) return secondary;
    const defined = Object.fromEntries(Object.entries(remote).filter(([, value]) => value !== undefined));
    return { ...secondary, ...defined } as ModelPrice;
  }

  available(): string[] { return [...this.#zen].sort(); }

  source(model: string): string {
    return this.#zenMetadata.has(model) ? 'OpenCode + models.dev' : this.#prices.has(model) ? 'models.dev' : 'estimación conservadora';
  }

  limits(model: string): { contextWindow?: number; maxInput?: number; maxOutput?: number } | undefined {
    const price = this.metadata(model);
    if (!price) return undefined;
    if (price.contextWindow === undefined && price.maxInput === undefined && price.maxOutput === undefined) return undefined;
    return {
      ...(price.maxInput !== undefined ? { maxInput: price.maxInput } : {}),
      ...(price.contextWindow !== undefined ? { contextWindow: price.contextWindow } : {}),
      ...(price.maxOutput !== undefined ? { maxOutput: price.maxOutput } : {}),
    };
  }

  /** Modos de entrada aceptados (["text","image",...]) o undefined sin datos. */
  modalities(model: string): string[] | undefined {
    const modalities = this.metadata(model)?.modalities;
    return modalities === undefined ? undefined : [...modalities];
  }

  /** Capacidad de razonamiento declarada por models.dev. */
  reasoningCapability(model: string): { reasoning: boolean; effortValues: string[] } | undefined {
    const price = this.metadata(model);
    if (!price) return undefined;
    return { reasoning: price.reasoning === true, effortValues: price.effortValues ?? [] };
  }

  snapshot(): CatalogSnapshot {
    const age = this.#updatedAt === 0 ? Infinity : this.#now() - this.#updatedAt;
    const stale = this.#updatedAt !== 0 && age > 10 * 60 * 1000;
    return {
      status: this.#updatedAt === 0 ? (this.#zenFailed ? 'error' : 'pending') : this.#zenFailed || stale ? 'stale' : 'ready',
      total: this.#zen.size,
      exposed: this.list().length,
      ...(this.#updatedAt !== 0 ? { lastRefresh: new Date(this.#updatedAt).toISOString() } : {}),
    };
  }

  /** Firma de la lista expuesta: permite detectar cambios reales del catálogo. */
  signature(): string {
    return JSON.stringify(this.list().map(id => [id, this.metadata(id)]));
  }

  get lastError(): string {
    return this.#lastError;
  }
}

async function fetchJson(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Tiempo de espera del catálogo agotado')); }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`catálogo devolvió HTTP ${response.status}`);
      return response.json();
    })()]);
  } finally {
    clearTimeout(timer);
  }
}

/** S1: catálogo en vivo con las cabeceras de correlación de la CLI. */
export async function fetchZenModels(
  zenBaseUrl: string,
  fetchImpl: typeof fetch,
  userAgent: string,
  onMetadata?: (metadata: Map<string, ModelPrice>) => void,
): Promise<string[]> {
  const payload = await fetchJson(fetchImpl, `${zenBaseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: {
        authorization: 'Bearer public',
        'user-agent': userAgent,
        'x-opencode-client': 'cli',
        accept: 'application/json',
      },
    }) as { data?: Array<{ id?: unknown }> };
  if (!payload || !Array.isArray(payload.data) || payload.data.some(item => !item || typeof item.id !== 'string' || !item.id)) {
    throw new Error('El catálogo de modelos tiene un formato inválido');
  }
  const models: string[] = [];
  const enriched = payload.data.filter(item => Object.keys(item).some(key => ['limit', 'cost', 'name', 'modalities', 'tool_call', 'provider', 'reasoning', 'reasoning_options'].includes(key)));
  onMetadata?.(decodeModelsDev({ opencode: { models: Object.fromEntries(enriched.map(item => [item.id, item])) } }));
  for (const item of payload.data ?? []) {
    if (typeof item?.id === 'string' && item.id.length > 0) models.push(item.id);
  }
  return models;
}

interface MetadataCache {
  updatedAt: number;
  prices: Array<[string, ModelPrice]>;
}

async function saveMetadataCache(path: string, prices: Map<string, ModelPrice>, now: number): Promise<void> {
  const cache: MetadataCache = { updatedAt: now, prices: [...prices] };
  const tmp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(cache), 'utf8');
  await rm(path, { force: true });
  await rename(tmp, path);
}

async function loadMetadataCache(path: string, now: () => number = Date.now): Promise<Map<string, ModelPrice>> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as MetadataCache;
  if (now() - raw.updatedAt > 7 * METADATA_REFRESH_MS) {
    throw new Error('caché de models.dev demasiado antiguo');
  }
  return new Map(raw.prices);
}
