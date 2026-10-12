#!/usr/bin/env bash
# Carga el token de Vercel de Pana en el Worker (Cloudflare) y en GitHub Actions.
# El token se crea en vercel.com/account/tokens (Vercel no deja crearlo con la sesión del CLI).
# Uso: VERCEL_TOKEN=<token> bash scripts/conectar-vercel.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN="${VERCEL_TOKEN:-}"
[ -n "$TOKEN" ] || { echo "Crea el token en vercel.com/account/tokens y corre: VERCEL_TOKEN=<token> bash scripts/conectar-vercel.sh"; exit 1; }

# Comprobar que el token sirve antes de guardarlo.
ESTADO=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "https://api.vercel.com/v6/deployments?teamId=team_ZB0eFNsqFQo6bL8QgAMAWUHa&limit=1")
[ "$ESTADO" = "200" ] || { echo "Vercel rechazó el token ($ESTADO). Revisa que el scope sea 'Proyectos de Diego'."; exit 1; }
echo "🔑 Token válido"

printf %s "$TOKEN" | gh secret set VERCEL_TOKEN
echo "✅ Guardado en GitHub Actions"

# wrangler lee CLOUDFLARE_API_TOKEN si existe y tapa tu sesión: se ignora aquí.
(cd worker && printf %s "$TOKEN" | env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN npx wrangler secret put VERCEL_TOKEN >/dev/null)
echo "✅ Guardado en el Worker"
echo "🐦 Listo: Pana ya puede leer tus deploys de Vercel"
