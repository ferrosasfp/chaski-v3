// @vitest-environment jsdom
//
// Tests · ola 2 de rediseño (M-1 a M-6): lo que las pantallas ganaron, y lo que NO pueden perder.
//
// ⚠️ LO PRIMERO, PORQUE ACOTA TODO LO DEMÁS. Acá no corre Tailwind y jsdom NO hace layout. Estos
// tests leen NOMBRES DE CLASE sobre el elemento REALMENTE RENDERIZADO y la ESTRUCTURA del DOM. Que
// `text-money` produzca 32px, que `top-aire` produzca 24px o que el conector se vea como una línea
// lo hace el compilador de Tailwind y el navegador, y esta suite no lo verifica. Es la misma
// limitación que ya declaran `touch-targets.test.tsx` y `sistema-de-diseno.test.tsx`, y leerla de
// menos sería leer estos verdes como "la pantalla se ve bien".
//
// Lo que sí se puede afirmar desde acá, y es lo que cada bloque fija:
//   · que el vocabulario viejo YA NO ESTÁ ESCRITO en ningún lado (T-O2-1 y T-O2-2). Esto no lo puede
//     hacer `tsc`: una clase de Tailwind es un string adentro de un `className`, así que un
//     `rounded-xl2` olvidado compila, pasa el typecheck y NO EMITE NINGUNA REGLA. El borde
//     desaparece en silencio, que es el peor modo de falla de los tres.
//   · que el conector de M-3 existe, progresa, y NO rompe el helper que otro archivo usa para medir
//     los tonos de los pasos (T-O2-3 a T-O2-6).
//   · que la jerarquía de M-4 bajó el peso del control que consulta SIN bajarle el área de toque
//     (T-O2-7, T-O2-8 y T-O2-11).
//   · que la cifra usa un solo rol y sigue siendo un nodo de texto (T-O2-9).
//   · que las dos señales de entorno de prueba de M-6 hablan el mismo idioma visual y siguen siendo
//     dos textos distintos (T-O2-10).
//
// 🔴 REGLA DE ESTE ARCHIVO, heredada de `history-onchain.test.tsx`: cada test nombra la edición
// plausible que lo pone en rojo. Un test que no puede nombrar su mutante no es cobertura.
//
// ══ LOS ONCE MUTANTES, APLICADOS Y MEDIDOS ═════════════════════════════════════════════════════
// No es una lista de lo que "debería" fallar: es la salida de correrlos uno por uno sobre el árbol
// de esta rama, con el archivo en 23 tests. Cada uno se aplicó, se corrió y se revirtió.
//   · el conector escrito como `<span>`                        ⇒ 4 failed | 19 passed
//   · el tramo pintado con `active` en vez de `reached`         ⇒ 4 failed | 19 passed
//   · un tramo por paso (sin el guard del último)               ⇒ 1 failed | 22 passed
//   · `h-[52px]` mudado de la clase base a la variante `primary` ⇒ 2 failed | 21 passed
//   · `ghost` de vuelta a `text-stone`                          ⇒ 1 failed | 22 passed
//   · el gesto de revisar de vuelta a `primary`                 ⇒ 1 failed | 22 passed
//   · un `rounded-xl2` olvidado en un `className`               ⇒ 1 failed | 22 passed
//   · un `tabular` a mano en un `className`                     ⇒ 1 failed | 22 passed
//   · un `text-sm` nuevo en `flow.tsx`                          ⇒ 1 failed | 22 passed
//   · la cifra del recibo con un `text-4xl` encima              ⇒ 1 failed | 22 passed
//   · la píldora de demo de vuelta a `bg-sand text-ink`         ⇒ 1 failed | 22 passed
//
// 🔴 Y EL PRIMERO DE LOS ONCE ES EL QUE MÁS ENSEÑA, porque la PRIMERA versión de este archivo lo
// dejaba pasar: asserteaba que el primer `<span>` del paso tuviera `rounded-full`, y el conector
// también lo lleva (son sus puntas redondeadas), así que el candado se confirmaba con exactamente lo
// que venía a detectar. Está contado en el `it` que lo arregla.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { Receipt, TrackView } from "./flow";
import { Button } from "./ui";
import { Money } from "../domain/money";
import {
  type KycVerification,
  Remittance,
  type RemittanceState,
  toPersistedIdentity,
} from "../domain/remittance";
import { FAKE_SOLANA_BENEFICIARY, FakeSolanaEscrowRefundGateway, FixedClock, InMemoryRepo, T0, beneficiary } from "../test-support/fakes";
import { InMemoryPopProofStore } from "../infrastructure/auth/pop-proof-store";
import { RecoverEscrowFunds } from "../application/use-cases/recover-escrow-funds";

afterEach(cleanup);

// ══ El árbol, para los dos barridos estáticos ═══════════════════════════════════════════════════
//
// Se recorre el mismo conjunto que el candado de citas: `src` y `app`, `.ts`/`.tsx`. Se excluyen los
// `*.test.*` a propósito, y no por comodidad: ESTE archivo nombra las clases viejas para poder
// buscarlas, así que incluirse a sí mismo haría que el guard se encontrara siempre.
const ROOT = process.cwd();
const SKIP = new Set(["node_modules", ".next", "doc", "migrations"]);

function recorrer(dir: string, out: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    const full = path.join(dir, entrada);
    if (statSync(full).isDirectory()) {
      if (!SKIP.has(entrada)) recorrer(full, out);
    } else if (/\.tsx?$/.test(entrada) && !/\.(test|spec)\./.test(entrada)) {
      out.push(full);
    }
  }
  return out;
}

const FUENTES = ["src", "app"].flatMap((d) => recorrer(path.join(ROOT, d)));

/** Los `className="..."` de un archivo. NUNCA el archivo entero: los comentarios de este repo citan
 *  clases viejas para contar su historia, y un barrido textual las contaría como usos. */
function clasesDe(abs: string): string[] {
  const src = readFileSync(abs, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{cn\(([\s\S]*?)\)\})/g)) {
    out.push(m[1] ?? m[2] ?? "");
  }
  // Y los mapas de variantes (`BTN_VARIANTS`, `PILL`, `AVISO`), que son listas de clases sueltas.
  for (const m of src.matchAll(/^\s{2}\w+:\s*"([a-z0-9][^"]*)",$/gm)) out.push(m[1] ?? "");
  return out;
}

const CLASES_DEL_ARBOL = FUENTES.flatMap((f) => clasesDe(f).map((c) => ({ archivo: f, clases: c })));

describe("T-O2-1 (M-1): el vocabulario retirado ya no está ESCRITO en ninguna pantalla", () => {
  it("el barrido encuentra clases (si diera 0, todo lo de abajo pasaría por vacío)", () => {
    // La trampa de siempre: un guard que no encuentra lo que vigila da verde igual. El piso es el
    // conteo medido al escribirlo, no un objetivo.
    expect(CLASES_DEL_ARBOL.length).toBeGreaterThan(100);
  });

  it.each([
    // INPUT QUE LO PONE EN ROJO: escribir cualquiera de estas dos en un `className` de `src` o `app`.
    ["rounded-xl2", "el token se BORRÓ del tema en la ola 2: escribirlo no emite ninguna regla"],
    ["tabular", "la clase a mano de `globals.css` se borró; la de fábrica es `tabular-nums`"],
  ])("no queda ningún `%s`", (clase, porQue) => {
    const culpables = CLASES_DEL_ARBOL.filter(({ clases }) =>
      clases.split(/\s+/).includes(clase),
    ).map(({ archivo }) => path.relative(ROOT, archivo));
    expect(culpables, porQue).toEqual([]);
  });
});

describe("T-O2-2 (M-1): las pantallas hablan el vocabulario por ROL, no el de fábrica", () => {
  it("no queda ningún tamaño de texto de fábrica en `flow.tsx` ni en `ui.tsx`", () => {
    // El punto de S-1 no era tener seis roles: era que la pregunta "¿qué tamaño le pongo a esto?"
    // dejara de contestarse comparando pantallas. Mientras convivan los dos vocabularios, se sigue
    // contestando comparando.
    //
    // INPUT QUE LO PONE EN ROJO: un `text-sm` nuevo en cualquiera de los dos archivos.
    const viejos = /^text-(xs|sm|base|lg|xl|[2-9]xl)$/;
    const culpables: string[] = [];
    for (const rel of ["src/presentation/flow.tsx", "src/presentation/ui.tsx"]) {
      for (const clases of clasesDe(path.join(ROOT, rel))) {
        for (const c of clases.split(/\s+/)) if (viejos.test(c)) culpables.push(`${rel}: ${c}`);
      }
    }
    expect(culpables).toEqual([]);
  });
});

// ══ El montaje del seguimiento ══════════════════════════════════════════════════════════════════

const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true, realVerified: true, verifiedAt: null,
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

/** `demo` cambia SÓLO la proveniencia del desembolso, que es lo que `isDemoMode` mira: con un valor
 *  fuera de `REAL_PAYOUT_PROVENANCES` se prenden las dos señales de entorno de prueba. Nada más del
 *  snapshot cambia, así que los tests de M-6 hablan de la misma pantalla que los de M-3. */
function remesa(
  hasta: "confirmed" | "principal_in" | "payout_submitted" | "settled",
  { demo = false }: { demo?: boolean } = {},
): RemittanceState {
  const r = Remittance.create("rem-o2", beneficiary(), Money.of(400, "USDC"), T0);
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
  if (hasta === "confirmed") return r.snapshot;
  r.markPrincipalIn("solana-sig", T0);
  if (hasta === "principal_in") return r.snapshot;
  r.markPayoutSubmitted("transfi-sol-po-1", T0, demo ? "mock" : "transfi");
  if (hasta === "payout_submitted") return r.snapshot;
  r.markSettled(T0, Money.of(1478.15, "PEN"), demo ? "mock" : "transfi");
  return r.snapshot;
}

function pintarSeguimiento(rem: RemittanceState) {
  return render(<TrackView rem={rem} recover={undefined} sender={null} onRecovered={() => {}} />);
}

/** Los tramos del camino, en orden. Salen del DOM, no del fuente. */
function tramos(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="camino-tramo-"]'));
}

describe("T-O2-3 (M-3): los tres pasos son un camino, y el camino tiene UN tramo menos que pasos", () => {
  it("hay exactamente dos tramos para tres pasos", () => {
    // 🔴 EL MUTANTE QUE MATA, y es el tentador: sacar el `i < TRACK_STEPS.length - 1` y dibujar un
    // tramo por paso. El de más cuelga bajo el último ícono, o sea que el camino sigue después del
    // final y promete un paso que no existe. Un test de PRESENCIA no lo ve; éste cuenta.
    const { container } = pintarSeguimiento(remesa("payout_submitted"));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(tramos(container)).toHaveLength(2);
  });
});

describe("T-O2-4 (M-3): el camino PROGRESA, no está pintado de una", () => {
  it.each([
    // estado de la remesa, tramo 0, tramo 1
    ["confirmed" as const, "bg-line", "bg-line"],
    ["principal_in" as const, "bg-line", "bg-line"],
    ["payout_submitted" as const, "bg-verde", "bg-line"],
    ["settled" as const, "bg-verde", "bg-verde"],
  ])("en `%s` los dos tramos son %s y %s", (estado, esperado0, esperado1) => {
    // 🔴 ESTE ES EL TEST QUE HACE AL CONECTOR "UNA LÍNEA QUE PROGRESA" Y NO UNA DECORACIÓN. Los dos
    // mutantes que mata:
    //   · pintar el tramo con `active` en vez de con `reached`: en `payout_submitted` el tramo 1 se
    //     pondría verde, o sea que el camino afirmaría un tramo recorrido que no se recorrió.
    //   · dejar los dos tramos con una clase fija: la fila de `settled` y la de `confirmed` darían
    //     el mismo resultado y el conector no diría nada.
    // ⚠️ `confirmed` y `principal_in` dan lo mismo A PROPÓSITO: en los dos el primer paso está EN
    // CURSO y no completado, que es la distinción que `flow.test.tsx` ya defiende para los íconos.
    const { container } = pintarSeguimiento(remesa(estado));
    const [t0, t1] = tramos(container);
    expect(t0?.className, "tramo 0").toContain(esperado0);
    expect(t1?.className, "tramo 1").toContain(esperado1);
  });
});

describe("T-O2-5 (M-3): el conector NO es un `<span>`, y eso protege un test de OTRO archivo", () => {
  it.each(["confirmed", "principal_in", "payout_submitted", "settled"] as const)(
    "en `%s`, el primer `<span>` de cada paso sigue siendo el círculo del ícono",
    (estado) => {
      // 🔴 EL MUTANTE MÁS PROBABLE DE TODA ESTA OLA, porque es el cambio que uno haría sin pensarlo:
      // escribir el conector como `<span>` en vez de `<div>`. `flow.test.tsx` mide el tono de cada
      // paso con `li.querySelector("span")`, o sea el PRIMER `<span>` del `<li>` en orden de
      // documento, y espera el círculo. Con un `<span>` delante, esos asserts pasan a medir el
      // conector.
      //
      // 🔴 Y ACÁ HAY DOS COSAS QUE MEDÍ Y ME SALIERON AL REVÉS DE LO QUE HABÍA ESCRITO. Las dos van
      // acá porque son el motivo de la forma que este `it` tiene hoy:
      //
      //   1. La primera versión de este test asserteaba que el primer `<span>` tuviera
      //      `rounded-full`. APLICADO el mutante, daba VERDE: el conector también lleva
      //      `rounded-full` (son sus puntas redondeadas), así que el assert se cumplía sobre el
      //      elemento equivocado. Un candado que se confirma con lo que vino a detectar.
      //   2. El comentario decía que `flow.test.tsx` NO caía con ese mutante. MEDIDO: cae, 2 de 110.
      //      Pero SOLO en algunos estados: en `settled` los dos conectores son `bg-verde` y los tres
      //      íconos también, así que ahí el mutante pasa desapercibido. Por eso este `it` recorre los
      //      cuatro estados y no uno.
      //
      // La forma que sí discrimina no mira clases: mira QUÉ CONTIENE. El círculo del ícono siempre
      // tiene adentro un `<svg>` (tilde, reloj o spinner) o el número del paso; el conector está
      // vacío por definición.
      const { container } = pintarSeguimiento(remesa(estado));
      for (const li of Array.from(container.querySelectorAll("li"))) {
        const primerSpan = li.querySelector("span");
        expect(primerSpan, "el `<li>` no tiene ningún `<span>`").not.toBeNull();
        const tieneContenido =
          primerSpan?.querySelector("svg") !== null ||
          /\d/.test(primerSpan?.textContent ?? "");
        expect(
          tieneContenido,
          "el primer `<span>` del paso está vacío: dejó de ser el círculo del ícono y " +
            "`flow.test.tsx` pasó a medir otra cosa",
        ).toBe(true);
      }
    },
  );

  it("los tramos están fuera del árbol accesible", () => {
    // Un camino es información redundante: el estado de cada paso ya lo dice el ícono y la etiqueta.
    // Sin `aria-hidden`, un lector de pantalla anunciaría dos elementos vacíos por tarjeta.
    const { container } = pintarSeguimiento(remesa("payout_submitted"));
    for (const t of tramos(container)) expect(t).toHaveAttribute("aria-hidden", "true");
  });
});

describe("T-O2-6 (M-3): el camino no se anima", () => {
  it("en `payout_submitted` ningún tramo gira ni late", () => {
    // El paso del medio NO avanza solo: el release lo dispara una persona a mano. Un tramo animado
    // afirmaría un progreso que no existe, que es exactamente por lo que ese paso muestra un reloj y
    // no un spinner. `flow.test.tsx` ya cuenta `.animate-*` en toda la tarjeta; esto lo dice del
    // conector en particular, para que el rojo nombre la causa.
    const { container } = pintarSeguimiento(remesa("payout_submitted"));
    for (const t of tramos(container)) {
      expect(t.className).not.toMatch(/animate-/);
      expect(t.className).not.toMatch(/transition/);
    }
  });
});

// ══ M-4 · la jerarquía de los dos botones ═══════════════════════════════════════════════════════

/** El alto declarado por el `<Button>` de referencia, leído del elemento renderizado. Mismo molde
 *  que `pxDelCtaDelCaminoFeliz` en `touch-targets.test.tsx`: el número no se escribe a mano. */
function altoDelBotonBase(): string {
  const { unmount } = render(<Button>referencia</Button>);
  const cls = screen.getByRole("button", { name: "referencia" }).className;
  const m = /(?:^|\s)(h-\[\d+px\])/.exec(cls);
  unmount();
  if (m === null) throw new Error("el <Button> de ui.tsx ya no declara ningún h-[Npx]");
  return m[1] as string;
}

describe("T-O2-7 (M-4): bajar la jerarquía NO baja el área de toque", () => {
  it("las tres variantes declaran EXACTAMENTE el mismo alto", () => {
    // 🔴 ESTE ES EL INNEGOCIABLE DE M-4. El mutante que mata es el "arreglo" prolijo de mover el
    // `h-[52px]` de la clase base a la variante `primary`, que se ve idéntico en el camino feliz y
    // deja `ghost` y `outline` con el alto del texto. Dos de los controles que sacan plata del
    // contrato son `outline`.
    const alto = altoDelBotonBase();
    for (const v of ["primary", "outline", "ghost"] as const) {
      const { unmount } = render(<Button variant={v}>x</Button>);
      expect(screen.getByRole("button", { name: "x" }).className, v).toContain(alto);
      unmount();
    }
  });
});

describe("T-O2-8 (M-4): el que CONSULTA pesa menos que el que mueve plata", () => {
  it("`ghost` no tiene fondo ni sombra, y `outline` sí tiene superficie", () => {
    // El estado ANTERIOR a M-4, medido en 4c24324: "Revisar ahora" era `primary` (`bg-cochineal` +
    // `shadow-lift`, la única variante con sombra) y "Recuperar fondos" era `outline`. O sea que el
    // control que sólo consulta era el más fuerte de la pantalla y el que saca los USDC del contrato
    // estaba por debajo.
    //
    // MUTANTE QUE MATA: devolver `variant="ghost"` a `primary` en el gesto de revisar, o darle fondo
    // a `ghost`.
    const { unmount } = render(<Button variant="ghost">consultar</Button>);
    const ghost = screen.getByRole("button", { name: "consultar" }).className;
    unmount();
    render(<Button variant="outline">mover plata</Button>);
    const outline = screen.getByRole("button", { name: "mover plata" }).className;

    expect(ghost, "el que consulta no puede tener sombra").not.toContain("shadow-lift");
    expect(ghost, "el que consulta no puede tener fondo sólido").toContain("bg-transparent");
    expect(ghost, "el que consulta no puede tener borde").not.toMatch(/(^|\s)border(\s|$)/);
    expect(outline, "el que mueve plata sí tiene borde").toMatch(/(^|\s)border(\s|$)/);
    expect(outline, "el que mueve plata sí tiene superficie").toContain("bg-card");
  });

  it("`ghost` no usa el gris de contraste insuficiente", () => {
    // 🔴 NO ES PREFERENCIA DE COLOR, ES UN NÚMERO. `text-stone` (`#8A8178`) sobre el fondo de la app
    // (`#FBFAF7`) da 3.66:1 por la fórmula de luminancia relativa de WCAG 2.x, y el texto del
    // `<Button>` es de 15px `font-semibold`, o sea texto NORMAL (el umbral de "grande" es 18.66px en
    // negrita). El mínimo AA para texto normal es 4.5:1. `cochineal-ink` (`#9E1C40`) da 7.46:1.
    //
    // ⚠️ ESTE TEST NO CALCULA EL CONTRASTE: no hay colores resueltos en jsdom. Clava la clase que se
    // eligió DESPUÉS de hacer esa cuenta, así que lo que vigila es que nadie la devuelva al gris.
    // MUTANTE QUE MATA: volver `ghost` a `text-stone`.
    render(<Button variant="ghost">x</Button>);
    const cls = screen.getByRole("button", { name: "x" }).className;
    expect(cls).not.toContain("text-stone");
    expect(cls).toContain("text-cochineal-ink");
  });
});

/**
 * El seguimiento con LOS DOS botones en pantalla al mismo tiempo, que es la situación que M-4
 * describe. `ventana` devuelve `"sin-prueba"` (o sea: se ofrece el gesto de revisar) y `recover` es
 * el use-case real sobre un repo sembrado, así que "Recuperar fondos" también se pinta.
 */
async function seguimientoConLosDosBotones() {
  const rem = remesa("payout_submitted");
  const repo = new InMemoryRepo();
  await repo.save(Remittance.rehydrate(rem));
  const recover = new RecoverEscrowFunds(repo, new FixedClock(), new FakeSolanaEscrowRefundGateway());
  const store = new InMemoryPopProofStore(new FixedClock());
  return render(
    <TrackView
      rem={rem}
      recover={recover}
      sender={FAKE_SOLANA_BENEFICIARY}
      onRecovered={() => {}}
      revision={{
        ventana: { estado: () => (store.peek(FAKE_SOLANA_BENEFICIARY) ? "vigente" : "sin-prueba") },
        renovar: {
          prove: vi.fn(async (a: string) => {
            const prueba = { challenge: "ch", signature: "sig" };
            store.record(a, prueba);
            return prueba;
          }),
        },
      }}
    />,
  );
}

describe("T-O2-11 (M-4): en la pantalla REAL, el que consulta pesa menos que el que mueve plata", () => {
  it("«Revisar ahora» no es el elemento más fuerte, y «Recuperar fondos» sigue teniendo superficie", async () => {
    // 🔴 ESTE ES EL TEST DE M-4 Y NO EL DE ARRIBA. T-O2-8 mide la DEFINICIÓN de las variantes; éste
    // mide QUÉ VARIANTE USA CADA BOTÓN en la pantalla donde conviven, que es lo que el encargo pide.
    // Sin él, alguien puede devolver el gesto de revisar a `primary` y las variantes seguirían
    // definidas perfecto.
    //
    // MUTANTE QUE MATA: sacarle el `variant="ghost"` al `<Button>` de `REVISION_GESTO` (o sea,
    // volver al estado de 4c24324, donde el control que sólo consulta era el único con sombra de
    // toda la pantalla y el que saca los USDC del contrato estaba un escalón por debajo).
    await seguimientoConLosDosBotones();
    const revisar = await screen.findByRole("button", { name: /revisar/i });
    const recuperar = screen.getByRole("button", { name: /Recuperar fondos/ });

    expect(revisar.className, "el que consulta no puede ser el único con sombra").not.toContain(
      "shadow-lift",
    );
    expect(revisar.className, "el que consulta no puede tener fondo sólido").not.toContain(
      "bg-cochineal ",
    );
    expect(recuperar.className, "el que mueve plata sigue teniendo superficie").toContain("bg-card");

    // ⛔ Y EL ÁREA DE TOQUE NO SE MOVIÓ POR BAJAR LA JERARQUÍA: los dos declaran el mismo alto, y ese
    // alto sale del `<Button>` de referencia, no de un número escrito acá.
    const alto = altoDelBotonBase();
    expect(revisar.className, "bajar la jerarquía le bajó el área de toque").toContain(alto);
    expect(recuperar.className).toContain(alto);
  });
});

// ══ M-2 · la cifra ══════════════════════════════════════════════════════════════════════════════

describe("T-O2-9 (M-2): la cifra usa UN solo rol, y es de ancho fijo", () => {
  it("el monto del desembolso en curso y el del recibo emiten `text-money` y `tabular-nums`", () => {
    // Antes de M-2 había SEIS tamaños distintos para la misma cosa (18, 20, 24, 30, 36 px). El
    // mutante que mata: devolver cualquiera de estos dos a un `text-3xl`/`text-4xl` escrito a mano.
    //
    // ⚠️ Se leen los DOS sitios que se pueden montar sin recorrer el flujo entero. Los otros tres
    // (el preview de `send` y las dos tarjetas de revisión) los cubre el barrido estático de T-O2-2,
    // que prohíbe los tamaños de fábrica en todo `flow.tsx`.
    const { container: enCurso } = pintarSeguimiento(remesa("payout_submitted"));
    const cifraEnCurso = within(enCurso).getByText("S/1,478.15");
    expect(cifraEnCurso.className).toContain("text-money");
    expect(cifraEnCurso.parentElement?.className).toContain("tabular-nums");

    cleanup();
    const { container: recibo } = render(
      <Receipt rem={remesa("settled")} onNew={() => {}} />,
    );
    const cifraRecibo = within(recibo).getByText("S/1,478.15");
    expect(cifraRecibo.className).toContain("text-money");
    expect(cifraRecibo.parentElement?.className).toContain("tabular-nums");
  });

  it("la cifra sigue siendo UN nodo de texto: el símbolo no se partió de los dígitos", () => {
    // 🔴 EL LÍMITE DE M-2, ESCRITO COMO TEST PARA QUE NO SE OLVIDE POR QUÉ. El encargo pedía la
    // moneda en peso menor, y en seis de los siete sitios eso exige partir "S/1,478.15" en dos
    // `<span>`. No se puede: `Money.format()` devuelve símbolo y dígitos pegados, y dos asserts de
    // `flow.test.tsx` piden ese string como texto DIRECTO de un elemento: el regex
    // `getByText(/^S\/[\d,]+\.\d{2}$/)` y el literal `getByText("S/1,500.00")`. `getNodeText` de
    // testing-library sólo concatena los hijos que YA son nodos de texto, así que partirlo deja al
    // elemento sin texto propio y los dos quedan en rojo. Uno de los dos es el guard de que la
    // pantalla nunca muestre "S/0.00".
    //
    // Este `it` documenta la restricción del lado de esta ola: si alguien parte la cifra, acá se
    // entera del motivo sin tener que reconstruirlo.
    const { container } = pintarSeguimiento(remesa("payout_submitted"));
    const cifra = within(container).getByText("S/1,478.15");
    expect(cifra.childNodes).toHaveLength(1);
    expect(cifra.childNodes[0]?.nodeType).toBe(3); // Node.TEXT_NODE
  });
});

// ══ M-6 · las dos señales de entorno de prueba ══════════════════════════════════════════════════

describe("T-O2-10 (M-6): las dos señales de prueba hablan el mismo idioma visual", () => {
  it("la píldora de modo demo y la caja del desembolso comparten el punteado sobre arena", () => {
    // Antes eran dos gramáticas: la píldora `bg-sand text-ink` (superficie sólida, sin borde) y la
    // caja un punteado sobre nada. MUTANTE QUE MATA: devolver cualquiera de las dos a su receta
    // vieja.
    //
    // ⚠️ La píldora se monta desde `<Receipt>` y no desde el flujo, porque es el sitio donde el modo
    // demo se prende con un snapshot y sin recorrer nada. El otro sitio (la banda de arriba del
    // flujo) usa la MISMA constante y el MISMO `tone`.
    render(<Receipt rem={remesa("settled", { demo: true })} onNew={() => {}} />);
    const pildora = screen.getByText("Modo demo (con pasos simulados)");
    expect(pildora.className).toContain("border-dashed");
    expect(pildora.className).toContain("bg-sand/60");

    cleanup();
    const { container } = pintarSeguimiento(remesa("payout_submitted", { demo: true }));
    const caja = within(container).getByText("Entorno de prueba.").closest("div");
    expect(caja?.className).toContain("border-dashed");
    expect(caja?.className).toContain("bg-sand/60");
  });

  it("los DOS textos siguen existiendo por separado", () => {
    // ⛔ La unificación es de JERARQUÍA, no de contenido: son dos afirmaciones distintas (una habla
    // de los PASOS del envío, la otra de que el depósito en cadena sí es real). MUTANTE QUE MATA:
    // fusionarlas en un solo aviso, que es la simplificación tentadora.
    const { container } = pintarSeguimiento(remesa("payout_submitted", { demo: true }));
    expect(within(container).getByText("Entorno de prueba.")).toBeInTheDocument();
    expect(
      within(container).getByText(/El depósito en la cadena sí es real/),
    ).toBeInTheDocument();
  });
});
