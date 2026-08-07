// Tests — createContainer (T2, AC-3.1).
//
// Qué se clava acá: que la wallet que arma el container es SIEMPRE el SolanaWalletAdapter (no hay
// selección posible), y que una configuración residual de settlement en el entorno —lo único que no
// se resuelve por construcción, porque vive en el panel del proveedor de hosting— hace que el
// container NO arranque (assertNoEvmResidue).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { createContainer } from "./container";

// Las envs EVM tienen que estar AUSENTES para que el container arranque (assertNoEvmResidue).
const EVM_ENVS = [
  "NEXT_PUBLIC_VM",
  "NEXT_PUBLIC_EIP3009_ENABLED",
  "NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS",
  "NEXT_PUBLIC_USDC_CONTRACT_ADDRESS",
  "NEXT_PUBLIC_CHAIN_ID",
  "NEXT_PUBLIC_REOWN_PROJECT_ID",
] as const;

beforeEach(() => {
  for (const k of EVM_ENVS) vi.stubEnv(k, undefined as unknown as string);
});
afterEach(() => {
  vi.unstubAllEnvs();
  solanaWalletBridge.reset();
});

describe("createContainer — se construye SIN leer ninguna env EVM (AC-3.1)", () => {
  it("con TODAS las envs EVM ausentes construye OK", () => {
    expect(() => createContainer()).not.toThrow();
  });

  it("el flag de value-delivery sigue funcionando (a2a) sin ninguna env EVM", () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    expect(() => createContainer()).not.toThrow();
  });

  // El ternario `solanaWallet ?? pickWallet()` era el punto donde una wallet EVM podía entrar. Ya no
  // hay ternario: la wallet es SIEMPRE el SolanaWalletAdapter, sin importar la configuración.
  it("AC-3.1: la wallet es SIEMPRE el SolanaWalletAdapter (no hay ternario que pueda elegir otra)", () => {
    const c = createContainer();
    const wallet = (c.connectWallet as unknown as { wallet: unknown }).wallet;
    expect(wallet).toBeInstanceOf(SolanaWalletAdapter);
  });

  it("AC-3.1: y lo sigue siendo con el adapter de value-delivery en 'fallback' (el gate no es ese flag)", () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "fallback");
    const c = createContainer();
    expect((c.connectWallet as unknown as { wallet: unknown }).wallet).toBeInstanceOf(
      SolanaWalletAdapter,
    );
  });

  // T2 — `pickWallet` no es "una función que no se llama": el MÓDULO no existe.
  it("AC-3.1: el módulo de la wallet EVM no existe en el árbol (pickWallet no es importable)", () => {
    expect(existsSync(path.resolve(process.cwd(), "src/infrastructure/wallet.ts"))).toBe(false);
  });
});

describe("createContainer — assertNoEvmResidue es la PRIMERA línea (AC-3.3)", () => {
  // Va antes de cualquier `new`: un deploy con config EVM huérfana no arranca, en vez de arrancar
  // a medias con la mitad del grafo construido.
  it("una env EVM residual ⇒ el container NO se construye, y el error la nombra", () => {
    vi.stubEnv("NEXT_PUBLIC_VM", "solana");
    expect(() => createContainer()).toThrow("evm_config_residue");
    expect(() => createContainer()).toThrow("NEXT_PUBLIC_VM");
  });

  it("también con NEXT_PUBLIC_EIP3009_ENABLED: su sola presencia BLOQUEA el arranque", () => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    expect(() => createContainer()).toThrow("evm_config_residue");
  });
});

describe("createContainer — money-path Solana (HU-SOL-13)", () => {
  it("flag Solana OFF ⇒ ConfirmAndSend NO recibe `solana` (y su tapón DT-8 falla fail-closed)", () => {
    const c = createContainer();
    const solana = (c.confirmAndSend as unknown as { solana?: unknown }).solana;
    expect(solana).toBeUndefined();
  });

  it("flag Solana ON sin mint configurado ⇒ throw fail-loud en construcción (la app NO arranca)", () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_USDC_MINT", "");
    expect(() => createContainer()).toThrow("solana_usdc_mint_not_configured");
  });

  it("flag Solana ON con mint pero sin facilitator ⇒ throw fail-loud en construcción", () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_USDC_MINT", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY", "");
    expect(() => createContainer()).toThrow("solana_facilitator_not_configured");
  });

  it("flag Solana ON con todo configurado ⇒ ConfirmAndSend recibe prepare+gateway ACOPLADOS", () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_USDC_MINT", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    vi.stubEnv(
      "NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    const c = createContainer();
    const solana = (c.confirmAndSend as unknown as {
      solana?: { prepare?: unknown; gateway?: unknown };
    }).solana;
    // Los dos JUNTOS o ninguno: un `prepare` suelto que quede undefined saltearía el binding en silencio.
    expect(solana?.prepare).toBeDefined();
    expect(solana?.gateway).toBeDefined();
  });

  // HU-SOL-20/AC-2: el SolanaWalletAdapter se construye CON su resolver de remittanceId. El wiring tiene un
  // ciclo aparente (adapter → resolver → PopSigner → wallet=adapter) que se rompe difiriendo el
  // PopSigner; esto lo ejercita END-TO-END en el container real. Si el diferido estuviera mal
  // (TDZ / instancia a medio construir), acá saldría un ReferenceError, no un escrow_not_found.
  it("HU-SOL-20: el resolver de remittanceId queda cableado sin ciclo — el refund sin id pide el PoP", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ error: "pop_not_configured" }, { status: 501 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const c = createContainer();
      const gw = c.solanaRefund as unknown as {
        refund(i: { remittanceId?: string; sender: string }): Promise<{ refundTx: string }>;
      };
      expect(gw).toBeDefined();
      // 501 ⇒ prove() null ⇒ el resolver contesta `not_asked/pop_disabled` ⇒ el refund lo propaga con
      // el motivo pegado (nunca un crash de wiring). El desenlace cambió en WKH-331: antes ese mismo
      // 501 se colapsaba a una lista vacía y salía `escrow_not_found`, o sea que el cableado que este
      // test verifica terminaba en la frase que afirma haber mirado envíos que nadie pidió.
      await expect(
        gw.refund({ sender: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
      ).rejects.toThrow("escrow_recovery_unavailable:pop_disabled");
      // Prueba de que el PopSigner diferido SE construyó con el propio adapter y corrió.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/a2a/payout/challenge");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * WKH-327/AC-7 — EL CABLEADO del guard del cierre (2º fix-pack, AR/MNR-5).
 *
 * 🔴 POR QUÉ ESTE DESCRIBE EXISTE. El fix del guard tautológico sacó la dirección conectada del
 * argumento y la puso detrás de un puerto, y eso cierra la forma equivocada DESDE EL LLAMADOR. Lo que
 * no cierra es el cableado: `ConnectedWalletProbe` tiene un solo método, así que cualquier objeto
 * literal lo satisface, y el que devuelve el CACHE (`wallet.getAddress()`) reintroduce el bloqueante
 * entero acá, en una línea. Se midió: con esa línea puesta, la suite entera daba 1297/1297 y `tsc`
 * exit 0. El test de AC-7 que sí lo mataría construye el use-case a mano, así que no toca esta línea.
 *
 * Acá el objeto bajo prueba es el `closeEscrowAccounts` QUE DEVUELVE `createContainer()`, no uno
 * construido por el test. Y las dos direcciones salen del `solanaWalletBridge` real, del mismo modo en
 * que divergen de verdad: cambiando de cuenta en la wallet sin recargar la página.
 */
describe("createContainer — WKH-327/AC-7: el cierre pregunta por la billetera VIVA, no por el cache", () => {
  const A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const B = "8tJVcM2JmYcMNCcNFYtUpXVWvKNTfnrCEwLuTRHpF9dQ";

  /** Deja el container con `connect()` YA CORRIDO con A: sin eso no hay cache que exponga la
   *  diferencia, y el mutante del cache sobreviviría por no tener nada que cachear. */
  function containerConectadoCon(address: string) {
    // Un puerto cerrado en loopback: si el guard dejara pasar, el gateway se cae al instante y en
    // local. CERO I/O fuera de la máquina (CD-11) y ninguna firma posible: el bridge no tiene handle.
    vi.stubEnv("NEXT_PUBLIC_SOLANA_RPC_URL", "http://127.0.0.1:1/");
    solanaWalletBridge.setState({ publicKey: address, connected: true });
    const c = createContainer();
    const wallet = (c.connectWallet as unknown as { wallet: SolanaWalletAdapter }).wallet;
    return { c, wallet };
  }

  it("busco con A, cambio a B en la wallet, y el cierre del container lo VE (close_not_sender)", async () => {
    const { c, wallet } = containerConectadoCon(A);
    await wallet.connect(); // recorre el cache de connect(), igual que producción

    // La persona cambia de cuenta en Phantom. `sender` sigue congelado en A (es de quién pagó).
    solanaWalletBridge.setState({ publicKey: B, connected: true });

    await expect(
      c.closeEscrowAccounts?.execute({ remittanceId: "rem-x", sender: A }),
    ).rejects.toThrow("close_not_sender");
  });

  // 🔴 EL CONTROL SIN EL CUAL EL DE ARRIBA NO PRUEBA NADA: si `close_not_sender` fuera el desenlace de
  // cualquier ejecución (por ejemplo, porque el probe devolviera siempre null o basura), el test de
  // arriba pasaría igual. Sin cambiar de billetera, el guard NO frena y el fallo que sale es el del
  // gateway contra el RPC muerto.
  it("CONTROL: sin cambiar de billetera el guard deja pasar, y el fallo ya no es del guard", async () => {
    const { c, wallet } = containerConectadoCon(A);
    await wallet.connect();

    let mensaje = "NO LANZÓ";
    try {
      await c.closeEscrowAccounts?.execute({ remittanceId: "rem-x", sender: A });
    } catch (e) {
      mensaje = e instanceof Error ? e.message : String(e);
    }
    expect(mensaje).not.toBe("NO LANZÓ"); // el RPC muerto tiene que hacerse notar
    expect(mensaje).not.toContain("close_not_sender");
    expect(mensaje).not.toContain("wallet_not_connected");
  });

  it("y si la wallet se DESCONECTA, el container lo ve como 'no hay nadie', no como otra billetera", async () => {
    const { c, wallet } = containerConectadoCon(A);
    await wallet.connect();

    solanaWalletBridge.setState({ publicKey: null, connected: false });

    await expect(
      c.closeEscrowAccounts?.execute({ remittanceId: "rem-x", sender: A }),
    ).rejects.toThrow("wallet_not_connected");
  });
});

// ── WKH-333/AC-20 · CD-21 — EL CABLEADO DEL VEREDICTO ────────────────────────────────────────────
//
// 🔴 POR QUÉ ESTE DESCRIBE EXISTE Y NO ALCANZA CON `connect-wallet.test.ts`. Ese archivo construye el
// use-case A MANO y le pasa un gateway. Si `container.ts` no inyectara ninguno, `ConnectWallet` sigue
// compilando (el 3er parámetro es opcional, para que el demo quede byte-idéntico) y la suite entera
// queda VERDE — mientras el relleno de la fila del veredicto no corre en ningún camino real y toda
// persona ya verificada llega a `prepare` sin fila. Es exactamente el caso que 041/MNR-5 midió: con
// el cableado roto, `tsc` daba exit 0 y los tests del use-case pasaban.
//
// Lo que se ejercita acá es el `connectWallet` QUE EL CONTAINER DEVUELVE, contra la red real.
describe("createContainer — WKH-333/AC-20: el connectWallet REAL consulta el veredicto", () => {
  it("T-CABLE-1: el `connectWallet` del container tiene un gateway de veredicto cableado", () => {
    const c = createContainer();
    const gw = (c.connectWallet as unknown as { verdictGateway?: unknown }).verdictGateway;
    expect(
      gw,
      "el container NO inyecta el gateway del veredicto: `ConnectWallet` compila igual (el " +
        "parámetro es opcional a propósito) y la suite queda verde, pero el relleno de la fila no " +
        "corre en ningún camino real ⇒ toda persona ya verificada llega a pagar sin fila y se corta",
    ).toBeDefined();
  });

  it("T-CABLE-1b: ese gateway PIDE el veredicto de verdad — no es un doble que siempre dice `not_asked`", async () => {
    // El mutante M-21 es inyectar un gateway inerte. Un `toBeDefined()` solo no lo mata: hay que
    // EJERCITARLO. Se apagan las dos redes de las que depende (el emisor del challenge y el endpoint
    // del veredicto) y se afirma que el `connectWallet` del container las TOCA.
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(String(url));
      // 501 en el emisor del challenge ⇒ `prove()` devuelve null ⇒ `pop_disabled` sin pedir nada más.
      return new Response(JSON.stringify({ error: "pop_not_configured" }), { status: 501 });
    });
    vi.stubGlobal("fetch", fetchMock);
    // La billetera del container necesita el bridge conectado; sin él, `connect()` tira antes de
    // llegar al gateway. Mismo mecanismo que usa el describe de WKH-327 más arriba.
    solanaWalletBridge.setState({
      publicKey: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      connected: true,
    });

    const c = createContainer();
    const out = await c.connectWallet.execute();

    expect(
      calls.some((u) => u.includes("/api/a2a/payout/challenge")),
      "el connectWallet del container NO pidió un challenge: el gateway cableado no consulta nada " +
        "(un doble inerte pasaría este container sin que nadie se entere)",
    ).toBe(true);
    // Y el desenlace es el honesto: el mecanismo está apagado server-side, no "no hay veredicto".
    expect(out.serverVerdict).toEqual({ outcome: "not_asked", reason: "pop_disabled" });
    vi.unstubAllGlobals();
  });
});
