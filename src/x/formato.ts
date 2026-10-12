// Esquema de un tweet o hilo, compartido por el agente de X y el chat.
import { z } from "zod";
import type { ParteHilo } from "./api.ts";

export const parte = z.object({
  texto: z
    .string()
    .min(1)
    .max(280)
    .refine((t) => !/https?:\/\/|www\./i.test(t), "Sin links en el texto: X les baja el alcance y cuestan $0.20. Para referenciar un tweet usa citar; para un artículo, cuéntalo con tus palabras y usa su imagen."),
  imagen: z
    .string()
    .optional()
    .describe('Opcional: URL https de una imagen (jpg/png/webp/gif, máx 5 MB) o "tg:<file_id>" de una foto que Diego mandó por Telegram'),
});

export const hilo = z.array(parte).min(1).max(8).describe("1 elemento = tweet suelto; 2 a 8 = hilo, en orden");

export const citar = z
  .string()
  .regex(/^\d+$/)
  .optional()
  .describe("Opcional: id numérico de un tweet a citar (quote) en el primer tweet; sale de las URLs x.com/.../status/<id>");

export const textoDeHilo = (partes: ParteHilo[]) =>
  partes.map((p) => (p.imagen ? `${p.texto}\n[imagen: ${p.imagen}]` : p.texto)).join("\n\n—\n\n");
