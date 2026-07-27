# Receta del circuito completo del escrow en Solana devnet (deposit gasless, release, refund)

> **Qué es esto**: la secuencia EXACTA que se ejecutó y se verificó on-chain el **2026-07-27** en devnet.
> No es un plan: cada tx de abajo existe en la cadena y cada valor está citado contra el código, el IDL
> o el RPC. Sirve para repetir el circuito sin adivinar.
>
> **Cero plata real**: todo devnet, con un mint USDC de prueba propio.
>
> **Secretos**: acá NO hay ningún valor secreto (este archivo está versionado en git). Solo nombres de
> variables y de dónde sacarlas. Los valores viven en `m5-keys/` (gitignored) y en los paneles de
> Railway/Vercel.

Documentos hermanos:
- `RUNBOOK-M5.md`: los pasos founder-gated de setup (deploy, envs, flags, migraciones, smoke).
- `runbook-skeleton.md`: snapshot del estado de M5 al 2026-07-22.

---

## 0. Autenticación del facilitator (esto es lo primero que hay que saber)

Los endpoints del facilitator se autentican con **`Authorization: Bearer <FACILITATOR_API_KEY>`**.

```
Authorization: Bearer <FACILITATOR_API_KEY>
```

**`X-API-Key` NO funciona: devuelve 401.** El middleware lee exclusivamente el header `authorization` y
exige el prefijo literal `Bearer `:

- `../wasiai-facilitator/src/middleware/auth.ts:102-106`: `request.headers['authorization']`, y si no
  empieza con `'Bearer '` responde `unauthorized`. La comparación contra las keys configuradas es
  timing-safe (`auth.ts:110-119`).
- Cliente de referencia del propio Chaski: `src/infrastructure/settlement/facilitator-client.ts:112`
  y `:217` mandan `authorization: \`Bearer ${KEY}\``.

**De dónde sacar la key** (NUNCA la copies a un archivo versionado):

```bash
# proyecto de Chaski en Vercel, entorno PREVIEW
vercel env pull .env.preview.local --environment=preview
# y leer FACILITATOR_API_KEY de ahí
```

El proyecto ya está linkeado (`.vercel/project.json`). Si lo que tenés en la mano arranca con `<` y
termina con `>`, es el placeholder de la doc, no una key: eso es exactamente lo que hizo fallar el
primer intento del 2026-07-27.

El facilitator acepta `FACILITATOR_API_KEY` o cualquier entrada de `FACILITATOR_API_KEYS`
(`../wasiai-facilitator/src/infra/env.ts:74-81`), y es **obligatoria** fuera de `NODE_ENV=test`
(`env.ts:351-356`).

---

## 1. Prerrequisitos (si algo de esto falta, el endpoint devuelve 404, no 500)

Las dos rutas Solana son **opt-in-off**: si el flag está apagado o la keypair no parsea, la ruta
**no se registra** y el POST da 404 (no un error de negocio).

| Ruta | Se registra solo si | Cita |
|------|--------------------|------|
| `POST /solana/sponsor` | `SOLANA_FEE_PAYER_SPONSOR_ENABLED=true` **y** `SOLANA_FEE_PAYER_PRIVATE_KEY` parseable | `../wasiai-facilitator/src/app.ts:405-407` |
| `POST /solana/escrow/release` | `SOLANA_ESCROW_RELEASE_ENABLED=true` **y** `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` parseable | `../wasiai-facilitator/src/app.ts:410-412` + `src/infra/solana-release-authority.ts:120-130` |

El refund **no pasa por el facilitator**: se firma local contra el RPC (ver paso 3).

---

## 2. Direcciones y program ids verificados (devnet, 2026-07-27)

Todo esto es público (pubkeys base58), se puede versionar.

| Rol | Pubkey | Cómo lo verifiqué |
|-----|--------|-------------------|
| Escrow program (Anchor, deployado) | `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` | `src/infrastructure/solana/escrow-idl.ts:9` (`address`) + `getAccountInfo` devnet: `executable=true`, owner `BPFLoaderUpgradeab1e…` |
| SPL Token program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | `escrow-idl.ts:243` + `../wasiai-facilitator/src/chains/solana-adapter.ts:45` + es el `owner` real del mint de prueba |
| Associated Token program | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | `escrow-idl.ts:247` |
| Sender (firma deposit y refund) | `8tJVcM2JehYkyPLHUZ3rxNvhfADaQdHx7xaJw6kS6ux8` | `EscrowState.sender` decodificado on-chain |
| Fee-payer del facilitator (gasless) y mint-authority del USDC de prueba | `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH` | fee-payer de la tx del deposit + `mintAuthority` del mint |
| Release authority | `9rphjeRUekSbVpDZhzN9roQQmn6yndodRVfiBvyEAGAV` | `EscrowState.authority` decodificado on-chain |
| Beneficiario (destino del release) | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` | `EscrowState.beneficiary` decodificado on-chain |
| Operador del gateway | `HUzz9CXtiz92VJBoqDkSZ5mXHbzj6rqGxGQwg5k7rPy3` | `m5-keys/gateway-operator.json` (pubkey), balance devnet > 0 |
| Mint USDC de PRUEBA (6 decimales) | `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` | `getAccountInfo` devnet: `decimals=6`, `mintAuthority=4wPhH…`, owner = SPL Token |
| RPC | `https://api.devnet.solana.com` | |

⚠️ **El mint de arriba NO es el USDC devnet de Circle**, es un mint de prueba nuestro (nosotros tenemos
su mint-authority, por eso podemos acuñar para test). No mezclar los dos: el circuito de esta receta
corre 100% sobre `8yRX3…`.

---

## 3. Paso 1: depósito gasless (el usuario firma, el facilitator paga el gas)

**Endpoint**: `POST {FACILITATOR_URL}/solana/sponsor`
**Script**: `m5-keys/deposit-direct.ts` (gitignored) via `npx tsx`.

Envs que consume el script (`m5-keys/deposit-direct.ts:12-22`):

| Env | Qué es | De dónde |
|-----|--------|----------|
| `FACILITATOR_URL` | base URL del facilitator en Railway | panel de Railway |
| `FACILITATOR_API_KEY` | la key del Bearer | Vercel de Chaski, entorno **preview** (ver §0) |
| `SPONSOR_POP_SECRET` | secreto del PoP, igual a `SOLANA_SPONSOR_POP_SECRET` del facilitator | `m5-keys/M5-ENV-CHECKLIST.md` |
| `USDC_MINT` | mint de prueba | tabla §2 |
| `BENEFICIARY` | destino del release | tabla §2 |
| `AUTHORITY` | release authority | tabla §2 |
| `FEE_PAYER_PUBKEY` | pubkey del fee-payer del facilitator | tabla §2 |
| `AMOUNT_USD` | monto (se convierte a minor units de 6 decimales) | |
| `REMITTANCE_ID` | id de la remesa. **GUARDALO** (ver §6) | lo elegís vos |

Opcionales: `RPC_URL` (default devnet), `SENDER_JSON` (default `m5-keys/sender.json`), `PROGRAM_ID`
(default `escrowIdl.address`), `SIM=1` (simula sin broadcastear), `BROADCAST=1` (broadcastea local con
el fee-payer, sin pasar por el facilitator).

**Body que arma el script** (schema real: `../wasiai-facilitator/src/routes/solana-sponsor.ts:55-60`):

```json
{ "partialSignedTx": "<base64>", "reference": "<pubkey>", "sender": "<pubkey>", "popProof": "<hex>" }
```

- `partialSignedTx`: la tx con la ix `deposit` del escrow, `feePayer` = fee-payer del facilitator,
  firmada SOLO por el sender (`partialSign`), serializada base64 con `requireAllSignatures:false`.
- `popProof` = `HMAC_SHA256(SPONSOR_POP_SECRET, senderPubkeyBase58)` en **hex**
  (`../wasiai-facilitator/src/methods/solana-sponsor/pop.ts:22-24`). Fail-closed: si el secreto no está
  seteado en el facilitator, **rechaza todo** (`pop.ts:36`).
- El script también manda `remittanceId`; el schema del sponsor no lo exige (lo ignora).

**Resultado real (2026-07-27, verificado on-chain)**:

| Qué | Valor |
|-----|-------|
| tx | `22A61CyncHSGGHHDujNVJUvrgx8wxETSaGzPFdHrE9WMxatsxr4vNTg6JFesBQdBdbycTj6iF3gX2eoRY65JcFnN` |
| explorer | https://explorer.solana.com/tx/22A61CyncHSGGHHDujNVJUvrgx8wxETSaGzPFdHrE9WMxatsxr4vNTg6JFesBQdBdbycTj6iF3gX2eoRY65JcFnN?cluster=devnet |
| escrowState PDA | `DHc1DYrSm2QeWe6txAs5NnDSzKYeXcCC1WUwviHk11oj` (owner = DR5G, 154 bytes) |
| estado | `Deposited`, `amount = 2000000` (2 USDC) |
| fee payer de la tx | `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH` (el usuario NO pagó gas) |

Que el `feePayer` de la tx sea el del facilitator y no el sender **es** la prueba del gasless.

---

## 4. Paso 2: release (mueve el USDC del vault al beneficiario)

**Endpoint**: `POST {FACILITATOR_URL}/solana/escrow/release`
**Header**: `Authorization: Bearer <FACILITATOR_API_KEY>`
**Body** (schema real: `../wasiai-facilitator/src/routes/solana-escrow.ts:70-74`):

```json
{ "remittanceId": "<el mismo del deposit>", "sender": "<pubkey del sender>", "attestation": "<hex>" }
```

### El `attestation`

`HMAC-SHA256` en **hex** sobre un encoding **inyectivo**, con clave
`SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET` (la lee de `process.env` directo, no de `env.ts`:
`solana-escrow.ts:174`):

```
mensaje = `${remittanceId.length}:${remittanceId}${sender}`
attestation = hmac_sha256(SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET, mensaje).hex()
```

**Fuente de verdad única**: `encodeAttestationMessage` en
`../wasiai-facilitator/src/routes/solana-escrow.ts:86-88`, usada tanto por
`computeReleaseAttestation` (`:97-105`) como por la verificación (`:108-121`). Cualquier cliente DEBE
construir el mensaje con esa función, no a mano.

**Por qué el largo va prefijado** (y no un simple `remittanceId:sender`): el encoding naive no es
inyectivo. `("a:b","c")` y `("a","b:c")` producen el mismo string `a:b:c`, así que un mismo HMAC valdría
para dos pares distintos de (remesa, sender) y una atestación podría replayearse cruzando escrows. Con
el largo adelante la frontera entre los dos campos es inequívoca: se lee `len`, luego exactamente `len`
caracteres de `remittanceId`, y el resto es `sender`. Está documentado en `solana-escrow.ts:76-85`.

Fail-closed: secreto sin setear, HMAC malo, o cualquier campo vacío, todo rechaza
(`solana-escrow.ts:114-115`). La comparación es timing-safe (`:120`).

**Resultado real (2026-07-27, verificado on-chain)**:

| Qué | Valor |
|-----|-------|
| respuesta | HTTP 200 con `{ signature: … }` |
| signature | `2opxzWsKCBCTXugexSPTBFnvvjYmunH9Z6KS1SCRToR6g3RaBZ5tFjqEqc6Eq2WHf4eabFGiEeHKs5tKY21iRs9a` |
| explorer | https://explorer.solana.com/tx/2opxzWsKCBCTXugexSPTBFnvvjYmunH9Z6KS1SCRToR6g3RaBZ5tFjqEqc6Eq2WHf4eabFGiEeHKs5tKY21iRs9a?cluster=devnet |
| escrow `DHc1…` | `Deposited` a `Released` |
| beneficiario | 10 a **12 USDC** (ATA `BQC6fXinyR4KnESJso1oY8nnbQjXjbFAJb221V7UkiVe`) |
| vault del escrow | 0 USDC (ATA `268ZqoPjHwXckm8Y7fe5WT3C6riomM3sjyiyJRPBKgRK`) |
| fee payer de la tx | `9rphjeRUekSbVpDZhzN9roQQmn6yndodRVfiBvyEAGAV` (la release authority) |

Alternativa sin facilitator: `m5-keys/release-direct.ts` firma el `release` con la release-authority
local (sirve para probar la pata on-chain cuando el flag del facilitator está OFF).

---

## 5. Paso 3: refund (el camino trustless)

Es la mitad que hace que el escrow sea **no-custodial de verdad**: el usuario recupera su plata **solo
con su firma**, sin la release authority, sin el facilitator y sin nosotros.

- **Único firmante**: el `sender` (`escrow-idl.ts:172-177`: `sender` es `signer: true` y tiene
  `relations: ["escrow_state"]`, o sea el programa exige que sea el sender guardado en la PDA).
  La instrucción **no tiene** cuenta `authority`.
- **Único argumento**: `remittance_id`, `[u8; 16]` (`escrow-idl.ts:250-255`), derivado como
  `sha256(utf8(remittanceId)).slice(0, 16)` (misma derivación en los tres lados:
  `src/infrastructure/solana-wallet.ts:61`, `scripts/smoke-solana-e2e.ts:102-104`, y los scripts de
  `m5-keys/`).
- **Cuentas**: `sender`, `mint`, `escrow_state` (PDA `["escrow", sender, remittance_id]`), `vault`
  (ATA del PDA), `sender_ata`, `token_program`, `associated_token_program`.
- **Guard del deadline**: antes del deadline el programa **rechaza** con
  `DeadlineNotReached` (código `6003`, `escrow-idl.ts:369`); después, permite.

**Dónde vive el refund en el producto**: `SolanaWallet.refundEscrow()` en
`src/infrastructure/solana-wallet.ts:160-226` (`feePayer = sender`, firma y broadcastea el sender,
`solana-wallet.ts:217-224`). Antes de firmar lee el `EscrowState` on-chain (fuente
autoritativa) y aborta client-side con `escrow_not_found` / `escrow_not_deposited` /
`refund_before_deadline` para no mandar una tx que revertiría; el guard real sigue siendo el del
programa.

Script que ejercita las dos direcciones contra la cadena (deposita con deadline de 45s, intenta refund
antes, espera, refund después): `m5-keys/_refund-test.ts`.

**Resultado real (2026-07-27, verificado on-chain)**:

| Qué | Valor |
|-----|-------|
| refund antes del deadline | rechazado por el programa (correcto) |
| refund después del deadline | tx `4GDwrHgsu2kcJub8A2r8Nh5oRU5uA6DYqXgGoFKG1H9Nw9oYyPC5ooYWR9AAusLjhG1u4tCp5fSWo5DSgkkhyikk` |
| explorer | https://explorer.solana.com/tx/4GDwrHgsu2kcJub8A2r8Nh5oRU5uA6DYqXgGoFKG1H9Nw9oYyPC5ooYWR9AAusLjhG1u4tCp5fSWo5DSgkkhyikk?cluster=devnet |
| fee payer de la tx | `8tJVcM2JehYkyPLHUZ3rxNvhfADaQdHx7xaJw6kS6ux8` (el sender, nadie más firmó) |
| plata | vuelve entera al `sender_ata` (el depósito y el refund se cancelan) |

**Por qué importan las dos mitades**:
1. Sin el refund, el depósito sería custodia: la plata solo saldría si la release authority (nosotros)
   firma. El refund es lo que hace que el usuario no dependa de nosotros.
2. Sin el guard del deadline, el depósito no significaría nada: el sender podría retirar en cualquier
   momento y el beneficiario no tendría ninguna garantía. El deadline es lo que le da peso al depósito.

Probar solo una de las dos direcciones no prueba nada: hay que ejercitar el rechazo Y la aceptación.

---

## 6. ⚠️⚠️ ADVERTENCIA: GUARDÁ EL `remittanceId` ANTES DE FIRMAR EL DEPÓSITO

> **El `remittanceId` NO se puede recuperar desde la cadena.** En la seed de la PDA vive solo su hash
> truncado: `sha256(utf8(remittanceId))[:16]` (`escrow-idl.ts:186-190`), que es irreversible. El
> `refund` y el `release` lo exigen **como argumento en claro**.
>
> **Si perdés el `remittanceId`, los fondos de ese escrow quedan trabados para siempre**: ni el usuario
> ni nosotros podemos firmar el refund ni el release.

**Ya hay un caso real** (devnet, verificado hoy con `getAccountInfo` + decode del `EscrowState`):

| escrowState PDA | `BmHDdjKLCJXcdzd8CqbHaeRWY9utbviZduXhbnH5Jm9F` |
|---|---|
| estado | `Deposited` |
| monto | `10000000` = **10 USDC** (vault ATA `DiDy1gDf4Wvy41rWB3kT3pSyrZBrAWPmcrWMo6bzTexH`, sigue con los 10) |
| deadline | `1784756926` = 2026-07-22T21:48:46Z (**vencido**) |
| `remittanceId` | **perdido** |
| consecuencia | nadie puede sacar esos 10 USDC, ni el sender ni la release authority |

En devnet es plata de juguete. **En producción esto sería grave**: el escrow deja de ser no-custodial en
la práctica, porque el camino trustless (refund) queda inaccesible por pérdida de un dato off-chain.

**Regla operativa**: persistí el `remittanceId` (y su par `quoteId`) ANTES de mandar a firmar, en un
storage durable, y logueá el par (`remittanceId`, `escrowState PDA`) junto a la signature del depósito.

---

## 7. Cómo verificar el estado de un escrow a mano

`EscrowState` (layout de `escrow-idl.ts:373-388`, 154 bytes con el discriminador de 8):

```
offset  8 : sender       pubkey (32)
offset 40 : beneficiary  pubkey (32)
offset 72 : authority    pubkey (32)
offset 104: mint         pubkey (32)
offset 136: amount       u64 LE  (8)
offset 144: deadline     i64 LE  (8, unix seconds)
offset 152: status       u8  (0=Deposited, 1=Released, 2=Refunded)
offset 153: bump         u8
```

Con `@coral-xyz/anchor` conviene decodificar con
`new anchor.BorshAccountsCoder(escrowIdl).decode("EscrowState", info.data)` (así lo hace el checkpoint 6
del smoke, `scripts/smoke-solana-e2e.ts:279-296`).

El balance del vault es el del ATA del PDA:
`getAssociatedTokenAddressSync(mint, escrowStatePda, true)`.

---

## 8. Gotchas encontrados el 2026-07-27

1. **El RPC público de devnet poda historial.** `getFirstAvailableBlock` devolvía `478470331` con el
   slot actual en `479366681`: las tx del 2026-07-22 ya **no** se pueden consultar por signature ahí
   (dan "not found" sin ser falsas). Para evidencia histórica hay que guardar el link del explorer y,
   mejor, el estado de la PDA (las cuentas no se podan).
2. **`X-API-Key` da 401.** Ver §0. Es `Authorization: Bearer`.
3. **404 en `/solana/sponsor` o `/solana/escrow/release` no es un bug de ruta**: es el opt-in-off (§1).
4. **`SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET` (facilitator) y `DEPOSIT_ATTESTATION_SECRET` (Chaski)
   hoy se setean con el MISMO valor** pero son dos atestaciones **distintas**: la del facilitator es un
   HMAC hex crudo sobre el mensaje inyectivo (§4); la de Chaski es un token
   `b64url(payload).b64url(hmac)` que ata `depositAddress`/`beneficiary` a la remesa
   (`src/infrastructure/settlement/deposit-attestation.ts:54-56, 117-119`). Compartir un secreto entre
   dos dominios contradice la separación que el propio código pide
   (`deposit-attestation.ts:46-47`). No lo cambié (es cambio de código, no de doc): queda anotado como
   deuda a resolver con dos secretos separados.
5. **Hoy nadie calcula el release attestation del lado de Chaski**: no existe un mirror de
   `encodeAttestationMessage` en este repo (grep sin resultados). El release del 2026-07-27 se armó a
   mano con el script. Si se automatiza, el mirror debe copiar la función, no reimplementarla.
