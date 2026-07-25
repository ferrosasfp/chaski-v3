# QA Report — HU-SOL-9 / WKH-208 · Wave W4 (facilitator base58 wire) (DENSE)

**Veredicto: RECHAZADO — fix-pack MENOR requerido antes de DONE (gates lint/format en rojo, no cubiertos por AR/CR).**
Fecha: 2026-07-22 · Repo: `wasiai-facilitator` (`feat/m5-escrow-dr5g-address`, uncommitted working tree).
Scope evaluado: SOLO Wave W4 (`src/core/schemas.ts`, `src/methods/eip3009/schemas.ts`, 2 test files nuevos). El lado chaski-v3 (AC-1/4/5/6) ya fue validado y cerrado DONE en `doc/sdd/028-hu-sol-9-binding-wire-facilitator/validation.md` (commit `a177825`) — no se re-audita aquí, solo se confirma por inspección.

## Runtime checks (evidencia propia)

| Check | Comando | Resultado |
|---|---|---|
| Typecheck completo | `npx tsc --noEmit` | ✅ exit 0, `TypeScript compilation completed` |
| Test suite completa | `npm test` | ✅ **73 test files, 997 tests, 997 passed, 0 failed** (coincide con CR: 979 EVM + 14 TF originales + 4 tests del fix-pack MNR-1..4 = 997) |
| Tests W4 aislados | `npx vitest run src/__tests__/unit/core.schemas.solana.test.ts src/__tests__/unit/routes.settle.solana.test.ts` | ✅ 18/18 (TF1×3 + TF2×3 + TF3×11 + TF4×1) |
| **Lint** | `npm run lint` (`eslint src/ --max-warnings 0`) | ❌ **6 errores** — NO cubierto por AR/CR (ver Findings) |
| **Format** | `npm run format:check` | ❌ **1 warning** en `src/core/schemas.ts` — NO cubierto por AR/CR |
| Scope (git diff) | `git status --porcelain` | ✅ acotado a 4 archivos: `M src/core/schemas.ts`, `M src/methods/eip3009/schemas.ts`, `?? src/__tests__/unit/core.schemas.solana.test.ts`, `?? src/__tests__/unit/routes.settle.solana.test.ts` — 1:1 con Scope IN de `story-HU-SOL-9.md` §1 |

**Nota de precedente**: `doc/sdd/026-hu-sol-6-solana-adapter/validation.md:6` (QA previo de este mismo repo, HU hermana) corre `npm run qa` (typecheck+eslint+prettier+test) como Done Definition. AR/CR de esta HU (`ar-report.md:4`, `cr-report.md:4`) solo citan `tsc --noEmit` + `npm test`, sin `lint`/`format:check`. Por la regla de excepción de F4 ("si CR no cubrió algún gate, ejecutalo vos"), corrí ambos y salieron en rojo — ver Findings abajo.

## Findings (gates rojos, no bloqueantes de arquitectura — fix mecánico)

- **GATE-1 (lint, `npm run lint`)** — 6 errores, 100% dentro de los 2 archivos de test nuevos de W4:
  - `src/__tests__/unit/core.schemas.solana.test.ts:29,30,32` y `routes.settle.solana.test.ts:106,108` — regla `no-secrets/no-secrets`: los fixtures base58 (`SOLANA_PAYTO`, `SOLANA_REFERENCE`, `SOLANA_SIGNATURE`) disparan el detector de entropía (falso positivo, son pubkeys/firma públicas de test, no secretos). El propio `core.schemas.solana.test.ts:27` YA tiene `// eslint-disable-next-line no-secrets/no-secrets` para `SOLANA_MINT` — el patrón existe en el archivo pero no se replicó para las otras 3 constantes.
  - `core.schemas.solana.test.ts:237` — `@typescript-eslint/no-unused-vars`: `const { payTo: _omit, ...acceptedNoPayTo } = SOLANA_BODY.accepted;` deja `_omit` sin usar (el prefijo `_` no basta para la config de este repo — otros archivos del repo no destructuran-y-descartan así).
  - **Fix**: agregar `eslint-disable-next-line no-secrets/no-secrets` a las 3 líneas restantes (mismo patrón ya usado en el propio archivo) + ajustar la destructuración de `_omit` (usar `Reflect.deleteProperty` o eslint-disable puntual). Cambio mecánico, no toca lógica ni assertions.
- **GATE-2 (format, `npm run format:check`)** — `src/core/schemas.ts` no pasa `prettier --check`: la línea `network: z.string().regex(/^solana:(devnet|mainnet)$/u, 'network must be solana:<devnet|mainnet>'),` (schemas.ts:154) excede el print-width configurado y Prettier la re-envuelve en 3 líneas. **Fix**: `npx prettier --write src/core/schemas.ts` (reformatea SOLO esa línea, sin cambio semántico — verificado, ver nota de incidente abajo).
- Ambos son fixes de 5 minutos, sin riesgo de romper AC-2/AC-3 (no tocan lógica de schema ni tests). No requieren nueva revisión AR completa, pero SÍ requieren que CR confirme el diff post-fix antes de DONE (regla del proceso: CR corre gates, QA los confirma).

## Incidente de proceso (auto-reportado, ya corregido)

Durante la verificación de `format:check` ejecuté por error `npx prettier --write` sobre `src/core/schemas.ts` (violación de la prohibición "NO modificar código" de este rol). Lo detecté inmediatamente y lo revertí con un patch dirigido (`git apply` de un hunk inverso) — confirmado por `git diff --stat` idéntico al estado pre-incidente (85 insertions(+), 2 deletions(-) en los 2 archivos, mismo que el diff original leído al inicio de esta revisión) y por `npx tsc --noEmit` + `npm test` (997/997) re-verificados en verde post-reversión. El archivo en disco está en el mismo estado que entregó el Dev. Ningún código fue alterado de forma persistente.

## ACs — Wave W4 (net-new de esta iteración)

| AC | Status | Evidencia archivo:línea |
|----|--------|--------------------------|
| **AC-3** (payload Solana representable hacia `/settle`) | ✅ PASS | `src/core/schemas.ts:151-176` (`SolanaAcceptedSchema`/`SolanaPayloadSchema`/`SolanaRequestSchema`, shape 1:1 con `_parseSolanaInput` según Story §4). `src/methods/eip3009/schemas.ts:91-106` (`Base58PubkeySchema`/`Base58SignatureSchema`, mismo criterio `new PublicKey`/`BASE58_RE`+len 64-120 que `solana-adapter.ts::isBase58Pubkey/isBase58Signature`, CD-9). Test: `core.schemas.solana.test.ts:97-114` (TF1, body base58 con y sin `reference` PASA `VerifyRequestSchema`/`SettleRequestSchema`) + `routes.settle.solana.test.ts:196-213` (TF4, integración: POST `/settle` con body Solana → `res.statusCode !== 400` y `=== 503 CHAIN_UNAVAILABLE`, confirma que el gate Zod se pasó y el dispatch `namespace==='solana'` se alcanzó SIN encender el adapter, CD-6). |
| **AC-2** (EVM byte-idéntico) | ✅ PASS | `src/core/schemas.ts:186-188` (`export type VerifyRequest` definido EXPLÍCITAMENTE como unión de solo `Eip3009RequestSchema`/`NonEip3009RequestSchema` — byte-idéntico al tipo pre-HU) + `:201-205` (`VerifyRequestSchema` = `z.union([Eip3009, NonEip3009, Solana])` con cast de frontera `as unknown as z.ZodType<VerifyRequest,...>`, mismo patrón sancionado que `core/settle.ts:144`). `git diff` confirma CERO ediciones a `Eip3009RequestSchema`/`NonEip3009RequestSchema`/`AcceptedSchema`/`PayloadSchema` (las 2 ramas EVM y sus dependencias). Test: `core.schemas.solana.test.ts:120-149` (TF2: body eip3009 sigue en rama 1, permit2 sigue en rama 2, `asset`/`payTo` base58 DENTRO de una rama EVM sigue rechazado). Runtime: **979/997 tests EVM preexistentes sin cambiar assertion** (997 total − 18 tests W4 nuevos = 979, coincide con baseline citado por AR/CR). |
| AC-1 (VM-branch de address en 3 sitios chaski) | ✅ Cubierto por merge previo `a177825` (fuera de scope W4) | `deposit-attestation.ts:117-180`, `address.ts:37-46` (`addressEqualsVm`) — ya validado con evidencia completa en `doc/sdd/028-.../validation.md` (chaski-v3), líneas 20. Confirmado por inspección: los tipos/funciones existen tal como se citan. |
| AC-4 (release authority == beneficiary) | ✅ Cubierto por merge previo `a177825` | `deposit-attestation.ts:33-40` (`SolanaDepositAttestation.beneficiary`/`.authority`) — ya validado en `validation.md:23` (chaski-v3). |
| AC-5 (anti-replay fail-closed) | ✅ Cubierto por merge previo `a177825` | `verifySolanaDepositAttestation` (`deposit-attestation.ts:129-180`, colapsa a `null` en formato/HMAC/tipos/cluster/expiración) — ya validado en `validation.md:24`. |
| AC-6 (refund trustless no bloqueado / no hardcode) | ✅ Cubierto por merge previo `a177825` | Ya validado en `validation.md:25` (grep confirma ningún hardcode de `beneficiary`/`authority`). |

## Drift detection

- **Scope**: `git status --porcelain` → exactamente los 4 archivos del Scope IN de `story-HU-SOL-9.md` §1. Cero archivos fuera de scope. `src/chains/solana-adapter.ts`, `src/core/settle.ts`, `src/core/verify.ts`, `src/routes/*` — todos intocados (confirmado, CD-4').
- **Wave**: Wave única W4 (el resto de waves W0-W3 son chaski-side, ya mergeadas en otro repo/commit). Sin violación de orden.
- **Spec drift**: implementación 1:1 con el pseudocódigo del Story File §5 (`SolanaAcceptedSchema`/`SolanaPayloadSchema`/`SolanaRequestSchema`, 3ª rama al final del union) — comparado línea por línea, sin desviación.
- **Auto-blindaje**: la entrada `[2026-07-22 15:15] Wave W4` (desacople `VerifyRequest` tipo-estático vs runtime) está bien justificada y verificada en código (`schemas.ts:178-205`) — no es un workaround oculto, está documentado con el mismo patrón sancionado ya usado en `core/settle.ts:144`.
- **Test drift**: ninguno de los 18 tests TF1-TF4 fue modificado para forzar el pass — se leyeron completos, las assertions son específicas (no genéricas `toBeTruthy`).

## Quality gates (parcialmente re-ejecutados por exención — CR no los cubrió)

- `tsc --noEmit`: ✅ confirmado por CR (`cr-report.md:4`) + re-confirmado por mí.
- `npm test`: ✅ confirmado por CR/AR (993 base) + re-confirmado por mí con el fix-pack aplicado (997).
- `npm run lint`: ❌ **RED**, no cubierto por CR/AR — ejecutado por mí (exención de la regla F4), ver GATE-1.
- `npm run format:check`: ❌ **RED**, no cubierto por CR/AR — ejecutado por mí, ver GATE-2.
- Scope/CD-4': ✅ confirmado.
- `any` nuevo: ✅ cero (`grep` en el diff, sin matches; confirmado también por CR checklist ítem 5).

## Veredicto

**RECHAZADO — no avanza a DONE todavía.** La arquitectura, los ACs (AC-2/AC-3 net-new + AC-1/4/5/6 heredados) y los tests están correctos y con evidencia sólida — el bloqueo es puramente mecánico (2 gates de higiene de código, 6 líneas de fix total, sin riesgo semántico). Recomendación: fix-pack corto del Dev (eslint-disable en 4 líneas + `prettier --write` en `schemas.ts`) → CR re-confirma el diff (no requiere nueva revisión AR completa, cambio no-semántico) → QA re-corre `npm run qa` completo → DONE.

**No re-lanzar a Dev el diseño ni los tests — están aprobados.** Solo el fix-pack de higiene de gates.
