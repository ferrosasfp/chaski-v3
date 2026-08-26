// T-KGS-1/2/3 (WKH-366 · AC-15 parcial) — canario ESTÁTICO de los DOS slugs nuevos del KYC por
// gateway, y de los dos símbolos del transporte directo que todavía no se pueden borrar.
//
// Exemplar: `agent-slug-residue.static.test.ts` (el `walk`, el `SELF`, el control de no-vacuidad).
//
// 🔴 POR QUÉ ESTE ARCHIVO EXISTE HOY Y NO EN LA HU DE SEGUIMIENTO. AC-15 completo afirma que "no
// existe `fetch` directo al agente en producción", y eso es FALSO POR DISEÑO mientras `KYC_TRANSPORT`
// tenga default `direct`: el transporte directo sigue vivo y tiene que seguir vivo, porque ES el
// rollback. Mergear ese guard ahora lo dejaría rojo o —peor— lo obligaría a nacer con una excepción
// que lo vacía. Lo que SÍ puede ser cierto hoy, y por eso está acá, es la mitad del conteo: que los
// dos slugs nuevos no se dispersen, y que los dos símbolos del camino viejo no ganen importadores.
//
// ⚠️ LO QUE ESTE CANDADO **NO** CIERRA, enunciado y no insinuado:
//   1. Es TEXTUAL sobre subcadenas literales. Un slug partido en dos (`"remit-kyc-" + "session"`) o
//      leído de una env lo esquiva entero. No mira semántica: mira una cadena.
//   2. NO mira los `*.test.*`. Los tests DEBEN poder escribir los slugs: los dobles de `/compose`
//      arman la respuesta del ejecutor con el slug adentro, y sin eso no habría cómo montar T-C5.
//   3. NO mira `scripts/`. Es la misma exclusión deliberada del exemplar, y acá pesa más: el smoke
//      de W4 apunta a los dos agentes POR SU NOMBRE, que es su trabajo (es una sonda operativa, no
//      el camino del dinero).
//   4. **CUENTA IMPORTADORES, NO USOS.** Un módulo que importe `resolveKycAgentBaseUrl` una vez y lo
//      llame veinte cuenta 1. Lo que se vigila es la superficie, no la frecuencia.
//   5. NO dice nada sobre si el slug es el CORRECTO. Que sea el que el catálogo publica lo mide el
//      smoke contra los servicios desplegados, no un `grep`.
//
// ⛔ CD-9 — ESTE GUARD NO PUEDE LEERSE A SÍ MISMO. El mecanismo es `path.resolve(full) !== SELF`,
// exactamente el del exemplar. Un `expect(self.includes("literal"))` NUNCA puede fallar, porque el
// literal está en la línea que lo busca; este repo ya pagó tres controles vacuos por ese error.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app"];
const SCAN_EXTS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations"]);

const SELF = path.resolve(ROOT, "src/composition/kyc-gateway-slug-count.static.test.ts");

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
  text: string;
}

/** Toda línea de producción que contenga la subcadena, sea código o prosa. */
function hitsDe(needle: string): Hit[] {
  const hits: Hit[] = [];
  for (const full of FILES) {
    readFileSync(full, "utf8")
      .split("\n")
      .forEach((linea, i) => {
        if (linea.includes(needle)) {
          hits.push({ rel: path.relative(ROOT, full), line: i + 1, text: linea.trim() });
        }
      });
  }
  return hits;
}

/**
 * Los módulos de producción que IMPORTAN el símbolo. Un `import` puede ocupar varias líneas, así que
 * el match es por ARCHIVO y no por línea; el `[^;]*` es lo que impide que el barrido salte de una
 * sentencia a la siguiente.
 */
function importadoresDe(simbolo: string): string[] {
  const re = new RegExp(`import[^;]*\\b${simbolo}\\b[^;]*from\\s*["'][^"']+["']`, "s");
  return FILES.filter((f) => re.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
    .sort();
}

/**
 * 🔻 G-4 — LOS CINCO IMPORTADORES DE `resolveKycAgentBaseUrl`, ESCRITOS LITERALES.
 *
 * 🔴 EL SDD DECÍA «EXACTAMENTE UN MÓDULO» PARA LOS DOS SÍMBOLOS, Y ESO ERA FALSO SOBRE `main` SIN
 * NINGÚN CAMBIO DE ESTA HU: `resolveKycAgentBaseUrl` ya tenía CUATRO importadores de producción.
 * Escribirlo como decía el SDD habría dejado este test rojo el día 1, y el reflejo entonces habría
 * sido "ajustar el número" en vez de leer por qué son cuatro. Son cuatro porque TRES de ellos son
 * los preflights del rollback D-1 —que viven FUERA del transporte y no se apagan con la bandera— y
 * el cuarto es el cliente directo, que sí compone la URL.
 *
 * 🔴 EL QUINTO ENTRÓ CON EL FIX-PACK DEL AR (BLQ-ALTO-1), Y ES UNA CATEGORÍA NUEVA — no un preflight
 * más ni un compositor de URL. Este test se puso ROJO al agregarlo, que es exactamente lo que tenía
 * que pasar, y la decisión se escribe acá en vez de "ajustar el número":
 *
 *   `src/infrastructure/kyc/gateway-kyc-client.ts` importa la fábrica para **verificar al ejecutor**.
 *   N3 comparaba el par `(slug, registry)`, y el AR midió que ese par lo publica cualquier caller
 *   autenticado del Coordinador (`POST /agents` es auth-only, el slug es PK global
 *   primero-que-llega). El único lado de la comparación que un publicador NO puede tocar es una env
 *   del deploy, y `KYC_AGENT_BASE_URL` ES esa env. ⛔ La alternativa —leer
 *   `process.env.KYC_AGENT_BASE_URL` a mano en el transporte— habría esquivado este candado sin
 *   ponerlo rojo, y habría roto la regla 2 de `agent-env.ts` (una sola fuente, garantizada por el
 *   brand nominal). Se prefirió el quinto importador VISIBLE a una segunda fuente invisible.
 *
 * ⚠️ Esto NO es un objetivo: es una FOTO con fecha (2026-08-26). Si mañana hay un sexto, este test
 * se pone rojo y hay que decidir si es legítimo, no editarlo de reflejo.
 */
const IMPORTADORES_DEL_HOST = [
  "app/api/kyc/decision/route.ts",
  "app/api/kyc/session/route.ts",
  "src/infrastructure/kyc/agent-kyc-client.ts",
  "src/infrastructure/kyc/gateway-kyc-client.ts",
  "src/infrastructure/payout/authority.ts",
] as const;

/** El compositor de la URL del agente. Ése sí es UNO, y tiene que seguir siéndolo. */
const IMPORTADORES_DE_LA_URL = ["src/infrastructure/kyc/agent-kyc-client.ts"] as const;

describe("el barrido no es vacuo (si esto falla, los tres de abajo no significan nada)", () => {
  it("ve archivos, encuentra la aguja cuando está, y no matchea lo que no debe", () => {
    // 50 es un PISO, no la medición: descarta el modo de falla "el walk devolvió (casi) nada", que
    // es como este guard se volvería decorativo sin ponerse rojo.
    expect(FILES.length).toBeGreaterThan(50);
    // Y que el matcher matchee — sobre cadenas SINTÉTICAS, nunca sobre este archivo: un control que
    // se lee a sí mismo no puede fallar.
    expect('const S = "remit-kyc-session";'.includes("remit-kyc-session")).toBe(true);
    // Y que NO matchee al vecino: los dos slugs nuevos y el viejo son tres cadenas distintas.
    expect("remit-kyc-validator".includes("remit-kyc-session")).toBe(false);
    expect("remit-kyc-session".includes("remit-kyc-decision")).toBe(false);
    // El detector de importadores discrimina un `import` de una mención cualquiera.
    const falso = ["// habla de kycAgentUrl", "const x = kycAgentUrl(base);"].join("\n");
    const verdadero = 'import { kycAgentUrl } from "./agent-env";';
    expect(/import[^;]*\bkycAgentUrl\b[^;]*from\s*["'][^"']+["']/s.test(falso)).toBe(false);
    expect(/import[^;]*\bkycAgentUrl\b[^;]*from\s*["'][^"']+["']/s.test(verdadero)).toBe(true);
  });
});

describe("T-KGS-1/2 — cada slug nuevo aparece EXACTAMENTE UNA VEZ en producción", () => {
  // 🧬 MUTANTE: escribir el slug en un segundo módulo (por ejemplo un default "por si el gateway no
  // contesta", o una constante "sólo para el preview") ⇒ 2 hits ⇒ ROJO. Es el mismo modo de falla
  // que WKH-332 cerró para los otros dos agentes: un slug disperso vuelve a atar este repo a un
  // proveedor concreto en N lugares que después nadie sincroniza.
  it.each([
    ["remit-kyc-session", "src/infrastructure/kyc/gateway-kyc-client.ts"],
    ["remit-kyc-decision", "src/infrastructure/kyc/gateway-kyc-client.ts"],
  ])("«%s» vive sólo en %s", (needle, esperado) => {
    const hits = hitsDe(needle);
    expect(
      hits.map((h) => `${h.rel}:${h.line}  «${h.text}»`),
      `el slug «${needle}» se dispersó. Es un PIN DE SEGURIDAD (N1 de AC-6), no una URL: el día que ` +
        "haya dos copias, una se actualiza y la otra autoriza desembolsos contra el agente que no es",
    ).toHaveLength(1);
    expect(hits[0]?.rel.split(path.sep).join("/")).toBe(esperado);
  });
});

describe("T-KGS-3 🔻 G-4 — la superficie del transporte DIRECTO no crece", () => {
  // 🧬 MUTANTE: importar `kycAgentUrl` desde `gateway-kyc-client.ts` ⇒ 2 importadores ⇒ ROJO. Ese
  // import sería el transporte nuevo componiendo la URL del agente por su cuenta, o sea el
  // acoplamiento que esta HU vino a cortar, entrando por la puerta de al lado.
  it("`kycAgentUrl` se importa desde EXACTAMENTE UN módulo de producción", () => {
    expect(importadoresDe("kycAgentUrl")).toEqual([...IMPORTADORES_DE_LA_URL]);
  });

  // 🧬 MUTANTE: agregar un 6º importador de `resolveKycAgentBaseUrl` ⇒ ROJO. 🧬 MUTANTE: borrar uno
  // de los tres preflights ⇒ también ROJO, y ése es el que importa: los preflights son el
  // interruptor de rollback D-1, y perderlos en silencio dejaría el KYC sin apagado. 🧬 MUTANTE:
  // borrar el quinto (el transporte por gateway) ⇒ ROJO, y ése se lleva puesto el guard de origen
  // de N3, o sea el cierre del BLQ-ALTO-1.
  it("`resolveKycAgentBaseUrl` se importa desde EXACTAMENTE los cinco módulos declarados", () => {
    expect(importadoresDe("resolveKycAgentBaseUrl")).toEqual([...IMPORTADORES_DEL_HOST]);
  });

  // 🔴 EL NÚMERO NO ES EL CRITERIO Y ENVEJECE SOLO. Acá decía «los CUATRO módulos declarados» y el
  // fix-pack del AR lo volvió falso en la misma HU: `IMPORTADORES_DEL_HOST` pasó a cinco entradas
  // (más la de `IMPORTADORES_DE_LA_URL`, que repite una de ellas ⇒ cinco rutas distintas, seis
  // vueltas del bucle). El título se ancla en el CRITERIO —«toda ruta declarada arriba»— que es lo
  // que el `for` recorre de verdad y no cambia cuando la lista crece.
  it("TODA ruta declarada en las dos listas EXISTE (una excepción a un archivo borrado no protege nada)", () => {
    for (const rel of [...IMPORTADORES_DEL_HOST, ...IMPORTADORES_DE_LA_URL]) {
      expect(existsSync(path.join(ROOT, rel)), `la lista apunta a un archivo inexistente: ${rel}`).toBe(
        true,
      );
    }
  });
});
