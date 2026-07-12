# Story File — WKH-186 · Value-delivery scaffolding (adapter a2a mock/off + reconciliación + refund-on-failure + EIP-3009-ready)

> **Contrato autosuficiente para el Dev (F3).** Todo lo que necesitás está acá. NO leas el chat.
> Fuentes: `sdd.md` + `work-item.md` (mismo dir). Gate `SPEC_APPROVED` otorgado.
> **Repo:** `chaski-v2` (la DApp de remesas, paralela al demo intacto).

---

## 0. Invariante rectora — LEÉ ESTO PRIMERO (CD-2, CRÍTICA money-path)

**CERO movimiento de dinero real en esta HU.** Es scaffolding: cuando llegue Fase A (creds TransFi
reales) el único cambio debe ser flippear env vars, NO re-arquitecturar. Reglas absolutas:

- **CD-1:** PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/`. NADA de `wasiai-a2a` ni de
  `wasiai-remittance-agents` (los agentes remit-* son **SOLO lectura** — su contrato ya está en §5).
- **CD-2:** TODOS los adapters nuevos (a2a quote/payout, EIP-3009 signing, refund) quedan **mock/off
  por DEFAULT**. Ningún env var nuevo puede tener un default que mueva plata real ni que apunte a un
  endpoint/contrato de prod con capacidad de desembolso.
- **Regresión byte-idéntica:** con los defaults (adapter=`fallback`, EIP-3009=`off`) el demo se
  comporta EXACTAMENTE como hoy. Los 19 archivos `.test.ts` actuales deben seguir verdes.

Si te encontrás a punto de: mover USDC/fiat real, setear un default peligroso, o tocar otro repo →
**STOP**, es violación de CD-1/CD-2.

---

## 1. Contexto (qué se construye y por qué)

WKH-186 es la porción **técnica** de WKH-168 (desembolso real), sin depender del partner/sandbox
TransFi. 4 piezas:

1. **Adapter `a2a`** (`A2aQuoteGateway`/`A2aPayoutGateway`) que llama a los agentes live
   `remit-corridor-fx`/`remit-cashout-payout` detrás de un flag de composición. Default = fallback
   local (como hoy). Llama vía **API routes server-only** de `chaski-v2` (no fetch directo desde el
   gateway), espejando `DiditKycGateway`→`/api/kyc/*` y `HttpPayoutAuthorityGateway`→`/api/payout/validate`.
2. **Reconciliación + idempotencia:** validar que el PEN entregado (`deliveredPen`) es consistente
   con el `expectedReceivePen` lockeado, dentro de la MISMA tolerancia de `assertReceiveConsistent`,
   ANTES de `markSettled`. Mismatch → `payout_failed`. El `idempotencyKey` existente viaja intacto.
3. **Refund-on-failure:** cierra el gap de remesas huérfanas. HOY toda rama que llama
   `markPayoutFailed` deja la remesa clavada ahí para siempre (nadie dispara `payout_failed→refunded`
   aunque la FSM lo permita). Agregamos un `RefundGateway.creditBack()` (ledger-only) tras cada
   `markPayoutFailed`.
4. **Wallet EIP-3009-ready:** rama `signTypedData` real de `transferWithAuthorization`, detrás de un
   flag OFF por default + fail-loud si se enciende sin payout real.

---

## 2. Scope IN — archivos exactos a tocar (lista exhaustiva)

**Nuevos (crear):**
- `src/infrastructure/a2a/gateways.ts` — `A2aQuoteGateway` + `A2aPayoutGateway`.
- `src/infrastructure/a2a/gateways.test.ts`.
- `src/infrastructure/refund/ledger-refund-gateway.ts` — `LedgerRefundGateway`.
- `src/infrastructure/refund/ledger-refund-gateway.test.ts`.
- `app/api/a2a/quote/route.ts` + `app/api/a2a/quote/route.test.ts` — proxy server-side a `remit-corridor-fx`.
- `app/api/a2a/payout/submit/route.ts` + `app/api/a2a/payout/submit/route.test.ts` — proxy a `remit-cashout-payout`.
- `src/application/use-cases/track-remittance.test.ts` — **no existe hoy**, crear.

**Existentes (modificar):**
- `src/application/ports.ts` — agregar `RefundGateway` (NO tocar `PayoutSubmit`/`PayoutRecord`).
- `src/domain/remittance.ts` — exportar `isDeliveredWithinReceiveTolerance()`.
- `src/application/use-cases/confirm-and-send.ts` — dep `refund` + `failAndRefund` + reconciliación + 5 sitios.
- `src/application/use-cases/confirm-and-send.test.ts` — regresión (`payout_failed`→`refunded`) + casos nuevos.
- `src/application/use-cases/track-remittance.ts` — dep `refund` + `failAndRefund` + reconciliación + 2 sitios.
- `src/composition/container.ts` — flag adapter + guard fail-loud + wiring `refund`.
- `src/infrastructure/wallet.ts` — rama `signTypedData` en ambos wallets reales.
- `src/infrastructure/wallet.test.ts` — casos flag-off (regresión) + flag-on + guard.
- `src/infrastructure/chain.ts` — helper `resolveUsdcAddress()`.
- `src/test-support/fakes.ts` — agregar `FakeRefundGateway`.
- `src/test-support/test-container.ts` — override `refund?`.
- `.env.example` — 4 vars nuevas.

**RIPPLE fuera de Scope IN del work-item pero OBLIGATORIO (CD-11):**
- `src/application/use-cases.test.ts` — 6º arg a `ConfirmAndSend` (L52), 4º arg a `TrackRemittance`
  (L53), assertion `payout_failed`→`refunded` (L123).

---

## 3. Anti-Hallucination anchors (archivo:línea EXACTO, verificados 2026-07-11)

**No inventes firmas ni paths. Estos son los hechos verificados en disco:**

### `src/application/ports.ts`
- L63-70 `PayoutSubmit`: `{ quoteId, amountUsd, expectedReceivePen: Money, beneficiary, kycVerificationId, idempotencyKey }`. **NO agregar campos** (DT-5: `kycPayoutAllowed` se sintetiza en el adapter).
- L71-77 `PayoutRecord`: `{ payoutId, status: "submitted"|"settled"|"failed", deliveredPen: Money|null, txRef: string|null, failureReason: string|null }`. **NO existe `"blocked"`** → el adapter mapea `blocked`→`failed` (DT-13).
- L78-81 `PayoutGateway`: `submit()` + `status()`.
- L21-23 `QuoteGateway`: `requestQuote(req: QuoteRequest): Promise<Quote>`.
- **NO existe `RefundGateway` hoy** → lo agregás nuevo (§4.1). Nombres exactos, no abreviar (CD-13).
- L96-101 `WalletPort`: `authorizePrincipal(quote: Quote): Promise<{ tx: string }>`.

### `src/infrastructure/fallback/gateways.ts`
- L1-3: comentario confirma que los adapters reales van en `./a2a`.
- L95-116 `FallbackPayoutGateway`: `submit`→`{status:"submitted", deliveredPen:null, ...}` (L98-106);
  `status`→`{status:"settled", deliveredPen:null, ...}` (L107-115). **La regresión default es byte-idéntica a esto.**
- L45-61 `FallbackQuoteGateway`. **NO se toca ninguno de los dos** (siguen siendo el default).

### `src/composition/container.ts`
- L43-70 `createContainer()`. L49 `new FallbackQuoteGateway()`, L53 `new FallbackPayoutGateway()`.
- **L64** `new ConfirmAndSend(wallet, payouts, repo, clock, payoutAuthority)` → pasa a 6 args (+`refund`).
- **L65** `new TrackRemittance(payouts, repo, clock)` → pasa a 4 args (+`refund`).
- Es el ÚNICO lugar que conoce adapters concretos. Acá van los 2 flags + guard fail-loud.

### `src/application/use-cases/confirm-and-send.ts`
- L16-22 ctor `(wallet, payouts, repo, clock, authority)` → agregar `refund: RefundGateway` como 6º.
- **5 sitios que hoy llaman `markPayoutFailed` sin refund:**
  - (1) auth-gate: L45-49 (`r.markPayoutFailed(auth.reason ?? "kyc_reauth_failed", ...)`).
  - (2) expiry-1: L55-59 (`"quote_expired_before_submit"`).
  - (3) expiry-2: L72-77 (`"quote_expired_before_submit"`, ya con principal_in).
  - (4) submit rama `failed`: L93-94; y `catch`: L96-97.
  - (5) **NUEVO** mismatch de reconciliación (AC-6), a insertar en la rama `settled` L91-92.
- **L80** `const idempotencyKey = \`${s.id}:${quote.quoteId}\`` → debe viajar INTACTO (CD-10).
- **L82-89** el submit ya pasa `expectedReceivePen: quote.receive` (L85). `quote.receive` == el
  `Money` lockeado usado en reconciliación.

### `src/application/use-cases/track-remittance.ts`
- L6-10 ctor `(payouts, repo, clock)` → agregar `refund: RefundGateway` como 4º.
- L16 guard: sólo corre si `s.status === "payout_submitted"`.
- **Sitios:** rama `settled` L19-21 (agregar reconciliación PRE-`markSettled`); rama `failed` L22-24
  (`markPayoutFailed` → reemplazar por refund); **NUEVO** mismatch (AC-6).

### `src/infrastructure/wallet.ts`
- **L46-58** `InjectedWallet.authorizePrincipal` = `client.signMessage(...)` (mensaje simbólico L53-56).
- **L139-149** `WalletConnectWallet.authorizePrincipal` = idem `signMessage` (L144-147).
- L51-52 comentario EIP-3009 ("En producción: EIP-3009 signTypedData...").
- **`FallbackWallet.authorizePrincipal` (L72-74) NO SE TOCA** (`0xdemo${...}`).
- L3 imports de viem: `createWalletClient, custom, isAddress, toHex`. L6 import `resolveChain, resolveChainId` de `./chain`.
- La rama EIP-3009 se inserta AL INICIO de cada `authorizePrincipal` real, SIN tocar el path
  `signMessage` (que queda como default byte-idéntico).

### `src/infrastructure/chain.ts`
- L9-13 `resolveChainId()` (env `NEXT_PUBLIC_CHAIN_ID`, 43113/43114 fail-safe).
- L16-18 `resolveChain()`. Base para `resolveUsdcAddress()` nuevo (mismo principio "una sola fuente").

### `src/domain/remittance.ts`
- L85-97 `TRANSITIONS`: `payout_failed: ["refunded"]` (L95). La FSM YA soporta el refund; nadie lo dispara.
- L99 `TERMINAL_STATUSES = ["settled", "kyc_failed", "refunded"]`.
- L105-107 constantes `RECEIVE_TOL_ABS_PEN = 0.02`, `RECEIVE_TOL_REL = 0.01` (a reusar, CD-6).
- L113-119 `assertReceiveConsistent(quote)` — la fórmula/tolerancia que la reconciliación reusa.
- L226-227 `markPayoutFailed(reason, now)` → patchea `failureReason`.
- L229-231 `markRefunded(refundTx, now)` → patchea SÓLO `refundTx` → **`failureReason` sobrevive** al
  pasar a `refunded` (importante para CD-17: las assertions de `failureReason` siguen válidas).

### `src/domain/money.ts`
- L10-14 `Money`: `minor` = unidades menores (micro-USDC = 6 decimales para USDC = base units EIP-3009).
- L39-41 `.major` (para comparar tolerancia). L16-26 `Money.of(major, currency)`.

### `src/test-support/fakes.ts`
- L185-210 `FakePayoutGateway` (ctor con overrides parciales) — molde de `FakeRefundGateway`.
- L254-261 `FakePayoutAuthorityGateway` (registra `calls`, ctor con result) — molde de registro de llamadas.

### `src/test-support/test-container.ts`
- L42-52 `TestContainerOverrides` — agregar `refund?: RefundGateway`.
- L54-80 `buildTestContainer()`. L63 `payouts`, L73/74 ctors espejo de container. Agregar
  `const refund = o.refund ?? new FakeRefundGateway()` y pasarlo a ambos ctors.

### Ripple call-sites (grep verificado — NINGUNO puede quedar roto, `tsc` verde):
- `container.ts:64/65`, `test-container.ts:73/74`, `confirm-and-send.test.ts:56/78/96/113/133/155/174`,
  `use-cases.test.ts:52/53`.
- Assertions `payout_failed` terminal a actualizar a `refunded`: `confirm-and-send.test.ts:60/82/137/159`,
  `use-cases.test.ts:123`.

### Exemplars a seguir (leer para copiar patrón):
- `src/infrastructure/payout/payout-authority-gateway.ts` (L1-26): adapter cliente→`/api/...`,
  fail-closed en catch, cero PII.
- `src/infrastructure/didit/kyc-gateway.ts` (L14-54): cliente→API-route, mapea `{result}`→dominio,
  delega 501 al fallback.
- `app/api/payout/validate/route.ts` (L1-103): route server-only, guard-order fail-loud, TODO en
  try/catch (nunca 500 crudo), cero PII, `AbortSignal.timeout(10_000)`, env server-side sin `NEXT_PUBLIC_`.
- `app/api/kyc/session/route.ts`: env server-only, 501 si no configurado.

---

## 4. Diseño paso a paso (snippets objetivo)

### 4.1 `RefundGateway` (port) + `LedgerRefundGateway` (adapter default)

**`ports.ts`** — nombres EXACTOS (CD-13):
```ts
export interface RefundGateway {
  creditBack(input: { remittanceId: string; amountUsd: Money; reason: string }): Promise<{ refundTx: string }>;
}
```

**`src/infrastructure/refund/ledger-refund-gateway.ts`** (nuevo, DEFAULT en container, AC-8):
```ts
// ⚠️ LEDGER-ONLY (CD-8): NO revierte ningún movimiento on-chain real. En modo mock el principal no
// se movió (authorizePrincipal firma un mensaje simbólico salvo EIP-3009 real, gated). Produce un
// refundTx SINTÉTICO documentado. El clawback on-chain real (revertir un transferWithAuthorization
// ya settleado) es Scope OUT / follow-up de Fase A. Análogo al 0xdemo... de FallbackWallet.
export class LedgerRefundGateway implements RefundGateway {
  async creditBack(_input: { remittanceId: string; amountUsd: Money; reason: string }): Promise<{ refundTx: string }> {
    return { refundTx: `refund-ledger-${Date.now().toString(36)}` };
  }
}
```

### 4.2 `failAndRefund()` helper — refund-on-failure en los 5+2 sitios (AC-7, CD-7)

Cada use-case (`ConfirmAndSend`, `TrackRemittance`) gana un método privado (DT-9). Cada
`markPayoutFailed` inline se reemplaza por `await this.failAndRefund(r, reason)`:

```ts
private async failAndRefund(r: Remittance, reason: string): Promise<void> {
  r.markPayoutFailed(reason, this.clock.nowIso());
  await this.repo.save(r);
  try {
    const { refundTx } = await this.refund.creditBack({
      remittanceId: r.snapshot.id,
      amountUsd: r.snapshot.sendUsd,   // Money USDC
      reason,                          // reason = enum estable, NUNCA PII (CD-5)
    });
    r.markRefunded(refundTx, this.clock.nowIso());
    await this.repo.save(r);
  } catch {
    // refund falló → queda en payout_failed (best-effort). El mock nunca falla.
  }
}
```

- **`ConfirmAndSend` — 5 sitios (CD-7):** (1) auth-gate L45-49, (2) expiry-1 L55-59, (3) expiry-2
  L72-77, (4) submit `failed`/`catch` L93-98, (5) mismatch de AC-6 (§4.4, nuevo).
- **`TrackRemittance` — 2 sitios:** (6) rama `failed` L22-24, (7) mismatch de AC-6 (nuevo).
- **Nota Fase A (documentar en código, §Riesgos):** en modo real el refund del auth-gate/expiry
  pre-firma (donde el principal nunca se pulló) debería condicionarse a `principalTx != null`. En
  esta HU es NO-OP ledger (DT-3), así que refundear uniformemente es correcto y cierra el gap (AC-7
  pide "por cualquier razón"). La condicionalidad real = follow-up.

### 4.3 Reconciliación (AC-6, CD-6)

**`remittance.ts`** — exportar función pura que reusa las MISMAS constantes (CD-6, sin tolerancia nueva):
```ts
export function isDeliveredWithinReceiveTolerance(expected: Money, delivered: Money): boolean {
  if (expected.currency !== delivered.currency) throw new Error("reconcile_currency_mismatch");
  const e = expected.major;
  const allowedDelta = Math.max(RECEIVE_TOL_ABS_PEN, e * RECEIVE_TOL_REL); // MISMAS constantes
  return Math.abs(delivered.major - e) <= allowedDelta;
}
```

**Uso PRE-`markSettled`** (en `ConfirmAndSend` rama `settled` del submit L91-92, y en
`TrackRemittance` rama `settled` L19-21):
```ts
if (rec.status === "settled") {
  if (rec.deliveredPen && !isDeliveredWithinReceiveTolerance(quote.receive, rec.deliveredPen)) {
    await this.failAndRefund(r, "payout_amount_mismatch");   // payout_submitted→payout_failed→refunded, NUNCA settled
  } else {
    r.markSettled(rec.txRef ?? "", rec.deliveredPen, this.clock.nowIso());
  }
}
```
- En `ConfirmAndSend`, `expected = quote.receive` (mismo `Money` lockeado, L85). En
  `TrackRemittance`, `expected = r.snapshot.quote?.receive` (guardá el `?? null`; si no hay quote,
  no reconcilia — no debería pasar en `payout_submitted`).
- **Regresión default:** el fallback devuelve `deliveredPen:null` → la guarda `rec.deliveredPen &&`
  es falsa → `markSettled(null)` como hoy → byte-idéntico.

### 4.4 Adapter a2a (`src/infrastructure/a2a/gateways.ts`, nuevo)

```ts
export class A2aQuoteGateway implements QuoteGateway {
  async requestQuote(req: QuoteRequest): Promise<Quote> {
    const res = await fetch("/api/a2a/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountUsd: req.amountUsd, destCountry: req.destCountry, payoutMethod: req.method }),
    });
    if (!res.ok) throw new Error("a2a_quote_unavailable");         // AC-5, PII-free
    const { result } = await res.json();                          // type-guard el shape (CD-15, sin any)
    if (!isValidQuoteShape(result)) throw new Error("a2a_quote_bad_shape");
    return mapResultToQuote(result, req);                         // tabla §5
  }
}

export class A2aPayoutGateway implements PayoutGateway {
  private last = new Map<string, PayoutRecord>();                 // DT-12 / AC-14
  async submit(req: PayoutSubmit): Promise<PayoutRecord> {
    const res = await fetch("/api/a2a/payout/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteId: req.quoteId,
        amountUsd: req.amountUsd,
        kycVerificationId: req.kycVerificationId,
        kycPayoutAllowed: true,          // DT-5 sintetizado (ConfirmAndSend ya garantizó autoridad, WKH-180)
        beneficiary: req.beneficiary,    // viaja al server; NUNCA logueado (CD-5)
        idempotencyKey: req.idempotencyKey, // INTACTO (CD-10)
      }),
    });
    if (!res.ok) throw new Error("a2a_payout_unavailable");       // AC-5, PII-free
    const { result } = await res.json();
    if (!isValidPayoutShape(result)) throw new Error("a2a_payout_bad_shape");
    const rec = mapResultToPayoutRecord(result);                 // tabla §5, DT-13 blocked→failed
    this.last.set(rec.payoutId, rec);
    return rec;
  }
  async status(payoutId: string): Promise<PayoutRecord> {        // DT-12: cache del último submit()
    return this.last.get(payoutId) ?? {
      payoutId, status: "failed", deliveredPen: null, txRef: null, failureReason: "payout_status_unknown",
    };
  }
}
```
- **AC-5 / CD-5:** mensajes de error PII-free y estables (`a2a_quote_unavailable`,
  `a2a_payout_unavailable`, `a2a_*_bad_shape`). NUNCA interpolan `beneficiary.name`/`destination` ni
  el body crudo. El `throw` es intencional: `ConfirmAndSend` lo captura en el try/catch del submit;
  el quote en su use-case correspondiente.
- **`expectedReceivePen`** NO se manda al agente (no lo consume) — se usa sólo en reconciliación local.
- **Validación de shape** con type-guards explícitos, sin `any` (CD-15), respetando
  `noUncheckedIndexedAccess` (CD-12: `?? null`/optional-chaining en accesos por índice).

### 4.5 API routes server-only (`app/api/a2a/quote/route.ts` + `app/api/a2a/payout/submit/route.ts`)

Patrón `app/api/payout/validate/route.ts` + `app/api/kyc/session/route.ts`:
```ts
const BASE = process.env.REMIT_AGENTS_BASE_URL;   // server-only (CD-9), SIN NEXT_PUBLIC_
export async function POST(req: Request): Promise<Response> {
  if (!BASE) return NextResponse.json({ error: "a2a_not_configured" }, { status: 501 });
  const body = await req.json().catch(() => ({}));
  try {
    const res = await fetch(`${BASE}/api/agents/<slug>/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return NextResponse.json({ error: "a2a_upstream_error" }, { status: 502 });
    const { result } = await res.json();
    if (!isValidShape(result)) return NextResponse.json({ error: "a2a_bad_shape" }, { status: 502 });
    return NextResponse.json({ result }, { status: 200 });       // sólo el result, sin BASE
  } catch {
    return NextResponse.json({ error: "a2a_unavailable" }, { status: 502 }); // timeout/DNS/parse → nunca 500
  }
}
```
- `<slug>`: `remit-corridor-fx` (quote) / `remit-cashout-payout` (payout submit).
- **CD-9:** `REMIT_AGENTS_BASE_URL` nunca llega al cliente; la ruta sólo devuelve `{ result }`.
- **CD-5:** forwarda `beneficiary` al agente (necesario) pero NUNCA lo loguea ni lo ecoa en un error.
  Errores = cuerpos fijos opacos. **CD-10:** `idempotencyKey` se forwarda tal cual (no regenerar).

### 4.6 EIP-3009-ready (`chain.ts` + `wallet.ts`, AC-9/AC-10)

**`chain.ts`** — `resolveUsdcAddress()` (DT-10):
```ts
export function resolveUsdcAddress(): `0x${string}` {
  const raw = process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS;
  if (!raw || !isAddress(raw)) throw new Error("usdc_contract_not_configured");  // fail-loud
  return raw;
}
```
(`isAddress` de viem — CD-14. El `.env.example` documenta el USDC canónico de Circle por chain como
COMENTARIO, no en código.)

**`wallet.ts`** — insertar AL INICIO de `InjectedWallet.authorizePrincipal` (L46) Y
`WalletConnectWallet.authorizePrincipal` (L139), SIN tocar el path `signMessage` (default):
```ts
if (process.env.NEXT_PUBLIC_EIP3009_ENABLED === "true") {
  // AC-10: firma REAL de transferWithAuthorization (EIP-712). El guard de container (AC-11) ya
  // garantizó adapter=a2a + receiver + usdc address ANTES de construir esta wallet.
  const usdc = resolveUsdcAddress();
  const receiver = process.env.NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS as `0x${string}`;
  const nonce = /* 32-byte hex aleatorio via crypto.getRandomValues → toHex */;
  const validBefore = BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000)); // atado al quote
  const sig = await client.signTypedData({
    account: this.address,
    domain: { name: "USD Coin", version: "2", chainId: resolveChainId(), verifyingContract: usdc },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" },
      { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" } ] },
    primaryType: "TransferWithAuthorization",
    message: { from: this.address, to: receiver, value: BigInt(quote.send.minor), // micro-USDC = base units
      validAfter: 0n, validBefore, nonce },
  });
  return { tx: sig };
}
// ... path default signMessage INTACTO (byte-idéntico, AC-9) ...
```
- **`value = BigInt(quote.send.minor)`**: `Money.minor` de USDC = micro-USDC (6 dec) = base units
  EIP-3009. Cero conversión ni floats.
- `client` es el `createWalletClient` que cada wallet ya construye (Injected via `custom(eth)`, WC
  via `custom(provider)`). Usá los tipos/helpers de viem (`signTypedData`, `isAddress`, `toHex`) —
  no reconstruyas literal-types (CD-14).
- **Regresión:** flag unset/`"false"` → rama no se ejecuta → `signMessage` idéntico a hoy (AC-9).

### 4.7 Guard fail-loud + flag adapter en `createContainer()` (AC-1/AC-2/AC-11, CD-3/4/16)

Al INICIO de `createContainer()`, antes de construir wallet/use-cases:
```ts
const adapter = process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER;   // "fallback"(default) | "a2a"
const eip3009 = process.env.NEXT_PUBLIC_EIP3009_ENABLED === "true";
if (eip3009) {
  if (adapter !== "a2a") throw new Error("eip3009_requires_a2a_adapter");                              // CD-3
  if (!process.env.NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS) throw new Error("eip3009_requires_receiver");  // CD-4
  if (!process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS) throw new Error("eip3009_requires_usdc_contract"); // CD-16
}
const useA2a = adapter === "a2a";
const quotes  = useA2a ? new A2aQuoteGateway()  : new FallbackQuoteGateway();   // AC-1/AC-2 (DT-4: un flag, ambos)
const payouts = useA2a ? new A2aPayoutGateway() : new FallbackPayoutGateway();
const refund  = new LedgerRefundGateway();                                       // AC-8 default
// ... new ConfirmAndSend(wallet, payouts, repo, clock, payoutAuthority, refund)  (L64, 6 args)
// ... new TrackRemittance(payouts, repo, clock, refund)                          (L65, 4 args)
```
- **DT-4:** un solo flag controla quote+payout (evita quote-real + payout-mock).
- **Fail-loud money-path:** EIP-3009 encendido sin adapter=a2a/receiver/usdc → throw en construcción,
  la app no arranca. Imposible modo mixto silencioso.

### 4.8 `FakeRefundGateway` (`fakes.ts`) + override (`test-container.ts`)

```ts
// molde de FakePayoutAuthorityGateway (registra calls) — fakes.ts
export class FakeRefundGateway implements RefundGateway {
  public calls: Array<{ remittanceId: string; amountUsd: Money; reason: string }> = [];
  constructor(private mode: "resolve" | "reject" = "resolve") {}
  async creditBack(input: { remittanceId: string; amountUsd: Money; reason: string }): Promise<{ refundTx: string }> {
    this.calls.push(input);
    if (this.mode === "reject") throw new Error("refund_unavailable"); // para el best-effort de failAndRefund
    return { refundTx: "refund-fake" };
  }
}
```
`test-container.ts`: agregar `refund?: RefundGateway` a `TestContainerOverrides` (§3 L42-52) y
`const refund = o.refund ?? new FakeRefundGateway()`, pasado a ambos ctors (L73/74). Default =
`FakeRefundGateway` (regresión-neutral).

---

## 5. Contrato verificado de los agentes remit-* (SOLO lectura — CD-1)

Transporte: `POST {BASE}/api/agents/<slug>/invoke` → `200 { result: {...} }` | `400 { error, details }`
| `502 { error }`. **Nunca 500 crudo.** `remit-cashout-payout` resuelve TODO en el round-trip (no hay
`/status` async — de ahí el cache de DT-12/AC-14).

**`remit-corridor-fx`** — input `{ amountUsd>0, destCountry≥2="PE", destCurrency:"PEN", payoutMethod:"yape"|"plin"|"bank_cci"="yape" }`
→ `result: { slug, rate, feeUsd, netDeliveredLocal, localCurrency:"PEN", etaMinutes, quoteId, expiresAt, provenance }`.

| `Quote` | fuente |
|---------|--------|
| `quoteId` | `result.quoteId` |
| `send` | `Money.of(req.amountUsd, "USDC")` (del REQUEST) |
| `receive` | `Money.of(result.netDeliveredLocal, "PEN")` |
| `feeUsd` | `Money.of(result.feeUsd, "USDC")` |
| `rate` | `result.rate` |
| `etaMinutes` | `result.etaMinutes` |
| `expiresAt` | `result.expiresAt` |
| `provenance` | `result.provenance` |

**`remit-cashout-payout`** — input `{ quoteId, amountUsd>0, kycVerificationId≥1, kycPayoutAllowed:boolean,
beneficiary:{name,country≥2,method,destination}, idempotencyKey≥1 }` → `result: { slug, executed,
status:"submitted"|"settled"|"failed"|"blocked", payoutId:string|null, deliveredLocal:number|null,
txRef:string|null, reason:string|null, provenance }`.

| `PayoutRecord` | fuente |
|----------------|--------|
| `payoutId` | `result.payoutId` (si `null` y status≠failed → error de shape, AC-5) |
| `status` | `result.status`, con **`"blocked"→"failed"`** (DT-13) |
| `deliveredPen` | `result.deliveredLocal != null ? Money.of(result.deliveredLocal, "PEN") : null` |
| `txRef` | `result.txRef` |
| `failureReason` | `result.reason` |

- `kycPayoutAllowed` (input requerido) → el adapter lo sintetiza en `true` (DT-5). NO se toca `ports.ts`.
- Sin auth/paywall en el `invoke` hoy → la llamada directa server-side es válida (DT-1). 2ª capa
  money-path fuera de esta HU: el agente corre en `PAYOUT_ALLOW_MOCK` (no desembolsa sin
  `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`) — independiente de `chaski-v2`.

---

## 6. Waves de implementación

**W0 — Contratos + dominio (SERIAL, sin cambio de comportamiento):**
- `ports.ts`: `RefundGateway` (§4.1).
- `remittance.ts`: `isDeliveredWithinReceiveTolerance()` exportada (§4.3, reusa constantes).
- `fakes.ts`: `FakeRefundGateway` (§4.8).
- **Gate W0:** `tsc` verde; los tests actuales siguen pasando (nada consume aún las piezas nuevas).

**W1 — Refund wiring + reconciliación + ripple (SERIAL, depende de W0):**
- `src/infrastructure/refund/ledger-refund-gateway.ts` (§4.1, AC-8/CD-8).
- `confirm-and-send.ts`: dep `refund` + `failAndRefund` + los 4 sitios + rama mismatch (§4.2/§4.3).
- `track-remittance.ts`: dep `refund` + `failAndRefund` + rama `failed` + rama mismatch.
- `container.ts`: instanciar `LedgerRefundGateway`, wire en ambos ctors (adapter sigue fallback).
- `test-container.ts`: override `refund?` + wiring.
- **RIPPLE (CD-11):** `use-cases.test.ts` L52/53 (ctors) + L123 (`payout_failed`→`refunded`).
- **REGRESIÓN (CD-17):** `confirm-and-send.test.ts` L60/82/137/159 `"payout_failed"→"refunded"` +
  assertions `refundTx` truthy + `failureReason` preservado. NO relajar "submit/authorizePrincipal NOT called".
- Crear `track-remittance.test.ts` (cobertura nueva de reconciliación + refund).

**W2 — Adapter a2a + API routes (PARALELIZABLE con W3, depende de W0/W1):**
- `app/api/a2a/quote/route.ts` + `.test.ts`; `app/api/a2a/payout/submit/route.ts` + `.test.ts` (§4.5).
- `src/infrastructure/a2a/gateways.ts` (§4.4) + `.test.ts`.
- `container.ts`: flag `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` switch (AC-1/AC-2, §4.7).

**W3 — EIP-3009 wallet + guard (PARALELIZABLE con W2):**
- `chain.ts`: `resolveUsdcAddress()` (§4.6).
- `wallet.ts`: rama `signTypedData` en ambos wallets reales (AC-10), sin tocar el default (AC-9).
- `container.ts`: guard fail-loud (AC-11, §4.7).
- `wallet.test.ts`: casos flag-off (regresión) + flag-on (typed-data) + guard.

**W4 — Env + verificación final (SERIAL):**
- `.env.example`: 4 vars nuevas con defaults mock/off + comentario del USDC canónico de Circle por chain.
- Suite completa verde (actuales + nuevos); `tsc` + linter limpios; `next build`.

> **`container.ts` se toca en W1/W2/W3** (bloques disjuntos: refund-wiring / adapter-flag / guard).
> Coordinar en serie ese archivo aunque W2/W3 sean paralelos en el resto.

---

## 7. Env vars nuevas (`.env.example`, AC-12) — defaults mock/off

| Var | Default (comentario) | Efecto default |
|-----|----------------------|----------------|
| `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` | unset / `"fallback"` | Cablea Fallback gateways (demo, mock). `"a2a"` = agentes reales. |
| `REMIT_AGENTS_BASE_URL` | unset (**server-only, SIN `NEXT_PUBLIC_`**) | Sin base → route a2a devuelve 501. NO exponer al cliente (CD-9). |
| `NEXT_PUBLIC_EIP3009_ENABLED` | unset / `"false"` | `authorizePrincipal` firma mensaje simbólico (AC-9). `"true"` = firma real (requiere guard). |
| `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` | unset | Sin receiver → guard throw si EIP-3009 on (CD-4). |
| `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS` | unset (comentario: canónico Circle Avalanche 43114/43113) | Sin usdc → guard throw si EIP-3009 on (CD-16). |

> Son 5 vars en total; el work-item AC-12 nombra las 4 principales — documentá también
> `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS` (introducida por DT-10/CD-16). Ninguna con default que mueva plata (CD-2).

---

## 8. Constraint Directives — checklist obligatorio

- [ ] **CD-1** — sólo archivos dentro de `chaski-v2/`. Cero cambios a `wasiai-a2a`/`wasiai-remittance-agents`.
- [ ] **CD-2 (CRÍTICA)** — todos los adapters nuevos mock/off por default; ningún env default mueve plata.
- [ ] **CD-3/CD-4/CD-16** — guard fail-loud en `createContainer()`: EIP-3009 on sin (adapter=a2a ∧ receiver ∧ usdc) → throw.
- [ ] **CD-5** — cero PII (`beneficiary.name`/`destination`) en logs/errores del adapter y las routes; mensajes de throw estables/opacos.
- [ ] **CD-6** — reconciliación PRE-`markSettled`, reusa `RECEIVE_TOL_ABS_PEN`/`RECEIVE_TOL_REL` (sin tolerancia nueva).
- [ ] **CD-7** — TODA rama `payout_failed` (5 en ConfirmAndSend + 2 en TrackRemittance) dispara refund en el mismo `execute()`.
- [ ] **CD-8** — `LedgerRefundGateway` ledger-only, comentario explícito "NO revierte on-chain real".
- [ ] **CD-9** — `REMIT_AGENTS_BASE_URL` server-only; las routes sólo devuelven `{ result }`.
- [ ] **CD-10** — `idempotencyKey` (`${remittanceId}:${quoteId}`) viaja INTACTO hasta el agente; no regenerar.
- [ ] **CD-11** — actualizar `use-cases.test.ts` (L52/53 ctors, L123 assertion) — FUERA de Scope IN pero obligatorio; `grep -rn "new ConfirmAndSend\|new TrackRemittance"` para no dejar call-sites rotos.
- [ ] **CD-12** — `noUncheckedIndexedAccess`: `?? null`/`!` deliberado/optional-chaining en accesos por índice; `vi.fn` inspeccionados tipados.
- [ ] **CD-13** — nombres de tipo EXACTOS de `ports.ts` (`RefundGateway`, `PayoutRecord`, `PayoutSubmit`, `PayoutGateway`).
- [ ] **CD-14** — tipos/helpers de viem (`signTypedData`, `isAddress`, `toHex`) — no reconstruir literal-types.
- [ ] **CD-15** — sin `any` explícito; validación de shape con type-guards.
- [ ] **CD-17** — tests que asertaban `payout_failed` terminal en escenarios que ahora refundean → `refunded`, PRESERVANDO assertions de `failureReason` y de "NOT called".

---

## 9. Test plan (≥1 por AC — dobles inyectados, sin red real)

| AC | Test | Qué cubre |
|----|------|-----------|
| AC-1 | container / `confirm-and-send.test.ts` regresión | flag unset/`"fallback"` → Fallback cableado; demo byte-idéntico |
| AC-2 | `gateways.test.ts` (a2a) + container | flag `"a2a"` → `A2aQuote/PayoutGateway` cableados |
| AC-3 | `gateways.test.ts` (`fetch` mockeado) | `requestQuote` → POST `/api/a2a/quote`; mapeo `{result}`→`Quote` (§5) |
| AC-4 | `gateways.test.ts` | `submit` → POST `/api/a2a/payout/submit`; `idempotencyKey` intacto (CD-10); `kycVerificationId` propagado; mapeo→`PayoutRecord`; `kycPayoutAllowed:true` sintetizado |
| AC-5 | `gateways.test.ts` + route `.test.ts` | !200 / shape inválido → throw PII-free; assert que el error NO contiene name/destination |
| AC-6 | `confirm-and-send.test.ts` + `track-remittance.test.ts` | `deliveredPen` dentro de tolerancia → `settled`; fuera → `payout_failed`(→`refunded`) razón `payout_amount_mismatch`; test de borde a ±tolerancia |
| AC-7 | `confirm-and-send.test.ts` + `track-remittance.test.ts` | cada rama `payout_failed` (auth, expiry×2, submit-failed, catch, mismatch, track-failed, track-mismatch) → `creditBack` llamado + `markRefunded` + status `refunded` en el mismo `execute()` |
| AC-8 | `ledger-refund-gateway.test.ts` | `creditBack` resuelve `{refundTx}` sintético |
| AC-9 | `wallet.test.ts` | flag off/unset → `signMessage` (byte-idéntico); `signTypedData` NO llamado |
| AC-10 | `wallet.test.ts` | flag on → `signTypedData` con domain/types/`to`=receiver/`value`=`quote.send.minor`; en Injected y WalletConnect |
| AC-11 | container test | EIP-3009 on + (adapter≠a2a ∨ sin receiver ∨ sin usdc) → `createContainer()` throws |
| AC-12 | revisión manual | `.env.example` documenta las vars con defaults mock/off |
| AC-13 | meta | cubierto por los `.test.ts` de arriba |
| AC-14 | `gateways.test.ts` | `status(payoutId)` devuelve el `PayoutRecord` cacheado del `submit()`; id desconocido → `failed`/`payout_status_unknown` |
| — | route `.test.ts` (ambas) | 501 sin `REMIT_AGENTS_BASE_URL`; no ecoa la base ni PII; 502 en upstream !ok/timeout (nunca 500) |
| — | regresión | los tests actuales verdes tras CD-11/CD-17 |

Usá el harness WKH-185 (`buildTestContainer` con override `refund`) en tests de flujo RTL; los
use-case tests usan dobles directos (patrón `confirm-and-send.test.ts`).

---

## 10. Regresión (default = demo byte-idéntico)

- **Adapter default (`fallback`):** `FallbackQuote/PayoutGateway` sin cambios → quote local + payout
  mock `deliveredPen:null`. AC-1 byte-idéntico.
- **EIP-3009 default (`off`):** `authorizePrincipal` = `signMessage` sin cambios. AC-9 byte-idéntico.
- **Reconciliación (AC-6):** guardada por `rec.deliveredPen &&` → con fallback (`null`) nunca corre.
- **Refund-on-failure:** en el happy demo el payout nunca llega a `payout_failed`. Los escenarios de
  fallo (auth-gate/expiry) AHORA terminan en `refunded` en vez de `payout_failed` → **cambio de
  status terminal esperado**, cubierto por CD-17 (actualizar assertions, `failureReason` intacto —
  `markRefunded` sólo patchea `refundTx`, L229-231).
- **WKH-180/182/185 intactos:** WKH-180 (autoridad server-side) y WKH-182 (CAS/expiry/`expectedReceivePen`)
  siguen intactos en lógica — sólo se agrega el paso refund tras `markPayoutFailed`. El harness RTL de
  WKH-185 sigue verde: `test-container.ts` gana un override `refund?` con default `FakeRefundGateway`
  (regresión-neutral) — el container 100% fallback del harness sigue funcionando.
- **UI (Scope OUT):** el estado `refunded` ya existe en el enum; la copy visual dedicada es HU de UI
  separada (`flow-vm` mapea `payout_failed`→"reembolsamos", sigue válido para el intermedio).

---

## 11. Done Definition

- [ ] Los 5 sitios `markPayoutFailed` de `ConfirmAndSend` + 2 de `TrackRemittance` disparan refund (CD-7).
- [ ] Reconciliación PRE-`markSettled` en ambos use-cases, reusando las constantes (CD-6).
- [ ] Adapter a2a + 2 API routes server-only; `idempotencyKey` intacto; cero PII (CD-5/CD-9/CD-10).
- [ ] EIP-3009 rama en ambos wallets reales (off por default) + guard fail-loud en container (CD-3/4/16).
- [ ] `.env.example` con las vars nuevas, defaults mock/off (AC-12/CD-2).
- [ ] ≥1 test por AC; ripple (`use-cases.test.ts`) y regresión (`confirm-and-send.test.ts`) actualizados (CD-11/CD-17).
- [ ] **`npx tsc --noEmit`** limpio.
- [ ] **`npx vitest run`** verde (todos los tests actuales + nuevos).
- [ ] **`next build`** exitoso.
- [ ] Cero cambios fuera de `chaski-v2/` (CD-1). Cero default que mueva plata real (CD-2).

---

## 12. Anti-Hallucination Checklist (marcá antes de dar por hecho)

- [ ] NO agregué campos a `PayoutSubmit`/`PayoutRecord` (`kycPayoutAllowed` se sintetiza en el adapter — DT-5).
- [ ] NO toqué `FallbackQuoteGateway`/`FallbackPayoutGateway`/`FallbackWallet` (siguen siendo el default).
- [ ] NO inventé una tolerancia nueva — reusé `RECEIVE_TOL_ABS_PEN`/`RECEIVE_TOL_REL` de `remittance.ts` (CD-6).
- [ ] NO usé `ethers` — el proyecto usa **viem** (`signTypedData`, `isAddress`, `toHex`, `createWalletClient`).
- [ ] La rama EIP-3009 NO altera el path `signMessage` (regresión AC-9).
- [ ] Los nombres de estado (`payout_failed`, `refunded`, `settled`) y de método (`markRefunded`,
      `markPayoutFailed`, `markSettled`) salen de `remittance.ts` verificado, no de memoria.
- [ ] El transporte de los agentes es `POST {BASE}/api/agents/<slug>/invoke` → `{ result }` (§5), verificado.
- [ ] Actualicé TODOS los call-sites de `new ConfirmAndSend`/`new TrackRemittance` (grep §3).
