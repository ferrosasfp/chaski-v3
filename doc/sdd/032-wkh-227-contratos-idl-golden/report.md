# Report — WKH-227 / HU-SOL-24 — Contratos A2A tipados + IDL versionado + golden EVM tests

**Fecha de cierre**: 2026-07-23  
**Status final**: **DONE**  
**Repositorios**: `chaski-v3`, `wasiai-remittance-agents` (W1), `wasiai-facilitator` (W2), lectura de `solana-programs`.

---

## Resumen ejecutivo

Entregado test-infra aditiva en 3 repos (166 tests W1 remit, 1004 tests W2 facilitator, 695 tests W3 chaski) que cierra deuda cross-repo de testing: (1) **contract tests** que replayan fixtures vendoreados del provider contra validadores del consumer y saltan rojo ante drift; (2) **hash SHA-256 del IDL** (`aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71`) con auto-consistencia + test best-effort vs sibling; (3) **4 golden EVM tests** congelando la serialización byte-exacta de payloads (EIP-712, eip3009.authorization, body /settle, issueDepositAttestation). **Cero cambio de comportamiento runtime** (CD-1). AR APROBADO 0 BLQ, CR APROBADO 0 BLQ, F4 APROBADO 7/7 ACs con experimento de drift propio. Un MENOR (nonce placeholder) fix-packeado. Todas las branches sin mergear aún — el orquestador commitea después.

---

## Pipeline ejecutado

| Fase | Gate | Artefacto | Status |
|------|------|-----------|--------|
| **F0** | N/A | `project-context.md` cargado (4 repos, grounding T-3/T-9 verificado en vivo) | ✅ DONE |
| **F1** | `HU_APPROVED` | `work-item.md` + 7 ACs EARS, 5 DT-N, 7 CD-N | ✅ DONE (2026-07-22) |
| **F2** | `SPEC_APPROVED` | `sdd.md` full, IDL hash verificado `aa53c03f…fb71` byte-exacto en los 3 repos | ✅ DONE (2026-07-22) |
| **F2.5** | — | 3 story files (W1/W2/W3, uno por repo consumer/provider) | ✅ DONE |
| **F3** | — | **W1** (remit-agents): 4 fixtures + contract test → 166 total tests. **W2** (facilitator): fixture /settle + contract test + hash test + canonical-hash helper → 1004 total tests. **W3** (chaski): 4 vendoreados + 4 contract tests + 4 golden EVM + hash test + CONTRACT-VERSIONS.md → 695 total tests | ✅ DONE (2026-07-23) |
| **AR** | APROBADO | 0 BLOQUEANTE, 1 MENOR (MNR-1: nonce placeholder divergente en W2) fix-packeado | ✅ APROBADO |
| **CR** | APROBADO | 0 BLOQUEANTE, 1 MENOR (MNR-1, mismo hallazgo) fix-packeado | ✅ APROBADO |
| **F4** | APROBADO | 7/7 ACs PASS (remit 166/166, facilitator 1004/1004, chaski 695/695; drift experiments: AR mutó golden #3, QA mutó golden #2 independientemente, ambos rojo → restaurado → verde) | ✅ APROBADO |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia | Repos tocados |
|----|--------|-----------|---|
| **AC-1** | **PASS** | Contract tests invocan validadores reales del consumer (no re-implementan). Drift simulado: `feeUsd→feeUsd2` (W3 quote test) → 502/throw; payout status drift → throw; settle body completo toEqual vs fixture. `facilitator/src/contracts/contracts.provider.test.ts` con `.strict()` rechaza extra/renombrado. | W1 (remit), W2 (facilitator), W3 (chaski) |
| **AC-2** | **PASS** | Hash IDL pinneado: `escrow-idl.hash.test.ts` en chaski (`contracts/idl/`) y facilitator (`src/chains/`) → ambos `canonicalSha256(escrowIdl) === "aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71"` PASS | W3 (chaski), W2 (facilitator) |
| **AC-3** | **PASS** | Test best-effort nivel 2 (sibling `../solana-programs/target/idl/escrow.json`): skip limpio cuando path no existe. En este workspace el sibling existe → NO skipea, corre y pasa en ambos repos. | W3, W2 |
| **AC-4** | **PASS** | 4 golden EVM: experimento drift en vivo (QA + AR independientes): mutación `value: "400000000"→"400000001"` → test rojo, restaurado → verde. Freeze byte-a-byte confirmado. | W3 |
| **AC-5** | **PASS** | Montos on-chain como `string`/`bigint` minor-units. Montos FIAT (`rate`, `feeUsd`, etc.) quedan `z.number()`. | W1 (remit), W2 (facilitator), W3 |
| **AC-6** | **PASS** | Suites previas 100% verdes: W1 remit 160→166 (+6), W2 1004 sin cambio count, W3 695 nuevos. `tsc --noEmit` clean, `npm run build` verde (chaski). | W1, W2, W3 |
| **AC-7** | **PASS** | 4 fixtures vendoreados llevan header AC-7: "COPIA PINNEADA, NO SE EDITA… Origen: <repo>/<path> + fecha sync 2026-07-22" | W3 |

---

## Hallazgos finales

### Bloqueantes (BLQ)
**Ninguno.** AR APROBADO 0 BLQ, CR APROBADO 0 BLQ.

### Menores (MNR)

| ID | Categoría | Hallazgo | Fix |
|----|-----------|----------|-----|
| **MNR-1** | Integration/traceability | `wasiai-facilitator/src/contracts/settle-eip3009.body.fixture.ts:25-26`: nonce placeholder `0x`+`cd`×32 divergente del nonce determinístico real (`keccak256(...)`, 32 bytes hex) en la copia vendoreada chaski. No rompe contrato (nonce consumer-side), riesgo de confusión al re-vendorear. Documentado en `CONTRACT-VERSIONS.md` §CD-4. | Fix-packeado: comentario inline aclaratorio ("PLACEHOLDER... NO copiar verbatim al vendorear"), verificado presente por QA. |

---

## Auto-Blindaje consolidado

### [2026-07-23 00:00] Wave W2 (facilitator) — lint `--max-warnings 0` rojo por security plugin

**Error**: `npm run lint` falló con 3 warnings: `security/detect-object-injection` en `canonical-hash.ts` (lookup `obj[k]`) + 2× `security/detect-non-literal-fs-filename` en `escrow-idl.hash.test.ts`.

**Causa**: repo corre eslint con `--max-warnings 0`; security plugin marca lookup dinámico/fs, aunque input sea seguro.

**Fix**: convención EXISTENTE del repo — inline `// eslint-disable-next-line security/detect-object-injection -- ...` (idéntico a `src/core/idempotency.ts:120`) + file-level `/* eslint-disable security/detect-non-literal-fs-filename ... */` (idéntico a `src/__tests__/unit/no-console.test.ts:1`). Sin cambio lógica.

**Lección**: verifica `npm run lint` ANTES de cerrar wave, no solo `tsc`. Helpers nuevos con `Object.keys()` o tests que leen archivos por path variable necesitan disable justificado o lint bloquea.

### [2026-07-23 00:00] Wave W1 (remit-agents) — grounding FALSO: `vitest.config.ts` SÍ tiene `include`

**Error**: Story afirmaba que `vitest.config.ts` NO define `include` → tests correrían auto. FALSO: tiene `include: ["src/**/*.test.ts"]`. `npm test` corre 160 tests (todos en `src/`), NO recoge `contracts/`.

**Causa**: Architect asumió glob default sin leer config real.

**Resolución**: relocalizó `contracts/` → `src/contracts/` (sin tocar `vitest.config.ts`, CD-1). Tests ahora 160→166 (+6 dentro de la suite), `tsc --noEmit` limpio.

**Lección**: verifica `include`/`testMatch` REAL en el config del repo antes de asumir globs default. El dev DEBE confirmar que el conteo de test-files SUBIÓ, no solo que "pasó".

### [2026-07-23 00:00] W3 (chaski) — Relocación `contracts/` depende de `include` del runner

**Observación (no bloqueante)**: chaski → `contracts/` raíz (vitest default). W1/W2 → `src/contracts/` (porque incluye `src/**`). Cada repo = su convención. Ya documentado en auto-blindaje.

---

## Archivos modificados por repositorio

### wasiai-remittance-agents (W1)

Nuevos bajo `src/contracts/` (aditivos):
- `corridor-fx.output.fixture.ts`, `kyc-validator.output.fixture.ts`, `cashout-payout.output.fixture.ts`, `inputs.fixture.ts`, `contracts.provider.test.ts` (6 tests)

**Count**: 160 → 166 tests (+6 PASS)

### wasiai-facilitator (W2)

Nuevos bajo `src/contracts/` + `src/chains/` (aditivos):
- `settle-eip3009.body.fixture.ts`, `contracts.provider.test.ts`, `src/chains/canonical-hash.ts`, `src/chains/escrow-idl.hash.test.ts` (con `eslint-disable` justificados)

**Count**: 1004 tests totales, todos verdes.

### chaski-v3 (W3)

Nuevos bajo `contracts/` + 1 línea `tsconfig.json`:
- **Vendoreados**: `corridor-fx.output.fixture.ts`, `kyc-validator.output.fixture.ts`, `cashout-payout.output.fixture.ts`, `settle-eip3009.body.fixture.ts` (con headers AC-7)
- **Contract tests**: `contracts.quote.test.ts`, `contracts.payout.test.ts`, `contracts.kyc.test.ts`, `contracts.settle.test.ts`
- **Golden EVM**: `contracts/golden/golden-evm.test.ts` + 4 golden JSON/TXT files + `README.md` (documenta `UPDATE_GOLDEN=1`)
- **Hash IDL**: `contracts/idl/canonical-hash.ts`, `contracts/idl/escrow-idl.hash.test.ts`
- **Docs**: `contracts/CONTRACT-VERSIONS.md` (tabla vendoreados + MNR-1 + deuda Missing Input #1)
- **tsconfig.json**: +1 línea `include: ["contracts/**/*.ts"]` (type-check only, no bundlea)

**Count**: 695 tests totales (562 base EVM + 133 nuevos), todos verdes.

---

## Lecciones para próximas HUs

1. **`vitest.config.ts` / `jest.config` REAL** — el test runner NO auto-descubre cambios fuera de `include`. Verificá antes de asumir globs default. Count de test-files debe SUBIR.

2. **eslint `--max-warnings 0` + security plugin** — disables justificados (inline/file-level) replicando convención del repo. `canonical-hash.ts` es seguro pero genérico no lo sabe.

3. **Contract test = golden + durabilidad** — replay del fixture real (AC-1) + congelación byte-exacta (AC-4) cierran hueco T-3/T-9. Para futuras modificaciones de contratos HTTP: actualizar fixture provider → re-generar golden → actualizar fixture vendoreado consumer → tests consumer fallan rojo hasta actualizar código consumer.

4. **Hash canónico (canonicalJson) estable pero re-pinnear manual** — preserva orden arrays, ordena keys objetos. Si IDL se edita sin re-pinnear → falla. Para próximo cambio escrow Anchor: recomputar hash, actualizar constante pinneada en AMBOS tests.

5. **Nonce determinístico vs placeholder** — documentar en fixture qué campos son placeholders (W2 provider) vs reales (W3 consumer). Confusion-point para futuras sincronizaciones.

---

## Resumen técnico: estado de 3 repos post-entrega

| Repo | Cambios | Tests | Status |
|------|---------|-------|--------|
| **wasiai-remittance-agents** (W1) | 5 nuevos en `src/contracts/` | 160→166 (+6) | ✅ Verde |
| **wasiai-facilitator** (W2) | 4 nuevos en `src/contracts/` + `src/chains/` | 1004 | ✅ Verde |
| **chaski-v3** (W3) | 15 nuevos en `contracts/` + 1 línea tsconfig.json | 695 | ✅ Verde |

**Constante pinneada (ESCROW_IDL_SHA256)**: `aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71` — los 3 IDL canonicalizan al MISMO valor hoy (byte-a-byte verificado en F2).

**Scope garantizado**: 0 cambio de comportamiento runtime. Solo tests + fixtures + helpers + docs nuevos (CD-1).

---

## Entregables finales

✅ `doc/sdd/032-wkh-227-contratos-idl-golden/report.md` (este archivo)  
✅ `doc/sdd/_INDEX.md` actualizado (fila WKH-227 → DONE 2026-07-23)  
✅ Auto-Blindaje consolidado (todas las transiciones resueltas)  
✅ 3 repos listos para commit (branches sin push aún — orquestador commitea después)  

**Listo para DONE.**
