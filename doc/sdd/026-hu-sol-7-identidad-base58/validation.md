# Validation Report — [WKH-213][HU-SOL-7] Identidad multi-VM (base58) — GATE DE SEGURIDAD

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-21
**Commit validado**: `e65bae6` (branch `feat/026-hu-sol-7-identidad-base58`)
**AR/CR**: APROBADO (verdictos provistos por el orquestador — AR ejecutó el ataque IDOR CR-2 y lo vio FALLAR; CR sin findings pendientes). No hay `ar-report.md`/`cr-report.md` en disco (patrón de sesión, no bloqueante).

## Runtime checks (evidencia propia)

**`npm run typecheck`** (`tsc --noEmit` completo, CD-7): `EXIT 0`, cero errores.

**`npm run test` (vitest, dentro de `npm run qa`)**:
```
Test Files  51 passed (51)
     Tests  586 passed (586)
  Duration  4.24s
```
Todos los stderr del run son logs `best-effort` esperados (CD-17, fallos simulados de ledger que no rompen el money-path), no fallos de test.

**EVM byte-idéntico (AC-5)**: `src/infrastructure/address.ts:14-15` — la rama `evm` es `address.toLowerCase()` puro, sin `isAddress`, `NUNCA throw`. Confirmado en `src/infrastructure/address.test.ts:40-53` (`'0xAAA'→'0xaaa'`, `'0xZZZ'→'0xzzz'`, `FALLBACK_WALLET_ADDRESS` no-hex nunca throwea). Los 586 tests existentes (incluido `chain.test.ts`, `kyc-store.test.ts`, `persistence.test.ts`, `authority`-covering `submit/route.test.ts`, `prepare/route.test.ts`, `challenge/route.test.ts`, `settle/principal/route*.test.ts`) pasan **sin cambio de expectativa** — ninguna assertion EVM preexistente fue tocada (verificado por lectura de los test files modificados: los únicos `it(...)` nuevos son los explícitamente marcados `AC-2`/`AC-4`/`CD-9`/`W3.x`).

## ACs — tabla con evidencia archivo:línea

| AC | Texto (resumen) | Status | Evidencia |
|----|------------------|--------|-----------|
| AC-1 | `canonicalizeAddress(address, vm)` VM-aware | PASS | `src/infrastructure/address.ts:12-25` (switch evm/solana); tests `src/infrastructure/address.test.ts:11-20` |
| AC-2 | No-colisión Solana case-distinto | PASS | `src/infrastructure/address.test.ts:23-27` (preserva case) + `:57-63` (CD-9, dos pubkeys reales case-distintas → canónicos distintos) |
| AC-3 | Owner-scoping `recordPayoutOutcome` canonicaliza ANTES del `.eq` | PASS | `src/infrastructure/persistence/supabase-settlement-ledger.ts:167` — `.eq("sender_address", canonicalizeAddress(input.senderAddress, input.vm))`; test IDOR explícito `supabase-settlement-ledger.test.ts:122-133` (filtra por pubkey base58 case-preservada, `not.toContainEqual` del lowercase) y `:135-149` (dos senders Solana case-distintos → filtros distintos) |
| AC-4 | KYC-once round-trip con la misma key canónica | PASS | `src/infrastructure/kyc-store.ts:93,101,118` (`get`/`save`/`clear` usan `canonicalizeAddress(address, resolveActiveVm())`); test `kyc-store.test.ts:102-107` (round-trip) + `:109-113` (otra pubkey válida → `null`, no colisiona) + `:115-118` (malformada → throw, nunca devuelve la entry de la víctima) |
| AC-5 | EVM byte-idéntico | PASS | Ver sección Runtime checks arriba — `address.ts:14-15` + `address.test.ts:40-53` + 586/586 tests sin expectativas cambiadas |
| AC-6 | vm ambigua / address malformada → fail-loud throw | PASS | `src/infrastructure/address.ts:19-23` (catch→throw en solana malformado; default→throw en vm desconocida); tests `address.test.ts:30-37` |
| AC-7 | Cero `.toLowerCase()` crudo sobre address en los 9 archivos de Scope IN | PASS | Grep verificado: 0 ocurrencias en `supabase-settlement-ledger.ts`, `persistence.ts`, `kyc-store.ts`, `authority.ts`, `submit/route.ts`, `prepare/route.ts`, `challenge/route.ts`, `flow-vm.ts`. Único `.toLowerCase()` remanente en Scope IN/OUT: `app/api/settle/principal/route.ts:263` (nonce bytes32, AC-9 exime explícitamente) |
| AC-8 | Migración aditiva `chain_id` → identidad de red Solana | PASS | `supabase/migrations/20260721T000000_add_vm_network_id_to_remittance_settlements.sql:1-23` — agrega `vm`/`network_id`, relaja `chain_id` a NULLABLE (NO `ALTER COLUMN...TYPE` destructivo), agrega CHECK de coherencia vm↔columnas; comentario `-- PENDING-DEPLOY` en L1-2. **NO aplicada** (verificado: no se ejecutó ningún comando de DB durante esta validación) |
| AC-9 | Nonce EVM `settle/principal/route.ts:263` intacto | PASS | `git diff main...HEAD -- app/api/settle/principal/route.ts` → solo 2 líneas (import de `resolveActiveVm` + `vm: resolveActiveVm()` agregado a un call de ledger); la comparación `expectedNonce.toLowerCase() !== nonce.toLowerCase()` en L263 no fue tocada |
| CD-9 (test obligatorio) | Test IDOR explícito en sitios críticos | PASS | `recordPayoutOutcome`: `supabase-settlement-ledger.test.ts:122,135`; `kyc-store.get/save/clear`: `kyc-store.test.ts:89-119`; guard PoP `submit`: `address.test.ts:57-63` (invariante reusado por `submit/route.ts:144`) |

## Drift detection

`git diff main...HEAD --name-only` → 19 archivos, todos dentro de Scope IN de `work-item.md`:
`address.ts`+`address.test.ts` (helper nuevo), `ports.ts` (firma `vm`), `fakes.ts` (fix-pack AR-MNR-1), `supabase-settlement-ledger.ts`+`.test.ts`, `orphan-ledger.test.ts`, `persistence.ts`, `kyc-store.ts`+`.test.ts`, `authority.ts`, `flow-vm.ts`, las 4 rutas (`submit`, `prepare`, `challenge`, `settle/principal` — diff mínimo de 2 líneas), la migración, y `doc/sdd/026-hu-sol-7-identidad-base58/*`.

- **`doc/sdd/025-hu-sol-5-*` NO tocado** — confirmado (no aparece en el diff; existe solo como directorio untracked de otra HU en curso, ajeno a este branch).
- **CD-8** (no tocar lógica de negocio más allá del reemplazo puntual): diffs de `submit/route.ts` (+8/-3... realmente 8 inserciones/3 deleciones netas incluyen el import), `prepare/route.ts` (6 líneas), `challenge/route.ts` (5 líneas), `authority.ts` (4 líneas), `flow-vm.ts` (4 líneas) — todos diffs quirúrgicos, sin reorder de guards.
- **Wave order**: `auto-blindaje.md` documenta Wave 1 (port/impl bivarianza) y Wave 3 (test IDOR), consistente con progresión W0→W1→W2/W3 declarada en el story file.

Drift: **NONE**.

## Gate confirmation

- **AR**: APROBADO — ejecutó el ataque IDOR CR-2 (`canon(A) ≠ canon(A.toLowerCase())`) y lo vio FALLAR (sin colisión). Confirmado (orquestador, autoritativo).
- **CR**: APROBADO — sin findings pendientes. Confirmado (orquestador, autoritativo).
- **typecheck/tests**: confirmados por evidencia propia en este reporte (no re-ejecución de gates ya corridos por Dev/CR, sino verificación runtime-first requerida a QA sobre el estado final del commit).

## Nota migración PENDING-DEPLOY

`supabase/migrations/20260721T000000_add_vm_network_id_to_remittance_settlements.sql` es aditiva y segura por inspección: no altera el tipo de `chain_id` (sigue `integer`), solo relaja su `NOT NULL` y agrega `vm text not null default 'evm'` + `network_id text` + un `CHECK` de coherencia mutuamente excluyente. No fue aplicada a ninguna base de datos durante esta validación (ni se emitió ningún comando de escritura/DDL). Queda gated para el founder, mismo patrón que `20260716T000000_create_remittance_settlements.sql`.

**Listo para DONE.**
