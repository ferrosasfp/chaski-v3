# CR Report — WKH-227 / HU-SOL-24 (Contratos A2A tipados + IDL versionado + golden EVM)

**Veredicto: APROBADO con MENOR (0 BLOQUEANTE).**
Fecha: 2026-07-23 · Test-infra 100% aditiva, sin cambio runtime (CD-1). Gates: `tsc --noEmit` clean en los 3 repos; remit 166 · facilitator 1004 · chaski 695 verdes.

## Checklist
1. **Corrección — OK.** Los replay tests invocan validadores REALES del consumer (no reimplementan): `contracts.quote.test.ts:8,36,63` (handler POST real + `A2aQuoteGateway`), `contracts.payout.test.ts:39` (`A2aPayoutGateway.submit`), `contracts.settle.test.ts:109` (body real de `broadcastSettle`), facilitator `contracts.provider.test.ts:15,21` (schemas `.strict()` reales), remit `:12-14` (`run*()` reales + `parse()`). Único shape-guard reimplementado = KYC (forward-looking, chaski no consume KYC en prod, documentado). Helper `canonical-hash.ts` correcto (arrays preservan orden, objetos ordenan keys, null manejado).
2. **CD-8 (WKH-208) — OK.** `contracts.quote.test.ts:8` importa solo `{ POST }`; nada exportado desde `route.ts` (tsc full con `.next/types` verde).
3. **Determinismo golden — OK.** Inputs fijos, envs stubeadas, `UPDATE_GOLDEN` documentado en `golden/README.md` + `CONTRACT-VERSIONS.md`.
4. **Duplicación helper hash — OK.** `facilitator/src/chains/canonical-hash.ts` ≡ `chaski/contracts/idl/canonical-hash.ts` algorítmicamente idénticos; mismo hash `aa53c03f…fb71` verificado en ambos.
5. **Naming/headers — OK.** Los 4 vendoreados con header AC-7 "COPIA PINNEADA…" + origen + `Sync: 2026-07-22`. Sin `any`, sin `console.*`.
6. **No regresión — OK.** Suites previas verdes con mismas assertions; `tsconfig.json` +1 línea `include` no rompe next build.
7. **CONTRACT-VERSIONS.md — OK.** Tabla de vendoreados + sección CD-4 (nonce W2 divergente) + deuda de sync cross-repo.

## Findings
- **MNR-1 (naming/consistencia)** `wasiai-facilitator/src/contracts/settle-eip3009.body.fixture.ts:1-4,25`: header dice "byte-a-byte" pero el nonce es placeholder divergente del real. Riesgo: re-vendorear verbatim → falso-rojo en `contracts.settle.test.ts:111`. No bloquea (test-only). → fix-packeado (comentario inline aclaratorio).

## Observaciones (no findings)
- Relocación `contracts/` → `src/contracts/` en remit + facilitator (vs SDD §4.1): correcta, evita tocar `vitest.config.ts` (`include: src/**`), documentada en auto-blindaje.
