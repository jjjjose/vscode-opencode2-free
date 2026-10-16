/**
 * Prueba de humo contra el lane anónimo real de OpenCode Zen.
 *
 * Uso:
 *   node scripts/smoke.mjs [modelo] [--tools] [--reasoning]
 *
 * Compila antes (`npm run compile`). Imprime por stdout el texto del modelo y
 * por stderr los eventos de razonamiento, las llamadas a herramientas y el
 * resumen. No forma parte de la extensión: es una utilidad de verificación.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ZenClient } = require('../out/zen/client.js');
const { buildChatBody } = require('../out/zen/payload.js');
const { deriveRequestIDs } = require('../out/zen/ids.js');

const model = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'big-pickle';
const withTools = process.argv.includes('--tools');

const log = {
  debug: () => {},
  info: () => {},
  warn: (m) => console.error(`[warn] ${m}`),
  error: (m) => console.error(`[error] ${m}`),
};

const messages = [
  {
    role: 'user',
    content:
      process.env.SMOKE_PROMPT ?? 'Responde en una sola frase corta: ¿qué es OpenCode Zen?',
  },
];
const ids = deriveRequestIDs(messages);
const body = buildChatBody({
  model,
  messages,
  tools: withTools
    ? [
        {
          name: 'read_file',
          description: 'Lee un archivo del disco',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ]
    : [],
  toolChoice: 'auto',
});

console.error(`modelo=${model} herramientas=${withTools ? 1 : 0} sesión=${ids.session}`);

const client = new ZenClient(log);
let text = '';
let reasoning = 0;
const toolCalls = [];

try {
  for await (const event of client.streamChat(body, {
    ids,
    firstEventTimeoutMs: 30_000,
    idleTimeoutMs: 90_000,
    maxRetries: 2,
  })) {
    switch (event.type) {
      case 'text':
        text += event.delta;
        process.stdout.write(event.delta);
        break;
      case 'reasoning':
        reasoning += event.delta.length;
        break;
      case 'tool-call-delta': {
        const entry = toolCalls[event.index] ?? (toolCalls[event.index] = { id: event.id, name: event.name, args: '' });
        if (event.id !== undefined) entry.id = event.id;
        if (event.name !== undefined) entry.name = entry.name ?? event.name;
        entry.args += event.argumentsDelta;
        break;
      }
      case 'usage':
        console.error(
          `\n[usage] entrada=${event.usage.inputTokens} salida=${event.usage.outputTokens}` +
            (event.usage.cacheReadTokens ? ` caché=${event.usage.cacheReadTokens}` : ''),
        );
        break;
      case 'done':
        console.error(`\n[done] finish_reason=${event.finishReason}`);
        break;
    }
  }
  console.error(`[resumen] texto=${text.length} car. razonamiento=${reasoning} car.`);
  if (toolCalls.length > 0) {
    for (const call of toolCalls) {
      console.error(`[tool-call] ${call.name}(${call.args}) id=${call.id}`);
    }
  }
  process.exit(0);
} catch (err) {
  console.error(`\n[error] ${err?.name}: ${err?.message}`);
  process.exit(1);
}
