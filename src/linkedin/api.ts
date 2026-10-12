// Cliente mínimo de la API oficial de LinkedIn (producto "Share on LinkedIn").

const API = "https://api.linkedin.com";

// LinkedIn exige una versión YYYYMM en cada request y retira las de más de ~1 año.
// Usamos la de hace 2 meses para no depender de que la del mes actual ya exista.
function versionLinkedIn(): string {
  if (process.env.LINKEDIN_VERSION) return process.env.LINKEDIN_VERSION;
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 2);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// El campo `commentary` usa el formato "little text": estos caracteres son
// reservados y, sin escapar, LinkedIn corta el post en silencio.
const RESERVADOS = /[\\|{}@\[\]()<>#*_~]/g;
const escapar = (s: string) => s.replace(RESERVADOS, (c) => `\\${c}`);

// Escapa el texto y convierte los #hashtags en hashtags reales (clickeables).
export function aLittleText(texto: string): string {
  const partes = texto.split(/(#[\p{L}\p{N}]+)/gu);
  return partes
    .map((p) => (/^#[\p{L}\p{N}]+$/u.test(p) ? `{hashtag|\\#|${p.slice(1)}}` : escapar(p)))
    .join("");
}

export async function publicarPost(texto: string): Promise<string> {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const personId = process.env.LINKEDIN_PERSON_ID;
  if (!token || !personId) throw new Error("Faltan LINKEDIN_ACCESS_TOKEN o LINKEDIN_PERSON_ID");

  const res = await fetch(`${API}/rest/posts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "LinkedIn-Version": versionLinkedIn(),
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: `urn:li:person:${personId}`,
      commentary: aLittleText(texto),
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });

  if (res.status !== 201) {
    throw new Error(`LinkedIn respondió ${res.status}: ${await res.text()}`);
  }
  return res.headers.get("x-restli-id") ?? "(sin id)";
}

export async function borrarPost(urn: string): Promise<void> {
  const res = await fetch(`${API}/rest/posts/${encodeURIComponent(urn)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
      "LinkedIn-Version": versionLinkedIn(),
      "X-Restli-Protocol-Version": "2.0.0",
    },
  });
  if (res.status !== 204) throw new Error(`LinkedIn respondió ${res.status}: ${await res.text()}`);
}

export const urlPost = (urn: string) => `https://www.linkedin.com/feed/update/${urn}/`;
