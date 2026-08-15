// @vitest-environment jsdom
//
// Tests · S-1 a S-5: el sistema de diseño de la ola 1.
//
// ⚠️ LO PRIMERO, PORQUE CAMBIA CÓMO SE LEE TODO LO DEMÁS: en esta ola las piezas se CREAN y no se
// CABLEAN. Los sitios de llamada se mueven en la ola 2. Así que los únicos llamadores de `Muted`,
// `Aviso` y `Money` son estos tests, y este repo ya tiene escrita la lección de que un componente
// cuyos únicos llamadores viven en `*.test.*` NO tiene cableado probado. Por lo tanto:
//   · SÍ se prueba que cada pieza emita lo que dice emitir, leído del DOM.
//   · NO se prueba que la aplicación las use. Hoy no las usa, y ningún test de acá lo sugiere.
// Leer el verde de este archivo como "las pantallas ya usan el sistema" es leerlo de más.
//
// ⚠️ Y UN SEGUNDO LÍMITE, EL MISMO DE SIEMPRE EN ESTE ENTORNO: acá no corre Tailwind. Estos tests
// leen el TEMA (los valores que se declaran) y las CLASES (los nombres que llegan al DOM). Que
// `text-support` produzca 13px con interlineado 1.7 en un navegador lo hace el compilador de
// Tailwind, y esta suite no lo verifica.
//
// LOS DIEZ MUTANTES SE APLICARON Y SE MIDIERON, uno por uno, sobre el árbol de 9cd4586. No es una
// lista de lo que "debería" fallar, es la salida de correrlos (el archivo tiene 22 tests):
//   · `body` sin `lineHeight`                                    ⇒ 2 failed | 20 passed
//   · `support` con el mismo interlineado que `body`             ⇒ 1 failed | 21 passed
//   · `money` más chico que `title`                              ⇒ 1 failed | 21 passed
//   · `cn.ts` sin el grupo `font-size`                           ⇒ 2 failed | 20 passed
//   · `cn.ts` sin la escala `spacing`                            ⇒ 1 failed | 21 passed
//   · `Muted` emitiendo `text-[#8A8178]` (el MISMO gris, otra clase) ⇒ 3 failed | 19 passed
//   · la moneda de `Money` al mismo peso que la cifra            ⇒ 1 failed | 21 passed
//   · dos tonos de `Aviso` con la misma superficie               ⇒ 1 failed | 21 passed
//   · `Money` sin `tabular-nums`                                 ⇒ 1 failed | 21 passed
//   · `xl2` con un valor distinto de `caja`                      ⇒ 1 failed | 21 passed
//
// El sexto es el que más importa de la lista: es el gris EXACTO escrito como valor arbitrario, o sea
// el cambio que se ve idéntico en pantalla y rompe igual el candado de `history-onchain.test.tsx`.
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import tailwind from "../../tailwind.config";
import { cn } from "./cn";
import { Aviso, Money, Muted } from "./ui";

afterEach(cleanup);

type Rol = [string, { lineHeight?: string; letterSpacing?: string }];

const tema = (tailwind.theme?.extend ?? {}) as Record<string, unknown>;
const rem = (v: string) => Number(v.replace("rem", ""));

// Los cuatro helpers de abajo FALLAN RUIDOSAMENTE cuando no encuentran lo que buscan, y no es
// ceremonia: si devolvieran `undefined`, media docena de `expect` de este archivo compararían
// `NaN` con `NaN` o `undefined` con `undefined` y pasarían por vacuidad. Un candado que no encuentra
// lo que vigila y aun así da verde es un candado que dejó de existir.

function grupo(nombre: string): Record<string, unknown> {
  const g = tema[nombre];
  if (g === null || typeof g !== "object")
    throw new Error(`\`theme.extend.${nombre}\` no está en tailwind.config.ts`);
  return g as Record<string, unknown>;
}

/** Las claves de un grupo del tema, derivadas y nunca escritas a mano. */
function claves(nombre: string): string[] {
  const k = Object.keys(grupo(nombre));
  if (k.length < 2) throw new Error(`\`theme.extend.${nombre}\` tiene menos de dos claves`);
  return k;
}

/** El valor (string) de una clave del tema. */
function valor(nombreGrupo: string, k: string): string {
  const v = grupo(nombreGrupo)[k];
  if (typeof v !== "string") throw new Error(`\`${nombreGrupo}.${k}\` no es un string`);
  return v;
}

function rol(nombre: string): Rol {
  const r = grupo("fontSize")[nombre];
  if (!Array.isArray(r)) throw new Error(`el rol tipográfico \`${nombre}\` no está en el tema`);
  return r as Rol;
}

/** La n-ésima clave de un grupo, con el error a la vista si el grupo se quedó corto. */
function claveN(nombreGrupo: string, i: number): string {
  const k = claves(nombreGrupo)[i];
  if (k === undefined) throw new Error(`\`${nombreGrupo}\` no tiene una clave en la posición ${i}`);
  return k;
}

/** La pila monoespaciada declarada en el tema. */
function pilaMono(): string[] {
  const m = grupo("fontFamily").mono;
  if (!Array.isArray(m)) throw new Error("`fontFamily.mono` no está declarada en el tema");
  return m as string[];
}

const ROLES = ["money", "title", "body", "support", "label", "mono"] as const;

describe("S-1 · la escala tipográfica tiene seis roles y todos declaran interlineado", () => {
  it("los seis roles existen", () => {
    for (const n of ROLES) expect(() => rol(n), n).not.toThrow();
  });

  it("los seis declaran interlineado, no sólo tamaño", () => {
    // 🔴 ESTE ES EL DEFECTO QUE LA HU CIERRA, y no es el número de tamaños. En 40f0b68 había UN solo
    // `leading-*` en todo el árbol (`leading-none`, una vez) contra párrafos de copy de hasta 570
    // caracteres. Un rol que declara tamaño y NO interlineado deja el problema exactamente donde
    // estaba, con la escala prolija por arriba.
    //
    // INPUT QUE LO PONE EN ROJO: escribir cualquier rol como `body: ["0.9375rem"]`.
    for (const n of ROLES) {
      const lh = rol(n)[1]?.lineHeight;
      expect(lh, `\`${n}\` no declara lineHeight`).toBeDefined();
      expect(Number(lh), n).toBeGreaterThan(0);
    }
  });

  it("`support` respira MÁS que `body`: es la razón de que sean dos roles y no uno", () => {
    // Si los dos tuvieran el mismo interlineado, `support` sería `body` un punto más chico y no haría
    // falta como rol. Lo que lo justifica es esta desigualdad, así que es lo que se clava.
    //
    // INPUT QUE LO PONE EN ROJO: igualar los dos `lineHeight`, que es la simplificación tentadora.
    expect(Number(rol("support")[1].lineHeight)).toBeGreaterThan(
      Number(rol("body")[1].lineHeight),
    );
  });

  it("la escala está ordenada: `money` es el más grande y `label` el más chico", () => {
    // Un candado barato contra el error más tonto y más probable de una tabla de seis filas: pegar
    // los valores corridos una fila. Sin esto, `money` a 0.75rem pasaría todos los tests de arriba.
    const tam = (n: string) => rem(rol(n)[0]);
    const todos = ROLES.map(tam);
    expect(tam("money")).toBe(Math.max(...todos));
    expect(tam("label")).toBe(Math.min(...todos));
    expect(tam("title")).toBeGreaterThan(tam("body"));
    expect(tam("body")).toBeGreaterThan(tam("support"));
  });
});

describe("S-1 · la familia monoespaciada existe y no pide un solo byte a la red", () => {
  it("`fontFamily.mono` está declarada", () => {
    // En 40f0b68 `font-mono` se usaba (1 vez, sobre una firma de transacción) y la familia NO estaba
    // declarada, así que caía al default de Tailwind.
    expect(pilaMono().length).toBeGreaterThan(1);
  });

  it("es una pila del sistema: ni URL, ni variable de fuente cargada", () => {
    // 🔴 ESTO CUIDA LA CSP, que en esta app está EN MODO BLOQUEO con `font-src 'self' data:`. Una
    // familia que llegara por `<link>` a un CDN se bloquearía en producción y acá seguiría verde;
    // el candado que cierra ese camino es `csp-policy.test.ts` (T-CSP-11) y este es su complemento
    // del lado del tema. `next/font` sería legal (Next auto-hospeda), pero paga descarga por texto
    // accesorio, así que tampoco se usa y por eso se assertea la ausencia de `var(--font-`.
    for (const f of pilaMono()) {
      expect(f, f).not.toContain("http");
      expect(f, f).not.toContain("url(");
      expect(f, f).not.toContain("var(--font-");
    }
  });
});

describe("S-4 · radios, íconos y espaciado quedan en escalas decidibles", () => {
  it("hay dos radios semánticos, y lo anidado es MENOR que lo que lo contiene", () => {
    // El criterio de S-4 es "lo anidado va con menos radio". Eso sólo es decidible si los números lo
    // permiten: con `control >= caja` la regla quedaría escrita y sería inaplicable.
    expect(rem(valor("borderRadius", "caja"))).toBeGreaterThan(
      rem(valor("borderRadius", "control")),
    );
  });

  it("`xl2` sigue existiendo y vale lo mismo que `caja`", () => {
    // 🔴 NO ES PRUDENCIA, ES UN CANDADO CONCRETO: `ui.tsx` usa `rounded-xl2` en `Button` y en `Card`,
    // y `touch-targets.test.tsx` lee el `<Button>` renderizado. Borrar el token ahora dejaría esas
    // clases sin emitir. Que valga lo mismo que `caja` es lo que permite migrar los sitios de
    // llamada en la ola 2 sin que cambie un pixel.
    expect(valor("borderRadius", "xl2")).toBe(valor("borderRadius", "caja"));
  });

  it("hay tres tamaños de ícono, estrictamente crecientes", () => {
    const s = claves("size").map((k) => rem(valor("size", k)));
    expect(s).toHaveLength(3);
    expect([...s].sort((a, b) => a - b)).toEqual(s);
  });

  it("hay cuatro pasos de espaciado, estrictamente crecientes", () => {
    const s = claves("spacing").map((k) => rem(valor("spacing", k)));
    expect(s).toHaveLength(4);
    expect([...s].sort((a, b) => a - b)).toEqual(s);
  });
});

// ══ El defecto que apareció al escribir estos tests, y que no estaba en el encargo ═════════════
//
// 🔴 `tailwind-merge` NO LEE `tailwind.config.ts`. Trae su propia tabla, y ahí una palabra suelta
// detrás de `text-` es un COLOR. Con el `twMerge` sin configurar, medido:
//     cn("text-support", "text-stone") ⇒ "text-stone"     ← el tamaño desaparecía
//     cn("text-money",   "text-verde") ⇒ "text-verde"     ← ídem
// O sea que el vocabulario nuevo se PERDÍA al pasar por `cn`, en silencio, con el resultado
// dependiendo del orden de los argumentos. Lo destapó el test de `Muted` de más abajo con un
// «expected 'text-stone' to contain 'text-support'», no un razonamiento.
//
// El arreglo vive en `cn.ts` y es, necesariamente, UNA SEGUNDA COPIA DE LOS NOMBRES DEL TEMA. Este
// bloque existe para que esa copia no se desactualice callada: deriva los nombres del tema de
// verdad, así que un rol nuevo en `tailwind.config.ts` que nadie declare en `cn.ts` se pone rojo acá.
describe("el vocabulario propio sobrevive a `cn` (y la tabla duplicada no se desactualiza)", () => {
  it("ningún rol tipográfico se pierde al combinarlo con un color", () => {
    // INPUT QUE LO PONE EN ROJO: agregar un rol a `theme.extend.fontSize` y no agregarlo al grupo
    // `font-size` de `cn.ts`. Ese rol pasa a comportarse como un color y se lo come el color.
    for (const nombre of claves("fontSize")) {
      const salida = cn(`text-${nombre}`, "text-stone");
      expect(salida, nombre).toContain(`text-${nombre}`);
      expect(salida, nombre).toContain("text-stone");
    }
  });

  it("las escalas propias SÍ se pisan entre sí, que es lo que `cn` tiene que hacer", () => {
    // El par del test de arriba, y no es simetría decorativa. Un token que `cn` no reconoce no
    // desaparece: SOBREVIVE junto al que debería pisarlo, y entonces el ganador lo decide el orden
    // en que Tailwind emitió las reglas, que no lo eligió nadie. Medido antes del arreglo:
    // `cn("p-holgado", "p-4")` devolvía «p-holgado p-4».
    const par = (grupoTema: string, prefijo: string) => {
      const a = `${prefijo}-${claveN(grupoTema, 0)}`;
      const b = `${prefijo}-${claveN(grupoTema, 1)}`;
      expect(cn(a, b), `${a} + ${b}`).toBe(b);
    };
    par("spacing", "p");
    par("spacing", "gap");
    par("spacing", "space-y");
    par("borderRadius", "rounded");
    par("size", "size");
    // El del área segura contra el valor de fábrica que reemplazó.
    expect(cn(`pt-${claveN("padding", 0)}`, "pt-6")).toBe("pt-6");
  });

  it("control: los valores arbitrarios que YA funcionaban siguen funcionando", () => {
    // Se midió antes de tocar `cn.ts` y estaba bien, así que no se arregló: `tailwind-merge` sabe
    // leer un `[15px]` como longitud. Este `it` está para que el arreglo del caso de arriba no rompa
    // el caso que no estaba roto, que es el `<Button>` de este mismo archivo.
    const salida = cn("h-[52px] px-5 text-[15px] font-semibold", "bg-cochineal text-white");
    expect(salida).toContain("text-[15px]");
    expect(salida).toContain("text-white");
  });
});

describe("S-2 · el texto secundario sale de un componente y sigue emitiendo `text-stone`", () => {
  it("🔴 emite `text-stone`, que es una clase CONGELADA por otros tests", () => {
    // No es preferencia de color. `history-onchain.test.tsx` assertea
    // `expect(devuelto.className).toContain("text-stone")` sobre el párrafo renderizado, y lo usa
    // para distinguir la fila que ya se resolvió de la que TODAVÍA TIENE PLATA recuperable. Un
    // `<Muted>` que usara otro gris equivalente rompería un candado que cuida esa distinción.
    //
    // INPUT QUE LO PONE EN ROJO: cambiar `text-stone` por cualquier otra clase de gris en `Muted`.
    render(<Muted>secundario</Muted>);
    expect(screen.getByText("secundario").className).toContain("text-stone");
  });

  it("las dos escalas emiten roles distintos, y las dos conservan el gris", () => {
    const { container } = render(
      <>
        <Muted escala="support">explicación</Muted>
        <Muted escala="label">etiqueta</Muted>
      </>,
    );
    expect(screen.getByText("explicación").className).toContain("text-support");
    expect(screen.getByText("etiqueta").className).toContain("text-label");
    for (const el of container.querySelectorAll("p")) {
      expect(el.className).toContain("text-stone");
    }
  });

  it("`as` cambia la etiqueta sin cambiar nada más", () => {
    // Los 76 sitios de llamada de la ola 2 no son todos `<p>`: varios son `<span>` dentro de una
    // fila. Sin esta prop, migrarlos obligaría a meter un `<p>` en medio de un `flex` y cambiaría el
    // layout, que es justo lo que esta ola no quiere hacer de refilón.
    render(<Muted as="span">en línea</Muted>);
    expect(screen.getByText("en línea").tagName).toBe("SPAN");
    expect(screen.getByText("en línea").className).toContain("text-stone");
  });
});

describe("S-3 · las cuatro superficies de aviso son distintas entre sí", () => {
  it("los cuatro tonos comparten el radio y NO comparten el fondo", () => {
    // Que los cuatro existan no alcanza: si dos tonos emiten la misma superficie, el sitio de
    // llamada de la ola 2 elige uno u otro y da igual, que es como se pierde una distinción sin que
    // nada se ponga rojo.
    //
    // INPUT QUE LO PONE EN ROJO: dejar `bueno` y `prueba` con el mismo par borde/fondo.
    const tonos = ["neutro", "bueno", "atencion", "prueba"] as const;
    const clases = tonos.map((t) => {
      const { container, unmount } = render(<Aviso tono={t}>x</Aviso>);
      const c = (container.firstChild as HTMLElement).className;
      unmount();
      return c;
    });
    for (const c of clases) expect(c).toContain("rounded-control");
    expect(new Set(clases).size).toBe(tonos.length);
  });

  it("`atencion` es el único que trae color de texto propio", () => {
    // Los otros tres heredan el color del contenido; el de atención lo fija porque su fondo rosado
    // deja el `text-ink` sin contraste suficiente. Es la única asimetría de la tabla y conviene que
    // esté clavada, para que no se "empareje" por prolijidad.
    const { container } = render(<Aviso tono="atencion">x</Aviso>);
    expect((container.firstChild as HTMLElement).className).toContain("text-cochineal-ink");
  });
});

describe("S-5 · el monto: cifras de ancho fijo y la moneda por debajo de la cifra", () => {
  it("las cifras son de ancho fijo", () => {
    // En `track` el monto se refresca en el lugar. Con cifras de ancho variable el número entero se
    // corre de costado en cada refresco, sobre el dato que la persona está mirando.
    const { container } = render(<Money moneda="S/">1.234,56</Money>);
    expect((container.firstChild as HTMLElement).className).toContain("tabular-nums");
  });

  it("la moneda pesa MENOS que la cifra, que es el punto del componente", () => {
    // 🔴 Es la única regla de composición que S-5 pide, así que es la que se clava. Al mismo peso las
    // dos partes compiten y el número deja de ser lo primero que se ve, que es todo lo que el
    // componente tiene que resolver.
    //
    // INPUT QUE LO PONE EN ROJO: poner `font-extrabold` también en la moneda.
    render(<Money moneda="S/">1.234,56</Money>);
    expect(screen.getByText("S/").className).toContain("font-semibold");
    expect(screen.getByText("S/").className).not.toContain("font-extrabold");
    expect(screen.getByText("1.234,56").className).toContain("font-extrabold");
  });

  it("la cifra usa el rol `money`, y la moneda no", () => {
    render(<Money moneda="S/">1.234,56</Money>);
    expect(screen.getByText("1.234,56").className).toContain("text-money");
    expect(screen.getByText("S/").className).not.toContain("text-money");
  });

  it("sin moneda no se pinta un hueco", () => {
    // Varios sitios de llamada de la ola 2 muestran la cifra sola (el monto ya viene formateado con
    // su símbolo). Sin este caso, migrarlos obligaría a pasar `moneda=""` y quedaría un `gap` vacío.
    const { container } = render(<Money>42</Money>);
    expect(container.querySelectorAll("span")).toHaveLength(2); // el envoltorio y la cifra
    expect(screen.getByText("42").className).toContain("text-money");
  });
});
