// Avisos a Diego por Telegram. Texto plano: sin parse_mode no hay nada que escapar.
import { leerConfig } from "./memoria.ts";

const LIMITE = 4000; // Telegram corta en 4096

export async function avisar(texto: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  // El chat id lo guarda el Worker en D1 cuando Diego vincula el bot.
  const chatId = process.env.TELEGRAM_CHAT_ID || (token ? await leerConfig("telegram_chat_id") : "");
  if (!token || !chatId) return console.log(`[telegram desactivado] ${texto}`);

  for (let i = 0; i < texto.length; i += LIMITE) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: texto.slice(i, i + LIMITE), link_preview_options: { is_disabled: true } }),
    });
    // Un aviso que falla no debe tumbar una publicación que ya salió.
    if (!res.ok) console.error(`Telegram respondió ${res.status}: ${await res.text()}`);
  }
}
