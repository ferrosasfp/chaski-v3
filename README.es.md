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

**El depósito es la pieza más sólida, y la salvedad importa.** La instrucción entra en la cadena, la
wallet del que envía es la única que firma la transferencia, y un fee payer patrocinador cubre las fees
así el usuario nunca necesita SOL. Lo que prueba la firma de arriba es que eso funciona cuando lo
maneja el script de smoke. Si entra desde un navegador **todavía no está verificado**: el bloqueo de
protocolo que describe el párrafo siguiente ya no está, pero nadie recorrió la vuelta completa con una
extensión de wallet real. Esa prueba es la W7 del SDD 037 y sigue pendiente, así que lo honesto es decir
"sin verificar", no "anda" y tampoco "no anda".

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

Lo que sí queda abierto en esta pata es la vuelta completa desde el navegador (la W7 de arriba) y una
pieza de configuración: el facilitator necesita `SOLANA_SPONSOR_NETWORK_ID` seteada, y mientras no lo
esté rechaza todo pedido de patrocinio. El orden en que se despliegan los dos repos no importa, porque
el camino hoy está muerto en las dos direcciones: un cliente viejo manda `popProof` y se lleva un 400
sin que se firme nada, y un cliente nuevo manda una firma que el servidor viejo ignora y muere en el
mismo 400.

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
3. El facilitator cofirma como fee payer y hace el broadcast, así el usuario no necesita SOL. Este es el
   paso que hoy está cortado desde el navegador, por el motivo descrito arriba.
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

**126 archivos de test**, todos en verde. Ese número no es una afirmación que haya que creer:
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
