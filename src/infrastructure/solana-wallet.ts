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
  EscrowRefundConfirmation,
  PrincipalDepositState,
  SolanaEscrowDeposit,
  SolanaEscrowDepositProbe,
  SolanaEscrowRefundResult,
  SolanaPrincipalAuthorization,
  SolanaRemittanceIdResolver,
  SolanaSenderSolBalance,
  SolanaSenderSolBalanceProbe,
  SolanaCloseableEscrowLister,
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
import { solanaWalletBridge } from "./solana-wallet-bridge";

// HU-SOL-20/AC-2: tope de candidatos que el fallback sondea on-chain. Los ids vienen ordenados por
// created_at desc, así que 10 cubre de sobra un escrow reciente perdido y acota a UNA sola llamada RPC.
//
// Se EXPORTA porque el copy de "no encontramos nada" tiene que decir sobre CUÁNTOS envíos miramos, y
// escribir un 10 a mano al lado de la constante que lo decide es exactamente cómo nació la hora
// inventada que `RefundWindowNote` ya tuvo que arreglar una vez.
export const MAX_RECOVERY_CANDIDATES = 10;

// WKH-327/AC-8: tope de candidatos que el descubrimiento de CERRABLES sondea on-chain.
//
// NO es un número inventado ni una copia de MAX_RECOVERY_CANDIDATES: es el techo DURO que aplica el
// servidor (`app/api/solana/escrow/remittance-ids/route.ts:32`, `MAX_IDS = 20`), así que pedir más no
// puede devolver más. Pedir menos sí perdería filas que el servidor sí tenía.
//
// POR QUÉ NO REUSA MAX_RECOVERY_CANDIDATES = 10: su derivación escrita (arriba) habla de "un escrow
// reciente perdido", que es la pregunta del refund — hay UN objetivo natural y está cerca en el tiempo.
// La pregunta del alquiler es otra: mira toda la historia recuperable, porque cada envío terminado dejó
// sus dos cuentas abiertas y todas valen lo mismo.
//
// Se EXPORTA por la misma razón que su vecina: el copy de "no encontramos nada" tiene que decir sobre
// CUÁNTOS envíos miramos, y escribir un 20 a mano al lado de la constante que lo decide es cómo el copy
// termina diciendo un número que el código dejó de usar.
//
// LÍMITE, dicho (L-8): un remitente con más de 20 filas en el ledger NO ve las más viejas, y esta HU no
// recupera ese alquiler. Subirlo requiere tocar el servidor, que está fuera de alcance.
export const MAX_CLOSEABLE_CANDIDATES = 20;

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
 *  que corre dentro del camino que la persona espera mirando la pantalla.
 *
 *  Sin este techo, un `getAccountInfo` colgado (el RPC público que acepta la conexión y no contesta)
 *  deja a la persona mirando "Cerrando…" para siempre. Vencido el techo el resultado es "no pudimos
 *  preguntar", que ACÁ significa abortar sin firmar: ver `probeEscrowIndex`. */
const ESCROW_INDEX_PROBE_TIMEOUT_MS = 5_000;

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
    ConnectedWalletProbe
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
   * (`flow.tsx`:296-300). Al volver, el resume salta derecho al paso `confirm` sin pasar por
   * `connect()` (`flow.tsx`:157-178). Antes de este fallback, ahí `getAddress()` contestaba `null`.
   *
   * El bridge SÍ sobrevive a esa recarga, y no porque persista nada: lo repuebla el sync component
   * desde `useWallet()` en cuanto `autoConnect` reconecta (`solana-providers.tsx`:50-55 y :107).
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

  /** ÚNICA fuente de la derivación de la PDA `escrow_state` para el refund (seeds: "escrow" | sender |
   *  remittanceId[u8;16]) — la usan el path normal y el fallback de recuperación (HU-SOL-20/AC-2), así
   *  que no pueden divergir. Byte-idéntica a la de authorizePrincipal / cross-repo (AH-9).
   *  `PublicKey.findProgramAddressSync` es estático: el import de módulo y el lazy-import resuelven a
   *  la MISMA clase. */
  private deriveEscrowState(
    senderPk: InstanceType<typeof PublicKey>,
    programId: InstanceType<typeof PublicKey>,
    remittanceId: string,
  ): { pda: InstanceType<typeof PublicKey>; bytes: Uint8Array } {
    const bytes = this.remittanceIdToBytes16(remittanceId); // [u8;16] determinístico
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), senderPk.toBuffer(), Buffer.from(bytes)],
      programId,
    );
    return { pda, bytes };
  }

  // HU-SOL-20/AC-2 — FALLBACK de recuperación: el caller no trajo el remittanceId (localStorage
  // borrado / otro dispositivo), así que se lo pide al store durable server-side y se elige on-chain.
  // Sin resolver inyectado ⇒ fail-loud (`escrow_id_unavailable`), NUNCA silencioso.
  // Sondea hasta MAX_RECOVERY_CANDIDATES PDAs en UNA sola llamada RPC y devuelve el PRIMER escrow con
  // status Deposited (los ids llegan ordenados por created_at desc). El resultado es solo un CANDIDATO:
  // el caller vuelve a leer la cuenta elegida y re-aplica los guards autoritativos (status/deadline).
  private async resolveRemittanceIdFromLedger(senderB58: string): Promise<string> {
    const resolver = this.remittanceIdResolver;
    if (!resolver) throw new Error("escrow_id_unavailable"); // fail-loud: no hay de dónde recuperar
    const ids = await resolver.listBySender(senderB58);
    if (ids.length === 0) throw new Error("escrow_not_found"); // nada durable para este sender
    const candidates = ids.slice(0, MAX_RECOVERY_CANDIDATES);

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
    // El guard de vencimiento de la cotización ya corrió aguas arriba (`confirm-and-send.ts`:197,
    // orden CAS → autoridad → expiry → prepare → firma). Éste lo repite localmente para que la
    // wallet nunca firme sobre una cotización con fecha ilegible, venga de donde venga el llamador.
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

    // ── reference (AC-4/CD-SDD-13) — Pubkey único, @solana/web3.js, NO @solana/pay ──
    const reference = Keypair.generate().publicKey; // la privada se DESCARTA (nunca firma)

    // ── Build ix (AC-1/AC-4) — vía anchor Program (programId del idl.address) ──
    const connection = new Connection(
      resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe: NEXT_PUBLIC_SOLANA_RPC_URL ?? público (AR-MNR-2)
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
      .accounts({ sender: senderPk, mint: mintPk, escrowState: escrowStatePda, vault, senderAta })
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

    // ── feePayer + blockhash + partial-sign + serializar (AC-2/AC-3) ──
    const { blockhash } = await connection.getLatestBlockhash();
    // Orden [limit, price, deposit]: convención y legibilidad (el límite es lo que el precio
    // multiplica). CR-1 NO lo exige — filtra las ix de ComputeBudget por programId (cr1.ts:106-107) y
    // toma businessIx[0] del array ya filtrado (:115). Se documenta para que nadie lo cambie creyendo
    // que da igual, y para que nadie lo defienda creyendo que el validador lo impone.
    const tx = new Transaction().add(limitIx, priceIx, ix); // [limit, price, deposit] — ver CD-1
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
    const escrowId =
      typeof remittanceId === "string" && remittanceId.trim().length > 0
        ? remittanceId
        : await this.resolveRemittanceIdFromLedger(senderB58);

    // ── lazy-import (patrón authorizePrincipal, DT-SDD-8) ──
    const web3 = await import("@solana/web3.js");
    const { PublicKey, Transaction, Connection } = web3;
    const anchor = await import("@coral-xyz/anchor");
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const { escrowIdl } = await import("./solana/escrow-idl");

    const senderPk = new PublicKey(senderB58); // valida base58 (CD-SDD-7)
    const programId = new PublicKey((escrowIdl as { address: string }).address); // DR5G…SE4x

    // ── PDA escrow_state (misma derivación que authorizePrincipal / cross-repo, AH-9) ──
    const { pda: escrowStatePda, bytes: remittanceIdBytes } = this.deriveEscrowState(
      senderPk,
      programId,
      escrowId,
    );

    const connection = new Connection(
      resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe
    );

    // ── Read on-chain (autoritativo): status==Deposited && now>=deadline (AC-6/AC-7) ──
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
    const signed = (await solanaWalletBridge.signTransaction(tx)) as Web3Transaction; // firma SÓLO el sender
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
      blockhash: string;
      lastValidBlockHeight: number;
      coder: { decode(name: string, data: Buffer): unknown };
    },
  ): Promise<EscrowRefundConfirmation> {
    let reverted = false;
    try {
      const res = await withTimeout(
        connection.confirmTransaction(
          {
            signature,
            blockhash: ctx.blockhash,
            lastValidBlockHeight: ctx.lastValidBlockHeight,
          },
          "confirmed",
        ),
        this.confirmTimeoutMs,
      );
      // La tx entró en un bloque Y el programa la revirtió: eso sí es un "no" (los USDC no se movieron).
      if (res?.value?.err) throw new RefundTxReverted("refund_tx_failed");
      return "confirmed"; // confirmada sin error ⇒ la ix `refund` se ejecutó
    } catch (err) {
      // Todo lo que NO sea un revert medido es "no pudimos ver": timeout, blockhash vencido, websocket
      // ausente, RPC caído. Un blockhash vencido prueba que la tx no puede entrar DE ACÁ EN ADELANTE,
      // NO que no haya entrado antes ⇒ hay que ir a mirar el estado autoritativo.
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
   * Qué NO recupera: el alquiler del `EscrowIndex` — no hay instrucción que cierre esa cuenta.
   *
   * POR QUÉ EXIGE `remittanceId` Y `refundEscrow` NO: el fallback de refund (`:498-502` + `:211-246`)
   * elige UNO entre N y actúa sobre él, porque "recuperar mis USDC" tiene un objetivo natural — el
   * escrow que todavía tiene plata. Para `close` no existe ese "el": todos los terminales son igual de
   * cerrables, y elegir uno en silencio le cerraría a la persona una cuenta que no eligió. El
   * descubrimiento (`listCloseableEscrows`) devuelve la LISTA y elige ella.
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
   * NO declara ComputeBudget, a diferencia de `authorizePrincipal` (`:324-342`): aquello existía por el
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
   */
  private async probeEscrowIndex(
    connection: Web3Connection,
    senderPk: InstanceType<typeof PublicKey>,
    programId: InstanceType<typeof PublicKey>,
    coder: { decode(name: string, data: Buffer): unknown },
  ): Promise<
    | { status: "present"; pda: InstanceType<typeof PublicKey> }
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
    try {
      coder.decode("EscrowIndex", info.data);
    } catch {
      // El decode no es decorativo: distingue "el índice de este sender" de "una cuenta que cayó en esa
      // dirección y no es lo que creemos". Meter una cuenta ESCRIBIBLE que no podemos identificar en
      // una tx del money-path es peor que no mandarla.
      return { status: "unknown" };
    }
    return { status: "present", pda };
  }

  /**
   * ¿Entró el `close`? Devuelve el tri-estado y TIRA `close_tx_failed` sólo cuando medimos que la tx
   * entró y revirtió Y la cuenta sigue ahí.
   *
   * ⚠️ DOS DIVERGENCIAS DELIBERADAS respecto de `confirmRefund` (`:582-622`). Están escritas acá para
   * que nadie las "armonice" de vuelta en un code review:
   *
   * 1. `confirmRefund` devuelve "confirmed" apenas la tx confirma sin error (`:607`), SIN leer nada.
   *    Éste NO puede: AC-5 exige que el alquiler volvió se afirme *sólo después de leer que la cuenta
   *    ya no existe*. Un `confirmTransaction` sin `err` prueba que la tx ENTRÓ; leer la ausencia es lo
   *    que prueba que hizo lo que queríamos. El input que pone en rojo cualquier atajo acá: un doble
   *    con `confirmTransaction` OK y `getAccountInfo` que sigue devolviendo la cuenta tiene que dar
   *    "pending" (test "AC-5: confirmación limpia + la cuenta SIGUE AHÍ ⇒ 'pending'").
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
      const res = await withTimeout(
        connection.confirmTransaction(
          { signature, blockhash: ctx.blockhash, lastValidBlockHeight: ctx.lastValidBlockHeight },
          "confirmed",
        ),
        this.confirmTimeoutMs,
      );
      if (res?.value?.err) throw new CloseTxReverted("close_tx_failed");
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
   * trampa que `probeEscrowRefunded` ya tiene escrita (`:633-635`). Por eso el copy del éxito NO
   * menciona los USDC (CD-15).
   *
   * ⚠️ El commitment "confirmed" es EXPLÍCITO y no es decorativo. Medido en la librería instalada: el
   * constructor de `Connection` deja `this._commitment = void 0` salvo que le pasen algo
   * (`node_modules/@solana/web3.js/lib/index.cjs.js:5985-6090`) y `_buildArgs` sólo adjunta
   * `commitment` si `override || this._commitment` es truthy (`:8769-8781`). O sea: sin este argumento
   * la lectura NO manda commitment y la decisión queda del lado del RPC, cuyo default documentado es
   * `finalized` — que corre por detrás del `confirmed` con el que confirmamos la tx dos líneas arriba.
   * Sin este argumento, un `close` genuinamente exitoso reportaría "pending" casi siempre, y "pending"
   * no es gratis: le dice a la persona "no sabemos" sobre algo que a ese nivel sí sabemos.
   *
   * Lo que este argumento CUESTA, dicho: `confirmed` no es `finalized`, así que un rollback de ese slot
   * devolvería las cuentas. Es asimétrico a favor — un rollback RESTITUYE el alquiler y la persona
   * puede volver a cerrar; lo que se pierde es exactitud del mensaje durante esa ventana.
   *
   * 🔴 **No se pudo verificar** contra un RPC real que un `getAccountInfo(pda,"confirmed")`
   * inmediatamente posterior a un `confirmTransaction(...,"confirmed")` vea el efecto. Ningún doble de
   * test puede matar el mutante que borra este argumento: el mock ignora el segundo parámetro y
   * devuelve lo mismo con o sin él. Su detección es del code review, y el único input que lo probaría
   * es un `close` real contra devnet.
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
   * Espeja `resolveRemittanceIdFromLedger` (`:211-246`) en su disciplina: fail-loud sin resolver, tope
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
   */
  async listCloseable(input: { sender: string }): Promise<readonly CloseableEscrow[]> {
    const resolver = this.remittanceIdResolver;
    if (!resolver) throw new Error("escrow_id_unavailable"); // fail-loud, nunca silencioso
    const ids = await resolver.listBySender(input.sender);
    // El tope es del SERVIDOR (`remittance-ids/route.ts:32`, MAX_IDS = 20): pedir más no puede
    // devolver más. Un remitente con más filas no ve las más viejas — declarado, no mitigado (L-8).
    const candidates = ids.slice(0, MAX_CLOSEABLE_CANDIDATES);
    if (candidates.length === 0) return []; // el servidor CONTESTÓ y no tiene nada de esta billetera

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
}
