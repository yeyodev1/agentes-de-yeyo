// Memoria compartida: la base D1 del Worker "cerebro-yeyo", usada desde
// GitHub Actions por la API REST de Cloudflare.

export type Red = "linkedin" | "x";

export type Post = {
  id: number;
  red: Red;
  externo_id: string;
  fecha: string;
  texto: string;
  gancho: string | null;
  estructura: string | null;
  tema: string | null;
  origen: string;
  metricas: string | null;
};

export type Fuente = { fecha: string; origen: string; autor: string | null; url: string | null; texto: string; metricas: string | null };

function requerido(nombre: string): string {
  const v = process.env[nombre];
  if (!v) throw new Error(`Falta la variable ${nombre}`);
  return v;
}

export async function sql<T = Record<string, unknown>>(consulta: string, params: unknown[] = []): Promise<T[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${requerido("CF_ACCOUNT_ID")}/d1/database/${requerido("CF_D1_ID")}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${requerido("CF_API_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: consulta, params }),
  });
  const cuerpo = (await res.json()) as { success: boolean; errors: unknown[]; result?: { results: T[] }[] };
  if (!res.ok || !cuerpo.success) throw new Error(`D1 ${res.status}: ${JSON.stringify(cuerpo.errors)}`);
  return cuerpo.result?.[0]?.results ?? [];
}

export async function leerConfig(clave: string, porDefecto = ""): Promise<string> {
  const [fila] = await sql<{ valor: string }>("SELECT valor FROM config WHERE clave = ?", [clave]);
  return fila?.valor ?? porDefecto;
}

export async function guardarConfig(clave: string, valor: string): Promise<void> {
  await sql(
    "INSERT INTO config (clave, valor, actualizado) VALUES (?, ?, datetime('now')) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado = excluded.actualizado",
    [clave, valor],
  );
}

export async function guardarPost(p: Omit<Post, "id" | "metricas">): Promise<void> {
  await sql(
    "INSERT INTO posts (red, externo_id, fecha, texto, gancho, estructura, tema, origen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [p.red, p.externo_id, p.fecha, p.texto, p.gancho, p.estructura, p.tema, p.origen],
  );
}

export async function postsRecientes(red: Red, limite: number): Promise<Post[]> {
  const filas = await sql<Post>("SELECT * FROM posts WHERE red = ? AND borrado = 0 ORDER BY fecha DESC LIMIT ?", [red, limite]);
  return filas.reverse();
}

const diaEcuador = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Guayaquil" });

export async function postsDeHoy(red: Red): Promise<number> {
  const desde = new Date(Date.now() - 36 * 3_600_000).toISOString();
  const filas = await sql<{ fecha: string }>("SELECT fecha FROM posts WHERE red = ? AND borrado = 0 AND fecha >= ?", [red, desde]);
  const hoy = diaEcuador(new Date());
  return filas.filter((f) => diaEcuador(new Date(f.fecha)) === hoy).length;
}
