// Radar de X (cada 6 h): lo nuevo de las cuentas que Diego sigue de cerca, sus
// bookmarks y likes, y las métricas de sus propios tweets. Todo va a D1.
import { guardarConfig, leerConfig, sql } from "../comun/memoria.ts";
import { idsDeUsuarios, metricasDe, misBookmarks, misLikes, tweetsDe, type Tweet, yo } from "./api.ts";

const ahora = new Date();
const yoMismo = await yo();

async function guardarFuentes(origen: string, tweets: (Tweet & { autor: string })[]): Promise<number> {
  for (const t of tweets) {
    await sql(
      "INSERT OR IGNORE INTO fuentes (fecha, origen, externo_id, autor, url, texto, metricas) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        t.created_at ?? ahora.toISOString(),
        origen,
        t.id,
        t.autor,
        `https://x.com/${t.autor}/status/${t.id}`,
        t.text,
        t.public_metrics ? JSON.stringify(t.public_metrics) : null,
      ],
    );
  }
  return tweets.length;
}

// 1. Cuentas del radar. Los ids se guardan para no pagar la búsqueda cada vez.
const usernames = (await leerConfig("radar_x")).split(",").map((u) => u.trim().replace(/^@/, "")).filter(Boolean);
const cache: Record<string, string> = JSON.parse((await leerConfig("radar_x_ids")) || "{}");
const faltan = usernames.filter((u) => !cache[u.toLowerCase()]);
for (const u of await idsDeUsuarios(faltan)) cache[u.username.toLowerCase()] = u.id;
await guardarConfig("radar_x_ids", JSON.stringify(cache));

const desde = (await leerConfig("radar_x_ultimo")) || new Date(ahora.getTime() - 24 * 3_600_000).toISOString();
let radar = 0;
for (const u of usernames) {
  const id = cache[u.toLowerCase()];
  if (!id) {
    console.log(`::warning::No encontré @${u} en X`);
    continue;
  }
  radar += await guardarFuentes("x_radar", await tweetsDe(id, desde));
}
await guardarConfig("radar_x_ultimo", ahora.toISOString());

// 2. Lo que Diego guardó o le gustó: la mejor señal de lo que está leyendo.
const bookmarks = await guardarFuentes("x_bookmark", await misBookmarks(yoMismo.id).catch(avisoSinPermiso("bookmarks")));
const likes = await guardarFuentes("x_like", await misLikes(yoMismo.id).catch(avisoSinPermiso("likes")));

// 3. Métricas de los tweets propios de la última semana.
const hace7 = new Date(ahora.getTime() - 7 * 86_400_000).toISOString();
const propios = await sql<{ externo_id: string }>("SELECT externo_id FROM posts WHERE red = 'x' AND borrado = 0 AND fecha >= ?", [hace7]);
const conMetricas = await metricasDe(propios.map((p) => p.externo_id).slice(0, 100));
for (const t of conMetricas) {
  await sql("UPDATE posts SET metricas = ?, metricas_at = ? WHERE red = 'x' AND externo_id = ?", [
    JSON.stringify(t.public_metrics),
    ahora.toISOString(),
    t.id,
  ]);
}

console.log(`Radar: ${radar} tweets de ${usernames.length} cuentas · ${bookmarks} bookmarks · ${likes} likes · métricas de ${conMetricas.length} tweets propios`);

function avisoSinPermiso(que: string) {
  return (e: unknown) => {
    console.log(`::warning::No pude leer ${que}: ${e instanceof Error ? e.message : e}`);
    return [];
  };
}
