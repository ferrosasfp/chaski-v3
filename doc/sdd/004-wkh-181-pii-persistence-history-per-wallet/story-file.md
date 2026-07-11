# Story File — #004: [WKH-181] No persistir PII cruda + historial por-wallet + riskLevel AML

> SDD: `doc/sdd/004-wkh-181-pii-persistence-history-per-wallet/sdd.md`
> Work-item: `doc/sdd/004-wkh-181-pii-persistence-history-per-wallet/work-item.md`
> Fecha: 2026-07-11
> Branch: `fix/181-pii-persistence-history-per-wallet`
> Repo: `chaski-v2/` (100% este repo — CD-1)

---

## Goal

Reducir la PII que se persiste en `localStorage` (nunca escribir `documentNumber` completo / `dateOfBirth` / `nationality`), aislar el historial y el KYC-once **por wallet real** (`ownerAddress` en el estado + `list(address)` filtrado), agregar TTL de 180 días al KYC recordado, y dejar el mapeo de `riskLevel` abierto a una señal AML fina sin romper el fallback binario. Cierra el hallazgo A3 + M5 de la auditoría adversarial 2026-07-10 (bug "María Elena vieja" para usuarios con wallet real).

**Contexto clave que el Dev DEBE tener presente:**
- El estado se rehidrata desde `localStorage` en cada paso post-KYC (`repo.get(id)` → `setRem(snapshot)`), así que lo que se persiste SÍ llega al render del Review. Por eso la reducción de PII se hace **aguas arriba** (en los productores del `KycVerification.identity`), no con un type-lie en `persistence.ts` (ver §"Decisión central" y CD-6).
- **AC-8 (FallbackWallet) está DIFERIDO** — NO se toca `wallet.ts`. Para usuarios sin wallet real (pseudo-address hardcodeada compartida) el bug persiste; es una decisión de producto del founder, fuera de esta HU. AC-5/6/7 SÍ se implementan y sirven a usuarios con wallet real (caso de producción). No agregues nada en `wallet.ts`.

---

## Acceptance Criteria (EARS)

> Copiados del SDD/work-item aprobados. QA los verifica en F4.

- **AC-1**: WHEN un `Remittance` se persiste vía `RemittanceRepository.save()`, el sistema NO escribe `documentNumber` completo ni `dateOfBirth` a `localStorage` — `documentNumber` se reduce a los últimos ≤4 caracteres y `dateOfBirth`/`nationality` se omiten del representado persistido.
- **AC-2**: WHEN un `KycVerification` se persiste vía `KycStore.save()`, se aplica la misma reducción de PII que AC-1 (mismo shape reducido, single source of truth — helper único).
- **AC-3**: WHEN se persiste identidad, el sistema PRESERVA `firstName`, `lastNamePaternal`, `lastNameMaternal`, `documentType` (necesarios para el Review). *(Resuelto D1: nombres SÍ se persisten.)*
- **AC-4**: IF hay un snapshot legacy en `localStorage` (escrito antes del fix) con `VerifiedIdentity` no reducida, THEN el sistema NO crashea al leer (parse defensivo) y normaliza al shape reducido.
- **AC-5**: WHEN se llama `RemittanceRepository.list(address)`, el sistema devuelve SOLO entries cuyo `ownerAddress` matchea `address` (case-insensitive). Ningún registro de otra wallet aparece.
- **AC-6**: WHEN un `Remittance` transiciona por primera vez fuera de `kyc_pending` (identidad verificada, en `start-kyc.ts`), el sistema registra la `address` del caller como owner del estado persistido.
- **AC-7**: IF un `RemittanceState` no tiene owner `address` (remesa abandonada en `created`/`send`), THEN `list()` lo EXCLUYE de cualquier resultado scopeado por address.
- **AC-8**: **DIFERIDO** (D2). NO se toca `wallet.ts`. Documentado como residual/follow-up (§Out of Scope). Sin código en esta HU.
- **AC-9**: WHEN `mapDiditDecision` procesa un payload con una señal AML/riesgo identificable más fina que approve/decline, el sistema PRESERVA esa señal (`"medium"`) en vez de colapsar a `approved ? "low" : "high"`.
- **AC-10**: IF no hay campo AML/riesgo en el payload (caso actual: workflow "Free KYC" sin AML), THEN el sistema cae al mapeo binario existente (`approved ? "low" : "high"`) — sin regresión.
- **AC-11**: El sistema mantiene `mapDiditDecision`/`resolveRiskLevel` puro/testeable sin I/O.
- **AC-12**: WHILE `NEXT_PUBLIC_KYC_MODE` no está en `"didit"` (modo simulación/fallback), el sistema preserva el flujo de fallback (`FallbackKycGateway`) sin requerir el sandbox real de Didit.
- **AC-13**: WHEN el Review (`flow.tsx`) renderiza `rem.kyc.identity` tras el fix, sigue mostrando nombre verificado + documento enmascarado (últimos 4) exactamente igual que antes.

---

## ⚠️ Anti-Hallucination Anchors (líneas REALES verificadas al 2026-07-11)

> El SDD tiene algunos números de línea desactualizados (`decision.ts:49`, `ports.ts:96-100`). **Estos anchors son la fuente de verdad — verificados con `Read` sobre `main`.** Si al abrir un archivo la línea no coincide (por merge de WKH-180 previo), buscá el CONTENIDO citado, no confíes en el número.

| Archivo | Símbolo | Línea REAL | Contenido a anclar |
|---------|---------|-----------|--------------------|
| `src/domain/remittance.ts` | `VerifiedIdentity` | **L27-35** | `documentNumber` L32, `dateOfBirth` L33, `nationality` L34 (los que se DROPEAN) |
| `src/domain/remittance.ts` | `KycVerification.identity` | **L43** | `identity: VerifiedIdentity \| null` → cambia a `PersistedIdentity \| null` |
| `src/domain/remittance.ts` | `RemittanceState` | **L79-94** | NO tiene ownership → agregar `ownerAddress: string \| null` |
| `src/domain/remittance.ts` | `create()` | **L99-118** | todos los campos a `null` (L107-114) → agregar `ownerAddress: null` |
| `src/domain/remittance.ts` | `to()` | **L134-139** | aplica `patch: Partial<RemittanceState>` |
| `src/domain/remittance.ts` | `startKyc(now)` | **L141-143** | `this.to("kyc_pending", now)` → firma `startKyc(now, ownerAddress)` + patch `{ ownerAddress }` |
| `src/domain/remittance.ts` | `applyKyc(kyc, now)` | **L145-151** | recibe `kyc` con `identity` YA reducida (no cambia la firma) |
| `src/infrastructure/persistence.ts` | `reviver`/`replacer` | **L9-15** | solo (de)serializa `Money`; base del read defensivo |
| `src/infrastructure/persistence.ts` | `read()` | **L28-39** | `JSON.parse(raw, reviver)` sin validar shape → punto de normalización AC-4 |
| `src/infrastructure/persistence.ts` | `save()` | **L50-54** | serializa snapshot ya reducido (no reduce acá) |
| `src/infrastructure/persistence.ts` | `list()` | **L61-63** | `[...values()].sort(...)` sin filtro → `list(address)` + filtro por `ownerAddress` |
| `src/infrastructure/kyc-store.ts` | `KEY` | **L6** | `"chaski.kyc.v1"` — NO bumpear (D3) |
| `src/infrastructure/kyc-store.ts` | `read()` | **L19-27** | `JSON.parse(... ?? "{}")` → read defensivo del wrapper |
| `src/infrastructure/kyc-store.ts` | `get(address)` | **L29-31** | `this.read()[address.toLowerCase()] ?? null` → aplicar TTL + legacy |
| `src/infrastructure/kyc-store.ts` | `save(address, kyc)` | **L33-42** | `all[address.toLowerCase()] = kyc` → envolver en `{ v, savedAt }` |
| `src/application/ports.ts` | `KycStore` | **L102-106** | NO cambia (TTL interno del adapter) |
| `src/application/ports.ts` | `RemittanceRepository.list` | **L112** | `list(): Promise<RemittanceState[]>` → `list(address: string)` |
| `src/application/use-cases/list-history.ts` | `execute()` | **L8-10** | `execute()` → `execute(address)` + `repo.list(address)` (en execute, NO en ctor) |
| `src/application/use-cases/start-kyc.ts` | `startKyc` call | **L33** | `r.startKyc(this.clock.nowIso())` → `r.startKyc(this.clock.nowIso(), input.address)` |
| `src/application/use-cases/start-kyc.ts` | `execute` | **L23-68** | ÚNICO punto con `remittanceId` + `address` en las 3 ramas; L33 cubre KYC-once (L36-41), completed (L51-56) y redirect (L60) |
| `src/infrastructure/didit/kyc-gateway.ts` | `decision()` | **L50** | `identity: d.identity` → `d.identity ? toPersistedIdentity(d.identity) : null` |
| `src/infrastructure/fallback/gateways.ts` | `simulated()` | **L72-89** | fixture FULL `identity` L79-87 ("María Elena / Quispe / Mamani") → envolver con `toPersistedIdentity({...})` |
| `src/infrastructure/didit/decision.ts` | `DiditRaw` | **L17-22** | ya tiene `vendor_data?` (WKH-180) → agregar `risk_level?: string` como línea SEPARADA (aditivo) |
| `src/infrastructure/didit/decision.ts` | `mapDiditDecision` | **L31-57** | return L46-56 |
| `src/infrastructure/didit/decision.ts` | `riskLevel:` | **L51** | `riskLevel: approved ? "low" : "high"` → `riskLevel: resolveRiskLevel(raw, approved)` (SDD decía L49 — es L51) |
| `src/infrastructure/didit/decision.ts` | `maskIdentity`/`maskDecision` | **L63-73** | **NO TOCAR** (WKH-179, capa HTTP — CD-8) |
| `src/presentation/flow.tsx` | Review render | **L510-522** | nombres L516-518 (intactos); `.documentNumber.slice(-4)` L519 → `.documentNumberLast4` |
| `src/test-support/fakes.ts` | `InMemoryRepo.list` | **L60-62** | `[...store.values()]` sin filtro → filtrar por `ownerAddress` case-insensitive |
| `src/test-support/fakes.ts` | `FakeKycGateway.v()` | **L89-107** | fixture FULL identity L96-104 → reducir vía `toPersistedIdentity` |
| `src/composition/container.ts` | `new ListHistory(repo)` | **L64** | `ListHistory` recibe `address` en `execute()`, NO en ctor → **NO cambia** (CD-7) |

**Verificado además:**
- No hay `vitest.config.*` → env de test = `node`. En node no existe `window` → `LocalRepo`/`LocalKycStore` caen al `Map` en memoria. Para testear el path `localStorage` real (serialización sin PII, legacy, TTL) hay que inyectar un **stub `Storage` Map-backed** en `globalThis.window`. jsdom NO está instalado.
- `decision.ts` en `main` YA contiene `vendor_data?`/`vendorData` (superficie de WKH-180 ya presente). El cambio de esta HU es puramente aditivo sobre eso.
- Tests que NO existen aún (se CREAN): `persistence.test.ts`, `kyc-store.test.ts`. Tests existentes a extender: `remittance.test.ts`, `decision.test.ts`, `use-cases.test.ts`.

---

## Decisión central: dónde se reduce la PII (CD-6 — LEER ANTES DE CODEAR)

**Regla:** el estado (`RemittanceState.kyc.identity`), el KycStore y la UI hablan `PersistedIdentity` (SIN `documentNumber`/`dateOfBirth`/`nationality`). El tipo FULL `VerifiedIdentity` queda confinado a la frontera Didit (`DiditDecisionResult` en `decision.ts`, consumido por `maskIdentity`) y **NUNCA entra al estado del cliente**.

La reducción ocurre en **cada productor** de `KycVerification.identity`, embudada por UN helper único `toPersistedIdentity` (CD-2):
1. `kyc-gateway.ts` L50 (Didit real).
2. `fallback/gateways.ts` `simulated()` (simulación/demo).
3. `fakes.ts` `FakeKycGateway.v()` (test-support).

`persistence.ts`/`kyc-store.ts` **serializan lo ya reducido** → cumplen AC-1/AC-2 por construcción. El read defensivo (AC-4) es el refuerzo para snapshots legacy.

**PROHIBIDO** reducir solo en `save()` manteniendo `VerifiedIdentity | null` en el estado: con el campo renombrado `documentNumberLast4`, un read-back tipado `VerifiedIdentity` mentiría (`documentNumber`/`dateOfBirth` = `undefined` en runtime → crash en `flow.tsx:519`).

---

## Tipos exactos

```ts
// domain/remittance.ts — NEW
export interface PersistedIdentity {
  firstName: string;
  lastNamePaternal: string;
  lastNameMaternal: string;
  documentType: string;
  documentNumberLast4: string; // últimos ≤4; nunca el número completo
}

// domain/remittance.ts — NEW helper puro y único (CD-2)
export function toPersistedIdentity(id: VerifiedIdentity): PersistedIdentity {
  const dn = id.documentNumber ?? "";
  return {
    firstName: id.firstName,
    lastNamePaternal: id.lastNamePaternal,
    lastNameMaternal: id.lastNameMaternal,
    documentType: id.documentType,
    documentNumberLast4: dn.slice(-4), // "44556677"→"6677"; ""→""; "12"→"12"
  };
}
```
- `KycVerification.identity: PersistedIdentity | null` (era `VerifiedIdentity | null`).
- `VerifiedIdentity` (L27-35) **queda intacto** (tipo de frontera Didit).
- `RemittanceState` gana `ownerAddress: string | null`; `create()` lo pone en `null`.
- `startKyc(now: string, ownerAddress: string): void` → `this.to("kyc_pending", now, { ownerAddress })`. (Requerido, NO `string | undefined`.)

**KYC TTL (kyc-store.ts):**
```ts
const KYC_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 días — revisión AML periódica; promovible a NEXT_PUBLIC_KYC_TTL_DAYS
// shape persistido: Record<address, { v: KycVerification; savedAt: number }>
```
- `save`: `{ v: kyc, savedAt: Date.now() }` (`Date.now()` en adapter infra es OK, patrón `gateways.ts:26`).
- `get`: entry ausente → `null`; `Date.now() - savedAt > KYC_TTL_MS` → `null` (expirado → fuerza re-verify); shape legacy (bare `KycVerification` sin `savedAt`) → `null` (defensivo AC-4, non-crashing).

**riskLevel defensivo (decision.ts):**
```ts
function resolveRiskLevel(raw: DiditRaw, approved: boolean): "low" | "medium" | "high" {
  const c = raw?.risk_level; // UN candidato documentado; NO inventar múltiples nombres
  if (c === "low" || c === "medium" || c === "high") return c; // señal fina válida (AC-9)
  return approved ? "low" : "high"; // fallback binario (AC-10, CD-3)
}
```
- `DiditRaw` gana `risk_level?: string; // TBD placeholder AML (WKH-22/Fase A)` como línea separada.
- Cambia SOLO la línea `riskLevel:` (L51) del return.

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/domain/remittance.ts` | Modificar | `PersistedIdentity` (NEW) + `toPersistedIdentity` (NEW, único) + `KycVerification.identity: PersistedIdentity\|null` + `ownerAddress` en `RemittanceState` + `create()` init `null` + firma `startKyc(now, ownerAddress)` | `maskIdentity` (`decision.ts:63-68`) para el estilo del reducer puro |
| 2 | `src/domain/remittance.test.ts` | Modificar | Actualizar llamadas `startKyc(T0)` → `startKyc(T0, "0x...")` + tests de `toPersistedIdentity` (AC-1) | tests existentes del mismo archivo |
| 3 | `src/application/ports.ts` | Modificar | `RemittanceRepository.list(address: string): Promise<RemittanceState[]>` (L112). `KycStore` NO cambia | sección "Persistencia" L108-113 |
| 4 | `src/infrastructure/persistence.ts` | Modificar | `list(address)` + filtro `ownerAddress` case-insensitive (AC-5/7); read defensivo AC-4 (normaliza identity legacy). `save()` sin cambios | `kyc-store.ts:29,35` para `.toLowerCase()` |
| 5 | `src/infrastructure/persistence.test.ts` | **Crear** | AC-4 (read legacy no crashea + normaliza), AC-5 (filtro por address), AC-7 (sin owner → excluido). Stub `Storage` en `globalThis.window` | `kyc-auth.test.ts` para setup de test infra |
| 6 | `src/infrastructure/kyc-store.ts` | Modificar | Wrapper `{ v, savedAt }` + TTL 180d + read defensivo legacy (AC-2/AC-4). Serializa identity ya reducida | `wallet.ts`/`gateways.ts:26` (`Date.now()` en infra) |
| 7 | `src/infrastructure/kyc-store.test.ts` | **Crear** | AC-2 (serializa `{v,savedAt}`, sin PII cruda en el string), AC-4 (legacy bare → `get` null). TTL con `vi.useFakeTimers`/`vi.setSystemTime` | `rate-limit.test.ts` para fake timers |
| 8 | `src/application/use-cases/list-history.ts` | Modificar | `execute(address: string)` → `repo.list(address)` (en execute, NO ctor) | archivo actual L8-10 |
| 9 | `src/application/use-cases/start-kyc.ts` | Modificar | L33: `r.startKyc(this.clock.nowIso(), input.address)` (AC-6). Cubre las 3 ramas | archivo actual L23-68 |
| 10 | `src/infrastructure/didit/kyc-gateway.ts` | Modificar | L50: `identity: d.identity ? toPersistedIdentity(d.identity) : null` (import de `domain/remittance`) | — |
| 11 | `src/infrastructure/fallback/gateways.ts` | Modificar | `simulated()` L72-89: envolver fixture FULL con `toPersistedIdentity({...})`. Mantener "María Elena / Quispe / Mamani" (AC-12) | — |
| 12 | `src/infrastructure/didit/decision.ts` | Modificar | `DiditRaw += risk_level?: string` (aditivo) + `resolveRiskLevel` (NEW puro) + cambiar SOLO L51 `riskLevel:`. **NO tocar `maskIdentity`/`maskDecision`** | `mapDiditDecision` actual (patrón puro) |
| 13 | `src/infrastructure/didit/decision.test.ts` | Modificar | AC-9 (`risk_level:"medium"`→`"medium"`), AC-10 (sin campo → binario, regresión verde), AC-11 (`"extreme"`→fallback, sin 4to valor) | tests existentes L5-58 |
| 14 | `src/presentation/flow.tsx` | Modificar | SOLO L519: `.documentNumber.slice(-4)` → `.documentNumberLast4`. Nombres L516-518 intactos (AC-13) | archivo actual L510-522 |
| 15 | `src/test-support/fakes.ts` | Modificar | `InMemoryRepo.list(address)` filtra por `ownerAddress` (L60-62); `FakeKycGateway.v()` reduce identity (L96-104) | `FakeKycStore:170-178` |
| 16 | `src/application/use-cases.test.ts` | Modificar | Extender: AC-6 (owner seteado tras `startKyc`), AC-12 (fallback verde con identity reducida) | tests existentes del archivo |

**NO tocar** (fuera de la tabla): `wallet.ts` (AC-8 diferido), `container.ts` (CD-7), `confirm-and-send.ts` (CD-7), `resume-kyc.ts` (CD-7), `app/api/kyc/*` (CD-8), `decision.ts:63-73` masking (CD-8).

---

## Constraint Directives

### OBLIGATORIO
- **CD-2**: la reducción de PII vive en UN SOLO helper (`toPersistedIdentity` en `domain/remittance.ts`). Todos los productores lo embudan. PROHIBIDO duplicar la lógica.
- **CD-5**: `list(address)` filtra case-insensitive (`.toLowerCase()` en ambos lados, patrón `kyc-store.ts:29,35`).
- **CD-6**: reducción **aguas arriba** (en los productores del `KycVerification.identity`), NO type-lie en `persistence.ts`. `VerifiedIdentity` FULL confinado a la frontera Didit.
- **CD-9** (auto-blindaje WKH-179#2): `tsconfig` tiene `noUncheckedIndexedAccess` activo. Optional-chaining / `!` deliberado en TODO acceso por índice (ej. `raw?.id_verifications?.[0]`, `arr[0]!`). Tipar explícitamente los `vi.fn`/stubs cuyos `.mock.calls` se inspeccionen. NO `any`.
- **CD-10** (auto-blindaje WKH-179#1): PROHIBIDO reconstruir a mano tipos literal-template de librerías; derivarlos con `Parameters<>`/`ReturnType<>` (no aplica directo acá, se hereda como regla del repo).
- El `KEY` de `localStorage` NO se bumpea (`chaski.remittances.v1` / `chaski.kyc.v1`) — D3, no perder historial.
- El fixture demo se mantiene "María Elena / Quispe / Mamani" (reducido) — AC-12.

### PROHIBIDO
- **CD-1**: tocar archivos fuera de `chaski-v2/`. Tocar el demo live (`yarvis`, `wasiai-v2`, `agentshop-*`).
- **CD-3**: introducir un 4to valor en `riskLevel: "low"|"medium"|"high"`. Señal AML no reconocida → fallback binario.
- **CD-4**: cifrado "de mentira" (base64/XOR/clave hardcodeada). No cifrar es preferible (Scope OUT).
- **CD-7**: modificar `container.ts`, `confirm-and-send.ts`, `resume-kyc.ts`.
- **CD-8**: tocar `maskIdentity`/`maskDecision` (`decision.ts:63-73`) ni `app/api/kyc/*`.
- Tocar `wallet.ts` (AC-8 diferido — D2).
- Agregar dependencias nuevas (ninguna): jsdom NO se instala — usá stub `Storage` inline.
- Agregar env vars nuevas (ninguna). `KYC_TTL_MS` es una const documentada, NO una env var en esta HU.

---

## Coordinación de merge con WKH-180

- **WKH-180 mergea PRIMERO** (va más adelante). El único punto de rebase manual es `decision.ts`.
- **Antes de tocar `decision.ts`, re-verificá las líneas reales** de `DiditRaw` y del return de `mapDiditDecision` (el merge de 180 puede haberlas movido). En `main` actual ya está `vendor_data?`/`vendorData` — tu cambio (`risk_level?` + `resolveRiskLevel` + línea `riskLevel:`) es **aditivo y lógicamente independiente**: agregá `risk_level?` como línea SEPARADA en `DiditRaw`, y cambiá SOLO la línea `riskLevel: approved ? "low" : "high"`. No toques `vendorData` ni el masking.
- `ports.ts`: 180 toca la sección **Payout** (`PayoutAuthorityGateway`, L82-93), 181 toca la sección **Persistencia** (`RemittanceRepository.list`, L108-113) → regiones distintas, auto-merge. NO reordenes ni toques la sección Payout.

---

## Test Expectations

| Test | ACs | Framework | Tipo |
|------|-----|-----------|------|
| `src/domain/remittance.test.ts` (extend) | AC-1 (`toPersistedIdentity` dropea `documentNumber`/`dateOfBirth`/`nationality`, conserva nombres + `documentNumberLast4`; edge `"44556677"→"6677"`, `""→""`, `"12"→"12"`) + AC-6 (campo `ownerAddress`) | vitest | unit |
| `src/infrastructure/persistence.test.ts` (**NEW**) | AC-4 (legacy no crashea + normaliza), AC-5 (filtro por address case-insensitive: `0xaaa`/`0xAAA` matchean, `0xBBB` no aparece), AC-7 (sin owner → excluido) | vitest | unit |
| `src/infrastructure/kyc-store.test.ts` (**NEW**) | AC-2 (serializa `{v,savedAt}`, string sin `documentNumber`/`dateOfBirth`/`nationality`), AC-4 (bare legacy → `get` null), TTL (dentro de 180d → hit; pasados 180d → null, con `vi.setSystemTime`) | vitest | unit |
| `src/infrastructure/didit/decision.test.ts` (extend) | AC-9 (`risk_level:"medium"`→`"medium"`), AC-10 (sin campo → `approved?"low":"high"`, regresión verde), AC-11 (`"extreme"`→fallback, sin 4to valor) | vitest | unit |
| `src/application/use-cases.test.ts` (extend) | AC-6 (tras `startKyc.execute({address:"0xAAA"})` el snapshot persistido tiene `ownerAddress=="0xAAA"`), AC-12 (fallback verde, identity reducida presente) | vitest | unit |
| `flow.tsx:519` (typecheck) | AC-13 (el cambio de campo `documentNumberLast4` compila; nombres intactos) | tsc | static |

**Test-first**: SÍ (lógica de dominio + adapters + mapeo). Escribí el test del helper/adapter antes de la implementación cuando sea razonable.

**Infra de test para `localStorage`** (CD-9): stub `Storage` Map-backed inyectado en `globalThis.window` al inicio de `persistence.test.ts`/`kyc-store.test.ts`; métodos tipados explícitamente (no `any`); limpiar en `afterEach`. TTL con `vi.useFakeTimers()`/`vi.setSystemTime()`.

---

## Waves

### Wave -1: Environment Gate (verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v2
npm install 2>/dev/null || echo "revisar package.json"
npm run typecheck   # baseline verde ANTES de empezar
npm run test        # baseline verde ANTES de empezar
# Archivos base del Scope IN existen:
ls src/domain/remittance.ts src/infrastructure/persistence.ts src/infrastructure/kyc-store.ts \
   src/application/ports.ts src/application/use-cases/start-kyc.ts \
   src/infrastructure/didit/decision.ts src/infrastructure/didit/kyc-gateway.ts \
   src/infrastructure/fallback/gateways.ts src/test-support/fakes.ts src/presentation/flow.tsx
```
Si algo falla → PARAR y reportar al orquestador. No implementar sobre entorno roto.

### Wave 1 — dominio + reducer (SERIAL, contratos primero)
- [ ] W1.1: `remittance.ts` → `PersistedIdentity` + `toPersistedIdentity` + `KycVerification.identity: PersistedIdentity|null` + `ownerAddress` en `RemittanceState` + `create()` init `null` + `startKyc(now, ownerAddress)` → Archivo #1
- [ ] W1.2: `remittance.test.ts` → `startKyc(T0, "0x...")` + tests `toPersistedIdentity` (AC-1) → Archivo #2
- Verificación: `npm run test:core` verde.

> Al cambiar `KycVerification.identity` a `PersistedIdentity`, el typecheck va a **romper** en los productores (`kyc-gateway.ts`, `gateways.ts`, `fakes.ts`) hasta W3. Es esperado — completá W2/W3 antes de correr `npm run typecheck` full.

### Wave 2 — persistencia + store + ports (tras W1; paralela a W3)
- [ ] W2.1: `ports.ts` → `list(address: string)` → Archivo #3
- [ ] W2.2: `persistence.ts` → `list(address)` + filtro + read defensivo → Archivo #4
- [ ] W2.3: `kyc-store.ts` → wrapper `{v,savedAt}` + TTL + read defensivo → Archivo #6
- [ ] W2.4: `list-history.ts` → `execute(address)` → Archivo #8
- [ ] W2.5: `fakes.ts` → `InMemoryRepo.list(address)` filtro → Archivo #15
- [ ] W2.6: `persistence.test.ts` (NEW, AC-4/5/7) → Archivo #5
- [ ] W2.7: `kyc-store.test.ts` (NEW, AC-2/4/TTL) → Archivo #7

### Wave 3 — productores + wiring + AML (tras W1; paralela a W2)
- [ ] W3.1: `start-kyc.ts` L33 → `startKyc(now, input.address)` (AC-6) → Archivo #9
- [ ] W3.2: `kyc-gateway.ts` L50 → reducir identity → Archivo #10
- [ ] W3.3: `gateways.ts` `simulated()` → reducir fixture → Archivo #11
- [ ] W3.4: `fakes.ts` `FakeKycGateway.v()` → reducir identity → Archivo #15
- [ ] W3.5: `decision.ts` → `risk_level?` + `resolveRiskLevel` + L51 (AC-9/10/11) → Archivo #12  ← **re-verificar líneas post-merge de WKH-180**
- [ ] W3.6: `decision.test.ts` (AC-9/10/11) → Archivo #13
- [ ] W3.7: `flow.tsx` L519 → `documentNumberLast4` (AC-13) → Archivo #14
- [ ] W3.8: `use-cases.test.ts` (AC-6/12) → Archivo #16

### Wave 4 — verificación final
- [ ] W4.1: `npm run typecheck` (0 errores)
- [ ] W4.2: `npm run test` (0 regresiones; nuevos tests verdes)
- [ ] W4.3: `npm run build` (`next build --webpack` verde)

### Verificación incremental

| Wave | Verificación |
|------|--------------|
| W1 | `npm run test:core` |
| W2 | tests de persistence/kyc-store verdes |
| W3 | tests de decision/use-cases verdes |
| W4 | `npm run typecheck` + `npm run test` + `npm run build` |

---

## Done Definition (DoD)

- [ ] Los 13 ACs codeables cubiertos (AC-8 diferido, documentado — NO se implementa).
- [ ] `toPersistedIdentity` es el ÚNICO reducer, embudado por los 3 productores (CD-2/CD-6).
- [ ] Ningún `documentNumber` completo / `dateOfBirth` / `nationality` en lo persistido (verificado por test sobre el string de `localStorage`).
- [ ] `list(address)` filtra case-insensitive; sin owner → excluido.
- [ ] KYC TTL 180d + read defensivo legacy (no crashea).
- [ ] `riskLevel` sin 4to valor; fallback binario preservado.
- [ ] `wallet.ts`, `container.ts`, `confirm-and-send.ts`, `resume-kyc.ts`, `maskIdentity/maskDecision`, `app/api/kyc/*` **intactos**.
- [ ] `npm run typecheck` → 0 errores.
- [ ] `npm run test` (`vitest run`) → 0 regresiones + tests nuevos verdes.
- [ ] `npm run build` (`next build --webpack`) → verde.
- [ ] Solo archivos de la tabla tocados (branch `fix/181-pii-persistence-history-per-wallet`).

---

## Out of Scope (NO tocar bajo ninguna circunstancia)

- **`src/infrastructure/wallet.ts`** — AC-8 (FallbackWallet pseudo-address) DIFERIDO por decisión de producto del founder. Para usuarios sin wallet real el bug "María Elena vieja" persiste; se cierra en una HU aparte. NO agregar pseudo-address.
- `container.ts`, `confirm-and-send.ts`, `resume-kyc.ts` (CD-7).
- `decision.ts:63-73` (`maskIdentity`/`maskDecision`, WKH-179) y `app/api/kyc/*` (CD-8) — capa HTTP distinta y complementaria.
- Cifrado real de `localStorage` (Scope OUT — sin key-management seguro, no cifrar > cifrar mal).
- Ownership check en `repo.get(id)` (gap IDOR-shaped de baja prioridad, sin superficie hoy).
- Confirmar nombres de campo AML reales de Didit (depende del sandbox WKH-22/Fase A) — el mapeo queda defensivo/extensible con UN candidato `risk_level`.
- Construir una pantalla de historial nueva (esta HU deja el repo/use-case listos, no construye UI).
- El demo live (`yarvis`/`wasiai-v2`/`agentshop-*`) — CD-1.
- "Mejorar" código adyacente / refactors no solicitados.

---

## Escalation Rule

> **Si algo no está en este Story File, el Dev PARA y escala al Architect.** No inventar, no asumir, no improvisar.

Situaciones de escalation:
- Un anchor de línea no coincide y el CONTENIDO citado tampoco aparece (posible drift mayor post-merge de WKH-180).
- El typecheck full sigue rojo tras completar W1-W3 por un caller de `repo.list()` no listado en la tabla.
- Un campo AML real distinto de `risk_level` aparece necesario (no inventar múltiples nombres — escalar).
- El cambio requiere tocar un archivo fuera de la tabla "Files to Modify/Create".

---

*Story File generado por NexusAgil — F2.5 (Architect). Contrato autocontenido: el Dev implementa SOLO desde este documento.*
