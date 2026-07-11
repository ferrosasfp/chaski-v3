# Code Review — WKH-179 (Cerrar IDOR PII + auth/rate-limit en /api/kyc/*)

**Veredicto**: APPROVED — 0 BLOQUEANTES, 1 MENOR (fixeado)
**Fecha**: 2026-07-10
**Branch**: `fix/179-kyc-idor-auth-ratelimit`
**Scope**: 17 archivos modificados/creados (Waves 0–2)

---

## Hallazgos

### BLOQUEANTES
Ninguno. Guard-order en ambas rutas sigue exacto la especificación (501 → 500 → auth/rate-limit → Didit → issue/mask). No hay deslices en el orden de evaluación (CD-2 cumplido). Tests automáticos en verde (79/79, `vitest`).

### MENORs (1)

| # | Hallazgo | Archivo | Status | Fix |
|---|----------|---------|--------|-----|
| MNR-3 | Rate-limit `KYC_RL_IP_WINDOW` env var no validada antes de pasar a `Ratelimit.slidingWindow()` | `src/infrastructure/rate-limit.ts` | FIXEADO | Helper `win()` + regex validation (L44-51); fallback a `"10 m"` si malformada. Test `rate-limit.test.ts:81-88` verifica `"diez minutos"` → fallback. |

**Verificación**: Ver `f4-report.md:72-75` (QA validó con test en verde).

---

## Calidad de código

✅ **Tipado**: `tsc --noEmit` = 0 errores; `noUncheckedIndexedAccess` respetado (auto-blindaje.md documenta el patrón).
✅ **Tests**: 16 tests cobriendo ≥1 por AC (AC-1…AC-10); pattern `vi.stubGlobal("fetch") + afterEach(restoreAllMocks)` consistente.
✅ **Masking puro**: `maskIdentity` en `decision.ts:60-65` sin I/O; función testeable isolada.
✅ **Crypto**: `node:crypto` (`createHmac`, `timingSafeEqual`); sin `jsonwebtoken`/`jose`.
✅ **No-regresión**: `FallbackKycGateway.decision()` sigue asignable (firma con menos params); simulación intacta.
✅ **Scope**: Cero drift; `src/presentation/*` sin tocar (CD-6 cumplido).

---

## Recomendaciones (no-bloqueantes)

1. **`.env.example` comentario desactualizado**: L24 dice default `10` por IP pero real es `5` (endurecido en MNR-2). Cosmético, recomendar fix en patch siguiente.
2. **Documentación token HMAC**: Agregar en `kyc-auth.ts` (docstring) que el token **NO** prueba posesión de wallet — es replayable si se filtra; SIWE queda deferred.

---

## Constraint Directives — 15/15 cumplidos

Verificados: CD-1 (scope), CD-2 (guard-order), CD-3 (no hardcodes), CD-4 (501 primero), CD-5 (anti-enum), CD-6 (no presentación), CD-7 (500 sin secret), CD-8 (masking edges), CD-9 (timing-safe), CD-10 (token names), CD-11 (Upstash), CD-A (node:crypto), CD-B (puro), CD-C (vitest), CD-D (runtime Node).

---

**CR APPROVED PARA READY (0 BLQ, 1 MNR fixeado, lecciones documentadas)**
