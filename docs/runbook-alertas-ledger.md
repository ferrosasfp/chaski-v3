# Runbook — las alertas del ledger de settlements

> Escrito el 2026-08-12. Existe porque el código clasifica un `fund_failed` de TransFi en **tres
> situaciones que piden tres acciones distintas de una persona**
> (`src/infrastructure/persistence/webhook-failure-classes.ts`, primer párrafo del docblock) y **en
> ningún lado decía cuáles son esas tres acciones**. Este documento las dice.

## Antes que nada: nadie te va a avisar

⚠️ **Estas alertas no llegan a ningún canal.** `logLedgerAlert`
(`src/infrastructure/persistence/ledger-alert.ts`) hace exactamente una cosa: un `console.error` con
el prefijo `[ledger][ALERT]`. El propio código lo declara en
`src/infrastructure/persistence/ledger-write-failure.ts`, en el comentario que empieza con
"NO HACE: alertar a nadie".

En la práctica eso significa que la línea vive en los logs de Vercel y **sólo aparece si alguien la
busca**. Mientras no haya un canal conectado, este runbook se ejecuta cuando alguien decide mirar,
no cuando algo pasa. Está declarado a propósito: preferimos que se lea así que fingir que hay una
guardia.

**Cómo mirar:** en los logs de la función de producción, buscar el string literal `[ledger][ALERT]`.

Ese prefijo tiene **dos emisores, y son dos señales distintas** (medido el 2026-08-12; el docblock de
`ledger-alert.ts` los declara y advierte que interpolar el prefijo a mano en un tercer lugar rompe la
lista en silencio):

| Función | Qué señala | ¿lo cubre este runbook? |
|---|---|---|
| `logLedgerAlert` | una escritura que **corrió** y no dejó la evidencia que correspondía | **sí**, es todo lo de abajo |
| `logLedgerWriteFailure` | una escritura que **falló** (el evento termina en `_failed`) | **no**, ver más abajo |

Así que mirá el sufijo del evento antes de seguir: si termina en `_failed`, no es ninguna de las tres
clases de este runbook.

### Si la línea termina en `_failed`

Es una falla de escritura del ledger, no una clasificación de `fund_failed` del proveedor. Trae
`code`, `kind` y `severity` además de los identificadores de correlación. Lo que hay que entender es
que **el registro puede haber quedado atrás del mundo**: la operación de dinero pudo ocurrir sin que
su fila lo refleje. La consecuencia práctica es que **no podés concluir nada del estado de la fila**
en ese caso, y la única fuente confiable es la cadena (procedimiento más abajo).

Este runbook **no** cubre el manejo completo de esa señal. Está declarado así en vez de improvisarlo.

## Las tres clases, y qué hacer con cada una

El evento del proveedor es siempre el mismo (`fund_failed`). Lo que las separa es **el estado previo
de la fila** en el ledger. Los tres literales viven en `webhook-failure-classes.ts` y en ningún otro
lado.

### 1. `transfi_fund_failed_no_principal` — la fila estaba en `prepared`

**Qué dice:** el ledger **no tiene registrado** un depósito nuestro.

⚠️ **Qué NO dice, y es la trampa de esta clase:** que no haya habido plata. Dice el estado del
**registro**, no el del mundo. Un depósito real puede dejar la fila en `prepared` si la escritura
best-effort de `recordSolanaPrincipalIn` falló de forma pasajera. El propio docblock de
`webhook-failure-classes.ts` lo advierte y pide que el comentario no prometa que no hubo plata.

**Acción:** **verificar en cadena antes de cerrar el caso** (procedimiento abajo). Si el escrow no
existe o no tiene fondos, no hay nada que recuperar y el caso se cierra. Si existe con fondos, tratalo
como la clase 2.

### 2. `transfi_fund_failed_principal_in_escrow` — la fila estaba en `principal_in` o `forward_error`

**Qué dice:** el principal está en el escrow y **no se liberó**.

**Acción:** el camino de recuperación es el **refund después del deadline**, que es un camino que el
programa ya soporta y la app ya expone. No hay pérdida: los fondos siguen en custodia y vuelven al
remitente. Verificá en cadena que el `status` sea `Deposited` y mirá el `deadline` para saber desde
cuándo se puede pedir el refund.

### 3. `transfi_fund_failed_principal_released` — la fila estaba en `submitted`

**Es la única de las tres que puede costar el principal, y la única que emite alerta.**

**Qué dice:** el proveedor **dijo** haber visto los USDC (mandó `asset_deposited`, que el ledger mapea
a `submitted`) y **después** avisó que el fiat no salió.

⚠️ **Qué NO dice:** que el release haya entrado en la cadena. Eso es el dicho del proveedor, no un
hecho verificado. La alerta es **el pedido de esa verificación, no su veredicto** — mismo fraseo que
usa `app/api/webhooks/transfi/route.ts` en el comentario de la alerta.

**Acción, en este orden:**

1. **Verificar en cadena si el release ocurrió** (procedimiento abajo).
2. Si el `status` on-chain es `Released` y el vault quedó en cero: los USDC salieron del escrow hacia
   la dirección de depósito del proveedor. Eso convierte el caso en un **reclamo contra el proveedor**,
   no en un problema recuperable en cadena. Escalá con el `payoutId` que trae la alerta.
3. Si el `status` on-chain sigue en `Deposited`: **el proveedor se equivocó** y el principal nunca
   salió. Tratalo como la clase 2 (refund tras el deadline).

El paso 3 no es hipotético y por eso está escrito: es exactamente la razón por la que el código no
afirma la pérdida.

## Cómo verificar un escrow en cadena

### Derivar la dirección

El escrow es una PDA con tres seeds, y la derivación vive en `deriveEscrowState` dentro de
`src/infrastructure/solana-wallet.ts`:

```
seeds = [ "escrow", <pubkey del sender>, <bytes del remittanceId> ]
programId = el programa del escrow (sale de la config, no lo claves)
```

### Leer el estado

⚠️ **`getProgramAccounts` no sirve.** No está en el tier gratuito de Alchemy (medido el 2026-08-12:
el mismo error con y sin header `Origin`, así que el muro es el plan, no la lista blanca), y el
endpoint público de devnet responde 429. **Usá `getAccountInfo` o `getMultipleAccounts` sobre la
dirección derivada**, con la clave de Alchemy y un header `Origin` que esté en su lista blanca —
un script no manda `Origin` solo y sin él la lista blanca lo rechaza.

La cuenta mide **154 bytes** y su layout, tomado del IDL publicado on-chain, es:

| offset | tamaño | campo |
|---|---|---|
| 0 | 8 | discriminador |
| 8 | 32 | `sender` |
| 40 | 32 | `beneficiary` |
| 72 | 32 | `authority` (la única llave que puede firmar `release`) |
| 104 | 32 | `mint` |
| 136 | 8 | `amount` (u64, 6 decimales para USDC) |
| 144 | 8 | `deadline` (i64, unix) |
| 152 | 1 | `status`: 0 `Deposited`, 1 `Released`, 2 `Refunded` |
| 153 | 1 | `bump` |

### Los dos datos que deciden

- **`status`** — `Deposited` significa que el principal sigue en custodia. `Released` o `Refunded`
  son estados terminales.
- **el saldo del vault** — el `amount` del estado es lo que se depositó, **no lo que queda**. Para
  saber si hay fondos hoy hay que mirar la cuenta de token del escrow
  (`getTokenAccountsByOwner` sobre la PDA). Un escrow `Released` con vault en cero no tiene nada que
  recuperar.

Confundir `amount` con "lo que queda" es el error que este cuadro existe para evitar.

## Lo que este runbook no cubre

- **No hay forma de listar todos los escrows** sin `getProgramAccounts`. Sólo se pueden inspeccionar
  direcciones que ya conocés o que puedas derivar. Si hace falta un inventario completo, se necesita
  un plan de RPC que habilite ese método.
- **No hay automatización.** Las tres acciones las ejecuta una persona.
- **No cubre el caso en que el ledger no tenga fila alguna.** Un depósito sin fila es un problema
  distinto y está trackeado por separado.
