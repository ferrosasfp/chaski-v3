# Arquitectura

Detalle de capas y flujo. El panorama general y el estado del proyecto están en el
[README](../README.md).

## Regla de dependencia

```
presentation   ->  application  ->  domain
infrastructure ->  application (implementa sus ports)
composition    ->  conoce a todos, los cablea
```

Nada del dominio ni de la aplicación importa React, `viem`, `@solana/web3.js` ni un cliente
de base de datos. Los adaptadores se eligen en un solo lugar, `src/composition/container.ts`,
que es el único archivo que menciona clases concretas de infraestructura.

La consecuencia práctica: el camino del dinero se prueba en la capa de use cases con dobles,
sin navegador, sin red y sin wallet. Es la razón por la que hay 819 tests que corren en
segundos en vez de una suite de integración lenta y frágil.

## `src/domain/`

Puro, sin dependencias externas.

- `Money`: montos en unidades menores, enteros, cero floats. Evita que un redondeo de punto
  flotante se convierta en una diferencia de plata.
- `Remittance`: el agregado. Contiene la máquina de estados y las invariantes de negocio.

Estados: `created`, `kyc_pending`, `kyc_passed`, `kyc_failed`, `quoted`, `confirmed`,
`principal_in`, `payout_submitted`, `settled`, `payout_failed`, `refunded`.

Las transiciones no son libres. No se puede confirmar sin identidad verificada y sin una
cotización vigente. Una cotización con fecha de vencimiento no parseable se trata como
vencida, no como válida.

## `src/application/`

Los use cases orquestan el dominio y dependen solo de los ports.

Use cases: `PreviewQuote`, `CreateRemittance`, `ConnectWallet`, `StartKyc`, `ResumeKyc`,
`AbandonPendingKyc`, `ForgetKyc`, `LockQuote`, `ConfirmAndSend`, `TrackRemittance`,
`ListHistory`.

Los ports viven en `src/application/ports.ts`. Los principales:

| Port | Responsabilidad |
|---|---|
| `QuoteGateway` | Cotización de FX del corredor |
| `KycGateway`, `KycStore`, `KycPendingStore` | Verificación de identidad y su estado |
| `PayoutGateway`, `PayoutAuthorityGateway` | Envío del desembolso y su autorización server side |
| `WalletPort` | Conectar y firmar, indistinto EVM o Solana |
| `PrincipalSettlementGateway` | Movimiento del principal en el camino EVM |
| `SolanaSettlementGateway`, `SolanaPayoutPrepareGateway` | Depósito al escrow y patrocinio de gas |
| `SolanaEscrowRefundGateway`, `SolanaRemittanceIdResolver`, `RefundGateway` | Devolución y recuperación |
| `PopSigner` | Prueba de posesión de la clave |
| `RemittanceRepository`, `SettlementLedger` | Persistencia local y ledger de settlement |
| `Clock`, `IdGenerator` | Tiempo e identificadores, inyectados para poder testear |

`WalletPort` es la abstracción que hace posible el multichain: el mismo use case sirve para
una wallet EVM y para una Solana, porque ninguno de los dos adaptadores filtra su tipo de
cadena hacia arriba.

## `src/infrastructure/`

Los adaptadores, agrupados por responsabilidad:

- `wallet.ts`, `solana-wallet.ts`, `solana-wallet-bridge.ts`: wallets EVM (inyectada y
  WalletConnect) y Solana, más el fallback de demo.
- `settlement/`: cliente del facilitator, atestación de depósito, verificador on chain,
  gateways de preparación y settlement para cada VM.
- `solana/escrow-idl.ts`: copia pinneada del IDL del programa Anchor.
- `refund/`: devolución vía escrow y resolución del identificador de remesa desde el índice
  on chain.
- `persistence/`: ledger de settlement en Postgres y manejo de fallos de escritura.
- `a2a/`: clientes de los agentes del marketplace, siempre detrás de rutas server only.
- `auth/`, `rate-limit.ts`, `address.ts`, `chain.ts`: prueba de posesión, límites de tasa,
  validación de direcciones y resolución de red desde el entorno.

`chain.ts` es la única fuente de verdad para red, mint, direcciones de contrato y pubkeys.
No hay ninguna de esas constantes escrita en otro archivo.

## `app/`

Shell de Next con App Router, más las rutas de API. Las rutas son server only: son el único
lugar donde viven las keys de los servicios externos, que nunca llegan al bundle del
navegador.

- `api/payout/prepare`, `api/payout/validate`: preparación y validación del desembolso.
- `api/settle/principal`, `api/settle/solana-sponsor`: settlement por VM.
- `api/solana/escrow/remittance-ids`: lectura del índice on chain de escrows.
- `api/kyc/session`, `api/kyc/decision`: identidad.
- `api/a2a/quote`, `api/a2a/payout/challenge`, `api/a2a/payout/submit`: llamadas al
  marketplace de agentes.
- `api/webhooks/*`: notificaciones del proveedor de desembolso, con firma verificada.
- `api/admin/reconcile-orphans`: reconciliación de filas del ledger sin contraparte.

## Flujo

Pasos de la interfaz: `send`, `connect`, `review`, `verify`, `confirm`, `track`, `done`.

```
send      monto, preview de tasa en vivo
connect   conexión de wallet
review    revisión de la cotización y el beneficiario
verify    verificación de identidad
confirm   confirmación, firma del depósito al escrow
track     seguimiento del estado
done      recibo
```

La cotización se pide antes de la verificación de identidad, a propósito: el usuario ve el
precio antes de que se le pida un documento.

## Composition root

`src/composition/container.ts` decide, leyendo el entorno:

- Qué VM está activa, y con eso qué adaptador de wallet se inyecta. Un solo dispatcher, para
  que no exista un modo mixto silencioso.
- Qué adaptador de cotización y desembolso se usa: el de demo o el que llama a los agentes.
- Si el settlement real está encendido o no.

Los guards son fail loud y corren en construcción, no en tiempo de firma. Una configuración
incoherente rompe al arrancar la app. Los casos cubiertos:

- Firma EIP-3009 encendida sin adaptador real, sin dirección receptora, sin contrato de
  token, o con una dirección malformada.
- Camino Solana encendido sin VM Solana, sin mint, o sin la pubkey del facilitator.
- VM Solana y firma EIP-3009 encendidas a la vez, que son mutuamente excluyentes.

Con el entorno vacío ningún guard se activa, porque ninguna flag está encendida: la app
levanta en modo demo y no mueve fondos.
