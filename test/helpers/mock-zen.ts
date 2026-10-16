import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * Servidor HTTP que imita el lane anónimo de OpenCode Zen para las pruebas
 * de integración del cliente: catálogo, streaming SSE y fallos reproducibles.
 */

export interface MockZenScript {
  /** Si se define, responde con este estado en lugar de un stream. */
  status?: number;
  /** Cabeceras extra en la respuesta (p. ej. retry-after). */
  headers?: Record<string, string>;
  /** Cuerpo de error (objeto → JSON). */
  errorBody?: unknown;
  /** Cargas `data:` a enviar en orden; los objetos se serializan como JSON. */
  chunks?: Array<Record<string, unknown> | string>;
  /** Retraso antes del primer chunk. */
  delayBeforeFirstChunkMs?: number;
  /** Retraso entre chunks. */
  delayBetweenChunksMs?: number;
  /** Cierra la conexión tras enviar N chunks (0 = justo tras cabeceras). */
  closeAfterChunks?: number;
  /** Mantiene la conexión abierta sin enviar nada (tras las cabeceras). */
  hangAfterHeaders?: boolean;
}

export interface MockZenRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  json: unknown;
}

export interface MockZenOptions {
  models?: string[];
  /** Guion por petición de chat; el último se repite. */
  chatScripts?: MockZenScript[];
}

const DEFAULT_CHAT_SCRIPT: MockZenScript = {
  chunks: [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'hola' } }] },
    { choices: [{ index: 0, delta: { content: ' mundo' }, finish_reason: 'stop' }] },
    '[DONE]',
  ],
};

export class MockZen {
  readonly requests: MockZenRequest[] = [];
  #server: Server;
  #port = 0;
  #models: string[];
  #scripts: MockZenScript[];
  #scriptIndex = 0;

  constructor(options: MockZenOptions = {}) {
    this.#models = options.models ?? ['big-pickle', 'mimo-v2.6-flash-free', 'claude-opus-5'];
    this.#scripts = options.chatScripts !== undefined && options.chatScripts.length > 0 ? options.chatScripts : [DEFAULT_CHAT_SCRIPT];
    this.#server = createServer((req, res) => void this.#handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.#server.address();
    if (address === null || typeof address === 'string') throw new Error('dirección del servidor de prueba no disponible');
    this.#port = address.port;
  }

  async stop(): Promise<void> {
    // Destruye conexiones colgadas (p. ej. los escenarios hangAfterHeaders)
    // para que close() pueda terminar.
    this.#server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get chatRequestCount(): number {
    return this.requests.filter((request) => request.path === '/v1/chat/completions').length;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let json: unknown;
    try {
      json = body.length > 0 ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }
    this.requests.push({ path: req.url ?? '', method: req.method ?? '', headers: req.headers, json });

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: this.#models.map((id) => ({ id, object: 'model' })) }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const script = this.#nextScript();
      await this.#serveChat(script, res);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  }

  #nextScript(): MockZenScript {
    const script = this.#scripts[Math.min(this.#scriptIndex, this.#scripts.length - 1)];
    this.#scriptIndex += 1;
    return script;
  }

  async #serveChat(script: MockZenScript, res: ServerResponse): Promise<void> {
    if (script.status !== undefined) {
      const payload = script.errorBody ?? { error: { message: `HTTP ${script.status}` } };
      res.writeHead(script.status, {
        'content-type': 'application/json',
        ...(script.headers ?? {}),
      });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...(script.headers ?? {}),
    });

    if (script.hangAfterHeaders === true) {
      // Se mantiene la conexión viva sin enviar datos.
      return;
    }

    const chunks = script.chunks ?? DEFAULT_CHAT_SCRIPT.chunks ?? [];
    if (script.delayBeforeFirstChunkMs !== undefined && script.delayBeforeFirstChunkMs > 0) {
      await sleep(script.delayBeforeFirstChunkMs);
    }

    let sent = 0;
    for (const chunk of chunks) {
      if (res.destroyed) return;
      sendSsePayload(res, chunk);
      sent += 1;
      if (script.closeAfterChunks !== undefined && sent >= script.closeAfterChunks) {
        res.destroy();
        return;
      }
      if (script.delayBetweenChunksMs !== undefined && script.delayBetweenChunksMs > 0) {
        await sleep(script.delayBetweenChunksMs);
      }
    }
    res.end();
  }
}

function sendSsePayload(res: ServerResponse, chunk: Record<string, unknown> | string): void {
  const payload = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
  res.write(`data: ${payload}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
