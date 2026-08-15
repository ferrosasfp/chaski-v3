// Tests — WKH-353. La confirmación de `refund` y de `close` pregunta por HTTP y NO abre ninguna
// suscripción de firma.
//
// 🔴 QUÉ DAÑO CIERRA ESTE ARCHIVO, y por qué no alcanzaba con lo que ya había. `confirmTransaction`
// abre SIEMPRE un `signatureSubscribe` por WebSocket. El RPC que usamos contesta `-32601` a ese
// método; la librería atrapa ese error, lo loguea y devuelve la máquina de estados a 'pending' sin
// límite de reintentos, así que el estado 'subscribed' no llega nunca — y el respaldo HTTP que la
// propia librería tiene está DETRÁS de esa espera. Resultado medido en producción: la confirmación
// se comía los 30 s enteros del techo y no producía ningún veredicto, ni bueno ni malo.
//
// ⚠️ LO QUE ESTE ARCHIVO NO PRUEBA, dicho para que nadie lo cite de más:
//   1. NO prueba que el endpoint real conteste rápido. Eso es un refund contra devnet, no un doble.
//   2. NO prueba nada del camino de DEPÓSITO, que confirma en otro repo (`wasiai-facilitator`).
//      Ningún test de acá se pone rojo si ese repo cambia. Lo único que T-353-9 candea es que
//      NOSOTROS no reintroduzcamos `confirmTransaction`.
//   3. NO prueba que la fuga de reintentos de la librería esté cerrada. Se cierra de rebote, porque
//      deja de haber suscripción que abrir, y eso no tiene test propio.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// QUÉ MUTANTE MATA CADA TEST. TODOS APLICADOS Y CORRIDOS, NINGUNO POR SIMETRÍA.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Cada fila se midió así: aplicar UNA edición mínima en `solana-wallet.ts`, correr, anotar QUÉ se
// puso rojo, revertir. La columna de la derecha es lo que la corrida devolvió, no lo que yo esperaba.
//
//   Mutante aplicado                                              │ Qué se puso ROJO
//   ──────────────────────────────────────────────────────────────┼──────────────────────────────────
//   volver `confirmRefund` al `confirmTransaction` de antes        │ T-353-1 por los TRES ejes, medidos
//                                                                  │ uno por uno: (a) «onSignature
//                                                                  │ called 1 times», (b) idem
//                                                                  │ confirmTransaction, (c) 3113 ms
//                                                                  │ contra un tope de 1000. Y T-353-9.
//   borrar el chequeo de `verdict.err` en `confirmRefund`          │ T-353-3 (+ T-353-8)
//   `expired` ⇒ "pending" sin pasar por la sonda                   │ T-353-4 y T-353-8
//   borrar la ÚLTIMA MIRADA del paso 2                             │ T-353-5, y SÓLO T-353-5
//   `height > lastValid` ⇒ `height >= lastValid` (el borde)         │ T-353-5b, y SÓLO T-353-5b (12 de
//                                                                  │ 13 verdes). Con DOS polls en vez
//                                                                  │ de tres, el mismo mutante PASA:
//                                                                  │ medido, y por eso son tres.
//   `catch { height = -1 }` ⇒ `Number.MAX_SAFE_INTEGER`            │ T-353-6, y SÓLO T-353-6
//   borrar el `catch` de `leerEstado` (el throw se propaga)        │ T-353-6b, y SÓLO T-353-6b
//   aceptar `"processed"` como confirmado                          │ T-353-7, y SÓLO T-353-7
//   `getSignatureStatuses` CON `searchTransactionHistory: true`    │ la aserción de
//                                                                  │ `solana-wallet.refund.test.ts`
//   llamar a `onSignature` dentro del bucle nuevo                  │ el 3er `it` de T-353-9 (+ 1..4)
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SolanaWalletAdapter } from "./solana-wallet";
import { escrowIdl } from "./solana/escrow-idl";
import { solanaWalletBridge } from "./solana-wallet-bridge";

const ESCROW_PROGRAM_ID = "DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x";
const MINT_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const FIXED_BLOCKHASH = Keypair.generate().publicKey.toBase58();

const SENDER_KP = Keypair.generate();
const SENDER_B58 = SENDER_KP.publicKey.toBase58();
const AUTHORITY_PK = Keypair.generate().publicKey;
const PROGRAM_ID = new PublicKey(ESCROW_PROGRAM_ID);

/** ⏱️ EL TECHO DE ESTE ARCHIVO ES 3.000 ms Y NO 20, y ésa es la diferencia entre un candado y un
 *  adorno. El resto de los tests del adapter usa `connected(20)` porque sólo les importa que el techo
 *  VENZA. Acá el eje temporal tiene que DISTINGUIR "resolvió por poll" de "resolvió por techo
 *  vencido", y con 20 ms el código VIEJO también termina en ~20 ms: la aserción daría verde con el
 *  bug adentro y sin él. Con 3.000 ms, el camino bueno resuelve en el primer poll (~0 ms) y el malo
 *  paga los 3 s enteros.
 *
 *  ⚠️ Y ESTO NO ES GRATIS CUANDO ESTÁ VERDE, que es lo que acá decía. Medido con los 13 tests en
 *  verde: T-353-6 (3.015 ms), T-353-7 (3.023 ms) y T-353-8 (3.031 ms) concluyen POR el techo, o sea
 *  ~9,1 s de los 12,3 s del archivo, en CADA corrida. No paga sólo el rojo: paga siempre. La decisión
 *  sigue siendo ésta porque un techo que no distingue no candea nada, pero el precio es ése. */
const TECHO_MS = 3_000;
/** Holgadamente por encima de un ciclo de poll (`SIGNATURE_POLL_INTERVAL_MS` = 1.000 ms) y
 *  holgadamente por debajo del techo. Es la banda que separa los dos desenlaces. */
const TOPE_ELAPSED_MS = 1_000;

const ULTIMO_BLOQUE_VALIDO = 10_000;
const BLOQUE_VIGENTE = 1;
const BLOQUE_VENCIDO = 1_000_000;

/**
 * 🔴 LA FIRMA TIENE QUE SER BASE58 DE 64 BYTES DE VERDAD, Y ÉSA ES LA DIFERENCIA ENTRE UN CANDADO Y
 * UN ADORNO. El resto de los tests del adapter usa la cadena literal «refund-sig», que les alcanza
 * porque nunca ejecutan el `confirmTransaction` real. Acá sí: el spy de `confirmTransaction` deja
 * pasar, y el mutante que devuelve el código viejo entra al cuerpo de la librería.
 *
 * MEDIDO contra `@solana/web3.js` 1.98.4, y por eso está escrito acá:
 *   · con «refund-sig», `confirmTransaction` RECHAZA en 0 ms con «signature must be base58
 *     encoded» y NUNCA llega a `onSignature`. Con eso, el mutante del código viejo terminaba rápido:
 *     la aserción de ausencia (a) quedaba VACUAMENTE cierta y el eje temporal (c) no distinguía nada.
 *     O sea, dos de los tres ejes aplaudiendo el bug.
 *   · con esta firma, `confirmTransaction` llama a `onSignature` UNA vez y después SIGUE COLGADO
 *     (medido a 4.000 ms sin resolver). Que es exactamente lo que hace en producción contra un RPC
 *     que contesta `-32601`, y lo que hace que (a), (b) y (c) sean los tres mortales.
 */
const FIRMA_VALIDA = bs58.encode(new Uint8Array(64).fill(7));

function remittanceIdBytes16(remittanceId: string): Uint8Array {
  return Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
}

function escrowStatePdaOf(remittanceId: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), SENDER_KP.publicKey.toBuffer(), Buffer.from(remittanceIdBytes16(remittanceId))],
    PROGRAM_ID,
  )[0];
}

const ESCROW_INDEX_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from("escrow-index"), SENDER_KP.publicKey.toBuffer()],
  PROGRAM_ID,
)[0];

async function encodeEscrowState(
  status: "deposited" | "released" | "refunded",
  deadlineSec = Math.floor(Date.now() / 1000) - 3600,
): Promise<Buffer> {
  const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
  return coder.encode("EscrowState", {
    sender: SENDER_KP.publicKey,
    beneficiary: Keypair.generate().publicKey,
    authority: AUTHORITY_PK,
    mint: new PublicKey(MINT_B58),
    amount: new anchor.BN(1_000_000),
    deadline: new anchor.BN(deadlineSec),
    status:
      status === "deposited" ? { Deposited: {} } : status === "released" ? { Released: {} } : { Refunded: {} },
    bump: 255,
  });
}

function accountInfo(data: Buffer) {
  return { data, executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0 };
}

/** El estado que devuelve un poll. `null` = la cadena contestó y todavía no tiene nada de esta firma;
 *  `"throw"` = no pudimos ni preguntar, que NO es lo mismo y por eso son dos valores. */
type Poll = { err: unknown; nivel: "processed" | "confirmed" | "finalized" } | null | "throw";

/** Los polls, EN ORDEN; el último se repite para siempre. Un array y no un valor fijo porque los dos
 *  candados más finos —la última mirada y el commitment gate— sólo se pueden escribir como una
 *  SECUENCIA: "primero nada, después algo". */
function mockStatuses(...polls: Poll[]) {
  let i = 0;
  return vi.spyOn(Connection.prototype, "getSignatureStatuses").mockImplementation((async () => {
    const p = polls[Math.min(i, polls.length - 1)] ?? null;
    i++;
    if (p === "throw") throw new Error("rpc_down");
    return {
      context: { slot: 1 },
      value: [p === null ? null : { slot: 1, confirmations: 1, err: p.err, confirmationStatus: p.nivel }],
    };
  }) as never);
}

/** ⚠️ `getBlockHeight` NO se dobla con `vi.spyOn(Connection.prototype, ...)`: es la única de las que
 *  estos tests doblan que el constructor de `Connection` le asigna a CADA instancia, así que no está
 *  en el prototype y vitest tira «getBlockHeight does not exist». La medición completa y el porqué
 *  del accessor están escritos una sola vez, en
 *  (`mockBlockHeight`, `solana-wallet.refund.test.ts:75`). */
function mockBlockHeight(height: () => Promise<number>): { llamadas: number } {
  const contador = { llamadas: 0 };
  const envuelto = async () => {
    contador.llamadas++;
    return height();
  };
  Object.defineProperty(Connection.prototype, "getBlockHeight", {
    configurable: true,
    get: () => envuelto,
    set: () => {},
  });
  return contador;
}

/** Responde por PUBKEY y por número de lectura. Mapear por orden de llamada le daría al índice la
 *  respuesta del escrow, que es el footgun que `solana-wallet.close.test.ts:6-10` ya tiene escrito.
 *
 *  Devuelve un contador PROPIO y no el `mock.calls` del spy a propósito: T-353-8 vuelve a llamar a
 *  `mockChain` dentro de un `for`, y el spy del prototype es el MISMO objeto entre vueltas, así que
 *  sus `calls` se acumularían y la aserción de la segunda vuelta pasaría con las llamadas de la
 *  primera. Un contador por instalación no puede hacer eso. */
type Reply = Buffer | null;
function mockChain(byPda: Record<string, Reply | Reply[]>): { lecturas: number } {
  const vistas = new Map<string, number>();
  const contador = { lecturas: 0 };
  vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation((async (k: PublicKey) => {
    const key = k.toBase58();
    const entry = byPda[key];
    const n = vistas.get(key) ?? 0;
    vistas.set(key, n + 1);
    contador.lecturas++;
    const reply = Array.isArray(entry) ? (entry[Math.min(n, entry.length - 1)] ?? null) : (entry ?? null);
    return reply ? accountInfo(reply) : null;
  }) as never);
  return contador;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// El doble del `-32601` de Alchemy: ABRE Y NUNCA NOTIFICA. NO TIRA.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 ÉSTA ES LA DECISIÓN QUE HACE QUE EL CANDADO SEA UN CANDADO, y es contraintuitiva. Si el doble de
// `onSignature` TIRARA una excepción, el `catch (err) { reject(err) }` de la librería rechazaría de
// inmediato; entonces, CON EL CÓDIGO VIEJO, `confirmTransaction` fallaría en milisegundos, el techo
// ni se dispararía, el `catch` de `confirmRefund` atraparía, y la sonda devolvería el veredicto
// correcto rápido. O sea: el código viejo PASARÍA el test. Tendríamos un candado que aplaude el bug
// que la HU vino a arreglar.
//
// Por eso el doble hace lo que Alchemy hace de verdad: devuelve un id de suscripción y NUNCA invoca
// el callback. Con eso el código viejo no puede resolver de ninguna manera y sólo termina cuando
// vence el techo, que es lo que el eje temporal mide.
const SIGNATURE_SUBSCRIBE_NOT_FOUND = {
  code: -32601,
  message: "Method 'signatureSubscribe' not found",
};

/** El `-32601` que el doble deja DISPONIBLE, y los dos spies de ausencia. Va como función para que
 *  TypeScript infiera los tipos de los spies: declararlos como `ReturnType<typeof vi.spyOn>` no
 *  compila (el default genérico no acepta las firmas concretas de `Connection`). */
function instalarDoblesDeSuscripcion(subscribeRejections: unknown[]) {
  const onSignatureSpy = vi
    .spyOn(Connection.prototype, "onSignature")
    .mockImplementation(((_sig: string, _cb: unknown) => {
      subscribeRejections.push(SIGNATURE_SUBSCRIBE_NOT_FOUND);
      return 1; // ClientSubscriptionId: abre, y no notifica NUNCA
    }) as never);
  // Defensa en profundidad: las otras dos puertas de la misma suscripción.
  vi.spyOn(Connection.prototype, "onSignatureWithOptions").mockImplementation(((
    _sig: string,
    _cb: unknown,
  ) => {
    subscribeRejections.push(SIGNATURE_SUBSCRIBE_NOT_FOUND);
    return 1;
  }) as never);
  vi.spyOn(Connection.prototype, "removeSignatureListener").mockImplementation((async () => {}) as never);
  // 🔴 ESTE SPY NO LLEVA `mockImplementation`, Y LA RAZÓN LA DIO UNA MEDICIÓN. Con un doble que
  // colgaba, `confirmTransaction` nunca llegaba a su cuerpo real, así que nunca llamaba a
  // `onSignature`: el mutante que devuelve el código viejo dejaba la aserción (a) VACUAMENTE cierta y
  // sólo la mataban (b) y el eje temporal. Sin doble, el mutante viejo entra al cuerpo real de la
  // librería, y ahí sí abre la suscripción contra nuestro `onSignature` — que es lo que (a) afirma
  // que no pasa. En el código correcto este spy no se llama nunca, así que dejarlo pasar no cuesta
  // nada. Medido: con el mutante, (a) pasa de vacua a mortal.
  const confirmTransactionSpy = vi.spyOn(Connection.prototype, "confirmTransaction");
  return { onSignatureSpy, confirmTransactionSpy };
}

describe("WKH-353 — la confirmación pregunta por HTTP y no abre suscripción", () => {
  let onSignatureSpy: ReturnType<typeof instalarDoblesDeSuscripcion>["onSignatureSpy"];
  let confirmTransactionSpy: ReturnType<typeof instalarDoblesDeSuscripcion>["confirmTransactionSpy"];
  /** El `-32601` que el doble dejó DISPONIBLE. Que quede vacío es lo que documenta que nadie pidió la
   *  suscripción: el error real de Alchemy estaba ahí y no se llegó a él. */
  let subscribeRejections: unknown[];

  beforeEach(() => {
    subscribeRejections = [];
    ({ onSignatureSpy, confirmTransactionSpy } = instalarDoblesDeSuscripcion(subscribeRejections));

    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: FIXED_BLOCKHASH,
      lastValidBlockHeight: ULTIMO_BLOQUE_VALIDO,
    } as Awaited<ReturnType<Connection["getLatestBlockhash"]>>);
    vi.spyOn(Connection.prototype, "sendRawTransaction").mockImplementation((async () => FIRMA_VALIDA) as never);
    const firmar: ReturnType<typeof vi.fn> = vi.fn(async (tx: Transaction) => {
      tx.partialSign(SENDER_KP); // firma REAL: `serialize()` exige la del feePayer
      return tx;
    });
    solanaWalletBridge.registerSignTransaction(firmar);
  });

  afterEach(() => {
    solanaWalletBridge.reset();
    vi.restoreAllMocks();
    // `vi.restoreAllMocks()` no deshace un `defineProperty`.
    Reflect.deleteProperty(Connection.prototype, "getBlockHeight");
  });

  async function conectado(): Promise<SolanaWalletAdapter> {
    solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
    const adapter = new SolanaWalletAdapter(undefined, TECHO_MS);
    await adapter.connect();
    return adapter;
  }

  // ── T-353-1 · el candado de la HU, con sus TRES EJES ──────────────────────────────────────────────
  // Un solo eje no alcanza, y cada uno está por una razón distinta:
  //   EJE 1 (estructural) — el código no abre la suscripción.
  //   EJE 2 (temporal)    — el veredicto sale del poll, no del techo vencido.
  //   EJE 3 (veredicto)   — y además contesta bien, Y contestó PREGUNTANDO.
  // El eje 3 no es adorno: sin él, las aserciones de AUSENCIA del eje 1 son vacuamente ciertas si un
  // refactor saltea la confirmación entera, y el test aplaudiría un agujero más grande que el que
  // cierra. Toda aserción de ausencia lleva su aserción de presencia al lado, en el mismo `it`.
  it("T-353-1 (AC-5): el refund confirma SIN abrir signatureSubscribe, resuelve por poll y devuelve 'confirmed'", async () => {
    mockChain({ [escrowStatePdaOf("rem-1").toBase58()]: await encodeEscrowState("deposited") });
    const statusSpy = mockStatuses({ err: null, nivel: "confirmed" });
    mockBlockHeight(async () => BLOQUE_VIGENTE);
    const adapter = await conectado();

    // Los tres ejes se assertean DESPUÉS de esperar el resultado, y en el orden 1-2-3 a propósito: si
    // el veredicto fuera lo primero, el `it` abortaría ahí y los otros dos ejes no llegarían a
    // reportar. Medido con el mutante del código viejo: en este orden se ven caer los tres.
    const t0 = Date.now();
    const resultado = await adapter.refundEscrow("rem-1");
    const elapsed = Date.now() - t0;

    // EJE 1 (a) y (b): estructural. MEDIDO con el mutante que devuelve `confirmRefund` al
    // `confirmTransaction` de antes: (a) se pone roja porque el spy de `confirmTransaction` deja
    // pasar la llamada al cuerpo real de la librería, que abre la suscripción contra nuestro doble.
    expect(onSignatureSpy).not.toHaveBeenCalled();
    expect(confirmTransactionSpy).not.toHaveBeenCalled();
    // EJE 2 (c): temporal. Con el código viejo y este doble, `confirmTransaction` NO PUEDE resolver
    // (la suscripción no notifica nunca) y sólo termina al vencer el techo ⇒ elapsed ≈ TECHO_MS.
    expect(elapsed).toBeLessThan(TOPE_ELAPSED_MS);
    // EJE 3 (d): el veredicto correcto.
    expect(resultado).toEqual({ refundTx: FIRMA_VALIDA, confirmation: "confirmed" });
    // EJE 3 (e): presencia. Sin esto, (a) y (b) serían ciertas también si nadie confirmara nada.
    expect(statusSpy).toHaveBeenCalled();
    // EJE 3 (f): el `-32601` estuvo DISPONIBLE y nadie lo pidió. O sea que el doble carga el error
    // real de Alchemy y no un timeout genérico.
    expect(subscribeRejections.length).toBe(0);
  });

  it("T-353-2 (AC-5): el close confirma SIN abrir signatureSubscribe, resuelve por poll y devuelve 'confirmed'", async () => {
    const terminal = await encodeEscrowState("released");
    // Segunda lectura `null`: la sonda de `confirmClose` ve la AUSENCIA, que es lo único que prueba
    // que el alquiler volvió. El close NO retorna temprano con la tx confirmada (divergencia 1).
    mockChain({
      [escrowStatePdaOf("rem-2").toBase58()]: [terminal, null],
      [ESCROW_INDEX_PDA.toBase58()]: null,
    });
    const statusSpy = mockStatuses({ err: null, nivel: "confirmed" });
    mockBlockHeight(async () => BLOQUE_VIGENTE);
    const adapter = await conectado();

    const t0 = Date.now();
    const resultado = await adapter.closeEscrow("rem-2");
    const elapsed = Date.now() - t0;

    expect(onSignatureSpy).not.toHaveBeenCalled();
    expect(confirmTransactionSpy).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(TOPE_ELAPSED_MS);
    expect(resultado).toEqual({ closeTx: FIRMA_VALIDA, confirmation: "confirmed" });
    expect(statusSpy).toHaveBeenCalled();
    expect(subscribeRejections.length).toBe(0);
  });

  // ── T-353-3 · el revert se sigue detectando, ahora leyendo `err` del status ───────────────────────
  it("T-353-3: el status trae `err` ⇒ refund_tx_failed (el 'no' MEDIDO sigue siendo un 'no')", async () => {
    // La sonda dice Deposited: la plata sigue en el vault, así que el revert no lo tapa nada.
    mockChain({
      [escrowStatePdaOf("rem-3").toBase58()]: await encodeEscrowState("deposited"),
    });
    mockStatuses({ err: { InstructionError: [0, { Custom: 6002 }] }, nivel: "confirmed" });
    mockBlockHeight(async () => BLOQUE_VIGENTE);
    const adapter = await conectado();

    await expect(adapter.refundEscrow("rem-3")).rejects.toThrow("refund_tx_failed");
    expect(onSignatureSpy).not.toHaveBeenCalled();
  });

  // ── T-353-4 · `expired` NO es "no entró" ─────────────────────────────────────────────────────────
  it("T-353-4: altura VENCIDA y sin status ⇒ no se afirma fracaso, se va a la sonda, y gana la sonda", async () => {
    // La sonda dice Refunded: la plata YA volvió, aunque nunca hayamos visto la firma. Convertir
    // `expired` en "no entró" haría que este caso reportara un fracaso sobre plata que sí volvió, que
    // es exactamente la mentira vieja al revés.
    mockChain({
      [escrowStatePdaOf("rem-4").toBase58()]: [
        await encodeEscrowState("deposited"), // guard pre-firma
        await encodeEscrowState("refunded"), // sonda post-broadcast
      ],
    });
    const statusSpy = mockStatuses(null); // la cadena contesta y NUNCA tiene la firma
    const alturas = mockBlockHeight(async () => BLOQUE_VENCIDO);
    const adapter = await conectado();

    const t0 = Date.now();
    await expect(adapter.refundEscrow("rem-4")).resolves.toEqual({
      refundTx: FIRMA_VALIDA,
      confirmation: "confirmed",
    });
    // No se consumió el techo: el vencimiento se CONCLUYE, no se espera.
    expect(Date.now() - t0).toBeLessThan(TOPE_ELAPSED_MS);
    expect(alturas.llamadas).toBeGreaterThanOrEqual(1); // se llegó a preguntar la altura
    expect(statusSpy).toHaveBeenCalled();
    expect(onSignatureSpy).not.toHaveBeenCalled();
  });

  // ── T-353-5 · la ÚLTIMA MIRADA del paso 2 ────────────────────────────────────────────────────────
  it("T-353-5: altura vencida PERO el status aparece en la relectura ⇒ gana `landed`, no `expired`", async () => {
    // La carrera real: la tx entró en el último bloque válido mientras nosotros leíamos la altura.
    // La sonda queda en Deposited a propósito: si el veredicto fuera `expired` el resultado sería
    // "pending", así que el "confirmed" sólo puede venir de la última mirada.
    mockChain({ [escrowStatePdaOf("rem-5").toBase58()]: await encodeEscrowState("deposited") });
    mockStatuses(null, { err: null, nivel: "confirmed" }); // 1º nada, 2º (la última mirada) sí
    mockBlockHeight(async () => BLOQUE_VENCIDO);
    const adapter = await conectado();

    const t0 = Date.now();
    await expect(adapter.refundEscrow("rem-5")).resolves.toEqual({
      refundTx: FIRMA_VALIDA,
      confirmation: "confirmed",
    });
    expect(Date.now() - t0).toBeLessThan(TOPE_ELAPSED_MS);
  });

  // ── T-353-5b · el BORDE del vencimiento: `>` y no `>=` ───────────────────────────────────────────
  it("T-353-5b: altura EXACTAMENTE igual a `lastValidBlockHeight` ⇒ TODAVÍA no venció, se sigue preguntando", async () => {
    // El borde que no probaba nadie: los otros casos usan 1 y 1.000.000 contra 10.000, así que `>` y
    // `>=` daban lo mismo en todos. El signo lo fija la semántica de Solana, no el gusto:
    // `lastValidBlockHeight` es el ÚLTIMO bloque en el que la tx todavía puede entrar, así que estar
    // parado en él no es haber vencido. Con `>=` la confirmación abandona un bloque antes de tiempo y
    // manda a la sonda una tx que todavía podía entrar: no pierde plata (la sonda sigue decidiendo),
    // pero degrada el veredicto sin motivo.
    //
    // POR QUÉ TRES POLLS Y NO DOS, que es lo que hace mortal a este test y está MEDIDO: con `>=` el
    // bucle concluye en la PRIMERA vuelta y su ÚLTIMA MIRADA consume el 2º poll; con `>`, el 2º poll lo
    // consume la 2ª vuelta y el veredicto sale del 3º. Con dos polls los dos caminos leen el
    // `confirmed` en la misma lectura y los dos devuelven "confirmed": el mutante SOBREVIVE (medido,
    // verde con `>=`). Con tres, muere.
    //
    // La sonda queda en Deposited a propósito: si el veredicto fuera `expired`, el resultado sería
    // "pending". Así que el "confirmed" sólo puede venir de haber seguido preguntando.
    //
    // La aserción que discrimina es de VALOR y no un contador, y eso es deliberado: los contadores de
    // este archivo pueden traer llamadas de un bucle huérfano de otro test (ver el bloque de abajo,
    // arriba de T-353-6).
    mockChain({ [escrowStatePdaOf("rem-5b").toBase58()]: await encodeEscrowState("deposited") });
    mockStatuses(null, null, { err: null, nivel: "confirmed" });
    mockBlockHeight(async () => ULTIMO_BLOQUE_VALIDO); // EXACTAMENTE el último bloque válido
    const adapter = await conectado();

    await expect(adapter.refundEscrow("rem-5b")).resolves.toEqual({
      refundTx: FIRMA_VALIDA,
      confirmation: "confirmed",
    });
  }, 20_000);

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ⚠️ LOS CONTADORES DE LOS TRES TESTS DE ACÁ ABAJO PUEDEN INCLUIR LLAMADAS QUE NO SON SUYAS
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // T-353-6, T-353-6b y T-353-7 terminan porque VENCE EL TECHO, y el techo rechaza la espera del
  // llamador SIN detener el bucle de adentro: `withTimeout` es un `Promise.race` contra un `setTimeout`
  // y no tiene ninguna forma de cancelar el trabajo que perdió la carrera. O sea que cada uno de esos
  // tests deja un bucle HUÉRFANO corriendo, y el huérfano resuelve `getSignatureStatuses` y
  // `getBlockHeight` por el PROTOTYPE EN EL MOMENTO DE LLAMAR: cae en el doble que instaló el test
  // siguiente y le mueve el contador.
  //
  // MEDIDO acá, no deducido (techo de 1.500 ms, altura que tira siempre, estados siempre `null`):
  //   · el llamador se fue a los 1.641 ms con 2 lecturas de estado y 2 de altura; 5 s más tarde el
  //     contador iba en 7 y 7. El huérfano sigue vivo y a 2 req/s, que es el ritmo del poll.
  //   · un contador RECIÉN INSTALADO, sin nadie que lo llame, recibió 3 `getSignatureStatuses` y 3
  //     `getBlockHeight` en 3 s. O sea que la contaminación es real y no teórica.
  //
  // POR QUÉ IGUAL NO INVALIDA NADA: en los tres, la aserción que prueba el mecanismo es de VALOR
  // ("confirmed" vs "pending"), y ésa el huérfano no la toca. Los contadores están como refuerzo del
  // "siguió preguntando", y su piso es `>= 2`: un huérfano sólo puede EMPUJARLOS PARA ARRIBA, así que
  // puede volver vacua una aserción de piso, nunca darla vuelta.
  //
  // FUGA A LA RED REAL: hoy no hay, pero lo que la sostiene NO es un diseño, así que no se puede citar
  // como garantía. MEDIDO envolviendo el `getSignatureStatuses` REAL y contando quién llega hasta él:
  // en una corrida normal del archivo, CERO. Lo que lo sostiene es que siempre hay un doble instalado
  // cuando el huérfano pollea, y que el proceso termina antes del poll que sigue al último test. Se
  // cae con un cambio concreto: el `afterEach`, `:274` restaura los métodos reales
  // (`vi.restoreAllMocks`, `:276`) y borra el accessor de altura (`Reflect.deleteProperty`, `:278`),
  // así que alcanza con que algo mantenga el proceso vivo un segundo más. MEDIDO agregando 3,5 s de
  // espera al final del archivo: el huérfano alcanzó el método REAL 3 veces, contra
  // `https://api.devnet.solana.com` (el `clusterApiUrl("devnet")` que sale cuando
  // `NEXT_PUBLIC_SOLANA_RPC_URL` no está, que es el caso en los tests).
  //
  // EL ARREGLO SI ALGÚN DÍA MOLESTA, con su medición, porque el atajo obvio NO funciona: contar "en el
  // doble y por instalación" (que es lo que hace `mockChain`, `:184`) NO alcanza, y es lo que dan los
  // 3 y 3 de arriba, porque el huérfano encuentra el doble NUEVO. `mockChain` resuelve otro problema:
  // que los `calls` del spy se acumulen entre re-instalaciones DENTRO de un mismo test. Para el
  // huérfano hay que discriminar POR INSTANCIA de `Connection`: medido, el huérfano llama siempre con
  // la conexión de SU test (1 sola instancia distinta, y no es la que se construye después), así que un
  // doble escrito como `function (this: Connection)` que sólo cuente cuando `this` es la conexión del
  // test en curso deja el contador limpio. No se hizo porque las aserciones de valor ya alcanzan.
  //
  // ── T-353-6 · un RPC caído JAMÁS produce un vencimiento ──────────────────────────────────────────
  it("T-353-6: `getBlockHeight` TIRA siempre ⇒ nunca se declara vencido; se agota el techo y cae a la sonda", async () => {
    // 🔴 La regla del repo, en su forma más pura: "no pude preguntar" NO es "no pasó". Si un fallo de
    // red se tradujera a "venció", un endpoint con hipo produciría un vencimiento FALSO sobre la plata
    // de una persona. La prueba de que NO se declaró vencido es TEMPORAL: el vencimiento se concluye
    // rápido (T-353-4 tarda < 1 s), y acá tiene que agotar el techo entero.
    mockChain({
      [escrowStatePdaOf("rem-6").toBase58()]: [
        await encodeEscrowState("deposited"),
        await encodeEscrowState("deposited"), // sigue Deposited ⇒ "pending", ni éxito ni fracaso
      ],
    });
    mockStatuses(null);
    const alturas = mockBlockHeight(async () => {
      throw new Error("rpc_down");
    });
    const adapter = await conectado();

    await expect(adapter.refundEscrow("rem-6")).resolves.toEqual({
      refundTx: FIRMA_VALIDA,
      confirmation: "pending",
    });
    // 🔴 LA ASERCIÓN QUE DISCRIMINA ES ÉSTA, Y ES UN CONTADOR, NO EL RELOJ. Si el `catch` tradujera el
    // fallo a "venció", el bucle concluiría en la PRIMERA vuelta: una sola pregunta de altura y a la
    // sonda. Que haya preguntado VARIAS veces es la prueba de que siguió esperando, o sea de que no
    // concluyó nada. Esto no depende de cuántos workers compiten ni de si la máquina tuvo un hipo.
    //
    // ⚠️ La primera versión de este test medía el RELOJ (`elapsed >= TECHO_MS - 200`) y una corrida
    // del archivo completo devolvió 997 ms sin que se pudiera reproducir después, ni sola, ni con el
    // test de antes, ni con el de después. Un candado del money-path que a veces dice otra cosa es
    // peor que no tenerlo: se cambió por el mecanismo, que es lo que la regla afirma de verdad.
    expect(alturas.llamadas).toBeGreaterThanOrEqual(2);
  }, 20_000);

  // ── T-353-6b · la MISMA regla, en el OTRO RPC: un `getSignatureStatuses` que tira no concluye nada ─
  it("T-353-6b: el primer poll TIRA y el segundo trae el status ⇒ 'confirmed' (el fallo no aborta la espera)", async () => {
    // §3 tiene dos mitades y T-353-6 sólo mide la de la altura. Ésta es la otra: si el `try` de
    // `leerEstado` no estuviera, ese throw se propagaría fuera del bucle, lo atraparía el `catch` de
    // `confirmRefund` y el resultado sería "pending" — o sea que un hipo de UN poll enterraría la
    // confirmación entera. Con el `catch`, el bucle sigue y el segundo poll contesta.
    //
    // La sonda queda en Deposited a propósito: si el bucle abortara, el resultado sería "pending", así
    // que el "confirmed" sólo puede venir del segundo poll.
    mockChain({ [escrowStatePdaOf("rem-6b").toBase58()]: await encodeEscrowState("deposited") });
    const statusSpy = mockStatuses("throw", { err: null, nivel: "confirmed" });
    mockBlockHeight(async () => BLOQUE_VIGENTE);
    const adapter = await conectado();

    await expect(adapter.refundEscrow("rem-6b")).resolves.toEqual({
      refundTx: FIRMA_VALIDA,
      confirmation: "confirmed",
    });
    expect(statusSpy.mock.calls.length).toBeGreaterThanOrEqual(2); // preguntó de nuevo, no se rindió
  }, 20_000);

  // ── T-353-7 · el commitment gate: "processed" NO alcanza ─────────────────────────────────────────
  it("T-353-7: `confirmationStatus` en 'processed' en todos los polls ⇒ NO concluye; agota el techo y va a la sonda", async () => {
    // Los dos llamadores confirman con "confirmed" y eso no se toca. Aceptar "processed" sería
    // afirmar que la plata volvió sobre un nivel que todavía puede irse en un fork.
    mockChain({
      [escrowStatePdaOf("rem-7").toBase58()]: [
        await encodeEscrowState("deposited"),
        await encodeEscrowState("deposited"),
      ],
    });
    const statusSpy = mockStatuses({ err: null, nivel: "processed" });
    mockBlockHeight(async () => BLOQUE_VIGENTE); // nunca vence: el único corte es el techo
    const adapter = await conectado();

    await expect(adapter.refundEscrow("rem-7")).resolves.toEqual({
      refundTx: FIRMA_VALIDA,
      confirmation: "pending",
    });
    // La aserción que discrimina, por la MISMA razón que en T-353-6: un contador, no el reloj. Si
    // "processed" contara como confirmado, el bucle cortaría en la PRIMERA lectura y el resultado
    // sería "confirmed". Las dos cosas juntas —siguió preguntando Y no afirmó nada— son lo que este
    // test tiene que decir.
    expect(statusSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  // ── T-353-8 · la sonda corre en los caminos que no son `landed` sin error ────────────────────────
  it("T-353-8: en `expired`, `unseen` y en el revert, la sonda on-chain SE LLAMA (2 lecturas, no 1)", async () => {
    // La primera lectura es el guard pre-firma; la SEGUNDA es la sonda. Un mutante que se saltee la
    // sonda deja el contador en 1. El caso `landed` sin error queda afuera a propósito: ahí
    // `confirmRefund` retorna temprano y NO sondea, que es su comportamiento de siempre (y el que
    // `confirmClose` NO comparte — su divergencia 1 la mide `solana-wallet.close.test.ts`).
    const casos = [
      { nombre: "expired", polls: [null] as Poll[], altura: async () => BLOQUE_VENCIDO },
      { nombre: "unseen", polls: [null] as Poll[], altura: async () => BLOQUE_VIGENTE },
      {
        nombre: "revert",
        polls: [{ err: "AccountNotFound", nivel: "confirmed" }] as Poll[],
        altura: async () => BLOQUE_VIGENTE,
      },
    ];
    for (const caso of casos) {
      const pda = escrowStatePdaOf(`rem-8-${caso.nombre}`).toBase58();
      const lecturas = mockChain({
        [pda]: [await encodeEscrowState("deposited"), await encodeEscrowState("refunded")],
      });
      mockStatuses(...caso.polls);
      mockBlockHeight(caso.altura);
      const adapter = await conectado();

      // Con la sonda en Refunded los tres desenlazan igual: la fuente autoritativa manda.
      await expect(adapter.refundEscrow(`rem-8-${caso.nombre}`)).resolves.toEqual({
        refundTx: FIRMA_VALIDA,
        confirmation: "confirmed",
      });
      expect(lecturas.lecturas, `caso ${caso.nombre}`).toBeGreaterThanOrEqual(2);
    }
  }, 20_000);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-353-9 · barrido del repo: la reintroducción por CUALQUIER vía
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Los ocho tests de arriba miden el comportamiento de UN camino. Éste mide que no aparezca un camino
// nuevo. Es el único que se pone rojo si mañana alguien agrega otro `confirmTransaction` en otro
// archivo de producción.
//
// ⚠️ LO QUE NO CUBRE, declarado: mira TEXTO, no semántica. Una llamada escrita como
// `conn["confirm" + "Transaction"]()` lo pasa. No es una defensa contra alguien que quiera evadirlo:
// es una defensa contra el olvido.
describe("T-353-9 — `confirmTransaction` no vuelve a producción, y el adapter no nombra `onSignature`", () => {
  const ROOT = process.cwd();
  const SKIP = new Set(["node_modules", ".next", "doc", "migrations"]);

  function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!SKIP.has(entry)) walk(full, out);
      } else if ([".ts", ".tsx"].includes(path.extname(entry))) {
        out.push(full);
      }
    }
    return out;
  }

  function esComentario(linea: string): boolean {
    const t = linea.trimStart();
    return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
  }

  const FUENTES = walk(path.join(ROOT, "src")).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

  it("el barrido no está vacío (si `src/` no se lee, este candado no candea nada)", () => {
    expect(FUENTES.length).toBeGreaterThanOrEqual(50);
  });

  it("ningún archivo de producción de `src/` LLAMA a `confirmTransaction` (comentarios aparte)", () => {
    const hallazgos: string[] = [];
    for (const abs of FUENTES) {
      readFileSync(abs, "utf8")
        .split("\n")
        .forEach((l, i) => {
          if (!esComentario(l) && l.includes("confirmTransaction")) {
            hallazgos.push(`${path.relative(ROOT, abs)}:${i + 1} → ${l.trim().slice(0, 80)}`);
          }
        });
    }
    expect(hallazgos).toEqual([]);
  });

  it("`solana-wallet.ts` no nombra ningún `onSignature*` ni `removeSignatureListener` en líneas de CÓDIGO", () => {
    // Los comentarios se EXCLUYEN a propósito (el `.filter` de abajo): el docblock del helper explica
    // por qué NO se usa la suscripción, así que nombra `onSignature` una vez y eso es correcto. Lo que
    // se candea es que no aparezca en ninguna línea de CÓDIGO. La prueba de que el nombre no está en
    // el código, y no sólo de que no está el efecto, es lo que separa este candado del de comportamiento.
    const src = readFileSync(path.join(ROOT, "src/infrastructure/solana-wallet.ts"), "utf8").split("\n");
    const enCodigo = src
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => !esComentario(l))
      .filter(({ l }) => /onSignature|removeSignatureListener/.test(l))
      .map(({ l, n }) => `solana-wallet.ts:${n} → ${l.trim().slice(0, 80)}`);
    expect(enCodigo).toEqual([]);
  });
});
