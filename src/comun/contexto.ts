// Lo que todo agente sabe antes de escribir: quién es Diego, cómo escribe en esa red,
// qué pasó, qué aprendió y qué está leyendo. Así LinkedIn y X no se repiten entre sí.
import { readFile } from "node:fs/promises";
import { type Fuente, type Post, type Red, leerConfig, postsRecientes, sql } from "./memoria.ts";

// Repos propios que sí se pueden nombrar en público (configurable con la clave github_mencionables).
const MENCIONABLES_POR_DEFECTO = "agentes-de-yeyo,agente-linkedin,personal-portfolio-2025,yeyo-backapp";
// Partes de nombres de repo que no identifican a nadie (no se tapan en los commits).
const GENERICAS = new Set(["backapp", "frontapp", "frontend", "backend", "api", "web", "app", "page", "tienda", "store", "landing", "admin", "dashboard", "bakano"]);

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
  const hace3dias = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const [voz, vozRed, materialFijo, material, aprendizajes, mios, otros, fuentes, github, mencionables] = await Promise.all([
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
      "SELECT fecha, origen, autor, url, texto, metricas FROM fuentes WHERE fecha >= ? AND origen NOT IN ('github', 'vercel') ORDER BY fecha DESC LIMIT 60",
      [hace4dias],
    ),
    sql<Fuente>("SELECT fecha, origen, autor, url, texto, metricas FROM fuentes WHERE origen IN ('github', 'vercel') AND fecha >= ? ORDER BY fecha DESC LIMIT 40", [hace3dias]),
    leerConfig("github_mencionables", MENCIONABLES_POR_DEFECTO),
  ]);
  const publicos = new Set(mencionables.split(",").map((r) => r.trim().toLowerCase()));
  // Los repos de clientes llevan el nombre del cliente: los agentes nunca lo ven,
  // ni en el nombre del repo, ni en su descripción, ni dentro de los commits.
  const lineaGithub = (g: Fuente) => {
    const corto = (g.autor ?? "").split("/").pop()?.toLowerCase() ?? "";
    const texto = g.texto.replace(/\n/g, " | ").slice(0, 600);
    if (publicos.has(corto)) {
      const descripcion = g.metricas ? (JSON.parse(g.metricas) as { descripcion?: string }).descripcion : null;
      return `${g.autor}${descripcion ? ` (${descripcion})` : ""}: ${texto}`;
    }
    const nombre = corto.split(/[-_.]/).filter((p) => p.length > 2 && !GENERICAS.has(p));
    const oculto = nombre.length ? texto.replace(new RegExp(nombre.join("|"), "gi"), "[cliente]") : texto;
    return `un proyecto de cliente (nombre oculto): ${oculto}`;
  };

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

<lo_que_diego_programa>
Su actividad de los últimos 3 días en GitHub (commits, repos) y Vercel (🚀 deploys a producción, o sea cosas que ya están en vivo): material real de build in public (qué está construyendo, qué arregló, qué lanzó). Cuéntalo en lenguaje humano, no como lista de commits. Los proyectos de cliente se cuentan sin nombre y sin detalles que lo identifiquen ("una tienda en línea para un cliente").
${github.map((g) => `- [${g.fecha.slice(0, 16)}] ${lineaGithub(g)}`).join("\n") || "(sin actividad reciente)"}
</lo_que_diego_programa>

<posts_recientes_${red}>
${mios.map(formatoPost).join("\n\n") || "(todavía no hay)"}
</posts_recientes_${red}>

<posts_recientes_${otra}>
Lo que se publicó en la otra red. Puedes retomar un tema con otro ángulo, pero no copies.
${otros.map(formatoPost).join("\n\n") || "(todavía no hay)"}
</posts_recientes_${otra}>`;
}
