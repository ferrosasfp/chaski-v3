# Report — HU [WKH-183] Chaski v2: higiene menor + 1 bug real

## Resumen ejecutivo

**6 fixes entregados** (V1-V6): 1 bug real (**KYC pendiente huérfano si localStorage falla**) + 2 mejoras de robustez (Money safe-int cap, FX doble redondeo eliminado) + 2 copy/docs (errores de wallet, comentario FallbackKycGateway siempre aprueba) + 1 corrección env.example (var muerta/var sin doc). **Status final: DONE**. Todos los 11 ACs en PASS, tsc/vitest/build verdes, 0 drift, 0 regresiones. **Archivos clave**: `kyc-pending-store.ts` (try/catch), `start-kyc.ts` (reorder), `flow-vm.ts` (humanError movido + copy wallet), `money.ts` (cap), `fallback/gateways.ts` (comentario + V4), `.env.example` (docs).

---

## Pipeline ejecutado

| Fase | Resultado | Notas |
|------|-----------|-------|
| **F0** | Grounding + HU_APPROVED (2026-07-10) | 8 ítems originales → **2 descartados** (resueltos por WKH-181/WKH-178), **6 vivos** (V1-V6). V1 confirmado como bug real (huérfano). |
| **F1** | Work-item.md (HU_APPROVED) | Contexto verificado al 2026-07-11 contra `main` @ `7838f33` (post WKH-178/179/180/181). |
| **F2** | SDD.md (SPEC_APPROVED) | Decisiones técnicas (DT-1..7) + Constraints (CD-1..9) + Waves (W1-W4) + Plan de tests (≥1 AC). Coordinación con WKH-182 (archivos compartidos). |
| **F2.5** | story-file.md | Contrato autocontenido para F3; anti-hallucination checklist; mapa AC↔archivo↔test. |
| **F3** | Implementación 4 waves (2026-07-11) | **W1** (dominio/infra puros): `money.ts` cap (AC-9) + `gateways.ts` comentario V3 (AC-7) + reorder V4 (AC-8). **W2** (bug real): `kyc-pending-store.ts` try/catch (AC-1) + `start-kyc.ts` reorder (AC-2/3/4) + doble `ThrowingKycPendingStore` (DT-7). **W3** (presentación): `humanError` movido a `flow-vm.ts` (AC-5/6 + DT-2) + import en `flow.tsx`. **W4** (docs): `.env.example` (AC-10/AC-11). **Re-verificación post-merge 182**: AC-10 resultó no-op (182 ya agregó `NEXT_PUBLIC_REOWN_PROJECT_ID`); V4 seguía vivo (182 no tocó línea 53). |
| **AR** | 0 BLQ, 0 MENOR | V1 diagnóstico exacto (huérfano evitado con reorder). V2-V6 sin riesgos (copy, docs, robustez técnica). CD-1..9 confirmados. |
| **CR** | 0 BLQ, 0 MENOR | Calidad consistente: try/catch normalizado, tests 100% aditivos (0 regresión), `noUncheckedIndexedAccess` respetado, imports verificados. No-regresión verificada: happy path, redirect→resume, fallback, FX observable. |
| **F4** | APROBADO PARA DONE (2026-07-11) | tsc 0, vitest 154/154 PASS, build OK. 11/11 ACs PASS (AC-10 documentado como no-op por 182). 0 drift, 0 findings pendientes. |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `kyc-pending-store.ts:8-14,25-31` — `save()`/`clear()` con try/catch, re-lanzan `new Error("kyc_pending_unavailable")` (no crudo). |
| AC-2 ⭐ | PASS | `start-kyc.ts:62-69` — reorder: `pending.save()` L62 ANTES de `repo.save()` L68. Test estrella `use-cases.test.ts:176-188` verifica que `repo.get(id).status === "created"` tras fallo (no huérfano en `kyc_pending`). |
| AC-3 | PASS | `flow.tsx:193-197` navegación gateada por `await execute()` exitoso. Si `pending.save()` falla, `execute()` rechaza ANTES de retornar `{kind:"redirect"}` → nunca llega a `window.location.href`. |
| AC-4 | PASS | `use-cases.test.ts:190-` — retry con store sano avanza sin `invalid_transition`. No-regresión: `use-cases.test.ts:158-167` (redirect→resume→passed) intacto y verde. |
| AC-5 | PASS | `flow-vm.ts:21-22` — `humanError("no_wallet")` → copy específico "no se detectó una wallet instalada". Test `flow-vm.test.ts:66-68`. |
| AC-6 | PASS | `flow-vm.ts:23-24` — `humanError("no_account"/"wallet_not_connected")` → "Reconectá o desbloqueá tu wallet". Test `flow-vm.test.ts:71-73`. |
| AC-7 | PASS | `gateways.ts:66-68` — comentario explícito "SIEMPRE aprueba... NUNCA representa un rechazo" + referencia gate WKH-180. Runtime sin cambio (`simulated()` L75-92 idéntico). |
| AC-8 | PASS | `gateways.ts:53` — `Money.of(netUsd * rate, "PEN")`, único redondeo. Comentario "sin doble round (V4)". Mismo monto observable en caso común. |
| AC-9 | PASS | `money.ts:22-24` — cap `> Number.MAX_SAFE_INTEGER` con `throw new Error("invalid_money_amount:${major}")`. Test `money.test.ts:25-29`: `Money.of(1e12, "USDC")` throws, `Money.of(1_000_000, "USDC")` no throws. |
| AC-10 | PASS (no-op, documentado) | `.env.example:49` — `NEXT_PUBLIC_REOWN_PROJECT_ID=` ya presente (agregado por WKH-182). Confirmado leído en `wallet.ts:156`. `auto-blindaje.md` documenta el no-op. |
| AC-11 | PASS | `.env.example:16-18` — `NEXT_PUBLIC_KYC_MODE` anotada `[DEPRECATED — no-op desde WKH-180]`. No se lee en `src/` (verificado `grep -r "KYC_MODE" src/` → 0 matches). NO se borra la línea (DT-5, documenta historial). |

---

## Hallazgos finales

**BLOQUEANTES**: 0 → Sin deuda bloqueante. V1 (bug real huérfano) resuelto con reorder + try/catch, evita brick permanente sin ampliar dominio.

**MENORES**: 0 → Sin deuda técnica aceptada. Batch de higiene limpio.

---

## Auto-Blindaje consolidado

| Lección | Aplicación |
|---------|------------|
| **Archivos compartidos (W1/W4)** | Cuando una HU declara "archivo COMPARTIDO con HU-N", grep del snippet exacto ANTES de editar. No anclar por número de línea del Story File (válidos pre-merge previo). Resultado: AC-10 documentado como no-op tras verificación (182 lo agregó ya), V4 confirmado vivo (182 no tocó línea 53). |
| **Reorder save/persist para no dejar agregados huérfanos (V1)** | Cuando un step de persistencia secundario (localStorage `pending.save`) puede fallar, va ANTES del `repo.save` que muta el agregado. Si el secundario lanza, el principal no corre → agregado sigue en último estado válido → retry usa transición legal sin brick. Aplicar en cualquier use-case que escriba en dos stores (auxiliar PRIMERO). |
| **Normalizar errores capturados (AC-1)** | Try/catch envuelto no debe lanzar `TypeError`/`DOMException` crudo. Re-lanzar con código tipado reconocible (`new Error("kyc_pending_unavailable")`) para que capas superiores (`humanError`, logging) puedan actuar. |
| **CD-5: Ordering de ramas con substring overlap** | Cuando un error code contiene substring (ej. `"kyc_pending_unavailable"` ⊇ `"kyc"`), su chequeo DEBE preceder al genérico o matchea el mensaje equivocado. Test explícito para verificar orden. |

---

## Archivos modificados

| Categoría | Archivos |
|-----------|----------|
| **Dominio** | `src/domain/money.ts` (cap safe-int, AC-9) |
| **Infra/Port** | `src/infrastructure/kyc-pending-store.ts` (try/catch, AC-1) · `src/infrastructure/fallback/gateways.ts` (V3 comentario AC-7 + V4 reorder AC-8) |
| **Use-cases** | `src/application/use-cases/start-kyc.ts` (reorder, AC-2/3/4) |
| **Presentación** | `src/presentation/flow-vm.ts` (mover + exportar `humanError`, AC-5/6) · `src/presentation/flow.tsx` (importar `humanError`) |
| **Test support** | `src/test-support/fakes.ts` (agregar `ThrowingKycPendingStore`, DT-7) |
| **Tests** | `src/application/use-cases.test.ts` (casos V1, AC-1/2/3/4) · `src/presentation/flow-vm.test.ts` (casos `humanError`, AC-5/6) · `src/domain/money.test.ts` (caso cap, AC-9) |
| **Docs/Config** | `.env.example` (AC-10/11, vars wallet/KYC mode) |

**Total**: 11 archivos de código + config, 100% aditivos en tests (0 regresión).

---

## Decisiones diferidas a backlog

Ninguna. El batch de 6 fixes cierra sin spinoffs. Los 2 ítems descartados en F0 ya están resueltos por WKH-181/WKH-178 (no se reabren). La higiene P3 se completa acá; no hay pendiente de auditoría 2026-07-10 relacionada con chaski-v2 abierta post WKH-178/179/180/181/182/183.

---

## Lecciones para próximas HUs

1. **Coordinación de merge en archivos compartidos** — cuando N HUs tocan el mismo archivo, anclar por contenido (snippet exacto) en lugar de números de línea del Story File. Story Files se escriben pre-merge previo; orden real puede diferir. Marcar explícitamente qué ACs quedaron no-op tras merge anterior (ejemplo: AC-10 cubierto por WKH-182).

2. **Reorder de persistencia para evitar huérfanos** — caso de uso general (no solo KYC): cuando hay 2 persistencias en serie (auxiliar + principal) en un use-case, si la auxiliar puede fallar, va PRIMERO. Si falla, la principal no corre → estado persisted sigue en último válido → retry legal. No hay que tocar dominio ni compensación.

3. **Try/catch normaliza, no swallow** — excepciones del browser (`DOMException`, `TypeError`) deben ser re-lanzadas con código aplicativo tipado. Capacita capas superiores (presentación, logging) a reaccionar. No silenciar excepciones.

4. **Test de ordering con substring overlap** — cuando 2 códigos de error comparten substring, el test debe verificar explícitamente que el orden de chequeo en `humanError` no confunde los mensajes. Evita bugs de copy que reaparecen cuando se reordena.

---

## Status final

✅ **DONE** — 2026-07-11

- Report completado: este archivo (`done-report.md`)
- `_INDEX.md` actualizado: WKH-183 = DONE
- Artefactos cerrados: `ar-report.md` (APROBADO), `cr-report.md` (APPROVED), `f4-report.md` (APROBADO PARA DONE)
- Auto-blindaje consolidado: 2 lecciones de coordinación/persistencia extraídas
- Sin pendientes de orquestador: pipeline cerrado
