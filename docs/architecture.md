# Arquitectura

Detalle de capas y flujo. El panorama general y el estado del proyecto están en el README
([español](../README.es.md) / [inglés](../README.md)), que es también donde vive el conteo de tests:
acá no se repite para que no puedan quedar dos números distintos en dos documentos.

## Una sola máquina virtual

Chaski corre sobre Solana. No hay interruptor de VM, no hay dispatcher que elija entre dos, y no hay
un segundo adaptador de wallet apagado esperando una env var. `createContainer()` construye siempre
el mismo: `const wallet = createSolanaWallet()` (`src/composition/container.ts:100`), sin ternario,
porque no hay nada entre lo cual elegir.

Este repo SÍ tuvo un camino EVM. Se podó, y quedaron tres cosas en su lugar:

1. **Un guard fail loud en runtime.** `assertNoEvmResidue()` es la primera línea de
   `createContainer()` (`src/composition/container.ts:81`) y aborta el arranque si encuentra
   configuración de aquel camino. Nombra seis variables, una por una, como accesos estáticos
   (`src/composition/evm-residue-guard.ts:17-22`): `NEXT_PUBLIC_VM`, `NEXT_PUBLIC_EIP3009_ENABLED`,
   `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS`, `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS`,
   `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_REOWN_PROJECT_ID`. Su alcance es deliberado y está acotado a
   las `NEXT_PUBLIC_*`: son las únicas que el container puede observar allí donde corre. El error
   lleva NOMBRES de variables, nunca valores.
2. **Un test que recorre el árbol.** `src/composition/no-evm-surface.test.ts` es un denylist
   ENUMERADO, no una prohibición universal, y conviene leerlo por lo que es. Ver
   [Qué garantiza el test anti EVM, exactamente](#qué-garantiza-el-test-anti-evm-exactamente).
3. **Lo que describe filas ya escritas, que no se toca.** La unión `vm: "evm" | "solana"` sigue en
   `src/application/ports.ts` y en el ledger (`src/infrastructure/persistence/supabase-settlement-ledger.ts:84-91`),
   porque hay filas EVM ya escritas en Postgres y podar código no es reescribir la historia de una
   base de datos. Lo verificable es que ningún call site de producción pasa `"evm"`: los dos que
   escriben en el ledger pasan `vm: "solana"` (`app/api/payout/prepare/route.ts:297`,
   `app/api/solana/escrow/remittance-ids/route.ts:128`).

## Regla de dependencia

```
presentation   ->  application  ->  domain
infrastructure ->  application (implementa sus ports)
composition    ->  conoce a todos, los cablea
```

Nada de `src/domain/` ni de `src/application/` importa un paquete externo: ni React, ni
`@solana/web3.js`, ni un cliente de base de datos. Es comprobable en una línea, y da vacío:

```bash
grep -rn '^import' src/domain src/application --include='*.ts' | grep -v '\.test\.' | grep 'from "[^.]'
```

Los adaptadores se eligen en un solo lugar, `src/composition/container.ts`, que es el único archivo
fuera de `src/infrastructure/` que menciona clases concretas de infraestructura. La consecuencia
práctica: el camino del dinero se prueba en la capa de use cases con dobles, sin navegador, sin red y
sin wallet, y la suite entera termina en segundos en vez de ser una batería de integración lenta y
frágil.

## `src/domain/`

Puro, sin dependencias externas. Dos archivos: `money.ts` y `remittance.ts`.

- `Money`: montos en unidades menores, enteros, cero floats. Evita que un redondeo de punto flotante
  se convierta en una diferencia de plata.
- `Remittance`: el agregado. Contiene la máquina de estados y las invariantes de negocio.

Estados (`src/domain/remittance.ts:72-83`): `created`, `kyc_pending`, `kyc_passed`, `kyc_failed`,
`quoted`, `confirmed`, `principal_in`, `payout_submitted`, `settled`, `payout_failed`, `refunded`.
Terminales: `settled`, `kyc_failed`, `refunded`.

Las transiciones no son libres: están declaradas una por una en la tabla `TRANSITIONS`
(`remittance.ts:85-97`). No se puede confirmar sin identidad verificada y sin una cotización vigente.
Una cotización con fecha de vencimiento no parseable se trata como vencida, no como válida.

## `src/application/`

Los use cases orquestan el dominio y dependen solo de los ports. Son once, uno por archivo en
`src/application/use-cases/`: `PreviewQuote`, `CreateRemittance`, `ConnectWallet`, `StartKyc`,
`ResumeKyc`, `AbandonPendingKyc`, `ForgetKyc`, `LockQuote`, `ConfirmAndSend`, `TrackRemittance`,
`ListHistory`.

Los ports viven en `src/application/ports.ts`. Los principales:

| Port | Responsabilidad |
|---|---|
| `QuoteGateway` | Cotización de FX del corredor |
| `KycGateway`, `KycStore`, `KycPendingStore` | Verificación de identidad y su estado |
| `PayoutGateway`, `PayoutAuthorityGateway` | Envío del desembolso y su autorización server side |
| `WalletPort` | Conectar y firmar |
| `SolanaSettlementGateway`, `SolanaPayoutPrepareGateway` | Depósito al escrow y patrocinio de gas |
| `SolanaEscrowRefundGateway`, `SolanaRemittanceIdResolver`, `RefundGateway` | Devolución y recuperación |
| `PopSigner` | Prueba de posesión de la clave |
| `RemittanceRepository`, `SettlementLedger` | Persistencia local y ledger de settlement |
| `Clock`, `IdGenerator` | Tiempo e identificadores, inyectados para poder testear |

`WalletPort` no filtra nada de la cadena hacia arriba: el use case pide una firma y recibe un
envelope opaco. Por eso el dominio y los use cases se prueban enteros con dobles, sin RPC ni wallet,
y un cambio en la capa de firma no llega a tocarlos.

## `src/infrastructure/`

Los adaptadores, agrupados por responsabilidad:

- `solana-wallet.ts`, `solana-wallet-bridge.ts`: el adaptador de wallet y el puente con el árbol de
  providers de React.
- `solana/escrow-idl.ts`: copia vendoreada del IDL del programa Anchor. El código de producción lee
  el program id de una sola fuente, el campo `address` de ese IDL (`escrow-idl.ts:9`), nunca de un
  literal copiado. Un `grep -rn DR5GoMT7 src app scripts contracts` devuelve ese IDL y tres archivos
  más, y los tres son tests que pinnean el id a propósito (`solana-wallet.test.ts:63`, `solana-wallet.refund.test.ts:14`,
  `contracts/idl/escrow-idl.hash.test.ts:31`). El código fuente en Rust de ese programa no está en
  este repo: ver el README.
- `settlement/`: cliente del facilitator (`facilitator-client.ts`), atestación de depósito
  (`deposit-attestation.ts`) y los gateways Solana de preparación y settlement.
- `refund/`: devolución vía escrow (`solana-escrow-refund-gateway.ts`), resolución del identificador
  de remesa desde el índice on chain y el refund ledger only.
- `persistence/`: ledger de settlement en Postgres (Supabase) y manejo de fallos de escritura.
- `a2a/`: clientes de los agentes del marketplace (`gateways.ts`) y el cliente del gateway A2A
  (`gateway-client.ts`), siempre detrás de rutas server only.
- `didit/`, `payout/`, `webhooks/`: identidad, autoridad de payout y verificación HMAC del webhook
  del proveedor.
- `auth/`, `rate-limit.ts`, `address.ts`, `chain.ts`: prueba de posesión, límites de tasa,
  canonicalización de direcciones y resolución de red desde el entorno.

`chain.ts` es la única fuente de red, mint, RPC y pubkeys, y todo lo resuelve desde el entorno:
`resolveSolanaUsdcMint()` (`NEXT_PUBLIC_SOLANA_USDC_MINT`), `resolveSolanaFacilitatorPubkey()`
(`NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`), `resolveSolanaReleaseAuthorityPubkey()`
(`SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`) y los dos resolvers de RPC. Cada uno falla ruidoso si la
variable falta o no es base58 válido, y la validación es siempre `new PublicKey(...)` de
`@solana/web3.js`, nunca un validador hexadecimal. La única dirección literal del archivo es
`canonicalUsdcMint` (`chain.ts:19`), y está anotada como REFERENCIA documentada: el resolver no la
usa.

## `app/`

Shell de Next con App Router, más las rutas de API. Las rutas son server only: son el único lugar
donde viven las keys de los servicios externos, que nunca llegan al bundle del navegador. Son diez y
esta es la lista completa (`find app/api -name route.ts`):

- `api/payout/prepare`, `api/payout/validate`: preparación y validación del desembolso.
- `api/settle/solana-sponsor`: patrocinio de gas y broadcast del depósito vía el facilitator.
- `api/solana/escrow/remittance-ids`: lectura del índice on chain de escrows.
- `api/kyc/session`, `api/kyc/decision`: identidad.
- `api/a2a/quote`, `api/a2a/payout/challenge`: cotización vía el marketplace de agentes y el
  challenge de la prueba de posesión.
- `api/webhooks/transfi`: notificaciones del proveedor de desembolso, con firma HMAC verificada.
- `api/admin/reconcile-orphans`: reconciliación de filas del ledger sin contraparte.

Hay una sola ruta de settlement, no una por VM. `app/api/settle/principal` y
`app/api/a2a/payout/submit` fueron borradas, y su ausencia está asserted, no comentada
(`src/composition/no-evm-surface.test.ts:121-136`): el test comprueba que el directorio NO EXISTE,
que es distinto de un handler que devuelve 404.

## Flujo

Pasos de la interfaz (`src/presentation/flow.tsx:23`): `send`, `connect`, `review`, `verify`,
`confirm`, `track`, `done`.

```
send      monto, preview de tasa en vivo
connect   conexión de wallet
review    revisión de la cotización y el beneficiario
verify    verificación de identidad
confirm   confirmación, firma del depósito al escrow
track     seguimiento del estado
done      recibo
```

La cotización se pide antes de la verificación de identidad, a propósito: el usuario ve el precio
antes de que se le pida un documento.

## Composition root

`src/composition/container.ts` corre primero el guard de residuo y después decide, leyendo el
entorno, dos cosas y nada más:

- Qué adaptador de cotización y desembolso se usa: el de demo (`fallback`, el default) o el que le pide
  capacidades al gateway (`a2a-gateway`), vía `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` (`container.ts:114`).
  Son los dos únicos legales: `a2a`, el carril punto a punto, se borró en WKH-332 y hoy TIRA al arrancar.
- Si el settlement Solana está encendido, vía `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` (`container.ts:141`).

La wallet no está en esa lista, y es el punto: no se decide, se construye.

Los guards son fail loud y corren en construcción, no en tiempo de firma. Una configuración
incoherente rompe al arrancar la app. Los casos cubiertos:

- Settlement Solana encendido sin mint, o sin la pubkey del facilitator (`container.ts:142-145`).
- Configuración de un camino de settlement que este código ya no tiene. Ese es el único guard que no
  se resuelve por construcción: esa configuración vive fuera del código, en el panel del proveedor de
  hosting, y ahí puede quedar huérfana sin que nadie se entere.

Con el entorno vacío ningún guard se activa, porque ninguna flag está encendida: la app levanta en
modo demo y no mueve fondos.

## Qué garantiza el test anti EVM, exactamente

`src/composition/no-evm-surface.test.ts` recorre `src/`, `app/`, `scripts/` y `contracts/` en cada
`npm test` y falla contra una lista CERRADA, que conviene leer entera antes de citarla:

- Imports de `viem` (incluidos sus submódulos), `wagmi` y `@walletconnect/ethereum-provider`, en
  forma de `import` y de `require` (`:57-61`).
- El interruptor `NEXT_PUBLIC_VM` (`:63`), con un allowlist de cuatro rutas EXACTAS: el guard de
  residuo tiene que nombrar la variable que caza, y sus tests tienen que nombrarla para probar que la
  nombra.
- Los validadores de address hexadecimal `isAddress(` e `isAddressEqual(` (`:73-74`) y dos regex
  `0x…{40}` escritas a mano (`:76-77`).
- Que `viem`, `wagmi` y `@walletconnect/ethereum-provider` no estén en `dependencies` ni en
  `devDependencies` de `package.json` (`:111`).
- Que nueve rutas y archivos del camino viejo no existan en el árbol (`:121-136`).

Eso es lo que garantiza, y no más: **cierra las puertas por las que el camino EVM se fue, para que
no pueda volver por ellas.** No es una prohibición universal de toda librería Ethereum. Un
`npm i ethers` seguido de un import en `src/infrastructure/` pasa el gate en verde; lo mismo `web3`,
`@ethersproject/*` o `thirdweb`. Si algún día hace falta cubrir esos nombres, se agregan a la lista
`FORBIDDEN` con su entrada.

Tres trampas están resueltas a propósito dentro del archivo, y están documentadas en su cabecera: el
test se excluye a sí mismo por RUTA EXACTA y nunca por un glob `*.test.ts` (que cegaría toda la
suite); los patrones buscan el TEXTO de la regex de una address, no una address que la matchee (para
no poner rojos los fixtures legítimos de filas EVM ya escritas); y los patrones son import shaped,
para no matchear prosa.
