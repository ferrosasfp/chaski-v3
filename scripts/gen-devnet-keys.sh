#!/usr/bin/env bash
# gen-devnet-keys.sh — Genera + fondea las 2 keypairs devnet de M5 e imprime
# los valores EXACTOS para pegar en Railway (facilitator) y Vercel (chaski).
#
# Formato de private key (verificado en código):
#   solana-fee-payer.ts / solana-release-authority.ts esperan
#   Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env)))
#   → el valor de la env es el ARRAY JSON de 64 números (contenido del .json),
#     NO base58.
#
# Cero plata real — todo devnet. NUNCA commitees los .json ni las private keys.
set -euo pipefail

OUT_DIR="${1:-./m5-keys}"          # dir de salida (gitignorealo)
AIRDROP_SOL_FEEPAYER="${AIRDROP_SOL_FEEPAYER:-10}"   # SOL por airdrop
AIRDROP_ROUNDS_FEEPAYER="${AIRDROP_ROUNDS_FEEPAYER:-3}"  # ~30 SOL total
AIRDROP_SOL_RELEASE="${AIRDROP_SOL_RELEASE:-5}"

command -v solana >/dev/null 2>&1 || { echo "❌ 'solana' CLI no instalado. Instalá: https://docs.solanalabs.com/cli/install"; exit 1; }
command -v solana-keygen >/dev/null 2>&1 || { echo "❌ 'solana-keygen' no encontrado (viene con el CLI)"; exit 1; }

mkdir -p "$OUT_DIR"
echo "⚠️  Las keys se escriben en $OUT_DIR — NO las commitees (agregá $OUT_DIR/ a .gitignore)."
echo "==================================================================="

gen_and_fund() {
  local label="$1" file="$2" sol="$3" rounds="$4"
  echo ""
  echo ">>> $label"
  if [ -f "$file" ]; then
    echo "    (ya existe $file, no regenero)"
  else
    solana-keygen new --no-bip39-passphrase --silent -o "$file"
  fi
  local pubkey
  pubkey="$(solana address -k "$file")"
  echo "    PUBKEY (base58): $pubkey"

  echo "    Fondeando devnet ($sol SOL x $rounds)..."
  for i in $(seq 1 "$rounds"); do
    solana airdrop "$sol" "$pubkey" --url devnet >/dev/null 2>&1 \
      && echo "      airdrop $i/$rounds OK" \
      || echo "      airdrop $i/$rounds falló (faucet rate-limit; reintentá luego con: solana airdrop $sol $pubkey --url devnet)"
    sleep 2
  done
  local bal
  bal="$(solana balance "$pubkey" --url devnet 2>/dev/null || echo '?')"
  echo "    BALANCE devnet: $bal"

  # private key = contenido del .json (array de 64 números), en una línea
  local privkey_json
  privkey_json="$(tr -d ' \n' < "$file")"
  echo "    PRIVATE KEY (pegá TODO el array en la env, incluyendo corchetes):"
  echo "      $privkey_json"
}

gen_and_fund "FEE-PAYER (gasless sponsor)" "$OUT_DIR/fee-payer.json" "$AIRDROP_SOL_FEEPAYER" "$AIRDROP_ROUNDS_FEEPAYER"
FEEPAYER_PUB="$(solana address -k "$OUT_DIR/fee-payer.json")"

gen_and_fund "RELEASE-AUTHORITY (firma release del escrow)" "$OUT_DIR/release-authority.json" "$AIRDROP_SOL_RELEASE" "1"
RELEASE_PUB="$(solana address -k "$OUT_DIR/release-authority.json")"

echo ""
echo "==================================================================="
echo "📋 DÓNDE VA CADA VALOR:"
echo ""
echo "  RAILWAY (wasiai-facilitator):"
echo "    SOLANA_FEE_PAYER_PRIVATE_KEY              = [array de fee-payer.json]  (private, 64 números)"
echo "    SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY = [array de release-authority.json]  (private)"
echo ""
echo "  VERCEL (chaski-v3):"
echo "    NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY     = $FEEPAYER_PUB   (pubkey del fee-payer)"
echo "    SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY    = $RELEASE_PUB   (pubkey release-authority, server-only)"
echo ""
echo "  ⚠️  Los PUBKEYS son públicos (van en pubkey vars). Los ARRAYS son SECRETOS"
echo "      (van solo en las *_PRIVATE_KEY / *_SECRET_KEY del panel, nunca en el repo)."
echo "==================================================================="
echo "✅ Listo. Verificá los balances > 0 antes de correr el smoke."
