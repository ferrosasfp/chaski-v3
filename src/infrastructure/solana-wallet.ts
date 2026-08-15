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
  TransactionInstruction,
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
  SolanaPrincipalAuthorization,
  SolanaRemittanceIdResolver,
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
  resolveSolanaComputeUnitPriceMicroLamports,
  resolveSolanaFacilitatorPubkey,
  resolveSolanaNetworkConfig,
  resolveSolanaNetworkId,
  resolveSolanaRpcUrlPublic,
  resolveSolanaUsdcMint,
} from "./chain";
import { ESCROW_INDEX_MAX_ENTRIES } from "./escrow-index-limits";
import { ESCROW_ID_LOOKUP_CEILING } from "./escrow-lookup-limits"; import { ESCROW_STATE_BATCH_CEILING, ESCROW_STATE_BATCH_TIMEOUT_MS } from "./escrow-history-limits"; // WKH-349: EN ESTA LÍNEA, no en una nueva — los imports de este archivo están ARRIBA de `:188` y una línea acá rota TODAS las citas ancladas que apuntan de ahí para abajo, que son las que este archivo recibe. Va pegado a `ESCROW_ID_LOOKUP_CEILING` y no a `ESCROW_INDEX_MAX_ENTRIES` a propósito: ése es justo el techo con el que el nuevo NO se confunde (uno lo pone el servidor del registro durable, el otro el RPC), y quien lea la línea ve los dos juntos
import { solanaWalletBridge } from "./solana-wallet-bridge";

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
const ESCROW_INDEX_PROBE_TIMEOUT_MS = 5_000;

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
    ConnectedWalletProbe, SolanaEscrowChainStateReader // WKH-349: EN ESTA LÍNEA. El estado on-chain de los escrows del historial se le pregunta a la CADENA, así que vive en el mismo adapter por la misma razón que sus vecinos de arriba
{
  private address: string | null = null;

  // HU-SOL-20/AC-2: resolver OPCIONAL del remittanceId durable server-side. Ausente (modo demo o
  // wiring viejo) ⇒ `refundEscrow` sin id explícito falla fail-loud con `escrow_id_unavailable`; el
  // path con id presente NUNCA lo consulta (AC-6 byte-idéntico).
  // `confirmTimeoutMs` es inyectable SÓLO para que los tests no tengan que esperar 30 s de reloj real
  // (el default es el de producción). NUNCA para apagar la confirmación: no hay valor que la saltee.
  constructor(
    private readonly remittanceIdResolver?: SolanaRemittanceIdResolver,
    private readonly confirmTimeoutMs: number = REFUND_CONFIRM_TIMEOUT_MS,
  ) {}

  async connect(): Promise<string> {
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
   * (`window.location.href`, `flow.tsx:407`). Al volver, el resume salta derecho a `confirm` sin
   * pasar por `connect()` (`setStep`, `flow.tsx:222`). Antes, ahí `getAddress()` contestaba `null`.
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
  async getAddress(): Promise<string | null> {
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
  async getConnectedAddress(): Promise<string | null> {
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
  // y la frase de la pantalla es cierta. Espeja a (`listCloseable`, `:1454`), que ya hacía esto.
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
    deposit?: { address: string; escrow?: SolanaEscrowDeposit },
  ): Promise<{ tx: string; solana?: SolanaPrincipalAuthorization }> {
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

    // ── feePayer + blockhash + partial-sign + serializar (AC-2/AC-3) ──
    const { blockhash } = await connection.getLatestBlockhash();
    // Orden [limit, price, deposit]: convención y legibilidad (el límite es lo que el precio
    // multiplica). CR-1 NO lo exige — filtra las ix de ComputeBudget por programId (cr1.ts:106-107) y
    // toma businessIx[0] del array ya filtrado (:115). Se documenta para que nadie lo cambie creyendo
    // que da igual, y para que nadie lo defienda creyendo que el validador lo impone.
    //
    // 🔴 LO QUE SÍ ES UN INVARIANTE: el `deposit` va SIEMPRE en la posición 0 de las ix DE NEGOCIO, y
    // el `register_escrow` DESPUÉS. Hay TRES actores que dependen de eso por POSICIÓN, no por
    // discriminador: el CR-1 del facilitator, el Guard A de SDD 037 y NUESTRO PROPIO SERVIDOR
    // (`tx.instructions.filter`, `settlement/solana-deposit-beneficiary.ts:106`), que indexa la POSICIÓN
    // 0 de las ix del escrow y después exige que sea el `deposit`. Con el orden invertido ese lector devuelve
    // `unreadable` y la route del settle responde 400: TODO depósito patrocinado falla en nuestro
    // propio servidor, antes de que el facilitator vea nada. ⛔ PROHIBIDO invertirlo.
    const tx = regIx
      ? new Transaction().add(limitIx, priceIx, ix, regIx) // [limit, price, deposit, register] — CD-1
      : new Transaction().add(limitIx, priceIx, ix); // [limit, price, deposit] — ver CD-1
    tx.feePayer = new PublicKey(resolveSolanaFacilitatorPubkey()); // AC-2: facilitator paga el fee de red
    tx.recentBlockhash = blockhash;

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

    return {
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
      blockhash,
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
      blockhash: string; // ⚠️ WKH-353: la confirmación YA NO lo consume; el vencimiento se decide por ALTURA, no por blockhash. Queda como superficie muerta DECLARADA, y el motivo que estaba escrito acá ("sacarlo desplazaría las citas ancladas que apuntan a `confirmRefund`") NO es el motivo: ese costo esta misma HU lo pagó diez veces al re-anclar, así que no puede ser lo que frena un borrado. El motivo real, dicho porque es peor: un sistema de citas por NÚMERO DE LÍNEA desincentiva borrar código muerto, porque cada borrado cobra una ronda de re-anclado que el que borra no eligió. El incentivo empuja a acumular superficie muerta, y este campo es el ejemplo vivo.
      lastValidBlockHeight: number;
      coder: { decode(name: string, data: Buffer): unknown };
    },
  ): Promise<EscrowRefundConfirmation> {
    let reverted = false;
    try {
      // WKH-353: preguntamos por HTTP en vez de suscribirnos. `confirmTransaction` abría SIEMPRE un
      // `signatureSubscribe`, el RPC contesta `-32601`, y la espera se consumía entera sin producir
      // ningún veredicto. El techo sigue siendo UNO y sigue siendo el mismo: ver `awaitSignatureVerdict`, `:1750`.
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
      // WKH-353 — el puente hacia los tres desenlaces con nombre, SIN reemplazar una palabra de las
      // tres líneas de arriba: el `expired` de `SignatureVerdict`, `:1831` ES ese blockhash vencido,
      // con nombre propio. Sigue yendo a la sonda por la misma razón de arriba: prueba que la tx no
      // puede entrar DE ACÁ EN ADELANTE, NO que no haya entrado antes. `unseen` es otra cosa y va al
      // mismo lugar: se nos acabó el tiempo de preguntar, y es el que llega hasta acá abajo como
      // excepción "confirm_timeout". Colapsar los dos en un booleano vuelve a perder la distinción
      // que estas líneas existen para no perder.
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
   * POR QUÉ EXIGE `remittanceId` Y `refundEscrow` NO: el fallback de refund (`refundEscrow`, `:914`,
   * que llama a `resolveRemittanceIdFromLedger`, `:353`) elige UNO entre N y actúa sobre él, porque
   * "recuperar mis USDC" tiene un objetivo natural — el escrow que todavía tiene plata. Para `close` no
   * existe ese "el": todos los terminales son igual de cerrables, y elegir uno en silencio le cerraría
   * a la persona una cuenta que no eligió. El descubrimiento (`listCloseable`, `:1454`) devuelve la
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
      blockhash,
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
   * ⚠️ DOS DIVERGENCIAS DELIBERADAS respecto de `confirmRefund`, `:1034`. Están escritas acá para
   * que nadie las "armonice" de vuelta en un code review:
   *
   * 1. `confirmRefund` devuelve "confirmed" apenas la tx confirma sin error (`confirmRefund`, `:1034`), SIN leer nada.
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
    ctx: { blockhash: string; lastValidBlockHeight: number },
  ): Promise<EscrowRefundConfirmation> {
    let reverted = false;
    try {
      // WKH-353, igual que en `confirmRefund`, `:1034`: por HTTP y sin suscripción. El `ctx.blockhash`
      // ya no se consume acá tampoco, y se conserva por la misma razón escrita allá.
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
   * posterior a un veredicto `landed` de `awaitSignatureVerdict`, `:1750` vea el efecto. (WKH-353 cambió
   * QUIÉN aplica el gate de commitment, no que se aplique: lo aplicaba `confirmTransaction`, que ya no
   * está en este archivo, y hoy lo aplica `leerEstado`, `:1758`.) Ningún doble de test puede matar el
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
  async signMessage(message: string): Promise<string> {
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
   * (`resolveRemittanceIdFromLedger`, `:353`) ni (`listCloseable`, `:1454`), que hacen el MISMO
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
   * (`refund_before_deadline`, `:972`). Que las dos expresiones coincidan es lo único que se verifica:
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
    // constructores, sobre un camino que producción no toca (`idsAConsultar`, `../presentation/flow.tsx:3026`). Y a cambio
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
        // (`probeEscrowIndex`, `:1294`), y el mensaje "confirm_timeout" que arrastra `withTimeout` no
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
        // el refund de este mismo archivo rechaza por deadline (`refund_before_deadline`, `:972`).
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
   * `SignatureVerdict`, `:1831`, preguntando por HTTP y sin abrir NINGUNA suscripción.
   *
   * POR QUÉ NO `connection.confirmTransaction`, que es lo que estaba acá antes. Sus dos estrategias
   * terminan las dos en `onSignature`, o sea en un `signatureSubscribe` por WebSocket, y el RPC que
   * usamos contesta `-32601` a ese método. La librería atrapa ese error, lo loguea y devuelve el
   * estado a 'pending' SIN límite de reintentos (su propio código lo admite con un «TODO: Maybe add
   * an 'errored' state or a retry limit?»), así que el estado 'subscribed' no llega nunca — y su
   * respaldo HTTP por `getSignatureStatus` está DETRÁS de esa espera. O sea que ni la suscripción ni
   * el respaldo de la librería podían producir un veredicto: la espera se consumía entera contra el
   * techo y no aprendía nada. Las referencias a `@solana/web3.js` 1.98.4 van SIN el formato anclado
   * del repo a propósito: el candado de citas no escanea `node_modules` y una cita anclada ahí se
   * pondría roja (lib/index.cjs.js:6553, :6562, :6585, :8383-8410).
   *
   * ⚠️ ESTE MÉTODO NO TIENE TECHO PROPIO, Y ESTE BUCLE NO TERMINA SOLO. Acá decía que "lo corta el
   * `withTimeout`, `:150` del llamador", y es FALSO: ese helper es un `Promise.race` contra un
   * `setTimeout`, o sea que rechaza LA ESPERA DEL LLAMADOR y no tiene ninguna forma de detener el
   * trabajo de adentro. Lo que el techo acota es cuánto espera quien llama, no cuánto corre esto.
   * El bucle de abajo sale por `landed` o porque la altura superó `lastValidBlockHeight`, y con un
   * `getBlockHeight` que falla de forma sostenida NO SALE POR NINGUNA DE LAS DOS: el `catch` deja la
   * altura en -1 a propósito (ver el bloque de abajo), y -1 nunca supera nada. Medido: con el RPC de
   * altura tirando siempre, el llamador se va por techo y el bucle sigue haciendo requests después,
   * a ~2 por segundo, hasta que el proceso lo tira. Eso es lo que `solana-wallet.confirm-http.test.ts`
   * llama "huérfano", y su efecto sobre los contadores está escrito ahí.
   *
   * POR QUÉ ESE RESIDUO IGUAL ES LA OPCIÓN CORRECTA, con los dos números y no con adjetivos: este
   * bucle hace 2 req/s (un estado + una altura por vuelta) y bajo rate-limit se frena solo, porque el
   * cliente HTTP de la librería reintenta el 429 con backoff 500→1000→2000→4000 ms
   * (lib/index.cjs.js:5054-5076). El mecanismo anterior, contra el mismo RPC que contesta `-32601`,
   * hacía ~40.000 intentos de suscripción POR SEGUNDO sin ningún backoff (~1.200.000 sobre el techo de
   * 30 s; medición del AR de esta HU, contra un RPC local, y está anotada junto a
   * `SIGNATURE_POLL_INTERVAL_MS`, `:1848`), y tenía LOS MISMOS TRES DEFECTOS que este bucle: el techo
   * del llamador tampoco lo cortaba, por esta misma razón; era inmortal con el RPC de altura caído,
   * porque su propio bucle de vencimiento hacía `catch` y devolvía -1 (mismo archivo, :6665-6670); y
   * dejaba un huérfano por reintento. O sea: residuo CONOCIDO Y MEDIDO, cuatro órdenes de magnitud más
   * barato que el de antes, y NO una regresión de esta HU.
   *
   * Un contador o un techo acá adentro serían un segundo reloj que nadie configura y que nadie ve al
   * leer el llamador; el que quiera matar el huérfano de verdad necesita un `AbortSignal` que cruce
   * desde el llamador, y eso es una HU con su propio alcance, no una línea acá.
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
      // librería aplicaba, y los dos llamadores confirman con "confirmed" (`confirmRefund`, `:1034`).
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
}

/**
 * WKH-353 — el resultado de preguntarle a la cadena por una firma, con TRES desenlaces y no dos.
 *
 * Vive acá abajo, después del cierre de la clase, y no arriba con las constantes. La razón está
 * medida y escrita en `:116`: TODAS las citas ancladas que este archivo RECIBE apuntan de `:188`
 * para abajo, y una línea nueva en la cabecera las rota a todas. Acá desplaza cero.
 *
 * ⚠️ `expired` y `unseen` van HOY al mismo lugar —la sonda on-chain— y aun así son dos miembros
 * distintos. PROHIBIDO colapsarlos a un booleano o a un `if (kind !== "landed")`: la distinción que
 * `confirmRefund`, `:1034` explica en prosa —un blockhash vencido prueba que la tx no puede entrar
 * DE ACÁ EN ADELANTE, NO que no haya entrado antes— sólo queda protegida si tiene una rama con
 * nombre propio que haya que BORRAR para perderla. Con un booleano volvemos al estado anterior a
 * esta HU, con más líneas.
 *
 * `unseen` no lo construye ningún lado de este archivo, y eso es correcto: lo produce el
 * `withTimeout`, `:150` del llamador cuando se acaba la espera, y llega al `catch` que ya existía
 * como la excepción "confirm_timeout". El miembro existe para que el tipo NOMBRE ese desenlace, no
 * para que alguien lo devuelva.
 */
type SignatureVerdict =
  | { readonly kind: "landed"; readonly err: unknown | null } // la firma TIENE status: entró en un bloque
  | { readonly kind: "expired" } // altura > lastValidBlockHeight, y sin status
  | { readonly kind: "unseen" }; // se acabó la espera; no vimos nada

/** Cada cuánto le volvemos a preguntar a la cadena. El número NO es al azar: es el mismo `sleep(1000)`
 *  del bucle de vencimiento de `@solana/web3.js` 1.98.4 (lib/index.cjs.js:6676), o sea el intervalo que
 *  el ecosistema ya considera aceptable para un RPC público. Con el techo de producción (30 s) son como
 *  mucho 30 lecturas de estado y 30 de altura por confirmación, o sea 60 requests y 2 por segundo.
 *
 *  ⚠️ EL NÚMERO CON EL QUE ESTO SE COMPARABA ERA FALSO POR SEIS ÓRDENES DE MAGNITUD. Acá decía "un
 *  orden de magnitud por debajo" citando las "~27 reconexiones WebSocket" del SDD. Medido después por
 *  el AR de esta HU, con un servidor RPC local que contesta `-32601`: el mecanismo anterior hacía
 *  ~40.000 intentos POR SEGUNDO, sostenidos y sin backoff, o sea ~1.200.000 sobre el mismo techo de
 *  30 s. La causa está en la librería: tras el error devuelve la suscripción a 'pending' y se
 *  re-invoca en la misma vuelta, sin `sleep` (lib/index.cjs.js:8404-8410). O sea que la comparación
 *  honesta es 60 contra ~1.200.000, no "un orden de magnitud". */
const SIGNATURE_POLL_INTERVAL_MS = 1_000;

/** Espera `ms` sin bloquear. No existía en este archivo: lo trae WKH-353 para el bucle de
 *  `awaitSignatureVerdict`, `:1750`, y no tiene ningún otro llamador. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
