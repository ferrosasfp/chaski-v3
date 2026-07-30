# Chaski

App de remesas cripto a fiat, no custodial. El que envía conecta su wallet, el principal
queda bloqueado en un escrow on chain, y recién cuando el pago en destino está confirmado
la autoridad de release lo libera. El operador nunca tiene la custodia del dinero.

El principal viaja por **Solana**. El escrow es un programa **Anchor** en devnet, sin plata
real. El resto del ecosistema es multichain: el marketplace de agentes vive en Avalanche, y
el settlement lo coordina un facilitator con un adaptador por red.

> **Estado.** Devnet, sin dinero real. La configuración por defecto del repo no mueve
> fondos: los caminos de settlement están detrás de flags que arrancan apagadas. Ver
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
- Ledger de settlement en Postgres, con el registro de la VM y la red usadas en cada fila.

En construcción o apagado a propósito:

- El desembolso a fiat corre contra un adaptador mock por defecto. El adaptador real existe
  y está cableado, pero exige credenciales de proveedor que no están en este repo.
- El camino de settlement EVM (firma EIP-3009 sobre Base) está implementado y apagado. Es
  mutuamente excluyente con el camino Solana: encender los dos a la vez hace que la app no
  arranque, a propósito.
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

**819 casos en 68 archivos**, todos en verde. Se reparten en:

- Dominio y aplicación con dobles de prueba, sin red ni wallet ni navegador. Ahí viven las
  invariantes del camino del dinero: no se confirma sin identidad verificada y cotización
  vigente, la cotización vencida falla cerrado, la máquina de estados no admite saltos.
- Rutas de API, adaptadores de infraestructura y componentes con Testing Library.
- Contract tests contra copias pinneadas del output de cada servicio externo
  (`contracts/`). Si un proveedor cambia la forma de su respuesta y alguien re vendorea la
  copia, el test del consumidor se pone rojo en vez de romperse en producción.
- Golden tests del cuerpo de la firma EIP-3009 y del payload de atestación de depósito.

```bash
npm test          # 819 tests
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
   un desafío, atado a la red vía CAIP-2 para que no se pueda reusar en otra cadena.
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
- **`src/infrastructure/`** los adaptadores: wallets EVM y Solana, escrow, settlement,
  atestaciones, ledger en Postgres, identidad, rate limiting, clientes de los agentes.
- **`src/composition/container.ts`** el único lugar que conoce clases concretas. Ahí viven
  los guards que hacen que una configuración incoherente rompa al arrancar y no en medio de
  una transferencia.
- **`app/`** el shell de Next y las rutas de API server only, que son las que hablan con los
  servicios externos con las keys del lado del servidor.

Que el dominio no sepa nada de React ni de `@solana/web3.js` es lo que permite probar el
camino del dinero con dobles, en milisegundos, sin navegador.

### Multichain

La app no asume una sola cadena. `NEXT_PUBLIC_VM` elige la máquina virtual de settlement y
un solo dispatcher gobierna el cableado del wallet, así que no hay modo mixto silencioso.
Hoy conviven dos caminos:

- **Solana** para el principal, con el escrow no custodial descrito arriba.
- **EVM** sobre Base, con firma EIP-3009, implementado y apagado.

El agente que cotiza el FX se resuelve en tiempo de ejecución: la app le pregunta al gateway
A2A por la capability que necesita y llama al agente que le devuelve, sin URL ni slug fijos
en el código, con una agent key propia del lado del servidor. Es fail closed, así que si el
gateway no responde la operación corta en vez de caer a una llamada directa. Ese camino está
detrás de una flag y arranca apagado.

La verificación de identidad y el desembolso todavía se integran punto a punto, no por el
gateway. Llevarlos al mismo riel es trabajo pendiente, y el desembolso además tiene que
preservar la atestación que ata la dirección de depósito a la remesa.

El marketplace de agentes corre sobre Avalanche. El settlement lo coordina un facilitator con
un adaptador por red, que es lo que permite que el principal viaje por una cadena y el resto
del ecosistema viva en otra.

## Configuración

Todas las variables están documentadas en `.env.example`. El criterio de diseño es que
**cada default sea el seguro**: con el archivo vacío la app levanta en modo demo y no mueve
fondos.

| Variable | Default | Efecto |
|---|---|---|
| `NEXT_PUBLIC_VM` | `evm` en el código, **`solana` en `.env.example`** | Chaski corre hoy sobre Solana. El archivo de ejemplo trae `solana` para que un clon limpio levante el camino real; el default del código se invierte cuando se elimine el interruptor |
| `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` | apagado | Enciende depósito al escrow y patrocinio de gas |
| `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` | `fallback` | `a2a` o `a2a-gateway` usan los agentes reales |
| `NEXT_PUBLIC_EIP3009_ENABLED` | apagado | Firma EIP-3009 real en el camino EVM |

Los guards del composition root son fail loud. Encender la firma EIP-3009 sin un adaptador
real, o sin dirección receptora, o con una dirección malformada, hace que la app no arranque.
Lo mismo con el camino Solana sin mint o sin la pubkey del facilitator. La idea es que un
error de configuración se vea al desplegar y no cuando hay dinero en tránsito.

Las migraciones de la base están en `supabase/migrations/`.

## Stack

Next 16 con App Router, React 19, TypeScript en modo estricto, Tailwind, Vitest.
`@coral-xyz/anchor` y `@solana/web3.js` para Solana, `viem` y `wagmi` para EVM.

## Licencia

MIT. Ver [LICENSE](LICENSE).
