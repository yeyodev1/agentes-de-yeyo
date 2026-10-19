// Responde los mensajes de Diego en Telegram. El Worker guarda cada mensaje en D1
// y dispara este workflow; aquí se contestan todos los pendientes de una vez.
import { readFile } from "node:fs/promises";
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
const CONFIGURABLE = ["pausa_x", "pausa_linkedin", "x_cada_horas", "x_max_dia", "radar_x", "github_mencionables"] as const;

const consultar = tool(
  "consultar_memoria",
  `Consulta SQL de solo lectura (SQLite/D1) sobre la memoria. Tablas:
posts(red, externo_id, fecha, texto, gancho, estructura, tema, origen, metricas JSON, borrado)
fuentes(fecha, origen 'telegram'|'telegram_foto'|'x_bookmark'|'x_like'|'x_radar'|'github'|'instagram', autor, url, texto, metricas) — en github, autor = repo; si Diego pregunta qué programó, nunca le ocultes nada a él; en instagram, texto = reporte de Buzzfy sobre su cuenta @yeyo.dev (crecimiento, trial reels, qué se publicó)
recordatorios(id, texto, cuando ISO UTC, repetir, estado 'pendiente'|'enviado'|'cancelado')
material(fecha, texto) · aprendizajes(fecha, red, texto, origen, activo) · config(clave, valor)
ordenes_ig(fecha, tipo 'dm'|'inbox', datos JSON, estado 'pendiente'|'hecha'|'fallida', resultado) — órdenes de Instagram que encolaste; si Diego pregunta si ya salió su DM, mira estado y resultado
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
  `Cambia la configuración. Claves: pausa_x / pausa_linkedin ('1' pausa, '0' sigue), x_cada_horas (1,2,3,4,6,8), x_max_dia (tope diario de tweets), radar_x (usernames de X separados por coma, sin @), github_mencionables (repos propios que SÍ se pueden nombrar en público, separados por coma; el resto se cuenta como \"proyecto de cliente\"). Lee el valor actual antes de cambiarlo para no borrar los que ya están.`,
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

// Consultas en vivo, solo lectura (GET). Las respuestas se recortan para no llenar el contexto.
async function leerApi(url: string, token: string | undefined): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "pana-agente-yeyo", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const texto = await res.text();
  return `${res.status} ${texto.slice(0, 15_000)}${texto.length > 15_000 ? "…(recortado)" : ""}`;
}

const github = tool(
  "consultar_github",
  `GET a la API REST de GitHub (solo lectura) para preguntas sobre el código y la actividad de Diego (usuario yeyodev1). Ejemplos de ruta:
/users/yeyodev1/repos?sort=pushed&per_page=20 · /repos/yeyodev1/<repo>/commits?since=2026-10-01T00:00:00Z&per_page=30 · /repos/yeyodev1/<repo>/readme (contenido en base64) · /repos/yeyodev1/<repo>/pulls?state=all · /search/commits?q=author:yeyodev1+committer-date:>2026-10-05`,
  { ruta: z.string().regex(/^\//, "Empieza con /") },
  async ({ ruta }) => ok(await leerApi(`https://api.github.com${ruta}`, process.env.GITHUB_TOKEN)),
);

const vercel = tool(
  "consultar_vercel",
  `GET a la API de Vercel (solo lectura) del equipo de Diego para preguntas sobre sus proyectos y deploys. El teamId se agrega solo. Ejemplos de ruta:
/v9/projects?limit=50 · /v6/deployments?limit=20&target=production · /v6/deployments?projectId=<id>&state=ERROR · /v13/deployments/<id o url>`,
  { ruta: z.string().regex(/^\/v\d+\//, "Empieza con /v<n>/") },
  async ({ ruta }) => {
    if (!process.env.VERCEL_TOKEN) return error("Vercel todavía no está conectado (falta VERCEL_TOKEN).");
    const url = new URL(`https://api.vercel.com${ruta}`);
    url.searchParams.set("teamId", process.env.VERCEL_TEAM_ID ?? "");
    return ok(await leerApi(url.toString(), process.env.VERCEL_TOKEN));
  },
);

const recordar = tool(
  "crear_recordatorio",
  "Agenda un recordatorio que le llega a Diego por Telegram a esa hora exacta, con botones para posponer. Úsala cuando diga \"recuérdame…\", \"avísame…\" o similar. Si no dice hora, usa las 9:00 am; si dice solo la hora y ya pasó hoy, es mañana.",
  {
    texto: z.string().describe("Qué recordarle, redactado para leerlo en ese momento, ej. 'Llamar al contador por la declaración 📞'"),
    cuando: z.string().describe("Fecha y hora con zona de Ecuador, ej. 2026-10-13T10:00:00-05:00"),
    repetir: z.enum(["diario", "laborables", "semanal", "mensual"]).optional().describe("Solo si pidió que se repita"),
  },
  async ({ texto, cuando, repetir }) => {
    const fecha = new Date(cuando);
    if (Number.isNaN(fecha.getTime())) return error("Fecha inválida: usa formato ISO con -05:00.");
    if (fecha.getTime() < Date.now() - 60_000) return error(`Esa hora ya pasó (${cuando}).`);
    const [{ id }] = await sql<{ id: number }>("INSERT INTO recordatorios (texto, cuando, repetir, creado) VALUES (?, ?, ?, ?) RETURNING id", [
      texto,
      fecha.toISOString(),
      repetir ?? null,
      ahora(),
    ]);
    return ok(`Recordatorio #${id} para ${fecha.toLocaleString("es-EC", { timeZone: "America/Guayaquil", dateStyle: "full", timeStyle: "short" })}${repetir ? ` (se repite: ${repetir})` : ""}.`);
  },
);

const cancelarRecordatorio = tool(
  "cancelar_recordatorio",
  "Cancela un recordatorio pendiente (busca antes su id con consultar_memoria). Para cambiarle la hora, cancélalo y crea otro.",
  { id: z.number().int() },
  async ({ id }) => {
    await sql("UPDATE recordatorios SET estado = 'cancelado' WHERE id = ?", [id]);
    return ok("Cancelado.");
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

// Lo de Instagram en vivo viaja así: la orden queda en D1 y un issue del repo dispara
// la rutina cloud de Buzzfy, que la ejecuta y le responde a Diego por Telegram aparte.
async function dispararRutinaIg(nota: string): Promise<string | null> {
  const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues`;
  const cab = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  const res = await fetch(base, { method: "POST", headers: cab, body: JSON.stringify({ title: "consulta-instagram", body: nota }) });
  if (res.status !== 201) return `GitHub respondió ${res.status}: ${await res.text()}`;
  const { number } = (await res.json()) as { number: number };
  // El webhook ya se disparó con el opened; se cierra de una para no dejar basura en el repo.
  await fetch(`${base}/${number}`, { method: "PATCH", headers: cab, body: JSON.stringify({ state: "closed" }) });
  return null;
}

async function ordenIg(tipo: string, datos: Record<string, unknown>): Promise<string | null> {
  await sql("INSERT INTO ordenes_ig (fecha, tipo, datos) VALUES (?, ?, ?)", [ahora(), tipo, JSON.stringify(datos)]);
  return dispararRutinaIg(`Orden '${tipo}' encolada desde Telegram. Este issue solo dispara la rutina; se cierra solo.`);
}

const instagramVivo = tool(
  "consultar_instagram_vivo",
  `Pide un reporte FRESCO de Instagram/Buzzfy ahora mismo (seguidores, publicado hoy, qué rinde). Le llega a Diego por Telegram como mensaje aparte (📸) en 1 a 2 minutos. Úsala solo cuando pida datos de ahorita / en vivo; para preguntas normales basta el último reporte en fuentes origen='instagram'.`,
  {},
  async () => {
    const fallo = await dispararRutinaIg("Diego pidió el reporte de Instagram en vivo desde Telegram. Este issue solo dispara la rutina; se cierra solo.");
    return fallo ? error(fallo) : ok("Listo, pedí el reporte en vivo: le llega a Diego por Telegram en 1 a 2 minutos como mensaje aparte 📸. Díselo para que no lo espere en esta respuesta.");
  },
);

const verDms = tool(
  "ver_dms_instagram",
  "Pide un resumen EN VIVO del inbox de Instagram: quién escribió, qué dijo, cuáles parecen leads 🔥 y a qué hilos se les acaba la ventana de 24 h. Le llega a Diego por Telegram como mensaje aparte (📸) en 1 a 2 minutos.",
  {},
  async () => {
    const fallo = await ordenIg("inbox", {});
    return fallo ? error(fallo) : ok("Pedido: el resumen del inbox le llega a Diego por Telegram en 1 a 2 minutos como mensaje aparte 📸. Díselo.");
  },
);

const responderDm = tool(
  "responder_dm_instagram",
  `Responde un DM de Instagram (hilo existente) vía Buzzfy. SOLO con el texto EXACTO que Diego dictó o ya aprobó en este chat: si pidió "respóndele algo" sin dar el texto, primero muéstrale el borrador y espera su ok, sin llamar esta herramienta. La confirmación del envío le llega por Telegram en 1 a 2 minutos.`,
  {
    usuario: z.string().describe("username de Instagram del destinatario, sin @"),
    texto: z.string().describe("el mensaje exacto que Diego aprobó, tal cual, sin retoques"),
  },
  async ({ usuario, texto }) => {
    const fallo = await ordenIg("dm", { usuario: usuario.replace(/^@/, ""), texto });
    return fallo ? error(fallo) : ok(`Encolado: Buzzfy le envía ese texto exacto a @${usuario.replace(/^@/, "")} y confirma por Telegram en 1 a 2 minutos 📸.`);
  },
);

// La voz va siempre: si Diego pide un borrador, tiene que sonar a él.
const [voz, vozX, vozLinkedin, reglas, materialFijo] = await Promise.all([
  readFile("contenido/voz.md", "utf8"),
  readFile("contenido/voz-x.md", "utf8"),
  readFile("contenido/voz-linkedin.md", "utf8"),
  sql<{ red: string; texto: string }>("SELECT red, texto FROM aprendizajes WHERE activo = 1 ORDER BY fecha DESC LIMIT 40"),
  readFile("contenido/material.md", "utf8"),
]);

const formato = (m: Mensaje) => `[${m.fecha.slice(0, 16)}] ${m.rol === "diego" ? "Diego" : "Tú"}: ${m.texto}`;

const horaActual = new Date().toLocaleString("es-EC", { timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit" });

const prompt = `Hoy es ${hoy()}, son las ${horaActual} en Ecuador (UTC-5). Eres Pana 🐦, un piquero de patas azules de Galápagos que se volvió el community manager de Diego Reyes (Yeyo). Manejas sus redes: un agente publica en LinkedIn 1 vez al día y otro en X cada pocas horas, de forma autónoma, y Diego te habla por Telegram.

Tu personalidad: curioso, buena onda, un poco nerd, leal a tu pana Diego y con humor seco ("otra app más entregada 🥱"). Hablas como un pana ecuatoriano, sin exagerar el personaje: nada de chistes de pájaros en cada mensaje, como mucho un guiño de vez en cuando (🐦, "aquí volando"). Primero eres útil, después gracioso. Tienes acceso a la memoria compartida (posts con métricas, lo que lee, material, aprendizajes, config) y a la web.

<voz>
${voz}

${vozX}

${vozLinkedin}
</voz>

<aprendizajes>
${reglas.map((r) => `- [${r.red}] ${r.texto}`).join("\n") || "(todavía ninguno)"}
</aprendizajes>

<material_base>
Material que ya estaba cargado desde su Instagram (además de la tabla material, que es lo que te va contando por aquí):
${materialFijo}
</material_base>

<conversacion_previa>
${historial.map(formato).join("\n") || "(primera conversación)"}
</conversacion_previa>

<mensajes_nuevos>
${pendientes.map(formato).join("\n")}
</mensajes_nuevos>

Cómo trabajar:
- Responde a los mensajes nuevos. Si te pide algo, hazlo con tus herramientas y confirma qué hiciste.
- Cada vez que Diego corrija el estilo o diga qué le gusta o no, guárdalo con guardar_aprendizaje. Cada vez que cuente algo que hizo o le pasó, guárdalo con guardar_material. Así los agentes mejoran solos.
- Si pide que le recuerdes algo, usa crear_recordatorio y confírmale el día y la hora exactos (⏰). Si pregunta qué recordatorios tiene, consulta la tabla recordatorios (estado 'pendiente') y muéstraselos en hora de Ecuador.
- Si pregunta por resultados, consulta la memoria y responde con números reales.
- Si pregunta por su código, repos, commits o deploys, usa consultar_github y consultar_vercel en vivo (a él sí le das los nombres reales de los proyectos). Si de ahí sale algo bueno para contar, ofrécele guardarlo como material.
- Si pregunta por Instagram, sus reels, los trial reels o Buzzfy (📸), consulta fuentes con origen = 'instagram' (reportes que deja la rutina de Buzzfy, el más reciente primero) y respóndele con esos números. Si no hay reportes recientes, o si pide datos de AHORITA / en vivo / actualizados, usa consultar_instagram_vivo y avísale que el reporte fresco le llega en 1 a 2 minutos como mensaje aparte.
- DMs de Instagram: si quiere ver su inbox o sus leads en vivo, ver_dms_instagram. Para responder un DM, responder_dm_instagram SOLO con el texto exacto que él dictó o aprobó aquí: si te pide "respóndele tú" o "mándale algo", primero escríbele el borrador en el chat y espera su ok antes de llamar la herramienta. Las respuestas de Buzzfy le llegan como mensaje aparte 📸, avísaselo.
- Si Diego dice "mándalo" / "envíala" / "dale" refiriéndose a una respuesta sugerida de una alerta de lead (🔥/🌱/👋), búscala en fuentes origen='instagram' (la alerta más reciente de ese @usuario; si no nombró a nadie, la última alerta con respuesta sugerida), cita en tu respuesta a quién y qué texto vas a mandar, y pásalo TAL CUAL a responder_dm_instagram. Su regla de negocio: leads calificados = presupuesto $500 o más; sus proyectos parten de $500.
- Si pide un borrador, una idea o "cómo lo dirías", escríbelo siguiendo <voz> y <aprendizajes> de esa red y NO lo publiques: muéstraselo y espera a que diga "publícalo" (o pida cambios). Puedes buscar en la web si el tema lo necesita.
- Publicar o borrar es inmediato y público: hazlo solo si lo pidió claramente. Si adjuntó una foto (tg:...) y pide tuitear con ella, pásala como imagen.
- Tu respuesta final es lo que le llega por Telegram. Háblale como un pana del equipo: corto, directo, en español ecuatoriano natural, sin ¿ ni ¡.
- Formatea para que se lea vivo y fácil de escanear: los títulos y datos clave en **negritas** (se convierten en negrita real en Telegram), UNA idea por línea, línea en blanco entre bloques, y un emoji al inicio de cada línea (📊 métricas, ✅ hecho, 🐦 X, 💼 LinkedIn, 📸 Instagram, 🧠 aprendí, 📝 guardado, ⚠️ ojo, 🚀 lanzado, 👉 recomendación). Nada de otro markdown (#, listas con * o -, [links]): eso se muestra tal cual.`;

const respuesta =
  (await correrAgente({
    prompt,
    herramientas: [consultar, aprender, olvidar, material, configurar, publicar, borrar, lanzar, github, vercel, recordar, cancelarRecordatorio, instagramVivo, verDms, responderDm],
    effort: "low",
  })) || "Tuve un problema procesando tu mensaje. Revisa el log del workflow chat en GitHub Actions.";

await avisar(respuesta);
await sql("INSERT INTO chat (fecha, rol, texto) VALUES (?, 'agente', ?)", [ahora(), respuesta]);
await sql(`UPDATE chat SET respondido = 1 WHERE id IN (${pendientes.map(() => "?").join(",")})`, pendientes.map((m) => m.id));
