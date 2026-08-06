// @vitest-environment jsdom
//
// LA OTRA MITAD DE LA JUNTA (WKH-327 / AC-8, 2º fix-pack — AR/BLQ-MED-2).
//
// 🔴 POR QUÉ ESTE ARCHIVO EXISTE. El 1er fix-pack partió el copy en dos y dejó impecable la mitad del
// `catch`. La mitad de la LISTA VACÍA seguía rota, y su único test usaba
// `FakeSolanaCloseableEscrowLister([])`: un doble que POR CONSTRUCCIÓN sólo devuelve `[]` cuando el
// servidor contestó. El desenlace que rompía —el servidor no nos contestó nada y el resolver lo
// colapsó a `[]`— ese doble no lo puede representar. Es la tercera vez en esta HU que un fixture
// esquiva el agujero por construcción, así que acá no hay ningún doble del descubrimiento.
//
// De dónde sale el árbol: de `createContainer()`, el container REAL. O sea el `HttpPopSigner` real, el
// `HttpSolanaRemittanceIdResolver` real y el `SolanaWalletAdapter` real, cableados como en producción.
// Lo único stubbeado es `fetch` — la frontera de red — y la firma de la wallet.
//
// ⚠️ NINGÚN caso de acá llega a la cadena, y no es una omisión: en los tres desenlaces degradados
// `listCloseable` corta ANTES de derivar la PDA, y en el control la lista de ids viene vacía, que
// también corta antes. Por eso jsdom alcanza. La derivación de PDA en jsdom NO funciona
// (`escrow-rent-discovery-junta.test.ts` explica con qué mensaje) y ningún test de este archivo la
// necesita.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EscrowRentRecovery } from "./flow";
import { createContainer } from "../composition/container";
import { MAX_CLOSEABLE_CANDIDATES } from "../infrastructure/solana-wallet";
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
  // La wallet está conectada y firma: los tres desenlaces de abajo NO son "la persona no firmó".
  solanaWalletBridge.setState({ publicKey: SENDER, connected: true });
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

/** Monta la puerta con el descubrimiento del container REAL y aprieta "Buscar". */
function buscarConElContainerReal() {
  const c = createContainer();
  render(
    <EscrowRentRecovery
      lister={c.solanaCloseableEscrows}
      close={c.closeEscrowAccounts}
      resolveSender={async () => SENDER}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Recuperar el depósito de red de envíos anteriores/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));
}

/** La aserción que el bloqueante necesitaba: la pantalla NO afirma haber mirado nada. */
async function laPantallaNoAfirmaHaberMirado() {
  await waitFor(() => {
    expect(screen.getByText(/no llegamos a preguntar/)).toBeInTheDocument();
  });
  expect(screen.queryByText(/No encontramos envíos terminados/)).not.toBeInTheDocument();
  expect(
    screen.queryByText(new RegExp(`últimos ${MAX_CLOSEABLE_CANDIDATES} envíos`)),
  ).not.toBeInTheDocument();
}

describe("AC-8: los TRES desenlaces en que el registro no nos contestó, con el resolver REAL", () => {
  // Los tres los dispara una BANDERA DE CONFIGURACIÓN, no una caída: con el ledger apagado, o el
  // secreto del PoP ausente, le pasan a TODO EL MUNDO y en TODAS las búsquedas.
  it("A) el mecanismo de prueba de posesión está apagado (501 en el challenge) ⇒ no se afirma nada", async () => {
    const llamadas = stubFetch({
      [RUTA_CHALLENGE]: () => Response.json({ error: "pop_not_configured" }, { status: 501 }),
    });
    buscarConElContainerReal();

    await laPantallaNoAfirmaHaberMirado();
    // Y la prueba de que NO se preguntó: nunca se llegó al endpoint de los ids.
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

  // 🔴 EL CONTROL SIN EL CUAL LOS TRES DE ARRIBA NO PRUEBAN NADA. Si "No encontramos" dejara de
  // decirse nunca, los tres pasarían igual. Acá el servidor SÍ contesta, y contesta que no hay nada:
  // ése es el único caso en que la pantalla puede afirmar algo sobre las cuentas de la persona. Mismo
  // resolver real, misma ruta, mismo árbol — la ÚNICA diferencia es el status y el body.
  it("CONTROL: el registro contesta 200 con la lista vacía ⇒ ahí SÍ se dice 'No encontramos'", async () => {
    stubFetch({
      [RUTA_CHALLENGE]: challengeOk,
      [RUTA_IDS]: () => Response.json({ remittanceIds: [] }, { status: 200 }),
    });
    buscarConElContainerReal();

    await waitFor(() => {
      expect(screen.getByText(/No encontramos envíos terminados/)).toBeInTheDocument();
    });
    expect(
      screen.getByText(new RegExp(`últimos ${MAX_CLOSEABLE_CANDIDATES} envíos`)),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no llegamos a preguntar/)).not.toBeInTheDocument();
  });
});
