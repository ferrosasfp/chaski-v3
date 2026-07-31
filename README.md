# Chaski

App de remesas cripto a fiat, no custodial. El que envía conecta su wallet, el principal
queda bloqueado en un escrow on chain, y recién cuando el pago en destino está confirmado
la autoridad de release lo libera. El operador nunca tiene la custodia del dinero.

El principal viaja por **Solana**. El escrow es un programa **Anchor** en devnet, sin plata
real. El settlement lo coordina un facilitator, que es el único servicio que transmite a la
red: esta app firma y verifica, nunca broadcastea por su cuenta.

> **Estado.** Devnet, sin dinero real. La configuración por defecto del repo no mueve
> fondos: el settlement está detrás de una flag que arranca apagada. Ver
> [Configuración](#configuración) para el detalle de qué enciende qué.

## Qué hace hoy y qué no

Funcionando en devnet:

- Flujo completo de producto: monto con preview de tasa, conexión de wallet, verificación
  de identidad, revisión, confirmación, seguimiento y recibo.
- Depósito no custodial al escrow Anchor en Solana devnet, firmado por la wallet del que
  envía. La transacción la paga un fee payer patrocinador, así que el usuario no necesita SOL.
- Release y refund contra el escrow, con la autoridad de release del lado del servidor. La
  clave privada de esa autoridad no vive en este repo.
- Índice on chain de escrows por remesa, para poder recuperar una operación cuyo
  identificador local se perdió.
- Ledger de settlement en Postgres, que registra la red de cada fila como identificador
  CAIP-2 (`solana:devnet`). La columna conserva además un discriminador heredado, porque
  describe filas ya escritas: podar código no es reescribir la historia de la base.

En construcción o apagado a propósito:

- El desembolso a fiat corre contra un adaptador mock por defecto. El adaptador real existe
  y está cableado, pero exige credenciales de proveedor que no están en este repo.
- Nada de esto apunta a mainnet. El script de smoke aborta si el cluster no es devnet.

## Correr el proyecto

Requiere Node 22 (probado en 22.22.0).

```bash
git clone https://github.com/ferrosasfp/chaski-v3.git
cd chaski-v3
npm install --legacy-peer-deps
cp .env.example .env.local     # todo vacío arranca en modo demo, sin mover fondos
npm run dev                    # http://localhost:3000
```

El árbol de dependencias mezcla React 19 con paquetes que todavía declaran peers de React 18,
por eso el `--legacy-peer-deps`.

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
| `npm run smoke:solana` | Smoke end to end contra devnet. Opt in, ver abajo |
| `npm run lint` | `biome lint src app scripts` |

## Tests

**692 casos en 57 archivos**, todos en verde. Se reparten en:

- Dominio y aplicación con dobles de prueba, sin red ni wallet ni navegador. Ahí viven las
  invariantes del camino del dinero: no se confirma sin identidad verificada y cotización
  vigente, la cotización vencida falla cerrado, la máquina de estados no admite saltos.
- Rutas de API, adaptadores de infraestructura y componentes con Testing Library.
- Contract tests contra copias pinneadas del output de cada servicio externo
  (`contracts/`). Si un proveedor cambia la forma de su respuesta y alguien re vendorea la
  copia, el test del consumidor se pone rojo en vez de romperse en producción.
- El IDL del programa de escrow está pinneado por hash canónico
  (`contracts/idl/escrow-idl.hash.test.ts`): si alguien edita el IDL vendoreado a mano, o el
  programa on chain cambia el orden de sus cuentas, la suite se pone roja antes de que una
  transacción se rechace en producción.
- Una garantía repo wide (`src/composition/no-evm-surface.test.ts`): recorre `src/`, `app/`,
  `scripts/` y `contracts/` en cada corrida y **falla si vuelve a aparecer superficie de otra
  máquina virtual** — un import de una librería de otra cadena, un validador de direcciones
  hexadecimales, un interruptor de VM, o una de las rutas eliminadas de vuelta en el árbol.
  Que este repo sea sólo Solana no depende de que alguien se acuerde: lo sostiene un test.

```bash
npm test          # 692 tests
npm run qa        # typechecks + tests
```

## El camino del dinero en Solana

El escrow es un programa Anchor en devnet:

```
DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x
```

Seis instrucciones: `deposit`, `release`, `refund`, `close`, `register_escrow`,
`deregister_escrow`. El estado por remesa vive en una PDA derivada del identificador de la
remesa, y los fondos en un vault asociado a esa PDA.

El ciclo:

1. La app pide al servidor los parámetros del depósito. Si la pubkey de la autoridad de
   release no está configurada, responde 503 en vez de seguir.
2. La wallet del que envía firma la instrucción `deposit`. El USDC sale de su cuenta y queda
   en el vault del escrow. El operador no lo toca.
3. El facilitator cofirma como fee payer y hace el broadcast, así el usuario no necesita SOL.
   Para pedir ese patrocinio hay que probar posesión de la clave con una firma ed25519 sobre
   un desafío, atado a la red vía CAIP-2 para que no se pueda reusar en otro cluster.
4. Con el pago en destino confirmado, la autoridad de release ejecuta `release`. Si algo
   falla, `refund` devuelve el principal a quien lo depositó, sin permiso de nadie más.

### IDL pinneado

El IDL del programa está copiado en `src/infrastructure/solana/escrow-idl.ts` y su hash
SHA-256 canónico está fijado en `contracts/idl/canonical-hash.ts`. El test
`contracts/idl/escrow-idl.hash.test.ts` compara uno contra otro en cada corrida: si alguien
edita el IDL a mano, la suite se pone roja. Re pinnear es una decisión explícita, con su
entrada en la bitácora de `contracts/CONTRACT-VERSIONS.md`, nunca un drift silencioso.

### Smoke de devnet

`npm run smoke:solana` corre el ciclo completo contra servicios ya desplegados. Está
deliberadamente incómodo de ejecutar:

- Aborta antes de cualquier llamada si no está `SMOKE_ALLOW_REAL=true`. No corre en CI.
- Todas sus entradas son variables de entorno. No hay ninguna URL, key, cluster ni mint
  hardcodeados. Si falta una, aborta e imprime el nombre de la variable, nunca su valor.
- El cluster es `devnet` como constante del script. No hay fallback a mainnet.

## Arquitectura

Clean Architecture, con la regla de dependencia apuntando hacia adentro.

```
presentation   ->  application (use cases + ports)  ->  domain
infrastructure ->  implementa los ports, se inyecta en el composition root
```

- **`src/domain/`** puro, sin dependencias. `Money` en unidades menores, cero floats.
  `Remittance` con la máquina de estados (`created`, `kyc_pending`, `kyc_passed`, `quoted`,
  `confirmed`, `principal_in`, `payout_submitted`, `settled`, `refunded`, y los estados de
  fallo) y las invariantes de negocio.
- **`src/application/`** los use cases y los ports que necesitan. Dependen solo de las
  interfaces, nunca de un adaptador concreto.
- **`src/infrastructure/`** los adaptadores: wallet Solana, escrow, settlement, atestaciones,
  ledger en Postgres, identidad, rate limiting, clientes de los agentes.
- **`src/composition/container.ts`** el único lugar que conoce clases concretas. Ahí viven
  los guards que hacen que una configuración incoherente rompa al arrancar y no en medio de
  una transferencia.
- **`app/`** el shell de Next y las rutas de API server only, que son las que hablan con los
  servicios externos con las keys del lado del servidor.

Que el dominio no sepa nada de React ni de `@solana/web3.js` es lo que permite probar el
camino del dinero con dobles, en milisegundos, sin navegador.

El agente que cotiza el FX se resuelve en tiempo de ejecución: la app le pregunta al gateway
A2A por la capability que necesita y llama al agente que le devuelve, sin URL ni slug fijos
en el código, con una agent key propia del lado del servidor. Es fail closed, así que si el
gateway no responde la operación corta en vez de caer a una llamada directa. Ese camino está
detrás de una flag y arranca apagado.

La verificación de identidad y el desembolso todavía se integran punto a punto, no por el
gateway. Llevarlos al mismo riel es trabajo pendiente, y el desembolso además tiene que
preservar la atestación que ata la dirección de depósito a la remesa.

## Configuración

Todas las variables están documentadas en `.env.example`. El criterio de diseño es que
**cada default sea el seguro**: con el archivo vacío la app levanta en modo demo y no mueve
fondos.

| Variable | Default | Efecto |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` | apagado | Enciende depósito al escrow y patrocinio de gas |
| `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` | `fallback` | `a2a` o `a2a-gateway` usan los agentes reales |

Los guards del composition root son fail loud. Encender el camino Solana sin mint o sin la
pubkey del facilitator hace que la app no arranque. La idea es que un error de configuración
se vea al desplegar y no cuando hay dinero en tránsito.

Hay un guard más, y su alcance es deliberado: el composition root aborta si encuentra
variables de entorno de un camino de settlement que ya no existe en este código. Vive fuera
del código, en el panel del proveedor de hosting, que es el único lugar donde esa
configuración puede quedar huérfana sin que nadie se entere.

Las migraciones de la base están en `supabase/migrations/`.

## Stack

Next 16 con App Router, React 19, TypeScript en modo estricto, Tailwind, Vitest.
`@coral-xyz/anchor`, `@solana/web3.js` y `@solana/wallet-adapter-*` para Solana; `tweetnacl`
y `bs58` para la prueba de posesión ed25519.

## Licencia

MIT. Ver [LICENSE](LICENSE).
