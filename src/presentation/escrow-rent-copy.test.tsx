// @vitest-environment jsdom
//
// EL COPY DEL CIERRE DE CUENTAS (WKH-327 / AC-6, AC-7, AC-4).
//
// Lo que estos tests cuidan no es "que el texto exista": es que la CIFRA que la pantalla promete sea la
// del alquiler que de verdad vuelve, y no la de al lado.
//
// 🔴 POR QUÉ HAY ASERCIONES POR AUSENCIA Y NO SÓLO DE PRESENCIA. `formatLamportsAsSol` (el ceil) mapeaba
// DOS constantes distintas a la MISMA cadena "0,0041": el umbral de depósito (que entonces era 4.100.000)
// y el alquiler de las dos cuentas (4.002.000). O sea que un test que sólo assertara la presencia de un
// número pasa igual con la constante equivocada adentro, o con el formateador equivocado. Las tres
// aserciones por ausencia ("0,0041", "0,0048", "0,0088") son las que distinguen:
//   · "0,0041" aparece si se usó el ceil, o si se formateó el umbral en vez del alquiler;
//   · "0,0048" aparece si se mostró el alquiler del EscrowIndex;
//   · "0,0088" aparece si se sumó el índice al total.
//
// ⚠️ WKH-347 MOVIÓ EL UMBRAL A 8.874.560, o sea "0,0089", así que la colisión con "0,0041" YA NO EXISTE
// por sí sola. Las tres aserciones por ausencia siguen siendo válidas y NO se tocan: "0,0089" no está en
// esa lista, y las tres cadenas que enumeran siguen señalando errores reales. Lo que cambió es que una de
// las tres —"0,0041" por haber formateado el umbral— dejó de ser alcanzable por ESA vía en particular,
// mientras sigue siéndolo por la otra (haber usado el ceil sobre el alquiler). Se conserva por eso, y
// porque el umbral ya se movió tres veces y puede volver a acercarse.
//
// 🔴 POR QUÉ `within(...)` Y NO `document.body`. `humanError("solana_sender_sol_insufficient")` renderiza
// LEGÍTIMAMENTE la cifra del umbral de SOL (flow-vm.ts) — hoy "0,0089", antes de WKH-347 "0,0041". La
// razón del `within` no cambió con el número: una aserción de ausencia sobre todo el documento se pondría
// roja por algo que no tiene nada que ver con AC-6, y el arreglo "obvio" sería borrar la aserción, que es
// justo la que ataja el error que este archivo existe para atajar.
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { CloseEscrowAction, TrackView } from "./flow";
import {
  escrowCloseError,
  escrowCloseSentCopy,
  escrowRentExplainer,
} from "./flow-vm";
import { CloseEscrowAccounts } from "../application/use-cases/close-escrow-accounts";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeConnectedWallet,
  FakeSolanaEscrowCloseGateway,
  FakeSolanaRentReader,
} from "../test-support/fakes";
import type { RemittanceState } from "../domain/remittance";

afterEach(cleanup);

const sender = FAKE_SOLANA_BENEFICIARY;
const OTRA_BILLETERA = "8tJVcM2JmYcMNCcNFYtUpXVWvKNTfnrCEwLuTRHpF9dQ";

function useCase(): CloseEscrowAccounts {
  // Este archivo va sobre el COPY: la billetera conectada es la del remitente para que el camino no
  // se corte antes de renderizar nada. Que el guard vea de verdad la billetera viva se prueba en
  // `escrow-rent-recovery.test.tsx`, contra el bridge real.
  return new CloseEscrowAccounts(new FakeSolanaEscrowCloseGateway(), new FakeConnectedWallet(sender));
}

// 🔴 HU-079 — LOS DOS PARES VIVOS DE DEVNET, medidos cuenta por cuenta con `getAccountInfo` el
// 2026-09-04, y los dos TODAVÍA ABIERTOS. Son la razón de que esta pantalla ya no pueda mostrar UNA
// cifra: el alquiler queda CONGELADO en las cuentas el día que se crean, así que dos escrows de la
// MISMA cadena devuelven distinto y ninguna constante puede acertarle a los dos.
const PAR_VIVO_MAYORITARIO = 4_002_000; // 14 de los 15 escrows vivos ⇒ "0,0040"
const PAR_VIVO_MINORITARIO = 3_641_475; // 1 de los 15 ⇒ "0,0036" — el valor que la HU-077 congeló

/** El subárbol del componente de cierre, y NADA más del documento (ver la cabecera). */
function subarbolDelCierre(): HTMLElement {
  return screen.getByTestId("close-escrow-action");
}

function remesa(overrides: Partial<RemittanceState> = {}): RemittanceState {
  return {
    id: "rem-1",
    status: "settled",
    version: 1,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ownerAddress: sender,
    // El camino optimista de TrackView renderiza `PayoutInProgress`, que lee `rem.beneficiary.name`:
    // sin esto el test de AC-4 se cae por una razón que no tiene nada que ver con AC-4.
    beneficiary: {
      name: "Rosa Quispe",
      country: "PE",
      method: "bank_cci",
      destination: "00212345678901234567",
    },
    ...overrides,
  } as RemittanceState;
}

describe("AC-6: la cifra que se promete es la del alquiler que vuelve, no la de al lado", () => {
  it("T-079-D1: muestra la cifra QUE LA CADENA DEVOLVIÓ y ninguna de las cadenas equivocadas", async () => {
    render(
      <CloseEscrowAction
        remittanceId="rem-1"
        sender={sender}
        close={useCase()}
        explainer="own"
        rent={new FakeSolanaRentReader(PAR_VIVO_MAYORITARIO)}
      />,
    );
    const card = within(await screen.findByText(/0,0040/));
    expect(card).toBeDefined();

    const texto = subarbolDelCierre().textContent ?? "";
    // ⚠️ QUÉ CUBRE ESTA LISTA Y QUÉ NO — la versión corregida de una frase que afirmaba de más
    // (AR/MNR-1). Los números que enumera se assertan en SUS DOS grafías, la del ceil y la del floor,
    // y eso costó un mutante que sobrevivió: la lista original ("0,0041", "0,0048", "0,0088") salía de
    // la tabla medida con `formatLamportsAsSol` (ceil), la implementación usa el FLOOR, y con el floor
    // el índice se escribe "0,0047" y la suma "0,0087". Un mutante que AGREGABA la suma del índice
    // formateada con el floor pasó los cinco `not.toContain` de la lista vieja en verde.
    //
    // 🔴 LO QUE ESTA LISTA NO PUEDE CERRAR, medido y declarado: la BANDA. Con floor y 4 decimales,
    // TODO el intervalo [3.600.000, 3.699.999] se escribe "0,0036" (antes de HU-077 la banda era
    // [4.000.000, 4.099.999] ⇒ "0,0040"), así que ningún assert de ESTE archivo sobre el TEXTO puede
    // distinguir el alquiler de un valor vecino dentro de la banda, ni derivando el literal de la
    // propia expresión (los dos lados del assert se moverían juntos). ⚠️ HISTORIA, NO ESTADO ACTUAL
    // (fix-pack AR/MNR-2): acá se leía «mutante aplicado de verdad (`ESCROW_DEPOSIT_RENT_LAMPORTS +
    // 5_000`): SOBREVIVE la suite completa, 1297/0». Esa constante YA NO EXISTE (HU-077 la partió en
    // `_RETURNED_`/`_CHARGED_`) y el 1297 es de una suite que hoy colecta 3523 tests. Re-medido el
    // 2026-09-03 con su equivalente vivo, +5.000 sobre la hoja `ESCROW_STATE_RENT_DEVNET_LAMPORTS`:
    // YA NO SOBREVIVE — 3 rojos propios (4 menos el del IDL, que es ambiental), y quien lo mata es T-077-2 (1) en `solana-escrow-rent.test.ts`, con `expected 3646475 to be 3641475`: la constante contra el oráculo en cadena. O sea que la banda sigue abierta para las aserciones de TEXTO de acá, y está cerrada para la SUITE por un test de VALOR EXACTO que vive en otro archivo. Lo que sigue sin red es una futura "mejora" que le sume la comisión a la cifra.
    //
    // 🔴 HU-077 — LA LISTA SE RE-DERIVÓ Y PASÓ DE 5 A 7 CADENAS. ⛔ NO se borró ninguna de las viejas:
    // cada una sigue señalando un error real, y el propio archivo ya explica arriba (`:17-22`) por qué
    // conserva cadenas cuya vía de aparición se cerró. Lo que se agrega:
    //   · "0,0040" es EL DEFECTO DE ESTA HU: el valor de MAINNET (4.002.000) en el lado que se muestra.
    //     Hasta hoy era la cifra que la pantalla prometía, y por eso vivía en la aserción de PRESENCIA.
    //   · "0,0037" es el ceil del alquiler NUEVO ⇒ formateador equivocado. Reemplaza EN FUNCIÓN a
    //     "0,0041", que se conserva igual porque sigue siendo el ceil del valor de mainnet.
    //   · "0,0084" / "0,0085" son la suma con el índice sobre el total NUEVO (3.641.475 + 4.774.560 =
    //     8.416.035), floor y ceil. Las viejas "0,0087"/"0,0088" son esa misma suma sobre el total
    //     viejo, y también se conservan.
    // 🔴 HU-079 — LA LISTA SE RE-DERIVÓ OTRA VEZ, Y "0,0040" TUVO QUE SALIR DE ELLA. No es un
    // ablandamiento y conviene decir exactamente por qué: "0,0040" era el defecto de la HU-077 —el
    // valor de MAINNET congelado en el lado que se muestra— y hoy es LA RESPUESTA CORRECTA para 14 de
    // los 15 escrows vivos, que es justo lo que este fixture monta. Una cadena no puede estar a la vez
    // prohibida y ser lo que la pantalla debe decir. Lo que reemplaza esa cobertura, y es más fuerte,
    // es el `it` de abajo: con el OTRO par vivo la pantalla dice "0,0036" y "0,0040" NO aparece — o
    // sea que ahora se vigila la DEPENDENCIA (dos entradas, dos salidas) y no una constante.
    //   · Entra "0,0036": el valor que la HU-077 congeló. Con la cifra leída del parámetro, verlo acá
    //     con el par MAYORITARIO significa que alguien volvió a congelarla.
    //   · Entra "0,0034": el floor del `EscrowIndex` de devnet HOY (3.484.880) ⇒ sumar el índice.
    expect(texto).not.toContain("0,0036"); // 🔴 el valor que la 077 congeló, ahora prohibido como literal
    expect(texto).not.toContain("0,0034"); // floor del EscrowIndex de devnet hoy ⇒ se sumó el índice
    expect(texto).not.toContain("0,0037"); // ceil del alquiler que vuelve (formateador equivocado)
    expect(texto).not.toContain("0,0041"); // ceil del valor de mainnet, y antes también el umbral
    expect(texto).not.toContain("0,0048"); // ceil del alquiler del EscrowIndex
    expect(texto).not.toContain("0,0047"); // floor del mismo
    expect(texto).not.toContain("0,0085"); // ceil de la suma con el índice, sobre el total NUEVO
    expect(texto).not.toContain("0,0084"); // floor de la misma
    expect(texto).not.toContain("0,0088"); // ceil de la suma con el índice, sobre el total viejo
    expect(texto).not.toContain("0,0087"); // floor de la misma
    expect(texto).not.toContain("4.774.560"); // el índice en lamports
    expect(texto).not.toContain("4774560");
  });

  it("nombra LAS DOS cuentas que se cierran, no 'tu alquiler' a secas (CD-3)", () => {
    render(<CloseEscrowAction remittanceId="rem-1" sender={sender} close={useCase()} explainer="own" rent={new FakeSolanaRentReader(PAR_VIVO_MAYORITARIO)} />);
    const texto = subarbolDelCierre().textContent ?? "";
    expect(texto).toContain("dos cuentas");
    expect(texto).toContain("la del contrato");
    expect(texto).toContain("la que guardó tus USDC");
  });

  it("menciona APARTE la tercera cuenta que NO se cierra y cuyo depósito no vuelve", () => {
    render(<CloseEscrowAction remittanceId="rem-1" sender={sender} close={useCase()} explainer="own" rent={new FakeSolanaRentReader(PAR_VIVO_MAYORITARIO)} />);
    const texto = subarbolDelCierre().textContent ?? "";
    expect(texto).toContain("tercera cuenta");
    expect(texto).toContain("índice");
    expect(texto).toContain("no vuelve");
    // Y NO la suma a la cifra: eso es lo que asserta el test de arriba por ausencia de "0,0088".
  });

  // LAS DOS voces, no una: el fix de CR/BLQ-BAJO-1 partió el `body` en "discovery" y "remittance", y
  // una promesa de neto que se colara en la voz nueva no la vería un test que sólo mira la vieja.
  it.each(["discovery", "remittance"] as const)(
    "voz %s: NO promete un neto, dice que hay comisión y que no sabemos cuánto (CD-3)",
    (voice) => {
      const { body } = escrowRentExplainer(voice, { status: "known", lamports: PAR_VIVO_MINORITARIO });
      expect(body).toContain("comisión");
      expect(body).toContain("no lo sabemos de antemano");
      // Y las dos nombran LAS DOS cuentas y la cifra del floor, que son hechos del mecanismo.
      expect(body).toContain("la que guardó tus USDC");
      expect(body).toContain("0,0036"); // el floor del par que se le PASÓ, no una constante del módulo
    },
  );

  // 🔴 El hallazgo, clavado en la función y no sólo en la pantalla: la voz de la PUERTA no puede
  // afirmar nada sobre un envío, porque cuando se monta todavía no se buscó ninguno.
  it("la voz 'discovery' no afirma que ningún envío haya terminado; la 'remittance' sí puede", () => {
    expect(escrowRentExplainer("discovery", { status: "no-escrow" }).body).not.toContain("Este envío ya terminó");
    expect(escrowRentExplainer("discovery", { status: "no-escrow" }).body).not.toContain("de ese envío");
    // Control positivo: la afirmación existe y vive donde SÍ hay un envío elegido.
    expect(escrowRentExplainer("remittance", { status: "unknown" }).body).toContain("Este envío ya terminó");
  });

  // 🔴 T-079-D1 (2ª mitad) — LA DEPENDENCIA, EN LA PANTALLA Y NO SÓLO EN LA FUNCIÓN. Es lo que
  // reemplaza —con más fuerza— al `not.toContain("0,0040")` que la lista de ausencias tuvo que soltar:
  // el MISMO componente, con dos lecturas distintas, pinta dos cifras distintas. Ninguna constante
  // congelada, de ningún valor, puede pasar los dos `it` a la vez.
  it("T-079-D1: con el OTRO par vivo la pantalla dice 0,0036, y 0,0040 NO aparece", async () => {
    render(
      <CloseEscrowAction
        remittanceId="rem-1"
        sender={sender}
        close={useCase()}
        explainer="own"
        rent={new FakeSolanaRentReader(PAR_VIVO_MINORITARIO)}
      />,
    );
    await screen.findByText(/0,0036/);
    const texto = subarbolDelCierre().textContent ?? "";
    expect(texto).toContain("0,0036");
    expect(texto).not.toContain("0,0040"); // ⛔ la cifra del OTRO par: acá sería un valor congelado
  });

  // 🔴 T-079-D2 — EL `it` QUE ATACA `CD-079-4` DE FRENTE. Con el lector que RECHAZA, la tarjeta NO
  // muestra NINGUNA cifra y dice la frase de `unknown`. ⛔ Un fallback a un literal en el `catch` del
  // efecto pondría acá una cifra con cara de dato y la pantalla se vería NORMAL — el fail-open de esta
  // HU no es una excepción visible, es una promesa silenciosa de más.
  it("T-079-D2: con el lector que RECHAZA no sale ninguna cifra, y se dice cuál es el hecho", async () => {
    render(
      <CloseEscrowAction
        remittanceId="rem-1"
        sender={sender}
        close={useCase()}
        explainer="own"
        rent={new FakeSolanaRentReader(PAR_VIVO_MAYORITARIO, "reject")}
      />,
    );
    await screen.findByText(/no pudimos preguntarle a la red/);
    const texto = subarbolDelCierre().textContent ?? "";
    expect(texto).toMatch(/no pudimos preguntarle a la red/);
    expect(texto).not.toMatch(/\d,\d{4}/); // ⛔ NINGUNA cifra de SOL, de ningún valor
    expect(texto).not.toContain("depende de cada envío"); // ⛔ CD-079-5: no es el otro hecho
  });

  // Y el colaborador AUSENTE —no un fallo, sino un montaje que no lo cablea— cae en el MISMO estado
  // `unknown`, nunca en un literal. Es el caso que un `?` en el container haría invisible.
  it("T-079-D2b: sin lector cableado tampoco sale ninguna cifra", async () => {
    render(<CloseEscrowAction remittanceId="rem-1" sender={sender} close={useCase()} explainer="own" />);
    const texto = (await screen.findByTestId("close-escrow-action")).textContent ?? "";
    expect(texto).toMatch(/no pudimos preguntarle a la red/);
    expect(texto).not.toMatch(/\d,\d{4}/);
  });
});

describe("AC-4 / AC-7: cuándo NO se ofrece la acción", () => {
  const noop = () => {};

  it("AC-7: la remesa es de OTRA billetera ⇒ el botón no está en el documento", () => {
    render(
      <TrackView
        rem={remesa({ ownerAddress: OTRA_BILLETERA })}
        closeEscrow={useCase()}
        sender={sender}
        onRecovered={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /Cerrar y recuperar/ })).not.toBeInTheDocument();
  });

  it("AC-4: la remesa NO está en un estado terminal ⇒ el botón no está en el documento", () => {
    render(
      <TrackView
        rem={remesa({ status: "payout_submitted" })}
        closeEscrow={useCase()}
        sender={sender}
        onRecovered={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /Cerrar y recuperar/ })).not.toBeInTheDocument();
  });

  // El caso que hay que mirar dos veces: un envío que falló puede tener el principal TODAVÍA adentro
  // del escrow (Deposited en cadena), que es justo lo que `close` rechaza.
  it("AC-4: payout_failed tampoco ofrece el cierre (el principal puede seguir en el escrow)", () => {
    render(
      <TrackView
        rem={remesa({ status: "payout_failed" })}
        closeEscrow={useCase()}
        sender={sender}
        onRecovered={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /Cerrar y recuperar/ })).not.toBeInTheDocument();
  });

  it("AC-7: sin billetera conectada ⇒ el botón no está en el documento", () => {
    render(
      <TrackView rem={remesa()} closeEscrow={useCase()} sender={null} onRecovered={noop} />,
    );
    expect(screen.queryByRole("button", { name: /Cerrar y recuperar/ })).not.toBeInTheDocument();
  });

  // El control positivo: sin él, los cuatro `not.toBeInTheDocument()` de arriba pasarían igual si el
  // botón no se montara NUNCA — que es como un test de ausencia deja de probar nada.
  it("control positivo: remesa terminal + billetera del dueño ⇒ el botón SÍ está", () => {
    render(
      <TrackView rem={remesa()} closeEscrow={useCase()} sender={sender} onRecovered={noop} />,
    );
    expect(screen.getByRole("button", { name: /Cerrar y recuperar/ })).toBeInTheDocument();
  });
});

describe("qué dice y qué NO dice el desenlace", () => {
  // CD-15: la ausencia de `escrow_state` prueba que las cuentas se cerraron y NADA MÁS. No dice a
  // dónde fue la plata, así que el copy del éxito no puede nombrar los USDC.
  it("el copy de éxito NO menciona los USDC", () => {
    expect(escrowCloseSentCopy("confirmed")).not.toContain("USDC");
  });

  it("pending y unknown se dicen distinto: uno es 'todavía no', el otro es 'no pudimos preguntar'", () => {
    expect(escrowCloseSentCopy("pending")).toContain("todavía no nos confirma");
    expect(escrowCloseSentCopy("unknown")).toContain("no pudimos preguntarle a la red");
    expect(escrowCloseSentCopy("pending")).not.toBe(escrowCloseSentCopy("unknown"));
  });

  // `escrow_account_absent` NO es un error: o ya se cerraron, o nunca se crearon, y en las dos no pasó
  // nada malo. Decir "error" manda a buscar un problema que no existe.
  it("escrow_account_absent no se dice como un fallo: sin 'error' ni 'no pudimos'", () => {
    const copy = escrowCloseError("escrow_account_absent");
    expect(copy).not.toContain("error");
    expect(copy).not.toContain("no pudimos");
    expect(copy).toContain("ya se cerraron");
    expect(copy).toContain("nunca llegaron a crearse");
  });

  it("escrow_index_probe_failed dice que NO se firmó nada (es lo que la persona necesita saber)", () => {
    const copy = escrowCloseError("escrow_index_probe_failed");
    expect(copy).toContain("no firmamos nada");
    expect(copy).toContain("No se movió nada de tu billetera");
  });

  it("escrow_not_terminal NO afirma dónde están los USDC", () => {
    expect(escrowCloseError("escrow_not_terminal")).toContain("no dice dónde están tus USDC");
  });

  it("close_not_sender manda a conectar la billetera que pagó, sin nombrarla", () => {
    const copy = escrowCloseError("close_not_sender");
    expect(copy).toContain("otra billetera");
    expect(copy).not.toContain(sender); // PII-free: nunca se interpola una address
  });
});
