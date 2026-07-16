# SDD — [WKH-206] G5 del gate de Fase A: proof-of-possession (SIWE) para el payout

> SPEC_APPROVED: no
> Fecha: 2026-07-16
> Tipo: feature (superficie de seguridad money-path — identidad/auth/cripto)
> SDD_MODE: full
> Metodología: QUALITY (sin excepción — money-path)
> Branch: `feat/017-wkh-206-payout-proof-of-possession`
> Artefactos: `doc/sdd/017-wkh-206-payout-proof-of-possession/`
> Gate de la HU: `npm run qa` (= `tsc --noEmit` + `vitest run`, `package.json`). NUNCA `npm run build` (excluye los tests — lección WKH-196/WKH-168).

---

## 1. Contexto + Hallazgo Central heredado

WKH-206 construye (**NO enciende**) un mecanismo de **proof-of-possession** tipo SIWE: el caller firma con la private key de `address` un *challenge* server-emitido (nonce single-use, con expiración, atado a `chainId`), y `/api/a2a/payout/submit` recupera criptográficamente al firmante y exige que coincida EXACTAMENTE con la `address` declarada en el body antes de continuar. Es **defensa en profundidad**: el F0 (Hallazgo Central del work-item) probó que el único camino que hoy mueve dinero real — `EIP3009_ENABLED=true` + `SETTLE_ATTESTATION_SECRET` — YA tiene una prueba de posesión *criptográfica transitiva* vía WKH-168 A7 (el contrato USDC rechaza on-chain una `transferWithAuthorization` cuya firma no recupere al `from`). El gap que WKH-206 cierra es el **resto de la superficie**: (1) `/api/payout/validate` (oráculo de ownership sin atestación), (2) el guard-4-6 de autoridad (WKH-202) que corre ANTES de la atestación y sería la única defensa si un 2º money-rail no reusara la composición `settle→verify→attest`, y (3) desacoplar la invariante de identidad del rail de settlement concreto. **El humano decidió BUILD AHORA** (gate `HU_APPROVED`). **DT-1 = opción (a)**: endpoint nuevo `/api/a2a/payout/challenge` + verificación inline en `submit` (única opción que aporta algo nuevo dado el Hallazgo Central).

**Coordinación WKH-168 — RESUELTA y verificada en este SDD**: `git log` confirma que `main` está en `f289cae` (`feat(WKH-168): principal-in real`), working tree limpio ⇒ **cero riesgo de conflicto de merge** sobre `submit/route.ts`/`confirm-and-send.ts`. El `_INDEX.md` decía "F1 (en curso)" para WKH-168 — es **stale**, no bloqueante.

---

## 2. Work Item (resumen)

| Campo | Valor |
|-------|-------|
| **#** | WKH-206 |
| **Tipo** | feature (security, money-path) |
| **Objetivo** | Proof-of-possession de `address` (SIWE/personal_sign) como guard opt-in en el payout, OFF por default. |
| **Scope IN** | `pop-challenge.ts` (nuevo), `pop-nonce-store.ts` (nuevo), `/api/a2a/payout/challenge/route.ts` (nuevo), guard nuevo en `submit/route.ts`, `http-pop-signer.ts` (nuevo), wiring en `ports.ts`/`wallet.ts`/`a2a/gateways.ts`/`confirm-and-send.ts`/`container.ts`/`test-container.ts`/`fakes.ts`, tests. |
| **Scope OUT** | NO encender `NEXT_PUBLIC_EIP3009_ENABLED` ni `PAYOUT_POP_SECRET`; NO reimplementar WKH-202/WKH-168; NO tocar Didit/`vendor_data`; NO tocar `/api/payout/validate` (ver DT-9); NO tocar `wasiai-a2a`/`wasiai-v2`/demo; NO cerrar reconciliación server-side (WKH-207). |
| **Missing Inputs** | DT-1 resuelto por humano (a). DT-2/DT-3 resueltos en este SDD. Cero `[NEEDS CLARIFICATION]` residuales. |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1** (state-driven): WHILE el mecanismo NO está configurado (secreto ausente), the system SHALL procesar `submit` **byte-idéntico** a pre-WKH-206 (ningún fetch nuevo, ningún guard evaluado).
- **AC-2** (event-driven): WHEN un caller pide un challenge, the system SHALL emitir un nonce single-use con expiración explícita, single-use garantizado server-side por el mismo `SET NX EX` atómico que `claimAttestationOnce`, SOLO WHERE el mecanismo está configurado.
- **AC-3** (event-driven): WHEN el caller presenta una firma sobre el challenge vigente, the system SHALL recuperar criptográficamente la address firmante y SHALL rechazar con el mismo error opaco IF la address recuperada ≠ (case-insensitive) la `address` del body.
- **AC-4** (unwanted): IF el nonce ya fue reclamado (replay) O está expirado O el nonce-store no está disponible, THEN the system SHALL rechazar fail-closed (SIN forwardear), replicando A8/A9.
- **AC-5** (state-driven): WHILE está habilitado, el guard nuevo SHALL correr SIN debilitar/saltear/condicionar los guards de WKH-202 y WKH-168.
- **AC-6** (event-driven): WHEN se construye el mensaje a firmar, the system SHALL incluir `resolveChainId()` y una expiración explícita en el payload firmado (mata replay cross-entorno — mismo criterio A7″).
- **AC-7** (ubiquitous): the system SHALL usar exclusivamente `viem` para la verificación criptográfica — cero dependencias npm nuevas.

---

## 3. Context Map — qué leí y qué extraje (todo verificado con Read/Glob/Grep)

| Archivo (verificado) | Por qué | Patrón / evidencia extraída |
|---|---|---|
| `app/api/a2a/payout/submit/route.ts` (221 L) | El guard-order donde se inserta el nuevo guard | Guard-order fail-closed: `:61` `!BASE→501`; `:69-70` parseo `unknown`+`isRecord` (NUNCA cast); `:76-78` formato→400; `:82-111` autoridad WKH-202 (guards 4-6); `:113-201` **atestación WKH-168 (guard 8, A1-A9)**; `:204-220` forward en try/catch. `:116` `SETTLE_SECRET` leído DENTRO del handler (CD-14). `:120-123` A1/A2: sin secreto en Vercel→503, fuera de Vercel→skip. `:188-190` A7″ chainId-binding contra `resolveChainId()`. `:192-200` claim single-use→409/503. |
| `src/infrastructure/settlement/attestation.ts` (98 L) | **Exemplar exacto** de `pop-challenge.ts` | Formato `${b64url(JSON)}.${b64url(hmac)}`; HMAC sobre el STRING b64url (`:36-38`); `secret()` lee env DENTRO (`:29-34`, CD-14); `verify` devuelve `null` ante CUALQUIER problema (`:54-98`): HMAC PRIMERO con check de longitud antes de `timingSafeEqual` (`:70-73`), parse en try/catch (`:76-81`), validar tipo de CADA campo (`:85-92`, `isAddress` para addresses), expiración `exp*1000<=nowMs` (`:95`). `ATTESTATION_TTL_SECONDS = 15*60` (`:27`). |
| `src/infrastructure/settlement/attestation-store.ts` (67 L) | **Exemplar exacto** de `pop-nonce-store.ts` | `claimAttestationOnce`: `getRedis()` memoizado, env DENTRO (`:30-37`, CD-14); `redis.set(key,"1",{nx:true,ex})` → `"OK"`=primer uso, `null`=replay (`:49-53`); **fail-CLOSED**: `if (!redis) return {ok:false,unavailable:true}` (`:46`) y `catch → {ok:false,unavailable:true}` (`:55-59`) — la cabecera `:7-11` es explícita: "NUNCA fail-open, no es rate-limit.ts". `CLAIM_TTL_SECONDS = 86_400 > TTL de la atestación` (`:23-25`). `__resetAttestationStore()` para tests (`:65-67`). |
| `src/infrastructure/wallet.ts` (279 L) | Cómo se firma hoy client-side + dónde agregar `signMessage` | `:127-130` (`InjectedWallet`) y `:259-262` (`WalletConnectWallet`): `client.signMessage({account, message})` — **el mensaje demo `"Chaski · autorizo enviar…"`** es exactamente el patrón de DT-3. `FallbackWallet.authorizePrincipal` (`:146-148`) devuelve un `tx` fake. Los 3 wallets implementan `WalletPort`. `resolveChainId()` importado de `./chain` (`:7`). |
| `src/infrastructure/chain.ts` (39 L) | Binding chainId (AC-6/CD-7) | `resolveChainId()` (`:9-13`) → 43113|43114 (default), NO tira (fallback). |
| `src/infrastructure/payout/authority.ts` (92 L) | WKH-202 — NO se toca; entender el guard-order | `resolvePayoutAuthority`. La `MNR-B` (`:73-82`) NOMBRA el gap que WKH-206 cierra: *"el ownership sólo tiene fuerza real cuando `address` proviene de un caller AUTENTICADO (sesión firmada / SIWE)… el hardening completo (binding a sesión firmada / SIWE) = follow-up"* ⇒ **WKH-206 es ese follow-up nombrado en el código**. |
| `src/application/use-cases/confirm-and-send.ts` (250 L) | Wiring cliente + patrón de inyección opcional | `:19-42` constructor: **7º param `settlement?` OPCIONAL** = patrón de la inyección gateada (WKH-168) — `undefined` ⇒ demo byte-idéntico POR CONSTRUCCIÓN. `:115` `authorizePrincipal`; `:210-224` `payouts.submit(...)` (donde se agregan `popChallenge`/`popSignature`). `:94-98` `getAddress() ?? ""`. AR/MNR-4 (`:30-40`): **application NO importa infrastructure** — la infra viaja inyectada. |
| `src/application/ports.ts` (141 L) | Contratos a extender | `WalletPort` (agregar `signMessage`); `PayoutSubmit` (`:63-78`, `settlementAttestation?` es el exemplar de campo opcional server-enforced — `:73-77` explica "OPCIONAL a propósito, el enforcement vive en el SERVER, no es fail-open"); `PayoutGateway.submit` (`:87-90`). |
| `src/infrastructure/a2a/gateways.ts` (`A2aPayoutGateway.submit` `:119-146`) | Dónde se arma el body del POST a `submit` | `:123-138` `JSON.stringify({...})`: `settlementAttestation: req.settlementAttestation` (`:137`) — en demo `undefined` ⇒ `JSON.stringify` lo omite ⇒ body byte-idéntico (`:136`). Mismo patrón para `popChallenge`/`popSignature`. |
| `src/composition/container.ts` (`:55-113`) | Composition root — inyección gateada | `:60-68` guard fail-loud EIP3009; `:88-91` `settlement = flag ? {...} : undefined`; `:100-108` `new ConfirmAndSend(wallet, payouts, repo, clock, payoutAuthority, refund, settlement)`. **AQUÍ se inyecta `pop?` gateado por `NEXT_PUBLIC_PAYOUT_POP_ENABLED`.** |
| `src/test-support/test-container.ts` (`:69,83`) + `fakes.ts` | 2º composition root + fakes (auto-blindaje WKH-201) | `test-container.ts:69` `wallet = o.wallet ?? new FakeWallet()`; `:83` `new ConfirmAndSend(...)`. **Cambiar la firma del constructor o de `WalletPort` rompe AMBOS roots + `FakeWallet`** — deben tocarse en la MISMA wave. |
| `app/api/a2a/payout/submit/route.test.ts` (encabezado) | Exemplar del test de route + mock del store | `vi.hoisted(() => ({ claimMock: vi.fn<(txHash)=>Promise<Claim>>(...) }))` + `vi.mock(attestation-store)`; **`verifySettlementAttestation` corre REAL** (HMAC de verdad). `beforeEach` stubea `DIDIT_API_KEY=""`, `VERCEL_ENV=""`, `SETTLE_ATTESTATION_SECRET=""`. `fetchRouter` despacha por URL y separa `agentCalls` para `expect(agentCalls).toHaveLength(0)`. |
| `app/api/payout/validate/route.ts` (24 L) | El otro consumidor de la autoridad (DT-9) | Wrapper delgado; **NO se toca** en esta HU (DT-9). |
| `doc/sdd/016/…/auto-blindaje.md`, `015`, `014-wkh-201`, `013`/`012` | Errores recurrentes → CDs | Ver §9. Patrones ≥2 HUs: contar-leyendo-vs-ejecutando (198/201/202), fail-open mutant (168), `vi.fn` union sin type param (168), 2 composition roots (201). |

### Verificaciones anti-alucinación ejecutadas en este SDD
- `viem` exporta `verifyMessage` **function**, `recoverMessageAddress` **function**, `isAddress`, `getAddress` (AC-7/CD-1). ✔
- `viem/accounts` exporta `privateKeyToAccount` + `generatePrivateKey` **functions** (para firmar en los tests, sin dep nueva). ✔
- `grep -c "siwe\|ethers" package.json` → **0** (baseline AC-7). ✔
- `node:crypto` (`randomBytes`, `createHmac`, `timingSafeEqual`) ya usado en `attestation.ts`/`kyc-auth.ts`. ✔
- `@upstash/redis` `Redis.set(key,val,{nx,ex})` ya usado en `attestation-store.ts`. ✔
- `main @ f289cae` (WKH-168 mergeado), working tree limpio ⇒ sin conflicto. ✔

---

## 4. Decisiones Técnicas (DT-N)

### DT-1 — Arquitectura (RESUELTA POR EL HUMANO, gate HU_APPROVED): opción (a)
Endpoint nuevo `/api/a2a/payout/challenge` (emite el nonce) + verificación inline en `submit`. No se reduce a "solo validate". Rationale en §1.

### DT-2 — Patrón de flag (RESUELTO): **presencia de secreto server-only**
- **Server**: `PAYOUT_POP_SECRET` (presencia = habilitado), **exactamente** el patrón de `SETTLE_ATTESTATION_SECRET`. Leído DENTRO del handler / de `secret()` (CD-14, `vi.stubEnv`). SIN prefijo `NEXT_PUBLIC_` ⇒ **nunca llega al bundle del cliente** (la verificación es 100% server-side — CD-9/CD-17 del repo). Rechazado el boolean `NEXT_PUBLIC_*` para el server: filtraría al cliente y desacoplaría "habilitado" de "tengo el secreto para firmar/verificar el challenge".
- **Cliente**: `NEXT_PUBLIC_PAYOUT_POP_ENABLED=true` (boolean) — el cliente **no puede** ver `PAYOUT_POP_SECRET`, así que necesita su propia señal para decidir si fetchea el challenge y firma. Mismo doble-flag coordinado que WKH-168 (server `SETTLE_ATTESTATION_SECRET` ⟷ cliente `NEXT_PUBLIC_EIP3009_ENABLED`). El container inyecta el `PopSigner` SOLO con este flag on (DT-7).
- **Acoplamiento ops** (documentar): server-ON + cliente-OFF ⇒ `submit` responde 403 (el body no trae `popChallenge`/`popSignature`) ⇒ el payout falla → ops debe encender AMBOS (idéntico a EIP3009). server-OFF + cliente-ON ⇒ `/challenge` responde 501; el `HttpPopSigner` trata 501 como skip (no adjunta campos). El demo (ambos OFF) = byte-idéntico.

### DT-3 — Formato del mensaje firmado (RESUELTO): **`personal_sign` estructurado** (viem `signMessage`/`verifyMessage`), NO EIP-4361 completo
Rationale:
1. El repo YA firma personal_sign en el path demo (`wallet.ts:127-130`, `signMessage({account,message})`) y viem verifica EIP-191 vía `verifyMessage` (además cubre ERC-1271 / smart-contract wallets automáticamente). Cero superficie nueva.
2. EIP-4361 spec-compliant (para que MetaMask renderice el prompt SIWE nativo) exige ABNF estricto (`domain`, `uri`, `version`, `issued-at`, `nonce`≥8 alfanum, etc.). Sin la lib `siwe` (prohibida por CD-1), hand-rollear el ABNF exacto es frágil y agranda la superficie de parseo/validación — contra la lección de auto-blindaje "no construyas maquinaria que no podés verificar". El prompt SIWE nativo es un nice-to-have que no justifica esa presión sobre CD-1.
3. Todos los campos de binding (chainId, exp, nonce, address — AC-6/CD-7) caben en un mensaje estructurado.

**Formato EXACTO del mensaje** (función pura `buildPopMessage`, ÚNICA fuente de verdad — la usan el endpoint `/challenge` para producir `popMessage` Y el guard de `submit` para reconstruirlo ⇒ byte-idéntico por construcción):

```
Chaski Proof-of-Possession
address: <address>
chainId: <chainId>
nonce: <nonce>
expires: <exp>
```

- 5 líneas separadas por `\n`, **SIN newline final**.
- `<address>`: 0x + 40 hex, **lowercased** (normalizado en el `/challenge` al emitir; elimina toda ambigüedad de casing entre firmar y verificar).
- `<chainId>`: decimal (ej. `43113`).
- `<nonce>`: 32 hex sin `0x` (`randomBytes(16).toString("hex")`).
- `<exp>`: epoch **segundos** decimal.
- Template literal canónico: `` `Chaski Proof-of-Possession\naddress: ${p.address}\nchainId: ${p.chainId}\nnonce: ${p.nonce}\nexpires: ${p.exp}` ``.
- **Contrato de firma (CD-nuevo)**: el cliente firma el string `popMessage` que devolvió `/challenge` **verbatim** (NO lo reconstruye); el server reconstruye vía `buildPopMessage(ch)` desde el challenge HMAC-verificado. Ambos lados = misma función ⇒ idénticos.

### DT-4 (NUEVA) — Secreto ausente ⇒ **SKIP puro** (byte-idéntico), sin A2-style 503
A diferencia de WKH-168 (A2: sin secreto en Vercel → 503, porque el settlement es un gate OBLIGATORIO), WKH-206 es **defensa en profundidad opt-in ("construye, NO enciende")**. Cuando `PAYOUT_POP_SECRET` está ausente, el guard hace **skip total en TODO entorno** (Vercel incluido) ⇒ AC-1/CD-2 byte-idéntico. Un 503-cuando-ausente CAMBIARÍA el comportamiento con el mecanismo apagado ⇒ violaría AC-1. El operador enciende PoP seteando el secreto (como `NEXT_PUBLIC_EIP3009_ENABLED`).

### DT-5 (NUEVA) — Challenge **stateless** (HMAC), nonce escrito al store SOLO al consumir (submit)
El `/challenge` emite un **token HMAC** (`pop-challenge.ts`, mirror de `attestation.ts`) que ata `{address, chainId, nonce, exp}` — NO escribe en Upstash. El nonce se **quema** recién en `submit` vía `claimPopNonceOnce(nonce)` = `SET NX EX` (mirror EXACTO de `claimAttestationOnce`, CD-3). Ventajas sobre un nonce stateful (SET en challenge + GETDEL en submit):
1. Mirror byte-a-byte de la arquitectura WKH-168 (`attestation.ts` + `attestation-store.ts`) ⇒ menos superficie nueva, mismo `SET NX EX` que CD-3 pide literal.
2. `/challenge` sin dependencia de Upstash ⇒ no se puede DoS-ear el store desde `/challenge` (solo el consumo escribe). El binding a `address` lo da el **HMAC** (no un valor en el store) ⇒ el nonce no es transferible a otra address (cambiar `address` invalida el HMAC).
3. No requiere `GETDEL` (verbo ausente del exemplar) — `SET NX EX` idéntico.

### DT-6 (NUEVA) — Posición del guard: **guard 7**, entre autoridad WKH-202 (6) y atestación WKH-168 (8)
El bloque PoP se inserta **encima** del bloque `// ── 8. Atestación` (`submit/route.ts:113`), después del `switch` de autoridad (`:93-111`). Así:
- Guards 1-6 (WKH-202) quedan **intactos** (CD-11 heredado) y evaluados ANTES del PoP.
- El bloque WKH-168 (`:113-201`) queda **textualmente byte-idéntico** debajo (no se mueve ni una línea) ⇒ AC-5/CD-5 satisfecho de forma fuerte (verificable con `md5sum`, no `git diff` — auto-blindaje).
- Campos del body que el caller presenta: `popChallenge` (string, el token HMAC) y `popSignature` (string, `0x…` la firma personal_sign). El body se forwarda TAL CUAL (los campos extra viajan al agente pero son inertes — mismo criterio que `kycPayoutAllowed`).
- El burn de PoP ocurre antes de los checks stateless de WKH-168; un request con PoP válido pero atestación inválida quema el nonce PoP y luego 403 (fail-closed; el usuario legítimo re-fetchea un challenge — costo de retry, no hueco de seguridad).

### DT-7 (NUEVA) — Wiring cliente: puerto `PopSigner` inyectado + `WalletPort.signMessage`
Mirror del patrón `settlement?` de WKH-168. `ConfirmAndSend` recibe un **8º param `pop?: PopSigner`**; el container lo inyecta SOLO con `NEXT_PUBLIC_PAYOUT_POP_ENABLED=true`. `undefined` ⇒ demo byte-idéntico POR CONSTRUCCIÓN (el use-case nunca lee una env — CD-14; nunca importa infrastructure — AR/MNR-4). `PopSigner.prove(address)` (impl `HttpPopSigner`) fetchea `/api/a2a/payout/challenge`, obtiene `popMessage`, delega la firma en `WalletPort.signMessage(popMessage)` (método nuevo, genérico, implementado en los 3 wallets + `FakeWallet`), y devuelve `{ challenge, signature }`. `PopSigner` es la única pieza que toca la red de challenge (application queda pura).

### DT-8 (NUEVA) — Tiering de errores (no-oracle, CD-4)
- **403 `payout_pop_unverified`** para TODO fallo stateless/cripto (P1 campos ausentes, P2 HMAC/exp inválidos, P3 address mismatch, P4 chainId mismatch, P5 firma que no recupera) — un solo enum opaco dentro del tier de verificación (no-oracle: no distingue "firma mala" de "expirado" de "address ajena").
- **409 `payout_pop_replayed`** (nonce ya reclamado) y **503 `payout_pop_unavailable`** (nonce-store caído) — **mirror EXACTO de A8/A9** de `claimAttestationOnce` (AC-4 lo pide literal: "replicando el patrón fail-closed A8/A9"). Son señales operativas (idempotencia / infra retry-able), no un oráculo cripto — mismo precedente que WKH-168 (403/409/503).

### DT-9 (NUEVA) — `/api/payout/validate` **NO se toca en esta HU**
El work-item deja explícito que extender `/api/payout/validate` a PoP es "una decisión explícita a documentar en el SDD". **Decisión: NO**. Rationale: (1) `validate` es advisory (devuelve `{authorized, reason}`, sin PII, sin mover plata); (2) tocar una route live cambia su contrato observable (mismo criterio CD-10 que frenó el fix del body-`null` en WKH-202); (3) el módulo `pop-challenge.ts`/`pop-nonce-store.ts` queda disponible para extender `validate` en una HU futura sin retrabajo. Se documenta como **residual R1** (no bloqueante).

---

## 5. Contratos exactos

### 5.1 `src/infrastructure/auth/pop-challenge.ts` (NUEVO — mirror de `attestation.ts`)

```
export interface PopChallenge {
  address: string;   // 0x+40hex, lowercased
  chainId: number;   // entero
  nonce: string;     // 32 hex (sin 0x)
  exp: number;       // epoch SEGUNDOS
}
export const POP_CHALLENGE_TTL_SECONDS = 10 * 60; // ventana challenge→firma→submit

function secret(): string   // process.env.PAYOUT_POP_SECRET, DENTRO de la fn (CD-14), throw si falta
function sign(payloadB64): string   // createHmac("sha256", secret()).update(payloadB64).digest("base64url")

export function issuePopChallenge(p: PopChallenge): string
  // `${b64url(JSON.stringify(p))}.${sign(payloadB64)}`

export function verifyPopChallenge(token: string, nowMs: number): PopChallenge | null
  // devuelve null ante CUALQUIER problema (fail-closed, no-throw). Orden EXACTO de attestation.ts:
  //  1. token string, split(".") en 2 partes no vacías
  //  2. si !process.env.PAYOUT_POP_SECRET → null
  //  3. HMAC PRIMERO: length check → timingSafeEqual
  //  4. parse b64url→JSON en try/catch; isRecord
  //  5. validar CADA campo: isAddress(address); Number.isInteger(chainId);
  //     /^[0-9a-f]{32}$/.test(nonce); Number.isFinite(exp)
  //  6. exp*1000 <= nowMs → null

export function buildPopMessage(p: PopChallenge): string   // ver DT-3 (formato EXACTO)
```

### 5.2 `src/infrastructure/auth/pop-nonce-store.ts` (NUEVO — mirror de `attestation-store.ts`)

```
export type PopNonceClaim =
  | { ok: true }
  | { ok: false; alreadyUsed: true }
  | { ok: false; unavailable: true };

const CLAIM_TTL_SECONDS = 86_400; // > POP_CHALLENGE_TTL_SECONDS (un challenge vigente jamás sobrevive a su flag)

export async function claimPopNonceOnce(nonce: string): Promise<PopNonceClaim>
  // getRedis() memoizado, env DENTRO (CD-14). !redis → {ok:false,unavailable:true} (fail-CLOSED).
  // redis.set(`pop:nonce:${nonce}`, "1", {nx:true, ex:CLAIM_TTL_SECONDS}):
  //   "OK"  → {ok:true}
  //   null  → {ok:false, alreadyUsed:true}
  // catch → {ok:false, unavailable:true}   ← PROHIBIDO {ok:true} (CD-3, no es rate-limit.ts)

export function __resetPopNonceStore(): void   // gemelo de __resetAttestationStore
```

### 5.3 Endpoint `POST /api/a2a/payout/challenge` (NUEVO)

- **Request body**: `{ address: string }` (la wallet que va a probar posesión).
- **Handler** (defensivo, NUNCA 500 crudo):
  1. `POP_SECRET = process.env.PAYOUT_POP_SECRET` (dentro del handler, CD-14). Si `!POP_SECRET` → **501 `{ error: "pop_not_configured" }`** (mecanismo off; el cliente lo trata como skip).
  2. `parsed = await req.json().catch(() => null)`; `body = isRecord(parsed) ? parsed : {}` (auto-blindaje WKH-202 BLQ-BAJO-1: `req.json()` resuelve con `null` para el literal `null` ⇒ el `.catch` no dispara).
  3. `address = typeof body.address === "string" ? body.address : ""`. Si `!isAddress(address)` → **400 `{ error: "pop_invalid_request" }`** (formato de address es info pública ⇒ 400 no es oráculo de KYC).
  4. `nonce = randomBytes(16).toString("hex")`; `exp = Math.floor(Date.now()/1000) + POP_CHALLENGE_TTL_SECONDS`; `chainId = resolveChainId()`; `addr = address.toLowerCase()`.
  5. `challenge = issuePopChallenge({ address: addr, chainId, nonce, exp })`; `message = buildPopMessage({ address: addr, chainId, nonce, exp })`.
  6. **200 `{ popChallenge: challenge, popMessage: message, exp }`**.
- **Sin oráculo**: emitir un challenge para cualquier address no revela nada (las addresses son públicas; el token es inútil sin la private key). No fetchea Didit, no lee estado KYC, no escribe en Upstash (DT-5).
- **Errores**: 501 (no config), 400 (address malformada). Cero 500 (json en try/catch; HMAC/randomBytes no tiran con secreto presente).
- **Residual R2 (no bloqueante)**: `/challenge` no está rate-limiteado; un flood solo quema CPU HMAC (no toca el store). Reusar `rate-limit.ts` = follow-up opcional.

### 5.4 Guard nuevo en `submit/route.ts` (guard 7, DT-6/DT-8)

Insertado entre `:111` (fin `switch` autoridad) y `:113` (inicio bloque WKH-168). Imports nuevos: `verifyPopChallenge`, `buildPopMessage` de `pop-challenge`; `claimPopNonceOnce` de `pop-nonce-store`; `verifyMessage` de `viem`.

```
// ── 7. Proof-of-Possession (WKH-206) ──
const POP_SECRET = process.env.PAYOUT_POP_SECRET;   // CD-14
if (POP_SECRET) {                                    // presencia = ON; ausente = SKIP total (DT-4, AC-1)
  const popChallenge = body.popChallenge;
  const popSignature = body.popSignature;
  // P1 — presencia + tipo
  if (typeof popChallenge !== "string" || !popChallenge.trim() ||
      typeof popSignature !== "string" || !popSignature.trim())
    return 403 payout_pop_unverified;
  // P2 — HMAC + exp + tipos (fail-closed → null)
  const ch = verifyPopChallenge(popChallenge, Date.now());
  if (!ch) return 403 payout_pop_unverified;
  // P3 — el challenge fue emitido para ESTA address (case-insensitive)
  if (ch.address.toLowerCase() !== address.toLowerCase()) return 403 payout_pop_unverified;
  // P4 — chainId binding (AC-6, mirror A7″). Contra la ENV server-side, NUNCA un chainId del body.
  if (ch.chainId !== resolveChainId()) return 403 payout_pop_unverified;
  // P5 — PRUEBA CRIPTOGRÁFICA: recuperar al firmante del mensaje reconstruido (buildPopMessage=SSOT).
  //      Se verifica contra ch.address (ya isAddress-validado en P2); P3 lo ata a body.address.
  let ok = false;
  try { ok = await verifyMessage({ address: ch.address, message: buildPopMessage(ch), signature: popSignature }); }
  catch { ok = false; }   // firma/address malformada → fail-closed
  if (!ok) return 403 payout_pop_unverified;
  // P6 — single-use atómico, fail-CLOSED (mirror A8/A9)
  const claim = await claimPopNonceOnce(ch.nonce);
  if (!claim.ok) {
    if ("alreadyUsed" in claim) return 409 payout_pop_replayed;
    return 503 payout_pop_unavailable;   // Upstash caído → NUNCA forward
  }
}
// (bloque WKH-168 `// ── 8. Atestación` sigue byte-idéntico debajo)
```

Todos los `403` devuelven el MISMO body `{ error: "payout_pop_unverified" }` (CD-4/no-oracle). El agente NUNCA se invoca en ningún path de rechazo (P1-P6).

### 5.5 Wiring cliente (DT-7)

| Cambio | Archivo | Detalle |
|---|---|---|
| Puerto `PopSigner` | `ports.ts` | `interface PopSigner { prove(address: string): Promise<{ challenge: string; signature: string }>; }` |
| `WalletPort.signMessage` | `ports.ts` | `signMessage(message: string): Promise<string>` (genérico) |
| `PayoutSubmit` campos | `ports.ts` | `popChallenge?: string; popSignature?: string;` (opcionales, server-enforced — mismo criterio que `settlementAttestation?`) |
| Impl `signMessage` | `wallet.ts` | `InjectedWallet`/`WalletConnectWallet`: `client.signMessage({account:this.address, message})`. `FallbackWallet`: firma fake demo (`0xdemosig…`). |
| `HttpPopSigner` | `src/infrastructure/auth/http-pop-signer.ts` (NUEVO) | ctor `(wallet: WalletPort)`. `prove(address)`: `fetch("/api/a2a/payout/challenge",{POST,{address}})`; si `!res.ok` (501/400) → throw `pop_challenge_unavailable`; `{popChallenge, popMessage} = await res.json()`; `signature = await wallet.signMessage(popMessage)`; return `{challenge: popChallenge, signature}`. |
| Forward en gateway | `a2a/gateways.ts` | En el `JSON.stringify` de `A2aPayoutGateway.submit`: agregar `popChallenge: req.popChallenge, popSignature: req.popSignature` (demo `undefined` ⇒ omitidos ⇒ byte-idéntico). |
| 8º param `pop?` | `confirm-and-send.ts` | Constructor `pop?: PopSigner`. Antes de `payouts.submit`: `if (this.pop) { const {challenge, signature} = await this.pop.prove(address ?? ""); }` → pasar `popChallenge`/`popSignature` a `submit(...)`. `undefined` ⇒ no adjunta ⇒ byte-idéntico (AC-5). |
| Inyección gateada | `container.ts` | `const pop = process.env.NEXT_PUBLIC_PAYOUT_POP_ENABLED === "true" ? new HttpPopSigner(wallet) : undefined;` → 8º arg de `new ConfirmAndSend(...)`. |
| 2º root + fake | `test-container.ts` + `fakes.ts` | `FakeWallet.signMessage` (fake sig); `FakePopSigner` (o `pop` override en `TestContainerOverrides`); `test-container.ts` pasa el 8º arg. (auto-blindaje WKH-201: AMBOS roots + fakes en la MISMA wave.) |

---

## 6. Waves de implementación

### Wave 0 (SERIAL GATE) — módulo puro + nonce-store (contratos, 100% unit-testable, cero routes)
- **W0.1** `src/infrastructure/auth/pop-challenge.ts` (NUEVO) → exemplar `attestation.ts`. Incluye `PopChallenge`, `issue`/`verify`/`buildPopMessage`/`secret`/`sign`.
- **W0.2** `src/infrastructure/auth/pop-nonce-store.ts` (NUEVO) → exemplar `attestation-store.ts`.
- **Tests**: `pop-challenge.test.ts`, `pop-nonce-store.test.ts`.
- **Gate**: `npm run qa` verde. No toca ningún archivo existente ⇒ typecheck no puede romper nada.

### Wave 1 (server enforcement — depende de W0)
- **W1.1** `app/api/a2a/payout/challenge/route.ts` (NUEVO) → exemplar `submit/route.ts` (parseo defensivo) + `payout/validate/route.ts` (wrapper delgado). §5.3.
- **W1.2** `app/api/a2a/payout/submit/route.ts` (MODIFICAR): insertar guard 7 (§5.4). El bloque WKH-168 queda byte-idéntico.
- **Tests**: `app/api/a2a/payout/challenge/route.test.ts` (NUEVO); EXTENDER `app/api/a2a/payout/submit/route.test.ts` (mock de `pop-nonce-store` con `vi.hoisted`+type param; `pop-challenge` corre REAL; firmas reales con `viem/accounts`).
- **Gate**: `npm run qa` verde.

### Wave 2 (client wiring — depende de W0; integra con W1) — TODO en una wave (auto-blindaje WKH-201)
- **W2.1** `ports.ts`: `PopSigner`, `WalletPort.signMessage`, `PayoutSubmit.popChallenge?/popSignature?`.
- **W2.2** `wallet.ts`: `signMessage` en `InjectedWallet`/`WalletConnectWallet`/`FallbackWallet`.
- **W2.3** `src/infrastructure/auth/http-pop-signer.ts` (NUEVO).
- **W2.4** `a2a/gateways.ts`: forward `popChallenge`/`popSignature`.
- **W2.5** `confirm-and-send.ts`: 8º param `pop?` + orquestación.
- **W2.6** `container.ts` + `test-container.ts` + `fakes.ts`: inyección gateada + `FakeWallet.signMessage` + `FakePopSigner`.
- **Tests**: `http-pop-signer.test.ts` (NUEVO); EXTENDER `confirm-and-send.test.ts` (pop inyectado adjunta campos; `pop` undefined ⇒ byte-idéntico).
- **Gate**: `npm run qa` verde (cambiar `WalletPort`/constructor rompe AMBOS roots + fakes ⇒ tocarlos juntos).

### Wave 3 (integración + matriz de seguridad + no-regresión — depende de W0/W1/W2)
- Matriz completa en `submit/route.test.ts` (§7). Mutantes fail-open (auto-blindaje WKH-168 fix-pack#2). Byte-identidad del bloque WKH-168 vía `md5sum` (NO `git diff` sobre untracked — auto-blindaje).
- **Gate**: `npm run qa` verde; suite completa sin regresiones (los 19+6 tests preexistentes de `submit` intactos).

---

## 7. Test Plan (≥1 por AC + matriz de seguridad)

> **Regla anti-alucinación (auto-blindaje 198/201/202)**: todo número de "tests preexistentes" se verifica con `grep -c "  it(" archivo` / output de vitest ANTES de escribirlo, nunca contando a ojo. El F3 debe re-contar.

| Test | AC / riesgo | Archivo | Wave |
|---|---|---|---|
| `verify` OK round-trip (issue→verify) | AC-2 | `pop-challenge.test.ts` | W0 |
| HMAC forjado / firmado con otro secreto → null | AC-3-cripto | `pop-challenge.test.ts` | W0 |
| exp vencido → null; tipos deformes (address/chainId/nonce) → null | AC-4/AC-6 | `pop-challenge.test.ts` | W0 |
| `buildPopMessage` contiene address+chainId+nonce+expires, formato exacto, sin `\n` final | AC-6/DT-3 | `pop-challenge.test.ts` | W0 |
| `claimPopNonceOnce` primer uso `{ok:true}`; 2º `{alreadyUsed}`; sin redis / throw `{unavailable}` (fail-closed) | AC-4 | `pop-nonce-store.test.ts` | W0 |
| `/challenge`: secreto off → 501 | AC-1 | `challenge/route.test.ts` | W1 |
| `/challenge`: address válida → 200 `{popChallenge, popMessage, exp}`, HMAC verificable | AC-2 | `challenge/route.test.ts` | W1 |
| `/challenge`: address malformada / body `null` → 400, nunca 500 | robustez | `challenge/route.test.ts` | W1 |
| `submit`: secreto off → **byte-idéntico**; `claimPopNonceOnce` NUNCA llamado; sin fetch challenge | **AC-1** | `submit/route.test.ts` | W3 |
| `submit`: secreto off en **Vercel** (`VERCEL_ENV=preview`) → SKIP igual (NO 503, DT-4) | AC-1/DT-4 | `submit/route.test.ts` | W3 |
| `submit`: happy — challenge válido + firma real (`privateKeyToAccount`) que recupera a `address` → forward | AC-3 | `submit/route.test.ts` | W3 |
| `submit`: firma de OTRA key (recupera a address distinta) → 403 opaco, agente NUNCA | **AC-3 / suplantación** | `submit/route.test.ts` | W3 |
| `submit`: `popChallenge`/`popSignature` ausentes o no-string → 403, agente NUNCA | AC-3 | `submit/route.test.ts` | W3 |
| `submit`: challenge de address distinta a `body.address` (P3) → 403 | AC-3 | `submit/route.test.ts` | W3 |
| `submit`: replay (2ª presentación, `claimMock` `{alreadyUsed}`) → 409, agente NUNCA | **AC-4 / replay** | `submit/route.test.ts` | W3 |
| `submit`: challenge expirado → 403 (mismo enum que HMAC malo, no-oracle) | AC-4 | `submit/route.test.ts` | W3 |
| `submit`: nonce-store caído (`{unavailable}`) → 503 fail-closed, agente NUNCA | **AC-4 / fail-open store** | `submit/route.test.ts` | W3 |
| `submit`: challenge de OTRA cadena (`ch.chainId ≠ resolveChainId`) → 403 | **AC-6 / replay cross-entorno** | `submit/route.test.ts` | W3 |
| `submit`: **mutante fail-open chainId** — body jura `chainId:[43113,"43114",null]` + challenge de otra cadena ⇒ 403 igual (mata el chainId-del-caller) | AC-6 / auto-blindaje 168#2 | `submit/route.test.ts` | W3 |
| `submit`: no-oracle — P2/P3/P4/P5 devuelven el MISMO status+body (403 `payout_pop_unverified`) | oráculo de estado / CD-4 | `submit/route.test.ts` | W3 |
| `submit`: **no-regresión WKH-202** — ownership mismatch → 403 ANTES del guard PoP (guards 4-6 intactos) | **AC-5** | `submit/route.test.ts` | W3 |
| `submit`: **no-regresión WKH-168** — los tests de atestación siguen verdes; bloque byte-idéntico (`md5sum`) | **AC-5** | `submit/route.test.ts` | W3 |
| `submit`: **mutante — guard PoP DESPUÉS del claim de atestación** (o burn en path de rechazo) → `claimPopNonceOnce` NO llamado en 403 stateless | AC-5 / fail-open | `submit/route.test.ts` | W3 |
| `package.json` sin `siwe`/`ethers` (`grep -c → 0`); módulos importan solo `viem`/`node:crypto`/`@upstash/redis` | **AC-7** | `pop-challenge.test.ts` / manual | W3 |
| `HttpPopSigner.prove`: fetch challenge + `wallet.signMessage` → `{challenge, signature}`; 501 → throw | wiring | `http-pop-signer.test.ts` | W2 |
| `ConfirmAndSend`: `pop` inyectado adjunta `popChallenge/popSignature`; `pop` undefined ⇒ byte-idéntico | AC-1/AC-5 | `confirm-and-send.test.ts` | W2 |

**Mocking (exemplar `submit/route.test.ts` WKH-168)**: `pop-nonce-store` mockeado con `vi.hoisted(() => ({ popClaimMock: vi.fn<(nonce:string)=>Promise<PopNonceClaim>>(async () => ({ok:true})) }))` + `vi.mock` (**type param OBLIGATORIO** — auto-blindaje 168: sin él tsc infiere `{ok:boolean}` y las ramas `alreadyUsed`/`unavailable` no compilan; el gate es `npm run qa`). `pop-challenge` corre **REAL** (HMAC de verdad). Firmas reales con `privateKeyToAccount(generatePrivateKey())` de `viem/accounts`. `beforeEach` agrega `vi.stubEnv("PAYOUT_POP_SECRET", "")` (los tests que quieren PoP re-stubean adentro). Mocks de `fetch` que responden N veces → `mockImplementation`, NUNCA `mockResolvedValue` sobre un `Response` (auto-blindaje 168 W2). **Verificar que cada test llega a la rama que dice probar** (no solo que el status coincide — auto-blindaje 168 W5/6).

---

## 8. Constraint Directives (CD-N)

### Heredadas del work-item (CD-1..CD-7) — vigentes
- **CD-1**: PROHIBIDO `siwe`/`ethers`/otra lib de firma. Solo `viem` (`verifyMessage` / `recoverMessageAddress`) + `node:crypto`. Verificado: `grep -c "siwe\|ethers" package.json → 0`.
- **CD-2**: OBLIGATORIO byte-idéntico cuando `PAYOUT_POP_SECRET` ausente (guard skip total, DT-4). Verificar con `md5sum` del bloque WKH-168 + los 19+6 tests preexistentes verdes.
- **CD-3**: OBLIGATORIO nonce single-use, claim ATÓMICO `SET NX EX` (mirror `claimAttestationOnce`), fail-CLOSED si el store cae. PROHIBIDO `{ok:true}` en el `catch`/`!redis` (no es `rate-limit.ts`).
- **CD-4**: PROHIBIDO oráculo. Todo fallo stateless/cripto → MISMO 403 `payout_pop_unverified`. 409/503 solo para replay/store-down (mirror A8/A9).
- **CD-5**: PROHIBIDO debilitar/saltear/condicionar los guards de WKH-202 (autoridad) y WKH-168 (atestación A1-A9). El guard 7 se AGREGA; el bloque WKH-168 queda byte-idéntico.
- **CD-6**: PROHIBIDO loguear/ecoar/incluir en errores la firma cruda, el nonce, o el `address`. Los errores llevan solo enums.
- **CD-7**: OBLIGATORIO atar `chainId` (`resolveChainId()`) + expiración en el mensaje firmado (mata replay cross-entorno).

### Nuevas de este SDD
- **CD-8**: `PAYOUT_POP_SECRET` (server) SIN `NEXT_PUBLIC_`; leído DENTRO del handler/`secret()` (CD-14-style, `vi.stubEnv`). PROHIBIDO importar `pop-challenge`/`pop-nonce-store`/`http-pop-signer` server-modules desde código que llegue al bundle del cliente.
- **CD-9**: El `chainId` comparado en P4 sale de `resolveChainId()` (ENV server-side), NUNCA del body. **Test obligatorio del mutante body-sourced** (auto-blindaje 168#2): mandar `chainId` homónimo hostil en el body y exigir 403.
- **CD-10**: `buildPopMessage` es la ÚNICA fuente del formato del mensaje. El cliente firma `popMessage` verbatim; el server reconstruye vía `buildPopMessage(ch)`. PROHIBIDO reconstruir el string a mano en dos lugares.
- **CD-11**: `verifyPopChallenge` devuelve `null` ante CUALQUIER problema (no-throw), HMAC PRIMERO con length-check antes de `timingSafeEqual`, parse en try/catch, validar tipo de CADA campo. Mirror byte-a-byte de `verifySettlementAttestation`.
- **CD-12**: PROHIBIDO tocar `app/api/payout/validate/route.ts`, `authority.ts`, `attestation.ts`, `attestation-store.ts`, el bloque WKH-168 de `submit/route.ts`, Didit, `wasiai-a2a`/`wasiai-v2`/demo. (DT-9 + Scope OUT.)
- **CD-13**: `application` (`confirm-and-send.ts`) NUNCA importa `infrastructure` ni lee `process.env`. El `PopSigner` viaja inyectado (mirror `settlement?`). `pop?` undefined = demo byte-idéntico.
- **CD-14** (grep-safe, auto-blindaje 168 W1): los comentarios que citen un antipatrón (ej. `ethers`, `siwe`, `fail-open`) NO deben usar el token literal si un CD se verifica con `grep→0`. Parafrasear.
- **CD-15** (2 composition roots, auto-blindaje 201): cambiar `WalletPort`/el constructor de `ConfirmAndSend` obliga a tocar `container.ts` **Y** `test-container.ts` **Y** `fakes.ts` (`FakeWallet`) en la MISMA wave.
- **CD-16** (auto-blindaje 168): `vi.fn` cuyo retorno sea unión discriminada (`PopNonceClaim`) lleva type param explícito. Gate de wave = `npm run qa`, NUNCA `npm run build`.

---

## 9. Auto-Blindaje aplicado (patrones recurrentes ≥2 HUs → CDs)

| Patrón recurrente | HUs | Prevención en este SDD |
|---|---|---|
| Contar artefactos leyendo vs. ejecutando ("N tests" mal) | 198, 201, 202 | §7 regla: `grep -c "  it("` / vitest antes de escribir el número; F3 re-cuenta. |
| Test pasa con status correcto **por el guard equivocado** (falso verde) | 168 (W5/6) | §7: "verificar que el test llega a la rama que dice probar"; asserts `not.toHaveBeenCalled()`. |
| Escribir el mutante ausente pero NO el fail-open | 168 (fix-pack#2, A7″ body-sourced) | CD-9 + tests de mutante fail-open para chainId (P4), address (P3), burn-position (P6). |
| `vi.fn` de unión discriminada sin type param → tsc rojo que `build` oculta | 168, 196 | CD-16; `PopNonceClaim` tipado en el mock. |
| `mockResolvedValue` de un `Response` reusado → falso verde | 168 (W2) | §7: `mockImplementation` para mocks de fetch multi-llamada. |
| Cambiar interfaz/constructor rompe AMBOS composition roots | 201 | CD-15 (W2 toca container + test-container + fakes juntos). |
| `git diff` sobre untracked/unstaged da vacío por construcción | 168, 202 | §6 W3: byte-identidad del bloque WKH-168 vía `md5sum -c`, no `git diff`. |
| Campo firmado sin verificar = binding falso | 168 (fix-pack MNR-1) | §5.4: cada campo de `PopChallenge` (address/chainId/nonce/exp) se verifica (P3/P4/P5/P2-exp); ninguno viaja sin check. |

---

## 10. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|
| Guard PoP mal insertado rompe/saltea WKH-202/168 | B | A | DT-6 (guard 7 encima del bloque WKH-168 intacto); CD-5; tests de no-regresión + `md5sum` (§7/W3). |
| Fail-open del nonce-store | B | A | CD-3 fail-CLOSED (mirror `attestation-store`); test store-down → 503. |
| Replay cross-entorno (reuso de `PAYOUT_POP_SECRET` entre Fuji/mainnet) | M | A | CD-7/CD-9: chainId en el mensaje firmado + P4 contra ENV; test + mutante body-sourced. |
| Mismatch de casing address entre firmar y verificar | M | M | DT-3: address lowercased al emitir; `buildPopMessage` SSOT; P3 case-insensitive. |
| Byte-identidad rota cuando el mecanismo está off | B | A | DT-4 skip total; test byte-idéntico (Vercel incluido); `md5sum`. |
| Doble flag desincronizado (server on / cliente off) | M | M | DT-2: documentado como acoplamiento ops (idéntico a EIP3009); `.env.example` a documentar. |
| Firma smart-contract-wallet (ERC-1271) | B | B | `viem.verifyMessage` cubre ERC-1271 automáticamente (async). |

---

## 11. Missing Inputs / Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|---|---|---|---|
| (ninguno) | — | DT-1 resuelto por humano; DT-2/DT-3 y DT-4..DT-9 resueltos en este SDD. | — |
| **R1** (residual) | DT-9 | `/api/payout/validate` NO se protege con PoP en esta HU (route live, advisory). Follow-up. | No |
| **R2** (residual) | §5.3 | `/challenge` sin rate-limit (solo quema CPU HMAC, no toca el store). Follow-up opcional. | No |
| **R3** (residual, heredado) | — | Reconciliación server-side de una remesa varada = WKH-207. | No |

---

## 12. Readiness Check (Architect — antes de SPEC_APPROVED)

```
[x] Cada AC (AC-1..AC-7) tiene ≥1 archivo + ≥1 test asociado (§5, §7)
[x] Cada archivo nuevo tiene exemplar VERIFICADO con Read/Glob:
      pop-challenge.ts → attestation.ts ✔ | pop-nonce-store.ts → attestation-store.ts ✔
      challenge/route.ts → submit/route.ts + payout/validate/route.ts ✔
      http-pop-signer.ts → gateways.ts (patrón fetch same-origin) ✔
[x] Cero [NEEDS CLARIFICATION] pendientes (DT-1 humano; DT-2..DT-9 cerradas)
[x] Constraint Directives: 7 heredadas + 9 nuevas, con ≥3 PROHIBIDO explícitos
[x] Context Map: 13 archivos leídos + 6 verificaciones anti-alucinación ejecutadas
[x] Scope IN/OUT explícitos y no ambiguos (§2)
[x] Sin cambios de BD (persistencia = Upstash efímero, mirror attestation-store)
[x] Happy path completo (§5.3/§5.4/§5.5) + flujo de error (403/409/503 opacos, fail-closed)
[x] APIs externas verificadas existentes: viem verifyMessage/recoverMessageAddress/isAddress,
    viem/accounts privateKeyToAccount/generatePrivateKey, @upstash/redis SET NX EX, node:crypto
[x] Coordinación WKH-168 verificada: main @ f289cae, tree limpio, sin conflicto
```

**Veredicto: READINESS VERDE.** Sin blockers. Listo para presentar al humano en el gate `SPEC_APPROVED`.

---

*SDD generado por NexusAgil F2 — FULL. Architect: agente nexus-architect.*
