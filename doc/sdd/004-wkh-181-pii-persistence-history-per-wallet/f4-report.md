# F4 — Validación + Quality Gates — WKH-181

**Repo**: `chaski-v2/` · **Branch**: `fix/181-pii-persistence-history-per-wallet` · **Fecha**: 2026-07-11
**Commit base**: `66c822b` (fix WKH-181) + fix-pack MNR-1 sin commitear en working tree.

**Veredicto: APROBADO PARA DONE**

---

## 1. Runtime gates (ejecutados por QA — no había cr-report.md/ar-report.md en disco)

| Gate | Comando | Resultado |
|------|---------|-----------|
| Typecheck | `npx tsc --noEmit` | ✅ exit 0 — "TypeScript compilation completed" |
| Tests | `npx vitest run` | ✅ exit 0 — `PASS (122) FAIL (0)` |
| Build | `npm run build` (`next build --webpack`) | ✅ exit 0 — "Compiled successfully" + TS + páginas generadas |

Nota: no se encontró `cr-report.md` ni `ar-report.md` en `doc/sdd/004-wkh-181-.../`. El mensaje del commit `66c822b` documenta "Tests: +22 (121 total verde). tsc 0 errores. next build OK." — consistente con lo re-verificado acá. El working tree tiene además 3 archivos modificados sin commitear (`kyc-store.ts`, `kyc-store.test.ts`, `tsconfig.tsbuildinfo`) correspondientes al fix-pack del MNR-1 (ver §3); quedaron incluidos en el conteo de 122 tests corridos.

---

## 2. ACs (12 activos + AC-8 diferido)

| AC | Status | Evidencia | Método |
|----|--------|-----------|--------|
| AC-1 | ✅ PASS | `src/domain/remittance.ts:52-61` `toPersistedIdentity` dropea `documentNumber`/`dateOfBirth`/`nationality`; `src/domain/remittance.test.ts:137-141` edge cases `""→""`,`"12"→"12"`,`"1234"→"1234"`,`"12345"→"2345"` | Read + test |
| AC-2 | ✅ PASS | `src/infrastructure/kyc-store.test.ts:58-75` asserta sobre el STRING serializado: `expect(raw).not.toContain("44556677"/"dateOfBirth"/"nationality"/"1990-05-14")`; wrapper `{v,savedAt}` confirmado (`kyc-store.ts:97-99`) | Test + Read |
| AC-3 | ✅ PASS | `src/domain/remittance.ts:52-61` conserva `firstName/lastNamePaternal/lastNameMaternal/documentType`; `flow.tsx:516-519` los renderiza | Read |
| AC-4 | ✅ PASS | `persistence.test.ts:113-125` ("no crashea al leer y normaliza... dropea PII cruda"); `persistence.test.ts:134-139` (raw corrupto → mapa vacío, no crash); `kyc-store.test.ts:148-164` (legacy bare→null, corrupto→null) | Test |
| AC-5 | ✅ PASS | `persistence.test.ts:50-61` "AC-5: devuelve SOLO entries del address, case-insensitive" (`0xaaa`/`0xAAA` matchean, `0xbbb` no) | Test |
| AC-6 | ✅ PASS | `use-cases.test.ts:174` (nombre del test: "tras startKyc, el snapshot persistido queda con ownerAddress == caller.address"); implementado en `start-kyc.ts:33` `r.startKyc(this.clock.nowIso(), input.address)` | Test + Read |
| AC-7 | ✅ PASS | `persistence.test.ts:63-73` "AC-7: remesa sin owner (created, nunca verificó) queda EXCLUIDA de cualquier list scopeada"; `persistence.test.ts:127-132` legacy sin ownerAddress → excluida | Test |
| AC-8 | ⏸ DIFERIDO (documentado, D2) | `wallet.ts` sin diff: `git diff --stat main...66c822b -- src/infrastructure/wallet.ts` → sin output (0 cambios). Fuera de scope de código por decisión de producto (SDD §9, Story File "Out of Scope") | Read + git diff |
| AC-9 | ✅ PASS | `decision.test.ts:83-91` "AC-9: risk_level fino reconocido ('medium') se PRESERVA" + variante `'high'` | Test |
| AC-10 | ✅ PASS | `decision.test.ts:93-96` "AC-10: sin campo risk_level → fallback binario... sin regresión" | Test |
| AC-11 | ✅ PASS | `decision.test.ts:98-104` "AC-11: valor no reconocido ('extreme') → fallback binario, NUNCA un 4to valor (CD-3)" | Test |
| AC-12 | ✅ PASS | `use-cases.test.ts:184` (nombre: "flujo fallback (sin sandbox Didit) queda verde con identity REDUCIDA presente"); `fallback/gateways.ts:79-88` mantiene fixture "María Elena / Quispe / Mamani" reducido vía `toPersistedIdentity` | Test + Read |
| AC-13 | ✅ PASS | `flow.tsx:519` `••••{rem.kyc.identity.documentNumberLast4}` (cambio único de presentación); nombres L516-518 intactos; typecheck 0 errores confirma el tipo | Read + tsc |

**12/12 ACs activos PASS. AC-8 correctamente diferido y sin código (verificado: `wallet.ts` con 0 diff).**

---

## 3. Verificación del fix-pack MNR-1 (scrub comprensivo de PII legacy en kyc-store)

**Hallazgo original**: el read defensivo legacy solo saneaba la entry de la address consultada; una entry legacy de OTRA address (PII cruda) podía sobrevivir indefinidamente en el string de `localStorage` si esa address nunca volvía a hacer `save()`.

**Fix verificado** (`src/infrastructure/kyc-store.ts:81-88`): `private read()` ahora itera TODAS las entries del mapa crudo, descarta las legacy-bare (`isEntry` false) y normaliza el `identity` de cada entry válida vía `normalizeIdentity` (que embuda por el helper único `toPersistedIdentity`, CD-2). `save()` (L97-99) persiste el mapa YA saneado completo, no solo la entry tocada.

**Evidencia del test nuevo** (`kyc-store.test.ts:102-144`, `describe("LocalKycStore — scrub comprensivo de PII legacy (MNR-1)")`):
- Siembra manualmente `0xa` con identity FULL legacy (`documentNumber`/`dateOfBirth`/`nationality` en claro) y `0xb` ya reducida.
- Llama `store.save("0xC", kyc)` — un `save` de una tercera address, no de `0xa`.
- Asserta sobre el string crudo post-save: `expect(raw).not.toContain("44556677"/"dateOfBirth"/"nationality"/"1990-05-14")` → la PII de `0xa` desapareció del string aunque el save fue de `0xC`.
- Asserta shape: `0xa` quedó con `documentNumberLast4 === "6677"`, `0xb` intacta, `0xc` agregada.

**`get()` legacy→null intacto**: `kyc-store.test.ts:147-153` "entry legacy bare (KycVerification sin savedAt) → get null (non-crashing)" sigue verde — el comportamiento AC-4 original no regresionó.

Verificado en el run de `vitest run` (122/122 verde, incluye este describe block). **MNR-1: RESUELTO.**

---

## 4. Regresión crítica (WKH-179 / WKH-180)

- **WKH-179** (`maskIdentity`/`maskDecision`, `decision.ts:73-83`): sin diff en esas líneas (`git diff main...66c822b -- decision.ts` solo toca `DiditRaw`+`resolveRiskLevel`+línea `riskLevel:`, L17-36). Tests `decision.test.ts:117-155` (masking) siguen presentes y verdes. `app/api/kyc/*` sin diff (`git diff --stat main...66c822b -- src/app` → vacío).
- **WKH-180** (gate server-side + `vendorData`): `decision.ts` conserva `vendor_data?`/`vendorData` intacto (L14, L21, L65); `decision.test.ts:60-69` (vendorData) sigue verde. `container.ts`, `confirm-and-send.ts`, `resume-kyc.ts` — 0 diff (CD-7 respetado).
- **Review muestra nombre + doc last-4**: `flow.tsx:514-521` confirmado por Read (§2 AC-13).

---

## 5. Drift Detection

- **Scope**: 17 archivos tocados en `git diff --name-only main...66c822b -- src/`. 16 matchean la tabla "Files to Modify/Create" del Story File. El 17mo (`src/application/use-cases/confirm-and-send.test.ts`) es un cambio de 1 línea (`r.startKyc(T0)` → `r.startKyc(T0, "0xSender")`) — ripple mecánico obligatorio por el cambio de firma de `startKyc` (W1), NO modifica `confirm-and-send.ts` (el archivo prohibido por CD-7 es el `.ts` de implementación, no su test). **Drift menor, justificado y sin impacto — no bloquea.**
- **wallet.ts**: 0 diff — confirmado AC-8 diferido respetado.
- **Waves**: commit único `66c822b` con W1→W2→W3 reflejados en el diff (contratos de dominio + persistencia/store + producers/AML), consistente con el orden declarado.
- **CDs**:
  - CD-1 (solo `chaski-v2/`): ✅ — repo es standalone, sin paths fuera.
  - CD-2 (helper único): ✅ — `toPersistedIdentity` es la única función reductora (`remittance.ts:52-61`); `normalizeIdentity` en `persistence.ts`/`kyc-store.ts` la LLAMA, no duplica lógica.
  - CD-3 (sin 4to riskLevel): ✅ — `resolveRiskLevel` (`decision.ts:32-36`) + test AC-11.
  - CD-5 (case-insensitive): ✅ — `persistence.ts:105-107`, `kyc-store.ts:90-95` (`.toLowerCase()` en ambos lados).
  - CD-6 (reducción aguas-arriba): ✅ — los 3 productores (`kyc-gateway.ts:47`, `fallback/gateways.ts:79`, `fakes.ts`) embudan por `toPersistedIdentity`; `persistence.ts`/`kyc-store.ts` solo serializan + normalizan legacy (defensivo).
  - CD-7 (no tocar `container.ts`/`confirm-and-send.ts`/`resume-kyc.ts`): ✅ (ver arriba).
  - CD-8 (no tocar masking / `app/api/kyc/*`): ✅ (ver §4).

---

## 6. Resumen ejecutivo

122/122 tests verdes, tsc 0 errores, build OK (todos re-ejecutados por QA). Los 12 ACs activos tienen evidencia archivo:línea + nombre de test; AC-8 queda correctamente diferido y sin código (`wallet.ts` 0 diff). El fix-pack del MENOR (MNR-1, scrub comprensivo de PII legacy en `kyc-store.ts`) está verificado con test dedicado que asserta sobre el string crudo de `localStorage` post-`save()` de una tercera address — la PII legacy de otras addresses ya no sobrevive. Regresión de WKH-179 (masking) y WKH-180 (vendorData/gate server-side) intacta, con 0 diff en los archivos protegidos por CD-7/CD-8. Único hallazgo de drift: un archivo de test fuera de la tabla del Story File (`confirm-and-send.test.ts`), cambio de 1 línea mecánico y no bloqueante. Nota de proceso: no se encontraron `cr-report.md`/`ar-report.md` en disco; los gates fueron re-verificados directamente por QA como indica el mandato de esta tarea.

**Listo para DONE.**
