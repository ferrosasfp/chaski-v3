# Story File — [WKH-206] Proof-of-Possession (SIWE) para el payout

> **Contrato ejecutable para el Dev (F3).** Seguí las waves EN ORDEN. Cada wave es autocontenida:
> no necesitás abrir el SDD para implementarla. Si algo NO está acá, NO lo hagas.
> **Gate de TODA wave: `npm run qa`** (= `tsc --noEmit` + `vitest run`). **NUNCA `npm run build`**
> (excluye los tests → oculta errores de tsc en mocks — lección WKH-196/WKH-168).
> Branch: `feat/017-wkh-206-payout-proof-of-possession`.

---

## 0. Contexto mínimo (leé esto una vez)

WKH-206 **construye, NO enciende** un mecanismo de proof-of-possession tipo SIWE: el caller firma con la
private key de `address` un challenge server-emitido (nonce single-use + expiración + `chainId`), y
`/api/a2a/payout/submit` recupera criptográficamente al firmante y exige que coincida con la `address` del
body ANTES de continuar. Es **defensa en profundidad opt-in**: cuando `PAYOUT_POP_SECRET` está ausente
(default), el guard hace **skip total** ⇒ `submit` byte-idéntico a pre-WKH-206.

Se apoya en WKH-202 (autoridad, guards 4-6) y WKH-168 (atestación, guard 8) **SIN tocarlos**. El guard nuevo
es el **guard 7**, insertado ENTRE los dos, sin mover una sola línea del bloque WKH-168. Arquitectura = mirror
byte-a-byte de WKH-168 (`attestation.ts` + `attestation-store.ts`). Cero dependencias npm nuevas: solo `viem` +
`node:crypto` + `@upstash/redis` (ya presentes).

**Doble flag coordinado** (idéntico a EIP3009): server `PAYOUT_POP_SECRET` (presencia = ON) ⟷ cliente
`NEXT_PUBLIC_PAYOUT_POP_ENABLED=true`.

**Total: 4 waves · 5 archivos NUEVOS · 9 archivos MODIFICADOS · 4 archivos de test nuevos + 2 extendidos.**

---

## 1. Formato EXACTO del mensaje firmado (`buildPopMessage`) — COPIAR VERBATIM, NO reinventar

Función pura, **única fuente de verdad** (DT-3 / CD-10). La usan el endpoint `/challenge` (para emitir
`popMessage`) Y el guard de `submit` (para reconstruirlo) ⇒ byte-idéntico por construcción.

```ts
export function buildPopMessage(p: PopChallenge): string {
  return `Chaski Proof-of-Possession\naddress: ${p.address}\nchainId: ${p.chainId}\nnonce: ${p.nonce}\nexpires: ${p.exp}`;
}
```

Renderizado (5 líneas `\n`-separadas, **SIN newline final**):

```
Chaski Proof-of-Possession
address: <address>
chainId: <chainId>
nonce: <nonce>
expires: <exp>
```

- `<address>`: `0x` + 40 hex **lowercased** (normalizado al emitir en `/challenge`).
- `<chainId>`: decimal (ej. `43113`).
- `<nonce>`: 32 hex sin `0x` (`randomBytes(16).toString("hex")`).
- `<exp>`: epoch **segundos** decimal.
- **Contrato de firma**: el cliente firma el `popMessage` que devolvió `/challenge` **verbatim** (NO lo
  reconstruye); el server reconstruye vía `buildPopMessage(ch)` desde el challenge HMAC-verificado.

---

## 2. Wave 0 (SERIAL GATE) — módulo puro + nonce-store

> No toca ningún archivo existente ⇒ typecheck no puede romper nada. 100% unit-testable.

### W0.1 — CREAR `src/infrastructure/auth/pop-challenge.ts`
- **Exemplar exacto a copiar**: `src/infrastructure/settlement/attestation.ts` (98 L). Copiá su estructura
  entera: `import { createHmac, timingSafeEqual } from "node:crypto"`, `import { isAddress } from "viem"`,
  el `secret()` que lee env DENTRO (CD-14), el `sign(payloadB64)` que HMACea el STRING b64url, el `isRecord`,
  el formato `${payloadB64}.${sign(payloadB64)}`, y el `verify` que devuelve `null` ante CUALQUIER problema.
- **Contrato (§5.1 del SDD)**:
  ```ts
  export interface PopChallenge {
    address: string;   // 0x+40hex, lowercased
    chainId: number;   // entero
    nonce: string;     // 32 hex (sin 0x)
    exp: number;       // epoch SEGUNDOS
  }
  export const POP_CHALLENGE_TTL_SECONDS = 10 * 60;

  function secret(): string   // process.env.PAYOUT_POP_SECRET, DENTRO de la fn; throw si falta
  function sign(payloadB64: string): string   // createHmac("sha256", secret()).update(payloadB64).digest("base64url")

  export function issuePopChallenge(p: PopChallenge): string   // `${b64url(JSON.stringify(p))}.${sign(payloadB64)}`
  export function verifyPopChallenge(token: string, nowMs: number): PopChallenge | null
  export function buildPopMessage(p: PopChallenge): string   // ver §1 — VERBATIM
  ```
- **Orden EXACTO de `verifyPopChallenge`** (mirror `verifySettlementAttestation`, CD-11):
  1. `typeof token !== "string"` → null; `split(".")` en exactamente 2 partes no vacías.
  2. `if (!process.env.PAYOUT_POP_SECRET) return null`.
  3. **HMAC PRIMERO**: `expected = Buffer.from(sign(payloadB64))`, `received = Buffer.from(macB64)`;
     `if (expected.length !== received.length) return null` **ANTES** de `timingSafeEqual` (tira con
     longitudes distintas); luego `if (!timingSafeEqual(expected, received)) return null`.
  4. Parse `b64url→JSON` en `try/catch` → null; `isRecord`.
  5. Validar CADA campo: `isAddress(address)`; `typeof chainId === "number" && Number.isInteger(chainId)`;
     `typeof nonce === "string" && /^[0-9a-f]{32}$/.test(nonce)`; `typeof exp === "number" && Number.isFinite(exp)`.
  6. `if (exp * 1000 <= nowMs) return null`.
- **CD-6**: nunca loguear firma/nonce/address. **CD-14** (grep-safe): comentarios que citen antipatrones
  (`ethers`, `siwe`, `fail-open`) → parafrasear, NO usar el token literal.

### W0.2 — CREAR `src/infrastructure/auth/pop-nonce-store.ts`
- **Exemplar exacto a copiar**: `src/infrastructure/settlement/attestation-store.ts` (67 L). Copiá el
  `getRedis()` memoizado con env DENTRO (CD-14), el `redis.set(key,"1",{nx:true,ex})`, el fail-CLOSED, y el
  `__reset...`.
- **Contrato (§5.2 del SDD)**:
  ```ts
  export type PopNonceClaim =
    | { ok: true }
    | { ok: false; alreadyUsed: true }
    | { ok: false; unavailable: true };

  const CLAIM_TTL_SECONDS = 86_400; // > POP_CHALLENGE_TTL_SECONDS

  export async function claimPopNonceOnce(nonce: string): Promise<PopNonceClaim>
  // getRedis() memoizado, env DENTRO. !redis → {ok:false,unavailable:true} (fail-CLOSED).
  // redis.set(`pop:nonce:${nonce}`, "1", {nx:true, ex:CLAIM_TTL_SECONDS}):
  //   "OK"  → {ok:true}
  //   null  → {ok:false, alreadyUsed:true}
  // catch → {ok:false, unavailable:true}   ← PROHIBIDO {ok:true} en catch/!redis (CD-3)

  export function __resetPopNonceStore(): void
  ```
- **CD-3 (crítico)**: fail-CLOSED. PROHIBIDO `{ok:true}` en el `catch` o el `!redis`. Este NO es `rate-limit.ts`.
- **Key namespace**: `pop:nonce:${nonce}` (distinto de `settle:att:${txHash}` — no colisiona).

### Tests W0 (nombres del §7 del SDD)
- `src/infrastructure/auth/pop-challenge.test.ts` (NUEVO):
  - `verify` OK round-trip (issue→verify) — AC-2.
  - HMAC forjado / firmado con otro secreto → null — AC-3-cripto.
  - exp vencido → null; tipos deformes (address/chainId/nonce) → null — AC-4/AC-6.
  - `buildPopMessage` contiene address+chainId+nonce+expires, formato exacto, **sin `\n` final** — AC-6/DT-3.
- `src/infrastructure/auth/pop-nonce-store.test.ts` (NUEVO):
  - `claimPopNonceOnce` primer uso `{ok:true}`; 2º `{alreadyUsed}`; sin redis / throw → `{unavailable}` (fail-closed) — AC-4.

### Gate W0
`npm run qa` verde. **DoD W0**: 2 archivos nuevos + 2 tests nuevos; ningún archivo existente tocado;
`tsc --noEmit` limpio; vitest verde.

---

## 3. Wave 1 (server enforcement — depende de W0)

### W1.1 — CREAR `app/api/a2a/payout/challenge/route.ts`
- **Exemplares**: `app/api/a2a/payout/submit/route.ts` (parseo defensivo `:57-78`) + `app/api/payout/validate/route.ts`
  (wrapper delgado, patrón de la route).
- **Handler (§5.3 del SDD, defensivo — NUNCA 500 crudo)**:
  1. `const POP_SECRET = process.env.PAYOUT_POP_SECRET;` (dentro del handler, CD-14).
     `if (!POP_SECRET) return NextResponse.json({ error: "pop_not_configured" }, { status: 501 });`
  2. `const parsed: unknown = await req.json().catch(() => null); const body = isRecord(parsed) ? parsed : {};`
     (auto-blindaje WKH-202 BLQ-BAJO-1: `req.json()` resuelve con `null` para el literal `null` ⇒ el `.catch`
     NO dispara ⇒ isRecord cubre null).
  3. `const address = typeof body.address === "string" ? body.address : "";`
     `if (!isAddress(address)) return NextResponse.json({ error: "pop_invalid_request" }, { status: 400 });`
  4. `const nonce = randomBytes(16).toString("hex"); const exp = Math.floor(Date.now()/1000) + POP_CHALLENGE_TTL_SECONDS;`
     `const chainId = resolveChainId(); const addr = address.toLowerCase();`
  5. `const challenge = issuePopChallenge({ address: addr, chainId, nonce, exp });`
     `const message = buildPopMessage({ address: addr, chainId, nonce, exp });`
  6. `return NextResponse.json({ popChallenge: challenge, popMessage: message, exp }, { status: 200 });`
- Imports: `randomBytes` de `node:crypto`; `isAddress` de `viem`; `resolveChainId` de `chain`;
  `issuePopChallenge`, `buildPopMessage`, `POP_CHALLENGE_TTL_SECONDS` de `pop-challenge`.
- **NO** fetchea Didit, **NO** lee estado KYC, **NO** escribe en Upstash (DT-5: el nonce se quema recién en `submit`).
- Errores: 501 (no config), 400 (address malformada). Cero 500.

### W1.2 — MODIFICAR `app/api/a2a/payout/submit/route.ts` — insertar guard 7
- **Imports nuevos** (junto a los de `:33-34`):
  ```ts
  import { verifyPopChallenge, buildPopMessage } from "../../../../../src/infrastructure/auth/pop-challenge";
  import { claimPopNonceOnce } from "../../../../../src/infrastructure/auth/pop-nonce-store";
  import { verifyMessage } from "viem";
  ```
  (verificá que el path relativo `../../../../../src/...` coincida con los imports existentes `:31-34`.)
- **Posición EXACTA del bloque**: se inserta **entre la línea `:111`** (`  }` que cierra el `if (!d.authorized)`
  del switch de autoridad WKH-202) **y la línea `:113`** (`  // ── 8. Atestación de settlement...`). El bloque
  WKH-168 (`:113-201`) queda **byte-idéntico**, no se mueve NI UNA línea (CD-5, verificable con `md5sum`).
- **Guard 7 — pseudo-código anotado (§5.4 del SDD)**. Todos los `403` devuelven el MISMO body
  `{ error: "payout_pop_unverified" }` (CD-4 no-oracle). El agente NUNCA se invoca en un path de rechazo:
  ```ts
  // ── 7. Proof-of-Possession (WKH-206) ──────────────────────────────────────────
  const POP_SECRET = process.env.PAYOUT_POP_SECRET;   // CD-14: dentro del handler
  if (POP_SECRET) {                                    // presencia = ON; ausente = SKIP total (DT-4, AC-1)
    const popChallenge = body.popChallenge;
    const popSignature = body.popSignature;
    // P1 — presencia + tipo
    if (typeof popChallenge !== "string" || !popChallenge.trim() ||
        typeof popSignature !== "string" || !popSignature.trim()) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    // P2 — HMAC + exp + tipos (fail-closed → null)
    const ch = verifyPopChallenge(popChallenge, Date.now());
    if (!ch) return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    // P3 — el challenge fue emitido para ESTA address (case-insensitive)
    if (ch.address.toLowerCase() !== address.toLowerCase()) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    // P4 — chainId binding (AC-6). Contra la ENV server-side (resolveChainId()), NUNCA un chainId del body.
    if (ch.chainId !== resolveChainId()) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    // P5 — PRUEBA CRIPTOGRÁFICA: recuperar al firmante del mensaje reconstruido (buildPopMessage=SSOT).
    let ok = false;
    try {
      ok = await verifyMessage({ address: ch.address, message: buildPopMessage(ch), signature: popSignature });
    } catch {
      ok = false;   // firma/address malformada → fail-closed
    }
    if (!ok) return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    // P6 — single-use atómico, fail-CLOSED (mirror A8/A9)
    const claim = await claimPopNonceOnce(ch.nonce);
    if (!claim.ok) {
      if ("alreadyUsed" in claim) {
        return NextResponse.json({ error: "payout_pop_replayed" }, { status: 409 });
      }
      return NextResponse.json({ error: "payout_pop_unavailable" }, { status: 503 }); // Upstash caído → NUNCA forward
    }
  }
  // (bloque WKH-168 `// ── 8. Atestación` sigue byte-idéntico debajo)
  ```
- **DT-4 crítico**: con `PAYOUT_POP_SECRET` ausente → SKIP total en TODO entorno (Vercel incluido). NO hay
  A2-style 503-cuando-ausente (eso violaría AC-1). El `verifyMessage` de viem es `async` (cubre ERC-1271).

### Tests W1
- `app/api/a2a/payout/challenge/route.test.ts` (NUEVO):
  - secreto off → 501 `pop_not_configured` — AC-1.
  - address válida → 200 `{popChallenge, popMessage, exp}`, HMAC verificable (`verifyPopChallenge` REAL) — AC-2.
  - address malformada / body `null` → 400, nunca 500 — robustez.
- `app/api/a2a/payout/submit/route.test.ts` (EXTENDER): la matriz completa va en **W3** (abajo). En W1 solo
  agregá el mock de `pop-nonce-store` con `vi.hoisted` + type param (ver §5) y el stub `vi.stubEnv("PAYOUT_POP_SECRET","")`
  en el `beforeEach`, dejando los tests existentes verdes.

### Gate W1
`npm run qa` verde. **DoD W1**: `/challenge` route + su test; guard 7 insertado; bloque WKH-168 byte-idéntico;
tests preexistentes de `submit` verdes.

---

## 4. Wave 2 (client wiring — depende de W0; TODO en UNA wave, CD-15)

> **CD-15 (auto-blindaje WKH-201)**: cambiar `WalletPort` o el constructor de `ConfirmAndSend` rompe AMBOS
> composition roots (`container.ts` Y `test-container.ts`) + `FakeWallet`. **Se tocan JUNTOS en esta wave** o
> `tsc` queda rojo. NO dividas W2.

### W2.1 — MODIFICAR `src/application/ports.ts`
```ts
// nuevo puerto
export interface PopSigner {
  prove(address: string): Promise<{ challenge: string; signature: string }>;
}
// WalletPort: agregar método (dentro de la interface existente, :153-163)
signMessage(message: string): Promise<string>;
// PayoutSubmit: agregar campos opcionales (junto a settlementAttestation?, :77)
popChallenge?: string;
popSignature?: string;
```
Los campos opcionales son **server-enforced** (mismo criterio que `settlementAttestation?` :73-77 — NO es fail-open).

### W2.2 — MODIFICAR `src/infrastructure/wallet.ts` — `signMessage` en los 3 wallets
- `InjectedWallet` (clase :52) y `WalletConnectWallet` (`signMessage` demo en :259-262): agregar método
  ```ts
  async signMessage(message: string): Promise<string> {
    const eth = injectedProvider(); // (InjectedWallet) / provider ensureProvider() (WalletConnectWallet)
    if (!eth || !this.address) throw new Error("wallet_not_connected");
    const client = createWalletClient({ chain: resolveChain(), transport: custom(eth) });
    return client.signMessage({ account: this.address, message });
  }
  ```
  (Reusá el patrón exacto de firma demo ya presente en `:127-130` / `:259-262`.)
- `FallbackWallet` (:136): `async signMessage(_message: string): Promise<string> { return "0xdemosig" + Date.now().toString(16); }`
  (firma fake demo, no toca red — mismo espíritu que `authorizePrincipal` fake :146-148).

### W2.3 — CREAR `src/infrastructure/auth/http-pop-signer.ts`
- Implementa `PopSigner`. ctor `(wallet: WalletPort)`.
  ```ts
  export class HttpPopSigner implements PopSigner {
    constructor(private readonly wallet: WalletPort) {}
    async prove(address: string): Promise<{ challenge: string; signature: string }> {
      const res = await fetch("/api/a2a/payout/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) throw new Error("pop_challenge_unavailable"); // 501/400 → cliente lo trata como skip vía throw
      const { popChallenge, popMessage } = (await res.json()) as { popChallenge: string; popMessage: string };
      const signature = await this.wallet.signMessage(popMessage);
      return { challenge: popChallenge, signature };
    }
  }
  ```

### W2.4 — MODIFICAR `src/infrastructure/a2a/gateways.ts` — forward en `A2aPayoutGateway.submit`
- En el `JSON.stringify({...})` (`:123-138`), junto a `settlementAttestation: req.settlementAttestation` (:137),
  agregar:
  ```ts
  popChallenge: req.popChallenge,
  popSignature: req.popSignature,
  ```
  En demo son `undefined` ⇒ `JSON.stringify` los omite ⇒ body byte-idéntico (AC-5).

### W2.5 — MODIFICAR `src/application/use-cases/confirm-and-send.ts` — 8º param `pop?`
- Constructor: agregar **8º param** DESPUÉS de `settlement?` (:41):
  ```ts
  private readonly pop?: PopSigner,
  ```
  (importar `PopSigner` del `ports` :3-11). **CD-13**: application NUNCA importa infrastructure ni lee
  `process.env`. `pop` viaja inyectado. `undefined` ⇒ demo byte-idéntico por construcción.
- En `execute`, ANTES del `this.payouts.submit({...})` (:213), obtener la prueba:
  ```ts
  let popChallenge: string | undefined;
  let popSignature: string | undefined;
  if (this.pop) {
    const proof = await this.pop.prove(address ?? "");
    popChallenge = proof.challenge;
    popSignature = proof.signature;
  }
  ```
  Y pasar `popChallenge, popSignature` dentro del objeto de `submit(...)` (junto a `settlementAttestation` :223).
  `undefined` ⇒ no se adjunta ⇒ byte-idéntico (AC-5). (`address` ya existe en el scope, :94.)

### W2.6 — MODIFICAR `container.ts` + `test-container.ts` + `fakes.ts` (JUNTOS, CD-15)
- `container.ts`: importá `HttpPopSigner`. Después de `const settlement = ...` (:88-91), antes del `return`:
  ```ts
  const pop =
    process.env.NEXT_PUBLIC_PAYOUT_POP_ENABLED === "true" ? new HttpPopSigner(wallet) : undefined;
  ```
  Y agregar `pop` como **8º arg** de `new ConfirmAndSend(...)` (:100-108), después de `settlement`.
- `test-container.ts`: agregar `pop?: PopSigner;` a `TestContainerOverrides` (:45-61); pasar `o.pop` como 8º
  arg de `new ConfirmAndSend(...)` (:83-91), después de `o.settlement`. Importar `PopSigner` del ports.
- `fakes.ts`: agregar `FakeWallet.signMessage` (:248, dentro de la clase):
  ```ts
  async signMessage(_message: string): Promise<string> { return "0xfakesig"; }
  ```
  y crear un `FakePopSigner`:
  ```ts
  export class FakePopSigner implements PopSigner {
    async prove(_address: string): Promise<{ challenge: string; signature: string }> {
      return { challenge: "pop-ch", signature: "0xfakesig" };
    }
  }
  ```

### Tests W2
- `src/infrastructure/auth/http-pop-signer.test.ts` (NUEVO): `prove` fetchea `/challenge` + `wallet.signMessage`
  → `{challenge, signature}`; `!res.ok` (501) → throw. **Mock de fetch multi-llamada con `mockImplementation`,
  NUNCA `mockResolvedValue` sobre un `Response` reusado** (auto-blindaje 168 W2).
- `src/application/use-cases/confirm-and-send.test.ts` (EXTENDER, 24 tests preexistentes — contá con
  `grep -c "  it(" ANTES): `pop` inyectado (via `FakePopSigner`) adjunta `popChallenge`/`popSignature` al submit;
  `pop` undefined ⇒ byte-idéntico (el submit NO recibe esos campos). — AC-1/AC-5.

### Gate W2
`npm run qa` verde. **DoD W2**: `WalletPort.signMessage` + `PopSigner` + `PayoutSubmit` campos; los 3 wallets +
`FakeWallet` implementan `signMessage`; `HttpPopSigner`; gateway forward; 8º param en `ConfirmAndSend` + AMBOS
roots + fakes; tsc limpio (prueba de que CD-15 se respetó).

---

## 5. Wave 3 (integración + matriz de seguridad + no-regresión — depende de W0/W1/W2)

Todo en `app/api/a2a/payout/submit/route.test.ts` (EXTENDER). **Preexistentes: 27 tests `it(` (contá con
`grep -c "  it(" ANTES de escribir y re-contá al final — auto-blindaje 198/201/202).**

### Mocking (exemplar: encabezado del `submit/route.test.ts` WKH-168, líneas :9-15)
```ts
type PopNonceClaim = { ok: true } | { ok: false; alreadyUsed: true } | { ok: false; unavailable: true };
const { popClaimMock } = vi.hoisted(() => ({
  popClaimMock: vi.fn<(nonce: string) => Promise<PopNonceClaim>>(async () => ({ ok: true })),
}));
vi.mock("../../../../../src/infrastructure/auth/pop-nonce-store", () => ({
  claimPopNonceOnce: popClaimMock,
}));
```
- **Type param OBLIGATORIO en `vi.fn`** (CD-16): sin él tsc infiere `{ok:boolean}` y las ramas
  `alreadyUsed`/`unavailable` no compilan. El gate es `npm run qa`, NUNCA `npm run build`.
- `pop-challenge` corre **REAL** (HMAC de verdad). NO lo mockees.
- Firmas reales: `import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";` — firmá con
  `account.signMessage({ message: buildPopMessage(...) })` (o vía un walletClient). Cero dep nueva.
- `beforeEach`: agregar `vi.stubEnv("PAYOUT_POP_SECRET", "")`. Los tests que quieren PoP re-stubean adentro.
- Mocks de fetch multi-respuesta → `mockImplementation`, NUNCA `mockResolvedValue` sobre `Response` reusado.

### Matriz (§7 del SDD)
| Test | AC / riesgo |
|---|---|
| `submit`: secreto off → **byte-idéntico**; `popClaimMock` NUNCA llamado; sin fetch challenge | AC-1 |
| `submit`: secreto off en **Vercel** (`VERCEL_ENV=preview`) → SKIP igual (NO 503, DT-4) | AC-1/DT-4 |
| `submit`: happy — challenge válido + firma real (`privateKeyToAccount`) que recupera a `address` → forward | AC-3 |
| `submit`: firma de OTRA key (recupera a address distinta) → 403 opaco, agente NUNCA | AC-3 / suplantación |
| `submit`: `popChallenge`/`popSignature` ausentes o no-string → 403, agente NUNCA | AC-3 |
| `submit`: challenge de address distinta a `body.address` (P3) → 403 | AC-3 |
| `submit`: replay (2ª presentación, `popClaimMock` `{alreadyUsed}`) → 409, agente NUNCA | AC-4 / replay |
| `submit`: challenge expirado → 403 (MISMO enum que HMAC malo, no-oracle) | AC-4 |
| `submit`: nonce-store caído (`{unavailable}`) → 503 fail-closed, agente NUNCA | AC-4 / fail-open store |
| `submit`: challenge de OTRA cadena (`ch.chainId ≠ resolveChainId`) → 403 | AC-6 / replay cross-entorno |
| `submit`: **mutante fail-open chainId** — body jura `chainId:[43113,"43114",null]` + challenge de otra cadena ⇒ 403 igual | AC-6 / auto-blindaje 168#2 |
| `submit`: no-oracle — P2/P3/P4/P5 devuelven el MISMO status+body (403 `payout_pop_unverified`) | CD-4 |
| `submit`: **no-regresión WKH-202** — ownership mismatch → 403 ANTES del guard PoP (guards 4-6 intactos) | AC-5 |
| `submit`: **no-regresión WKH-168** — los tests de atestación siguen verdes; bloque byte-idéntico (`md5sum`) | AC-5 |
| `submit`: **mutante — guard PoP corre ANTES del claim de atestación**; en 403 stateless `popClaimMock` NO llamado en path de rechazo P1-P5 | AC-5 / fail-open |
| `package.json` sin `siwe`/`ethers` (`grep -c → 0`) | AC-7 |

**Regla de falso-verde (auto-blindaje 168 W5/6)**: cada test debe *llegar a la rama que dice probar*, no solo
matchear el status. Usá `expect(agentCalls).toHaveLength(0)` (el `fetchRouter` ya separa `agentCalls`, :70-81) y
`expect(popClaimMock).not.toHaveBeenCalled()` donde corresponda.

### Byte-identidad del bloque WKH-168 (auto-blindaje 168/202)
Verificá con **`md5sum` del bloque `:113-201`**, NO con `git diff` (el archivo está modificado → diff no prueba
que ESE bloque quedó intacto). Ej.: extraé las líneas `:113-201` a un tmp y compará su md5 contra el mismo rango
en `git show HEAD:app/api/a2a/payout/submit/route.ts`.

### Gate W3
`npm run qa` verde; suite completa sin regresiones. **DoD W3**: matriz completa; mutantes fail-open (chainId,
address, burn-position) presentes Y en rojo si se invierte el guard; bloque WKH-168 md5-idéntico; conteo de tests
re-verificado con `grep`/vitest.

---

## 6. CD-1..CD-16 como checks verificables (referencia — NO re-leer el SDD entero)

| CD | Regla | Check concreto |
|---|---|---|
| CD-1 | Solo `viem` + `node:crypto`; PROHIBIDO `siwe`/`ethers` | `grep -c "siwe\|ethers" package.json` → **0**; los módulos nuevos importan solo `viem`/`node:crypto`/`@upstash/redis` |
| CD-2 | Byte-idéntico cuando `PAYOUT_POP_SECRET` ausente | `md5sum` del bloque WKH-168 (:113-201) + test byte-idéntico (Vercel incluido) |
| CD-3 | nonce single-use `SET NX EX`, fail-CLOSED | `pop-nonce-store.ts`: `catch`/`!redis` → `{unavailable}`, **nunca `{ok:true}`**; test store-down → 503 |
| CD-4 | no-oracle: todo fallo cripto/stateless → MISMO 403 `payout_pop_unverified` | test P2/P3/P4/P5 mismo status+body |
| CD-5 | NO debilitar/mover guards WKH-202/168 | bloque WKH-168 `md5sum`-idéntico; guard 7 insertado entre `:111` y `:113` |
| CD-6 | NO loguear firma/nonce/address | errores solo enums; grep de los módulos por `console.`/interpolación de `nonce`/`signature` en strings de error |
| CD-7 | `chainId` (`resolveChainId()`) + `exp` en el mensaje firmado | `buildPopMessage` incluye ambos (§1); P4 compara contra ENV |
| CD-8 | `PAYOUT_POP_SECRET` SIN `NEXT_PUBLIC_`; leído DENTRO del handler | `grep "NEXT_PUBLIC_PAYOUT_POP_SECRET"` → 0; `secret()`/handlers leen env dentro |
| CD-9 | chainId de P4 sale de `resolveChainId()`, NUNCA del body | test mutante body-sourced chainId → 403 |
| CD-10 | `buildPopMessage` = única fuente del formato | cliente firma `popMessage` verbatim; server reconstruye vía `buildPopMessage(ch)`; NO hay 2º lugar que arme el string |
| CD-11 | `verifyPopChallenge` → null ante todo; HMAC PRIMERO + length-check antes de `timingSafeEqual`; parse en try/catch; tipo de cada campo | orden §2 W0.1 |
| CD-12 | PROHIBIDO tocar `validate/route.ts`, `authority.ts`, `attestation.ts`, `attestation-store.ts`, bloque WKH-168, Didit, wasiai-a2a/v2/demo | `git diff --name-only` no debe listar esos archivos (salvo los imports/guard-7 de `submit/route.ts`) |
| CD-13 | `confirm-and-send.ts` NUNCA importa infrastructure ni lee `process.env` | `grep "infrastructure\|process.env" src/application/use-cases/confirm-and-send.ts` → 0 (aparte de lo preexistente) |
| CD-14 | comentarios grep-safe: no usar token literal `ethers`/`siwe`/`fail-open` si un CD lo grepea a 0 | parafrasear en comentarios |
| CD-15 | cambiar `WalletPort`/constructor toca `container.ts` **Y** `test-container.ts` **Y** `fakes.ts` en la MISMA wave (W2) | tsc limpio tras W2 |
| CD-16 | `vi.fn` de unión discriminada (`PopNonceClaim`) lleva **type param explícito** | ver §5; gate `npm run qa`, NUNCA `npm run build` |

---

## 7. Anti-alucinación / trampas a evitar (auto-blindaje §9 del SDD)

| Trampa | Check concreto |
|---|---|
| Contar tests "a ojo" (mal) | `grep -c "  it(" <archivo>` / output de vitest ANTES y DESPUÉS. **Preexistentes: `submit/route.test.ts`=27, `confirm-and-send.test.ts`=24.** |
| Test verde por el guard equivocado (falso verde) | verificar que el test llega a la rama que dice probar: `expect(agentCalls).toHaveLength(0)` + `expect(popClaimMock).not.toHaveBeenCalled()` |
| Escribir el mutante ausente pero NO el fail-open | tests de mutante fail-open para chainId (P4), address (P3), burn-position (P6) — cada uno rojo si se invierte el guard |
| `vi.fn` de unión sin type param → tsc rojo que `build` oculta | type param `<(nonce: string) => Promise<PopNonceClaim>>` (§5); gate `npm run qa` |
| `mockResolvedValue` de un `Response` reusado → falso verde | `mockImplementation` para fetch multi-llamada (`http-pop-signer.test.ts`, `submit`) |
| Cambiar interfaz/constructor rompe AMBOS composition roots | W2 toca `container.ts` + `test-container.ts` + `fakes.ts` JUNTOS (CD-15) |
| `git diff` sobre archivo modificado da falsa tranquilidad | byte-identidad del bloque WKH-168 vía **`md5sum` del rango :113-201**, NO `git diff` |
| Campo firmado sin verificar = binding falso | cada campo de `PopChallenge` (address/chainId/nonce/exp) se verifica (P2 tipos+exp, P3 address, P4 chainId, P5 firma) |

---

## 8. Orden de ejecución y gates (resumen)

1. **W0** (serial gate): `pop-challenge.ts` + `pop-nonce-store.ts` + 2 tests. No toca routes → typecheck no
   rompe nada. Gate: `npm run qa`.
2. **W1**: `challenge/route.ts` (nuevo) + guard 7 en `submit/route.ts` (bloque WKH-168 intacto) + tests de
   `/challenge`. Gate: `npm run qa`.
3. **W2** (una wave, CD-15): `ports.ts` + `wallet.ts` + `http-pop-signer.ts` + `gateways.ts` + `confirm-and-send.ts`
   + `container.ts` + `test-container.ts` + `fakes.ts` + tests. Tocá los 2 composition roots + fakes JUNTOS.
   Gate: `npm run qa`.
4. **W3**: matriz de seguridad + no-regresión (mutantes fail-open, `md5sum` bloque WKH-168, no-oracle) en
   `submit/route.test.ts`. Gate: `npm run qa` verde, suite completa sin regresiones.

**Entre waves NO hay gate humano** — corré W0→W1→W2→W3 y entregá al Adversary (AR).

---

## 9. Inventario de archivos

**NUEVOS (5 producción + 4 test):**
- `src/infrastructure/auth/pop-challenge.ts` (W0) + `.test.ts`
- `src/infrastructure/auth/pop-nonce-store.ts` (W0) + `.test.ts`
- `app/api/a2a/payout/challenge/route.ts` (W1) + `.test.ts`
- `src/infrastructure/auth/http-pop-signer.ts` (W2) + `.test.ts`

**MODIFICADOS (9):**
- `app/api/a2a/payout/submit/route.ts` (W1: imports + guard 7) + `route.test.ts` (W1/W3: matriz)
- `src/application/ports.ts` (W2)
- `src/infrastructure/wallet.ts` (W2)
- `src/infrastructure/a2a/gateways.ts` (W2)
- `src/application/use-cases/confirm-and-send.ts` (W2) + `confirm-and-send.test.ts` (W2)
- `src/composition/container.ts` (W2)
- `src/test-support/test-container.ts` (W2)
- `src/test-support/fakes.ts` (W2)

---

## 10. [SDD-GAP] detectado (informativo, NO bloqueante)

- **[SDD-GAP-1]** El SDD §6 (W3) y §8 (CD-2) citan "los **19+6** tests preexistentes de `submit`" (= 25). El
  conteo real hoy es **`grep -c "  it(" app/api/a2a/payout/submit/route.test.ts` = 27**. No cambia el diseño ni
  el scope: el propio SDD (§7) manda contar con `grep`/vitest, no a ojo — este Story File usa el número real
  (27). **No lo resolví inventando**: lo dejo señalado para que el Dev tome el conteo `grep` como autoritativo y
  el Architect/QA lo note. Igual para `confirm-and-send.test.ts` = 24 (el SDD no da número).

---

*Story File generado por NexusAgil F2.5 — Architect: agente nexus-architect. Fuente única: SDD aprobado
`sdd.md` + exemplars verificados con Read.*
