// Autoriza la app de X con OAuth 2.0 + PKCE en tu navegador y guarda el refresh
// token en D1 (los agentes lo renuevan solos desde ahí). Se corre una sola vez,
// o de nuevo si X revoca el acceso.
// Uso: npm run token:x
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { guardarConfig } from "../src/comun/memoria.ts";

const PUERTO = 8787;
const REDIRECT_URI = `http://127.0.0.1:${PUERTO}/callback`;
// offline.access da el refresh token; media.write sube imágenes; bookmark.read y like.read alimentan el radar.
const SCOPES = "tweet.read tweet.write users.read media.write bookmark.read like.read offline.access";

const { X_CLIENT_ID: clientId, X_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) {
  console.error("Pon X_CLIENT_ID y X_CLIENT_SECRET en .env");
  process.exit(1);
}

const verifier = randomBytes(32).toString("base64url");
const state = crypto.randomUUID();
const urlAuth = new URL("https://x.com/i/oauth2/authorize");
urlAuth.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  state,
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
}).toString();

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", REDIRECT_URI);
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    const recibido = url.searchParams.get("code");
    if (!recibido || url.searchParams.get("state") !== state) {
      res.end("Error de autorización. Revisa la terminal.");
      server.close();
      return reject(new Error(url.searchParams.get("error") ?? "Callback inválido"));
    }
    res.end("Listo, ya puedes cerrar esta pestaña.");
    server.close();
    resolve(recibido);
  });
  server.listen(PUERTO, "127.0.0.1", () => {
    console.log("Abriendo X para autorizar…");
    execFileSync("open", [urlAuth.toString()]);
  });
});

const res = await fetch("https://api.x.com/2/oauth2/token", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
  },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
});
if (!res.ok) throw new Error(`Token: ${res.status} ${await res.text()}`);
const t = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };

const resYo = await fetch("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${t.access_token}` } });
if (!resYo.ok) throw new Error(`Perfil: ${resYo.status} ${await resYo.text()}`);
const { data } = (await resYo.json()) as { data: { id: string; username: string } };

await guardarConfig("x_refresh_token", t.refresh_token);
await guardarConfig("x_access_token", t.access_token);
await guardarConfig("x_access_expira", new Date(Date.now() + t.expires_in * 1000).toISOString());
await guardarConfig("x_usuario", JSON.stringify({ id: data.id, username: data.username }));
console.log(`Autorizado como @${data.username}. Tokens guardados en D1.`);
