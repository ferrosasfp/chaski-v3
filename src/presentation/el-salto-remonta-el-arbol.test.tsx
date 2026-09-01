// @vitest-environment jsdom
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-374 · W0-3 — `L-5`: EL SALTO POR ENLACE REMONTA EL ÁRBOL DE REACT
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ MIDE Y POR QUÉ ES BLOQUEANTE. De esta premisa cuelga el §2 entero del work-item: el vale, el
// borrador server-side y la circularidad. Hasta hoy era DOCTRINA HEREDADA —está escrita en prosa en
// `infrastructure/auth/sesion-store.ts:16-25` (⛔ esa cita va SIN ancla a propósito: ese archivo es
// vecindad del money-path y el patrón de citar sin ancla lo declara `bitacora-de-vuelta.ts:175-177`)—
// y nunca fue una corrida. Si la premisa fuera FALSA, la sesión cruzaría el salto, `DT-3` dejaría de
// hacer falta y el diseño de la HU cambia de forma. Por eso se mide ANTES de escribir una línea.
//
// ⛔ LO QUE ESTE ARCHIVO **NO** PRUEBA, dicho antes de que alguien lea su verde de más:
//   · No corre en un teléfono. Que el `localStorage` cruce al navegador de la billetera es OTRA
//     pregunta (`L-4`) y ⛔ este archivo no la contesta ni de un lado ni del otro.
//   · La pata (b) mide una AUSENCIA en el árbol de HOY. Es un candado contra el futuro, no una
//     demostración de que una navegación blanda sea imposible en Next.
//   · La pata (a) compara CONTENEDORES y no almacenes: `sesiones` no está expuesto en el tipo
//     `Container` (es una variable local de `createContainer`), así que la identidad del contenedor es
//     el observable que hay. Lo que la vuelve concluyente es que el almacén se construye ADENTRO de
//     `createContainer`: mismo contenedor ⇒ mismo almacén; contenedor nuevo ⇒ almacén nuevo.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createContainer, getContainer } from "../composition/container";
import { InMemorySesionStore } from "../infrastructure/auth/sesion-store";

const ROOT = process.cwd();
const DIRS = ["src", "app"];
const EXTS = new Set([".ts", ".tsx"]);
const SKIP = new Set(["node_modules", ".next", "doc", "migrations"]);

/** 🔴 RUTA EXACTA DE ESTE ARCHIVO, ⛔ NUNCA UN GLOB NI EL SUFIJO `.test.`. Este archivo escribe los
 *  cuatro patrones en su prosa y en su control negativo: sin excluirse, el barrido se leería a sí
 *  mismo y el `it` no podría dar verde jamás — que es la otra cara de un guard que no puede fallar.
 *  Mismo recurso, y por el mismo motivo, que (`SELF`, `../composition/citas-ancladas.test.ts:56`),
 *  aplicado en la condición de recolección de (`SELF`, `../composition/citas-ancladas.test.ts:64`). */
const SELF = path.resolve(ROOT, "src/presentation/el-salto-remonta-el-arbol.test.tsx");

/** Los cuatro literales que delatarían una navegación BLANDA (sin recargar el documento). Armados por
 *  concatenación para que el barrido no pueda encontrarlos escritos enteros en NINGUNA línea de este
 *  archivo, ni siquiera si mañana alguien le saca la exclusión por ruta. Es cinturón sobre tirante:
 *  la defensa que vale es `SELF`, y ésta hace que el modo de falla sea un rojo y no un falso verde. */
const PATRONES = ["useRouter", `router${"."}push`, `router${"."}replace`, `next${"/"}navigation`];

type Fuente = { archivo: string; lineas: readonly string[] };
type Hallazgo = { archivo: string; linea: number; patron: string; texto: string };

/** 🔴 EL BARRIDO ES UNA FUNCIÓN PURA SOBRE FUENTES, y eso es lo que lo hace calibrable: se le puede
 *  entrar con líneas SINTÉTICAS y exigirle que las cace. Un barrido que sólo se corre contra el árbol
 *  real es indistinguible de uno roto el día que el árbol está limpio, que es exactamente hoy. */
function barrer(fuentes: readonly Fuente[]): Hallazgo[] {
  const out: Hallazgo[] = [];
  for (const f of fuentes) {
    f.lineas.forEach((l, i) => {
      for (const p of PATRONES) {
        if (l.includes(p)) out.push({ archivo: f.archivo, linea: i + 1, patron: p, texto: l.trim() });
      }
    });
  }
  return out;
}

/** 🔴 SE LEE CON `readFileSync`, ⛔ NUNCA CON `import`. Está medido en este repo: un guard de
 *  existencia que IMPORTA lo que vigila no muere por una aserción, muere por `Failed to resolve
 *  import` y el archivo entero colapsa en `0 test` — un rojo indistinguible de un error de sintaxis,
 *  que no es un KILLED. Lo dejó escrito el docblock del mutante de `T-372-W1-11`, en
 *  `./recorrido-en-el-navegador-de-la-billetera.test.tsx`. */
function leerElArbol(dir: string, out: Fuente[] = []): Fuente[] {
  for (const entrada of readdirSync(dir)) {
    const full = path.join(dir, entrada);
    if (statSync(full).isDirectory()) {
      if (!SKIP.has(entrada)) leerElArbol(full, out);
    } else if (EXTS.has(path.extname(entrada)) && path.resolve(full) !== SELF) {
      out.push({ archivo: path.relative(ROOT, full), lineas: readFileSync(full, "utf8").split("\n") });
    }
  }
  return out;
}

const ARBOL = DIRS.flatMap((d) => leerElArbol(path.join(ROOT, d)));
const HALLAZGOS = barrer(ARBOL);
const de = (patron: string): string[] =>
  HALLAZGOS.filter((h) => h.patron === patron).map((h) => `${h.archivo}:${h.linea} → ${h.texto}`);

describe("W0-3 · el salto por enlace remonta el árbol (`L-5`)", () => {
  // MUTANTES QUE LO TIENEN QUE MATAR, uno por pata y corridos POR SEPARADO:
  //   · M-3 · en `composition/container.ts`, borrarle la memoización a `getContainer` (que el `if`
  //     desaparezca y `singleton` se re-cree siempre) ⇒ cae la PRIMERA mitad de (a).
  //     ⚠️ FALSO KILLED: M-3 también pone rojo a `container.test.ts`. El `×` que cuenta es el de
  //     ESTE `it`, nombrado.
  //   · M-4 · agregarle una línea con el literal del `push` a la LISTA SINTÉTICA del control negativo
  //     ⇒ cae el control negativo de (b). ⛔ NO se escribe ningún archivo real en `src/` para esto:
  //     sería producción, y además correría el conteo de tests de los dos README.
  //   · M-5 · que `peek` devuelva siempre `null` en `infrastructure/auth/sesion-store.ts` ⇒ cae (c).
  //     ⚠️ FALSO KILLED: `sesion-store.test.ts` también se pondrá rojo. El `×` que cuenta es el de acá.
  it("T-374-W0-3: el almacén de sesión es POR DOCUMENTO, la salida al enlace es una navegación de documento, y el instrumento sabe decir que SÍ hay sesión", () => {
    // ── (a) EL ALMACÉN ES POR DOCUMENTO, NO POR NAVEGACIÓN ────────────────────────────────────────
    // Las dos mitades juntas dicen QUÉ DEPENDE DE QUÉ. Ninguna sola dice nada: la primera sin la
    // segunda sería «hay un cache» y la segunda sin la primera, «se puede construir dos veces».
    expect(
      getContainer(),
      "`getContainer()` devolvió dos objetos distintos: no memoiza, y entonces ni siquiera una " +
        "navegación BLANDA conservaría la sesión",
    ).toBe(getContainer());
    expect(
      createContainer(),
      "dos `createContainer()` devolvieron el MISMO objeto: una carga NUEVA del documento estaría " +
        "reusando el almacén de sesión de la anterior, y `L-5` sería falsa",
    ).not.toBe(createContainer());

    // ── (b) 🔴 LA QUE DE VERDAD DECIDE: EN ESTE REPO NO HAY ROUTER DE CLIENTE ─────────────────────
    // Toda navegación del recorrido es `window.location.href = …` ⇒ toda salida es una navegación de
    // DOCUMENTO ⇒ el registro de módulos se descarta ⇒ el `singleton` de (a) vuelve a `null`. O sea:
    // `L-5` es verdadera hoy, y lo es POR AUSENCIA. Este barrido convierte esa ausencia en candado: el
    // día que alguien agregue un router de cliente, la premisa de la HU cambia y esto se pone rojo.
    expect(de("useRouter"), "apareció un hook de router de cliente: `L-5` hay que volver a medirla").toEqual([]);
    expect(de(PATRONES[1] as string), "apareció una navegación blanda por `push`").toEqual([]);
    expect(de(PATRONES[2] as string), "apareció una navegación blanda por `replace`").toEqual([]);
    // ⛔ LA ÚNICA OCURRENCIA PERMITIDA, Y SE FIJA POR LO QUE IMPORTA Y NO POR SU NÚMERO DE LÍNEA: un
    // `notFound()` NO navega, aborta el render. Si alguien le suma un `useRouter` a ESE mismo import,
    // esto cae por las dos puntas (acá y en el primer `expect` de arriba).
    expect(
      HALLAZGOS.filter((h) => h.patron === PATRONES[3]).map((h) => `${h.archivo} → ${h.texto}`),
      "el conjunto de imports de `next/navigation` del árbol cambió: puede haber entrado una " +
        "navegación de cliente",
    ).toEqual(['app/kyc-simulado/page.tsx → import { notFound } from "next/navigation";']);
    // 🔴 EL CONTROL NEGATIVO, SIN EL CUAL LO DE ARRIBA NO DICE NADA: un barrido roto que no encuentra
    // nada es indistinguible de un repo sin router. Las líneas son SINTÉTICAS y viven en memoria.
    const sintetico = barrer([
      {
        archivo: "sintetico.tsx",
        lineas: [
          `const enrutador = useRouter();`,
          `  router${"."}push("/x");`,
          `  router${"."}replace("/y");`,
          `import { redirect } from "next${"/"}navigation";`,
          `const nada = 1;`,
        ],
      },
    ]);
    expect(
      sintetico.map((h) => `${h.linea}:${h.patron}`),
      "el barrido no caza un router escrito con todas las letras: su `[]` de arriba es ceguera, no " +
        "una ausencia",
    ).toEqual([
      `1:useRouter`,
      `2:${PATRONES[1]}`,
      `3:${PATRONES[2]}`,
      `4:${PATRONES[3]}`,
    ]);

    // ── (c) EL CONTROL POSITIVO, SIN EL CUAL (a) NO DICE NADA ────────────────────────────────────
    // ⛔ Sin esto, un `peek` que devolviera `null` siempre haría que «la sesión no cruzó» fuera
    // indistinguible de «el instrumento no sabe decir que sí».
    const almacen = new InMemorySesionStore({ nowIso: () => new Date().toISOString() });
    almacen.record("Direccion-De-Prueba", "token-374");
    expect(
      almacen.peek("Direccion-De-Prueba"),
      "el almacén no devuelve una sesión que ACABA de grabar: no puede decir que SÍ, y entonces su " +
        "`null` no significa nada",
    ).toBe("token-374");
    expect(
      almacen.peek("Otra-Direccion"),
      "el almacén devuelve una sesión para una dirección que nadie grabó",
    ).toBeNull();
  });
});
