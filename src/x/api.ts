// Cliente mínimo de la API v2 de X con OAuth 2.0 (contexto de usuario).
// Cobro por uso: ~$0.015 por tweet creado, ~$0.005 por post ajeno leído, ~$0.001 por dato propio.
import { guardarConfig, leerConfig } from "../comun/memoria.ts";

const API = "https://api.x.com/2";

export type Tweet = {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: Record<string, number>;
};

// El access token dura 2 h y el refresh token cambia en cada uso: los dos viven en
// D1 para que los compartan el agente, el radar y el chat.
let accessToken: string | null = null;

async function token(): Promise<string> {
  if (accessToken) return accessToken;
  const [guardado, expira] = await Promise.all([leerConfig("x_access_token"), leerConfig("x_access_expira")]);
  if (guardado && Date.parse(expira) - Date.now() > 5 * 60_000) return (accessToken = guardado);

  const refresh = await leerConfig("x_refresh_token");
  if (!refresh) throw new Error("No hay x_refresh_token en D1. Corre en tu Mac: npm run token:x");
  const { X_CLIENT_ID: id, X_CLIENT_SECRET: secreto } = process.env;
  if (!id || !secreto) throw new Error("Faltan X_CLIENT_ID o X_CLIENT_SECRET");

  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secreto}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: id }),
  });
  if (!res.ok) throw new Error(`X token ${res.status}: ${await res.text()}. Si persiste, corre: npm run token:x`);
  const t = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  // El refresh viejo ya no sirve: guardar el nuevo antes que cualquier otra cosa.
  await guardarConfig("x_refresh_token", t.refresh_token);
  await guardarConfig("x_access_token", t.access_token);
  await guardarConfig("x_access_expira", new Date(Date.now() + t.expires_in * 1000).toISOString());
  return (accessToken = t.access_token);
}

async function x<T>(ruta: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${ruta}`, {
    ...init,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`X ${init.method ?? "GET"} ${ruta.split("?")[0]} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function publicarTweet(texto: string, respondeA?: string): Promise<string> {
  const cuerpo = respondeA ? { text: texto, reply: { in_reply_to_tweet_id: respondeA } } : { text: texto };
  const { data } = await x<{ data: { id: string } }>("/tweets", { method: "POST", body: JSON.stringify(cuerpo) });
  return data.id;
}

// Publica un hilo encadenando respuestas. Devuelve los ids en orden.
export async function publicarHilo(tweets: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const t of tweets) ids.push(await publicarTweet(t, ids.at(-1)));
  return ids;
}

export async function borrarTweet(id: string): Promise<void> {
  await x(`/tweets/${id}`, { method: "DELETE" });
}

export async function yo(): Promise<{ id: string; username: string }> {
  const guardado = await leerConfig("x_usuario");
  if (guardado) return JSON.parse(guardado);
  const { data } = await x<{ data: { id: string; username: string } }>("/users/me");
  await guardarConfig("x_usuario", JSON.stringify({ id: data.id, username: data.username }));
  return data;
}

export const urlTweet = (usuario: string, id: string) => `https://x.com/${usuario}/status/${id}`;

const CAMPOS = "tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username";
type Pagina = { data?: Tweet[]; includes?: { users?: { id: string; username: string }[] } };

// Agrega el username del autor a cada tweet.
function conAutor(p: Pagina): (Tweet & { autor: string })[] {
  const nombres = new Map(p.includes?.users?.map((u) => [u.id, u.username]));
  return (p.data ?? []).map((t) => ({ ...t, autor: nombres.get(t.author_id ?? "") ?? "?" }));
}

export async function idsDeUsuarios(usernames: string[]): Promise<{ id: string; username: string }[]> {
  if (!usernames.length) return [];
  const { data } = await x<{ data?: { id: string; username: string }[] }>(`/users/by?usernames=${usernames.join(",")}`);
  return data ?? [];
}

export async function tweetsDe(userId: string, desde: string, max = 10) {
  return conAutor(await x<Pagina>(`/users/${userId}/tweets?max_results=${max}&exclude=retweets,replies&start_time=${desde}&${CAMPOS}`));
}

export async function misBookmarks(userId: string, max = 20) {
  return conAutor(await x<Pagina>(`/users/${userId}/bookmarks?max_results=${max}&${CAMPOS}`));
}

export async function misLikes(userId: string, max = 20) {
  return conAutor(await x<Pagina>(`/users/${userId}/liked_tweets?max_results=${max}&${CAMPOS}`));
}

export async function metricasDe(ids: string[]): Promise<Tweet[]> {
  if (!ids.length) return [];
  const { data } = await x<{ data?: Tweet[] }>(`/tweets?ids=${ids.join(",")}&tweet.fields=public_metrics`);
  return data ?? [];
}
