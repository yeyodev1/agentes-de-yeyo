// Pasa el historial del repo viejo de LinkedIn (historial.json) a D1. Se corre una vez.
// Uso: npm run migrar
import { readFile } from "node:fs/promises";
import { guardarPost, sql } from "../src/comun/memoria.ts";

type Viejo = { fecha: string; urn: string; gancho: string; estructura: string; texto: string };

const historial: Viejo[] = JSON.parse(await readFile("agente-para-linkedin/contenido/historial.json", "utf8"));
for (const p of historial) {
  const [existe] = await sql("SELECT 1 FROM posts WHERE red = 'linkedin' AND externo_id = ?", [p.urn]);
  if (existe) continue;
  await guardarPost({
    red: "linkedin",
    externo_id: p.urn,
    fecha: p.fecha,
    texto: p.texto,
    gancho: p.gancho,
    estructura: p.estructura,
    tema: null,
    origen: "agente",
  });
}
console.log(`${historial.length} posts de LinkedIn en D1.`);
