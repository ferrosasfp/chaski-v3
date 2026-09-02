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
// Las TRES marcas del enlace que producción exporta con nombre propio. ⛔ Ningún literal: son las que
// hacen falta para cerrar la permutación de la tupla (ver el `it` de la premisa).
import { MARCA_CREAR_NONCE } from "../../infrastructure/solana/deeplink/conexion";
import { MARCA_POP_KYC, MARCA_POP_PAYOUT } from "../../infrastructure/solana/deeplink/pop-por-enlace";
import { PARAM_ERROR } from "../../infrastructure/solana/deeplink/protocol";
import { PARAM_KYC, VALOR_VUELTA_KYC, urlDeVueltaDeKyc } from "../splash-puerta";
import { PARAM_SALIDA, VALOR_SALIDA } from "../salida-al-navegador-de-la-billetera";
import { PASO_DE_ENTRADA, esPasoDelRecorrido } from "./pasos";
import {
  MARCA_DEL_VERIFICADOR,
  MARCA_DE_LA_SALIDA,
  MOTIVO_SIN_ATERRIZAJE,
  PASO_DE_LA_MARCA_DESCONOCIDA,
  SIN_ATERRIZAJE,
  aterrizaEnLaEntrada,
  aterrizajeDe,
  aterrizajeDelAnfitrion,
  codigoDeErrorDeLaUrl,
  marcaDeLaUrl,
  volvioPorEnlace,
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

    // ── (5) 🔴 LA PERMUTACIÓN, QUE ES EL AGUJERO QUE EL AR MIDIÓ (MNR-1) ─────────────────────────
    //
    // ⚠️ ACÁ SE DECLARABA EL AGUJERO EQUIVOCADO: se decía que la calibración «no cierra el caso de que
    // producción RENOMBRE las seis manteniendo el conteo», y ese caso es INOFENSIVO — las claves de la
    // tabla de aterrizaje salen de la MISMA tupla, así que un renombre mueve las dos puntas a la vez y
    // nada se rompe. El agujero real es el otro: una PERMUTACIÓN de la tupla re-apunta la tabla
    // (indexada por POSICIÓN) y las cuatro aserciones de arriba siguen verdes, porque las cuatro son
    // invariantes bajo permutación: «todas aterrizan», «ninguna en la entrada», «la sintética no».
    //
    // SE CIERRA CON LOS TRES NOMBRES QUE PRODUCCIÓN EXPORTA, y ⛔ sin escribir un solo literal de marca:
    // se afirma la LIGADURA marca → paso, que es justo lo que una permutación rompe.
    expect(
      aterrizajeDe(MARCA_CREAR_NONCE),
      "la vuelta de la creación del nonce durable dejó de aterrizar en el paso de firmar: es un salto DENTRO de preparar la firma, así que vuelve de donde salió",
    ).toBe("firmar");
    expect(
      aterrizajeDe(MARCA_POP_PAYOUT),
      "la vuelta de la prueba de posesión del pago dejó de aterrizar en el seguimiento: sirve para leer el estado, no para mover fondos",
    ).toBe("seguimiento");
    expect(
      aterrizajeDe(MARCA_POP_KYC),
      "la vuelta de la prueba de posesión de la identidad dejó de aterrizar en el seguimiento",
    ).toBe("seguimiento");
    // Y las tres tienen que SER de la tupla, o estaríamos midiendo tres marcas que no están en juego.
    for (const m of [MARCA_CREAR_NONCE, MARCA_POP_PAYOUT, MARCA_POP_KYC]) {
      expect(
        MARCAS_DE_VUELTA as readonly string[],
        `${m} no está en la tupla de producción: la ligadura de arriba no diría nada de la tabla`,
      ).toContain(m);
    }
    //
    // ⚠️ LO QUE **SIGUE** ABIERTO, declarado con su tamaño exacto: una permutación confinada a las tres
    // marcas del viaje del depósito (`PasoDelViaje`), que ⛔ NO tienen constante exportada con nombre
    // propio en producción — son literales dentro de `esPaso`, que no se exporta. De esas tres, dos
    // aterrizan en el MISMO paso, así que intercambiarlas es un no-op observable; lo que queda
    // realmente abierto es la permutación que mueve la marca del connect contra una de las otras dos.
    // ⛔ Cerrarlo exigiría transcribir un literal acá, que es lo que `CD-W1-7` prohíbe, o exportar tres
    // constantes nuevas desde el motor del enlace, que es un archivo fuera del alcance de esta ola.
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
    // El código crudo que una billetera deja al rechazar. ⛔ NO es una marca de vuelta (no lo vigila
    // `CD-W1-7`) y ⛔ no es una causa del vocabulario del enlace: es texto de la billetera, y por eso
    // `humanError` lo manda a su default, que es exactamente lo que hace el árbol viejo con él.
    const CODIGO_DE_RECHAZO = "4001";
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
      // 🔴 LA RAMA DE ERROR SE CONSTRUYE COMO LA CONSTRUYE PRODUCCIÓN: pegándole a la MISMA URL el
      // parámetro con el que la billetera reporta un rechazo. Hasta el fix-pack esto entraba por un
      // argumento (`codigoDeError`) que ⛔ NINGÚN LLAMADOR PASABA, o sea que este `it` ejercitaba una
      // rama que nadie construye y el motivo era `null` para toda vuelta real (AR/BLQ-MED-4).
      // ⛔ El nombre del parámetro no se escribe: entra por `PARAM_ERROR`, de producción.
      const conCodigo = new URL(href);
      conCodigo.searchParams.set(PARAM_ERROR, CODIGO_DE_RECHAZO);
      const conError = vueltaDeUnSalto({ href: conCodigo.toString() });
      // Calibración del fixture: el código está EN la URL, y lo lee el mismo lector que usa
      // `vueltaDeUnSalto`. Sin esto, un typo en el armado dejaría las dos ramas idénticas y las
      // comparaciones de abajo pasarían por trivialidad.
      expect(
        codigoDeErrorDeLaUrl(conCodigo.toString()),
        "la URL de la rama de error no lleva ningún código: las dos ramas serían la MISMA",
      ).toBe(CODIGO_DE_RECHAZO);
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

  // ── LA MARCA QUE VIENE DEL PROTOTIPO ───────────────────────────────────────────────────────────
  //
  // MUTANTE QUE MATA (`MW-13`): en `./salto.ts`, volver a la forma vieja —borrar el
  // `if (!Object.hasOwn(...))` y devolver `(ATERRIZAJE_POR_ENLACE as Record<string, PasoDelRecorrido |
  // undefined>)[marca] ?? SIN_ATERRIZAJE`— ⇒ cae la PRIMERA aserción, con `toString`.
  // ⛔ FALSO KILLED A EVITAR: probar sólo una marca INVENTADA, que es lo que hacía el control negativo
  // de `T-374-W1-0`. Una marca inventada no existe en `Object.prototype`, así que la forma vieja la
  // contesta bien y el `it` queda verde sobre el defecto. Por eso las claves de acá son las del
  // PROTOTIPO, y por eso hay un control positivo con una marca REAL: sin él, un `aterrizajeDe` que
  // devolviera el tercer valor SIEMPRE pasaría las cuatro primeras.
  it("T-374-W1-13: una clave del prototipo de `Object` NO es un aterrizaje", () => {
    for (const clave of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      const a = aterrizajeDe(clave);
      expect(
        a,
        `«${clave}» viene de \`Object.prototype\` y se está colando como aterrizaje: con eso la app queda sin ninguna pantalla montada`,
      ).toBe(SIN_ATERRIZAJE);
      expect(
        typeof a,
        `«${clave}» devolvió algo que ni siquiera es una cadena: el tipo publicado por \`Aterrizaje\` es falso`,
      ).toBe("string");
      expect(
        aterrizaEnLaEntrada(a),
        `el predicado de fallo-cerrado contesta cualquier cosa para «${clave}»`,
      ).toBe(false);
    }
    // Y la vuelta ENTERA, desde la URL: es el input exacto que dejaba el `body` en «Paso 1 de 5».
    const conPrototipo = new URL("https://chaski.test/");
    conPrototipo.searchParams.set(MARCA, "toString");
    expect(
      vueltaDeUnSalto({ href: conPrototipo.toString() }).desenlace,
      "una marca heredada del prototipo se lee como si fuera un aterrizaje de la tabla",
    ).toBe("sin-aterrizaje");

    // CONTROL POSITIVO: una marca REAL sigue aterrizando. Sin esto, las de arriba las pasaría un
    // `aterrizajeDe` que contestara el tercer valor siempre, que es el mutante más barato.
    expect(
      aterrizajeDe(MARCA_CREAR_NONCE),
      "el control positivo no aterriza: las aserciones de arriba pasarían por un `aterrizajeDe` que no reconoce NADA",
    ).not.toBe(SIN_ATERRIZAJE);
  });

  // ── EL DESENLACE DEL ANFITRIÓN, COMO FUNCIÓN PURA ──────────────────────────────────────────────
  //
  // MUTANTE QUE MATA (`MW-14`): en `aterrizajeDelAnfitrion`, hacer que la rama `sin-aterrizaje`
  // devuelva `{ paso: pasoDeArranque, motivo: null }`, o sea el `? :` que había en el anfitrión ⇒ caen
  // las DOS aserciones del caso desconocido (el paso y el motivo).
  // ⛔ FALSO KILLED A EVITAR: afirmar sólo «no es la entrada». Con `pasoDeArranque` puesto a mano en
  // un paso del medio eso seguiría siendo cierto y el defecto seguiría ahí, así que el `it` pasa la
  // costura en la PANTALLA DE ENTRADA —que es el default de producción— y afirma las dos mitades.
  it("T-374-W1-14: una marca sin consumidor NO colapsa en el paso de arranque, y trae motivo", () => {
    const desconocida = vueltaDeUnSalto({
      href: `https://chaski.test/?${MARCA}=marca-que-nadie-escribio`,
    });
    expect(
      desconocida.desenlace,
      "el fixture no reproduce el caso: esta URL no da el tercer valor",
    ).toBe("sin-aterrizaje");

    const r = aterrizajeDelAnfitrion(desconocida, PASO_DE_ENTRADA);
    expect(
      r.paso,
      "una marca sin consumidor manda a la persona al paso de arranque: con el default de producción eso es la PANTALLA DE ENTRADA, que es lo que AC-8 prohíbe con la palabra NUNCA",
    ).not.toBe(PASO_DE_ENTRADA);
    expect(r.paso, "el paso de la marca desconocida no es el que el módulo declara").toBe(
      PASO_DE_LA_MARCA_DESCONOCIDA,
    );
    expect(
      r.motivo,
      "la persona vuelve con una marca que no reconocemos y no lee NINGÚN motivo: eso es mandarla a otro lado en silencio",
    ).toBe(MOTIVO_SIN_ATERRIZAJE);

    // Los otros dos desenlaces, para que las dos de arriba no sean el único comportamiento posible.
    const sinMarca = aterrizajeDelAnfitrion(vueltaDeUnSalto({ href: "https://chaski.test/" }), PASO_DE_ENTRADA);
    expect(sinMarca.paso, "sin marca en la URL el arranque tiene que ser el normal").toBe(PASO_DE_ENTRADA);
    expect(sinMarca.motivo, "sin marca no hay nada que reportar").toBeNull();

    const buena = aterrizajeDelAnfitrion(
      vueltaDeUnSalto({ href: enlaceDeVuelta("https://chaski.test/", MARCA_CREAR_NONCE) }),
      PASO_DE_ENTRADA,
    );
    expect(buena.paso, "una marca REAL dejó de aterrizar donde la tabla dice").toBe("firmar");
    expect(buena.motivo, "una vuelta sin código de error no puede traer motivo").toBeNull();

    // Y el predicado de fallo-cerrado tiene que ser FALSO para el paso al que este módulo manda: si
    // fuera la entrada, la rama de arriba entraría en un bucle en vez de fallar cerrado.
    expect(
      aterrizaEnLaEntrada(PASO_DE_LA_MARCA_DESCONOCIDA),
      "el paso de la marca desconocida ES la pantalla de entrada: el fallo-cerrado no tendría a dónde caer",
    ).toBe(false);

    // `volvioPorEnlace` distingue el camino del enlace de las otras dos marcas del universo.
    expect(
      volvioPorEnlace(enlaceDeVuelta("https://chaski.test/", MARCA_POP_PAYOUT)),
      "una vuelta del enlace profundo no se reconoce como tal: la pantalla anunciaría las firmas del otro camino",
    ).toBe(true);
    expect(
      volvioPorEnlace(urlDeVueltaDeKyc("https://chaski.test")),
      "la vuelta del verificador se está contando como camino por enlace",
    ).toBe(false);
    expect(volvioPorEnlace("https://chaski.test/"), "una URL sin marca no vuelve de ningún enlace").toBe(false);
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
    // `PARAM_ERROR` entró en el fix-pack, junto con el lector del código de error: es el quinto nombre
    // de parámetro que el árbol nuevo consume y ⛔ el quinto que no puede quedar transcrito a mano.
    const literales = [MARCA, PARAM_KYC, VALOR_VUELTA_KYC, PARAM_SALIDA, PARAM_ERROR, ...MARCAS_DE_VUELTA];
    expect(literales.length, "la lista de literales vino vacía: el barrido no miraría nada").toBe(
      MARCAS_DE_VUELTA.length + 5,
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
