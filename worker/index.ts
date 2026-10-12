// Cerebro de los agentes: recibe Telegram, guarda la memoria en D1 y dispara los
// workflows de GitHub a la hora exacta (los horarios de Actions se atrasan o se saltan).
// Claude no corre aquí: el Agent SDK necesita lanzar un proceso y los Workers no pueden.
interface Env {
  DB: D1Database;
  GH_REPO: string;
  GH_USUARIO: string; // cuya actividad pública se lee como material
  VERCEL_TOKEN?: string; // deploys a producción como material
  VERCEL_TEAM_ID: string;
  GH_TOKEN_DISPARO: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_VINCULO: string; // código del link t.me/<bot>?start=<código> que vincula a Diego
  TELEGRAM_CHAT_ID?: string;
  AGENTES_SECRET: string; // los agentes de GitHub Actions leen y escriben D1 por /api/sql
}

type Mensaje = {
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  caption?: string;
  photo?: { file_id: string; width: number }[];
  forward_origin?: { type: string; sender_user?: { username?: string }; chat?: { username?: string; title?: string } };
};

type Boton = {
  id: string;
  from: { id: number };
  data?: string;
  message?: { message_id: number; chat: { id: number }; text?: string };
};

const HORA_LINKEDIN = "30 13 * * *"; // 8:30 am Ecuador
const RADAR_HORAS = [7, 13, 19]; // hora Ecuador: el radar corre una hora antes que los tweets
const X_DESDE = 8;
const X_HASTA = 22;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/api/sql") return consultaAgentes(req, env);
    if (req.method === "POST" && url.pathname === "/api/github") {
      if (!igualSeguro(req.headers.get("Authorization") ?? "", `Bearer ${env.AGENTES_SECRET}`)) return new Response("no", { status: 401 });
      return Response.json({ github: await sincronizarGithub(env), vercel: await sincronizarVercel(env) });
    }
    if (req.method !== "POST" || url.pathname !== "/telegram") return new Response("ok");
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("no", { status: 401 });
    }
    const update = (await req.json()) as { message?: Mensaje; callback_query?: Boton };
    // Responder rápido a Telegram; el trabajo sigue en segundo plano.
    const fallo = (e: unknown) => responder(env, `⚠️ Algo falló en el Worker: ${escapar(String(e))}`);
    if (update.message) ctx.waitUntil(atender(update.message, env).catch(fallo));
    if (update.callback_query) ctx.waitUntil(botonRecordatorio(update.callback_query, env).catch(fallo));
    return new Response("ok");
  },

  async scheduled(evento: ScheduledController, env: Env): Promise<void> {
    if (evento.cron === HORA_LINKEDIN) {
      if ((await config(env, "pausa_linkedin")) !== "1") await disparar(env, "linkedin.yml");
      return;
    }
    // Este cron corre cada minuto por los recordatorios; lo demás va solo en el minuto 0.
    await enviarRecordatorios(env).catch((e) => console.error("Recordatorios:", e));
    if (new Date(evento.scheduledTime).getUTCMinutes() !== 0) return;
    await sincronizarGithub(env).catch((e) => console.error("GitHub:", e));
    await sincronizarVercel(env).catch((e) => console.error("Vercel:", e));
    const hora = (new Date(evento.scheduledTime).getUTCHours() + 19) % 24; // UTC-5, Ecuador no tiene horario de verano
    if (RADAR_HORAS.includes(hora)) await disparar(env, "radar.yml");
    if ((await config(env, "pausa_x")) === "1" || hora < X_DESDE || hora > X_HASTA) return;
    const cada = Number(await config(env, "x_cada_horas")) || 4;
    if ((hora - X_DESDE) % cada === 0) await disparar(env, "x.yml");
  },
};

// Cada hora: lo que Diego programó (actividad pública de GitHub) entra como fuente.
// No usa Claude; los agentes deciden después si vale la pena contarlo.
type EventoGh = { type: string; created_at: string; repo: { name: string }; payload: { ref_type?: string; action?: string; pull_request?: { title?: string } } };
const MAX_REPOS = 8; // los Workers tienen límite de subrequests por ejecución

async function sincronizarGithub(env: Env): Promise<{ repos: number }> {
  const desde = (await config(env, "github_ultimo")) ?? new Date(Date.now() - 24 * 3_600_000).toISOString();
  const ahora = new Date().toISOString();
  const eventos = await gh<EventoGh[]>(env, `/users/${env.GH_USUARIO}/events/public?per_page=100`);
  const porRepo = new Map<string, string[]>();
  for (const e of eventos.filter((e) => e.created_at > desde)) {
    const notas = porRepo.get(e.repo.name) ?? [];
    if (e.type === "CreateEvent" && e.payload.ref_type === "repository") notas.push("🆕 creó el repo");
    if (e.type === "PublicEvent") notas.push("🌍 lo hizo público");
    if (e.type === "PullRequestEvent" && e.payload.action) notas.push(`PR ${e.payload.action}${e.payload.pull_request?.title ? `: ${e.payload.pull_request.title}` : ""}`);
    if (e.type === "PushEvent" && !notas.includes("push")) notas.push("push");
    porRepo.set(e.repo.name, notas);
  }

  const repos = [...porRepo].slice(0, MAX_REPOS);
  for (const [repo, notas] of repos) {
    const commits = notas.includes("push")
      ? await gh<{ commit: { message: string } }[]>(env, `/repos/${repo}/commits?since=${desde}&per_page=15`).catch(() => [])
      : [];
    const info = await gh<{ description: string | null; language: string | null; html_url: string }>(env, `/repos/${repo}`).catch(() => null);
    const lineas = [
      ...notas.filter((n) => n !== "push"),
      ...commits.map((c) => `- ${c.commit.message.split("\n")[0].slice(0, 140)}`),
    ];
    if (!lineas.length) continue;
    const cabecera = `${commits.length} commits${info?.language ? ` · ${info.language}` : ""}`;
    // La descripción va aparte: en repos de clientes suele traer el nombre del cliente.
    await env.DB.prepare("INSERT OR IGNORE INTO fuentes (fecha, origen, externo_id, autor, url, texto, metricas) VALUES (?, 'github', ?, ?, ?, ?, ?)")
      .bind(ahora, `${repo}@${ahora}`, repo, info?.html_url ?? `https://github.com/${repo}`, `${cabecera}\n${lineas.join("\n")}`, JSON.stringify({ descripcion: info?.description ?? null }))
      .run();
  }
  await guardarConfig(env, "github_ultimo", ahora);
  return { repos: repos.length };
}

// Cada hora: los deploys a producción que salieron bien ("hoy subí X a producción").
type Deploy = { uid: string; name: string; url: string; created: number; meta?: { githubCommitMessage?: string; githubCommitRepo?: string } };

async function sincronizarVercel(env: Env): Promise<{ deploys: number }> {
  if (!env.VERCEL_TOKEN) return { deploys: 0 };
  const desde = Number(await config(env, "vercel_ultimo")) || Date.now() - 24 * 3_600_000;
  const res = await fetch(
    `https://api.vercel.com/v6/deployments?teamId=${env.VERCEL_TEAM_ID}&target=production&state=READY&since=${desde}&limit=50`,
    { headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` } },
  );
  if (!res.ok) throw new Error(`Vercel ${res.status}`);
  const { deployments } = (await res.json()) as { deployments: Deploy[] };
  // Un registro por proyecto: varios deploys seguidos del mismo proyecto son una sola noticia.
  const porProyecto = new Map<string, Deploy[]>();
  for (const d of deployments) porProyecto.set(d.name, [...(porProyecto.get(d.name) ?? []), d]);
  for (const [proyecto, ds] of porProyecto) {
    const mensajes = [...new Set(ds.map((d) => d.meta?.githubCommitMessage?.split("\n")[0]).filter(Boolean))].slice(0, 8);
    await env.DB.prepare("INSERT OR IGNORE INTO fuentes (fecha, origen, externo_id, autor, url, texto) VALUES (?, 'vercel', ?, ?, ?, ?)")
      .bind(new Date(ds[0].created).toISOString(), ds[0].uid, ds[0].meta?.githubCommitRepo ?? proyecto, `https://${ds[0].url}`, `🚀 ${ds.length} deploy(s) a producción\n${mensajes.map((m) => `- ${m}`).join("\n")}`)
      .run();
  }
  if (deployments.length) await guardarConfig(env, "vercel_ultimo", String(Math.max(...deployments.map((d) => d.created)) + 1));
  return { deploys: deployments.length };
}

async function gh<T>(env: Env, ruta: string): Promise<T> {
  const res = await fetch(`https://api.github.com${ruta}`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN_DISPARO}`, Accept: "application/vnd.github+json", "User-Agent": "cerebro-yeyo" },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} en ${ruta.split("?")[0]}`);
  return (await res.json()) as T;
}

// Puerta de los agentes a la memoria: así no necesitan un token de Cloudflare.
async function consultaAgentes(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!env.AGENTES_SECRET || !igualSeguro(auth, `Bearer ${env.AGENTES_SECRET}`)) return new Response("no", { status: 401 });
  const { sql, params = [] } = (await req.json()) as { sql: string; params?: unknown[] };
  try {
    const { results } = await env.DB.prepare(sql).bind(...params).all();
    return Response.json({ results });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}

function igualSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

async function atender(m: Mensaje, env: Env): Promise<void> {
  const texto = (m.text ?? m.caption ?? "").trim();

  // El dueño se vincula una sola vez abriendo t.me/<bot>?start=<TELEGRAM_VINCULO>.
  env.TELEGRAM_CHAT_ID ||= (await config(env, "telegram_chat_id")) ?? undefined;
  if (!env.TELEGRAM_CHAT_ID) {
    if (texto !== `/start ${env.TELEGRAM_VINCULO}`) return;
    await guardarConfig(env, "telegram_chat_id", String(m.chat.id));
    env.TELEGRAM_CHAT_ID = String(m.chat.id);
    return responder(env, "🐦 <b>Qué más Diego, soy Pana.</b>\n\nQuedé vinculado contigo: desde ahora solo te hago caso a ti 🔒\nEscribe /ayuda para ver todo lo que puedo hacer 🚀");
  }
  if (String(m.from?.id) !== env.TELEGRAM_CHAT_ID) return; // solo Diego

  // Fotos: quedan como material visual que los agentes pueden poner en los tweets.
  const foto = m.photo?.at(-1);
  if (foto) {
    await env.DB.prepare("INSERT INTO fuentes (fecha, origen, externo_id, url, texto) VALUES (?, 'telegram_foto', ?, ?, ?)")
      .bind(new Date().toISOString(), String(m.message_id), `tg:${foto.file_id}`, texto || "(foto sin descripción)")
      .run();
    if (!texto || /^https?:\/\/\S+$/.test(texto)) return reaccionar(env, m, "👌");
  }

  const [comando, arg = ""] = texto.split(/\s+/, 2);
  const redes = arg === "x" ? ["x"] : arg === "linkedin" ? ["linkedin"] : ["x", "linkedin"];
  switch (comando.toLowerCase().replace(/@\w+$/, "")) {
    case "/pausa":
    case "/sigue": {
      const valor = comando.startsWith("/pausa") ? "1" : "0";
      for (const r of redes) await guardarConfig(env, `pausa_${r}`, valor);
      return responder(env, `${valor === "1" ? "⏸️ <b>En pausa</b>" : "▶️ <b>Activo de nuevo</b>"}: ${redes.map(nombreRed).join(" y ")}`);
    }
    case "/ya": {
      const wf = { x: "x.yml", linkedin: "linkedin.yml", radar: "radar.yml" }[arg];
      if (!wf) return responder(env, "🤔 Dime a quién lanzo:\n\n🐦 /ya x\n💼 /ya linkedin\n📡 /ya radar");
      await disparar(env, wf, arg === "radar" ? {} : { forzar: "true" });
      return responder(env, `🚀 <b>Lancé ${nombreRed(arg)}</b>\nEn 1 a 3 minutos te aviso qué salió ⏳`);
    }
    case "/estado":
      return responder(env, await estado(env));
    case "/recordatorios":
      return responder(env, await listaRecordatorios(env));
    case "/start":
    case "/ayuda":
      return responder(env, AYUDA);
  }

  // Reenviado o solo links: es algo que Diego leyó, va a fuentes sin gastar Claude.
  const soloLinks = texto && texto.replace(/https?:\/\/\S+/g, "").trim() === "";
  if (!foto && (m.forward_origin || soloLinks)) {
    const o = m.forward_origin;
    const autor = o?.sender_user?.username ?? o?.chat?.username ?? o?.chat?.title ?? null;
    await env.DB.prepare("INSERT INTO fuentes (fecha, origen, externo_id, autor, url, texto) VALUES (?, 'telegram', ?, ?, ?, ?)")
      .bind(new Date().toISOString(), String(m.message_id), autor, texto.match(/https?:\/\/\S+/)?.[0] ?? null, texto || "(sin texto)")
      .run();
    return reaccionar(env, m, "👌");
  }
  if (!texto) return responder(env, "🙈 Por ahora entiendo texto, links y fotos. Notas de voz pronto.");

  // Conversación: la contesta el agente de chat en GitHub Actions (~1 min).
  const conFoto = foto ? `${texto}\n[adjuntó una foto: tg:${foto.file_id}]` : texto;
  await env.DB.prepare("INSERT INTO chat (fecha, rol, texto, respondido) VALUES (?, 'diego', ?, 0)").bind(new Date().toISOString(), conFoto).run();
  await reaccionar(env, m, "👀");
  await disparar(env, "chat.yml");
}

// Cada minuto: manda los recordatorios vencidos con botones para posponer.
type Recordatorio = { id: number; texto: string; cuando: string; repetir: string | null };
const MINUTO = 60_000;
const BOTONES = (id: number) => ({
  inline_keyboard: [
    [
      { text: "⏰ 15 min", callback_data: `pos:15:${id}` },
      { text: "⏰ 1 h", callback_data: `pos:60:${id}` },
      { text: "🌅 Mañana", callback_data: `pos:manana:${id}` },
    ],
    [{ text: "✅ Listo", callback_data: `ok:${id}` }],
  ],
});

async function enviarRecordatorios(env: Env): Promise<void> {
  env.TELEGRAM_CHAT_ID ||= (await config(env, "telegram_chat_id")) ?? undefined;
  if (!env.TELEGRAM_CHAT_ID) return;
  const { results } = await env.DB.prepare("SELECT id, texto, cuando, repetir FROM recordatorios WHERE estado = 'pendiente' AND cuando <= ? ORDER BY cuando LIMIT 20")
    .bind(new Date().toISOString())
    .all<Recordatorio>();
  for (const r of results) {
    // Primero se marca: si Telegram falla, mejor perder un aviso que mandarlo cada minuto.
    const siguiente = r.repetir ? proximaVez(r.cuando, r.repetir) : null;
    await env.DB.prepare("UPDATE recordatorios SET estado = ?, cuando = ? WHERE id = ?")
      .bind(siguiente ? "pendiente" : "enviado", siguiente ?? r.cuando, r.id)
      .run();
    const repite = r.repetir ? `\n🔁 <i>${r.repetir} · el próximo: ${horaEcuador(siguiente!)}</i>` : "";
    await telegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `⏰ <b>Recordatorio</b>\n\n${escapar(r.texto)}${repite}`,
      parse_mode: "HTML",
      reply_markup: BOTONES(r.id),
    });
  }
}

// Ecuador es UTC-5 todo el año: sumar días en UTC no se descuadra.
function proximaVez(cuando: string, repetir: string): string {
  const d = new Date(cuando);
  const ahora = Date.now();
  do {
    if (repetir === "mensual") d.setUTCMonth(d.getUTCMonth() + 1);
    else d.setUTCDate(d.getUTCDate() + (repetir === "semanal" ? 7 : 1));
    if (repetir === "laborables") while ([0, 6].includes(new Date(d.getTime() - 5 * 3_600_000).getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getTime() <= ahora); // si el Worker estuvo caído, no manda los atrasados en ráfaga
  return d.toISOString();
}

async function botonRecordatorio(b: Boton, env: Env): Promise<void> {
  env.TELEGRAM_CHAT_ID ||= (await config(env, "telegram_chat_id")) ?? undefined;
  if (String(b.from.id) !== env.TELEGRAM_CHAT_ID || !b.message || !b.data) return;
  const [accion, minutos, idTexto] = b.data.split(":");
  const id = Number(accion === "ok" ? minutos : idTexto);
  const r = await env.DB.prepare("SELECT id, texto, cuando, repetir FROM recordatorios WHERE id = ?").bind(id).first<Recordatorio>();
  let aviso = "✅ Listo";
  let pie = "\n\n✅ <i>Listo</i>";
  if (accion === "pos" && r) {
    const cuando = minutos === "manana" ? mananaNueve() : new Date(Date.now() + Number(minutos) * MINUTO).toISOString();
    // Posponer un recordatorio que se repite crea uno suelto: la serie sigue igual.
    if (r.repetir) {
      await env.DB.prepare("INSERT INTO recordatorios (texto, cuando, creado) VALUES (?, ?, ?)").bind(r.texto, cuando, new Date().toISOString()).run();
    } else {
      await env.DB.prepare("UPDATE recordatorios SET estado = 'pendiente', cuando = ? WHERE id = ?").bind(cuando, id).run();
    }
    aviso = `⏰ Te lo vuelvo a recordar ${horaEcuador(cuando)}`;
    pie = `\n\n⏰ <i>Pospuesto: ${horaEcuador(cuando)}</i>`;
  }
  await telegram(env, "answerCallbackQuery", { callback_query_id: b.id, text: aviso });
  await telegram(env, "editMessageText", {
    chat_id: b.message.chat.id,
    message_id: b.message.message_id,
    text: `⏰ <b>Recordatorio</b>\n\n${escapar(r?.texto ?? b.message.text ?? "")}${pie}`,
    parse_mode: "HTML",
  });
}

// Mañana a las 9:00 am Ecuador (14:00 UTC).
function mananaNueve(): string {
  const d = new Date(Date.now() - 5 * 3_600_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 14)).toISOString();
}

async function listaRecordatorios(env: Env): Promise<string> {
  const { results } = await env.DB.prepare("SELECT id, texto, cuando, repetir FROM recordatorios WHERE estado = 'pendiente' ORDER BY cuando LIMIT 30").all<Recordatorio>();
  if (!results.length) return "⏰ No tienes recordatorios pendientes.\n\nPídemelos normal: <i>\"recuérdame mañana a las 10 llamar al contador\"</i>";
  return [
    "⏰ <b>Tus recordatorios</b>",
    "",
    ...results.map((r) => `• ${horaEcuador(r.cuando)}${r.repetir ? ` 🔁 ${r.repetir}` : ""}\n  ${escapar(r.texto)}`),
    "",
    "<i>Para cancelar uno dime \"cancela el de …\"</i>",
  ].join("\n");
}

const horaEcuador = (iso: string) =>
  new Date(iso).toLocaleString("es-EC", { timeZone: "America/Guayaquil", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function estado(env: Env): Promise<string> {
  const { results: cfg } = await env.DB.prepare(
    "SELECT clave, valor FROM config WHERE clave IN ('pausa_x','pausa_linkedin','x_cada_horas','x_max_dia','radar_x')",
  ).all<{ clave: string; valor: string }>();
  const c = Object.fromEntries(cfg.map((f) => [f.clave, f.valor]));
  const { results: ultimos } = await env.DB.prepare(
    "SELECT red, fecha, substr(texto, 1, 80) AS inicio FROM posts WHERE borrado = 0 ORDER BY fecha DESC LIMIT 4",
  ).all<{ red: string; fecha: string; inicio: string }>();
  const hora = (iso: string) =>
    new Date(iso).toLocaleString("es-EC", { timeZone: "America/Guayaquil", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return [
    "🐦📊 <b>Así vamos, pana</b>",
    "",
    `💼 <b>LinkedIn</b>: ${c.pausa_linkedin === "1" ? "⏸️ en pausa" : "✅ activo · diario 8:30 am"}`,
    `🐦 <b>X</b>: ${c.pausa_x === "1" ? "⏸️ en pausa" : `✅ activo · cada ${c.x_cada_horas} h (máx ${c.x_max_dia} al día)`}`,
    `📡 <b>Radar</b>: ${escapar(c.radar_x.split(",").map((u) => `@${u.trim()}`).join(", "))}`,
    "",
    "🕐 <b>Últimos posts</b>",
    ...(ultimos.length ? ultimos.map((p) => `${p.red === "x" ? "🐦" : "💼"} ${hora(p.fecha)} · <i>${escapar(p.inicio)}…</i>`) : ["Todavía nada 🤷🏾‍♂️"]),
  ].join("\n");
}

async function config(env: Env, clave: string): Promise<string | null> {
  return env.DB.prepare("SELECT valor FROM config WHERE clave = ?").bind(clave).first<string>("valor");
}

async function guardarConfig(env: Env, clave: string, valor: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO config (clave, valor, actualizado) VALUES (?, ?, datetime('now')) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado = excluded.actualizado",
  )
    .bind(clave, valor)
    .run();
}

async function disparar(env: Env, workflow: string, inputs: Record<string, string> = {}): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN_DISPARO}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cerebro-yeyo",
    },
    body: JSON.stringify({ ref: "main", inputs }),
  });
  if (res.status !== 204) throw new Error(`GitHub respondió ${res.status} al disparar ${workflow}: ${await res.text()}`);
}

async function telegram(env: Env, metodo: string, cuerpo: unknown): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  if (!res.ok) console.error(`Telegram ${metodo} ${res.status}: ${await res.text()}`);
}

// Mensajes fijos del Worker en HTML de Telegram: todo texto variable pasa por escapar().
const responder = (env: Env, text: string) =>
  telegram(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });

const escapar = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const nombreRed = (r: string) => ({ x: "🐦 X", linkedin: "💼 LinkedIn", radar: "📡 el radar" })[r] ?? r;

const AYUDA = `🐦 <b>Qué más, soy Pana</b>
Tu piquero de confianza para X y LinkedIn.

💬 <b>Háblame normal</b>
• "cómo van mis tweets esta semana?"
• "hoy terminé el MCP del equipo" → lo guardo como material
• "no uses tanto la palabra X" → aprendo la regla
• "publica esto en X: …"

🔗 <b>Mándame links o reenvíame posts</b> y los uso como inspiración
📸 <b>Mándame fotos</b> y las pongo en tus tweets

⚡ <b>Atajos</b>
⏰ <b>Recordatorios</b>
• "recuérdame mañana a las 10 llamar al contador"
• "todos los lunes a las 8 revisar métricas"
⏰ /recordatorios · ver los pendientes

📊 /estado · cómo van los agentes
⏸️ /pausa x · /pausa linkedin · /pausa (todo)
▶️ /sigue x · /sigue linkedin · /sigue (todo)
🚀 /ya x · /ya linkedin · /ya radar`;

const reaccionar = (env: Env, m: Mensaje, emoji: string) =>
  telegram(env, "setMessageReaction", { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: "emoji", emoji }] });
