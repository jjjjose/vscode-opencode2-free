# OpenCode Free Chat

Extensión de VS Code que añade modelos gratuitos de **OpenCode Zen** al selector nativo de modelos del chat (Copilot Chat), sin claves de API: usa el *lane* anónimo público (`Bearer public`) con el mismo protocolo que la CLI de OpenCode.

```
Chat de VS Code ──▶ LanguageModelChatProvider ──▶ cliente Zen (streaming, cancelación)
                                                        │
                                                        ▼
                                          https://opencode.ai/zen/v1
```

## Requisitos

- VS Code **1.106** o superior.
- El panel de chat integrado (Copilot Chat) para elegir el modelo.

## Uso

1. Abre el chat (`⌃⌘I` en macOS).
2. En el selector de modelos, elige cualquier modelo bajo el proveedor **OpenCode Free** (p. ej. `big-pickle`, `mimo-v2.6-flash-free`, `deepseek-v4.1-flash-free`).
3. Conversa con normalidad: streaming, multi-turno, imágenes (en los modelos que las admiten) y herramientas (modo agente) funcionan a través de la API estándar de VS Code.

No hace falta configurar nada. El catálogo se refresca solo cada 5 minutos. El uso que devuelve el lane (tokens de entrada, salida y caché) se reporta al chat, de modo que el medidor de contexto y la compactación funcionan también con estos modelos.

### Sesiones de agente (Copilot CLI)

Las sesiones de agente no usan directamente los proveedores de la ventana donde escribes: el host de agentes publica los modelos BYOK de **una única ventana servidora** (la primera con modelos disponibles). Por eso, para ver «OpenCode Free» en el selector de las sesiones de agente:

1. Instala la extensión en el perfil normal (VSIX o Marketplace), no solo con **F5**: las ventanas de desarrollo no sirven modelos al host de agentes.
2. Recarga la ventana tras instalar o actualizar: el host publica los modelos cuando la extensión se carga.
3. Elige el modelo bajo el grupo **OpenCode Free**. Otras extensiones pueden ofrecer los mismos nombres de modelo en otro grupo, así que comprueba el grupo al seleccionar.
4. **Si un turno termina al instante con «No response was returned»** y en el canal «OpenCode Free» **no** aparece ninguna línea `petición →`, el turno se bloqueó *antes* de llegar al proveedor. Es una limitación conocida del host de agentes de VS Code ([vscode#336797](https://github.com/microsoft/vscode/issues/336797), [vscode#336980](https://github.com/microsoft/vscode/issues/336980)): el chequeo de contexto estático (prompt de sistema + definiciones de herramientas) se compara contra el presupuesto del modelo y, con muchos servidores MCP, las definiciones por sí solas lo exceden ([copilot-cli#5151](https://github.com/github/copilot-cli/issues/5151)). Opciones para esas sesiones: elegir un modelo gratuito de ventana grande (p. ej. **Space Bunny**, **LongCat 2.5 Preview**, **Nemotron 3.5 Super VL** o **Cat Jam**, ~1M tokens), desactivar servidores MCP que no uses (el MCP de GitHub es el que más definiciones suele aportar), o usar el chat/agente de la ventana, donde las herramientas se difieren. La ausencia de `petición →` en el canal distingue este caso del proveedor: si no hay línea, el corte es del host. El selector marca los modelos de ventana justa con «⚠» en el detalle (el tooltip explica la salida) y el comando `OpenCode Free: El agente no responde` ofrece los atajos: elegir modelo, abrir el selector de herramientas o ver el registro.

Además, el upstream del lane rechaza peticiones con más de 128 herramientas: si la sesión aporta más, la extensión recorta las últimas hasta 128 (tras asegurar los stubs `bash`+`read`) y registra el ajuste en el canal («ajuste de herramientas: …»).

## Comandos

| Comando | Qué hace |
| --- | --- |
| `OpenCode Free: Gestionar` | Menú rápido (también el botón de gestión del selector de modelos). |
| `OpenCode Free: Actualizar modelos` | Fuerza un refresco inmediato del catálogo. |
| `OpenCode Free: Mostrar diagnóstico` | Vuelca catálogo, decisiones por modelo y ajustes al canal de salida. |
| `OpenCode Free: El agente no responde` | Guía del bloqueo de sesiones de agente (contexto estático) con atajos: elegir modelo, abrir herramientas y ver registro. |
| `OpenCode Free: Mostrar registros` | Abre el canal de salida «OpenCode Free». |

## Ajustes

| Ajuste | Por defecto | Descripción |
| --- | --- | --- |
| `opencode-free.catalog.refreshMinutes` | `5` | Cadencia de refresco del catálogo (minutos). |
| `opencode-free.request.firstEventTimeoutSeconds` | `30` | Espera máxima hasta que Zen responde (cabeceras y primer evento). |
| `opencode-free.request.idleTimeoutSeconds` | `120` | Inactividad máxima del stream antes de abortar. |
| `opencode-free.request.maxRetries` | `3` | Reintentos ante 429/caídas **antes** de recibir contenido. |
| `opencode-free.debug` | `false` | Registros detallados (sin contenido de conversaciones). |

## Cómo funciona

### Descubrimiento de modelos

Catálogo dinámico, sin listas de modelos ni overrides de límites:

1. **S1 — catálogo en vivo**: `GET {zen}/v1/models` con `Authorization: Bearer public`.
2. **S2 — metadatos**: `https://models.dev/api.json` aporta precio, límites de contexto/salida, razonamiento y modalidades. Un veredicto explícito manda: si un modelo aparece como de pago, no se anuncia como gratuito aunque se llame `-free`. El caché vive en el almacenamiento global de la extensión con caducidad de 7 días.
3. **Caché del catálogo**: último listado válido ante fallos de red (hasta 7 días). Una actualización válida incorpora altas, bajas y modificaciones sin reinstalar. Un listado vacío válido retira todos los modelos; una respuesta malformada conserva el anterior.

Los metadatos de OpenCode, cuando existan, tienen prioridad sobre models.dev. Se publican nombre, familia/versión declaradas, entrada máxima, salida y capacidades. El contexto total aparece en el tooltip. Cambios de metadatos actualizan el selector aunque no cambien los identificadores. Los adaptadores declarados distintos de OpenAI-compatible se excluyen por compatibilidad; sin declaración se intenta Chat Completions y se conserva el error del servicio si no lo admite.

Si faltan límites —solo durante la fase transitoria en la que los metadatos aún están cargando— se usa un respaldo explícitamente estimado de 8192 tokens de contexto y 2048 de salida. Una vez cargados los metadatos, un modelo que no aparece en ellos **no se expone** al selector: es preferible no anunciar límites inventados, porque un presupuesto irreal hace que el modo agente de VS Code aborte turnos con «contexto estático excedido» (aparece en el diagnóstico como `metadata_model_missing`). Sin límite de entrada independiente se utiliza la ventana de contexto. No se inventan variantes ni capacidades. El conteo de tokens es aproximado (bytes UTF-8/4, sobrecarga de mensajes y reserva de 1536 por imagen), no un tokenizador exacto por modelo.

### El «lane» anónimo

El servicio exige una forma concreta que replica la CLI de OpenCode (matriz verificada por el proyecto de referencia [opencode2dsh](https://github.com/FishBottle7/opencode2dsh), del que este proyecto adapta el protocolo):

- Id de sesión **canónico** `ses_` + 12 hex + 14 base62, con el reloj en milisegundos invertido en los 12 hex. Se acuña una vez por conversación (derivada del primer turno) y se reutiliza para conservar la afinidad de caché.
- Cuerpo con `stream: true` y un array `tools` con forma de agente: siempre se añaden los stubs `bash` y `read` («Reserved for the host runtime; do not call it.»). Cuando la petición no trae herramientas propias se envía `tool_choice: "none"` para que el modelo nunca los invoque; si el chat está en modo agente, se reenvían las herramientas reales de VS Code y se **descartan** las llamadas a nombres no declarados (stubs incluidos).
- Cabeceras de correlación idénticas a la CLI (`x-opencode-client: cli`, `x-opencode-session`, `x-session-affinity`, `X-Session-Id`, `x-opencode-request`, `x-opencode-project`, `user-agent: opencode/…`).

> Estos requisitos son observaciones del cliente de referencia, no un contrato publicado: OpenCode puede cambiarlos en cualquier momento. La extensión falla con mensajes claros si eso ocurre.

### Robustez

- **Reintentos** con backoff exponencial + jitter ante 429/5xx, respetando `Retry-After`, solo antes de que llegue contenido (una respuesta parcial nunca se reproduce).
- **Vigilantes de vida**: tiempo máximo a cabeceras/primer evento y de inactividad del cuerpo.
- **Cancelación**: el `CancellationToken` de VS Code aborta la petición HTTP encadenada.
- **Errores tipados**: `LanguageModelError.Blocked` (región/tier), `RateLimited` (con `Retry-After` cuando está disponible), `NotFound`, y mensajes en español con la acción recomendada.

## Diagnóstico

Si algo no aparece o falla:

1. `OpenCode Free: Mostrar diagnóstico` — estado del catálogo, decisiones por modelo y ajustes.
2. `OpenCode Free: Mostrar registros` — traza de peticiones (modelo, tiempos, tokens, errores). Con `opencode-free.debug` activado hay más detalle. Nunca se registra el contenido de los mensajes.
3. Si un modelo concreto responde 403/429, prueba otro del selector: el lane gratuito tiene contención y algunos modelos son sensibles a la región.

## Desarrollo

```bash
npm install
npm run compile      # tsc → out/
npm test             # vitest: catálogo dinámico, SSE, cliente, conversión e integración
node scripts/smoke.mjs big-pickle   # prueba real contra opencode.ai (requiere red)
```

Para probar en VS Code: abre esta carpeta y pulsa **F5** (configuración «Ejecutar extensión (Extension Development Host)»). En la ventana nueva, abre el chat y elige un modelo de «OpenCode Free». El host de desarrollo sirve para el chat de esa ventana; las **sesiones de agente** requieren la extensión instalada en el perfil (ver «Sesiones de agente»).

Para empaquetar: `npx vsce package` y instala el `.vsix` generado.

## Limitaciones conocidas

- Solo se implementa el protocolo **Chat Completions**; se filtra por adaptador declarado, sin listas de nombres.
- No hay selector de esfuerzo de razonamiento: los modelos con razonamiento usan su comportamiento por defecto (el contenido de razonamiento no se muestra en el chat).
- La API estable de VS Code todavía no permite reportar consumo de tokens por parte de un proveedor; el consumo real queda en los registros.
- El lane anónimo es un servicio público sin contrato de nivel de servicio: puede limitar, bloquear por región o retirar modelos.

## Aviso legal

Este proyecto no está afiliado a OpenCode. Usa el acceso anónimo público que la propia CLI de OpenCode utiliza; revisa los términos del servicio de OpenCode Zen antes de un uso intensivo.

## Licencia

MIT. Partes del protocolo y del diseño se adaptan de [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) (MIT, © 2026 FishBottle7) y de opencode2api. Ver `LICENSE`.
