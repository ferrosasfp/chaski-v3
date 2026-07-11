# CR — Code Review — WKH-181
**Repo**: `chaski-v2/` · **Branch**: `fix/181-pii-persistence-history-per-wallet` · **Fecha**: 2026-07-11
**Commit base**: `66c822b`

## Veredicto: APPROVED — 0 BLOQUEANTES + 0 MENORES

---

## Resumen de revisión

| Aspecto | Hallazgo | Evidencia |
|---------|----------|-----------|
| **Implementación de ACs** | 12/12 activos PASS, AC-8 correctamente diferido (sin código en `wallet.ts`) | `git diff main...66c822b -- src/infrastructure/wallet.ts` → 0 cambios; f4-report.md §2 |
| **Helper único (CD-2)** | `toPersistedIdentity` es el único reductor de PII; sin duplication logic en persistencia/kycstore | `remittance.ts:52-61`; `normalizeIdentity` en `persistence.ts`/`kyc-store.ts` LLAMA, no duplica |
| **Upstream reduction (CD-6)** | Todos los productores de `KycVerification.identity` embudan por `toPersistedIdentity` (gateways + fakes) | `kyc-gateway.ts:47`, `fallback/gateways.ts:79`, `test-support/fakes.ts:87` |
| **Type safety** | `PersistedIdentity` distinto de `VerifiedIdentity` (frontera); no type-lie | `remittance.ts:52-61` tipado explícitamente; `flow.tsx:519` accede `.documentNumberLast4` |
| **Case-insensitive filtering (CD-5)** | `list(address)` filtra con `.toLowerCase()` en ambos accesos | `persistence.ts:105-107`, `kyc-store.ts:90-95` |
| **Regresión WKH-179 (CD-8)** | `maskIdentity`/`maskDecision` + `/api/kyc/*` sin diff | `git diff main...66c822b -- decision.ts:56-70, src/app` → 0 cambios |
| **Regresión WKH-180 (CD-8)** | `vendorData` en `decision.ts` confinado, tests intactos | `decision.ts:14,21,65` sigue present; `decision.test.ts:60-69` verde |
| **Story File anchor (W1-W3)** | Commit único refleja W1→W2→W3; un desvío mecánico de test en `confirm-and-send.test.ts` (cambio de firma de `startKyc`) | `git diff --stat` muestra 17 archivos; 16 matched Story File, 1 test (ripple obligatorio) |
| **Constraints** | CD-1 (chaski-v2 only), CD-2 (helper), CD-3 (sin 4to riskLevel), CD-4 (no encryption), CD-5 (case-insensitive), CD-6 (upstream), CD-7 (no wiring changes), CD-8 (no masking/api change), CD-9 (noUncheckedIndexedAccess), CD-10 (no hand-rolled types) — todas verificadas | Ver §5 de f4-report.md |
| **TTL + Legacy defensivo** | `kyc-store.ts:81-95` normaliza TODAS las entries; `persistence.test.ts` asserta parse robusto | `kyc-store.test.ts:102-144` (scrub completo); `persistence.test.ts:113-139` (legacy crash-free) |
| **riskLevel extensible (AC-9/10)** | `resolveRiskLevel` defensivo — lee campo candidato SOLO si presente y válido; fallback binario en default | `decision.ts:32-36`, `decision.test.ts:83-104` cubre todos los casos |

---

## Conclusión

Sin hallazgos bloqueantes. La arquitectura es limpia: reducción en el punto justo (upstream de state), type-honesty, helpers únicos, defensiva contra legacy. Las pruebas son exhaustivas (122/122) y cubren edge cases (legacy corruption, colapso riskLevel, etc.). Merge-ready.

**Aprobado para DONE.**
