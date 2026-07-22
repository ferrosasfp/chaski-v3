# Auto-Blindaje — HU-SOL-11 (WKH-214) · Dev F3

Registro de errores cometidos durante la implementación y sus fixes, para blindar futuras HUs.

### [2026-07-22] Wave 1 — feePayer del `deposit` mal derivado en el smoke
- **Error**: en `scripts/smoke-solana-e2e.ts` seteé `tx.feePayer = new PublicKey(authority)` (la
  release-authority) al construir la ix `deposit`, en vez del pubkey del fee-payer del facilitator.
- **Causa raíz**: al portar el patrón de `solana-wallet.ts:138` (`tx.feePayer =
  resolveSolanaFacilitatorPubkey()`) reusé una variable ya a mano (`authority`) por conveniencia de
  tipado, confundiendo dos pubkeys distintos (release-authority vs. fee-payer del sponsor).
- **Fix**: leer el fee-payer de una env dedicada `SMOKE_SOLANA_FACILITATOR_PUBKEY` (`requireEnv`), que
  se corresponde con `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`/`SOLANA_FEE_PAYER_PRIVATE_KEY` del
  facilitator. La keypair privada cofirma como feePayer en el sponsor server-side.
- **Aplicar en**: cualquier construcción de tx Solana gasless — el `feePayer` SIEMPRE es el pubkey del
  facilitator (fee-payer), NUNCA la release-authority ni el sender. Son 3 pubkeys de roles distintos.

### [2026-07-22] Wave 1 — `tsx` ausente en node_modules
- **Error**: `smoke:solana` (`tsx scripts/...`) no resolvía; `tsx` estaba declarado en el Story pero no
  instalado.
- **Causa raíz**: `tsx` es la única devDep nueva de la HU; el lockfile del repo no la tenía.
- **Fix**: agregar `"tsx": "^4.19.0"` a `devDependencies` + `npm install` (resolvió a v4.23.1 limpio).
  El typecheck de scripts NO depende de `tsx` (usa `tsc -p tsconfig.scripts.json`); `tsx` es solo runtime
  del smoke (que NO corre en F3).
- **Aplicar en**: al declarar una devDep nueva en un Story, verificar `node_modules/.bin/<tool>` antes de
  asumir que el script corre; instalar y confirmar la versión.

### [2026-07-22] Wave 1 — `npm run lint` roto en el repo (Next 16 removió `next lint`)
- **Error/Discovery**: el gate "lint sin errores" no es ejecutable — `npm run lint` (= `next lint`)
  falla con "Invalid project directory ... /lint" en Next 16.2.10 (el subcomando `next lint` fue
  removido y no hay `eslint` ni config instalados en el repo). La herramienta rtk-lint reporta
  "Errors: 1" incluso sobre archivos ya mergeados y limpios (p.ej. el `route.ts` pre-existente) → es
  ruido, no un hallazgo real.
- **Causa raíz**: condición pre-existente del repo (Next 16 sin migración a la CLI de ESLint).
- **Fix**: el check estático real y ejecutable es TypeScript — `tsc --noEmit` (completo, con `.next/types`)
  + `tsc -p tsconfig.scripts.json --noEmit` para `scripts/`. Ambos verdes. NO se introdujo ningún cambio
  para "arreglar lint" (fuera de scope).
- **Aplicar en**: en este repo, tratar `tsc`/`tsconfig.scripts.json` como el gate estático; no confiar
  en el conteo de `next lint`/rtk-lint. Si se quiere lint real, es una HU aparte (migrar a `eslint` CLI).
