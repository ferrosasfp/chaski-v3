// Tests — HU-079 / W0. `SolanaWalletAdapter.readOpenEscrowRent` y `.readNewDepositRent`: el alquiler
// se LEE de la cadena en vez de escribirse en el repo.
//
// 🔴 QUÉ DEFECTO CIERRAN, MEDIDO. La HU-077 escribió `ESCROW_DEPOSIT_RENT_RETURNED_LAMPORTS = 3.641.475`
// el 2026-09-03 y AL DÍA SIGUIENTE la cadena movió la tarifa en las DOS redes, sin un solo commit en el
// medio (`git log cd94bfd..HEAD` ⇒ 0). El evento que rompe el número es de CALENDARIO, no de commit, y
// por eso el arreglo no puede ser otro número: es preguntar.
//
// ⚠️ EL DOBLE DE CADENA MAPEA POR PUBKEY (CD-14), copiado de `mockBatch`
// (solana-wallet.closeable.test.ts:63-71). Un doble ordenado —"la 1ª llamada devuelve esto, la 2ª
// aquello"— le daría a cada cuenta la respuesta de otra y los tests pasarían sin probar que el adapter
// consulta las cuentas que dice consultar. Acá eso importa más que en ningún otro lado: `T-079-R2` va
// justamente sobre CUÁL pubkey se consulta.
import { sha256 } from "@noble/hashes/sha256";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ACCOUNT_SIZE, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SolanaWalletAdapter } from "./solana-wallet";
import { escrowIdl } from "./solana/escrow-idl";
import { solanaWalletBridge } from "./solana-wallet-bridge";

const PROGRAM_ID = new PublicKey((escrowIdl as { address: string }).address);

/** El mint que vive DENTRO del `EscrowState` on-chain. Es el único del que puede salir el vault. */
const MINT_ONCHAIN = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
/** Un mint DISTINTO, que ningún camino correcto puede usar. Existe sólo para `T-079-R2`: si el adapter
 *  derivara el vault de algo que no sea el `EscrowState`, caería en ESTA ATA y no en la buena. */
const MINT_AJENO = new PublicKey("So11111111111111111111111111111111111111112");

const SENDER_KP = Keypair.generate();
const SENDER_B58 = SENDER_KP.publicKey.toBase58();
const REM_ID = "rem-alquiler-079";

// 🔴 LOS DOS SALDOS DEL FIXTURE SON DISTINTOS Y NINGUNO ES LA MITAD DEL OTRO, A PROPÓSITO. Con `X + X`
// un mutante que devolviera `estado.lamports * 2` sobreviviría, y con `2X + X` sobreviviría uno que
// devolviera `estado.lamports * 1.5`. Son los saldos REALES del par
// `2eWYonV4Pjzn…` + `2S5QejufWmGD…` leídos en devnet el 2026-09-04, cuyo `close` devuelve 4.002.000.
const LAMPORTS_ESTADO = 1_962_720;
const LAMPORTS_VAULT = 2_039_280;
const SUMA_ESPERADA = 4_002_000;

function remittanceIdBytes16(remittanceId: string): Uint8Array {
  return Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
}

function pdaOf(remittanceId: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("escrow"),
      SENDER_KP.publicKey.toBuffer(),
      Buffer.from(remittanceIdBytes16(remittanceId)),
    ],
    PROGRAM_ID,
  )[0];
}

async function encodeEscrowState(mint: PublicKey): Promise<Buffer> {
  const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
  return coder.encode("EscrowState", {
    sender: SENDER_KP.publicKey,
    beneficiary: Keypair.generate().publicKey,
    authority: Keypair.generate().publicKey,
    mint,
    amount: new anchor.BN(1_000_000),
    deadline: new anchor.BN(Math.floor(Date.now() / 1000) - 3600),
    status: { Released: {} },
    bump: 255,
  });
}

function accountInfo(data: Buffer, lamports: number) {
  return { data, executable: false, lamports, owner: PROGRAM_ID, rentEpoch: 0 };
}

/** Las cuentas mapeadas POR PUBKEY, y la lista de lo que se consultó (que es lo que mide `T-079-R2`). */
function mockCuentas(por: Map<string, { data: Buffer; lamports: number }>): { pedidas: string[] } {
  const pedidas: string[] = [];
  vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation((async (k: PublicKey) => {
    pedidas.push(k.toBase58());
    const hit = por.get(k.toBase58());
    return hit ? accountInfo(hit.data, hit.lamports) : null;
  }) as never);
  return { pedidas };
}

/** El par completo y sano: el `EscrowState` con el mint on-chain, y SU ATA con su propio saldo. */
async function parSano(): Promise<Map<string, { data: Buffer; lamports: number }>> {
  const pda = pdaOf(REM_ID);
  const vault = getAssociatedTokenAddressSync(MINT_ONCHAIN, pda, true);
  return new Map([
    [pda.toBase58(), { data: await encodeEscrowState(MINT_ONCHAIN), lamports: LAMPORTS_ESTADO }],
    [vault.toBase58(), { data: Buffer.alloc(ACCOUNT_SIZE), lamports: LAMPORTS_VAULT }],
  ]);
}

async function conectado(): Promise<SolanaWalletAdapter> {
  solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
  const adapter = new SolanaWalletAdapter();
  await adapter.connect();
  return adapter;
}

afterEach(() => {
  solanaWalletBridge.reset();
  vi.restoreAllMocks();
});

describe("HU-079/W0 · readOpenEscrowRent — el saldo REAL de las dos cuentas", () => {
  it("T-079-R1: devuelve la SUMA de los lamports de EscrowState y del vault", async () => {
    mockCuentas(await parSano());
    const adapter = await conectado();

    await expect(adapter.readOpenEscrowRent({ sender: SENDER_B58, remittanceId: REM_ID })).resolves.toEqual({
      status: "known",
      lamports: SUMA_ESPERADA,
    });
    // Y que la suma sea SUMA y no otra cosa: los dos sumandos son distintos, así que ningún factor
    // aplicado a uno solo da este total. `M-R1` (devolver sólo el del EscrowState) da 1.962.720.
    expect(SUMA_ESPERADA).toBe(LAMPORTS_ESTADO + LAMPORTS_VAULT);
    expect(LAMPORTS_ESTADO).not.toBe(LAMPORTS_VAULT);
  });

  it("T-079-R2: el vault se deriva del mint ON-CHAIN, no de ningún otro", async () => {
    const pda = pdaOf(REM_ID);
    const vaultBueno = getAssociatedTokenAddressSync(MINT_ONCHAIN, pda, true);
    const vaultAjeno = getAssociatedTokenAddressSync(MINT_AJENO, pda, true);
    expect(vaultBueno.toBase58()).not.toBe(vaultAjeno.toBase58()); // control: las dos ATAs difieren

    // El mapa tiene las DOS ATAs, con saldos DISTINTOS. Un adapter que derivara del mint equivocado
    // NO se quedaría sin respuesta: obtendría un número, y sería el número de otra cuenta. Por eso el
    // fixture le da saldo al vault ajeno en vez de dejarlo ausente — si lo dejara ausente, este `it`
    // moriría por el mismo camino que `T-079-R3`(d) y sería un falso KILLED.
    const por = await parSano();
    por.set(vaultAjeno.toBase58(), { data: Buffer.alloc(ACCOUNT_SIZE), lamports: 999_999 });
    const { pedidas } = mockCuentas(por);
    const adapter = await conectado();

    const r = await adapter.readOpenEscrowRent({ sender: SENDER_B58, remittanceId: REM_ID });
    expect(r).toEqual({ status: "known", lamports: SUMA_ESPERADA }); // NO 1.962.720 + 999.999
    expect(pedidas).toEqual([pda.toBase58(), vaultBueno.toBase58()]);
    expect(pedidas).not.toContain(vaultAjeno.toBase58());
  });

  // 🔴 LOS CUATRO CAMINOS VAN EN CUATRO `it` SEPARADOS, no en uno con cuatro `expect`. Con uno solo,
  // tres podrían estar muertos —o no llegar a correr tras el primer fallo— y nadie lo vería.
  describe("T-079-R3: cualquier tropiezo contesta `unknown`, y NUNCA un número", () => {
    it("(a) el RPC tira ⇒ unknown", async () => {
      vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation((async () => {
        throw new Error("rpc_caido");
      }) as never);
      const adapter = await conectado();
      await expect(
        adapter.readOpenEscrowRent({ sender: SENDER_B58, remittanceId: REM_ID }),
      ).resolves.toEqual({ status: "unknown" });
    });

    // ⏱️ ESTE `it` ESPERA `ESCROW_INDEX_PROBE_TIMEOUT_MS` DE RELOJ REAL (5 s) Y POR ESO LLEVA SU PROPIO
    // TECHO DE 20 s. No es descuido y no es negociable: es la misma decisión ya MEDIDA en este repo
    // (`solana-wallet.close.test.ts:352-358` y `solana-wallet.history-states.test.ts:307-312`), donde la
    // versión con `vi.useFakeTimers()` pasaba corriendo el archivo SOLO y fallaba en la suite COMPLETA.
    //
    // 🔴 Y ACÁ SE MIDIÓ OTRA VEZ, con un resultado propio que vale escribir: con los relojes falsos
    // instalados, `getAccountInfo` se llamaba **CERO** veces y no quedaba **NINGÚN** timer pendiente
    // (`vi.getTimerCount()` ⇒ 0). O sea que el `it` no moría por el techo: moría sin haber llegado nunca
    // al techo, colgado en los `await import()` dinámicos del adapter, y el rojo decía "Test timed out"
    // igual que si el techo hubiera fallado. Un rojo que NO habla de lo que el test mide es el peor de
    // los verdes disfrazados. Calentar los imports con relojes reales ANTES tampoco alcanzó.
    //
    // El techo por test del repo es el default de vitest (5.000 ms, no hay `testTimeout` configurado),
    // o sea que EMPATA con el techo que este test mide: sin el `}, 20_000` la carrera la decide el
    // scheduler.
    it(
      "(b) el techo de tiempo vence ⇒ unknown",
      async () => {
        // El doble que TIRA no sirve acá: tirar ya lo cubre (a). Hace falta la promesa que NUNCA
        // resuelve, que es el RPC que acepta la conexión y no contesta. Sin `withTimeout` esto dejaría
        // a la persona esperando para siempre, y ningún otro `it` de este archivo lo notaría.
        vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation(
          (() => new Promise(() => {})) as never,
        );
        const adapter = await conectado();
        await expect(
          adapter.readOpenEscrowRent({ sender: SENDER_B58, remittanceId: REM_ID }),
        ).resolves.toEqual({ status: "unknown" });
      },
      20_000,
    );

    it("(c) el EscrowState no está ⇒ unknown", async () => {
      mockCuentas(new Map()); // ninguna cuenta existe
      const adapter = await conectado();
      await expect(
        adapter.readOpenEscrowRent({ sender: SENDER_B58, remittanceId: REM_ID }),
      ).resolves.toEqual({ status: "unknown" });
    });

    // 🔴 (d) ES EL QUE IMPORTA, y es el único que un `?? 0` sobre el vault deja pasar: devolvería
    // `{known, 1.962.720}`, o sea una cifra INCOMPLETA con cara de dato medido. Prometer de menos sin
    // que nada se ponga rojo es exactamente el modo de falla que esta HU vino a cerrar.
    it("(d) el EscrowState está pero el vault NO ⇒ unknown, jamás el saldo a medias", async () => {
      const pda = pdaOf(REM_ID);
      const soloEstado = new Map([
        [pda.toBase58(), { data: await encodeEscrowState(MINT_ONCHAIN), lamports: LAMPORTS_ESTADO }],
      ]);
      mockCuentas(soloEstado);
      const adapter = await conectado();

      const r = await adapter.readOpenEscrowRent({ sender: SENDER_B58, remittanceId: REM_ID });
      expect(r).toEqual({ status: "unknown" });
      // Y explícito, porque es la mitad del punto: no salió NINGÚN número, ni siquiera el parcial.
      expect(JSON.stringify(r)).not.toContain(String(LAMPORTS_ESTADO));
    });
  });
});

describe("HU-079/W0 · readNewDepositRent — lo que un depósito NUEVO inmoviliza HOY", () => {
  /** El doble contesta POR TAMAÑO, no por orden: pedir un tamaño que no está en la tabla no devuelve
   *  el número de otro, devuelve `null`. Son los valores REALES de devnet el 2026-09-04. */
  function mockRent(tabla: Record<number, number>): { pedidos: number[] } {
    const pedidos: number[] = [];
    vi.spyOn(Connection.prototype, "getMinimumBalanceForRentExemption").mockImplementation(
      (async (size: number) => {
        pedidos.push(size);
        return tabla[size] ?? null;
      }) as never,
    );
    return { pedidos };
  }

  const TABLA_DEVNET_2026_09_04 = { 154: 1_432_560, [ACCOUNT_SIZE]: 1_488_440, 558: 3_484_880 };

  it("T-079-R4: devuelve el par y el índice SEPARADOS, y el par usa ACCOUNT_SIZE de la librería", async () => {
    const { pedidos } = mockRent(TABLA_DEVNET_2026_09_04);
    const adapter = await conectado();

    await expect(adapter.readNewDepositRent()).resolves.toEqual({
      status: "known",
      escrowPairLamports: 2_921_000, // 1.432.560 + 1.488.440, el par de devnet HOY
      escrowIndexLamports: 3_484_880, // el EscrowIndex, que se cobra y NO vuelve con el `close`
    });
    // ⛔ El 165 NO se escribe a mano: si la librería cambia el layout, este test lo sigue solo.
    expect(pedidos).toContain(ACCOUNT_SIZE);
    expect(ACCOUNT_SIZE).toBe(165); // control positivo: hoy, con @solana/spl-token 0.4.15, vale 165
    // `M-R4` (pedir 164 en vez de ACCOUNT_SIZE) hace que el doble devuelva null y esto se ponga rojo.
    expect(pedidos.every((p) => p in TABLA_DEVNET_2026_09_04)).toBe(true);
  });

  it("T-079-R4b: los dos campos NO están pre-sumados — el índice no entra al par", async () => {
    mockRent(TABLA_DEVNET_2026_09_04);
    const adapter = await conectado();
    const r = await adapter.readNewDepositRent();
    if (r.status !== "known") throw new Error("el fixture pide una lectura exitosa");
    // Si alguien sumara el índice al par, el par valdría 6.405.880 y el `close` prometería de más algo
    // que el `close` no devuelve. Ver el docblock de `SolanaNewDepositRent`.
    expect(r.escrowPairLamports).not.toBe(r.escrowPairLamports + r.escrowIndexLamports);
    expect(r.escrowPairLamports + r.escrowIndexLamports).toBe(6_405_880);
  });

  it("T-079-R4c: un RPC que contesta dos números y un null NO contestó ⇒ unknown", async () => {
    mockRent({ 154: 1_432_560, [ACCOUNT_SIZE]: 1_488_440 }); // falta el 558
    const adapter = await conectado();
    await expect(adapter.readNewDepositRent()).resolves.toEqual({ status: "unknown" });
  });
});
