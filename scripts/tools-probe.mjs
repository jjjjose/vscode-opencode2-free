/**
 * Sondea el tope de herramientas del lane anónimo (el upstream rechaza más
 * de 128 por petición).
 *
 * Uso:
 *   node scripts/tools-probe.mjs [modelo] [caso]
 *
 * Casos:
 *   limite   → 128 herramientas con bash+read presentes (sin inyección)
 *   holgado  → 126 herramientas sin bash/read (el gate completa hasta 128)
 *   recorte  → 128 herramientas sin bash/read (el gate inyecta y recorta a 128)
 *
 * Compila antes (`npm run compile`). No forma parte de la extensión: es una
 * utilidad de verificación contra el lane real y gratuito.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ZenClient } = require('../out/zen/client.js');
const { buildChatBody, FREE_LANE_GATE_TOOL_NAMES } = require('../out/zen/payload.js');
const { deriveRequestIDs } = require('../out/zen/ids.js');

const model = process.argv[2] ?? 'cat-jam-free';
const testCase = process.argv[3] ?? 'recorte';

const dummy = (name) => ({ name, description: 'probe', inputSchema: { type: 'object', properties: {} } });
const gate = FREE_LANE_GATE_TOOL_NAMES.map((name) => dummy(name));
const filler = (count) => Array.from({ length: count }, (_, i) => dummy(`probe_${i}`));

const tools =
  testCase === 'limite' ? [...gate, ...filler(126)] : testCase === 'holgado' ? filler(126) : filler(128);

const messages = [{ role: 'user', content: 'Responde solo: ok' }];
const ids = deriveRequestIDs(messages);

let adjustment;
const body = buildChatBody({
  model,
  messages,
  tools,
  toolChoice: 'auto',
  onToolsAdjusted: (info) => {
    adjustment = info;
  },
});

const wireTools = Array.isArray(body.tools) ? body.tools.length : 0;
console.error(
  `modelo=${model} caso=${testCase} declaradas=${tools.length} wire=${wireTools}` +
    (adjustment ? ` inyectadas=${adjustment.injected.join('+') || '-'} recortadas=${adjustment.dropped.join(',') || '-'}` : ''),
);

const log = {
  debug: () => {},
  info: () => {},
  warn: (m) => console.error(`[warn] ${m}`),
  error: (m) => console.error(`[error] ${m}`),
};
const client = new ZenClient(log);

try {
  let text = '';
  for await (const event of client.streamChat(body, {
    ids,
    firstEventTimeoutMs: 30_000,
    idleTimeoutMs: 90_000,
    maxRetries: 1,
  })) {
    if (event.type === 'text') text += event.delta;
    if (event.type === 'done') console.error(`[done] finish_reason=${event.finishReason}`);
  }
  console.error(`[ok] petición aceptada · texto=${text.length} car.`);
  process.exit(0);
} catch (err) {
  console.error(`[error] ${err?.name}: ${err?.message}`);
  process.exit(1);
}
