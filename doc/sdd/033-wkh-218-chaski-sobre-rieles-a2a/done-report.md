# Done Report — WKH-218 Chaski corre SOBRE los rieles A2A

**Status**: DONE
**Date**: 2026-07-24
**Branch**: `feat/033-wkh-218-chaski-sobre-rieles-a2a`

---

## Resumen ejecutivo

Chaski enruta ahora el quote (FX) y el payout **a través del gateway `wasiai-a2a`** en lugar de punto-a-punto. La nueva rama `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER="a2a-gateway"` resuelve dinámicamente cada agente via `POST /discover` e invoca via `POST /compose` con una Agent Key propia server-only, habilitando discovery, fee-split x402 y orquestación del gateway (el keystone del pitch: "Chaski corre SOBRE los rieles A2A"). Flag OFF por defecto (construye, no enciende). 8/8 ACs PASS, 0 BLQ, 2 MNR opcionales. Path byte-idéntico cuando flag ≠ `"a2a-gateway"`. Guards 1-8 de payout intactos (CD-2).

---

## Pipeline ejecutado

| Fase | Hito | Detalle | Verificado |
|------|------|---------|-----------|
| **F0** | Grounding + Análisis | Project context, contrato real del gateway `wasiai-a2a` (`/discover`, `/compose`), patrón de routes punto-a-punto existentes, guard-order autoridad+PoP+atestación intocable. CD-1 confirmado: prohibido modificar `wasiai-a2a`. | ✓ Work Item |
| **F1** | Work Item + ACs EARS | 8 ACs EARS (quote/payout via gateway, discover+compose, fail-closed, byte-idéntico flag OFF, creds server-only, idempotencyKey intacto), 5 DT-N (single-step no orchestrate, discover parametrizado, Agent Key propia, 3er valor flag, byte-idéntico guards), 8 CD-N. 4 Missing Inputs NO bloqueantes (aprovisionamiento founder-gated, capability strings, shape Agent, nombre env var). Repo: `chaski-v3`. | ✓ HU_APPROVED (2026-07-24) |
| **F2** | SDD (SPEC_APPROVED) | Architecture map (routes server-only con rama `a2a-gateway`, gateway-client.ts helper fail-closed, container.ts wiring), contratos leídos de `wasiai-a2a` (CD-1), 9 archivos scope IN, patrón Anti-Hallucination (tipos narrow, algo fail-closed, exemplars byte-exactos). | ✓ SPEC_APPROVED (2026-07-24) |
| **F2.5** | Story File | Contrato ejecutable F3: `runViaGateway(capability, expectedSlug?, input)`, tipos narrow local, 9 archivos exactos, Wave 0-3 checklist, Anti-Hallucination verificado (slugs, endpoints, unwrap, fail-closed). | ✓ Story-WKH-218.md |
| **F3 W0** | Contratos/tipos/wiring | `gateway-client.ts` (NUEVO, 200 líneas), `gateway-client.test.ts` (NUEVO, 300+ líneas), `container.ts` (+2 líneas wiring), `.env.example` (+11 líneas docs). Commit: `338ee6a`. Gates: tsc 0, vitest 64. | ✓ W0 PASS |
| **F3 W1** | Quote route + tests | `app/api/a2a/quote/route.ts` rama `a2a-gateway` (25+/1-), `quote/route.test.ts` (casos gateway, discover, compose, fail-closed). Byte-idéntico cuando flag ≠ `a2a-gateway` (tests `it.each(["fallback","a2a",undefined])`). Commit: `abed124`. Gates: tsc 0, vitest 64 + 9 nuevos. | ✓ W1 PASS |
| **F3 W2** | Payout route + guards | `app/api/a2a/payout/submit/route.ts` forward final (37+/0- deletions), guards 1-8 byte-idénticos (CD-2 confirmado), tests gateway + fail-closed + guard-8-intact. Commit: `c75dbb3`. Gates: tsc 0, vitest 64 + 27 nuevos. | ✓ W2 PASS |
| **F3 W3** | Tests finales + coverage | `guard8-intact.test.ts` extensión (caso flag gateway ON, guards byte-idénticos), cobertura AC-1 a AC-8. Commits: `608440a`. Gates: tsc 0, **vitest 730 tests total PASSED**. | ✓ W3 PASS |
| **AR** | Adversarial Review | 0 BLOQUEANTES. Evaluación: guards 1-8 intactos, fail-closed sin fallback, creds server-only, AC-4 (estrella, fail-closed sin bypass) verificado por replay-no-fallback en discover/compose. | ✓ AR APROBADO |
| **CR** | Code Review | 0 BLOQUEANTES. Calidad: tsc strict (0 any), tests 730/730 (sin drift), patrón fail-closed opaco (no leak de URL/KEY), idempotencyKey intacto, anti-mixto DT-4 confirmado (single flag quote+payout). **2 MNR opcionales documentados (sección Hallazgos finales)**. | ✓ CR APROBADO |
| **F4** | Validation + ACs | 8/8 ACs PASS con evidencia archivo:línea (validation.md completo). Drift = scope IN exacto (9 archivos + tests). Secrets = 0 matches `NEXT_PUBLIC_WASIAI*`, 0 console.* en gateway-client.ts. Gates estáticos: tsc 0, vitest 730 PASSED. | ✓ F4 APROBADO |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|-----|--------|-----------|
| **AC-1: Quote vía compose (flag ON)** | PASS | `app/api/a2a/quote/route.ts:36-50` rama `a2a-gateway` al tope; test `quote/route.test.ts:119-130` verifica `{GW}/discover` + `{GW}/compose`, `directCalls.toHaveLength(0)` |
| **AC-2: Payout vía compose post-guards (flag ON)** | PASS | `app/api/a2a/payout/submit/route.ts:372-399` post guard 8 (L364 comentario "A10"); guards 1-8 (L74-333) byte-idénticos; test `payout/submit/route.test.ts:1188-1199` |
| **AC-3: Discover antes de compose, sin slug hardcodeado** | PASS | `gateway-client.ts:49-69` (discover→pick→compose, `expectedSlug` desambigua); test `gateway-client.test.ts:43-89` verifica orden y fallback a agents[0] |
| **AC-4 (ESTRELLA): Fail-closed sin fallback** | PASS | `gateway-client.ts:55-93` (todo throw/!ok/shape→`unavailable`/`no_agent`, nunca lanza fallback); tests confirm: discover-throw, discover-vacío, guard-8-corta = `runViaGateway` NO llamado, `directCalls.toHaveLength(0)` |
| **AC-5: Gateway resuelve x402, Chaski autentica solo** | PASS | `gateway-client.ts:74-79` (único header `x-a2a-key`, sin firma/challenge); test `gateway-client.test.ts:177-192` (`raw.not.toContain("x402"/"signature"/"challenge")`) |
| **AC-6: Flag OFF byte-idéntico** | PASS | `quote/route.ts` diffstat 25+/1- (body movido, no cambia respuesta), `payout/submit/route.ts` 37+/0- (guards 1-8 intactos); tests `it.each(["fallback","a2a",undefined])` confirman fetch directo byte-idéntico incluso con envs de gateway seteadas |
| **AC-7: Creds server-only, nunca logueadas** | PASS | grep: 0 `NEXT_PUBLIC_WASIAI*`, 0 `console.*` en `gateway-client.ts`/routes; test `gateway-client.test.ts:195-226` (`not_configured` sin fetch + `serialized.not.toContain(KEY/URL)`) |
| **AC-8: idempotencyKey intacto + PII-free** | PASS | `gateway-client.ts:77-78` (`input: params.input` tal cual), `route.ts:377` (`input: body as Record<...>`); tests `payout/submit/route.test.ts:1201-1213` (`stepInput.idempotencyKey`/`beneficiary` intactos), `:1234-1242` (`raw.not.toContain("999888777")`) |

---

## Hallazgos finales

### BLOQUEANTES (F4)
- **0 BLOQUEANTES** en AR, CR ni F4. Pipeline QUALITY verde.

### MENORES — Follow-ups opcionales (NO bloquean DONE)

**MNR-1: Validación de `pick.slug` antes de armar el compose step**
- Ubicación: `gateway-client.ts:70-72`
- Hallazgo: La validación actual es `agents.length === 0 || pick == null`, pero no valida que `pick.slug` sea un string no-vacío.
- Recomendación: Agregar `pick.slug && pick.slug.length > 0` antes del compose. **Nota**: fail-closed de AC-4 ya lo cubre (si `slug` es inválido, compose 5xx se convierte en `unavailable`).
- Aplicar en: Próxima HU que toque `gateway-client.ts` (no crea deuda, hardening defensivo).

**MNR-2: Duplicación mapeo status→ledger en `payout/submit/route.ts`**
- Ubicación: `payout/submit/route.ts` línea ~380, mapeo de `ComposeResult.status` → ledger state
- Hallazgo: Existe duplicación del mapeo `status` (ej. `success → payout_success`) entre el forward de compose y la persistencia ledger.
- Justificación: CD-2 (DT-5) exige byte-identidad de los guards 1-8; cualquier refactoring común del mapeo rompe la garantía → la duplicación es intencional, no es deuda.
- Aplicar en: No aplicar (diseño confirmado, cero deuda).

---

## Auto-Blindaje consolidado

### Corrida limpia (sin ciclos de corrección)

Las 4 waves (W0→W3) pasaron el gate estático (`npx tsc --noEmit` + `npx vitest run`) en el primer intento de cada wave, **sin errores de tipo, sin tests rojos, sin re-trabajo**.

**Factores que evitaron errores (patrones seguidos, no descubiertos):**
- **Story File autosuficiente**: firma exacta de `runViaGateway`, tipos narrow del gateway, algoritmo fail-closed paso a paso, paths de import ya resueltos en F2 (Anti-Hallucination Checklist §3).
- **Exemplars byte-exactos**: type-guard `isRecord` (gateways.ts:42), route fail-closed opaco (quote/route.ts), test stubEnv+stubGlobal (quote/route.test.ts) copiados tal cual.
- **Ramificación aditiva**: quote y payout agregan una rama al tope/post-guard-8 dejando el bloque punto-a-punto intacto → cero riesgo de romper guards 1-8 ni byte-identidad flag OFF.

### Errores documentados (ninguno)
No hubo hallazgos críticos identificados durante F3 que requieran fix-pack.

---

## Archivos modificados (diff vs feat/032-wkh-227)

**Nuevos archivos:**
- `src/infrastructure/a2a/gateway-client.ts` (200 líneas, server-only helper)
- `src/infrastructure/a2a/gateway-client.test.ts` (300+ líneas, unit tests)

**Modificados (aditivos, byte-idéntico cuando flag ≠ `a2a-gateway`):**
- `app/api/a2a/quote/route.ts` (+25/−1)
- `app/api/a2a/quote/route.test.ts` (+cases gateway discover+compose+fail-closed)
- `app/api/a2a/payout/submit/route.ts` (+37/−0, guards 1-8 intactos, forward final cambiado)
- `app/api/a2a/payout/submit/route.test.ts` (+cases gateway)
- `app/api/a2a/payout/guard8-intact.test.ts` (+caso flag gateway ON)
- `src/composition/container.ts` (+2 líneas wiring, useA2a guard)
- `.env.example` (+11 líneas, docs nuevas WASIAI_A2A_*)
- `doc/sdd/_INDEX.md` (actualizado, este reporte)

**NO tocados (scope OUT confirmado):**
- `src/infrastructure/a2a/gateways.ts` (contrato client-side, intacto)
- `wasiai-a2a/**` (repo del gateway, SOLO LECTURA)

---

## Decisiones diferidas a backlog

### Aprovisionamiento de la Agent Key (Missing Input #1 — NO bloqueante para código, SÍ para e2e real)
- **Qué es**: crear y fondear la Agent Key de Chaski en el gateway `wasiai-a2a`.
- **Responsabilidad**: acción founder/ops-gated (fuera de scope de desarrollo).
- **Bloquea**: e2e real contra el gateway vivo (testnet/devnet). **NO bloquea** el código ni testing con gateway mockeado (ya completo).
- **Ticket relacionado**: WKH-173 (registro libre de agentes). Runbook esperado: similar a M5 de WKH-214 (HU-SOL-11).

### Confirmación de capability strings (Missing Input #2 — NO bloqueante para F2)
- **Qué es**: nombres exactos de las `capabilities` con las que `remit-corridor-fx`/`remit-cashout-payout` están registrados en el marketplace.
- **Cómo**: `GET /discover?q=remit-corridor-fx` manual contra el gateway, o parametrización por env como fallback.
- **Status**: parametrizable por env (`WASIAI_A2A_FX_CAPABILITY`, `WASIAI_A2A_PAYOUT_CAPABILITY`), **no bloqueante** si se deja vía env.

---

## Invariantes confirmados

| Invariante | Estado | Evidencia |
|------------|--------|-----------|
| **Guards 1-8 payout byte-idénticos** | ✓ CONFIRMADO | `payout/submit/route.ts` diffstat 37+/0- (zero deletions L74-333), tests `guard8-intact.test.ts:65-73` (`runViaGatewayMock).not.toHaveBeenCalled()`) |
| **Flag OFF byte-idéntico** | ✓ CONFIRMADO | Diffstat + tests `it.each(["fallback","a2a",undefined])` (quote/route.test.ts:190-206, payout/submit/route.test.ts:1266-1282) confirman fetch directo byte-idéntico |
| **Fail-closed sin fallback** | ✓ CONFIRMADO | AC-4 (estrella): discover-throw/discover-vacío/compose-throw → `unavailable`, nunca fallback al punto-a-punto; tests `quote/route.test.ts:132-151`, `payout/submit/route.test.ts:1215-1232` |
| **Creds server-only** | ✓ CONFIRMADO | grep 0 `NEXT_PUBLIC_WASIAI*`, 0 console.* (test AC-7), `gateway-client.ts` jamás usa creds en client |
| **Anti-mixto DT-4 preservado** | ✓ CONFIRMADO | Un solo flag `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` cablea quote+payout juntos (container.ts:71,84-85,89) |

---

## Lecciones para próximas HUs

1. **Ramificación aditiva = cero riesgo de byte-identidad**: agregar una rama al tope (quote) o después de guards finales (payout) sin tocar el bloque existente → garantía automática de AC-6. Patrón replicable para HU-233 (KYC via A2A, similar wiring en `authority.ts`).

2. **Story File autosuficiente elimina hallazgos de F3**: firma exacta de `runViaGateway`, tipos narrow, paths de import pre-resueltos en F2 → cero sorpresas de integración. Validar Anti-Hallucination Checklist en F2 con rigor (contrato HTTP real del gateway, no especulativo).

3. **Fail-closed exhaustivo es testeable**: un `try/catch` por fetch + shape validation con `isRecord` + `Array.isArray` es simple de test (mock de cada rama: throw, empty array, bad shape, success). Patrón replicable para HU-233 (KYC), HU-218 fase 2 (escrow Solana).

4. **Parametrización por env > hardcodeo de capabilities**: los strings de capability no son verificables desde código (dato de DB de otro repo) → parametrizar por env con defaults documentados. Evita redeploy si un agente se re-registra con capability distinto.

---

## Ready for merge

- ✓ Branch `feat/033-wkh-218-chaski-sobre-rieles-a2a`
- ✓ F0→F1→F2→F2.5→F3→AR→CR→F4 DONE
- ✓ 8/8 ACs PASS, 0 BLQ, 2 MNR opcionales (no-bloqueantes)
- ✓ Gates: tsc 0, vitest 730/730 PASSED
- ✓ Diff scope IN exacto, NO orphan files
- ✓ Dependencia única = aprovisionamiento founder-gated (NO bloquea código)

**Siguiente paso**: el orquestador integra en `feat/032-wkh-227-contratos-idl-golden` (rama de integración), y luego a `main` cuando el punta esté lista.
