// G-1 … G-5 (WKH-233) — el CRITERIO DE CIERRE de esta HU, mecanizado:
//
//     «Cambiar de proveedor de KYC no debe exigir un solo cambio en Chaski.»
//
// Patrón y exemplar: `kyc-verification-id-guard.static.test.ts` (mismo `walk`, mismo
// `stripComments`, mismo estilo de cabecera). Es un `grep` corriendo en cada `npm test` en vez de un
// `grep` que alguien tiene que acordarse de correr.
//
// 🔴 EL CONTROL POSITIVO, MEDIDO ANTES DE EMPEZAR. Sobre `da0fb68` este mismo barrido daba **131**
// hits de `/didit/i` en CÓDIGO y **28** de `/DIDIT_[A-Z_]+/`, repartidos en 15 archivos. Un guard que
// llega a cero sin que nadie haya visto el número de partida no es evidencia de nada: podría estar
// barriendo la carpeta equivocada. El número de partida está acá para que el próximo pueda
// reproducirlo en el commit anterior a esta HU.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ⚠️ LO QUE ESTE CANDADO **NO** CIERRA, enunciado y no insinuado
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
//  1. ES TEXTUAL, NO SEMÁNTICO. Un `"di" + "dit"`, un nombre leído de una env, o —el caso que de
//     verdad importa— **un proveedor NUEVO con otro nombre** lo esquivan enteros. Lo que sí mide, y
//     es la mitad que vale, es **que el que había no vuelva**.
//     ⚠️ En particular `process.env["DIDIT_" + "ENV"]` ESQUIVA a G-2. Se declara acá porque no lo
//     cierra este archivo: lo cierran `tsc` (la env ya no existe en ningún tipo) y el code review.
//
//  2. NO MIRA LOS `*.test.*`. Los tests DEBEN poder nombrar al proveedor: los dobles describen contra
//     qué se midieron y los fixtures reproducen su payload. Al 2026-08-19 son **41** los archivos de
//     test que lo mencionan (`command grep -rlI "didit" src/ app/ --include=*.test.ts
//     --include=*.test.tsx | wc -l`) — y **ese número es una foto que no verifica nadie**: lo que
//     este archivo verifica es el CERO en producción, no el conteo en los tests.
//
//  3. NO MIRA `doc/`, `.env.example`, `supabase/` NI `contracts/`. `.env.example` **tiene que** poder
//     nombrarlo: es donde se documenta que esas envs se fueron y qué las reemplaza.
//
//  4. NO MIRA LA PROSA, Y ES DELIBERADO. Al cierre de la HU quedan **146** hits en comentarios.
//     Barrerlos habría arrastrado archivos con citas por número desde afuera y **roto citas ajenas en
//     silencio**, que es un daño peor que el que evitaría. Se declara para que nadie lea el verde de
//     G-1 como *"el repo no menciona al proveedor"*. Lo que G-1 afirma es más chico y más útil:
//     **ninguna línea de CÓDIGO lo nombra**.
//
//  5. NO MIDE EL VALOR DE NADA. Que `KYC_AGENT_BASE_URL` apunte al agente correcto, o que el
//     `.eq("owner_address", …)` lleve el **valor** correcto, **no lo verifica este archivo**. Eso es
//     de los tests de comportamiento (`supabase-kyc-session-tokens.test.ts`, `authority.test.ts`) y
//     del code review. **G-5 verifica PRESENCIA y UBICACIÓN, no valor.**
//
//  6. EL DESPOJADO DE COMENTARIOS ES HEURÍSTICO, NO UN PARSER — el mismo del exemplar, con el mismo
//     sesgo escrito en su header: **prefiere un falso positivo antes que un falso verde**.
//
//  7. NO AFIRMA QUE EL KYC VÍA AGENTE FUNCIONE. Este archivo mide cañería, no comportamiento contra
//     el proveedor vivo. Un verde acá **no es evidencia** de que una verificación real termine bien.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app", "scripts"];
const SCAN_EXTS = new Set([".ts", ".tsx"]);
/** ⚠️ `test-support/` NO SE SALTEA, a diferencia del exemplar: `src/test-support/fakes.ts` tenía 1
 *  hit de código y **no es un `*.test.*`** para el regex de abajo, así que saltearlo habría sido
 *  pasar por debajo de la métrica en vez de cumplirla. */
const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations"]);

const SELF = path.resolve(ROOT, "src/composition/kyc-provider-residue.static.test.ts");

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

/** Deja el texto con los comentarios en blanco y **conservando los saltos de línea**, para que el
 *  número de línea del hit siga siendo el del archivo. Ver el agujero #6 del encabezado. */
function stripComments(source: string): string {
  const sinBloques = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return sinBloques
    .split("\n")
    .map((line) => {
      // Primer `//` que NO venga pegado a `:` (o sea, que no sea el de `https://`).
      const i = line.search(/(^|[^:])\/\//);
      if (i === -1) return line;
      return line.slice(0, line.indexOf("//", i));
    })
    .join("\n");
}

interface Hit {
  rel: string;
  line: number;
  text: string;
}

/** Cuenta OCURRENCIAS (no líneas) del regex en el código despojado, por archivo. */
function contarPorArchivo(re: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const full of FILES) {
    const n = (stripComments(readFileSync(full, "utf8")).match(re) ?? []).length;
    if (n > 0) out.set(path.relative(ROOT, full), n);
  }
  return out;
}

/** Líneas del código despojado que contienen la aguja literal. */
function hitsDe(needle: string): Hit[] {
  const hits: Hit[] = [];
  for (const full of FILES) {
    stripComments(readFileSync(full, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        if (line.includes(needle)) {
          hits.push({ rel: path.relative(ROOT, full), line: i + 1, text: line.trim() });
        }
      });
  }
  return hits;
}

/**
 * 🔴 LAS ÚNICAS EXCEPCIONES DE G-1, POR ARCHIVO **Y CON EL CONTEO PINNEADO**.
 *
 * Que el conteo esté pinneado —y no sólo el archivo— es lo que impide que la excepción se convierta
 * en un permiso de directorio: agregar un uso NUEVO del nombre del proveedor dentro de uno de estos
 * archivos pone el guard en rojo igual.
 *
 * · Las TRES superficies del simulador (`app/kyc-simulado/**`, `app/api/mock-didit/**`) se conservan
 *   a propósito: son la dependencia del recorrido manual de punta a punta del repo de los agentes, y
 *   borrarlas es una HU aparte (companion declarado). Su gate las apaga por default.
 *
 * · 🔴 Y LA CUARTA, QUE EL PLAN DE LA HU NO TENÍA Y HAY QUE DECIRLO: `src/infrastructure/mock-surface.ts`
 *   conserva 1 hit, que es su **nombre exportado** `mockDiditSurfaceEnabled`. NO se puede renombrar:
 *   las cuatro aserciones TEXTUALES del candado `app/kyc-simulado/kyc-simulado-gate.test.ts` comparan
 *   el cuerpo de las tres superficies contra ese identificador, así que renombrarlo apagaría ese
 *   candado **en silencio** — el modo de falla exacto que ese candado existe para cazar. El nombre
 *   sigue siendo verdadero (el simulador que hay imita a ese proveedor). El día que las tres
 *   superficies se borren, este renglón y ese nombre se van juntos.
 *
 * ⚠️ LOS NÚMEROS SON UNA MEDICIÓN, NO UN DESEO: salen de correr este mismo barrido sobre el árbol al
 * cierre de la HU. Si cambian, alguien tocó uno de estos cuatro archivos y hay que ir a mirar QUÉ.
 */
const PERMITIDOS_G1: ReadonlyMap<string, number> = new Map([
  ["app/kyc-simulado/page.tsx", 5],
  ["app/api/mock-didit/v3/session/route.ts", 3],
  [path.join("app", "api", "mock-didit", "v3", "session", "[sessionId]", "decision", "route.ts"), 3],
  ["src/infrastructure/mock-surface.ts", 1],
]);

/**
 * G-3 — dónde puede aparecer `identityMatches` en producción.
 *
 * 🔴 SON DOS ARCHIVOS, NO CUATRO, Y ES A PROPÓSITO MÁS ESTRICTO QUE EL PLAN. El plan de la HU
 * permitía además `src/infrastructure/payout/authority.ts` y `app/api/kyc/decision/route.ts`. Medido
 * al cierre: **ninguno de los dos lo lee**, y no leerlo es justamente DT-5' —el gate es
 * `payoutAllowed === true` y NADA MÁS, porque recomponer el criterio con `approved && identityMatches`
 * sería re-implementar el juicio de KYC—. ⇒ permitirlo ahí habría dejado abierta la puerta exacta que
 * la HU cierra. Los dos que quedan son el borde: el TIPO y el módulo que lo estrecha.
 */
const PERMITIDOS_IDENTITY_MATCHES: ReadonlySet<string> = new Set([
  "src/infrastructure/kyc/agent-contract.ts",
  "src/infrastructure/kyc/agent-kyc-client.ts",
]);

/** G-5 — los DOS únicos sitios de la lectura SIN filtro de dueño. Ver el docblock del store. */
const PERMITIDOS_LECTURA_SIN_DUENO: ReadonlySet<string> = new Set([
  "src/infrastructure/persistence/supabase-kyc-session-tokens.ts",
  "app/api/kyc/decision/route.ts",
]);

// ══════════════════════════════════════════════════════════════════════════════════════════════════

describe("G-4 — el barrido no es vacuo (si esto falla, los otros cuatro no significan nada)", () => {
  it("ve archivos, y el despojado de comentarios NO se come el código", () => {
    // 50 es un PISO, no la medición: descarta el modo de falla "el walk devolvió (casi) nada", que es
    // como este guard se volvería decorativo sin ponerse rojo. Al cierre de la HU son bastantes más.
    // 🧬 MUTANTE M-4b: hacer que `walk()` devuelva `[]` ⇒ ROJO acá, y no en los otros cuatro.
    expect(FILES.length).toBeGreaterThan(50);
    // Las cuatro calibraciones del exemplar. Si se invirtieran, el guard daría verde con el proveedor
    // reintroducido y rojo con un comentario que lo nombra.
    expect(stripComments("// habla de didit")).not.toMatch(/didit/i);
    expect(stripComments('const x = "didit";')).toMatch(/didit/i);
    expect(stripComments("/* bloque\n con didit\n */")).not.toMatch(/didit/i);
    expect(stripComments('fetch("https://x.test/didit");')).toMatch(/didit/i);
    // Los saltos de línea se conservan ⇒ los números de línea del hit son los del archivo.
    expect(stripComments("/* a\nb */\nconst didit = 1;").split("\n")).toHaveLength(3);
  });

  it("la lista de excepciones de G-1 está pinneada en EXACTAMENTE cuatro archivos, con su conteo", () => {
    // 🧬 MUTANTE M-4: agregar `src/presentation/flow.tsx` (o cualquier otro) a la excepción ⇒ ROJO.
    // La excepción es una lista corta y cerrada; que crezca es un hallazgo, no un ajuste.
    expect([...PERMITIDOS_G1.keys()].sort()).toEqual(
      [
        "app/api/mock-didit/v3/session/route.ts",
        path.join("app", "api", "mock-didit", "v3", "session", "[sessionId]", "decision", "route.ts"),
        "app/kyc-simulado/page.tsx",
        "src/infrastructure/mock-surface.ts",
      ].sort(),
    );
    // Y que los cuatro EXISTAN: una excepción a un archivo borrado es una excepción que ya no protege
    // nada y que nadie va a notar.
    for (const rel of PERMITIDOS_G1.keys()) {
      expect(existsSync(path.join(ROOT, rel)), `la excepción apunta a un archivo inexistente: ${rel}`).toBe(true);
    }
  });
});

describe("G-1 — el nombre del proveedor no aparece en NINGUNA línea de código de producción", () => {
  it("cero hits fuera de las cuatro excepciones declaradas", () => {
    const porArchivo = contarPorArchivo(/didit/gi);
    const fuera = [...porArchivo.entries()].filter(([rel]) => !PERMITIDOS_G1.has(rel));
    // 🧬 MUTANTE M-1: `const BASE = "https://verification.didit.me"` en `agent-kyc-client.ts` ⇒ ROJO.
    expect(
      fuera.map(([rel, n]) => `${rel} (${n})`),
      "volvió el nombre del proveedor de KYC al código de producción. El criterio de cierre de esta " +
        "HU es que cambiar de proveedor no exija un solo cambio en Chaski: cada aparición acá es un " +
        "sitio que habría que editar el día que se cambie",
    ).toEqual([]);
  });

  it("dentro de las excepciones, el conteo es EXACTAMENTE el pinneado (la excepción no es un directorio)", () => {
    const porArchivo = contarPorArchivo(/didit/gi);
    const real = new Map([...porArchivo.entries()].filter(([rel]) => PERMITIDOS_G1.has(rel)));
    // 🧬 MUTANTE M-1b: agregar un `didit` de CÓDIGO en `app/kyc-simulado/page.tsx` más allá del gate
    // ⇒ el conteo sube ⇒ ROJO. La excepción es por ARCHIVO **y CONTEO**, nunca por directorio.
    expect(Object.fromEntries([...real].sort()), "el conteo dentro de una excepción cambió").toEqual(
      Object.fromEntries([...PERMITIDOS_G1].sort()),
    );
  });
});

describe("G-2 — ninguna env del proveedor sobrevive en el código, sin excepciones", () => {
  it("cero ocurrencias de /DIDIT_[A-Z_]+/ en código despojado", () => {
    const porArchivo = contarPorArchivo(/DIDIT_[A-Z_]+/g);
    // 🧬 MUTANTE M-2: reponer `if (process.env.DIDIT_API_KEY)` en `app/api/payout/validate/route.ts`
    // ⇒ ROJO. ⚠️ M-2b (`process.env["DIDIT_" + "ENV"]`) lo ESQUIVA: es textual. Declarado en el
    // agujero #1 del encabezado; lo cierran `tsc` y el CR, no este archivo.
    expect(
      [...porArchivo.entries()].map(([rel, n]) => `${rel} (${n})`),
      "volvió una env del proveedor de KYC al código. Esta HU las eliminó todas: la credencial del " +
        "proveedor vive en el agente, y setearlas acá no puede tener ningún efecto",
    ).toEqual([]);
  });
});

describe("G-3 — el juicio LOCAL sobre si una verificación es real está borrado (CD-11/D-3)", () => {
  it.each([["REAL_KYC_PROVENANCES"], ["KYC_PROVENANCE_LIVE"], ["KYC_PROVENANCE_MOCK"], ["isKycDemo"]])(
    "cero ocurrencias de `%s` en código de producción",
    (needle) => {
      // 🧬 MUTANTE M-3: reponer `const REAL_KYC_PROVENANCES = new Set(["didit"])` en `flow-vm.ts`
      // ⇒ ROJO por DOS flancos (éste y G-1). Una allow-list local con el nombre del proveedor adentro
      // es, literalmente, lo primero que habría que cambiar al cambiar de proveedor.
      expect(
        hitsDe(needle).map((h) => `${h.rel}:${h.line}  «${h.text}»`),
        `volvió el juicio local sobre proveniencias (\`${needle}\`). Quien decide si una verificación ` +
          "es real es el AGENTE, vía `payoutAllowed`; Chaski pregunta y adopta",
      ).toEqual([]);
    },
  );

  it("`identityMatches` sólo vive en el BORDE (el tipo y el módulo que lo estrecha)", () => {
    const fuera = hitsDe("identityMatches").filter((h) => !PERMITIDOS_IDENTITY_MATCHES.has(h.rel));
    // 🧬 MUTANTE M-3b: leerlo desde `flow.tsx` ⇒ ROJO. 🧬 Y el que importa: leerlo desde
    // `authority.ts` para recomponer `approved && identityMatches` ⇒ ROJO, porque eso es
    // re-implementar el juicio de KYC (DT-5').
    // ⚠️ LO QUE ESTE `it` NO CAZA: un `payoutAllowed === true || esDemo()` dentro de `authority.ts`.
    // Ese mutante NO tiene nombre que grepear. Lo mata T-AUTH-2, no este archivo.
    expect(
      fuera.map((h) => `${h.rel}:${h.line}  «${h.text}»`),
      "un consumidor nuevo está leyendo `identityMatches` por su cuenta. Ese campo es del BORDE: el " +
        "juicio que hace falta ya viene hecho en `payoutAllowed`",
    ).toEqual([]);
  });

  it("control positivo: las agujas de G-3 SÍ aparecen cuando aparecen", () => {
    // Sin esto, un `hitsDe` roto (o un `FILES` vacío) daría cero para todo y los cinco `it` de arriba
    // serían vacuos. Se prueba sobre una cadena, no sobre el árbol: un test que se lee a sí mismo no
    // puede fallar nunca, y este repo ya tuvo tres controles vacuos por ese error.
    expect(stripComments('const x = isKycDemo(p);').includes("isKycDemo")).toBe(true);
    expect(stripComments('// isKycDemo(p)').includes("isKycDemo")).toBe(false);
  });
});

describe("G-5 — CD-19: la lectura SIN filtro de dueño no entra al money-path", () => {
  it("`readForVerifiedSession` vive SÓLO en el store y en la route de PANTALLA", () => {
    const fuera = hitsDe("readForVerifiedSession").filter(
      (h) => !PERMITIDOS_LECTURA_SIN_DUENO.has(h.rel),
    );
    // 🧬 MUTANTE M-5: usar `readForVerifiedSession` en `authority.ts` en vez de `getForOwner` ⇒ ROJO.
    // Es la lectura SIN filtro de dueño entrando al momento del dinero: un IDOR sobre la credencial
    // que autoriza el desembolso. En la route de pantalla es legítima porque el HMAC corre ANTES;
    // en el money-path no hay ningún HMAC delante.
    expect(
      fuera.map((h) => `${h.rel}:${h.line}  «${h.text}»`),
      "la lectura sin filtro de dueño apareció fuera de sus dos sitios. Si es el money-path, es un IDOR",
    ).toEqual([]);
  });

  it("CERO ocurrencias bajo `src/infrastructure/payout/**`, dicho aparte y a propósito", () => {
    // El `it` de arriba ya lo cubre, y éste lo dice CON EL DIRECTORIO ADENTRO: el día que alguien
    // agregue un tercer sitio legítimo a `PERMITIDOS_LECTURA_SIN_DUENO`, este `it` sigue vigilando el
    // único lugar donde la lectura sin dueño NUNCA puede estar.
    const enPayout = hitsDe("readForVerifiedSession").filter((h) =>
      h.rel.startsWith(path.join("src", "infrastructure", "payout")),
    );
    expect(enPayout.map((h) => `${h.rel}:${h.line}`)).toEqual([]);
  });

  it("✅ calibración: el money-path SÍ usa la lectura owner-scoped (no es que no use ninguna)", () => {
    // Un guard que sólo dijera "no uses la insegura" daría verde también si el money-path no leyera
    // NADA — o sea si alguien borrara el chequeo entero. Esta mitad es la que lo distingue.
    const conFiltro = hitsDe("getForOwner").map((h) => h.rel);
    expect(conFiltro).toContain(path.join("src", "infrastructure", "payout", "authority.ts"));
  });
});
