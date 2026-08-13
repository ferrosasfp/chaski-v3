// Tests — SolanaWalletAdapter.readEscrowStates (WKH-349). La segunda capa de conocimiento del
// historial: qué contestó LA CADENA sobre la PDA `escrow_state` de cada envío que el snapshot local
// no puede afirmar.
//
// ⚠️ El doble de cadena mapea POR PUBKEY, copiado de `solana-wallet.closeable.test.ts:63-72`. Un doble
// ORDENADO le daría a cada PDA la respuesta de otra y estos tests pasarían con las respuestas
// cruzadas, sin probar que el mapeo lee el estado de la fila que dice leer. Es lo que mata T-A3.
//
// Cada `it` nombra, en su cuerpo, la edición plausible que lo pone en rojo. Un test que no puede
// nombrar su mutante no es un candado.
import { sha256 } from "@noble/hashes/sha256";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemittanceIdLookup, SolanaRemittanceIdResolver } from "../application/ports";
import { SolanaWalletAdapter } from "./solana-wallet";
import { ESCROW_STATE_BATCH_CEILING } from "./escrow-history-limits";
import { escrowIdl } from "./solana/escrow-idl";
import { solanaWalletBridge } from "./solana-wallet-bridge";

const ESCROW_PROGRAM_ID = "DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x";
const MINT_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PROGRAM_ID = new PublicKey(ESCROW_PROGRAM_ID);

const SENDER_KP = Keypair.generate();
const SENDER_B58 = SENDER_KP.publicKey.toBase58();
/** Otra billetera, para separar "el sender del argumento" de "el que quedó cacheado en connect()". */
const OTRO_KP = Keypair.generate();
const OTRO_B58 = OTRO_KP.publicKey.toBase58();

function remittanceIdBytes16(remittanceId: string): Uint8Array {
  return Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
}

function pdaOf(remittanceId: string, sender: PublicKey = SENDER_KP.publicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), sender.toBuffer(), Buffer.from(remittanceIdBytes16(remittanceId))],
    PROGRAM_ID,
  )[0];
}

/** Una hora ANTES de ahora: la ventana de release ya venció y la única salida es el refund. */
const vencido = (): number => Math.floor(Date.now() / 1000) - 3600;
/** Una hora DESPUÉS de ahora: la ventana sigue abierta. */
const vigente = (): number => Math.floor(Date.now() / 1000) + 3600;

// El `deadline` es un parámetro REQUERIDO y no un default a propósito (WKH-349 · W4.5): cuando estaba
// clavado en `now - 3600`, TODAS las fixtures de este archivo estaban vencidas y ninguna lo decía.
// Requerido hace que `tsc` enumere cada call site en vez de que cada uno se decida solo y en silencio.
async function encodeEscrowState(
  status: "deposited" | "released" | "refunded",
  deadlineSec: number,
): Promise<Buffer> {
  const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
  return coder.encode("EscrowState", {
    sender: SENDER_KP.publicKey,
    beneficiary: Keypair.generate().publicKey,
    authority: Keypair.generate().publicKey,
    mint: new PublicKey(MINT_B58),
    amount: new anchor.BN(1_000_000),
    deadline: new anchor.BN(deadlineSec),
    status:
      status === "deposited"
        ? { Deposited: {} }
        : status === "released"
          ? { Released: {} }
          : { Refunded: {} },
    bump: 255,
  });
}

function accountInfo(data: Buffer) {
  return { data, executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0 };
}

/** Las llamadas al batch, con sus pubkeys: es lo que miden T-A1 y T-A8. */
type Llamada = { keys: string[] };

/** El batch mapeado POR PUBKEY: cada PDA responde SU propio estado, o null si no existe. */
function mockBatch(byPda: Map<string, Buffer>): Llamada[] {
  const llamadas: Llamada[] = [];
  vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockImplementation((async (
    keys: PublicKey[],
  ) => {
    llamadas.push({ keys: keys.map((k) => k.toBase58()) });
    return keys.map((k) => {
      const d = byPda.get(k.toBase58());
      return d ? accountInfo(d) : null;
    });
  }) as never);
  return llamadas;
}

/** Un adapter con `connect()` YA CORRIDO, así que tiene una address cacheada. Sin eso, el mutante de
 *  T-A9 (derivar con `this.getAddress()`) no tendría nada que cachear y sobreviviría por accidente. */
async function conectadoCon(address: string, resolver?: SolanaRemittanceIdResolver) {
  solanaWalletBridge.setState({ publicKey: address, connected: true });
  const adapter = new SolanaWalletAdapter(resolver);
  await adapter.connect();
  return adapter;
}

afterEach(() => {
  solanaWalletBridge.reset();
  vi.restoreAllMocks();
  // T-A12 congela `Date` (y SÓLO `Date`). Devolver el reloj acá y no dentro del test es lo que hace
  // que un test caído a mitad no le deje el reloj congelado al siguiente ni a otro archivo.
  vi.useRealTimers();
});

describe("SolanaWalletAdapter.readEscrowStates (WKH-349)", () => {
  // T-A1 (AC-1) — MUTANTE: `for (const id of ids) await conn.getMultipleAccountsInfo([pda])`, o sea
  // una llamada por fila. Abrir el historial pasaría de 1 request a N.
  it("T-A1: 13 ids ⇒ UNA sola llamada al batch, con las 13 pubkeys adentro", async () => {
    const ids = Array.from({ length: 13 }, (_, i) => `rem-${i}`);
    const llamadas = mockBatch(new Map([[pdaOf("rem-0").toBase58(), await encodeEscrowState("deposited", vigente())]]));
    const adapter = await conectadoCon(SENDER_B58);

    const map = await adapter.readEscrowStates({ sender: SENDER_B58, remittanceIds: ids });

    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]?.keys).toHaveLength(13);
    expect(llamadas[0]?.keys).toEqual(ids.map((id) => pdaOf(id).toBase58()));
    expect(map.get("rem-0")).toBe("deposited-window-open");
  });

  // T-A2 (AC-1, CD-15) — MUTANTE: cualquier implementación que "reuse" `resolveRemittanceIdFromLedger`
  // o `listCloseable`. Los dos arrancan con `resolver.lookupBySender`, que es PoP-autenticado: abrir
  // "Ver mis envíos" abriría un diálogo de firma. Acá el resolver está INYECTADO y no se lo toca.
  it("T-A2: con un resolver inyectado, NO se lo consulta ni una vez (cero firmas al abrir el historial)", async () => {
    const lookupBySender = vi.fn(
      async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ["rem-x"] }),
    );
    mockBatch(new Map());
    // `lookupBySender` es el ÚNICO método del puerto (`SolanaRemittanceIdResolver`), y es justo el que
    // dispara el PoP: los dos caminos que no se reusan arrancan por él.
    const adapter = await conectadoCon(SENDER_B58, { lookupBySender });

    await adapter.readEscrowStates({ sender: SENDER_B58, remittanceIds: ["rem-1", "rem-2"] });

    expect(lookupBySender).not.toHaveBeenCalled();
  });

  // T-A3 (AC-2/3/4) — MUTANTE: leer `infos[0]` para cualquier id, o cualquier desalineación índice↔id.
  // Un doble ORDENADO daría verde con las respuestas cruzadas; el mapeo por pubkey es lo que lo mata.
  it("T-A3: Deposited / Released / Refunded llegan cada uno a SU fila", async () => {
    mockBatch(
      new Map([
        [pdaOf("rem-dep").toBase58(), await encodeEscrowState("deposited", vencido())],
        [pdaOf("rem-rel").toBase58(), await encodeEscrowState("released", vencido())],
        [pdaOf("rem-ref").toBase58(), await encodeEscrowState("refunded", vencido())],
      ]),
    );
    const adapter = await conectadoCon(SENDER_B58);

    const map = await adapter.readEscrowStates({
      sender: SENDER_B58,
      remittanceIds: ["rem-dep", "rem-rel", "rem-ref"],
    });

    expect(map.get("rem-dep")).toBe("deposited-window-closed");
    expect(map.get("rem-rel")).toBe("released");
    expect(map.get("rem-ref")).toBe("refunded");
  });

  // T-A4 (CD-2) — MUTANTE (a): `if (!acc) continue`, y la fila DESAPARECE del Map. MUTANTE (b):
  // `if (!acc) → "unknown"`, que colapsa "la cadena contestó" con "no pudimos preguntar".
  it('T-A4: una PDA sin cuenta es "absent" (la cadena CONTESTÓ), nunca "unknown" ni una fila faltante', async () => {
    mockBatch(new Map([[pdaOf("rem-viva").toBase58(), await encodeEscrowState("deposited", vigente())]]));
    const adapter = await conectadoCon(SENDER_B58);

    const map = await adapter.readEscrowStates({
      sender: SENDER_B58,
      remittanceIds: ["rem-viva", "rem-sin-cuenta"],
    });

    expect(map.get("rem-sin-cuenta")).toBe("absent");
    expect(map.has("rem-sin-cuenta")).toBe(true);
    expect(map.get("rem-viva")).toBe("deposited-window-open");
  });

  // T-A5 (AC-1, totalidad) — MUTANTE: cualquier `continue` que saltee una fila. El contrato del puerto
  // dice "una entrada por cada id pedido", y esto es lo único que lo verifica del lado del adapter.
  it("T-A5: 5 ids pedidos ⇒ 5 entradas, y las claves son EXACTAMENTE los ids pedidos", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    mockBatch(
      new Map([
        [pdaOf("a").toBase58(), await encodeEscrowState("deposited", vigente())],
        [pdaOf("c").toBase58(), Buffer.from([1, 2, 3])], // no decodifica
      ]),
    );
    const adapter = await conectadoCon(SENDER_B58);

    const map = await adapter.readEscrowStates({ sender: SENDER_B58, remittanceIds: ids });

    expect(map.size).toBe(5);
    expect([...map.keys()].sort()).toEqual([...ids].sort());
  });

  // T-A6 (AC-5) — MUTANTE (a): `catch { return new Map() }`, que pierde TODO. MUTANTE (b): un
  // try/catch GLOBAL alrededor del bucle, que pierde el chunk que sí contestó. La respuesta buena de
  // un chunk no se tira porque otro se cayó.
  it("T-A6: si el batch del 1er chunk LANZA, ese chunk es 'unknown' y el 2º conserva sus valores", async () => {
    const ids = Array.from({ length: ESCROW_STATE_BATCH_CEILING + 2 }, (_, i) => `rem-${i}`);
    const ultimo = ids[ESCROW_STATE_BATCH_CEILING] as string;
    const byPda = new Map([[pdaOf(ultimo).toBase58(), await encodeEscrowState("released", vencido())]]);
    let n = 0;
    vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockImplementation((async (
      keys: PublicKey[],
    ) => {
      n += 1;
      if (n === 1) throw new Error("rpc_down");
      return keys.map((k) => {
        const d = byPda.get(k.toBase58());
        return d ? accountInfo(d) : null;
      });
    }) as never);
    const adapter = await conectadoCon(SENDER_B58);

    const map = await adapter.readEscrowStates({ sender: SENDER_B58, remittanceIds: ids });

    expect(map.size).toBe(ids.length);
    expect(map.get("rem-0")).toBe("unknown"); // chunk caído: NO pudimos preguntar
    expect(map.get(ultimo)).toBe("released"); // chunk sano: su respuesta sigue viva
    // Y lo caído NO se disfraza de "no hay cuenta".
    expect(map.get("rem-0")).not.toBe("absent");
  });

  // T-A7 (AC-5) — MUTANTE (a): `continue` en el catch del decode, y la fila se cae del Map. MUTANTE
  // (b): sacar el try/catch del decode, y una sola cuenta deforme rompe el batch entero.
  it("T-A7: una cuenta que no decodifica deja ESA fila en 'unknown' y no toca a las demás", async () => {
    mockBatch(
      new Map([
        [pdaOf("rem-ok").toBase58(), await encodeEscrowState("deposited", vigente())],
        [pdaOf("rem-deforme").toBase58(), Buffer.from([9, 9, 9, 9])],
      ]),
    );
    const adapter = await conectadoCon(SENDER_B58);

    const map = await adapter.readEscrowStates({
      sender: SENDER_B58,
      remittanceIds: ["rem-ok", "rem-deforme"],
    });

    expect(map.get("rem-deforme")).toBe("unknown");
    expect(map.get("rem-ok")).toBe("deposited-window-open");
    expect(map.size).toBe(2);
  });

  // T-A8 (AC-1) — MUTANTE (a): mandar los 150 en UNA llamada (el RPC la rechaza y caen las 150 filas
  // a "unknown"). MUTANTE (b): truncar a `ESCROW_STATE_BATCH_CEILING` y devolver 100 entradas para 150
  // ids, o sea perder 50 filas EN SILENCIO.
  it("T-A8: 150 ids ⇒ 2 llamadas (100 + 50) y 150 entradas", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `rem-${i}`);
    const llamadas = mockBatch(new Map([[pdaOf("rem-149").toBase58(), await encodeEscrowState("refunded", vencido())]]));
    const adapter = await conectadoCon(SENDER_B58);

    const map = await adapter.readEscrowStates({ sender: SENDER_B58, remittanceIds: ids });

    expect(llamadas).toHaveLength(2);
    expect(llamadas[0]?.keys).toHaveLength(ESCROW_STATE_BATCH_CEILING);
    expect(llamadas[1]?.keys).toHaveLength(150 - ESCROW_STATE_BATCH_CEILING);
    expect(map.size).toBe(150);
    expect(map.get("rem-149")).toBe("refunded"); // la última del 2º chunk, la primera en perderse
  });

  // T-A9 (AC-7) — MUTANTE: derivar con `this.getAddress()` (el cache de `connect()`) en vez del
  // `sender` del argumento. Acá el cache es OTRO_B58 y el argumento es SENDER_B58: con el mutante, las
  // PDAs derivadas serían las de OTRO y la fila diría "absent" sobre un escrow que existe.
  it("T-A9: las PDAs se derivan del `sender` del ARGUMENTO, no de la address cacheada por connect()", async () => {
    const llamadas = mockBatch(
      new Map([[pdaOf("rem-1").toBase58(), await encodeEscrowState("deposited", vigente())]]),
    );
    const adapter = await conectadoCon(OTRO_B58); // el cache apunta a OTRA billetera

    const map = await adapter.readEscrowStates({ sender: SENDER_B58, remittanceIds: ["rem-1"] });

    expect(map.get("rem-1")).toBe("deposited-window-open");
    expect(llamadas[0]?.keys).toEqual([pdaOf("rem-1").toBase58()]);
    // El control sin el cual lo de arriba no prueba nada: las dos PDAs son DISTINTAS, así que el
    // assert de recién no puede pasar por casualidad.
    expect(pdaOf("rem-1", OTRO_KP.publicKey).toBase58()).not.toBe(pdaOf("rem-1").toBase58());
  });

  // ⏱️ T-A10 (AC-5, el techo de tiempo) espera ESCROW_STATE_BATCH_TIMEOUT_MS de RELOJ REAL (5 s) y por
  // eso lleva su propio techo de 20 s. La razón de NO usar `vi.useFakeTimers()` está medida en
  // `solana-wallet.close.test.ts:314-320`: esa versión pasaba corriendo el archivo SOLO y fallaba en la
  // suite COMPLETA ("Test timed out in 5000ms"), y subir iteraciones la habría puesto verde sin que
  // nadie supiera por qué. El techo por test del repo es el default de vitest (5 000 ms, no hay
  // `testTimeout` configurado en ningún lado), o sea que EMPATA con el techo que este test mide: sin el
  // `}, 20_000)` la carrera la decide el scheduler.
  //
  // MUTANTE: sacar el `withTimeout` y dejar el `await` pelado. ⚠️ T-A6 SIGUE VERDE con ese mutante (un
  // doble que lanza, lanza igual): hace falta la promesa que NUNCA resuelve. Es la lección escrita en
  // `solana-wallet.close.test.ts:322-323`.
  it("T-A10: un batch que NUNCA RESUELVE ⇒ vence el techo, ese chunk es 'unknown', y la promesa RESUELVE", async () => {
    vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockImplementation(
      (() => new Promise(() => {})) as never,
    );
    const adapter = await conectadoCon(SENDER_B58);

    const map = await adapter.readEscrowStates({
      sender: SENDER_B58,
      remittanceIds: ["rem-1", "rem-2"],
    });

    expect(map.get("rem-1")).toBe("unknown");
    expect(map.get("rem-2")).toBe("unknown");
    expect(map.size).toBe(2);
  }, 20_000);

  // 🔴 T-A11 (AC-10, AC-11, AC-12, CD-19) — DOS FILAS `Deposited` QUE NO DICEN LO MISMO.
  // MUTANTE (a) — el código de antes de esta amenda: mapear todo `Deposited` a un solo valor, o sea no
  // leer el `deadline`. Las dos filas darían idéntico y los dos asserts caen juntos.
  // MUTANTE (b): la comparación INVERTIDA (`nowSec < deadlineSec` ⇒ closed). Las dos respuestas se
  // cruzan y el test se pone rojo por partida doble.
  // MUTANTE (c): pedir el `deadline` con una segunda lectura. El contador del doble pasa de 1 a 2, que
  // es lo que AC-12/CD-19 prohíben: el `deadline` viaja en la MISMA cuenta que el `status`.
  it("T-A11: dos Deposited en la MISMA llamada ⇒ ventana abierta y ventana vencida, según su deadline", async () => {
    const llamadas = mockBatch(
      new Map([
        [pdaOf("rem-abierta").toBase58(), await encodeEscrowState("deposited", vigente())],
        [pdaOf("rem-vencida").toBase58(), await encodeEscrowState("deposited", vencido())],
      ]),
    );
    const adapter = await conectadoCon(SENDER_B58);

    const map = await adapter.readEscrowStates({
      sender: SENDER_B58,
      remittanceIds: ["rem-abierta", "rem-vencida"],
    });

    expect(map.get("rem-abierta")).toBe("deposited-window-open");
    expect(map.get("rem-vencida")).toBe("deposited-window-closed");
    // AC-12: el desenlace nuevo NO costó una llamada más.
    expect(llamadas).toHaveLength(1);
  });

  // 🔴 T-A12 (AC-13) — LA FRONTERA EXACTA: `nowSec === deadlineSec`.
  // Con el reloj congelado JUSTO en el `deadline`, la respuesta tiene que ser `window-closed`, porque
  // el predicado de acá es la negación exacta del guard con el que el refund de este mismo adapter
  // rechaza por deadline (`refund_before_deadline`, `solana-wallet.ts:972`): a esa altura aquél YA NO
  // rechaza, así que la pantalla no puede decir que todavía se puede liberar.
  //
  // MUTANTE: `nowSec > deadlineSec` (estricto). Cambia el resultado UN SOLO SEGUNDO de toda la línea de
  // tiempo, y T-A11 no lo ve: sus fixtures están a ±1 h. Es exactamente el desacuerdo con el refund que
  // AC-13 prohíbe.
  //
  // ⚠️ LO QUE ESTE TEST NO CUBRE: no prueba nada sobre el reloj del CLUSTER. Sólo prueba que las dos
  // expresiones de ESTE repo coinciden. Que el programa on-chain corte en el mismo instante es una
  // afirmación que este repo no midió.
  //
  // ⚠️ Se fake-ea SÓLO `Date`, nunca `setTimeout`: T-A10 necesita 5 s de reloj real y este archivo ya
  // se quemó con eso (`solana-wallet.close.test.ts:314-320`). El criterio de aceptación de este test no
  // es "pasa el archivo": es `npm test` COMPLETO en verde, con T-A10 adentro.
  it("T-A12: con el reloj congelado EXACTAMENTE en el deadline, la ventana ya está cerrada", async () => {
    const CONGELADO_MS = Date.UTC(2026, 7, 13, 12, 0, 0); // múltiplo exacto de 1000: nowSec sin resto
    const deadlineSec = CONGELADO_MS / 1000;
    const data = await encodeEscrowState("deposited", deadlineSec); // se codifica con el reloj real
    mockBatch(new Map([[pdaOf("rem-borde").toBase58(), data]]));
    const adapter = await conectadoCon(SENDER_B58);

    // Sólo `Date`: `setTimeout` queda real. El `afterEach` de este archivo devuelve el reloj aunque el
    // test se caiga a mitad, así que ningún otro test hereda el congelamiento.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CONGELADO_MS);

    // 🔴 CASO DE CONTROL (CD-11): sin esto, el test podría estar midiendo el reloj de la máquina y
    // dando verde por casualidad. Si el instrumento no congela, acá se pone rojo POR EL CONTROL.
    expect(Date.now()).toBe(CONGELADO_MS);
    expect(Math.floor(Date.now() / 1000)).toBe(deadlineSec);

    const map = await adapter.readEscrowStates({
      sender: SENDER_B58,
      remittanceIds: ["rem-borde"],
    });

    expect(map.get("rem-borde")).toBe("deposited-window-closed");
  });
});
