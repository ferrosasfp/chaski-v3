// T-2.1 (WKH-332 / AC-2) — canario ESTÁTICO: ningún nombre de agente vuelve al código de producción.
// Patrón: `kyc-verification-id-guard.static.test.ts`, que es el exemplar de este repo para un candado
// que es un `grep` corriendo en cada `npm test` en vez de un `grep` que alguien tiene que acordarse.
//
// 🔴 QUÉ AGUJERO CIERRA, Y NO ES HIPOTÉTICO. Esta app llamaba a dos agentes por su slug, cableado en
// una URL, y el preview mostraba el agente que el catálogo listaba primero. MEDIDO contra producción el
// 2026-08-05: el catálogo devolvía un par de slugs y las rutas llamaban a OTRO par, así que la pantalla
// nombraba a quien no corría. WKH-332 borró el carril entero, y el modo de falla que queda es la
// reintroducción: una constante "sólo para el preview", un default "por si el gateway no contesta", un
// comentario que documenta un agente que ya no se invoca. Ninguna de las tres falla al correr — todas
// vuelven a atar este repo a un proveedor concreto, que es lo contrario de pedir una capacidad.
//
// ⚠️ LO QUE ESTE CANDADO **NO** CIERRA, enunciado y no insinuado:
//   1. Es TEXTUAL sobre subcadenas literales. Un slug partido en dos (`"remit-" + "corridor-fx"`), uno
//      leído de una env, o un agente NUEVO con otro nombre lo esquivan enteros. No mira semántica:
//      mira dos palabras. Lo que sí mide, y es la mitad que importa, es que las que había no vuelvan.
//   2. NO mira los `*.test.*`. Los tests DEBEN poder escribir un slug: varios describen contra qué
//      catálogo se midió, y los fixtures vendoreados nombran al provider. AC-2 no los cubre a
//      propósito — al 2026-08-07 quedan 26 hits en tests, y ese número es una foto que no verifica
//      nadie: lo que este archivo verifica es el CERO en producción.
//   3. NO mira `doc/`, `.env.example`, `supabase/` ni `contracts/`. `contracts/` queda afuera porque
//      el fixture vendoreado del provider ES su nombre: pinnearlo es el punto de un contract test.
//   4. NO mira `scripts/`. Es una diferencia deliberada con el guard del `kycVerificationId`, que sí
//      los barre: los scripts de smoke apuntan a agentes concretos por diseño (son sondas operativas,
//      no el camino del dinero). Si mañana un script vuelve a ser el que ELIGE el agente que cobra,
//      esta exclusión hay que revisarla.
//   5. EL DESPOJADO DE COMENTARIOS NO EXISTE ACÁ, y es lo contrario del exemplar. AC-2 dice
//      textualmente "ni en código ni en comentarios", porque un comentario que documenta el agente que
//      se invoca es lo que mantiene vivo el acoplamiento en la cabeza de quien lee. Ergo: cualquier
//      línea, sea código o prosa, cuenta como hit.
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 WKH-233 — EXISTE UN SLUG NUEVO EN PRODUCCIÓN, `remit-kyc-validator`, Y **NO ENTRA A
// `PROHIBIDAS`**. La excepción va escrita ACÁ, dentro del propio candado, porque `doc/` no viaja con
// el repo y una excepción que sólo vive en un documento es una excepción que nadie va a encontrar.
//
// (a) QUÉ ES. Desde WKH-233, Chaski deja de implementar el KYC y lo consume del agente
//     `remit-kyc-validator` (repo `wasiai-remittance-agents`). El nombre aparece en producción, sí.
//
// (b) 🔴 POR QUÉ NO ES EL PATRÓN QUE ESTE CANDADO EXISTE PARA CAZAR, que es la parte que importa.
//     Lo que AC-2 prohíbe es "un slug CABLEADO EN VEZ DE PEDIR UNA CAPACIDAD": el repo sabía nombrar
//     `remittance-fx-quote` y aun así llamaba a un proveedor concreto por su nombre, así que la
//     pantalla podía nombrar a quien no corría. **Ese camino alternativo no existe para el KYC.** El
//     gateway A2A resuelve capacidades con un `POST /compose` de N pasos, y `GET /decision` es un
//     **GET con la credencial en una cabecera** y un redirect humano en el medio: el protocolo NO
//     SABE EXPRESAR eso hoy (DT-1). No hay una capacidad que pedir en lugar del slug — hay un slug o
//     no hay KYC. Cablearlo no es elegir el camino fácil sobre el correcto: es el único que existe.
//     ⚠️ Y se dice al derecho: esto NO es "Chaski corre entero sobre el gateway". Es "Chaski CONSUME
//     el agente de KYC". La diferencia está declarada como residual de la HU, no disimulada.
//
// (c) APARECE **EXACTAMENTE UNA VEZ** en producción, y ese uno está gateado: vive en
//     `src/infrastructure/kyc/agent-env.ts`, en la constante que compone la ruta, junto a la única
//     fábrica del host (fail-closed, sin default). Los call sites NO lo escriben: usan `kycAgentUrl`,
//     que es lo que impide la segunda aparición. Su candado propio es **T-ENV-3** en
//     `agent-env.test.ts`, que cuenta apariciones TEXTUALES en ese módulo y exige exactamente 1 —
//     por eso ni siquiera la prosa de ese archivo lo nombra.
//
// ⛔ LO QUE NO SE HIZO, Y SE DICE: **no se lo agregó a `PROHIBIDAS` con una excepción por archivo.**
// Eso habría sido pasar por debajo de la lista de agujas sin declararlo, o sea ganar la métrica sin
// cumplir la regla. La regla se cumple por otro lado (el conteo de T-ENV-3) y acá se explica por qué.
// El día que el gateway sepa expresar una capacidad de dos saltos con redirect humano, este slug
// tiene que irse a `PROHIBIDAS` como los otros — y ese día hay que borrar este bloque, no ampliarlo.
// ════════════════════════════════════════════════════════════════════════════════════════════════
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app"];
const SCAN_EXTS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations"]);

/**
 * Las subcadenas prohibidas.
 *
 * 🔴 SON DOS Y NO CUATRO, Y ESO ESTÁ MEDIDO, NO ASUMIDO. Los cuatro slugs que esta HU borró eran
 * `remit-corridor-fx`, `remit-cashout-payout` y sus dos variantes con sufijo `-solana`. Las variantes
 * CONTIENEN a las dos de acá como prefijo, así que buscar las cuatro daría exactamente los mismos hits
 * y haría creer que el barrido es más fino de lo que es. El `it` de abajo lo comprueba en vez de
 * pedir que se confíe: asserta que cada variante con sufijo contiene una de estas dos.
 */
const PROHIBIDAS = ["remit-corridor-fx", "remit-cashout-payout"] as const;

/** Las cuatro grafías que AC-2 nombra. Existe para que el `it` de cobertura pueda demostrar que las
 *  dos agujas de arriba las cubren, y para que agregar una quinta grafía que NO empiece igual rompa
 *  ese `it` en vez de pasar inadvertida. */
const LAS_CUATRO_DE_AC2 = [
  "remit-corridor-fx",
  "remit-cashout-payout",
  "remit-corridor-fx-solana",
  "remit-cashout-payout-solana",
] as const;

const SELF = path.resolve(ROOT, "src/composition/agent-slug-residue.static.test.ts");

function isTestFile(full: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path.basename(full));
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (SCAN_EXTS.has(path.extname(entry))) {
      if (path.resolve(full) !== SELF && !isTestFile(full)) out.push(full);
    }
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

interface Hit {
  rel: string;
  line: number;
  needle: string;
  text: string;
}

function findHits(): Hit[] {
  const hits: Hit[] = [];
  for (const full of FILES) {
    const lineas = readFileSync(full, "utf8").split("\n");
    lineas.forEach((linea, i) => {
      for (const needle of PROHIBIDAS) {
        if (linea.includes(needle)) {
          hits.push({ rel: path.relative(ROOT, full), line: i + 1, needle, text: linea.trim() });
        }
      }
    });
  }
  return hits;
}

describe("AC-2 — barrido estático: ningún nombre de agente en el código de producción", () => {
  it("el barrido no es vacuo: ve archivos, y encuentra la aguja cuando la aguja está", () => {
    // 50 es un PISO, no la medición: descarta el modo de falla "el walk devolvió (casi) nada", que es
    // como este guard se volvería decorativo sin ponerse rojo. Al 2026-08-07 son bastantes más.
    expect(FILES.length).toBeGreaterThan(50);
    // Y que el matcher matchee: sin esto, un `PROHIBIDAS` vacío o mal escrito daría cero hits y verde.
    expect(PROHIBIDAS.some((n) => "const X = \"remit-corridor-fx\";".includes(n))).toBe(true);
    expect(PROHIBIDAS.some((n) => "// el agente remit-cashout-payout-solana".includes(n))).toBe(true);
    // Y que NO matchee lo que no debe: `remittance-fx-quote` es la CAPACIDAD, que sí puede aparecer.
    expect(PROHIBIDAS.some((n) => "remittance-fx-quote".includes(n))).toBe(false);
    expect(PROHIBIDAS.some((n) => "remittance-payout".includes(n))).toBe(false);
  });

  // Lo que hace que "dos agujas cubren cuatro grafías" sea un hecho verificable y no una suposición.
  it("las dos agujas cubren las CUATRO grafías que AC-2 nombra", () => {
    for (const grafia of LAS_CUATRO_DE_AC2) {
      expect(
        PROHIBIDAS.some((n) => grafia.includes(n)),
        `la grafía «${grafia}» no la cubre ninguna aguja: agregala a PROHIBIDAS`,
      ).toBe(true);
    }
  });

  // 🔴 WKH-233 — LA EXCEPCIÓN DECLARADA, HECHA ASSERT. El bloque de la cabecera explica POR QUÉ el
  // slug del agente de KYC no entra a `PROHIBIDAS`; esto fija la mitad que se puede medir: que
  // `PROHIBIDAS` sigue SIN cubrirlo (o sea que la excepción es real y no un descuido) y que el
  // conteo en producción lo vigila OTRO test, nombrado acá para que se pueda seguir.
  it("T-SLUG-1: `remit-kyc-validator` NO está cubierto por `PROHIBIDAS`, y su candado es T-ENV-3", () => {
    expect(
      PROHIBIDAS.some((n) => "remit-kyc-validator".includes(n)),
      "el slug del agente de KYC entró al conjunto prohibido: o alguien lo agregó sin leer la " +
        "excepción de la cabecera, o una aguja nueva lo cubre por accidente. Las dos rompen el KYC",
    ).toBe(false);
    // Y el control positivo del propio assert: las agujas SÍ cubren lo que tienen que cubrir. Sin
    // esto, un `PROHIBIDAS` vacío pasaría el `toBe(false)` de arriba y este `it` sería vacuo.
    expect(PROHIBIDAS.some((n) => "remit-corridor-fx-solana".includes(n))).toBe(true);
  });

  it("AC-2: cero hits en `src` y `app` (excluidos los `*.test.*`), en código Y en comentarios", () => {
    expect(
      findHits().map((h) => `${h.rel}:${h.line}  [${h.needle}]  «${h.text}»`),
      "volvió un nombre de agente al código de producción. Sea una constante, un default o un " +
        "comentario, lo que reintroduce es el acoplamiento a un proveedor concreto: este repo pide la " +
        "capacidad `remittance-fx-quote` / `remittance-payout` y el gateway resuelve QUIÉN al ejecutar. " +
        "Si de verdad hace falta nombrar a alguien, el que decide es el gateway y el dato viaja en " +
        "`steps[i].agent` de su respuesta, no en una constante de acá",
    ).toEqual([]);
  });
});
