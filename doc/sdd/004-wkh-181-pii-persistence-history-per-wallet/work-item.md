# Work Item — [WKH-181] No persistir PII cruda + historial por-wallet + riskLevel AML

## Resumen
`persistence.ts` guarda cada `RemittanceState` completo en `localStorage` — incluye
`kyc.identity` (DNI/DOB/nombres) y `beneficiary.destination` (celular) en claro — y `list()`
devuelve TODAS las remesas del dispositivo SIN filtrar por dueño (hallazgo A3, auditoría
adversarial 2026-07-10). `kyc-store.ts` guarda la `KycVerification` completa (misma PII) sin
cifrar ni TTL. Ambos gaps explican el bug "María Elena vieja": en un dispositivo compartido, la
identidad de una verificación anterior queda expuesta/reutilizada para otro usuario. Además
`decision.ts:48-49` colapsa `riskLevel` a binario (`approved ? "low" : "high"`), descartando
cualquier señal AML más fina que Didit pudiera enviar. Esta HU reduce lo que se persiste, filtra
el historial/KYC-once por wallet real, y deja el mapeo de riesgo abierto a señal AML real sin
romper el fallback binario actual.

## Sizing
- Modo de proceso: QUALITY (Chaski es siempre QUALITY por convención de proyecto)
- SDD_MODE: full (toca domain — `RemittanceState`/`KycVerification` — + 2 ports + 3 adapters +
  1 use-case + wallet fallback; no es un fix contenido de presentación como WKH-178)
- Estimación: M
- Branch sugerido: `fix/181-pii-persistence-history-per-wallet`

## Contexto verificado (F0 grounding, líneas reales al 2026-07-11, sobre `main` post WKH-178/179)

### Persistencia de remesas (A3)
- `chaski-v2/src/infrastructure/persistence.ts:50-63` — `LocalRepo.save()` serializa el
  `RemittanceState` COMPLETO (incluye `kyc.identity` y `beneficiary.destination`) a
  `localStorage["chaski.remittances.v1"]` sin ningún replacer que reduzca PII (el único
  `replacer`/`reviver` existente, líneas 9-15, es para `Money`, no para PII). `list()` (línea
  61-63) devuelve `[...map.values()]` SIN ningún filtro — no hay ningún parámetro de owner en la
  firma (`application/ports.ts:99`: `list(): Promise<RemittanceState[]>`).
- `chaski-v2/src/domain/remittance.ts:79-94` — `RemittanceState` NO tiene ningún campo de
  ownership (`ownerAddress`, `walletAddress`, etc.). No hay forma de saber, a partir del estado
  persistido, a QUÉ wallet pertenece una remesa.
- **`list()` HOY NO SE USA en ninguna pantalla** — confirmado: `chaski-v2/src/presentation/` solo
  tiene `flow.tsx` y `ui.tsx`, y ninguno importa/llama `container.listHistory`. El use-case
  `ListHistory` (`application/use-cases/list-history.ts`) está cableado en `container.ts:36,62`
  pero es código muerto desde la UI. Esto significa: el gap de A3 es una vulnerabilidad LATENTE
  (bomba de tiempo — el día que se agregue una pantalla de historial, el cross-user leak se
  activa sin que nadie lo note) MÁS un problema YA ACTIVO hoy — la PII en claro es inspeccionable
  vía devtools/`localStorage` por cualquiera con acceso físico al dispositivo, sin necesitar UI.
- `chaski-v2/src/application/use-cases/lock-quote.ts:13`, `confirm-and-send.ts:23`,
  `track-remittance.ts:13` — **los 3 use-cases posteriores a KYC SIEMPRE rehidratan la remesa
  vía `repo.get(id)`** (leen lo PERSISTIDO, no el objeto en memoria de la llamada anterior) y
  devuelven un `Remittance` nuevo cuyo `.snapshot` reemplaza el estado en React
  (`flow.tsx:113,171,209,225,245`: `setRem(locked.snapshot)` / `setRem(r.snapshot)`). **Esto
  importa para el diseño del fix**: reducir lo que persiste `LocalRepo.save()` SÍ se propaga al
  render del step `review` (`flow.tsx:510-522`), porque ese render lee `rem.kyc.identity` desde
  el snapshot devuelto por `lockQuote.execute()`, que a su vez viene de `repo.get()` — es decir,
  del estado PERSISTIDO, no del original devuelto por `startKyc`.
- `chaski-v2/src/presentation/flow.tsx:510-522` — el Review renderiza `rem.kyc.identity.firstName`,
  `.lastNamePaternal`, `.lastNameMaternal` y `.documentType` **completos** (línea 516-519), y
  `documentNumber.slice(-4)` (línea 519, ya solo últimos 4). `dateOfBirth` y `nationality`
  **NO se renderizan en ningún lugar de `flow.tsx`/`ui.tsx`** (grep confirmado, cero matches).
  **Conclusión de grounding (punto b de la tarea)**: reducir el `documentNumber` persistido a
  solo últimos 4 y DROPPEAR `dateOfBirth`/`nationality` del snapshot persistido NO rompe ningún
  render actual. Pero DROPPEAR `firstName`/`lastNamePaternal`/`lastNameMaternal`/`documentType`
  (lectura literal de "solo últimos-4 + verificationId + approved/payoutAllowed" en la HU) SÍ
  rompe el Review (nombre en blanco) por el punto anterior (rehidratación vía `repo.get()`) — ver
  DT-1 y Missing Inputs.
- No existe ningún mecanismo de migración de datos legacy: `LocalRepo.read()` (línea 28-39) hace
  `JSON.parse(raw, reviver)` y castea a `RemittanceState[]` sin validar shape — un snapshot viejo
  con `kyc.identity` completo simplemente se lee tal cual (no hay versión de schema en el `KEY`
  `"chaski.remittances.v1"` más allá del sufijo `.v1` fijo en el string).

### KYC store (M-adjacent de A3)
- `chaski-v2/src/infrastructure/kyc-store.ts:16-43` — `LocalKycStore` **YA está keyed por
  address** (`get(address)`/`save(address, kyc)`, línea 29-35: `all[address.toLowerCase()]`).
  El hallazgo de la HU sobre este archivo NO es la falta de keying (eso ya existe) sino: (1) guarda
  la `KycVerification` COMPLETA (incluye `identity` con DNI/DOB en claro) sin ninguna reducción, y
  (2) no tiene TTL — un registro queda "verificado para siempre" en ese dispositivo/address, sin
  expiración ni forma de forzar re-verificación periódica (relevante para AML: una persona puede
  entrar en una lista de sanciones DESPUÉS de su primer KYC).
- `chaski-v2/src/application/use-cases/start-kyc.ts:36-40,51-53` y
  `chaski-v2/src/application/use-cases/resume-kyc.ts:46-47` — ambos hacen
  `await this.kycStore.save(input.address, v)` con `v` = `KycVerification` completa SIN
  reducción, tanto al completar un KYC nuevo como al reusar uno (`start-kyc.ts:38`
  `r.applyKyc(remembered, ...)` reinyecta el objeto completo leído del store en el snapshot de la
  remesa — es decir, el mismo objeto no-reducido termina también en `persistence.ts` vía
  `repo.save(r)` en la línea 39).

### El colapso REAL de "keying por address": FallbackWallet usa una address HARDCODEADA
- `chaski-v2/src/infrastructure/wallet.ts:47-60` — `FallbackWallet.connect()` (el wallet que se
  usa cuando NO hay wallet inyectada, línea 129-133 `pickWallet()`: sin MetaMask/Rabby Y sin
  `NEXT_PUBLIC_REOWN_PROJECT_ID` configurado → cae acá) devuelve **SIEMPRE la MISMA constante**:
  `"0xDEMO00000000000000000000000000000A11ce"` (línea 51). **Esto es la causa raíz más probable
  del bug "María Elena vieja"**: en cualquier dispositivo sin wallet real (el caso típico de
  remesas familiares — un teléfono compartido sin extensión de wallet), TODOS los usuarios que
  pasan por `FallbackWallet` comparten la MISMA `address`, así que el `KycStore` keyed-por-address
  (que ya existe) los colapsa en la MISMA entrada — el KYC-once (`start-kyc.ts:36-40`) reusa
  automáticamente la identidad de "María Elena" (la primera persona que verificó en ese
  dispositivo) para cualquier persona siguiente. **Filtrar `list()`/`kycStore` "por address" NO
  arregla este caso concreto si la address sigue siendo compartida** — es un prerequisito real
  para que el fix de esta HU cumpla su propio objetivo declarado. Ver DT-2 (recomendado, no
  asumido como AC obligatoria sin confirmación — ver Missing Inputs).
- `WalletConnectWallet` (línea 71-120) y `InjectedWallet` (línea 15-44) SÍ devuelven una address
  real/distinta por usuario — no tienen este problema.

### riskLevel / AML (M5)
- `chaski-v2/src/infrastructure/didit/decision.ts:29-54` (`mapDiditDecision`) — línea 49:
  `riskLevel: approved ? "low" : "high"` es un valor DERIVADO de `approved`, no leído de ningún
  campo del payload de Didit. El tipo `DiditRaw` (línea 16-20) solo declara `status`,
  `session_id`, `id_verifications` — **no hay NINGÚN campo de AML/riesgo en el tipo hoy**; no es
  solo un bug de colapso, es que el mapeo de AML nunca se implementó (coincide con el comentario
  de línea 26-28: "los paths exactos... dependen de la config del workflow en Didit... verificar
  contra el sandbox"). Por MEMORY del proyecto: el workflow "Free KYC" usado en dev/test NO
  incluye AML; el workflow real con AML (`8925738f`, $0.65/verificación) es el que se usaría en
  producción — sin acceso a ese sandbox hoy, no se puede confirmar el/los campo(s) exacto(s) que
  Didit devuelve para riesgo AML (`risk_level`, `aml_result`, `watchlist_hit`, u otro nombre).
- `chaski-v2/src/infrastructure/didit/decision.test.ts:5-35` — el test fixture usa exactamente
  `"MARIA ELENA" / "QUISPE" / "MAMANI"` como identidad Approved — confirma que este es el fixture
  de referencia del bug narrado en la HU.
- `chaski-v2/src/infrastructure/didit/kyc-gateway.ts:35-53` — `decision()` ya propaga `riskLevel`
  tal cual desde `DiditDecisionResult` hacia `KycDecision.verification.riskLevel` — el pipeline
  end-to-end SÍ respeta el valor que `mapDiditDecision` calcule; el único punto a arreglar es el
  cálculo en `decision.ts:49`.

### Otros archivos revisados (sin cambios necesarios, confirmado)
- `chaski-v2/src/composition/container.ts` — cablea `LocalRepo`/`LocalKycStore` sin parámetros;
  cualquier cambio de firma de `RemittanceRepository.list()`/`KycStore` se resuelve acá sin lógica
  nueva (solo pasar `address` donde ya está disponible).
- `chaski-v2/src/application/use-cases/connect-wallet.ts:14-18` — ya devuelve `address` +
  `rememberedKyc`; es el punto donde la UI conoce la wallet, pero el `RemittanceState` recién se
  crea ANTES de este paso (`flow.tsx`: step `send` → crea remesa → step `connect` → recién ahí se
  conecta la wallet), así que el `ownerAddress` no puede setearse en `CreateRemittance` — el
  primer punto donde `remittanceId` + `address` coexisten en TODAS las ramas del flujo (KYC-once
  vía `onConnect` Y verificación completa vía `onVerify`) es `StartKyc.execute()`
  (`start-kyc.ts:23-26`, recibe `remittanceId` + `address` siempre).
- `chaski-v2/.env.example` — ya tiene `UPSTASH_REDIS_REST_URL`/`TOKEN` (WKH-179, rate-limit
  server-side). Redis es server-side y NO aplica a este fix (100% client-side/localStorage);
  no hay TTL-store server-side reutilizable para el KycStore del browser.

## Acceptance Criteria (EARS)

### A3 — PII cruda persistida en claro (BLOQUEANTE)
- **AC-1**: WHEN a `Remittance` is persisted via `RemittanceRepository.save()`, the system SHALL
  NOT write the raw `documentNumber` (full) or `dateOfBirth` of `VerifiedIdentity` to
  `localStorage` — `documentNumber` SHALL be reduced to at most the last 4 characters and
  `dateOfBirth` SHALL be omitted entirely from the persisted representation.
- **AC-2**: WHEN a `KycVerification` is persisted via `KycStore.save()`, the system SHALL apply
  the same PII reduction as AC-1 to the stored `identity` (same reduced shape, single source of
  truth — ver DT-1).
- **AC-3**: `[NEEDS CLARIFICATION — bloqueante para F2, ver Missing Inputs]` WHEN persisting
  `VerifiedIdentity`, the system SHALL preserve `firstName`, `lastNamePaternal`,
  `lastNameMaternal`, `documentType` en el estado persistido — necesario para que el Review
  (`flow.tsx:516-519`) siga mostrando el nombre verificado sin romperse (ver grounding); requiere
  confirmación humana de que nombre completo persistido no cuenta como "PII cruda" prohibida en
  el sentido de esta HU (documentNumber/DOB sí lo son, nombres son ambiguos en el texto original).
- **AC-4**: IF a legacy snapshot already present in `localStorage` (written before this fix)
  contains a non-reduced `VerifiedIdentity`, THEN the system SHALL NOT crash on read (`reviver`/
  parse defensivo, patrón ya usado en `LocalRepo.read()`/`LocalKycStore.read()`) — el manejo
  exacto (migrar-y-reducir en el próximo `save()`, o descartar registros legacy) queda a
  DT-3/Missing Inputs, pero el mínimo no-negociable es "no rompe la app".

### Cross-user leak / historial por-wallet (BLOQUEANTE)
- **AC-5**: WHEN `RemittanceRepository.list()` is called with a caller `address`, the system SHALL
  return only `RemittanceState` entries whose owner matches that `address` (case-insensitive) —
  ningún registro de otra wallet SHALL aparecer en el resultado.
- **AC-6**: WHEN a `Remittance` transitions out of `kyc_pending` for the first time (identidad
  verificada, ver `start-kyc.ts`), the system SHALL record the caller's wallet `address` as the
  owner of that remittance in the persisted state, de forma que AC-5 pueda filtrar por ese campo.
- **AC-7**: IF a `RemittanceState` has no recorded owner `address` (remesa abandonada antes de
  llegar a `startKyc` — steps `created`/`send`), THEN `list()` SHALL exclude it from any
  address-scoped result (no atribuible = no se muestra a nadie).
- **AC-8** `[NEEDS CLARIFICATION — recomendado, no explícito en la HU original, ver DT-2/Missing
  Inputs]`: WHEN no wallet real está inyectada ni configurado WalletConnect (`FallbackWallet`
  path), the system SHALL generate and persist a distinct pseudo-address per browser
  installation instead of reusing a single hardcoded constant — sin esto, AC-5/AC-6 no logran
  el objetivo declarado por la HU (evitar que "María Elena vieja" se filtre a otro usuario en el
  MISMO dispositivo sin wallet real), porque todos los usuarios de `FallbackWallet` seguirían
  colapsando en una sola "wallet".

### M5 — riskLevel AML colapsado a binario
- **AC-9**: WHEN `mapDiditDecision` processes a Didit decision payload that includes an
  identifiable AML/risk signal beyond approve/decline (campo exacto TBD, ver Missing Inputs — WKH-
  22/Fase A), the system SHALL preserve that finer-grained signal (ej. `"medium"`) instead of
  collapsing it to the binary `approved ? "low" : "high"`.
- **AC-10**: IF no AML/risk field is present in the payload (caso actual: workflow "Free KYC" sin
  AML), THEN the system SHALL fall back to the existing binary mapping (`approved ? "low" :
  "high"`) — no regression, comportamiento actual preservado como default.
- **AC-11**: the system SHALL keep `mapDiditDecision` pure/testeable sin I/O (mismo patrón que
  `maskIdentity`/`maskDecision` de WKH-179) — el mapeo de riesgo fino es lógica de mapeo, no una
  llamada adicional a Didit.

### Regresión / no-daño
- **AC-12**: WHILE `NEXT_PUBLIC_KYC_MODE` no está en `"didit"` (modo simulación/fallback), the
  system SHALL preserve el flujo de fallback existente (`FallbackKycGateway`) sin requerir que
  el sandbox real de Didit esté disponible para validar esta HU.
- **AC-13**: WHEN the Review screen (`flow.tsx:510-522`) renders `rem.kyc.identity` after this
  fix, the system SHALL continue to display the verified name and masked document number exactly
  as before (sujeto a la resolución de AC-3).

## Scope IN
- `chaski-v2/src/domain/remittance.ts` — reducir `VerifiedIdentity` a la forma persistible (o
  introducir un tipo derivado, ej. `PersistedIdentity`) + agregar campo de ownership a
  `RemittanceState` (ej. `ownerAddress: string | null`).
- `chaski-v2/src/infrastructure/persistence.ts` — `LocalRepo.save()` aplica la reducción de PII
  antes de `JSON.stringify`; `list()` recibe `address` y filtra; manejo defensivo de legacy (AC-4).
- `chaski-v2/src/infrastructure/kyc-store.ts` — `LocalKycStore.save()` aplica la misma reducción
  (compartir helper con `persistence.ts`, no duplicar la lógica de reducción); agregar TTL
  (timestamp + política de expiración) a lo persistido.
- `chaski-v2/src/application/ports.ts` — `RemittanceRepository.list()` cambia de firma para
  aceptar `address`; `KycStore` si aplica TTL en la interfaz.
- `chaski-v2/src/application/use-cases/list-history.ts` — propaga `address` al repo.
- `chaski-v2/src/application/use-cases/start-kyc.ts` — punto donde se setea `ownerAddress` en el
  snapshot (AC-6).
- `chaski-v2/src/infrastructure/didit/decision.ts` — `mapDiditDecision` deja de colapsar
  `riskLevel` a binario cuando el payload trae señal más fina (AC-9/AC-10); helper de reducción de
  PII (compartido con persistence.ts/kyc-store.ts) puede vivir acá o en un archivo nuevo (a
  definir en F2 — ver DT-1).
- `chaski-v2/src/composition/container.ts` — cablear el `address` disponible hacia
  `listHistory`/`repo` donde corresponda (hoy `listHistory.execute()` no recibe address; cambia a
  `listHistory.execute(address)`).
- `chaski-v2/src/infrastructure/wallet.ts` — `[condicionado a confirmar AC-8]` `FallbackWallet`
  deja de devolver una constante hardcodeada; genera/persiste una pseudo-address por instalación
  de browser.
- Tests: `chaski-v2/src/infrastructure/didit/decision.test.ts` (extender AC-9/10),
  `chaski-v2/src/application/use-cases.test.ts` (extender para ownership/list filtrado), tests
  nuevos para `persistence.ts`/`kyc-store.ts` (hoy sin test file dedicado — confirmar en F2 si se
  crea `persistence.test.ts`/`kyc-store.test.ts`).

## Scope OUT
- Cifrado real de lo persistido en `localStorage` — no hay hoy ningún mecanismo de
  passphrase/session-secret client-side para derivar una clave de cifrado segura; "cifrar" sin
  key-management real sería seguridad-teatro. Deferred a un follow-up (posible WKH nueva) si se
  decide introducir, ej., un secreto derivado de la firma de wallet (SIWE-like) — eso además
  depende de WKH-179 DT-1 (SIWE) que sigue `[NEEDS CLARIFICATION]`.
- Ownership check en `RemittanceRepository.get(id)` — hoy sin superficie de ataque real (el
  `remittanceId` nunca se expone a input arbitrario del usuario; el único lugar donde persiste
  entre navegaciones es `KycPendingStore`, propio del mismo flujo/usuario). Se documenta como gap
  IDOR-shaped de baja prioridad, no se corrige en esta HU (ver Missing Inputs).
- Confirmación del mapeo exacto de campos AML de Didit (nombres de campo reales en el payload
  `id_verifications`/nivel superior) — depende del sandbox real con el workflow AML (WKH-22/Fase
  A), no disponible hoy. Esta HU deja el mapeo defensivo/extensible, NO hardcodea nombres de campo
  inventados.
- `chaski-v2/app/api/kyc/*` (rutas server-side) — ya cerradas en WKH-179; esta HU es 100%
  client-side/localStorage, no toca las rutas.
- Cambios en `app/api/kyc/decision/route.ts`'s `maskDecision` (WKH-179) — esa es la reducción en
  el LÍMITE HTTP (server→cliente); esta HU es la reducción en el límite cliente→`localStorage`.
  Son capas distintas y complementarias, no se fusionan.
- El demo live (`yarvis`/`wasiai-v2`, fuera de `chaski-v2/`) — NO SE TOCA (CD-1).
- Pantalla de historial nueva (UI que consuma `listHistory`) — fuera de alcance; esta HU arregla
  el repositorio/use-case para que, EL DÍA que se construya esa pantalla, no nazca con un
  cross-user leak. No se construye la pantalla acá.

## Decisiones técnicas (DT-N)

- **DT-1 (forma exacta de "PII reducida")**: se recomienda un tipo persistido derivado (ej.
  `PersistedIdentity`) con `{ firstName, lastNamePaternal, lastNameMaternal, documentType,
  documentNumberLast4: string }` (sin `documentNumber` completo ni `dateOfBirth`/`nationality`),
  compartido entre `persistence.ts` y `kyc-store.ts` vía un único helper (evita duplicar la lógica
  de reducción, mismo patrón que `maskIdentity` de WKH-179 en `decision.ts`). Justificación: es el
  set MÍNIMO que no rompe el render actual del Review (`flow.tsx:516-519`) — ver grounding. Esto
  es una interpretación de "no persistir PII cruda" que preserva nombres (necesarios para UX) y
  reduce documento/DOB (los campos explícitamente citados en la HU como "cruda"). Alternativa más
  estricta (dropear también nombres) requiere rediseñar el Review para no depender de datos
  persistidos (ej. mantener el nombre solo en memoria de React, nunca en el repo) — mayor cambio,
  `[NEEDS CLARIFICATION]` para el Architect/humano, ver Missing Inputs.
- **DT-2 (FallbackWallet — address compartida)**: recomendado reemplazar la constante hardcodeada
  por una pseudo-address generada una vez por instalación de browser (ej.
  `crypto.randomUUID()`-derivada, persistida en una key nueva de `localStorage`, ej.
  `chaski.demo-address.v1`) — sin esto, el fix de "historial por-wallet" no cumple su propio
  objetivo para el segmento de usuarios más probable en un demo de remesas familiares (teléfono
  compartido sin wallet real). Riesgo de NO incluirlo: la HU se cierra "técnicamente cumplida"
  (filtra por address) pero el bug reportado ("María Elena vieja") sigue reproduciéndose en el
  caso más común. `[NEEDS CLARIFICATION]` si se confirma como AC obligatoria (AC-8) o se defiere.
- **DT-3 (migración de datos legacy)**: NO migrar activamente snapshots viejos (no hay endpoint ni
  necesidad de "limpiar" retroactivamente para el alcance de un demo/hackathon) — el enfoque
  mínimo es defensivo: el próximo `save()` sobre cualquier remesa existente aplica la reducción
  (auto-sanea en el próximo write natural del flujo), y las lecturas (`reviver`) no deben romper
  si encuentran un shape viejo con más campos de los esperados (JS ignora props extra al
  desestructurar, no requiere código especial salvo no asumir que TODOS los campos reducidos
  existen). Alternativa (borrar `localStorage` completo en un cambio de versión de `KEY`, ej.
  `"chaski.remittances.v2"`) es más agresiva (pierde historial existente) — se documenta como
  opción B para el Architect.
- **DT-4 (riskLevel AML)**: mantener el fallback binario como DEFAULT explícito (no error, no
  campo `"unknown"` nuevo en el union type `"low"|"medium"|"high"` — eso rompería el dominio) y
  agregar una rama que lea un campo candidato del payload (nombre exacto TBD, ej.
  `raw.risk_level ?? raw.aml_result ?? raw.watchlist_hit`, defensivo) SOLO si está presente y es
  uno de los 3 valores válidos del union type — cualquier valor inesperado cae al fallback binario
  (no se inventa un 4to nivel de riesgo).

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/`. PROHIBIDO tocar el demo live
  (`yarvis`, `wasiai-v2`, cualquier ruta bajo `agentshop-*`). Esta HU es exclusivamente
  `chaski-v2/src/{domain,application,infrastructure}/*` según Scope IN — NO construye pantallas
  nuevas de presentación (fuera de un ajuste mínimo en `flow.tsx` SOLO si AC-13 lo requiere, y
  siempre acotado a lo estrictamente necesario para que el Review no se rompa).
- **CD-2**: OBLIGATORIO que la reducción de PII (AC-1/AC-2) se aplique en UN SOLO helper
  compartido entre `persistence.ts` y `kyc-store.ts` — PROHIBIDO duplicar la lógica de
  masking/reducción en 2 archivos distintos (riesgo de que uno se actualice y el otro no, mismo
  espíritu que CD de WKH-179 sobre `maskIdentity`).
- **CD-3**: PROHIBIDO introducir un 4to valor en el union type `riskLevel: "low"|"medium"|"high"`
  — cualquier señal AML no reconocida cae al fallback binario existente (AC-10/DT-4), no se
  extiende el dominio sin decisión explícita del Architect.
- **CD-4**: PROHIBIDO implementar cifrado "de mentira" (ej. base64, XOR con clave hardcodeada) como
  sustituto de cifrado real — si no hay key-management seguro disponible (confirmado en Scope
  OUT), NO cifrar es preferible a cifrar mal (falsa sensación de seguridad).
- **CD-5**: OBLIGATORIO que `list()` con filtro de address sea case-insensitive (mismo patrón ya
  usado en `kyc-store.ts:30,35` — `address.toLowerCase()`), para no crear falsos negativos por
  checksum de address (EIP-55) vs lowercase.

## Missing Inputs
- `[NEEDS CLARIFICATION — bloqueante para F2]` AC-3/DT-1: ¿persistir nombre completo
  (`firstName`/`lastNamePaternal`/`lastNameMaternal`) cuenta como "PII cruda" prohibida por esta
  HU, o el foco es específicamente DNI (`documentNumber`)/DOB (mencionados explícitamente en el
  texto original de la HU)? La lectura literal de "solo últimos-4 + verificationId +
  approved/payoutAllowed" rompe el Review; la interpretación de grounding (DT-1) preserva nombres.
  Requiere confirmación humana antes de F2.
- `[NEEDS CLARIFICATION — bloqueante para F2]` AC-8/DT-2: ¿el fix de `FallbackWallet` (pseudo-
  address por instalación en vez de constante compartida) es AC obligatoria de esta HU, o se
  defiere a una HU aparte? Sin esto, el objetivo declarado de la HU (parar el leak "María Elena
  vieja") no se logra para usuarios sin wallet real — el caso más probable en remesas familiares.
- `[NEEDS CLARIFICATION — no bloqueante, resolver en F2]` DT-3: ¿migrar/descartar snapshots
  legacy activamente (ej. bump de `KEY` a `.v2`, pierde historial existente) o dejar que el
  próximo `save()` naturalmente sanee (recomendado, no bloqueante)?
- `[NEEDS CLARIFICATION — no bloqueante, resolver en F2]` DT-3 (kyc-store TTL): valor exacto de la
  ventana de expiración del KYC recordado (ej. 90/180 días) — no especificado en la HU original;
  el Architect debe fijar un default razonable (sugerido: alinear con práctica AML estándar de
  revisión periódica, sin inventar un número sin justificación regulatoria).
- `[NEEDS CLARIFICATION — no bloqueante, resolver en F2/con sandbox real]` AC-9: nombre(s) exacto(s)
  del campo AML en el payload de Didit — no se puede confirmar sin acceso al workflow con AML
  (WKH-22/Fase A). El mapeo se implementa de forma defensiva/extensible, no se bloquea la HU por
  esto (AC-10 cubre el caso sin campo presente).
- `[resuelto en F0]` `kyc-store.ts` YA está keyed por address — el gap no es el keying en sí, es
  la falta de reducción de PII + TTL, y el colapso real de "por wallet" viene de
  `FallbackWallet` (DT-2), no de `LocalKycStore`.
- `[resuelto en F0]` `list()` no se consume hoy desde ninguna pantalla — el fix es preventivo
  además de cerrar la exposición directa vía inspección de `localStorage`.

## Análisis de paralelismo
- Corre en paralelo con **WKH-180** (mismo repo `chaski-v2`, misma auditoría 2026-07-10, NNN `003`
  en `doc/sdd/003-wkh-180-.../` — coordinado por el orquestador para evitar colisión de NNN con
  esta HU, que usa `004`). Confirmar con el Architect/Dev de WKH-180 si tocan los mismos archivos
  (`persistence.ts`, `kyc-store.ts`, `decision.ts`) antes de F3.
- Depende del estado ya mergeado de **WKH-178** (demo-safe fixes en `flow.tsx`/
  `track-remittance.ts`) y **WKH-179** (auth/rate-limit + `maskDecision` en `decision.ts`) — AMBAS
  YA en `main`. Esta HU trabaja sobre ese estado; el masking de WKH-179 (`maskDecision`, límite
  HTTP server→cliente) es una capa DISTINTA y complementaria a la reducción cliente→localStorage
  de esta HU (ver Scope OUT) — no hay conflicto, pero SÍ comparten el archivo
  `decision.ts` (WKH-179 agregó `maskIdentity`/`maskDecision` al final del archivo; esta HU toca
  `mapDiditDecision` en el medio) — bajo riesgo de conflicto de merge, no de lógica.
- No bloquea otras HUs conocidas del backlog; es aislada a la capa de persistencia
  cliente/dominio de identidad.
- Internamente: A3 (reducción de PII + ownership/list) y M5 (riskLevel) son independientes entre
  sí y pueden implementarse en paralelo. AC-8 (FallbackWallet) es un prerequisito de facto para
  que A3 cumpla su objetivo declarado, pero es técnicamente separable (se puede mergear después).

## Waves sugeridas (para F3, referencia — el Architect define las definitivas en F2.5)
- **Wave 1**: dominio (`remittance.ts` — `ownerAddress` en `RemittanceState`, tipo de identidad
  reducida) + helper compartido de reducción de PII (testeable en aislamiento, sin I/O).
- **Wave 2**: `persistence.ts` (AC-1, AC-4, AC-5, AC-7) + `kyc-store.ts` (AC-2, TTL) + `ports.ts`
  (firma de `list()`) — aplican el helper de Wave 1.
- **Wave 3**: `start-kyc.ts` (AC-6, setear `ownerAddress`) + `container.ts`/`list-history.ts`
  (propagar `address`) + `decision.ts` (AC-9/AC-10, riskLevel) — independiente de Wave 2, puede ir
  en paralelo.
- **Wave 4** (condicionada a resolución de AC-8): `wallet.ts` — pseudo-address por instalación en
  `FallbackWallet`.
