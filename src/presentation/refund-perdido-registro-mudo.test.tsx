// @vitest-environment jsdom
//
// LA PUERTA DEL REFUND PERDIDO AFIRMABA HABER MIRADO LO QUE NO MIRÓ (WKH-331 / AC-1, AC-2, AC-3,
// AC-5, AC-8).
//
// 🔴 POR QUÉ ESTE ARCHIVO EXISTE. `resolveRemittanceIdFromLedger` consumía `listBySender`, que colapsa
// CUATRO condiciones en una lista vacía: el mecanismo de prueba de posesión apagado, el registro
// durable apagado, la prueba de posesión rechazada, y —la única legítima— el servidor contestando que
// no hay ids. Sobre esa lista vacía el adapter tiraba `escrow_not_found`, y la pantalla decía haber
// mirado los últimos N envíos del servidor. En los tres primeros casos nunca se llegó a preguntar.
//
// De dónde sale el árbol: de `createContainer()`, el container REAL. O sea el `HttpPopSigner` real, el
// `HttpSolanaRemittanceIdResolver` real, el `SolanaWalletAdapter` real y el `SolanaEscrowRefundGateway`
// real, cableados como en producción. Lo único stubbeado es `fetch` — la frontera de red — y la firma
// de la wallet. NO hay ningún doble del resolver escrito a mano (AC-8): un doble puede representar el
// desenlace que su autor tuvo en mente, y el desenlace a cazar es justamente el que nadie tenía.
//
// ⚠️ NINGÚN caso de acá llega a la cadena, y no es una omisión: los tres degradados cortan ANTES de
// derivar la PDA, y el CONTROL corta por lista vacía también antes (`solana-wallet.ts`, el guard de
// lista vacía, antes de los `await import(...)`). Por eso jsdom alcanza. La derivación de PDA en jsdom
// NO funciona (`escrow-rent-discovery-junta.test.ts` explica con qué mensaje) y ningún caso la
// necesita.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LostEscrowRecovery } from "./flow";
import { createContainer } from "../composition/container";
import { MAX_RECOVERY_CANDIDATES } from "../infrastructure/solana-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { FAKE_SOLANA_BENEFICIARY } from "../test-support/fakes";

const SENDER = FAKE_SOLANA_BENEFICIARY;
const RUTA_CHALLENGE = "/api/a2a/payout/challenge";
const RUTA_IDS = "/api/solana/escrow/remittance-ids";

// ⚠️ Acá NO se ausentan las envs EVM (`container.test.ts` sí lo hace). Nombrarlas está PROHIBIDO en
// todo el árbol salvo en un allowlist enumerado (`no-evm-surface.test.ts`), y este archivo no tiene
// una razón estructural para entrar en él. Si alguna quedara seteada en el entorno, `createContainer`
// tira `evm_config_residue` y este test se pone rojo diciéndolo — que es el desenlace correcto.
beforeEach(() => {
  // La wallet firma: los desenlaces A/B/C/E de abajo NO son "la persona no firmó". El caso D
  // sobreescribe este handle a propósito, y ésa es la única diferencia.
  solanaWalletBridge.registerSignMessage(async () => new Uint8Array(64));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  solanaWalletBridge.reset();
});

/** Un `fetch` que contesta por ruta. Lo que no esté acá es un error del test, no del código. */
function stubFetch(rutas: Record<string, () => Response>) {
  const llamadas: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      llamadas.push(u);
      const handler = rutas[u];
      if (!handler) throw new Error(`ruta no stubbeada en el test: ${u}`);
      return handler();
    }),
  );
  return llamadas;
}

const challengeOk = () =>
  Response.json({ popChallenge: "chal-1", popMessage: "firmá esto" }, { status: 200 });

/**
 * Monta la puerta con el gateway del container REAL y aprieta "Buscar".
 *
 * El `sender` va explícito por `resolveSender`, así que no hace falta conectar el bridge: el gateway
 * se lo pasa a `refundEscrow`, que lo usa antes de cualquier guard de conexión.
 */
function buscarConElContainerReal() {
  const c = createContainer();
  render(<LostEscrowRecovery refund={c.solanaRefund} resolveSender={async () => SENDER} />);
  fireEvent.click(screen.getByRole("button", { name: /Recuperar un envío perdido/ }));
  fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));
}

/** La aserción del bloqueante: la pantalla NO afirma haber mirado ningún envío. */
async function laPantallaNoAfirmaHaberMirado() {
  await waitFor(() => {
    expect(screen.getByText(/no llegamos a preguntar/)).toBeInTheDocument();
  });
  expect(screen.queryByText(/No encontramos escrows abiertos/)).not.toBeInTheDocument();
  expect(
    screen.queryByText(new RegExp(`últimos ${MAX_RECOVERY_CANDIDATES} envíos`)),
  ).not.toBeInTheDocument();
}

describe("AC-1/AC-2/AC-8: los TRES desenlaces en que el registro no nos contestó, con el resolver REAL", () => {
  // Los tres los dispara una BANDERA DE CONFIGURACIÓN, no una caída: con el registro apagado, o el
  // secreto del PoP ausente, le pasan a TODO EL MUNDO y en TODAS las búsquedas.
  it("A) el mecanismo de prueba de posesión está apagado (501 en el challenge) ⇒ no se afirma nada", async () => {
    const llamadas = stubFetch({
      [RUTA_CHALLENGE]: () => Response.json({ error: "pop_not_configured" }, { status: 501 }),
    });
    buscarConElContainerReal();

    await laPantallaNoAfirmaHaberMirado();
    // CD-7: y la prueba MEDIDA de que no se preguntó — nunca se llegó al endpoint de los ids.
    expect(llamadas).toEqual([RUTA_CHALLENGE]);
  });

  it("B) el registro durable está apagado (501 en los ids) ⇒ no se afirma nada", async () => {
    stubFetch({
      [RUTA_CHALLENGE]: challengeOk,
      [RUTA_IDS]: () => Response.json({ error: "escrow_recovery_not_enabled" }, { status: 501 }),
    });
    buscarConElContainerReal();

    await laPantallaNoAfirmaHaberMirado();
  });

  it("C) la prueba de posesión no verificó (403 en los ids) ⇒ no se afirma nada", async () => {
    stubFetch({
      [RUTA_CHALLENGE]: challengeOk,
      [RUTA_IDS]: () => Response.json({ error: "pop_invalid" }, { status: 403 }),
    });
    buscarConElContainerReal();

    await laPantallaNoAfirmaHaberMirado();
  });
});

describe("AC-5: la firma de posesión no se completó, que tampoco es una respuesta sobre los fondos", () => {
  // ⚠️ El string lo escribe la wallet y no lo controlamos: "User rejected the request." es el que
  // manda Phantom. Usar acá el código interno en vez del texto real dejaría sin vigilar justo la
  // traducción que la rama existe para hacer.
  it("D) la persona rechaza la firma ⇒ se dice que no llegamos a preguntar, NO que fracasamos", async () => {
    stubFetch({ [RUTA_CHALLENGE]: challengeOk });
    solanaWalletBridge.registerSignMessage(async () => {
      throw new Error("User rejected the request.");
    });
    buscarConElContainerReal();

    await waitFor(() => {
      expect(screen.getByText(/aceptá la firma/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/No pudimos recuperar los fondos/)).not.toBeInTheDocument();
  });
});

describe("AC-3: el CONTROL, sin el cual los cuatro de arriba no prueban nada", () => {
  // 🔴 POR QUÉ ESTE CASO EXISTE, y por qué sus aserciones son POSITIVAS. Un arreglo que hiciera decir
  // "no llegamos a preguntar" en las CUATRO condiciones pasaría A/B/C/D sin despeinarse, y sería tan
  // falso como el defecto que esta HU cierra, sólo que en la otra dirección: la pantalla afirmaría no
  // haber preguntado también cuando el servidor sí contestó. Acá el servidor SÍ contesta, y contesta
  // que no hay nada: ése es el único caso en que la pantalla puede afirmar algo sobre esta billetera.
  // Mismo resolver real, misma ruta, mismo árbol — la ÚNICA diferencia es el status y el body.
  //
  // ⚠️ Las dos subcadenas se exigen PRESENTES a propósito. Con sólo la negación de "no llegamos a
  // preguntar", un mensaje distinto —o vacío— también la satisfaría y la sobre-corrección quedaría
  // invisible.
  it("E) el registro contesta 200 con la lista vacía ⇒ ahí SÍ se dice 'No encontramos'", async () => {
    stubFetch({
      [RUTA_CHALLENGE]: challengeOk,
      [RUTA_IDS]: () => Response.json({ remittanceIds: [] }, { status: 200 }),
    });
    buscarConElContainerReal();

    const msg = await screen.findByText(/No encontramos escrows abiertos para esta billetera/);
    expect(msg).toBeInTheDocument();
    // El número sale de la MISMA constante que sondea, no de un literal escrito en el test.
    expect(msg).toHaveTextContent(`los últimos ${MAX_RECOVERY_CANDIDATES} envíos`);
    expect(screen.queryByText(/no llegamos a preguntar/)).not.toBeInTheDocument();
  });
});
