// @vitest-environment jsdom
//
// LA TARJETA QUE NOMBRABA A QUIEN NO CORRE.
//
// Medido contra producción el 2026-08-05:
//   · `GET /api/a2a/plan` → `remit-corridor-fx-solana` y `remit-cashout-payout-solana`
//   · `POST /api/a2a/quote` → `result.slug = "remit-corridor-fx"`
//   · `payout/prepare` llama a `remit-cashout-payout` (route.ts:269)
// Son slugs DISTINTOS. La tarjeta mostraba el del catálogo con la coletilla "hoy se llama directo",
// o sea que afirmaba, del agente equivocado, justamente lo que era falso de él.
//
// El otro hallazgo de la misma tarjeta: "Lo que cobran los agentes: 0.06 USDC". En el carril punto a
// punto las dos rutas hacen un `fetch` liso, sin x402, sin `Authorization` y sin Agent Key, y el
// agente contesta 200 igual (verificado en vivo). Ese precio no se le cobra a nadie.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { TEST_CCI } from "../test-support/fakes";

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type PlanStep = {
  capability: string;
  label: string;
  agent: {
    id: string;
    description: string;
    priceUsdc: number | null;
    verified: boolean;
    registry: string;
  } | null;
  transport: "gateway" | "punto-a-punto";
  runsTodayAgentId?: string | null;
};

/** Monta el flujo hasta `review`, que es donde vive la tarjeta, con el plan que se le indique. */
async function verLaTarjeta(steps: PlanStep[], totalUsdc: number): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ steps, totalUsdc }) })),
  );
  render(<RemittanceFlow container={buildTestContainer()} />);
  fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), {
    target: { value: "Mamá" },
  });
  fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
  await screen.findByText(/Revisá el envío/);
  await screen.findByText(/Quién va a atender tu envío/);
}

const paso = (over: Partial<PlanStep> = {}): PlanStep => ({
  capability: "remittance-fx-quote",
  label: "Cotizar el cambio",
  agent: {
    id: "remit-corridor-fx-solana",
    description: "",
    priceUsdc: 0.03,
    verified: false,
    registry: "self-published",
  },
  transport: "punto-a-punto",
  runsTodayAgentId: "remit-corridor-fx",
  ...over,
});

describe("la tarjeta dice quién corre, no sólo quién ofrece", () => {
  // 🔴 EL test. Con los dos slugs reales de producción, la fila tiene que nombrar a los DOS y decir
  // cuál es cuál. Elegir uno en silencio, en cualquiera de las dos direcciones, es el bug.
  it("cuando el catálogo y la ejecución divergen, nombra a los dos", async () => {
    await verLaTarjeta([paso()], 0.03);

    expect(screen.getByText(/El catálogo ofrece a remit-corridor-fx-solana/)).toBeInTheDocument();
    expect(
      screen.getByText(/Hoy no corre ese: la app llama directo a remit-corridor-fx/),
    ).toBeInTheDocument();
    // Y no queda la frase vieja, que le atribuía al del catálogo la llamada directa.
    expect(screen.queryByText(/remit-corridor-fx-solana · hoy se llama directo/)).toBeNull();
  });

  it("cuando coinciden, lo dice sin inventar una divergencia", async () => {
    await verLaTarjeta(
      [paso({ agent: { ...paso().agent!, id: "remit-corridor-fx" } })],
      0.03,
    );

    expect(screen.getByText(/Hoy se llama directo a remit-corridor-fx\./)).toBeInTheDocument();
    expect(screen.queryByText(/Hoy no corre ese/)).toBeNull();
  });

  // En el carril del gateway NADIE llama a un slug: se pide la capacidad y el gateway resuelve al
  // ejecutar. Nombrar al del catálogo ahí sería inventar una certeza.
  it("en el carril del gateway no nombra a ninguno: ahí se elige al ejecutar", async () => {
    await verLaTarjeta([paso({ transport: "gateway", runsTodayAgentId: null })], 0.03);

    expect(screen.getByText(/corre por el gateway, que elige al ejecutar/)).toBeInTheDocument();
    expect(screen.queryByText(/Hoy se llama directo/)).toBeNull();
    expect(screen.queryByText(/Hoy no corre ese/)).toBeNull();
  });

  // Version skew: un server viejo no manda el campo. Callar dejaría la fila leyéndose como si el del
  // catálogo fuera el que corre, que es exactamente el bug que esta HU cierra.
  it("si el server no dice quién corre, lo dice: no asume que sea el del catálogo", async () => {
    await verLaTarjeta([paso({ runsTodayAgentId: undefined })], 0.03);

    expect(screen.getByText(/No sabemos a qué agente se llama hoy en este paso/)).toBeInTheDocument();
    expect(screen.queryByText(/Hoy se llama directo/)).toBeNull();
  });

  it("no mete un em dash", async () => {
    await verLaTarjeta([paso()], 0.03);
    expect(document.body.textContent ?? "").not.toContain("—");
  });
});

// ── El precio que nadie cobra ────────────────────────────────────────────────────────────────────
//
// Decía "Lo que cobran los agentes: 0.06 USDC". En el carril punto a punto las dos rutas hacen un
// `fetch` liso (sin x402, sin `Authorization`, sin Agent Key) y el agente contesta 200: verificado en
// vivo contra producción el 2026-08-05. Nadie cobra eso, y encima es el precio de catálogo de agentes
// que pueden no ser los que corren.
describe("el precio dice qué es y quién lo cobraría", () => {
  it("en punto-a-punto no afirma un cobro: dice que se llama sin pago", async () => {
    await verLaTarjeta([paso()], 0.06);

    expect(screen.getByText("Precio publicado en el catálogo")).toBeInTheDocument();
    expect(screen.getByText("0.06 USDC")).toBeInTheDocument(); // el dato se conserva
    expect(
      screen.getByText(/la app los llama sin ningún pago y contestan igual/),
    ).toBeInTheDocument();
    // La frase vieja, que afirmaba un cobro que no ocurre.
    expect(screen.queryByText("Lo que cobran los agentes")).toBeNull();
  });

  // El otro carril SÍ paga, y por eso no puede compartir la frase: ahí el fee lo liquida el gateway
  // contra la Agent Key de Chaski. Decir "no se cobra" también ahí sería el mismo error al revés.
  it("en el carril del gateway dice quién paga, en vez de decir que no se cobra", async () => {
    await verLaTarjeta([paso({ transport: "gateway", runsTodayAgentId: null })], 0.06);

    expect(screen.getByText(/lo paga Chaski con su Agent Key al ejecutar el paso/)).toBeInTheDocument();
    expect(screen.queryByText(/los llama sin ningún pago/)).toBeNull();
  });
});
