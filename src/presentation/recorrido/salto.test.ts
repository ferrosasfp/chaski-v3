// WKH-374 · W1.0 — LA PREMISA DE LA OLA, FALSABLE, Y LOS DOS CANDADOS DEL ATERRIZAJE
//
// 🔴 `T-374-W1-0` ES LA PUERTA DE LA OLA. Afirma que el universo de marcas de vuelta se DERIVA de
// producción y que ninguna marca queda sin aterrizaje. Si se pone roja, la tabla de aterrizaje de
// `./salto.ts` sería una lista escrita a mano que envejece sola, y eso se resuelve en diseño y no
// ajustando un fixture hasta el verde.
//
// ⛔ NINGÚN LITERAL DE MARCA SE ESCRIBE EN ESTE ARCHIVO (`CD-W1-7`). Todos entran importados de
// producción, y eso tiene una consecuencia que conviene decir en voz alta: la CALIBRACIÓN de abajo
// no puede transcribir «los seis de hoy» sin violar la misma regla que el archivo mide. Lo que sí
// puede, y hace, es exigir que la tupla tenga al menos seis entradas, todas distintas y no vacías —
// con eso, un import roto (`[]`) o colapsado (todas iguales) se pone rojo, que es el modo de falla
// por el que la calibración existe.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  MARCA,
  MARCAS_DE_VUELTA,
  enlaceDeVuelta,
} from "../../infrastructure/solana/deeplink/sesion";
import { PARAM_KYC, VALOR_VUELTA_KYC, urlDeVueltaDeKyc } from "../splash-puerta";
import { PARAM_SALIDA, VALOR_SALIDA } from "../salida-al-navegador-de-la-billetera";
import { PASO_DE_ENTRADA, esPasoDelRecorrido } from "./pasos";
import {
  MARCA_DEL_VERIFICADOR,
  MARCA_DE_LA_SALIDA,
  SIN_ATERRIZAJE,
  aterrizajeDe,
  marcaDeLaUrl,
  vueltaDeUnSalto,
} from "./salto";

const ROOT = process.cwd();

/** Las tres marcas del universo, en el vocabulario único de `aterrizajeDe`. ⛔ Ninguna se escribe:
 *  las seis del enlace salen de la tupla de producción y las otras dos de sus símbolos. */
const UNIVERSO: readonly string[] = [
  ...MARCAS_DE_VUELTA,
  MARCA_DEL_VERIFICADOR,
  MARCA_DE_LA_SALIDA,
];

describe("WKH-374/W1.0 · la premisa: el universo de marcas de vuelta es enumerable desde producción", () => {
  it("T-374-W1-0: el universo de marcas de vuelta se DERIVA de producción, y ninguna queda sin aterrizaje", () => {
    // ── (1) CALIBRACIÓN ──────────────────────────────────────────────────────────────────────────
    // Sin esto, un import roto dejaría `MARCAS_DE_VUELTA` en `[]`, el `for` de abajo no daría ni una
    // vuelta y las aserciones (2) y (3) pasarían POR VACÍO — el modo de falla más barato que tiene
    // un guard que recorre un conjunto.
    expect(
      MARCAS_DE_VUELTA.length,
      "la tupla de marcas de producción vino vacía o encogió: todo lo de abajo pasaría por vacío",
    ).toBeGreaterThanOrEqual(6);
    expect(
      new Set(MARCAS_DE_VUELTA).size,
      "hay marcas repetidas en la tupla: el recorrido de abajo mediría menos casos de los que dice",
    ).toBe(MARCAS_DE_VUELTA.length);
    for (const m of MARCAS_DE_VUELTA) {
      expect(typeof m, "una marca que no es cadena no puede viajar en una URL").toBe("string");
      expect(m.length, "una marca vacía haría que el parámetro de vuelta no distinga nada").toBeGreaterThan(0);
    }
    // Y las dos marcas compuestas tienen que ser distintas entre sí y de las seis, o el `switch` de
    // `aterrizajeDe` estaría resolviendo dos cosas por el mismo camino sin que se note.
    expect(
      new Set(UNIVERSO).size,
      "dos marcas del universo colapsaron en el mismo token: `aterrizajeDe` no las podría distinguir",
    ).toBe(UNIVERSO.length);

    // ── (2) TODA MARCA ATERRIZA EN UN PASO QUE ESTÁ EN LA TABLA ──────────────────────────────────
    // 🔴 ES LA ASERCIÓN QUE MATA A `MW-0`: una séptima marca agregada a la tupla de producción cae acá,
    // porque `aterrizajeDe` le contesta el tercer valor y el tercer valor no es un paso de la tabla.
    const sinAterrizaje: string[] = [];
    for (const marca of UNIVERSO) {
      const a = aterrizajeDe(marca);
      if (a === SIN_ATERRIZAJE || !esPasoDelRecorrido(a)) sinAterrizaje.push(marca);
    }
    expect(
      sinAterrizaje,
      "hay marcas de vuelta SIN aterrizaje en la tabla de `salto.ts`: la vuelta de esas marcas no sabría dónde dejar a la persona",
    ).toEqual([]);

    // ── (3) NINGUNA ATERRIZA EN LA PANTALLA DE ENTRADA (AC-7) ────────────────────────────────────
    // Comparada POR VALOR contra el `id` del paso, no por el nombre de una variable.
    const enLaEntrada = UNIVERSO.filter((m) => aterrizajeDe(m) === PASO_DE_ENTRADA);
    expect(
      enLaEntrada,
      "una marca de vuelta aterriza en la pantalla de entrada, que es exactamente lo que AC-7 prohíbe con la palabra NUNCA",
    ).toEqual([]);

    // ── (4) CONTROL NEGATIVO: EL TERCER VALOR, ⛔ NO UN PASO POR DEFECTO ──────────────────────────
    // ⚠️ Un booleano acá perdería el tercer valor, que es la lección más cara de esta HU: «no sé qué
    // es esta marca» ⛔ no es «aterriza en el principio».
    const sintetica = "marca-que-nadie-escribio";
    expect(
      UNIVERSO,
      "la marca sintética se volvió real: el control negativo dejaría de serlo",
    ).not.toContain(sintetica);
    expect(
      aterrizajeDe(sintetica),
      "una marca desconocida tiene que contestar el TERCER VALOR, no un paso por defecto",
    ).toBe(SIN_ATERRIZAJE);
    expect(
      esPasoDelRecorrido(String(aterrizajeDe(sintetica))),
      "el tercer valor se está colando como si fuera un paso de la tabla",
    ).toBe(false);
  });

  // ── LA VUELTA COMPLETA, DE LA URL AL PASO ──────────────────────────────────────────────────────
  //
  // MUTANTE QUE MATA (`MW-3`): en `./salto.ts`, en `vueltaDeUnSalto`, hacer que la rama con
  // `codigoDeError` devuelva la pantalla de entrada en vez del mismo paso.
  // ⛔ FALSO KILLED A EVITAR: recorrer sólo el camino feliz. `AC-8` es la mitad que importa, y con el
  // mutante puesto el camino feliz sigue verde. Por eso el `it` recorre LAS DOS RAMAS sobre el mismo
  // conjunto de URLs, y compara el paso de una contra el de la otra.
  it("T-374-W1-3: ninguna marca aterriza en `entrar`, y el camino de ERROR aterriza en el MISMO paso que el feliz", () => {
    const origen = "https://chaski.test/";
    // Las URLs se ARMAN con los constructores de producción o con los símbolos de producción, ⛔ nunca
    // escribiendo un literal de marca a mano (`CD-W1-7`).
    //
    // ⚠️ LA DE LA SALIDA SE COMPONE Y ⛔ NO SALE DE `urlDeSalidaAlNavegadorDeLaBilletera`, y es una
    // corrección medida: esa función devuelve el enlace universal de la billetera, con NUESTRA url
    // codificada adentro del path. La marca que la app recibe al aterrizar es la de la url INTERNA, que
    // es la que se arma acá con los mismos dos símbolos que ese módulo exporta.
    const conMarcaDeSalida = new URL(origen);
    conMarcaDeSalida.searchParams.set(PARAM_SALIDA, VALOR_SALIDA);
    const urls: string[] = [
      ...MARCAS_DE_VUELTA.map((m) => enlaceDeVuelta(origen, m)),
      urlDeVueltaDeKyc("https://chaski.test"),
      conMarcaDeSalida.toString(),
    ];
    expect(urls.length, "sin URLs, las dos ramas de abajo pasarían por vacío").toBe(
      MARCAS_DE_VUELTA.length + 2,
    );

    const enLaEntrada: string[] = [];
    const divergentes: string[] = [];
    let aterrizajes = 0;
    for (const href of urls) {
      // La lectura de la marca y el aterrizaje son dos pasos distintos, y los dos tienen que dar: una
      // URL que no entrega marca dejaría al `for` sin nada que comparar.
      expect(marcaDeLaUrl(href), `esta URL no entrega ninguna marca legible: ${href}`).not.toBeNull();
      const feliz = vueltaDeUnSalto({ href });
      const conError = vueltaDeUnSalto({ href, codigoDeError: "wallet_rejected" });
      expect(
        feliz.desenlace,
        `esta URL no trajo ninguna marca reconocible: ${href}`,
      ).toBe("aterriza");
      if (feliz.desenlace !== "aterriza" || conError.desenlace !== "aterriza") continue;
      aterrizajes++;
      if (feliz.paso === PASO_DE_ENTRADA || conError.paso === PASO_DE_ENTRADA) enLaEntrada.push(href);
      if (feliz.paso !== conError.paso) {
        divergentes.push(`${href}: feliz=${feliz.paso} error=${conError.paso}`);
      }
      // Y el error cambia el MOTIVO, que es lo único que puede cambiar.
      expect(feliz.motivo, "el camino feliz no puede traer motivo de error").toBeNull();
      expect(
        conError.motivo,
        "el camino de error tiene que traer un motivo legible, o la persona queda sin saber qué pasó",
      ).toBeTruthy();
    }
    expect(aterrizajes, "ninguna URL llegó a aterrizar: las dos listas de abajo pasarían por vacío").toBe(
      urls.length,
    );
    expect(
      enLaEntrada,
      "una vuelta aterriza en la pantalla de entrada. AC-7 lo prohíbe con la palabra NUNCA",
    ).toEqual([]);
    expect(
      divergentes,
      "el camino de ERROR manda a otro paso que el feliz: el error cambia el motivo, ⛔ nunca el paso (AC-8)",
    ).toEqual([]);
  });

  // ── EL BARRIDO DE LITERALES ────────────────────────────────────────────────────────────────────
  //
  // MUTANTE QUE MATA (`MW-4`): escribir el literal del parámetro del enlace profundo a mano, entre
  // comillas, en `./salto.ts`.
  // ⛔ FALSO KILLED A EVITAR: barrer con `import` en vez de con `readFileSync`. Un guard de existencia
  // que importa lo que vigila muere por «Failed to resolve import», y eso NO es un KILLED. Se lee el
  // FUENTE.
  //
  // 🔴 POR QUÉ ESTE ARCHIVO **NO** SE EXCLUYE DEL BARRIDO, y es una decisión medida y no un olvido:
  // acá los literales NO están escritos en el fuente, entran importados de producción, y las líneas
  // sintéticas del control negativo se ARMAN EN MEMORIA a partir de esos mismos valores. Excluirse
  // sería apagar la vigilancia sobre el único archivo del árbol nuevo donde alguien podría tener la
  // tentación de escribir uno «para el test». Si algún día este archivo necesitara escribir un
  // literal, la exclusión se agrega por RUTA EXACTA (molde: `SELF`, `../../composition/citas-ancladas.test.ts:56`),
  // ⛔ nunca por glob ni por el sufijo de test.
  it("T-374-W1-4: ningún literal de marca de vuelta está ESCRITO en el árbol del recorrido nuevo", () => {
    // ⛔ `VALOR_SALIDA` queda FUERA de la lista, y se dice por qué: vale un solo dígito, así que
    // buscarlo entre comillas cazaría cualquier `"1"` legítimo (un `tabIndex`, un monto de fixture) y
    // el guard sería ruido en vez de señal. Lo que sí se vigila es el NOMBRE de ese parámetro, que es
    // el que no puede quedar duplicado a mano.
    const literales = [MARCA, PARAM_KYC, VALOR_VUELTA_KYC, PARAM_SALIDA, ...MARCAS_DE_VUELTA];
    expect(literales.length, "la lista de literales vino vacía: el barrido no miraría nada").toBe(
      MARCAS_DE_VUELTA.length + 4,
    );
    const patrones = literales.map((l) => ({
      literal: l,
      // Literal-shaped: matchea CÓDIGO, no prosa. Es la misma «TRAMPA 3» que documenta
      // (`FORBIDDEN`, `../../composition/no-evm-surface.test.ts:56`): los comentarios de este repo
      // nombran cosas para contar su historia, y un substring crudo los contaría como usos.
      pattern: new RegExp(`["'\`]${l.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}["'\`]`),
    }));

    // CONTROL NEGATIVO, con los LITERALES EXACTOS que el instrumento tiene que cazar. Sin esto, el
    // `toEqual([])` de abajo es indistinguible de un barrido que no ve nada.
    for (const p of patrones) {
      const sintetica = `const x = ${JSON.stringify(p.literal)};`;
      expect(
        p.pattern.test(sintetica),
        `el barrido NO caza el literal ${JSON.stringify(p.literal)} escrito a mano: no está midiendo nada`,
      ).toBe(true);
    }

    const archivos = archivosDelRecorrido();
    expect(
      archivos.length,
      "el barrido no encontró archivos del recorrido nuevo: pasaría por vacío",
    ).toBeGreaterThanOrEqual(3);
    const culpables: string[] = [];
    for (const abs of archivos) {
      const lineas = readFileSync(abs, "utf8").split("\n");
      lineas.forEach((l, i) => {
        for (const p of patrones) {
          if (p.pattern.test(l)) {
            culpables.push(`${path.relative(ROOT, abs)}:${i + 1} → ${JSON.stringify(p.literal)}`);
          }
        }
      });
    }
    expect(
      culpables,
      "un literal de marca de vuelta quedó ESCRITO en el árbol nuevo: se importa de producción, no se transcribe (CD-W1-7)",
    ).toEqual([]);
  });
});

/** Los `.ts`/`.tsx` de `src/presentation/recorrido`. Molde: `walk` en
 *  (`walk`, `../../composition/no-evm-surface.test.ts:35`). */
function archivosDelRecorrido(dir = path.join(ROOT, "src/presentation/recorrido")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...archivosDelRecorrido(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}
