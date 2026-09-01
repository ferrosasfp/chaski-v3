// Tests — createContainer (T2, AC-3.1).
//
// Qué se clava acá: que la wallet que arma el container es SIEMPRE el SolanaWalletAdapter (no hay
// selección posible), y que una configuración residual de settlement en el entorno —lo único que no
// se resuelve por construcción, porque vive en el panel del proveedor de hosting— hace que el
// container NO arranque (assertNoEvmResidue).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs"; import path from "node:path"; // WKH-337: en UNA línea para no correr (`CABLEADO`, `:135`)
import { A2aPayoutGateway, A2aQuoteGateway } from "../infrastructure/a2a/gateways";
import { FallbackPayoutGateway, FallbackQuoteGateway } from "../infrastructure/fallback/gateways";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { createContainer } from "./container";
import { VALUE_DELIVERY_ADAPTERS, type ValueDeliveryAdapter } from "./value-delivery-adapter";
import { LedgerPayoutStatusGateway } from "../infrastructure/settlement/ledger-payout-status-gateway";
import bs58 from "bs58"; import { almacenDeNavegador, guardarViaje } from "../infrastructure/solana/deeplink/sesion"; import { guardarEleccion } from "../infrastructure/solana/deeplink/conexion"; // WKH-358 (fix-pack): los tres EN ESTA LÍNEA — `T-065-GATE-1b`, más abajo, siembra el disco con los escritores de PRODUCCIÓN. ⚠️ Este archivo corre en NODE: `localStorage` y `location` los stubea ese `it`, y el `afterEach` los saca
import { esperarConectado } from "../test-support/desenlaces"; // WKH-359: ConnectWallet.execute() ahora tiene DOS desenlaces. Este helper TIRA si suspendió donde el test no lo espera, en vez de dejar un `undefined` viajando por media suite.

/** La cuenta que el viaje del enlace afirma. Es base58 válida y NO es la del bridge de los otros `it`. */
const DIRECCION_DEL_VIAJE = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";

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
  vi.unstubAllGlobals(); // WKH-358 (fix-pack): `T-065-GATE-1b` stubea `localStorage`/`location`, que este archivo NO tiene (corre en Node)
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
    const out = esperarConectado(await c.connectWallet.execute());

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
// popup cada 1,5 s (`}, 1500);`, `../presentation/flow.tsx:661`).
describe("createContainer — el seguimiento del payout lee el ledger (WKH-337/AC-1)", () => {
  const SENDER = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

  /** Una remesa en `payout_submitted` DENTRO del repo que el container construyó — no en uno propio:
   *  lo que se prueba es el cableado, y un repo inyectado a mano no lo tocaría.
   *
   *  🔴 LOS IMPORTS SON DINÁMICOS Y ES DELIBERADO, no una preferencia de estilo. Un `import` estático
   *  arriba desplazaría (`CABLEADO`, `:135`), que (`CABLEADO`, `../application/agent-rejections.test.ts:140`)
   *  cita por número de línea — y ese archivo está fuera del Scope IN de esta HU. Medido: con los 5
   *  imports arriba, `citas-ancladas.test.ts` se puso rojo por esa cita. ⛔ No los "subas" sin re-medirla.
   *  ⚠️ Decía `:115` y ESTA HU lo rompió: `T-335-AR-1` metió +21 líneas en `agent-rejections.test.ts:71`,
   *  o sea ARRIBA de la cita (115 → 136 el bloque, 119 → 140 la cita). Ahora va ANCLADA, que es la única
   *  forma que `citas-ancladas.test.ts` sabe verificar — suelta era el agujero declarado #1 de ese candado. */
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
        payoutAllowed: true, realVerified: true, verifiedAt: null,
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

// ── WKH-358 / CD-14 · LA RAMA DE ENLACE YA TIENE ACTIVACIÓN, Y EL INTERRUPTOR ES EL GATE ─────────
//
// 🔴 QUÉ DECÍA ESTE BLOQUE HASTA LA OLA 4, Y POR QUÉ DEJÓ DE SER CIERTO. Decía *"la rama de enlace NO
// tiene activación de producción"*, porque 062 escribió el motor entero y NO lo cableó: faltaba la ola 4
// —la que produce el `viaje.direccion`, la `session` y la `claveBilletera` que el motor CONSUME—. Esa
// ola es ÉSTA. El colaborador se cablea ahora **sin condición**, y el `it` de abajo se invirtió con su
// mensaje reescrito en vez de borrarse (CD-14, precedente `:45-48`).
//
// ⚠️ LO QUE NO CAMBIÓ ES EL ARGUMENTO DE FONDO: la lección `tests-que-registran-el-doble-no-prueban-el-
// cableado` dice que si nadie MIDE el cableado, alguien va a leer "la HU está hecha" como "el flujo
// móvil anda". Por eso el `it` sigue existiendo y sigue mirando el objeto que `createContainer()`
// devuelve — sólo que ahora custodia la presencia en vez de la ausencia.
//
// ⛔ Y SIGUE SIENDO FALSO QUE EL FLUJO MÓVIL ANDE. Nadie de este equipo lo midió en un teléfono, y el
// DEPÓSITO por enlace sigue sin cerrar por el PoP (WKH-359). Lo que esta ola enciende es el connect por
// enlace y la creación de la cuenta de nonce.
//
// ⚠️ CD-17 · LA TABLA DE MUTANTES QUE ESTABA ACÁ SE MIDIÓ CONTRA EL ÁRBOL DE 062 Y NO SE HEREDA. Decía
// "cablear el colaborador ⇒ 2 rojos" e "invertir el `if` del adaptador ⇒ 46 rojos", y los dos números
// describen un árbol que esta HU acaba de cambiar (el cableado YA no es un mutante: es el estado, y el
// `if` ganó una segunda condición). Los números re-medidos de esta HU, con su `sha`, están en la tabla
// de mutación que vive al final de `../infrastructure/solana/deeplink/conexion.test.ts` y que se re-corre
// con `node scripts/mutacion/bateria-065.mjs` (el harness y la especificación están COMMITEADOS desde el
// fix-pack: antes esta línea remitía a un "reporte de F3" que no existía, CR/BLQ-BAJO-3); escribir acá los
// viejos sería exactamente el "6 → 7 → 8" que este repo
// ya tiene documentado como candado podrido.
describe("createContainer — WKH-358/CD-14: la firma por enlace YA está cableada, y lo que la enciende es el GATE", () => {
  // 🔴 ESTE `it` SE INVIRTIÓ EN LA OLA 4, NO SE BORRÓ (CD-14). Mismo movimiento y misma razón que el
  // `it` de `"a2a"` de WKH-332 (`:45-48`), que es el precedente exacto de este archivo.
  //
  // QUÉ CUSTODIABA ANTES: que el motor NO estuviera cableado, porque al cerrar 062 faltaba la ola 4 —la
  // que produce el `viaje.direccion`, la `session` y la `claveBilletera` que el motor CONSUME—, así que
  // cablearlo sólo habría borrado la evidencia de que el camino estaba apagado.
  //
  // QUÉ CUSTODIA AHORA, que es lo contrario y por eso el `it` se da vuelta: esa ola llegó, el
  // colaborador se cablea **sin condición**, y lo que decide si la rama corre dejó de ser el cableado y
  // pasó a ser el gate del adaptador (`caminoPorEnlace`, `../infrastructure/solana-wallet.ts:2239`):
  // elección persistida del selector **Y** `availability === "none"`. Un `undefined` acá ya no
  // significa "está apagado a propósito": significa que el cableado se perdió y que **el recorrido por
  // enlace no existe para nadie**, en silencio y con la suite en verde.
  //
  // ⛔ LO QUE ESTE `it` NO AFIRMA, y hay que decirlo porque el nombre invita a leerlo así: NO afirma que
  // el depósito por enlace funcione. `prepare()` exige un PoP firmado por el bridge
  // ((`prove`, `../infrastructure/settlement/http-solana-prepare-gateway.ts:283-296`)) y en un móvil sin
  // extensión el bridge está vacío, así que un depósito por enlace muere en `payout_pop_unavailable`
  // antes de llegar a la rama. Eso es WKH-359.
  // ⚠️ ESA CITA IBA SIN ANCLA Y DECÍA `:222-235`, que hoy es la firma de un tipo: la ola W3 de WKH-372
  // metió 76 líneas en ese archivo y la corrió, y sin ancla `citas-ancladas.test.ts` no la mira por
  // diseño, así que el gate quedó verde con la cita rota (AR/BLQ-MED-1).
  // Lo que esta HU enciende es el connect y la creación de la cuenta de nonce.
  it("T-062-21 (INVERTIDO): el `SolanaWalletAdapter` del container se construye CON el colaborador de enlace", () => {
    const c = createContainer();
    const wallet = (c.confirmAndSend as unknown as { wallet?: unknown }).wallet;
    expect(wallet, "el container no cableó ninguna billetera a `ConfirmAndSend`").toBeDefined();
    const motor = (wallet as unknown as { firmaPorEnlace?: unknown }).firmaPorEnlace;
    expect(
      motor,
      "el container NO inyectó el motor de firma por enlace. Sin ese cableado, `caminoPorEnlace()` " +
        "puede devolver la billetera elegida y la rama NO corre igual, porque el primer operando del " +
        "`if` es el colaborador: el recorrido por enlace queda apagado PARA TODOS y nada más se pone " +
        "rojo. Si sacarlo es intencional, hay que revertir la ola 4 entera (selector, connect y cuenta " +
        "de nonce) y actualizar el SDD y los dos README en el mismo cambio.",
    ).toBeDefined();
  });

  // ── T-065-GATE-1 (AC-6b) · EL CONTAINER REAL, CON BRIDGE CONECTADO Y SIN ELECCIÓN EN DISCO ────────
  //
  // 🔴 POR QUÉ ESTE `it` VA SOBRE EL CONTAINER REAL Y NO SOBRE UN ADAPTER ARMADO A MANO. Es la mitad (b)
  // de AC-6, y la mitad que un doble no puede dar: lo que hay que medir es que el objeto QUE ESTE
  // ARCHIVO CONSTRUYE —con el colaborador ya cableado, que es lo que la inversión de arriba acaba de
  // permitir— siga recorriendo el camino inyectado. Con un adapter a mano estaríamos midiendo el
  // cableado del test, que es justo lo que la lección `tests-que-registran-el-doble` prohíbe.
  //
  // El desenlace esperado NO es un éxito: es `escrow_params_missing`, un guard fail-loud PRE-EXISTENTE
  // (`solana-wallet.ts:562-563`). Que la causa sea ÉSA —y no ninguna del vocabulario `deeplink_*`— es
  // exactamente la prueba de que la rama de enlace no se tocó.
  it("T-065-GATE-1 (AC-6b): con el bridge conectado y SIN elección en disco, no sale ninguna causa `deeplink_*`", async () => {
    solanaWalletBridge.setState({
      publicKey: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      connected: true,
    });
    solanaWalletBridge.setWalletAvailability("injected");
    const c = createContainer();
    const wallet = c.confirmAndSend as unknown as {
      wallet: { authorizePrincipal: (...a: unknown[]) => Promise<unknown> };
    };
    let causa = "";
    try {
      await wallet.wallet.authorizePrincipal(
        { send: { minor: 1 }, expiresAt: "2099-01-01T00:00:00.000Z" },
        "rem-gate-1",
      );
    } catch (e) {
      causa = (e as Error).message;
    }
    // CD-18: el fixture tiene que haber fabricado algo. Sin esto, un `authorizePrincipal` que resolviera
    // sin tirar dejaría `causa` en `""` y el `not.toMatch` de abajo pasaría por vacío.
    expect(causa, "el fixture no produjo ningún corte: no hay nada que clasificar").not.toBe("");
    expect(
      causa,
      "el camino INYECTADO produjo una causa del vocabulario `deeplink_*`. El gate dejó pasar un " +
        "recorrido que no es por enlace: revisá `caminoPorEnlace()`, que con `availability === " +
        '"injected"` tiene que devolver `null` en su PRIMERA condición, sin siquiera mirar el disco.',
    ).not.toMatch(/^deeplink_/);
    expect(causa, "la causa dejó de ser el guard pre-existente").toBe("escrow_params_missing");
  });

  // ── T-065-GATE-1b (AC-6b) · LA CONDICIÓN DE LA ELECCIÓN, AISLADA ──────────────────────────────────
  //
  // 🔴 POR QUÉ EXISTE ESTE `it` ADEMÁS DEL DE ARRIBA, Y ES UN HALLAZGO DEL CR (CR/BLQ-BAJO-1). El `it` de
  // arriba tenía atribuido como "mutante que mata" el de borrarle a `caminoPorEnlace()` la lectura de la
  // elección, y **ese mutante lo deja verde**: su fixture monta con `availability === "injected"`, así
  // que el gate corta en su PRIMERA condición y nunca llega a leer el disco; y además llama a
  // `authorizePrincipal` SIN `deposit`, así que muere en `escrow_params_missing` antes de cualquier rama.
  // O sea: AC-6(b) no tenía ningún mutante verificado. La atribución vieja era falsa y el fixture no
  // podía distinguirla.
  //
  // ⛔ POR QUÉ NO SE ARREGLA CAMBIÁNDOLE EL MUTANTE AL `it` DE ARRIBA: con `injected` NINGÚN mutante de
  // las condiciones 2 y 3 del gate cambia el desenlace, porque el corte pre-existente llega primero. La
  // condición de la ELECCIÓN sólo se puede aislar con `availability === "none"`, que es este fixture.
  //
  // 🔴 LA SONDA ES `getConnectedAddress()` Y NO `authorizePrincipal`, y es deliberado: es el observable
  // MÁS BARATO del gate —(`direccionDelViajeConectado`, `../infrastructure/solana-wallet.ts:2307`) corta
  // en `caminoPorEnlace() === null` en su primera línea— y no toca la red, no abre ningún modal y no pide
  // ninguna firma. Sigue siendo el CONTAINER REAL, que es lo que AC-6(b) exige: el objeto que este
  // archivo construye, con el colaborador de enlace ya cableado.
  //
  // MUTANTE QUE MATA: en `caminoPorEnlace()`, reemplazar `return leerEleccion(disco)` por
  // `return "phantom"` (línea-neutro) ⇒ el primer `expect` recibe la dirección del viaje en vez de `null`.
  it("T-065-GATE-1b (AC-6b): con `none` y un viaje CONECTADO en el disco pero SIN elección, el container real NO entra al camino por enlace", async () => {
    const disco = new Map<string, string>();
    const storage = {
      getItem: (k: string) => disco.get(k) ?? null,
      setItem: (k: string, v: string) => void disco.set(k, v),
      removeItem: (k: string) => void disco.delete(k),
      clear: () => disco.clear(),
      key: () => null,
      length: 0,
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("location", { href: "https://chaski.test/enviar", origin: "https://chaski.test" });
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true"); // la 3ª condición del gate, prendida: la que se aísla acá es la 1ª
    const almacen = almacenDeNavegador(storage as unknown as Storage);
    // El viaje se escribe con el ESCRITOR DE PRODUCCIÓN: así el nombre de la clave y la forma del `Viaje`
    // tienen UNA sola fuente y renombrarlos no deja este fixture escribiendo en el vacío.
    guardarViaje(almacen, {
      billetera: "phantom",
      secreta: bs58.encode(new Uint8Array(32)),
      publica: bs58.encode(new Uint8Array(32)),
      claveBilletera: bs58.encode(new Uint8Array(32)),
      session: "s",
      direccion: DIRECCION_DEL_VIAJE,
      paso: "conectar",
      remittanceId: "rem-gate-1b",
      desde: Date.now(),
    });
    solanaWalletBridge.setWalletAvailability("none");
    solanaWalletBridge.setState({ publicKey: null, connected: false }); // en un teléfono sin extensión el bridge está VACÍO
    const c = createContainer();

    expect(
      await c.connectedWallet.getConnectedAddress(),
      "sin elección persistida el gate se encendió igual: `caminoPorEnlace()` está leyendo el viaje " +
        "sin que nadie haya elegido nada en el selector, y eso es AC-6(b) roto.",
    ).toBeNull();

    // 🔴 LA ÚNICA VARIABLE QUE SE MUEVE: la elección. Sin esta mitad, el `toBeNull()` de arriba podría
    // estar pasando porque la siembra del viaje nunca sirvió para nada (CD-18).
    guardarEleccion(almacen, "phantom");
    expect(
      await c.connectedWallet.getConnectedAddress(),
      "con la elección puesta el gate TIENE que encenderse, o este `it` no está midiendo la elección",
    ).toBe(DIRECCION_DEL_VIAJE);
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

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // WKH-359 · T-067-19 (DT-13) — LOS CONSUMIDORES 3 Y 4 CAMBIAN DE DIAGNÓSTICO, **NO DE RECORRIDO**
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //
  // 🔴 QUÉ DECLARA ESTE `it`, y es tanto lo que afirma como lo que NIEGA. Son CUATRO los consumidores
  // de una prueba de posesión, no tres: el prepare del payout (1), el veredicto de KYC (2), el
  // resolver del refund (3, `../infrastructure/refund/http-solana-remittance-id-resolver.ts`) y el
  // gesto de renovar la ventana de lectura (4, `renovarVentana`, cableado en `container.ts:221`).
  // Esta HU le da recorrido a los DOS PRIMEROS. A los otros dos les da **diagnóstico y nada más**.
  //
  // ⛔ NADIE PUEDE LEER ESTE CAMBIO COMO "el refund por enlace ya funciona". Lo que cambia es que en
  // vez de `wallet_sign_not_available` —la marca del bridge, que en el camino por enlace es cierta
  // SIEMPRE y por lo tanto no distingue nada— ahora sale `deeplink_pop_sin_firma`, que dice "falta el
  // insumo" y la pantalla sabe traducir. El recorrido de esos dos gestos sigue muriendo ahí.
  it("T-067-19 (DT-13): `renovarVentana` por enlace corta con `deeplink_pop_sin_firma`, no con `wallet_sign_not_available`", async () => {
    const disco = new Map<string, string>();
    const storage = {
      getItem: (k: string) => disco.get(k) ?? null,
      setItem: (k: string, v: string) => void disco.set(k, v),
      removeItem: (k: string) => void disco.delete(k),
      clear: () => disco.clear(),
      key: () => null,
      length: 0,
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("location", { href: "https://chaski.test/enviar", origin: "https://chaski.test" });
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ popChallenge: "t", popMessage: "m", exp: Math.floor(Date.now() / 1000) + 600 }), { status: 200, headers: { "content-type": "application/json" } })));
    const almacen = almacenDeNavegador(storage as unknown as Storage);
    // Las TRES condiciones del gate, sembradas con los escritores de PRODUCCIÓN.
    guardarViaje(almacen, {
      billetera: "phantom",
      secreta: bs58.encode(new Uint8Array(32)),
      publica: bs58.encode(new Uint8Array(32)),
      claveBilletera: bs58.encode(new Uint8Array(32)),
      session: "s",
      direccion: DIRECCION_DEL_VIAJE,
      paso: "conectar",
      remittanceId: "rem-067-19",
      desde: Date.now(),
    });
    guardarEleccion(almacen, "phantom");
    solanaWalletBridge.setWalletAvailability("none");
    solanaWalletBridge.setState({ publicKey: null, connected: false }); // el bridge VACÍO de un teléfono
    const c = createContainer();

    // CD-18 — el fixture fabricó el caso: el gate está encendido de verdad.
    expect(
      await c.connectedWallet.getConnectedAddress(),
      "el gate no se encendió: este `it` estaría midiendo el camino inyectado",
    ).toBe(DIRECCION_DEL_VIAJE);

    let causa = "";
    try {
      await c.renovarVentana?.prove(DIRECCION_DEL_VIAJE);
    } catch (e) {
      causa = (e as Error).message;
    }
    expect(causa, "el gesto no cortó: no hay nada que clasificar").not.toBe("");
    // 🔴 MUTANTE QUE MATA: borrar el gate de `signMessage` ⇒ vuelve `wallet_sign_not_available`.
    expect(
      causa,
      "el consumidor #4 sigue recibiendo la marca del bridge, que en el camino por enlace es cierta " +
        "SIEMPRE y por lo tanto no le dice nada a nadie",
    ).not.toBe("wallet_sign_not_available");
    expect(causa).toBe("deeplink_pop_sin_firma");
  });

});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-359/AC-3 · T-CABLE-2 — EL 4º ARGUMENTO DE `ConnectWallet`, EJERCITADO (F4/F4-1)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 POR QUÉ EXISTE ESTE `it`: PORQUE LA PROSA QUE DECÍA QUE YA EXISTÍA ERA FALSA, Y F4 LO MIDIÓ.
// `container.ts:185` afirmaba «⛔ SIN ESTA LÍNEA … `prepare` contesta 403 … Lo ve `container.test.ts`»
// y `../application/use-cases/connect-wallet.ts:55` repetía «y eso tiene test propio». Las dos
// describían un candado que NO estaba escrito. Los dos mutantes que lo probaron (F4 · §4):
//   · **M4** — el 4º argumento ⇒ `undefined as never`: este archivo daba **36 passed (36)**.
//   · **M5** — el 4º argumento **BORRADO**, que es literalmente "sin esta línea": `tsc --noEmit`
//     exit **0** (el parámetro es `pop?`, opcional en `connect-wallet.ts:56`) y la suite COMPLETA en
//     **147 passed / 2783 passed | 1 skipped**. ⇒ borrar "el eslabón entero" compilaba y pasaba TODO.
//
// 🔴 Y POR QUÉ NINGÚN `it` DE LOS QUE YA ESTABAN PODÍA VERLO — la causa es estructural y es la parte
// que hay que entender antes de tocar esto. Con la bandera APAGADA el 4º argumento no hace nada:
// `pedir()` contesta `no-corresponde` en su primera línea (`../infrastructure/solana-wallet.ts:2384`)
// y el use-case sigue byte-idéntico (AC-8, y es deliberado). Así que el único `it` capaz de ver el
// cableado es uno que prenda `NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED` **Y** ejercite
// `c.connectWallet.execute()` **EN EL MISMO `it`**. Este archivo tenía los dos ingredientes por
// separado —la bandera en `:840` y `:935`, el `connectWallet` del container en `:402` y `:511`— y
// nunca juntos. Ésa es exactamente la superficie donde M4 y M5 vivían.
//
// ⛔ POR QUÉ NO ALCANZA CON `expect((c.connectWallet as …).pop).toBeDefined()`, que es más barato: es
// el mismo error que `T-CABLE-1b` ya corrigió para el 3er argumento. Un `toBeDefined()` mata M5 pero
// **no mata M4 en su versión útil** —inyectar un colaborador inerte, un objeto cuyo `pedir()` conteste
// siempre `no-corresponde`— y ése es el mutante que importa, porque es el que un refactor produce sin
// querer. Acá se EJERCITA: se enciende el camino por enlace de verdad y se exige que el `connectWallet`
// QUE EL CONTAINER DEVUELVE **suspenda** para ir a buscar la firma.
//
// 🔴 EL FIXTURE ES EL DE `T-067-19` (`:935`), con los escritores de PRODUCCIÓN, y por la misma razón:
// las TRES condiciones del gate (`caminoPorEnlace`, `../infrastructure/solana-wallet.ts:2239-2240`)
// sembradas sin copiar ni el nombre de la clave ni la forma del `Viaje`.
//
// ⚠️ LO QUE ESTE `it` NO AFIRMA: no dice que el PoP del KYC funcione en un teléfono. La firma la
// devuelve la billetera y **nadie de este equipo corrió eso en un dispositivo** ([NC-3], sigue
// abierto). Lo que afirma es lo que M5 destapó: que **el 4º argumento está cableado y hace algo**.
describe("createContainer — WKH-359/AC-3: el `connectWallet` REAL consigue el PoP por enlace (T-CABLE-2)", () => {
  /** Las tres condiciones del gate + el emisor del desafío vivo. Devuelve el container REAL. */
  function containerPorEnlace(desafio: Response): ReturnType<typeof createContainer> {
    const disco = new Map<string, string>();
    const storage = {
      getItem: (k: string) => disco.get(k) ?? null,
      setItem: (k: string, v: string) => void disco.set(k, v),
      removeItem: (k: string) => void disco.delete(k),
      clear: () => disco.clear(),
      key: () => null,
      length: 0,
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("location", { href: "https://chaski.test/enviar", origin: "https://chaski.test" });
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
    vi.stubGlobal("fetch", vi.fn(async () => desafio.clone()));
    const almacen = almacenDeNavegador(storage as unknown as Storage);
    guardarViaje(almacen, {
      billetera: "phantom",
      secreta: bs58.encode(new Uint8Array(32)),
      publica: bs58.encode(new Uint8Array(32)),
      claveBilletera: bs58.encode(new Uint8Array(32)),
      session: "s",
      direccion: DIRECCION_DEL_VIAJE,
      paso: "conectar",
      remittanceId: "rem-cable-2",
      desde: Date.now(),
    });
    guardarEleccion(almacen, "phantom");
    solanaWalletBridge.setWalletAvailability("none");
    solanaWalletBridge.setState({ publicKey: null, connected: false }); // el bridge VACÍO de un teléfono sin extensión
    return createContainer();
  }

  const DESAFIO_VIVO = () =>
    new Response(
      JSON.stringify({ popChallenge: "c-cable-2", popMessage: "m-cable-2", exp: Math.floor(Date.now() / 1000) + 600 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  // 🔴 MUTANTES QUE MATAN ESTE `it`, LOS DOS DE F4 (y son la razón de que exista):
  //   · **M5** — borrar el 4º argumento de `container.ts:185` ⇒ `this.pop` queda `undefined`,
  //     `connect-wallet.ts:95` no entra al `if`, y `execute()` sale por `"listo"` en vez de suspender.
  //   · **M4** — pasarlo como `undefined as never` ⇒ idéntico desenlace.
  // Un tercero, el que `T-CABLE-1b` enseñó a no dejar pasar: inyectar un colaborador INERTE cuyo
  // `pedir()` conteste siempre `no-corresponde` ⇒ también sale `"listo"` y también cae acá.
  it("T-CABLE-2: con el camino por enlace encendido, el `connectWallet` del container SUSPENDE a firmar el PoP del KYC", async () => {
    const c = containerPorEnlace(DESAFIO_VIVO());

    // CD-18 — el fixture fabricó el caso de verdad. Sin esto, un gate apagado dejaría a este `it`
    // midiendo el camino inyectado y el `toBe("hay-que-salir")` de abajo caería por el motivo equivocado.
    expect(
      await c.connectedWallet.getConnectedAddress(),
      "el gate no se encendió: este `it` estaría midiendo el camino inyectado, donde el 4º argumento " +
        "no hace nada por diseño (AC-8) y por lo tanto no se puede ver",
    ).toBe(DIRECCION_DEL_VIAJE);

    const out = await c.connectWallet.execute();

    // 🔴 LA CITA POR NÚMERO VIVE ACÁ ARRIBA Y NO ADENTRO DEL MENSAJE, y es a propósito
    // (AR/BLQ-MED-1). Decía `prepare/route.ts:311` desde dentro de la cadena del `expect`, y esa
    // línea ya era un `})`: la ola W3 insertó 60 líneas más arriba y la corrió. ⛔ Y NO ALCANZABA
    // CON RE-DERIVARLA AHÍ: `citas-ancladas.test.ts` sólo mira las líneas que llevan COMENTARIO —su
    // lexer saltea las cadenas a propósito—, así que una cita adentro de un string es invisible para
    // el candado por más anclada que esté. Acá arriba sí la cubre, y el mensaje del `expect` se queda
    // con el nombre del enum, que no tiene número que envejecer.
    // El corte es (`prepare_kyc_verdict_missing`, `../../app/api/payout/prepare/route.ts:371`).
    expect(
      out.estado,
      "el `connectWallet` que ESTA composición devuelve NO pidió la prueba de posesión por enlace: el " +
        "4º argumento de `container.ts:185` no está cableado, o el colaborador inyectado es inerte. " +
        "Consecuencia, y por eso este candado existe: en todo teléfono sin extensión la sesión de Didit " +
        "se crea SIN ATAR, `persistKycVerdict` no escribe la fila del veredicto (su gate es " +
        "`d.payoutAllowed !== true`) y " +
        "`prepare/route.ts` contesta 403 `prepare_kyc_verdict_missing` (la línea exacta, anclada, en " +
        "el comentario de arriba). ⚠️ Y NO SE " +
        "VE: una billetera que YA tiene fila cierra igual, así que el bug sólo lo sufre la gente nueva",
    ).toBe("hay-que-salir");
    if (out.estado !== "hay-que-salir") return; // narrowing; el `expect` de arriba ya falló
    // El propósito es el del KYC y no el del payout: son ANCLAS DISTINTAS (CD-15) y confundirlas haría
    // que la firma del veredicto se consumiera como si fuera la del depósito.
    expect(out.esperando).toBe("firma-pop-kyc");
    expect(out.address).toBe(DIRECCION_DEL_VIAJE);
    expect(out.irA, "suspendió sin decir a dónde ir, que es una suspensión que nadie puede resolver").toContain("phantom");
  });

  // 🔴 EL CONTROL SIN EL CUAL EL DE ARRIBA NO PRUEBA NADA (CD-18, y es la lección de `T-065-GATE-1`).
  // Si `execute()` contestara `"hay-que-salir"` por cualquier motivo —por ejemplo porque el fixture
  // rompió algo aguas arriba—, el `it` de arriba pasaría igual sin que el 4º argumento exista. Acá se
  // mueve UNA sola variable: el emisor del desafío contesta 501 (`PAYOUT_POP_SECRET` ausente
  // server-side), que es el desenlace `no-se-puede` de AC-5. El cableado es el MISMO y el desenlace
  // TIENE que cambiar a `"listo"`, sin salto a ninguna billetera.
  it("CONTROL: con el emisor del desafío en 501 el MISMO cableado NO suspende (el desenlace lo decide el colaborador, no el fixture)", async () => {
    const c = containerPorEnlace(
      new Response(JSON.stringify({ error: "pop_not_configured" }), { status: 501 }),
    );
    expect(await c.connectedWallet.getConnectedAddress()).toBe(DIRECCION_DEL_VIAJE);

    const out = await c.connectWallet.execute();
    expect(
      out.estado,
      "con el emisor apagado el connect suspendió igual: entonces la suspensión del `it` de arriba no " +
        "la produce `pedir()` y ese test no está midiendo el cableado",
    ).toBe("listo");
    expect(out.address).toBe(DIRECCION_DEL_VIAJE); // conectar sigue funcionando: el PoP no puede ser la puerta (CD-15)
  });
});

// ── 🔴 WKH-372/W3.4 · T-372-W3-16 — LA MISMA INSTANCIA DEL ALMACÉN EN LOS DOS GATEWAYS ───────────
//
// QUÉ AGUJERO CIERRA, Y ES EL MODO DE FALLA MÁS BARATO DE TODA LA OLA. El almacén de la sesión entra
// como SEGUNDO argumento OPCIONAL en los dos gateways (`../infrastructure/kyc/http-kyc-verdict-gateway.ts`
// y `../infrastructure/settlement/http-solana-prepare-gateway.ts`), y opcional significa que si
// `container.ts` no lo cablea —o cablea DOS instancias distintas, una por gateway— todo compila, toda
// la suite queda VERDE, y la ola entera es un no-op: el veredicto graba la sesión en un `Map` que el
// depósito nunca lee, así que la persona sigue firmando dos veces y nadie se entera.
//
// Es exactamente el defecto que `T-CABLE-1` (por nombre, en este mismo archivo) ya cubre para el 3er
// argumento de `ConnectWallet`, y por eso el molde se copia en vez de inventarse.
//
// ⛔ Y NO ALCANZA UN `toBeDefined()`: dos instancias distintas también están definidas. Por eso este
// `it` EJERCITA — graba por la cara de escritura y lee por la de lectura. Si no son el mismo objeto,
// el `peek` devuelve `null`.
//
// MUTANTE QUE LO MATA: en `./container.ts:106`, instanciar un segundo almacén y pasarle ÉSE a uno de
// los dos gateways ⇒ `peek` devuelve null y este `it` se pone rojo con su mensaje.
//
// ⚠️ SE CITA SIEMPRE CON SU ARCHIVO: hay `T-CABLE-*` en este archivo Y en
// `../presentation/wallet-availability.test.tsx`, midiendo cosas distintas.
describe("createContainer — WKH-372/W3.4: el almacén de la sesión es UNA sola instancia", () => {
  const DIRECCION = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

  it("T-372-W3-16: el gateway del veredicto y el del depósito comparten el MISMO almacén de sesión", () => {
    // Las tres envs que el bundle de Solana exige para construirse, con los MISMOS valores que ya usa
    // el `it` de "flag Solana ON con todo configurado" de más arriba en este archivo.
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_USDC_MINT", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const c = createContainer();

    // La cara de ESCRITURA: la que `HttpKycVerdictGateway` recibe (`SesionRecorder`).
    const escritor = (
      c.connectWallet as unknown as { verdictGateway?: { sesiones?: { record(a: string, t: string): void } } }
    ).verdictGateway?.sesiones;
    // La cara de LECTURA: la que `HttpSolanaPayoutPrepareGateway` recibe (`SesionReader`).
    const lector = (
      c.confirmAndSend as unknown as { solana?: { prepare?: { sesiones?: { peek(a: string): string | null } } } }
    ).solana?.prepare?.sesiones;

    expect(
      escritor,
      "el container NO le cableó el almacén al gateway del veredicto: la sesión nunca se graba y la " +
        "persona sigue firmando dos veces, con toda la suite en verde",
    ).toBeDefined();
    expect(
      lector,
      "el container NO le cableó el almacén al gateway del depósito: la sesión se graba y nadie la lee",
    ).toBeDefined();

    // 🔴 LA AFIRMACIÓN, Y ES DE COMPORTAMIENTO: lo que uno graba, el otro lo lee.
    escritor?.record(DIRECCION, "sesion-de-prueba.mac");
    expect(
      lector?.peek(DIRECCION),
      "el container cableó DOS instancias distintas: el veredicto graba en un Map y el depósito lee " +
        "otro ⇒ `peek` devuelve null en producción y la ola es un no-op verde",
    ).toBe("sesion-de-prueba.mac");

    // CONTROL POSITIVO del instrumento: el lector sabe decir que NO. Sin esta mitad, un doble que
    // devolviera siempre el mismo string pasaría la línea de arriba.
    expect(
      lector?.peek("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      "el lector contesta lo mismo para cualquier dirección: este `it` no mide nada",
    ).toBeNull();
  });
});
