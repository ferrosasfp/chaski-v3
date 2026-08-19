[English](README.md)

# Chaski

Chaski es una app de remesas cripto a fiat que nunca toma la custodia del dinero. El que envía conecta
su wallet y el principal queda bloqueado en una cuenta de escrow en Solana. Una autoridad de release
puede moverlo únicamente al beneficiario que quedó fijado en el momento del depósito, y sólo cuando el
pago en el país de destino está confirmado. Si eso no pasa, el que envía firma un refund y recupera su
propia plata sin permiso de nadie. El escrow es un programa Anchor en devnet, sin dinero real.

La parte que vale la pena leer dos veces es la sección siguiente: **el core de la lógica de remesas no
está en Chaski, está en los agentes que conforman el pipeline.** Chaski orquesta y consume. Los agentes
implementan.

Este es un proyecto en implementación. Lo que sigue describe qué se está construyendo, cómo se compone
una remesa, y dónde está parado el trabajo hoy, incluidos los dos lugares donde la cadena de pasos
todavía está abierta y por qué.

> **Sobre el nombre.** El proyecto de hosting se creó como `chaski-v2` y no se puede renombrar desde
> acá, así que el sitio desplegado se sirve en `chaski-v2.vercel.app`. Esa misma cadena sobrevive a
> propósito en el campo `id` de `public/manifest.json`: cambiar el `id` de un manifest PWA deja
> huérfanas las instalaciones existentes.

## Cómo probarlo en devnet

La app desplegada es `https://chaski-v2.vercel.app`. Todo lo que sigue pasa en la devnet de Solana,
con el USDC de devnet de Circle. No se mueve dinero real y a nadie se le pide un documento de verdad.

**En el celular hay que abrir la app DESDE ADENTRO del navegador de Phantom.** Un navegador de
celular común no tiene ninguna wallet inyectada, y ésa es la primera pared con la que choca quien
prueba. La pantalla lo dice y ofrece la salida: un botón que vuelve a abrir la misma URL adentro de
Phantom, armado como `https://phantom.app/ul/browse/<url>?ref=<origen>`
(`src/presentation/wallet-availability.ts:26-28`, el copy de la pantalla en
`src/presentation/flow.tsx:1311-1329`). En una computadora el camino es el otro: instalar la
extensión de Phantom o de Solflare y recargar. Esas dos son las únicas wallets que la app cablea
(`src/presentation/solana/solana-providers.tsx:228`).

**Hacé el recorrido entero en ese mismo navegador.** La remesa en curso se guarda en el
`localStorage` del navegador (`src/infrastructure/persistence.ts:86`), así que empezar en uno y
saltar a otro la pierde.

### Qué conseguir antes de empezar

- **USDC de devnet de Circle**, mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Se piden en
  <https://faucet.circle.com>, eligiendo la red `Solana Devnet` y pegando la dirección de la wallet.
  Tanto la página como esa opción de red contestaron el 2026-08-16. Hacen falta **5 USDC como
  mínimo**: por debajo de eso la app no cotiza, porque `MIN_SEND_USD = 5`
  (`src/domain/remittance.ts:209`).
  ⚠️ NO es el mint `8yRX3fZ2…` de las tres firmas de la tabla de más abajo. Ése es un token de prueba
  y la app no está configurada contra él.
- **Unos 0,009 SOL de devnet** en esa misma wallet. Se piden en <https://faucet.solana.com> (contestó
  el 2026-08-16), o con `solana airdrop 1 <tu pubkey> --url devnet` si tenés la CLI.

**Por qué hace falta SOL si la comisión la paga otro.** Una transacción de Solana paga dos cosas
distintas y sólo una está patrocinada. La comisión de red la paga el facilitator, que firma como fee
payer. El alquiler de las cuentas que crea el depósito lo paga quien envía, porque el programa lo
nombra a él como payer de esas cuentas. Medido sobre los tres depósitos que se citan más abajo: el
fee payer puso 11.200 lamports de comisión y la wallet del remitente puso 4.002.000 de alquiler. La
app lo chequea antes de pedir una sola firma y corta con "Te falta SOL en la wallet" por debajo de
0,0089 SOL (`SENDER_MIN_LAMPORTS_FOR_DEPOSIT`, `src/application/solana-escrow-rent.ts:187`, con su
derivación en ese mismo archivo).

### El recorrido

1. Conectar la wallet.
2. Monto de 5 USDC o más, el nombre de quien recibe, y una cuenta de destino de 20 dígitos, que es el
   largo de un CCI peruano. El formulario chequea el LARGO, no que la cuenta exista
   (`src/domain/remittance.ts:31` y `:44`), así que un número inventado te deja seguir.
3. Identidad. **En este despliegue es simulada**: la pantalla dice que no verifica nada y no pide
   ningún dato. Esa pantalla sólo existe si el operador declaró el mock
   (`src/infrastructure/didit/mock-surface-enabled.ts:26`), y la app desplegada la sirvió con un 200
   el 2026-08-16.
4. Confirmar. **La wallet pide firmar dos veces, y es a propósito**: primero la transacción del
   depósito, después un mensaje legible que nombra esta remesa, para que una firma de transacción
   capturada no le alcance a un tercero para pedir el patrocinio de un depósito
   (`src/infrastructure/solana-wallet.ts:781-799`).
5. El depósito entra en la cadena y la pantalla enlaza la transacción al visor
   (`src/presentation/flow.tsx:3582`). Los USDC quedan en el vault del escrow, y el operador no los
   puede redirigir.

### Qué NO va a pasar, dicho antes de probar y no después

- **Nadie paga soles.** La pata fiat corre contra un agente mock por defecto. No hay ninguna
  transferencia bancaria al final de esto.
- **Los USDC se quedan en el vault del escrow.** Sacarlos hacia el beneficiario es el `release`, y
  hoy el disparador es una persona. Lo dice el código donde aterriza el webhook del proveedor de
  pagos: *"La verificación on-chain del release la hace una persona; esto es el pedido de que la
  haga"* (`app/api/webhooks/transfi/route.ts:94-97`). El depósito es no-custodial y automático; la
  entrega fiat la confirma el operador.
- **La plata la recuperás vos.** Dos horas después del depósito se cierra la ventana de custodia
  (`CUSTODY_WINDOW_SECS`, `src/infrastructure/solana-wallet.ts:100`) y la app te deja firmar el
  refund, que no necesita la cooperación de nadie. Antes de ese deadline el programa lo rechaza
  (`DeadlineNotReached` 6003), así que las dos horas son una espera y no una falla. Ya se hizo en la
  cadena: el `Refund` de la sección de abajo, con el remitente como único firmante.

## Una remesa se arma, no viene cableada

Una remesa es una cadena de pasos: verificar quién envía, poner precio al par de monedas, entregar el
principal sin tomar custodia, y pagar en el país de destino. Chaski no es dueño de ninguno de esos pasos
como lógica de negocio. Es dueño del orden, de las invariantes y de la vía de escape del dinero.

Cada paso es una capacidad, y una capacidad la cumple el agente que pueda cumplirla. El código pide
`remittance-fx-quote` y pide `remittance-payout`. No nombra un agente, y no guarda la URL de ninguno. El
gateway A2A resuelve quién responde, y esa respuesta se valida contra la forma que el use case espera
antes de que pueda convertirse en dinero moviéndose.

La consecuencia es el objetivo de diseño: **la máquina se puede volver a armar en cada llamada.** Un
agente de FX mejor reemplaza al actual sin un deploy de este repo. Un agente que cubre dos pasos a la
vez colapsa dos llamadas en una. Un país de destino nuevo es un agente nuevo que declara la capacidad de
payout, no una rama en un switch acá adentro.

Dónde está eso hoy, en presente:

- **Ya no hay camino punto a punto.** Este bullet decía que era el activo y que llamaba a una base URL
  conocida. WKH-332 borró ese carril: por defecto la app cablea los gateways demo y no llama a ningún agente.
- **Por capacidad es el único transporte, y esta bandera no lo apaga.**
  `app/api/a2a/quote/route.ts:91-96` y `app/api/payout/prepare/route.ts:391-395` mandan una `capability`,
  con un piso de reputación en cada pata, y el gateway elige. `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` cablea
  UN adapter del CLIENTE, el de la cotización; el ESTADO del payout ya NO cuelga de ella (WKH-337: lo lee el ledger); estas
  routes no la leen. Sacale al gateway la URL o la key y las dos ROUTES contestan 501 sin un solo fetch.
- **Es fail closed a propósito.** Si el gateway no responde, la operación corta. Nunca cae a una llamada
  directa, porque un fallback silencioso crearía la orden de payout con un agente distinto del que el
  resto del flujo tomó como propio.
- **La identidad todavía no está en ese riel.** El KYC sigue siendo una integración directa con un
  proveedor (`src/infrastructure/didit/kyc-gateway.ts`), sin ninguna capacidad declarada. Llevarlo al
  mismo riel es trabajo abierto.

## Dónde está esto hoy

El escrow está deployado en devnet y sus tres instrucciones de dinero ya se ejecutaron on chain.
Cualquiera puede comprobarlas contra el RPC público de devnet sin pedirle permiso a nadie:

| Instrucción | Firma | Qué muestran los saldos |
|---|---|---|
| `deposit` | [`22A61Cync…`](https://explorer.solana.com/tx/22A61CyncHSGGHHDujNVJUvrgx8wxETSaGzPFdHrE9WMxatsxr4vNTg6JFesBQdBdbycTj6iF3gX2eoRY65JcFnN?cluster=devnet) | el principal sale del sender y queda en el vault del escrow |
| `release` | [`2opxzWsKCB…`](https://explorer.solana.com/tx/2opxzWsKCBCTXugexSPTBFnvvjYmunH9Z6KS1SCRToR6g3RaBZ5tFjqEqc6Eq2WHf4eabFGiEeHKs5tKY21iRs9a?cluster=devnet) | el vault queda en cero, el beneficiario recibe |
| `refund` | [`4GDwrHgsu2…`](https://explorer.solana.com/tx/4GDwrHgsu2kcJub8A2r8Nh5oRU5uA6DYqXgGoFKG1H9Nw9oYyPC5ooYWR9AAusLjhG1u4tCp5fSWo5DSgkkhyikk?cluster=devnet) | el vault queda en cero, el sender recupera el principal |

Esas tres movieron un token SPL emitido para pruebas
(`8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q`, seis decimales), no el USDC devnet de Circle. El mint
contra el que la app está configurada es el de Circle
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), y es una sola variable de entorno, nunca un hardcode.
Decir "se movió USDC" sobre esas firmas sería falso, así que acá no se dice.

**El depósito es la pieza más sólida, y entra desde un navegador.** La instrucción entra en la
cadena, la wallet del que envía es la única que firma la transferencia, y un fee payer patrocinador
cubre la comisión de red. No cubre todo, y la diferencia no es un detalle: el alquiler de las cuentas
que crea el depósito sale de la wallet de quien envía, así que "el usuario no necesita SOL" sería
falso y acá no se dice. Los números están en la sección "Cómo probarlo en devnet".

Dos corridas del 2026-08-16, desde el navegador propio de Phantom en un celular Android, entraron las
dos:

| Firma | Hora (UTC) | Qué se movió |
|---|---|---|
| [`59XvDKhAJD…`](https://explorer.solana.com/tx/59XvDKhAJD5tbdzYeRQWWhNsi5Ac5ppSwu8xM3rHwVCRUVhvZPBcPnUtucU3F5o53VjaM8H9KAWG3zWSq5Waii8K?cluster=devnet) | 2026-08-16T06:17:19Z | 7 USDC salen del remitente y quedan en el vault `GppYQSnQ…` |
| [`2MUbUgJWSh…`](https://explorer.solana.com/tx/2MUbUgJWSh9kVPz5JKAEC7PYw8gNAMjLsqR1fJ3iZ18CtYZCdTEULxNRojmdxinTrCWcBkjMi9HNiTBRGpoPYYo5?cluster=devnet) | 2026-08-16T07:40:14Z | 6 USDC al vault `HcsP8afr…`, el remitente pasa de 56 a 50 |

Las dos vienen con `err: null`, comisión de 11.200 lamports puesta por el patrocinador `4wPhH4dC…`,
el remitente `4AvAjtPg…` como el otro firmante, y la forma de cuatro instrucciones del camino de
depósito de la app. Se releen del RPC público de devnet sin permiso de nadie. Lo que la cadena prueba
es la transacción; que el cliente haya sido el navegador de un celular es el reporte de quien las
corrió, la misma clase de evidencia que el recorrido de CSP de más abajo.

**Lo que NO está probado es el ciclo completo, y el motivo no es el depósito.** Los 13 USDC de esas
dos corridas siguen en custodia: los dos vaults tenían 7 y 6 USDC el 2026-08-16, y un
`getTokenAccountBalance` sobre cada uno dice si eso sigue siendo cierto cuando leas esto. Ahí no
falló nada. El recorrido termina donde termina el sistema hoy, porque el release lo dispara una
persona.

**La salida también se ejercitó, y la firmó el remitente solo.** El escrow del 2026-08-15 pasó su
deadline y quien depositó recuperó la plata sin la cooperación de nadie:
[`3dYjRE7u8b…`](https://explorer.solana.com/tx/3dYjRE7u8bzBKZD9PKci3oJ5X98J8jku65kK9T8GwEZ4hLZ2h9rwWt49ibqgEngSrAiNiA3F5gTN13cZroF2ywDj?cluster=devnet),
del 2026-08-16T06:17:49Z, una instrucción que los logs nombran `Refund`, con el vault `7piawXnH…`
pasando de 13,5 USDC a cero y la wallet del remitente de 42,5 a 56. Hay un solo firmante, el
remitente, y los 80.000 lamports de comisión salieron de su propia wallet. No se le pidió permiso a
nadie.

**Chaski emite instrucciones de ComputeBudget en el depósito (WKH-321), y ese camino YA entró en la
cadena.** La transacción del `deposit` lleva dos instrucciones antes de las del escrow,
`setComputeUnitLimit` y `setComputeUnitPrice`, que salen de los resolvers de
`src/infrastructure/chain.ts:93` y `:124` y se agregan a la transacción en
`src/infrastructure/solana-wallet.ts:675-678`. Eso baja la probabilidad de que una billetera como
Phantom meta sus propias propinas de prioridad por encima del tope del facilitator (medido en devnet
en 50.000 unidades).

**La transacción que lo prueba** es
[`38PyBoVizf…`](https://explorer.solana.com/tx/38PyBoVizfhVLxm217QzeWP3JPYqGxJUC6vzuxh9xxv9FJdMquQ6BUFyUsma1ePiWK59qCQweFNNony1MJ7UReLV?cluster=devnet),
del 2026-08-15T08:36:12Z, con `err: null`, comisión de 11.200 lamports y 54.600 unidades de cómputo
consumidas. Lleva cuatro instrucciones, en este orden: dos de
`ComputeBudget111111111111111111111111111111` y dos del programa de escrow
`DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`, que sus propios logs nombran `Deposit` y
`RegisterEscrow`. Y movió plata de verdad: el vault del escrow `7piawXnH…` no existía antes y terminó
con 13,5 USDC, mientras la cuenta de tokens del remitente pasó de 48 a 34,5, en el USDC de devnet de
Circle (mint `4zMMC9…`), que es el mint contra el que la app está configurada. Cualquiera la relee
del RPC público de devnet con `getTransaction`, sin pedirnos nada.

⚠️ **La cadena no registra qué cliente armó una transacción.** Una firma lleva instrucciones y
firmantes, nunca el programa que las ensambló. Para las dos corridas de más arriba, el navegador del
celular es el reporte de quien las corrió. Para ésta no hay tal reporte, y lo que se puede decir es
más angosto: la forma de cuatro instrucciones `[limit, price, deposit, register]` la arma únicamente
el camino de depósito de la app (`src/infrastructure/solana-wallet.ts:769-771`), mientras que el
script de smoke arma tres, sin `register_escrow` (`scripts/smoke-solana-e2e.ts:455`), y su firmante
tampoco es el remitente sobre el que se midieron esas corridas
(`src/application/solana-escrow-rent.ts:14`). O sea que no es una corrida del smoke tal como está en
este árbol, y más lejos que eso la cadena no llega.

⚠️ La salvedad sobre las billeteras sigue igual: si una billetera intenta anteponer su propio
ComputeBudget y rechaza el duplicado después de haber firmado (como asume el código), el depósito
falla con evidencia clara. Esa suposición no es contractual, es comportamiento observado en
billeteras de terceros.

⚠️ **Los tres párrafos de ComputeBudget de acá arriba faltaban enteros en esta traducción hasta el
2026-08-16**, mientras el README en inglés tenía el suyo desde WKH-321. Es el mismo modo de falla que
ya está anotado más abajo para el párrafo de seguridad, y el que hace inútil comparar los dos
archivos por tamaño: hasta hoy los dos tenían 396 líneas.

**El bloqueo de la pata de confirmación era un secreto compartido, y ya no está.** La primera mitad se
había arreglado antes: el cliente firma una prueba de posesión antes de pedirle al servidor que cree la
orden de payout, así que el flujo ya no muere antes de que la wallet pida una sola firma. La segunda
mitad era el broadcast del depósito, y estaba bloqueada por diseño y no por una línea que faltara: el
facilitator autorizaba el patrocinio con un HMAC sobre un secreto compartido entre servidores, y un
navegador no puede guardar un secreto entre servidores sin filtrarlo. Quien tuviera ese secreto además
podía fabricar una prueba válida para cualquier billetera, que es la peor mitad del mismo problema.

El SDD 037 reemplazó ese HMAC por una firma de la propia billetera. La persona firma un mensaje legible
que nombra la remesa, el monto, el token y la red, más la firma de la transacción exacta que se va a
patrocinar; el facilitator reconstruye ese mensaje línea por línea desde la transacción y desde su
propia config, y lo verifica con ed25519. No queda ningún secreto compartido: la clave que valida es el
pubkey del que envía, leído de la instrucción `deposit` y no del body del request. En concreto: el
schema del facilitator ahora exige `popSignature`
([`solana-sponsor.ts`](https://github.com/ferrosasfp/wasiai-facilitator/blob/main/src/routes/solana-sponsor.ts)),
un request con el viejo `popProof` recibe un 400 sin que se firme nada, el cliente manda `popSignature`
en el `settle()` (`src/application/use-cases/confirm-and-send.ts`), y la ruta que reenvía
(`app/api/settle/solana-sponsor/route.ts`) corta con 400 si falta o viene deforme, antes de gastar el
forward. Ese reemplazo es esta rama, no trabajo abierto.

Lo que quedaba abierto en esta pata era la vuelta desde el navegador y una pieza de configuración, y
ninguna de las dos sigue abierta. Los dos depósitos del 2026-08-16 se broadcastearon con el
facilitator firmando como fee payer, que es lo que hace su endpoint de patrocinio. Con
`SOLANA_SPONSOR_NETWORK_ID` sin setear se rechaza TODO pedido de patrocinio, y a estos dos no se los
rechazó, así que esa variable está puesta en el facilitator desplegado y el camino de `popSignature`
funciona contra una billetera real. Lo que decía acá, que el camino estaba muerto en las dos
direcciones porque un cliente viejo manda `popProof` y se lleva un 400 mientras uno nuevo firma para
un servidor que lo ignora, describía la ventana entre los dos deploys y se cerró con ellos.

**El release corre, pero nada decide cuándo correrlo.** La instrucción está implementada, restringida y
probada on chain, como muestra la tabla de arriba. Lo que no existe, en ninguno de los tres repos, es un
componente que observe un pago fiat confirmado y llame al release. Hoy lo hace una persona a mano, y el
smoke de devnet está sustituyendo a ese actor ausente. La consecuencia es concreta y conviene decirla
sin vueltas: una remesa llega a `payout_submitted` con el dinero todavía sentado en el vault del escrow.
La pieza que falta no es la llamada on chain, es la que decide. Hasta que exista, la garantía del que
envía es el refund, que no necesita la cooperación de nadie.

**Se cerraron dos huecos de seguridad en el flujo de confirmación (2026-08-04).** El flujo de KYC podía
abrir una sesión sin atadura a la dirección de billetera de quien envía; `/api/payout/validate` entonces
autorizaba cualquier dirección presentada por un llamador no autenticado. Se reprodujo en producción: un
POST público con el cuerpo vacío creó una sesión sin `vendor_data`, el mock la aprobó, y tres direcciones
sin relación entre sí pasaron la validación. El endpoint ahora falla cerrado: `vendor_data` tiene que
coincidir con la dirección o la autorización se rechaza (WKH-180, revisado en
`app/api/payout/validate/route.test.ts:156-180`). El segundo arreglo: el endpoint de confirmación ahora
verifica que la dirección de billetera exista antes de consultar a la autoridad de payout. Si la sesión
de KYC no tiene dirección, `confirm-and-send` devuelve `wallet_address_unavailable` en vez de dejar que
una dirección vacía viaje hasta la autoridad, que convertiría un error trivial de estado local en un 502
falso ("falló el proveedor de identidad"). La guarda de propiedad sigue en pie: la autoridad sigue
fallando cerrado y sigue rechazando exactamente lo que rechazaba antes.

⚠️ **Este párrafo faltaba entero en esta traducción hasta el 2026-08-11**, mientras el README en inglés
lo tenía. Medido comparando sección por sección: trece de catorce secciones estaban dentro del ±7%
normal de una traducción, y esta caía al 74%. O sea que quien leyera el repo en español no veía trabajo
de seguridad que sí existe, y el modo de falla de una traducción parcial es exactamente ése: no dice algo
falso, omite. Por eso la comparación es por tamaño de sección y no por lectura.

Dos cosas más que están apagadas por decisión y no por estar sin terminar:

- El desembolso a fiat corre contra un adaptador mock por defecto. El adaptador real existe y está
  cableado, y necesita credenciales de proveedor que no están en este repo.
- Nada apunta a mainnet. El cluster es una constante en el script de smoke, no una variable.

## El camino del dinero

El escrow es un programa Anchor deployado en devnet:

```
DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x
```

Seis instrucciones: `deposit`, `release`, `refund`, `close`, `register_escrow`, `deregister_escrow`.

**El código fuente de ese programa NO está en este repo.** Acá no hay ningún `.rs`, ni `Anchor.toml`, ni
`Cargo.toml`, y `contracts/` tiene contract tests en TypeScript, no Rust. El programa Anchor vive en
[`ferrosasfp/solana-programs`](https://github.com/ferrosasfp/solana-programs), en
`programs/escrow/src/lib.rs`, y es público. Lo que sí vive acá es el lado consumidor: el IDL del
programa, vendoreado y pinneado por hash canónico, como se describe abajo.

El estado por remesa vive en una PDA derivada de `[b"escrow", sender, remittance_id]`, donde
`remittance_id` es un array de 16 bytes. Los fondos viven en la associated token account de esa PDA para
el mint, así que la dirección del vault es función de la cuenta de escrow y no se puede apuntar a otro
lado.

El ciclo:

1. La app le pide al servidor los parámetros del depósito. Si la pubkey de la autoridad de release no
   está configurada, el servidor responde 503 en vez de seguir.
2. La wallet del que envía firma `deposit`, que toma `beneficiary`, `authority`, `amount` y `deadline`
   como argumentos. El principal sale de su cuenta y queda en el vault del escrow. El operador no lo
   toca.
3. El facilitator cofirma como fee payer y hace el broadcast, así quien envía no paga comisión de red.
   El alquiler de la PDA del escrow y de su vault, 4.002.000 lamports (unos 0,004 SOL por remesa,
   medidos en devnet), SÍ sale de la wallet de quien envía, y por eso la app le mira el saldo de SOL
   antes. Este paso ya entró desde un navegador: las dos corridas del 2026-08-16 de más arriba.
4. Con el pago en destino confirmado, la autoridad de release firma `release`. `sender`, `beneficiary` y
   `mint` están restringidos por `has_one` contra la cuenta de escrow, así que el destino es el que
   quedó fijado en el depósito y la autoridad no puede redirigir los fondos. Todavía no hay nada
   automático que decida dar este paso.
5. Si algo falla, el que envía firma `refund` y el principal vuelve a quien lo depositó, sin ninguna
   otra firma. El programa lo rechaza si el escrow no está en estado `Deposited` y si el deadline
   todavía no venció (`EscrowNotDeposited` 6002, `DeadlineNotReached` 6003).

### El IDL está pinneado por hash

El IDL del programa está vendoreado en `src/infrastructure/solana/escrow-idl.ts` y su SHA-256 canónico
está fijado en `contracts/idl/escrow-idl.hash.test.ts`, que corre en cada `npm test`. El mismo test
pinnea además el program id y el orden posicional de las cuentas de `deposit`, `refund` y
`register_escrow`. Si alguien edita el IDL vendoreado a mano, o el programa deployado reordena sus
cuentas, la suite se pone roja antes de que una transacción se rechace en producción. Re pinnear es una
decisión explícita con su entrada en `contracts/CONTRACT-VERSIONS.md`, nunca un drift silencioso. El
valor pinneado coincide con el que tiene
[`wasiai-facilitator`](https://github.com/ferrosasfp/wasiai-facilitator). Medido el 2026-08-11 por cuatro
caminos independientes: este árbol, la cadena, el facilitator y `solana-programs` canonizan los cuatro a
`cc2761266dcf8335a17562129de040805f37f69cfe654f5be472045ba7bfcd51` sobre 16.020 bytes.

### Cabeceras de seguridad, y qué es lo que todavía NO protegen

La app sirve `Content-Security-Policy` en modo **bloqueo** (`next.config.mjs`, la política se arma en
`src/infrastructure/security/csp-policy.mjs`). Una política mal puesta acá no se manifiesta como una
página rota: se manifiesta **al firmar**, porque el árbol del wallet adapter, el RPC y su WebSocket abren
conexiones que una política incompleta bloquea, y la persona lo descubre con la transacción ya armada.

Por eso `connect-src` se **deriva** de `NEXT_PUBLIC_SOLANA_RPC_URL`, la misma variable con la que el
navegador construye su `Connection`, y de una sola URL saca **dos** orígenes: el `https://` de las
llamadas JSON-RPC y el `wss://` de las suscripciones. Omitir el segundo no rompe el envío, rompe la
*confirmación*, que es el modo de falla más confuso. `csp-policy.test.ts` grepea el TEXTO del propio
módulo de la política para prohibir cualquier host de Solana escrito a mano, así las dos listas no pueden
separarse.

**Cómo se validó, porque esto no lo puede contestar un test en verde.** La política corrió una primera
vuelta en `Report-Only`, sin bloquear nada, mientras el navegador reportaba qué *habría* bloqueado, y la
persona que firma recorrió la aplicación completa tres veces el 2026-08-11 (5, 12 y 11 dólares, con
depósito confirmado en la cadena cada vez). Resultado: **cero violaciones atribuibles a esta app**,
incluidas cero de `connect-src`.

Sí hubo cinco violaciones y **ninguna se autorizó**. Las cinco las produce la barra que Vercel inyecta,
que carga su propia tipografía de Google y necesita `eval`. Que no son nuestras está medido, no supuesto:
`DM Sans`, `gstatic` y `eval(` no aparecen ni en el repo, ni en el HTML servido, ni en el JS del cliente.
Autorizarlas costaría `'unsafe-eval'` más tres dominios para todos los visitantes, para acomodar una
herramienta que sólo ve quien está logueado en Vercel. Un test (`T-CSP-10`) prohíbe agregar esos cuatro
permisos, porque "agregar el dominio hasta que deje de quejarse" es el camino de menor resistencia.

⚠️ **Lo que esto NO protege.** `script-src` sigue llevando `'unsafe-inline'`, porque Next inyecta scripts
en línea para hidratar. Con ese permiso presente, `script-src` **no** protege contra XSS inyectado en el
HTML: es la directiva más importante de la política y hoy es la más débil. Arreglarlo bien exige un nonce
por request, que exige mover las cabeceras a un middleware. Está declarado en el código, no escondido, y
es trabajo en cola y no un detalle.

### El proveedor de RPC, y por qué su credencial es pública

Desde el 2026-08-11 la app habla con un proveedor dedicado en vez del endpoint público de devnet, que
estaba devolviendo HTTP 429 en ráfagas durante un recorrido real. La credencial está **a la vista en la
página por diseño**: las variables `NEXT_PUBLIC_*` se incrustan en el bundle al compilar, así que el
navegador de cada visitante tiene que poder usarla y no hay forma de esconderla en un plan gratuito. El
control que sí existe es una **lista blanca de dominios** del lado del proveedor, verificada el
2026-08-11 en los dos canales: tanto las llamadas JSON-RPC como el saludo del WebSocket aceptan el origen
de esta app y rechazan un origen ajeno y una petición sin origen. Su límite honesto: impide que **otro
sitio web** use la credencial, no que un script mande la cabecera a mano.

⚠️ Una consecuencia que conviene saber antes de escribir herramientas: `getProgramAccounts` **no está
disponible en el plan gratuito de ese proveedor**, y el endpoint público lo limita por cuota. La app nunca
lo llama (sus cinco métodos son `getAccountInfo`, `getLatestBlockhash`, `getBalance`,
`sendRawTransaction` y `confirmTransaction`, los cinco verificados funcionando), pero cualquier script que
enumere cuentas de un programa hoy no tiene endpoint contra el que correr.

### Smoke de devnet

`npm run smoke:solana` corre el ciclo on chain completo contra servicios ya desplegados: healthchecks,
prueba de posesión, `/api/payout/prepare`, la instrucción `deposit` firmada por el sender, el broadcast
patrocinado por el facilitator, que cubre la comisión de red y no el alquiler de cuentas, la verificación del escrow (estado, saldo del vault y beneficiario), el
release contra el facilitator y la relectura de la cadena hasta ver el escrow liberado y el vault en
cero. Está deliberadamente incómodo de ejecutar:

- Aborta antes de cualquier llamada si no está `SMOKE_ALLOW_REAL=true`. No corre en CI.
- Las URLs de los servicios, las keys, los identificadores, el monto, el mint y la pubkey del
  facilitator son todas variables de entorno: trece requeridas, listadas y validadas una por una en
  `scripts/smoke-solana-e2e.ts:55-69`. Si falta alguna, el script aborta e imprime el nombre de la
  variable, nunca su valor.
- Dos entradas NO son variables, y cada una tiene su motivo. El cluster es la constante
  `CLUSTER = "devnet"` (`:46`): no hay variable de entorno que pueda apuntar este script a mainnet. El
  endpoint de RPC sí tiene default, `clusterApiUrl("devnet")` (`:108`), que es el endpoint público de
  devnet.
- **Lo que el smoke NO prueba, y lo imprime en cada corrida.** La atestación que autoriza el release la
  calcula el propio script con el secreto compartido. En el diseño del sistema esa atestación certifica
  que el KYC se aprobó y que la orden fiat se completó, así que un script que se la firma a sí mismo
  prueba la pata on chain y no prueba nada de la pata fiat. Y además está sustituyendo al decisor
  ausente descrito arriba: el smoke demuestra que las piezas on chain funcionan cuando alguien las llama
  en orden, no que el sistema las llame solo.
- La proveniencia del payout se imprime como parte del resultado. Un solo valor significa desembolso
  fiat real, y si aparece el script aborta, porque el alcance autorizado es devnet sin dinero real.

## Correr el proyecto

Requiere Node 22 (probado en 22.22.0).

```bash
git clone https://github.com/ferrosasfp/chaski-v3.git
cd chaski-v3
npm install --legacy-peer-deps
cp .env.example .env.local     # todo vacío arranca en modo demo, sin mover fondos
npm run dev                    # http://localhost:3000
```

El árbol de dependencias mezcla React 19 con paquetes que todavía declaran peers de React 18, por eso el
`--legacy-peer-deps`.

### Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | Next en desarrollo |
| `npm run build` | Build de producción |
| `npm start` | Sirve el build |
| `npm run typecheck` | `tsc --noEmit` sobre la app |
| `npm run typecheck:scripts` | `tsc --noEmit` sobre `scripts/`, que queda fuera del build de Next |
| `npm test` | `vitest run`, la suite completa |
| `npm run test:core` | Solo dominio y aplicación, sin infraestructura ni componentes |
| `npm run qa` | La puerta completa: lint, los dos typechecks y la suite |
| `npm run smoke:solana` | Smoke end to end contra devnet. Opt in, ver arriba |
| `npm run lint` | `biome lint src app scripts` |

## Tests

**151 archivos de test**, todos en verde. Ese número no es una afirmación que haya que creer:
`src/composition/readme-test-count.test.ts` cuenta el árbol en cada corrida y pone la suite roja si esta
línea se le despega. Para el número de casos individuales, corré `npm test`, que lo imprime. Se reparten
en:

- Dominio y aplicación con dobles de prueba, sin red ni wallet ni navegador. Ahí viven las invariantes
  del camino del dinero: no se confirma sin identidad verificada y cotización vigente, la cotización
  vencida falla cerrado, la máquina de estados no admite saltos.
- Rutas de API, adaptadores de infraestructura y componentes con Testing Library.
- Contract tests contra copias pinneadas de lo que devuelven los servicios externos (`contracts/`): la
  cotización, el KYC, y los tres topes del sponsor del facilitator de Solana, pinneados el 2026-08-03
  por WKH-321. Si un proveedor cambia la forma de su respuesta y alguien re vendorea la copia, el
  test del consumidor se pone rojo en vez de romperse en producción. Un cuarto, el del payout, se
  retiró: su validador consumidor estaba dentro de un método que apuntaba a una ruta borrada, así que su
  verde no probaba nada. El motivo y el follow up están en `contracts/CONTRACT-VERSIONS.md`.
- El IDL del escrow pinneado por hash canónico (`contracts/idl/escrow-idl.hash.test.ts`), descrito
  arriba.
- Un guard contra el regreso del camino EVM que este repo supo tener
  (`src/composition/no-evm-surface.test.ts`). Recorre el árbol en cada corrida y falla contra una lista
  CERRADA y enumerada de imports, interruptores y patrones de address hexadecimal, y asserta que las
  rutas borradas no están como directorios, en vez de como handlers que devuelven 404. Su alcance es
  exactamente ese: cierra las puertas por las que el camino EVM se fue. No es una prohibición universal
  de toda librería Ethereum que exista, y cubrir un nombre nuevo es agregarlo a la lista, con su motivo.

```bash
npm test          # vitest run, la suite completa. Imprime archivos y casos
npm run qa        # lint + los dos typechecks + tests
```

### CI

`.github/workflows/ci.yml` corre `npm run lint`, `npm run typecheck`, `npm run typecheck:scripts`,
`npm test` y `npm run build` sobre Node 22, en cada push a `main` y en cada pull request. El script de
smoke queda deliberadamente afuera: es opt in y mueve tokens en devnet.

Hay un segundo workflow, `.github/workflows/reconcile-orphans.yml`, y es programado en vez de
disparado por un push. Una vez por hora (`23 * * * *`) queda declarado para llamar a la ruta admin de
reconciliación en producción con el secreto en un header, y para ponerse rojo si el transporte falla o
si la respuesta reporta filas que una persona tiene que mirar. Imprime sólo los contadores agregados,
nunca los ids de correlación: los logs de un repositorio público son públicos.

⛔ Estado al 2026-08-19, medido y no supuesto: **ese workflow no corrió ni una vez.** GitHub lista sólo
`ci.yml` en `gh api repos/ferrosasfp/chaski-v3/actions/workflows`,
`gh run list --workflow=reconcile-orphans.yml` contesta HTTP 404, y el repo tiene cero secrets de
Actions (`{"total_count":0}`). Mergear el archivo registra el schedule, que es la mitad fácil. La otra
mitad no lo es: sin el secreto cargado, el job falla en su primer paso sin llamar a la ruta, así que
cada corrida horaria es roja y no se reconcilia nada, hasta que alguien ejecute
`gh secret set RECONCILE_ADMIN_SECRET`. La tabla de estado medido está al principio de
[`docs/runbook-reconcile-orphans.md`](docs/runbook-reconcile-orphans.md). Leela antes de concluir que
hay un chequeo horario vigilando el ledger, porque hoy no hay ninguno.

Lo que no hace, una vez que sí corra, es montar guardia. Si GitHub retrasa o saltea un tick programado
no hay corrida, y por lo tanto nada se pone rojo. Ese agujero está escrito en vez de insinuado, en el
encabezado del workflow y en `docs/runbook-reconcile-orphans.md`, que además dice qué hacer con cada
rojo.

## Arquitectura

Detalle capa por capa y la lista completa de rutas de API:
[`docs/architecture.md`](docs/architecture.md).

Clean Architecture, con la regla de dependencia apuntando hacia adentro.

```
presentation   ->  application (use cases + ports)  ->  domain
infrastructure ->  implementa los ports, se inyecta en el composition root
```

- **`src/domain/`** puro, sin dependencias. `Money` en unidades menores, cero floats. `Remittance` con
  la máquina de estados (`created`, `kyc_pending`, `kyc_passed`, `quoted`, `confirmed`, `principal_in`,
  `payout_submitted`, `settled`, `refunded`, y los estados de fallo) y las invariantes de negocio.
- **`src/application/`** los use cases y los ports que necesitan. Dependen solo de las interfaces, nunca
  de un adaptador concreto. Acá vive la frontera con los agentes: un use case le pide una cotización a
  un port, y que eso resuelva en un mock, en una URL conocida o en un agente elegido por capacidad es
  una decisión de cableado que él nunca ve.
- **`src/infrastructure/`** los adaptadores: wallet, escrow, settlement, atestaciones, ledger en
  Postgres, identidad, rate limiting, clientes de los agentes.
- **`src/composition/container.ts`** el único lugar que conoce clases concretas. Ahí viven los guards
  que hacen que una configuración incoherente rompa al arrancar y no en medio de una transferencia.
- **`app/`** el shell de Next y las rutas de API server only, que son las que hablan con los servicios
  externos con las keys del lado del servidor.

Que el dominio no sepa nada de React ni de `@solana/web3.js` es lo que permite probar el camino del
dinero con dobles, en milisegundos, sin navegador. Es también lo que hace reemplazables a los agentes:
lo que se cambia es un adaptador detrás de un port, no una rama de la lógica de negocio.

## Configuración

`.env.example` documenta las variables que leen `src/` y `app/`, más las dieciséis que lee el script de
smoke de devnet, en una sección propia al final. No cubre lo que inyecta sola la plataforma de hosting.
El criterio de diseño es que **cada default sea el seguro**: con el archivo vacío la app levanta en modo
demo y no mueve fondos.

| Variable | Default | Efecto |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` | apagado | Tres efectos, no uno. Enciende el depósito al escrow y el patrocinio de gas, y desde WKH-336 además decide lo que la tarjeta del preview AFIRMA sobre la entrega: la fila "Entregar el dinero" deriva su transporte de esta bandera y no de `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`. Con el adapter en `fallback` y esta en `"true"` las dos filas dicen cosas distintas, y está bien: el payout sí pasa por el gateway. Apagada, la entrega no corre y tampoco se simula: falla cerrado con `settlement_unavailable` |
| `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` | `fallback` | Dos valores legales y ninguno más: `fallback` (gateways demo: cotización simulada; el ESTADO del payout ya NO lo decide esta bandera —WKH-337 lo lee del ledger— y tampoco es ella la que deja quieta la plata, es `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED`) y `a2a-gateway` (le pide una capacidad al gateway y el gateway resuelve el agente). Cualquier otro valor TIRA al arrancar, incluido `a2a`: era el carril punto a punto y WKH-332 lo borró, así que un entorno que quedó en ese valor falla ruidoso en vez de cablear los simuladores en silencio |

Los guards del composition root son fail loud. Encender el settlement sin mint o sin la pubkey del
facilitator hace que la app no arranque. La idea es que un error de configuración se vea al desplegar y
no cuando hay dinero en tránsito.

Hay un guard más, y su alcance es deliberado: el composition root aborta si encuentra variables de
entorno de un camino de settlement que este código no tiene. Esa configuración vive fuera del código, en
el panel del proveedor de hosting, que es el único lugar donde puede quedar huérfana sin que nadie se
entere.

Las migraciones de la base están en `supabase/migrations/`.

## Stack

Next 16 con App Router, React 19, TypeScript en modo estricto, Tailwind, Vitest. `@coral-xyz/anchor`,
`@solana/web3.js` y `@solana/wallet-adapter-*` para Solana; `tweetnacl` y `bs58` para la prueba de
posesión ed25519.

## Licencia

MIT. Ver [LICENSE](LICENSE).
