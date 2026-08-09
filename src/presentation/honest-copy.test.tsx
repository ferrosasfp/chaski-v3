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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IdCard, ScanFace } from "lucide-react";
import { RemittanceFlow, TrackView } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { TEST_CCI } from "../test-support/fakes";
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
  fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
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
  fireEvent.click(await screen.findByRole("button", { name: /Verificar mi identidad/ }));
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
// (confirm-and-send.ts:191-197). O sea que Chaski SÍ puede mover esos USDC.
//
// Lo verificable, y lo que de verdad hace a esto no custodial, es DÓNDE quedan: en una cuenta del
// contrato (ATA de la PDA `escrowStatePda`, `solana-wallet.ts:383`), nunca en una billetera de Chaski.
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

/**
 * El TRAZO de un `<svg>`: sus hijos con todos sus atributos, en orden de dibujo.
 *
 * POR QUÉ ESTO Y NO EL NOMBRE DEL ÍCONO. Un test que busque el string "ScanFace" (o la clase
 * `lucide-scan-face` que lucide le pone al `<svg>`) es frágil por los dos lados: se rompe solo si
 * lucide renombra sus clases, y se lo saltea cualquiera que reimporte el mismo ícono con otro alias
 * (`import { ScanFace as Foto }`) o que copie sus paths a un componente propio. Ninguna de esas dos
 * cosas cambia lo único que la persona ve, que es EL DIBUJO.
 *
 * Así que el ancla es el dibujo: se renderiza el ícono prohibido acá mismo, se le saca la huella, y
 * se busca esa huella en la pantalla. Si el pictograma de "documento" o el de "cara escaneada" vuelve
 * a aparecer en el paso `verify` (importado, aliaseado o copiado a mano), la huella coincide y esto se
 * pone rojo. Si lucide cambia el dibujo de sus íconos, la huella cambia de los dos lados a la vez y el
 * test sigue midiendo lo mismo.
 */
function trazo(svg: Element): string {
  return Array.from(svg.children)
    .map((hijo) => {
      const attrs = Array.from(hijo.attributes)
        .map((a) => `${a.name}=${a.value}`)
        .sort()
        .join(",");
      return `${hijo.tagName}[${attrs}]`;
    })
    .join("|");
}

/** La huella de un ícono, renderizado y desmontado acá para no ensuciar el `screen` del flujo. */
function trazoDe(icono: React.ReactElement): string {
  const { container, unmount } = render(icono);
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("el ícono no renderizó ningún <svg>");
  const huella = trazo(svg);
  unmount();
  return huella;
}

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
    await screen.findByRole("button", { name: /Verificar mi identidad/ });

    expect(
      screen.getByText(/no se comparten con los agentes que cotizan y pagan/),
    ).toBeInTheDocument();
    // La frase vieja, entera y por partes.
    expect(screen.queryByText(/Tus datos no se comparten\./)).toBeNull();
    expect(screen.queryByText(/verificador certificado/i)).toBeNull();
    expect(screen.queryByText(/Lo hace/)).toBeNull();
  });

  // 🔴 LA TERCERA FRASE DE LA MISMA TARJETA, y la única que describía una ACCIÓN FÍSICA.
  // "Escaneás tu DNI y te sacás una selfie" es falsa con `DIDIT_ENV=mock`, que es la configuración de
  // producción: medido el 2026-08-05, `POST /api/kyc/session` devuelve un `url` que apunta a
  // `/kyc-simulado`, una página nuestra que no pide ni un dato y lo declara en pantalla.
  it("no promete un escaneo que el entorno puede no hacer, ni en la frase ni en el botón", async () => {
    await irARevisar();
    fireEvent.click(await screen.findByRole("button", { name: /Continuar/ }));
    await screen.findByRole("button", { name: /Verificar mi identidad/ });

    // Lo que sí vale en las dos configuraciones.
    expect(screen.getByText(/verificamos tu identidad/)).toBeInTheDocument();
    // La acción física, muerta en las dos partes donde estaba.
    expect(screen.queryByText(/Escaneás tu DNI/)).toBeNull();
    expect(screen.queryByText(/te sacás una selfie/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Escanear DNI/ })).toBeNull();
  });

  // 🔴 LA MISMA PROMESA, MOVIDA AL DIBUJO. La frase y el botón se arreglaron; el recuadro de arriba
  // seguía dibujando `IdCard → ArrowRight → ScanFace`, o sea documento, flecha, cara escaneada: la
  // acción física que la frase dejó de prometer, contada en pictogramas. Con `DIDIT_ENV=mock` la
  // persona aterriza en `/kyc-simulado`, que no pide ni un dato, así que ese dibujo es falso en la
  // configuración con la que se recorre la demo.
  //
  // Y NO SE ARREGLA CONDICIONÁNDOLO POR MODO: `DIDIT_ENV` es server-only, sin variante
  // `NEXT_PUBLIC_` (`didit-env.ts:66`), así que esta pantalla no puede saber qué verificador está
  // configurado. Igual que las tres frases vecinas, el ícono tiene que ser cierto en las dos.
  it("el recuadro del paso verify no dibuja el escaneo de documento+rostro que la frase dejó de prometer", async () => {
    // Las huellas se sacan ANTES de montar el flujo, para que estos renders no se crucen con `screen`.
    const prohibidos: ReadonlyArray<readonly [string, string]> = [
      ["IdCard (documento)", trazoDe(<IdCard />)],
      ["ScanFace (cara escaneada)", trazoDe(<ScanFace />)],
    ];

    await irARevisar();
    fireEvent.click(await screen.findByRole("button", { name: /Continuar/ }));
    await screen.findByRole("button", { name: /Verificar mi identidad/ });

    const dibujados = Array.from(document.querySelectorAll("svg")).map(trazo);
    for (const [nombre, huella] of prohibidos) {
      expect(dibujados, `el paso verify sigue dibujando ${nombre}`).not.toContain(huella);
    }

    // El fix no puede ser vaciar el recuadro: sigue habiendo UN ícono ahí, y uno solo (dos o tres
    // vuelven a armar una secuencia, que es la forma en que este defecto contaba la acción física).
    const recuadro = screen.getByTestId("verify-idle-icon");
    expect(recuadro.querySelectorAll("svg")).toHaveLength(1);
  });

  // La barra de progreso de tres pasos era doblemente inventada: `setScanStage` sólo se llama con
  // 0, 1 y 4 (las etapas 2 y 3 no las alcanza nadie), y entre la 1 y la 4 lo único que ocurre es una
  // llamada a `startKyc`. Nadie escanea, nadie mira una cara y nadie consulta una lista AML.
  it("mientras arranca no narra tres etapas de un verificador que no se está ejecutando", async () => {
    await irARevisar();
    fireEvent.click(await screen.findByRole("button", { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Verificar mi identidad/ }));

    expect(screen.queryByText(/Escaneando tu documento/)).toBeNull();
    expect(screen.queryByText(/Verificando tu rostro/)).toBeNull();
    expect(screen.queryByText(/Revisando listas de seguridad/)).toBeNull();
    // Lo que queda es lo único que ocurre de verdad, y su desenlace.
    expect(await screen.findByText(/Tu verificación volvió aprobada/)).toBeInTheDocument();
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
// "Ninguno de estos pasos está atado a una empresa fija" quedaba desmentido por el detalle de cada
// fila: la que decía "hoy se llama directo a X" ERA un paso cableado a un agente concreto. Esa fila
// se fue con el carril (WKH-332/W3), y la frase de arriba sigue describiendo el MODELO sin afirmar
// que hoy los pasos corran por ahí — cada fila lo dice por su cuenta, y en demo la cotización la arma la app.
//
// ⚠️ EL `it` CAMBIÓ DE ASSERT, y el motivo va escrito: verificaba la PRESENCIA de "Hoy se llama
// directo a", que es una de las dos frases que AC-7 ahora prohíbe. Lo que sobrevive del test es su
// eje real —que la frase de arriba no NIEGUE lo que la fila afirma— y para eso se usa el estado que
// hoy sí puede contradecirla: `demo`, donde la fila dice que el paso lo corre un simulador.
describe("la tarjeta de quién atiende el envío", () => {
  it("no niega lo que cada fila afirma: en demo la fila dice que el paso se simula", async () => {
    const steps = [
      {
        capability: "fx.quote",
        label: "Cotización",
        agent: {
          id: "un-proveedor-de-fx",
          description: "",
          priceUsdc: 0.5,
          verified: false,
          registry: "wasiai",
        },
        transport: "demo" as const,
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
      expect(
        screen.getByText(/esta app está en modo demo y lo simula/),
      ).toBeInTheDocument();
      // Y las dos frases que AC-7 prohíbe no vuelven por acá.
      expect(document.body.textContent ?? "").not.toContain("Hoy se llama directo a");
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
    await screen.findByRole("button", { name: /Verificar mi identidad/ });
    expect(document.body.textContent ?? "").not.toContain("—");

    // `confirm` faltaba, y es donde se acaba de escribir la tarjeta de identidad (sección 10).
    fireEvent.click(screen.getByRole("button", { name: /Verificar mi identidad/ }));
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
  // casos son alcanzables sin inventar nada (`kyc-gateway.ts`:52 castea el JSON sin validar;
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
  // quedaba sin ningún aviso también en seguimiento, y lo mismo en el recibo (`Receipt`, `flow.tsx:2782`,
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


// ── T-15.1 / T-16.1 · AC-15 y AC-16 · BARRIDOS DE PROSA ──────────────────────────────────────────
//
// Estos dos `it` no miran el DOM: miran el ÁRBOL. Van en este archivo porque es el que ya tiene la
// disciplina de "cada frase falsable con un input concreto", y lo que vigilan es exactamente eso —
// dos afirmaciones concretas que el código NO puede sostener y que ya se escribieron una vez.
//
// 🔴 LOS DOS SON CANARIOS, Y HAY QUE DECIRLO ASÍ: al 2026-08-07 el árbol NO tiene ninguna de las dos
// frases, así que su verde de HOY no prueba que alguien las haya borrado. Lo que prueban es que si
// mañana alguien las escribe, la suite se cae. Por eso cada uno lleva su assert de NO-VACUIDAD: se
// planta la frase prohibida en un string y se comprueba que el matcher la caza. Sin eso, un `needle`
// mal escrito daría cero hits para siempre y el candado sería decorativo.
describe("barridos de prosa (AC-15 / AC-16)", () => {
  const ROOT = process.cwd();
  const SCAN_DIRS = ["src", "app"];
  const SCAN_EXTS = new Set([".ts", ".tsx"]);
  const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations"]);
  const SELF = path.resolve(ROOT, "src/presentation/honest-copy.test.tsx");

  function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(entry)) walk(full, out);
      } else if (SCAN_EXTS.has(path.extname(entry)) && path.resolve(full) !== SELF) {
        out.push(full);
      }
    }
    return out;
  }

  const ARBOL: Array<{ rel: string; lineas: string[] }> = SCAN_DIRS.flatMap((d) =>
    walk(path.join(ROOT, d)).map((full) => ({
      rel: path.relative(ROOT, full),
      lineas: readFileSync(full, "utf8").split("\n"),
    })),
  );

  /** Toda línea del árbol que cumpla el predicado, con su ubicación. */
  function lineasQue(pred: (linea: string) => boolean): string[] {
    const out: string[] = [];
    for (const { rel, lineas } of ARBOL) {
      lineas.forEach((l, i) => {
        if (pred(l)) out.push(`${rel}:${i + 1}  «${l.trim()}»`);
      });
    }
    return out;
  }

  it("el barrido no es vacuo: ve el árbol entero", () => {
    // Piso, no medición: descarta "el walk devolvió (casi) nada", que es cómo estos dos `it` se
    // volverían decorativos sin ponerse rojos.
    expect(ARBOL.length).toBeGreaterThan(50);
  });

  // ── T-15.1 · AC-15 ─────────────────────────────────────────────────────────────────────────────
  //
  // LA AFIRMACIÓN PROHIBIDA, con su contra-evidencia MEDIDA: que el `inputSchema` que el agente
  // publica en su AgentCard describa TODO lo que ese agente exige para atender. No lo describe. El
  // agente de payout del catálogo publica 6 campos requeridos y ADEMÁS exige `senderIdentity`, y su
  // `quoteId` tiene que ser uno real que vence a los ~10 minutos. Escribir que el schema alcanza haría
  // creer que un cliente que lo cumple va a ser atendido, y no es cierto.
  //
  // Por qué el barrido busca el par (schema, suficiencia) y no la palabra `inputSchema` sola: la
  // palabra por sí misma es legítima —se puede hablar del schema sin afirmar que alcance—. Lo que no
  // se puede es decir que sea completo, suficiente o que describa todo.
  // ⚠️ `"completo"` NO ESTÁ EN ESTA LISTA COMO SUBCADENA SUELTA, Y ES UN BUG QUE ESTE TEST YA CAZÓ:
  // `"incompleto"` la contiene, así que la frase CORRECTA (*"el inputSchema del card es incompleto"*)
  // daba un falso positivo. Se piden las formas afirmativas con su verbo delante.
  const SUFICIENCIA = [
    "suficiente",
    "alcanza",
    "describe todo",
    "todos los campos",
    "es completo",
    "está completo",
    "esta completo",
  ];
  function afirmaSuficienciaDelSchema(linea: string): boolean {
    const l = linea.toLowerCase();
    const hablaDelSchema = l.includes("inputschema") || l.includes("input schema");
    return hablaDelSchema && SUFICIENCIA.some((s) => l.includes(s));
  }

  it("T-15.1/AC-15: ninguna prosa afirma que el `inputSchema` del catálogo sea suficiente", () => {
    // NO-VACUIDAD primero: el matcher tiene que cazar la frase prohibida plantada a mano. Si esto se
    // pusiera rojo, el `expect` de abajo estaría dando verde por no mirar nada.
    expect(
      afirmaSuficienciaDelSchema(
        "// el inputSchema del catálogo describe todo lo que el agente exige",
      ),
      "el matcher de T-15.1 dejó de cazar la frase prohibida: el barrido de abajo es decorativo",
    ).toBe(true);
    expect(afirmaSuficienciaDelSchema("// el inputSchema del card es incompleto (WKH-334)")).toBe(
      false,
    );

    expect(
      lineasQue(afirmaSuficienciaDelSchema),
      "una prosa afirma que el `inputSchema` publicado alcanza para invocar la capacidad. No alcanza: " +
        "el agente de payout publica 6 requeridos y además exige `senderIdentity`, y el `quoteId` tiene " +
        "que ser real y vence a los ~10 min (WKH-334, otro repo). Cumplir el schema NO garantiza ser " +
        "atendido, y esta app no se rompe por eso porque `prepare` reenvía el body entero",
    ).toEqual([]);
  });

  // ── T-16.1 · AC-16 ─────────────────────────────────────────────────────────────────────────────
  //
  // DOS afirmaciones prohibidas, y las dos se escribieron de verdad antes de WKH-333:
  //   (a) que el veredicto de KYC viva SÓLO en el navegador. La tabla `kyc_verdicts` está aplicada a
  //       producción y `prepare` saca el identificador de SU PROPIA fila.
  //   (b) que `KYC_VERDICT_STORE_ENABLED` sea un kill-switch. MEDIDO con la autoridad real en el lazo:
  //       apagarlo devuelve 503 a TODO pagador legítimo. Es un interruptor de una sola dirección.
  //
  // 🔴 EL BARRIDO NO PUEDE PEDIR CERO MENCIONES DE "kill-switch", Y ESO ES EL PUNTO. Hoy hay tres, y
  // las tres son correctas porque NIEGAN la afirmación: el docblock de `prepare/route.ts` que grita
  // que NO lo es, y dos de `route.flag-off.test.ts`, que es el candado que lo mide. Un barrido que
  // pidiera cero se pondría verde borrando la advertencia y su test — apagar la vigilancia para que la
  // medición se vea linda. Así que lo que se prohíbe es la mención AFIRMATIVA: toda línea que nombre
  // el término tiene que negarlo o invertirlo en la misma línea.
  const NIEGA = ["no es", "no lo es", "nunca", "invertido", "no un kill", "no es un kill"];
  function afirmaQueEsKillSwitch(linea: string): boolean {
    const l = linea.toLowerCase();
    if (!l.includes("kill-switch") && !l.includes("kill switch")) return false;
    return !NIEGA.some((n) => l.includes(n));
  }
  function diceQueElVeredictoViveSoloEnElNavegador(linea: string): boolean {
    const l = linea.toLowerCase();
    const hablaDelVeredicto =
      l.includes("veredicto") || l.includes("verdict") || l.includes("kycverificationid");
    const dicheSoloNavegador =
      (l.includes("sólo en el navegador") ||
        l.includes("solo en el navegador") ||
        l.includes("sólo en el browser") ||
        l.includes("solo en el browser")) &&
      !l.includes("ya no") &&
      !l.includes("dejó de");
    return hablaDelVeredicto && dicheSoloNavegador;
  }

  it("T-16.1/AC-16: nadie llama kill-switch a `KYC_VERDICT_STORE_ENABLED` sin negarlo en la misma línea", () => {
    // NO-VACUIDAD: la frase afirmativa se caza, la negada no.
    expect(afirmaQueEsKillSwitch("// KYC_VERDICT_STORE_ENABLED es el kill-switch del KYC")).toBe(
      true,
    );
    expect(afirmaQueEsKillSwitch("// `KYC_VERDICT_STORE_ENABLED` NO ES UN KILL-SWITCH.")).toBe(
      false,
    );
    // Y el barrido tiene que ESTAR VIENDO las tres menciones negadas: si dejara de verlas, el
    // predicado estaría filtrando por otra cosa y su cero no diría nada.
    const menciones = lineasQue((l) => l.toLowerCase().includes("kill-switch"));
    expect(
      menciones.length,
      "desaparecieron las menciones que NIEGAN el kill-switch: alguien borró la advertencia de " +
        "`prepare/route.ts` o el candado de `route.flag-off.test.ts`, y este barrido se puso verde por eso",
    ).toBeGreaterThanOrEqual(3);

    expect(
      lineasQue(afirmaQueEsKillSwitch),
      "una prosa llama kill-switch a `KYC_VERDICT_STORE_ENABLED` sin negarlo. Medido con la autoridad " +
        "REAL en el lazo: apagarlo devuelve 503 a TODO pagador legítimo, porque la ruta se queda sin " +
        "fila de dónde sacar el identificador y no hay camino de respaldo (CD-26). El rollback no es " +
        "apagar el flag: es re-desplegar el código anterior",
    ).toEqual([]);
  });

  it("T-16.1/AC-16: ninguna prosa dice que el veredicto de KYC viva SÓLO en el navegador", () => {
    // NO-VACUIDAD.
    expect(
      diceQueElVeredictoViveSoloEnElNavegador(
        "// el veredicto de KYC vive sólo en el navegador de la persona",
      ),
    ).toBe(true);
    expect(
      diceQueElVeredictoViveSoloEnElNavegador(
        "// el veredicto ya no vive sólo en el navegador: hay fila en Postgres",
      ),
    ).toBe(false);
    // Y el falso positivo que este predicado tiene que NO producir, medido: hay una línea del árbol
    // que dice que el `remittanceId` queda sólo en el navegador, y eso es CIERTO y no habla del KYC.
    expect(
      diceQueElVeredictoViveSoloEnElNavegador(
        "// el remittanceId, único argumento del refund on-chain, queda sólo en el navegador.",
      ),
    ).toBe(false);

    expect(
      lineasQue(diceQueElVeredictoViveSoloEnElNavegador),
      "una prosa dice que el veredicto de KYC vive sólo en el navegador. La tabla `kyc_verdicts` está " +
        "aplicada a producción y `prepare` saca el identificador de SU PROPIA fila (bloque PR5.5): el " +
        "del cliente se lee para descartarlo",
    ).toEqual([]);
  });
});
