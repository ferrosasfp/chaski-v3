# Adversarial Review — WKH-186 (Value-delivery scaffolding)

**Veredicto: APROBADO CON 2 MENOR**

**Fecha**: 2026-07-11  
**Branch**: `feat/186-value-delivery-scaffolding-a2a-eip3009-ready`  
**Revisión**: Commit `eebc7a3` + waves W0-W4 `c1e08da`/`d285788`

---

## 1. Hallazgos

### BLOQUEANTES
Ninguno.

### MENOR
| Item | Ubicación | Descripción | Fix-pack aplicado |
|------|-----------|-------------|------------------|
| **MNR-A** | `src/infrastructure/chain.ts:35-39` | `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` sin validar → potencial cast a `0x...` malformado (checksum inválido) entraría a `wallet.ts` sin validación. Falta `isAddress()` explícito + throw en `createContainer()`. | ✅ Aplicado: `resolveReceiverAddress()` con `isAddress()` fail-loud; `container.ts:66` calla función; `wallet.ts:73,187` usan función en vez de cast crudo. 2 tests nuevos verdes. |
| **MNR-B** | `src/infrastructure/a2a/gateways.ts:137-153` | `status()` cache-miss (no existe un submit previo registrado) devolvía `status:"failed"` → dispara falsa refund en `TrackRemittance` sin razón legítima. Debería devolver `status:"submitted"` (no-terminal). | ✅ Aplicado: cache-miss ahora devuelve `status:"submitted"` + `failureReason:"payout_status_unknown"`. `TrackRemittance` NO transiciona a `payout_failed`. Tests `gateways.test.ts` + `track-remittance.test.ts:119-130` verdes. |

**Conclusión**: 0 BLOQUEANTES, 2 MENOR fixeados, **APROBADO**.

---

## 2. Garantía money-path (CD-2)

Verificado:
- 6 capas independientes previenen dinero real por default (adapter, fallback, wallet, refund, routes, guard).
- Ningún env var nuevo tiene default peligroso.
- `REMIT_AGENTS_BASE_URL` server-only, sin NEXT_PUBLIC_.
- `LedgerRefundGateway` ledger-only, documentado.

**Money-path PASS.**

---

## 3. Scope

Diff 100% dentro de `chaski-v2/` (27 archivos, código+tests+docs). CD-1 **PASS**. Sin modificaciones a `wasiai-remittance-agents` ni `wasiai-a2a`.

---

## 4. Veredicto final

**APROBADO PARA CR** — 0 BLOQUEANTES, 2 MENOR fixeados, garantía money-path verificada.
