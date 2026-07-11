# SDD — [WKH-181] No persistir PII cruda + historial por-wallet + riskLevel AML

- **HU**: WKH-181  ·  **NNN**: 004  ·  **Modo**: QUALITY  ·  **SDD_MODE**: full
- **Input**: `work-item.md` (13 ACs, 5 CDs, DT-1..4) + gate HU_APPROVED + decisiones del orquestador (ver §0).
- **Repo**: `chaski-v2/`  ·  **Branch sugerido**: `fix/181-pii-persistence-history-per-wallet`
- **Autor**: nexus-architect (F2)

---

## 0. Decisiones del orquestador aplicadas (cierran los NEEDS CLARIFICATION del work-item)

| # | Tema | Decisión aplicada en este SDD |
|---|------|-------------------------------|
| D1 | AC-3/DT-1 | Tipo persistido `PersistedIdentity = { firstName, lastNamePaternal, lastNameMaternal, documentType, documentNumberLast4 }`. DROP de `documentNumber` completo + `dateOfBirth` + `nationality` de todo lo persistido. Nombres SÍ se persisten. Helper de reducción ÚNICO (CD-2). |
| D2 | AC-8/DT-2 | **DIFERIDO**. NO se toca `wallet.ts`. AC-8 sale del alcance de código. Se documenta como residual (§9). AC-5/6/7 SÍ se implementan (sirven a usuarios con wallet real). |
| D3 | DT-3 legacy | Defensivo, sin migración activa, sin bump de `KEY`. Reads no crashean ante shape viejo; normalización-en-lectura auto-sanea al próximo `save()`. |
| D4 | KYC TTL | **180 días** (default, configurable — const documentada). |
| D5 | AC-9 AML | Defensivo/extensible: leer UN campo candidato SOLO si presente y ∈ `"low"\|"medium"\|"high"`; cualquier otra cosa → fallback binario. Sin 4to valor (CD-3). Sin inventar múltiples nombres de campo. |

---

## 1. Context Map (archivos leídos, línea real, patrón extraído)

| Archivo:línea | Rol | Qué extraje / por qué importa |
|---------------|-----|-------------------------------|
| `src/domain/remittance.ts:27-35` | `VerifiedIdentity` | Tipo FULL que Didit extrae: `documentNumber` completo + `dateOfBirth` + `nationality` + nombres + `documentType`. Es la PII cruda. |
| `src/domain/remittance.ts:37-44` | `KycVerification` | `identity: VerifiedIdentity \| null`. Es lo que persiste el estado y el KycStore. **Punto de cambio de tipo → `PersistedIdentity \| null`**. |
| `src/domain/remittance.ts:79-94` | `RemittanceState` | NO tiene campo de ownership. `createdAt/updatedAt` presentes. **Agregar `ownerAddress: string \| null`**. |
| `src/domain/remittance.ts:99-118` | `create()` | Inicializa todos los campos a `null`. Setear `ownerAddress: null`. |
| `src/domain/remittance.ts:134-143` | `to()` / `startKyc(now)` | La transición aplica un `patch: Partial<RemittanceState>`. `startKyc` → `kyc_pending`. **Punto para setear `ownerAddress` (AC-6)**: cambiar firma a `startKyc(now, ownerAddress)`. |
| `src/domain/remittance.ts:145-151` | `applyKyc(kyc, now)` | Guarda `kyc` completo en el estado. Sale de `kyc_pending` → `kyc_passed/kyc_failed`. El `kyc.identity` que entra debe venir YA reducido (ver §3, Approach 2). |
| `src/infrastructure/persistence.ts:9-15` | `replacer`/`reviver` | Solo (de)serializa `Money`. No toca PII. Base para el read defensivo (AC-4). |
| `src/infrastructure/persistence.ts:28-39` | `LocalRepo.read()` | `JSON.parse(raw, reviver)` sin validar shape → in-mem fallback si no hay `window` (tests corren en node → usa `this.mem`). **Punto de normalización-en-lectura (AC-4)**. |
| `src/infrastructure/persistence.ts:50-63` | `save()` / `list()` | `save` serializa el snapshot; `list()` devuelve TODO sin filtro. **`list()` → `list(address)` + filtro por `ownerAddress` case-insensitive (AC-5/7, CD-5)**. |
| `src/infrastructure/kyc-store.ts:16-43` | `LocalKycStore` | Ya keyed por `address.toLowerCase()` (L30,35). Guarda `KycVerification` cruda sin TTL. **Agregar wrapper `{ v, savedAt }` + expiry 180d + read defensivo (AC-2, AC-4)**. Usa el mismo patrón `ls()` node-safe. |
| `src/application/ports.ts:90-93` | `KycStore` | Firma `get(address)`/`save(address, kyc)`. **NO cambia** (TTL es interno del adapter). |
| `src/application/ports.ts:96-100` | `RemittanceRepository` | **`list(): Promise<RemittanceState[]>` → `list(address: string)`**. Sección "Persistencia" (aislada de la sección Payout que toca WKH-180). |
| `src/application/use-cases/list-history.ts:8-10` | `ListHistory.execute()` | Llama `repo.list()`. **`execute(address)` → `repo.list(address)`**. |
| `src/application/use-cases/start-kyc.ts:23-56` | `StartKyc.execute()` | Único punto donde `remittanceId` + `address` coexisten en TODAS las ramas. `r.startKyc(nowIso())` L33. **Pasar `input.address` a `startKyc(now, address)` (AC-6)**. Reusa `remembered` del store (identity ya reducida). |
| `src/application/use-cases/resume-kyc.ts:46-49` | `ResumeKyc` | Aplica la decisión al volver del redirect. `applyKyc(v)`. **NO cambia**: el owner ya quedó seteado en `startKyc` (antes del redirect, L60 del start-kyc). La `v.identity` viene reducida del gateway. |
| `src/infrastructure/didit/kyc-gateway.ts:35-53` | `DiditKycGateway.decision()` | Construye `KycVerification` desde `DiditDecisionResult`. `identity: d.identity` (L50). **Reducir: `toPersistedIdentity(d.identity)`** (producer de PII → punto de reducción). |
| `src/infrastructure/fallback/gateways.ts:63-90` | `FallbackKycGateway` | `simulated()` construye `identity` FULL inline (fixture "María Elena / Quispe / Mamani", L79-88). **Envolver con `toPersistedIdentity(...)`**. Corre en modo simulación (AC-12). |
| `src/infrastructure/didit/decision.ts:16-54` | `mapDiditDecision` | `DiditRaw` (L16-20) sin campo AML. L49 `riskLevel: approved ? "low" : "high"`. **Solo la L49 + `DiditRaw` (aditivo) cambian (AC-9/10)**. Produce `DiditDecisionResult` con `VerifiedIdentity` FULL — **no cambia** (es el tipo de frontera server). |
| `src/infrastructure/didit/decision.ts:56-70` | `maskIdentity`/`maskDecision` | WKH-179, reducción en el LÍMITE HTTP (server→cliente). **NO SE TOCA** (capa distinta, ver §8). |
| `src/presentation/flow.tsx:510-522` | Review render | Lee `rem.kyc.identity.firstName/.lastNamePaternal/.lastNameMaternal/.documentType` (L516-519) + `.documentNumber.slice(-4)` (L519). `dateOfBirth`/`nationality` NO se renderizan. **Único cambio de presentación: L519 `.documentNumber.slice(-4)` → `.documentNumberLast4` (AC-13, mínimo permitido por CD-1)**. |
| `src/test-support/fakes.ts:49-61` | `InMemoryRepo` | `list()` sin filtro. **`list(address)` + filtro por `ownerAddress`**. |
| `src/test-support/fakes.ts:87-105` | `FakeKycGateway.v()` | Fixture identity FULL. **Reducir vía `toPersistedIdentity`**. |
| `src/domain/remittance.test.ts:27,49` | Tests dominio | Llaman `r.startKyc(T0)`. **Actualizar a `startKyc(T0, "0x...")`**. |
| `src/infrastructure/didit/decision.test.ts:5-35,71-119` | Tests decision | `mapDiditDecision` asserts sobre `identity.documentNumber`/`dateOfBirth` (siguen sobre `VerifiedIdentity`, NO cambian). `maskIdentity` tests (WKH-179) intactos. **Extender AC-9/10/11**. |

**Environment de test (verificado)**: no hay `vitest.config.*` → env por defecto `node`. En node no existe `window` → `LocalRepo`/`LocalKycStore` caen al `Map` en memoria (`this.mem`). Para testear el path `localStorage` real (serialización sin PII, read defensivo legacy, TTL) se usa un **stub `Storage` Map-backed en `globalThis.window`** dentro del test (jsdom NO está instalado). Ver §6.

---

## 2. Constraint Directives (heredados + nuevos)

**Heredados del work-item (vigentes):**
- **CD-1**: PROHIBIDO tocar archivos fuera de `chaski-v2/`. PROHIBIDO tocar el demo live (`yarvis`, `wasiai-v2`, `agentshop-*`). Presentación: solo el ajuste mínimo de `flow.tsx:519` requerido por AC-13.
- **CD-2**: la reducción de PII vive en UN SOLO helper compartido (`toPersistedIdentity`). PROHIBIDO duplicar la lógica en 2 archivos.
- **CD-3**: PROHIBIDO un 4to valor en `riskLevel: "low"|"medium"|"high"`. Señal AML no reconocida → fallback binario.
- **CD-4**: PROHIBIDO cifrado "de mentira" (base64/XOR/clave hardcodeada). No cifrar es preferible (Scope OUT).
- **CD-5**: `list()` filtra address case-insensitive (`.toLowerCase()`, patrón `kyc-store.ts:30,35`).

**Nuevos (F2):**
- **CD-6**: la reducción de PII ocurre **aguas arriba** del estado (en el punto donde el gateway construye el `KycVerification`), NO con un type-lie en `persistence.ts`. El dominio/estado/KycStore/UI hablan `PersistedIdentity`; `VerifiedIdentity` (FULL) queda confinado a la frontera Didit (`DiditDecisionResult` en `decision.ts`) y NUNCA entra al estado del cliente. Motivo: type-honesty — con el nombre de campo `documentNumberLast4` (D1), un read-back tipado como `VerifiedIdentity` mentiría (`documentNumber`/`dateOfBirth` = `undefined` en runtime → crash en el Review). Ver §3.
- **CD-7**: PROHIBIDO modificar `container.ts`, `confirm-and-send.ts` ni `resume-kyc.ts` en esta HU (minimización de colisión de merge con WKH-180 — ver §7). El `ownerAddress` se setea en `startKyc` (upstream de `resume`); el TTL es interno del adapter (no cambia `container` wiring); `ListHistory` recibe `address` en `execute()`, no en el ctor (no cambia wiring).
- **CD-8**: PROHIBIDO tocar `maskIdentity`/`maskDecision` (`decision.ts:56-70`, WKH-179) ni `app/api/kyc/*`. Son la capa HTTP, distinta de la capa cliente→localStorage de esta HU (§8).
- **CD-9** (auto-blindaje WKH-179#2): `tsconfig` tiene `noUncheckedIndexedAccess` activo. OBLIGATORIO optional-chaining / `!` deliberado en TODO acceso por índice (ej. `raw?.id_verifications?.[0]`, `arr[0]!`). Tipar explícitamente los `vi.fn` cuyos `.mock.calls` se inspeccionen. Referencia: `002-wkh-179/auto-blindaje.md#2`.
- **CD-10** (auto-blindaje WKH-179#1): PROHIBIDO reconstruir a mano tipos literal-template de librerías; derivarlos con `Parameters<>`/`ReturnType<>`. (No aplica directo acá — no se envuelve lib — pero se hereda como regla del repo.) Referencia: `002-wkh-179/auto-blindaje.md#1`.

---

## 3. Decisión técnica central: dónde se reduce la PII (DT-1 + CD-6)

**Problema.** D1 fija un tipo persistido distinto `PersistedIdentity` con el campo `documentNumberLast4` (renombrado). El estado `RemittanceState.kyc.identity` es UN solo tipo usado pre- y post-persistencia. Si se dejara `VerifiedIdentity | null` y se redujera solo al serializar en `persistence.ts.save()`, el read-back produciría objetos con forma `PersistedIdentity` (sin `documentNumber`/`dateOfBirth`) pero tipados `VerifiedIdentity` → **type-lie + crash** en `flow.tsx:519` (`identity.documentNumber` = `undefined`).

**Decisión (Approach 2 — reducción upstream, type-honest).**
1. `KycVerification.identity: PersistedIdentity | null` — contrato de dominio. El estado NUNCA contiene PII cruda.
2. Reducción en **cada producer de `KycVerification.identity`** vía el helper único `toPersistedIdentity` (CD-2/CD-6):
   - `kyc-gateway.ts` (Didit real): `identity: d.identity ? toPersistedIdentity(d.identity) : null`.
   - `fallback/gateways.ts` (simulación): `identity: toPersistedIdentity({ ...FULL fixture... })`.
   - `fakes.ts` `FakeKycGateway`: idem (test-support).
3. `persistence.ts`/`kyc-store.ts` **serializan lo ya reducido** → cumplen AC-1/AC-2 por construcción (nunca reciben PII cruda). Refuerzo defensivo: normalización-en-lectura (AC-4, §4).
4. `VerifiedIdentity` (FULL) permanece intacto como tipo de frontera Didit (`DiditDecisionResult`), consumido por `maskIdentity` (WKH-179) y por `mapDiditDecision`. `mapDiditDecision` **no cambia** su producción de identity.

**Consecuencia de scope (surfaced).** El cambio de tipo de `KycVerification.identity` ripplea a TODOS los producers → suma a Scope IN: `kyc-gateway.ts`, `fallback/gateways.ts`, `fakes.ts`, y el ajuste mínimo de `flow.tsx:519`. El work-item Scope IN (escrito pre-decisión de tipo) ubicaba la reducción en `persistence.ts`/`kyc-store.ts`; la decisión explícita del orquestador (D1, `documentNumberLast4`) **necesita** esta ubicación upstream para ser type-sound. CD-2 (helper único) se cumple genuinamente: todos los producers embudan por `toPersistedIdentity`.

**Alternativa rechazada (Approach 1).** Reducir solo en `save()` manteniendo `VerifiedIdentity | null` + campo `documentNumber` (4 chars) en vez de `documentNumberLast4`: evitaría tocar gateways y `flow.tsx`, pero (a) contradice el nombre de campo explícito de D1, (b) hace `documentNumber` ambiguo (a veces full, a veces 4). Rechazada por decisión explícita del orquestador.

---

## 4. Diseño por archivo (contratos, sin implementación — F3)

### 4.1 `src/domain/remittance.ts` (W1)
- **NEW** `PersistedIdentity`:
  ```ts
  export interface PersistedIdentity {
    firstName: string;
    lastNamePaternal: string;
    lastNameMaternal: string;
    documentType: string;
    documentNumberLast4: string; // solo últimos 4 (o menos si el doc es más corto)
  }
  ```
- **CHANGE** `KycVerification.identity: PersistedIdentity | null` (era `VerifiedIdentity | null`).
- **KEEP** `VerifiedIdentity` sin cambios (tipo de frontera Didit).
- **NEW** helper puro (único, CD-2):
  ```ts
  export function toPersistedIdentity(id: VerifiedIdentity): PersistedIdentity {
    const dn = id.documentNumber ?? "";
    return {
      firstName: id.firstName,
      lastNamePaternal: id.lastNamePaternal,
      lastNameMaternal: id.lastNameMaternal,
      documentType: id.documentType,
      documentNumberLast4: dn.slice(-4), // "44556677" → "6677"; "" → ""; "12" → "12"
    };
  }
  ```
- **CHANGE** `RemittanceState`: agregar `ownerAddress: string | null;`. `create()` lo inicializa a `null`.
- **CHANGE** firma `startKyc(now: string, ownerAddress: string): void` → `this.to("kyc_pending", now, { ownerAddress })`. (Requerido, no `string | undefined`.)

### 4.2 `src/application/ports.ts` (W2)
- **CHANGE** `RemittanceRepository.list(address: string): Promise<RemittanceState[]>`.
- `KycStore` **sin cambios** (TTL interno del adapter). *(Sección "Persistencia" L96-100 — aislada de la sección "Payout" que toca WKH-180 → colisión baja.)*

### 4.3 `src/infrastructure/persistence.ts` (W2)
- **`list(address)`** (AC-5/7, CD-5): filtrar `s.ownerAddress?.toLowerCase() === address.toLowerCase()` antes del `sort`. `ownerAddress` null/legacy → excluido (AC-7).
- **Normalización-en-lectura defensiva** (AC-4, DT-3): en `read()`, tras el parse, si `s.kyc?.identity` tiene forma legacy (posee `documentNumber` y/o `dateOfBirth`, sin `documentNumberLast4`), reducirla con `toPersistedIdentity(legacy as VerifiedIdentity)` y strip de campos crudos. Auto-sanea al próximo `save()`. NO crashea ante props de más (JS ignora extras al desestructurar). Sin bump de `KEY` (D3 — no perder historial).
- `save()` sin cambios de reducción (el estado ya viene reducido, CD-6).

### 4.4 `src/infrastructure/kyc-store.ts` (W2)
- **TTL 180d** (D4, AC-2): cambiar el shape persistido a `Record<address, { v: KycVerification; savedAt: number }>`.
  - Const documentada configurable: `const KYC_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 días — revisión AML periódica; promovible a NEXT_PUBLIC_KYC_TTL_DAYS`.
  - `save(address, kyc)`: `{ v: kyc, savedAt: Date.now() }`. `Date.now()` en el adapter infra es consistente con `wallet.ts:58`/`gateways.ts` (no es dominio → no viola la regla de pureza).
  - `get(address)`: si entry ausente → null; si `Date.now() - savedAt > KYC_TTL_MS` → null (expirado → fuerza re-verificación); si shape **legacy** (bare `KycVerification` sin `savedAt`) → null (defensivo AC-4: no servir KYC sin TTL; el re-verify persiste el shape nuevo). Non-crashing.
- `identity` que entra ya viene reducida (CD-6) → el store solo serializa.

### 4.5 `src/application/use-cases/list-history.ts` (W2)
- **CHANGE** `execute(address: string): Promise<RemittanceState[]>` → `return this.repo.list(address);`.
- *(Sin caller vivo hoy — código muerto desde la UI. No requiere cambio en `container.ts`.)*

### 4.6 `src/application/use-cases/start-kyc.ts` (W3)
- **CHANGE** L33: `r.startKyc(this.clock.nowIso(), input.address);` (AC-6). Se setea al ENTRAR a `kyc_pending` → cubre las 3 ramas (KYC-once, completed, redirect) y el redirect persiste con owner ya seteado (L60). Remesas abandonadas en `created`/`send` quedan con `ownerAddress: null` → excluidas de `list()` (AC-7).

### 4.7 `src/infrastructure/didit/kyc-gateway.ts` (W3)
- **CHANGE** L50: `identity: d.identity ? toPersistedIdentity(d.identity) : null` (import de `toPersistedIdentity` desde `domain/remittance`).

### 4.8 `src/infrastructure/fallback/gateways.ts` (W3)
- **CHANGE** `FallbackKycGateway.simulated()`: envolver el fixture identity FULL con `toPersistedIdentity(...)`. Mantiene el fixture "María Elena / Quispe / Mamani" (regresión demo, AC-12), reducido.

### 4.9 `src/infrastructure/didit/decision.ts` (W3) — cirugía mínima (colisión con WKH-180)
- **ADITIVO** en `DiditRaw`: `risk_level?: string; // TBD — placeholder pendiente sandbox AML (WKH-22/Fase A)`.
- **NEW** helper puro (AC-11):
  ```ts
  function resolveRiskLevel(raw: DiditRaw, approved: boolean): "low" | "medium" | "high" {
    const c = raw?.risk_level; // UN candidato documentado; NO inventar múltiples nombres (D5)
    if (c === "low" || c === "medium" || c === "high") return c; // señal fina válida (AC-9)
    return approved ? "low" : "high"; // fallback binario (AC-10, CD-3)
  }
  ```
- **CHANGE** solo la L49 del return de `mapDiditDecision`: `riskLevel: resolveRiskLevel(raw, approved),`.
- `maskIdentity`/`maskDecision` (L56-70) **intactos** (CD-8).

### 4.10 `src/presentation/flow.tsx` (W3) — mínimo AC-13
- **CHANGE** L519: `••••{rem.kyc.identity.documentNumber.slice(-4)}` → `••••{rem.kyc.identity.documentNumberLast4}`. Único cambio de presentación (CD-1). L516-518 (nombres) intactos.

### 4.11 `src/test-support/fakes.ts` (W2/W3)
- **CHANGE** `InMemoryRepo.list(address)`: filtrar por `ownerAddress` case-insensitive (paridad con `LocalRepo`).
- **CHANGE** `FakeKycGateway.v()`: `identity` vía `toPersistedIdentity({ ...FULL... })`.

---

## 5. Waves de implementación

| Wave | Serial? | Archivos | ACs | Depende de |
|------|---------|----------|-----|-----------|
| **W1** — dominio + reducer | **Serial (contratos)** | `domain/remittance.ts` (`PersistedIdentity`, `KycVerification.identity`, `ownerAddress`, `startKyc` firma, `toPersistedIdentity`) + `domain/remittance.test.ts` | AC-1, AC-11(reducer), AC-6(campo) | — |
| **W2** — persistencia + store + ports | Tras W1 | `application/ports.ts` (`list(address)`) · `persistence.ts` (filtro + read defensivo) · `kyc-store.ts` (TTL + read defensivo) · `list-history.ts` · `fakes.ts` (`InMemoryRepo.list`) · **NEW** `persistence.test.ts` · **NEW** `kyc-store.test.ts` | AC-2, AC-4, AC-5, AC-7 | W1 |
| **W3** — producers + wiring + AML | Tras W1 (paralela a W2) | `start-kyc.ts` (AC-6) · `kyc-gateway.ts` (reduce) · `fallback/gateways.ts` (reduce) · `fakes.ts` (`FakeKycGateway`) · `decision.ts` (riskLevel) · `decision.test.ts` · `flow.tsx:519` · `use-cases.test.ts` | AC-6, AC-9, AC-10, AC-12, AC-13 | W1 |

**Sin Wave 4** (`wallet.ts` / AC-8 diferido — D2, §9).

---

## 6. Plan de tests (≥1 por AC)

| AC | Test (archivo) | Qué cubre |
|----|----------------|-----------|
| AC-1 | `remittance.test.ts` — `toPersistedIdentity` | Dropea `documentNumber` full + `dateOfBirth` + `nationality`; conserva nombres + `documentType` + `documentNumberLast4`. Edge: `"44556677"→"6677"`, `""→""`, `"12"→"12"` (noUncheckedIndexedAccess-safe). |
| AC-2 | `kyc-store.test.ts` (NEW) | `save` almacena `{ v, savedAt }`; el `v.identity` es `PersistedIdentity` (sin claves crudas). Serialización a stub `localStorage` no contiene `documentNumber`/`dateOfBirth`/`nationality` (assert sobre el string). |
| AC-4 | `persistence.test.ts` + `kyc-store.test.ts` (NEW) | Read defensivo: sembrar en el stub un snapshot **legacy** (identity FULL, sin `ownerAddress`/`documentNumberLast4`) → `read()` no crashea + normaliza a `PersistedIdentity`. KycStore legacy (bare `KycVerification`) → `get()` devuelve `null` sin crash. |
| AC-5 | `persistence.test.ts` (NEW) | `list("0xAAA")` solo devuelve remesas con `ownerAddress` == 0xAAA (case-insensitive: `0xaaa`/`0xAAA` matchean). Remesa de `0xBBB` NO aparece. |
| AC-6 | `use-cases.test.ts` (extend) | Tras `startKyc.execute({address:"0xAAA"})`, el snapshot persistido tiene `ownerAddress == "0xAAA"`. |
| AC-7 | `persistence.test.ts` (NEW) | Remesa guardada sin `ownerAddress` (status `created`/`send`) → excluida de `list(anyAddress)`. Legacy sin owner → excluida. |
| AC-9 | `decision.test.ts` (extend) | `mapDiditDecision({status:"Approved", risk_level:"medium"})` → `riskLevel === "medium"`. |
| AC-10 | `decision.test.ts` (extend) | Sin `risk_level` presente → `approved?"low":"high"` (regresión: los tests existentes L27,42 siguen verdes). |
| AC-11 | `decision.test.ts` (extend) | `resolveRiskLevel`/`mapDiditDecision` puro, sin I/O. Valor inválido (`risk_level:"extreme"`) → fallback binario (CD-3, sin 4to valor). |
| AC-12 | `use-cases.test.ts` (existente + extend) | Flujo fallback (`FakeKycGateway`/`FallbackKycGateway`) sigue verde sin sandbox Didit; identity reducida presente. |
| AC-13 | `decision.test.ts` / manual + `use-cases.test.ts` | El estado post-KYC expone `documentNumberLast4` y nombres → el Review (`flow.tsx:519`) renderiza nombre + `••••6677`. (Presentación: cambio de campo verificado por typecheck.) |
| AC-3 | (cubierto por AC-1/AC-13) | Nombres + `documentType` preservados en el persistido. |
| AC-8 | **Out-of-scope esta HU** (§9) | Diferido — sin test de código. Documentado como residual/follow-up. |

**Infra de test para localStorage** (CD-9): stub `Storage` Map-backed inyectado en `globalThis.window` al inicio de `persistence.test.ts`/`kyc-store.test.ts`; TTL testeado con `vi.setSystemTime`/`vi.useFakeTimers`. Métodos del stub tipados explícitamente (no `any`).

Comando de verificación: `npm run qa` (typecheck + vitest). Meta: 0 regresiones en los 3 test files existentes tocados.

---

## 7. Coordinación de merge con WKH-180 (NNN 003)

WKH-180 (payout authority server-side) mergea **PRIMERO** (va más adelante). Superficie compartida:

| Archivo | WKH-180 | WKH-181 | Colisión | Mitigación |
|---------|---------|---------|----------|-----------|
| `ports.ts` | Sección **Payout** (`PayoutAuthorityGateway`, ~L62-80) | Sección **Persistencia** (`RemittanceRepository.list(address)`, ~L96-100) | **Baja** (regiones distintas) | git auto-merge. |
| `decision.ts` | `DiditRaw`+`vendor_data`/`vendorData` + extrae en `mapDiditDecision` + `HttpPayoutAuthorityGateway` | `DiditRaw`+`risk_level?` + `resolveRiskLevel` + cambia L49 `riskLevel:` | **Media** (ambos editan `DiditRaw` y el return de `mapDiditDecision`) | 181 diseñado surgical/aditivo (líneas distintas): agregar `risk_level?` como línea separada en `DiditRaw`; cambiar SOLO la línea `riskLevel:`. **El Dev de 181 rebasa sobre main tras el merge de 180.** Ediciones lógicamente independientes. |
| `container.ts` | SÍ (wiring nuevo gateway) | **NO** (CD-7) | **Nula** | 181 no toca el archivo. |
| `confirm-and-send.ts` | SÍ | **NO** (CD-7) | **Nula** | 181 no toca el archivo. |

**Nota para `_INDEX.md`**: registrar orden de merge 180 → 181. El único punto de rebase manual esperado es `decision.ts`.

---

## 8. Regresión / no-daño (verificado en grounding)

- **Review** (`flow.tsx:510-522`): sigue mostrando nombre (`firstName`+`lastNamePaternal`+`lastNameMaternal`) + `documentType` + `••••` + últimos 4 (ahora `documentNumberLast4`). Sin cambio visual para el usuario (AC-13).
- **Flujo demo/fallback** (AC-12): `FallbackKycGateway`/`FakeKycGateway` producen identity reducida con el mismo fixture; el money-path (`use-cases.test.ts` happy path) intacto. No requiere sandbox Didit.
- **WKH-179 masking** (`decision.ts:56-70`, `app/api/kyc/*`): capa HTTP server→cliente, **intacta** y ortogonal. Esta HU reduce en la capa cliente→localStorage. Complementarias, no se fusionan (CD-8, Scope OUT del work-item).
- **KYC-once** (`start-kyc.ts:36-40`): sigue funcionando con identity reducida en el store; el TTL 180d agrega expiración (fuerza re-verify periódico — mejora AML, no regresión funcional para el demo).
- **`mapDiditDecision`**: los tests existentes (`decision.test.ts` L22-34, L37-43) sobre `identity.documentNumber`/`dateOfBirth` siguen verdes (operan sobre `DiditDecisionResult`/`VerifiedIdentity`, que NO cambia).

---

## 9. Residual / follow-up (AC-8 DIFERIDO — decisión de producto/UX del founder)

**Problema abierto (no se corrige en esta HU).** `FallbackWallet.connect()` (`wallet.ts:47-53`) devuelve **SIEMPRE** la constante `"0xDEMO00000000000000000000000000000A11ce"` (L51). `pickWallet()` (L128-133) cae a `FallbackWallet` cuando NO hay wallet inyectada Y no está `NEXT_PUBLIC_REOWN_PROJECT_ID` — el caso típico de un **teléfono compartido sin wallet real** (remesas familiares).

**Consecuencia.** Para ese segmento, TODOS los usuarios comparten la misma `address`. El filtro por `ownerAddress` de esta HU (AC-5/6/7) y el `KycStore` keyed-por-address los colapsan en la MISMA entrada → el bug **"María Elena vieja"** (la identidad del primer verificador se reutiliza para el siguiente) **persiste para ese segmento**. Filtrar "por address" no aísla usuarios si la address es compartida.

**Por qué AC-5/6/7 SÍ valen igual.** Para usuarios con wallet **REAL** (`InjectedWallet` / `WalletConnectWallet` — el caso de producción, `wallet.ts:15-44,71-120`), cada usuario tiene address propia → el ownership filter aísla correctamente. Esta HU cierra el leak para prod y deja el repositorio/store listos para el día que se construya una pantalla de historial (sin nacer con cross-user leak).

**Fix completo diferido (fuera de código de esta HU).** Requiere decisión de producto/UX del founder, no una pseudo-address silenciosa. Opciones a evaluar en una HU aparte:
1. **Gate de KYC tras wallet real**: no permitir KYC/persistencia bajo `FallbackWallet` (exigir conexión de wallet real antes de verificar identidad).
2. **Reset explícito de sesión** en dispositivo compartido (botón "cambiar de usuario" que limpia `chaski.kyc.v1` + `chaski.remittances.v1` + pendientes).
3. Pseudo-address por instalación (DT-2 original) — descartada como fix silencioso: enmascara el problema de UX sin decisión de producto.

**No se toca `wallet.ts` en esta HU** (D2, CD-1).

---

## 10. Exemplars verificados (paths confirmados con Read)

| Patrón | Exemplar | Uso |
|--------|----------|-----|
| Reducer puro sobre identity | `maskIdentity` (`decision.ts:60-65`) | Forma/estilo de `toPersistedIdentity` (pero vive en `domain`, no toca `decision.ts`). |
| Filtro address case-insensitive | `kyc-store.ts:30,35` (`.toLowerCase()`) | CD-5 en `LocalRepo.list`. |
| `localStorage` node-safe + reviver defensivo | `persistence.ts:17-39` | Read defensivo AC-4 + stub de test. |
| `Date.now()` en adapter infra | `wallet.ts:58`, `gateways.ts:26,51` | TTL en `kyc-store.ts` (no viola pureza de dominio). |
| Test de use-case con fakes | `use-cases.test.ts:24-53`, `abandon-pending-kyc.test.ts` | AC-6/12. |
| Test de mapeo puro | `decision.test.ts:5-58` | AC-9/10/11. |
| Port interface | `ports.ts:96-100` (`RemittanceRepository`) | Cambio de firma `list(address)`. |

---

## 11. Readiness Check

- [x] Work-item leído completo (13 ACs, 5 CDs, DT-1..4).
- [x] Decisiones del orquestador aplicadas (D1..D5) → NEEDS CLARIFICATION resueltos (AC-3 ✔ D1, AC-8 ✔ diferido D2, DT-3 ✔ D3, TTL ✔ 180d D4, AC-9 ✔ D5).
- [x] Todos los archivos referenciados verificados con Read (líneas reales, §1).
- [x] Decisión de arquitectura central resuelta y justificada (§3, CD-6 — reducción upstream, type-honest).
- [x] Scope delta surfaced (gateways/fakes/flow.tsx suman a Scope IN por el cambio de tipo — §3).
- [x] Waves definidas (W1 serial → W2/W3 paralelas; sin W4).
- [x] Test plan ≥1 por AC (AC-8 documentado out-of-scope, §6).
- [x] Coordinación de merge con WKH-180 diseñada (§7 — solo `decision.ts` rebasa).
- [x] Regresión analizada (§8 — Review, demo, WKH-179 masking intactos).
- [x] Residual documentado (§9 — FallbackWallet, decisión del founder).
- [x] CDs heredados + nuevos (CD-1..CD-10), incl. auto-blindaje WKH-179 (#1,#2).
- [x] Sin `[NEEDS CLARIFICATION]` abiertos.

**Estado: LISTO para SPEC_APPROVED.**
