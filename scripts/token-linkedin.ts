// Obtiene un access token de LinkedIn (dura 60 días) con OAuth en tu navegador.
// Uso: npm run token:linkedin            → lo guarda en .env
//      npm run token:linkedin -- --subir → además lo sube como secrets del repo con `gh`
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const PUERTO = 8787;
const REDIRECT_URI = `http://localhost:${PUERTO}/callback`;
const SCOPES = "openid profile w_member_social";

const clientId = process.env.LINKEDIN_CLIENT_ID;
const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Pon LINKEDIN_CLIENT_ID y LINKEDIN_CLIENT_SECRET en .env");
  process.exit(1);
}

const state = crypto.randomUUID();
const urlAuth = new URL("https://www.linkedin.com/oauth/v2/authorization");
urlAuth.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  state,
}).toString();

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", REDIRECT_URI);
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    const error = url.searchParams.get("error_description");
    const recibido = url.searchParams.get("code");
    if (error || !recibido || url.searchParams.get("state") !== state) {
      res.end("Error de autorización. Revisa la terminal.");
      server.close();
      return reject(new Error(error ?? "Callback inválido"));
    }
    res.end("Listo, ya puedes cerrar esta pestaña.");
    server.close();
    resolve(recibido);
  });
  server.listen(PUERTO, () => {
    console.log("Abriendo LinkedIn para autorizar…");
    execFileSync("open", [urlAuth.toString()]);
  });
});

const resToken = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    client_secret: clientSecret,
  }),
});
if (!resToken.ok) throw new Error(`Token: ${resToken.status} ${await resToken.text()}`);
const { access_token, expires_in } = (await resToken.json()) as { access_token: string; expires_in: number };

const resPerfil = await fetch("https://api.linkedin.com/v2/userinfo", {
  headers: { Authorization: `Bearer ${access_token}` },
});
if (!resPerfil.ok) throw new Error(`Perfil: ${resPerfil.status} ${await resPerfil.text()}`);
const { sub, name } = (await resPerfil.json()) as { sub: string; name: string };

const valores = {
  LINKEDIN_ACCESS_TOKEN: access_token,
  LINKEDIN_PERSON_ID: sub,
  LINKEDIN_TOKEN_EXPIRA: new Date(Date.now() + expires_in * 1000).toISOString(),
};

// Actualiza o agrega cada clave en .env sin tocar el resto.
let env = await readFile(".env", "utf8").catch(() => "");
for (const [k, v] of Object.entries(valores)) {
  const linea = `${k}=${v}`;
  env = new RegExp(`^${k}=.*$`, "m").test(env)
    ? env.replace(new RegExp(`^${k}=.*$`, "m"), linea)
    : `${env.trimEnd()}\n${linea}\n`;
}
await writeFile(".env", env);
console.log(`Autorizado como ${name}. Token guardado en .env (vence ${valores.LINKEDIN_TOKEN_EXPIRA.slice(0, 10)}).`);

if (process.argv.includes("--subir")) {
  for (const [k, v] of Object.entries(valores)) {
    execFileSync("gh", ["secret", "set", k, "--body", v], { stdio: "inherit" });
  }
  console.log("Secrets actualizados en GitHub.");
}
