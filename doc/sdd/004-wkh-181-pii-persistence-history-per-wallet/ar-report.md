# AR — Adversarial Review — WKH-181
**Repo**: `chaski-v2/` · **Branch**: `fix/181-pii-persistence-history-per-wallet` · **Fecha**: 2026-07-11
**Commit base**: `66c822b`

## Veredicto: APROBADO — 0 BLOQUEANTES + 1 MENOR (FIXEADO)

---

## Hallazgos

### Bloqueantes: 0

---

### Menores: 1

| ID | Título | Severidad | Descripción | Estado |
|----|--------|-----------|-------------|--------|
| MNR-1 | PII legacy no scrubbeada proactivamente en kyc-store | MENOR | El `read()` defensivo de `LocalKycStore` solo normalizaba la entry de la address consultada vía `get(address)`. Una entry legacy (completa) de **otra address** podía sobrevivir indefinidamente en el string de `localStorage` si esa address nunca volvía a hacer `save()`. Exponía PII cruda a inspección local sin garantía de scrub. | ✅ RESUELTO |

**Fix verificado** (`src/infrastructure/kyc-store.ts:81-88`): `private read()` itera TODAS las entries del mapa crudo, descarta las legacy-bare y normaliza cada entry válida vía `toPersistedIdentity` (helper único, CD-2). `save()` persiste el mapa YA saneado completo, no solo la entry tocada. Test dedicado (`kyc-store.test.ts:102-144`) asserta sobre el string crudo: PII legacy de otra address desaparece post-`save()` de una tercera dirección. **MNR-1: RESUELTO en el fix-pack.**

---

## Resumen

- **Security posture**: tipos y helpers leídos upstream de persistence (`toPersistedIdentity` en productores de KYC), garantiza que PII cruda nunca entra al estado del cliente. Read defensivo + normalization-on-write (AC-4) cierran el gap legacy.
- **Edge cases**: colapso FallbackWallet (AC-8) diferido intencionalmente por decisión de producto (D2). Sin ese fix, historial por-wallet no aísla a usuarios de teléfono compartido sin wallet real. AC-5/6/7 SÍ se implementan (sirven a usuarios con wallet real).
- **Type safety**: `PersistedIdentity` vs `VerifiedIdentity` (frontera Didit) mantiene la separación; no hay type-lie.

**Aprobado para CR.**
