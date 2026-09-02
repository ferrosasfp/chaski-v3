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
/** 🔴 LAS CUATRO RAÍCES, Y HASTA EL `MNR-1` DEL CR DE ESTA OLA ERAN DOS. El otro barrido de la ola ya
 *  leía las cuatro y éste leía dos, **sin ningún motivo escrito**, que es lo que el CR marcó: dos
 *  guards hermanos que divergen en silencio. Medido ANTES de alinearlas, con
 *  `/usr/bin/grep -rn --include=*.ts --include=*.tsx` de los seis delatores sobre `scripts` y
 *  `contracts`: **cero ocurrencias** ⇒ sumar las dos raíces ensancha el barrido y ⛔ no mueve ni una
 *  de las aserciones de abajo. */
const DIRS = ["src", "app", "scripts", "contracts"];
const EXTS = new Set([".ts", ".tsx"]);
const SKIP = new Set(["node_modules", ".next", "doc", "migrations"]);

/** 🔴 RUTA EXACTA DE ESTE ARCHIVO, ⛔ NUNCA UN GLOB NI EL SUFIJO `.test.`. Este archivo escribe los
 *  SEIS delatores en su prosa y en su control negativo (decía «cuatro», y quedó viejo cuando el AR
 *  agregó dos): sin excluirse, el barrido se leería a sí mismo y el `it` no podría dar verde jamás,
 *  que es la otra cara de un guard que no puede fallar.
 *  Mismo recurso, y por el mismo motivo, que (`SELF`, `../composition/citas-ancladas.test.ts:56`),
 *  aplicado en la condición de recolección de (`SELF`, `../composition/citas-ancladas.test.ts:64`). */
const SELF = path.resolve(ROOT, "src/presentation/el-salto-remonta-el-arbol.test.tsx");

/** Los SEIS delatores de una navegación BLANDA (sin recargar el documento).
 *  🔴 LOS DOS ÚLTIMOS ENTRARON POR EL `BLQ-ALTO-1` DEL AR DE ESTA MISMA OLA, y el hallazgo vale la
 *  pena escribirlo: con los cuatro primeros solos, este `it` publicaba que «no hay router de cliente»
 *  mientras el árbol tenía —y tiene— un `<Link>` de `next/link` VIVO una línea debajo del import que
 *  la aserción de más abajo pinnea como la única permitida. Un componente nuevo con un `<Link>` para
 *  cambiar de pantalla —el gesto más natural de W1— dejaba este `it` en verde, o sea que el candado
 *  no protegía del error que existe para prevenir. `next/link` NO recarga el documento: preserva el
 *  registro de módulos, y con él el `singleton` que la pata (a) mide.
 *  🔴 Y NO SON SUBSTRINGS CRUDOS, QUE ES EL `MNR-2` DEL CR: son import-shaped, call-shaped o
 *  JSX-shaped, por el mismo motivo que documenta desde WKH-320 la «TRAMPA 3» de
 *  (`FORBIDDEN`, `../composition/no-evm-surface.test.ts:56`) —«los comentarios no son
 *  imports»— y que este archivo tuvo que volver a aprender. Medido antes de cambiarlos: **una sola
 *  línea de comentario** en cualquier archivo del árbol que dijera «acá NUNCA se usa useRouter»
 *  ponía este `it` rojo con el mensaje «apareció un hook de router de cliente». ⚠️ **W1 va a escribir
 *  justamente esos docblocks**, y el rojo lo iba a leer como un hallazgo.
 *  ⛔ LO QUE ESTA FORMA **NO** COMPRA: inmunidad del archivo a sí mismo. El control negativo de más
 *  abajo escribe los seis con todas las letras a propósito ⇒ **`SELF` sigue siendo load-bearing acá**
 *  (el `MNR-1` del AR midió que en el otro archivo de la ola no lo era; en éste sí). Lo único que la
 *  forma compra es que **la tabla se pueda escribir plana**, sin la concatenación que antes hacía
 *  falta para que estas seis líneas no se cazaran a sí mismas.
 *  ⚠️ EL LÍMITE DE `elemento-Link`, declarado: matchea una línea que empiece —tras puros espacios—
 *  con `<Link`. En un comentario eso no puede pasar (empiezan con `//` o con `*`); dentro de un
 *  template literal, sí. */
const PATRONES = [
  { nombre: "useRouter", pattern: /\buseRouter\s*\(/, por: "llamada al hook de router de cliente" },
  { nombre: "router.push", pattern: /\brouter\s*\.\s*push\s*\(/, por: "navegación blanda por push" },
  { nombre: "router.replace", pattern: /\brouter\s*\.\s*replace\s*\(/, por: "navegación blanda por replace" },
  { nombre: "import-next-navigation", pattern: /from\s+["']next\/navigation["']/, por: "import del router del App Router" },
  { nombre: "import-next-link", pattern: /from\s+["']next\/link["']/, por: "import del enlace blando" },
  { nombre: "elemento-Link", pattern: /(?:^\s*|[>{(&?:,=]\s*)<Link(?:[\s/>]|$)/, por: "un enlace blando renderizado" },
] as const;

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
        // ⛔ Los seis van SIN la bandera `g`: `test()` con `g` arrastra `lastIndex` entre llamadas y
        // saltearía una línea de cada dos. Es un falso VERDE, y es gratis de evitar.
        if (p.pattern.test(l)) out.push({ archivo: f.archivo, linea: i + 1, patron: p.nombre, texto: l.trim() });
      }
    });
  }
  return out;
}

/** 🔴 SE LEE CON `readFileSync`, ⛔ NUNCA CON `import`. Está medido en este repo: un guard de
 *  existencia que IMPORTA lo que vigila no muere por una aserción, muere por `Failed to resolve
 *  import` y el archivo entero colapsa en `0 test` — un rojo indistinguible de un error de sintaxis,
 *  que no es un KILLED. Lo dejó escrito el docblock del mutante de `T-372-W1-11`, en
 *  `./recorrido-en-el-navegador-de-la-billetera.test.tsx`.
 *  🔴 Y ESTÁ DUPLICADO A PROPÓSITO, QUE ES EL `MNR-1` DEL CR: este recorredor —con su `SKIP`, su
 *  `EXTS` y su `Fuente`— es byte a byte el de
 *  (`leerElArbol`, `../composition/costo-de-una-cita-anclada.test.ts:77`), y **el guard existía ya
 *  una tercera vez** en (`walk`, `../composition/no-evm-surface.test.ts:35`) desde WKH-320. ⛔ NO se
 *  extrae a un módulo compartido, y el motivo es de esta ola y no de estilo: **W0 escribe CERO
 *  líneas de producción** (`CD-W0-1`), y un helper fuera de un `.test.` es producción. Extraerlo
 *  además ataría tres guards independientes a un solo punto de falla: el día que alguien le agregue
 *  un `SKIP` para arreglar UNO, ciega a los otros dos en silencio. ⚠️ Lo que sí se corrigió es la
 *  divergencia muda: las raíces de los tres coinciden hoy, y el motivo está arriba, en `DIRS`. */
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
  //   · M-8 · 🔴 EL MUTANTE DEL `BLQ-ALTO-1`, y es el único que se aplica escribiendo un archivo:
  //     un componente NUEVO en `src/` con `import Link from "next/link"` y un enlace a `/enviar` ⇒
  //     caen las dos aserciones de `next/link` de la pata (b). Es exactamente el gesto que W1 va a
  //     hacer para cambiar de pantalla, y con los cuatro patrones originales este `it` lo dejaba
  //     pasar en verde. ⛔ El archivo del mutante se BORRA en la misma tarea: es producción.
  //   · M-11 · 🔴 EL MUTANTE DE LA ASERCIÓN DEL CORTE, que hasta el `BLQ-MED-1` del CR era la ÚNICA
  //     de las nuevas sin uno declarado (`CD-W0-6`) y era justo la que se escapaba. **Partir el `if`
  //     de `app/kyc-simulado/page.tsx:72` en dos líneas** (la condición en una, el `notFound();` en
  //     la otra) ⇒ ninguna línea conjuga ya los dos símbolos ⇒ cae la aserción del corte.
  //     🔴 Y ESTÁ ELEGIDO ASÍ A PROPÓSITO: **no cambia el comportamiento en nada**, así que
  //     `T-GATE-3'` y su control quedan VERDES y el rojo es de esta aserción y de ninguna otra. Es
  //     el mutante que un `E1`/`E2` no puede ser: los dos escapes tocan el comportamiento y los mata
  //     `T-GATE-3'`, o sea que serían falsos KILLED de este `it`, que ni siquiera se pone rojo.
  //     ⚠️ Lo que M-11 demuestra es exactamente el alcance declarado: esto vigila FORMA.
  //   · M-12 · devolverle a un `pattern` de `PATRONES` la forma de substring crudo (p. ej.
  //     `/useRouter/`) ⇒ las dos líneas de PROSA del control negativo empiezan a contarse y cae el
  //     control negativo. ⛔ No hace falta tocar ningún archivo del árbol: el fixture está en memoria.
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

    // ── (b) 🔴 LA QUE DE VERDAD DECIDE: EN EL RECORRIDO NO HAY NI UNA NAVEGACIÓN BLANDA ──────────
    // Toda navegación del recorrido es `window.location.href = …` ⇒ toda salida es una navegación de
    // DOCUMENTO ⇒ el registro de módulos se descarta ⇒ el `singleton` de (a) vuelve a `null`. O sea:
    // `L-5` es verdadera hoy, y lo es POR AUSENCIA. Este barrido convierte esa ausencia en candado: el
    // día que alguien agregue un router de cliente, la premisa de la HU cambia y esto se pone rojo.
    // ⚠️ Y LA FRASE VA ACOTADA AL RECORRIDO A PROPÓSITO: «en este repo no hay ninguna navegación
    // blanda» sería FALSA hoy, y el AR de esta ola lo midió. Hay exactamente una, declarada abajo.
    expect(de("useRouter"), "apareció un hook de router de cliente: `L-5` hay que volver a medirla").toEqual([]);
    expect(de("router.push"), "apareció una navegación blanda por `push`").toEqual([]);
    expect(de("router.replace"), "apareció una navegación blanda por `replace`").toEqual([]);
    // ⛔ LA ÚNICA OCURRENCIA PERMITIDA, Y SE FIJA POR LO QUE IMPORTA Y NO POR SU NÚMERO DE LÍNEA: un
    // `notFound()` NO navega, aborta el render. Si alguien le suma un `useRouter` a ESE mismo import,
    // esto cae por las dos puntas (acá y en el primer `expect` de arriba).
    expect(
      HALLAZGOS.filter((h) => h.patron === "import-next-navigation").map((h) => `${h.archivo} → ${h.texto}`),
      "el conjunto de imports de `next/navigation` del árbol cambió: puede haber entrado una " +
        "navegación de cliente",
    ).toEqual(['app/kyc-simulado/page.tsx → import { notFound } from "next/navigation";']);
    // ⛔ LA SEGUNDA OCURRENCIA PERMITIDA, Y ÉSTA SÍ NAVEGA: hay UN `<Link>` de `next/link` vivo en el
    // árbol, `app/kyc-simulado/page.tsx:114`, una línea debajo del import de acá arriba. No cuenta
    // contra `L-5` por dos motivos: (1) NO ESTÁ EN EL RECORRIDO —es la pantalla del simulador de KYC,
    // no una pantalla del envío—, y (2) ESTÁ DETRÁS DE UNA BANDERA: esa página corta con `notFound()`
    // salvo que `MOCK_KYC_SURFACE_ENABLED` valga el literal `"true"`, y eso lo decide
    // (`mockDiditSurfaceEnabled`, `../infrastructure/mock-surface.ts:51`).
    // 🔴 Y ACÁ VA EL LÍMITE, QUE ES EL `BLQ-MED-1` DEL CR DE ESTA OLA: **el (2) NO LO VERIFICA ESTE
    // ARCHIVO**. Quien lo mide —llamando a la página y mirando qué pasa, no leyendo su texto— es
    // it("T-GATE-3': con el gate apagado la página CORTA con la señal de 404 (llamada, no leída)")
    // en `app/kyc-simulado/kyc-simulado-gate.test.ts`. La tercera aserción de abajo es un TRIPWIRE DE
    // FORMA, su alcance está escrito arriba de ella, y ⛔ acá no se promete nada más.
    expect(
      HALLAZGOS.filter((h) => h.patron === "import-next-link").map((h) => `${h.archivo} → ${h.texto}`),
      "el conjunto de imports de `next/link` del árbol cambió: entró una navegación BLANDA, que NO " +
        "recarga el documento, preserva el registro de módulos y vuelve a poner en duda `L-5`",
    ).toEqual(['app/kyc-simulado/page.tsx → import Link from "next/link";']);
    expect(
      HALLAZGOS.filter((h) => h.patron === "elemento-Link").map((h) => h.archivo),
      "apareció un enlace de `next/link` fuera de la página apagada del simulador de KYC: es una " +
        "navegación blanda del App Router y el recorrido no puede tener ninguna",
    ).toEqual(["app/kyc-simulado/page.tsx"]);
    // ⛔ QUÉ EXIGE ESTA ASERCIÓN, LITERAL Y SIN UNA PALABRA DE MÁS: que en `app/kyc-simulado/page.tsx`
    // exista UNA línea que no empiece con `//` y que conjugue `mockDiditSurfaceEnabled()` con
    // `notFound()`. Hoy hay exactamente una y es `:72`, el corte de verdad.
    // 🔴 QUÉ **NO** EXIGE. La versión anterior de esta prosa decía «y QUE NO SEA UN COMENTARIO» y «si
    // alguien le saca el corte, esto cae». Las dos eran falsas, y el CR de esta ola las midió con dos
    // escapes de una línea que dejan ESTA ASERCIÓN EN VERDE:
    //   · E1 · invertir el `if` ⇒ `if (mockDiditSurfaceEnabled()) notFound();`. Los dos símbolos
    //     siguen en la misma línea ⇒ verde acá. Re-medido en el fix-pack: los rojos son `T-GATE-3'`
    //     y su control positivo, los dos en `app/kyc-simulado/kyc-simulado-gate.test.ts`.
    //   · E2 · reemplazar el corte por un `/** … */` que lo mencione ⇒ verde acá, porque
    //     `startsWith("//")` descarta el comentario de LÍNEA, ⛔ no el de BLOQUE. Re-medido: los
    //     rojos son `T-GATE-3'` y `G-1` (`../composition/kyc-provider-residue.static.test.ts`).
    // ⇒ ESTA ASERCIÓN NO INFIERE COMPORTAMIENTO, y ningún renglón de acá puede decir que lo hace. Lo
    // que sí caza, y por eso se queda: que esa línea desaparezca, se parta en dos o se mude de
    // archivo, o sea que **la excepción de este guard se quedó sin dónde apoyarse**.
    // ⚠️ Y EL `!startsWith("//")` HOY NO ES LOAD-BEARING, medido en vez de supuesto: ese archivo
    // nombra `notFound()` en su prosa en `:18`, `:31`, `:58`, `:64` y `:65`, pero ninguna de esas
    // líneas nombra además `mockDiditSurfaceEnabled()` ⇒ quitando la cláusula el `it` sigue verde.
    // Se queda como cinturón —el día que alguien comente el corte con `//` en vez de borrarlo, el
    // modo de falla es un rojo y no un verde—, ⛔ pero no se lo puede citar como si vigilara algo hoy.
    expect(
      (ARBOL.find((f) => f.archivo === "app/kyc-simulado/page.tsx")?.lineas ?? []).some(
        (l) =>
          !l.trimStart().startsWith("//") &&
          l.includes("mockDiditSurfaceEnabled()") &&
          l.includes("notFound()"),
      ),
      "la línea que conjuga `mockDiditSurfaceEnabled()` y `notFound()` desapareció de " +
        "`app/kyc-simulado/page.tsx`. ⛔ Esto NO dice que el corte dejó de funcionar —eso lo mide " +
        "`T-GATE-3'` en `app/kyc-simulado/kyc-simulado-gate.test.ts`, llamando a la página—: dice " +
        "que la excepción de este guard se quedó sin dónde apoyarse y hay que volver a leerla",
    ).toBe(true);
    // 🔴 EL CONTROL NEGATIVO, SIN EL CUAL LO DE ARRIBA NO DICE NADA: un barrido roto que no encuentra
    // nada es indistinguible de un repo sin router. Las líneas son SINTÉTICAS y viven en memoria.
    // 🔴 Y TIENE DOS MITADES DESDE EL `MNR-2` DEL CR: las líneas `1..7` son las que TIENE que cazar,
    // y las `8` y `9` son PROSA que nombra los seis delatores y que ⛔ NO puede aparecer en la lista.
    // Con los substrings crudos de antes, esas dos líneas ponían el `it` rojo — y son exactamente el
    // docblock que W1 va a escribir. Lo que las mantiene afuera es la FORMA de los patrones.
    const sintetico = barrer([
      {
        archivo: "sintetico.tsx",
        lineas: [
          `const enrutador = useRouter();`,
          `  router${"."}push("/x");`,
          `  router${"."}replace("/y");`,
          `import { redirect } from "next${"/"}navigation";`,
          `const nada = 1;`,
          `import Enlace from "next${"/"}link";`,
          `  <${"L"}ink href="/enviar">Ir a enviar</${"L"}ink>`,
          `// nota: acá NUNCA se usa useRouter, y el recorrido no tiene ningún <Link> blando`,
          ` * el molde viejo hablaba de router.push, de router.replace y de next/link sin usarlos`,
        ],
      },
    ]);
    expect(
      sintetico.map((h) => `${h.linea}:${h.patron}`),
      "o el barrido no caza un router ni un enlace blando escritos con todas las letras —y su `[]` " +
        "de arriba es ceguera y no una ausencia—, o volvió a cazar PROSA, que es el falso rojo que " +
        "le espera a cada docblock que W1 escriba",
    ).toEqual([
      `1:useRouter`,
      `2:router.push`,
      `3:router.replace`,
      `4:import-next-navigation`,
      `6:import-next-link`,
      `7:elemento-Link`,
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
