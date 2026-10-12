// Agente de X: lo dispara el Worker cada N horas (N lo decide él mismo dentro de un rango).
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { correrAgente, error, ok, sinApertura } from "../comun/agente.ts";
import { contexto, hoy } from "../comun/contexto.ts";
import { guardarConfig, guardarPost, leerConfig, postsDeHoy, sql } from "../comun/memoria.ts";
import { avisar } from "../comun/telegram.ts";
import { publicarHilo, urlTweet, yo } from "./api.ts";
import { citar, hilo, textoDeHilo } from "./formato.ts";

const DRY_RUN = process.env.DRY_RUN === "1";
const FRECUENCIAS = [1, 2, 3, 4, 6, 8];

if (!DRY_RUN && (await leerConfig("pausa_x")) === "1") {
  console.log("X está en pausa (/sigue x en Telegram para reanudar).");
  process.exit(0);
}

const maxDia = Number(await leerConfig("x_max_dia", "8"));
const deHoy = await postsDeHoy("x");
if (!DRY_RUN && process.env.FORZAR !== "1" && deHoy >= maxDia) {
  console.log(`Ya van ${deHoy} tweets hoy (tope ${maxDia}).`);
  process.exit(0);
}

const cadaHoras = await leerConfig("x_cada_horas", "4");
let publicado: { ids: string[]; texto: string } | null = null;
let decision = "";

const publicar = tool(
  "publicar_tweet",
  "Publica en X: un tweet suelto o un hilo. Llámala UNA sola vez.",
  {
    tweets: hilo,
    citar,
    tipo: z.string().describe("Tipo de tweet según <voz>, ej. 'opinión', 'construyendo', 'tip', 'hilo paso a paso'"),
    gancho: z.string().describe("Cómo abre, ej. 'dato', 'confesión', 'contraintuitivo'"),
    tema: z.string().describe("Tema en 3 a 6 palabras"),
  },
  async ({ tweets, citar, tipo, gancho, tema }) => {
    if (publicado) return error("Ya publicaste en esta ejecución.");
    tweets = tweets.map((t) => ({ ...t, texto: sinApertura(t.texto) }));
    let ids: string[];
    try {
      ids = DRY_RUN ? ["dry-run"] : await publicarHilo(tweets, citar);
    } catch (e) {
      return error(`No se pudo publicar: ${e instanceof Error ? e.message : e}. Si fue la imagen, intenta sin ella o con otra.`);
    }
    const texto = (citar ? `[cita el tweet ${citar}]\n` : "") + textoDeHilo(tweets);
    publicado = { ids, texto };
    if (!DRY_RUN) {
      await guardarPost({ red: "x", externo_id: ids[0], fecha: new Date().toISOString(), texto, gancho, estructura: tipo, tema, origen: "agente" });
    }
    return ok(`Publicado (${ids.join(", ")}).`);
  },
);

const borrador = tool(
  "dejar_borrador",
  "Si tienes una buena idea pero dudas de que encaje con la voz o los límites (tema sensible, opinión fuerte sobre alguien, dato que no puedes verificar), no publiques: déjale el borrador a Diego por Telegram para que lo revise.",
  { tweets: hilo, citar, motivo: z.string().describe("Por qué dudas") },
  async ({ tweets, citar, motivo }) => {
    const texto = `📝 Borrador para revisar (${motivo})\n\n${citar ? `[cita el tweet ${citar}]\n` : ""}${textoDeHilo(tweets)}\n\nDime "publícalo", pídeme cambios o ignóralo.`;
    decision = `Dejé un borrador: ${motivo}`;
    if (!DRY_RUN) {
      await avisar(texto);
      // Queda en el chat para que el agente de Telegram sepa de qué borrador le hablan.
      await sql("INSERT INTO chat (fecha, rol, texto) VALUES (?, 'agente', ?)", [new Date().toISOString(), texto]);
    }
    return ok("Borrador enviado a Diego.");
  },
);

const noPublicar = tool(
  "no_publicar",
  "Úsala si esta vez no hay nada que valga la pena decir. Mejor nada que un tweet de relleno.",
  { motivo: z.string() },
  async ({ motivo }) => {
    decision = `No publiqué: ${motivo}`;
    return ok("Entendido, no se publica esta vez.");
  },
);

const cambiarFrecuencia = tool(
  "cambiar_frecuencia",
  `Cambia cada cuántas horas te disparan (entre 8 am y 10 pm de Ecuador). Ahora: cada ${cadaHoras} h. Hazlo solo con evidencia en las métricas o en <aprendizajes>, no por intuición.`,
  { cada_horas: z.literal(FRECUENCIAS), motivo: z.string() },
  async ({ cada_horas, motivo }) => {
    if (!DRY_RUN) {
      await guardarConfig("x_cada_horas", String(cada_horas));
      await avisar(`🔁 Agente de X: paso de cada ${cadaHoras} h a cada ${cada_horas} h.\nMotivo: ${motivo}`);
    }
    return ok(`Frecuencia: cada ${cada_horas} h.`);
  },
);

const prompt = `Hoy es ${hoy()}. Eres el agente que maneja el X (Twitter) de Diego. La cuenta estuvo abandonada y la estás reviviendo. Trabajas solo y de forma autónoma: Diego no va a revisar antes de que publiques, así que cuida cada palabra. Te disparan cada ${cadaHoras} h y hoy ya salieron ${deHoy} tweets (tope ${maxDia}).

${await contexto("x", { propios: 30 })}

Cómo hacerlo:
1. Mira <posts_recientes_x> y sus métricas: qué tipo de tweet funcionó y qué no. Revisa <lo_que_diego_lee> y <material_reciente> para ver qué hay nuevo.
2. Decide si vale la pena publicar ahora. Si no hay nada bueno, usa no_publicar.
3. Si publicas, elige un tipo y un gancho distintos a los de los últimos tweets y escríbelo siguiendo <voz> y <aprendizajes>. Solo hechos reales de las fuentes: no inventes cifras, clientes ni anécdotas. Nunca nombres clientes de Bakano.
4. Refuerza el tweet cuando sume:
   - Referencia: si reaccionas a un tweet de <lo_que_diego_lee>, cítalo con citar (el id sale de su URL) y aporta tu experiencia; no lo resumas.
   - Imagen: las fotos que mandó Diego (origen telegram_foto, url "tg:...") son lo mejor porque son reales. También sirve la imagen principal de un artículo que comentas (búscala con WebFetch). Nunca inventes una URL de imagen.
   - Hilo: cuando hay un paso a paso o una historia con varias partes, y como máximo uno al día.
5. Si dudas de algo, usa dejar_borrador en lugar de publicar.
6. Opcional: si las métricas de varios días muestran algo claro, ajusta tu frecuencia con cambiar_frecuencia.
7. Termina en cuanto publiques, dejes el borrador o decidas no publicar.`;

const resultado = await correrAgente({ prompt, herramientas: [publicar, borrador, noPublicar, cambiarFrecuencia], effort: "medium" });

if (publicado) {
  const final: { ids: string[]; texto: string } = publicado;
  console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}${final.texto}`);
  if (!DRY_RUN) {
    const { username } = await yo();
    await avisar(`🐦 Publiqué en X\n${urlTweet(username, final.ids[0])}\n\n${final.texto}\n\nPara bajarlo: "borra el último tweet"`);
  }
} else if (decision) {
  console.log(decision);
} else {
  console.error(`El agente terminó sin decidir.\n${resultado}`);
  await avisar(`⚠️ El agente de X terminó sin publicar ni explicar por qué.\n\n${resultado.slice(0, 1500)}`);
  process.exit(1);
}
