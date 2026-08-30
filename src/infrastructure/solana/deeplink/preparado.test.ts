// ⚠️ CD-15 · LOS MUTANTES DE ESTE ARCHIVO SE CORRIERON (2026-08-17). `spawnSync` sin pipes, aguja
// contada con `== 1`, relectura del disco, restauración verificada byte a byte. **15 mutantes: 14
// murieron y UNO SOBREVIVIÓ**, y el que sobrevivió está escrito al lado de su `it` en vez de tapado.
// (Acá decía "14 mutantes: 13 murieron" con una tabla de QUINCE filas: el número de la prosa no lo
// verificaba nada y su propio artefacto lo contradecía — MNR-CR-5. Se cuentan las filas, no la memoria.)
//
// | mutante                                                        | exit | `it` rojos |
// |---|---|---|
// | borrar la validación de `remittanceId`                          | 1 | 3 |
// | borrar la validación de `sender`                                | 1 | 3 |
// | borrar la validación de `beneficiary`                           | 1 | 3 |
// | borrar la validación de `authority`                             | 1 | 3 |
// | borrar la validación de `mensajeBase64`                         | 1 | 3 |
// | borrar la validación de `referenceBase58`                       | 1 | 3 |
// | `esTextoUtil` degradado a `typeof === "string"`                  | 1 | 6 |
// | ⚠️ `typeof desde !== "number"` en vez de `Number.isFinite` | 1 | 1 — YA NO SOBREVIVE (ver abajo) |
// | borrar el guard del `desde` en el FUTURO                        | 1 | 1 |
// | borrar la ventana de edad                                      | 1 | 1 |
// | NO limpiar el disco ante un JSON roto                          | 1 | 1 |
// | `guardarPreparado` se traga la excepción del disco              | 1 | 2 |
// | `terminarPreparado` TIRA (se le saca el try/catch)              | 1 | 1 |
// | el `leer` sin try/catch                                        | 1 | 1 |
// | reusar la CLAVE del viaje                                      | 1 | 66 |
//
// ⚠️ ESTA TABLA SE RE-MIDIÓ ENTERA EN EL FIX-PACK 1 (2026-08-17) y DOS NÚMEROS CAMBIARON, porque
// cambiaron los tests que rodean a este archivo, no el archivo: «reusar la CLAVE del viaje» pasó de 6 a
// **66** `it` rojos (ahora arrastra `firma-por-enlace.test.ts` y `solana-wallet.test.ts` completos) y
// «`guardarPreparado` se traga la excepción» dio 2. Los 15 mutantes se corrieron con la suite COMPLETA
// (136 archivos) y no sólo con este archivo: es lo que hace visible que un cambio de acá se lleva
// puesto medio recorrido, y es la razón por la que el conteo de `it` rojos no se puede copiar de una
// corrida vieja.
//
// Que los seis campos tengan UN mutante cada uno —y que cada uno mate SÓLO sus tres `it`— es lo que
// prueba que los seis están mirados, y no que "alguno" lo esté.
// WKH-356 · candados del registro que sobrevive a la muerte de la página.
//
// 🔴 QUÉ SE ESTÁ PROTEGIENDO. Todo lo que sale de `leerPreparado` viene de un `JSON.parse` sobre una
// cadena que escribe cualquiera que pueda ejecutar en este origen, o que edite el disco a mano. El
// `as Preparado` no verifica nada: es una afirmación del compilador sobre un dato que el compilador
// nunca vio. Estos `it` fijan qué se valida y, sobre todo, que ante basura el disco se LIMPIE — la
// lección medida en 061 es que un campo inválido que hace tirar y no limpia repite la excepción en
// cada carga de la página, así que la persona queda encerrada.
//
// ⚠️ LO QUE ESTE ARCHIVO NO VERIFICA: que un navegador real conserve `localStorage` al volver de la
// app de la billetera. Acá el almacén es un `Map`. Eso lo contesta un teléfono, y está [NO VERIFICADO].
//
// ⛔ POR QUÉ CADA VALIDACIÓN TIENE SU PROPIO `it` Y NO HAY UN `it.each` QUE LAS BARRA JUNTAS: porque
// entonces el mutante "borrar la validación de UN campo" mataría el bloque entero y no se sabría
// cuál. Cada `it` de abajo declara el mutante puntual que lo mata, y ese mutante se corrió.
import { describe, expect, it } from "vitest";
import { type Almacen, MAX_EDAD_MS } from "./sesion";
import {
  type Preparado,
  guardarPreparado,
  leerPreparado,
  terminarPreparado,
} from "./preparado";

/** Almacén de mentira: un `Map`. Cuenta borrados, que es lo que prueba la higiene. */
function almacenFalso(): Almacen & { datos: Map<string, string>; borrados: number } {
  const datos = new Map<string, string>();
  const a = {
    datos,
    borrados: 0,
    leer: (k: string) => datos.get(k) ?? null,
    escribir: (k: string, v: string) => void datos.set(k, v),
    borrar: (k: string) => {
      a.borrados += 1;
      datos.delete(k);
    },
  };
  return a;
}

const AHORA = 1_700_000_000_000;

function preparado(sobre: Partial<Preparado> = {}): Preparado {
  return {
    remittanceId: "rem-1",
    sender: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    beneficiary: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    authority: "3n1mQ5xJhLuqSU4C3vQAcTsHqzhSMtCB2K3P6bT3gJzZ",
    mensajeBase64: "AQIDBAUGBwg=",
    referenceBase58: "6dNVLJxTiCLPHRbkbUJLwZgLBUhz2Y7dRtNqkQyNhKcz",
    desde: AHORA,
    ...sobre,
  };
}

/** Escribe basura DIRECTO en el disco, sin pasar por `guardarPreparado` (que tipa). */
function sembrar(a: Almacen, valor: unknown): void {
  a.escribir("chaski.billetera.preparado.v1", JSON.stringify(valor));
}

describe("preparado — el trío guardar/leer/terminar", () => {
  // MUTANTE QUE MATA: hacer que `guardarPreparado` escriba en la clave del viaje
  // (`"chaski.billetera.viaje.v1"`) ⇒ `leerPreparado` no lo encuentra y este `it` se pone rojo.
  it("lo que se guarda se lee de vuelta, campo por campo", () => {
    const a = almacenFalso();
    const p = preparado();
    guardarPreparado(a, p);
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "hay", preparado: p });
  });

  // 🔴 EL CANDADO DE LA CLAVE PROPIA. Son dos ciclos de vida distintos: `terminarViaje` limpia en
  // cada corte y reintentar es empezar de cero, mientras el `Preparado` describe el intento contra
  // el que hay que COMPARAR. Con la clave compartida, limpiar uno se llevaría el otro.
  // MUTANTE QUE MATA: usar `"chaski.billetera.viaje.v1"` como `CLAVE` en `preparado.ts`.
  it("usa una clave PROPIA, distinta de la del viaje", () => {
    const a = almacenFalso();
    guardarPreparado(a, preparado());
    expect([...a.datos.keys()]).toEqual(["chaski.billetera.preparado.v1"]);
    expect(a.datos.has("chaski.billetera.viaje.v1")).toBe(false);
  });

  // MUTANTE QUE MATA: envolver el `a.escribir` de `guardarPreparado` en un `try {} catch {}` ⇒ deja
  // de tirar y el que llama salta igual, mandando a la persona a firmar algo contra lo que este
  // dispositivo no va a poder comparar nada.
  it("guardarPreparado TIRA si el disco no acepta (se llama ANTES del salto)", () => {
    const a = almacenFalso();
    a.escribir = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => guardarPreparado(a, preparado())).toThrow("QuotaExceededError");
  });

  // MUTANTE QUE MATA: sacarle el `try/catch` a `terminarPreparado` ⇒ tira, y con él se cae la salida
  // entera de la rama de enlace por una LIMPIEZA.
  it("terminarPreparado NO tira aunque el disco no deje borrar", () => {
    const a = almacenFalso();
    a.borrar = () => {
      throw new Error("SecurityError");
    };
    expect(() => terminarPreparado(a)).not.toThrow();
  });

  it("terminarPreparado deja el disco sin registro", () => {
    const a = almacenFalso();
    guardarPreparado(a, preparado());
    terminarPreparado(a);
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-hay" });
  });
});

describe("preparado — leerPreparado valida el disco y limpia ante basura", () => {
  it("sin nada guardado contesta no-hay y no borra nada", () => {
    const a = almacenFalso();
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-hay" });
    expect(a.borrados).toBe(0);
  });

  // MUTANTE QUE MATA: quitarle el `try/catch` al `a.leer(...)` ⇒ la excepción del almacén escapa y
  // rompe la lectura entera en vez de contestar "acá no hay nada que recordar".
  it("un almacén que ni siquiera deja LEER contesta no-hay, no tira", () => {
    const a = almacenFalso();
    a.leer = () => {
      throw new Error("SecurityError");
    };
    expect(() => leerPreparado(a, AHORA)).not.toThrow();
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-hay" });
  });

  // MUTANTE QUE MATA: sacar el `terminarPreparado(a)` de la rama del `catch` del `JSON.parse` ⇒ la
  // basura se queda en el disco y se vuelve a parsear en cada carga de la página.
  it("un JSON roto contesta no-hay Y LIMPIA el disco", () => {
    const a = almacenFalso();
    a.escribir("chaski.billetera.preparado.v1", "{no es json");
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-hay" });
    expect(a.borrados, "el JSON roto quedó en el disco: se repite en cada carga").toBe(1);
    expect(a.datos.size).toBe(0);
  });

  // ── Un `it` por campo, y por eso son seis y no un `it.each` ──────────────────────────────────────
  // MUTANTE QUE MATA (uno por caso): borrar del `if` de `leerPreparado` la línea
  // `!esTextoUtil(p?.<campo>)` correspondiente ⇒ SÓLO ese `it` se pone rojo. Es lo que prueba que
  // los seis campos están mirados de verdad y no que "alguno" lo esté.
  const CAMPOS = [
    "remittanceId",
    "sender",
    "beneficiary",
    "authority",
    "mensajeBase64",
    "referenceBase58",
  ] as const;

  for (const campo of CAMPOS) {
    it(`\`${campo}\` AUSENTE es basura: no-hay + limpieza`, () => {
      const a = almacenFalso();
      const { [campo]: _quitado, ...resto } = preparado();
      sembrar(a, resto);
      expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-hay" });
      expect(a.borrados).toBe(1);
    });

    it(`\`${campo}\` con OTRO TIPO es basura: no-hay + limpieza`, () => {
      const a = almacenFalso();
      sembrar(a, { ...preparado(), [campo]: 7 });
      expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-hay" });
      expect(a.borrados).toBe(1);
    });

    // 🔴 EL CASO QUE UN `typeof === "string"` DEJA PASAR, y es el peligroso: `"" === ""` da `true`,
    // así que dos campos vacíos "coinciden" y el guard de destino de la reanudación aplaude sobre
    // dos nadas. MUTANTE QUE MATA: cambiar `esTextoUtil` por `typeof x === "string"`.
    it(`\`${campo}\` VACÍO es basura (dos vacíos "coinciden"): no-hay + limpieza`, () => {
      const a = almacenFalso();
      sembrar(a, { ...preparado(), [campo]: "   " });
      expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-hay" });
      expect(a.borrados).toBe(1);
    });
  }

  // ⚠️ MUTANTE QUE SOBREVIVÍA Y HOY MUERE, y la historia entera vale más que el veredicto. Primero acá
  // decía «MUTANTE QUE MATA: `typeof p?.desde !== "number"` en vez de `!Number.isFinite(p?.desde)`»;
  // la batería de WKH-356 lo corrió y midió la suite VERDE (exit 0, 0 rojos), así que la frase se
  // corrigió a «SOBREVIVE» con el porqué input por input:
  //   `1e999`  → `Infinity`  ⇒ lo cortaba el guard del FUTURO (`Infinity > ahora` es true)
  //   `-1e999` → `-Infinity` ⇒ lo corta la VENTANA (`ahora - (-Infinity)` es `Infinity`)
  //   `"ayer"`, `null`, `true`, `[]`, `{}` ⇒ los corta el `typeof` mutado igual
  //   `NaN`    → no es JSON válido: `JSON.parse` TIRA y lo cubre el `catch` de más arriba
  // Los cinco convergían en `no-hay`, que era la MISMA respuesta que daba el original.
  //
  // 🔴 EL ADDENDUM DEL RELOJ ROMPIÓ ESA CONVERGENCIA, y no a propósito: el guard del futuro ya no
  // contesta `no-hay` ni limpia, contesta `no-fechable` y ⛔ DEJA EL DISCO. Así que hoy el `1e999` sí
  // distingue las dos versiones del código, y el `it` de acá abajo se pone rojo con el mutante puesto.
  // MUTANTE QUE MATA (medido en esta pasada): `typeof p?.desde !== "number"` ⇒ el `it` de `1e999` da
  // `expected { tipo: "no-fechable" } to deeply equal { tipo: "no-hay" }` y `expected 0 to be 1`.
  // ⚠️ Y LA CONSECUENCIA REAL ES PEOR QUE EL ROJO: sin esta validación un `+Infinity` sería basura que
  // la ventana NO limpia nunca, porque `ahora - Infinity` es `-Infinity`.
  //
  // ⚠️ El párrafo que seguía acá decía que en `sesion.ts` el mismo guard SÍ tenía candado «porque
  // `leerViaje` tiene TRES desenlaces y `LecturaDelPreparado` tiene DOS». La segunda mitad ya es falsa:
  // `LecturaDelPreparado` tiene TRES desde el addendum, y ésa es exactamente la razón por la que el
  // mutante dejó de sobrevivir. El propio comentario había escrito su condición de caducidad («el día
  // que este tipo gane un tercer valor pasa a ser observable»), y ese día llegó.
  it("un `desde` no finito POSITIVO es basura: no-hay + limpieza", () => {
    const a = almacenFalso();
    a.escribir(
      "chaski.billetera.preparado.v1",
      JSON.stringify(preparado()).replace(String(AHORA), "1e999"),
    );
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-hay" });
    expect(a.borrados).toBe(1);
  });

  it("un `desde` no finito NEGATIVO es basura, y NO se contesta 'vencido' inventado", () => {
    const a = almacenFalso();
    a.escribir(
      "chaski.billetera.preparado.v1",
      JSON.stringify(preparado()).replace(String(AHORA), "-1e999"),
    );
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-hay" });
    expect(a.borrados).toBe(1);
  });

  it("un `desde` que no es número es basura: no-hay + limpieza", () => {
    const a = almacenFalso();
    sembrar(a, { ...preparado(), desde: "ayer" });
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-hay" });
    expect(a.borrados).toBe(1);
  });

  // ══ WKH-075 · ADDENDUM DEL RELOJ · testigo E ═══════════════════════════════════════════════════
  //
  // 🔴 EL RETROCESO SE EXPRESA CON `ahora` POR PARÁMETRO, ⛔ nunca con un reloj real: `leerPreparado`
  // recibe el instante (`leerPreparado`, `./preparado.ts:129`), así que un retroceso son dos llamadas
  // con `ahora` decreciente. Un testigo que dependiera del reloj del runner quedaría verde con el bug
  // adentro en cualquier máquina con el reloj disciplinado por slew.
  //
  // 🔴 POR QUÉ ESTE REGISTRO IMPORTA SI «SOLO NO VALE NADA»: su `mensajeBase64` es lo ÚNICO contra lo
  // que se puede verificar la `transaccionFirmada` que el viaje sí preserva. Arreglar el viaje sin
  // arreglar esto convierte el defecto en otro: viaje vivo sobre registro muerto ⇒
  // `deeplink_sin_memoria` en CADA invocación, con la firma preservada e inutilizable.
  // MUTANTE QUE MATA (E-1): quitar la rama `p.desde > ahora` de `preparado.ts` ⇒ `expected { tipo:
  //   "hay", ... } to deeply equal { tipo: "no-fechable" }`. ⚠️ Si el rojo saliera del `borrados`, el
  //   mutante habría muerto por la VENTANA y sería un falso KILLED: con `desde` futuro `ahora - desde`
  //   es negativo y esa ventana no se alcanza nunca.
  // MUTANTE QUE MATA (E-2): devolverle el `terminarPreparado(a)` a esa rama ⇒ `expected 1 to be 0` en
  //   el `expect` del disco. Ése es EL `expect` que mide el arreglo.
  it("T-075-RELOJ-E · un `desde` en el FUTURO no se puede fechar, y ⛔ el registro NO SE BORRA", () => {
    const a = almacenFalso();
    guardarPreparado(a, preparado({ desde: AHORA + 10 * 24 * 60 * 60 * 1000 }));
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-fechable" });
    expect(a.borrados, "una LECTURA no destruye lo que no entrega").toBe(0);
    expect(a.datos.has("chaski.billetera.preparado.v1")).toBe(true);
  });

  it("T-075-RELOJ-E2 · un MILISEGUNDO adelantado ya no es fechable, y el registro REVIVE después", () => {
    // El borde, sin tolerancia, y la vuelta: en cuanto el reloj pasa su `desde`, el MISMO registro
    // vuelve a servir sin que nadie lo haya reescrito. Es la mitad que prueba que degradar no mutila.
    const a = almacenFalso();
    const p = preparado({ desde: AHORA + 1 });
    guardarPreparado(a, p);
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-fechable" });
    expect(leerPreparado(a, AHORA + 1)).toEqual({ tipo: "hay", preparado: p });
    expect(a.borrados).toBe(0);
  });

  it("T-075-RELOJ-E-J · CONTROL NEGATIVO: con retroceso CERO el registro sigue siendo «hay»", () => {
    // ⛔ Sin esto, nada distingue «arreglé el guard» de «rompí el guard»: el corte es ESTRICTAMENTE
    // mayor, y un registro leído en el mismo milisegundo en que se escribió es el caso normal.
    const a = almacenFalso();
    const p = preparado({ desde: AHORA });
    guardarPreparado(a, p);
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "hay", preparado: p });
    expect(a.borrados).toBe(0);
  });

  // MUTANTE QUE MATA: borrar el `if (ahora - p.desde > MAX_EDAD_MS)` ⇒ un registro de horas atrás
  // sigue contestando "hay" y se compara contra un intento que ya nadie puede completar.
  it("pasada la ventana contesta no-hay y limpia", () => {
    const a = almacenFalso();
    guardarPreparado(a, preparado({ desde: AHORA - MAX_EDAD_MS - 1 }));
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "no-hay" });
    expect(a.borrados).toBe(1);
  });

  it("justo en el borde de la ventana todavía contesta hay (el corte es estricto)", () => {
    const a = almacenFalso();
    const p = preparado({ desde: AHORA - MAX_EDAD_MS });
    guardarPreparado(a, p);
    expect(leerPreparado(a, AHORA)).toEqual({ tipo: "hay", preparado: p });
  });
});
