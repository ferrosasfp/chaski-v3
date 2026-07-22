# Validation Report — HU-SOL-5 / WKH-207* (F4)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-22
**Branch**: `feat/025-hu-sol-5-wallet-deposit-escrow` @ `79ff56b`

## Runtime checks (evidencia propia, no re-ejecuto lo que CR ya confirmó)

- `npm run qa` (vitest run, ejecutado por mí): **51 test files, 594/594 tests PASS**, 0 failures.
  Duration 4.02s. Los `[ledger] recordPrincipalIn_failed / recordOrderPrepared_failed / recordPayoutOutcome_failed
  Error: db down` en stderr son best-effort esperados (DT preexistente WKH-168/211/206), no relacionados con esta HU.
- `npx tsc --noEmit` (completo, incluye tests — lección WKH-196): **exit 0**, "TypeScript compilation completed".
- Fix BLQ-MED-1 (CR) verificado directamente:
  - `grep -rn "node:crypto"` sobre `src/infrastructure/solana-wallet.ts`, `solana-wallet-bridge.ts`,
    `chain.ts`, `solana/escrow-idl.ts` → **0 matches**.
  - `src/infrastructure/solana-wallet.ts:8` — `import { sha256 } from "@noble/hashes/sha256"` (import
    ESTÁTICO, browser-safe, hoisted como dep transitiva real de `@solana/web3.js` y `@coral-xyz/anchor`
    — ambos deps directos ya usados en el mismo archivo — no es un hoist frágil de npm).
  - `src/infrastructure/solana-wallet.ts:60-62` — `remittanceIdToBytes16`: `sha256(utf8(remittanceId)).subarray(0,16)`
    → `Uint8Array` de 16 bytes. Output byte-idéntico a `node:crypto` confirmado por el orquestador
    (fix-pack), consistente con `doc/sdd/025-.../auto-blindaje.md` L34-36.
- Money-path safety (grep + lectura directa):
  - `src/infrastructure/solana-wallet.ts:137` — `tx.feePayer = new PublicKey(resolveSolanaFacilitatorPubkey())`,
    resuelto de `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` (`src/infrastructure/chain.ts:146-155`, env-driven,
    fail-loud, valida con `PublicKey` real — NO caller-controlled).
  - `src/infrastructure/solana-wallet.ts:136` — una sola `Transaction().add(ix)` (una sola instrucción).
  - `src/infrastructure/solana-wallet.ts:140` — `solanaWalletBridge.signTransaction(tx)`: partial-sign
    SÓLO wallet (test `solana-wallet.test.ts:171` confirma `signSpy` llamado 1×, feePayer ≠ sender).
  - `src/infrastructure/solana-wallet.ts:131` — `remainingAccounts([{ pubkey: reference, isSigner:false, isWritable:false }])`.
  - `grep -rn "sendTransaction\|sendRawTransaction" src/infrastructure/solana-wallet.ts` → único match es
    el comentario L144 ("NUNCA... acá"); cero invocaciones reales. Test `solana-wallet.test.ts:182-183`
    asserta `Connection.prototype.sendRawTransaction`/`sendTransaction` NOT called.
- EVM byte-idéntico: `git diff main...HEAD --name-only` — `src/infrastructure/wallet.ts` y
  `src/composition/container.ts` **NO aparecen en el diff** (0 bytes tocados). El wiring de dispatch
  `resolveActiveVm() === "solana" ? new SolanaWalletAdapter() : pickWallet()` en `container.ts:83-84`
  YA existía desde HU-SOL-4/WKH-212 (`2dd1758`, merged a `main` antes de esta HU) — esta HU solo
  EXTIENDE `solana-wallet.ts` (que HU-SOL-4 ya había creado con `connect()/getAddress()/signMessage()`)
  agregando `authorizePrincipal`. `src/application/ports.ts` widening es 100% aditivo (`escrow?`
  opcional en el parámetro, `solana?` opcional en el retorno) — confirmado por diff (+17/-1, sin
  remover ningún campo existente).

## ACs

| AC | Status | Evidencia archivo:línea |
|----|--------|--------------------------|
| AC-1 (arma ix deposit con args/accounts del IDL) | PASS | `src/infrastructure/solana-wallet.ts:125-132` (build vía `program.methods.deposit`); test `src/infrastructure/solana-wallet.test.ts:140-165` (programId, discriminator, 9 accounts = 8 IDL + reference, PDA/ATA recalculados y comparados) |
| AC-2 (feePayer=facilitator, firma SOLO wallet) | PASS | `src/infrastructure/solana-wallet.ts:137,140`; test `solana-wallet.test.ts:167-176` (`signSpy` 1×, `tx.feePayer.toBase58() === FACILITATOR_B58`, `!== SENDER_B58`) |
| AC-3 (nunca broadcast, entrega serializada al facilitator) | PASS | `src/infrastructure/solana-wallet.ts:141-144` (`serialize({requireAllSignatures:false, verifySignatures:false})`, comentario explícito de no-broadcast); test `solana-wallet.test.ts:178-191` (spies `sendRawTransaction`/`sendTransaction` NOT called, `res.solana.partialSignedTx` regex base64, deserializa a la misma ix) |
| AC-4 (reference como remainingAccount no-signer/no-writable) | PASS | `src/infrastructure/solana-wallet.ts:106-107,131`; test `solana-wallet.test.ts:193-203` (último account = reference, `isSigner:false`, `isWritable:false`) |
| AC-5 (EVM byte-idéntico) | PASS | `git diff main...HEAD --name-only` — `wallet.ts`/`container.ts` no modificados; `src/infrastructure/wallet.test.ts` (24 tests), `src/composition/container.test.ts` (13 tests), `src/presentation/flow.test.tsx` (24 tests) — los 3 exemplars EVM, todos verdes sin cambio de expectativa (parte de los 594) |
| AC-6 (dispatch por VM hacia SolanaWallet) | PASS | `src/composition/container.ts:83-84` (`resolveActiveVm() === "solana" ? new SolanaWalletAdapter() : pickWallet()`, wiring preexistente de HU-SOL-4, `2dd1758`, sin diff en esta HU); test `src/composition/container.test.ts:118` (`"VM=solana → cablea el SolanaWalletAdapter (no pickWallet)"`) |
| AC-7 (sin wallet conectada → fail-loud sin firmar) | PASS | `src/infrastructure/solana-wallet.ts:72-73` (`if (!sender) throw new Error("wallet_not_connected")`, ANTES de cualquier construcción); test `solana-wallet.test.ts:205-211` (`signSpy` NOT called) |
| AC-8 (amount/deadline canónicos, sin floats) | PASS | `src/infrastructure/solana-wallet.ts:93,95` (`new anchor.BN(String(quote.send.minor))`, `new anchor.BN(String(Math.floor(Date.parse(quote.expiresAt)/1000)))`); test `solana-wallet.test.ts:221-232` (lee bytes borsh del data, compara `BigInt`) + `solana-wallet.test.ts:234-239` (`expiresAt` inválido → throw `quote_expires_at_invalid`, guard en `solana-wallet.ts:94`) |

Todos los ACs con evidencia archivo:línea directa (código) + test correspondiente ejecutado en el `npm run qa` que corrí (594/594 PASS).

## Drift

- Scope IN vs `git diff main...HEAD --name-only`: `.env.example`, `package.json`/`package-lock.json`
  (dep `@coral-xyz/anchor@0.30.1`, coincide con Story File L477 "NO agregar deps fuera de
  `@coral-xyz/anchor@0.30.1`"), `src/application/ports.ts`, `src/infrastructure/chain.ts`,
  `src/infrastructure/solana-wallet(-bridge).ts`, `src/infrastructure/solana/escrow-idl.ts` (IDL
  copiado, no el programa), `src/infrastructure/solana-wallet.test.ts`, docs SDD. **Todo dentro de
  Scope IN**. `solana-programs/` (repo externo) **NO tocado** — confirma CD-5.
- Wave order: commit único `79ff56b` (squash de W0-W3, consistente con el patrón de HUs previas de
  este repo, p.ej. WKH-196/WKH-213) — sin violación de orden observable.
- Spec drift (spot-check 3 funciones): `authorizePrincipal` (armado ix + feePayer + partial-sign +
  serialize, `solana-wallet.ts:66-150`) matchea DT-1/DT-2/DT-3/DT-4 del work-item; `resolveSolanaFacilitatorPubkey`
  (`chain.ts:146-155`) matchea CD-6 (env-driven, sin hardcode); `remittanceIdToBytes16`
  (`solana-wallet.ts:60-62`) matchea DT-SDD-5 (determinístico, sha256, reproducible server-side para
  HU-SOL-13). Sin drift.
- Test drift: los 6 grupos de Test Expectations de `story-HU-SOL-5.md:450-457` (AC-1, AC-2, AC-3,
  AC-4, AC-7/CD-SDD-8, AC-8) tienen su test 1:1 en `solana-wallet.test.ts`. AC-5 (regresión EVM)
  cubierta por `wallet.test.ts`+`container.test.ts` sin diff.

## Gates (confirmados por brief del orquestador + verificación propia)

- tests: 594/594 PASS (**re-verificado por mí**, no solo leído del CR report — ver Runtime checks).
- tsc --noEmit: exit 0 (**re-verificado por mí**).
- lint/build: confirmados verdes por CR según brief del orquestador (fix-pack BLQ-MED-1 aplicado y
  verificado); no re-ejecutados (regla F4 — CR ya cubrió esto).
- Mutation self-check (4 mutantes muertos, F3): confirmado por brief del orquestador, no re-ejecutable
  sin herramienta de mutation testing instalada en el repo — tomado como reportado.

## Hallazgos MENORES (no bloqueantes, no impactan el veredicto)

1. `.env.example` documenta `NEXT_PUBLIC_SOLANA_RPC_URL` (L71-75, agregado por esta HU) pero **NO**
   agrega `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` (usado en `chain.ts:148`, fail-loud si falta). Un
   operador que solo lea `.env.example` no descubre esta var nueva. Sugerido follow-up cosmético para
   la próxima HU que toque `chain.ts` o `.env.example` — no bloquea DONE (la var SÍ es fail-loud en
   runtime si falta, no hay riesgo de silent-fail).
2. `@noble/hashes` no es dependencia directa declarada en `package.json` (se resuelve transitivamente
   vía `@solana/web3.js`/`@coral-xyz/anchor`, ambos deps directos que YA se importan en el mismo
   archivo) — riesgo bajo, documentado explícitamente en `auto-blindaje.md` L34 como decisión
   consciente del fix-pack. No bloqueante.

## Follow-up conocido (documentado, no es AC fallido)

- `solana-wallet.test.ts` corre bajo `@vitest-environment node` (no `jsdom`): correrlo bajo jsdom
  rompe `PublicKey.findProgramAddressSync` por incompatibilidad cross-realm `Buffer`/`Uint8Array`
  entre `@noble/hashes` y el realm jsdom (reproducido y documentado en
  `doc/sdd/025-hu-sol-5-wallet-deposit-escrow/auto-blindaje.md`, sección "Wave 3 — jsdom NO viable").
  Diferido a la HU de test-infra/e2e por decisión del orquestador (fuera de Scope IN de esta HU:
  Solana + chain.ts + .env.example + ports.ts + package.json). `flow.test.tsx` (jsdom) sí ejercita el
  módulo del adapter (sin llegar al PDA), cubriendo la integración con el árbol React.

## AR/CR follow-up

- AR: APROBADO, 0 BLQ (10 vectores money-path atacados según brief del orquestador).
- CR: 1 BLOQUEANTE (BLQ-MED-1, `node:crypto` en bundle browser) — **fix aplicado y re-verificado por
  mí** (ver Runtime checks: 0 matches `node:crypto`, import estático `@noble/hashes/sha256`, output
  16 bytes). 3 MENORes de CR (AR-MNR-1 dead-code PDAs, AR-MNR-2 RPC hardcodeado, CR-MNR-1 asimetría
  String/BN) resueltos — confirmados en `auto-blindaje.md` sección "Fix-pack AR+CR".

**Listo para DONE.**
