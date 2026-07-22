# Validation Report — HU WKH-211 / HU-SOL-8 — PoP ed25519 VM-aware (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-22
**Commit**: `eb9a406` (branch `feat/027-hu-sol-8-pop-ed25519`)

## Runtime checks
- `npm run qa` (typecheck + test): tsc exit 0; **52 test files / 621 tests passed** (0 failed) — coincide con lo esperado (594 base + 27 nuevos). Confirmado por mí (no solo leído de CR).
  - Nuevos: `src/infrastructure/auth/pop-verify-solana.test.ts` (7), `src/infrastructure/auth/pop-challenge.test.ts` (agrega casos Solana), `app/api/a2a/payout/submit/route.test.ts` (+175 líneas, AC-1..AC-8), `app/api/payout/prepare/route.test.ts` (+24), `app/api/a2a/payout/challenge/route.test.ts` (+53), `src/infrastructure/solana-wallet.test.ts` (describe `signMessage (HU-SOL-8)`, 3 tests).
- Deps: `bs58@6.0.0` + `tweetnacl@1.0.3` pinned en `package.json` (git diff, +2/-0), `package-lock.json` resuelto sin `--legacy-peer-deps` (install ya corrido, lockfile consistente) — CD-7 OK.

## ACs
| AC | Status | Evidencia archivo:línea |
|----|--------|-----------------|
| AC-1 (verify ed25519, decode 32 bytes) | PASS | `src/infrastructure/auth/pop-verify-solana.ts:15-17,41` (`pubkeyBytes` vía `new PublicKey().toBytes()` + `nacl.sign.detached.verify(msg,sig,pub)`); test `pop-verify-solana.test.ts:35` "firma ed25519 legítima ⇒ true" |
| AC-2 (firma forjada/inválida → 403 opaco) | PASS | `app/api/a2a/payout/submit/route.ts:172-181` (P5, mismo `payout_pop_unverified`); test `submit/route.test.ts:1040` "AC-2/suplantación: firma de OTRA key ⇒ 403" |
| AC-3 (PoP obligatorio en Solana, 503 fail-closed) | PASS | `submit/route.ts:139-143` (`if (vm==="solana") if(!POP_SECRET) → 503`); `prepare/route.ts` mismo patrón (líneas ~122-126 del diff); test `submit/route.test.ts:1011` "vm=solana + PAYOUT_POP_SECRET unset ⇒ 503 payout_pop_unavailable, agente NUNCA" |
| AC-4 (binding CAIP-2 cross-cluster) | PASS | `submit/route.ts:168-171` (P4: `ch.networkId !== resolveSolanaNetworkId()`, resuelto server-side en `src/infrastructure/chain.ts:136-144`, nunca del body); test `submit/route.test.ts:1060` "token networkId='solana:mainnet' + server devnet ⇒ 403 (CD-3)" |
| AC-5 (decode ≠32/64 bytes → reject sin invocar nacl.verify) | PASS | `pop-verify-solana.ts:24-38` (try/catch en `pubkeyBytes` + guard `sig.length!==64` ANTES de `nacl.sign.detached.verify`); tests `pop-verify-solana.test.ts:73` "pubkey 31/33 bytes ⇒ false SIN invocar nacl.verify" y `:98` "firma ≠64 bytes ⇒ false SIN invocar nacl.verify" (spy sobre `nacl.sign.detached.verify` confirma 0 llamadas) |
| AC-6 (`buildPopMessage` SSOT, extensión aditiva) | PASS | `src/infrastructure/auth/pop-challenge.ts:53-55` (EVM `buildPopMessage` sin tocar, 0 líneas modificadas) + `:119-121` (`buildSolanaPopMessage` nueva, hermana aditiva); cliente firma verbatim vía `http-pop-signer.ts` sin cambios (`git diff` vacío para ese archivo) + `solana-wallet.ts:157-161` (`signMessage(message)` recibe el string y lo codifica, no reconstruye) |
| AC-7 (nonce single-use vía `claimPopNonceOnce`, fail-closed) | PASS | `submit/route.ts:184-190` (reusa `claimPopNonceOnce` importado sin cambios de `pop-nonce-store.ts` — `git diff` vacío para ese archivo); tests `submit/route.test.ts:1090` "AC-7/replay: 2ª presentación ⇒ 409" y `:1105` "AC-7/fail-closed: nonce-store caído ⇒ 503" |
| AC-8 (EVM byte-idéntico) | PASS | Ver sección "EVM byte-idéntico" abajo + `app/api/a2a/payout/guard8-intact.test.ts` (regresión pre-existente, verde) + suite EVM completa de `submit/route.test.ts`/`prepare/route.test.ts` sin modificar sus asserts (solo líneas nuevas agregadas) |

## Verificaciones de seguridad
- **Decode estricto (CD-4/CD-SDD-3)**: `pop-verify-solana.ts:24-38` — guardas de longitud (`pub.length!==32`, `sig.length!==64`) y try/catch ANTES de `nacl.sign.detached.verify`; confirmado con tests que spy-ean 0 invocaciones de `nacl.verify` en los casos malformados.
- **CAIP-2**: `networkId` viaja en el mensaje firmado (`pop-challenge.ts:120`) y se valida server-side contra `resolveSolanaNetworkId()` (`chain.ts:136-144`, deriva de `SOLANA_DEVNET` config — NUNCA lee del body). Test cross-cluster (`submit/route.test.ts:1060`) confirma rechazo.
- **PoP obligatorio fail-closed**: `submit/route.ts:141-143` / `prepare/route.ts` (mismo patrón) — sin `PAYOUT_POP_SECRET` en VM solana → 503, nunca skip. Test `submit/route.test.ts:1011`.
- **Browser-safety**: `grep -n "node:crypto\|Buffer" src/infrastructure/auth/pop-verify-solana.ts src/infrastructure/solana-wallet.ts` → 0 ocurrencias reales en `pop-verify-solana.ts` (solo comentarios "NUNCA Buffer"); en `solana-wallet.ts` el único `Buffer` real (línea 100) es de `authorizePrincipal`/`signTransaction`, pre-existente de HU-SOL-5, fuera de scope de esta HU. El `signMessage` nuevo (líneas 157-161) usa exclusivamente `TextEncoder`+`bs58`. Confirmado también por test `solana-wallet.test.ts:249-264` ("los bytes firmados son TextEncoder(message), NO Buffer").

## EVM byte-idéntico (AC-8/CD-1)
- `git diff main...HEAD --numstat`: `submit/route.ts` +68/-3, `prepare/route.ts` +61/-3, `challenge/route.ts` +29/-2 — los `-` son SOLO reformateo de imports (1 línea → multilínea) y el split `if (POP_SECRET)` → `if (vm==="solana") {...} else if (POP_SECRET) {...}`; el cuerpo de la rama EVM entre esas líneas es idéntico byte-a-byte al pre-HU (confirmado leyendo `submit/route.ts:191-242`, mismos comentarios/enums P1-P6 de WKH-206).
- Diffs de `*.test.ts` de esta HU: 100% aditivos (0 líneas `-` en `submit/route.test.ts`, `prepare/route.test.ts`, `challenge/route.test.ts` — `git diff --numstat` confirma `+N/-0` en los tres).
- `app/api/a2a/payout/guard8-intact.test.ts` (pre-existente, no tocado por esta HU) sigue verde.

## Drift
- Scope: `git show --stat eb9a406` — único commit, archivos tocados = exactamente el Scope IN del work-item (`pop-challenge.ts`, `pop-verify-solana.ts` nuevo, `submit/route.ts`, `prepare/route.ts`, `challenge/route.ts`, `solana-wallet.ts`, `solana-wallet-bridge.ts`, `solana-providers.tsx`, deps, tests, docs). `http-pop-signer.ts` y `pop-nonce-store.ts` NO se tocaron (decisión correcta: ya eran VM-agnósticos vía el `WalletPort`/reuso directo).
- `doc/sdd/028-*` y `doc/sdd/029-*` (untracked en el working tree) NO forman parte del commit `eb9a406` — confirmado por `git show --stat`. No hay cross-contamination con otras HUs.
- Path EVM: sin cambios de comportamiento (ver arriba). Wave order: single commit, sin violaciones de orden observables.

## Gates (confirmados por el orquestador + verificación propia)
- typecheck: exit 0 (confirmado por mí)
- tests: 621/621 (confirmado por mí, no solo leído)
- AR: APROBADO — 8 vectores, 0 findings (reportado por orquestador)
- CR: APROBADO — 0 BLQ / 0 MENOR (reportado por orquestador)

**Listo para DONE.**
