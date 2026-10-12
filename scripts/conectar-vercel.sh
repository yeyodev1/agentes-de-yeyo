#!/usr/bin/env bash
# Crea un token de Vercel para Pana usando tu sesión del CLI de Vercel y lo carga
# en el Worker (Cloudflare) y en GitHub Actions. El token nunca se imprime.
# Uso: bash scripts/conectar-vercel.sh
set -euo pipefail
cd "$(dirname "$0")/.."

EQUIPO="team_ZB0eFNsqFQo6bL8QgAMAWUHa" # Proyectos de Diego
AUTH="$HOME/Library/Application Support/com.vercel.cli/auth.json"
[ -f "$AUTH" ] || { echo "No encuentro la sesión del CLI de Vercel. Corre: vercel login"; exit 1; }

SESION=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['token'])" "$AUTH")
VENCE=$(python3 -c "import time; print(int((time.time() + 365 * 86400) * 1000))")

RESPUESTA=$(curl -s -X POST "https://api.vercel.com/v3/user/tokens?teamId=$EQUIPO" \
  -H "Authorization: Bearer $SESION" -H "Content-Type: application/json" \
  -d "{\"name\":\"pana-agentes (agentes-de-yeyo)\",\"expiresAt\":$VENCE}")
TOKEN=$(printf %s "$RESPUESTA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('bearerToken',''))")
[ -n "$TOKEN" ] || { echo "Vercel no creó el token: $RESPUESTA"; exit 1; }
echo "🔑 Token creado (vence en 1 año)"

printf %s "$TOKEN" | gh secret set VERCEL_TOKEN
echo "✅ Guardado en GitHub Actions"

# wrangler lee CLOUDFLARE_API_TOKEN si existe y tapa tu sesión: se ignora aquí.
(cd worker && printf %s "$TOKEN" | env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN npx wrangler secret put VERCEL_TOKEN >/dev/null)
echo "✅ Guardado en el Worker"
echo "🐦 Listo: Pana ya puede leer tus deploys de Vercel"
