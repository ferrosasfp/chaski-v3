# Adversarial Review — WKH-182 Money-path robustez

**Veredicto**: APROBADO (0 BLOQUEANTES, 3 MENOR)  
**Fecha**: 2026-07-11  
**Branch**: `fix/182-money-path-robustez`

## Hallazgos

| # | Tipo | Código | Descripción | Resolución |
|----|------|--------|-------------|-----------|
| MNR-1 | MENOR | chain-hardcode | `src/infrastructure/wallet.ts` importa `avalanche` (43114) directamente en vez de resolvarlo de env; `chains: [43114]` hardcodeado en WalletConnect init (M1). | **FIJADO en F3**: creado `src/infrastructure/chain.ts` con `resolveChainId()`/`resolveChain()` como única fuente; ambos wallets (InjectedWallet, WalletConnectWallet) usan `resolveChainId()` ahora (AC-7/CD-5). |
| MNR-2 | MENOR | expiry-window | Entre `confirm()` (que chequea expiry en T1) y `payouts.submit()` pueden pasar minutos (wallet.authorizePrincipal espera firma real del usuario); el quote puede expirar en esa ventana sin re-chequeo (M2). | **FIJADO en F3**: dos `isQuoteStillValid()` checks: 1º después de autoridad WKH-180 (pre-firma), 2º después de `authorizePrincipal` (post-firma). Si expira en cualquiera: `markPayoutFailed("quote_expired_before_submit")` + return sin submit (AC-5/DT-3). Verificado en test: `ScriptedClock([T0,T0,T0,18:11])` propaga `payout_failed`, firma SÍ ocurre, submit NO. |
| MNR-3 | MENOR | save-final-position | El `repo.save()` final tras `payouts.submit()` vive dentro del try/catch — si falla, el payout se registra en el backend pero la remesa no transiciona a `payout_submitted`. Risk: inconsistencia de caché local vs persistencia remota en flow real. | **NO REQUIERE ACCIÓN**: fail-loud es correcto (propaga, alerta operador, la idempotencyKey del payout previene doble-submit en retry). Documentado en §3.1 de SDD como riesgo aceptado (post-hoc, la plata ya se movería en versión real). |

## CDs verificados
- **CD-1** (solo `chaski-v2/`): PASS — git diff sin rutas externas.
- **CD-2** (orden guards CAS→expiry→firma→submit): PASS — verificado en `confirm-and-send.ts` línea 29-99.
- **CD-3** (validación pura, sin I/O): PASS — `assertReceiveConsistent` sin `Date.now()`.
- **CD-4** (fail-loud CAS): PASS — `ConcurrentModificationError` propagado, test rechaza persistencia del ganador.
- **CD-5** (chain única fuente): PASS — `chain.ts` es la única fuente, ambos wallets importan de ahí.

**Recomendación**: MNR-1/MNR-2 resueltos en el fix-pack (1 MENOR residual: MNR-3, aceptado como comportamiento correcto).
