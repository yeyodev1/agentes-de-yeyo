// Avisos a Diego por Telegram, en HTML: **negritas** del agente se vuelven <b>,
// todo lo demás se escapa. Si Telegram rechaza el HTML, se reenvía plano.
import { leerConfig } from "./memoria.ts";

const LIMITE = 4000; // Telegram corta en 4096

const escapar = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const aHtml = (t: string) => escapar(t).replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");

export async function avisar(texto: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  // El chat id lo guarda el Worker en D1 cuando Diego vincula el bot.
  const chatId = process.env.TELEGRAM_CHAT_ID || (token ? await leerConfig("telegram_chat_id") : "");
  if (!token || !chatId) return console.log(`[telegram desactivado] ${texto}`);

  // Se trocea el texto crudo y se convierte cada trozo: un ** partido queda literal, no rompe nada.
  for (let i = 0; i < texto.length; i += LIMITE) {
    const trozo = texto.slice(i, i + LIMITE);
    const enviar = (cuerpo: Record<string, unknown>) =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, link_preview_options: { is_disabled: true }, ...cuerpo }),
      });
    let res = await enviar({ text: aHtml(trozo), parse_mode: "HTML" });
    if (!res.ok) res = await enviar({ text: trozo });
    // Un aviso que falla no debe tumbar una publicación que ya salió.
    if (!res.ok) console.error(`Telegram respondió ${res.status}: ${await res.text()}`);
  }
}
