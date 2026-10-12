// Arranque común de los agentes con el Claude Agent SDK.
import { createSdkMcpServer, query, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

// En Actions un secret no definido llega como "" y taparía al otro método de auth.
for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
  if (process.env[k] === "") delete process.env[k];
}

type Opciones = {
  prompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  herramientas: SdkMcpToolDefinition<any>[];
  web?: boolean;
  effort?: "low" | "medium" | "high";
  maxTurns?: number;
};

// Devuelve el texto final del agente (vacío si terminó con error).
export async function correrAgente({ prompt, herramientas, web = true, effort = "high", maxTurns = 25 }: Opciones): Promise<string> {
  const integradas = web ? ["WebSearch", "WebFetch"] : [];
  let final = "";
  for await (const msg of query({
    prompt,
    options: {
      model: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
      effort,
      tools: integradas,
      mcpServers: { yeyo: createSdkMcpServer({ name: "yeyo", tools: herramientas }) },
      allowedTools: [...integradas, ...herramientas.map((h) => `mcp__yeyo__${h.name}`)],
      permissionMode: "dontAsk",
      settingSources: [],
      maxTurns,
    },
  })) {
    if (msg.type === "result") {
      console.log(`Resultado: ${msg.subtype} · ${msg.num_turns} turnos · ~$${msg.total_cost_usd.toFixed(3)}`);
      if (msg.subtype === "success") final = msg.result;
    }
  }
  return final;
}

export const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
export const error = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

// Diego no usa signos de apertura: se quitan siempre, aunque el modelo los ponga.
export const sinApertura = (t: string) => t.replace(/[¿¡]/g, "");
