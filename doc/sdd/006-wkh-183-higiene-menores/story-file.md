# Story File — [WKH-183] Higiene menor: pending-store huérfano, copy errores, FX/Money, drift env

> **Contrato autocontenido para el Dev (F3).** El Dev SOLO lee este archivo. Si algo no está acá, no se hace.
> **Fuente**: `sdd.md` (SPEC_APPROVED) + `work-item.md` en este mismo dir.
> **Repo**: `/home/ferdev/.openclaw/workspace/chaski-v2/` — **NO salir de acá (CD-1).**

---

## 0. ⚠️ Antes de escribir una línea — Coordinación de merge (LEER PRIMERO)

**WKH-182 mergea ANTES que esta HU.** Al arrancar F3:

1. `git log --oneline -15` → **confirmá que WKH-182 ya está en `main`.** Si NO está, avisá al orquestador antes de seguir.
2. Los números de línea de este Story File se verificaron sobre `main` @ `7838f33` (pre-182). **182 puede mover líneas** en 2 archivos compartidos:
   - `src/infrastructure/fallback/gateways.ts` (línea 53 del doble redondeo).
   - `.env.example`.
3. **REGLA DE ORO: anclá por CONTENIDO, no por número de línea.** Antes de cada Edit, hacé `grep`/`Read` del snippet exacto que vas a tocar y confirmá que sigue ahí. Los números abajo son orientativos post-merge de 182.
4. En los 2 archivos compartidos, **diff ESTRICTAMENTE acotado a las hunks de esta HU (CD-9)** — no reformatear, no tocar hunks que 182 haya agregado.

---

## 1. Contexto (qué se construye y por qué)

Backlog de higiene P3 de la auditoría adversarial 2026-07-10 sobre `chaski-v2` (post WKH-178/179/180/181, todas en `main`). **6 fixes**, de los cuales **solo V1 es un bug real** (BLOQUEANTE); el resto es robustez/copy/docs.

| ID | Qué | Severidad | Archivos |
|----|-----|-----------|----------|
| **V1** | KYC pendiente queda **huérfano/bricked** si `localStorage.setItem` falla | **BLOQUEANTE (bug real)** | `kyc-pending-store.ts` + `start-kyc.ts` + `fakes.ts` (doble de test) |
| V2 | Errores de wallet caen a copy genérico | MENOR | `flow-vm.ts` (mover `humanError`) + `flow.tsx` (importarlo) |
| V3 | Documentar que `FallbackKycGateway` **siempre aprueba** | MENOR (comentario) | `fallback/gateways.ts` |
| V4 | FX doble redondeo | MENOR | `fallback/gateways.ts` |
| V5 | `Money.of()` sin cap safe-int | MENOR | `money.ts` |
| V6 | Drift en `.env.example` (var muerta doc'd como viva + var viva sin doc) | MENOR | `.env.example` |

**CD-1 (inviolable)**: scope = SOLO `chaski-v2/`. PROHIBIDO tocar el demo live (`yarvis`, `wasiai-v2`, `agentshop-*`) ni nada fuera de `chaski-v2/`.

---

## 2. Scope IN — lista exhaustiva de archivos a tocar

**Producción:**
1. `src/infrastructure/kyc-pending-store.ts` — try/catch en `save()`/`clear()` (V1, AC-1).
2. `src/application/use-cases/start-kyc.ts` — reorder `pending.save()` antes de `repo.save(r)` en la rama redirect (V1, AC-2/3/4).
3. `src/presentation/flow-vm.ts` — **mover** `humanError` acá, exportarlo, agregar ramas wallet + `kyc_pending_unavailable` (V2, AC-5/6 + DT-2).
4. `src/presentation/flow.tsx` — **borrar** el `humanError` local; importarlo de `./flow-vm` (agregar al import existente).
5. `src/infrastructure/fallback/gateways.ts` — comentario V3 (AC-7) + quitar doble redondeo V4 (AC-8). **COMPARTIDO con 182.**
6. `src/domain/money.ts` — cap safe-int en `of()` (V5, AC-9).
7. `.env.example` — agregar `NEXT_PUBLIC_REOWN_PROJECT_ID` (AC-10) + anotar `NEXT_PUBLIC_KYC_MODE` deprecated (AC-11). **COMPARTIDO con 182.**

**Tests:**
8. `src/test-support/fakes.ts` — **agregar** `ThrowingKycPendingStore` (NO mutar `FakeKycPendingStore`).
9. `src/application/use-cases.test.ts` — casos nuevos de V1 (AC-1/2/3/4).
10. `src/presentation/flow-vm.test.ts` — casos nuevos de `humanError` (AC-5/6 + CD-5).
11. `src/domain/money.test.ts` — caso nuevo del cap (AC-9).

**NO tocar (fuera de scope):**
- `src/domain/remittance.ts` — **CD-3: `RemittanceStatus`/`TRANSITIONS` NO se tocan.**
- `src/application/ports.ts` — el port `KycPendingStore` ya es correcto.
- `app/api/**` — WKH-179/180 cerrados, **NO reabrir**.
- `FakeQuoteGateway` en `fakes.ts:77` (mismo patrón de redondeo pero es fixture de test — NO tocar, evita drift de otros tests).

---

## 3. Anti-Hallucination Checklist (verificar ANTES de editar)

Todo lo de abajo fue verificado sobre `main` @ `7838f33` (pre-182). **Re-verificá con `Read`/`grep` post-merge de 182.**

| Símbolo / anchor | Archivo:línea (pre-182) | Confirmado |
|------------------|-------------------------|------------|
| `LocalKycPendingStore.save()` — `setItem` sin try/catch | `kyc-pending-store.ts:8-10` | ✅ |
| `LocalKycPendingStore.clear()` — `removeItem` sin try/catch | `kyc-pending-store.ts:21-23` | ✅ |
| `get()` YA tiene try/catch (no tocar) | `kyc-pending-store.ts:11-20` | ✅ |
| Rama redirect: `repo.save(r)` PRIMERO, `pending.save({...})` DESPUÉS | `start-kyc.ts:60-66` | ✅ (orden a invertir) |
| `return { kind: "redirect", url: res.url }` | `start-kyc.ts:67` | ✅ |
| `r.startKyc(...)` muta en memoria (no persiste hasta `repo.save`) | `start-kyc.ts:33` | ✅ |
| Ctor `StartKyc(kyc, kycStore, pending, repo, clock)` — **NO cambia (CD-6)** | `start-kyc.ts:14-21` | ✅ |
| `window.location.href = res.url` dentro de `if (res.kind === "redirect")`, DESPUÉS del `await execute()` | `flow.tsx:193-197` | ✅ |
| `guard()` → `setError(humanError(e.message))` | `flow.tsx:144` | ✅ |
| `humanError(code)` local: `quote_expired`/`QUOTE_STALE`, `kyc`, `payout`, genérico | `flow.tsx:637-643` | ✅ |
| Import existente de flow-vm (agregar `humanError` acá) | `flow.tsx:17` (`import { deliveredDisplay, isDemoMode } from "./flow-vm"`) | ✅ |
| `flow-vm.ts` = módulo PURO (sin `"use client"`/JSX) | `flow-vm.ts:1-12` | ✅ |
| `FallbackKycGateway.simulated()` → `approved:true, payoutAllowed:true` | `gateways.ts:72-89` (aprobación 75-76) | ✅ |
| Comentario de `FallbackKycGateway` NO dice "nunca rechaza" | `gateways.ts:64-65` | ✅ |
| Doble redondeo: `receive: Money.of(Number((netUsd * rate).toFixed(2)), "PEN")` | `gateways.ts:53` | ✅ |
| `Money.of()` — valida `Number.isFinite`+`>=0`, `Math.round(major*factor)`, **sin techo** | `money.ts:16-22` | ✅ |
| Error existente `invalid_money_amount:${major}` | `money.ts:18` | ✅ |
| `.env.example` — `NEXT_PUBLIC_KYC_MODE` doc'd como viva | `.env.example:19-22` | ✅ |
| `.env.example` — `NEXT_PUBLIC_REOWN_PROJECT_ID` NO documentada | (ausente) | ✅ |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` leída de verdad | `wallet.ts:130` | ✅ |
| Códigos wallet | `wallet.ts:20` (`no_wallet`), `23,101` (`no_account`), `34,112` (`wallet_not_connected`) | ✅ |
| `FakeKycPendingStore` — save/get/clear in-memory, **sin modo fallo** | `fakes.ts:122-133` | ✅ |
| `setup()` en use-cases.test.ts crea `pending = new FakeKycPendingStore()` **hardcoded, sin override** | `use-cases.test.ts:32` | ✅ ⚠️ ver §5 W2 |
| Test redirect existente (no-regresión) `FakeKycGateway({}, true)` + `resumeKyc` | `use-cases.test.ts:158-167` | ✅ |
| `TRANSITIONS.created = ["kyc_pending"]` (retry válido); `kyc_pending` NO se auto-transiciona | `remittance.ts:85-97` — **NO tocar (CD-3)** | ✅ |

**Reglas de import (CD-8)**: `KycPending`, `KycPendingStore` viven en `../application/ports` (ya importados en `kyc-pending-store.ts:3`). No inventes símbolos.

---

## 4. El fix de V1 paso a paso (por qué cierra el huérfano)

### Diagnóstico (verificado)
En la rama redirect de `start-kyc.ts` el orden ACTUAL es:
```
60  await this.repo.save(r);          // ← YA persiste status: "kyc_pending"
61  await this.pending.save({...});   // ← si ESTO lanza, la remesa ya quedó en kyc_pending SIN KycPending
67  return { kind: "redirect", url }
```
Si `pending.save()` lanza (quota / private-browsing), la remesa queda persistida en `kyc_pending` **sin** un `KycPending` correlacionable →
- retry: `r.startKyc()` → `to("kyc_pending")` → `invalid_transition:kyc_pending->kyc_pending` (`kyc_pending` NO es destino válido en `TRANSITIONS`). **Brick.**
- resume: `pending.get()` → `null` → `{kind:"none"}`. **Tampoco retoma.**

### Fix (2 cambios, cero dominio)

**Cambio A — `kyc-pending-store.ts` (AC-1):** envolver `setItem` (save) y `removeItem` (clear) en try/catch que **re-lanza `new Error("kyc_pending_unavailable")`** (NO swallow, NO propagar `TypeError`/`DOMException` crudo). `get()` NO se toca.

**Cambio B — `start-kyc.ts` rama redirect (AC-2/3/4):** **invertir el orden** → `pending.save({...})` PRIMERO, `repo.save(r)` DESPUÉS, luego `return {kind:"redirect", url}`.

### Por qué cierra el huérfano
Si `pending.save()` lanza **PRIMERO** → `repo.save(r)` **nunca corre** → la mutación in-memory de `r.startKyc()` (línea 33) se descarta → la remesa **sigue persistida en `created`** (su último estado guardado). El retry hace `created → kyc_pending` (válido, `TRANSITIONS.created`). Sin rollback, sin compensación, sin tocar el dominio.

### AC-3 ya satisfecho sin tocar `flow.tsx` (control de navegación)
En `onVerify` (flow.tsx:188-197) el `window.location.href = res.url` (196) está DESPUÉS del `await c.startKyc.execute(...)` y DENTRO del `if (res.kind === "redirect")`. Si `pending.save()` falla, `execute()` **rechaza** → `guard()` (144) captura → `humanError()` muestra el error → **nunca se llega a la línea 196**. **NO reordenar navegación en flow.tsx.** El único cambio en flow.tsx para V1 es el copy (vía humanError movido a flow-vm, ver V2).

---

## 5. Waves (con snippets orientativos)

> Los snippets son GUÍA. Fijá el texto exacto (copys, comentarios) vos en F3. Re-verificá anchors post-182.

### W1 — dominio/infra puros (AC-7, AC-8, AC-9) — paralelizable, bajo riesgo

**`money.ts` — cap safe-int (V5, AC-9)** — tras el `Math.round`:
```ts
static of(major: number, currency: Currency): Money {
  if (!Number.isFinite(major) || major < 0) {
    throw new Error(`invalid_money_amount:${major}`);
  }
  const factor = 10 ** DECIMALS[currency];
  const minor = Math.round(major * factor);
  if (minor > Number.MAX_SAFE_INTEGER) {
    throw new Error(`invalid_money_amount:${major}`); // CD-4: cap técnico, NO regla de negocio
  }
  return new Money(minor, currency);
}
```

**`gateways.ts` — V4 doble redondeo (AC-8)** — **re-verificar post-182**; si 182 ya lo cambió → **no-op, documentalo, NO re-apliques**:
```ts
// antes:  receive: Money.of(Number((netUsd * rate).toFixed(2)), "PEN"),
// después:
receive: Money.of(netUsd * rate, "PEN"),  // único redondeo = Money.of (dominio)
```

**`gateways.ts` — V3 comentario (AC-7)** — adyacente a `simulated()` (línea ~72), sin cambiar runtime (CD-2):
```ts
// SIEMPRE aprueba (approved:true, payoutAllowed:true); NUNCA representa un rechazo.
// En prod su alcance está contenido por el gate server-side de WKH-180
// (/api/payout/validate: sin DIDIT_API_KEY + prod → 503 fail-loud, nunca autoriza por default).
```

### W2 — el bug real V1 (AC-1/2/3/4) — SERIAL: store → start-kyc → doble de test

**`kyc-pending-store.ts` (AC-1):**
```ts
async save(p: KycPending): Promise<void> {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    throw new Error("kyc_pending_unavailable");
  }
}
async clear(): Promise<void> {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(KEY);
  } catch {
    throw new Error("kyc_pending_unavailable");
  }
}
```

**`start-kyc.ts` rama redirect (AC-2/3/4)** — invertir orden:
```ts
// redirect: guardar PRIMERO el pendiente; solo si eso funciona, persistir la remesa en kyc_pending.
await this.pending.save({
  remittanceId: input.remittanceId,
  sessionId: res.sessionId,
  address: input.address,
  sessionToken: res.authToken,
});
await this.repo.save(r);   // ← si pending.save lanzó, ESTO no corre → remesa sigue en "created"
return { kind: "redirect", url: res.url };
```

**`fakes.ts` — doble nuevo (DT-7)** — AGREGAR (NO mutar `FakeKycPendingStore`):
```ts
export class ThrowingKycPendingStore implements KycPendingStore {
  private p: KycPending | null = null;
  async save(_p: KycPending): Promise<void> {
    throw new Error("kyc_pending_unavailable");
  }
  async get(): Promise<KycPending | null> {
    return this.p;
  }
  async clear(): Promise<void> {
    this.p = null;
  }
}
```

> ⚠️ **`setup()` no acepta override de `pending`** (`use-cases.test.ts:32` lo hardcodea a `FakeKycPendingStore`). Para el test estrella tenés 2 opciones: (a) construir `StartKyc` a mano en el test con `ThrowingKycPendingStore` + un `InMemoryRepo`/`FixedClock` locales, o (b) agregar un opt `pending?: KycPendingStore` a `setup()` reusando el patrón de los otros opts. **Si tocás `setup()`, no cambiés la firma del ctor de `StartKyc` (CD-6)** — solo la fuente del `pending`.

### W3 — presentación (AC-5/6 + DT-2 copy) — depende de W2 solo para el copy `kyc_pending_unavailable`

**`flow-vm.ts` — mover + exportar `humanError` (DT-6)**. **⚠️ CD-5 (ORDEN CRÍTICO)**: `kyc_pending_unavailable` contiene el substring `"kyc"` → su chequeo DEBE ir **ANTES** de `code.includes("kyc")` genérico, o matchea el mensaje equivocado:
```ts
export function humanError(code: string): string {
  if (code.includes("quote_expired") || code.includes("QUOTE_STALE"))
    return "La tasa cambió. Revisá el nuevo monto.";
  // CD-5: ANTES de includes("kyc") — el string contiene "kyc".
  if (code.includes("kyc_pending_unavailable") || code.includes("pending_unavailable"))
    return "No pudimos preparar la verificación. Probá de nuevo.";
  if (code.includes("no_wallet"))
    return "No se detectó una wallet instalada. Instalá o desbloqueá tu wallet.";
  if (code.includes("no_account") || code.includes("wallet_not_connected"))
    return "Reconectá o desbloqueá tu wallet para continuar.";
  if (code.includes("kyc")) return "No pudimos verificar tu identidad.";
  if (code.includes("payout")) return "No se pudo entregar. Si te cobramos, te reembolsamos.";
  return "Algo salió mal. Intentá de nuevo.";
}
```

**`flow.tsx`** — borrar el `humanError` local (637-643) y agregarlo al import existente de línea 17:
```ts
import { deliveredDisplay, humanError, isDemoMode } from "./flow-vm";
```
`guard()` (144) sigue llamando `humanError(e.message)` idéntico. No tocar la navegación.

### W4 — docs (AC-10/11) — 100% independiente. **COMPARTIDO con 182 → re-verificar secciones post-merge (CD-9).**

**`.env.example`**:
- **AC-11**: anotar `NEXT_PUBLIC_KYC_MODE` (líneas ~19-22) como deprecated/no-op — **NO borrar la línea** (DT-5). Ej:
  ```
  # [DEPRECATED — no-op desde WKH-180] Ya NO se lee en ningún lado de src/. El server
  # decide el adapter KYC (DiditKycGateway con fallback interno). Se deja documentada
  # para el historial; setearla no tiene efecto.
  NEXT_PUBLIC_KYC_MODE=
  ```
- **AC-10**: agregar bloque para `NEXT_PUBLIC_REOWN_PROJECT_ID` (usada en `wallet.ts:130`, gatea `WalletConnectWallet` vs `FallbackWallet`). Ej:
  ```
  # ── Wallet (WalletConnect / Reown) ──
  # Project ID de https://cloud.reown.com. Si vacío → FallbackWallet (inyectada / demo).
  NEXT_PUBLIC_REOWN_PROJECT_ID=
  ```

---

## 6. Mapa de ACs (11) → Wave / archivo / test

| AC | Qué | Wave | Test |
|----|-----|------|------|
| AC-1 | save/clear catchean y re-lanzan `kyc_pending_unavailable` (no crudo) | W2 | `use-cases.test.ts` (rama redirect con `ThrowingKycPendingStore` rechaza con ese Error) |
| **AC-2** ⭐ | redirect: `pending.save` ANTES de `repo.save` → si pending falla, remesa NO queda en `kyc_pending` | W2 | **TEST ESTRELLA**: tras execute que rechaza, `repo.get(id)` status === `"created"` |
| AC-3 | no navegar a Didit si pending falló | W2 (cubierto a nivel use-case; execute rechaza antes de `{kind:"redirect"}`) | assert: es throw, no `{kind:"redirect"}` |
| AC-4 | retry no lanza `invalid_transition`; no-regresión happy path | W2 | 2º execute con store sano avanza; + `use-cases.test.ts:158-167` sigue verde |
| AC-5 | `no_wallet` → copy específico | W3 | `flow-vm.test.ts`: `humanError("no_wallet")` ≠ genérico |
| AC-6 | `no_account`/`wallet_not_connected` → copy reconectar | W3 | `flow-vm.test.ts` |
| AC-7 | comentario `FallbackKycGateway` siempre aprueba | W1 | docs (sin runtime); `use-cases.test.ts:184-206` sigue verde |
| AC-8 | FX un solo redondeo | W1 | `requestQuote` produce mismo `receive.minor` que hoy |
| AC-9 | `Money.of` cap MAX_SAFE_INTEGER → throw `invalid_money_amount` | W1 | `money.test.ts`: `Money.of(1e12,"USDC")` throws; `Money.of(1_000_000,"USDC")` NO |
| AC-10 | `.env.example` documenta `NEXT_PUBLIC_REOWN_PROJECT_ID` | W4 | QA verifica diff (sin test) |
| AC-11 | `.env.example` anota `NEXT_PUBLIC_KYC_MODE` deprecated | W4 | QA verifica diff (sin test) |

---

## 7. Test plan (detalle) — vitest, `tsc` strict + `noUncheckedIndexedAccess`

**Test estrella (AC-2)** en `use-cases.test.ts`:
```ts
it("V1: si pending.save falla en el redirect, la remesa NO queda huérfana en kyc_pending", async () => {
  // StartKyc con ThrowingKycPendingStore + FakeKycGateway({}, true) (fuerza redirect).
  // ... construir repo (InMemoryRepo), clock, etc.
  const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
  await expect(
    startKyc.execute({ remittanceId: r0.snapshot.id, address: "0xSender" }),
  ).rejects.toThrow(/kyc_pending_unavailable/);      // AC-1
  const persisted = await repo.get(r0.snapshot.id);
  expect(persisted?.snapshot.status).toBe("created"); // AC-2 ⭐ NO "kyc_pending"
});
```
**No-regresión (AC-4)**: un 2º `execute()` con `pending` sano avanza sin `invalid_transition`. Y `use-cases.test.ts:158-167` (redirect→resume→passed) debe **seguir verde** sin cambios.

**`money.test.ts` (AC-9)**: `expect(() => Money.of(1e12, "USDC")).toThrow(/invalid_money_amount/)` (1e12*1e6 = 1e18 > MAX_SAFE_INTEGER) + un caso holgado `Money.of(1_000_000, "USDC")` que NO lanza (evita falso-positivo).

**`flow-vm.test.ts` (AC-5/6 + CD-5)**:
- `humanError("no_wallet")` → contiene "wallet instalada", ≠ "Algo salió mal".
- `humanError("no_account")` y `humanError("wallet_not_connected")` → "Reconectá/desbloqueá".
- `humanError("kyc_pending_unavailable")` → "No pudimos preparar la verificación" **y ≠** "No pudimos verificar tu identidad" (prueba el ordering de CD-5).

**CD-7**: en asserts que indexen arrays (`calls[0][1]`, etc.) recordá que son `T | undefined` — guardá o usá `?.`. Evitá index-access crudo.

---

## 8. Constraint Directives — checklist (marcar en F3)

- [ ] **CD-1**: no tocaste NADA fuera de `chaski-v2/`; no tocaste `yarvis`/`wasiai-v2`/`agentshop-*`.
- [ ] **CD-2**: cero cambio de runtime observable — `FallbackKycGateway` sigue aprobando siempre; FX devuelve el mismo monto a 2 decimales en el caso común.
- [ ] **CD-3**: NO tocaste `RemittanceStatus`/`TRANSITIONS` en `remittance.ts`. Fix de V1 = reorder + try/catch.
- [ ] **CD-4**: el cap de `Money.of()` es `Number.MAX_SAFE_INTEGER` (técnico), NO un número de negocio.
- [ ] **CD-5**: `kyc_pending_unavailable` se chequea ANTES de `code.includes("kyc")` en `humanError`.
- [ ] **CD-6**: NO cambiaste firmas de ctor/función (`StartKyc`, `Money.of`, port `KycPendingStore`, `FakeKycPendingStore`). Nuevos dobles se AGREGAN.
- [ ] **CD-7**: `noUncheckedIndexedAccess` respetado en tests nuevos.
- [ ] **CD-8**: no importaste símbolos no verificados de `ports.ts`/`remittance.ts`.
- [ ] **CD-9**: diff acotado en `gateways.ts` y `.env.example` (compartidos con 182); no reformateaste hunks ajenos.

---

## 9. Done Definition

- [ ] W1→W4 aplicadas; 11 ACs cubiertos.
- [ ] Todos los CD del §8 marcados.
- [ ] **WKH-182 confirmado en `main`** antes de arrancar; `gateways.ts:53` y `.env.example` re-verificados post-merge (V4 marcado no-op si 182 ya lo hizo).
- [ ] `npx tsc --noEmit` → **0 errores** (incluidos callers fuera de Scope IN, ej. `confirm-and-send.test.ts` — CD-6).
- [ ] `npx vitest run` → **todo verde**, incluidos el test estrella de V1 y las no-regresiones (`use-cases.test.ts:158-167`, happy path, AC-12 fallback).
- [ ] `npx next build` → build limpio.
- [ ] Sin `any` explícito, sin hardcodes nuevos, sin secrets.
- [ ] Reportar al orquestador: archivos tocados, resultado de los 3 comandos, y si V4 fue no-op por 182.
