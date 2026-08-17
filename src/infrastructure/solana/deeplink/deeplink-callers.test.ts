// ⚠️ CD-15 · LOS DOS MUTANTES DE ESTE ARCHIVO SE CORRIERON (2026-08-17, re-medidos en el fix-pack 1),
// con la suite COMPLETA y restauración verificada byte a byte:
//
// | mutante                                                                | exit | `it` rojos |
// |---|---|---|
// | agregar un SEGUNDO llamador de producción de `interpretarVuelta`        | 1 | 1 |
// | escribir `deeplink_rechazado` en un archivo de `src/presentation`       | 1 | 3 |
//
// El segundo mutante mata 3 y no 1, y los tres nombran algo distinto: el `it` de copy de acá, el
// candado de citas de `scripts/` y el de citas ancladas — porque el mutante mete una línea en
// `flow-vm.ts` y eso DESPLAZA citas. Es colateral y va dicho: si no se dice, alguien cuenta 3 y cree
// que el candado de copy es más fuerte de lo que es.
// T-062-10 (CD-8 / T1) · candado de CLASE: `interpretarVuelta` tiene UN SOLO llamador de producción.
//
// 🔴 QUÉ PROBLEMA CIERRA, Y POR QUÉ ES UN CANDADO DE CLASE Y NO DE INSTANCIA. `interpretarVuelta` es
// una ESCRITURA con nombre de lectura: consume el paso de forma irreversible y marca el viaje. El
// nombre invita justamente al uso que la rompe — llamarla "para ver qué pasó" desde un render, un
// `useMemo` o un efecto. Y `next.config.mjs` tiene `reactStrictMode: true`, así que en desarrollo los
// efectos se invocan DOS veces: la segunda lectura devuelve `ya-consumida` sobre una firma buena.
//
// Un test que dijera "el motor la llama con el argumento correcto" es de INSTANCIA: se pone verde y
// no dice nada del segundo llamador que alguien agregue mañana en un componente. La lección la dejó
// medida 061/MNR-1. Éste barre el árbol y cuenta.
//
// ⚠️ LO QUE ESTE CANDADO NO CIERRA, declarado:
//   1. Cuenta MENCIONES del identificador en archivos que no son de test, no llamadas resueltas por
//      un analizador. Un alias (`const f = interpretarVuelta; f(...)`) lo esquiva. Se prefirió el
//      barrido textual a un parser porque el modo de falla que importa —alguien escribe
//      `interpretarVuelta(` en un componente— es exactamente el que el texto ve.
//   2. No dice NADA sobre desde dónde se llama la única llamada que quedó: que esté en el motor y no
//      en un render lo fija el `expect` sobre la ruta, que es parte de este mismo `it`.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { humanError } from "../../../presentation/flow-vm";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app"];
const SCAN_EXTS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations"]);

/** Ruta EXACTA de este archivo: sus propias menciones son de mentira. */
const SELF = path.resolve(ROOT, "src/infrastructure/solana/deeplink/deeplink-callers.test.ts");
/** Donde la función VIVE. Su declaración y su docblock no son llamadas. */
const DECLARACION = path.resolve(ROOT, "src/infrastructure/solana/deeplink/sesion.ts");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
    } else if (SCAN_EXTS.has(path.extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

const ARCHIVOS = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

/** Un archivo de test no es producción: puede llamarla las veces que quiera. */
function esTest(rel: string): boolean {
  return /\.test\.tsx?$/.test(rel);
}

const LLAMADAS = ARCHIVOS.filter((abs) => {
  const rel = path.relative(ROOT, abs);
  return abs !== SELF && abs !== DECLARACION && !esTest(rel);
})
  .map((abs) => ({
    ruta: path.relative(ROOT, abs),
    veces: readFileSync(abs, "utf8").split("interpretarVuelta(").length - 1,
  }))
  .filter((x) => x.veces > 0);

describe("T-062-10 · CD-8: `interpretarVuelta` tiene EXACTAMENTE DOS llamadores de producción", () => {
  // Sin esto el candado podría quedar vigilando CERO archivos (un `SCAN_DIRS` mal escrito, un
  // `walk` que devuelve vacío) y seguir en verde, que es como un guard deja de existir sin que nadie
  // lo note. El piso es holgado a propósito: lo que se mide es que el barrido VE el árbol.
  it("el barrido no está vacío (el candado existe de verdad)", () => {
    expect(ARCHIVOS.length).toBeGreaterThan(200);
  });

  // 🔴 ESTE `it` SE INVIRTIÓ EN LA OLA 4, NO SE BORRÓ NI SE AFLOJÓ (CD-14). Decía "hay exactamente UN
  // sitio de producción, y es el motor", y era cierto mientras nadie escribía el paso 1: el motor
  // CONSUMÍA un viaje conectado que ningún código de producción producía.
  //
  // 🔒 LO QUE **NO** CAMBIÓ, y es todo el valor del candado: la lista sigue siendo EXACTA y EXHAUSTIVA.
  // No pasó a ser `toBeLessThanOrEqual(2)` ni "los que estén en esta carpeta": son estos dos archivos,
  // nombrados, con su cantidad de llamadas. Un tercer llamador —o una segunda llamada en cualquiera de
  // los dos— sigue poniendo esto rojo y nombrando el archivo.
  //
  // ⚠️ POR QUÉ EL SEGUNDO ES LEGÍTIMO Y NO UN ABLANDAMIENTO. Los dos llamadores están en los DOS
  // EXTREMOS del flujo y no pueden pisarse: el motor corre DESPUÉS del KYC (`authorizePrincipal` sólo
  // se alcanza con KYC aprobado) y el connect por enlace ocurre ANTES. Y `completarVuelta` **no toca**
  // las marcas del motor (`firmar-tx`/`firmar-patrocinio`): sale `nada` sin llamar a
  // `interpretarVuelta`, que es lo que impide que le queme el paso. Eso tiene su propio `it` (T-065-4).
  //
  // MUTANTE QUE MATA (los dos siguen matando): agregar `interpretarVuelta(` en CUALQUIER otro archivo
  // de producción ⇒ rojo, y nombra el archivo. Y agregar una SEGUNDA llamada en cualquiera de los dos
  // ⇒ también rojo, porque la cantidad va en la cadena comparada.
  it("hay exactamente DOS sitios de producción: el motor y la pata `conectar`", () => {
    expect(
      LLAMADAS.map((x) => `${x.ruta} (x${x.veces})`).sort(),
      "`interpretarVuelta` CONSUME el paso de forma irreversible. Un llamador de producción que no sea " +
        "uno de estos dos —sobre todo en un render o un efecto, que React invoca dos veces en " +
        "desarrollo— gasta una firma que la persona ya dio y la vuelve `ya-consumida`. Los DOS " +
        "legítimos son el motor (pasos 2 y 3, después del KYC) y `conexion.ts` (paso 1, antes del " +
        "KYC), y están en extremos opuestos del flujo. Si esta lista cambió, no es un detalle de estilo.",
    ).toEqual(
      [
        "src/infrastructure/solana/deeplink/conexion.ts (x1)",
        "src/infrastructure/solana/deeplink/firma-por-enlace.ts (x1)",
      ].sort(),
    );
  });

  // ⛔ Y no puede llamarse desde presentación NI aunque alguien "sólo la mire". Este `it` es
  // redundante con el de arriba a propósito: nombra la clase de archivo prohibida, que es lo que un
  // lector busca cuando está por escribir el segundo llamador.
  it("NINGÚN archivo de presentación la menciona", () => {
    const enPresentacion = ARCHIVOS.filter((abs) => {
      const rel = path.relative(ROOT, abs);
      return rel.startsWith("src/presentation") && readFileSync(abs, "utf8").includes("interpretarVuelta");
    }).map((abs) => path.relative(ROOT, abs));
    expect(enPresentacion).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-358/AC-8 — LAS ONCE CAUSAS TIENEN COPY PROPIO (candado INVERTIDO, CD-14)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ DECÍA ESTE CANDADO HASTA LA OLA 3 Y POR QUÉ CAMBIÓ DE SIGNO. Decía que **ninguna** causa de
// enlace tenía copy, y era verdad: el AR midió que `grep -rn "deeplink_" src/presentation` daba CERO,
// o sea que las once caían en el default de `humanError` y la persona leía la misma frase para
// "cancelaste" y para "no pudimos preguntarle a la red". El motivo de no escribirlo entonces era
// mecánico y está escrito en el commit de esa ola: el colaborador de enlace no estaba cableado, así
// que ninguna causa tenía camino de producción, y un copy para un error que nadie puede provocar es
// código muerto de money-path.
//
// La ola 4 cableó ese camino. El candado se **INVIERTE** —no se borra, no se `skip`ea— y pasa a exigir
// lo contrario, con el mismo mecanismo: las causas se DERIVAN del módulo con un regex, nunca de una
// lista escrita a mano.
//
// 🔴 Y POR QUÉ ESTA CAPA EXISTE ADEMÁS DEL `Record` TIPADO, que es la pregunta que se hace un review:
// el `Record` está tipado sobre `CausaDeEnlaceEnPantalla`, que es una unión escrita A MANO. `tsc`
// garantiza que no falte ninguna de las que ESE TIPO nombra, y nada más. Una DOCEAVA causa exportada
// mañana en el motor no entra sola a ese tipo, así que el compilador la deja pasar en silencio. Este
// candado deriva las causas del ARCHIVO y es el único que la ve.
// MUTANTE QUE MATA: agregar `export const DEEPLINK_XXX = "deeplink_xxx";` en `firma-por-enlace.ts`
// SIN agregarla al `Record` ⇒ rojo acá y verde en `tsc`, que es exactamente lo que este candado existe
// para probar. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`, que trae exit y `it` rojos de los 47 con el árbol en que se midieron.)
describe("T-065-COPY-1 · las once causas de enlace tienen copy propio", () => {
  const MOTOR = path.resolve(ROOT, "src/infrastructure/solana/deeplink/firma-por-enlace.ts");
  const ADAPTADOR = path.resolve(ROOT, "src/infrastructure/solana-wallet.ts");
  /** Las causas se DERIVAN del módulo, no se listan a mano: una lista a mano no ve la que falta. */
  const DEL_MOTOR = [...readFileSync(MOTOR, "utf8").matchAll(/^export const (DEEPLINK_\w+) = "(\w+)";$/gm)].map(
    (m) => m[2] as string,
  );
  /** 🔴 LAS DOS DEL ADAPTADOR, que NO están en `CausaDeEnlace` y son las que un `switch` exhaustivo
   *  deja pasar sin que `tsc` diga nada. Se derivan del archivo con la misma disciplina. */
  const DEL_ADAPTADOR = [
    ...new Set(
      [...readFileSync(ADAPTADOR, "utf8").matchAll(/throw new Error\("(deeplink_\w+)"\)/g)].map(
        (m) => m[1] as string,
      ),
    ),
  ];
  const CAUSAS = [...new Set([...DEL_MOTOR, ...DEL_ADAPTADOR])];
  const PRESENTACION = ARCHIVOS.filter((abs) =>
    path.relative(ROOT, abs).startsWith("src/presentation"),
  );

  // Refutación: sin esto, un regex que dejara de matchear pondría los `it` de abajo en verde sobre una
  // lista vacía, que es exactamente cómo un candado deja de existir sin que nadie lo note.
  it("las causas se derivaron de verdad, de los DOS archivos", () => {
    expect(DEL_MOTOR.length, "el barrido del motor no encontró NINGUNA causa exportada").toBeGreaterThanOrEqual(8);
    expect(
      DEL_ADAPTADOR,
      "el barrido del adaptador no encontró las dos causas que `CausaDeEnlace` NO nombra",
    ).toEqual(expect.arrayContaining(["deeplink_nonce_ausente", "deeplink_saldo_insuficiente"]));
    expect(CAUSAS).toContain("deeplink_rechazado");
    expect(PRESENTACION.length).toBeGreaterThan(10);
  });

  it("TODAS las causas derivadas tienen copy en `src/presentation`", () => {
    const sinCopy = CAUSAS.filter(
      (c) => !PRESENTACION.some((abs) => readFileSync(abs, "utf8").includes(c)),
    );
    expect(
      sinCopy,
      "estas causas del enlace llegan a la pantalla y caen en el default de `humanError`, o sea que " +
        "la persona lee la misma frase para 'cancelaste' que para 'no pudimos preguntarle a la red'. " +
        "El copy va en el `Record` de `flow-vm.ts`, y su clave tiene que estar en " +
        "`CausaDeEnlaceEnPantalla` para que `tsc` lo exija.",
    ).toEqual([]);
  });

  // 🔴 EL TRABAJO FINO QUE LA OLA 3 DEJÓ HECHO DEL LADO DEL MOTOR, VERIFICADO DEL LADO DEL COPY: los
  // tres son diagnósticos distintos con acciones distintas, y colapsarlos hace que una persona
  // reintente contra un muro. Que TENGAN copy no alcanza: tienen que ser textos DISTINTOS ENTRE SÍ.
  // MUTANTE QUE MATA: colapsar dos de los tres al mismo texto en el `Record`. (MEDIDO en §9.)
  it("T-065-COPY-2: los tres pares del mensaje son textos DISTINTOS entre sí", () => {
    const TRES = ["deeplink_rechazado", "deeplink_respuesta_ilegible", "deeplink_blockhash_desconocido"];
    const textos = TRES.map((c) => humanError(c));
    for (const [i, t] of textos.entries()) {
      expect(t, `\`${TRES[i]}\` cae en el default de \`humanError\``).not.toBe(
        "Algo salió mal. Intentá de nuevo.",
      );
    }
    expect(
      new Set(textos).size,
      "dos de los tres dicen lo mismo: 'cancelaste' (un gesto de la persona), 'no pudimos leer la " +
        "respuesta' (un fallo NUESTRO) y 'no llegamos a preguntar' piden acciones distintas",
    ).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-065-6 (AC-2) y T-065-CD11b (DT-2) — las afirmaciones que esta HU volvió falsas, y su reescritura
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ CLASE DE DEFECTO CIERRAN ESTOS DOS `it`, y no es "documentación desactualizada". Los dos
// vigilan frases que eran CIERTAS cuando se escribieron y que un cambio de código de OTRA wave volvió
// falsas sin tocarlas. Ningún barrido del diff las caza, porque en el diff no aparecen.
//
// ⚠️ LO QUE ESTOS DOS BARRIDOS **NO** PUEDEN HACER, dicho antes de que alguien se apoye en su verde:
// no prohíben la frase vieja, porque las reescrituras la CITAN a propósito (decir "esto decía X y X es
// falso" es la mitad del valor de la reescritura). Lo que exigen es que el texto nuevo esté: si
// alguien REEMPLAZA la reescritura por la frase vieja, los marcadores desaparecen y esto se pone rojo.
// Si alguien la AGREGA sin borrar nada, no lo ven. Es un techo real y va escrito.
describe("T-065-6 / T-065-CD11b · las afirmaciones reescritas", () => {
  const MOTOR = path.resolve(ROOT, "src/infrastructure/solana/deeplink/firma-por-enlace.ts");
  const ADAPTADOR = path.resolve(ROOT, "src/infrastructure/solana-wallet.ts");

  /** El bloque que arranca en `desde` y termina en `hasta`, con su refutación de que existe. */
  function bloque(archivo: string, desde: string, hasta: string): string {
    const txt = readFileSync(archivo, "utf8");
    const a = txt.indexOf(desde);
    expect(a, `no se encontró el ancla «${desde}» en ${path.basename(archivo)}`).toBeGreaterThan(0);
    const b = txt.indexOf(hasta, a);
    expect(b, `no se encontró el cierre «${hasta}» en ${path.basename(archivo)}`).toBeGreaterThan(a);
    return txt.slice(a, b);
  }

  // MUTANTE QUE MATA: restaurar la frase vieja («El día que la ola 4 escriba el connect por enlace,
  // esta rama pasa a ser alcanzable de verdad y ahí necesita su `it`.») EN LUGAR de la reescritura.
  // (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`, que trae exit y `it` rojos de los 47 con el árbol en que se midieron.)
  it("T-065-6: el docblock del `case \"conectado\"` del motor ya NO promete que la rama se vuelve alcanzable", () => {
    const b = bloque(MOTOR, 'case "conectado":', 'case "tx-firmada":');
    // La razón MEDIDA tiene que estar, y son las tres mitades del argumento de AC-2.
    expect(b, "el docblock dejó de decir que la rama SIGUE inalcanzable").toContain("SIGUE inalcanzable");
    expect(b, "el docblock no dice quién procesa la vuelta del connect").toContain("conexion.ts");
    expect(b, "el docblock no dice por qué los dos extremos no se pisan (el KYC)").toContain("KYC");
    // Refutación del instrumento: el bloque que se está mirando es el que se cree.
    expect(b, "el corte se llevó el cuerpo de la rama").toContain("cortar(DEEPLINK_VIAJE_VENCIDO)");
    expect(b.length).toBeGreaterThan(500);
  });

  // MUTANTE QUE MATA — TRES SITIOS, TRES CORRIDAS: restaurar la frase vieja («NUNCA sale del canal del
  // enlace», sin calificar el camino) en cualquiera de los tres, en lugar de la reescritura.
  // (MEDIDO: el conteo de cada uno está en LA BATERÍA, al final de `deeplink/conexion.test.ts`.)
  it("T-065-CD11b: los TRES sitios de CD-11 califican el camino, y ninguno se borró", () => {
    const sitios: ReadonlyArray<{ nombre: string; texto: string }> = [
      {
        nombre: "firma-por-enlace.ts · docblock de `PedidoDeFirma.sender`",
        texto: bloque(MOTOR, "  sender: string;", "  /** El `beneficiary` del `prepare()`"),
      },
      {
        nombre: "firma-por-enlace.ts · la justificación del guard",
        texto: bloque(MOTOR, "── 2 · CD-11 / T12", "const lectura = leerViaje("),
      },
      {
        nombre: "solana-wallet.ts · el bloque de CD-11 del adaptador",
        texto: bloque(ADAPTADOR, "CD-11, REESCRITO EN WKH-358", "const senderCanonico"),
      },
    ];
    // ⚠️ EL BLOQUE DEL `sender` SE MIDE HACIA ARRIBA: su docblock está ANTES de la firma. Se recorta al
    // revés y por eso el ancla de arranque es el campo, no el comentario.
    const delSender = readFileSync(MOTOR, "utf8");
    const finSender = delSender.indexOf("  sender: string;");
    const iniSender = delSender.lastIndexOf("  /**", finSender);
    const textoSender = delSender.slice(iniSender, finSender);

    const aRevisar = [{ nombre: sitios[0]?.nombre as string, texto: textoSender }, ...sitios.slice(1)];

    for (const s of aRevisar) {
      // (1) el sitio NO se borró: sigue habiendo texto ahí.
      expect(s.texto.length, `${s.nombre}: el bloque de CD-11 desapareció`).toBeGreaterThan(300);
      // (2) y CALIFICA EL CAMINO. Un solo texto para dos caminos era lo que volvía falsa la frase.
      expect(
        /camino inyectado/i.test(s.texto),
        `${s.nombre}: no nombra el camino INYECTADO, donde el \`sender\` sí sale de fuera del canal`,
      ).toBe(true);
      expect(
        /camino por enlace/i.test(s.texto),
        `${s.nombre}: no nombra el camino POR ENLACE, donde las dos mitades salen del mismo disco`,
      ).toBe(true);
      expect(
        /coherencia interna/i.test(s.texto),
        `${s.nombre}: no dice que en el camino por enlace el guard es COHERENCIA y no una defensa`,
      ).toBe(true);
    }
    // (3) y los dos que hablan del reemplazo nombran DÓNDE está el corte que sí lo es.
    for (const s of aRevisar.slice(1)) {
      expect(
        s.texto.includes("ownerAddress"),
        `${s.nombre}: no dice dónde está el corte que SÍ es una defensa (el cruce contra \`ownerAddress\`)`,
      ).toBe(true);
    }
    // (4) y el residual va escrito y sin suavizar en el sitio que lo desarrolla.
    expect(
      aRevisar[1]?.texto,
      "el residual de `ownerAddress == null` dejó de estar escrito: es la mitad que un review echa de menos",
    ).toContain("ownerAddress == null");
  });
});
