// @vitest-environment jsdom
//
// WKH-063 · SEGUNDO PASE (2ª parte) — LA COMPOSICIÓN VERTICAL DEL DESTINO "RECUPERAR".
//
// 🔴 EL DEFECTO QUE CIERRA. Es el MISMO que el pase anterior le cerró a la bienvenida, y acá era peor:
// el primer pase lo midió, lo anotó y lo dejó abierto porque vivía en otro archivo. Medido sobre el
// BUILD DE PRODUCCIÓN (`npm run build` + `npm start`) con Chrome headless, tres teléfonos:
//
//     viewport    fin del contenido   la barra empieza en   HUECO MÁS GRANDE
//     375x667              345px              566px          221px  ← 33%
//     390x844              345px              743px          398px  ← 47%
//     412x915              345px              814px          469px  ← 51%
//
// El contenido eran 259px (una cabecera de dos renglones y dos enlaces subrayados) y después nada:
// medio Pixel 7 en blanco. Y no le faltaba aire: le faltaban las dos cosas que una pantalla de
// recuperación tiene que contestar, que son **qué puedo recuperar** y **cómo**.
//
// DESPUÉS, mismo instrumento, mismos tres teléfonos:
//
//     viewport    contenido arranca   fin del contenido   la barra   HUECO MÁS GRANDE   doc
//     375x667              86px              710px          710px      24px  ←  4%      811px
//     390x844             122px              707px          743px      36px  ←  4%      844px
//     412x915             165px              735px          814px      79px  ←  9%      915px
//
// ⚠️ "HUECO MÁS GRANDE" ES EL HUECO EN CUALQUIER PARTE DE LA COLUMNA, no el del final, y la definición
// es deliberada: medir sólo el tramo entre el último texto y la barra se puede GANAR SIN ARREGLAR NADA
// —basta clavar una nota al pie con `mt-auto` y dejar el agujero en el medio—, así que el instrumento
// funde todas las bandas de tinta (nodos de texto por `Range`, hojas, bordes y fondos) y mide el salto
// máximo entre dos bandas consecutivas, incluido el tramo hasta la barra. A 412x915 el número de
// arriba (79px) es a la vez el sobrante de ARRIBA y el de ABAJO: el bloque quedó centrado, con el
// mismo margen a cada lado, que es la diferencia cualitativa contra "todo el vacío abajo".
//
// Y EL CONTROL QUE HACE HONESTA LA MEJORA, porque "llené la pantalla" es fácil de conseguir mal: esta
// pantalla NO quedó más alta que las otras. Altura del documento en el mismo build:
//
//     viewport    recuperar    bienvenida    send
//     375x667        811px        853px       834px    ← recuperar es la MÁS BAJA de las tres
//     390x844        844px        844px       844px
//     412x915        915px        915px       915px
//
// O sea: en el único teléfono de los tres donde la app scrollea, `recuperar` scrollea MENOS que la
// pantalla de entrada y menos que el formulario. No introduce una clase de dispositivo donde la app
// deje de caber.
//
// ── ⚠️ EL TERCER DESTINO, `history`, SIGUE SIN MEDIR — y esto es lo que sí se averiguó ─────────────
// El primer pase lo dejó abierto diciendo que hace falta una billetera conectada. Sigue siendo cierto y
// este pase tampoco lo midió: llegar a `history` pasa por `resolveSender` → `connectWallet`, y en un
// Chrome headless sin extensión el toque a la pestaña no hace nada. Medido, no supuesto: el instrumento
// que llega a `recuperar` tocando su pestaña, apuntado a "Mis envíos", devolvió números IDÉNTICOS a los
// de la bienvenida en los tres viewports (`853/844/915` de documento), o sea que nunca salió de la
// pantalla de entrada. Un número tomado así habría sido la bienvenida disfrazada de historial.
//
// LO QUE SÍ SE PUEDE AFIRMAR SIN NAVEGADOR, y es información nueva para el próximo pase: el defecto
// está ESTRUCTURALMENTE ABIERTO ahí. La raíz de `HistoryView` es `<div className="space-y-holgado">`
// (`HistoryView`, `flow.tsx:3303`), sin `flex-1` y sin `justify-center`, o sea exactamente la forma que
// tenía `recuperar` antes de este pase: anclada arriba, con todo el sobrante al pie. Y el tamaño del
// hueco ahí es CONDICIONAL al número de filas, que es la diferencia con las otras dos pantallas: con
// cero o una remesa va a ser grande, con muchas la pantalla scrollea y no hay hueco.
//
// QUÉ HARÍA FALTA para medirlo de verdad, dicho para que el próximo no lo improvise: un provider de
// billetera falso inyectado en el documento ANTES de que carguen los scripts (`window.phantom.solana`
// con `isPhantom`, `publicKey`, `connect`, `signMessage`) más `walletName` sembrado en `localStorage`
// para que el `autoConnect` del árbol de `@solana/wallet-adapter-react` lo elija. Eso es un doble de
// billetera dentro de un build de PRODUCCIÓN, así que antes de escribirlo hay que decidir si el número
// que sale de ahí cuenta como medición o no. No se hizo, y por eso acá no hay ninguna fila para
// `history`: una tabla con un número inventado es peor que una tabla con un hueco declarado.
//
// ⚠️ QUÉ PUEDE Y QUÉ NO PUEDE MEDIR ESTE ARCHIVO, declarado antes de los asserts. Acá corre jsdom, que
// NO hace layout y no corre Tailwind:
//   · NO mide un solo píxel. Los números de arriba son del navegador y están en este comentario porque
//     es el único lugar donde pueden estar; ningún test de este repo los reproduce.
//   · SÍ congela las decisiones de las que salen: que el bloque pida crecer y centrarse, que los dos
//     renglones nuevos digan lo que dicen, que lo que dicen sea EJECUTABLE, y que el consejo que
//     nombra otra pantalla se pueda SEGUIR hasta el final.
//   · Y SÍ congela la clase que NO hay que usar (T-063-16b), que es la que se midió inerte en este
//     mismo layout y en el código se ve exactamente igual que la que sí funciona.
//
// ── LOS DIEZ MUTANTES: APLICADOS Y CORRIDOS, no razonados ───────────────────────────────────────────
// Cada uno se editó en el árbol, se corrió este archivo (11 tests) y se anotó la salida. No es una
// lista de lo que "debería" fallar: son los conteos de la corrida.
//
//   MUTANTE APLICADO                                                          RESULTADO MEDIDO
//   1. la raíz sin `justify-center` (vuelve a quedar anclada arriba)          1 failed | 10 passed (11)
//   2. la raíz con `min-h-full` en vez de `flex-1` (la clase INERTE)          2 failed |  9 passed (11)
//   3. los dos renglones de `QUE_RECUPERA` INTERCAMBIADOS                     2 failed |  9 passed (11)
//   4. el renglón del envío perdido cambiado a "Devuelve tus USDC…"           3 failed |  8 passed (11)
//   5. `resolveSender` con el `address ??` de vuelta (cachea la 1ª cuenta)    1 failed | 10 passed (11)
//   6. el `Aviso` del consejo de "Mis envíos" borrado                         1 failed | 10 passed (11)
//   7. la nota de la red borrada                                             1 failed | 10 passed (11)
//   8. un `<Button>` (o sea `primary`) "Ver mis envíos" agregado acá         1 failed | 10 passed (11)
//   9. el `motion.div` de `flow.tsx` de vuelta a `flex-1` a secas            1 failed | 10 passed (11)
//  10. el renglón de la primera puerta sin renderizar (`flow.tsx`)           1 failed | 10 passed (11)
//
// ⚠️ EL 3 ES EL QUE JUSTIFICA EL ARCHIVO: intercambiar los dos renglones deja las dos frases existiendo
// letra por letra, así que un test que sólo verificara presencia las aprueba a las dos. Uno de los dos
// `it` que se ponen rojos es el que ABRE cada puerta y comprueba que adentro se hable de la moneda que
// el renglón anunció (verificado en la corrida, no deducido del conteo).
// EL 5 es el único que toca lógica y no texto: pone en rojo la nota del pie sobre la cuenta conectada,
// que es una afirmación sobre un MECANISMO y no sobre una pantalla.
// EL 8 es el que prueba que el último `it` no pasa por vacuidad, y también pone rojo la fila "recuperar"
// de `jerarquia-relativa.test.tsx` (`2 failed | 25 passed (27)` corriendo los dos archivos juntos): esa
// pantalla no puede ganar una acción resolutiva sin que alguien vaya a cambiar la fila y diga por qué.
//
// Y LOS MUTANTES 1 Y 3 SE CORRIERON ADEMÁS CONTRA LA SUITE COMPLETA (139 archivos), contra un baseline
// de `139 passed (139)` / `2478 passed (2478)`:
//     M1 ⇒ `1 failed | 138 passed (139)` · `1 failed | 2477 passed (2478)`   ← ESTE archivo y ninguno más
//     M3 ⇒ `1 failed | 138 passed (139)` · `2 failed | 2476 passed (2478)`   ← ídem
// O sea que fuera de acá nadie los ve, y eso es el dato: antes de este pase la composición vertical de
// este destino no la vigilaba nada.
//
// ⚠️ ANOTADO PORQUE PASÓ Y NO PORQUE SE ENTIENDA: en la PRIMERA corrida de M3 contra la suite completa
// falló además un `it` de otro archivo — `agent-plan-card.test.tsx > T-7.1 … > en 'gateway + agente
// ofrecido' el DOM no dice 'Hoy se llama directo a' ni 'Hoy no corre ese'`. NO se reprodujo: ese archivo
// da `32 passed (32)` aislado, la suite completa dio `139 passed` dos veces con el árbol restaurado, y
// la SEGUNDA corrida del MISMO mutante dio los números de arriba sin ese fallo. M3 cambia dos literales
// de `recuperar.tsx`, que ese archivo no importa, así que el mutante no puede ser la causa. Queda
// declarado como un flake candidato de OTRO archivo, SIN diagnosticar: "no se reprodujo" no es "está
// bien", y esta nota existe para que el próximo que lo vea no lo atribuya a esta HU.
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { RemittanceFlow } from "./flow";
import { QUE_RECUPERA } from "./recuperar";
import { buildTestContainer } from "../test-support/test-container";
import { Money } from "../domain/money";
import {
  type KycVerification,
  Remittance,
  type RemittanceState,
  toPersistedIdentity,
} from "../domain/remittance";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeConnectedWallet,
  FakeSolanaCloseableEscrowLister,
  FakeSolanaEscrowRefundGateway,
  FakeSolanaWallet,
  InMemoryRepo,
  T0,
  beneficiary,
} from "../test-support/fakes";

// El MISMO doble que `barra-destinos.test.tsx` y `bienvenida-composicion.test.tsx`: sin él el `exit` de
// AnimatePresence no completa en el mismo tick y el cambio de pantalla no se puede seguir con `get*`. Y
// acá cumple la segunda función que ya cumplía allá: el proxy PASA LAS PROPS al tag, así que el
// `className` del `motion.div` de `flow.tsx` llega al DOM y T-063-16c lo puede leer.
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

const OTRA_CUENTA = "8tJVcM2JmYcMNCcNFYtUpXVWvKNTfnrCEwLuTRHpF9dQ";

/**
 * El mundo del destino: las DOS puertas cableadas (sin sus gateways cada una devuelve `null` sola y no
 * hay nada que medir) más la costura que `resolveSender` usa de verdad.
 *
 * ⚠️ `connectedWallet` ES LA COSTURA QUE IMPORTA y no `wallet`: desde WKH-354 `resolveSender` le
 * pregunta a la billetera VIVA (`resolveSender`, `flow.tsx:396`) en cada búsqueda, no al `useState`.
 * Un test que sólo cambiara `wallet` no mediría nada de la nota del pie.
 */
function mundo() {
  const refund = new FakeSolanaEscrowRefundGateway();
  const lister = new FakeSolanaCloseableEscrowLister([]);
  const probe = new FakeConnectedWallet(FAKE_SOLANA_BENEFICIARY);
  return {
    refund,
    lister,
    probe,
    container: buildTestContainer({
      wallet: new FakeSolanaWallet(),
      connectedWallet: probe,
      solanaRefund: refund,
      solanaCloseableEscrows: lister,
    }),
  };
}

const pintarRecuperar = (container: ReturnType<typeof mundo>["container"]) =>
  render(<RemittanceFlow pasoInicial="recuperar" container={container} />);

// ══ LOS DOS RENGLONES · la tabla escrita a mano, que es lo único normativo del bloque ══════════════
//
// 🔴 LAS FRASES VAN ESCRITAS ACÁ, LETRA POR LETRA. Sí se importa `QUE_RECUPERA`, y sólo para comparar
// contra estos literales: un test que le preguntara al código qué dice y después verificara que dijo
// eso aprueba cualquier cosa. Es el mismo criterio con el que `bienvenida-composicion.test.tsx`
// escribe sus tres pasos y con el que `barra-destinos.test.tsx` escribe el literal de `DEMO_PILL`.
//
// Y `moneda` / `sinMoneda` son la otra mitad, la que impide que esto sea un test de ortografía: es lo
// que la puerta tiene que decir ADENTRO para que el renglón de afuera sea cierto.
const RENGLONES = [
  {
    puerta: /Recuperar un envío perdido/,
    frase: "Busca USDC: los de un envío que no llegó a completarse y pueden seguir en el contrato.",
    real: QUE_RECUPERA.envioPerdido,
    // Esta puerta habla de USDC y de ninguna cifra en SOL: lo que saca del contrato son los USDC del
    // envío ("esa sí es la transacción que saca tus USDC", en su propio cuerpo).
    dice: /USDC/,
    noDice: /\d[.,]\d+\s*SOL/,
  },
  {
    puerta: /Recuperar el depósito de red de envíos anteriores/,
    frase:
      "Busca SOL: el depósito que la red retiene por las cuentas de un envío, y que sólo se libera cerrándolas cuando ese envío ya terminó.",
    real: QUE_RECUPERA.depositoDeRed,
    // Y ésta habla de una CIFRA EN SOL, que sale de `ESCROW_DEPOSIT_RENT_LAMPORTS` formateada por
    // `escrowRentExplainer`. La cifra es lo que distingue las dos puertas de verdad: la de al lado no
    // tiene ninguna. ⛔ El regex pide un dígito antes de "SOL" a propósito — un `/SOL/` pelado también
    // matchearía la palabra en otra frase, y "Solana" (que las dos dicen) no matchea ninguno de los
    // dos porque el case importa.
    dice: /\d[.,]\d+\s*SOL/,
    noDice: null,
  },
] as const;

describe("T-063-13 (2º pase): cada puerta dice QUÉ MONEDA busca, y se comprueba abriéndola", () => {
  it("los dos renglones son EXACTAMENTE los de la tabla, y son dos", () => {
    // MUTANTE 4 (aplicado): cambiar el primero por "Devuelve tus USDC…" ⇒ rojo acá y en el `it` de
    // abajo. Una lista CERRADA y no un `toContain` por renglón: el riesgo del par es que los dos digan
    // lo mismo, y eso sólo se ve comparando los dos contra dos literales fijos.
    expect(Object.keys(QUE_RECUPERA)).toHaveLength(2);
    expect(RENGLONES.map((r) => r.real)).toEqual(RENGLONES.map((r) => r.frase));
  });

  it("ninguno promete que la plata vuelve, ni nombra un plazo ni una comisión", () => {
    // MUTANTE 4 (aplicado): "Devuelve tus USDC, si un envío no llegó a completarse…" ⇒ rojo.
    //
    // POR QUÉ. Las dos puertas pueden no encontrar nada, y aun encontrando, la orden puede quedar sin
    // desenlace conocido: la regla ya está escrita en `RefundSentNotice` ("Enviamos la orden", NUNCA
    // "volvieron"). El verbo tiene que ser el de lo que la puerta hace al tocarla, y es `busca`.
    // Y ninguno puede nombrar un plazo ni una comisión: los dos existen y los dos están dichos ADENTRO
    // de la puerta que corresponde, con su condición al lado. Acá arriba serían una segunda copia sin
    // condición, que es lo que el docblock de `recuperar.tsx` prohíbe.
    for (const { real, frase } of RENGLONES) {
      expect(real, frase).toMatch(/^Busca /);
      expect(real, frase).not.toMatch(/devuelve|recuperás|vuelven|volvés a tener/i);
      expect(real, frase).not.toMatch(/\bminutos?\b|\bhoras?\b|\bdías?\b|comisión/i);
    }
  });

  it("🔴 abrir cada puerta muestra la moneda que su renglón anunció (se abre, no se lee)", () => {
    // MUTANTE 3 (aplicado): intercambiar `envioPerdido` y `depositoDeRed` ⇒ rojo, y es el mutante que
    // justifica el archivo entero. Las dos frases siguen existiendo letra por letra, así que el `it`
    // de arriba las aprobaría igual (sólo cambiaría a qué puerta se le pegó cada una): lo único que lo
    // caza es ABRIR la puerta y mirar de qué moneda habla adentro.
    //
    // El intercambio se caza por los DOS lados, y por eso hay `dice` y `noDice`:
    //   · el renglón "Busca SOL" pegado a la puerta del envío perdido ⇒ su panel no tiene ninguna
    //     cifra en SOL ⇒ rojo por `dice`;
    //   · el renglón "Busca USDC" pegado a la puerta del alquiler ⇒ su panel SÍ tiene la cifra en SOL,
    //     que es de lo que esa puerta habla ⇒ rojo por `noDice`.
    //
    // ⚠️ LO QUE ESTE `it` NO VERIFICA, dicho antes de que alguien lo lea de más: que "sólo se libera
    // cuando ese envío ya terminó" sea cierto. Eso es un guard de la cadena
    // (`escrow_not_terminal`, `../infrastructure/solana-wallet.ts:1352`) y ya tiene su propio test
    // ejecutable en `solana-wallet.close.test.ts:391`, que comprueba que un `EscrowState` en
    // `Deposited` aborta ANTES de firmar. Acá se apunta a él en vez de escribir una segunda versión.
    for (const { puerta, dice, noDice, frase } of RENGLONES) {
      const { unmount } = pintarRecuperar(mundo().container);
      const boton = screen.getByRole("button", { name: puerta });
      // El renglón acompaña a su puerta EN EL DOM: hermano dentro del mismo envoltorio. Sin esto, los
      // dos renglones podrían estar los dos abajo del primero y este test no lo vería.
      expect(boton.parentElement?.textContent, frase).toContain(
        RENGLONES.find((r) => r.puerta === puerta)?.frase,
      );
      fireEvent.click(boton);
      const panel = document.body.textContent ?? "";
      expect(panel, `«${frase}» ⇒ la puerta tiene que hablar de esa moneda`).toMatch(dice);
      if (noDice !== null) {
        expect(panel, `«${frase}» ⇒ y NO de la otra`).not.toMatch(noDice);
      }
      unmount();
      cleanup();
    }
  });
});

// ══ EL PIE · CON QUÉ CUENTA SE BUSCA ═══════════════════════════════════════════════════════════════

describe("T-063-14 (2º pase): el pie dice con qué cuenta se busca, y la búsqueda usa ESA cuenta", () => {
  /** Los dos gestos de la puerta del envío perdido: abrirla y buscar. */
  const buscar = async () => {
    const abrir = screen.queryByRole("button", { name: /Recuperar un envío perdido/ });
    if (abrir !== null) fireEvent.click(abrir);
    fireEvent.click(await screen.findByRole("button", { name: /Buscar mis escrows/ }));
  };

  it("🔴 cambiar la cuenta conectada entre dos búsquedas cambia el `sender` de la segunda", async () => {
    // MUTANTE 5 (aplicado): devolver el `address ??` a `resolveSender` (`flow.tsx:396`), o sea cachear
    // la primera cuenta como estaba antes de WKH-354 ⇒ rojo. Es el único mutante de este archivo que
    // toca lógica y no texto, y es el que hace que la nota del pie sea una afirmación medida: dice
    // "cambiala ahí antes de buscar", y esto EJECUTA ese gesto y mira con qué `sender` salió la
    // búsqueda.
    //
    // POR QUÉ ESTA NOTA EXISTE. Es la precondición que decide si las dos puertas pueden encontrar
    // algo (las dos resuelven por `sender`), no estaba dicha en ninguna de las dos —ni abiertas ni
    // cerradas—, y es la causa #1 de un "no encontramos nada" que no significa "no tenés nada":
    // buscar con la cuenta B los envíos que firmó la A. El copy de la cadena ya manda gente acá
    // justamente por eso (`escrowOutcomeDisplay`, `flow-vm.ts:1253`).
    const { refund, probe, container } = mundo();
    pintarRecuperar(container);

    await buscar();
    await waitFor(() => expect(refund.calls).toHaveLength(1));
    expect(refund.calls[0]?.sender).toBe(FAKE_SOLANA_BENEFICIARY);

    // "cambiala ahí antes de buscar" — el gesto del copy, sobre la costura que `resolveSender` lee.
    probe.switchTo(OTRA_CUENTA);
    await buscar();
    await waitFor(() => expect(refund.calls).toHaveLength(2));
    expect(refund.calls[1]?.sender).toBe(OTRA_CUENTA);
    expect(refund.calls[1]?.sender).not.toBe(FAKE_SOLANA_BENEFICIARY);
  });

  it("(control) sin cambiar de cuenta, las dos búsquedas salen con la misma", async () => {
    // Sin este control el test de arriba podría estar verde porque el doble contesta `OTRA_CUENTA`
    // pase lo que pase. Mismo recorrido, sin el gesto del medio.
    const { refund, container } = mundo();
    pintarRecuperar(container);
    await buscar();
    await waitFor(() => expect(refund.calls).toHaveLength(1));
    await buscar();
    await waitFor(() => expect(refund.calls).toHaveLength(2));
    expect(refund.calls.map((c) => c.sender)).toEqual([
      FAKE_SOLANA_BENEFICIARY,
      FAKE_SOLANA_BENEFICIARY,
    ]);
  });
});

// ══ EL CONSEJO QUE NOMBRA OTRA PANTALLA, RECORRIDO ════════════════════════════════════════════════

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

/** Una remesa que YA depositó y quedó en curso: su pantalla ofrece recuperar los USDC. */
function depositada(id: string): RemittanceState {
  const r = Remittance.create(id, beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(
    {
      quoteId: "q",
      send: Money.of(400, "USDC"),
      receive: Money.of(1478.15, "PEN"),
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.7,
      etaMinutes: 30,
      expiresAt: "2026-07-10T00:00:00.000Z",
      provenance: "didit",
    },
    T0,
  );
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPrincipalIn("solana-sig", T0);
  r.markPayoutSubmitted("transfi-sol-po-1", T0, "transfi");
  return r.snapshot;
}

describe("T-063-15 (2º pase): el consejo de «Mis envíos» se puede SEGUIR desde esta pantalla", () => {
  it("🔴 se sigue el consejo tal como está escrito y se llega al botón de recuperar", async () => {
    // MUTANTE 6 (aplicado): borrar el `Aviso` del consejo ⇒ rojo por el primer `expect`.
    //
    // POR QUÉ ES UN RECORRIDO Y NO UN `getByText`. Es la lección que el auto-blindaje de esta misma HU
    // ya dejó escrita: esta HU YA rompió un copy que nombraba una ubicación ("volvé a la pantalla de
    // inicio: ahí está la opción de recuperar un envío perdido"), y lo cazó un test que EJECUTABA el
    // consejo, no uno que verificaba que el consejo existiera. Éste es copy nuevo que nombra otra
    // pantalla, así que nace con su recorrido.
    //
    // ⚠️ EL CONSEJO ES CONDICIONAL Y EL TEST CAMINA LA RAMA AFIRMATIVA, que es la única que se puede
    // caminar: dice "si sus USDC se pueden recuperar la opción está en esa misma pantalla", y la
    // opción está gateada (`showRefund && recover && sender`). Un envío ya entregado no la tiene, y por
    // eso la frase NO dice "cada envío tiene su recuperación".
    const repo = new InMemoryRepo();
    await repo.save(Remittance.rehydrate(depositada("rem-1")));
    const refund = new FakeSolanaEscrowRefundGateway();
    const container = buildTestContainer({
      repo,
      wallet: new FakeSolanaWallet(),
      connectedWallet: new FakeConnectedWallet(FAKE_SOLANA_BENEFICIARY),
      solanaRefund: refund,
      solanaCloseableEscrows: new FakeSolanaCloseableEscrowLister([]),
    });
    pintarRecuperar(container);

    // (1) El consejo, en pantalla, y los tres pedazos que este test va a ejecutar salen DEL COPY.
    const consejo = screen.getByText(/¿El envío te aparece en "Mis envíos"\?/);
    expect(consejo).toBeInTheDocument();
    expect(consejo.textContent).toContain("Abrilo desde ahí");
    expect(consejo.textContent).toContain("si sus USDC se pueden recuperar");

    // (2) "Mis envíos" — el nombre exacto de la pestaña, no un regex: /Recuperar/ y /Mis/ sueltos
    //     matchean más de un control en esta pantalla.
    fireEvent.click(screen.getByRole("button", { name: "Mis envíos" }));
    expect(await screen.findByText(/Tus envíos/)).toBeInTheDocument();

    // (3) "Abrilo desde ahí".
    fireEvent.click(await screen.findByRole("button", { name: /Ver seguimiento/ }));

    // (4) "la opción está en esa misma pantalla" — y se llega hasta el gateway, no hasta el borde.
    const recuperar = await screen.findByRole("button", { name: /Recuperar fondos/ });
    expect(recuperar).toBeEnabled();
    fireEvent.click(recuperar);
    await waitFor(() => expect(refund.calls).toHaveLength(1));
    expect(refund.calls[0]).toEqual({
      remittanceId: "rem-1",
      sender: FAKE_SOLANA_BENEFICIARY,
    });
  });
});

// ══ LA COMPOSICIÓN · las dos mitades que producen los píxeles del encabezado ═══════════════════════

/**
 * El envoltorio del destino y su padre, DERIVADOS del árbol y no buscados por la clase que estos tests
 * vigilan.
 *
 * 🔴 POR QUÉ NO ES UN `querySelector(".justify-center")`: sería el guard que se compara consigo mismo
 * que este repo ya tiene documentado. Se buscaría el elemento POR la clase que hay que verificar, así
 * que borrar la clase daría "no encontré el elemento" en vez de "la clase no está".
 *
 * El ancla son dos hechos ESTRUCTURALES de la pantalla, no dos frases: el titular y una de las dos
 * puertas. La raíz es el ancestro más cercano de la puerta que TAMBIÉN contiene el titular.
 *
 * ⚠️ Y NO SE ANCLA EN LA NOTA DE LA RED, que fue la primera versión: con ese ancla, borrar la nota
 * ponía en rojo los CUATRO `it` de este bloque en vez de uno, o sea que tres de ellos fallaban por un
 * motivo que no es el suyo. Medido corriendo el mutante 7 con las dos versiones: `4 failed` con la nota
 * de ancla, `1 failed` con ésta. Un ancla tiene que ser lo que no puede desaparecer sin que la pantalla
 * deje de ser esta pantalla.
 */
function bloque() {
  const puerta = screen.getByRole("button", { name: /Recuperar un envío perdido/ });
  const titulo = screen.getByRole("heading", {
    level: 2,
    name: "Recuperar fondos de un envío anterior",
  });
  let raiz: HTMLElement | null = puerta.parentElement;
  while (raiz !== null && !raiz.contains(titulo)) raiz = raiz.parentElement;
  if (raiz === null) throw new Error("no encontré el envoltorio de `recuperar` (¿cambió el árbol?)");
  const envoltorio = raiz.parentElement;
  if (envoltorio === null) throw new Error("el envoltorio de `recuperar` no tiene padre");
  return { raiz, envoltorio, puerta, titulo };
}

describe("T-063-16 (2º pase): el bloque pide crecer y centrarse, y su padre puede dárselo", () => {
  it("🔴 la raíz pide las dos cosas: crecer (`flex-1`) y centrar (`justify-center` en columna)", () => {
    // MUTANTE 1 (aplicado): borrar `justify-center` ⇒ rojo. Sin él el bloque crece igual pero el
    // contenido se apoya arriba y el sobrante vuelve entero abajo: es el defecto original con más
    // contenido, o sea 158px de nada al pie en vez de 79 arriba y 79 abajo.
    //
    // ⚠️ ESTO CONGELA LA DECLARACIÓN, NO EL PÍXEL, y está dicho así a propósito: jsdom no hace layout.
    pintarRecuperar(mundo().container);
    const { raiz } = bloque();
    expect(raiz.className, "sin `flex-1` no hay altura contra la que centrar").toContain("flex-1");
    expect(raiz.className, "sin `justify-center` el sobrante vuelve entero abajo").toContain(
      "justify-center",
    );
    expect(raiz.className, "y tiene que ser una columna flex para que el centrado sea vertical").toContain(
      "flex-col",
    );
  });

  it("🔴 y NO usa `min-h-full`: en este layout esa clase se midió INERTE", () => {
    // MUTANTE 2 (aplicado): `min-h-full` en lugar de `flex-1` ⇒ rojo acá, y en el navegador NO SE VE
    // NINGUNA DIFERENCIA con no poner nada. No es una hipótesis: el primer pase de esta misma HU
    // escribió esa clase para centrar la bienvenida y la midió, poniendo las cuatro variantes por DOM
    // a 412x915 sobre el build de producción:
    //
    //     `min-height:100%`   ⇒ el hijo midió 644px dentro de un padre de 728px   (no hizo NADA)
    //     `height:100%`       ⇒ 644px                                             (tampoco)
    //     sin nada            ⇒ 644px                                             (idéntico: la prueba)
    //     padre `flex-col` + hijo `flex-grow:1` ⇒ 728px                            (el único que estira)
    //
    // El motivo: el padre es un ÍTEM flex, no un CONTENEDOR flex, así que un porcentaje de altura no
    // tiene contra qué resolver. La clase compila, pasa `tsc`, pasa `biome` y no produce ningún efecto.
    // Este `it` existe porque `recuperar` es la SEGUNDA pantalla que usa esta receta, y una clase
    // inerte que se ve igual que la buena entra por copia.
    pintarRecuperar(mundo().container);
    const { raiz } = bloque();
    expect(
      raiz.className,
      "`min-h-full` acá no hace nada (medido): el padre es un ítem flex, no un contenedor",
    ).not.toContain("min-h-full");
  });

  it("🔴 el envoltorio compartido es un CONTENEDOR flex en columna, o el `flex-1` de arriba no sirve", () => {
    // MUTANTE 3 del PRIMER pase, que vale igual acá: devolver el `motion.div` de `flow.tsx` a
    // `className="flex-1"` a secas ⇒ rojo. Es la otra mitad del arreglo y ninguna sirve sola.
    // ⛔ Y ESE ENVOLTORIO NO PUEDE LLEVAR `justify-center`, que sería la forma "corta": lo comparten
    // TODAS las pantallas, así que centraría también el formulario y el recibo. Que no lo lleve ya lo
    // vigila `bienvenida-composicion.test.tsx`; acá se pide la mitad que este destino necesita.
    pintarRecuperar(mundo().container);
    const clases = bloque().envoltorio.className.split(/\s+/);
    expect(clases, "el padre tiene que ser `display:flex`").toContain("flex");
    expect(clases, "y en columna, o `flex-1` crecería a lo ancho").toContain("flex-col");
    expect(clases, "y seguir siendo el que ocupa el alto sobrante del `<main>`").toContain("flex-1");
  });

  it("la nota de la red dice «Solana devnet», y el literal va escrito ACÁ y no importado del resolver", () => {
    // MUTANTE 7 (aplicado): borrar la nota ⇒ rojo (y también rompe `bloque()`, que la usa de ancla).
    //
    // POR QUÉ EL LITERAL A MANO: si esto asserteara `resolveSolanaNetworkConfig().cluster` sería un
    // guard que se compara consigo mismo y pasaría con cualquier red, incluida la equivocada. Mismo
    // criterio que el `it` gemelo de la bienvenida.
    //
    // ⛔ Y NO ES DECORACIÓN, y en ESTA pantalla menos que en la otra: acá la persona puede querer ir a
    // mirar sus cuentas al explorador por su cuenta, y el explorador pide el cluster en la URL
    // (`resolveSolanaExplorerTxUrl`, `../infrastructure/chain.ts:224`). Sale del MISMO resolver que
    // firma, así que la pantalla no puede nombrar una red distinta de la real.
    pintarRecuperar(mundo().container);
    expect(screen.getByText(/Las cuentas de tus envíos viven en Solana devnet/)).toBeInTheDocument();
  });

  it("y esta pantalla sigue sin ninguna acción `primary`: la composición no cambió la jerarquía", () => {
    // El par del docblock de `recuperar.tsx`. El candidato obvio para llenar los 469px era un botón
    // "Ver mis envíos" acá, y habría hecho dos daños: duplicar la pestaña de la barra (AC-4) y
    // convertir esta pantalla en `resolutiva`, o sea obligarla a tener un `primary`
    // (`jerarquia-relativa.test.tsx`, fila "recuperar"). Se resolvió sin tocar la jerarquía, y esto lo
    // clava desde acá también: el consejo de "Mis envíos" es PROSA, no un control.
    //
    // ⚠️ Lo que este `it` mide es que no haya `<Button>` de la app en esta pantalla: la variante vive
    // en el `className` renderizado (`BTN_VARIANTS`, `ui.tsx:46`), y las tres pestañas de la barra son
    // `<button>` planos. Que la REGLA de qué es `primary` no se relaje sigue siendo trabajo de
    // `jerarquia-relativa.test.tsx`.
    pintarRecuperar(mundo().container);
    const conFondoDeCta = [...document.querySelectorAll("button")].filter((b) =>
      b.className.includes("bg-cochineal "),
    );
    expect(
      conFondoDeCta.map((b) => b.textContent),
      "una acción resolutiva nueva acá obliga a cambiar la fila de `jerarquia-relativa.test.tsx`",
    ).toEqual([]);
  });
});
