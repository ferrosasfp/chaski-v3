# Story File W1 — WKH-227 / HU-SOL-24 · repo `wasiai-remittance-agents` (PROVIDER)

> Contrato autocontenido para el Dev. Deriva de `chaski-v3/doc/sdd/032-wkh-227-contratos-idl-golden/sdd.md` (SPEC_APPROVED). El Dev SOLO lee este archivo. Si algo no está acá, no se hace.
>
> **Repo de trabajo:** `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents`
> **Wave:** W1 (paralelizable con W2 y W3 — repos distintos, sin archivos compartidos)
> **Naturaleza:** 100% ADITIVO. Solo se CREAN fixtures + 1 test. CERO edición de código de producción.

---

## 1. Contexto mínimo

`wasiai-remittance-agents` expone 3 agentes A2A cuyo OUTPUT viaja por el wire hacia consumers (chaski-v3, marketplace). Esta HU congela el CONTRATO de esos outputs como **fixtures tipados** + un **contract test provider-side** que ancla la fuente de verdad: si el shape que devuelve `run*()` cambia, el test se pone ROJO. El consumer (chaski-v3, W3) vendorea COPIAS de estos fixtures; este repo es el ORIGEN.

Los 3 agentes:
- `remit-corridor-fx` → `runCorridorFx()` → `CorridorFxOutput` (FX quote).
- `remit-kyc-validator` → `runKycValidator()` → `KycAgentOutput` (KYC, SIN PII).
- `remit-cashout-payout` → `runCashoutPayout()` → `CashoutPayoutOutput` (payout).

Los INPUT tienen schema Zod (`*InputSchema`); los OUTPUT son **interfaces TS sin Zod** → el anclaje del output es una **shape-assertion** (keys + `typeof` por campo), no `schema.parse()` (DT-7).

---

## 2. Scope IN — archivos EXACTOS a crear (todos nuevos, todos bajo `contracts/` en la raíz del repo)

| # | Archivo (path absoluto) | Acción |
|---|-------------------------|--------|
| 1 | `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/contracts/corridor-fx.output.fixture.ts` | Crear |
| 2 | `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/contracts/kyc-validator.output.fixture.ts` | Crear |
| 3 | `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/contracts/cashout-payout.output.fixture.ts` | Crear |
| 4 | `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/contracts/inputs.fixture.ts` | Crear |
| 5 | `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/contracts/contracts.provider.test.ts` | Crear |

> **NADA fuera de `contracts/`.** No tocar `src/agents/*`, `src/providers/*`, ni ningún schema/interface existente.

**Grounding verificado (por qué `contracts/` en la raíz funciona en ESTE repo):**
- `vitest.config.ts` NO define `include` → usa el glob default de vitest → `contracts/**/*.test.ts` **SÍ se ejecuta** con `npm test`. ✓
- `tsconfig.json` tiene `"include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]` → `contracts/**/*.ts` **SÍ es type-checkeado** por `tsc --noEmit`. ✓
- No existe carpeta `contracts/` previa → se crea limpia.

---

## 3. Anti-Hallucination Checklist (verificar ANTES de escribir)

- [ ] Import de tipos: `import type { CorridorFxOutput } from "../src/agents/corridor-fx";` (el tipo se exporta ahí, línea 22). NO redefinir el tipo.
- [ ] `KycAgentOutput` se exporta en `../src/agents/kyc-validator` (línea 34). `CashoutPayoutOutput` en `../src/agents/cashout-payout` (línea 50).
- [ ] Los `*InputSchema` se exportan: `CorridorFxInputSchema` (corridor-fx.ts:13), `KycInputSchema` (kyc-validator.ts:16), `CashoutPayoutInputSchema` (cashout-payout.ts:18).
- [ ] Las funciones core se exportan: `runCorridorFx`, `runKycValidator`, `runCashoutPayout`.
- [ ] Los valores de los fixtures salen de los TESTS EXISTENTES (DT-5), NO se inventan. Ver §4.
- [ ] `KycAgentOutput` **NO** tiene `travelRuleData` ni `legalId` — el fixture tampoco (CD-7). Verificado: kyc-validator.ts:34-43 no los incluye.
- [ ] NO usar `any`. Strict-typed (CD-9). Cada fixture tipado explícitamente con `: <OutputType>`.
- [ ] NO agregar dependencias. `zod` y `vitest` ya están.

---

## 4. Valores canónicos de los fixtures (de los tests existentes — DT-5)

### 4.1 INPUTs (`contracts/inputs.fixture.ts`)

Los 3 inputs canónicos, reusando `validInput` de cada `*.test.ts`:

```ts
// origen FX: src/agents/corridor-fx.test.ts:18 (runCorridorFx({ amountUsd: 100 }))
export const corridorFxInput = { amountUsd: 100 };

// origen KYC: src/agents/kyc-validator.test.ts:4-12 (validInput)
export const kycInput = {
  senderName: "Alice",
  senderCountry: "US",
  legalId: "12345678",
  amountUsd: 100,
  receiverName: "Bob",
  receiverCountry: "PE",
  purpose: "family support",
};

// origen payout: src/agents/cashout-payout.test.ts:8-18 (validInput)
export const cashoutPayoutInput = {
  quoteId: "q1",
  amountUsd: 100,
  kycVerificationId: "v1",
  senderIdentity: "12345678",
  beneficiary: { name: "Bob", country: "PE", method: "yape", destination: "999999999" },
  idempotencyKey: "idem-1",
};
```

> `corridorFxInput` usa solo `amountUsd` (el resto tiene defaults Zod). `kycInput.legalId` "12345678" es el sanitizado del test (NO PII real, CD-7).

### 4.2 OUTPUTs

Los OUTPUT se derivan de correr `run*()` con esos inputs en el **fallback determinístico** (sin keys reales). El Dev debe **generar los valores exactos ejecutando el test una vez** (ver §5) — NO transcribirlos a ojo. El fixture tipado captura el shape:

**`corridor-fx.output.fixture.ts`** — tipado `: CorridorFxOutput`. Shape (de `FxQuote` + `slug`, ver src/providers/types.ts:82-91 y corridor-fx.ts:22-24):
`{ slug, rate, feeUsd, netDeliveredLocal, localCurrency, etaMinutes, quoteId, expiresAt, provenance }`.
- FIAT queda `number` (`rate`, `feeUsd`, `netDeliveredLocal`) — AC-5, NO convertir.
- `localCurrency: "PEN"`, `provenance` es el objeto `Provenance` del provider.

**`kyc-validator.output.fixture.ts`** — tipado `: KycAgentOutput`. Shape (kyc-validator.ts:34-43):
`{ slug, approved, riskLevel, reasons, verificationId, provenance, payoutAllowed }`.
- Del test kyc-validator.test.ts:33-35: fallback + nada seteado → `provenance:"local-fallback"`, `approved:true`, `payoutAllowed:false`.
- **PROHIBIDO** incluir `travelRuleData`/`legalId` (CD-7).

**`cashout-payout.output.fixture.ts`** — tipado `: CashoutPayoutOutput`. Shape (cashout-payout.ts:50-60):
`{ slug, executed, status, payoutId, deliveredLocal, txRef, reason, provenance, depositAddress }`.
- Rama recomendada: **blocked** (fail-closed sin KYC real), que es determinística sin partner. Con `kycVerificationId:"v1"` y fallback KYC no-aprobado por default → `executed:false, status:"blocked", reason:"kyc_gate_not_passed", depositAddress:null`. El Dev confirma la rama exacta al generar (§5).
- `depositAddress: string | null` (WKH-212) — presente SIEMPRE, `null` en blocked/mock.

> Header AC-7/CD-6 en CADA fixture (patrón "COPIA PINNEADA" del IDL). En este repo (ORIGEN) el header indica que es la FUENTE:
> ```
> // FIXTURE DE CONTRATO — ORIGEN (provider). WKH-227 / HU-SOL-24, sync: 2026-07-22.
> // Captura el OUTPUT canónico de run<Agente>() en fallback determinístico. NO editar a mano:
> // regenerar corriendo contracts/contracts.provider.test.ts (ver doc). El consumer (chaski-v3)
> // vendorea una COPIA con header "COPIA PINNEADA, NO SE EDITA".
> ```

---

## 5. `contracts/contracts.provider.test.ts` (AC-1)

Exemplar: `src/agents/corridor-fx.test.ts` (vitest + `vi.stubEnv` + `vi.stubGlobal("fetch", ...)` + `afterEach` unstub). Estructura:

**Bloque A — INPUTs pasan su schema (Zod real):**
```ts
CorridorFxInputSchema.parse(corridorFxInput);   // no throw
KycInputSchema.parse(kycInput);                 // no throw
CashoutPayoutInputSchema.parse(cashoutPayoutInput); // no throw
```

**Bloque B — cada OUTPUT fixture shape-matchea lo que `run*()` devuelve HOY (DT-7, ancla de la verdad):**
- Stubear el entorno para forzar el fallback determinístico (mismos `vi.stubEnv`/`vi.stubGlobal` que el test de cada agente: FX mockea `fetch` `{rates:{PEN:3.8}}` con `TRANSFI_API_KEY:""`; KYC con `DIDIT_API_KEY:""`, `NODE_ENV:""`, `ALLOW_FALLBACK_KYC:""`; payout con el stub de decisión Didit del test — ver cashout-payout.test.ts para el patrón `stubDiditDecision`).
- Correr `const out = await runCorridorFx(corridorFxInput);` etc.
- Assertar que **el set de keys del fixture === el set de keys de `out`** y que el `typeof` de cada campo coincide. Ejemplo de anclaje:
  ```ts
  expect(Object.keys(out).sort()).toEqual(Object.keys(corridorFxOutputFixture).sort());
  for (const k of Object.keys(corridorFxOutputFixture)) {
    expect(typeof (out as Record<string, unknown>)[k]).toBe(typeof (corridorFxOutputFixture as Record<string, unknown>)[k]);
  }
  ```
- Para KYC: assertar además que `JSON.stringify(out)` NO contiene `"12345678"` ni `"travelRuleData"` (espeja kyc-validator.test.ts:19-20 — CD-7 en el contrato).

> **Regeneración del fixture (si el shape cambia legítimamente):** el Dev corre el test, lee `out`, y actualiza el fixture con esos valores. NO se escribe el fixture "a ojo": se copia de la salida real. Es el mecanismo que hace el fixture la fuente de verdad (si el agente cambia, este test obliga a re-sincronizar el fixture antes de que W3 lo vendoree).

---

## 6. Constraint Directives que aplican a W1

- **CD-1**: CERO cambio de comportamiento runtime. Solo fixtures + 1 test. Ningún archivo de `src/` se edita.
- **CD-6/AC-7**: cada fixture lleva header de origen + fecha sync.
- **CD-7**: PROHIBIDO PII real. Reusar los sanitizados (Alice/Bob, legalId "12345678"). El output KYC NO lleva `travelRuleData`/`legalId`.
- **CD-9 (heredado WKH-196)**: gate = `npm run typecheck` (`tsc --noEmit` COMPLETO) + `npm test`. Tests strict-typed, sin `any`.
- **AC-5**: FIAT (`rate`/`feeUsd`/`netDeliveredLocal`) queda `number`. NO convertir a string/bigint. Esta HU no reabre eso.
- **DT-5**: valores de los tests existentes, no inventados. **DT-7**: output anclado por shape-assertion (no Zod).

---

## 7. Tests requeridos

| Test | AC | Cómo verifica el drift |
|------|----|------------------------|
| `contracts.provider.test.ts` bloque A | AC-1 | INPUT canónico contra `*InputSchema.parse()` |
| `contracts.provider.test.ts` bloque B | AC-1 | OUTPUT fixture vs shape real de `run*()` (keys + typeof) — si un agente renombra/añade/quita un campo, el set de keys diverge → ROJO |
| Suite existente completa | AC-6 | debe seguir 100% verde |

---

## 8. Done Definition (W1)

- [ ] Los 5 archivos creados bajo `contracts/`, cada fixture con header AC-7.
- [ ] `cd /home/ferdev/.openclaw/workspace/wasiai-remittance-agents && npx tsc --noEmit` → 0 errores (COMPLETO, CD-9).
- [ ] `npm test` → suite previa 100% verde + `contracts.provider.test.ts` verde (AC-6).
- [ ] Fixtures generados de la salida REAL de `run*()` (no transcritos a ojo).
- [ ] Ningún archivo fuera de `contracts/` modificado.
- [ ] KYC fixture sin PII/`travelRuleData` (CD-7) — verificado por el assert de `JSON.stringify`.

---

## 9. Comando de verificación

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-remittance-agents
npx tsc --noEmit            # CD-9: gate estático COMPLETO
npm test                   # AC-6: suite previa verde + contracts.provider.test.ts
```
