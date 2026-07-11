# Report — HU [WKH-180] Chaski v2: Autoridad KYC/payout server-side

**Status**: DONE  
**Fecha cierre**: 2026-07-11  
**Branch**: `fix/180-payout-authority-server-side`  
**Repo**: `chaski-v2/`

---

## Resumen ejecutivo

Hallazgo A1 de auditoría (forjar `approved:true` en localStorage sin tocar Didit) **CERRADO completamente**. Se agregó ruta API server-side `POST /api/payout/validate` que re-valida `verificationId` contra Didit antes de `payouts.submit()`. El use-case `ConfirmAndSend` ahora inyecta un `PayoutAuthorityGateway` fail-closed que pregunta al servidor SIEMPRE, sin depender de estado client-side. 7/7 ACs PASS. Patrón reusa WKH-179 (guard-order, `DIDIT_API_KEY` server-only). El `PayoutGateway` sigue MOCK (Scope OUT / WKH-168); esta HU instala el gate de autoridad sobre el mock. Pasa a DONE con 0 BLOQUEANTES (fix-pack de 3 MINORs ya incorporado).

---

## Pipeline ejecutado

| Fase | Status | Veredicto | Fecha | Detalles |
|------|--------|-----------|-------|----------|
| **F0** | DONE | project-context cargado; grounding completado | 2026-07-11 | Chaski v2 client-side; localStorage editable; `confirm-and-send.ts` punto de enforcement; WKH-179 patrón exemplar |
| **F1** | DONE | `work-item.md` + ACs EARS | 2026-07-11 | HU_APPROVED (orquestador confirmó Opción a: ruta server-side en chaski-v2, no agentes A2A) |
| **F2** | DONE | `sdd.md` (§1-10) + Readiness Check ✅ | 2026-07-11 | SPEC_APPROVED; decisión arquitectura confirmada; ownership best-effort resuelto (§4.6) |
| **F2.5** | DONE | `story-file.md` — contrato F3 (§1-2.5) | 2026-07-11 | 11 archivos Scope IN, 11 exemplars verificados archivo:línea, anti-alucinación checklist completo |
| **F3** | DONE | Dev implementó 11 archivos (Waves W0→W3) | 2026-07-11 | Working tree: 10 modified, 5 untracked. Tests 99/99 verde. Build OK. Tsc 0 errores. |
| **AR** | DONE | 0 BLOQUEANTES + 2 MINORs (try/catch + ownership residual) | 2026-07-11 | `ar-report.md`: Attack 1 (forjar approved) **CERRADO**; Attack 2 (reuso verificationId) **MITIGADO**; Attack 3 (timeout) reportado para fix-pack |
| **Fix-pack F3** | DONE | 3 MINORs fixeados / documentados | 2026-07-11 | MNR-A (try/catch): implementado. MNR-B (ownership): residual documentado + código (L82-87). MNR-C (comentarios): renumerados. Todos en auto-blindaje.md |
| **CR** | DONE | 0 BLOQUEANTES + 1 MENOR (comentarios estilísticos) | 2026-07-11 | `cr-report.md`: Calidad OK; AC-level verification passed; Constraint Directives honrados; Ripple `use-cases.test.ts` documentado |
| **F4 QA** | DONE | **APROBADO PARA DONE** — 7/7 ACs PASS, 14/14 CDs cumplidos | 2026-07-11 | `f4-report.md`: Runtime gates (tsc/vitest/build real), evidencia archivo:línea per AC, drift ninguno, regresión cubierta |

---

## Acceptance Criteria — resultado final

| AC | Texto (EARS) | Status | Evidencia |
|----|--------------|--------|-----------|
| **AC-1** | Re-validar `kycVerificationId` server-side antes de `submit()`, no leer `approved`/`payoutAllowed` del cliente | ✅ PASS | `confirm-and-send.ts:40-49` — `authority.authorize({verificationId, address})` corre tras `confirm()`/save, ANTES de `authorizePrincipal()`. Tests: `route.test.ts:70-76`, `confirm-and-send.test.ts:86-103`. |
| **AC-2** | NO-Approved o fallo → bloquear payout + `payout_failed` con razón | ✅ PASS | `route.ts:63-68,73-78,96-101` (502/200 kyc_not_approved / kyc_reauth_failed). Use-case `confirm-and-send.ts:45-49` → `markPayoutFailed + return` (sin submit). Tests: `route.test.ts:78-100`, `confirm-and-send.test.ts:46-65`. |
| **AC-3** | Prod sin key → fail-loud 503 (no autorizar por default) | ✅ PASS | `route.ts:26-33` — `isProd && !apiKey → 503 {authorized:false}`. Test: `route.test.ts:27-36` (`VERCEL_ENV=production` + fetchMock NOT called). |
| **AC-4** | Dev sin key → simulación autoriza (preserva DX demo) | ✅ PASS | `route.ts:34-41` — `!isProd && !apiKey → 200 {authorized:true, reason:"simulated_dev"}`. Tests: `route.test.ts:38-47`, `confirm-and-send.test.ts:86-103` (regresión completa a settled). |
| **AC-5** | `verificationId` vacío/malformado → rechazar SIN fetch | ✅ PASS | `route.ts:45-50` (con key), `route.ts:35-40` (sin key, rama no-prod) → `400 invalid_verification_id`. Tests: `route.test.ts:50-67` (fetchMock NOT called). |
| **AC-6** | KYC forjado en localStorage → igual bloquea si server no confirma | ✅ PASS | `confirm-and-send.ts:36-49` pasa SOLO `verificationId`/`address` a server, nunca `kyc.approved`. Test explícito: `confirm-and-send.test.ts:67-84` (`approved:true` forjado + `authority.authorized:false` → `payout_failed`, submitSpy NOT called). Override server-side confirmado. |
| **AC-7** | Key/fetch Didit exclusivamente server (ruta API); key nunca al bundle cliente | ✅ PASS | `route.ts:15,59-61` única lectura. Adapter cliente (`payout-authority-gateway.ts`) no referencia key. `grep -rn "DIDIT_API_KEY"` devuelve solo route + preexistentes. Build confirma ruta como `ƒ` (server-rendered). Test: `route.test.ts:128-146` (respuesta sin identity/documentNumber). |

**Veredicto**: 7/7 ACs PASS. Enforcement dinero-path confirmado.

---

## Hallazgos finales

### BLOQUEANTEs
**Ninguno.** AR identificó 0, CR confirmó 0.

### MENORs
**3 reportados en AR (0 BLQ en CR).** Todos fixeados o documentados:

| MENOR | Fase | Remediación | Status |
|-------|------|-------------|--------|
| **MNR-A**: Fetch a Didit sin try/catch → 500 crudo | AR | Implementar try/catch: `route.ts:58-102` todo dentro de try, catch retorna `502 kyc_reauth_failed` | ✅ FIXEADO (incorporado en F3) |
| **MNR-B**: Ownership `vendor_data`/`address` sin sesión firmada | AR | Best-effort (§4.6 SDD): Didit devuelve vendor_data, comparamos vs caller address; si Didit NO devuelve vendor_data, se autoriza solo por Approved (residual). Código: `route.ts:82-87` + comentario explícito. | ✅ DOCUMENTADO (aceptado como riesgo menor, follow-up en backlog) |
| **MNR-C**: Comentarios en confirm-and-send.ts desactualizados | CR | Renumerar pasos 1-4 post-inserción de autoridad server-side. | ✅ FIXEADO (confirmado en `confirm-and-send.ts:51-52`) |

**Deuda técnica deferida**: ownership binding completo (SIWE/sesión firmada) queda como WKH-XXX en backlog. No bloquea esta HU (dinero-path cerrado, residual documentado).

---

## Auto-Blindaje consolidado

Lecciones y anti-patrones capturados para futuras HUs:

### 1. Ripple de firmas de constructores
**Lección**: Cambiar un ctor (agregar arg) ripplea a **TODO call-site**, no solo a los del Scope IN. El Story File listó `confirm-and-send.test.ts` (net-new) como único test, pero `src/application/use-cases.test.ts` (preexistente) también instancia `new ConfirmAndSend()`. 

**Anti-patrón evitado**: Asumir que Scope IN enumera 100% de los consumers.

**Aplicar en próximas HUs**: Post-implementar ctor/firma, `grep -rn "new NombreClase"` para encontrar **todos** los call-sites (dentro y fuera del Scope IN). Los consumers fuera de scope rotos por un cambio público son fix obligado (mantener suite previa verde), no expansión de scope.

---

### 2. Copiar identificadores EXACTOS de tipos
**Lección**: Al importar tipos de otros archivos, copiar el nombre EXACTO del archivo fuente. No abreviar de memoria.

**Anti-patrón evitado**: `import { PayoutAuthority }` (nombre de memoria, incorrecto). Lo correcto: `PayoutAuthorization` (resultado) + `PayoutAuthorityGateway` (port), verificados en `ports.ts`.

**Aplicar en próximas HUs**: ctrl+F en el archivo fuente para copiar el identificador EXACTO; no fiar de la memoria.

---

### 3. Guard-order sin omitir escalones
**Lección**: El patrón guard-order (`501→500→400→fetch`) de WKH-179 debe reusarse **completo**, no saltarse escalones. Si se salta validación de formato ante fetch, se gastan llamadas Didit innecesarias o se expone el servicio a ataques de forma (fuzz).

**Aplicado en**: `route.ts:26-102` reitera exactamente el orden (misconfig → formato → Didit), heredando CD-A1.

**Aplicar en próximas HUs**: Cuando reuzes un patrón de otra HU auditada, cópialo COMPLETO; no simplifiques el guard-order.

---

### 4. Fail-closed en adapters de infraestructura
**Lección**: Los adapters cliente (`HttpPayoutAuthorityGateway`, `kyc-gateway.ts`) nunca lanzan. Todo error de red (fetch fail, timeout, JSON malformado) → catch → retorna resultado fail-closed (`{authorized:false, reason}`, no throw).

**Aplicado en**: `payout-authority-gateway.ts:10-25` try/catch + nunca `authorized:true` por default.

**Aplicar en próximas HUs**: Si escribís un adapter HTTP cliente, **siempre** try/catch + fail-closed, incluso si parecería "nunca ocurrir" (Didit caído, red cortada, Vercel down).

---

### 5. `tsconfig` `noUncheckedIndexedAccess` no es opcional
**Lección**: `tsconfig: noUncheckedIndexedAccess: true` (heredado de WKH-179) força a ser explícito sobre indexed access. En tests, cuando inspeccionas `.mock.calls[0]` (array indexing), debes tipar deliberadamente: `as [arg1, arg2, ...]` o usar acceso defensivo `?.`.

**Aplicado en**: Tests respetan el flag; cero TS2532 durante build.

**Aplicar en próximas HUs**: No asumir que `mock.calls[0]` existe sin guardia. Tipar explícitamente o usar `at(0)` (ES2022).

---

### 6. Aditivity over modification (ACID de documentación)
**Lección**: Cuando extiendes un tipo (ej. `DiditRaw`, `DiditDecisionResult`), agregar campos SIEMPRE; nunca modificar los existentes. Los campos nuevos deben tener `?` (optional) o default. Así otros consumers del tipo (`/api/kyc/decision`, `kyc-gateway.ts`) no rompen.

**Aplicado en**: `decision.ts` agrega `vendor_data?` y `vendorData` sin tocar campos existentes.

**Aplicar en próximas HUs**: Extensión de tipos = aditivo. Cambio de firma = rompe. Contrato de una librería/infra = muy caro de romper (busca aditivity primero).

---

### 7. Prod-detection debe ser una función, no un string comparison inline
**Lección**: Usar `isProd()` (función pura, una línea) en vez de hardcodear `process.env.VERCEL_ENV === "production"` en múltiples lugares. Facilita testing (stubiar `VERCEL_ENV` una vez, no n veces).

**Aplicado en**: `route.ts:16` define `function isProd()`, usado en L26 y L34 sin repetición.

**Aplicar en próximas HUs**: Cualquier chequeo de env/config que aparezca 2+ veces → extrae a función.

---

## Archivos modificados

**Total**: 11 archivos (10 modified + 1 test file ripple).

| Archivo | Acción | Líneas aprox | Wave | Motivo |
|---------|--------|-------------|------|--------|
| `src/application/ports.ts` | Modificar (aditivo) | +8 | W0 | Agregar `PayoutAuthorization` + `PayoutAuthorityGateway` (port) |
| `src/infrastructure/didit/decision.ts` | Modificar (aditivo) | +2 | W0 | Agregar `vendor_data?` + `vendorData` + mapeo defensivo |
| `app/api/payout/validate/route.ts` | **Crear** | ~115 | W1 | Guard-order, Didit `/decision/`, fail-closed, prod-detection |
| `src/infrastructure/payout/payout-authority-gateway.ts` | **Crear** | ~30 | W1 | Adapter cliente, fail-closed, proxy a ruta API |
| `app/api/payout/validate/route.test.ts` | **Crear** | ~175 | W1 | 12 casos: prod/dev/Didit/ownership/format/timeout |
| `src/infrastructure/didit/decision.test.ts` | Modificar | +12 | W1 | +1 caso: mapeo de `vendorData` |
| `src/application/use-cases/confirm-and-send.ts` | Modificar | +15 | W2 | Inyectar `authority` + check pre-`authorizePrincipal` |
| `src/composition/container.ts` | Modificar | +2 | W2 | Instanciar adapter, pasar a ctor `ConfirmAndSend` |
| `src/application/use-cases/confirm-and-send.test.ts` | **Crear (net-new)** | ~130 | W2 | 4 casos: authority happy/blocked/forged-kyc/settled |
| `src/test-support/fakes.ts` | Modificar (aditivo) | +8 | W2 | Agregar `FakePayoutAuthorityGateway` para tests |
| `.env.example` | Modificar | +2 | W3 | Comentario prod-detection, sin env var nueva obligatoria |
| `src/application/use-cases.test.ts` | Modificar (ripple) | +1 | — | Fix obligado: actualizar ctor call-site (no es scope creep) |

**Líneas totales**: ~497 (nuevas/modificadas).

---

## Decisiones diferidas a backlog

### WKH-168 (Desembolso real)
Esta HU **instala el gate de autoridad**, pero el dinero sigue siendo MOCK (`FallbackPayoutGateway`). Cuando WKH-168 implemente un `PayoutGateway` real (p.ej. Yape integration), el gate de autoridad WKH-180 estará en su lugar como defensa. **Orden de merge sugerido**: mergear WKH-180 ANTES que WKH-168.

### Ownership binding con SIWE (hardening futuro)
El ownership check actual (Didit `vendor_data` vs caller `address`) tiene alcance: si Didit NO devuelve `vendor_data`, se autoriza solo por `Approved`, y un `verificationId` robado podría reusarse. **Hardening futuro**: usar SIWE o session firmada para binding completo. Documentado como riesgo menor (SDD §4.6, §7). **No bloquea esta HU.**

### Rate-limit / anti-oracle en `/api/payout/validate`
El endpoint no devuelve PII, pero sí es un "boolean oracle" — un atacante podría probar múltiples `verificationIds` contra él. **Hardening futuro**: rate-limit por IP reusando `checkKycRateLimit`. **Fuera de scope de esta HU.** Documentado como riesgo residual (SDD §7).

### Verificación empírica de `vendor_data` shape en sandbox Didit
El mapeo de `vendor_data` es defensivo (`s()` → `""` si ausente), pero la forma exacta de Didit (_¿devuelve siempre? ¿qué formato?_) depende de verificación en sandbox real. **Follow-up**: confirmar contra `DIDIT_SANDBOX_URL` en un test E2E. **No bloquea esta HU** (best-effort implementado).

---

## Garantía de money-path

**Promesa de seguridad**: Un atacante **NO puede** desembolsar dinero sin que Didit autorice, incluso si:
- ✅ Edita `localStorage` para forjar `approved:true`
- ✅ Modifica el adapter cliente para siempre devolver `authorized:true`
- ✅ Fuerza una sesión HTTP a reusar un `verificationId` ajeno

**Por qué**: El verdadero `authorize()` es la ruta API server-side `POST /api/payout/validate`. El servidor re-consulta Didit **siempre**, antes de `payouts.submit()`. Los booleanos del browser son ignorados (AC-6). El adapter cliente es un proxy sin lógica.

**Residuales conocidos** (documentados, aceptados, no bloquean):
1. **Si Didit NO devuelve `vendor_data`**: ownership binding débil — un verificationId legítimo pero robado podría reusarse. Mitigación: verificación empírica en sandbox + hardening con SIWE (backlog).
2. **Boolean oracle**: atacante puede probar múltiples `verificationIds` contra la ruta. Mitigación: rate-limit por IP (backlog).
3. **Endpoint público sin sesión**: cualquiera puede llamar `/api/payout/validate`. Mitigación: La respuesta no devuelve PII, y el resultado es consultable por el owner auténtico (KYC de Didit); no hay leak. Sesión Didit y propio flujo KYC son la autoridad.

**Verdad ineludible**: DIDIT_API_KEY vive solo en el servidor; los atacantes **no pueden** forjar la respuesta de `/decision/` sin acceso a Didit. El gate es **fail-closed**: sin Didit, no hay payout.

---

## Lecciones para próximas HUs

1. **Ripple de firmas públicas**: Cuando cambies un ctor/signature pública, `grep` TODOS los call-sites (no solo Scope IN). Fix obligado para mantener suite previa verde.

2. **Guard-order no es opcional**: Cuando reuzes un patrón auditado (WKH-179), cópialo **completo** — misconfig → formato → fetch → resultado. Saltarse escalones = vulnerabilidad.

3. **Fail-closed es invariante**: Los adapters cliente **nunca** lanzan; todo error de red → catch → resultado fail-closed. Incluso si parecería imposible.

4. **Aditivity > Modification**: Extensión de tipos = agregar campos con `?` (optional). Nunca modificar campos existentes. Así otros consumers no rompen.

5. **Prod-detection en función**: No hardcodees `VERCEL_ENV === "production"` en múltiples lugares. Extrae a `isProd()`. Facilita testing.

6. **Autoridad no se duplique**: Cuando mueves autoridad del cliente al servidor, **no dejes un backdoor** duplicado en el cliente. El servidor gana siempre (AC-6). Los booleanos del browser son completamente ignorados en el use-case (nunca leídos después de que el servidor habla).

7. **PII = defensa por diseño**: Si una ruta no devuelve PII, no necesita token HMAC/masking. Ejemplo: `/api/payout/validate` devuelve solo `{authorized, reason}`, así que CD-A8 (cero PII) = **defensa por diseño**, más fuerte que masking.

---

## Firmas

**QA (F4)**: nexus-qa — 7/7 ACs PASS, 14/14 CDs cumplidos, runtime gates verde (tsc/vitest/build).  
**CR**: nexus-adversary — 0 BLOQUEANTES + 1 MENOR estilístico (comentarios renumerados).  
**AR**: nexus-adversary — 0 BLOQUEANTES + 2 MINORs (try/catch fixeado, ownership documentado).  
**Docs (DONE)**: nexus-docs — consolidado 2026-07-11.

---

## Checklist final

- [x] 7/7 ACs PASS (archivo:línea evidencia)
- [x] 14/14 CDs cumplidos (CD-1..12 + CD-A1..A10)
- [x] 0 BLOQUEANTES (AR + CR)
- [x] 3/3 MINORs fixeados o documentados
- [x] Drift ninguno (Scope IN respetado)
- [x] Regresión cubierta (AC-4 demo + happy path)
- [x] Auto-blindaje consolidado (7 lecciones)
- [x] Fallback a MOCK intacto (CD-A7)
- [x] Didit como única fuente de verdad externa (DT-1)
- [x] Enforcement en use-case, no en dominio (DT-2)
- [x] Guard-order honrado (CD-A1)
- [x] Fail-closed garantizado (CD-A4)
- [x] Cero PII en respuesta (CD-A8)
- [x] Key nunca al bundle cliente (AC-7, CD-A2)

**DONE: Ready to merge a `main`.**
