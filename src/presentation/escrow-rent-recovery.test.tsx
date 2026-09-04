// @vitest-environment jsdom
//
// LA PUERTA DEL ALQUILER (WKH-327 / AC-8).
//
// Qué cubre que no cubría nada: los envíos TERMINADOS de esta billetera que este navegador no conoce.
// El historial está scopeado por `localStorage` y declara que no consulta la cadena; la puerta de
// "envío perdido" busca escrows ABIERTOS, y un escrow terminal no está abierto. O sea que el alquiler
// de un envío hecho desde otro dispositivo no tenía ningún camino.
//
// Lo que estos tests clavan, en orden de importancia:
//   1. que un id que NO está en localStorage aparece igual como cerrable;
//   2. que "no encontramos" y "no llegamos a preguntar" NO se dicen con las mismas palabras;
//   3. que el número del copy sale de la constante, no escrito a mano;
//   4. que las firmas se explican ANTES de que aparezca ningún diálogo.
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EscrowRentRecovery } from "./flow";
import { MAX_CLOSEABLE_CANDIDATES, SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { CloseEscrowAccounts } from "../application/use-cases/close-escrow-accounts";
import {
  MENSAJE_FIRMA_RECHAZADA_SIN_MEDIR,
  MENSAJE_RPC_CAIDO_NODE_MEDIDO,
} from "../test-support/rpc-caido";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeConnectedWallet,
  FakeSolanaCloseableEscrowLister,
  FakeSolanaEscrowCloseGateway,
} from "../test-support/fakes";

afterEach(() => {
  cleanup();
  solanaWalletBridge.reset();
});

const sender = FAKE_SOLANA_BENEFICIARY;
const OTRA_BILLETERA = "8tJVcM2JmYcMNCcNFYtUpXVWvKNTfnrCEwLuTRHpF9dQ";
const resolveSender = async () => sender;

function abrirPuerta(lister: FakeSolanaCloseableEscrowLister) {
  render(
    <EscrowRentRecovery
      lister={lister}
      close={
        new CloseEscrowAccounts(
          new FakeSolanaEscrowCloseGateway(),
          new FakeConnectedWallet(sender),
        )
      }
      resolveSender={resolveSender}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Recuperar el depósito de red de envíos anteriores/ }),
  );
}

describe("AC-8: alcanza envíos que este navegador no conoce", () => {
  it("localStorage vacío + el lister devolviendo un id terminal ⇒ aparece como cerrable", () => {
    // El navegador arranca sin nada guardado: esto es EXACTAMENTE el caso que hoy no tiene camino.
    expect(localStorage.length).toBe(0);
    const lister = new FakeSolanaCloseableEscrowLister([
      { remittanceId: "rem-de-otro-dispositivo", status: "released" },
    ]);
    abrirPuerta(lister);

    fireEvent.click(screen.getByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));

    return waitFor(() => {
      expect(screen.getByText(/rem-de-otro-dispositivo/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Cerrar y recuperar/ })).toBeInTheDocument();
      expect(lister.calls).toEqual([{ sender }]);
    });
  });

  it("el copy de 'no encontramos' nombra CUÁNTOS envíos miramos, con la constante importada", () => {
    const lister = new FakeSolanaCloseableEscrowLister([]); // la cadena contestó: no hay nada
    abrirPuerta(lister);

    fireEvent.click(screen.getByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));

    return waitFor(() => {
      // El número NO se escribe a mano acá: sale de la MISMA constante que el adapter sondea, así que
      // si el tope cambia el copy no puede quedar diciendo el viejo.
      expect(
        screen.getByText(new RegExp(`últimos ${MAX_CLOSEABLE_CANDIDATES} envíos`)),
      ).toBeInTheDocument();
      expect(screen.getByText(/No encontramos envíos terminados/)).toBeInTheDocument();
    });
  });

  // 🔴 La distinción que este archivo existe para sostener. Una lista vacía es una RESPUESTA; una
  // excepción es nuestra propia falla. Decir "no tenés nada" sobre lo segundo es afirmar sobre las
  // cuentas de alguien a partir de que nosotros no pudimos mirar.
  //
  // ⚠️ EL CASO DE ABAJO ERA EL ÚNICO Y NO ALCANZABA (AR/BLQ-MED-1): `escrow_recovery_unavailable` es
  // uno de los dos códigos que el guard del copy SÍ reconocía, o sea que el fixture elegido esquivaba
  // justo el agujero. Los mensajes que el adapter propaga DE VERDAD están en el `it` siguiente y su
  // string sale de una constante medida, no de una elección.
  it("el lister LANZANDO dice 'no llegamos a preguntar', nunca 'no encontramos'", () => {
    const lister = new FakeSolanaCloseableEscrowLister([], "reject", "escrow_recovery_unavailable");
    abrirPuerta(lister);

    fireEvent.click(screen.getByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));

    return waitFor(() => {
      expect(screen.getByText(/no llegamos a preguntar/)).toBeInTheDocument();
      expect(screen.queryByText(/No encontramos envíos terminados/)).not.toBeInTheDocument();
      expect(screen.getByText(/no es una respuesta sobre tus cuentas/)).toBeInTheDocument();
    });
  });

  // 🔴 Los mensajes que NO son códigos nuestros — los que el bloqueante mostraba como "no tenés nada".
  // El primero lo mide `escrow-rent-discovery-junta.test.ts` corriendo el adapter real contra un RPC
  // muerto; el segundo es el de la wallet cuando la persona cierra el popup de la firma de posesión.
  for (const [quePaso, mensaje] of [
    ["el RPC no contesta", MENSAJE_RPC_CAIDO_NODE_MEDIDO],
    ["la persona cerró el popup de la firma", MENSAJE_FIRMA_RECHAZADA_SIN_MEDIR],
  ] as const) {
    it(`${quePaso} ⇒ la pantalla NO afirma haber mirado ningún envío`, () => {
      abrirPuerta(new FakeSolanaCloseableEscrowLister([], "reject", mensaje));

      fireEvent.click(screen.getByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));

      return waitFor(() => {
        expect(screen.getByText(/no llegamos a preguntar/)).toBeInTheDocument();
        expect(screen.queryByText(/No encontramos envíos terminados/)).not.toBeInTheDocument();
        // Y tampoco el número: "los últimos 20 envíos" es contar lo que se miró, y no se miró nada.
        expect(
          screen.queryByText(new RegExp(`últimos ${MAX_CLOSEABLE_CANDIDATES} envíos`)),
        ).not.toBeInTheDocument();
      });
    });
  }

  it("sin lister cableado la puerta no se ofrece (no hay botón que no lleve a nada)", () => {
    render(<EscrowRentRecovery resolveSender={resolveSender} />);
    expect(
      screen.queryByRole("button", { name: /Recuperar el depósito de red/ }),
    ).not.toBeInTheDocument();
  });
});

describe("AC-8: qué se dice ANTES de abrir ningún diálogo de firma", () => {
  it("explica las DOS firmas y qué hace cada una, antes de cualquier acción", () => {
    abrirPuerta(new FakeSolanaCloseableEscrowLister([]));
    // La puerta está abierta y todavía no se apretó "Buscar": nada tocó la wallet.
    expect(screen.getByText(/es un texto, no mueve fondos y no paga comisión de red/)).toBeInTheDocument();
    expect(screen.getByText(/su comisión de red la pagás vos/)).toBeInTheDocument();
  });

  it("dice qué se recupera y qué NO, y NINGUNA cifra — porque acá todavía no hay envío", () => {
    abrirPuerta(new FakeSolanaCloseableEscrowLister([]));
    const texto = document.body.textContent ?? "";
    // 🔴 HU-079 — ACÁ DECÍA `toContain("0,0036")` Y AHORA DICE LO CONTRARIO, y el cambio es el corazón
    // de esta HU. La puerta de descubrimiento se monta ANTES de buscar nada, así que no hay UN envío
    // del que hablar; y aunque lo hubiera, una cifra ÚNICA para una LISTA es falsa por construcción: el
    // alquiler queda CONGELADO en las cuentas el día que se crean, y medido en devnet el 2026-09-04 los
    // 15 escrows vivos tenían DOS valores distintos (4.002.000 en 14 de ellos, 3.641.475 en 1).
    // Mostrar "0,0036" acá le prometía de MENOS a 14 de cada 15 personas.
    //
    // ⛔ Y NO SALE NINGUNA CIFRA, de ningún valor — no una cifra vieja, no un promedio, no un "desde".
    // Sale una FRASE: "cuánto exactamente depende de cada envío" (CD-079-5), que es un hecho distinto
    // de "no pudimos preguntarle a la red" y por eso se dice con otras palabras.
    expect(texto).not.toMatch(/\d,\d{4}/);
    expect(texto).toContain("depende de cada envío");
    expect(texto).not.toContain("no pudimos preguntarle a la red"); // ⛔ los dos hechos no se colapsan
    // Y la lista de ausencias, que ⛔ no perdió ninguna: cada cadena sigue señalando un error real, y
    // ahora "0,0036" y "0,0040" están las dos del lado de la ausencia porque acá NINGUNA es correcta.
    expect(texto).not.toContain("0,0036"); // el valor que la HU-077 congeló
    expect(texto).not.toContain("0,0040"); // 🔴 el valor de MAINNET del lado que se muestra: EL DEFECTO
    expect(texto).not.toContain("0,0037"); // ceil del alquiler que vuelve (formateador equivocado)
    expect(texto).not.toContain("0,0041"); // ceil del valor de mainnet. ⚠️ WKH-347: ya NO es también el umbral de depósito, que pasó a "0,0089"; la aserción sigue valiendo por el ceil
    expect(texto).not.toContain("0,0047"); // floor del alquiler del índice
    expect(texto).not.toContain("0,0048"); // ceil del mismo
    expect(texto).not.toContain("0,0084"); // floor de la suma con el índice, sobre el total NUEVO
    expect(texto).not.toContain("0,0085"); // ceil de la misma
    expect(texto).not.toContain("0,0087"); // floor de la suma con el índice, sobre el total viejo
    expect(texto).not.toContain("0,0088"); // ceil de la misma
    // Y nombra aparte la cuenta que NO se cierra.
    expect(screen.getByText(/tercera cuenta/)).toBeInTheDocument();
  });
});

/**
 * LA VOZ DE LA PUERTA (fix-pack CR/BLQ-BAJO-1).
 *
 * 🔴 EL INPUT QUE LO PONE ROJO ES EL MONTAJE, no una interacción. `escrowRentExplainer` está escrito
 * en la voz de UN envío concreto y ya terminado ("las dos cuentas de ese envío", "Este envío ya
 * terminó, así que se pueden cerrar"), y esa voz es correcta en `CloseEscrowAction`, donde hay un
 * `remittanceId`. La puerta lo montaba con el MISMO texto antes de que existiera ninguna selección:
 * afirmaba un hecho sobre una remesa que todavía no se había buscado. Y cuando el descubrimiento
 * fallaba, la pantalla decía las dos cosas a la vez — "Este envío ya terminó" y "no llegamos a
 * preguntar".
 *
 * Ningún test lo veía porque todos entraban por "Buscar": el defecto vive ANTES de apretar el botón.
 */
describe("la puerta no afirma nada sobre un envío que todavía no se buscó", () => {
  const CONCRETAS = ["Este envío ya terminó", "de ese envío"] as const;

  it("recién abierta, con el botón sin apretar, no hay ninguna frase de envío concreto", () => {
    // La lista tiene contenido a propósito: si algún día el componente buscara solo, este test
    // seguiría siendo sobre el montaje y no sobre una lista vacía.
    abrirPuerta(
      new FakeSolanaCloseableEscrowLister([{ remittanceId: "rem-x", status: "released" }]),
    );
    const texto = document.body.textContent ?? "";
    for (const frase of CONCRETAS) expect([frase, texto.includes(frase)]).toEqual([frase, false]);
    // Control positivo: el bloque explicativo SÍ está montado, o sea que los `false` de arriba no
    // pasan por una pantalla vacía.
    expect(texto).toContain("Recuperá tu depósito de red");
    // HU-079: el control positivo pasa a ser una frase y no una cifra, porque acá ya no hay ninguna.
    expect(texto).toContain("depende de cada envío");
  });

  // El caso B del hallazgo: el registro apagado es el camino de fallo MÁS probable (lo prende una
  // bandera de configuración, no una caída), y ahí la pantalla decía las dos cosas juntas.
  it("con el registro apagado dice 'no llegamos a preguntar' y NADA sobre un envío terminado", async () => {
    abrirPuerta(
      new FakeSolanaCloseableEscrowLister(
        [],
        "reject",
        "escrow_recovery_unavailable:registry_disabled",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));

    await screen.findByText(/no llegamos a preguntar/);
    const texto = document.body.textContent ?? "";
    for (const frase of CONCRETAS) expect([frase, texto.includes(frase)]).toEqual([frase, false]);
  });
});

/** Cuántas veces aparece `frase` en `texto`. `toContain` es insensible a la multiplicidad, que es
 *  exactamente lo que dejó pasar la duplicación de abajo. */
function veces(texto: string, frase: string): number {
  return texto.split(frase).length - 1;
}

/**
 * EL BLOQUE EXPLICATIVO, UNA SOLA VEZ (fix-pack CR/MNR-1).
 *
 * 🔴 POR QUÉ ESTE TEST USA TRES CERRABLES Y NO UNO. La puerta monta el explicativo, y `CloseEscrowAction`
 * lo montaba OTRA VEZ, una por envío de la lista: N+1 copias del mismo párrafo. Con el tope de 20
 * cerrables el mismo texto aparecía 21 veces. Ningún test lo veía porque todos usaban listas de 0 o 1
 * elemento —donde N+1 = 2 y nadie contaba— y `toContain`, que da verde con cualquier multiplicidad.
 * El input que lo pone rojo es una lista de VARIOS.
 */
describe("con varios cerrables, el explicativo no se repite una vez por envío", () => {
  it("tres cerrables ⇒ el párrafo aparece UNA vez, y los tres botones de cierre están", async () => {
    abrirPuerta(
      new FakeSolanaCloseableEscrowLister([
        { remittanceId: "rem-a", status: "released" },
        { remittanceId: "rem-b", status: "refunded" },
        { remittanceId: "rem-c", status: "released" },
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));
    await screen.findByText(/rem-c/);

    // Control positivo primero: los TRES envíos se ofrecen. Sin esto, un conteo de 1 podría venir de
    // que la lista no se renderizó, que es como un test de "no se repite" deja de probar nada.
    expect(screen.getAllByRole("button", { name: /Cerrar y recuperar/ })).toHaveLength(3);

    const texto = document.body.textContent ?? "";
    // Frases que están en LAS DOS voces del explicativo, así que el conteo detecta la duplicación
    // venga del lado que venga.
    for (const frase of [
      "Recuperá tu depósito de red",
      "la que guardó tus USDC",
      "depende de cada envío", // HU-079: era "0,0036"; la puerta ya no muestra ninguna cifra
      "Hay una tercera cuenta",
    ]) {
      expect([frase, veces(texto, frase)]).toEqual([frase, 1]);
    }
  });
});

/**
 * AC-7 CONTRA EL ÁRBOL REAL — el cambio de billetera entre "Buscar" y "Cerrar y recuperar"
 * (fix-pack AR/BLQ-BAJO-1).
 *
 * 🔴 POR QUÉ ACÁ NO HAY NINGÚN DOBLE DE BILLETERA, y es todo el punto. El guard de AC-7 recibía la
 * dirección conectada del llamador, y el único call-site de producción le pasaba
 * `connectedAddress: sender` — la MISMA variable. Su rama falsa no existía en producción, y los cuatro
 * tests que la ejercitaban construían el input a mano: probaban el doble, no el cableado. Inyectar acá
 * dos direcciones distintas sería repetir exactamente ese error con otra forma.
 *
 * Así que las DOS direcciones salen del mismo lugar del que salen en producción: el
 * `solanaWalletBridge` real, leído por el `SolanaWalletAdapter` real. La divergencia se produce del
 * único modo en que se produce de verdad — cambiando de cuenta en la wallet sin recargar la página.
 *
 * Y hay una razón concreta para que el adapter esté acá y no un doble: `getAddress()` NO sirve para
 * esto. Devuelve el cache de `connect()`, así que después del cambio de cuenta sigue contestando la
 * billetera vieja. Este test recorre ese cache (llama a `connect()` con A antes de cambiar a B), o sea
 * que se pondría rojo si el guard se apoyara en `getAddress()`.
 */
describe("AC-7 cableado: cambiar de billetera después de buscar NO ofrece una firma imposible", () => {
  const A = FAKE_SOLANA_BENEFICIARY;
  const B = OTRA_BILLETERA;

  /** Monta la puerta con el adapter REAL como fuente de "quién está conectado". */
  function montarConBridge(gw: FakeSolanaEscrowCloseGateway) {
    solanaWalletBridge.setState({ publicKey: A, connected: true });
    const adapter = new SolanaWalletAdapter();
    render(
      <EscrowRentRecovery
        lister={new FakeSolanaCloseableEscrowLister([{ remittanceId: "rem-x", status: "released" }])}
        close={new CloseEscrowAccounts(gw, adapter)}
        // La misma puerta que producción: `resolveSender` sale de la wallet, no de una constante del
        // test. Con el bridge ya conectado, `connect()` no abre ningún modal (lee el estado y cachea).
        resolveSender={() => adapter.connect()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Recuperar el depósito de red de envíos anteriores/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));
  }

  it("busco con A, cambio a B en la wallet, y el cierre se rechaza SIN llamar al gateway", async () => {
    const gw = new FakeSolanaEscrowCloseGateway();
    montarConBridge(gw);
    const cerrar = await screen.findByRole("button", { name: /Cerrar y recuperar/ });

    // La persona cambia de cuenta en Phantom. Nada re-renderiza la lista: `sender` sigue congelado en A.
    solanaWalletBridge.setState({ publicKey: B, connected: true });
    fireEvent.click(cerrar);

    await waitFor(() => {
      expect(screen.getByText(/Este envío se firmó con otra billetera/)).toBeInTheDocument();
    });
    // 🔴 La aserción que importa: CERO llamadas al gateway ⇒ cero diálogos de firma. Un guard que
    // avisara DESPUÉS de construir y pedir la firma pasaría el `getByText` de arriba igual.
    expect(gw.calls).toHaveLength(0);
  });

  it("control positivo: sin cambiar de billetera, el cierre SÍ llega al gateway con A", async () => {
    const gw = new FakeSolanaEscrowCloseGateway();
    montarConBridge(gw);
    const cerrar = await screen.findByRole("button", { name: /Cerrar y recuperar/ });

    fireEvent.click(cerrar);

    await waitFor(() => {
      expect(gw.calls).toEqual([{ remittanceId: "rem-x", sender: A }]);
    });
  });

  it("si la wallet se desconecta entre buscar y cerrar ⇒ 'reconectá', no 'es de otra billetera'", async () => {
    const gw = new FakeSolanaEscrowCloseGateway();
    montarConBridge(gw);
    const cerrar = await screen.findByRole("button", { name: /Cerrar y recuperar/ });

    solanaWalletBridge.setState({ publicKey: null, connected: false });
    fireEvent.click(cerrar);

    await waitFor(() => {
      expect(screen.getByText(/Reconectá o desbloqueá tu wallet/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Este envío se firmó con otra billetera/)).not.toBeInTheDocument();
    expect(gw.calls).toHaveLength(0);
  });
});
