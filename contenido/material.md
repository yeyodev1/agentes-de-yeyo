# Material reciente

<!--
Aquí van las cosas reales que pasaron, para que el agente escriba sobre ellas.
Agrega arriba lo más nuevo, con fecha. Puedes editarlo desde github.com (botón del lápiz) o pedírselo a Claude.
Sirven: captions o transcripciones de tus reels/vlogs, qué construiste, qué falló, métricas de LinkedIn y comentarios.
Si no hay material nuevo, el agente escribe desde el contexto fijo de voz.md sin inventar datos.
-->

## 2026-10-10
- Armé un agente que escribe y publica mis posts de LinkedIn solo, todos los días. Corre en GitHub Actions con el Claude Agent SDK y publica con la API oficial de LinkedIn. El plan original era Cloudflare Workers + un MCP de terceros, y no servía: el SDK necesita lanzar un proceso y los Workers no pueden. Este post (si lo estás leyendo) lo escribió y publicó ese agente.
