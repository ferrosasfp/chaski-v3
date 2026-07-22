# Report — HU-SOL-7 / WKH-213: Identidad multi-VM base58 (GATE DE SEGURIDAD IDOR)

**Status**: DONE
**Fecha**: 2026-07-21
**Branch**: `feat/026-hu-sol-7-identidad-base58`
**Commit**: `e65bae6`

## Resumen ejecutivo

HU-SOL-7 cierra un **IDOR cross-tenant de seguridad crítica**: `.toLowerCase()` corrompe base58 Solana (case-sensitive). Una pubkey Solana lowercaseada colisiona con otra distinta, abriendo IDOR en el guard ownership (`recordPayoutOutcome: .eq('sender_address')`) y rompiendo el KYC-once. **Solución**: helper único VM-aware `canonicalizeAddress(address, vm)` en 15 sitios lógicos (9 archivos). EVM byte-idéntico (rama `.toLowerCase()` puro, 586 tests sin cambios). Solana: `new PublicKey(address).toBase58()` — case preservado, fail-loud si malformado. Migración aditiva Opción A (`chain_id integer` intacto, agrega `vm`/`network_id`) marcada `-- PENDING-DEPLOY` (aplica founder). **AR ejecutó ataque IDOR y vio fallar sin colisión. CR aprobado. F4 QA: 9/9 ACs PASS, drift NONE. Listo para producción.**

## Pipeline ejecutado

| Fase | Status | Nota |
|------|--------|------|
| F0/F1 | HU_APPROVED | 25 `.toLowerCase()` invocaciones en 15 sitios, 9 archivos mapeados |
| F2 | SPEC_APPROVED (2026-07-21) | DT-1..4 resueltas; CD-1..10 formulados; model Opción A confirmado |
| F2.5 | Story File ✓ | AC-5/CD-2 (EVM byte-idéntico) highlighted |
| F3 | 586 tests ✓ | W0 helper aislado, W1 cascada port/impl/fake, W2 reemplazo 15 sitios, W3 tests IDOR |
| AR | APROBADO | Ataque CR-2 ejecutado, FALLA sin colisión; 1 MENOR (fix-pack test-doubles) |
| CR | APROBADO | Sin findings pendientes; diffs quirúrgicos (6-8 líneas/archivo) |
| F4 | APROBADO PARA DONE | typecheck EXIT 0, 586 tests PASS, drift NONE |

## ACs — tabla con evidencia

| AC | Texto | Status | Evidencia |
|----|-------|--------|-----------|
| AC-1 | `canonicalizeAddress(address, vm)` VM-aware | PASS | `src/infrastructure/address.ts:12-25`; tests `:11-20` |
| AC-2 | No-colisión Solana case-distinto | PASS | `address.test.ts:23-27` + `:57-63` (dos pubkeys reales) |
| AC-3 | `recordPayoutOutcome` canonicaliza ANTES `.eq` | PASS | `supabase-settlement-ledger.ts:167`; test IDOR `:122-149` |
| AC-4 | KYC-once round-trip MISMA key canónica | PASS | `kyc-store.ts:93,101,118`; test `:102-118` (round-trip OK, otra→null) |
| AC-5 | EVM byte-idéntico, suite intacta | PASS | `address.ts:14-15` rama puro; 586 tests sin `expect` tocado |
| AC-6 | vm ambigua / malformado → fail-loud throw | PASS | `address.ts:19-23`; tests `:30-37` |
| AC-7 | Cero `.toLowerCase()` crudo (9 archivos) | PASS | Grep 0 residuos; único residuo nonce bytes32 (AC-9 exime) |
| AC-8 | Migración aditiva (Opción A) | PASS | `20260721T000000_*.sql:1-23` (PENDING-DEPLOY, aditiva, CHECK) |
| AC-9 | Nonce bytes32 `settle/principal:263` intacto | PASS | `git diff` solo import+`vm` param; L263 untouched |

## Hallazgos

**Bloqueantes**: Ninguno.

**Menores (resueltos)**:
- AR-MNR-1: 5 test-doubles en `fakes.ts` no alineados a nuevo type `vm` → fix-pack aplicado (cascada port, trivial).

## Auto-Blindaje

1. **Cascada del port en inline-types**: extender port ⇒ bivariancia permite que impl compile sin props faltantes si declara inline types. **Regla**: cascada simultánea en impl + fake + inputs literales tests (W1). Ya aplicada WKH-207/211.

2. **Base58 colisión es sutil**: lowercasear pubkey válida puede seguir siendo pubkey DISTINTA válida (no necesariamente inválida). El riesgo IDOR es **colisión**, no throw. Test con pubkeys reales distintas, no con `K.toLowerCase()`. Aplicable HU-SOL-8/9.

## Archivos modificados (19 total, todos Scope IN)

**Creados**: `address.ts`, `address.test.ts`, migración SQL (PENDING-DEPLOY).

**Modificados**: `ports.ts`, `supabase-settlement-ledger.ts` (+test), `persistence.ts`, `kyc-store.ts` (+test), `authority.ts`, `flow-vm.ts`, `submit/route.ts` (+test), `prepare/route.ts` (+test), `challenge/route.ts`, `settle/principal/route.ts`, `fakes.ts`.

## Follow-ups para founder

1. **Migración PENDING-DEPLOY**: ejecutar `20260721T000000_add_vm_network_id_to_remittance_settlements.sql` antes de habilitar Solana money-path (HU-SOL-9). Aditiva, segura, sin riesgo a filas EVM.

2. **Flag `NEXT_PUBLIC_VM`**: esta HU NO wirea Solana en runtime. Cuando HU-SOL-9 esté lista, setear `NEXT_PUBLIC_VM=solana` en `.env` para activar el path Solana completo.

3. **AR-MNR-2 diferido**: poblar `vm`/`network_id` en escrituras del ledger cuando exista el money-path Solana (HU-SOL-9); hoy la columna es aditiva y nullable.

## Constraint Directives cumplidas

CD-1..CD-10: todos verificados. EVM byte-idéntico, guard-order intacto, IDOR cerrado, migración aditiva, tests IDOR ejecutables.
