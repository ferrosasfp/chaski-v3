# Validation Report — WKH-208 / HU-SOL-9 (chaski-v3)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-22
**Branch/commit**: `feat/028-hu-sol-9-binding-wire-facilitator` @ `a177825`

## Runtime checks (evidencia propia, no re-ejecución de gates ya confirmados en texto salvo lo indicado)

- `npm run qa` (typecheck + test) ejecutado por mí: **53 test files, 648 tests, 648 passed, 0 failed**.
  `Test Files 53 passed (53) / Tests 648 passed (648)` — coincide con lo declarado por CR (642 base + fix-pack → 648).
- `npx tsc --noEmit` (completo, incluye `.next/types` y tests, CD-12 auto-blindaje): `TypeScript compilation completed`, exit 0.
- Los 4 `stderr` de `[ledger] recordX_failed`/`nonce_mismatch` en la corrida son logs ESPERADOS de tests que simulan `db down` / nonce-mismatch best-effort (WKH-207 CD-17) — no son fallos.
- Ningún archivo de `wasiai-facilitator` presente/tocado en este workspace (CD-4 confirmado: `find . -iname "wasiai-facilitator*"` → vacío).
- `verifySolanaSettlement` (facilitator-client.ts:185) NO está wireada a ningún route.ts (`grep -rn "verifySolanaSettlement" app/ src/` sólo matchea el propio módulo + su test) — confirma CD-6 (dark/aditivo) y que no hay ningún callsite real que pueda leakear un base58 no-validado a un `fetch`.

## ACs (work-item.md, 6 ACs EARS)

| AC | Status | Evidencia archivo:línea |
|----|--------|--------------------------|
| **AC-1** (VM-branch de address en 3 sitios) | ✅ PASS (con nota de scope, ver abajo) | `deposit-attestation.ts:117-180` (`issueSolanaDepositAttestation`/`verifySolanaDepositAttestation`, tipos separados, sin `isAddress`); `address.ts:37-46` (`addressEqualsVm`, usado en `settle/principal/route.ts:154,183,189,194` B6/S12/S13, VM-discriminado vía `resolveActiveVm()`); `prepare/route.ts:93-105` (PR4, `address` del caller VM-branch). Tests: `deposit-attestation.test.ts:130-198`, `address.test.ts:69-109`, `route.binding.test.ts:220-231`. |
| **AC-2** (EVM byte-idéntico) | ✅ PASS | `git diff main...HEAD --stat -- app/api/settle/principal/route.test.ts app/api/settle/principal/route.static.test.ts` → **0 diff** (regresión EVM intacta). `facilitator-client.test.ts:166-191` (`broadcastSettle` payload EIP-3009 exacto `toEqual`, sin cambios). Único diff EVM-adyacente es `prepare/route.test.ts` (+6/-4), acotado 100% al describe `PR6 rama Solana (HU-SOL-8)` (`git diff` líneas 273-292, ver abajo) — assertions 503/403/no-fetch sin cambio. |
| **AC-3** (payload Solana representable hacia `/settle`) | ✅ PASS | `facilitator-client.ts:185-241` (`verifySolanaSettlement`, objeto literal NUEVO: `network:"solana:<cluster>"`, `asset`/`payTo` base58, `payload.signature`/`reference` base58, SIN `authorization`). Test `facilitator-client.test.ts:51-73` asserta campo a campo el body enviado + `"authorization" in sentBody.payload === false` (línea 72). El objeto `payload` de `broadcastSettle` (líneas 100-104) no se toca (mismo archivo, función separada). |
| **AC-4** (release authority / `to` atestado == beneficiary) | ✅ PASS | `chain.ts:178-187` (`resolveSolanaReleaseAuthorityPubkey()`, env `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, fail-loud, jamás del body). `deposit-attestation.ts:36-37` (`SolanaDepositAttestation.beneficiary`/`.authority`). `settle/principal/route.ts:181-186` (B6: `addressEqualsVm(to, att.depositAddress, vm)` → rechazo `settle_receiver_mismatch` PRE-broadcast). Tests: `chain.test.ts` T3 (`resolveSolanaReleaseAuthorityPubkey` fail-loud, malformado/ausente/cross-VM → throw); `route.binding.test.ts:125-131` (vector B6 EVM, mismo esqueleto). Nota: la resolución RUNTIME del `beneficiary` real es HU-SOL-13 (DT-3, documentado) — esta HU define/testea el contrato de comparación, no lo orquesta e2e. |
| **AC-5** (anti-replay / fail-closed no-oracle) | ✅ PASS | `verifySolanaDepositAttestation` (`deposit-attestation.ts:129-180`) colapsa a `null` en: formato (`132-138`), HMAC (`143-148`), parse (`150-156`), tipos por-campo (`160-172`), `cluster!=="devnet"` (`173`), expiración (`176-177`). Tests: `deposit-attestation.test.ts:135-150` (HMAC forjado reusando MAC → null), `:145-150` (cluster cross-replay → null), `:152-164` (base58 deforme → null sin throw), `:173-178` (expiración frontera), `:180-190` (secreto incorrecto/ausente → null nunca throw). |
| **AC-6** (refund trustless no bloqueado / no hardcode beneficiary/authority) | ✅ PASS | `grep -n "beneficiary" app/api/payout/prepare/route.ts app/api/settle/principal/route.ts src/infrastructure/settlement/deposit-attestation.ts src/infrastructure/chain.ts src/infrastructure/settlement/facilitator-client.ts` → único uso real es forward tal cual al agente (`prepare/route.ts:227`, comentario CD-10/CD-5) y comentarios "NUNCA ecoa beneficiary" (`:221,293`); ningún sitio asigna/hardcodea `beneficiary`/`authority` a un valor de plataforma. `chain.ts:172-177` documenta explícitamente que sólo el pubkey (no la keypair) se conoce server-side y que la resolución real es HU-SOL-13. |

### Nota de scope sobre AC-1 (no es FAIL, es decisión SPEC_APPROVED documentada)

El texto EARS de AC-1 lista `prepare/route.ts (address, depositAddress)`. La implementación VM-branchea `address` (PR4, `prepare/route.ts:93-105`) pero **PR8/`depositAddress`** (`prepare/route.ts:252`, `isAddress(depositAddress)`) queda **EVM-only, sin VM-branch**. Esto NO es drift del Dev: está explícitamente scopeado así en el SDD aprobado (`sdd.md:78` tabla §4.1: *"PR4 `address`: VM-branch... Emisión de atestación Solana = CONTRATO (ver §4.6, gated para HU-SOL-13)"*; `sdd.md:224-227` §4.6: *"La emisión de la SolanaDepositAttestation... requiere el beneficiary real ⇒ resuelto por HU-SOL-13. Esta HU... NO cablea la resolución del beneficiary"*) y en el Story File (`story-HU-SOL-9.md:42` Scope IN sólo lista PR4; `story-HU-SOL-9.md:236` T7 = regresión "PR4/PR8 EVM intactos"). Consistente además con `route.binding.test.ts:188-195` (comentario explícito: la rama Solana de B6/S12/S13 en `settle/principal/route.ts` es forward-looking, no alcanzable e2e vía HTTP en esta HU porque S5/S9 siguen exigiendo `isAddress` sobre `from`/`to`/`address` — sólo las funciones de comparación quedan VM-safe, listas para cuando HU-SOL-13 las cablee). Verificado en código: `settle/principal/route.ts:115,121` (`isAddress` unconditional en S5/S9) — el guard fail-closea un `to` base58 ANTES de llegar a B6/S12/S13, confirmado por el test `route.binding.test.ts:220-231`.

## Verificaciones críticas (pedidas explícitamente)

1. **Atestación HMAC anti-forja/replay**: `deposit-attestation.test.ts:135-143` (cambiar `beneficiary` reusando el MAC → `null`); `:145-150` (`cluster !== "devnet"` → `null`, anti-replay cross-cluster). Fail-closed confirmado — `verifySolanaDepositAttestation` nunca throwea (`:152-164,180-190`, `expect(() => ...).not.toThrow()`).
2. **Release-authority**: `resolveSolanaReleaseAuthorityPubkey()` (`chain.ts:178-187`) es 100% env-driven (`SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`), fail-loud (throw `solana_release_authority_not_configured` si ausente/malformado), y el comentario/código confirma que NUNCA se deriva del body.
3. **EIP-3009 intacto**: `facilitator-client.test.ts:166-191` — payload `broadcastSettle` byte-idéntico vía `toEqual` completo; `verifySolanaSettlement` es función+objeto-literal NUEVOS (`facilitator-client.ts:185-209`), sin tocar el objeto `payload` de la rama EIP-3009 (líneas 100-104). Respuesta Solana validada base58 (`isBase58Signature`, `facilitator-client.ts:173-176`), NO `0x…{64}` — test explícito `facilitator-client.test.ts:80-86` rechaza shape EVM.
4. **IDOR base58**: `address.test.ts:107-109` (`addressEqualsVm` case-sensitive: pubkey vs su lowercase → `false`); `address.ts:37-46` confirma que NUNCA se llama `.toLowerCase()` sobre una address Solana (CD-2/CD-10).
5. **No-broadcast pre-fetch**: `verifySolanaSettlement` no está wireada a ningún `route.ts` en esta HU (`grep -rn "verifySolanaSettlement" app/ src/` → sólo el módulo propio + su test), consistente con Scope OUT (broadcast/orquestación runtime = HU-SOL-13/HU-SOL-14). En el único punto donde SÍ hay un fetch real hoy (`broadcastSettle`, rama EVM), el guard B1-B6/S12/S13 (`settle/principal/route.ts:156-196`) rechaza un `to` no atestado ANTES de llamar `broadcastSettle`/`verifySettlementOnChain` — verificado por los 7 vectores de ataque de `route.binding.test.ts:125-185` (`expect(broadcastMock).not.toHaveBeenCalled()` en todos).

## EVM byte-idéntico (confirmación adicional)

- `git diff main...HEAD --name-only` acotado a: `app/api/payout/prepare/route.{ts,test.ts}`, `app/api/settle/principal/route.{ts,binding.test.ts}`, `src/infrastructure/address.{ts,test.ts}`, `src/infrastructure/chain.{ts,test.ts}`, `src/infrastructure/settlement/deposit-attestation.{ts,test.ts}`, `src/infrastructure/settlement/facilitator-client.{ts,test.ts}` + docs de esta HU. Ningún archivo fuera de este set.
- `route.test.ts` / `route.static.test.ts` (los dos suites EVM principales de settle/principal): **0 líneas de diff**.
- `addressEqualsVm` rama `evm` delega en `isAddressEqual` de viem sin transformación (`address.ts:45`) — paridad confirmada por `address.test.ts:77-88` (`toBe(isAddressEqual(...))`).

## Drift

- **Scope**: todos los archivos tocados están dentro del Scope IN del work-item o explícitamente añadidos por el SDD aprobado (`chain.ts` para `resolveSolanaReleaseAuthorityPubkey`, `address.ts` para la extracción MNR-1 del fix-pack). Sin scope creep.
- **doc/sdd/029** (HU-SOL-13): untracked, sin diff — no tocado.
- **wasiai-facilitator**: no presente en el workspace, no tocado (CD-4 OK).
- **Wave order**: un solo commit squasheado (`a177825`); el orden interno W0→W3 está documentado en `auto-blindaje.md` (2 entradas, ambas de F3 con fixes aplicados antes del commit final) y en `sdd.md §4.1`. Sin evidencia de violación.

## Gates (confirmado del contexto del orquestador — no re-ejecutado salvo `qa`/`tsc` arriba)

- AR: APROBADO — 7 vectores, 0 BLOQUEANTEs, 1 MENOR (resuelto en fix-pack: `addressEqualsVm` extraído a `address.ts` + tests de ambas ramas, confirmado en el diff/tests leídos arriba).
- CR: APROBADO — 0 BLOQUEANTEs, 1 MENOR (mismo, resuelto).

## Companion WF (facilitator) — diferido, no bloquea DONE de esta HU

El wire-format HTTP del `wasiai-facilitator` (`AcceptedSchema.asset`/`payTo` 0x-hex en ambas ramas del `z.union`) sigue sin relajarse — un payload Solana real todavía recibiría `400 INVALID_PAYLOAD` del facilitator hoy. Esto es un bloqueante **cross-repo** explícitamente fuera del alcance de esta HU (CD-4, Missing Input #1 del work-item), diseñado (no codeado) en `sdd.md §4.5` como companion ticket separado. El código de esta HU es correcto y testeado contra el shape esperado (mock), pero NO es HTTP-reachable e2e hasta que ese companion se resuelva — mismo lenguaje que usó HU-SOL-6. No bloquea el veredicto DONE de esta HU (todo el código está dark/flags OFF).

**Listo para DONE.**
