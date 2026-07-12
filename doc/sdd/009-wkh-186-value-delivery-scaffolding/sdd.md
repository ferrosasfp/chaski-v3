# SDD — WKH-186 · Value-delivery scaffolding (adapter a2a mock/off + reconciliación + refund-on-failure + EIP-3009-ready)

> **Money-path — máxima rigurosidad.** Modo QUALITY, SDD_MODE=full. Input: `work-item.md` (14 ACs, 10 CDs, DT-1..6) + decisiones del orquestador (cierran los 4 Missing Inputs). Gate `HU_APPROVED` otorgado.
> **Invariante rectora (CD-2):** cero movimiento de dinero real. Todo adapter nuevo queda mock/off por DEFAULT; ningún env var nuevo tiene un default que mueva plata.

---

## 1. Context Map (archivos leídos — archivo:línea verificados 2026-07-11, sobre `main` post WKH-178..185)

| Archivo | Líneas clave | Qué extraje / por qué |
|---------|-------------|------------------------|
| `src/application/ports.ts` | 63-81 (`PayoutSubmit`/`PayoutRecord`/`PayoutGateway`), 21-23 (`QuoteGateway`), 91-94 (`PayoutAuthorityGateway`), 96-101 (`WalletPort`) | `PayoutSubmit` YA trae `expectedReceivePen: Money` (WKH-182, L66). `PayoutRecord.status` ∈ `submitted\|settled\|failed` (L73) — **no existe `blocked`** → el adapter debe mapear el `blocked` del agente. NO hay `RefundGateway` hoy. Firma de `PayoutGateway`: `submit()` + `status()`. |
| `src/infrastructure/fallback/gateways.ts` | 1-3 (comentario `./a2a`), 45-61 (`FallbackQuoteGateway`), 95-116 (`FallbackPayoutGateway`) | L3 confirma que los adapters reales van en `./a2a`. Fallback `submit`→`status:"submitted"`, `deliveredPen:null` (L98-106); `status`→`settled`, `deliveredPen:null` (L107-115). **La regresión default (AC-1/AC-9) = byte-idéntico a esto.** |
| `src/composition/container.ts` | 43-70 (`createContainer`), L49/53 (fallback quote/payout), L64 (`ConfirmAndSend(...5 args)`), L65 (`TrackRemittance(...3 args)`) | Único lugar que conoce adapters concretos (L1-3). Acá van los 2 flags + guard fail-loud + wiring de `refund`. |
| `src/application/use-cases/confirm-and-send.ts` | 40-49 (auth gate → `markPayoutFailed`), 55-59 y 72-77 (expiry re-checks → `markPayoutFailed`), 79-99 (submit + rama `failed` L93-94 + `catch` L96-97), L80 (`idempotencyKey = \`${s.id}:${quote.quoteId}\``) | **4 sitios `markPayoutFailed` sin refund.** El submit ya pasa `expectedReceivePen: quote.receive` (L85). `idempotencyKey` (L80) = el que debe viajar INTACTO (CD-10). |
| `src/application/use-cases/track-remittance.ts` | 12-27 (rama `failed` L22-24 → `markPayoutFailed`; rama `settled` L19-21 → `markSettled`) | 5º sitio `markPayoutFailed` sin refund. Guard L16: sólo corre si `status === "payout_submitted"`. |
| `src/infrastructure/wallet.ts` | 46-58 (`InjectedWallet.authorizePrincipal` = `signMessage`), 139-149 (`WalletConnectWallet` idem), L51-52 (comentario EIP-3009), L6 (import `resolveChain/resolveChainId`) | Ambos wallets firman un MENSAJE simbólico. La rama EIP-3009 se inserta acá SIN tocar el path `signMessage` (default). `FallbackWallet` (62-75) NO se toca. |
| `src/infrastructure/chain.ts` | 9-13 (`resolveChainId`), 16-18 (`resolveChain`) | Única fuente env-driven (`NEXT_PUBLIC_CHAIN_ID`, 43114/43113). Base para `resolveUsdcAddress()` nuevo (mismo principio "una sola fuente"). |
| `src/domain/remittance.ts` | 85-97 (`TRANSITIONS`: `payout_failed→[refunded]` L95), 105-119 (`assertReceiveConsistent` + `RECEIVE_TOL_ABS_PEN=0.02`/`RECEIVE_TOL_REL=0.01`), 226-231 (`markPayoutFailed`/`markRefunded`) | La FSM YA soporta `payout_failed→refunded`; nadie la dispara. `markRefunded` (L229) sólo patchea `refundTx` → **`failureReason` sobrevive** al pasar a `refunded`. Las tolerancias (L106-107) son las que AC-6 debe reusar (CD-6). |
| `src/domain/money.ts` | 10-45 (`Money`, `minor` = base units, `.major`, `.of`) | `Money.minor` de USDC = micro-USDC (6 decimales) = base units EIP-3009 (`value`). `.major` para comparación de tolerancia. |
| `src/infrastructure/payout/payout-authority-gateway.ts` | 8-26 | **Exemplar del adapter cliente**: fetch a ruta relativa `/api/...`, parse defensivo, fail-closed en catch, cero PII. Patrón para `A2aQuoteGateway`/`A2aPayoutGateway`. |
| `src/infrastructure/didit/kyc-gateway.ts` | 17-54 | **Exemplar cliente→API-route**: `fetch("/api/kyc/...")`, mapea `{result-like}`→dominio, delega 501 al fallback. Patrón para el adapter a2a + su API route. |
| `app/api/payout/validate/route.ts` | 14-103 | **Exemplar de API route server-only**: env server-side, guard-order fail-loud, todo el fetch en try/catch → nunca 500 crudo, cero PII. Patrón para `app/api/a2a/*`. |
| `app/api/kyc/session/route.ts` | 33-87 | Exemplar server-only: `process.env.X` (sin `NEXT_PUBLIC_`), 501 si no configurado, `AbortSignal.timeout(10_000)`, nunca ecoa el body al cliente. |
| `src/test-support/fakes.ts` | 185-210 (`FakePayoutGateway`), 254-261 (`FakePayoutAuthorityGateway`), 36-56 (clocks), 65-87 (`InMemoryRepo` CAS) | Patrón de dobles: ctor con overrides parciales, registro de `calls`. `FakeRefundGateway` nuevo sigue este molde. |
| `src/test-support/test-container.ts` | 42-80 | Harness WKH-185 (RTL). `TestContainerOverrides` + wiring espejo de `container.ts`. Requiere un override `refund?` nuevo. |
| `src/application/use-cases/confirm-and-send.test.ts` | 46-183 | Patrón de test de use-case (spies sobre wallet/payout, `FixedClock`/`ScriptedClock`). **L60/82/137/159 asertan `payout_failed` como terminal → cambian a `refunded`** (ver §7 regresión). |
| `src/application/use-cases.test.ts` | 51-54 (ctors), 123 (`toBe("payout_failed")`) | **⚠️ FUERA de Scope IN pero DEBE actualizarse** (ripple de firma de ctor + assertion `payout_failed`→`refunded`). Ver §6 CD-11 y §9. |
| `src/infrastructure/wallet.test.ts` | 1-215 | Patrón de mock de provider EIP-1193 (`makeProvider`/`makeWcProvider`, `stubWindow`, `vi.hoisted` para el lazy-import WC). Base para testear la rama `signTypedData`. |
| **`wasiai-remittance-agents`** (SOLO lectura, CD-1) | `src/agents/corridor-fx.ts:13-42`, `src/agents/cashout-payout.ts:17-119`, `src/providers/types.ts:45-82`, ambos `invoke/route.ts` | **Contrato verificado** (§3). `invoke` envuelve todo en try/catch → nunca 500 crudo. `cashout-payout` resuelve TODO en el round-trip (no hay `/status` async). Fail-safe propio `assertPayoutProviderSafe()` (2ª capa money-path). |

**Auto-Blindaje histórico consultado** (últimas HUs DONE: 185, 182→no existe, 181, 180, 179):
- **Recurrente ×3** (179 ×2, 181): `tsconfig` tiene `strict:true` + `noUncheckedIndexedAccess:true` → todo acceso por índice es `T|undefined` → `?? null`/`!`/optional-chaining obligatorio; tipar los `vi.fn` cuyos `.mock.calls` se inspeccionan.
- **Recurrente ×2** (180, 181): cambiar una firma de ctor/método **ripplea a TODOS los call-sites**, no sólo a los del Scope IN → `grep -rn "new <Clase>"` ANTES de tocar. (Ya ejecutado — ver §6 CD-11.)
- **180**: copiar los nombres de tipo EXACTOS de `ports.ts` (no abreviar de memoria).
- **179**: derivar tipos literal-template de librerías con `Parameters<>`/`ReturnType<>` (aplica a la typed-data de viem si hace falta).
→ Estos 4 patrones se heredan como **CD-12..CD-15** (§6).

---

## 2. Decisiones técnicas (DT-N)

Heredo DT-1..DT-6 del work-item (ratificadas por el orquestador) y agrego:

- **DT-7 (adapter a2a = cliente→API-route, no fetch directo desde el gateway).** `A2aQuoteGateway`/`A2aPayoutGateway` corren en el browser (dentro del container) y hacen `fetch("/api/a2a/...")` a rutas server-only de `chaski-v2`; las rutas leen `REMIT_AGENTS_BASE_URL` (server-only, sin `NEXT_PUBLIC_`, CD-9) y llaman a `POST {BASE}/api/agents/<slug>/invoke`. Espeja EXACTAMENTE `DiditKycGateway`→`/api/kyc/*` y `HttpPayoutAuthorityGateway`→`/api/payout/validate`. Cierra la decisión #1 (DIRECTO server-side, no por el gateway pagado).
- **DT-8 (reconciliación = función pura de dominio que reusa las MISMAS constantes).** Agrego a `remittance.ts` una función exportada pura `isDeliveredWithinReceiveTolerance(expected: Money, delivered: Money): boolean` que reusa `RECEIVE_TOL_ABS_PEN`/`RECEIVE_TOL_REL` (las MISMAS de `assertReceiveConsistent`, CD-6). No introduce tolerancia nueva. La comparación es `|delivered.major − expected.major| ≤ max(ABS, expected.major × REL)`. El use-case la invoca PRE-`markSettled`.
- **DT-9 (refund = helper privado sincrónico por use-case).** Cada use-case (`ConfirmAndSend`, `TrackRemittance`) gana un `private async failAndRefund(r, reason)` que hace `markPayoutFailed → save → refund.creditBack() → (si resuelve) markRefunded → save`, todo en el mismo `execute()` (DT-2). Si `creditBack()` rechaza, la remesa queda en `payout_failed` (best-effort, documentado; el mock nunca falla). No se comparte un módulo entre los 2 use-cases (cada uno tiene sus deps inyectadas) — misma decisión de granularidad que el resto de `use-cases/`.
- **DT-10 (USDC address = env `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS`, leída SOLO en el path EIP-3009).** Cierra la decisión #2. `resolveUsdcAddress()` en `chain.ts` lee la env, valida `isAddress`, y **lanza** `usdc_contract_not_configured` si falta/malformada. El `.env.example` documenta el default canónico de Circle por chain como COMENTARIO (no en código). Como el flag EIP-3009 está OFF por default (AC-9), este path nunca se ejecuta en el demo.
- **DT-11 (guard fail-loud extendido a USDC).** El guard de AC-11 en `createContainer()` (DT-6) valida las 2 condiciones del ticket (adapter=`a2a`, receiver seteado) **Y ADEMÁS** que `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS` esté seteada cuando `NEXT_PUBLIC_EIP3009_ENABLED="true"` — para fallar en la construcción del container, no en el momento de firmar (que escaparía uncaught de `authorizePrincipal`, fuera del try/catch de submit). Extensión natural de CD-3/CD-4, formalizada como CD-16.
- **DT-12 (`A2aPayoutGateway.status()` = cache en memoria del último `submit()`).** AC-14: como `remit-cashout-payout` resuelve el estado final en el `invoke` (no hay `/status` async), la instancia del gateway cachea el `PayoutRecord` por `payoutId` en un `Map` durante `submit()`; `status(payoutId)` devuelve el cacheado. Si el id es desconocido (instancia fría / reload) → devuelve `{ status:"failed", failureReason:"payout_status_unknown", ... }` (fail-safe, dispara refund, nunca inventa `settled`). Gap `[NEEDS CLARIFICATION]` de Fase A documentado (Missing #4): el `/status` async real es HU futura en `wasiai-remittance-agents` (CD-1).
- **DT-13 (mapeo `blocked`→`failed`).** El agente puede devolver `status:"blocked"` (KYC gate, `cashout-payout.ts:82-93`). `PayoutRecord` no tiene `blocked` → el adapter mapea `blocked`→`failed` con `failureReason = reason` (ej. `"kyc_gate_not_passed"`). Correcto: un `blocked` es un no-desembolso → debe disparar refund vía AC-7.

---

## 3. Contrato verificado de los agentes remit-* (fuente: `wasiai-remittance-agents`, SOLO lectura)

**Transporte uniforme:** `POST {BASE}/api/agents/<slug>/invoke` → `200 { result: {...} }` | `400 { error, details }` | `502 { error }`. Nunca 500 crudo (ambos routes envuelven todo en try/catch: `remit-cashout-payout/invoke/route.ts:20-30`, `remit-corridor-fx/invoke/route.ts`).

**`remit-corridor-fx`** (`corridor-fx.ts:13-42`, output = `FxQuote & {slug}`, `providers/types.ts:45-54`):
- Input: `{ amountUsd:number>0, destCountry:string≥2="PE", destCurrency:"PEN", payoutMethod:"yape"|"plin"|"bank_cci"="yape" }`.
- Output `result`: `{ slug, rate, feeUsd, netDeliveredLocal, localCurrency:"PEN", etaMinutes, quoteId, expiresAt, provenance }`.
- **Mapeo → `Quote`** (dominio):

  | `Quote` | fuente |
  |---------|--------|
  | `quoteId` | `result.quoteId` |
  | `send` | `Money.of(req.amountUsd, "USDC")` (del REQUEST, no del output) |
  | `receive` | `Money.of(result.netDeliveredLocal, "PEN")` |
  | `feeUsd` | `Money.of(result.feeUsd, "USDC")` |
  | `rate` | `result.rate` |
  | `etaMinutes` | `result.etaMinutes` |
  | `expiresAt` | `result.expiresAt` |
  | `provenance` | `result.provenance` |

**`remit-cashout-payout`** (`cashout-payout.ts:17-119`, output `providers/types.ts:75-82`):
- Input: `{ quoteId, amountUsd:number>0, kycVerificationId:string≥1, kycPayoutAllowed:boolean, beneficiary:{name,country≥2,method,destination}, idempotencyKey:string≥1 }`.
- Output `result`: `{ slug, executed, status:"submitted"|"settled"|"failed"|"blocked", payoutId:string|null, deliveredLocal:number|null, txRef:string|null, reason:string|null, provenance }`.
- **Mapeo → `PayoutRecord`**:

  | `PayoutRecord` | fuente |
  |----------------|--------|
  | `payoutId` | `result.payoutId` (si `null` y status≠failed → error de shape, AC-5) |
  | `status` | `result.status`, con `"blocked"→"failed"` (DT-13) |
  | `deliveredPen` | `result.deliveredLocal != null ? Money.of(result.deliveredLocal, "PEN") : null` |
  | `txRef` | `result.txRef` |
  | `failureReason` | `result.reason` |

- **`kycPayoutAllowed` (input requerido, NO está en `PayoutSubmit`):** el adapter lo sintetiza en `true` (DT-5) — `ConfirmAndSend` ya garantizó la autoridad server-side (WKH-180, `confirm-and-send.ts:40-49`) antes de llegar a `submit()`. NO se toca `ports.ts` para esto.
- **Sin auth/paywall en el `invoke` hoy** → la llamada directa server-side es válida (DT-1). **2ª capa de seguridad money-path fuera de esta HU:** `assertPayoutProviderSafe()` (`cashout-payout.ts:44-72`) impide desembolso real sin `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY` — independiente de `chaski-v2`.

---

## 4. Diseño de las piezas

### 4.1 `A2aQuoteGateway` / `A2aPayoutGateway` (`src/infrastructure/a2a/gateways.ts`, nuevo)

```
A2aQuoteGateway implements QuoteGateway
  requestQuote(req): fetch("/api/a2a/quote", POST {amountUsd, destCountry: req.destCountry, payoutMethod: req.method})
    → si !res.ok || shape inválido → throw new Error("a2a_quote_unavailable")  // AC-5, sin PII
    → mapear result → Quote (tabla §3)

A2aPayoutGateway implements PayoutGateway
  private last = new Map<string, PayoutRecord>()   // DT-12 (AC-14)
  submit(req): fetch("/api/a2a/payout/submit", POST {
        quoteId, amountUsd: req.amountUsd, kycVerificationId: req.kycVerificationId,
        kycPayoutAllowed: true,                       // DT-5 sintetizado
        beneficiary: req.beneficiary,                  // viaja al server; NUNCA logueado (CD-5)
        idempotencyKey: req.idempotencyKey })          // INTACTO (CD-10)
    → si !res.ok || shape inválido → throw new Error("a2a_payout_unavailable")  // AC-5, sin PII
    → rec = mapear result → PayoutRecord (tabla §3, DT-13); this.last.set(rec.payoutId, rec); return rec
  status(payoutId): return this.last.get(payoutId) ?? { payoutId, status:"failed", deliveredPen:null, txRef:null, failureReason:"payout_status_unknown" }  // DT-12
```

- **AC-5 / CD-5:** los mensajes de error son PII-free y estables (`a2a_quote_unavailable`, `a2a_payout_unavailable`, `a2a_payout_bad_shape`). NUNCA interpolan `beneficiary.name`/`destination` ni el body crudo. El `throw` es intencional: `ConfirmAndSend`/`LockQuote` lo capturan (submit está en try/catch; quote se cubre en el use-case correspondiente).
- **`expectedReceivePen`** de `PayoutSubmit` NO se manda al agente (el agente no lo consume) — se usa sólo en la reconciliación local (AC-6).
- **Validación de shape** con type-guards explícitos (sin `any`), respetando `noUncheckedIndexedAccess`.

### 4.2 API routes server-only (`app/api/a2a/quote/route.ts` + `app/api/a2a/payout/submit/route.ts`, nuevos)

Patrón `app/api/payout/validate/route.ts` + `app/api/kyc/session/route.ts`:

```
const BASE = process.env.REMIT_AGENTS_BASE_URL;        // server-only (CD-9), sin NEXT_PUBLIC_
POST(req):
  if (!BASE) return 501 { error: "a2a_not_configured" }  // sin base → no configurado (default demo NO llega acá: adapter=fallback)
  body = await req.json().catch(()=>({}))
  try {
    res = await fetch(`${BASE}/api/agents/<slug>/invoke`, { POST, json(body), AbortSignal.timeout(10_000) })
    if (!res.ok) return 502 { error: "a2a_upstream_error" }          // NUNCA ecoa el body upstream ni PII
    const { result } = await res.json()
    if (!isValidShape(result)) return 502 { error: "a2a_bad_shape" }
    return 200 { result }                                            // sólo el result mapeable, sin BASE
  } catch { return 502 { error: "a2a_unavailable" } }                // timeout/DNS/parse → nunca 500 crudo
```

- **CD-9:** `REMIT_AGENTS_BASE_URL` (sin `NEXT_PUBLIC_`) nunca llega al cliente; la ruta sólo devuelve `{ result }`.
- **CD-5:** la ruta forwarda `beneficiary` al agente (necesario para el payout) pero NUNCA lo loguea ni lo ecoa en un error. Errores = cuerpos fijos opacos. El agente remoto tampoco lo ecoa (`cashout-payout/invoke/route.ts:5,26-29`).
- **CD-10:** `idempotencyKey` se forwarda tal cual (la ruta no lo regenera).

### 4.3 Reconciliación (AC-6, CD-6) — `remittance.ts` + los 2 use-cases

- **Dominio** (`remittance.ts`, DT-8): exportar
  ```ts
  export function isDeliveredWithinReceiveTolerance(expected: Money, delivered: Money): boolean {
    if (expected.currency !== delivered.currency) throw new Error("reconcile_currency_mismatch");
    const e = expected.major;
    const allowedDelta = Math.max(RECEIVE_TOL_ABS_PEN, e * RECEIVE_TOL_REL);   // MISMAS constantes (CD-6)
    return Math.abs(delivered.major - e) <= allowedDelta;
  }
  ```
- **Uso** (en `ConfirmAndSend` rama settled del submit, y en `TrackRemittance` rama settled), PRE-`markSettled`:
  ```
  if (rec.deliveredPen && !isDeliveredWithinReceiveTolerance(quote.receive, rec.deliveredPen))
      → await failAndRefund(r, "payout_amount_mismatch")     // payout_submitted→payout_failed (CD-6, nunca settled)
  else
      → markSettled(rec.txRef ?? "", rec.deliveredPen, now)
  ```
  `quote.receive` == `expectedReceivePen` (mismo `Money` lockeado, `confirm-and-send.ts:85`). En `TrackRemittance`, `expected = r.snapshot.quote.receive`.
- **Regresión default:** el fallback devuelve `deliveredPen:null` → la guarda `rec.deliveredPen &&` es falsa → `markSettled(null)` como hoy → byte-idéntico.

### 4.4 `RefundGateway` + `LedgerRefundGateway` + wiring refund-on-failure (AC-7/AC-8, CD-7/CD-8)

- **Port** (`ports.ts`), nombres exactos (CD-13):
  ```ts
  export interface RefundGateway {
    creditBack(input: { remittanceId: string; amountUsd: Money; reason: string }): Promise<{ refundTx: string }>;
  }
  ```
- **`LedgerRefundGateway`** (`src/infrastructure/refund/ledger-refund-gateway.ts`, nuevo, DEFAULT en container, AC-8):
  ```ts
  // ⚠️ LEDGER-ONLY (CD-8): NO revierte ningún movimiento on-chain real. En modo mock el principal
  // no se movió (authorizePrincipal firma un mensaje simbólico salvo EIP-3009 real, gated). Produce
  // un refundTx SINTÉTICO documentado. El clawback on-chain real (revertir un transferWithAuthorization
  // ya settleado) es Scope OUT / follow-up de Fase A. Análogo al 0xdemo... de FallbackWallet.
  async creditBack(input): Promise<{ refundTx: string }> {
    return { refundTx: `refund-ledger-${Date.now().toString(36)}` };
  }
  ```
- **Wiring (DT-9)**: `ConfirmAndSend` y `TrackRemittance` reciben `refund: RefundGateway` como dep nueva; cada `markPayoutFailed` inline se reemplaza por `await this.failAndRefund(r, reason)`:
  ```ts
  private async failAndRefund(r: Remittance, reason: string): Promise<void> {
    r.markPayoutFailed(reason, this.clock.nowIso());
    await this.repo.save(r);
    try {
      const { refundTx } = await this.refund.creditBack({
        remittanceId: r.snapshot.id, amountUsd: r.snapshot.sendUsd, reason,  // reason = enum, nunca PII (CD-5)
      });
      r.markRefunded(refundTx, this.clock.nowIso());
      await this.repo.save(r);
    } catch { /* refund falló → queda en payout_failed (best-effort). El mock nunca falla. */ }
  }
  ```
- **Cobertura de los 5 sitios (CD-7):**
  - `ConfirmAndSend`: (1) auth-gate `confirm-and-send.ts:45-49`, (2) expiry-1 `55-59`, (3) expiry-2 `72-77`, (4) submit `failed`/`catch` `93-98`, (5) **nuevo** mismatch de AC-6.
  - `TrackRemittance`: (6) `failed` `track-remittance.ts:22-24`, (7) **nuevo** mismatch de AC-6.
- **Nota Fase A (riesgo documentado, §8):** en modo real, el refund del auth-gate/expiry-pre-firma (donde el principal NUNCA se pulló) debe condicionarse a `principalTx != null` para no "acreditar" plata jamás cobrada. En esta HU es un NO-OP ledger (DT-3), así que refundear uniformemente es correcto y cierra el gap de huérfanas (AC-7 lo pide explícito "por cualquier razón"). La condicionalidad real = follow-up.

### 4.5 EIP-3009-ready (`wallet.ts` + `chain.ts`, AC-9/AC-10/AC-11, CD-3/CD-4)

- **`chain.ts`** (DT-10): `resolveUsdcAddress(): \`0x${string}\`` — lee `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS`, valida `isAddress`, lanza `usdc_contract_not_configured` si falta/malformada.
- **`wallet.ts`** — en `InjectedWallet.authorizePrincipal` Y `WalletConnectWallet.authorizePrincipal`, insertar rama al inicio (sin tocar el path `signMessage` default):
  ```ts
  if (process.env.NEXT_PUBLIC_EIP3009_ENABLED === "true") {
    // AC-10: firma REAL de transferWithAuthorization (EIP-712). El guard de container (AC-11)
    // ya garantizó adapter=a2a + receiver + usdc address ANTES de construir esta wallet.
    const usdc = resolveUsdcAddress();
    const receiver = process.env.NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS as `0x${string}`;
    const nonce = <32-byte hex aleatorio via crypto.getRandomValues>;
    const validBefore = BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000)); // atado al quote
    const sig = await client.signTypedData({
      account: this.address,
      domain: { name: "USD Coin", version: "2", chainId: resolveChainId(), verifyingContract: usdc },
      types: { TransferWithAuthorization: [ {name:"from",type:"address"}, {name:"to",type:"address"},
        {name:"value",type:"uint256"}, {name:"validAfter",type:"uint256"},
        {name:"validBefore",type:"uint256"}, {name:"nonce",type:"bytes32"} ] },
      primaryType: "TransferWithAuthorization",
      message: { from: this.address, to: receiver, value: BigInt(quote.send.minor),  // micro-USDC = base units
        validAfter: 0n, validBefore, nonce },
    });
    return { tx: sig };
  }
  // ... path default signMessage INTACTO (byte-idéntico, AC-9) ...
  ```
- **`value = BigInt(quote.send.minor)`**: `Money` de USDC guarda `minor` en micro-USDC (6 decimales), = base units EIP-3009. Cero conversión ni floats.
- **Sin destino de settlement (Scope OUT):** no existe facilitator Avalanche que consuma la firma; el flag deja la firma "lista pero sin settlement". Documentado.
- **Regresión:** flag unset/`"false"` → rama no se ejecuta → `signMessage` idéntico a hoy (AC-9).

### 4.6 Guard fail-loud en `createContainer()` (AC-11, CD-3/CD-4/CD-16 · DT-6/DT-11)

Al inicio de `createContainer()`, antes de construir wallet/use-cases:
```ts
const adapter = process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER;   // "fallback"(default) | "a2a"
const eip3009 = process.env.NEXT_PUBLIC_EIP3009_ENABLED === "true";
if (eip3009) {
  if (adapter !== "a2a") throw new Error("eip3009_requires_a2a_adapter");                 // CD-3
  if (!process.env.NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS) throw new Error("eip3009_requires_receiver"); // CD-4
  if (!process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS) throw new Error("eip3009_requires_usdc_contract"); // CD-16 (DT-11)
}
const useA2a = adapter === "a2a";
const quotes  = useA2a ? new A2aQuoteGateway()  : new FallbackQuoteGateway();   // AC-1/AC-2 (DT-4: un flag, ambos)
const payouts = useA2a ? new A2aPayoutGateway() : new FallbackPayoutGateway();
const refund  = new LedgerRefundGateway();                                       // AC-8 default
// ... ConfirmAndSend(wallet, payouts, repo, clock, payoutAuthority, refund)
// ... TrackRemittance(payouts, repo, clock, refund)
```
- **DT-4:** un solo flag controla quote+payout (evita quote-real + payout-mock).
- **Fail-loud money-path:** un EIP-3009 encendido sin adapter=a2a/receiver/usdc **nunca** cae en un modo mixto silencioso — throw en construcción.

### 4.7 Análisis de seguridad money-path — por qué CERO dinero real (capas de defensa)

| # | Capa (en `chaski-v2`, salvo la 4) | Efecto |
|---|-----------------------------------|--------|
| 1 | `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` unset/`"fallback"` (**DEFAULT**) | Se cablea `FallbackQuote/PayoutGateway` → payout mock, `deliveredPen:null`, cero red externa de payout. Byte-idéntico a hoy (AC-1). |
| 2 | `NEXT_PUBLIC_EIP3009_ENABLED` unset/`"false"` (**DEFAULT**) | `authorizePrincipal` firma un MENSAJE simbólico (no una autorización on-chain). El principal NO viaja (AC-9). |
| 3 | Guard fail-loud en `createContainer()` (AC-11) | Encender EIP-3009 sin adapter=a2a + receiver + usdc → **throw**, la app no arranca. Imposible un modo mixto (firma real + payout mock). |
| 4 | `REMIT_AGENTS_BASE_URL` server-only, sin default (ruta → 501 si falta) | Sin la env, la ruta a2a ni siquiera resuelve. Y aunque apunte al deploy, el agente corre en `PAYOUT_ALLOW_MOCK` (`FallbackPayoutProvider`, NO mueve plata) — 2ª capa **fuera de `chaski-v2`** (`cashout-payout.ts:48-72`, `assertPayoutProviderSafe`). |
| 5 | Sin facilitator Avalanche que consuma la firma EIP-3009 (Scope OUT) | Aunque se firme una autorización real (flag on), no hay quién la settlee on-chain → la firma queda inerte. |
| 6 | `LedgerRefundGateway` ledger-only (CD-8) | El refund NO ejecuta clawback on-chain — `refundTx` sintético. |

**Conclusión:** para mover dinero real harían falta, simultáneamente: flippear 2 flags en `chaski-v2` **+** setear receiver+usdc reales **+** setear `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY` en `wasiai-remittance-agents` (otro repo, CD-1) **+** construir un facilitator Avalanche inexistente. Ninguna de estas condiciones existe por default; cada una es un acto explícito de Fase A. **Esta HU no habilita ninguna.**

---

## 5. Waves de implementación

**W0 — Contratos + dominio (SERIAL, sin cambio de comportamiento).**
- `src/application/ports.ts`: `RefundGateway` (§4.4).
- `src/domain/remittance.ts`: `isDeliveredWithinReceiveTolerance()` exportada (§4.3, DT-8) — reusa las constantes existentes.
- `src/test-support/fakes.ts`: `FakeRefundGateway` (registra `calls`, default resuelve `{refundTx:"refund-fake"}`; variante que rechaza para el best-effort).
- **Gate W0:** `tsc` verde; los 181 tests siguen pasando (nada consume aún las piezas nuevas).

**W1 — Refund domain wiring + reconciliación en use-cases + ripple (SERIAL, depende de W0).**
- `src/infrastructure/refund/ledger-refund-gateway.ts` (nuevo, AC-8, CD-8).
- `src/application/use-cases/confirm-and-send.ts`: dep `refund` + `failAndRefund` + los 4 sitios + rama mismatch (§4.3/§4.4).
- `src/application/use-cases/track-remittance.ts`: dep `refund` + `failAndRefund` + rama `failed` + rama mismatch.
- `src/composition/container.ts`: instanciar `LedgerRefundGateway`, wire en ambos ctors (adapter sigue fallback).
- `src/test-support/test-container.ts`: override `refund?` + wiring (default `FakeRefundGateway`).
- **RIPPLE (CD-11, fuera de Scope IN):** `src/application/use-cases.test.ts` — 6º arg a `ConfirmAndSend` (L52), 4º arg a `TrackRemittance` (L53), y `L123 "payout_failed"→"refunded"`.
- **REGRESIÓN (Scope IN):** `confirm-and-send.test.ts` L60/82/137/159 `"payout_failed"→"refunded"` + assertions nuevas `refundTx` truthy + `failureReason` preservado.

**W2 — Adapter a2a + API routes (PARALELIZABLE con W3, depende de W0/W1 container).**
- `app/api/a2a/quote/route.ts` + `.test.ts`.
- `app/api/a2a/payout/submit/route.ts` + `.test.ts`.
- `src/infrastructure/a2a/gateways.ts` (`A2aQuoteGateway`/`A2aPayoutGateway`) + `.test.ts`.
- `src/composition/container.ts`: flag `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` switch (AC-1/AC-2, DT-4).

**W3 — EIP-3009 wallet + guard (PARALELIZABLE con W2).**
- `src/infrastructure/chain.ts`: `resolveUsdcAddress()` (DT-10).
- `src/infrastructure/wallet.ts`: rama `signTypedData` en ambos wallets (AC-10), sin tocar el default (AC-9).
- `src/composition/container.ts`: guard fail-loud (AC-11, CD-3/4/16).
- `src/infrastructure/wallet.test.ts`: casos flag-off (regresión) + flag-on (typed-data) + guard.

**W4 — Env + verificación final (SERIAL, último).**
- `.env.example`: 4 vars nuevas con defaults mock/off explícitos + comentario del USDC canónico de Circle por chain (AC-12).
- Suite completa verde (181 + nuevos); `tsc` + linter limpios.

> `container.ts` se toca en W1/W2/W3 (bloques disjuntos: refund-wiring / adapter-flag / guard) — coordinar en serie ese archivo aunque W2/W3 sean paralelos en el resto.

---

## 6. Constraint Directives (heredados + nuevos)

Heredo **CD-1..CD-10** del work-item SIN cambios (money-path críticos: CD-1 solo `chaski-v2`; CD-2 nada mueve plata real por default; CD-3/CD-4 fail-loud EIP-3009; CD-5 cero PII; CD-6 misma tolerancia; CD-7 refund en toda rama `payout_failed`; CD-8 refund ledger-only; CD-9 base URL server-only; CD-10 idempotencyKey intacto). Agrego:

- **CD-11 (ripple de firma de ctor — heredado del Auto-Blindaje WKH-180#1/WKH-181#1):** al agregar la dep `refund` a `ConfirmAndSend`/`TrackRemittance` DEBE actualizarse **`src/application/use-cases.test.ts`** (L52/53 ctors + L123 assertion), que está FUERA del Scope IN del work-item pero construye ambos use-cases. `grep -rn "new ConfirmAndSend\|new TrackRemittance"` ya ejecutado (§Context Map / §9): call-sites = container.ts, test-container.ts, confirm-and-send.test.ts, **use-cases.test.ts**. Ningún call-site puede quedar roto (`tsc` verde).
- **CD-12 (`noUncheckedIndexedAccess` — heredado WKH-179#2/#1, WKH-181#2):** todo acceso por índice en código/tests nuevos usa `?? null`/`!` deliberado/optional-chaining. Los `vi.fn` cuyos `.mock.calls` se inspeccionan se tipan con firma explícita.
- **CD-13 (nombres de tipo exactos — heredado WKH-180#2):** importar los identificadores EXACTOS de `ports.ts` (`RefundGateway`, `PayoutRecord`, `PayoutSubmit`, `PayoutGateway`) — no abreviar de memoria.
- **CD-14 (tipos de librería derivados — heredado WKH-179#1):** para la typed-data de viem, usar los tipos/helpers de la lib (`signTypedData` params, `isAddress`, `toHex`) — no reconstruir literal-types a mano.
- **CD-15 (sin `any` explícito — Golden Path):** validación de shape de las respuestas del agente con type-guards, sin `any`.
- **CD-16 (guard USDC — DT-11, extensión de CD-3/CD-4):** el guard de `createContainer()` DEBE fallar-loud si `NEXT_PUBLIC_EIP3009_ENABLED="true"` sin `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS` — no defaultear a un USDC hardcodeado en runtime.
- **CD-17 (regresión de tests existentes):** los tests que asertan `payout_failed` como terminal en escenarios que ahora refundean (`confirm-and-send.test.ts` L60/82/137/159, `use-cases.test.ts` L123) se actualizan a `refunded`, PRESERVANDO las assertions de `failureReason` (que sobrevive a `markRefunded`). NO se relajan las assertions de "submit/authorizePrincipal NOT called".

---

## 7. Regresión (default = demo idéntico) — análisis

- **Adapter default (`fallback`):** `FallbackQuote/PayoutGateway` sin cambios → quote local + payout mock `deliveredPen:null`. AC-1 byte-idéntico.
- **EIP-3009 default (`off`):** `authorizePrincipal` = `signMessage` sin cambios. AC-9 byte-idéntico.
- **Reconciliación (AC-6):** guardada por `rec.deliveredPen &&` → con fallback (`null`) NUNCA se ejecuta → `markSettled(null)` como hoy.
- **Refund-on-failure (AC-7):** en el happy demo el payout nunca llega a `payout_failed` → refund no dispara. PERO los escenarios de fallo (auth-gate/expiry) AHORA terminan en `refunded` en vez de `payout_failed` → **cambio de status terminal esperado**, cubierto por CD-17 (actualizar assertions, `failureReason` intacto). WKH-180 (autoridad) y WKH-182 (CAS/expiry/`expectedReceivePen`) siguen intactos en lógica — sólo se agrega el paso refund tras `markPayoutFailed`.
- **Harness WKH-185:** `test-container.ts` gana un override `refund?` con default `FakeRefundGateway` (regresión-neutral) — el container 100% fallback del harness RTL sigue funcionando.
- **UI (Scope OUT):** una remesa que ahora termina `refunded` en un path de fallo puede no tener copy dedicada (`flow-vm.test.ts:104` mapea `payout_failed`→"reembolsamos", que sigue válido para el estado intermedio). El estado `refunded` ya existe en el enum; la copy visual es HU de UI separada — riesgo menor documentado (§8).
- **Objetivo:** los 181 tests actuales pasan tras los ajustes de CD-11/CD-17; los nuevos ≥1 por AC se suman.

---

## 8. Riesgos

| # | Riesgo | Mitigación |
|---|--------|------------|
| R1 | Refund uniforme acredita un principal nunca pulido (auth-gate/expiry-pre-firma) | NO-OP ledger en esta HU (DT-3/CD-8). Fase A: condicionar a `principalTx != null` — documentado en código + §4.4. |
| R2 | Ripple de ctor rompe `use-cases.test.ts` (fuera de Scope IN) | CD-11: grep ya hecho, call-sites enumerados; fix mecánico obligado. |
| R3 | `noUncheckedIndexedAccess` rompe los adapters/routes/tests nuevos | CD-12: optional-chaining/`!` deliberado; `vi.fn` tipados. |
| R4 | Estado `refunded` sin copy de UI | Scope OUT (HU de UI). El enum ya lo soporta; sin impacto funcional. |
| R5 | `A2aPayoutGateway.status()` con id desconocido (instancia fría) | DT-12: devuelve `failed`/`payout_status_unknown` (dispara refund), nunca `settled` inventado. |
| R6 | La firma EIP-3009 se genera sin destino de settlement | Scope OUT + flag off default; firma inerte. Documentado. |
| R7 | PII (`beneficiary`) filtrada en logs/errores del adapter o la ruta | CD-5: errores = cuerpos fijos opacos; mensajes de throw PII-free; el agente remoto tampoco ecoa. Test de "no-PII" en la route. |

---

## 9. Exemplars verificados (paths confirmados)

| Exemplar (existe, verificado) | Patrón que aporta |
|-------------------------------|-------------------|
| `src/infrastructure/didit/kyc-gateway.ts` | adapter cliente→API-route, mapeo `{result}`→dominio, delegación al fallback |
| `src/infrastructure/payout/payout-authority-gateway.ts` | adapter fetch a `/api/...`, parse defensivo, fail-closed, cero PII |
| `app/api/payout/validate/route.ts` | API route server-only, guard-order fail-loud, todo-en-try/catch (nunca 500), cero PII |
| `app/api/kyc/session/route.ts` | env server-only (`process.env.X`), `AbortSignal.timeout(10_000)`, 501 si no configurado |
| `src/test-support/fakes.ts:185-261` | `FakePayoutGateway`/`FakePayoutAuthorityGateway` — molde de `FakeRefundGateway` |
| `src/infrastructure/wallet.test.ts:41-98` | mock provider EIP-1193 + `vi.hoisted` lazy-import — base del test `signTypedData` |
| `src/application/use-cases/confirm-and-send.test.ts` | patrón de test de use-case (spies + clocks) |
| `wasiai-remittance-agents/src/agents/{corridor-fx,cashout-payout}.ts` + `providers/types.ts` | contrato I/O real (SOLO lectura, CD-1) — mapeos §3 |

Call-sites de ctor a actualizar (grep verificado): `container.ts:64/65`, `test-container.ts:73/74`, `confirm-and-send.test.ts:56/78/96/113/133/155/174`, `use-cases.test.ts:52/53`.

---

## 10. Plan de tests (≥1 por AC — dobles inyectados, sin red real)

| AC | Test (archivo) | Qué cubre |
|----|----------------|-----------|
| AC-1 | `container` (o `wallet.test.ts`/`confirm-and-send.test.ts` regresión) | flag unset/`"fallback"` → `FallbackQuote/PayoutGateway` cableados; demo byte-idéntico |
| AC-2 | `gateways.test.ts` (a2a) + container | flag `"a2a"` → `A2aQuote/PayoutGateway` cableados |
| AC-3 | `gateways.test.ts` (a2a, `fetch` mockeado) | `requestQuote` → POST a `/api/a2a/quote`; mapeo `{result}`→`Quote` (tabla §3) |
| AC-4 | `gateways.test.ts` (a2a) | `submit` → POST a `/api/a2a/payout/submit`; `idempotencyKey` intacto (CD-10); `kycVerificationId` propagado; mapeo→`PayoutRecord`; `kycPayoutAllowed:true` sintetizado |
| AC-5 | `gateways.test.ts` + route `.test.ts` | !200 / shape inválido → throw PII-free; sin `beneficiary` en el error (assert que el mensaje no contiene name/destination) |
| AC-6 | `confirm-and-send.test.ts` + `track-remittance.test.ts` | `deliveredPen` dentro de tolerancia → `settled`; fuera → `payout_failed`(→`refunded`) razón `payout_amount_mismatch`; reusa las constantes (test de borde a ±tolerancia) |
| AC-7 | `confirm-and-send.test.ts` + `track-remittance.test.ts` | cada rama `payout_failed` (auth, expiry×2, submit-failed, catch, mismatch, track-failed, track-mismatch) → `creditBack` llamado + `markRefunded` + status `refunded` en el mismo `execute()` |
| AC-8 | `ledger-refund-gateway.test.ts` | `creditBack` resuelve `{refundTx}` sintético, no-op de negocio |
| AC-9 | `wallet.test.ts` | flag off/unset → `signMessage` (regresión, byte-idéntico); `signTypedData` NO llamado |
| AC-10 | `wallet.test.ts` | flag on → `signTypedData` con domain/types/`to`=receiver/`value`=`quote.send.minor`; en `Injected` y `WalletConnect` |
| AC-11 | `container` test | EIP-3009 on + (adapter≠a2a ∨ sin receiver ∨ sin usdc) → `createContainer()` throws (CD-3/4/16) |
| AC-12 | (revisión manual / no testeable) | `.env.example` documenta las 4 vars con defaults mock/off |
| AC-13 | (meta) | cubierto por los archivos `.test.ts` de arriba |
| AC-14 | `gateways.test.ts` (a2a) | `status(payoutId)` devuelve el `PayoutRecord` cacheado del `submit()`; id desconocido → `failed`/`payout_status_unknown` |
| — | route `.test.ts` (ambas) | server-only: 501 sin `REMIT_AGENTS_BASE_URL`; no ecoa la base ni PII; 502 en upstream !ok/timeout (nunca 500) |
| — | regresión | los 181 tests actuales verdes tras CD-11/CD-17 |

Usar el harness WKH-185 (`buildTestContainer` con override `refund`) donde aplique a tests de flujo RTL; los use-case tests usan dobles directos (patrón `confirm-and-send.test.ts`).

---

## 11. Readiness Check

- [x] Work-item leído completo (14 ACs, 10 CDs, DT-1..6, Missing #1-4).
- [x] Los 4 Missing Inputs cerrados por el orquestador (DIRECTO / env USDC / receiver guard / status cacheado) → reflejados en DT-7/DT-10/DT-11/DT-12.
- [x] Todos los exemplars verificados con Read (paths reales, §9).
- [x] Contrato de los agentes remit-* verificado en disco (SOLO lectura, CD-1) — mapeos §3 exactos (incl. `blocked`→`failed`, `kycPayoutAllowed` sintetizado).
- [x] Superficie de regresión identificada con grep (call-sites de ctor + assertions `payout_failed`) → CD-11/CD-17.
- [x] Auto-Blindaje histórico incorporado (CD-12..CD-15).
- [x] Análisis de seguridad money-path explícito: 6 capas, cero dinero real por default (§4.7).
- [x] Waves con archivos exactos por wave; test plan ≥1 por AC.
- [x] CDs heredados + 7 nuevos (CD-11..CD-17).
- [x] Sin `[NEEDS CLARIFICATION]` abierto bloqueante (los de Fase A — status async real, facilitator Avalanche, clawback on-chain — son Scope OUT explícito, no bloquean el scaffolding).

**Veredicto: LISTO para `SPEC_APPROVED`.**
