# Changelog

## 1.1.0

- Variantes de razonamiento dinámicas: los niveles de esfuerzo publicados por el catálogo (`reasoning_options`) aparecen en el selector como `Modelo (low)`, `Modelo (max)`, etc.; la variante elegida envía `reasoning_effort` al lane y la entrada sin sufijo conserva el comportamiento predeterminado. Sin listas fijas: cada refresco añade o retira variantes automáticamente.
- Selección de modelos robusta: identificadores locales opacos (nunca viajan como IDs de modelo) resueltos contra el catálogo vigente en cada petición; si la variante elegida desaparece tras un refresco, la extensión pide escoger otra antes de enviar.
- README reescrito en inglés (`README.md`), con versiones en español (`README.es.md`) y chino (`README.zh.md`).

## 1.0.0

- Icono del marketplace regenerado desde `media/icon.svg` (el anterior estaba malformado); nueva tarea `npm run icon` con `@resvg/resvg-js` para reproducirlo.
- Pruebas de integración con servidor Zen simulado (MockZen) y sonda de herramientas del lane.
- Empaquetado publicado como release con el `.vsix` adjunto.

## 0.1.0

- Proveedor `LanguageModelChatProvider` («OpenCode Free») con los modelos gratuitos del lane anónimo de OpenCode Zen en el selector de modelos del chat de VS Code.
- Catálogo en cascada: `/v1/models` en vivo ∩ metadatos de models.dev, con lista estática de respaldo y exclusión verificada de modelos bloqueados o exclusivos de Responses.
- Cliente con streaming SSE, forma del lane (`bash`+`read`, sesión canónica, cabeceras de la CLI), reintentos con backoff/Retry-After y vigilantes de vida.
- Conversión completa de mensajes: sistema, imágenes (según capacidades del modelo), resultados de herramientas y llamadas del historial.
- Reenvío de llamadas a herramientas a VS Code con validación de JSON y descarte de nombres no declarados.
- Comandos de gestión, refresco y diagnóstico; ajustes de catálogo, tiempos y reintentos; registros sin contenido de conversación.
- Pruebas: SSE, forma del lane, ids, catálogo, cliente HTTP (servidor Zen simulado), conversión, agregador y contador de tokens.
