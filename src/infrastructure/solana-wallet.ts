// src/infrastructure/solana-wallet.ts
// SolanaWalletAdapter implements WalletPort — puente React-free hacia el árbol Solana vía el
// singleton bridge. NUNCA importa @solana/wallet-adapter-* (seam AC-3). Valida base58 con PublicKey
// de @solana/web3.js (CD-SDD-5), NUNCA con un validador hexadecimal. connect()/getAddress()/signMessage() son
// de HU-SOL-4 (NO se tocan). authorizePrincipal (HU-SOL-5) construye la ix `deposit` del escrow
// Anchor, fija feePayer=facilitator, partial-signa SÓLO con la wallet (bridge) y devuelve la tx
// serializada base64 — NUNCA broadcastea (CD-SDD-1, AC-3): el broadcast es del facilitator (HU-SOL-14).
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import type {
  Connection as Web3Connection,
  Transaction as Web3Transaction,
  TransactionInstruction, TransactionError, // WKH-353: `TransactionError` va EN ESTA LÍNEA y no en una nueva, por la misma razón que ya está escrita dos veces más abajo: una línea nueva acá arriba rota TODAS las citas ancladas que este archivo recibe
} from "@solana/web3.js";
import type { Idl, Provider } from "@coral-xyz/anchor";
import type {
  CloseableEscrow,
  ConnectedWalletProbe,
  EscrowId16,
  EscrowRefundConfirmation,
  PrincipalDepositState,
  SolanaEscrowDeposit,
  SolanaEscrowDepositProbe,
  SolanaEscrowRefundResult,
  AutorizacionDelPrincipal, // WKH-356: OCUPA LA LÍNEA que dejó `SolanaPrincipalAuthorization` (que quedó sin uso al cambiar el retorno). Sustituirlo en el lugar, y no borrar una línea y agregar otra, es lo que deja este bloque en Δ0: las citas por número a este archivo apuntan de `:188` para abajo.
  SolanaRemittanceIdResolver, PruebaDePosesionPorEnlace, PruebaPorEnlace, // WKH-359: los DOS EN ESTA LÍNEA, no en dos nuevas — todas las citas ancladas a este archivo apuntan de `:188` para abajo y una línea nueva acá arriba las rota a todas (mismo motivo que WKH-349 y WKH-356, un par de líneas más abajo)
  SolanaSenderSolBalance,
  SolanaSenderSolBalanceProbe,
  SolanaCloseableEscrowLister, EscrowChainState, SolanaEscrowChainStateReader, // WKH-349: EN ESTA LÍNEA, no en dos nuevas — TODAS las citas ancladas a este archivo apuntan de `:188` para abajo, y una línea nueva acá arriba las rota a todas
  WalletPort,
} from "../application/ports";
import type { Quote } from "../domain/remittance";
import { isParseableIso } from "../domain/remittance";
import { buildSponsorPopMessage } from "./auth/sponsor-pop-message";
import {
  resolveSolanaComputeUnitLimit,
  resolveSolanaComputeUnitPriceMicroLamports, resolveSolanaDeeplinkEnabled, // WKH-358 (fix-pack): la 3ª condición del gate, EN ESTA LÍNEA por lo mismo que los otros
  resolveSolanaFacilitatorPubkey,
  resolveSolanaNetworkConfig,
  resolveSolanaNetworkId,
  resolveSolanaRpcUrlPublic,
  resolveSolanaUsdcMint,
} from "./chain";
import { ESCROW_INDEX_MAX_ENTRIES } from "./escrow-index-limits";
import { ESCROW_ID_LOOKUP_CEILING } from "./escrow-lookup-limits"; import { ESCROW_STATE_BATCH_CEILING, ESCROW_STATE_BATCH_TIMEOUT_MS } from "./escrow-history-limits"; // WKH-349: EN ESTA LÍNEA, no en una nueva — los imports de este archivo están ARRIBA de `:188` y una línea acá rota TODAS las citas ancladas que apuntan de ahí para abajo, que son las que este archivo recibe. Va pegado a `ESCROW_ID_LOOKUP_CEILING` y no a `ESCROW_INDEX_MAX_ENTRIES` a propósito: ése es justo el techo con el que el nuevo NO se confunde (uno lo pone el servidor del registro durable, el otro el RPC), y quien lea la línea ve los dos juntos
import { solanaWalletBridge } from "./solana-wallet-bridge"; import nacl from "tweetnacl"; import { anotarHuellaDeLaVuelta, anotarSitioDelCorte, HUELLA_ILEGIBLE, huella } from "./solana/deeplink/bitacora-del-corte"; /* WKH-373: el sitio del corte y la huella de la vuelta, EN ESTA MISMA LÍNEA (Δ0). ⛔ COMENTARIO DE BLOQUE Y NO `//`: esta línea sigue con más imports a la derecha, y un comentario de línea acá se los come a todos. */ import { almacenDeNavegador, leerViaje } from "./solana/deeplink/sesion"; import { terminarPreparado } from "./solana/deeplink/preparado"; import { type Almacen, terminarViaje } from "./solana/deeplink/sesion"; import type { FirmaPorEnlace } from "./solana/deeplink/firma-por-enlace"; import { construirNonceAdvance, direccionDelNonce, leerNonce } from "./solana/nonce-duradero"; import { SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT } from "../application/solana-escrow-rent"; import { leerEleccion } from "./solana/deeplink/conexion"; import type { BilleteraDeeplink } from "./solana/deeplink/protocol"; import { MARCA_POP_KYC, MARCA_POP_PAYOUT, iniciarPop, leerFirmaParaMensaje, leerPasoPop, leerPruebaPop } from "./solana/deeplink/pop-por-enlace"; import { DEEPLINK_POP_SIN_FIRMA, DEEPLINK_SIN_MEMORIA } from "./solana/deeplink/firma-por-enlace"; // WKH-359 — EN ESTA MISMA LÍNEA, por el mismo motivo que los de WKH-349 y WKH-356 de arriba: todas las citas ancladas a este archivo apuntan de `:188` para abajo y una línea nueva acá las rota a todas. // WKH-358 agregó los dos últimos por la MISMA razón que los siete de acá y ANTES de este comentario, no después. WKH-356: TODOS EN ESTA LÍNEA, no en siete nuevas — las citas por número a este archivo apuntan de `:188` para abajo y siete líneas acá arriba las rotan a todas. WKH-357 agregó los dos últimos por la MISMA razón y ANTES de este comentario, no después: cuatro imports de 062 quedaron una vez adentro de un `//` por pegarlos del lado equivocado

// HU-SOL-20/AC-2: tope de candidatos que el fallback del REFUND sondea on-chain — el camino que
// devuelve el PRINCIPAL.
//
// 🔴 ANTES ERA 10, Y ESO DESCARTABA FILAS QUE EL SERVIDOR YA HABÍA MANDADO. La route corta en
// `ESCROW_ID_LOOKUP_CEILING` (hoy 20) y este cliente pedía 10, así que hasta 10 ids llegaban y se
// tiraban. La justificación escrita era que "10 cubre de sobra un escrow reciente perdido": eso es una
// suposición sobre la conducta de la persona, no una restricción del sistema, y no costaba nada
// levantarla — el sondeo es UNA sola llamada `getMultipleAccounts` para 10 o para 20. Peor todavía: el
// camino del ALQUILER, que recupera centavos, sí miraba los 20. El más valioso miraba menos.
//
// Se EXPORTA porque el copy de "no encontramos nada" tiene que decir sobre CUÁNTOS envíos miramos, y
// escribir el número a mano al lado de la constante que lo decide es exactamente cómo nació la hora
// inventada que `RefundWindowNote` ya tuvo que arreglar una vez.
export const MAX_RECOVERY_CANDIDATES = ESCROW_ID_LOOKUP_CEILING;

// WKH-327/AC-8: tope de candidatos que el descubrimiento de CERRABLES sondea on-chain.
//
// Es el mismo techo, y ahora lo dice el código en vez de una prosa que pedía confianza: los dos derivan
// de `ESCROW_ID_LOOKUP_CEILING` y `escrow-lookup-limits.test.ts` falla si alguno vuelve a escribir un
// literal. Se conservan los DOS nombres a propósito, porque responden preguntas distintas y el copy de
// cada pantalla cita el suyo; lo que no puede volver a pasar es que difieran sin que nadie lo note.
//
// LÍMITE, dicho (L-8): un remitente con más filas que el techo NO ve las más viejas por ninguno de los
// dos caminos. Subirlo es una decisión de producto y se toma en un solo lugar.
export const MAX_CLOSEABLE_CANDIDATES = ESCROW_ID_LOOKUP_CEILING;

/**
 * Ventana de custodia que este cliente le pide al escrow: 2 horas.
 *
 * QUÉ ES: cuánto tiempo tiene el operador para completar la pata fiat antes de que el sender pueda
 * recuperar su plata. Mientras la ventana está abierta manda el operador (`release`); una vez
 * cerrada manda el sender (`refund`). El programa exige que el depósito caiga dentro de
 * `[now + 3600, now + 86400]` (`MIN_CUSTODY_SECS` / `MAX_CUSTODY_SECS`, `programs/escrow/src/lib.rs`
 * :111 y :119 del repo `solana-programs`), y rechaza con `DeadlineTooSoon` / `DeadlineTooFar`.
 *
 * POR QUÉ NO SALE DE `quote.expiresAt`, que es de donde salía antes: son dos cosas distintas que se
 * habían confundido. `expiresAt` dice cuándo vence la TASA; la ventana dice cuánto tiempo tiene el
 * operador para entregar. El TTL de la cotización es de 10 minutos
 * (`wasiai-remittance-agents/src/providers/fx.ts:170`), o sea DEBAJO del piso del programa: usarlo
 * como deadline hace que el programa rechace todos los depósitos.
 *
 * POR QUÉ 2 h Y NO EL PISO EXACTO DE 1 h: el `now` de esa comparación es el reloj del VALIDADOR
 * cuando la tx se ejecuta, no el del cliente cuando la arma. Pedir exactamente el piso es una
 * carrera que pierde toda tx que tarde más de cero segundos en entrar. Las ~1 h de margen absorben
 * la latencia de la firma del usuario, el partial-sign del facilitator y el desfasaje de relojes.
 *
 * PROVISORIO, igual que las dos constantes del programa y por la misma razón: el número que lo
 * fijaría es la medición del tiempo real de la pata fiat del proveedor, extremo a extremo, y hoy
 * ese número no existe. Subirlo alarga lo que el sender espera para poder recuperar su plata;
 * bajarlo achica el margen del operador. No tocar sin esa medición.
 */
export const CUSTODY_WINDOW_SECS = 2 * 60 * 60;

// Cuánto esperamos a que la cadena responda si el refund entró, antes de dejar de preguntar. Vencido,
// el resultado es INDETERMINADO (nunca un éxito, nunca un fracaso): la tx puede seguir viva. 30 s es
// menos que la vida útil de un blockhash (~60-90 s), así que "se acabó la espera" jamás significa
// "la tx ya no puede entrar".
const REFUND_CONFIRM_TIMEOUT_MS = 30_000;

/** Techo de la consulta de saldo de SOL. Es una lectura simple (sin firma ni confirmación) que corre
 *  dentro del camino que la persona espera mirando la pantalla, y su resultado sólo sirve para dar un
 *  mejor mensaje de error: no puede costar más de lo que ahorra. Vencido el techo, el resultado es
 *  "no pudimos preguntar", nunca "no tiene saldo". */
const SOL_BALANCE_PROBE_TIMEOUT_MS = 5_000;

/** WKH-327/AC-3 — techo de la sonda de la PDA `["escrow-index", sender]`. Mismo número y MISMA razón
 *  que SOL_BALANCE_PROBE_TIMEOUT_MS de acá arriba: es una lectura simple (sin firma ni confirmación)
 *  que corre dentro del camino que la persona espera mirando la pantalla. ⚠️ HAY UN CUARTO TECHO DE ESTA MISMA FAMILIA Y NO ESTÁ EN ESTE BLOQUE: `ESCROW_STATE_BATCH_TIMEOUT_MS` (el de `readEscrowStates`, el batch del historial) vive en `./escrow-history-limits.ts` junto a su techo de cantidad, porque TODAS las citas ancladas que este archivo recibe apuntan de `:188` para abajo y una línea nueva acá arriba las rota a todas.
 *
 *  Sin este techo, un `getAccountInfo` colgado (el RPC público que acepta la conexión y no contesta)
 *  deja a la persona mirando "Cerrando…" para siempre. Vencido el techo el resultado es "no pudimos
 *  preguntar", que ACÁ significa abortar sin firmar: ver `probeEscrowIndex`. */
const ESCROW_INDEX_PROBE_TIMEOUT_MS = 5_000; /** WKH-356/DT-9 — techo de las DOS lecturas de la cuenta de nonce de la rama de enlace (la de antes de armar la tx y la de la vuelta). MISMO número y MISMA razón que los tres de arriba, y va EN ESTA LÍNEA (no en una nueva) porque todas las citas por número que este archivo recibe apuntan de `:188` para abajo. Sin techo, un RPC que acepta la conexión y no contesta deja el botón girando para siempre; vencido el techo el resultado es `deeplink_blockhash_desconocido`, que NO es "venció el blockhash". ⚠️ EL NOMBRE DICE `BLOCKHASH` POR HISTORIA: hasta WKH-357 acotaba una sonda de frescura de blockhash, y renombrarlo costaría rotar las citas ancladas que este archivo recibe. Lo que acota hoy es un `getAccountInfo` sobre la cuenta de nonce. */ const BLOCKHASH_PROBE_TIMEOUT_MS = 5_000;

/**
 * WKH-347 — QUÉ escrow eligió el camino de recuperación, y POR CUÁL de las dos fuentes.
 *
 * Es una unión discriminada y no una cadena, y ésa es toda la razón por la que existe: lo que sale
 * del índice on-chain es un `EscrowId16` (los 16 bytes que la cadena consume) y NO es un
 * `remittanceId`. `sha256` no se invierte, así que del id16 no se vuelve. Con las dos cosas tipadas
 * como `string`, un id16 podía terminar interpolado en un copy, mandado al registro durable o
 * comparado con el del `localStorage`, y las tres son falsas. Acá el consumidor está OBLIGADO a
 * nombrar el caso antes de poder usar el valor.
 *
 * Vive en este módulo y no en `ports.ts` a propósito: no cruza ningún puerto. Un puerto ensanchado
 * que nadie usa es superficie muerta en el money-path.
 */
type EscrowRecoveryTarget =
  | { readonly via: "ledger"; readonly remittanceId: string }
  | { readonly via: "index"; readonly id16: EscrowId16 };

/** Marca interna: la tx ENTRÓ en un bloque y el programa la revirtió. Es un "no" MEDIDO, no una
 *  indeterminación, y por eso viaja como excepción y no como uno de los tres valores. */
class RefundTxReverted extends Error {}

/** Hermano exacto de RefundTxReverted, para el camino de `close`. Separado y no reusado: son dos
 *  transacciones distintas y mezclarlas haría que un `instanceof` de un camino atrape al del otro. */
class CloseTxReverted extends Error {}

/** Corre `p` con un techo de tiempo. El perdedor de la carrera queda con handler (Promise.race los
 *  attachea a los dos), así que no genera un rejection sin manejar; el timer se limpia siempre. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("confirm_timeout")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class SolanaWalletAdapter
  implements
    WalletPort,
    SolanaEscrowDepositProbe,
    SolanaSenderSolBalanceProbe,
    // WKH-327/AC-8: el descubrimiento de cerrables se le pregunta a la CADENA, no a un agente, así
    // que vive en el mismo adapter que ya es `probe` y `senderBalance` por la misma razón.
    SolanaCloseableEscrowLister,
    // WKH-327 (fix-pack AR/BLQ-BAJO-1): quién está conectado AHORA. Mismo adapter otra vez porque el
    // bridge que sabe la respuesta ya es suyo.
    ConnectedWalletProbe, SolanaEscrowChainStateReader, PruebaDePosesionPorEnlace // WKH-349: EN ESTA LÍNEA. El estado on-chain de los escrows del historial se le pregunta a la CADENA, así que vive en el mismo adapter por la misma razón que sus vecinos de arriba
{
  private address: string | null = null;

  // HU-SOL-20/AC-2: resolver OPCIONAL del remittanceId durable server-side. Ausente (modo demo o
  // wiring viejo) ⇒ `refundEscrow` sin id explícito falla fail-loud con `escrow_id_unavailable`; el
  // path con id presente NUNCA lo consulta (AC-6 byte-idéntico).
  // `confirmTimeoutMs` es inyectable SÓLO para que los tests no tengan que esperar 30 s de reloj real
  // (el default es el de producción). NUNCA para apagar la confirmación: no hay valor que la saltee.
  constructor(
    private readonly remittanceIdResolver?: SolanaRemittanceIdResolver,
    private readonly confirmTimeoutMs: number = REFUND_CONFIRM_TIMEOUT_MS, private readonly firmaPorEnlace?: FirmaPorEnlace, // WKH-356 — 3er parámetro, OPCIONAL y AL FINAL, EN ESTA LÍNEA (una línea nueva acá rota todas las citas por número que este archivo recibe de `:188` para abajo). AL FINAL para que `container.ts` —que pasa UN solo argumento— y los tests que pasan `confirmTimeoutMs` posicionalmente sigan compilando sin tocarse. Y OPCIONAL porque con el colaborador ausente este archivo ejecuta EXACTAMENTE el camino de hoy: la rama nueva vive entera adentro de un `if` y no ejecuta ni una línea. ⛔ NO se cablea en `container.ts` al cerrar 062 (falta la ola 4); lo mide T-062-21.
  ) {}

  async connect(): Promise<string> { const porEnlace = this.direccionDelViajeConectado(); if (porEnlace !== null) return porEnlace; // WKH-358/AC-1 — PEGADO A LA FIRMA, no en una línea propia: este archivo recibe 81 citas ancladas de acá para abajo y una línea de más las rota a todas (medido: 86 rotas cuando lo escribí en tres líneas nuevas). Si el gate está activo Y el viaje está conectado, la cuenta que contestó el connect por enlace vive SÓLO en `Viaje.direccion` y el bridge está vacío. ⛔ NO cachea en `this.address`: ver el docblock de `direccionDelViajeConectado`. Con el gate apagado esto devuelve `null` y lo de abajo corre BYTE-IDÉNTICO (AC-6)
    const state = solanaWalletBridge.getState();
    if (!state.connected || !state.publicKey) {
      solanaWalletBridge.openModal(); // abre el modal Phantom/Solflare (AC-2)
      await solanaWalletBridge.waitForConnection(); // throw en timeout/cancel (§flujo de error)
    }
    const base58 = solanaWalletBridge.getState().publicKey;
    if (!base58) throw new Error("wallet_not_connected");
    // Defensa en profundidad: valida base58 ANTES de cachear (espeja InjectedWallet:66).
    try {
      new PublicKey(base58);
    } catch {
      throw new Error("invalid_address");
    }
    this.address = base58; // OPACO, SIN toLowerCase (CD-3)
    return this.address;
  }

  /**
   * La address del sender. Devuelve lo que cacheó `connect()` y, si no hay nada, LA REHIDRATA DESDE
   * EL BRIDGE.
   *
   * ⚠️ EL FALLBACK NO ES DEFENSIVO: cubre un camino que el flujo recorre SIEMPRE. `this.address` vive
   * sólo en memoria y se escribe sólo en `connect()`, así que una recarga de la página lo borra — y hay
   * una navegación completa en el medio del flujo: el KYC se va a Didit y vuelve
   * (`window.location.href`, `flow.tsx:460`). Al volver, el resume salta derecho a `confirm` sin
   * pasar por `connect()` (`setStep`, `flow.tsx:208`). Antes, ahí `getAddress()` contestaba `null`.
   *
   * El bridge SÍ sobrevive a esa recarga, y no porque persista nada: lo repuebla el sync component
   * desde `useWallet()` en cuanto `autoConnect` reconecta (`setState`, `solana-providers.tsx:178`).
   * Leerlo es leer un objeto en memoria: NO abre el modal de wallet, NO pide una firma, NO llama a
   * `connect()`. Si autoConnect todavía no terminó, el estado dice `connected:false` y esto contesta
   * `null` — que es la verdad en ese instante, y el llamador ya la sabe distinguir.
   *
   * NO cachea lo que rehidrata, a propósito: la fuente de verdad es el bridge.
   *
   * ⚠️ LO QUE ESTA FUNCIÓN NO ES, y hace falta decirlo porque el nombre invita a creerlo: NO es "quién
   * está conectado ahora". Mientras `connect()` haya corrido en esta pestaña, devuelve el cache y no
   * mira el bridge — o sea que si la persona cambia de cuenta en Phantom, esto sigue contestando la
   * vieja. Para decidir si una firma que estamos por pedir puede prosperar, la pregunta correcta es
   * `getConnectedAddress()` de acá abajo.
   *
   * Valida base58 igual que `connect()`: lo que no puede entrar por una puerta tampoco entra por la
   * otra.
   */
  async getAddress(): Promise<string | null> { const porEnlace = this.direccionDelViajeConectado(); if (porEnlace !== null) return porEnlace; // WKH-358 — PEGADO A LA FIRMA (Δ0 de citas, ver `connect`). VA PRIMERO, ANTES DEL CACHE, y no es un detalle de orden: en el camino por enlace `connect()` no escribe `this.address`, así que el cache está vacío y el bridge también. Ésta es la única fuente que existe, y es de donde `authorizePrincipal` (`:560`) saca el `sender` que después el motor compara
    if (this.address) return this.address; // el MISMO base58 case-sensitive (AC-6)
    return this.getConnectedAddress(); // sin cache, la verdad la tiene el bridge
  }

  /**
   * WKH-327 (fix-pack AR/BLQ-BAJO-1) — quién está conectado EN ESTE INSTANTE, sin pasar por el cache.
   *
   * Es la mitad "viva" de `getAddress()`: el mismo código que ya corría cuando no había cache, ahora
   * con nombre propio y alcanzable siempre. La diferencia importa una sola vez y es la que motiva
   * todo esto: buscar con la billetera A, cambiar a B en Phantom sin recargar, y apretar "Cerrar y
   * recuperar". `getAddress()` contesta A (cache de `connect()`), esto contesta B, y sólo con B el
   * guard de AC-7 puede decir que no ANTES de abrir un diálogo de firma que B no puede satisfacer.
   *
   * Leer el bridge NO toca la red, NO abre el modal y NO pide ninguna firma: es un objeto en memoria
   * que el sync component mantiene al día desde `useWallet()` (`solana/solana-providers.tsx`). Si el
   * árbol todavía no montó, o la wallet se desconectó, contesta `null` — que es "no hay nadie
   * conectado", no "no pudimos preguntar".
   */
  async getConnectedAddress(): Promise<string | null> { const porEnlace = this.direccionDelViajeConectado(); if (porEnlace !== null) return porEnlace; // WKH-358/DT-2 — PEGADO A LA FIRMA (Δ0). 🔴 ÉSTA ES LA QUE VUELVE LOAD-BEARING AL CORTE FUERA DEL CANAL: `../presentation/flow.tsx:507` cruza ESTE valor contra `rem.ownerAddress`, que lo escribe `startKyc` en el repo de remesas y que el canal del enlace NO puede escribir. Sin esta línea, en el camino por enlace el cruce compararía `null` contra la remesa y NO cortaría nunca. Lo mide `T-065-CD11`; el razonamiento entero está en el bloque de CD-11 de `:906`
    const { connected, publicKey } = solanaWalletBridge.getState();
    if (!connected || !publicKey) return null; // sin conexión viva no hay address que devolver
    try {
      new PublicKey(publicKey); // espeja el guard de connect():124 — base58 válido o nada
    } catch {
      return null;
    }
    return publicKey; // OPACO, SIN toLowerCase (CD-3)
  }

  /** [u8;16] DETERMINÍSTICO desde remittanceId: `sha256(remittanceId)` truncado a 16 bytes
   *  (DT-SDD-5). Reproducible server-side (HU-SOL-13 re-deriva la PDA `escrow_state`). NUNCA
   *  Math.random. Usa `sha256` de @noble/hashes (browser-safe, SÍNCRONO) — NO el builtin de Node,
   *  que NO resuelve en el bundle client de Next (BLQ-MED-1). Output byte-idéntico al hash previo:
   *  sha256(utf8(remittanceId))[:16]. */
  private remittanceIdToBytes16(remittanceId: string): Uint8Array {
    return Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
  }

  /** La derivación de la PDA `escrow_state` DESDE UN `remittanceId` — la usan el path normal y el
   *  fallback de recuperación (HU-SOL-20/AC-2), así que no pueden divergir. Hashea con
   *  `remittanceIdToBytes16` y DELEGA los seeds en `deriveEscrowStateFromId16`, que a partir de
   *  WKH-347 es LA fuente única: hay un segundo camino que llega con el `id16` y sin `remittanceId`
   *  (el índice on-chain), y dos derivaciones separadas son dos PDAs que pueden divergir. */
  private deriveEscrowState(
    senderPk: InstanceType<typeof PublicKey>,
    programId: InstanceType<typeof PublicKey>,
    remittanceId: string,
  ): { pda: InstanceType<typeof PublicKey>; bytes: Uint8Array } {
    const id16 = this.id16FromBytes(this.remittanceIdToBytes16(remittanceId));
    return this.deriveEscrowStateFromId16(senderPk, programId, id16);
  }

  /** WKH-347 — ÚNICA fuente de la derivación de la PDA `escrow_state` (seeds: "escrow" | sender |
   *  id16[u8;16]). Byte-idéntica a la de authorizePrincipal / cross-repo (AH-9).
   *  `PublicKey.findProgramAddressSync` es estático: el import de módulo y el lazy-import resuelven a
   *  la MISMA clase.
   *
   *  Entra por `EscrowId16` y no por `remittanceId` porque hay UN camino que nunca tiene el segundo:
   *  el que redescubre un escrow leyendo el índice on-chain. `sha256` no se invierte, así que ahí el
   *  `remittanceId` no existe y no se puede inventar. */
  private deriveEscrowStateFromId16(
    senderPk: InstanceType<typeof PublicKey>,
    programId: InstanceType<typeof PublicKey>,
    id16: EscrowId16,
  ): { pda: InstanceType<typeof PublicKey>; bytes: Uint8Array } {
    const bytes = this.bytesFromId16(id16);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), senderPk.toBuffer(), Buffer.from(bytes)],
      programId,
    );
    return { pda, bytes };
  }

  /** ÚNICO lugar donde los 16 bytes se vuelven un `EscrowId16` (hex minúscula, 32 chars). Mismo
   *  criterio de fuente única que la derivación de la PDA de acá arriba: dos conversiones separadas
   *  son dos formas de escribir el mismo id que después no se comparan con `===`. */
  private id16FromBytes(bytes: Uint8Array | readonly number[]): EscrowId16 {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /** La vuelta. Fail-loud ante cualquier cosa que no sean 32 chars hex: un id16 deforme derivaría una
   *  PDA que no es la de nadie, y el camino de recuperación diría "no encontramos nada" sobre una
   *  búsqueda que nunca se hizo bien.
   *
   *  ⚠️ `escrow_id16_malformed` HOY NO TIENE PRODUCTOR ALCANZABLE, Y NINGÚN TEST LO CUBRE (fix-pack
   *  WKH-347, AR/MNR-6). Va dicho porque un docblock que afirma un comportamiento sin que nada lo
   *  verifique es una promesa, no una propiedad. La razón por la que es inalcanzable es por CONSTRUCCIÓN
   *  y se puede refutar con un input: el único lugar del adapter que fabrica un `EscrowId16` es
   *  `id16FromBytes`, que emite siempre 32 caracteres hex minúscula (un `padStart(2,"0")` por byte sobre
   *  16 bytes), y sus dos fuentes son `remittanceIdToBytes16` (sha256 truncado) y las `entries` del
   *  `EscrowIndex` decodificado (`vec<[u8;16]>`, cota del layout). Ninguna puede producir otra forma.
   *  ⇒ El guard queda porque `EscrowId16` es un alias de `string` y no lo protege el tipo: el día que un
   *  `id16` entre por un puerto, por la URL o escrito a mano en un doble, este `throw` es lo único que
   *  separa "no encontramos nada" de "buscamos en la PDA de nadie". Si le agregás ese productor, el test
   *  va con él. */
  private bytesFromId16(id16: EscrowId16): Uint8Array {
    if (!/^[0-9a-f]{32}$/.test(id16)) throw new Error("escrow_id16_malformed");
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = Number.parseInt(id16.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  // HU-SOL-20/AC-2 — FALLBACK de recuperación: el caller no trajo el remittanceId (localStorage
  // borrado / otro dispositivo), así que se lo pide al store durable server-side y se elige on-chain.
  // Sin resolver inyectado ⇒ fail-loud (`escrow_id_unavailable`), NUNCA silencioso.
  // Sondea hasta MAX_RECOVERY_CANDIDATES PDAs en UNA sola llamada RPC y devuelve el PRIMER escrow con
  // status Deposited (los ids llegan ordenados por created_at desc). El resultado es solo un CANDIDATO:
  // el caller vuelve a leer la cuenta elegida y re-aplica los guards autoritativos (status/deadline).
  //
  // 🔴 QUÉ SE ARREGLÓ ACÁ (WKH-331). Esto consumía un método que devolvía `string[]`, y sobre la lista
  // vacía tiraba `escrow_not_found`. Cuatro condiciones distintas llegaban con esa misma forma: el
  // mecanismo de PoP apagado, el registro apagado, el PoP rechazado y —la única legítima— el servidor
  // contestando que no hay ids. La pantalla las decía todas igual, afirmando haber mirado los últimos
  // MAX_RECOVERY_CANDIDATES envíos de la persona en los tres casos en que no se preguntó nada.
  // Ahora se consume `lookupBySender`, que las separa, y los tres `not_asked` salen por un código
  // propio. La CUARTA sigue saliendo por `escrow_not_found`, a propósito: ahí el servidor sí contestó
  // y la frase de la pantalla es cierta. Espeja a (`listCloseable`, `:1861`), que ya hacía esto.
  private async resolveRemittanceIdFromLedger(senderB58: string): Promise<string> {
    const resolver = this.remittanceIdResolver;
    // Mismo guard que `listCloseable`: sin el método no se adivina, y un doble de JS que no lo tenga
    // deja de reventar con un TypeError opaco.
    if (!resolver?.lookupBySender) throw new Error("escrow_id_unavailable");
    const lookup = await resolver.lookupBySender(senderB58);
    // El `reason` va pegado al código: el prefijo es lo que el copy reconoce y la cola es lo que
    // distingue los tres desenlaces. El copy NO lo interpola (CD-5). El código NO puede contener
    // `escrow_not_found`: `lostEscrowRecoveryError` evalúa esa subcadena primero y el arreglo saldría
    // por la frase que vino a sacar (CD-1).
    // ⚠️ ESTA COLA HOY NO LA LEE NADIE EN PRODUCCIÓN, y la prosa vieja decía que viajaba "para el
    // diagnóstico" (AR/MNR-4). El único consumidor de este camino es `LostEscrowRecovery`, que guarda
    // sólo el mensaje ya traducido (`flow.tsx`, el `catch` de `onRecover`) y descarta el código; no hay
    // log ni telemetría. O sea: el motivo es distinguible por un test, no por alguien mirando un error.
    if (lookup.outcome === "not_asked") {
      throw new Error(`escrow_recovery_unavailable:${lookup.reason}`);
    }
    // Corte temprano y no caída al `throw` de abajo: dejarlo caer haría un batch RPC de cero cuentas,
    // y si ese RPC fallara, "el servidor contestó que no hay nada" se convertiría en un error de red.
    if (lookup.remittanceIds.length === 0) throw new Error("escrow_not_found"); // el servidor contestó
    const candidates = lookup.remittanceIds.slice(0, MAX_RECOVERY_CANDIDATES);

    const web3 = await import("@solana/web3.js");
    const { PublicKey: PublicKeyLazy, Connection } = web3;
    const anchor = await import("@coral-xyz/anchor");
    const { escrowIdl } = await import("./solana/escrow-idl");

    const senderPk = new PublicKeyLazy(senderB58); // valida base58 (CD-SDD-7)
    const programId = new PublicKeyLazy((escrowIdl as { address: string }).address);
    const pdas = candidates.map((id) => this.deriveEscrowState(senderPk, programId, id).pda);

    const connection = new Connection(
      resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe
    );
    // UNA sola llamada RPC para los N candidatos (el nombre real de la API es getMultipleAccountsInfo).
    const infos = await connection.getMultipleAccountsInfo(pdas);
    const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
    for (let i = 0; i < candidates.length; i++) {
      const acc = infos[i];
      if (!acc) continue; // nunca se depositó (o ya cerró): no es candidata
      let statusKey: string | undefined;
      try {
        const state = coder.decode("EscrowState", acc.data) as { status: Record<string, unknown> };
        statusKey = Object.keys(state.status)[0]; // { Deposited: {} } | { Released: {} } | ...
      } catch {
        continue; // cuenta deforme/ajena al layout: se descarta, NUNCA rompe la recuperación
      }
      if (statusKey === "Deposited") return candidates[i]!; // el primero refundeable gana
    }
    throw new Error("escrow_not_found"); // ningún candidato está Deposited
  }

  /**
   * WKH-347 — QUÉ escrow hay que recuperar, mirando las DOS fuentes que existen: el registro durable
   * primero y, si ése no encontró nada, el índice on-chain del remitente.
   *
   * POR QUÉ EL ÍNDICE VA EN UN `catch` DE `escrow_not_found` Y NO ADENTRO DEL RESOLVER: ese código
   * sale de DOS puntos distintos del camino del ledger — el servidor contestó y no tiene ids, y
   * recorrió los candidatos y ninguno está `Deposited` — y los dos merecen la segunda fuente. Con el
   * `catch` quedan cubiertos los dos por construcción, en vez de por acordarse de tocar dos lugares.
   * Implementar sólo el primero dejaría el resultado colgado de si la persona CASUALMENTE tiene una
   * remesa vieja e irrelevante en el ledger, que es una moneda al aire sobre el camino que devuelve
   * el principal.
   *
   * 🚫 LO QUE NO SE CONSULTA, y es un límite declarado: cuando el registro durable contesta
   * `not_asked` (el mecanismo de PoP apagado, el registro apagado o el PoP rechazado), el corte sigue
   * siendo `escrow_recovery_unavailable:<motivo>` y el índice NO se mira, aunque sea uno de los
   * escenarios para los que existe. Ampliarlo obliga a tocar una superficie de copy con cinco
   * productores y es otra HU. El `throw e` de abajo es lo que lo mantiene cierto, y hay un test que
   * verifica que la cadena no se toca en esos tres casos.
   *
   * El retorno es una unión DISCRIMINADA y no una cadena, porque lo que sale del índice es un
   * `EscrowId16` y NO es un `remittanceId`: no se puede interpolar en un copy, ni mandar al registro,
   * ni comparar con el del `localStorage`. Con una cadena pelada las dos cosas serían el mismo tipo.
   */
  private async resolveEscrowTarget(senderB58: string): Promise<EscrowRecoveryTarget> {
    try {
      const remittanceId = await this.resolveRemittanceIdFromLedger(senderB58);
      return { via: "ledger", remittanceId };
    } catch (e) {
      // SÓLO `escrow_not_found` habilita la segunda fuente. `escrow_recovery_unavailable:*` y
      // `escrow_id_unavailable` significan que no se llegó a preguntar, y "no pude preguntar" no es
      // "no hay": pasan de largo tal cual, sin tocar la cadena.
      if ((e as Error)?.message !== "escrow_not_found") throw e;
      const id16 = await this.resolveFromEscrowIndex(senderB58);
      return { via: "index", id16 };
    }
  }

  /**
   * El camino de la SEGUNDA fuente: el índice on-chain `["escrow-index", sender]`, que se deriva de
   * la pubkey del remitente sola y por eso sigue alcanzable cuando el `remittanceId` se perdió.
   *
   * CUATRO desenlaces, y colapsarlos es exactamente el defecto que esta HU no puede introducir:
   *   · la PDA no existe            ⇒ `escrow_index_absent`. ❌ NO significa "no tenés nada".
   *   · no se pudo leer             ⇒ `escrow_index_unreadable`. ❌ NO dice nada sobre los fondos.
   *   · existe y está vacío         ⇒ `escrow_not_found`, que es el de hoy: se miró y no lista nada.
   *   · existe y tiene entradas     ⇒ sigue el sondeo on-chain, que es el único autoritativo.
   *
   * 🚫 LOS `entries` NO SE RECORTAN A `MAX_RECOVERY_CANDIDATES`. Ese techo es el de la ROUTE del
   * registro durable, que es otra fuente: el índice no tiene servidor, sus entradas son hasta
   * `ESCROW_INDEX_MAX_ENTRIES` y `getMultipleAccountsInfo` las sondea en UNA llamada igual que 20.
   * Recortarlas sería tirar candidatos del camino que devuelve el principal por un número que
   * pertenece a otro lado, que es el defecto que `escrow-lookup-limits.ts` ya documentó una vez.
   *
   * El criterio de elección es el mismo que el del camino del ledger: una sola llamada batch, una
   * cuenta que no decodifica se descarta y nunca rompe la recuperación, y el primero `Deposited` gana.
   *
   * 🔴 Y ESO ES UNA DUPLICACIÓN RESIDUAL DECLARADA, no una igualdad garantizada (fix-pack WKH-347,
   * CR/MNR-3). Acá se AFIRMABA que los dos bucles coinciden y NADA lo verificaba: el bucle de selección
   * de `escrowIndexCandidate` es un clon estructural del de `resolveRemittanceIdFromLedger`, y el día que
   * alguien cambie uno —agregarle el chequeo de `deadline`, por ejemplo, o cambiar el criterio de
   * empate— el otro se queda como está y este docblock queda mintiendo en silencio. No hay test que
   * compare los dos bucles.
   *
   * ⛔ **DECIDÍ NO REFACTORIZAR EL MONEY-PATH A ESTA ALTURA**, y va con esas palabras. Compartir el bucle
   * es lo correcto en abstracto y acá el costo es concreto: los dos caminos tienen tipos de entrada
   * distintos (`remittanceId` contra `EscrowId16`), derivan la PDA por funciones distintas y devuelven
   * cosas distintas, así que la extracción toca la función que elige QUÉ escrow se refundea, en el mismo
   * diff que ya cambió su comportamiento y con el fix-pack de dos revisiones encima. La deuda queda
   * anotada acá, en el sitio, y no en un backlog que nadie relee: **si tocás uno de los dos bucles, tocá
   * el otro o borrá esta afirmación.**
   *
   * ⚠️ POR QUÉ ESTA FUNCIÓN ES UN MAPEADOR Y EL TRABAJO VIVE EN LA DE ABAJO. Los cuatro desenlaces son
   * cuatro, y todo lo que no sea uno de ellos es un QUINTO desenlace SIN NOMBRE. `probeEscrowIndex`
   * atrapa lo suyo (el techo, el RPC, el decode), pero el resto de este camino —los cuatro
   * `await import()`, el `new PublicKey(senderB58)`, la derivación de las PDAs y la llamada batch— no
   * lo atrapa nadie, y un error de ahí escapaba CRUDO hasta la red de seguridad de la pantalla, que
   * dice "no sabemos hasta dónde llegamos". Y sí sabíamos: no pudimos leer el índice. MEDIDO en jsdom,
   * donde `findProgramAddressSync` tira "Unable to find a viable program address nonce" (la misma causa
   * que `escrow-rent-discovery-junta.test.ts` ya dejó medida) y la pantalla mostraba la red de
   * seguridad en vez del copy del índice.
   *
   * ⇒ Cualquier fallo que no sea uno de los tres códigos deliberados se dice `escrow_index_unreadable`,
   * porque es exactamente lo que significa: *no pude preguntar*, y eso no es "no". Los tres pasan tal
   * cual, así que este `catch` NO puede convertir un "no hay" en un "no pude".
   *
   * 🚫 LO QUE ESTE MAPEO CUESTA, y va escrito para que nadie lo descubra de golpe: el mensaje original
   * SE PIERDE. Un bug de programación en este camino se va a ver como "no pudimos leer el índice" y no
   * como el error que es. Se acepta porque acá no se mueve plata —este camino sólo LEE para elegir un
   * candidato, y los guards autoritativos del refund corren después y completos— y porque la
   * alternativa medida era peor: la pantalla afirmando que no sabe dónde se cortó cuando sí lo sabe.
   * El motivo NO se interpola en el código que viaja: un mensaje crudo de una dependencia no es un
   * enum, y esta cadena llega a `lostEscrowRecoveryError`.
   */
  private async resolveFromEscrowIndex(senderB58: string): Promise<EscrowId16> {
    try {
      return await this.escrowIndexCandidate(senderB58);
    } catch (e) {
      const code = (e as Error)?.message;
      if (
        code === "escrow_index_absent" ||
        code === "escrow_index_unreadable" ||
        code === "escrow_not_found"
      )
        throw e; // los TRES deliberados viajan intactos
      throw new Error("escrow_index_unreadable");
    }
  }

  /** El trabajo del camino del índice. Lo envuelve `resolveFromEscrowIndex`, que es quien garantiza
   *  que de acá no sale ningún desenlace sin nombre. */
  private async escrowIndexCandidate(senderB58: string): Promise<EscrowId16> {
    const web3 = await import("@solana/web3.js");
    const { PublicKey: PublicKeyLazy, Connection } = web3;
    const anchor = await import("@coral-xyz/anchor");
    const { escrowIdl } = await import("./solana/escrow-idl");

    const senderPk = new PublicKeyLazy(senderB58); // valida base58 (CD-SDD-7)
    const programId = new PublicKeyLazy((escrowIdl as { address: string }).address);
    const connection = new Connection(
      resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe
    );
    const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);

    const idx = await this.probeEscrowIndex(connection, senderPk, programId, coder);
    if (idx.status === "unknown") throw new Error("escrow_index_unreadable");
    if (idx.status === "absent") throw new Error("escrow_index_absent");
    if (idx.entries.length === 0) throw new Error("escrow_not_found"); // el índice existe y no lista nada

    const pdas = idx.entries.map((id) => this.deriveEscrowStateFromId16(senderPk, programId, id).pda);
    const infos = await connection.getMultipleAccountsInfo(pdas);
    for (let i = 0; i < idx.entries.length; i++) {
      const acc = infos[i];
      if (!acc) continue; // la cuenta ya no está: la entrada quedó colgada, no es candidata
      let statusKey: string | undefined;
      try {
        const state = coder.decode("EscrowState", acc.data) as { status: Record<string, unknown> };
        statusKey = Object.keys(state.status)[0];
      } catch {
        continue; // cuenta deforme/ajena al layout: se descarta, NUNCA rompe la recuperación
      }
      if (statusKey === "Deposited") return idx.entries[i]!; // el primero refundeable gana
    }
    // Se miraron las DOS fuentes y ninguna tiene un escrow abierto. Es el mismo código de hoy porque
    // es la misma afirmación, y es la única que se puede hacer: se preguntó y no hay.
    throw new Error("escrow_not_found");
  }

  // HU-SOL-5 (AC-1..AC-4, AC-7, AC-8): construye la ix `deposit` del escrow Anchor, fija
  // feePayer=facilitator, partial-signa SÓLO con la wallet (bridge) y devuelve la tx serializada.
  async authorizePrincipal(
    quote: Quote,
    remittanceId: string,
    deposit: { address: string; escrow?: SolanaEscrowDeposit } | undefined, hrefDeLaVuelta: string, // 🔴 WKH-373 — EL HREF ENTRA POR PARÁMETRO, EN ESTA MISMA LÍNEA (Δ0: este archivo recibe citas por número desde `ports.ts`, `chain.ts` y tres archivos de test, y una línea de más las rota a todas). ⛔ Y `deposit` DEJÓ DE SER `?` por una razón del compilador y no de diseño: TypeScript no admite un parámetro requerido detrás de uno opcional, y este tiene que ser requerido. El contrato entero está en (`hrefDeLaVuelta`, `../application/ports.ts:503`).
  ): Promise<AutorizacionDelPrincipal> {
    // ── GUARDS fail-loud (AC-7/CD-SDD-8) — ANTES de construir/firmar nada ──
    const sender = await this.getAddress(); // base58 del bridge (HU-SOL-4)
    if (!sender) throw new Error("wallet_not_connected"); // AC-7
    if (!deposit?.escrow?.beneficiary || !deposit?.escrow?.authority)
      throw new Error("escrow_params_missing"); // CD-SDD-8

    // ── lazy-import (DT-SDD-8, patrón wallet.ts:200) ──
    const web3 = await import("@solana/web3.js");
    const { PublicKey, Transaction, Connection, Keypair, ComputeBudgetProgram } = web3;
    const anchor = await import("@coral-xyz/anchor");
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const { escrowIdl } = await import("./solana/escrow-idl"); // la copia pinneada (W0.4)

    // ── Pubkeys (CD-SDD-7, validan base58) ──
    const senderPk = new PublicKey(sender);
    const beneficiaryPk = new PublicKey(deposit.escrow.beneficiary);
    const authorityPk = new PublicKey(deposit.escrow.authority);
    const mintPk = new PublicKey(deposit.escrow.mint ?? resolveSolanaUsdcMint()); // CD-SDD-4
    const programId = new PublicKey((escrowIdl as { address: string }).address); // DR5G…SE4x, CD-SDD-4

    // ── Args canónicos (AC-8/CD-SDD-3) — String(...) NO Number(...) ──
    const remittanceIdBytes = this.remittanceIdToBytes16(remittanceId); // [u8;16] determinístico
    const amount = new anchor.BN(String(quote.send.minor)); // u64, sin floats
    // El guard de vencimiento de la cotización ya corrió aguas arriba, en el bloque `2.5 Re-check de
    // vigencia del quote` de `confirm-and-send.ts` (orden: confirm → address → expiry → rent →
    // prepare → firma). ⚠️ DOS COSAS ESTABAN MAL ACÁ (AR/BLQ-BAJO-1): la cita apuntaba a `:198`, que
    // es el docblock del refund-knowledge y NO el guard de expiry —ya estaba equivocada antes de esta
    // HU, y el chequeo de drift la renumeró conservando el error—, y el orden nombraba un paso
    // "autoridad" que WKH-333/DT-20 eliminó de ese use-case. Por eso ahora se cita el BLOQUE por su
    // nombre y no un número de línea. Éste lo repite localmente para que la wallet nunca firme sobre
    // una cotización con fecha ilegible, venga de donde venga el llamador.
    // Ya NO alimenta el deadline: ver CUSTODY_WINDOW_SECS.
    if (!isParseableIso(quote.expiresAt)) throw new Error("quote_expires_at_invalid");
    const deadline = new anchor.BN(
      String(Math.floor(Date.now() / 1000) + CUSTODY_WINDOW_SECS),
    ); // i64 unix seconds

    // ── PDAs / ATAs (AC-1) ──
    const [escrowStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), senderPk.toBuffer(), Buffer.from(remittanceIdBytes)],
      programId,
    );
    // vault: ATA del mint owned por la PDA escrow_state (off-curve). sender_ata: ATA del sender.
    const vault = getAssociatedTokenAddressSync(mintPk, escrowStatePda, /*allowOwnerOffCurve*/ true);
    const senderAta = getAssociatedTokenAddressSync(mintPk, senderPk);
    // WKH-343 — beneficiary_ata: la NOVENA cuenta de `deposit`, índice 8. El programa desplegado la
    // EXIGE, y Anchor tolera cuentas de más pero NO de menos: mientras el IDL vendoreado declaraba 8,
    // esta ix salía con 8 y TODO depósito fallaba en producción.
    //
    // QUÉ ARREGLA QUÉ, medido y no supuesto, porque el reparto no es el intuitivo: lo que cierra la
    // rotura es el IDL nuevo, NO esta línea. El IDL declara la cuenta con seeds derivables
    // (`arg: beneficiary` + token program + `account: mint`, bajo el programa de ATA) y el resolver de
    // anchor las sabe usar: sacando `beneficiaryAta` del `.accounts()` de abajo y dejando el IDL
    // nuevo, la ix sigue saliendo con las 9 cuentas correctas y la suite entera queda verde. Y al
    // revés no se salva: con el IDL viejo, pasarla explícita NO alcanza (el shape loose descarta un
    // nombre que el IDL no declara) y la ix vuelve a salir con 8.
    // Entonces por qué existe igual: por AR-MNR-1, la misma razón que escrow_state y vault, que
    // también son derivables y también se pasan a mano — que la dirección no dependa de la versión
    // del resolver. Es defensa en profundidad declarada, no el arreglo.
    //
    // SIN `allowOwnerOffCurve`: el dueño es el beneficiario, una cuenta normal ON-curve. El `true` de
    // arriba es del vault y sólo porque SU dueño es una PDA; copiarlo acá aceptaría como beneficiario
    // una pubkey que no puede firmar nunca, y esos fondos no los cobra nadie.
    const beneficiaryAta = getAssociatedTokenAddressSync(mintPk, beneficiaryPk);

    // ── reference (AC-4/CD-SDD-13) — Pubkey único, @solana/web3.js, NO @solana/pay ──
    const reference = Keypair.generate().publicKey; // la privada se DESCARTA (nunca firma)

    // ── Build ix (AC-1/AC-4) — vía anchor Program (programId del idl.address) ──
    const connection = new Connection(
      resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe (AR-MNR-2) · ⛔ NO agregar reintento sobre 429 acá: web3.js YA reintenta 5 veces (@solana/web3.js/lib/index.cjs.js:5063) y una SEGUNDA capa no suma, MULTIPLICA: medido el 2026-08-11, ~30 s de espera y 502 en /api/settle/solana-sponsor, con la pantalla final diciendo "no sabemos si te cobramos" — un error rapido y claro convertido en incognita
    );
    const program = new anchor.Program(escrowIdl as unknown as Idl, { connection } as Provider);
    // `escrowIdl as Idl` es el IDL genérico ⇒ `methods.deposit` no está tipado por-instrucción;
    // se accede vía un shape loose (los args/accounts/remaining se validan contra el IDL en runtime).
    const methods = program.methods as unknown as {
      deposit: (...args: unknown[]) => {
        accounts: (a: Record<string, PublicKey>) => {
          remainingAccounts: (
            r: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>,
          ) => { instruction: () => Promise<TransactionInstruction> };
        };
      };
    };
    const ix = await methods
      .deposit(Array.from(remittanceIdBytes), beneficiaryPk, authorityPk, amount, deadline)
      // escrow_state/vault son PDAs derivables por anchor, pero se pasan EXPLÍCITOS (AR-MNR-1): más
      // robusto ante cambios de resolución de anchor y elimina el dead code. sender_ata NO es PDA.
      // programs (address fija en el IDL) los resuelve anchor.
      // beneficiaryAta explícita por lo mismo (WKH-343). Ojo con la lectura fácil: NO es lo que
      // arregla la rotura de producción — eso lo hace el IDL nuevo. Ver el bloque de su derivación.
      .accounts({
        sender: senderPk,
        mint: mintPk,
        escrowState: escrowStatePda,
        vault,
        senderAta,
        beneficiaryAta,
      })
      .remainingAccounts([{ pubkey: reference, isSigner: false, isWritable: false }]) // AC-4
      .instruction();

    // ── ComputeBudget: Chaski declara SU presupuesto (WKH-321 / SDD 038) ──────────────────────────
    // Antes de esta HU la tx salía con UNA sola instrucción y la billetera inyectaba las suyas
    // (375.000 µL/CU), 7,5x por encima del tope POR UNIDAD del facilitator
    // (SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS = 50.000, wasiai-facilitator/src/infra/env.ts:215)
    // -> 422 PRIORITY_FEE_ABOVE_MAX (cr1.ts:159-160). Emitir las nuestras hace que el valor que Chaski
    // declara deje de depender de la billetera. Lo que esto NO hace: impedir que la billetera igual
    // agregue las suyas — eso no lo puede prohibir ni el protocolo ni la librería. Si lo hace, el
    // rechazo es DISTINTO (TOO_MANY_COMPUTE_BUDGET_IX / DUP_*, cr1.ts:131-156), no un éxito.
    // Los valores y su derivación viven en chain.ts (resolveSolanaComputeUnit*): 120.000 CU sale de
    // 79.826 CU (peor caso sobre 28 corridas, solana-programs/tests/escrow-index.ts:725-731) x 1,5.
    // CD-1: las dos van ANTES de signTransaction. Agregar una ix DESPUÉS de firmar recompila el
    // mensaje y la firma ed25519 del sender deja de validar (y arrastra al mensaje canónico de
    // SDD 037, que lleva esa firma adentro).
    const limitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: resolveSolanaComputeUnitLimit(),
    });
    const priceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: resolveSolanaComputeUnitPriceMicroLamports(),
    });

    // ── WKH-347 · el escrow queda ENCONTRABLE desde la pubkey del remitente ────────────────────────
    //
    // QUÉ PROBLEMA ATACA, dicho sin exagerar: la derivación de la PDA del escrow es
    // `["escrow", sender, id16]` y el `id16` sale de `sha256(remittanceId)`, así que el `remittanceId`
    // es la ÚNICA entrada. Cuando la escritura del registro durable falla, ese id se pierde y no hay
    // forma de volver a derivar la PDA. Registrar el escrow en el índice on-chain del remitente lo
    // vuelve ENCONTRABLE desde su pubkey sola.
    //
    // ⛔ LO QUE NO HACE, y no se puede escribir de otra manera: NO vuelve imposible el depósito
    // huérfano y NO evita que la escritura del registro durable falle. Esa escritura sigue igual de
    // frágil que ayer. Lo único que cambia es que el escrow se puede volver a encontrar después.
    //
    // ── LA SONDA VA ACÁ, Y ESO ES PARTE DEL CONTRATO (CD-14) ─────────────────────────────────────
    //  · 14.1 · el resultado queda en una `const` local YA RESUELTA, antes de la primera línea que
    //    agrega instrucciones. Nunca un `.then()`, nunca una `Promise` guardada: si el `.add()`
    //    corriera antes del `await`, la firma no cubriría las dos ix.
    //  · 14.2 · PROHIBIDO memoizarlo en un campo del adapter. Este adapter es un SINGLETON del
    //    container y la ocupación del índice cambia con cada registro: un valor memoizado es un dato
    //    viejo decidiendo si se agrega una ix que puede REVERTIR EL DEPÓSITO COMPLETO.
    //  · 14.3 · PROHIBIDO que el guard de saldo lea el índice por su cuenta. Hoy compara contra UN
    //    número fijo y no lo lee; agregarle una lectura reintroduce el modo de falla que el umbral
    //    único eliminó (dos lecturas separadas por una llamada de red que pueden divergir).
    //
    // El techo de la sonda son 5 s (ESCROW_INDEX_PROBE_TIMEOUT_MS) y son hasta 5 s ANTES del diálogo
    // de firma. 🚫 PROHIBIDO subirlo "para mejorar la tasa de registro": el costo lo paga la persona
    // mirando la pantalla.
    const idxCoder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
    const idx = await this.probeEscrowIndex(connection, senderPk, programId, idxCoder);
    // La decisión, con `idx` ya resuelto:
    //   absent                                   ⇒ se registra (la ix crea el índice)
    //   present con lugar                        ⇒ se registra
    //   present y LLENO (>= ESCROW_INDEX_MAX_ENTRIES) ⇒ NO se registra
    //   unknown                                  ⇒ NO se registra
    //
    // ⚠️ LA ASIMETRÍA CON `closeEscrow` ES DELIBERADA Y NO SE ARMONIZA. Allá `unknown` ABORTA, porque
    // adivinar puede dejar una entrada colgada consumiendo un lugar del cupo y lo único que se pierde
    // es un cierre reintentable. ACÁ DEGRADA, porque el costo de abortar es bloquear una remesa
    // legítima por una falla de lectura NUESTRA: un RPC caído no puede impedirle a alguien mandar
    // plata. Las dos mitades van escritas para que ningún review "corrija" una mirando la otra.
    //
    // Y el índice lleno tampoco aborta, por la misma razón: quien tenga 32 escrows abiertos sigue
    // pudiendo depositar. Lo que pierde es que ESE depósito quede registrado, no el depósito.
    const registrable =
      idx.status === "absent" ||
      (idx.status === "present" && idx.entries.length < ESCROW_INDEX_MAX_ENTRIES);
    // 🔴 CD-10 — TODO lo nuevo vive adentro de este `if`, así que el camino de UNA ix de negocio no
    // ejecuta ni una línea nueva y sale byte-idéntico al de antes de esta HU. Está medido contra un
    // fixture pinneado del árbol previo, no prometido.
    let regIx: TransactionInstruction | undefined;
    if (registrable) {
      const regMethods = program.methods as unknown as {
        registerEscrow: (...args: unknown[]) => {
          accounts: (a: Record<string, PublicKey>) => {
            instruction: () => Promise<TransactionInstruction>;
          };
        };
      };
      const [escrowIndexPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow-index"), senderPk.toBuffer()],
        programId,
      );
      regIx = await regMethods
        // El binding al `deposit` NO es opcional: el mismo sender, la MISMA `escrowStatePda` y los
        // MISMOS `remittanceIdBytes` que la ix de posición 0. No se re-deriva nada — se usan las
        // variables que ya están en el scope, que es lo que impide que las dos ix hablen de escrows
        // distintos. SIN `.remainingAccounts(...)`: una cuenta de más acá la rechaza el facilitator.
        .registerEscrow(Array.from(remittanceIdBytes))
        // `sender`, `escrowState` y `escrowIndex` explícitos por el mismo criterio que el `deposit`:
        // que la dirección no dependa de la versión del resolver de anchor. `systemProgram` tiene
        // `address` fija en el IDL y lo resuelve anchor.
        .accounts({ sender: senderPk, escrowState: escrowStatePda, escrowIndex: escrowIndexPda })
        .instruction();
    }

    // ══ WKH-357 · LAS TRES LECTURAS DEL NONCE DURABLE, ANTES DE ARMAR LA TX ══════════════════════
    //
    // 🔴 CD-1 — TODO esto vive adentro de `if (this.firmaPorEnlace)`, igual que el `if (registrable)`
    // de arriba y que la rama grande de abajo. El camino de la billetera inyectada (el del video de
    // M5) no ejecuta NI UNA línea de este bloque: no deriva, no lee la cuenta, no consulta el saldo.
    //
    // ⚠️ POR QUÉ ESTE BLOQUE ESTÁ ACÁ Y NO DENTRO DE LA RAMA GRANDE DE MÁS ABAJO. La transacción se
    // ARMA unas líneas más abajo, y la `nonceAdvance` y el `recentBlockhash` del nonce se necesitan
    // EN EL MOMENTO DE ARMARLA. Y la rama grande NO se puede subir hasta acá: este archivo lo prohíbe
    // explícitamente donde está escrita, porque subirla cambiaría el orden de los guards de este
    // método (y con él el ancla de DT-10, que se calcula sobre una tx que ya tiene blockhash). La
    // única forma que respeta las dos cosas es este bloque CORTO acá y la rama grande donde está.
    let nonceIx: TransactionInstruction | undefined;
    let valorDelNonce: string | undefined;
    if (this.firmaPorEnlace && this.caminoPorEnlace() !== null) { // WKH-358/DT-1: el colaborador CABLEADO ya no alcanza — hace falta que ESTE recorrido sea por enlace (elección del selector Y `availability === "none"`). Ver `caminoPorEnlace`, `:2239`
      // 0 · SIN MEMORIA NO HAY RECORRIDO, y esto va PRIMERO por dos razones medidas.
      //
      // La rama grande de abajo ya corta con esta misma causa (es la dueña del check y sigue
      // siéndolo); lo que se agrega acá es la PRECONDICIÓN, con el mismo string y sin vocabulario
      // nuevo. Sin ella, este bloque gastaría DOS lecturas de red (el saldo y la cuenta de nonce)
      // antes de descubrir que el viaje no puede completarse de todas formas, y encima la persona
      // vería "te falta SOL" cuando el problema real es que el navegador no puede recordar nada.
      // Un diagnóstico peor y dos llamadas al vacío: por eso el orden importa y no es estético.
      if (this.entornoDeEnlace() === null) throw new Error("deeplink_sin_memoria");

      // 1 · La dirección. Sin red: `createWithSeed` sólo hashea. Se re-deriva desde la pubkey SOLA,
      //     que es lo único que sobrevive a la muerte de la página.
      const noncePk = await direccionDelNonce(senderPk);

      // 2 · EL GUARD DE SALDO DEL CAMINO POR ENLACE, con SU umbral.
      //
      // Reusa la sonda que ya existe (`probeSenderSolBalance`): ya tiene su techo, ya devuelve los
      // dos valores sin colapsarlos y ya está testeada. ⛔ No se escribe un `getBalance` nuevo.
      //
      // 🔴 FAIL-OPEN, Y NO ES UNA ELECCIÓN DE ESTA HU: es la que este repo ya tomó y documentó en
      // `use-cases/confirm-and-send.ts` ("NO PUDE PREGUNTAR" DEJA SEGUIR, Y ES DELIBERADO). Este
      // guard NO custodia dinero —el que custodia es el runtime de Solana—, así que con un RPC caído
      // bloquear convertiría una caída de infraestructura NUESTRA en "no tenés saldo" y dejaría a
      // TODO el mundo sin poder enviar. La condición es exactamente el espejo de la de allá:
      // `status === "known"` Y por debajo del umbral. `unknown` DEJA SEGUIR. ⛔ No lo "arregles" al
      // revés.
      //
      // ⛔ Y NO se toca el guard de `confirm-and-send.ts`: compara contra
      // `SENDER_MIN_LAMPORTS_FOR_DEPOSIT`, no sabe el tipo de billetera, y hacérselo saber exige
      // cambiar `ports.ts`. Éste es el guard ESPECÍFICO del camino por enlace, no un reemplazo.
      //
      // EL COSTO, declarado y no disfrazado: este guard corre DESPUÉS de `prepare()`, así que un
      // corte por saldo deja una orden de payout huérfana. Eso NO es una clase nueva de problema —
      // ya es el caso NORMAL de este camino y está escrito en `confirm-and-send.ts` (tres
      // `prepare()`, las dos anteriores quedan huérfanas). Se dice para no presentarlo como gratis.
      const saldo = await this.probeSenderSolBalance({ sender: senderPk.toBase58() });
      if (saldo.status === "known" && saldo.lamports < SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT) {
        throw new Error("deeplink_saldo_insuficiente");
      }

      // 3 · El valor guardado en la cuenta. TRES desenlaces, y cada uno con su consecuencia.
      const lectura = await leerNonce(connection, noncePk, (p) =>
        withTimeout(p, BLOCKHASH_PROBE_TIMEOUT_MS),
      );
      if (lectura.tipo === "no-hay") {
        // ⛔ SIN limpiar el disco y SIN pedir ninguna firma. Que la cuenta no exista es, hasta que la
        // ola 4 la cree, el desenlace CORRECTO y esperado de este camino — no una falla. Y como no se
        // firmó nada, no hay nada que preservar ni que borrar.
        throw new Error("deeplink_nonce_ausente");
      }
      if (lectura.tipo === "no-pudimos-preguntar") {
        // ⛔ SIN limpiar: no sabemos nada de la cuenta, así que un reintento puede completar el
        // recorrido. Colapsar esto en "no hay cuenta" sería convertir "no pude preguntar" en "no pasó".
        throw new Error("deeplink_blockhash_desconocido");
      }
      valorDelNonce = lectura.valor;
      nonceIx = construirNonceAdvance(noncePk, senderPk);
    }

    // ── feePayer + blockhash + partial-sign + serializar (AC-2/AC-3) ──
    const { blockhash } = await connection.getLatestBlockhash();
    // Orden [limit, price, deposit]: convención y legibilidad (el límite es lo que el precio
    // multiplica). CR-1 NO lo exige — filtra las ix de ComputeBudget por programId (cr1.ts:106-107) y
    // toma businessIx[0] del array ya filtrado (:115). Se documenta para que nadie lo cambie creyendo
    // que da igual, y para que nadie lo defienda creyendo que el validador lo impone.
    //
    // 🔴 LO QUE SÍ ES UN INVARIANTE, RE-ENUNCIADO POR WKH-357 (no ablandado): el `deposit` va SIEMPRE
    // en la posición 0 de las ix DE NEGOCIO, y el `register_escrow` DESPUÉS. Lo que cambió es que la
    // `nonceAdvance` del camino por enlace se prepone ANTES de todo, y **la `nonceAdvance` no es una
    // ix de negocio**: no es del escrow ni de ComputeBudget, es del System Program. O sea que la
    // posición ABSOLUTA del `deposit` pasa de 2 a 3 en el camino por enlace, mientras que su posición
    // RELATIVA entre las de negocio no cambia nunca. Hay TRES actores que dependen de eso por
    // POSICIÓN, no por discriminador: el CR-1 del facilitator, el Guard A de SDD 037 y NUESTRO PROPIO
    // SERVIDOR (`tx.instructions.filter`, `settlement/solana-deposit-beneficiary.ts:106`), que indexa
    // la POSICIÓN 0 de las ix del escrow y después exige que sea el `deposit`. Los tres FILTRAN antes
    // de indexar, así que los tres siguen sirviendo — pero el del facilitator **sólo con su bandera
    // `SOLANA_SPONSOR_DURABLE_NONCE_ENABLED` prendida**, y hasta entonces un depósito por enlace
    // recibe 403. Con el orden invertido, en cambio, ese lector devuelve `unreadable` y la route del
    // settle responde 400: TODO depósito patrocinado falla en nuestro propio servidor, antes de que el
    // facilitator vea nada. ⛔ PROHIBIDO invertir el orden [nonceAdvance, limit, price, deposit, register].
    //
    // ⛔ Y LA `nonceAdvance` SE PREPONE ACÁ, A MANO, NUNCA CON `tx.nonceInfo`: ese campo la mete en un
    // array LOCAL de `compileMessage()` sin tocar `tx.instructions`, así que el objeto y el mensaje
    // firmado dirían cosas distintas y los tres lectores de arriba leerían la ix equivocada. Medido, y
    // congelado en el test T-N4 de `solana/nonce-duradero.test.ts`.
    const tx = nonceIx
      ? new Transaction().add(nonceIx, limitIx, priceIx, ix, ...(regIx ? [regIx] : [])) // WKH-357
      : regIx
        ? new Transaction().add(limitIx, priceIx, ix, regIx) // [limit, price, deposit, register] — CD-1
        : new Transaction().add(limitIx, priceIx, ix); // [limit, price, deposit] — ver CD-1
    tx.feePayer = new PublicKey(resolveSolanaFacilitatorPubkey()); // AC-2: facilitator paga el fee de red
    // El valor del nonce en el camino por enlace (no vence por tiempo); el de la red en el inyectado.
    // ⚠️ `getLatestBlockhash()` se sigue llamando en los DOS caminos y eso es a propósito: sacarlo de
    // acá para "ahorrar una llamada" movería una lectura de red que el camino inyectado necesita, y es
    // exactamente el tipo de cambio que CD-1 prohíbe. Lo que el camino por enlace hace es IGNORAR ese
    // valor, no evitar la llamada.
    tx.recentBlockhash = valorDelNonce ?? blockhash;

    // ══ WKH-356 · LA RAMA DE FIRMA POR ENLACE PROFUNDO ═══════════════════════════════════════════
    //
    // 🔴 CD-1 — TODO lo nuevo vive adentro de este `if`, exactamente igual que el `if (registrable)`
    // de WKH-347 unas líneas más arriba. Con el colaborador ausente —que es como queda producción al
    // cerrar 062, y lo mide T-062-21— el camino de la billetera inyectada (el del video de M5) no
    // ejecuta NI UNA línea nueva. La regresión byte-idéntica deja de ser una promesa: es una
    // propiedad del flujo de control.
    //
    // ⛔ NO SUBAS ESTA RAMA MÁS ARRIBA "para no armar la tx al pedo" en la reanudación. Sí, en las
    // invocaciones B y C la tx recién armada se descarta (la que vale es la que quedó en el disco).
    // Ese desperdicio es DELIBERADO: subirla cambiaría el orden de los guards de este método.
    //
    // ⚠️ ACÁ ESTA PROHIBICIÓN NOMBRABA UN CANDADO QUE NO PUEDE VERLA, y el CR lo midió (MNR-CR-3):
    // decía que subir la rama "rompería el candado de `confirm-and-send.reorder.test.ts`", y ese
    // archivo **no importa `solana-wallet.ts` en ninguna línea** — clava el orden de los guards de
    // `execute()`, que es otro método de otra capa. Quien leyera la prohibición, moviera la rama y
    // viera la suite verde iba a concluir que el comentario exageraba.
    //
    // 🔒 EL CANDADO QUE SÍ LA VE, MEDIDO en la batería de mutación del fix-pack 1: los ~40 `it` de
    // HU-SOL-5 de `solana-wallet.test.ts` (más `solana-deposit-beneficiary.test.ts`). Invertir este
    // mismo `if` pone **46 `it` rojos** en esos dos archivos, y NINGUNO en `container.test.ts`. O sea:
    // este código lo atraviesan esos 46 `it`, y el `if` es exactamente lo que los mantiene en el camino
    // de siempre. Mover la rama arriba del `tx.recentBlockhash` además rompe DT-10 por construcción (el
    // ancla se calcularía sobre una tx sin blockhash), y eso lo cazan los `it` de T-062-18.
    //
    // ⚠️ [NO VERIFICADO] (CD-12) — nada de esta rama está medido en un teléfono, Y SIGUE SIN ESTARLO DESPUÉS DE WKH-358. Eso es lo que esta actualización precisa, en las MISMAS 4 líneas (este bloque recibe [[CENSO src/infrastructure/solana-wallet.ts entrantes-desde-893=78]] citas ancladas por debajo): la ola 4 escribió quién enciende esta rama y quién la alimenta, así que ahora EXISTE un recorrido con el que se puede medir, y lo que no cambió es que nadie de este equipo lo corrió en un teléfono.
    // Siguen sin verificar, una por una: que la billetera vuelva al mismo origen · que el `localStorage` sobreviva al salto · que la transacción devuelta sea byte-idéntica a la enviada · y que el blockhash aguante el viaje de ida y vuelta (dos saltos a otra app, una persona leyendo, dos vueltas).
    // ⚠️ La CUARTA es la única que la ola 4 acota, y sólo para el depósito: el durable nonce le saca el reloj a los dos saltos que llevan plata, y el único salto que sigue compitiendo contra un blockhash es el de la CREACIÓN de la cuenta de nonce, donde no hay nada en riesgo (el encabezado de `./solana/nonce-duradero.ts` lo desarrolla). Las otras tres están intactas.
    // ⛔ PROHIBIDO convertir cualquiera de las cuatro en una afirmación del código sin el reporte del founder pegado al lado (CD-10). Su plan de medición vive en el expediente de la HU, no acá.
    if (this.firmaPorEnlace && this.caminoPorEnlace() !== null) { // WKH-358/DT-1: el colaborador CABLEADO ya no alcanza — hace falta que ESTE recorrido sea por enlace (elección del selector Y `availability === "none"`). Ver `caminoPorEnlace`, `:2239`
      // El almacén y el `href` se toman de acá y no del sitio de composición porque `PedidoDeFirma`
      // los pide y el colaborador no los trae. ⚠️ Sin `localStorage` o sin `location` este entorno no
      // puede ni recordar la firma ni volver del salto: el viaje no se puede completar, y ésa es
      // exactamente la afirmación de `deeplink_sin_memoria`.
      const entorno = this.entornoDeEnlace();
      if (entorno === null) throw new Error("deeplink_sin_memoria");
      const almacen = entorno.almacen;

      // 🔴 CD-11, REESCRITO EN WKH-358 CON LA MEDICIÓN Y EN LAS MISMAS 4 LÍNEAS (este bloque recibe [[CENSO src/infrastructure/solana-wallet.ts entrantes-desde-906=78]] citas ancladas por debajo —marcador verificado; decía 47, después 65, y las DOS veces se copió a la frase gemela de `:893`—). Acá decía «el `sender` … NUNCA del canal del enlace», sin calificar el camino, y esa mitad se volvió FALSA. El `sender` sigue saliendo de `this.getAddress()` (guard `:560-561`, sin cambios), pero `getAddress()` tiene ahora DOS fuentes y cuál se usa lo decide el gate (`caminoPorEnlace`, `:2239`):
      // · camino INYECTADO ⇒ el bridge, o sea FUERA del canal (y ahí esta rama ni corre: el mismo gate la apaga). · camino POR ENLACE ⇒ (`direccionDelViajeConectado`, `:2307`), que lee `Viaje.direccion`, o sea DENTRO del canal — y no hay alternativa: sin extensión el bridge está vacío.
      // ⇒ En el camino por enlace, el guard (`DEEPLINK_SENDER_MISMATCH`, `./solana/deeplink/firma-por-enlace.ts:691`) compara dos lecturas del MISMO disco: es COHERENCIA INTERNA, no una defensa. El corte que sí lo es está en (`live`, `../presentation/flow.tsx:506`) cruzado contra `rem.ownerAddress`, que escribe `startKyc` en el repo de remesas y que el canal del enlace no puede escribir; su residual (`ownerAddress == null` no dispara ⇒ un forjador del paso 1 puede dejar el depósito en un escrow que la víctima no puede cerrar) está escrito entero en el bloque de (`CD-11`, `./solana/deeplink/firma-por-enlace.ts:639`). Lo mide `T-065-CD11`. ⚠️ Y EL CRUCE ES TIME-OF-CHECK, NO FUENTE-INDEPENDIENTE (fix-pack · AR/BLQ-BAJO-4): en ESTE camino `rem.ownerAddress` lo escribió `startKyc` con la MISMA `Viaje.direccion` que acá se compara, así que un forjador anterior a `startKyc` compara A contra A. Lo que el cruce cierra de verdad es la ventana POSTERIOR a `startKyc`, cuando `ownerAddress` ya quedó congelado en el repo de remesas. La fuente-independiente real es un PoP por enlace (WKH-359), que no existe.
      // El `sender` va en su forma CANÓNICA: `senderPk.toBase58()` es el round-trip de `new PublicKey(...)`, que es exactamente lo que hace `canonicalizeAddress`. ⛔ NUNCA `.toLowerCase()`: base58 es case-sensitive y bajarlo a minúsculas fabrica colisiones.
      //
      // ⛔ ACÁ HABÍA UN `try { canonicalizeAddress(sender) } catch { limpiar; throw }` Y SE BORRÓ, con
      // dos motivos medidos, no uno (MNR-CR-2 + AR/BLQ-ALTO-1):
      //   · era INALCANZABLE. `new PublicKey(sender)` (`:573`) corre ~200 líneas antes que esta rama y
      //     tira con exactamente los mismos inputs que `canonicalizeAddress` —es la misma llamada
      //     adentro—, así que ningún `sender` que no parsee llega hasta acá. Medido convirtiendo el
      //     `catch` en un `throw` centinela: no se dispara en toda la suite. Este repo ya decidió qué
      //     hacer con una rama así (`sesion.ts`, docblock de `LecturaDelViaje`): se borra, porque un
      //     test para una rama inalcanzable congela una fantasía.
      //   · y encima LIMPIABA EL DISCO. Era el único sitio de este archivo que borraba antes de tirar y
      //     nadie lo assertaba: si algún día se volviera alcanzable, borraría una firma ya dada por una
      //     falla de NUESTRO lado. La limpieza queda con un solo escritor por capa —`cortar` en el
      //     motor, `limpiarRastroDeEnlace` acá— y ninguno borra una firma salvo cuando está DEMOSTRADO
      //     que no sirve.
      const senderCanonico = senderPk.toBase58();

      const desenlace = this.firmaPorEnlace.resolver({
        almacen,
        ahora: Date.now(),
        hrefActual: hrefDeLaVuelta, // el href COMPLETO: `enlaceDeVuelta` TIRA con uno relativo. 🔴 WKH-373 — ACÁ DECÍA `entorno.href` Y ÉSA ERA LA LÍNEA ROTA: `entornoDeEnlace()` (`:1177`) lee `globalThis.location.href` EN VIVO, y el llamador de producción llega hasta acá DESPUÉS de que `limpiarLaBarra()` (`../presentation/flow.tsx:4023`) le sacó a la barra el `dl`, el `nonce`, el `data` y la clave de cifrado ⇒ `interpretarVuelta` (`./solana/deeplink/firma-por-enlace.ts:709`) recibía una URL sin un solo parámetro de respuesta, contestaba `no-volvimos`, el paso 8 re-anclaba y devolvía OTRO salto: la misma firma, pedida de nuevo en cada vuelta, y la persona sin salir nunca de la bienvenida. ⛔ Y NO se arregla moviendo la limpieza: el paso 2 corre para toda vuelta (AC-4), así que lo que se arregla es de DÓNDE sale el href. Es LITERALMENTE el mismo arreglo que el PoP ya tenía, y cuyo docblock (`completarPop`, `./solana/preparacion-por-enlace.ts:495`) predijo por escrito que iba a volver a pasar. ⚠️ `almacen` y `origin` SIGUEN saliendo de `entorno()`: `replaceState` no toca el disco ni el origen, sólo la query.
        appUrl: entorno.origin,
        remittanceId, // el 2º parámetro, obligatorio. ⛔ NUNCA `null` (T2)
        sender: senderCanonico,
        beneficiary: deposit.escrow.beneficiary,
        authority: deposit.escrow.authority,
        mensajeBase64: tx.serializeMessage().toString("base64"),
        transaccionBase58: bs58.encode(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ),
        referenceBase58: reference.toBase58(),
        // El mensaje canónico de patrocinio, armado con la firma RECUPERADA de la tx que la billetera
        // devolvió — no con la de una tx nueva. Es la MISMA función que usa el camino inyectado.
        mensajeDePatrocinio: (firmaDelSenderB58: string) =>
          new TextEncoder().encode(
            buildSponsorPopMessage({
              sender: senderPk.toBase58(),
              networkId: resolveSolanaNetworkId(),
              remittanceId,
              amountMinor: String(quote.send.minor),
              mint: mintPk.toBase58(),
              txSignatureB58: firmaDelSenderB58,
            }),
          ),
      });

      // Los cortes salen por `throw`, igual que los tres que ya existen en este método
      // (`wallet_not_connected`, `escrow_params_missing`, `sender_signature_missing`): suben por
      // `execute()` sin `try/catch` hasta el `guard()` de la presentación y dejan la remesa en
      // `confirmed`, que es exactamente el estado que AC-3 vuelve re-ejecutable. ⛔ ACÁ DECÍA "El motor ya limpió." Y ES FALSO DESDE EL FIX-PACK 1 (AR-it2/MNR-1), en el mismo hunk que lo introdujo: el motor limpia SÓLO cuando en el disco no queda nada que salvar, y con un resultado ya firmado adentro preserva el viaje Y el ancla a propósito (`resultadoPreservable`, `solana/deeplink/firma-por-enlace.ts:490`). MEDIDO: `viaje=true prep=true` en 3 de 3 cortes con `transaccionFirmada`. Este `throw` NO limpia nada y NO tiene que hacerlo: es lo que permite que la invocación siguiente retome. Lo que queda pendiente y no es de esta capa: nadie limpia el query string de vuelta, así que con una URL de rechazo todavía en la barra la invocación siguiente vuelve a cortar (ola 4 / HU-357).
      if (desenlace.tipo === "corte") throw new Error(desenlace.causa);
      if (desenlace.tipo === "salto") {
        return { estado: "hay-que-salir", irA: desenlace.irA, esperando: desenlace.esperando };
      }

      // ── DT-10 · BYTES CONTRA BYTES ───────────────────────────────────────────────────────────────
      // ⛔ NO se compara contra una tx RECONSTRUIDA: la `reference` es un `Keypair.generate()` nuevo
      // en cada llamada (`:625`), el `deadline` sale del reloj (`:592-594`) y el blockhash cambia
      // (`getLatestBlockhash`, `:830`). Una reconstrucción no coincidiría JAMÁS y el chequeo se
      // volvería un "siempre falla" que alguien borraría. Se compara contra el mensaje ANCLADO.
      //
      // 🔴 EL ANCLA LA TRAE EL DESENLACE, y antes acá había un SEGUNDO `leerPreparado` con OTRO
      // `Date.now()` (MNR-CR-6). Con dos lecturas del mismo registro la responsabilidad quedaba
      // partida —el motor validaba `beneficiary`/`authority` sobre una lectura, el adaptador anclaba
      // los bytes sobre otra— y había una rama "el registro ya no está" que ningún test podía
      // alcanzar. Ahora el motor devuelve el ancla que ÉL validó: una lectura, un reloj, y el caso
      // "hay firma y no hay ancla" lo decide el motor, donde sí se puede probar.
      //
      // ⛔ Y LA LIMPIEZA DE ESTE CAMINO ES DE ACÁ, no del motor (AR/MNR-3): recién se limpia cuando
      // los bytes se verificaron Y la cadena contestó por el blockhash. Limpiar antes dejaba a la
      // persona sin nada que reanudar cuando el que fallaba era un RPC nuestro.
      let devuelta: Web3Transaction;
      try {
        devuelta = Transaction.from(bs58.decode(desenlace.transaccionFirmadaBase58));
      } catch {
        // Lo que hay en el disco no es una transacción: no hay nada que reanudar con eso.
        anotarHuellaDeLaVuelta(HUELLA_ILEGIBLE); this.limpiarRastroDeEnlace(almacen); // WKH-373: el sitio y la huella, EN ESTA MISMA LÍNEA (Δ0). Los siete emisores escriben la MISMA causa y desde la pantalla son indistinguibles: sin esto hay que probar cuatro veces en un teléfono para saber cuál fue.
        anotarSitioDelCorte("E4-deposito-ilegible"); throw new Error("deeplink_tx_alterada"); // WKH-373: el sitio, PEGADO al `throw` y en su MISMA línea (Δ0). ⛔ En la misma línea física a propósito: es lo que el candado de `./solana/deeplink/bitacora-del-corte.test.ts` puede verificar sin interpretar el bloque.
      }
      const mensajeDevuelto = devuelta.serializeMessage(); anotarHuellaDeLaVuelta(huella(mensajeDevuelto.toString("base64"))); // WKH-373: la huella de lo que VOLVIÓ, en la línea que existe (Δ0) y ⛔ TAMBIÉN en el camino feliz. Al lado de la del ancla —que el bloque de `?diag=1` saca del disco— es lo que separa «el ancla se pisó» (dos huellas legibles y distintas) de «la billetera devolvió cualquier cosa» (`ILEGIBLE`).
      if (mensajeDevuelto.toString("base64") !== desenlace.mensajeBase64) {
        this.limpiarRastroDeEnlace(almacen); // WKH-373: el sitio, EN ESTA MISMA LÍNEA (Δ0)
        anotarSitioDelCorte("E5-deposito-bytes-distintos"); throw new Error("deeplink_tx_alterada"); // WKH-373: el sitio, PEGADO al `throw` y en su MISMA línea (Δ0). ⛔ En la misma línea física a propósito: es lo que el candado de `./solana/deeplink/bitacora-del-corte.test.ts` puede verificar sin interpretar el bloque.
      }
      // Y que la firma del sender VERIFIQUE sobre esos bytes. Sin esto, alcanzaría con devolver la
      // misma transacción con la firma en cero: los bytes del MENSAJE coincidirían igual, porque las
      // firmas no son parte del mensaje.
      const firmaDevuelta = devuelta.signatures.find((s) => s.publicKey.equals(senderPk))?.signature;
      if (
        !firmaDevuelta ||
        !nacl.sign.detached.verify(
          new Uint8Array(mensajeDevuelto),
          new Uint8Array(firmaDevuelta),
          senderPk.toBytes(),
        )
      ) {
        this.limpiarRastroDeEnlace(almacen); // WKH-373: el sitio, EN ESTA MISMA LÍNEA (Δ0)
        anotarSitioDelCorte("E6-deposito-firma-no-verifica"); throw new Error("deeplink_tx_alterada"); // WKH-373: el sitio, PEGADO al `throw` y en su MISMA línea (Δ0). ⛔ En la misma línea física a propósito: es lo que el candado de `./solana/deeplink/bitacora-del-corte.test.ts` puede verificar sin interpretar el bloque.
      }

      // ── DT-9 · EL BLOCKHASH, Y POR QUÉ ESTO NO ES UNA OPTIMIZACIÓN ───────────────────────────────
      // Un blockhash vive ~60-90 s (ver `:104`). Entre fijarlo y volver con las dos firmas hubo dos
      // saltos a otra app, una persona leyendo y dos vueltas. Es muy probable que ya no exista.
      //
      // 🔴 SIN ESTO, EL MODO DE FALLA POR DEFAULT ES EL PEOR QUE ESTE REPO TIENE CATALOGADO:
      //   blockhash vencido → `solana_settle_broadcast_failed` → NO está en
      //   SETTLE_REASONS_BEFORE_BROADCAST → `failAfterBroadcast` le pregunta a la cadena → la cuenta
      //   no existe → `probeDeposit` contesta "unknown" POR DISEÑO (`probeDeposit`, `:1254`) →
      //   PRINCIPAL_STATE_UNKNOWN → la pantalla dice "no sabemos si te cobramos" sobre algo que SÍ
      //   sabemos: no salió nada, porque nunca hubo POST al settle.
      // Con esto, "no se movió nada" pasa a ser un HECHO en vez de una incógnita.
      //
      // ⛔ NO se agrega al camino inyectado: ahí sería una llamada de red de más antes de cada firma,
      // y CD-1 lo prohíbe.
      //
      // ⚠️ ACÁ DECÍA QUE LA SALIDA ESTRUCTURAL (durable nonce account) ERA "OTRA HU". ESA HU ES ÉSTA
      // (WKH-357) y la frase quedó falsa, así que se reescribe en vez de dejarla envejecer:
      //
      // El camino por enlace YA NO fija un blockhash de red: fija el valor de la cuenta de nonce del
      // remitente, que no vence por tiempo (ver el bloque de WKH-357 arriba, donde se arma la tx). O
      // sea que la carrera contra el reloj que este comentario describía **no existe en este camino**.
      // Lo que sigue abajo NO es una sonda de frescura de blockhash: es la comparación del valor del
      // nonce, y sus desenlaces son otros (el nonce AVANZÓ, o la cuenta NO ESTÁ).
      //
      // ⚠️ Y LO QUE SIGUE SIENDO CIERTO, sin suavizar (CD-14): el durable nonce elimina la carrera de
      // los dos saltos QUE LLEVAN PLATA, y queda expuesto UN salto —el de la tx que CREA la cuenta de
      // nonce, que usa un blockhash normal—. Eso es aceptable y no es lo mismo: en ese salto no hay
      // nada en riesgo (ningún escrow, ningún USDC, ninguna orden de payout) y si el blockhash vence,
      // el reintento pide uno nuevo y no cuesta más que un toque.
      //
      // ⚠️ [NO VERIFICADO] — nada de esto está medido en un teléfono real, y el `[NO VERIFICADO]` de
      // 062 se hereda entero: que la billetera vuelva al mismo origen y que la tx devuelta sea
      // byte-idéntica siguen siendo afirmaciones sobre un runtime móvil que este repo NO midió.
      //
      // ⚠️ TRES DESENLACES Y NO DOS (AR/MNR-3). La sonda tiene TECHO —`withTimeout`, el mismo helper y
      // el mismo número que las otras tres sondas de este archivo— porque un RPC que acepta la conexión
      // y no contesta dejaba el botón girando PARA SIEMPRE, y encima sobre un recorrido cuyas firmas la
      // versión anterior ya había borrado. Y vencido el techo la respuesta NO es "venció el blockhash":
      // es "no pudimos preguntar", que es una causa distinta y con una consecuencia distinta —no se
      // limpia nada, así que un reintento puede completar el recorrido. Colapsar los dos es exactamente
      // convertir "no pude preguntar" en "no pasó".
      const blockhashDevuelto = devuelta.recentBlockhash;
      if (!blockhashDevuelto) {
        this.limpiarRastroDeEnlace(almacen); // WKH-373: el sitio, EN ESTA MISMA LÍNEA (Δ0)
        anotarSitioDelCorte("E7-deposito-sin-blockhash"); throw new Error("deeplink_tx_alterada"); // WKH-373: el sitio, PEGADO al `throw` y en su MISMA línea (Δ0). ⛔ En la misma línea física a propósito: es lo que el candado de `./solana/deeplink/bitacora-del-corte.test.ts` puede verificar sin interpretar el bloque.
      }
      // 🔴 WKH-357 · ACÁ SE LE PREGUNTABA A `isBlockhashValid` Y YA NO SE PUEDE (AC-7). El valor que
      // trae esta transacción es el de una cuenta de nonce, y `isBlockhashValid` contesta `false` para
      // él — CORRECTAMENTE, porque no está entre los ~150 blockhashes recientes. Con la sonda vieja,
      // ese `false` caía en el `deeplink_blockhash_expired` de abajo, que LIMPIA EL DISCO: la feature
      // moría en el cliente y le borraba a la persona las DOS firmas antes de que el facilitator viera
      // nada. Ése es el guard que 062 agregó (DT-9), correcto para su caso, que esta HU vuelve
      // incorrecto.
      //
      // Lo que se pregunta ahora es la ÚNICA cosa que decide si esta tx puede entrar: ¿el valor
      // guardado en la cuenta de nonce sigue siendo el que la tx lleva? Se relee la cuenta acá y no se
      // reusa nada del bloque de arriba — ⛔ PROHIBIDO memoizar el valor en un campo del adapter, que
      // es un SINGLETON del container (la misma regla que este archivo ya escribe para la sonda del
      // índice). Y es lo que AC-6 exige: después de un fallo, el reintento tiene que leer el valor
      // VIGENTE, no el que teníamos.
      const noncePkDeVuelta = await direccionDelNonce(senderPk);
      const lecturaDeVuelta = await leerNonce(connection, noncePkDeVuelta, (p) =>
        withTimeout(p, BLOCKHASH_PROBE_TIMEOUT_MS),
      );
      if (lecturaDeVuelta.tipo === "no-pudimos-preguntar") {
        // ⛔ SIN `limpiarRastroDeEnlace`: las dos firmas pueden estar perfectas y el que falló fue un
        // RPC nuestro. Borrarlas acá sería castigar a la persona por nuestra infraestructura.
        // (Este comentario es el de DT-9 y sigue valiendo palabra por palabra: el techo vencido y el
        // RPC caído entran los dos por acá, y ninguno afirma que la transacción esté muerta.)
        throw new Error("deeplink_blockhash_desconocido");
      }
      // Los otros dos desenlaces significan lo MISMO para esta transacción —no puede entrar en ningún
      // bloque nunca más— y por eso comparten causa y limpieza:
      //   · `no-hay`  ⇒ la cuenta de nonce no está (o dejó de estar): no hay contra qué validar.
      //   · `hay` con un valor DISTINTO ⇒ el nonce YA AVANZÓ, o sea que otra tx lo consumió.
      // ⚠️ Y ojo con la diferencia contra el bloque de arriba: allá `no-hay` es el caso NORMAL y
      // esperado (la cuenta todavía no existe) y NO limpia porque no se firmó nada; acá ya hay dos
      // firmas dadas sobre un valor que no sirve, y limpiar es lo que evita que el próximo intento
      // vuelva a encontrar la misma firma muerta y corte igual durante 20 minutos.
      if (lecturaDeVuelta.tipo === "no-hay" || lecturaDeVuelta.valor !== blockhashDevuelto) {
        // La cadena CONTESTÓ que no. Esa transacción no puede entrar en ningún bloque nunca más, así
        // que el recorrido está muerto y lo que se limpia no le sirve a nadie: sin esta limpieza el
        // próximo intento volvería a encontrar la misma firma muerta y a cortar igual, durante 20 min.
        this.limpiarRastroDeEnlace(almacen);
        throw new Error("deeplink_blockhash_expired");
      }

      // El envelope, con LA REFERENCE PERSISTIDA — la que está DENTRO de la transacción firmada, no la
      // del `Keypair.generate()` de esta invocación, que se descartó con la tx que la llevaba.
      const serializadaDeVuelta = Buffer.from(bs58.decode(desenlace.transaccionFirmadaBase58)).toString("base64");
      // Recién ACÁ se limpia el camino de éxito (CD-10: leer → usar → limpiar). Todo lo que hacía falta
      // del disco ya está en variables locales de este bloque.
      this.limpiarRastroDeEnlace(almacen);
      return {
        estado: "listo",
        tx: serializadaDeVuelta,
        solana: {
          vm: "solana",
          partialSignedTx: serializadaDeVuelta,
          reference: desenlace.referenceBase58,
          popSignature: desenlace.firmaDePatrocinio,
        },
      };
    }

    const signed = (await solanaWalletBridge.signTransaction(tx)) as Web3Transaction; // AC-2: partial-sign SÓLO wallet
    const serialized = signed
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
    // AC-3/CD-SDD-1: NUNCA connection.sendRawTransaction / sendTransaction acá.

    // ── SDD 037 — SEGUNDO prompt de billetera (Guard B) ────────────────────────────────────────
    // La persona ya firmó la transacción; ahora firma un TEXTO que dice, en palabras, qué está
    // autorizando. No es redundante: la firma de la transacción prueba posesión de la llave, este
    // mensaje prueba consentimiento sobre ESTE depósito y ESTE momento. Sin él, una firma de
    // transacción capturada alcanza para que un tercero pida el patrocinio de un depósito que
    // nunca autorizó. PROHIBIDO fusionarlo con el prompt anterior: son dos preguntas distintas.
    //
    // Lo que este mensaje NO agrega, para que nadie le atribuya de más (CR MNR-1): no defiende el
    // monto ni el token. Los dos viven adentro de los bytes que la wallet ya firmó, así que
    // cambiarlos rompe la firma de la TRANSACCIÓN y lo corta Guard A del lado del facilitator, con
    // Guard B caído o no. Ver `sponsor-pop-message.ts` para el detalle medido.
    const senderSigEntry = signed.signatures.find((s) => s.publicKey.equals(senderPk));
    const senderSigBytes = senderSigEntry?.signature;
    if (!senderSigBytes) {
      // Fail-loud, coherente con los guards de arriba: sin la firma de la wallet no hay nada que
      // autorizar, y seguir armaría un mensaje con la línea `tx` vacía que el servidor va a rechazar.
      throw new Error("sender_signature_missing");
    }
    const popMessage = buildSponsorPopMessage({
      sender: senderPk.toBase58(),
      networkId: resolveSolanaNetworkId(),
      remittanceId,
      amountMinor: String(quote.send.minor),
      mint: mintPk.toBase58(),
      txSignatureB58: bs58.encode(new Uint8Array(senderSigBytes)),
    });
    const popSignature = await this.signMessage(popMessage);
    // ⚠️ RECORDATORIO DE ALCANCE (AR/MNR-4): "el camino inyectado no ejecuta ni una línea nueva" vale
    // para ESTE archivo y está medido, pero NO para el use-case. El guard de reanudación de
    // `confirm-and-send.ts` no está adentro de ningún `if` de enlace: una segunda invocación sobre una
    // remesa ya `confirmed` antes moría con `invalid_transition:confirmed->confirmed` y ahora sigue de
    // largo. Ese cambio es AC-3 y es intencional; lo que no se puede afirmar es que el camino inyectado
    // quedó intacto de punta a punta.

    return { estado: "listo", // WKH-356/AC-2 — el envoltorio es LO ÚNICO que cambia en este camino: ni un campo, ni un guard, ni una ix se movió. La regresión byte-idéntica del camino inyectado es CD-1. Y va EN ESTA LÍNEA, no en una nueva: `solana-wallet.ts` recibe citas por número desde `ports.ts`, tres archivos de test y `chain.ts`, y una línea de más acá arriba las rota a todas.
      tx: serialized,
      solana: {
        vm: "solana",
        partialSignedTx: serialized,
        reference: reference.toBase58(),
        popSignature,
      },
    };
  }

  /**
   * El disco y la URL de este navegador, o `null` si este entorno no los tiene.
   *
   * 🔴 POR QUÉ LA LECTURA VA ADENTRO DE UN `try` (MNR-CR-7). Todo el resto del código de enlace envuelve
   * las OPERACIONES del disco y sus docblocks nombran "el modo privado de algunos navegadores"; lo que
   * no estaba envuelto era el acceso a la PROPIEDAD, que en ese mismo escenario puede tirar antes de que
   * ninguna costura exista. Sin esto, `authorizePrincipal` subía un error FUERA del vocabulario
   * `deeplink_*` y la pantalla no tenía ninguna causa que traducir.
   *
   * ⚠️ `[NO VERIFICADO]` en un navegador real (CD-12): que un getter de `localStorage` lance está medido
   * acá con un doble, no en un teléfono.
   */
  private entornoDeEnlace(): { almacen: Almacen; href: string; origin: string } | null {
    try {
      const g = globalThis as {
        localStorage?: Storage;
        location?: { href: string; origin: string };
      };
      const disco = g.localStorage;
      const url = g.location;
      if (!disco || !url) return null;
      return { almacen: almacenDeNavegador(disco), href: url.href, origin: url.origin };
    } catch {
      return null;
    }
  }

  /**
   * Borra el rastro del recorrido por enlace: el viaje (con la x25519 y los resultados) y el registro
   * del intento.
   *
   * 🔴 ESTE ES EL ÚNICO ESCRITOR DE LIMPIEZA DE ESTE ARCHIVO, a propósito. La otra limpieza del sistema
   * es `cortar` en el motor. Dos escritores, uno por capa, cada uno con UNA implementación: es lo que
   * permite decir de una sola vez cuándo se borra y cuándo no.
   *
   * ⛔ Y NO SE LLAMA "por las dudas". Sólo desde los puntos donde está DEMOSTRADO que lo guardado no
   * sirve (los bytes no son los que se pidieron firmar, la cadena dijo que el blockhash murió) o donde
   * el envío entero terminó (`abandonarAutorizacion`). Un corte que no puede afirmar eso preserva: ver
   * el bloque de `cortar` en `firma-por-enlace.ts`.
   */
  private limpiarRastroDeEnlace(almacen: Almacen): void {
    terminarViaje(almacen);
    terminarPreparado(almacen);
  }

  /**
   * El envío terminó —bien o mal— y lo que quedaba guardado para completar una firma ya no sirve.
   *
   * 🔴 ESTO ERA UN REQUISITO EXPLÍCITO QUE 061 LE DEJÓ A ESTA HU y no estaba (AR/MNR-1). El docblock de
   * `terminarViaje` (`solana/deeplink/sesion.ts`) lo dice con estas palabras: *"cuando el caso de uso da
   * el viaje por cerrado —salió bien o se abandona— tiene que llamar a `terminarViaje`… si no lo hace, la
   * clave privada y la sesión viven hasta 20 minutos de más"*. MEDIDO antes de esto: ninguna salida de
   * abandono de `execute()` tocaba el almacén, así que la x25519 privada, la sesión y una transacción
   * firmada sobrevivían a la remesa que las produjo.
   *
   * ⚠️ ACÁ SÍ SE BORRA UNA FIRMA YA DADA, y es lo correcto justamente acá: la remesa quedó en
   * `payout_failed`, así que esa firma no puede usarse nunca más. Es la diferencia con un corte del
   * motor: "se venció el paso" no es "se abandonó el envío".
   *
   * Con el colaborador de enlace ausente —que es como queda producción al cerrar 062 (CD-13)— esto no
   * toca el disco ni una vez: no hay ningún recorrido por enlace del que limpiar nada, y el camino de la
   * billetera inyectada nunca escribió en `localStorage`.
   */
  abandonarAutorizacion(): void {
    if (!this.firmaPorEnlace) return;
    const entorno = this.entornoDeEnlace();
    if (entorno === null) return; // sin disco no hay nada que limpiar, y avisarlo no le sirve a nadie
    this.limpiarRastroDeEnlace(entorno.almacen);
  }

  /**
   * ¿Entró el principal al vault del escrow de ESTA remesa? Se lo pregunta A LA CADENA, derivando la
   * MISMA PDA `escrow_state` que arma el deposit (deriveEscrowState, fuente única). No consulta a
   * ningún agente, ni conoce su URL ni su slug: los agentes se reemplazan por otros mejores, la cadena
   * no. Reusa el criterio de tres valores de `probeEscrowRefunded`: este es su espejo en la otra
   * punta del money-path.
   *
   * · cuenta presente y decodificable ⇒ "deposited". La cuenta `escrow_state` sólo la crea la ix
   *   `deposit`, así que su existencia ES la prueba de que el depósito entró.
   * · cuenta AUSENTE ⇒ "unknown", NUNCA "not_deposited". Que todavía no esté no prueba que no vaya a
   *   estar: la tx puede estar en vuelo con un blockhash vivo (~60-90 s) y aterrizar un segundo
   *   después. Es la misma lección que `probeEscrowRefunded`: la ausencia de una cuenta no dice a
   *   dónde fue la plata, dice que no la vimos.
   * · RPC caído / bytes indecodificables ⇒ "unknown". No pudimos preguntar, y eso se dice.
   *
   * Por eso hoy este método no devuelve "not_deposited": ese valor lo aportan los guards que cortan
   * ANTES de que la tx salga. Queda en el contrato para el día que se pueda PROBAR la ausencia (leer
   * el blockHeight y ver que el blockhash del deposit ya venció) sin cambiarle la forma a nadie.
   */
  async probeDeposit(input: { remittanceId: string; sender: string }): Promise<PrincipalDepositState> {
    const senderB58 = input.sender?.trim() ? input.sender : ((await this.getAddress()) ?? "");
    // Sin sender o sin id no hay PDA que derivar: no es que no haya depósito, es que no podemos mirar.
    if (!senderB58 || !input.remittanceId?.trim()) return "unknown";
    try {
      const web3 = await import("@solana/web3.js");
      const { PublicKey: PublicKeyLazy, Connection } = web3;
      const anchor = await import("@coral-xyz/anchor");
      const { escrowIdl } = await import("./solana/escrow-idl");

      const senderPk = new PublicKeyLazy(senderB58); // valida base58 (CD-SDD-7)
      const programId = new PublicKeyLazy((escrowIdl as { address: string }).address);
      const { pda } = this.deriveEscrowState(senderPk, programId, input.remittanceId);

      const connection = new Connection(
        resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe
      );
      const info = await connection.getAccountInfo(pda);
      if (!info) return "unknown"; // ausencia ≠ prueba: la tx puede seguir en vuelo
      // Decodificar es lo que distingue "la cuenta del escrow de esta remesa" de una cuenta ajena que
      // cayó en la misma dirección. Si no decodifica, el catch responde "unknown" (no inventamos un no).
      new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl).decode("EscrowState", info.data);
      return "deposited";
    } catch {
      return "unknown"; // no pudimos preguntar; NO es una respuesta negativa
    }
  }

  /**
   * ¿Cuánto SOL tiene el remitente? Es la pregunta que nadie hacía: un grep de `getBalance` en este
   * repo no devolvía nada, así que alguien con 0 SOL llegaba a firmar igual y descubría el problema
   * cuatro reintentos después, como un 502 sin diagnóstico.
   *
   * Devuelve los DOS valores que existen, sin colapsarlos:
   *   · { known, lamports } — la cadena contestó.
   *   · { unknown }         — no pudimos preguntar: RPC caído, respuesta ilegible, o la consulta tardó
   *     más que el techo de acá abajo. NO es "tiene cero". Quien lo consume ya sabe que con esto no
   *     puede afirmar nada sobre la billetera de la persona.
   *
   * EL TECHO DE TIEMPO NO ES DECORATIVO: esta consulta se agrega al camino que la persona recorre
   * apretando un botón. Sin techo, un RPC colgado dejaría el flujo esperando por un dato que sólo
   * sirve para mejorar un mensaje de error. 5 s es holgado para un `getBalance` (una lectura simple,
   * sin firma ni confirmación) y sigue siendo mucho menos que los 15 s del settle.
   */
  async probeSenderSolBalance(input: { sender: string }): Promise<SolanaSenderSolBalance> {
    const senderB58 = input.sender?.trim() ? input.sender : ((await this.getAddress()) ?? "");
    if (!senderB58) return { status: "unknown" }; // sin address no hay a quién consultarle el saldo
    try {
      const { PublicKey: PublicKeyLazy, Connection } = await import("@solana/web3.js");
      const senderPk = new PublicKeyLazy(senderB58); // valida base58 (CD-SDD-7)
      const connection = new Connection(
        resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe
      );
      const lamports = await withTimeout(
        connection.getBalance(senderPk),
        SOL_BALANCE_PROBE_TIMEOUT_MS,
      );
      // Un RPC que contesta algo que no es un número finito no contestó: no se inventa un cero.
      if (typeof lamports !== "number" || !Number.isFinite(lamports)) return { status: "unknown" };
      return { status: "known", lamports };
    } catch {
      return { status: "unknown" }; // no pudimos preguntar; NO es un saldo de cero
    }
  }

  // HU-SOL-13 (WKH-216/AC-6/AC-7, CD-10): refund TRUSTLESS del escrow. El SENDER firma + el SENDER
  // broadcastea (feePayer=sender), SIN facilitator ni release-authority (CD-10). Antes de firmar lee
  // `EscrowState` on-chain (autoritativo, AH-14/NC-3) y ABORTA client-side si status≠Deposited o
  // now<deadline (evita una tx que revertiría; defensa en profundidad — el programa ya rechaza
  // EscrowNotDeposited/DeadlineNotReached). Reusa remittanceIdToBytes16 + la derivación PDA de
  // authorizePrincipal. CD-15: libs isomórficas (@noble/hashes, TextEncoder, Buffer polyfill de Next),
  // NUNCA node:crypto — el test-env `node` enmascara la falla del bundle browser.
  // HU-SOL-20/AC-2: `remittanceId` pasa a OPCIONAL. Con id presente el método queda BYTE-IDÉNTICO
  // (AC-6, cero cambio en el path que ya funciona); sin id se resuelve desde el store durable
  // server-side (AC-2) y recién entonces sigue el MISMO camino, guards autoritativos incluidos.
  async refundEscrow(remittanceId?: string, sender?: string): Promise<SolanaEscrowRefundResult> {
    // ── GUARDS fail-loud — ANTES de leer/construir/firmar nada ──
    const senderB58 = sender ?? (await this.getAddress());
    if (!senderB58) throw new Error("wallet_not_connected");

    // HU-SOL-20/AC-2: id presente ⇒ NO se consulta el resolver (AC-6). Ausente/vacío ⇒ recuperación.
    // 🔴 `idPedido` no es sólo trazabilidad: dice CUÁNTAS firmas pide esta llamada. Con el id presente
    // hay UNA (la de la transacción, más abajo). Sin él, el resolver pide primero la de posesión, y
    // recién después viene la de la transacción. Esa diferencia es la que hace falta al firmar.
    const idPedido =
      typeof remittanceId === "string" && remittanceId.trim().length > 0 ? remittanceId : undefined;
    // WKH-347 — TRES caminos de entrada, no dos, y el tercero es el que trae un `EscrowId16` desde el
    // índice on-chain. Los dos que ya existían no cambian ni un byte: con el id presente el resolver
    // NI SE ROZA, y sin id se sigue preguntando primero al registro durable.
    const target: EscrowRecoveryTarget =
      idPedido !== undefined
        ? { via: "ledger", remittanceId: idPedido }
        : await this.resolveEscrowTarget(senderB58);

    // ── lazy-import (patrón authorizePrincipal, DT-SDD-8) ──
    const web3 = await import("@solana/web3.js");
    const { PublicKey, Transaction, Connection } = web3;
    const anchor = await import("@coral-xyz/anchor");
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const { escrowIdl } = await import("./solana/escrow-idl");

    const senderPk = new PublicKey(senderB58); // valida base58 (CD-SDD-7)
    const programId = new PublicKey((escrowIdl as { address: string }).address); // DR5G…SE4x

    // ── PDA escrow_state (misma derivación que authorizePrincipal / cross-repo, AH-9) ──
    // Las dos ramas terminan en la MISMA función de derivación: la del `remittanceId` hashea y
    // delega, la del `id16` entra directo. Por eso no pueden divergir en la PDA que producen.
    const { pda: escrowStatePda, bytes: remittanceIdBytes } =
      target.via === "ledger"
        ? this.deriveEscrowState(senderPk, programId, target.remittanceId)
        : this.deriveEscrowStateFromId16(senderPk, programId, target.id16);

    const connection = new Connection(
      resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe
    );

    // ── Read on-chain (autoritativo): status==Deposited && now>=deadline (AC-6/AC-7) ──
    // 🔴 LOS TRES GUARDS DE ABAJO CORREN COMPLETOS PARA LOS TRES CAMINOS DE ENTRADA, incluido el del
    // índice. El índice NO es autoritativo sobre el estado de un escrow: dice que alguna vez se
    // registró, no que siga abierto ni que esté vencido. ⛔ PROHIBIDO saltear, reordenar u
    // "optimizar" esta secuencia porque el índice ya dijo algo.
    const info = await connection.getAccountInfo(escrowStatePda);
    if (!info) throw new Error("escrow_not_found"); // nada que refundear
    const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
    const state = coder.decode("EscrowState", info.data) as {
      mint: InstanceType<typeof PublicKey>;
      deadline: { toNumber(): number };
      status: Record<string, unknown>;
    };
    const statusKey = Object.keys(state.status)[0]; // enum anchor 0.30 → { Deposited: {} } | { Released: {} } | ...
    if (statusKey !== "Deposited") throw new Error("escrow_not_deposited"); // AC-6: sólo Deposited
    const deadlineSec = state.deadline.toNumber();
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < deadlineSec) throw new Error("refund_before_deadline"); // AC-7: bloquea pre-deadline

    // ── Build ix `refund` (AH-10) vía anchor Program (mismo shape loose que deposit) ──
    const mintPk = state.mint; // el mint on-chain (autoritativo), NUNCA del cliente
    const vault = getAssociatedTokenAddressSync(mintPk, escrowStatePda, /*allowOwnerOffCurve*/ true);
    const senderAta = getAssociatedTokenAddressSync(mintPk, senderPk);
    const program = new anchor.Program(escrowIdl as unknown as Idl, { connection } as Provider);
    const methods = program.methods as unknown as {
      refund: (...args: unknown[]) => {
        accounts: (a: Record<string, InstanceType<typeof PublicKey>>) => {
          instruction: () => Promise<TransactionInstruction>;
        };
      };
    };
    const ix = await methods
      .refund(Array.from(remittanceIdBytes))
      .accounts({ sender: senderPk, mint: mintPk, escrowState: escrowStatePda, vault, senderAta })
      .instruction();

    // ── feePayer=SENDER (CD-10: sin facilitator) + blockhash + sign SENDER + broadcast SENDER ──
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction().add(ix);
    tx.feePayer = senderPk; // AC-6/CD-10: el sender paga el fee y firma (NUNCA la release-authority)
    tx.recentBlockhash = blockhash;
    // 🔴 LA SEGUNDA FIRMA DE ESTA LLAMADA, cuando el id se resolvió contra el registro (AR/BLQ-BAJO-1).
    // La primera fue la de posesión, adentro del resolver. Las dos las escribe la MISMA billetera con
    // el MISMO texto ("User rejected the request." en Phantom), así que sin etiquetar acá la fase,
    // `lostEscrowRecoveryError` no puede distinguirlas y termina diciendo "no llegamos a preguntar"
    // justo cuando preguntamos, el servidor contestó, miramos la cadena y encontramos un escrow
    // abierto y vencido: los dos guards autoritativos de arriba ya pasaron para llegar hasta acá.
    // Con el id presente NO se re-etiqueta: ahí hay una sola firma, no hay ambigüedad que resolver, y
    // el camino que ya funcionaba propaga exactamente lo que propagaba (AC-6/CD-4).
    // El texto original de la billetera NO se conserva en el código a propósito: en esta pantalla el
    // código se descarta (`flow.tsx` guarda sólo el mensaje traducido), así que arrastrarlo sería
    // prometer un diagnóstico que nadie lee. Lo que se pierde es la distinción entre "la persona
    // canceló" y "el handle de firma no está montado", que el copy de las dos fases ya conflaciona.
    let signed: Web3Transaction;
    try {
      signed = (await solanaWalletBridge.signTransaction(tx)) as Web3Transaction; // firma SÓLO el sender
    } catch (e) {
      if (idPedido !== undefined) throw e; // una sola firma en juego: nada que desambiguar
      throw new Error("escrow_refund_signature_incomplete");
    }
    const signature = await connection.sendRawTransaction(
      signed.serialize(), // requireAllSignatures=true por default (el sender es el único signer)
    );
    // ⚠️ Acá terminaba el método, devolviendo la signature a secas — y el caller la leía como "la
    // plata volvió". No lo era: el RPC ACEPTÓ la transacción, nada más. Entre el getLatestBlockhash de
    // arriba y este punto hay una firma en la wallet que la persona puede tardar un minuto en dar; si
    // el blockhash vence antes de que la tx entre en un bloque (común en devnet), la tx se cae y los
    // USDC siguen en el vault. Preguntar es obligatorio ANTES de afirmar nada.
    const confirmation = await this.confirmRefund(connection, escrowStatePda, signature, {
      lastValidBlockHeight,
      coder,
    });
    return { refundTx: signature, confirmation };
  }

  /** ¿Entró el refund? Devuelve el tri-estado de `EscrowRefundConfirmation` y TIRA `refund_tx_failed`
   *  sólo cuando medimos que la tx entró y revirtió (un "no" real, con evidencia). Nunca colapsa una
   *  indeterminación a éxito ni a fracaso. */
  private async confirmRefund(
    connection: Web3Connection,
    escrowStatePda: InstanceType<typeof PublicKey>,
    signature: string,
    ctx: {
      lastValidBlockHeight: number; // WKH-353: el vencimiento se decide por ALTURA. Acá había además un `blockhash` que nadie consumía; se borró.
      coder: { decode(name: string, data: Buffer): unknown };
    },
  ): Promise<EscrowRefundConfirmation> {
    let reverted = false;
    try {
      // WKH-353: preguntamos por HTTP en vez de suscribirnos. `confirmTransaction` abría SIEMPRE un
      // `signatureSubscribe`, el RPC contesta `-32601`, y la espera se consumía entera sin producir
      // ningún veredicto. El techo sigue siendo UNO y sigue siendo el mismo: ver `awaitSignatureVerdict`, `:2151`.
      const verdict = await withTimeout(
        this.awaitSignatureVerdict(connection, signature, {
          lastValidBlockHeight: ctx.lastValidBlockHeight,
        }),
        this.confirmTimeoutMs,
      );
      // La tx entró en un bloque Y el programa la revirtió: eso sí es un "no" (los USDC no se movieron).
      if (verdict.kind === "landed" && verdict.err != null) throw new RefundTxReverted("refund_tx_failed");
      if (verdict.kind === "landed") return "confirmed"; // confirmada sin error ⇒ la ix `refund` se ejecutó
    } catch (err) {
      // Todo lo que NO sea un revert medido es "no pudimos ver": timeout, blockhash vencido, websocket
      // ausente, RPC caído. Un blockhash vencido prueba que la tx no puede entrar DE ACÁ EN ADELANTE,
      // NO que no haya entrado antes ⇒ hay que ir a mirar el estado autoritativo.
      //
      // WKH-353 — el mapeo a los desenlaces con nombre: el `expired` de `SignatureVerdict`, `:2478` ES
      // ese blockhash vencido, y `unseen` es que se nos acabó el tiempo de preguntar, el que llega
      // hasta acá abajo como excepción "confirm_timeout". Por qué NO colapsarlos: está en el tipo.
      reverted = err instanceof RefundTxReverted;
    }
    // Fuente autoritativa: el propio EscrowState. `refund` NO cierra la cuenta (eso lo hace la ix
    // `close`, separada), así que status==Refunded sigue legible después del refund.
    const probed = await this.probeEscrowRefunded(connection, escrowStatePda, ctx.coder);
    // Si la cadena dice Refunded, la plata volvió — aunque ESTA tx haya revertido (puede haberla
    // devuelto un intento anterior). Reportar fallo acá sería la mentira vieja al revés.
    if (probed === "confirmed") return "confirmed";
    if (reverted) throw new Error("refund_tx_failed"); // tx revertida + escrow no Refunded ⇒ no volvió
    return probed; // "pending" | "unknown" — la persona sigue pudiendo reintentar
  }

  /** Lee el EscrowState y responde SÓLO lo que ve. "confirmed" exige status==Refunded, que es la única
   *  lectura que prueba que los USDC salieron del vault hacia el sender. */
  private async probeEscrowRefunded(
    connection: Web3Connection,
    escrowStatePda: InstanceType<typeof PublicKey>,
    coder: { decode(name: string, data: Buffer): unknown },
  ): Promise<EscrowRefundConfirmation> {
    try {
      const info = await connection.getAccountInfo(escrowStatePda);
      // Cuenta ausente: la ix `close` la borra DESPUÉS de un refund O de un release, así que la
      // ausencia no dice a dónde fue la plata. Es indeterminación, NO un éxito.
      if (!info) return "unknown";
      const state = coder.decode("EscrowState", info.data) as { status: Record<string, unknown> };
      // Deposited ⇒ la tx todavía no entró (la plata sigue en el vault, el reintento es válido).
      // Released ⇒ salió hacia el beneficiario, o sea que NO volvió al sender. Ninguno de los dos
      // habilita a decir "recuperaste tus fondos", que es lo único que este método decide.
      return Object.keys(state.status)[0] === "Refunded" ? "confirmed" : "pending";
    } catch {
      return "unknown"; // no pudimos leer (RPC caído / bytes indecodificables): no sabemos, y se dice
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // WKH-327 — `close`: recuperar el alquiler de las dos cuentas del depósito
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  /**
   * Construye, firma y broadcastea la ix `close` del escrow. El SENDER firma y paga el fee, igual que
   * en `refundEscrow` y por la misma razón: es SU alquiler el que vuelve (las dos cuentas se crearon
   * con `payer = sender` en el `deposit`) y `close = sender` en el programa.
   *
   * Qué recupera: los 4.002.000 lamports del `EscrowState` (1.962.720) + la ATA del vault (2.039.280).
   * Qué NO recupera: el alquiler del `EscrowIndex`. Lo verificable desde acá es que esta ix la declara
   * como cuenta OPCIONAL (`escrow-idl.ts`, y el test de `solana-escrow-rent.test.ts`), o sea que hay
   * un `close` válido que ni la recibe, así que su alquiler no puede estar en la cifra que `close`
   * devuelve siempre. Que NINGUNA instrucción la cierre **no se pudo verificar** desde este repo: el
   * IDL no expresa las constraints `close = ...` de Anchor.
   *
   * POR QUÉ EXIGE `remittanceId` Y `refundEscrow` NO: el fallback de refund (`refundEscrow`, `:1329`,
   * que llama a `resolveRemittanceIdFromLedger`, `:353`) elige UNO entre N y actúa sobre él, porque
   * "recuperar mis USDC" tiene un objetivo natural — el escrow que todavía tiene plata. Para `close` no
   * existe ese "el": todos los terminales son igual de cerrables, y elegir uno en silencio le cerraría
   * a la persona una cuenta que no eligió. El descubrimiento (`listCloseable`, `:1861`) devuelve la
   * LISTA y elige ella.
   *
   * ⚠️ POR QUÉ EL LISTER NO TIENE GATEWAY Y EL CIERRE SÍ (apartamiento declarado del SDD §4.1/§4.2,
   * detectado en CR/MNR-3; el SDD lo llamaba `listCloseableEscrows` y ese símbolo nunca existió). El
   * cierre pasa por `SolanaEscrowCloseGateway` porque el use-case `CloseEscrowAccounts` tiene lógica
   * propia —el guard de AC-7 contra la billetera viva— y el gateway es lo que le deja un puerto que
   * doblar. El descubrimiento no tiene use-case: la pantalla le hace UNA pregunta a la cadena y
   * muestra la respuesta, así que el adapter implementa el puerto `SolanaCloseableEscrowLister`
   * directamente y el container lo cablea crudo (`container.ts`, `solanaCloseableEscrows: wallet`),
   * igual que `probeDeposit` y `probeSenderSolBalance`. Un gateway ahí sería una capa que sólo
   * reenvía.
   *
   * 🩸 Si alguna vez ves un 3012 (`AccountNotInitialized`): NO asumas que es el índice. `close` no
   * lleva `associated_token_program` y el programa exige `sender_ata` YA inicializada
   * (`solana-programs/programs/escrow/src/lib.rs:695-700`, leído en F2), así que una ATA de USDC
   * inexistente del remitente produce EL MISMO código. El error no desambigua las dos causas. Antes de
   * "arreglar" la construcción de `escrowIndex` (que probablemente esté bien), verificá la ATA:
   * arreglar lo que no está roto acá significa meter un cambio en el único lugar donde el footgun de la
   * cuenta opcional se puede pisar. Esta HU NO mitiga ese riesgo; lo declara. **No se pudo verificar**
   * qué código emite Anchor exactamente en ese caso: haría falta un `close` real que revierta.
   *
   * NO declara ComputeBudget, a diferencia de `authorizePrincipal`
   * (`ComputeBudgetProgram.setComputeUnitLimit`, `:674`): aquello existía por el
   * tope POR UNIDAD del facilitator, y acá el feePayer es el sender — no hay tope de nadie que
   * respetar. Y el número que haría falta (el consumo de CU de `close`) no existe: los 120.000 de
   * `resolveSolanaComputeUnitLimit` salen del peor caso de `deposit`. Declarar un límite por debajo del
   * consumo real hace que la tx falle.
   */
  async closeEscrow(
    remittanceId: string,
    sender?: string,
  ): Promise<{ closeTx: string; confirmation: EscrowRefundConfirmation }> {
    // ── GUARDS fail-loud — ANTES de leer/construir/firmar nada ──
    const senderB58 = sender ?? (await this.getAddress());
    if (!senderB58) throw new Error("wallet_not_connected");
    // Sin fallback al ledger, a propósito (ver el docblock). Un id vacío/whitespace NO cuenta.
    if (typeof remittanceId !== "string" || remittanceId.trim().length === 0) {
      throw new Error("escrow_id_required");
    }

    // ── lazy-import (patrón authorizePrincipal / refundEscrow, DT-SDD-8) ──
    const web3 = await import("@solana/web3.js");
    const { PublicKey, Transaction, Connection } = web3;
    const anchor = await import("@coral-xyz/anchor");
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const { escrowIdl } = await import("./solana/escrow-idl");

    const senderPk = new PublicKey(senderB58); // valida base58 (CD-SDD-7)
    const programId = new PublicKey((escrowIdl as { address: string }).address); // DR5G…SE4x

    // Misma derivación que deposit/refund (fuente única, AH-9): no pueden divergir.
    const { pda: escrowStatePda, bytes: remittanceIdBytes } = this.deriveEscrowState(
      senderPk,
      programId,
      remittanceId,
    );

    const connection = new Connection(
      resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe
    );

    // ── LECTURA AUTORITATIVA del EscrowState (AC-4/AC-10) ──
    const info = await connection.getAccountInfo(escrowStatePda);
    // AC-10: la cuenta ausente NO es un error. Son DOS situaciones indistinguibles desde acá — ya se
    // cerró (un intento anterior de esta misma persona) o nunca existió (nunca hubo depósito con ese
    // id) — y en las dos no hay alquiler que recuperar acá y NADA salió mal. El copy nombra las dos.
    if (!info) throw new Error("escrow_account_absent");
    const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
    let state: { mint: InstanceType<typeof PublicKey>; status: Record<string, unknown> };
    try {
      state = coder.decode("EscrowState", info.data) as {
        mint: InstanceType<typeof PublicKey>;
        status: Record<string, unknown>;
      };
    } catch {
      throw new Error("escrow_state_unreadable"); // bytes ajenos al layout: no sabemos qué es
    }
    const statusKey = Object.keys(state.status)[0]; // { Released: {} } | { Refunded: {} } | ...
    // AC-4: el programa exige estado terminal. Esto es el guard AUTORITATIVO (la cadena), no el de la
    // UI. Deposited ⇒ el envío sigue en curso y sus cuentas no se pueden cerrar. Este `throw` NO dice
    // dónde está la plata, y el copy tampoco.
    if (statusKey !== "Released" && statusKey !== "Refunded") throw new Error("escrow_not_terminal");
    const mintPk = state.mint; // el mint ON-CHAIN (autoritativo), NUNCA del cliente

    // ── SONDA DEL ÍNDICE (AC-1/AC-2/AC-3) — ANTES de armar y ANTES de firmar ──
    // El orden importa: acá todavía no hay tx que abortar. Si esto corriera después de la firma,
    // "no pudimos preguntar" costaría una firma que la persona ya dio para nada.
    const idx = await this.probeEscrowIndex(connection, senderPk, programId, coder);
    if (idx.status === "unknown") throw new Error("escrow_index_probe_failed"); // AC-3

    // ── Build ix `close` (AH-2/AH-3) ──
    const vault = getAssociatedTokenAddressSync(mintPk, escrowStatePda, /*allowOwnerOffCurve*/ true);
    const senderAta = getAssociatedTokenAddressSync(mintPk, senderPk);
    const program = new anchor.Program(escrowIdl as unknown as Idl, { connection } as Provider);
    const methods = program.methods as unknown as {
      close: (...args: unknown[]) => {
        accounts: (a: Record<string, InstanceType<typeof PublicKey> | null>) => {
          instruction: () => Promise<TransactionInstruction>;
        };
      };
    };
    const ix = await methods
      .close(Array.from(remittanceIdBytes))
      .accounts({
        sender: senderPk,
        mint: mintPk,
        escrowState: escrowStatePda,
        vault,
        senderAta,
        // 🔴 CD-1 + CD-11 — la clave va SIEMPRE, y "sin índice" se escribe `null` EXPLÍCITO.
        // Se escribe con un ternario sobre `idx.status` y NO con `idx.pda ?? null` porque `pda` sólo
        // existe en la rama "present" de la unión discriminada: un `??` sobre un campo opcional es
        // exactamente el camino por el que `undefined` llega a esta clave. Y está MEDIDO
        // (solana-wallet.close.test.ts, describe de caracterización) que `escrowIndex: undefined`
        // manda la PDA IGUAL, idéntico a omitir la clave — con TypeScript sin quejarse.
        // token_program lo resuelve anchor (address fija en el IDL).
        escrowIndex: idx.status === "present" ? idx.pda : null,
      })
      .instruction();

    // ── feePayer=SENDER + blockhash + sign SENDER + broadcast SENDER (espeja refundEscrow) ──
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction().add(ix);
    tx.feePayer = senderPk; // el sender paga el fee y firma: es SU alquiler el que vuelve
    tx.recentBlockhash = blockhash;
    const signed = (await solanaWalletBridge.signTransaction(tx)) as Web3Transaction;
    const signature = await connection.sendRawTransaction(signed.serialize());

    const confirmation = await this.confirmClose(connection, escrowStatePda, signature, {
      lastValidBlockHeight,
    });
    return { closeTx: signature, confirmation };
  }

  /**
   * ¿Existe la PDA `["escrow-index", sender]` y es realmente el índice de ESTE sender? Tres respuestas
   * SEPARADAS (AC-3), porque colapsarlas a `PublicKey | null` es el bug: "no pudimos preguntar"
   * pasaría a leerse como "no existe", y eso arma una tx con `escrowIndex: null` que puede dejar una
   * entrada colgada en el índice — el cap monótono que esa cuenta existe para evitar
   * (`solana/escrow-idl.ts:290-296`).
   *
   * El retorno es una unión DISCRIMINADA y no `{ pda?: PublicKey }` a propósito (CD-11): con un campo
   * opcional, el call-site puede escribir `idx.pda ?? null` y meter `undefined` en la clave, que está
   * medido que manda la PDA igual.
   *
   * Los TRES inputs que producen "unknown" — RPC caído, techo vencido, bytes indecodificables —
   * colapsan aguas arriba en UN solo código (`escrow_index_probe_failed`). Se dice acá para que nadie
   * lea ese código como un diagnóstico fino: la persona no puede hacer nada distinto con cada uno.
   *
   * ⚠️ WKH-347 — A PARTIR DE ACÁ HAY **TRES** LLAMADORES, Y LE DAN A `unknown` TRES DESENLACES
   * DISTINTOS. No es una incoherencia y no hay que "armonizarla". 🔴 Acá decía DOS, y subcontar es
   * exactamente lo que debilita a este docblock: existe para que nadie unifique la divergencia, y con un
   * llamador sin enumerar la unificación parece más barata de lo que es (fix-pack WKH-347, AR/MNR-4).
   *   · `closeEscrow` ABORTA (`escrow_index_probe_failed`). Adivinar ahí puede dejar una entrada
   *     colgada consumiendo un lugar del cupo, y lo único que se pierde abortando es un cierre que la
   *     persona puede reintentar.
   *   · `authorizePrincipal` DEGRADA: sale sin la 2ª ix. El costo de abortar ahí es otro y mucho más
   *     alto — bloquear una remesa legítima por una falla de lectura NUESTRA. Un RPC caído no puede
   *     impedirle a alguien mandar plata.
   *   · `escrowIndexCandidate` (el camino de RECUPERACIÓN, el tercero, agregado por esta HU) ABORTA con
   *     OTRO código: `escrow_index_unreadable`, que llega hasta la pantalla con su copy propio. No
   *     comparte el de `closeEscrow` a propósito — son dos acciones distintas para la persona— y no puede
   *     degradar como `authorizePrincipal`, porque degradar acá sería contestar "no hay" sobre una
   *     pregunta que no se pudo hacer.
   *
   * La rama `present` transporta además las `entries` ya decodificadas: el decode ya se hacía y su
   * resultado se tiraba, y hay dos preguntas que lo necesitan (¿queda cupo? ¿qué escrows redescubrir?).
   * Sigue siendo una unión de TRES, discriminada y sin ningún campo opcional (CD-7).
   */
  private async probeEscrowIndex(
    connection: Web3Connection,
    senderPk: InstanceType<typeof PublicKey>,
    programId: InstanceType<typeof PublicKey>,
    coder: { decode(name: string, data: Buffer): unknown },
  ): Promise<
    | {
        status: "present";
        pda: InstanceType<typeof PublicKey>;
        entries: readonly EscrowId16[];
      }
    | { status: "absent" }
    | { status: "unknown" }
  > {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow-index"), senderPk.toBuffer()],
      programId,
    );
    let info: Awaited<ReturnType<Web3Connection["getAccountInfo"]>>;
    try {
      // withTimeout y no un `await` pelado: un getAccountInfo colgado dejaría a la persona mirando un
      // botón en "Cerrando…" para siempre.
      info = await withTimeout(connection.getAccountInfo(pda), ESCROW_INDEX_PROBE_TIMEOUT_MS);
    } catch {
      return { status: "unknown" }; // RPC caído o techo vencido: NO es "no existe"
    }
    if (info === null) return { status: "absent" }; // la cadena CONTESTÓ: no existe
    let entries: readonly EscrowId16[];
    try {
      // El decode no es decorativo: distingue "el índice de este sender" de "una cuenta que cayó en esa
      // dirección y no es lo que creemos". Meter una cuenta ESCRIBIBLE que no podemos identificar en
      // una tx del money-path es peor que no mandarla.
      const decoded = coder.decode("EscrowIndex", info.data) as {
        entries: ReadonlyArray<Uint8Array | readonly number[]>;
      };
      // `entries` es `vec<[u8;16]>` en el IDL, o sea arrays de bytes. La conversión a `EscrowId16`
      // pasa por el ÚNICO lugar de conversión que tiene este adapter.
      entries = decoded.entries.map((e) => this.id16FromBytes(e));
    } catch {
      return { status: "unknown" };
    }
    return { status: "present", pda, entries };
  }

  /**
   * ¿Entró el `close`? Devuelve el tri-estado y TIRA `close_tx_failed` sólo cuando medimos que la tx
   * entró y revirtió Y la cuenta sigue ahí.
   *
   * ⚠️ DOS DIVERGENCIAS DELIBERADAS respecto de `confirmRefund`, `:1448`. Están escritas acá para
   * que nadie las "armonice" de vuelta en un code review:
   *
   * 1. `confirmRefund` devuelve "confirmed" apenas la tx confirma sin error (`confirmRefund`, `:1448`), SIN leer nada.
   *    Éste NO puede: AC-5 exige que el alquiler volvió se afirme *sólo después de leer que la cuenta
   *    ya no existe*. Un veredicto `landed` sin `err` —lo que WKH-353 puso en el lugar del
   *    `confirmTransaction` que este docblock nombraba acá— prueba que la tx ENTRÓ; leer la ausencia
   *    es lo que prueba que hizo lo que queríamos. El input que pone en rojo cualquier atajo acá: un
   *    doble con el status de la firma OK (antes: `confirmTransaction` OK) y `getAccountInfo` que
   *    sigue devolviendo la cuenta tiene que dar "pending" (test "AC-5: confirmación limpia + la
   *    cuenta SIGUE AHÍ ⇒ 'pending'").
   * 2. La lectura de ausencia lleva commitment "confirmed" EXPLÍCITO; la del refund no lleva ninguno.
   *    Ver `probeEscrowClosed`.
   */
  private async confirmClose(
    connection: Web3Connection,
    escrowStatePda: InstanceType<typeof PublicKey>,
    signature: string,
    ctx: { lastValidBlockHeight: number },
  ): Promise<EscrowRefundConfirmation> {
    let reverted = false;
    try {
      // WKH-353, igual que en `confirmRefund`, `:1448`: por HTTP y sin suscripción.
      const verdict = await withTimeout(
        this.awaitSignatureVerdict(connection, signature, {
          lastValidBlockHeight: ctx.lastValidBlockHeight,
        }),
        this.confirmTimeoutMs,
      );
      if (verdict.kind === "landed" && verdict.err != null) throw new CloseTxReverted("close_tx_failed");
      // ⚠️ Acá NO se devuelve "confirmed". Sigue de largo a la sonda (divergencia 1).
    } catch (err) {
      reverted = err instanceof CloseTxReverted;
    }

    const probed = await this.probeEscrowClosed(connection, escrowStatePda);
    if (probed === "confirmed") return "confirmed"; // la cuenta ya no está: se cerró
    // Revirtió Y la cuenta sigue ahí ⇒ un "no" medido. Si la cuenta NO estuviera, un intento anterior
    // de esta misma persona ya la cerró y reportar fallo sería la mentira vieja al revés.
    if (reverted) throw new Error("close_tx_failed");
    return probed; // "pending" | "unknown" — la persona sigue pudiendo reintentar
  }

  /**
   * Lee la AUSENCIA de `escrow_state` y responde SÓLO lo que ve.
   *
   * Lo que la ausencia prueba: que las dos cuentas se cerraron. `close = sender` aparece UNA SOLA VEZ
   * en todo el programa (`solana-programs/programs/escrow/src/lib.rs:679`, leído en F2) y no hay otra
   * instrucción que borre esa cuenta. Lo que la ausencia NO prueba: a dónde fue la plata — la misma
   * trampa que `probeEscrowRefunded` ya tiene escrita, `:692`. Por eso el copy del éxito NO
   * menciona los USDC (CD-15).
   *
   * ⚠️ El commitment "confirmed" es EXPLÍCITO y no es decorativo. Medido en la librería instalada: el
   * constructor de `Connection` deja `this._commitment = void 0` salvo que le pasen algo
   * (`node_modules/@solana/web3.js/lib/index.cjs.js:5985-6090`) y `_buildArgs` sólo adjunta
   * `commitment` si `override || this._commitment` es truthy (mismo archivo, `:8769-8781`; la cita
   * relativa es del CJS de la librería, NO de este archivo). O sea: sin este argumento
   * la lectura NO manda commitment y la decisión queda del lado del RPC, cuyo default documentado es
   * `finalized`, o sea POR DETRÁS del commitment "confirmed" que la confirmación de la firma ya exigió.
   * Sin este argumento, un `close` genuinamente exitoso reportaría "pending" casi siempre, y "pending"
   * no es gratis: le dice a la persona "no sabemos" sobre algo que a ese nivel sí sabemos.
   *
   * Lo que este argumento CUESTA, dicho: `confirmed` no es `finalized`, así que un rollback de ese slot
   * devolvería las cuentas. Es asimétrico a favor — un rollback RESTITUYE el alquiler y la persona
   * puede volver a cerrar; lo que se pierde es exactitud del mensaje durante esa ventana.
   *
   * 🔴 **No se pudo verificar** contra un RPC real que un `getAccountInfo(pda,"confirmed")` inmediatamente
   * posterior a un veredicto `landed` de `awaitSignatureVerdict`, `:2151` vea el efecto. (WKH-353 cambió
   * QUIÉN aplica el gate de commitment, no que se aplique: lo aplicaba `confirmTransaction`, que ya no
   * está en este archivo, y hoy lo aplica `leerEstado`, `:2159`.) Ningún doble de test puede matar el
   * mutante que borra este argumento: el mock ignora el segundo parámetro y devuelve lo mismo con o sin
   * él. Su detección es del code review, y el único input que lo probaría es un `close` real contra
   * devnet.
   */
  private async probeEscrowClosed(
    connection: Web3Connection,
    escrowStatePda: InstanceType<typeof PublicKey>,
  ): Promise<EscrowRefundConfirmation> {
    try {
      const info = await connection.getAccountInfo(escrowStatePda, "confirmed");
      return info === null ? "confirmed" : "pending";
    } catch {
      return "unknown"; // no pudimos preguntar: no sabemos, y se dice
    }
  }

  /**
   * WKH-327/AC-8 — ¿qué envíos de esta billetera están terminados y todavía tienen sus dos cuentas
   * abiertas? Cruza los ids que el servidor tiene guardados (`POST /api/solana/escrow/remittance-ids`,
   * PoP obligatorio) con una sonda ON-CHAIN, así que incluye envíos que NO están en el `localStorage`
   * de este navegador — que es exactamente la gente que hoy no tiene ningún camino hacia su alquiler.
   *
   * Espeja `resolveRemittanceIdFromLedger`, `:353`, en su disciplina: fail-loud sin resolver, tope
   * de candidatos, UNA sola llamada RPC batch, y un `decode` en try/catch para que una cuenta deforme
   * no rompa la recuperación entera. Tres diferencias, cada una con su razón:
   *
   *  1. Devuelve LA LISTA COMPLETA, no el primero. Para `close` no hay "el" escrow: todos los
   *     terminales son igual de cerrables y la elección es de la persona.
   *  2. El filtro es `Released | Refunded`, no `Deposited`. Es el mismo predicado que el programa
   *     aplica: ofrecer un `Deposited` haría firmar una tx que la cadena revierte.
   *  3. 🚫 SI EL RPC LANZA, PROPAGA. NUNCA devuelve `[]`. "No pudimos preguntar" no es "no tenés
   *     nada", y colapsarlos afirma sobre las cuentas de alguien a partir de nuestra propia falla. Una
   *     lista vacía significa UNA sola cosa: la cadena contestó y no hay nada cerrable.
   *
   * 🔴 Y LA MISMA REGLA CONTRA EL SERVIDOR PROPIO, que es lo que faltaba (2º fix-pack AR/BLQ-MED-2).
   * La razón 3 se cumplía contra el RPC y se rompía una capa antes: el resolver colapsaba en `[]` sus
   * tres degradaciones (PoP apagado, registro apagado, PoP rechazado), y esa lista vacía llegaba acá
   * indistinguible de la legítima. Por eso ahora se consume `lookupBySender`, que las separa, y un
   * `not_asked` SALE POR EL MISMO `throw` que un RPC caído. Sin resolver, o con un resolver que no
   * sepa contestar los tres desenlaces, esto NO adivina: tira `escrow_id_unavailable`.
   */
  async listCloseable(input: { sender: string }): Promise<readonly CloseableEscrow[]> {
    const resolver = this.remittanceIdResolver;
    // Fail-loud, nunca silencioso. No hay a qué caer de vuelta: el método que devolvía `string[]` y
    // colapsaba los tres `not_asked` en `[]` se borró del puerto en WKH-331, y el refund consume el
    // mismo `lookupBySender` que esto. Un doble que quiera fingir "no pude preguntar" tiene que decirlo.
    if (!resolver?.lookupBySender) throw new Error("escrow_id_unavailable");
    const lookup = await resolver.lookupBySender(input.sender);
    // El `reason` viaja en el código para el diagnóstico; el copy NO lo interpola (CD-5) y colapsa los
    // tres en una sola frase, porque la persona no puede hacer nada distinto con cada uno.
    if (lookup.outcome === "not_asked") {
      throw new Error(`escrow_recovery_unavailable:${lookup.reason}`);
    }
    // El tope es del SERVIDOR (`remittance-ids/route.ts:32`, MAX_IDS = 20): pedir más no puede
    // devolver más. Un remitente con más filas no ve las más viejas — declarado, no mitigado (L-8).
    const candidates = lookup.remittanceIds.slice(0, MAX_CLOSEABLE_CANDIDATES);
    // `answered` es lo único que llega hasta acá, así que esto sí es una respuesta del servidor sobre
    // esta billetera — y es la única premisa de la que cuelga la frase "no encontramos" de la pantalla.
    if (candidates.length === 0) return [];

    const web3 = await import("@solana/web3.js");
    const { PublicKey: PublicKeyLazy, Connection } = web3;
    const anchor = await import("@coral-xyz/anchor");
    const { escrowIdl } = await import("./solana/escrow-idl");

    const senderPk = new PublicKeyLazy(input.sender); // valida base58 (CD-SDD-7)
    const programId = new PublicKeyLazy((escrowIdl as { address: string }).address);
    const pdas = candidates.map((id) => this.deriveEscrowState(senderPk, programId, id).pda);

    const connection = new Connection(
      resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe
    );
    // UNA sola llamada RPC para los N candidatos. Sin try/catch a propósito: ver la razón 3 del
    // docblock. Si esto lanza, el error sube y el copy dice "no llegamos a preguntar".
    const infos = await connection.getMultipleAccountsInfo(pdas);
    const closeableCoder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);

    const out: CloseableEscrow[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const acc = infos[i];
      if (!acc) continue; // la cuenta ya se cerró, o nunca existió: no hay alquiler que recuperar
      let statusKey: string | undefined;
      try {
        const state = closeableCoder.decode("EscrowState", acc.data) as {
          status: Record<string, unknown>;
        };
        statusKey = Object.keys(state.status)[0];
      } catch {
        continue; // cuenta deforme/ajena al layout: se descarta, NUNCA rompe la lista entera
      }
      // Sólo los terminales. `Deposited` queda afuera: el envío sigue en curso y `close` lo rechaza.
      if (statusKey === "Released") out.push({ remittanceId: candidates[i]!, status: "released" });
      else if (statusKey === "Refunded")
        out.push({ remittanceId: candidates[i]!, status: "refunded" });
    }
    return out;
  }

  // HU-SOL-8 (AC-1/CD-6/CD-SDD-3): firma REAL del proof-of-possession. El caller (http-pop-signer) pasa
  // el popMessage VERBATIM; la wallet (vía bridge) devuelve la firma ed25519 de 64 bytes; se codifica
  // base58 (simétrico con verifySolanaPop.signatureBase58). Browser+node-safe: bs58 + TextEncoder,
  // NUNCA Buffer node-only (auto-blindaje HU-SOL-5 BLQ-MED-1).
  async signMessage(message: string): Promise<string> { const porEnlace = this.firmaDelPopPorEnlace(message); if (porEnlace !== null) return porEnlace; // WKH-359/AC-1 — PEGADO A LA FIRMA, no en una línea propia: este archivo recibe **29 citas ancladas a 8 destinos contando ESTA línea (comparador `>=1922`), y 26 a 7 sin contarla (`>1922`)**, y una línea de más las rota a todas. ⚠️ ACÁ DECÍA «25 a 8» Y NO LO REPRODUCE NINGUNA DE LAS DOS VARIANTES (fix-pack · AR/BLQ-BAJO-2): era un par mezclado de dos mediciones distintas. Re-derivado con la receta de (`ANCLADA`, `../composition/citas-ancladas.test.ts:74`) —su regex, su lexer de comentarios y su resolución de destino, contando entrantes largas y auto-citas—, y **calibrando el instrumento antes de creerle**: su total del árbol tiene que dar el mismo número que el candado real, que se lee subiéndole el piso al `it` de (`CITAS`, `../composition/citas-ancladas.test.ts:207`). 🔴 EL COMPARADOR QUE SOSTIENE EL ARGUMENTO ES EL `>=`, y por eso va primero: una línea nueva acá corre TAMBIÉN a esta misma línea, así que el conjunto en riesgo la incluye. ⚠️ Y el número es una FOTO —cada comentario nuevo lo mueve, y el Story File decía 23—; el invariante no lo es: todo lo que se cita de acá para abajo se corre con una línea nueva arriba. En el camino por enlace la firma NO se pide: se LEE de un ancla que un salto anterior ya trajo, o se corta (CD-12). ⛔ POR QUÉ NO PUEDE HACER EL VIAJE REDONDO, medido y no opinado: el tipo es `(message) => Promise<string>` (`../application/ports.ts:510`) y un proceso de JavaScript que navega a otra app DEJA DE EXISTIR antes de que la promesa resuelva ⇒ un `signMessage` que navegara devolvería una promesa que nunca resuelve. Ensanchar el retorno tocaría los cuatro dobles de `WalletPort` y correría 11 ocurrencias ancladas (CD-16). Con el gate apagado esto devuelve `null` y lo de abajo corre BYTE-IDÉNTICO (AC-8)
    const bytes = new TextEncoder().encode(message); // browser+node-safe (NO Buffer)
    const sig = await solanaWalletBridge.signMessage(bytes); // Uint8Array(64) de la wallet
    // Normalizar a Uint8Array cubre adapters que devuelvan otro shape (R-2 del SDD).
    return bs58.encode(sig instanceof Uint8Array ? sig : new Uint8Array(sig));
  }

  /**
   * WKH-349 — EN QUÉ ESTADO ESTÁ LA PDA `escrow_state` de cada uno de estos envíos. Lo consume la
   * pantalla de historial, para las filas cuyo desenlace el snapshot local no puede afirmar.
   *
   * 🔴 NO FIRMA NADA, Y ESA RESTRICCIÓN ES LA QUE DECIDE SU FORMA. No se reusan
   * (`resolveRemittanceIdFromLedger`, `:353`) ni (`listCloseable`, `:1861`), que hacen el MISMO
   * derive+batch+decode, porque los dos empiezan por `resolver.lookupBySender`, que es
   * PoP-autenticado: reusarlos abriría un diálogo de firma sólo por abrir "Ver mis envíos", y una app
   * que pide firmas por mirar una lista entrena a la gente a firmar cualquier cosa. Se reusa la mitad
   * "derive + batch + decode" y nada más; los ids llegan por argumento.
   *
   * El `sender` es el del ARGUMENTO, nunca `this.address`: el cache de `connect()` puede ser de otra
   * billetera que la persona eligió después, y derivar con él daría las PDAs de otro.
   *
   * ── R-3 · ES EL TERCER BUCLE DE SELECCIÓN DE ESTE ARCHIVO, Y NO SE UNIFICÓ ─────────────────────
   *
   * El docblock de (`escrowIndexCandidate`, `:463`) ya declara la duplicación residual entre ese
   * bucle y el del ledger, y pide con todas las letras "si tocás uno de los dos bucles, tocá el otro o
   * borrá esta afirmación". Esta HU **no toca ninguno de los dos**: agrega un tercero, y la asimetría
   * se declara acá en vez de quedar sin dueño. El motivo de no unificar, concreto: los tres devuelven
   * cosas distintas —el primero un `remittanceId`, el segundo un `EscrowId16`, éste un `Map` de seis
   * valores—, éste **no elige "el primero"** y **no filtra por estado** (conserva los seis
   * desenlaces), y la extracción tocaría, en el mismo diff, la función que decide QUÉ escrow se
   * refundea.
   *
   * ── EL CONTRATO ES TOTAL ──────────────────────────────────────────────────────────────────────
   *
   * Devuelve una entrada por CADA `remittanceId` pedido. Acá no hay ningún `continue` que saltee una
   * fila, al revés que en los otros dos bucles: allá descartar una candidata es correcto (buscan UNA),
   * acá sería perder una fila del historial de la persona sin decírselo.
   *
   * ── LOS TRES MODOS DE FALLA ───────────────────────────────────────────────────────────────────
   *
   *  · No se puede ni EMPEZAR (`sender` que no es base58, un `await import` que falla) ⇒ **TIRA**. Acá
   *    sí vale la disciplina de `SolanaCloseableEscrowLister`: no hay ninguna respuesta parcial que
   *    salvar. Quien llama arma su propio mapa de `"unknown"`.
   *  · El batch de un chunk lanza, o vence `ESCROW_STATE_BATCH_TIMEOUT_MS` ⇒ **sólo ese chunk** cae a
   *    `"unknown"`. Los demás conservan lo que la cadena contestó. Nunca `"absent"`: no preguntamos.
   *  · El decode de UNA cuenta lanza ⇒ **esa fila** cae a `"unknown"`, y las demás quedan intactas.
   *
   * ── EL RELOJ ES NUESTRO, NO EL DE LA CADENA ───────────────────────────────────────────────────
   *
   * Dos de los seis desenlaces —`"deposited-window-open"` y `"deposited-window-closed"`— no salen sólo
   * de lo que la cuenta dice. El `status` y el `deadline` los dijo la cadena; DE QUÉ LADO del
   * `deadline` caemos lo decide `Date.now()` de este dispositivo, leído acá abajo con la MISMA
   * expresión que usa el refund de este archivo, y comparado con la negación exacta de su guard
   * (`refund_before_deadline`, `:1387`). Que las dos expresiones coincidan es lo único que se verifica:
   * es lo que impide que la pantalla diga "la salida que queda es la devolución" sobre una fila que el
   * refund de esta misma app rechazaría.
   *
   * El `deadline` NO cuesta ninguna llamada más: viaja en la misma cuenta que el `status`, en el mismo
   * `coder.decode`. Si alguna vez hace falta un `getAccountInfo` por fila, un segundo batch o una
   * lectura del `Clock` del cluster para decidir esto, la decisión de diseño cambió y hay que volver a
   * discutirla: el "menor número de llamadas" que esta pantalla promete —hoy una por chunk— se paga acá.
   *
   * LO QUE NO SE MIDIÓ, y no se convierte en certeza en ninguna frase de este archivo:
   *  · El skew entre el reloj del dispositivo y el del cluster. Un navegador con la hora corrida
   *    contesta `"deposited-window-open"` sobre un escrow que el programa ya sólo deja refundear, y
   *    NADA acá lo detecta. Lo que se ELIMINÓ es no decir nada del `deadline` teniéndolo en la mano;
   *    lo que QUEDA VIVO es que lo decimos con nuestro reloj.
   *  · Que pasado el `deadline` el programa on-chain efectivamente rechace un `release`. Este repo no
   *    leyó el programa. La afirmación descansa en una medición contra devnet hecha afuera y en el
   *    guard propio de este archivo. Por eso el copy dice "la salida que queda" y NO "el refund va a
   *    entrar".
   */
  async readEscrowStates(input: {
    sender: string;
    remittanceIds: readonly string[];
  }): Promise<ReadonlyMap<string, EscrowChainState>> {
    const out = new Map<string, EscrowChainState>();
    // ACÁ NO HAY CORTE TEMPRANO POR LISTA VACÍA, y es una decisión. El que había decía que sin él
    // saldría "un batch de cero cuentas": es falso — el batch cuelga del `for` de abajo, que con cero
    // ids no entra NUNCA (la frase estaba copiada de `:370-372`, donde sí es cierta porque allá el
    // batch se llama incondicionalmente). Lo único que ahorraba eran cuatro `await import` y tres
    // constructores, sobre un camino que producción no toca (`idsAConsultar`, `../presentation/flow.tsx:3322`). Y a cambio
    // rompía lo que el docblock de arriba promete: con `{ sender: "no-es-base58", remittanceIds: [] }`
    // NO tiraba. Sin el corte, un `sender` inválido tira SIEMPRE, con lista vacía o llena (T-A15).

    const web3 = await import("@solana/web3.js");
    const { PublicKey: PublicKeyLazy, Connection } = web3;
    const anchor = await import("@coral-xyz/anchor");
    const { escrowIdl } = await import("./solana/escrow-idl");

    const senderPk = new PublicKeyLazy(input.sender); // valida base58 (CD-SDD-7); si no lo es, TIRA
    const programId = new PublicKeyLazy((escrowIdl as { address: string }).address);
    const connection = new Connection(
      resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe
    );
    const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);

    // El troceo es lo que hace que el techo sea POR CHUNK: con 150 ids son 2 llamadas y 2 techos, y
    // que la primera venza no le saca su respuesta a la segunda. Truncar a 100 y devolver 100
    // entradas para 150 ids perdería 50 filas en silencio, que es el mutante que T-A8 mata.
    for (let start = 0; start < input.remittanceIds.length; start += ESCROW_STATE_BATCH_CEILING) {
      const chunk = input.remittanceIds.slice(start, start + ESCROW_STATE_BATCH_CEILING);
      const pdas = chunk.map((id) => this.deriveEscrowState(senderPk, programId, id).pda);
      let infos: Awaited<ReturnType<Web3Connection["getMultipleAccountsInfo"]>>;
      try {
        // withTimeout y no un `await` pelado: un RPC que acepta la conexión y no contesta dejaría la
        // fila diciendo "Le estamos preguntando al contrato" para siempre. Es el mismo motivo que en
        // (`probeEscrowIndex`, `:1702`), y el mensaje "confirm_timeout" que arrastra `withTimeout` no
        // le llega a ninguna persona: acá se convierte en `"unknown"`.
        infos = await withTimeout(
          connection.getMultipleAccountsInfo(pdas),
          ESCROW_STATE_BATCH_TIMEOUT_MS,
        );
      } catch {
        for (const id of chunk) out.set(id, "unknown"); // NO pudimos preguntar; NO es "no hay cuenta"
        continue;
      }
      // 🔴 CARDINALIDAD: una respuesta CORTA no dice "no hay cuenta", dice que no sabemos leerla.
      // `getMultipleAccountsInfo` promete una entrada por pubkey pedida y NADIE lo verifica: web3.js
      // valida la FORMA de la respuesta —`array(nullable(AccountInfoResult))`,
      // `@solana/web3.js/lib/index.cjs.js:6410-6415`— y no su LARGO. Con `noUncheckedIndexedAccess`
      // (`tsconfig.json:13`) el faltante llega acá como `undefined`, y un `if (!acc)` lo metía en la
      // misma rama que el `null`: la fila terminaba diciendo "en el contrato no hay ninguna cuenta
      // para este envío" sobre un escrow que puede tener plata adentro. Es la regla del repo al revés.
      //
      // POR QUÉ EL CHUNK ENTERO Y NO SÓLO LAS FILAS FALTANTES: si vinieron menos entradas, tampoco
      // sabemos CUÁLES faltan. Una respuesta a la que le falta una del medio corre las que siguen, y
      // entonces `infos[i]` es la cuenta de OTRA fila — que es peor que no contestar. Lo único que
      // podemos afirmar de un chunk descalzado es que no pudimos leerlo.
      if (infos.length !== chunk.length) {
        for (const id of chunk) out.set(id, "unknown");
        continue;
      }
      for (let i = 0; i < chunk.length; i++) {
        const id = chunk[i] as string;
        const acc = infos[i];
        // Los dos casos van SEPARADOS y nunca se colapsan con un `if (!acc)`. El `undefined` de acá ya
        // no debería poder pasar —lo corta el guard de cardinalidad de arriba—, pero el tipo lo sigue
        // admitiendo, así que la rama existe y cae del lado que no afirma nada sobre los fondos.
        if (acc === undefined) {
          out.set(id, "unknown"); // NO nos contestaron por esta fila; NO es "no hay cuenta"
          continue;
        }
        if (acc === null) {
          out.set(id, "absent"); // la cadena CONTESTÓ: en esa PDA no hay cuenta
          continue;
        }
        let statusKey: string | undefined;
        let deadlineSec: number;
        try {
          const state = coder.decode("EscrowState", acc.data) as { status: Record<string, unknown>; deadline: { toNumber(): number } };
          statusKey = Object.keys(state.status)[0]; // { Deposited: {} } | { Released: {} } | ...
          // El `.toNumber()` va ACÁ ADENTRO, junto al decode, y no abajo en el mapeo: `BN.toNumber()`
          // TIRA si el valor no entra en 53 bits, y una excepción en el mapeo se escaparía de este
          // `try`, saldría del método entero y dejaría TODAS las filas del historial en "unknown" —
          // una sola cuenta deforme se llevaría puesto el batch, que es justo lo que el tercer modo de
          // falla del docblock de arriba promete que no pasa. ⚠️ Esto NO tiene test propio y va dicho:
          // la fixture que haría falta —una cuenta que pase el discriminador Borsh de `EscrowState`
          // con un `i64` absurdo— no representa nada que el programa que las escribe produzca.
          deadlineSec = state.deadline.toNumber();
        } catch {
          out.set(id, "unknown"); // cuenta deforme o ajena al layout: no pudimos LEER esta fila
          continue;
        }
        // El reloj es el del DISPOSITIVO, y esta comparación es la negación EXACTA del guard con el que
        // el refund de este mismo archivo rechaza por deadline (`refund_before_deadline`, `:1387`).
        // ⚠️ NO está escrita una sola vez: está escrita DOS, allá y acá, así que PUEDEN DIVERGIR — si el
        // refund cambia su condición y ésta no, la pantalla dice "la salida que queda es la devolución"
        // sobre una fila que este mismo código rechazaría. Lo único que las ata es T-A16, que corre LAS DOS.
        const nowSec = Math.floor(Date.now() / 1000);
        // Un `status` que no es ninguno de los tres es un cuarto desenlace SIN NOMBRE: se dice
        // "no pudimos" y no se elige uno de los tres por descarte.
        out.set(
          id,
          statusKey === "Deposited"
            ? nowSec < deadlineSec
              ? "deposited-window-open"
              : "deposited-window-closed"
            : statusKey === "Released"
              ? "released"
              : statusKey === "Refunded"
                ? "refunded"
                : "unknown",
        );
      }
    }
    return out;
  }

  /**
   * WKH-353 — ¿qué dice la cadena de ESTA firma? Devuelve uno de los tres desenlaces de
   * `SignatureVerdict`, `:2478`, preguntando por HTTP y sin abrir NINGUNA suscripción.
   *
   * POR QUÉ NO `connection.confirmTransaction`, que es lo que estaba acá antes. Sus dos estrategias
   * terminan en `onSignature`, o sea en un `signatureSubscribe` por WebSocket, y el RPC que usamos
   * contesta `-32601` a ese método. La librería atrapa ese error y devuelve el estado a 'pending' SIN
   * límite de reintentos, así que 'subscribed' no llega nunca, y su respaldo HTTP por
   * `getSignatureStatus` está DETRÁS de esa espera: ni la suscripción ni el respaldo podían producir
   * un veredicto (@solana/web3.js 1.98.4: lib/index.cjs.js:6553, :6562, :6585, :8383-8410).
   *
   * ⚠️ ESTE MÉTODO NO TIENE TECHO PROPIO, Y ESTE BUCLE NO TERMINA SOLO. Acá decía que "lo corta el
   * `withTimeout`, `:150` del llamador", y es FALSO: ese helper es un `Promise.race` contra un
   * `setTimeout`, así que rechaza LA ESPERA DEL LLAMADOR sin detener el trabajo de adentro. Con un
   * `getBlockHeight` que falla de forma sostenida lo que se pierde es LA SALIDA POR VENCIMIENTO, y NO
   * la salida por `landed`: el bucle lee el estado ANTES de tocar la altura (`leerEstado`, `:2159`) y
   * devuelve lo que vea. Medido con la altura tirando SIEMPRE y el status apareciendo en el segundo
   * poll: "confirmed" a los 1.105 ms. Lo inmortal es que fallen LAS DOS (altura caída y estado que
   * nunca concluye): el `catch` deja la altura en -1 a propósito y -1 nunca supera nada, así que el
   * llamador se va por techo y el bucle sigue pidiendo a ~2 req/s hasta que el proceso lo tira. Eso
   * es lo que `solana-wallet.confirm-http.test.ts` llama "huérfano".
   *
   * POR QUÉ ESE RESIDUO IGUAL ES LA OPCIÓN CORRECTA: son 2 req/s y bajo rate-limit se frena solo,
   * porque la librería reintenta el 429 con backoff 500→1000→2000→4000 ms (lib/index.cjs.js:5054-5076).
   * El mecanismo anterior tenía LOS MISMOS TRES DEFECTOS (el techo del llamador tampoco lo cortaba;
   * era inmortal con el RPC de altura caído, mismo archivo :6665-6670; dejaba un huérfano por
   * reintento) y era cuatro órdenes de magnitud más caro: los números y su medición viven UNA sola
   * vez, al lado de `SIGNATURE_POLL_INTERVAL_MS`, `:2493`.
   *
   * Matar el huérfano exige un `AbortSignal` que cruce desde el llamador, y es una HU con su propio
   * alcance y no una línea acá: los métodos de `Connection` no aceptan `signal` (`getSignatureStatuses`
   * toma `SignatureStatusConfig`; `getBlockHeight`, `Commitment | GetBlockHeightConfig`; el único
   * `abortSignal` de la librería es el de `confirmTransaction`, justo lo que sacamos), así que habría
   * que entrar por `ConnectionConfig.fetch`, y la `Connection` se construye acá adentro en NUEVE
   * sitios (`grep -c 'new Connection('`), los nueve con un solo argumento y ninguno con override.
   *
   * ⚠️ LO QUE ESTO NO ARREGLA, dicho para que ningún copy lo prometa: el techo de 30 s, la sonda
   * on-chain y el veredicto "unknown" siguen existiendo exactamente igual. Lo que se elimina es UN
   * CAMINO (la suscripción), no la posibilidad de no saber.
   */
  private async awaitSignatureVerdict(
    connection: Web3Connection,
    signature: string,
    ctx: { lastValidBlockHeight: number },
  ): Promise<SignatureVerdict> {
    // Paso 1 — el estado, que es la conclusión más barata. Devuelve `null` cuando NO concluye nada, y
    // ese `null` NO es "no entró": es "todavía no lo vemos". La distinción es la misma disciplina que
    // el resto de este archivo ya tiene escrita: no pudimos preguntar ≠ la respuesta es que no.
    const leerEstado = async (): Promise<SignatureVerdict | null> => {
      let res: Awaited<ReturnType<Web3Connection["getSignatureStatuses"]>>;
      try {
        // SIN segundo argumento, o sea SIN `searchTransactionHistory`: el RPC usa su default y mira
        // sólo su caché reciente de estados. Es una postura tomada y no un olvido — nunca preguntamos
        // por una firma vieja, preguntamos por una que ACABAMOS de emitir, y un miss de caché no
        // puede producir un "no entró" falso: cae en el `null` de abajo, que no concluye nada.
        // 🔴 SUPUESTO NO MEDIDO: que esa caché dure más que nuestro techo. NO SE PUDO VERIFICAR desde
        // este repo (haría falta medirlo contra el endpoint vivo). Si fuera más corta, el desenlace
        // sería más LENTO (unseen → sonda), nunca incorrecto.
        res = await connection.getSignatureStatuses([signature]);
      } catch {
        return null; // no pudimos PREGUNTAR. Un throw no es un `null`, y un `null` no es un "no entró".
      }
      const status = res.value[0];
      if (status === null || status === undefined) return null; // no lo vemos todavía
      // Con `err` NO se mira el commitment, y es deliberado: para tener error la tx tuvo que ENTRAR en
      // un bloque y ejecutarse. Es un "no" MEDIDO, el único "no" que este método puede afirmar.
      if (status.err != null) return { kind: "landed", err: status.err };
      // Sin `err` el nivel SÍ importa: "processed" no alcanza. Es el mismo commitment gate que la
      // librería aplicaba, y los dos llamadores confirman con "confirmed" (`confirmRefund`, `:1448`).
      const nivel = status.confirmationStatus;
      if (nivel === "confirmed" || nivel === "finalized") return { kind: "landed", err: null };
      return null; // "processed" o ausente ⇒ seguimos preguntando
    };

    for (;;) {
      const visto = await leerEstado();
      if (visto !== null) return visto;

      // Paso 2 — el vencimiento, DESPUÉS del estado y nunca antes.
      let height: number;
      try {
        height = await connection.getBlockHeight("confirmed");
      } catch {
        // 🔴 REGLA, no detalle de implementación: un RPC que falla JAMÁS puede producir un veredicto
        // de "expired". No pudimos preguntar la altura ⇒ NO sabemos si venció ⇒ seguimos esperando.
        // `-1` siempre es `<= lastValidBlockHeight`, así que el bucle itera como si la altura no
        // hubiera avanzado. Dejar propagar la excepción —o peor, traducirla a "venció"— haría que un
        // endpoint con hipo produjera un vencimiento FALSO, que acá significa mentirle a la persona
        // sobre su plata.
        height = -1;
      }
      if (height > ctx.lastValidBlockHeight) {
        // ÚLTIMA MIRADA, y no es decorativa: cierra la carrera de la tx que entró en el último bloque
        // válido mientras nosotros leíamos la altura. Si ahora hay status, GANA EL STATUS.
        const ultima = await leerEstado();
        return ultima ?? { kind: "expired" };
      }
      await sleep(SIGNATURE_POLL_INTERVAL_MS);
    }
  }

  /** WKH-358/DT-1 — La billetera del recorrido POR ENLACE, o `null` si este recorrido NO es por enlace.
   *
   *  🔴 ES EL ÚNICO INTERRUPTOR DE LA RAMA DE ENLACE, y **TRES condiciones** (eran dos hasta el
   *  fix-pack; la 3ª la agregó AR/BLQ-MED-1), las tres derivadas EN EL INSTANTE del gesto:
   *    1. la elección persistida del selector (`leerEleccion`, `./solana/deeplink/conexion.ts:149`), que
   *       escribe SÓLO el selector y nunca este archivo,
   *    2. (`getWalletAvailability`, `./solana-wallet-bridge.ts:70`) `=== "none"`, y
   *    3. la bandera del build (`resolveSolanaDeeplinkEnabled`, `./chain.ts:269`).
   *  Si falta cualquiera de las tres ⇒ `null` ⇒ el recorrido es el inyectado, **byte-idéntico al de hoy**.
   *
   *  ⚠️ `"unknown"` DEVUELVE `null` A PROPÓSITO, y es la mitad que un review "arregla" mal. `unknown` es
   *  lo que contesta el servidor y lo que contesta el navegador ANTES de montar
   *  (`useWalletAvailability`, `../presentation/wallet-availability.ts:36`, con su `"unknown"` de servidor
   *  en `:40`). Degrada al camino CONOCIDO y nunca al revés: si `unknown` activara el gate, un escritorio
   *  con la extensión todavía sin montar entraría a la rama de enlace. Lo mide `T-065-GATE-3`, y por eso
   *  la comparación es `=== "none"` y ⛔ **NO** `!== "injected"`, que son distintas exactamente en ese
   *  caso.
   *
   *  ⛔ POR QUÉ ESTO NO ES UNA FACTORY NI UN SEGUNDO ADAPTER, que es lo que parece la solución limpia.
   *  Una factory decidiría al construir el container (`getContainer`, `../composition/container.ts:265`,
   *  que corre UNA vez al montar) y la elección de la persona ocurre DESPUÉS: sería una decisión tomada
   *  antes de que exista el dato. Y un segundo adapter duplicaría un archivo de [[CENSO src/infrastructure/solana-wallet.ts lineas=2498]] líneas
   *  con [[CENSO src/infrastructure/solana-wallet.ts entrantes=130]] citas ancladas entrantes (los dos ya envejecieron dos veces acá —«2247/85» ⇒ «2362/116»— y por eso desde el fix-pack del CR son MARCADORES que verifica `citas-ancladas.test.ts`, no cifras escritas a mano), con las dos instancias compartiendo el MISMO bridge y el MISMO disco.
   *
   *  🔴 ACÁ DECÍA «NO LEE `deeplinkEnabled()`, y no es un olvido», Y ERA EL BUG (AR/BLQ-MED-1, en las MISMAS 4 líneas para no correr las 47 citas de más abajo). El argumento de esa frase era: *"con la bandera apagada nadie puede elegir, así que la condición 1 no se cumple"*. **Es falso para un dispositivo que YA eligió**: `CLAVE_ELECCION` no expira (`CLAVE_ELECCION`, `./solana/deeplink/conexion.ts:129`) y nada de producción la borraba, así que un build con la bandera prendida y después ausente dejaba a ese teléfono con este gate devolviendo `"phantom"` **sin puerta de vuelta**, o sea con la superficie NO replegable — que es justo lo que AC-9 pide poder hacer. Medido antes del fix: agregar la bandera como 3ª condición ponía **31 `it` en rojo**, o sea que la frase y el árbol se contradecían.
   *  ⇒ Hoy la lee, y la objeción original sigue en pie sin aplicar: la bandera no CONTESTA ninguna de las otras dos condiciones (no sabe qué eligió la persona ni qué hay inyectado), es una tercera que se conjuga con ellas. El literal de la env NO entra a este archivo: viene por (`resolveSolanaDeeplinkEnabled`, `./chain.ts:269`), que es su único sitio en producción.
   *  ⛔ Y NO alcanza sola: el otro repliegue es el gesto de la persona, y es el control «Cambiar de billetera» de (`OlvidarBilleteraDeEnlace`, `../presentation/flow.tsx:4243`), que llama a (`olvidar`, `./solana/preparacion-por-enlace.ts:246`). Los dos hacen falta: la bandera repliega el BUILD, el control repliega EL DISPOSITIVO. */
  private caminoPorEnlace(): BilleteraDeeplink | "no-podemos-saber" | null {
    if (solanaWalletBridge.getWalletAvailability() !== "none") return null; if (!resolveSolanaDeeplinkEnabled()) return null; // LA 3ª CONDICIÓN, EN ESTA MISMA LÍNEA (Δ0). ⚠️ ACÁ DECÍA «este bloque recibe 47 citas por número desde más abajo» Y ERA UN CONTEO INVENTADO (re-AR it2 · BLQ-BAJO-4): el 47 se copió del número viejo del archivo, que en ESTE MISMO COMMIT se estaba corrigiendo a 65 en `:906`. ⚠️ Y LA CORRECCIÓN DE ESE 47 REPITIÓ EL DEFECTO UNA CAPA MÁS ARRIBA (CR/MNR-2): decía «RE-MEDIDO en el árbol de este commit» y reportaba, al dígito, los cinco números del árbol BASE. ⇒ Desde el fix-pack del CR los números de esta línea NO se escriben: son MARCADORES que `citas-ancladas.test.ts` verifica contra el árbol en cada `npm test` y que se ponen ROJOS solos. Las que apuntan MÁS ABAJO de esta línea son [[CENSO src/infrastructure/solana-wallet.ts entrantes-desde-2241=9]] ocurrencias a [[CENSO src/infrastructure/solana-wallet.ts destinos-desde-2241=6]] destinos. El archivo entero recibe [[CENSO src/infrastructure/solana-wallet.ts entrantes=130]] a [[CENSO src/infrastructure/solana-wallet.ts destinos=69]] destinos, y [[CENSO src/infrastructure/solana-wallet.ts entrantes-desde-906=78]] de esas caen por debajo de `:906`. ⚠️ Lo que estos marcadores NO cuentan son las citas SUELTAS —`solana-wallet.ts:NNNN` sin símbolo delante—, que se rompen igual y no las mira nadie. El invariante que justifica el Δ0 no es el total: es que TODO lo que está más abajo se corre con una línea nueva acá. Va DESPUÉS de la disponibilidad y ANTES del disco a propósito: `T-065-GATE-1`/`GATE-2` afirman que con `injected` el gate corta "en su PRIMERA condición, sin siquiera mirar el disco", y meter la bandera antes volvería falsa esa frase para todos los `it` que no la declaran
    const disco = this.discoDeEnlace();
    // 🔴 EL TERCER VALOR, Y POR QUÉ NO PUEDE COLAPSAR EN `null`. Acá el disco NO SE DEJA LEER, así que
    // la pregunta "¿qué eligió la persona?" no tiene respuesta: no es "no eligió". Colapsarlo en `null`
    // (que fue mi primera versión) hace que el recorrido caiga al camino INYECTADO, y con
    // `availability === "none"` ese camino no tiene ninguna billetera que pueda prosperar: termina en
    // `wallet_not_connected`, que es una pista FALSA sobre lo que pasó. Entrando a la rama, en cambio,
    // el guard de `:778` contesta `deeplink_sin_memoria`, que es el diagnóstico correcto y el que la
    // pantalla sabe traducir. Lo miden los dos `it` de «el entorno del navegador, cuando no colabora».
    // ⛔ Y no se puede devolver una billetera inventada para rellenar: sería afirmar una elección que
    // nadie hizo. Por eso el tipo tiene TRES valores y no dos.
    if (disco === "no-se-pudo") return "no-podemos-saber";
    if (disco === null) return null;
    return leerEleccion(disco);
  }

  /** El `localStorage` de este navegador, distinguiendo **ausente** de **no se deja leer**.
   *
   *  ⚠️ POR QUÉ NO REUSA `entornoDeEnlace()` (`:1211`), que parece la misma pregunta: ése exige ADEMÁS
   *  que exista `location`, y funde los tres casos en `null`. El gate no necesita la URL —sólo la
   *  elección persistida— y sí necesita separar "no hay disco" de "el disco tiró". Un navegador sin
   *  `location` pero con disco SIGUE siendo un recorrido por enlace, y tiene que entrar a la rama para
   *  que el corte diga `deeplink_sin_memoria` en vez de degradar en silencio. */
  private discoDeEnlace(): Almacen | "no-se-pudo" | null {
    try {
      const disco = (globalThis as { localStorage?: Storage }).localStorage;
      if (!disco) return null;
      return almacenDeNavegador(disco);
    } catch {
      return "no-se-pudo"; // el getter LANZA (modo privado, cookies bloqueadas): no sabemos, no negamos
    }
  }

  /** WKH-358/DT-2 — La cuenta que contestó el connect POR ENLACE, o `null` si este recorrido no es por
   *  enlace, o si el viaje todavía no está conectado.
   *
   *  🔴 POR QUÉ EXISTE. (`authorizePrincipal`, `:554`) saca el `sender` de (`getAddress`, `:233`) y
   *  corta con `wallet_not_connected` si es nulo (`:561`). Las DOS fuentes de `getAddress()` eran el
   *  bridge —el cache que escribe `connect()` y (`getConnectedAddress`, `:252`)—, y en un teléfono sin
   *  extensión el bridge está VACÍO: el recorrido por enlace no podía ni empezar. La cuenta que
   *  contestó el connect por enlace vive en UN SOLO lugar del universo, que es
   *  (`direccion`, `./solana/deeplink/sesion.ts:152`).
   *
   *  🔴 CONSECUENCIA MEDIDA Y DECLARADA ACÁ, no un efecto colateral que descubra un review: con esto,
   *  el `sender` que llega al motor y el `viaje.direccion` contra el que el motor lo compara
   *  (`DEEPLINK_SENDER_MISMATCH`, `./solana/deeplink/firma-por-enlace.ts:691`) salen del MISMO disco,
   *  así que **en el camino por enlace ese guard es coherencia interna y NO una defensa**. En el camino
   *  inyectado sigue siendo la defensa que era, porque ahí el `sender` sale del bridge. El corte que sí
   *  es una defensa en el camino por enlace es el cruce contra `rem.ownerAddress` de
   *  (`live`, `../presentation/flow.tsx:506`), y es esta función la que lo vuelve load-bearing. Todo el
   *  razonamiento, con su residual, está en el bloque de CD-11 de `:906`. Lo mide `T-065-CD11`.
   *
   *  ⚠️ NO ES UNA LECTURA PURA Y HAY QUE DECIRLO: `leerViaje` LIMPIA el disco cuando el viaje venció o
   *  es basura. No degrada ningún diagnóstico —el motor trata `no-hay` y `vencido` con el MISMO corte
   *  (`DEEPLINK_VIAJE_VENCIDO`, `./solana/deeplink/firma-por-enlace.ts:685`)—, así que haber pasado por
   *  acá antes no cambia lo que la persona lee.
   *
   *  ⚠️ UN `direccion` QUE NO ES BASE58 CONTESTA `null`, y el desenlace de ese caso es
   *  `wallet_not_connected` y NO una causa `deeplink_*`. Se elige así por consistencia con las otras
   *  dos puertas de este archivo (`:198` y `:256`), que ya tratan un base58 inválido como "no hay
   *  address": lo que no puede entrar por una puerta tampoco entra por la otra. Un `direccion` que no
   *  parsea es un viaje sobre el que no podemos afirmar nada, y sin este guard reventaría ~200 líneas
   *  más adelante en el `new PublicKey(sender)` de (`senderPk`, `:573`) con una excepción sin causa
   *  traducible.
   *
   *  ⛔ NO cachea en `this.address`: la fuente de verdad es el disco, igual que el bridge lo es en el
   *  camino inyectado. Cachear haría que un viaje ya vencido —o ya limpiado— siguiera contestando. */
  private direccionDelViajeConectado(): string | null {
    if (this.caminoPorEnlace() === null) return null; // el gate manda: sin él, ni se mira el disco
    const disco = this.discoDeEnlace();
    if (disco === null || disco === "no-se-pudo") return null;
    const lectura = leerViaje(disco, Date.now());
    if (lectura.tipo !== "hay") return null; // vencido o inexistente: no hay ninguna cuenta que afirmar
    const v = lectura.viaje;
    // Los TRES campos, igual que (`estaConectado`, `./solana/deeplink/firma-por-enlace.ts:376`): sin
    // `claveBilletera` y sin `session` no hay canal cifrado, y una `direccion` suelta sería una cuenta
    // que nadie probó haber conectado. Un viaje recién abierto por `iniciarConexion` cae acá.
    if (typeof v.claveBilletera !== "string" || typeof v.session !== "string") return null;
    if (typeof v.direccion !== "string") return null;
    try {
      new PublicKey(v.direccion); // ver el docblock: base58 inválido ⇒ "no hay address", nunca una excepción
    } catch {
      return null;
    }
    return v.direccion; // OPACO, SIN toLowerCase (CD-3)
  }

  /** WKH-359/AC-1 — La firma del PoP que un salto anterior YA trajo, o `null` si este recorrido no es
   *  por enlace (y entonces `signMessage` sigue por el bridge, byte-idéntico — AC-8).
   *
   *  ⛔ LEE O CORTA, NUNCA PIDE (CD-12). El corte es `deeplink_pop_sin_firma` y ⛔ **no**
   *  `wallet_sign_not_available`, que es lo que salía antes de esta HU: esa marca la tira el bridge
   *  (`../infrastructure/solana-wallet-bridge.ts:127`) y significa "no hay extensión en este
   *  navegador", cosa que en el camino por enlace es cierta SIEMPRE y por lo tanto no distingue nada.
   *  La nueva significa "falta el insumo", que es accionable. Lo miden `T-067-2` y `T-067-19`.
   *
   *  🔴 Y ESO ES TODO LO QUE ESTA HU LE DA A LOS CONSUMIDORES 3 Y 4 (DT-13): el resolver de refund
   *  (`../infrastructure/refund/http-solana-remittance-id-resolver.ts:30`) y el gesto de renovar la
   *  ventana (`../presentation/flow.tsx:1180`) pasan por acá y reciben **diagnóstico correcto, NO
   *  recorrido**. ⛔ Nadie puede leer este cambio como "el refund por enlace ya funciona". */
  private firmaDelPopPorEnlace(mensaje: string): string | null {
    if (this.caminoPorEnlace() === null) return null; // el gate manda: camino inyectado ⇒ byte-idéntico
    const disco = this.discoDeEnlace();
    // Un disco que no se deja leer no es "no hay ancla": es que no podemos saber. El diagnóstico
    // correcto es el mismo que usa `:778` para el mismo hecho, y la pantalla ya lo sabe traducir.
    if (disco === null || disco === "no-se-pudo") throw new Error(DEEPLINK_SIN_MEMORIA);
    const firma = leerFirmaParaMensaje(disco, Date.now(), mensaje);
    if (firma === null) throw new Error(DEEPLINK_POP_SIN_FIRMA);
    return firma;
  }

  /** WKH-359/AC-2, AC-5 — La implementación de (`PruebaDePosesionPorEnlace`, `../application/ports.ts:1232`).
   *
   *  ⛔ VIVE ACÁ Y NO EN `preparacion-por-enlace.ts` PORQUE ACÁ VIVE EL GATE: (`caminoPorEnlace`,
   *  `:2239`) es `private`, y ese otro módulo **no puede** importar el adaptador — lo declara en sus
   *  (`solana-wallet`, `./solana/preparacion-por-enlace.ts:7-13`): sería la dependencia al revés, y ese archivo existe justamente para eso.
   *
   *  LOS CUATRO DESENLACES, y ninguno se puede colapsar en la ausencia de otro:
   *   · `no-corresponde` ⇒ el gate está apagado o no hay elección persistida. Quien llama sigue como
   *     siempre. **Es la línea que sostiene AC-8**, y por eso va PRIMERO, antes de tocar el disco.
   *   · `listo`          ⇒ el ancla ya tiene firma verificada. Se entrega UNA vez (CD-15).
   *   · `hay-que-salir`  ⇒ falta, y hay a dónde ir. El ancla se escribe ANTES de devolver la URL.
   *   · `no-se-puede`    ⇒ **sin `irA`**, y eso es lo medible (AC-5).
   *
   *  🔴 AC-5 — EL 501 NO SALTA A NINGUNA BILLETERA. Cuando el emisor contesta 501 (`PAYOUT_POP_SECRET`
   *  ausente server-side) esto corta con la marca ESTABLE `payout_pop_unavailable` —la misma que ya
   *  producía (`prepare`, `./settlement/http-solana-prepare-gateway.ts:227`) antes de esta HU— y ⛔ NO
   *  escribe ancla y ⛔ NO devuelve `irA`. Es lo mismo que hace hoy `HttpPopSigner` con su
   *  `if (res.status === 501) return null` (`./auth/http-pop-signer.ts:22`), y es una decisión de
   *  ahorro además de correctitud: la route leería ESA MISMA env y contestaría 503, así que saltar
   *  sería mandar a la persona a firmar algo cuyo rechazo ya está determinado.
   *
   *  ⚠️ EL EMISOR ES EL MISMO PARA LOS DOS PROPÓSITOS, y no es un atajo: `HttpKycVerdictGateway`
   *  también saca su desafío de `/api/a2a/payout/challenge` (lo hace vía el mismo `PopSigner`, ver
   *  (`PopSigner`, `./kyc/http-kyc-verdict-gateway.ts:74`) — iba SIN ancla y decía `:60`, que hoy es una línea EN BLANCO: la ola W3 de WKH-372 metió 35 líneas en ese archivo y la corrió — AR/BLQ-MED-1). Lo que separa los dos permisos es el `proposito` del
   *  ancla, no el emisor (CD-15).
   *
   *  ⛔ NO IMPORTA `pop-challenge.ts` (CD-13): la ventana sale del `exp` que viene en ESTE JSON, nunca
   *  de una constante copiada de un módulo que importa `node:crypto`. */
  async pedir(input: {
    proposito: typeof MARCA_POP_PAYOUT | typeof MARCA_POP_KYC;
    direccion: string;
  }): Promise<PruebaPorEnlace> {
    if (this.caminoPorEnlace() === null) return { estado: "no-corresponde" }; // AC-8: antes de tocar nada
    const disco = this.discoDeEnlace();
    if (disco === null || disco === "no-se-pudo") {
      return { estado: "no-se-puede", causa: "payout_pop_unavailable" }; // sin disco no hay ancla posible, y saltar sin poder recordar es saltar a ciegas
    }
    const ahora = Date.now();

    const ya = leerPruebaPop(disco, ahora, input.proposito);
    if (ya !== null) return { estado: "listo", proof: { challenge: ya.popChallenge, signature: ya.firma } };

    // 🔴 UN SALTO EN CURSO NO QUEMA UN DESAFÍO NUEVO. Si el ancla del MISMO propósito sigue viva y
    // todavía sin firma —la persona volvió sin firmar, o recargó—, se vuelve a armar la URL con el
    // MISMO `popChallenge` y el MISMO `exp`. Pedir uno nuevo acá haría que el reloj del permiso se
    // reiniciara en cada reintento, que es justo lo que DT-10 vino a evitar.
    const enCurso = leerPasoPop(disco, ahora);
    if (enCurso !== null && enCurso.proposito === input.proposito && enCurso.firma === undefined) {
      return { estado: "hay-que-salir", irA: this.saltoDelPop(disco, ahora, input.proposito, enCurso.popChallenge, enCurso.popMessage, enCurso.exp) };
    }

    let res: Response;
    try {
      res = await fetch("/api/a2a/payout/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: input.direccion }),
      });
    } catch {
      return { estado: "no-se-puede", causa: "payout_pop_unavailable" }; // red caída ⇒ no hay desafío que anclar, y no se salta
    }
    // ⛔ Los dos con la MISMA marca y SIN `irA`, a propósito: 501 es "el mecanismo está apagado" y el
    // resto es "no pudimos preguntar". Los dos significan que no hay nada que ir a firmar.
    if (!res.ok) return { estado: "no-se-puede", causa: "payout_pop_unavailable" };

    let desafio: { popChallenge?: unknown; popMessage?: unknown; exp?: unknown };
    try {
      desafio = (await res.json()) as typeof desafio;
    } catch {
      return { estado: "no-se-puede", causa: "payout_pop_unavailable" };
    }
    // Los TRES tienen que estar y ser del tipo que decimos. ⚠️ Un `exp` ausente NO se rellena con un
    // default: sería fabricar acá la ventana que DT-10 dice que la fija el servidor.
    if (
      typeof desafio.popChallenge !== "string" ||
      typeof desafio.popMessage !== "string" ||
      typeof desafio.exp !== "number" ||
      !Number.isFinite(desafio.exp)
    ) {
      return { estado: "no-se-puede", causa: "payout_pop_unavailable" };
    }

    return {
      estado: "hay-que-salir",
      irA: this.saltoDelPop(disco, ahora, input.proposito, desafio.popChallenge, desafio.popMessage, desafio.exp),
    };
  }

  /** El salto en sí. ⛔ NO se envuelve en un `try`: `iniciarPop` TIRA si el viaje no está conectado o si el disco no acepta el ancla, y las dos cosas significan que saltar sería mandar a firmar algo cuya vuelta este dispositivo no va a poder verificar. ⚠️ Y ESE THROW ES **UN QUINTO DESENLACE** QUE (`PruebaPorEnlace`, `../application/ports.ts:1214`) NO DECLARA (CR/MNR-6, dejado abierto a propósito): sus cuatro estados no agotan el espacio. Un `localStorage` LEGIBLE pero NO ESCRIBIBLE —modo privado de iOS Safari, cuota llena, o sea el escenario móvil de esta HU— sale como excepción cruda y no como `no-se-puede`, y los dos llamadores invocan `pedir()` fuera de todo `try` ((`pedir`, `../application/use-cases/confirm-and-send.ts:463`) y (`pedir`, `../application/use-cases/connect-wallet.ts:96`), este último a propósito: es el mutante de `T-067-5`). La asimetría está a cuatro líneas: disco ILEGIBLE ⇒ `no-se-puede` tipado; disco NO ESCRIBIBLE ⇒ throw. En el money-path la rama `no-se-puede` hace `failAndRefund` y el throw se lleva la remesa sin marcar. ⛔ NO se cierra acá porque es un cambio de comportamiento del money-path y esto es una pasada de cierre de MENORes; queda escrito para que nadie lea los cuatro estados como si fueran todos.
   *  ⚠️ EL `?? ""` DE ABAJO: MEDIDO Y NO ALCANZABLE EN PRODUCCIÓN (CR/MNR-6.b). Con `location` ausente, `enlaceDeVuelta` hace `new URL("")` y tira `TypeError: Invalid URL`, que no es ninguna causa que `copyDeEnlace` sepa traducir. Para llegar hace falta un runtime **con `localStorage` y sin `location`**, y ése no existe en los que esta app corre: `localStorage` está declarado ÚNICAMENTE en la interfaz `WindowLocalStorage` de `lib.dom.d.ts`, que sólo extiende `Window` —y toda `Window` tiene `location`—, mientras que `lib.webworker.d.ts` no lo declara ni una vez. La receta, sin número de línea porque vive en `node_modules` y lo mueve cualquier bump: `grep -n "localStorage" node_modules/typescript/lib/lib.webworker.d.ts` ⇒ **0 líneas**; el mismo grep sobre `lib.dom.d.ts` ⇒ **4**, que son dos sitios (la propiedad de `WindowLocalStorage` con su comentario de MDN, y el `declare var localStorage` global del scope de `Window`) y ninguno fuera de `Window`. ⚠️ El «4» salió de CORRER el grep: la primera versión de esta frase decía «una sola» sin correrlo y era falsa, que es el defecto que este mismo fix-pack está cerrando. Del otro lado, sin `localStorage` (SSR, node) (`discoDeEnlace`, `:2263`) contesta `null`, `caminoPorEnlace()` contesta `null` y `pedir()` sale por `no-corresponde` sin llegar acá. ⇒ el único que construye ese mundo es un test que estubea globales.
   *  ⛔ POR QUÉ NO SE SACA IGUAL: sin el `??`, `hrefActual` sería `string | undefined` y el tipo obligaría a decidir acá qué desenlace es —o sea a abrir el quinto—, que es justo lo que este pase NO hace. El día que se cierre el quinto, los dos se arreglan de una: `location` ausente ⇒ `no-se-puede`, no `""`. */
  private saltoDelPop(
    disco: Almacen,
    ahora: number,
    proposito: typeof MARCA_POP_PAYOUT | typeof MARCA_POP_KYC,
    popChallenge: string,
    popMessage: string,
    exp: number,
  ): string {
    return iniciarPop({
      almacen: disco,
      ahora,
      hrefActual: (globalThis as { location?: Location }).location?.href ?? "",
      appUrl: (globalThis as { location?: Location }).location?.origin ?? "",
      proposito,
      popChallenge,
      popMessage,
      exp,
    }).irA;
  }

}

/**
 * WKH-353 — el resultado de preguntarle a la cadena por una firma, con TRES desenlaces y no dos.
 *
 * ⚠️ NADA MECÁNICO PROTEGE LA DISTINCIÓN ENTRE `expired` Y `unseen`: este párrafo es lo único que hay.
 * Los tres consumos preguntan (`verdict.kind`, `:1469`) (y (`verdict.kind`, `:1470`), (`CloseTxReverted`, `:1779`)) por
 * `"landed"`, así que los otros dos caen por el `else` implícito y ninguna rama los nombra; `unseen`
 * además no lo construye NADIE (lo produce el `withTimeout`, `:150` del llamador al acabarse la
 * espera, y llega al `catch` como la excepción "confirm_timeout"). MEDIDO borrando el miembro
 * `unseen`: `tsc` verde y suite verde, 2075/2075; lo único rojo fue `citas-ancladas.test.ts`, por el
 * desplazamiento de UNA línea y no por la pérdida, y re-anclando esa cita queda verde también.
 * Aun así, PROHIBIDO colapsarlos a un booleano o a un `if (kind !== "landed")`: se pierde la
 * distinción que `confirmRefund`, `:1448` explica en prosa (un blockhash vencido prueba que la tx no
 * puede entrar DE ACÁ EN ADELANTE, NO que no haya entrado antes).
 */
type SignatureVerdict =
  | { readonly kind: "landed"; readonly err: TransactionError | null } // la firma TIENE status: entró en un bloque
  | { readonly kind: "expired" } // altura > lastValidBlockHeight, y sin status
  | { readonly kind: "unseen" }; // se acabó la espera; no vimos nada

/** Cada cuánto le volvemos a preguntar a la cadena. Es el mismo `sleep(1000)` del bucle de vencimiento
 *  de `@solana/web3.js` 1.98.4 (lib/index.cjs.js:6676). Con el techo de producción (30 s) son como
 *  mucho 30 lecturas de estado y 30 de altura por confirmación: 60 requests, 2 por segundo.
 *
 *  ⚠️ EL NÚMERO CON EL QUE ESTO SE COMPARABA ERA FALSO POR SEIS ÓRDENES DE MAGNITUD. Acá decía "un
 *  orden de magnitud por debajo" citando las "~27 reconexiones WebSocket" del SDD. Medido por el AR de
 *  esta HU contra un servidor RPC local que contesta `-32601`: el mecanismo anterior hacía ~40.000
 *  intentos POR SEGUNDO sin backoff, o sea ~1.200.000 sobre el mismo techo de 30 s, porque tras el
 *  error devuelve la suscripción a 'pending' y se re-invoca en la misma vuelta sin `sleep`
 *  (lib/index.cjs.js:8404-8410). La comparación honesta es 60 contra ~1.200.000. */
const SIGNATURE_POLL_INTERVAL_MS = 1_000;

/** Espera `ms` sin bloquear. Lo trae WKH-353 para `awaitSignatureVerdict`, `:2151`; sin otro llamador. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
