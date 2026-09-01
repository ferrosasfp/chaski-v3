// Tests — canario ESTÁTICO de CD-26/CD-27: el `kycVerificationId` del CLIENTE no vuelve al código de
// producción (WKH-333 · AR/MNR-2). Patrón: `prepared-claims-guard.static.test.ts`.
//
// 🔴 QUÉ AGUJERO CIERRA, MEDIDO POR EL AR. CD-27 dice que la barrera es "de compilación, no una
// convención". No lo era: el AR reintrodujo el campo en `SolanaPayoutPrepareGateway.prepare` **y** en
// la firma inline de `http-solana-prepare-gateway.ts` **y** en el body que sale a la route, y `tsc`
// terminó en exit 0 con la suite entera verde. La causa es que el gateway RE-DECLARA la forma de su
// input en línea en vez de referenciar el tipo del puerto, y TypeScript acepta el campo extra por
// bivarianza de métodos. `ports.ts` ya declaraba que el cierre real eran DOS comandos, `tsc` **y** un
// `grep` — pero el grep dependía de que un humano se acordara de correrlo. Esto es ese grep, corriendo
// en cada `npm test`.
//
// ⚠️ LO QUE ESTE CANDADO **NO** CIERRA, enunciado y no insinuado:
//   1. Es TEXTUAL sobre el identificador EXACTO `kycVerificationId`. Un `kyc_verification_id`, un
//      `verificationId` a secas, un `kycVerId` o cualquier reescritura lo esquiva. No mira semántica:
//      mira una palabra.
//   2. NO mira los `*.test.*` ni `test-support/`: los tests DEBEN poder escribir el campo, porque el
//      caso que hay que probar es justamente que la route lo ignora (T-PR-8, T-PR-11).
//   3. Sólo barre `.ts`/`.tsx` bajo `SCAN_DIRS`. Quedan afuera `supabase/`, `contracts/` y `doc/`.
//   4. 🔴 EL DESPOJADO DE COMENTARIOS ES HEURÍSTICO, no un parser. Corta en `/* */` y en `//`, y para
//      no romperse con las URLs (`https://…`) ignora los `//` precedidos por `:`. Consecuencia real:
//      una línea que tuviera una URL Y una ocurrencia del identificador DESPUÉS de un comentario en
//      la misma línea podría contarse de más, no de menos. Sesgo elegido a propósito: este guard
//      prefiere un falso positivo (que alguien tiene que ir a mirar) antes que un falso verde.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app", "scripts"];
const SCAN_EXTS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations", "test-support"]);
const NEEDLE = "kycVerificationId";

const SELF = path.resolve(ROOT, "src/composition/kyc-verification-id-guard.static.test.ts");

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
 *  número de línea del hit siga siendo el del archivo. Ver el agujero #4 del encabezado. */
function stripComments(source: string): string {
  const sinBloques = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return sinBloques
    .split("\n")
    .map((line) => {
      // Primer `//` que NO venga pegado a `:` (o sea, que no sea el de `https://`).
      const i = line.search(/(^|[^:])\/\//);
      if (i === -1) return line;
      const cut = line.indexOf("//", i);
      return line.slice(0, cut);
    })
    .join("\n");
}

interface Hit {
  rel: string;
  line: number;
  text: string;
}

function findHits(): Hit[] {
  const hits: Hit[] = [];
  for (const full of FILES) {
    const code = stripComments(readFileSync(full, "utf8"));
    code.split("\n").forEach((line, i) => {
      if (line.includes(NEEDLE)) {
        hits.push({ rel: path.relative(ROOT, full), line: i + 1, text: line.trim() });
      }
    });
  }
  return hits;
}

/**
 * Los ÚNICOS dos sitios de producción donde el identificador puede aparecer en CÓDIGO, los dos en la
 * misma route y los dos existiendo para NEUTRALIZARLO:
 *   · el `void (…body.kycVerificationId…)` que lo lee para descartarlo (deja escrito que no se usa);
 *   · el `{ ...alAgente, kycVerificationId: rowVerificationId }` que lo PISA con el de la fila.
 * Se anclan por archivo, no por número de línea: el archivo es la unidad estable.
 *
 * ⚠️ EL OBJETO QUE SE SPREADEA SE LLAMA `alAgente` Y NO `body` DESDE AR/BLQ-BAJO-2. Es el body MENOS
 * las tres credenciales de identidad (`sessionToken`, `popChallenge`, `popSignature`), que dejaron de
 * viajar al agente. El guard se re-apuntó al nombre nuevo en vez de aflojarse a un `.includes("...")`:
 * la propiedad que vigila es de ORDEN dentro del spread, y para medir un orden hay que saber qué dos
 * cosas se ordenan. Efecto colateral buscado: revertir aquel arreglo también pone ESTE guard en rojo.
 * ⛔ Lo que este guard sigue SIN mirar es qué campos lleva `alAgente`: eso lo mide `T-372-W3-21`, por
 * nombre, en `../../app/api/payout/prepare/route.test.ts`, sobre el cuerpo que efectivamente viajó.
 */
const PERMITIDOS = new Set(["app/api/payout/prepare/route.ts"]);

describe("CD-26/CD-27 — barrido estático del `kycVerificationId` en código de producción", () => {
  it("el barrido no es vacuo: ve archivos, y el despojado de comentarios NO se come el código", () => {
    // 50 es un PISO, no la medición: descarta el modo de falla "el walk devolvió (casi) nada", que es
    // como este guard se volvería decorativo sin ponerse rojo.
    expect(FILES.length).toBeGreaterThan(50);
    // El despojado tiene que borrar la mención en prosa y CONSERVAR la del código. Si se invirtiera,
    // el guard daría verde con el campo reintroducido y rojo con un comentario que lo nombra.
    expect(stripComments("// habla del kycVerificationId del cliente")).not.toContain(NEEDLE);
    expect(stripComments("const x = body.kycVerificationId;")).toContain(NEEDLE);
    expect(stripComments("/* bloque\n con kycVerificationId\n */")).not.toContain(NEEDLE);
    // Y una URL en la línea no puede cortar el código que viene después (agujero #4).
    expect(stripComments('fetch("https://x.test/kycVerificationId");')).toContain(NEEDLE);
    // Los saltos de línea se conservan ⇒ los números de línea del hit son los del archivo.
    expect(stripComments("/* a\nb */\nconst kycVerificationId = 1;").split("\n")).toHaveLength(3);
  });

  it("CD-27: ningún archivo de producción fuera de `prepare/route.ts` menciona el campo en CÓDIGO", () => {
    const fuera = findHits().filter((h) => !PERMITIDOS.has(h.rel));
    expect(
      fuera.map((h) => `${h.rel}:${h.line}  «${h.text}»`),
      "el `kycVerificationId` del cliente volvió a un puerto, a una firma inline o a un body de " +
        "producción. `tsc` NO lo caza (bivarianza de métodos: una clase puede declarar el campo extra " +
        "en su parámetro y compilar), así que este barrido es el único candado mecánico de CD-27",
    ).toEqual([]);
  });

  it("CD-26: en `prepare/route.ts` el campo aparece SÓLO para descartarlo y para pisarlo", () => {
    const dentro = findHits().filter((h) => PERMITIDOS.has(h.rel));
    // No es un número mágico: son exactamente los dos usos que la route documenta. Si aparece un
    // tercero, alguien agregó una lectura nueva del valor del cliente y hay que ir a mirarla.
    expect(
      dentro.map((h) => h.text),
      "apareció un uso NUEVO del `kycVerificationId` del cliente en la route del money-path: los " +
        "únicos dos permitidos son el `void` que lo descarta y el spread que lo pisa con el de la fila",
    ).toHaveLength(2);
    const [descarte, pisada] = dentro.map((h) => h.text) as [string, string];
    expect(descarte.startsWith("void ("), `el primer uso dejó de ser el descarte: «${descarte}»`).toBe(
      true,
    );
    expect(
      pisada.includes("...alAgente") && pisada.includes("rowVerificationId"),
      `el segundo uso dejó de ser la pisada con el id de la fila: «${pisada}»`,
    ).toBe(true);
    // 🔴 EL ORDEN DENTRO DEL SPREAD ES EL GUARD. `{ ...alAgente, kycVerificationId: … }` pisa; al
    // revés (`{ kycVerificationId: …, ...alAgente }`) el valor del cliente GANA y el agente recibe el
    // suyo.
    expect(
      pisada.indexOf("...alAgente"),
      "el spread quedó DESPUÉS del campo: el valor del cliente pisa al de la fila y el agente " +
        "autoriza con la verificación que propuso quien llama (CD-26)",
    ).toBeLessThan(pisada.indexOf(NEEDLE));
  });
});
