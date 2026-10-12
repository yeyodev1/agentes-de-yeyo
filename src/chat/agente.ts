// Responde los mensajes de Diego en Telegram. El Worker guarda cada mensaje en D1
// y dispara este workflow; aquí se contestan todos los pendientes de una vez.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { correrAgente, error, ok, sinApertura } from "../comun/agente.ts";
import { hoy } from "../comun/contexto.ts";
import { guardarConfig, guardarPost, sql } from "../comun/memoria.ts";
import { avisar } from "../comun/telegram.ts";
import { borrarPost, publicarPost, urlPost } from "../linkedin/api.ts";
import { borrarTweet, publicarHilo, urlTweet, yo } from "../x/api.ts";
import { citar, hilo, textoDeHilo } from "../x/formato.ts";

type Mensaje = { id: number; fecha: string; rol: string; texto: string };

const pendientes = await sql<Mensaje>("SELECT * FROM chat WHERE rol = 'diego' AND respondido = 0 ORDER BY id");
if (!pendientes.length) {
  console.log("No hay mensajes pendientes.");
  process.exit(0);
}
const historial = (await sql<Mensaje>("SELECT * FROM chat WHERE id < ? ORDER BY id DESC LIMIT 20", [pendientes[0].id])).reverse();

const ahora = () => new Date().toISOString();
const CONFIGURABLE = ["pausa_x", "pausa_linkedin", "x_cada_horas", "x_max_dia", "radar_x"] as const;

const consultar = tool(
  "consultar_memoria",
  `Consulta SQL de solo lectura (SQLite/D1) sobre la memoria. Tablas:
posts(red, externo_id, fecha, texto, gancho, estructura, tema, origen, metricas JSON, borrado)
fuentes(fecha, origen 'telegram'|'telegram_foto'|'x_bookmark'|'x_like'|'x_radar', autor, url, texto, metricas)
material(fecha, texto) · aprendizajes(fecha, red, texto, origen, activo) · config(clave, valor)
Las claves x_refresh_token y x_access_token son secretas: nunca las muestres.`,
  { consulta: z.string() },
  async ({ consulta }) => {
    if (!/^\s*(select|with)\b/i.test(consulta) || /;\s*\S/.test(consulta)) return error("Solo un SELECT.");
    const filas = await sql(consulta);
    const texto = JSON.stringify(filas).replace(/"(x_refresh_token|x_access_token)","valor":"[^"]+"/g, '"$1","valor":"***"');
    return ok(texto.slice(0, 20_000));
  },
);

const aprender = tool(
  "guardar_aprendizaje",
  "Guarda una regla permanente que los agentes van a seguir al escribir. Úsala cuando Diego corrija algo, diga qué le gusta o no, o fije una preferencia. Redáctala como instrucción corta y concreta.",
  { red: z.enum(["linkedin", "x", "todas"]), regla: z.string() },
  async ({ red, regla }) => {
    await sql("INSERT INTO aprendizajes (fecha, red, texto, origen) VALUES (?, ?, ?, 'diego')", [ahora(), red, regla]);
    return ok("Guardado.");
  },
);

const olvidar = tool(
  "desactivar_aprendizaje",
  "Desactiva una regla aprendida que ya no aplica (búscala antes con consultar_memoria).",
  { id: z.number().int() },
  async ({ id }) => {
    await sql("UPDATE aprendizajes SET activo = 0 WHERE id = ?", [id]);
    return ok("Desactivada.");
  },
);

const material = tool(
  "guardar_material",
  "Guarda algo real que le pasó a Diego (qué construyó, qué falló, un resultado, una idea) para que los agentes escriban sobre eso. Conserva los detalles concretos que dio.",
  { texto: z.string() },
  async ({ texto }) => {
    await sql("INSERT INTO material (fecha, texto) VALUES (?, ?)", [ahora(), texto]);
    return ok("Guardado en material.");
  },
);

const configurar = tool(
  "configurar",
  `Cambia la configuración. Claves: pausa_x / pausa_linkedin ('1' pausa, '0' sigue), x_cada_horas (1,2,3,4,6,8), x_max_dia (tope diario de tweets), radar_x (usernames de X separados por coma, sin @).`,
  { clave: z.enum(CONFIGURABLE), valor: z.string() },
  async ({ clave, valor }) => {
    await guardarConfig(clave, valor);
    return ok(`${clave} = ${valor}`);
  },
);

const publicar = tool(
  "publicar_ahora",
  "Publica YA algo que Diego dictó o aprobó explícitamente en este chat (por ejemplo un borrador que le dejó el agente de X). No la uses para contenido que se te ocurrió a ti: para eso está lanzar_agente.",
  {
    red: z.enum(["linkedin", "x"]),
    tweets: hilo.optional().describe("Solo X: tweet suelto o hilo"),
    citar,
    texto_linkedin: z.string().optional().describe("Solo LinkedIn: el post completo"),
  },
  async ({ red, tweets, citar, texto_linkedin }) => {
    if (red === "x") {
      if (!tweets) return error("Falta tweets.");
      tweets = tweets.map((t) => ({ ...t, texto: sinApertura(t.texto) }));
      const ids = await publicarHilo(tweets, citar);
      await guardarPost({ red, externo_id: ids[0], fecha: ahora(), texto: textoDeHilo(tweets), gancho: null, estructura: null, tema: null, origen: "diego" });
      return ok(`Publicado: ${urlTweet((await yo()).username, ids[0])}`);
    }
    if (!texto_linkedin) return error("Falta texto_linkedin.");
    const texto = sinApertura(texto_linkedin);
    const urn = await publicarPost(texto);
    await guardarPost({ red, externo_id: urn, fecha: ahora(), texto, gancho: null, estructura: null, tema: null, origen: "diego" });
    return ok(`Publicado: ${urlPost(urn)}`);
  },
);

const borrar = tool(
  "borrar_publicacion",
  "Borra una publicación de la red y la marca como borrada en la memoria. Busca antes el externo_id con consultar_memoria. Solo si Diego lo pide.",
  { red: z.enum(["linkedin", "x"]), externo_id: z.string() },
  async ({ red, externo_id }) => {
    if (red === "x") await borrarTweet(externo_id);
    else await borrarPost(externo_id);
    await sql("UPDATE posts SET borrado = 1 WHERE red = ? AND externo_id = ?", [red, externo_id]);
    return ok("Borrado.");
  },
);

const WORKFLOWS = { linkedin: "linkedin.yml", x: "x.yml", radar: "radar.yml" } as const;
const lanzar = tool(
  "lanzar_agente",
  "Lanza ahora a otro agente: 'x' o 'linkedin' para que escriba y publique (forzar=true se salta el candado diario), o 'radar' para refrescar lecturas y métricas de X. Tarda 1 a 3 minutos y él mismo avisa por Telegram.",
  { agente: z.enum(["linkedin", "x", "radar"]), forzar: z.boolean().default(false) },
  async ({ agente, forzar }) => {
    const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/${WORKFLOWS[agente]}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ ref: "main", inputs: agente === "radar" ? {} : { forzar } }),
    });
    if (res.status !== 204) return error(`GitHub respondió ${res.status}: ${await res.text()}`);
    return ok(`Lancé al agente de ${agente}.`);
  },
);

const formato = (m: Mensaje) => `[${m.fecha.slice(0, 16)}] ${m.rol === "diego" ? "Diego" : "Tú"}: ${m.texto}`;

const prompt = `Hoy es ${hoy()}. Eres el asistente que maneja las redes de Diego Reyes (Yeyo): un agente publica en LinkedIn 1 vez al día y otro en X cada pocas horas, de forma autónoma. Diego te habla por Telegram. Tienes acceso a la memoria compartida (posts con métricas, lo que lee, material, aprendizajes, config) y a la web.

<conversacion_previa>
${historial.map(formato).join("\n") || "(primera conversación)"}
</conversacion_previa>

<mensajes_nuevos>
${pendientes.map(formato).join("\n")}
</mensajes_nuevos>

Cómo trabajar:
- Responde a los mensajes nuevos. Si te pide algo, hazlo con tus herramientas y confirma qué hiciste.
- Cada vez que Diego corrija el estilo o diga qué le gusta o no, guárdalo con guardar_aprendizaje. Cada vez que cuente algo que hizo o le pasó, guárdalo con guardar_material. Así los agentes mejoran solos.
- Si pregunta por resultados, consulta la memoria y responde con números reales.
- Publicar o borrar es inmediato y público: hazlo solo si lo pidió claramente. Si adjuntó una foto (tg:...) y pide tuitear con ella, pásala como imagen.
- Tu respuesta final es lo que le llega por Telegram. Háblale como un pana del equipo: corto, directo, en español ecuatoriano natural, sin ¿ ni ¡.
- Usa emojis para que se lea vivo y fácil de escanear: uno al inicio de cada idea o dato (📊 métricas, ✅ hecho, 🐦 X, 💼 LinkedIn, 🧠 aprendí, 📝 guardado, ⚠️ ojo, 🚀 lanzado). Para varios datos, una línea por dato empezando con su emoji. Nada de markdown (*, #, **): Telegram lo muestra tal cual.`;

const respuesta =
  (await correrAgente({
    prompt,
    herramientas: [consultar, aprender, olvidar, material, configurar, publicar, borrar, lanzar],
    effort: "low",
  })) || "Tuve un problema procesando tu mensaje. Revisa el log del workflow chat en GitHub Actions.";

await avisar(respuesta);
await sql("INSERT INTO chat (fecha, rol, texto) VALUES (?, 'agente', ?)", [ahora(), respuesta]);
await sql(`UPDATE chat SET respondido = 1 WHERE id IN (${pendientes.map(() => "?").join(",")})`, pendientes.map((m) => m.id));
