# Validation Report — WKH-227 / HU-SOL-24 (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-23 · Repos: `wasiai-remittance-agents` (W1), `wasiai-facilitator` (W2), `chaski-v3` (W3).

## Runtime checks (ejecutados por QA, no re-leídos)
- `npx tsc --noEmit` clean en los 3 repos (exit 0, sin output) — re-ejecutado por QA.
- `npm test`: remit **166/166** (10 files), facilitator **1004/1004** (75 files), chaski **695/695** (63 files) — 0 rojos, re-ejecutado por QA (no solo leído de CR).
- `npm run build` (chaski, next): `✓ Compiled successfully in 6.9s` — confirmado por QA (no estaba en la lista de gates del CR report). Único warning es pre-existente (`ox/tempo` critical-dependency dinámico en `chain.ts`, no tocado por esta HU).
- **Experimento de drift en vivo #1 (AC-4)**: mutado `value` en `contracts/golden/eip3009-authorization.golden.json` (`400000000`→`400000001`) → `npx vitest run contracts/golden/golden-evm.test.ts` → **1 failed / 2 passed**, `AssertionError` mostrando el byte exacto que cambió. Restaurado byte-idéntico (`cp` desde backup) → re-run → **3/3 passed**. Confirma freeze real, no cosmético.
- Confirmado (sin re-derivar): AR ya corrió su propio experimento de mutación (`maxTimeoutSeconds` 60→999 en golden #3) con mismo resultado — dos experimentos independientes (AR + QA) sobre dos golden distintos, ambos rojo→restaurado.
- Hash IDL: `escrow-idl.hash.test.ts` (chaski `contracts/idl/`, 2/2 tests incl. AC-3 sibling NO skipeado porque `solana-programs/` existe en este workspace) + (facilitator `src/chains/`, 2/2) → ambos matchean `aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71` leído literal del código — re-verificado por QA.
- Scope: `git status --short` en los 3 repos → remit/facilitator solo carpetas nuevas (`src/contracts/`, `src/chains/canonical-hash.ts`, `src/chains/escrow-idl.hash.test.ts`); chaski solo `contracts/` nuevo + `tsconfig.json` (+1 línea `include`) + `tsconfig.tsbuildinfo` (build cache). Cero archivo de negocio existente modificado — confirma CD-1 por construcción (no por inspección).
- `contracts/` NO alcanzable desde `app/`/`src/` de chaski: `grep -rn "from ['\"].*contracts" app/ src/` → 0 matches fuera de la propia carpeta `contracts/` — confirma que no se bundlea en el build de producción.
- 0 `any` / 0 `console.*` en los 12 archivos nuevos de los 3 repos (grep directo).

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `chaski-v3/contracts/contracts.quote.test.ts:36-44,60-65` (drift `feeUsd→feeUsd2` → 502 / throw); `contracts.payout.test.ts:41-45` (drift status → throw); `contracts.settle.test.ts:96-112` (`toEqual` body completo real vs fixture vendoreado); `wasiai-facilitator/src/contracts/contracts.provider.test.ts:30-50` (`.strict()` rechaza extra/renombrado/versión) |
| AC-2 | PASS | `chaski-v3/contracts/idl/escrow-idl.hash.test.ts:13-15` + `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts:22-24` — ambos `canonicalSha256(escrowIdl) === "aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71"`, PASS en ambos repos (re-ejecutado por QA) |
| AC-3 | PASS | Mismos archivos, tests `AC-3: coincide con solana-programs (sibling)` — `existsSync(SIBLING) ? it : it.skip`; en este workspace el sibling existe → NO skipea, corre y pasa (2/2 en ambos repos) |
| AC-4 | PASS | `chaski-v3/contracts/golden/golden-evm.test.ts` (4 golden: EIP-712 typed-data, `eip3009.authorization`, body `/settle`, `issueDepositAttestation`) — experimento runtime de QA confirma rojo ante 1 dígito de drift (ver Runtime checks) |
| AC-5 | PASS | `chaski-v3/contracts/vendored/settle-eip3009.body.fixture.ts:23,34` (`amount`/`value: "400000000"` string) vs `contracts/vendored/corridor-fx.output.fixture.ts:12-14` (`rate`/`feeUsd`/`netDeliveredLocal` siguen `number`) |
| AC-6 | PASS | remit 160→166 (+6, `contracts.provider.test.ts`), facilitator y chaski: 0 archivo de test existente modificado (confirmado por `git status`) + 100% de la suite actual verde (1004/1004, 695/695) → previos verdes por construcción, no solo por conteo |
| AC-7 | PASS | Los 4 vendoreados llevan header — `chaski-v3/contracts/vendored/corridor-fx.output.fixture.ts:1-2`, `kyc-validator.output.fixture.ts:1-2`, `cashout-payout.output.fixture.ts:1-2`, `settle-eip3009.body.fixture.ts:1-2` — "COPIA PINNEADA, NO SE EDITA... Origen: <repo>/<path>. Sync: 2026-07-22" |

## Drift
- Único punto notable: `chaski-v3/doc/sdd/031-wkh-233-kyc-via-agente/` y su entrada en `_INDEX.md` aparecen en el working tree pero son de OTRA HU (WKH-233, F1, sin relación con WKH-227) — no es drift de esta HU, es un artefacto de sesión previa no commiteado; no lo toca el Dev de WKH-227.
- Resto: cero drift. Relocación `contracts/` → `src/contracts/` en remit/facilitator (vs SDD §4.1) está justificada y documentada en `auto-blindaje.md` (evita tocar `vitest.config.ts`, que ya restringe `include: src/**`).

## Gates
- `tsc --noEmit` / `npm test` (3 repos): confirmado por CR **y re-ejecutado independientemente por QA** con los mismos números exactos (166/1004/695).
- `next build` (chaski): confirmado por QA (gate no cubierto explícitamente por los números del CR report) — verde.
- Lint: confirmado leído de `auto-blindaje.md` (fix aplicado en W2 con `eslint-disable` justificado, convención existente del repo) — no re-ejecutado (ya resuelto y documentado).

## AR/CR follow-up
- MNR-1 (AR) / MNR-1 (CR) — mismo hallazgo (nonce placeholder divergente en `wasiai-facilitator/src/contracts/settle-eip3009.body.fixture.ts:25-26`): fix-packeado con comentario inline aclaratorio, verificado presente en el archivo leído por QA (línea 26: "PLACEHOLDER... NO copiar verbatim al vendorear"). 0 BLOQUEANTE de ambos reviewers.

**Listo para DONE.**
