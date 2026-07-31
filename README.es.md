[English](README.md)

# Chaski

Chaski es una app de remesas cripto a fiat que nunca toma la custodia del dinero. El que envía conecta
su wallet y el principal queda bloqueado en una cuenta de escrow en Solana. Una autoridad de release
puede moverlo únicamente al beneficiario que quedó fijado en el momento del depósito, y sólo cuando el
pago en el país de destino está confirmado. Si eso no pasa, el que envía firma un refund y recupera su
propia plata sin permiso de nadie. El escrow es un programa Anchor en devnet, sin dinero real.

> **Estado.** Devnet. La configuración por defecto del repo no mueve nada: el settlement está detrás
> de una flag que arranca apagada, y el desembolso a fiat corre contra un adaptador mock. Ver
> [Configuración](#configuración) para el detalle de qué enciende qué.

> **Sobre el nombre.** El proyecto de hosting se creó como `chaski-v2` y su nombre no se puede cambiar
> desde este repo, así que el sitio desplegado se sirve en `chaski-v2.vercel.app`. Es el mismo
> proyecto que este, con el nombre viejo. Esa misma cadena sobrevive a propósito en el campo `id` de
> `public/manifest.json`: cambiar el `id` de un manifest PWA deja huérfanas las instalaciones
> existentes, que es peor que una cadena vieja en un archivo de configuración.

## Qué hace hoy y qué no

Funcionando en devnet:

- Flujo completo de producto: monto con preview de tasa, conexión de wallet, verificación de
  identidad, revisión, confirmación, seguimiento y recibo.
- Depósito no custodial al escrow, firmado por la wallet del que envía. La transacción la paga un fee
  payer patrocinador, así que el usuario nunca necesita SOL.
- Release y refund contra el escrow. La autoridad de release corre del lado del servidor y su clave
  privada no vive en este repo.
- Índice on chain de los escrows de un sender, para poder recuperar una remesa cuyo identificador
  local se perdió.
- Ledger de settlement en Postgres que registra la red de cada fila como identificador CAIP-2
  (`solana:devnet`). La columna conserva además un discriminador heredado, porque describe filas ya
  escritas: podar código no es reescribir la historia de la base.

En construcción o apagado a propósito:

- El desembolso a fiat corre contra un adaptador mock por defecto. El adaptador real existe y está
  cableado, pero exige credenciales de proveedor que no están en este repo.
- Nada de esto apunta a mainnet. El script de smoke aborta si el cluster no es devnet.

## El camino del dinero

El escrow es un programa Anchor deployado en devnet:

```
DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x
```

Seis instrucciones: `deposit`, `release`, `refund`, `close`, `register_escrow`, `deregister_escrow`.

**El código fuente de ese programa NO está en este repo.** Acá no hay ningún `.rs`, ni `Anchor.toml`,
ni `Cargo.toml`, y `contracts/` tiene contract tests en TypeScript, no Rust. El programa Anchor vive
en [`ferrosasfp/solana-programs`](https://github.com/ferrosasfp/solana-programs), en
`programs/escrow/src/lib.rs`, y es público. Lo que sí vive acá es el lado consumidor: el IDL del
programa, vendoreado y pinneado por hash canónico, como se describe abajo.

El estado por remesa vive en una PDA derivada de `[b"escrow", sender, remittance_id]`, donde
`remittance_id` es un array de 16 bytes. Los fondos viven en la associated token account de esa PDA
para el mint, así que la dirección del vault es función de la cuenta de escrow y no se puede apuntar a
otro lado.

El ciclo:

1. La app le pide al servidor los parámetros del depósito. Si la pubkey de la autoridad de release no
   está configurada, el servidor responde 503 en vez de seguir.
2. La wallet del que envía firma `deposit`, que toma `beneficiary`, `authority`, `amount` y `deadline`
   como argumentos. El USDC sale de su cuenta y queda en el vault del escrow. El operador no lo toca.
3. El facilitator cofirma como fee payer y hace el broadcast, así el usuario no necesita SOL. Para
   pedir ese patrocinio hay que probar posesión de la clave: una firma ed25519 sobre un desafío
   emitido por el servidor, atado a la red por su identificador CAIP-2 para que no se pueda reusar
   contra otro cluster.
4. Con el pago en destino confirmado, la autoridad de release firma `release`. `sender`, `beneficiary`
   y `mint` están restringidos por `has_one` contra la cuenta de escrow, así que el destino es el que
   quedó fijado en el depósito y la autoridad no puede redirigir los fondos.
5. Si algo falla, el que envía firma `refund` y el principal vuelve a quien lo depositó, sin ninguna
   otra firma. El programa lo rechaza si el escrow no está en estado `Deposited` y si el deadline
   todavía no venció (`EscrowNotDeposited` 6002, `DeadlineNotReached` 6003).

### El IDL está pinneado por hash

El IDL del programa está vendoreado en `src/infrastructure/solana/escrow-idl.ts` y su SHA-256 canónico
está fijado en `contracts/idl/escrow-idl.hash.test.ts`, que corre en cada `npm test`. El mismo test
pinnea además el program id y el orden posicional de las cuentas de `deposit`, `refund` y
`register_escrow`. Si alguien edita el IDL vendoreado a mano, o el programa deployado reordena sus
cuentas, la suite se pone roja antes de que una transacción se rechace en producción. Re pinnear es
una decisión explícita con su entrada en `contracts/CONTRACT-VERSIONS.md`, nunca un drift silencioso.
El valor pinneado coincide con el que tiene `wasiai-facilitator`.

### Smoke de devnet

`npm run smoke:solana` corre el ciclo ON CHAIN completo contra servicios ya desplegados: healthchecks,
prueba de posesión, `/api/payout/prepare`, la instrucción `deposit` firmada por el sender, el broadcast
gasless vía el facilitator, la verificación del escrow (estado, saldo del vault y beneficiario), el
release contra el facilitator y la relectura de la cadena hasta ver el escrow liberado y el vault en
cero. Está deliberadamente incómodo de ejecutar:

- Aborta antes de cualquier llamada si no está `SMOKE_ALLOW_REAL=true`. No corre en CI.
- Las URLs de los servicios, las keys, los identificadores, el monto, el mint y la pubkey del
  facilitator son todas variables de entorno: son trece requeridas, listadas y validadas una por una
  en `scripts/smoke-solana-e2e.ts:55-78` y documentadas en `.env.example`. Si falta alguna, el script
  aborta e imprime el nombre de la variable, nunca su valor.
- Dos entradas NO son variables, y cada una tiene su motivo. El cluster es la constante
  `CLUSTER = "devnet"` (`:46`): no hay variable de entorno que pueda apuntar este script a mainnet. El
  endpoint de RPC sí tiene default: `SMOKE_SOLANA_RPC_URL` si la seteás, y si no
  `clusterApiUrl("devnet")` (`:108`), que es el endpoint público de devnet. `SMOKE_DEADLINE_SECONDS`
  también tiene default, una hora.
- **Lo que el smoke NO prueba, y lo imprime en cada corrida.** La atestación que autoriza el release la
  calcula el propio script con el secreto compartido. En el diseño del sistema esa atestación certifica
  que el KYC se aprobó y que la orden fiat se completó, así que un script que se la firma a sí mismo
  prueba la pata on chain y no prueba nada de la pata fiat. Y hay algo más grande: hoy no existe, en
  ninguno de los tres repos, un componente que decida llamar al release. Ese paso lo ejecuta una persona
  a mano, y el smoke está sustituyendo a ese actor ausente. El smoke demuestra que las piezas on chain
  funcionan cuando alguien las llama en orden, no que el sistema las llame solo.
- La proveniencia del payout se imprime como parte del resultado: el único valor que significa
  desembolso fiat real es `transfi`, y si aparece, el script aborta (el alcance autorizado es devnet sin
  dinero real).

## Correr el proyecto

Requiere Node 22 (probado en 22.22.0).

```bash
git clone https://github.com/ferrosasfp/chaski-v3.git
cd chaski-v3
npm install --legacy-peer-deps
cp .env.example .env.local     # todo vacío arranca en modo demo, sin mover fondos
npm run dev                    # http://localhost:3000
```

El árbol de dependencias mezcla React 19 con paquetes que todavía declaran peers de React 18, por eso
el `--legacy-peer-deps`.

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

**697 casos en 56 archivos**, todos en verde. Se reparten en:

- Dominio y aplicación con dobles de prueba, sin red ni wallet ni navegador. Ahí viven las invariantes
  del camino del dinero: no se confirma sin identidad verificada y cotización vigente, la cotización
  vencida falla cerrado, la máquina de estados no admite saltos.
- Rutas de API, adaptadores de infraestructura y componentes con Testing Library.
- Contract tests contra copias pinneadas del output de dos servicios externos, la cotización y el KYC
  (`contracts/`). Si un proveedor cambia la forma de su respuesta y alguien re vendorea la copia, el
  test del consumidor se pone rojo en vez de romperse en producción. El tercero, el del payout, se
  retiró: su validador consumidor estaba dentro de un método que apuntaba a una ruta borrada, así que
  su verde no probaba nada. El motivo y el follow up están escritos en `contracts/CONTRACT-VERSIONS.md`.
- El IDL del escrow pinneado por hash canónico (`contracts/idl/escrow-idl.hash.test.ts`), descrito
  arriba.
- Un guard contra el regreso del camino EVM que este repo supo tener
  (`src/composition/no-evm-surface.test.ts`). Recorre `src/`, `app/`, `scripts/` y `contracts/` en
  cada corrida y falla contra una lista CERRADA y enumerada: imports de `viem` y sus submódulos, de
  `wagmi` y de `@walletconnect/ethereum-provider`; el interruptor `NEXT_PUBLIC_VM`; los validadores de
  address hexadecimal `isAddress(` e `isAddressEqual(`; y las regex `0x` de 40 dígitos hex escritas a
  mano. Además asserta que esos tres paquetes no están ni en `dependencies` ni en `devDependencies`, y
  que nueve rutas y archivos borrados no están en el árbol, `app/api/settle/principal` entre ellos,
  comprobado como "el directorio no existe" y no como "el handler devuelve 404".

  Ese es su alcance exacto: cierra las puertas por las que el camino EVM se fue, para que no pueda
  volver por ellas ni por descuido ni por un merge. No es una prohibición universal de toda librería
  Ethereum que exista. Un `npm i ethers` más un import lo pasa en verde, y lo mismo `web3`,
  `@ethersproject/*` o `thirdweb`. Cubrir un nombre nuevo es agregarlo a la lista, con su motivo.

```bash
npm test          # 697 tests en 56 archivos
npm run qa        # lint + los dos typechecks + tests
```

### CI

`.github/workflows/ci.yml` corre `npm run lint`, `npm run typecheck`, `npm run typecheck:scripts`,
`npm test` y `npm run build` sobre Node 22, en cada push a `main` y en cada pull request. El script de
smoke queda deliberadamente afuera: es opt in y mueve USDC en devnet.

## Arquitectura

Detalle capa por capa, la lista completa de rutas de API y qué cubre y qué NO cubre el guard anti EVM:
[`docs/architecture.md`](docs/architecture.md).

Clean Architecture, con la regla de dependencia apuntando hacia adentro.

```
presentation   ->  application (use cases + ports)  ->  domain
infrastructure ->  implementa los ports, se inyecta en el composition root
```

- **`src/domain/`** puro, sin dependencias. `Money` en unidades menores, cero floats. `Remittance` con
  la máquina de estados (`created`, `kyc_pending`, `kyc_passed`, `quoted`, `confirmed`,
  `principal_in`, `payout_submitted`, `settled`, `refunded`, y los estados de fallo) y las invariantes
  de negocio.
- **`src/application/`** los use cases y los ports que necesitan. Dependen solo de las interfaces,
  nunca de un adaptador concreto.
- **`src/infrastructure/`** los adaptadores: wallet, escrow, settlement, atestaciones, ledger en
  Postgres, identidad, rate limiting, clientes de los agentes.
- **`src/composition/container.ts`** el único lugar que conoce clases concretas. Ahí viven los guards
  que hacen que una configuración incoherente rompa al arrancar y no en medio de una transferencia.
- **`app/`** el shell de Next y las rutas de API server only, que son las que hablan con los servicios
  externos con las keys del lado del servidor.

Que el dominio no sepa nada de React ni de `@solana/web3.js` es lo que permite probar el camino del
dinero con dobles, en milisegundos, sin navegador.

El agente que cotiza el FX se resuelve en tiempo de ejecución: la app le pregunta al gateway A2A por
la capability que necesita y llama al agente que le devuelve, sin URL ni slug fijos en el código, con
una agent key propia del lado del servidor. Es fail closed, así que si el gateway no responde la
operación corta en vez de caer a una llamada directa. Ese camino está detrás de una flag y arranca
apagado.

La verificación de identidad y el desembolso todavía se integran punto a punto, no por el gateway.
Llevarlos al mismo riel es trabajo pendiente, y el desembolso además tiene que preservar la atestación
que ata la dirección de depósito a la remesa.

## Configuración

`.env.example` documenta las variables que leen `src/` y `app/`, más las catorce que lee el script de
smoke de devnet, en una sección propia al final. No cubre lo que inyecta sola la plataforma de
hosting: `VERCEL_ENV` es la única de esas que el código lee, y también está explicada ahí. El criterio
de diseño es que **cada default sea el seguro**: con el archivo vacío la app levanta en modo demo y no
mueve fondos.

| Variable | Default | Efecto |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` | apagado | Enciende el depósito al escrow y el patrocinio de gas |
| `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` | `fallback` | `a2a` o `a2a-gateway` usan los agentes reales |

Los guards del composition root son fail loud. Encender el settlement sin mint o sin la pubkey del
facilitator hace que la app no arranque. La idea es que un error de configuración se vea al desplegar
y no cuando hay dinero en tránsito.

Hay un guard más, y su alcance es deliberado: el composition root aborta si encuentra variables de
entorno de un camino de settlement que este código no tiene. Esa configuración vive fuera del código,
en el panel del proveedor de hosting, que es el único lugar donde puede quedar huérfana sin que nadie
se entere.

Las migraciones de la base están en `supabase/migrations/`.

## Stack

Next 16 con App Router, React 19, TypeScript en modo estricto, Tailwind, Vitest. `@coral-xyz/anchor`,
`@solana/web3.js` y `@solana/wallet-adapter-*` para Solana; `tweetnacl` y `bs58` para la prueba de
posesión ed25519.

## Licencia

MIT. Ver [LICENSE](LICENSE).
