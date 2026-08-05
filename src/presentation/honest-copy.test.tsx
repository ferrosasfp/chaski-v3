// @vitest-environment jsdom
//
// EL BARRIDO DE COPY HONESTO — un test por frase reescrita.
//
// POR QUÉ EXISTE ESTE ARCHIVO. El arreglo del aviso de "no hay wallet en este navegador" destapó que
// el problema no era una frase: era un patrón. Varias frases del recorrido afirmaban cosas que la app
// no puede saber, y ninguna tenía un test que las matara, así que cualquiera podía reescribirlas de
// vuelta sin que nada se pusiera rojo.
//
// EL CRITERIO QUE SE APLICA, y con el que hay que leer cada test de acá: cada oración tiene que ser
// falsable con un input concreto. Si no se puede escribir "esta frase sería falsa si pasara X",
// entonces afirma de más. Los tests no assertean el texto lindo: assertean que la frase VIEJA (la que
// afirmaba de más) no volvió, y que la nueva sigue diciendo lo que la app sí sabe.
//
// Tres patrones aparecieron una y otra vez, y cada `it` de acá mata uno:
//   · afirmar sobre el DISPOSITIVO o sobre un TERCERO que nadie consultó ("no tenés X instalado",
//     "estamos hablando con Didit" cuando el KYC está simulado);
//   · prometer un FUTURO que el sistema no puede cumplir ("te reembolsamos", "llega en 30 min"
//     cuando el paso lo destraba una persona a mano);
//   · elegir UNA de varias posibilidades cuando la condición que prende el texto no las distingue
//     ("el desembolso es simulado" desde un OR de tres proveniencias).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RemittanceFlow, TrackView } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { CUSTODY_WINDOW_SECS } from "../infrastructure/solana-wallet";
import { Money } from "../domain/money";
import { Remittance, type RemittanceState, toPersistedIdentity } from "../domain/remittance";
import { RecoverEscrowFunds } from "../application/use-cases/recover-escrow-funds";
import type { ResumeKyc } from "../application/use-cases/resume-kyc";
import {
  FakeKycGateway,
  FakeSolanaEscrowRefundGateway,
  FixedClock,
  InMemoryRepo,
  T0,
  beneficiary,
} from "../test-support/fakes";
import {
  KYC_PROVENANCE_LIVE,
  KYC_PROVENANCE_MOCK,
} from "../infrastructure/didit/decision";

// CD-8 / DT-7: framer-motion pass-through (mismo mock que flow.test.tsx). jsdom no implementa
// requestAnimationFrame y sin esto los steps del flujo nunca montan.
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
          React.createElement(tag, props, children),
    },
  ),
}));

afterEach(() => cleanup());

function fillSend(): void {
  fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), {
    target: { value: "Mamá" },
  });
  fireEvent.change(screen.getByPlaceholderText("999 888 777"), { target: { value: "999888777" } });
}

/** send → connect (la pantalla de conectar wallet). */
function irAConectar(): void {
  render(<RemittanceFlow container={buildTestContainer()} />);
  fillSend();
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
}

/** send → connect → review (con el quote ya fijado). */
async function irARevisar(): Promise<void> {
  irAConectar();
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
  await screen.findByText(/Revisá el envío/);
}

/**
 * send → connect → review → verify → confirm, con la proveniencia de KYC que se le pida.
 *
 * `provenance` va como `string | undefined` A PROPÓSITO y sin default: `undefined` es uno de los casos
 * que hay que probar (una decisión que llega sin declarar de dónde salió), y un default lo taparía.
 *
 * La cotización la da `FakeQuoteGateway` (`provenance: "fake"`), que NO es `local-fallback`: la pata
 * del quote queda apagada en los cuatro casos, así que lo único que puede prender el sello acá es la
 * pata del KYC. Es lo que hace que estos tests midan lo que dicen medir.
 */
async function irAConfirmarConKyc(provenance: string | undefined): Promise<void> {
  render(
    <RemittanceFlow container={buildTestContainer({ kyc: new FakeKycGateway({ provenance }) })} />,
  );
  fillSend();
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
  await screen.findByText(/Revisá el envío/);
  fireEvent.click(await screen.findByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Escanear DNI \+ selfie/ }));
  await screen.findByRole("button", { name: /Confirmar y enviar/ });
}

/** Una remesa en `payout_failed` SIN reason conocido: el caso que cae al copy genérico de payout. */
function remesaConFalloDesconocido(): RemittanceState {
  const r = Remittance.create("rem-honest", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(
    {
      quoteId: "q",
      send: Money.of(400, "USDC"),
      receive: Money.of(1478.15, "PEN"),
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.7,
      etaMinutes: 30,
      expiresAt: "2099-01-01T00:00:00.000Z",
      provenance: "didit",
    },
    T0,
  );
  r.startKyc(T0, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  r.applyKyc(
    {
      verificationId: "v-1",
      approved: true,
      payoutAllowed: true,
      riskLevel: "low",
      provenance: "didit",
      identity: toPersistedIdentity({
        firstName: "Test",
        lastNamePaternal: "Quispe",
        lastNameMaternal: "Mamani",
        documentType: "DNI",
        documentNumber: "12345678",
        dateOfBirth: "1990-01-01",
        nationality: "PE",
      }),
    },
    T0,
  );
  r.confirm(T0);
  r.markPrincipalIn("0xp", T0);
  r.markPayoutSubmitted("p1", T0, "transfi");
  // Un reason que NINGUNA rama de TrackView reconoce ⇒ cae al copy genérico de `payout`.
  r.markPayoutFailed("un_reason_que_nadie_mapea", T0);
  return r.snapshot;
}

// ── 1. La pantalla de conectar: dónde queda la plata ─────────────────────────────────────────────
//
// "Chaski nunca toca tu plata, solo la dirige" es un absoluto, y hay quien lo falsifica: el escrow
// tiene una release-authority operada por el equipo, que puede liberar el vault hacia el pago
// (confirm-and-send.ts:190-196). O sea que Chaski SÍ puede mover esos USDC.
//
// Lo verificable, y lo que de verdad hace a esto no custodial, es DÓNDE quedan: en una cuenta del
// contrato (ATA de la PDA `escrow_state`, solana-wallet.ts:288), nunca en una billetera de Chaski.
describe("conectar wallet", () => {
  it("no promete que Chaski nunca toca la plata; dice dónde queda", async () => {
    irAConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });

    expect(screen.getByText(/Tus USDC van a un contrato en Solana, no a una cuenta de Chaski/))
      .toBeInTheDocument();
    expect(screen.queryByText(/nunca toca tu plata/i)).toBeNull();
    expect(screen.queryByText(/solo la dirige/i)).toBeNull();
  });
});

// ── 2. El paso de identidad: quién verifica y qué se comparte ────────────────────────────────────
//
// Dos frases distintas, un mismo error.
//  · "Lo hace Didit, un verificador certificado": con `DIDIT_ENV=mock` NO lo hace Didit, lo hace
//    `/kyc-simulado`, una página nuestra que no verifica nada, y esa es la configuración con la que
//    se recorre la demo. La pantalla no puede distinguir las dos (el navegador no ve `DIDIT_ENV` y
//    todavía no existe ninguna decisión con `provenance`), así que dice menos en vez de elegir mal.
//  · "Tus datos no se comparten": sin decir con quién, no hay input que la falsee ni que la cumpla.
//    El límite que SÍ está probado es que el body hacia los agentes no lleva `kyc` ni `identity`
//    (gateway-client.test.ts, T-A6.1).
describe("paso de identidad", () => {
  it("no nombra al verificador como un hecho ni promete un 'no se comparte' sin destinatario", async () => {
    await irARevisar();
    fireEvent.click(await screen.findByRole("button", { name: /Continuar/ }));
    await screen.findByRole("button", { name: /Escanear DNI \+ selfie/ });

    expect(
      screen.getByText(/no se comparten con los agentes que cotizan y pagan/),
    ).toBeInTheDocument();
    // La frase vieja, entera y por partes.
    expect(screen.queryByText(/Tus datos no se comparten\./)).toBeNull();
    expect(screen.queryByText(/verificador certificado/i)).toBeNull();
    expect(screen.queryByText(/Lo hace/)).toBeNull();
  });
});

// ── 3. El tiempo de llegada ──────────────────────────────────────────────────────────────────────
//
// "llega en ~30 min" prometía una entrega que este sistema no puede cumplir HOY: la release del vault
// la dispara una persona a mano, y la propia pantalla de seguimiento avisa que "puede quedarse acá un
// buen rato". Dos frases de la misma app no pueden contar dos historias.
//
// El número no se borra (es un dato del corredor y sirve para comparar): se le pone dueño.
describe("el tiempo de llegada", () => {
  it("el preview del monto atribuye el estimado al corredor, no lo promete Chaski", async () => {
    render(<RemittanceFlow container={buildTestContainer()} />);
    fireEvent.change(await screen.findByLabelText("Monto en dólares"), { target: { value: "400" } });

    expect(await screen.findByText(/el corredor estima ~\d+/)).toBeInTheDocument();
    expect(screen.queryByText(/llega en ~/i)).toBeNull();
  });

  it("la fila del review tampoco afirma una llegada", async () => {
    await irARevisar();

    expect(screen.getByText("Estimado del corredor")).toBeInTheDocument();
    expect(screen.queryByText("Llega en")).toBeNull();
  });
});

// ── 4. El mínimo enviable ────────────────────────────────────────────────────────────────────────
//
// "la comisión se lleva todo y tu familia no recibiría nada" tiene un input concreto que la falsea:
// con $4 (por debajo del mínimo de $5) y una comisión de medio dólar quedan $3,50, y la familia
// recibiría unos S/13. La aritmética sólo da cero bien abajo del mínimo, y el texto la afirmaba para
// todo el rango. Lo que sí vale en todo el rango es lo que el efecto hace: no pedir cotización.
describe("el mínimo enviable", () => {
  it("no afirma que la comisión se lleve todo: dice lo que la app efectivamente hace", async () => {
    render(<RemittanceFlow container={buildTestContainer()} />);
    fireEvent.change(await screen.findByLabelText("Monto en dólares"), { target: { value: "4" } });
    fillSend();

    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent("Por debajo de eso no cotizamos el envío");
    expect(alerta).not.toHaveTextContent(/se lleva todo/i);
    expect(alerta).not.toHaveTextContent(/no recibiría nada/i);
    // Y el efecto que la frase describe sigue siendo cierto: el botón no habilita.
    expect(screen.getByRole("button", { name: /Continuar/ })).toBeDisabled();
  });
});

// ── 5. El fallo de entrega que no reconocemos ────────────────────────────────────────────────────
//
// El copy genérico de `payout` decía "Si te cobramos, te reembolsamos" y es el ÚLTIMO recurso de
// TrackView para cualquier `payout_failed` con un reason que no mapea: el caso donde menos se sabe
// dónde está la plata era justo donde se prometía devolverla. Nada en este repo devuelve nada solo
// (LedgerRefundGateway responde `refundTx: null`, y sin comprobante real no se escribe `refunded`).
describe("payout_failed con un reason desconocido", () => {
  it("no promete un reembolso: nombra la salida que sí existe", () => {
    render(
      <TrackView
        rem={remesaConFalloDesconocido()}
        recover={undefined}
        sender={null}
        onRecovered={() => {}}
      />,
    );

    expect(screen.getByText(/No hay un reembolso automático/)).toBeInTheDocument();
    expect(screen.getByText(/los sacás vos firmando desde tu wallet/)).toBeInTheDocument();
    expect(screen.queryByText(/te reembolsamos/i)).toBeNull();
  });
});

// ── 6. La ventana para recuperar ─────────────────────────────────────────────────────────────────
//
// El "2 horas" estaba escrito a mano al lado de la constante que lo decide. Hoy coincidía; el día que
// alguien mueva `CUSTODY_WINDOW_SECS` la frase pasa a ser falsa y nada se pone rojo. Es exactamente
// cómo nació la hora inventada que esta pantalla ya tuvo que arreglar una vez.
//
// El test compara contra la constante IMPORTADA, no contra un 2 escrito acá: así prueba el cableado.
describe("la ventana para recuperar los fondos", () => {
  it("el plazo sale de la MISMA constante que fija el deadline del depósito", () => {
    render(
      <TrackView
        rem={remesaConFalloDesconocido()}
        recover={
          new RecoverEscrowFunds(
            new InMemoryRepo(),
            new FixedClock(T0),
            new FakeSolanaEscrowRefundGateway(),
          )
        }
        sender="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
        onRecovered={() => {}}
      />,
    );

    const horas = CUSTODY_WINDOW_SECS / 3600;
    expect(screen.getByText(new RegExp(`dura unas ${horas} horas`))).toBeInTheDocument();
  });
});

// ── 7. El overlay que retoma la verificación ─────────────────────────────────────────────────────
//
// "Estamos confirmando tu verificación con Didit" nombra a un tercero que, con `DIDIT_ENV=mock`,
// nadie llamó: la persona vuelve de `/kyc-simulado`, que es una página nuestra. Y es la configuración
// con la que se recorre la demo. Esta pantalla no puede distinguir las dos (el navegador no ve
// `DIDIT_ENV`), así que dice lo que vale en las dos.
describe("el overlay que retoma la verificación", () => {
  it("no dice con quién estamos hablando, porque en la demo no hablamos con nadie", async () => {
    const container = buildTestContainer({
      useCases: {
        resumeKyc: {
          execute: async () => ({ kind: "processing" as const }),
        } as unknown as ResumeKyc,
      },
    });
    render(<RemittanceFlow container={container} />);

    expect(await screen.findByText(/Estamos confirmando tu verificación\. Un segundo\./)).toBeInTheDocument();
    expect(screen.queryByText(/con Didit/)).toBeNull();
  });
});

// ── 8. La tarjeta de quién atiende el envío ──────────────────────────────────────────────────────
//
// "Ninguno de estos pasos está atado a una empresa fija" queda desmentido por el detalle de cada
// fila: la que dice "hoy se llama directo" ES un paso cableado a un agente concreto. La frase de
// arriba pasa a describir el modelo sin afirmar que hoy los tres corran por ahí, que es justo lo que
// cada fila responde una por una.
describe("la tarjeta de quién atiende el envío", () => {
  it("no niega que hoy haya pasos cableados: eso lo responde cada fila", async () => {
    const steps = [
      {
        capability: "fx.quote",
        label: "Cotización",
        agent: {
          id: "remit-corridor-fx",
          description: "",
          priceUsdc: 0.5,
          verified: false,
          registry: "wasiai",
        },
        transport: "punto-a-punto" as const,
        // Quién corre hoy, dicho por el server. Acá coincide con el del catálogo.
        runsTodayAgentId: "remit-corridor-fx",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ steps, totalUsdc: 0.5 }) })),
    );
    try {
      await irARevisar();

      expect(await screen.findByText(/Chaski pide capacidades, no empresas/)).toBeInTheDocument();
      expect(screen.queryByText(/Ninguno de estos pasos está atado a una empresa fija/)).toBeNull();
      // La fila sigue diciendo la verdad incómoda que la frase de arriba negaba.
      expect(screen.getByText(/Hoy se llama directo a remit-corridor-fx/)).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── 9. Sin em dashes en el copy que ve la persona ────────────────────────────────────────────────
//
// La preferencia del founder ya estaba fijada para el bloque del aviso de wallet (T-UI-2). Se extiende
// al recorrido entero, que es donde se van a escribir las próximas frases.
describe("estilo del copy", () => {
  it("ninguna pantalla del recorrido mete un em dash", async () => {
    await irARevisar();
    expect(document.body.textContent ?? "").not.toContain("—");

    fireEvent.click(await screen.findByRole("button", { name: /Continuar/ }));
    await screen.findByRole("button", { name: /Escanear DNI \+ selfie/ });
    expect(document.body.textContent ?? "").not.toContain("—");

    // `confirm` faltaba, y es donde se acaba de escribir la tarjeta de identidad (sección 10).
    fireEvent.click(screen.getByRole("button", { name: /Escanear DNI \+ selfie/ }));
    await screen.findByRole("button", { name: /Confirmar y enviar/ });
    expect(document.body.textContent ?? "").not.toContain("—");
  });
});

// ── 10. La identidad del paso `confirm`, y el sello que no se prendía ────────────────────────────
//
// EL BUG, tal cual lo iba a ver el founder recorriendo la demo: con `DIDIT_ENV=mock` la decisión llega
// con `provenance: "didit-mock"` (decision.ts:22 y :91), pero `isDemoMode` sólo reconocía como
// simulado el literal `"local-fallback"`. En `confirm` todavía no existe `payoutProvenance`, así que
// no había nada más que prendiera el OR: la pantalla escribía "Identidad verificada: María Elena
// Quispe Mamani · DNI ••••6677" sobre datos inventados, SIN un solo sello de demo. Un revisor que ve
// eso concluye que la app da por buena una identidad falsa.
//
// LA DIRECCIÓN ES LA MITAD DEL ARREGLO. La detección vieja era "es demo si la proveniencia es
// exactamente este valor conocido", o sea que todo lo desconocido se leía como REAL. Ahora es una
// allowlist (`REAL_KYC_PROVENANCES`, misma dirección que `REAL_PAYOUT_PROVENANCES`): sólo lo
// verificado como real cuenta como real, y todo lo demás sobre-avisa. Los cuatro tests de acá abajo
// prueban las cuatro entradas posibles de esa decisión, y el de "una proveniencia que nadie conoce"
// es el que muere si alguien la vuelve a invertir a denylist.
describe("la identidad del paso confirm", () => {
  it("KYC real (allowlist): badge verde, sin sello de demo", async () => {
    await irAConfirmarConKyc(KYC_PROVENANCE_LIVE);

    expect(screen.getByText(/Identidad verificada/)).toBeInTheDocument();
    expect(screen.getByText(/Test Quispe Mamani/)).toBeInTheDocument();
    // Éste es el caso que NO tiene que cambiar: sin sello, como hasta hoy.
    expect(screen.queryByText(/Modo demo/)).toBeNull();
    expect(screen.queryByText(/Identidad sin verificar/)).toBeNull();
  });

  // EL test de esta HU: el KYC simulado que la demo usa de verdad.
  it("KYC simulado (didit-mock): el sello se prende en confirm y la pantalla no afirma una verificación", async () => {
    await irAConfirmarConKyc(KYC_PROVENANCE_MOCK);

    // (a) el sello, que antes no aparecía hasta `track` y sólo si el payout era mock.
    expect(screen.getAllByText(/Modo demo \(con pasos simulados\)/)).toHaveLength(1);
    // (b) la frase que afirmaba una verificación que no ocurrió, muerta.
    expect(screen.queryByText(/Identidad verificada/)).toBeNull();
    // (c) lo que sí se puede afirmar: el origen, en crudo, para que la frase sea falsable a la vista.
    expect(screen.getByText(/Identidad sin verificar/)).toBeInTheDocument();
    expect(
      screen.getByText(/Estos datos salieron de "didit-mock", que no está en la lista de verificadores reales/),
    ).toBeInTheDocument();
    // (d) los datos siguen a la vista: el problema era lo que se AFIRMABA de ellos, no mostrarlos.
    expect(screen.getByText(/Test Quispe Mamani/)).toBeInTheDocument();
    // (e) el barrido de em dashes también cubre esta pantalla, que antes no visitaba.
    expect(document.body.textContent ?? "").not.toContain("—");
  });

  // El test que mata la denylist. Con la dirección vieja ("es demo si es exactamente X") una
  // proveniencia nueva o con un typo se leía como REAL y la pantalla volvía a afirmar de más.
  it("una proveniencia de KYC que no conocemos también prende el sello (sobre-avisa)", async () => {
    await irAConfirmarConKyc("verificador-nuevo-2027");

    expect(screen.getAllByText(/Modo demo \(con pasos simulados\)/)).toHaveLength(1);
    expect(screen.queryByText(/Identidad verificada/)).toBeNull();
    // No dice "es simulada", porque de un valor desconocido no lo sabemos. Dice lo comprobable.
    expect(
      screen.getByText(/Estos datos salieron de "verificador-nuevo-2027", que no está en la lista de verificadores reales/),
    ).toBeInTheDocument();
  });

  // La decisión explícita sobre el dato que falta: ausencia NO es prueba de que sea real. Los dos
  // casos son alcanzables sin inventar nada (`kyc-gateway.ts`:42 castea el JSON sin validar;
  // `kyc-store.ts`:86 rehidrata snapshots viejos con un spread), y comparten la frase porque un
  // `""` y un campo ausente dicen lo mismo: nadie declaró el origen.
  it.each([
    ["ausente", undefined],
    ["vacía", ""],
  ])("proveniencia de KYC %s: prende el sello y lo dice sin inventar un origen", async (_caso, p) => {
    await irAConfirmarConKyc(p);

    expect(screen.getAllByText(/Modo demo \(con pasos simulados\)/)).toHaveLength(1);
    expect(screen.queryByText(/Identidad verificada/)).toBeNull();
    expect(
      screen.getByText(/Estos datos no dicen de qué verificador salieron/),
    ).toBeInTheDocument();
    // Y NO se fabrica un origen entre comillas para un valor que no existe.
    expect(screen.queryByText(/Estos datos salieron de/)).toBeNull();
  });

  // 🔴 `confirm` no era el único paso afectado, y esto lo prueba. El sello de `track` se prendía SOLO
  // por la pata del payout: con el KYC simulado y un desembolso REAL (`transfi`), la remesa entera
  // quedaba sin ningún aviso también en seguimiento, y lo mismo en el recibo (`Receipt`, flow.tsx:1676,
  // que llama al mismo `isDemoMode`). Es la combinación hacia la que apunta el proyecto: payout real
  // primero, KYC real después.
  it("el KYC simulado también prende el sello en track, con un desembolso REAL", () => {
    const r = Remittance.create("rem-kyc-mock", beneficiary(), Money.of(400, "USDC"), T0);
    r.attachQuote(
      {
        quoteId: "q",
        send: Money.of(400, "USDC"),
        receive: Money.of(1478.15, "PEN"),
        feeUsd: Money.of(0.5, "USDC"),
        rate: 3.7,
        etaMinutes: 30,
        expiresAt: "2099-01-01T00:00:00.000Z",
        provenance: "didit",
      },
      T0,
    );
    r.startKyc(T0, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    r.applyKyc(
      {
        verificationId: "v-1",
        approved: true,
        payoutAllowed: true,
        riskLevel: "low",
        provenance: KYC_PROVENANCE_MOCK,
        identity: toPersistedIdentity({
          firstName: "Test",
          lastNamePaternal: "Quispe",
          lastNameMaternal: "Mamani",
          documentType: "DNI",
          documentNumber: "12345678",
          dateOfBirth: "1990-01-01",
          nationality: "PE",
        }),
      },
      T0,
    );
    r.confirm(T0);
    r.markPrincipalIn("0xp", T0);
    r.markPayoutSubmitted("p1", T0, "transfi"); // desembolso REAL: la pata del payout NO prende nada

    render(
      <TrackView rem={r.snapshot} recover={undefined} sender={null} onRecovered={() => {}} />,
    );

    expect(screen.getByText(/Entorno de prueba/)).toBeInTheDocument();
    expect(screen.getByText(/no está confirmado como real/)).toBeInTheDocument();
    // Y no se elige cuál de los tres pasos fue: acá el desembolso SÍ es real.
    expect(screen.queryByText(/es simulado\./)).toBeNull();
  });
});

