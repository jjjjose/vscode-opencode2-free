# Changelog

## 0.1.0

- Proveedor `LanguageModelChatProvider` («OpenCode Free») con los modelos gratuitos del lane anónimo de OpenCode Zen en el selector de modelos del chat de VS Code.
- Catálogo en cascada: `/v1/models` en vivo ∩ metadatos de models.dev, con lista estática de respaldo y exclusión verificada de modelos bloqueados o exclusivos de Responses.
- Cliente con streaming SSE, forma del lane (`bash`+`read`, sesión canónica, cabeceras de la CLI), reintentos con backoff/Retry-After y vigilantes de vida.
- Conversión completa de mensajes: sistema, imágenes (según capacidades del modelo), resultados de herramientas y llamadas del historial.
- Reenvío de llamadas a herramientas a VS Code con validación de JSON y descarte de nombres no declarados.
- Comandos de gestión, refresco y diagnóstico; ajustes de catálogo, tiempos y reintentos; registros sin contenido de conversación.
- Pruebas: SSE, forma del lane, ids, catálogo, cliente HTTP (servidor Zen simulado), conversión, agregador y contador de tokens.
