// WKH-373 — EL CANDADO DEL SITIO DEL CORTE, Y LA HUELLA.
//
// 🔴 QUÉ PROPIEDAD SOSTIENE, Y POR QUÉ NO SE PUEDE SOSTENER CON UNA LISTA A MANO. El diagnóstico de
// esta HU decía «SIETE sitios emiten `deeplink_tx_alterada`» y el árbol tiene **trece**: la lista
// estaba escrita a ojo y se había dejado afuera seis. Una lista copiada acá envejecería igual con la
// primera rama nueva. Por eso este archivo DERIVA los dos conjuntos del árbol y los cruza en las dos
// direcciones:
//   · todo sitio que emite la causa anota su código  ⇒ ningún corte llega a la pantalla sin decir cuál fue;
//   · todo código de la unión lo escribe exactamente un sitio ⇒ ⛔ ningún miembro sin llamador.
// La segunda mitad es la que impide el defecto que un `export` sin llamador produce: un artefacto que
// nadie invoca no es una defensa, y desde afuera es indistinguible de uno que funciona.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HUELLA_ILEGIBLE,
  anotarHuellaDeLaVuelta,
  anotarSitioDelCorte,
  huella,
  olvidarElSitioDelCorte,
  ultimaHuellaDeLaVuelta,
  ultimoSitioDelCorte,
} from "./bitacora-del-corte";

const RAIZ = path.resolve(process.cwd(), "src");

/** Todos los `.ts`/`.tsx` de producción de `src/`. ⛔ Sin los de test: un `it` que emitiera la causa
 *  no es un sitio de producción y no tiene por qué anotar nada. */
function fuentes(dir = RAIZ): string[] {
  return readdirSync(dir).flatMap((n) => {
    const abs = path.join(dir, n);
    if (statSync(abs).isDirectory()) return fuentes(abs);
    if (!/\.tsx?$/.test(n) || /\.test\.tsx?$/.test(n)) return [];
    return [abs];
  });
}

/** Las líneas que EMITEN la causa. ⛔ Se excluyen las que arrancan en comentario (la causa se nombra en
 *  muchos docblocks y ninguno emite nada) y las que la MENCIONAN sin devolverla: el `export const` que
 *  la declara, los dos `import`, el `| typeof …` del tipo y la clave del mapa de copy de `flow-vm.ts`.
 *  El discriminante es que la línea DEVUELVA o TIRE, que es lo único que hace que la persona la lea.
 *  ⚠️ ACÁ TUVE UN REGEX MÁS ESPECÍFICO —`causa: DEEPLINK_TX_ALTERADA` y dos formas más— y **se comía un
 *  sitio**: (`claveEnLaUrl`, `./conexion.ts:555`) la devuelve desde un TERNARIO, así que `causa:` no le
 *  queda pegado. Doce en vez de trece, y el `it` del piso fue el que lo cazó. */
const MENCION = /(DEEPLINK_TX_ALTERADA|"deeplink_tx_alterada")/;
const DEVUELVE = /\b(return|throw)\b/;

function sitiosQueEmiten(): { archivo: string; linea: number; texto: string }[] {
  const out: { archivo: string; linea: number; texto: string }[] = [];
  for (const abs of fuentes()) {
    readFileSync(abs, "utf8")
      .split("\n")
      .forEach((l, i) => {
        const codigo = l.replace(/^\s+/, "");
        if (codigo.startsWith("//") || codigo.startsWith("*") || codigo.startsWith("/*")) return;
        if (MENCION.test(l) && DEVUELVE.test(l)) out.push({ archivo: path.relative(RAIZ, abs), linea: i + 1, texto: l });
      });
  }
  return out;
}

/** Los miembros de la unión, LEÍDOS DEL TIPO y no copiados: es lo que hace que agregar uno sin sitio
 *  se vea. */
function miembrosDeLaUnion(): string[] {
  const fuente = readFileSync(path.join(RAIZ, "infrastructure/solana/deeplink/bitacora-del-corte.ts"), "utf8");
  const desde = fuente.indexOf("export type SitioDelCorte =");
  expect(desde, "no se encontró la declaración de `SitioDelCorte`").toBeGreaterThan(0);
  const hasta = fuente.indexOf(";", desde);
  return [...fuente.slice(desde, hasta).matchAll(/\|\s*"([^"]+)"/g)].map((m) => m[1] as string);
}

beforeEach(() => olvidarElSitioDelCorte());

describe("WKH-373: la bitácora del sitio del corte", () => {
  // 🔴 EL CANDADO NO PUEDE ESTAR VACÍO. Sin este piso, un regex que dejara de matchear daría cero
  // sitios y los dos `it` de abajo pasarían por CEGUERA en vez de por corrección — que es exactamente
  // la forma en que un guard deja de existir sin que nadie lo note. El piso es el conteo MEDIDO al
  // escribirlo (13), no un objetivo.
  it("T-373-SITIOS-0: hay sitios que vigilar (el candado no está vacío)", () => {
    expect(sitiosQueEmiten().length).toBeGreaterThanOrEqual(13);
    expect(miembrosDeLaUnion().length).toBeGreaterThanOrEqual(14);
  });

  // MUTANTE QUE MATA: borrarle el `anotarSitioDelCorte(...)` a cualquiera de los emisores ⇒ este `it`
  // lo nombra con su `archivo:línea`.
  it("T-373-SITIOS-1: TODO sitio que emite `deeplink_tx_alterada` anota su código", () => {
    const mudos = sitiosQueEmiten()
      .filter((s) => !s.texto.includes("anotarSitioDelCorte("))
      .map((s) => `${s.archivo}:${s.linea}`);
    expect(mudos, "estos sitios emiten la causa sin decir cuál fue: desde la pantalla son indistinguibles de los otros").toEqual([]);
  });

  // ⛔ LA OTRA DIRECCIÓN, y es la que caza un miembro sin llamador: un `SitioDelCorte` que nadie
  // escribe es un artefacto que nadie invoca, o sea una defensa que no existe.
  // MUTANTE QUE MATA: agregarle un `| "E99-inventado"` a la unión sin darle sitio ⇒ este `it` lo nombra.
  it("T-373-SITIOS-2: TODO código de la unión lo escribe exactamente un sitio del árbol", () => {
    const codigo = fuentes()
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const cuentas = miembrosDeLaUnion().map((m) => ({
      m,
      veces: [...codigo.matchAll(new RegExp(`anotarSitioDelCorte\\((?:[^)]*)"${m}"`, "g"))].length,
    }));
    expect(cuentas.filter((c) => c.veces !== 1), "hay códigos sin llamador, o escritos por más de un sitio").toEqual([]);
  });

  it("T-373-HUELLA: doce hex, determinística, y distinta para entradas distintas", () => {
    expect(huella("hola")).toMatch(/^[0-9a-f]{12}$/);
    expect(huella("hola")).toBe(huella("hola"));
    expect(huella("hola")).not.toBe(huella("holb"));
    // ⛔ Y NO ES EL CONTENIDO: la huella de un base64 largo no lo contiene ni de lejos.
    const largo = "AQABAmVzdG8tZXMtdW4tbWVuc2FqZS1sYXJnby1kZS12ZXJkYWQ=";
    expect(largo).not.toContain(huella(largo));
  });

  it("T-373-STORE: arranca en `null`, recuerda lo último y `olvidar…` limpia las DOS ranuras", () => {
    expect(ultimoSitioDelCorte()).toBeNull();
    expect(ultimaHuellaDeLaVuelta()).toBeNull();
    anotarSitioDelCorte("E5-deposito-bytes-distintos");
    anotarHuellaDeLaVuelta(HUELLA_ILEGIBLE);
    expect(ultimoSitioDelCorte()).toBe("E5-deposito-bytes-distintos");
    expect(ultimaHuellaDeLaVuelta()).toBe(HUELLA_ILEGIBLE);
    olvidarElSitioDelCorte();
    expect(ultimoSitioDelCorte()).toBeNull();
    expect(ultimaHuellaDeLaVuelta(), "`olvidar…` limpió una ranura y dejó la otra").toBeNull();
  });
});
