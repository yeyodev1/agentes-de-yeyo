// Agente que redacta y publica 1 post diario en LinkedIn.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { correrAgente, error, ok, sinApertura } from "../comun/agente.ts";
import { contexto, hoy } from "../comun/contexto.ts";
import { guardarPost, leerConfig, postsDeHoy } from "../comun/memoria.ts";
import { avisar } from "../comun/telegram.ts";
import { publicarPost, urlPost } from "./api.ts";

const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_CARACTERES = 3000; // límite duro de LinkedIn; la voz pide ~1.300

avisarSiTokenPorVencer();

if (!DRY_RUN && (await leerConfig("pausa_linkedin")) === "1") {
  console.log("LinkedIn está en pausa (/sigue linkedin en Telegram para reanudar).");
  process.exit(0);
}

// Candado: un solo post por día. El Worker y el horario de respaldo de GitHub
// pueden disparar el mismo día; el segundo se salta.
if (process.env.FORZAR !== "1" && !DRY_RUN && (await postsDeHoy("linkedin")) > 0) {
  console.log("Ya hay un post publicado hoy. No publico otro (usa forzar para saltarte esto).");
  process.exit(0);
}

let publicado: { urn: string; texto: string } | null = null;

const publicar = tool(
  "publicar_post",
  "Publica el post final en el perfil de LinkedIn. Llámala UNA sola vez, con el texto definitivo.",
  {
    texto: z.string().min(200).max(MAX_CARACTERES).describe("Texto completo del post, listo para publicar"),
    gancho: z.string().describe("Tipo de gancho usado, ej. 'confesión de error'"),
    estructura: z.string().describe("Estructura usada, ej. 'tutorial corto'"),
    tema: z.string().describe("Tema en 3 a 6 palabras, ej. 'agente de LinkedIn en Actions'"),
  },
  async ({ texto, gancho, estructura, tema }) => {
    if (publicado) return error("Ya se publicó un post en esta ejecución. No publiques otro.");
    texto = sinApertura(texto);
    const urn = DRY_RUN ? "dry-run" : await publicarPost(texto);
    publicado = { urn, texto };
    if (!DRY_RUN) {
      await guardarPost({ red: "linkedin", externo_id: urn, fecha: new Date().toISOString(), texto, gancho, estructura, tema, origen: "agente" });
    }
    return ok(`Publicado (${urn}).`);
  },
);

const prompt = `Hoy es ${hoy()}. Escribe y publica el post de LinkedIn de hoy. Trabajas solo: Diego no está disponible para responder preguntas.

${await contexto("linkedin")}

Cómo hacerlo:
1. Elige el ángulo. Prioriza lo más nuevo de <material_reciente> y de <lo_que_diego_programa> (lo que construyó estos días en GitHub) que todavía no esté contado en los posts recientes de LinkedIn. Si ya se contó todo, usa el contexto fijo de <voz> desde un ángulo que no se haya usado, o reacciona con experiencia propia a algo de <lo_que_diego_lee>. Solo hechos que estén en estas fuentes: no inventes cifras, clientes, anécdotas ni resultados.
2. Escoge un gancho y una estructura distintos a los del último post.
3. Escribe el post siguiendo <voz> y <aprendizajes> al pie de la letra.
4. Publícalo con publicar_post y termina.`;

const resultado = await correrAgente({ prompt, herramientas: [publicar] });

if (!publicado) {
  console.error(`El agente terminó sin publicar.\n${resultado}`);
  await avisar(`⚠️💼 El agente de LinkedIn terminó sin publicar.\n\n${resultado.slice(0, 1500)}`);
  process.exit(1);
}

const final: { urn: string; texto: string } = publicado;
console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}Post (${final.urn}):\n\n${final.texto}`);
if (!DRY_RUN) await avisar(`💼✅ Publiqué en LinkedIn\n🔗 ${urlPost(final.urn)}\n\n${final.texto}\n\n🗑️ Si no te gusta dime "borra el post de LinkedIn"`);

// El token de LinkedIn dura 60 días y no se puede refrescar solo:
// deja un warning visible en GitHub Actions la última semana.
function avisarSiTokenPorVencer() {
  const expira = process.env.LINKEDIN_TOKEN_EXPIRA;
  if (!expira) return;
  const dias = Math.floor((Date.parse(expira) - Date.now()) / 86_400_000);
  if (dias < 0) throw new Error(`El token de LinkedIn venció el ${expira}. Corre: npm run token:linkedin -- --subir`);
  if (dias <= 7) {
    console.log(`::warning::El token de LinkedIn vence en ${dias} días. Corre: npm run token:linkedin -- --subir`);
    void avisar(`🔑 El token de LinkedIn vence en ${dias} días. En tu Mac: npm run token:linkedin -- --subir`);
  }
}
