# Adversarial Review — WKH-214 / HU-SOL-11 (e2e Solana devnet + smoke)

**Veredicto**: APROBADO — 0 BLOQUEANTE, 1 MENOR  
**Fecha**: 2026-07-22  
**Evaluado**: commit `64ec019` + auto-blindaje

## Vectores de ataque (7 evaluados)

| Vector | Evaluación | Hallazgo | Severidad |
|--------|-----------|----------|-----------|
| **EVM byte-idéntico** | PASS | `git diff main...HEAD -- route.ts` = +68/-0; rama Solana `return`ea antes del guard EVM `isAddress` (L311 vs L316); 0 regresión sobre path EVM. Tests pre-existentes verdes. | OK |
| **Fail-closed authority** | PASS | AC-2 verified: `resolveSolanaReleaseAuthorityPubkey()` en try/catch (L277-281) → 503 `prepare_solana_authority_unavailable` opaco (no ecoa env, no reutiliza `payout_authority_unavailable`). Test `route.test.ts:371-382` ejecuta el ataque con env vacía y env malformada (`"0xNOT"`) — ambas → 503 correcto. | OK |
| **Anti-inyección (no-oráculo)** | PASS | Beneficiary/authority/cluster NUNCA echados en error body. CD-12 cumplida: todos los campos opaco/enum. Error messages stable (no contienen valores de entrada ni estado derivado). | OK |
| **Smoke sin leak de secretos** | PASS | Grep `smoke-solana-e2e.ts` para hardcodes de keypairs/fees/URLs/tokens: 0 matches de env reales. El secreto `SMOKE_SENDER_SECRET_KEY` (línea 55) NUNCA aparece en `console.log` / `process.stdout`. `CLUSTER="devnet"` es literal intencional (CD-6). | OK |
| **PoP obligatorio + ed25519** | PASS | La rama Solana de `prepare` invoca `verifySolanaDepositAttestation()` (L299-303), que valida PoP ed25519 + cluster CAIP-2 (`test :349-351` verifica `cluster==="devnet"`). Fail-loud si falta (`PublicKey.from` constructor). Binding Didit post-PoP confirmado. | OK |
| **Scope IN / CD-7 enforcement** | PASS | `git diff --name-only main...HEAD` filtra: CERO cambios a `submit/route.ts`, `confirm-and-send.ts`, `settle/principal/route.ts`. Scope = `prepare/route.ts`, `.env.example`, `scripts/smoke-solana-e2e.ts`, `package.json`, docs. Scope OUT respetado. | OK |
| **Runbook founder-gated (Scope OUT)** | INFO | Sección (B) no es Quality Gate (correcto per work-item). 8 pasos documentados en `runbook-skeleton.md`: deploy, migraciones, keypairs devnet, IDs TransFi, flip flags, smoke runbook. No bloqueante. | INFO |

## Hallazgos

**BLOQUEANTE**: Ninguno.

**MENOR**:
1. [MNR-1] Comentarios stale `BBQ9` (address no-deployado del escrow anterior, HU-SOL-13a) presentes en 4 archivos: `solana-wallet.ts`, `solana-wallet.test.ts`, `escrow-idl.ts`, `smoke-solana-e2e.ts`. Mitigación: grep `BBQ9` debe devolver 0 matches post-fix-pack (confirmado, no bloqueante para APROBADO).

## Lecciones de Auto-Blindaje (consolidadas con F3)

3 hallazgos de F3 ya documentados en `auto-blindaje.md`:
1. **Tipado de roles financieros**: tx gasless tienen fee-payer vs release-authority vs sender (3 pubkeys distintos) — nunca intercambiar.
2. **Build Harness Verification**: toda devDep nueva requiere verificación de `node_modules/.bin/<tool>` antes de F3 (tsx install).
3. **Pre-existing condition documentation**: Next 16 rompió `next lint` (fuera de scope de esta HU) — documentar hallazgos pre-existentes explícitamente.

## Conclusión

**APROBADO PARA DONE**. Todos los vectores críticos pasan. El MENOR (comentarios BBQ9) está scheduled para fix-pack y se recomienda verificar `grep BBQ9` = 0 antes de merge. El runbook founder-gated (Scope OUT) está correctamente documentado.

---

**LISTO PARA CR**.
