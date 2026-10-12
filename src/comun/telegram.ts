// Avisos a Diego por Telegram. Texto plano: sin parse_mode no hay nada que escapar.

const LIMITE = 4000; // Telegram corta en 4096

export async function avisar(texto: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
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
