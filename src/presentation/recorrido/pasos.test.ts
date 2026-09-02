// WKH-374 · W1.0 — LA TABLA DEL RECORRIDO Y EL ITINERARIO CONDICIONAL
//
// Los dos `it` de acá miden la FORMA de la tabla y el invariante que sostiene el indicador de
// progreso. ⛔ Ninguno escribe cuántos pasos hay: el número sale de la tabla, y por eso el mutante
// «agregar un paso» cae en la forma y no en un conteo que alguien tendría que actualizar a mano.

import { describe, expect, it } from "vitest";
import {
  PASO_DE_ENTRADA,
  TABLA,
  anterior,
  esPasoDelRecorrido,
  etiquetaDe,
  etiquetasDe,
  indiceEn,
  itinerario,
  siguiente,
} from "./pasos";

describe("WKH-374/W1.0 · la tabla enumerable de pasos (AC-2) y el itinerario condicional (AC-4)", () => {
  // MUTANTE QUE MATA (`MW-1`): agregar a `TABLA` una fila nueva SIN etiqueta (`etiqueta: ""`) ⇒ cae la
  // aserción de «todas las filas tienen etiqueta».
  // ⛔ FALSO KILLED A EVITAR: escribir el tamaño de la tabla como número en este `it`. Con el número
  // escrito, el mutante mataría EL LITERAL —«esperaba 5, hubo 6»— y no la derivación, y el `it`
  // quedaría siendo un recordatorio de actualizar un número en vez de un candado sobre la forma. Acá
  // el tamaño sale de `TABLA.length` y lo que se afirma es la FORMA: ids únicos, etiquetas no vacías,
  // y que el predicado de pertenencia y la tabla sean el MISMO conjunto.
  it("T-374-W1-1: la tabla es el único sitio donde el conjunto está escrito, y su tamaño se DERIVA", () => {
    // Calibración: una tabla vacía dejaría todo lo de abajo pasando por vacío.
    expect(TABLA.length, "la tabla vino vacía: los recorridos de abajo no medirían nada").toBeGreaterThan(0);

    const ids = TABLA.map((f) => f.id);
    expect(new Set(ids).size, "hay dos filas con el mismo `id`: la máquina de estado no las podría distinguir").toBe(
      TABLA.length,
    );

    const sinEtiqueta = TABLA.filter((f) => f.etiqueta.trim() === "").map((f) => f.id);
    expect(
      sinEtiqueta,
      "hay un paso sin etiqueta: el indicador de progreso mostraría un hueco donde la persona espera un nombre",
    ).toEqual([]);

    // El predicado y la tabla son el mismo conjunto, en las dos direcciones.
    for (const id of ids) {
      expect(esPasoDelRecorrido(id), `\`${id}\` está en la tabla pero el predicado lo rechaza`).toBe(true);
    }
    expect(
      esPasoDelRecorrido("un-paso-que-nadie-escribio"),
      "el predicado acepta pasos que no están en la tabla: no está mirando la tabla",
    ).toBe(false);

    // El primer paso es la entrada, que es la mitad de AC-1: conectar es lo PRIMERO, no lo tercero.
    expect(
      TABLA[0]?.id,
      "el recorrido no arranca en la pantalla de entrada: el orden es load-bearing (AC-1)",
    ).toBe(PASO_DE_ENTRADA);

    // Exactamente un paso es condicional. Si fueran cero, `T-374-W1-2` mediría dos veces el mismo caso.
    const condicionales = TABLA.filter((f) => f.soloLaPrimeraVez);
    expect(
      condicionales.length,
      "no hay ningún paso condicional: el `it` del itinerario compararía dos itinerarios idénticos y su mutante sobreviviría",
    ).toBeGreaterThan(0);
  });

  // MUTANTE QUE MATA (`MW-2`): en `./pasos.ts`, que `etiquetasDe` devuelva `TABLA.map((f) => f.etiqueta)`
  // —la tabla entera— en vez de mapear el itinerario recibido ⇒ cae el caso RECURRENTE.
  // ⛔ FALSO KILLED A EVITAR: correr sólo el caso de primera vez. Ahí el itinerario y la tabla
  // coinciden, el mutante SOBREVIVE y el `it` publicaría un verde sobre el caso que no mide nada.
  // Por eso LOS DOS CASOS van en el mismo `it`, y el `it` exige además que los dos largos DIFIERAN.
  it("T-374-W1-2: `etiquetas.length === itinerario.length` en los DOS casos, y los dos casos no son el mismo", () => {
    const primeraVez = itinerario({ identidadYaVerificada: false });
    const recurrente = itinerario({ identidadYaVerificada: true });

    // 🔴 LA CALIBRACIÓN QUE HACE FALSABLE AL RESTO: si los dos itinerarios fueran iguales, las dos
    // comparaciones de abajo serían la misma comparación hecha dos veces.
    expect(
      recurrente.length,
      "el itinerario recurrente NO es más corto que el de primera vez: el paso condicional no se está cayendo (AC-4)",
    ).toBeLessThan(primeraVez.length);
    expect(primeraVez.length, "el itinerario de primera vez no es la tabla entera").toBe(TABLA.length);

    for (const [nombre, itin] of [
      ["primera vez", primeraVez],
      ["recurrente", recurrente],
    ] as const) {
      const etiquetas = etiquetasDe(itin);
      expect(
        etiquetas.length,
        `caso «${nombre}»: el indicador de progreso recibiría ${etiquetas.length} etiquetas para ${itin.length} pasos`,
      ).toBe(itin.length);
      expect(
        etiquetas.filter((e) => e.trim() === ""),
        `caso «${nombre}»: hay una etiqueta vacía en el itinerario`,
      ).toEqual([]);
      // El paso actual siempre cae dentro del rango que el indicador puede pintar.
      for (const paso of itin) {
        const i = indiceEn(itin, paso);
        expect(i, `caso «${nombre}»: el paso \`${paso}\` no está en su propio itinerario`).toBeGreaterThanOrEqual(0);
        expect(i, `caso «${nombre}»: el índice de \`${paso}\` se sale del largo del indicador`).toBeLessThan(
          etiquetas.length,
        );
      }
    }

    // El paso condicional está en uno y no en el otro, comparado por valor.
    const condicional = TABLA.find((f) => f.soloLaPrimeraVez)?.id;
    expect(condicional, "no se pudo identificar el paso condicional").toBeTruthy();
    if (condicional !== undefined) {
      expect(primeraVez, "el paso condicional falta en el itinerario de primera vez").toContain(condicional);
      expect(recurrente, "el paso condicional sigue en el itinerario recurrente").not.toContain(condicional);
    }

    // Y las transiciones respetan el itinerario de cada quien: el recurrente SALTEA el condicional.
    if (condicional !== undefined) {
      const previo = TABLA[TABLA.findIndex((f) => f.id === condicional) - 1]?.id;
      const posterior = TABLA[TABLA.findIndex((f) => f.id === condicional) + 1]?.id;
      expect(previo, "el paso condicional no tiene un paso anterior en la tabla").toBeTruthy();
      expect(posterior, "el paso condicional no tiene un paso posterior en la tabla").toBeTruthy();
      if (previo !== undefined && posterior !== undefined) {
        expect(
          siguiente(recurrente, previo),
          "el itinerario recurrente no saltea el paso condicional al avanzar",
        ).toBe(posterior);
        expect(
          siguiente(primeraVez, previo),
          "el itinerario de primera vez se saltea el paso condicional al avanzar",
        ).toBe(condicional);
        expect(
          anterior(recurrente, posterior),
          "el itinerario recurrente no saltea el paso condicional al volver",
        ).toBe(previo);
      }
    }

    // Los extremos: el primero no retrocede fuera del recorrido y el último no avanza fuera.
    const primero = primeraVez[0];
    const ultimo = primeraVez[primeraVez.length - 1];
    expect(primero, "el itinerario no tiene primer paso").toBeTruthy();
    expect(ultimo, "el itinerario no tiene último paso").toBeTruthy();
    if (primero !== undefined && ultimo !== undefined) {
      expect(anterior(primeraVez, primero), "«Volver» en el primer paso se sale del recorrido").toBe(primero);
      expect(siguiente(primeraVez, ultimo), "«Seguir» en el último paso se sale del recorrido").toBe(ultimo);
    }
  });

  // ── AVANZAR DESDE UN PASO QUE ⛔ NO ESTÁ EN EL ITINERARIO ──────────────────────────────────────
  //
  // MUTANTE QUE MATA (`MW-22`): en `./pasos.ts`, volver `siguiente` a su forma anterior, o sea
  // reemplazar las tres últimas líneas por `if (i < 0) return itin[0] ?? PASO_DE_ENTRADA;` antes de
  // la salida de siempre ⇒ cae la PRIMERA aserción, la que nombra la pantalla de entrada.
  // ⛔ El comentario ⛔ NO escribe esa palabra reservada entre acentos graves, y no es prolijidad:
  // `T-374-W1-4` barre este árbol con patrones literal-shaped y uno de los valores que vigila se
  // escribe igual que ella. Medido: con los acentos graves ese `it` se pone rojo.
  // ⛔ FALSO KILLED A EVITAR: afirmar sólo «devuelve el paso posterior». Eso lo cumple también una
  // implementación que devuelva la entrada cuando el posterior no exista, que es la mitad que el
  // invariante prohíbe con la palabra NUNCA. Por eso las dos aserciones van SEPARADAS: primero que
  // ⛔ NO sea la pantalla de entrada, después cuál es. Y la calibración de arriba impide que un
  // itinerario que igual contenga el paso deje las dos pasando por el camino de siempre.
  it("T-374-W1-20: avanzar desde un paso fuera del itinerario ⛔ NUNCA aterriza en la pantalla de entrada", () => {
    const recurrente = itinerario({ identidadYaVerificada: true });
    const fuera = TABLA.find((f) => f.soloLaPrimeraVez)?.id;
    expect(fuera, "no hay ningún paso condicional: este `it` no tendría caso que medir").toBeTruthy();
    if (fuera === undefined) return;
    // CALIBRACIÓN: el paso tiene que estar REALMENTE fuera del itinerario, o `siguiente` tomaría el
    // camino de siempre y este `it` mediría otra cosa con el nombre de ésta.
    expect(
      indiceEn(recurrente, fuera),
      "el paso condicional sigue dentro del itinerario recurrente: no se está ejercitando la rama de «fuera del itinerario»",
    ).toBe(-1);

    const destino = siguiente(recurrente, fuera);
    expect(
      destino,
      "avanzar desde un paso fuera del itinerario aterriza en la PANTALLA DE ENTRADA, que es lo único que el invariante prohíbe con la palabra NUNCA",
    ).not.toBe(PASO_DE_ENTRADA);
    // Y va a donde tiene que ir: el siguiente de la TABLA que sí le toca a esta persona.
    const posterior = TABLA[TABLA.findIndex((f) => f.id === fuera) + 1]?.id;
    expect(posterior, "el paso condicional no tiene posterior en la tabla").toBeTruthy();
    expect(
      destino,
      "avanzar desde un paso fuera del itinerario no sigue el orden de la tabla",
    ).toBe(posterior);
  });

  // MUTANTE QUE MATA (`MW-23`): en `./pasos.ts`, que `etiquetaDe` devuelva siempre su argumento
  // (`return paso;`) ⇒ cae la aserción de la etiqueta, porque el id y la etiqueta no coinciden.
  // ⛔ FALSO KILLED A EVITAR: probarlo con un paso cuyo id y etiqueta se parezcan. Se prueban TODOS
  // los de la tabla, y la calibración exige que al menos uno tenga etiqueta distinta de su id.
  it("T-374-W1-21: `etiquetaDe` devuelve la etiqueta de la tabla, que es lo que un copy puede nombrar", () => {
    expect(
      TABLA.some((f) => f.etiqueta !== f.id),
      "ninguna fila tiene etiqueta distinta de su id: el mutante de la identidad sobreviviría",
    ).toBe(true);
    for (const f of TABLA) {
      expect(etiquetaDe(f.id), `«${f.id}» no devuelve su etiqueta de la tabla`).toBe(f.etiqueta);
    }
  });
});
