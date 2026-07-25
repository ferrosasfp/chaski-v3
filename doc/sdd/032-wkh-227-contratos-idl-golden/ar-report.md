# AR Report — WKH-227 / HU-SOL-24 (Contratos A2A tipados + IDL versionado + golden EVM)

**Veredicto: APROBADO con MENOR (0 BLOQUEANTE).**
Fecha: 2026-07-23 · Repos: `wasiai-remittance-agents` (W1), `wasiai-facilitator` (W2), `chaski-v3` (W3).

## Verificación ejecutada (no declarativa)
- `tsc --noEmit` clean en los 3 repos.
- Tests: remit **166**, facilitator **1004**, chaski **695** — todos verdes.
- IDL hash recomputado independientemente vs `solana-programs/target/idl/escrow.json` → `aa53c03f…5fb71` == pinneado EXACTO.
- **Experimento de drift real**: mutación `maxTimeoutSeconds` 60→999 en el golden #3 → ROJO (aislado), restaurado byte-idéntico. Confirma freeze byte-exacto.

## Vectores atacados
1. **¿Los contract tests detectan drift? (AC-1) — OK.** No son laxos: quote (`contracts.quote.test.ts:42-52` drift `feeUsd→feeUsd2` exige 502 + throw), payout (`:46-50` status drift → throw), settle (`:111` `toEqual` body completo, no `toMatchObject`), kyc (shape-guard forward-looking documentado — chaski no consume KYC en prod). Probado en vivo.
2. **Determinismo golden (AC-4) — OK.** Input 100% fijo, nonce = `keccak256("rmt_fixed_0001:q_fixed_0001")` determinístico, sin `Date.now()`/random en las rutas ejercitadas (el único `Date.now()` de `wallet.ts:174` está en la rama demo, no en `authorizePrincipal`).
3. **Hash IDL correcto/robusto (AC-2/AC-3) — OK.** Canonicalización estable (sort keys, orden de arrays preservado). Nivel 2 sibling con `it.skip` limpio.
4. **Cero cambio runtime (CD-1) — OK.** Solo aditivo salvo `chaski-v3/tsconfig.json` +1 línea `include` (type-check-only; `contracts/` no alcanzable desde `app/` → no se bundlea; `next build` verde).
5. **Inconsistencia cross-repo /settle — MENOR.** Ver MNR-1.
6. **PII/secrets — OK.** Fixture KYC sin `legalId`/DNI/`travelRuleData` (aserción negativa `not.toContain`); sin secrets reales (`DEPOSIT_ATTESTATION_SECRET="golden-fixed-secret"` es de test).

## Findings
- **MNR-1 (Integration/traceability)** `wasiai-facilitator/src/contracts/settle-eip3009.body.fixture.ts:25`: el fixture origen usa nonce placeholder `0x`+`cd`×32 divergente del nonce determinístico real re-pinneado en la copia vendoreada de chaski. NO rompe el contrato (el nonce es consumer-generado, no campo del provider); riesgo solo de confusión al re-vendorear. Documentado en CONTRACT-VERSIONS.md §CD-4. → fix-packeado (comentario inline).
