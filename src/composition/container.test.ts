// Tests — createContainer (T2, AC-3.1).
//
// Qué se clava acá: que la wallet que arma el container es SIEMPRE el SolanaWalletAdapter (no hay
// selección posible), y que una configuración residual de settlement en el entorno —lo único que no
// se resuelve por construcción, porque vive en el panel del proveedor de hosting— hace que el
// container NO arranque (assertNoEvmResidue).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs"; import path from "node:path"; // WKH-337: en UNA línea para no correr (`CABLEADO`, `:129`)
import { A2aPayoutGateway, A2aQuoteGateway } from "../infrastructure/a2a/gateways";
import { FallbackPayoutGateway, FallbackQuoteGateway } from "../infrastructure/fallback/gateways";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { createContainer } from "./container";
import { VALUE_DELIVERY_ADAPTERS, type ValueDeliveryAdapter } from "./value-delivery-adapter";
import { LedgerPayoutStatusGateway } from "../infrastructure/settlement/ledger-payout-status-gateway";

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

  // 🔴 ESTE `it` SE INVIRTIÓ EN W3, NO SE BORRÓ (WKH-332). Decía `.not.toThrow()` y era el centinela
  // de que `"a2a"` —la env con la que corría producción— siguiera cableando los gateways REALES
  // mientras el carril punto a punto existía. Ese carril ya no existe, así que `"a2a"` no nombra
  // ningún camino y pasó a TIRAR. Se conserva invertido porque lo que hay que custodiar ahora es lo
  // contrario: que el valor viejo NO se reinterprete en silencio como "fallback" (los simuladores).
  it("el flag en el valor viejo ('a2a') YA NO nombra ningún carril: TIRA, no cae al mock", () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    expect(() => createContainer()).toThrow("value_delivery_adapter_invalido");
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

// T-3.2 (WKH-332 / AC-3 / CD-3) — el test que cierra el peligro.
//
// CD-17: este `describe` depende del `beforeEach` de arriba (que BORRA las envs EVM), porque sin él
// `assertNoEvmResidue` podría tirar por otro motivo y el test daría verde por la razón equivocada.
// Por eso cada `it` de acá asserta el MENSAJE `value_delivery_adapter_invalido`, no un throw pelado.
//
// Qué mide, con el input concreto: con la bandera en un valor no reconocido, `createContainer()`
// TIRA en vez de devolver un container cuyo `previewQuote` cotiza de mock. La afirmación falsable es
// la segunda mitad: si alguien cambia el `throw` de `resolveValueDeliveryAdapter` por un
// `return "fallback"` (mutante M1), estos `it` se ponen rojos.
describe("createContainer — un valor no reconocido de la bandera NUNCA cablea el mock (AC-3)", () => {
  it("un typo de una letra ('a2a-gatewayy') ⇒ el container TIRA, y el error nombra la variable", () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gatewayy");
    expect(() => createContainer()).toThrow("value_delivery_adapter_invalido");
    expect(() => createContainer()).toThrow("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER");
  });

  it("la env presente y VACÍA ('') ⇒ el container TIRA (no es una ausencia: es una key en blanco)", () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "");
    expect(() => createContainer()).toThrow("value_delivery_adapter_invalido");
  });

  // 🔴 LA MITAD QUE IMPORTA. Un `expect().toThrow()` solo no distingue "tiró" de "tiró y además no
  // dejó nada construido": lo que el bug producía era un container ENTERO y funcional, con los
  // simuladores adentro. Acá se asserta que no hay ningún container que devolver.
  it("y no devuelve NINGÚN container: no hay un previewQuote de mock del otro lado del throw", () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gatewayy");
    let construido: unknown = "no-se-asigno";
    try {
      construido = createContainer();
    } catch {
      /* esperado */
    }
    expect(construido).toBe("no-se-asigno");
  });
});

// T-3.3 (WKH-332 / AC-3 / CD-3 · AR fix-pack BLQ-ALTO-2) — QUÉ CLASE QUEDA CABLEADA POR CADA VALOR.
//
// 🔴 QUÉ AGUJERO CIERRA, MEDIDO POR EL AR. T-3.2 (arriba) prueba que un valor ILEGAL tira. No probaba
// NADA sobre los legales: el mapeo valor→clase vivía en una segunda lista escrita a mano en
// `container.ts` (`adapter === "a2a" || adapter === "a2a-gateway"`). Borrando `adapter === "a2a" ||`
// de esa expresión, la suite COMPLETA daba 1580/1580 verde y, con la env en "a2a" —la de
// producción—, el container cableaba `FallbackQuoteGateway`. O sea los simuladores, en silencio, con
// el árbol entero en verde. Un test que sólo mira el `throw` no puede ver eso.
//
// Cómo se cierra, y por qué no alcanza con "agregar tres `it`":
//   · La tabla es un `Record<ValueDeliveryAdapter, …>`, o sea EXHAUSTIVA POR TIPO. Un valor nuevo en
//     `VALUE_DELIVERY_ADAPTERS` sin fila acá es `tsc` rojo, no un test que se olvidó.
//   · Los casos se recorren desde `VALUE_DELIVERY_ADAPTERS`, no desde una lista copiada. Cuando W3
//     sacó `"a2a"` del array, este `it.each` dejó de correrlo solo y la fila de la tabla quedó como
//     error de tipo — que es exactamente el momento de máxima probabilidad de romper el invariante.
//   · Asserta la CLASE construida, no la ausencia de throw.
//
// CD-17: depende del `beforeEach` de arriba, que BORRA las envs EVM; sin él `assertNoEvmResidue`
// podría tirar y todos estos casos darían rojo por la razón equivocada.
describe("createContainer — cada valor LEGAL de la bandera cablea la clase que dice (AC-3)", () => {
  const CABLEADO: Record<
    // `payouts` admite un ctor con argumentos porque el gateway del ledger recibe wallet+pruebas+reloj;
    // `quotes` sigue siendo `new ()` sin tocar (CD-3), que es lo que documenta que ésos no llevan deps.
    ValueDeliveryAdapter,
    { quotes: new () => unknown; payouts: new (...args: never[]) => unknown }
  > = {
    "a2a-gateway": { quotes: A2aQuoteGateway, payouts: LedgerPayoutStatusGateway },
    // 🔴 ACÁ HABÍA UNA FILA `a2a` Y SE FUE EN EL MISMO COMMIT QUE EL VALOR (W3). El tipo del Record
    // es `ValueDeliveryAdapter`, así que dejarla habría sido TS2353: la tabla no puede sobrevivir al
    // valor, ni el valor a la tabla.
    fallback: { quotes: FallbackQuoteGateway, payouts: LedgerPayoutStatusGateway },
  };

  // 🔴 WKH-337 — LA COLUMNA `payouts` DICE LA MISMA CLASE EN LAS DOS FILAS, Y ESO ES EL INVARIANTE
  // NUEVO, NO UNA TABLA A MEDIO LLENAR. Antes decía `A2aPayoutGateway` / `FallbackPayoutGateway`, o sea
  // codificaba la premisa "el adapter decide el gateway de payout". Esa premisa ERA el defecto, y no se
  // refuta con un argumento sino con una medición: las dos clases viejas no tienen un solo `fetch`, no
  // usan el `payoutId` y devuelven siempre la misma constante, así que la bandera nunca discriminó nada
  // OBSERVABLE en el seguimiento. Un test que espera dos clases distintas está custodiando una
  // diferencia que no existe.
  //
  // CD-11 — «¿qué mutante dejaría de morir si lo cambio así?» contestado por escrito, assert por assert:
  //   · `payouts: A2aPayoutGateway` (fila a2a-gateway) → el mutante que mataba era "el container cablea
  //     el Fallback con la env en a2a-gateway". Con la clase única ese mutante SIGUE MURIENDO (Ledger no
  //     es Fallback) y además muere uno que ANTES NO PODÍA MATAR: M11, re-cablear `payouts` con un
  //     ternario sobre cualquier bandera — con la tabla vieja, un ternario era justamente lo que el test
  //     EXIGÍA. El assert queda MÁS fuerte, no más corto.
  //   · `payouts: FallbackPayoutGateway` (fila fallback) → idéntico razonamiento, simétrico.
  //   · La columna `quotes` NO SE TOCA (CD-3): sigue byte a byte, con las dos clases distintas, porque
  //     ahí la bandera SÍ decide y sí es observable.
  // Lo que se agrega abajo es la NEGATIVA sobre las dos clases viejas, en LOS DOS cuadrantes: "es un
  // LedgerPayoutStatusGateway" no excluiría por sí solo que alguien reintrodujera el ternario con
  // herencia.
  it.each(VALUE_DELIVERY_ADAPTERS)(
    "con la bandera en '%s' el container cablea las clases declaradas, no las del otro carril",
    (valor) => {
      vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", valor);
      const c = createContainer();
      const esperado = CABLEADO[valor];
      const quotes = (c.previewQuote as unknown as { quotes: unknown }).quotes;
      const payouts = (c.trackRemittance as unknown as { payouts: unknown }).payouts;
      expect(quotes).toBeInstanceOf(esperado.quotes);
      expect(payouts).toBeInstanceOf(esperado.payouts);
      // T-337.7 · M11: ninguna bandera puede volver a elegir un gateway de payout CIEGO.
      expect(
        payouts,
        `con la bandera en '${valor}' el seguimiento volvió a un gateway que no consulta nada: ` +
          "cualquier ternario acá deja la remesa en `payout_submitted` para siempre",
      ).not.toBeInstanceOf(A2aPayoutGateway);
      expect(payouts).not.toBeInstanceOf(FallbackPayoutGateway);
    },
  );

  // La otra mitad, y es la que mata al mutante: "es un A2aQuoteGateway" no excluye que también
  // pasara por el mock si alguien hiciera herencia. Se asserta la NEGATIVA sobre la clase del otro
  // carril, que es la afirmación que el bug volvía falsa.
  // W3 movió el valor de este `it` de `"a2a"` a `"a2a-gateway"`: es el único que queda cableando lo
  // real, y el que la env de producción usa desde el flip. El caso `"a2a"` no desapareció, cambió de
  // pregunta y vive arriba, asertando que TIRA.
  it("con la bandera en 'a2a-gateway' NO hay ningún simulador adentro del container", () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    const c = createContainer();
    expect((c.previewQuote as unknown as { quotes: unknown }).quotes).not.toBeInstanceOf(
      FallbackQuoteGateway,
    );
    expect((c.trackRemittance as unknown as { payouts: unknown }).payouts).not.toBeInstanceOf(
      FallbackPayoutGateway,
    );
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

// ── WKH-337 · T-337.1 (AC-1) — el seguimiento LEE la fuente de verdad, en las TRES configuraciones ──
//
// 🔴 QUÉ AGUJERO CIERRA, Y POR QUÉ VA SOBRE EL CONTAINER REAL. Ningún test del repo podía ver el
// defecto: los de `flow.test.tsx` usan `buildTestContainer` (WKH-339: decía "los 71" y eran 79 — un conteo a mano envejece con cualquier HU, el criterio no) (`FakePayoutGateway`,
// `../test-support/test-container.ts:87`) y los de `track-remittance.test.ts` construyen el use-case a
// mano. O sea que el ÚNICO consumidor de producción del puerto —`TrackRemittance` cableado por
// `createContainer()`— no lo ejercitaba nadie contra un `fetch`. Con las dos implementaciones viejas
// (`A2aPayoutGateway`/`FallbackPayoutGateway`) este `it` es ROJO en los tres casos: las dos devuelven
// `status:"submitted"` sin consultar nada, así que la remesa se queda en `payout_submitted` mientras la
// fuente de verdad dice `settled`.
//
// Las TRES combinaciones (CD-4): `"fallback"`, `"a2a-gateway"` y la env AUSENTE. La bandera no puede
// discriminar el seguimiento, y por eso el `it.each` no tiene una tabla de clases esperadas: la
// afirmación es la MISMA para los tres.
//
// La prueba de posesión se OBSERVA, no se pide: el gesto es `connectWallet.execute()` —uno de los
// call-sites de `prove()` que ya existen— y el gateway de tracking sólo LEE lo que ese gesto produjo.
// ⛔ Por eso no hay ninguna llamada a `prove()` acá: si el tracking pudiera pedir una firma, pediría un
// popup cada 1,5 s (`}, 1500);`, `../presentation/flow.tsx:632`).
describe("createContainer — el seguimiento del payout lee el ledger (WKH-337/AC-1)", () => {
  const SENDER = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

  /** Una remesa en `payout_submitted` DENTRO del repo que el container construyó — no en uno propio:
   *  lo que se prueba es el cableado, y un repo inyectado a mano no lo tocaría.
   *
   *  🔴 LOS IMPORTS SON DINÁMICOS Y ES DELIBERADO, no una preferencia de estilo. Un `import` estático
   *  arriba desplazaría (`CABLEADO`, `:129`), que `../application/agent-rejections.test.ts:115` cita por
   *  número de línea — y ese archivo está fuera del Scope IN de esta HU. Medido: con los 5 imports
   *  arriba, `citas-ancladas.test.ts` se puso rojo por esa cita. ⛔ No los "subas" sin re-medirla. */
  async function seedSubmitted(c: ReturnType<typeof createContainer>): Promise<string> {
    const { Money } = await import("../domain/money");
    const { Remittance } = await import("../domain/remittance");
    const { QUOTE_EXPIRES, T0, beneficiary } = await import("../test-support/fakes");
    const repo = (c.trackRemittance as unknown as { repo: { save(r: unknown): Promise<void> } }).repo;
    const r = Remittance.create("rem-337", beneficiary(), Money.of(400, "USDC"), T0);
    r.attachQuote(
      {
        quoteId: "q-337",
        send: Money.of(400, "USDC"),
        receive: Money.of(1480, "PEN"),
        feeUsd: Money.of(0.5, "USDC"),
        rate: 3.7,
        etaMinutes: 30,
        expiresAt: QUOTE_EXPIRES,
        provenance: "fake",
      },
      T0,
    );
    r.startKyc(T0, SENDER);
    r.applyKyc(
      {
        verificationId: "v-337",
        approved: true,
        payoutAllowed: true,
        riskLevel: "low",
        provenance: "didit",
        identity: null,
      },
      T0,
    );
    r.confirm(T0);
    r.markPrincipalIn("prin-337", T0);
    r.markPayoutSubmitted("payout-337", T0);
    await repo.save(r);
    return "rem-337";
  }

  it.each([["fallback"], ["a2a-gateway"], [undefined]])(
    "con NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=%s: el ledger dice `settled` ⇒ la remesa QUEDA en `settled`",
    async (valor) => {
      vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", valor as unknown as string);
      const urls: string[] = [];
      const fetchMock = vi.fn(async (url: string) => {
        urls.push(String(url));
        if (String(url).includes("/api/a2a/payout/challenge")) {
          // El challenge NO se verifica de este lado: lo emite y lo comprueba el server. Acá sólo
          // tiene que existir, para que el gesto produzca una prueba OBSERVABLE.
          return Response.json({ popChallenge: "ch-337", popMessage: "msg-337" }, { status: 200 });
        }
        if (String(url).includes("/api/payout/status")) {
          return Response.json(
            { payout: { outcome: "known", status: "settled", provenance: "transfi" } },
            { status: 200 },
          );
        }
        return Response.json({ verdict: null, reason: "absent" }, { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      // La billetera del container necesita el bridge conectado Y su `signMessage` registrado: sin el
      // segundo, `prove()` tira y el gesto no deja ninguna prueba que observar.
      solanaWalletBridge.setState({ publicKey: SENDER, connected: true });
      solanaWalletBridge.registerSignMessage(async () => new Uint8Array(64).fill(3));
      try {
        const c = createContainer();
        const id = await seedSubmitted(c);
        // EL GESTO. Cuelga de una acción de la persona (conectar), como los otros tres call-sites.
        await c.connectWallet.execute();
        const out = await c.trackRemittance.execute({ remittanceId: id });

        expect(
          urls.some((u) => u.includes("/api/payout/status")),
          "el seguimiento NO le preguntó a nadie por el desenlace del payout: el gateway cableado " +
            "devuelve una constante sin consultar el ledger, así que la remesa no puede salir de " +
            "`payout_submitted` en NINGUNA configuración",
        ).toBe(true);
        expect(
          out.status,
          "el ledger (la fuente de verdad, alimentada por el webhook real) dice `settled` y la remesa " +
            "sigue en `payout_submitted`: la persona ve 'Pago en curso' para siempre",
        ).toBe("settled");
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});

// ── WKH-339 · T-339.5 (AC-3 + AC-5) — EL TEST DE CABLEADO DE LA VENTANA DE LECTURA ──────────────────
//
// 🔴 ES EL ÚNICO TEST DEL REPO QUE VE DOS MUTANTES, Y LOS DOS COMPILAN. Por eso no alcanza con probar
// los dos campos por separado ni con un `toBeDefined()`:
//
//  · M4 — `renovarVentana: new HttpPopSigner(wallet)`, SIN el 2º argumento. El recorder es OPCIONAL
//    (`constructor`, `../infrastructure/auth/http-pop-signer.ts:14`), así que `tsc` da exit 0, la ruta
//    del challenge se llama, el popup se abre, la persona firma… y NADIE graba nada. La ventana queda
//    en `"sin-prueba"` para siempre: el botón nunca desaparece y cada toque quema un challenge del cupo.
//  · M5 — la ventana se arma sobre un `new InMemoryPopProofStore(clock)` PROPIO en vez del que observa
//    el gateway de seguimiento (`payouts`, `./container.ts:127`). También compila, también deja
//    `estado()` en `"sin-prueba"` para siempre, y encima el gesto SÍ graba — en el almacén equivocado.
//
// Los dos son invisibles para `tsc` (los tipos se satisfacen), invisibles para los tests de
// `flow.test.tsx` (usan `buildTestContainer`, que arma su propio par) e invisibles para
// `http-pop-signer` (su test construye la clase a mano). Lo único que los ve es ejercitar los objetos
// que `createContainer()` DEVUELVE, y afirmar que el gesto de uno cambia lo que contesta el otro.
//
// ⚠️ Lo que este test NO puede afirmar, y hay que decirlo: no verifica que el almacén sea el MISMO que
// recibe `LedgerPayoutStatusGateway`, sino que los dos campos nuevos comparten uno. Un tercer almacén
// compartido por los dos campos y ajeno al gateway pasaría este `it`. Lo que cubre ese hueco es que
// `container.ts` construye UN solo `popProofs` (`:106`) y lo pasa a los tres lugares, y que agregar un
// segundo `new InMemoryPopProofStore` en ese archivo es visible en el diff de cualquier revisión.
describe("createContainer — WKH-339: el gesto de renovar enciende la ventana que la pantalla consulta", () => {
  const SENDER = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

  it("T-339.5: `estado` arranca en `sin-prueba`, y tras `renovarVentana.prove()` pasa a `vigente`", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      // El challenge no se verifica de este lado: lo emite y lo comprueba el server. Acá sólo tiene que
      // existir, para que el gesto produzca una prueba OBSERVABLE.
      if (String(url).includes("/api/a2a/payout/challenge")) {
        return Response.json({ popChallenge: "ch-339", popMessage: "msg-339" }, { status: 200 });
      }
      return Response.json({ error: "no deberia llamarse" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    // Sin `registerSignMessage` la firma tira y el gesto no deja ninguna prueba que observar: sería un
    // rojo por el motivo equivocado.
    solanaWalletBridge.setState({ publicKey: SENDER, connected: true });
    solanaWalletBridge.registerSignMessage(async () => new Uint8Array(64).fill(3));
    try {
      const c = createContainer();

      // 1 · Arranque en frío: el almacén es en memoria y está vacío. Es el caso real de una recarga.
      expect(
        c.ventanaDeLectura.estado(SENDER),
        "la ventana arranca ENCENDIDA sin que nadie haya firmado nada: el estado no cuelga del almacén",
      ).toBe("sin-prueba");

      // 2 · EL GESTO. Es el mismo `prove()` que los otros tres call-sites, y pide la firma CADA VEZ.
      const prueba = await c.renovarVentana.prove(SENDER);
      expect(prueba, "el gesto no produjo ninguna prueba: sin esto el paso 3 no dice nada").not.toBeNull();
      expect(urls.some((u) => u.includes("/api/a2a/payout/challenge"))).toBe(true);

      // 3 · EL ASERTO QUE MATA A M4 Y A M5. El objeto que CONSULTA el estado tiene que haberse enterado
      //     de la prueba que produjo el objeto que FIRMA. Si son dos almacenes, o si el signer se armó
      //     sin recorder, esto sigue en `"sin-prueba"` y todo lo demás pasa igual.
      expect(
        c.ventanaDeLectura.estado(SENDER),
        "el gesto firmó pero la ventana sigue apagada: o `renovarVentana` se armó SIN el 2º argumento " +
          "(el recorder es opcional ⇒ compila y no graba, M4), o la ventana lee un almacén DISTINTO " +
          "del que el gesto escribe (M5). En los dos casos el botón 'Revisar ahora' no desaparece " +
          "nunca y cada toque quema un challenge del cupo de la IP",
      ).toBe("vigente");

      // 4 · Y es POR ADDRESS, no un interruptor global: la prueba de una billetera no enciende la
      //     ventana de otra. Sin esto, `estado: () => "vigente"` tras el primer gesto pasaría.
      expect(c.ventanaDeLectura.estado("OtraBilleteraQueNadieFirmo")).toBe("sin-prueba");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * WKH-349/CD-17 — EL CABLEADO del lector de estado on-chain del historial.
 *
 * 🔴 EL MUTANTE MÁS PELIGROSO DE LA HU, y no es una hipótesis: es el mismo perfil que este archivo ya
 * documenta para `renovarVentana`. `solanaEscrowStates` es OPCIONAL en `Container` —lo tiene que ser
 * para que `buildTestContainer` pueda no pasarlo—, así que borrar la línea que lo cablea deja `tsc` en
 * exit 0 y la suite entera en verde: los tests de la pantalla (`history-onchain.test.tsx`) inyectan su
 * propio doble y nunca tocan este objeto. En producción el historial no le preguntaría nada a la
 * cadena y todas las filas volverían a decir "no comprobamos si tus USDC siguen en el escrow".
 *
 * Acá el objeto bajo prueba es el que DEVUELVE `createContainer()`, no uno construido por el test: es
 * el mismo criterio que el describe de AC-7 de más arriba, y es la única forma de que este test vea la
 * línea que vigila.
 */
describe("createContainer — WKH-349/CD-17: el historial tiene a quién preguntarle", () => {
  it("T-C1: `solanaEscrowStates` está cableado, y es el MISMO adapter que el resto usa", () => {
    const c = createContainer();
    // (1) Está. Sin esto, la pantalla queda en "no se preguntó" para siempre en producción.
    expect(c.solanaEscrowStates).toBeDefined();
    // (2) Y es el adapter de Solana, no un objeto literal que satisfaga la interfaz de un método.
    expect(c.solanaEscrowStates).toBeInstanceOf(SolanaWalletAdapter);
    // (3) EL ASERTO QUE MATA AL MUTANTE FINO: es la MISMA instancia que las otras entradas cableadas
    //     al adapter. Una segunda instancia compilaría igual y hablaría con la misma cadena, pero
    //     tendría su propio cache de `connect()`, que es exactamente la clase de divergencia que este
    //     archivo ya pagó una vez con el guard del cierre.
    expect(c.solanaEscrowStates).toBe(c.solanaCloseableEscrows);
    expect(c.solanaEscrowStates).toBe(
      (c.connectWallet as unknown as { wallet: unknown }).wallet,
    );
  });
});

/**
 * WKH-354/AC-2 — EL CABLEADO de `Container.connectedWallet`.
 *
 * 🔴 POR QUÉ ESTE DESCRIBE EXISTE. Es el mismo perfil que el de WKH-327/AC-7 de más arriba, y por eso
 * reusa su montaje: `ConnectedWalletProbe` tiene UN método, así que
 * `{ getConnectedAddress: () => wallet.getAddress() }` lo satisface, compila, y devuelve el CACHE de
 * `connect()` — o sea reintroduce en una línea el bug que esta HU vino a cerrar (CD-13). Ningún test
 * que arme el probe a mano lo puede ver: el objeto bajo prueba tiene que ser el `connectedWallet` QUE
 * DEVUELVE `createContainer()`.
 *
 * Y por eso el `await wallet.connect()` de cada caso NO es ceremonia: sin él no hay cache que
 * exponer, y el mutante del cache sobreviviría por no tener nada que cachear.
 */
describe("createContainer — WKH-354/AC-2: el probe del container lee la billetera VIVA", () => {
  const A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const B = "8tJVcM2JmYcMNCcNFYtUpXVWvKNTfnrCEwLuTRHpF9dQ";

  /** Gemelo del helper del describe de WKH-327/AC-7: puerto cerrado en loopback, cero I/O fuera de la
   *  máquina, y `connect()` corrible para que exista el cache. */
  function containerConectadoCon(address: string) {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_RPC_URL", "http://127.0.0.1:1/");
    solanaWalletBridge.setState({ publicKey: address, connected: true });
    const c = createContainer();
    const wallet = (c.connectWallet as unknown as { wallet: SolanaWalletAdapter }).wallet;
    return { c, wallet };
  }

  it("T-354-CABLE-1: conecté con A, la wallet pasó a B, y el probe del container contesta B (no el cache)", async () => {
    const { c, wallet } = containerConectadoCon(A);
    await wallet.connect(); // deja el cache de connect() cargado con A, igual que producción

    solanaWalletBridge.setState({ publicKey: B, connected: true }); // Phantom cambia de cuenta

    expect(await c.connectedWallet.getConnectedAddress()).toBe(B);
    // Y la otra mitad del hecho, que es lo que hace que este test signifique algo: el cache SÍ sigue
    // diciendo A. Las dos respuestas conviven, y el container tiene que exponer la VIVA.
    expect(await wallet.getAddress()).toBe(A);
  });

  it("T-354-CABLE-2: el default del test-container es `null`, y NO deriva del cache de la wallet", async () => {
    const { buildTestContainer } = await import("../test-support/test-container");
    const { FakeSolanaWallet } = await import("../test-support/fakes");
    const wallet = new FakeSolanaWallet();
    const c = buildTestContainer({ wallet });

    // "No hay ninguna billetera conectada" — que es el estado real de un test que no montó el árbol.
    expect(await c.connectedWallet.getConnectedAddress()).toBeNull();
    // Y no es que el fake no tenga qué contestar: `getAddress()` sí devuelve una dirección. Si el
    // default fuera `{ getConnectedAddress: () => wallet.getAddress() }` (CD-13), estas dos
    // expectativas serían la misma y este test quedaría rojo.
    expect(await wallet.getAddress()).not.toBeNull();
  });

  it("T-354-CABLE-3: la wallet se DESCONECTA ⇒ el probe contesta null, no la dirección vieja", async () => {
    const { c, wallet } = containerConectadoCon(A);
    await wallet.connect();

    solanaWalletBridge.setState({ publicKey: null, connected: false });

    expect(await c.connectedWallet.getConnectedAddress()).toBeNull();
  });
});

// ── WKH-356 / CD-13 · LA RAMA DE ENLACE NO TIENE ACTIVACIÓN DE PRODUCCIÓN ────────────────────────
//
// 🔴 POR QUÉ ESTE `it` EXISTE Y POR QUÉ ES OBLIGATORIO. 062 escribe el motor de firma por enlace
// profundo entero, pero NO lo cablea: falta la ola 4 (selector de billetera + connect por enlace),
// que es la que produce el `viaje.direccion`, la `session` y la `claveBilletera` que este motor
// CONSUME y EXIGE. Sin ese cableado no hay ningún camino de producción que entre a la rama.
//
// Escribirlo en un documento no alcanza: la lección `tests-que-registran-el-doble-no-prueban-el-
// cableado` dice que si nadie MIDE el cableado, alguien va a leer "la HU está hecha" como "el flujo
// móvil anda". Esto lo mide.
// ⚠️ CD-15 · MUTANTES CORRIDOS (2026-08-17, re-medidos en el fix-pack 1), suite COMPLETA, aguja
// contada con `== 1`, relectura del disco, restauración verificada byte a byte:
//
// | mutante                                                              | exit | `it` rojos |
// |---|---|---|
// | cablear el colaborador en `container.ts` (3er argumento)              | 1 | 2 |
// | invertir el `if (this.firmaPorEnlace)` del adaptador                  | 1 | **46, NINGUNO de este archivo** |
//
// El primero mata el T-062-21 de acá + el candado de citas ancladas (la línea nueva en `container.ts`
// desplaza citas; es colateral y va dicho).
describe("createContainer — WKH-356/CD-13: la firma por enlace NO está cableada al cerrar 062", () => {
  it("T-062-21: el `SolanaWalletAdapter` del container se construye SIN colaborador de enlace", () => {
    const c = createContainer();
    const wallet = (c.confirmAndSend as unknown as { wallet?: unknown }).wallet;
    expect(wallet, "el container no cableó ninguna billetera a `ConfirmAndSend`").toBeDefined();
    const motor = (wallet as unknown as { firmaPorEnlace?: unknown }).firmaPorEnlace;
    expect(
      motor,
      "el container INYECTÓ el motor de firma por enlace. Cablearlo NO enciende el flujo móvil: " +
        "`getAddress()` sigue leyendo el bridge, que en un móvil sin extensión no tiene nada, así que " +
        "`authorizePrincipal` tira `wallet_not_connected` ANTES de llegar a la rama. Lo único que " +
        "cablearlo consigue es BORRAR LA EVIDENCIA de que está apagado. Si esto es intencional, hay " +
        "que traer la ola 4 (selector + connect por enlace) y actualizar el SDD y los dos README en " +
        "el mismo cambio.",
    ).toBeUndefined();
  });

  // ⛔ Y el candado complementario: que el colaborador ausente signifique EL CAMINO DE HOY, no un
  // camino degradado. Con `firmaPorEnlace === undefined` la rama entera vive adentro de un `if`, así
  // que `authorizePrincipal` recorre exactamente el código de antes de esta HU (CD-1).
  // 🔴 ACÁ HABÍA UNA PROMESA FALSA, Y EL CR LA MIDIÓ (CD-15 en FAIL). Decía «MUTANTE QUE MATA: invertir
  // el `if (this.firmaPorEnlace)`», y ese mutante **deja este archivo entero en verde**: 33/33. La razón
  // es de este `it` y no del mutante: `authorizePrincipal` se llama SIN `deposit`, así que muere en el
  // guard `escrow_params_missing` **antes** de llegar a la rama, y por eso invertirla no lo mueve.
  //
  // LO QUE ESE MUTANTE SÍ HACE, MEDIDO en la batería del fix-pack 1: exit=1 con **46 `it` rojos**, todos
  // en `solana-wallet.test.ts` y `solana-deposit-beneficiary.test.ts` — o sea que el candado de CD-1 es
  // la suite del adaptador, no este `it`. Y eso es información útil: significa que esos ~46 `it` SÍ
  // atraviesan este código y que el `if` es lo que los protege.
  //
  // MUTANTE QUE MATA ESTE `it` (MEDIDO: exit=1, 3 `it` rojos — éste, el `it` de CD-SDD-8 del adaptador
  // y el candado de citas por el desplazamiento): borrar el guard `escrow_params_missing` ⇒ la causa
  // deja de ser la pre-existente y el `expect` de abajo cae. O sea: lo que este `it` fija es que el
  // camino que corre sin colaborador sigue muriendo en un guard VIEJO, no en uno del vocabulario
  // `deeplink_*`.
  it("T-062-21b: y con el colaborador ausente el retorno del camino inyectado sigue siendo `listo`", async () => {
    solanaWalletBridge.setState({
      publicKey: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      connected: true,
    });
    const c = createContainer();
    const wallet = c.confirmAndSend as unknown as {
      wallet: { authorizePrincipal: (...a: unknown[]) => Promise<unknown> };
    };
    // Sin `deposit.escrow` el método tira `escrow_params_missing` en el guard fail-loud PRE-EXISTENTE
    // (`:562-563`), o sea ANTES de cualquier línea nueva. Que la causa sea ÉSA —y no una del
    // vocabulario `deeplink_*`— es la prueba de que el camino que corre es el de siempre.
    await expect(
      wallet.wallet.authorizePrincipal({ send: { minor: 1 }, expiresAt: "2099-01-01T00:00:00.000Z" }, "rem-1"),
    ).rejects.toThrow("escrow_params_missing");
  });
});
