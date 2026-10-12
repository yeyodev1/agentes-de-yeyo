// Cerebro de los agentes: recibe Telegram, guarda la memoria en D1 y dispara los
// workflows de GitHub a la hora exacta (los horarios de Actions se atrasan o se saltan).
// Claude no corre aquí: el Agent SDK necesita lanzar un proceso y los Workers no pueden.
interface Env {
  DB: D1Database;
  GH_REPO: string;
  GH_TOKEN_DISPARO: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_CHAT_ID?: string;
}

type Mensaje = {
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  caption?: string;
  forward_origin?: { type: string; sender_user?: { username?: string }; chat?: { username?: string; title?: string } };
};

const HORA_LINKEDIN = "30 13 * * *"; // 8:30 am Ecuador
const RADAR_HORAS = [7, 13, 19]; // hora Ecuador: el radar corre una hora antes que los tweets
const X_DESDE = 8;
const X_HASTA = 22;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/telegram") return new Response("ok");
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("no", { status: 401 });
    }
    const update = (await req.json()) as { message?: Mensaje };
    // Responder rápido a Telegram; el trabajo sigue en segundo plano.
    if (update.message) ctx.waitUntil(atender(update.message, env).catch((e) => responder(env, `Error en el Worker: ${e}`)));
    return new Response("ok");
  },

  async scheduled(evento: ScheduledController, env: Env): Promise<void> {
    if (evento.cron === HORA_LINKEDIN) {
      if ((await config(env, "pausa_linkedin")) !== "1") await disparar(env, "linkedin.yml");
      return;
    }
    const hora = (new Date(evento.scheduledTime).getUTCHours() + 19) % 24; // UTC-5, Ecuador no tiene horario de verano
    if (RADAR_HORAS.includes(hora)) await disparar(env, "radar.yml");
    if ((await config(env, "pausa_x")) === "1" || hora < X_DESDE || hora > X_HASTA) return;
    const cada = Number(await config(env, "x_cada_horas")) || 4;
    if ((hora - X_DESDE) % cada === 0) await disparar(env, "x.yml");
  },
};

async function atender(m: Mensaje, env: Env): Promise<void> {
  const texto = (m.text ?? m.caption ?? "").trim();

  // Antes de configurar TELEGRAM_CHAT_ID, el bot solo dice cuál es tu chat id.
  if (!env.TELEGRAM_CHAT_ID) {
    return void (await telegram(env, "sendMessage", { chat_id: m.chat.id, text: `Tu chat id es ${m.chat.id}. Guárdalo como secret TELEGRAM_CHAT_ID.` }));
  }
  if (String(m.from?.id) !== env.TELEGRAM_CHAT_ID) return; // solo Diego

  const [comando, arg = ""] = texto.split(/\s+/, 2);
  const redes = arg === "x" ? ["x"] : arg === "linkedin" ? ["linkedin"] : ["x", "linkedin"];
  switch (comando.toLowerCase().replace(/@\w+$/, "")) {
    case "/pausa":
    case "/sigue": {
      const valor = comando.startsWith("/pausa") ? "1" : "0";
      for (const r of redes) await guardarConfig(env, `pausa_${r}`, valor);
      return responder(env, `${valor === "1" ? "⏸️ Pausado" : "▶️ Activo"}: ${redes.join(" y ")}`);
    }
    case "/ya": {
      const wf = { x: "x.yml", linkedin: "linkedin.yml", radar: "radar.yml" }[arg];
      if (!wf) return responder(env, "Uso: /ya x · /ya linkedin · /ya radar");
      await disparar(env, wf, arg === "radar" ? {} : { forzar: "true" });
      return responder(env, `🚀 Lancé ${arg}. En 1 a 3 minutos te aviso.`);
    }
    case "/estado":
      return responder(env, await estado(env));
    case "/start":
    case "/ayuda":
      return responder(
        env,
        "Háblame normal: pregúntame por métricas, corrígeme el estilo, cuéntame qué hiciste hoy o dime qué publicar.\n\nMándame links o reenvíame posts y los uso como inspiración.\n\nAtajos:\n/estado\n/pausa [x|linkedin]\n/sigue [x|linkedin]\n/ya x · /ya linkedin · /ya radar",
      );
  }

  // Reenviado o solo links: es algo que Diego leyó, va a fuentes sin gastar Claude.
  const soloLinks = texto && texto.replace(/https?:\/\/\S+/g, "").trim() === "";
  if (m.forward_origin || soloLinks) {
    const o = m.forward_origin;
    const autor = o?.sender_user?.username ?? o?.chat?.username ?? o?.chat?.title ?? null;
    await env.DB.prepare("INSERT INTO fuentes (fecha, origen, externo_id, autor, url, texto) VALUES (?, 'telegram', ?, ?, ?, ?)")
      .bind(new Date().toISOString(), String(m.message_id), autor, texto.match(/https?:\/\/\S+/)?.[0] ?? null, texto || "(sin texto)")
      .run();
    return reaccionar(env, m, "👌");
  }
  if (!texto) return responder(env, "Por ahora entiendo texto y links.");

  // Conversación: la contesta el agente de chat en GitHub Actions (~1 min).
  await env.DB.prepare("INSERT INTO chat (fecha, rol, texto, respondido) VALUES (?, 'diego', ?, 0)").bind(new Date().toISOString(), texto).run();
  await reaccionar(env, m, "👀");
  await disparar(env, "chat.yml");
}

async function estado(env: Env): Promise<string> {
  const { results: cfg } = await env.DB.prepare(
    "SELECT clave, valor FROM config WHERE clave IN ('pausa_x','pausa_linkedin','x_cada_horas','x_max_dia','radar_x')",
  ).all<{ clave: string; valor: string }>();
  const c = Object.fromEntries(cfg.map((f) => [f.clave, f.valor]));
  const { results: ultimos } = await env.DB.prepare(
    "SELECT red, fecha, substr(texto, 1, 80) AS inicio FROM posts WHERE borrado = 0 ORDER BY fecha DESC LIMIT 4",
  ).all<{ red: string; fecha: string; inicio: string }>();
  return [
    `LinkedIn: ${c.pausa_linkedin === "1" ? "⏸️ pausado" : "▶️ diario 8:30"}`,
    `X: ${c.pausa_x === "1" ? "⏸️ pausado" : `▶️ cada ${c.x_cada_horas} h (tope ${c.x_max_dia}/día)`}`,
    `Radar X: ${c.radar_x}`,
    "",
    "Últimos posts:",
    ...ultimos.map((p) => `• ${p.red} ${p.fecha.slice(5, 16).replace("T", " ")} UTC · ${p.inicio}…`),
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

const responder = (env: Env, text: string) => telegram(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text });

const reaccionar = (env: Env, m: Mensaje, emoji: string) =>
  telegram(env, "setMessageReaction", { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: "emoji", emoji }] });
