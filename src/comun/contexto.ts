// Lo que todo agente sabe antes de escribir: quién es Diego, cómo escribe en esa red,
// qué pasó, qué aprendió y qué está leyendo. Así LinkedIn y X no se repiten entre sí.
import { readFile } from "node:fs/promises";
import { type Fuente, type Post, type Red, postsRecientes, sql } from "./memoria.ts";

export function hoy(): string {
  return new Date().toLocaleString("es-EC", {
    timeZone: "America/Guayaquil",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const formatoPost = (p: Post) =>
  `--- ${p.fecha.slice(0, 16)} · ${p.gancho ?? "-"} · ${p.estructura ?? "-"}${p.metricas ? ` · métricas: ${p.metricas}` : ""} ---\n${p.texto}`;

export async function contexto(red: Red, { propios = 15, ajenos = 5 } = {}): Promise<string> {
  const otra: Red = red === "x" ? "linkedin" : "x";
  const hace4dias = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const [voz, vozRed, materialFijo, material, aprendizajes, mios, otros, fuentes] = await Promise.all([
    readFile("contenido/voz.md", "utf8"),
    readFile(`contenido/voz-${red}.md`, "utf8"),
    readFile("contenido/material.md", "utf8"),
    sql<{ fecha: string; texto: string }>("SELECT fecha, texto FROM material ORDER BY fecha DESC LIMIT 30"),
    sql<{ red: string; texto: string; origen: string }>(
      "SELECT red, texto, origen FROM aprendizajes WHERE activo = 1 AND red IN (?, 'todas') ORDER BY fecha DESC LIMIT 40",
      [red],
    ),
    postsRecientes(red, propios),
    postsRecientes(otra, ajenos),
    sql<Fuente>(
      "SELECT fecha, origen, autor, url, texto, metricas FROM fuentes WHERE fecha >= ? ORDER BY fecha DESC LIMIT 60",
      [hace4dias],
    ),
  ]);

  return `<voz>
${voz}

${vozRed}
</voz>

<aprendizajes>
Reglas que salieron de correcciones de Diego y de las métricas. Pesan más que <voz> si chocan.
${aprendizajes.map((a) => `- [${a.origen}] ${a.texto}`).join("\n") || "(todavía ninguno)"}
</aprendizajes>

<material_reciente>
${material.map((m) => `## ${m.fecha.slice(0, 10)}\n${m.texto}`).join("\n\n")}

${materialFijo}
</material_reciente>

<lo_que_diego_lee>
Links y fotos que mandó por Telegram (telegram_foto: la url tg:... se puede usar como imagen), sus bookmarks y likes de X, y lo último de las cuentas que sigue de cerca (la URL trae el id para citar). Úsalo como inspiración y para reaccionar con opinión propia; nunca copies ni lo presentes como experiencia de Diego.
${fuentes.map((f) => `- [${f.origen}${f.autor ? ` @${f.autor}` : ""} ${f.fecha.slice(0, 10)}] ${f.texto.replace(/\s+/g, " ").slice(0, 400)}${f.url ? ` (${f.url})` : ""}${f.metricas ? ` ${f.metricas}` : ""}`).join("\n") || "(nada todavía)"}
</lo_que_diego_lee>

<posts_recientes_${red}>
${mios.map(formatoPost).join("\n\n") || "(todavía no hay)"}
</posts_recientes_${red}>

<posts_recientes_${otra}>
Lo que se publicó en la otra red. Puedes retomar un tema con otro ángulo, pero no copies.
${otros.map(formatoPost).join("\n\n") || "(todavía no hay)"}
</posts_recientes_${otra}>`;
}
