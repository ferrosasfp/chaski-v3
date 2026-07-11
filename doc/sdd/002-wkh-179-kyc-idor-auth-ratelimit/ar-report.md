# Adversarial Review — WKH-179 (Cerrar IDOR PII + auth/rate-limit en /api/kyc/*)

**Veredicto**: APROBADO — 0 BLOQUEANTES, 2 MENOR (fixeados)
**Fecha**: 2026-07-10
**Branch**: `fix/179-kyc-idor-auth-ratelimit`
**Scope**: Código implementado en Wave 0–2 (helpers + rutas + integración)

---

## Hallazgos

### BLOQUEANTES
Ninguno. El diseño del token HMAC cierra el IDOR (AC-1/AC-2) correctamente con timing-safe compare. La rate-limit Upstash + fail-closed endurecen el DoS (AC-5/AC-6). El callback server-side cierra la SSRF (AC-8/AC-9).

### MENORs (3 — todos fixeados)

| # | Hallazgo | Archivo | Status | Fix |
|---|----------|---------|--------|-----|
| MNR-1 | IP source `x-forwarded-for` left-to-right spoofeable en Vercel (XFF `10.0.0.1, 192.168.1.1` → atacante finge ser 10.0.0.1) | `app/api/kyc/session/route.ts` | FIXEADO | Prioridad: `x-vercel-forwarded-for` (trusted) → `x-real-ip` (fallback) → XFF **right-most** solo como último recurso (L28: `parts[parts.length-1]`); test W1 `session/route.test.ts:62-73` |
| MNR-2 | Rate-limit IP condicionado a `body.vendorData` → un attacker sin `vendorData` no paga rate-limit | `src/infrastructure/rate-limit.ts` | FIXEADO | IP siempre se chequea, independiente de `address`. Default endurecido: `KYC_RL_IP_MAX=5` (antes propuesta 10). Test W0 `rate-limit.test.ts:71-79` |
| MNR-3 | `KYC_RL_IP_WINDOW` malformada (ej. `"diez minutos"`) pasa directo a `Ratelimit.slidingWindow` → potencial NaN/tipo error | `src/infrastructure/rate-limit.ts` | FIXEADO | Helper `win()` valida contra regex `/^\d+\s*(ms\|s\|m\|h\|d)$/` (L44-51); si no matchea → fallback a `"10 m"`. Test W0 `rate-limit.test.ts:81-88` |

**Verificación de fixes**: Ver `f4-report.md:60-77` (QA validó los 3 con tests en verde).

---

## Criterios de seguridad

✅ **IDOR**: Token HMAC stateless + timing-safe (CD-9, `kyc-auth.ts:31`).
✅ **PII**: `documentNumber` enmascarado en límite HTTP; `dateOfBirth`/nombres bajo auth check.
✅ **Financial-DoS**: Rate-limit Upstash antes de Didit; fail-closed en prod si no configurado.
✅ **SSRF/open-redirect**: Callback ignorado del body, reconstruido server-side.
✅ **Enumeración**: Mismo status/body para "sin token" y "token inválido" (CD-5).

---

## Notas de proceso

- Este AR corrió después de que los 3 MENORs fueron identificados y fixeados en Wave 2. No hubo **rechazo** del código (0 BLOQUEANTES), solo hallazgos de endurecimiento / defensa en profundidad que el Dev ya ha incluido en el working tree.
- La verificación del auto-blindaje (`auto-blindaje.md`) muestra dos lecciones de tipo-checking (`Duration`, `noUncheckedIndexedAccess`), ambas ortogonales a seguridad.

---

**AR APROBADO PARA CR (0 BLQ, 2 MNR fixeados, sin bloques)**
