// @vitest-environment jsdom
//
// EL CANDADO DE LA JERARQUÍA RELATIVA (ola 2.1).
//
// 🔴 QUÉ DEFECTO CIERRA, Y CÓMO SE MIDIÓ QUE NADIE LO MIRABA. La regla de `ui.tsx` decía que `primary`
// era "el camino feliz de ESTA pantalla", y dejaba huérfano el caso en que el camino feliz YA NO EXISTE:
// ahí ninguna acción calificaba y la pantalla se quedaba sin acción principal. En la rama de FALLO del
// seguimiento la única acción posible era "Recuperar fondos" —la que saca el principal del escrow— y se
// pintaba `outline`. MEDIDO: con el arreglo ya aplicado en `flow.tsx`, la suite completa seguía en
// 127 files / 2176 tests verde. O sea que la jerarquía de las pantallas no la vigilaba NADA.
//
// LO QUE ESTE ARCHIVO VERIFICA, en una frase: **ninguna pantalla que ofrezca una acción resolutiva queda
// sin `primary`, y ninguna que no la ofrezca se inventa uno.** Las dos mitades importan: sin la segunda,
// el "arreglo" de promover todos los botones a `primary` pasaría en verde.
//
// ══ LAS DOS TRAMPAS QUE ESTE REPO YA PISÓ, Y CÓMO LAS ESQUIVA ESTE ARCHIVO ══════════════════════════
//
// 1. EL CANDADO QUE SE APLAUDE SOLO. Si la lista de pantallas y su veredicto se derivaran del mismo
//    criterio con el que el código pinta, esto aprobaría cualquier cosa. Acá la LISTA y el NÚMERO
//    ESPERADO de cada fila están ESCRITOS A MANO abajo, uno por uno, con el motivo al lado; el código
//    no participa de esa decisión. Lo único que sí se deriva de `ui.tsx` es qué ASPECTO tiene un
//    `primary`, que es el vocabulario y tiene que salir de su única fuente (mismo molde que
//    `altoDelBotonBase` en `ola-2-pantallas.test.tsx` y que `pxDelCtaDelCaminoFeliz` en
//    `touch-targets.test.tsx`: el valor se lee del elemento renderizado, no se escribe a mano).
//
// 2. EL TEST QUE SE CONFIRMA CON LO QUE VINO A DETECTAR. Un marcador que también cumplieran `outline` y
//    `ghost` daría verde con el botón sin arreglar. Por eso `T-JR-0` mide el marcador ANTES de usarlo:
//    que no esté vacío, que un `primary` de referencia lo cumpla y que un `outline` y un `ghost` de
//    referencia NO lo cumplan. Si `BTN_VARIANTS` dejara a las tres variantes indistinguibles, el resto
//    del archivo sería vacuamente verde y este `it` es lo único que lo pone rojo.
//
// 3. Y LA VACUIDAD DE CADA FILA: contar `primary` en una pantalla que no renderizó nada da 0 y pasa.
//    Por eso cada fila declara además QUÉ BOTONES espera ver por su nombre visible. Una pantalla que
//    deja de montar su acción se pone roja en el assert de presencia, no en el conteo.
//
// ⚠️ LO QUE **NO** VERIFICA, declarado y no disfrazado:
//   · Que la clase emita el color. Acá no corre Tailwind y jsdom no hace layout: se leen NOMBRES DE
//     CLASE. Es la misma limitación que ya declaran `ola-2-pantallas.test.tsx` y `touch-targets`.
//   · Que la tabla de abajo esté COMPLETA. Las 10 filas salieron de barrer los 17 `<Button` de
//     `src/presentation/` y agrupar por pantalla; una pantalla NUEVA no entra sola a esta tabla y nadie
//     se entera. Eso es trabajo de quien revise el PR que la agregue, no de este archivo.
//   · Si el VEREDICTO de cada fila es el correcto. "¿Hay acá una acción que resuelve la situación?" es
//     un juicio de diseño. Este candado lo CONGELA para que cambiarlo obligue a editar esta tabla y a
//     decir por qué; no lo deduce.
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { HistoryView, Receipt, RemittanceFlow, TrackView } from "./flow";
import { Button } from "./ui";
import { Money } from "../domain/money";
import {
  type KycVerification,
  Remittance,
  type RemittanceState,
  toPersistedIdentity,
} from "../domain/remittance";
import { RecoverEscrowFunds } from "../application/use-cases/recover-escrow-funds";
import { CloseEscrowAccounts } from "../application/use-cases/close-escrow-accounts";
import { ConfirmAndSend } from "../application/use-cases/confirm-and-send";
import { KYC_PROVENANCE_LIVE } from "../infrastructure/didit/decision";
import { buildTestContainer } from "../test-support/test-container";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeConnectedWallet,
  FakeKycGateway,
  FakeSolanaEscrowCloseGateway,
  FakeSolanaEscrowRefundGateway,
  FixedClock,
  InMemoryRepo,
  T0,
  TEST_CCI,
  beneficiary,
} from "../test-support/fakes";
import { InMemoryPopProofStore } from "../infrastructure/auth/pop-proof-store";

// CD-8 / DT-7 — el mismo doble que `flow.test.tsx`: jsdom no implementa requestAnimationFrame, así que
// sin esto el `exit` de AnimatePresence no completa y los pasos del flujo NUNCA montan. Es una lista
// CERRADA: lo que no esté acá no existe para este archivo (ver el comentario de `flow.test.tsx:111`).
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
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

afterEach(cleanup);

// ══ El marcador de `primary`, DERIVADO de `ui.tsx` y no escrito a mano ══════════════════════════════

/**
 * Los tokens de clase que SÓLO tiene `primary`, calculados como la diferencia de conjuntos contra las
 * otras dos variantes sobre el elemento REALMENTE renderizado.
 *
 * Por qué derivado y no un literal: `BTN_VARIANTS` es la única fuente del vocabulario, y un literal acá
 * quedaría viejo el día que la paleta cambie —con el candado en verde y midiendo una clase que ya nadie
 * emite—. Por qué la DIFERENCIA y no "tiene `bg-cochineal`": lo que hace a un botón el principal de la
 * pantalla es lo que lo distingue de los otros dos, no una clase suelta que mañana puede compartir.
 */
function marcadoresDePrimary(): readonly string[] {
  const tokens = (variant: "primary" | "outline" | "ghost"): Set<string> => {
    const { unmount } = render(<Button variant={variant}>referencia</Button>);
    const cls = screen.getByRole("button", { name: "referencia" }).className;
    unmount();
    return new Set(cls.split(/\s+/).filter(Boolean));
  };
  const primary = tokens("primary");
  const otras = new Set([...tokens("outline"), ...tokens("ghost")]);
  return [...primary].filter((t) => !otras.has(t));
}

const MARCADORES = marcadoresDePrimary();

/** ¿Este `<button>` del DOM es el `primary` de su pantalla? */
function esPrimary(b: Element): boolean {
  const tokens = new Set(b.className.split(/\s+/).filter(Boolean));
  return MARCADORES.every((m) => tokens.has(m));
}

/** Los nombres visibles de los `<button>` que la pantalla pintó como `primary`. */
function primariesDe(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("button"))
    .filter(esPrimary)
    .map((b) => (b.textContent ?? "").trim());
}

describe("T-JR-0: el marcador de `primary` existe y DISCRIMINA", () => {
  it("no está vacío, lo cumple `primary` y NO lo cumplen `outline` ni `ghost`", () => {
    // 🔴 SIN ESTE `it` TODO EL ARCHIVO PUEDE SER VACUAMENTE VERDE. Si `MARCADORES` quedara vacío
    // —porque alguien unifique las tres variantes, o porque `cn` deje de emitir el bloque de
    // `BTN_VARIANTS`—, `esPrimary` daría `true` para CUALQUIER botón con `[].every(...)`, y las filas
    // que esperan 0 se pondrían rojas por la razón equivocada mientras las que esperan 1 pasarían por
    // accidente. Acá el rojo nombra la causa real.
    expect(MARCADORES.length).toBeGreaterThan(0);

    const { container: conPrimary, unmount } = render(<Button variant="primary">x</Button>);
    expect(primariesDe(conPrimary)).toEqual(["x"]);
    unmount();

    for (const v of ["outline", "ghost"] as const) {
      const { container, unmount: u } = render(<Button variant={v}>x</Button>);
      expect(primariesDe(container), `\`${v}\` no puede contar como el principal`).toEqual([]);
      u();
    }
  });
});

// ══ Los snapshots de las pantallas ══════════════════════════════════════════════════════════════════

const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  riskLevel: "low",
  provenance: "didit",
  identity: toPersistedIdentity({
    firstName: "Ana",
    lastNamePaternal: "Quispe",
    lastNameMaternal: "Mamani",
    documentType: "DNI",
    documentNumber: "12345678",
    dateOfBirth: "1990-01-01",
    nationality: "PE",
  }),
};

/** Un snapshot en el estado pedido. `startKyc` deja `ownerAddress` = el sender, que es lo que el guard
 *  de cierre de cuentas compara (AC-7 de WKH-327). */
function remesa(
  hasta: "payout_submitted" | "settled" | "payout_failed" | "refunded",
): RemittanceState {
  const r = Remittance.create("rem-jr", beneficiary(), Money.of(400, "USDC"), T0);
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
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPrincipalIn("solana-sig", T0);
  if (hasta === "payout_failed") {
    r.markPayoutFailed("partner_down", T0);
    return r.snapshot;
  }
  if (hasta === "refunded") {
    r.markPayoutFailed("partner_down", T0);
    r.markRefunded("refund-x", T0);
    return r.snapshot;
  }
  r.markPayoutSubmitted("transfi-sol-po-1", T0, "transfi");
  if (hasta === "payout_submitted") return r.snapshot;
  r.markSettled(T0, Money.of(1478.15, "PEN"), "transfi");
  return r.snapshot;
}

async function recoverUseCase(rem: RemittanceState) {
  const repo = new InMemoryRepo();
  await repo.save(Remittance.rehydrate(rem));
  return new RecoverEscrowFunds(repo, new FixedClock(), new FakeSolanaEscrowRefundGateway());
}

const closeUseCase = () =>
  new CloseEscrowAccounts(
    new FakeSolanaEscrowCloseGateway(),
    new FakeConnectedWallet(FAKE_SOLANA_BENEFICIARY),
  );

/** El bloque de revisión del seguimiento en el estado que SÍ ofrece el gesto de consultar. */
function revisionOfreciendoElGesto() {
  const store = new InMemoryPopProofStore(new FixedClock());
  return {
    ventana: { estado: () => (store.peek(FAKE_SOLANA_BENEFICIARY) ? "vigente" : "sin-prueba") },
    renovar: {
      prove: vi.fn(async (a: string) => {
        const prueba = { challenge: "ch", signature: "sig" };
        store.record(a, prueba);
        return prueba;
      }),
    },
  } as const;
}

// ══ LA TABLA. Escrita a mano, fila por fila, y es lo único normativo de este archivo ════════════════
//
// `resolutiva` contesta UNA pregunta: ¿hay en esta pantalla una acción que SAQUE A LA PERSONA DE DONDE
// ESTÁ? No "¿hay una acción?" ni "¿mueve plata?". Las tres respuestas que NO son "sí":
//   · la pantalla sólo informa o sólo lista ⇒ no hay nada que resolver;
//   · el camino feliz sigue vivo y lo que se ofrece lo ABANDONA (es un escape, no una salida);
//   · la situación YA está resuelta y lo que queda es limpieza.
type Fila = {
  nombre: string;
  /** true ⇒ se espera EXACTAMENTE 1 `primary`. false ⇒ se esperan 0. */
  resolutiva: boolean;
  /** Por qué. Va en el mensaje del assert: el rojo tiene que explicar el criterio, no sólo el número. */
  porQue: string;
  /** Los botones que la pantalla TIENE que estar mostrando. Sin esto, un render vacío da 0 y pasa. */
  botones: RegExp[];
  montar: () => Promise<HTMLElement>;
};

const FILAS: readonly Fila[] = [
  {
    nombre: "seguimiento · rama de FALLO, con la recuperación disponible",
    resolutiva: true,
    porQue:
      "el envío ya no se entrega, o sea que el camino feliz MURIÓ, y recuperar es lo único que le " +
      "devuelve sus USDC. Es el defecto que el founder vio en la vista previa.",
    botones: [/Recuperar fondos/],
    montar: async () => {
      const rem = remesa("payout_failed");
      return render(
        <TrackView
          rem={rem}
          recover={await recoverUseCase(rem)}
          sender={FAKE_SOLANA_BENEFICIARY}
          onRecovered={() => {}}
        />,
      ).container;
    },
  },
  {
    nombre: "seguimiento · rama de FALLO, sin billetera conectada",
    resolutiva: false,
    porQue:
      "sin `recover` ni `sender` no se ofrece ninguna acción: la pantalla sólo dice qué pasó y qué " +
      "hace falta para recuperar. Una pantalla puramente informativa no tiene nada que promover.",
    botones: [],
    montar: async () =>
      render(
        <TrackView rem={remesa("payout_failed")} recover={undefined} sender={null} onRecovered={() => {}} />,
      ).container,
  },
  {
    nombre: "seguimiento · en curso (`payout_submitted`), con recuperar y con el gesto de revisar",
    resolutiva: false,
    porQue:
      "el camino feliz SIGUE VIVO: la entrega puede llegar y esperar es lo que la trae. " +
      "«Recuperar fondos» no resuelve la situación, la ABANDONA, y «Revisar ahora» sólo consulta. " +
      "Es el par que prueba que la variante es de la PANTALLA y no del botón: el mismo " +
      "`RefundAction` de la fila 1, acá, es `outline`.",
    botones: [/Recuperar fondos/, /revisar/i],
    montar: async () => {
      const rem = remesa("payout_submitted");
      return render(
        <TrackView
          rem={rem}
          recover={await recoverUseCase(rem)}
          sender={FAKE_SOLANA_BENEFICIARY}
          onRecovered={() => {}}
          revision={revisionOfreciendoElGesto()}
        />,
      ).container;
    },
  },
  {
    nombre: "seguimiento · rama de FALLO ya recuperada (`refunded`), con el cierre de cuentas",
    resolutiva: false,
    porQue:
      "el titular dice «Recuperaste tus fondos»: los USDC ya volvieron y la situación ESTÁ resuelta. " +
      "«Cerrar y recuperar» devuelve el alquiler de las cuentas, que es limpieza y no una salida. " +
      "⚠️ ES LA FILA MÁS DISCUTIBLE DE LA TABLA y por eso está escrita: si alguien decide que el " +
      "alquiler sí es una situación por resolver, tiene que venir acá y cambiar el veredicto.",
    botones: [/Cerrar y recuperar/],
    montar: async () =>
      render(
        <TrackView
          rem={remesa("refunded")}
          closeEscrow={closeUseCase()}
          sender={FAKE_SOLANA_BENEFICIARY}
          onRecovered={() => {}}
        />,
      ).container,
  },
  {
    nombre: "seguimiento · `settled`, con el cierre de cuentas",
    resolutiva: false,
    porQue:
      "el camino feliz se COMPLETÓ (el envío se entregó). Mismo criterio que la fila anterior: lo " +
      "que queda es recuperar el alquiler, no destrabar nada.",
    botones: [/Cerrar y recuperar/],
    montar: async () =>
      render(
        <TrackView
          rem={remesa("settled")}
          closeEscrow={closeUseCase()}
          sender={FAKE_SOLANA_BENEFICIARY}
          onRecovered={() => {}}
        />,
      ).container,
  },
  {
    nombre: "recibo",
    resolutiva: false,
    porQue:
      "es la pantalla del final feliz: no hay ninguna situación abierta. «Enviar otra» EMPIEZA algo " +
      "nuevo, no resuelve lo que hay, y promoverla convertiría un comprobante en una invitación.",
    botones: [/Enviar otra/],
    montar: async () => render(<Receipt rem={remesa("settled")} onNew={() => {}} />).container,
  },
  {
    nombre: "historial",
    resolutiva: false,
    porQue:
      "lista y navega. «Ver seguimiento» y «Volver» llevan a otra pantalla; lo que se resuelve, se " +
      "resuelve allá. Ninguno de los dos cambia nada de este envío.",
    botones: [/Ver seguimiento/, /Volver/],
    montar: async () =>
      render(
        <HistoryView items={[remesa("payout_submitted")]} onOpen={() => {}} onBack={() => {}} />,
      ).container,
  },
];

describe("T-JR-1: ninguna pantalla con acción resolutiva queda sin `primary`, y ninguna otra se inventa uno", () => {
  it.each(FILAS.map((f) => [f.nombre, f] as const))("%s", async (_nombre, fila) => {
    const container = await fila.montar();

    // (a) ANTIVACUIDAD: la pantalla montó lo que la fila dice que monta. Sin esto, un `TrackView` que
    //     dejara de renderizar su acción daría 0 `primary` y la fila que espera 0 pasaría feliz.
    for (const re of fila.botones) {
      expect(
        await screen.findByRole("button", { name: re }),
        `la fila dice que esta pantalla muestra ${re}, y no está: el conteo de abajo mide otra cosa`,
      ).toBeInTheDocument();
    }

    // (b) EL INVARIANTE.
    const encontrados = primariesDe(container);
    expect(encontrados, `${fila.nombre} — ${fila.porQue}`).toHaveLength(fila.resolutiva ? 1 : 0);
  });

  it("la tabla cubre los dos veredictos (si no, la mitad del invariante no se está midiendo)", () => {
    // Un candado que sólo tuviera filas de un lado mediría media regla. El rojo de acá dice que
    // alguien borró justo las filas que hacían falsable la otra mitad.
    expect(FILAS.some((f) => f.resolutiva)).toBe(true);
    expect(FILAS.some((f) => !f.resolutiva)).toBe(true);
  });
});

// ══ Las pantallas que sólo existen recorriendo el flujo ═════════════════════════════════════════════
//
// `confirm` no se puede montar suelto: es una rama de `RemittanceFlow` y su estado de error lo produce
// un `confirmAndSend` que rechaza. Por eso estas tres van aparte y navegan de verdad.

const kycRealGateway = () => new FakeKycGateway({ provenance: KYC_PROVENANCE_LIVE });

function llenarSend(): void {
  fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), {
    target: { value: "Mamá" },
  });
  fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), {
    target: { value: TEST_CCI },
  });
}

async function irAConfirm(): Promise<void> {
  llenarSend();
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
  await screen.findByText(/Revisá el envío/);
  fireEvent.click(await screen.findByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Verificar mi identidad/ }));
  await screen.findByRole("button", { name: /Confirmar y enviar/ });
}

describe("T-JR-2: el paso `confirm`, con y sin error", () => {
  it("SIN error el principal es «Confirmar y enviar» (control: el camino feliz sigue siendo uno solo)", async () => {
    // Este `it` no está de adorno: es lo que impide que el arreglo del de abajo se lea como "en
    // `confirm` hay un `primary`". Sin él, mover el `primary` de «Confirmar y enviar» a cualquier otro
    // control de la misma pantalla pasaría desapercibido.
    const { container } = render(
      <RemittanceFlow container={buildTestContainer({ kyc: kycRealGateway() })} />,
    );
    await irAConfirm();
    expect(primariesDe(container)).toEqual([expect.stringContaining("Confirmar y enviar")]);
  });

  it("CON error, «Recotizar tasa» es el principal: la rama REEMPLAZA al camino feliz", async () => {
    // 🔴 EL SEGUNDO SITIO QUE EL BARRIDO ENCONTRÓ, y no lo había visto nadie. El `error ?` no AGREGA
    // un botón: sustituye a «Confirmar y enviar», así que en esa rama el camino feliz no está y
    // recotizar es lo único que desatasca el envío. Estaba en `outline` y la pantalla quedaba sin
    // acción principal, igual que la rama de fallo del seguimiento.
    //
    // MUTANTE QUE MATA: devolverle el `variant="outline"` al `<Button>` de `onRelock` en `flow.tsx`.
    const rechaza = {
      execute: async () => {
        throw new Error("confirm_quote_expired");
      },
    } as unknown as ConfirmAndSend;
    const { container } = render(
      <RemittanceFlow
        container={buildTestContainer({ kyc: kycRealGateway(), useCases: { confirmAndSend: rechaza } })}
      />,
    );
    await irAConfirm();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));
    await screen.findByRole("button", { name: /Recotizar tasa/ });

    // Y no queda «Confirmar y enviar» en pantalla: si quedara, habría DOS acciones compitiendo y el
    // conteo de abajo estaría midiendo una pantalla que no existe.
    expect(screen.queryByRole("button", { name: /Confirmar y enviar/ })).toBeNull();
    expect(primariesDe(container)).toEqual([expect.stringContaining("Recotizar tasa")]);
  });
});

describe("T-JR-3: el paso `send`", () => {
  it("«Continuar» es el único principal, y las puertas de recuperación NO compiten con él", async () => {
    // El camino feliz existe y es «Continuar». Las otras tres puertas de esta pantalla («Ver mis
    // envíos», «Recuperar un envío perdido», «Recuperar el depósito de red…») son `<button>` planos
    // subrayados y no pasan por `<Button>`, así que no pueden ganar prominencia por accidente. Este
    // `it` lo fija: si alguien las convierte en `<Button variant="primary">`, acá hay dos.
    const { container } = render(
      <RemittanceFlow container={buildTestContainer({ kyc: kycRealGateway() })} />,
    );
    await screen.findByRole("button", { name: /Continuar/ });
    expect(primariesDe(container)).toEqual([expect.stringContaining("Continuar")]);
  });
});
