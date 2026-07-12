# Work Item — [WKH-185] Component test harness (jsdom + RTL) + backfill de ACs de UI

## Resumen
`chaski-v2` no tiene harness de tests de componentes (sin `jsdom` ni `@testing-library/react`
en `devDependencies`, sin `vitest.config.ts`). Como consecuencia, varios ACs de UI de la
auditoría 2026-07-10/11 (WKH-178/181/183/184) quedaron validados en F4 solo por "inspección
de código"/"code review (sin RTL)" en lugar de test automático. Esta HU agrega el harness
mínimo (jsdom per-file + React Testing Library) y backfillea exactamente esos ACs con tests
RTL reales. **Es deuda técnica test-only: cero cambio de comportamiento en producción**, salvo
un seam de inyección de dependencias en `flow.tsx` necesario para poder testearlo con fakes
(ver DT-2, comportamiento por-defecto preservado byte-a-byte).

## Sizing
- SDD_MODE: full
- Estimación: M
- Branch sugerido: `test/185-component-test-harness-rtl`

## Grounding (F0) — hallazgos clave

1. **Setup actual**: `package.json` → `"test": "vitest run"`, `"test:core": "vitest run src/domain src/application"`, `"qa": "typecheck && test"`. `devDependencies` = `vitest@^2.1.1` únicamente. **No existe `vitest.config.ts`** en el repo (Vitest corre con defaults: `environment: "node"`). 14 archivos `*.test.ts` (dominio/aplicación/infraestructura + `src/presentation/flow-vm.test.ts`) corren hoy bajo ese default node.
2. **`flow.tsx` es NO testeable hoy con fakes**: `RemittanceFlow()` construye su propio container real internamente (`const c = useMemo(() => createContainer(), [])`, `flow.tsx:47`) — no recibe props, no hay ningún punto de inyección. `createContainer()` (`src/composition/container.ts:43-70`) cablea infraestructura real (`pickWallet()`, `DiditKycGateway`, `HttpPayoutAuthorityGateway`) que no puede simularse desde un test externo sin este seam. Único caller en prod: `app/page.tsx:4` → `<RemittanceFlow />` (sin props) — agregar un prop opcional es 100% backward-compatible.
3. **Los fakes ya existen**: `src/test-support/fakes.ts` tiene dobles completos de los 11 ports del `Container` (`FakeQuoteGateway`, `FakeKycGateway`, `InMemoryRepo`, `FakeWallet`, `FakePayoutGateway`, `FakePayoutAuthorityGateway`, `FakeKycStore`, `FakeKycPendingStore`, etc.) — usados hoy solo para testear use-cases, ensamblables 1:1 en un `Container` fake para RTL.
4. **ACs de UI marcados "sin RTL"/"code review" en los F4 existentes** (grounding vía `doc/sdd/00{1,4,6,7}-*/f4-report.md`):
   - **WKH-178 AC-8** (botón "Reintentar" junto al mensaje de timeout de KYC): *"inspección de código (sin harness de componente — documentado en SDD §6, sin @testing-library/jsdom en el repo)"* (`001-.../f4-report.md:33`).
   - **WKH-184 AC-4** (reset limpia estado React sin reload): *"code review (sin RTL, según SDD §6/8)"* (`007-.../f4-report.md:59`).
   - **WKH-184 AC-6** (control de reset visible solo con `address !== null`): *"code review (sin RTL, según SDD §6/8)"* (`007-.../f4-report.md:61`).
   - **WKH-184 fix-pack MNR-1** (PII del beneficiario anterior se limpia en el reset): *"No hay test unitario nuevo para esto (es estado de UI, mismo criterio AC-4 = code review)"* (`007-.../f4-report.md:75-76`).
   - **WKH-181 AC-3/AC-13** (review renderiza nombre + documento enmascarado): método "Read" únicamente, sin test (`004-.../f4-report.md:28,38`).
   - WKH-183 y WKH-180 no tienen ACs de presentación pendientes (confirmado por lectura completa de sus `f4-report.md` — ninguno toca `flow.tsx`/`ui.tsx` o ya tenían cobertura de lógica pura vía `flow-vm.test.ts`).
5. **Estrategia de environment recomendada**: docblock **per-file** `// @vitest-environment jsdom` en cada `*.test.tsx` nuevo. Vitest lo soporta nativamente sin tocar config global — el resto de los 14 tests `*.test.ts` existentes siguen corriendo bajo el default `node` sin ningún cambio, riesgo cero de romperlos. Se descarta `vitest.config.ts` con `environment: "jsdom"` global (afectaría los 14 tests existentes, sin necesidad) y se descarta `test.projects`/workspaces (sobre-ingeniería para 1 HU de backfill puntual).
6. `tsconfig.json` ya tiene `"jsx": "react-jsx"` y `"lib": ["ES2022","DOM","DOM.Iterable"]` — Vitest (esbuild) lo respeta automáticamente, sin config adicional para el transform JSX.

## Acceptance Criteria (EARS)

- AC-1: WHEN se ejecuta `npx vitest run` sobre la suite completa (tests node existentes + los nuevos `*.test.tsx`), the system SHALL reportar 0 fallos, preservando el número de tests node preexistentes (ninguno se rompe, se borra ni se skipea).
- AC-2: WHEN un archivo de test usa el docblock `// @vitest-environment jsdom`, the system SHALL ejecutar únicamente ESE archivo bajo entorno jsdom, sin alterar el entorno (`node`, default) de ningún otro archivo `*.test.ts` existente.
- AC-3: WHEN `RemittanceFlow` se renderiza sin el prop `container` (como hace `app/page.tsx` hoy), the system SHALL comportarse idéntico al comportamiento actual — usa `createContainer()` internamente, cero cambio observable en producción.
- AC-4: WHEN un test renderiza `<RemittanceFlow container={fakeContainer} />` con un `Container` ensamblado desde `src/test-support/fakes.ts`, the system SHALL permitir recorrer el flujo (wallet → KYC → quote → review) sin ninguna llamada real a Didit, Upstash o RPC de blockchain.
- AC-5: WHILE el resume-loop de KYC agota sus reintentos (estado `timedOut`), the system SHALL mostrar el botón "Reintentar" en la card de timeout — y WHEN el usuario hace click en "Reintentar", the system SHALL volver al step `"send"` sin invocar `window.location.reload` — backfillea WKH-178/AC-8 y AC-9.
- AC-6: WHEN el usuario confirma "Empezar de nuevo" en el control de reset (tras conectar wallet), the system SHALL limpiar `address`, la remesa en curso y el preview, y volver el `step` a `"send"` — backfillea WKH-184/AC-4.
- AC-7: WHILE `address === null`, the system SHALL NO renderizar el control "¿No sos vos?" / "Empezar de nuevo"; WHEN `address !== null`, the system SHALL renderizarlo — backfillea WKH-184/AC-6.
- AC-8: WHEN se ejecuta el reset (`forgetAndDisconnect`), the system SHALL limpiar los campos `recipient` y `destination` (PII del beneficiario anterior) y devolver `amount` a su default `"400"` — backfillea el fix-pack MNR-1 de WKH-184.
- AC-9: WHEN el flujo llega al step `"review"` con una identidad KYC verificada, the system SHALL renderizar el nombre completo del titular y el documento enmascarado (`••••` + últimos 4 dígitos), y NUNCA el número de documento completo en el DOM — backfillea WKH-181/AC-3 y AC-13.
- AC-10: IF un test RTL termina, THEN the system SHALL limpiar el DOM (`cleanup()` de `@testing-library/react`) antes de correr el siguiente test del mismo archivo, evitando fugas de estado entre tests.

## Scope IN
- `package.json` — nuevas `devDependencies`: `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`. Sin cambios de `dependencies` de producción.
- `package-lock.json` — regenerado por `npm install` (consecuencia mecánica de lo anterior).
- `src/presentation/flow.tsx` — **único cambio de código no-test**: agregar prop opcional `container?: Container` a `RemittanceFlow`, con default `container ?? createContainer()` (ver DT-2). Ninguna otra línea del archivo cambia.
- `src/presentation/flow.test.tsx` — **NUEVO**. Harness RTL, backfillea AC-3 a AC-9.
- `src/test-support/fakes.ts` — posible extensión aditiva (ej. un helper `buildTestContainer(overrides)` que ensambla los 11 ports fake en un `Container`) para no repetir el ensamblado en cada test — a confirmar en F2 (ver Missing Inputs).
- `doc/sdd/008-wkh-185-component-test-harness-backfill/*` — artefactos del pipeline (este work-item + sdd + story-file + reportes).

## Scope OUT
- `vitest.config.ts` — NO se crea. Se usa el docblock per-file (DT-1).
- Cualquier cambio de comportamiento en use-cases, dominio o infraestructura (fuera del seam de `flow.tsx`).
- Backfill de ACs de UI YA cubiertos por test de lógica pura en `flow-vm.test.ts` (ej. AC-4/AC-5/AC-6 de WKH-178, "Modo demo" — ya tienen test automático de la función `isDemoMode` + inspección de gating; no están marcados "sin RTL" en su F4, así que no se re-abren).
- El smoke E2E manual post-merge mencionado en el F4 de WKH-180 (Didit real, Vercel) — sigue siendo manual, fuera de alcance de esta HU.
- `src/presentation/ui.tsx` — no se modifica, solo se consume vía queries de RTL.
- Cualquier repo que no sea `chaski-v2` (`wasiai-a2a`, `wasiai-v2`, `yarvis`/agentshop-*, etc.).

## Decisiones técnicas (DT-N)
- DT-1: **Environment jsdom per-file** vía docblock `// @vitest-environment jsdom` en cada `*.test.tsx` nuevo, sin crear `vitest.config.ts`. Menor superficie de cambio posible; cero riesgo sobre los 14 tests node existentes (siguen bajo el default `node`, sin tocarlo). Soportado nativamente por Vitest.
- DT-2: **Seam de inyección en `flow.tsx`**: prop opcional `container?: Container` en `RemittanceFlow`, default `createContainer()`. Es el único cambio de código de producción necesario — sin él, `flow.tsx` es imposible de testear con fakes (siempre instancia infraestructura real vía `useMemo(() => createContainer(), [])`). Preserva el comportamiento actual byte-a-byte cuando no se pasa el prop (único caller real, `app/page.tsx`, no pasa props).
- DT-3: **Deps nuevas**: `jsdom` (entorno DOM), `@testing-library/react` + `@testing-library/user-event` (render/interacción), `@testing-library/jest-dom` (matchers custom tipo `toBeInTheDocument`, mejora legibilidad de asserts). Las 4 son devDependencies estándar de la industria, riesgo bajo, sin impacto en el bundle de producción.
- DT-4: **Fake timers para AC-5** (timeout de KYC): el resume-loop real hace 40 intentos × `sleep(2500)` = 100s reales (`flow.tsx:93-133`). El test usa un `resumeKyc` fake que siempre devuelve `{kind:"processing"}` + `vi.useFakeTimers()`/`vi.advanceTimersByTimeAsync(...)` para fast-forward el loop sin esperar en tiempo real.
- DT-5: **Lista cerrada de backfill**: solo se testean los ACs explícitamente marcados "sin RTL"/"code review (sin RTL)" en los `f4-report.md` de WKH-178/181/184 (ver Grounding punto 4). No se amplía a otros ACs de UI ya cubiertos por lógica pura, para mantener el work-item chico y evitar scope creep.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO tocar código fuera de `chaski-v2/`.
- CD-2: OBLIGATORIO — HU test-only. El único archivo de producción que puede cambiar es `src/presentation/flow.tsx`, y el ÚNICO cambio permitido ahí es el prop opcional `container` (DT-2) con default `container ?? createContainer()`; ninguna otra línea de `flow.tsx` puede modificarse.
- CD-3: PROHIBIDO crear/editar `vitest.config.ts` para cambiar el `environment` global a `jsdom`. La estrategia OBLIGATORIA es el docblock per-file `// @vitest-environment jsdom` (DT-1).
- CD-4: OBLIGATORIO — todo test RTL nuevo debe llamar `cleanup()` de `@testing-library/react` en un `afterEach` (no hay `setupFiles` global que lo automatice).
- CD-5: PROHIBIDO usar red real, mocks de `fetch` a Didit/Upstash, o cualquier RPC de blockchain real en los tests RTL — SIEMPRE inyectar el `Container` fake ensamblado desde `src/test-support/fakes.ts`.
- CD-6: OBLIGATORIO — al finalizar la HU, `npx vitest run` debe reportar 0 fallos y el conteo de tests node preexistentes no puede bajar (piso = el conteo actual al momento de F2).
- CD-7: PROHIBIDO expandir el backfill a ACs no listados en DT-5 (lista cerrada) sin volver a F1 para ampliar el work-item explícitamente.

## Missing Inputs
- [resuelto en F2] Confirmar con el Architect si conviene un helper `buildTestContainer(overrides)` en `test-support/fakes.ts` para no repetir el ensamblado del `Container` completo en cada test, o si cada test lo arma inline. No bloqueante para F1 — decisión de diseño de bajo riesgo, sin impacto en scope ni ACs.
- [resuelto en F2] `@testing-library/jest-dom` (DT-3) es una dependencia adicional a las estrictamente necesarias (RTL + user-event ya alcanzan). Se agrega tentativamente por ser estándar de la industria y de riesgo bajo; el Architect puede omitirla en el SDD si prefiere minimizar dependencias nuevas (los asserts se reescribirían con `.textContent`/`querySelector` nativo).
- Sin bloqueantes. El ticket y el grounding no dejaron ambigüedad de scope: la lista de ACs a backfillear surge 1:1 de los `f4-report.md` ya escritos (evidencia citada arriba), no de interpretación.

## Análisis de paralelismo
- Esta HU es standalone: no bloquea ni es bloqueada por ninguna HU de negocio (WKH-170 a WKH-184 están todas DONE). Puede correr en paralelo con cualquier trabajo futuro que NO toque `src/presentation/flow.tsx` (ej. un futuro WKH-168 de payout real, que toca `confirm-and-send.ts`/`container.ts`, no `flow.tsx`).
- **Riesgo de colisión**: si alguna HU futura también modifica `flow.tsx` en paralelo, aplica el mismo riesgo de merge documentado para el backlog 178-184 en `_INDEX.md` — coordinar orden de merge antes de F3 si surge esa situación.
- Recomendado: mergear esta HU pronto dado que es deuda técnica de bajo riesgo (test-only) — cuanto más tiempo pase, más ACs de UI futuros se acumularán sin harness disponible.
