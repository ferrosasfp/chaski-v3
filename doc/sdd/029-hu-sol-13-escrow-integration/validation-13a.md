# Validation Report — WKH-216 / HU-SOL-13 Wave 13a (chaski-v3, escrow integration)

**Veredicto**: APROBADO PARA DONE (con 2 hallazgos documentados, no bloqueantes)
**Fecha**: 2026-07-22
**Branch**: `feat/029a-hu-sol-13a-escrow-chaski` @ `e9f494a`
**Repo**: `/home/ferdev/.openclaw/workspace/chaski-v3`

---

## 1. Runtime checks

- **`npm run qa`** (tsc --noEmit COMPLETO + vitest run) → **EXIT 0**. 57 test files, **676/676 tests PASS**. Coincide con el número reportado por CR (676 post fix-pack).
- **DB / migraciones**: N/A para esta wave (13a no toca schema; el dedup del release es 13c/facilitator, founder-gated, PENDING-DEPLOY).
- **Env parity**: `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` no está seteada en ningún `.env*` del repo (`grep` sin matches) → default `undefined !== "true"` → **flag OFF por default**, confirmado en dos guard-points independientes: `src/composition/container.ts:102` y `app/api/settle/solana-sponsor/route.ts:22`.
- **Browser-safety**: `grep -rn "node:crypto"` sobre el diff → único match es un comentario (`solana-wallet.ts:159`, "NUNCA node:crypto"), cero uso real. `refundEscrow` usa `@solana/web3.js`, `@coral-xyz/anchor`, `@solana/spl-token`, lazy-imports — mismo patrón browser-safe que `authorizePrincipal` (CD-15 respetado).

## 2. Cierre de BLQ-MED-1 (AR/CR) — verificado

- `src/presentation/flow-vm.ts:34-42` — `isFallbackWalletAddress` ahora envuelve `canonicalizeAddress(...)` en `try/catch` → `catch { return false; }`. Antes del fix, `canonicalizeAddress(FALLBACK_WALLET_ADDRESS /* "0xDEMO…" EVM */, "solana")` throweaba (`new PublicKey` sobre un string no-base58) **durante el render**, crasheando `RemittanceFlow` completo bajo `vm=solana`.
- **T8** (`src/presentation/flow.test.tsx:856-876`, `describe("HU-SOL-13 — BLQ-MED-1…")`) renderiza `<RemittanceFlow container={buildTestContainer({ wallet: new FakeSolanaWallet() })} />` con `NEXT_PUBLIC_VM=solana`, navega `send → connect → review` y asserta `screen.getByText(/Revisá el envío/)` — si el render crasheara, ese texto nunca aparecería. También asserta que el banner "Sin aislamiento por wallet" está ausente (fail-safe correcto: el FALLBACK EVM no matchea bajo canonicalización Solana). **Test corrió y pasó** (parte de los 676, confirmado en `npm run qa`).
- Rama EVM del mismo fix: el `try/catch` es un no-op sobre `canonicalizeAddress(address, "evm")` (`toLowerCase`, nunca throwea) → byte-idéntico. `src/presentation/flow-vm.test.ts` (18 tests) y `src/infrastructure/address.test.ts` (15 tests) **sin diff** contra `main` (`git diff main...HEAD --stat` vacío para ambos archivos) → 0 assertion EVM cambiada.

**Conclusión BLQ-MED-1: CERRADO, con evidencia archivo:línea + test que renderiza el money-path Solana e2e sin crash.**

## 3. AC → PASS/FAIL (archivo:línea)

| AC | Texto (resumen) | Status | Evidencia |
|----|------------------|--------|-----------|
| AC-1 | deposit cableado: beneficiary/authority server-side → `authorizePrincipal(escrow)` | **PASS*** | `src/application/use-cases/confirm-and-send.ts:137-176` (rama `if (this.solana)`) + `confirm-and-send.solana.test.ts:74-105` (T1): `wallet.authorizeCalls[0].deposit?.escrow` == `{beneficiary: FAKE_SOLANA_BENEFICIARY, authority: FAKE_SOLANA_AUTHORITY}`, ambos vienen de `prepare.calls` (server-side gateway), nunca del body. Ver **Hallazgo H1** — el mock de `prepare` es fiel al contrato, pero la ruta real `/api/payout/prepare` NO fue extendida en esta wave. |
| AC-6 | refund trustless post-deadline, sender-signed | **PASS** | `src/infrastructure/solana-wallet.ts:156-227` (`refundEscrow`): `tx.feePayer = senderPk`, firma sólo `solanaWalletBridge.signTransaction`, broadcast `connection.sendRawTransaction`. Guard `statusKey !== "Deposited" → throw`; `nowSec < deadlineSec → throw`. Test: `src/infrastructure/solana-wallet.refund.test.ts:88` (happy, Deposited+now≥deadline arma+firma+broadcastea) + UI: `src/presentation/flow.test.tsx:813-825` (T7, AC-6: botón visible + dispara gateway). |
| AC-7 | refund bloqueado/oculto pre-deadline (UI) | **PASS** | `src/presentation/flow.tsx:816-820` (`showRefund = isSolana && refundeable && ... && deadlineReached && ...`) — oculta si `!deadlineReached`. Test: `flow.test.tsx:827-835` (T7, AC-7: `queryByRole("button",{name:/Recuperar fondos/})` es `null` con `expiresAt` futuro) + `solana-wallet.refund.test.ts:132` (guard on-chain autoritativo: `now<deadline` → `refund_before_deadline`, sin firmar/broadcastear). |
| AC-2/AC-3/AC-4/AC-5 | verify vault / release autorizado / rechazo / no-replay | **N/A esta wave** | Corresponden a 13b/13c (`wasiai-facilitator`), fuera del scope de este validation (13a, `chaski-v3`). No evaluados acá. |

`*` AC-1: PASS del **mecanismo** (invocación correcta, server-side, testeada) según el contrato acordado en el Story File (SPEC_APPROVED); ver Hallazgo H1 para el gap de wiring real end-to-end (documentado, no bloqueante, founder-gated).

## 4. Hallazgos (no bloqueantes — documentados para seguimiento)

### H1 — `/api/payout/prepare/route.ts` NO devuelve `{beneficiary, authority}` para Solana (gap real, ya anticipado por NC-1/NC-2)
- `HttpSolanaPayoutPrepareGateway` (`src/infrastructure/settlement/http-solana-prepare-gateway.ts:78`) llama a la ruta EXISTENTE `/api/payout/prepare`, que **no fue modificada en esta wave** (`git diff main...HEAD --stat -- app/api/payout/prepare/route.ts` → sin cambios).
- Esa ruta responde `{depositAddress, attestation, payoutId, provenance}` (`app/api/payout/prepare/route.ts:294`) — **no** `{beneficiary, authority}`. `isValidSolanaPrepareShape` (client) exige ambos campos → con la ruta real, **siempre** devolvería `prepare_bad_shape` (fail-closed, no crashea, no compromete fondos).
- `resolveSolanaReleaseAuthorityPubkey()` (HU-SOL-9, `src/infrastructure/chain.ts:178`) — grep sobre `src/` y `app/` (excluyendo tests) muestra que **NO se invoca en ningún código de producción**, solo aparece en comentarios/docstrings y en su propia definición. La resolución server-side de `authority` sigue sin wire real.
- **Impacto**: con el flag `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED=true` hoy, el prepare Solana real fallaría siempre (fail-closed, seguro) — el money-path Solana **no es funcional end-to-end** todavía, solo el mecanismo/contrato está probado con mocks.
- **Por qué NO es BLOQUEANTE**: el Story File (SPEC_APPROVED) documenta esto explícitamente como `[NC-1]`/`[NC-2]` (Uncertainty Markers, no-bloqueantes de F3, founder-gated — "stub el prepare Solana… hasta que el agente remit-cashout-payout exponga el destino Solana"). La tabla "Files to Modify/Create (13a)" del Story File **no** incluye modificar `/api/payout/prepare/route.ts` — el Architect deliberadamente dejó esa pieza fuera de 13a. Flag OFF por default (CD-5) → cero riesgo en el estado actual.
- **Recomendación**: abrir follow-up (HU-SOL-13d o parte de HU-SOL-14/agente remit-cashout-payout) para extender `/api/payout/prepare` con rama VM-discriminada que devuelva `{beneficiary, authority}` reales antes de flipear el flag.

### H2 — Guards fail-loud nuevos en `container.ts` sin test dedicado
- `src/composition/container.ts:103-110` agrega dos throws nuevos: `solana_vm_excludes_eip3009` (mutua exclusión VM Solana + flag EIP-3009 ON) y `solana_settle_requires_solana_vm` (flag Solana ON sin VM Solana), más `resolveSolanaUsdcMint()`/`resolveSolanaFacilitatorPubkey()` fail-loud.
- El repo tiene un patrón establecido de testear cada guard fail-loud del container (`src/composition/container.test.ts:22-126`, 8 tests dedicados al guard EIP-3009). Los 2 guards nuevos de Solana **no tienen test equivalente** — `container.test.ts` no tiene diff contra `main` (0 cambios, sigue en 13 tests).
- **Por qué NO es BLOQUEANTE**: el Story File's Test Expectations (T1-T8) no exige explícitamente un test de este guard; el código es defensivo/simple (2 comparaciones booleanas) y el flag por default está OFF, así que el guard nunca se ejecuta hoy en producción.
- **Recomendación**: agregar 2-3 tests en `container.test.ts` (mutua exclusión + fail-loud sin mint/facilitator configurados) en el próximo touch de ese archivo — MENOR, no bloquea DONE.

## 5. Drift Detection

- **Scope**: `git diff main...HEAD --stat` — 21 archivos, todos dentro de la tabla "Files to Modify/Create (13a)" del Story File (`ports.ts`, `http-solana-settlement-gateway.ts` [+test], `http-solana-prepare-gateway.ts`, `app/api/settle/solana-sponsor/route.ts` [+test], `solana-wallet.ts` [+test], `solana-escrow-refund-gateway.ts`, `confirm-and-send.ts` [+test], `container.ts`, `flow.tsx` [+test]) + `fakes.ts`/`test-container.ts` (test-support, esperado) + docs (`sdd.md`, `story-HU-SOL-13.md`, `work-item.md`, `auto-blindaje.md`).
- **Única expansión de scope**: `src/presentation/flow-vm.ts` (15 líneas, el fix de BLQ-MED-1). Está **explícitamente autorizado** por el orquestador según el brief de esta tarea y documentado en `auto-blindaje.md` ("`flow-vm.ts` entró de Scope-OUT por decisión del orquestador SOLO para este fix") — no se marca como drift.
- **Wave order**: commits respetan W0→W1→W2→W3 según el Story File (contratos → gateways/refund → confirm-and-send/container/flow → fix-pack AR/CR). Un solo commit squash (`e9f494a`) pero el contenido es consistente con las waves descritas.
- **Test drift**: T1-T8 (13a) todos presentes con nombres/archivo esperados por el Story File; T8 (fuera de la tabla original T1-T7, agregado en el fix-pack AR/CR) documentado y justificado.

**Drift: 1 expansión de scope autorizada (flow-vm.ts) + 2 hallazgos de gap documentado (H1/H2). Sin drift no autorizado.**

## 6. EVM byte-idéntico

- `confirm-and-send.ts`: diff = **+79/-0** (solo inserciones, 0 deleciones) — el bloque `if (this.settlement)` no fue tocado.
- `ports.ts`: diff = **+61/-0** — todos los tipos nuevos son aditivos, cero tipo EVM modificado.
- `container.ts`: diff = **+40/-4**; las 4 líneas "eliminadas" son un refactor equivalente (`const wallet = resolveActiveVm()... ? new SolanaWalletAdapter() : pickWallet()` → extraído a `solanaWallet` + `wallet = solanaWallet ?? pickWallet()`), misma semántica, sin cambio de comportamiento EVM.
- `flow.tsx`: diff = **+85/-3**; las 3 líneas "eliminadas" son el call-site de `<TrackView rem={rem}/>` (ahora con 2 props opcionales nuevas, ambas `undefined` en EVM) y la firma de la función `TrackView` (ahora exportada con params opcionales) — sin cambio funcional EVM.
- `flow-vm.ts`: fix BLQ-MED-1, try/catch no-op en EVM (`canonicalizeAddress` con `toLowerCase`, nunca throwea).
- **Suites EVM sin diff contra `main`** (confirmadas por `git diff main...HEAD --stat`, vacío): `src/presentation/flow-vm.test.ts` (18 tests), `src/infrastructure/address.test.ts` (15 tests), `src/composition/container.test.ts` (13 tests), `src/application/use-cases/confirm-and-send.demo.test.ts` (1 test). Todos **PASS** en `npm run qa` (evidencia §1) → **0 assertion EVM cambiada**.

**CD-2 confirmado: EVM path byte-idéntico por construcción y por evidencia de test.**

## 7. Gates (confirmado — no re-ejecutado más allá del gate combinado de QA)

- F3 (Dev): 666 tests, tsc 0 → confirmado consistente con el estado pre-fix-pack.
- AR: BLQ-MED-1 → fix-pack aplicado y **verificado independientemente** por esta QA (§2).
- CR: APROBADO, 0 BLQ, 1 MNR (route sin test) → resuelto en fix-pack (9 tests en `app/api/settle/solana-sponsor/route.test.ts`, confirmado presente y corriendo).
- QA propio: `npm run qa` → **676/676 PASS, tsc 0, exit 0** (re-ejecutado íntegramente porque es el gate final de esta wave, no una repetición de un gate ya confirmado por CR sino la corrida de cierre F4).

## Veredicto final

**APROBADO PARA DONE.** Los 3 ACs de esta wave (AC-1, AC-6, AC-7) están implementados y testeados según el contrato del Story File; el BLQ-MED-1 de AR/CR está cerrado con evidencia de regresión (T8); el path EVM es byte-idéntico. Los 2 hallazgos (H1: prepare real sin wire de beneficiary/authority; H2: guards de container sin test dedicado) son **no bloqueantes** — ambos están cubiertos por decisiones explícitas del Story File (NC-1/NC-2 founder-gated) o son de bajo riesgo con el flag OFF por default. Se recomienda trackear H1 como follow-up antes de flipear `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED`, y H2 como TD menor.

AC-2/AC-3/AC-4/AC-5 (13b/13c, `wasiai-facilitator`) quedan fuera del alcance de esta validación — requieren su propio F4 sobre el repo companion.

*Validation Report generado por NexusAgil F4 — QA — HU-SOL-13 Wave 13a / WKH-216*
