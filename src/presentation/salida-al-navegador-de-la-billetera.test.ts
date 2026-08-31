// Tests — el cálculo puro de la salida al navegador de la billetera (WKH-372 / W1.1).
//
// 🔴 LOS TRES `it` SON DE CLASES DISTINTAS Y HACEN FALTA LOS TRES:
//   · `T-372-W1-8`  mide QUÉ SE BORRA y QUÉ SE AGREGA al href (el contenido).
//   · `T-372-W1-9`  mide el OPT-IN ESTRICTO de la marca (qué valores cuentan y cuáles no).
//   · `T-372-W1-10` mide que el ENVOLTORIO siga siendo el de producción (que nadie reescriba el
//     universal link a mano en el módulo nuevo).
// Uno solo de los tres deja un agujero entero: con sólo el primero, alguien puede reescribir el
// prefijo del enlace; con sólo el tercero, la limpieza puede desaparecer sin que nada se ponga rojo.
//
// ⛔ NINGUNO ESCRIBE UN STRING COMPLETO A MANO NI RE-ESCRIBE UN LITERAL DEL MÓDULO. Los tres
// **importan** lo que van a comparar y **parsean** lo que reciben. Un `it` que buscara en la salida el
// mismo literal que el módulo escribe sería un guard leyéndose a sí mismo: nunca podría fallar.
import { describe, expect, it } from "vitest";
import {
  PARAM_SALIDA,
  URL_INSTALAR_PHANTOM,
  VALOR_SALIDA,
  hrefSinLaMarcaDeSalida,
  urlDeSalidaAlNavegadorDeLaBilletera,
  vinoDeUnaSalidaConBorrador,
} from "./salida-al-navegador-de-la-billetera";
import { phantomBrowseUrl } from "./wallet-availability";
import { PARAM_KYC, VALOR_VUELTA_KYC } from "./splash-puerta";
import { MARCA } from "../infrastructure/solana/deeplink/sesion";
// AR/BLQ-BAJO-1 — EL DECODIFICADO SE MUDÓ A `../test-support/salida-al-navegador.ts` y acá se
// IMPORTA. Estaba definido en este archivo, y el `it` de la OFERTA (`wallet-availability.test.tsx`,
// `T-372-W1-1`) necesita exactamente el mismo desarmado: dos copias serían dos guards que se corrigen
// por separado, y una copia nueva escrita a mano es la ocasión de escribir el prefijo a mano.
import { hrefQueLaBilleteraVaAAbrir } from "../test-support/salida-al-navegador";

const ORIGEN = "https://chaski.test";

describe("WKH-372/AC-1-4b · qué viaja y qué NO viaja al navegador de la billetera", () => {
  // MUTANTE QUE LO TIENE QUE MATAR: en `./salida-al-navegador-de-la-billetera.ts`, borrar la línea
  // `u.searchParams.delete(PARAM_KYC);` ⇒ el `?kyc=return` del aterrizaje del verificador viaja al
  // otro navegador y la fila del `kyc` de abajo se pone roja.
  // ⛔ FALSO KILLED A EVITAR: comparar la URL entera contra un string escrito a mano. Este `it`
  // CONSTRUYE el href de entrada con los nombres importados y PARSEA el de salida.
  it("T-372-W1-8: borra `dl`, los parámetros de respuesta de la billetera y `kyc`, y agrega la marca sólo con borrador", () => {
    const entrada = new URL(`${ORIGEN}/enviar`);
    entrada.searchParams.set("monto", "400"); // un parámetro de la app: NO se toca
    entrada.searchParams.set(MARCA, "firmar-tx"); // la marca de vuelta del enlace profundo
    entrada.searchParams.set("errorCode", "4001"); // una respuesta de la billetera
    entrada.searchParams.set("nonce", "9xQz"); // otra
    entrada.searchParams.set(PARAM_KYC, VALOR_VUELTA_KYC); // el aterrizaje del verificador

    const conBorrador = hrefQueLaBilleteraVaAAbrir(
      urlDeSalidaAlNavegadorDeLaBilletera({ href: entrada.toString(), origin: ORIGEN, hayBorrador: true }),
    );

    // CD-18 — el fixture fabricó el caso: los cinco parámetros estaban puestos ANTES de limpiar. Sin
    // esto, un `it` sobre una URL pelada pasaría sin haber ejercitado ninguna limpieza.
    expect(
      [...entrada.searchParams.keys()].sort(),
      "el fixture no cargó los parámetros que se quieren ver borrados",
    ).toEqual(["errorCode", MARCA, "monto", "nonce", PARAM_KYC].sort());

    // 1 · LO QUE SE BORRA, uno por uno y con su motivo en el mensaje.
    expect(conBorrador.searchParams.get(MARCA), "la marca de vuelta del enlace viajó al otro navegador").toBeNull();
    expect(conBorrador.searchParams.get("errorCode"), "un rechazo viejo de la billetera viajó").toBeNull();
    expect(conBorrador.searchParams.get("nonce"), "un parámetro de respuesta de la billetera viajó").toBeNull();
    expect(
      conBorrador.searchParams.get(PARAM_KYC),
      "el aterrizaje del verificador viajó al otro navegador: allá arranca a retomar un trámite que " +
        "en ESE almacenamiento no existe",
    ).toBeNull();
    // 2 · LO QUE **NO** SE BORRA: lo que la persona cargó no es un rastro de nadie.
    expect(conBorrador.searchParams.get("monto"), "se llevó puesto un parámetro de la app").toBe("400");
    // 3 · Y LA MARCA, puesta.
    expect(conBorrador.searchParams.get(PARAM_SALIDA)).toBe(VALOR_SALIDA);

    // 4 · EL PAR NEGATIVO, que es lo que hace falsable a la fila de arriba: sin borrador NO hay marca.
    //     Sin esta mitad, un módulo que pusiera la marca SIEMPRE pasaría igual.
    const sinBorrador = hrefQueLaBilleteraVaAAbrir(
      urlDeSalidaAlNavegadorDeLaBilletera({ href: entrada.toString(), origin: ORIGEN, hayBorrador: false }),
    );
    expect(
      sinBorrador.searchParams.get(PARAM_SALIDA),
      "se anunció un borrador que no existe: al aterrizar, la app le hablaría de datos que nunca cargó",
    ).toBeNull();
    expect(sinBorrador.searchParams.get("monto"), "la rama sin borrador limpia de más").toBe("400");
  });

  // MUTANTE QUE LO TIENE QUE MATAR: en `vinoDeUnaSalidaConBorrador`, cambiar la comparación por
  // `new URL(href).searchParams.has(PARAM_SALIDA)` ⇒ `""`, `"true"`, `"0"` y `"1 "` pasan a prender.
  // Patrón obligatorio: (`T-065-20`, `./wallet-availability.test.tsx:1021`), que ya hace exactamente
  // esto para una env.
  it("T-372-W1-9: la marca es opt-in ESTRICTO: sólo el valor exacto prende", () => {
    const conValor = (v: string): string => `${ORIGEN}/?${PARAM_SALIDA}=${encodeURIComponent(v)}`;
    // Lo que SÍ prende, PRIMERO: sin esta fila el `it` pasaría con una función que devuelve `false`
    // siempre, que es el mutante más barato de todos.
    expect(
      vinoDeUnaSalidaConBorrador(conValor(VALOR_SALIDA)),
      "el valor exacto TIENE que prender, o esto no reconoce ninguna salida",
    ).toBe(true);
    for (const v of ["", "0", "true", "TRUE", `${VALOR_SALIDA} `, ` ${VALOR_SALIDA}`, "11", "yes"]) {
      expect(
        vinoDeUnaSalidaConBorrador(conValor(v)),
        `el valor ${JSON.stringify(v)} NO puede contar como una salida con borrador`,
      ).toBe(false);
    }
    // El parámetro AUSENTE: es el visitante nuevo dentro del navegador de la billetera, y el desenlace
    // correcto es que no vea ningún aviso sobre datos que nunca cargó.
    expect(vinoDeUnaSalidaConBorrador(`${ORIGEN}/enviar?monto=400`), "sin marca no hay salida").toBe(false);
    // Y un href que no se deja leer: no se puede afirmar que traiga una marca lo que no se puede leer.
    expect(vinoDeUnaSalidaConBorrador("no-soy-una-url"), "un href impareseable afirmó una salida").toBe(false);
  });

  // 🔴 CR/`BLQ-MEDIO-1` — LA MITAD PURA DE CONSUMIR LA MARCA. La mitad de PANTALLA (que el aterrizaje
  // sobreviva a una recarga) la mide `T-372-W1-7e` en `./wallet-availability.test.tsx`; acá se mide el
  // cálculo, que es donde vive el criterio de qué se saca y qué se deja.
  // MUTANTE QUE LO TIENE QUE MATAR: cambiar el `delete(PARAM_SALIDA)` por un `return null` ⇒ la fila
  // (a) se pone roja porque la marca sigue en el href.
  // ⛔ FALSO KILLED A EVITAR: medir sólo el caso (a). Sin la fila (c), una función que devolviera
  //    SIEMPRE un href limpio haría que quien llama reescriba la barra en cada carga de la app.
  it("T-372-W1-9b: `hrefSinLaMarcaDeSalida` saca la marca, deja el resto, y devuelve `null` cuando no hay nada que consumir", () => {
    // (a) CON MARCA: sale la marca y NADA MÁS. El href de entrada se arma con los nombres importados.
    const conMarca = new URL(`${ORIGEN}/enviar`);
    conMarca.searchParams.set("monto", "400");
    conMarca.searchParams.set(PARAM_SALIDA, VALOR_SALIDA);
    // CD-18 — el fixture reprodujo el caso: la marca estaba puesta ANTES de consumirla. Sin esto, una
    // URL pelada dejaría las dos filas de abajo verdes sin haber ejercitado ninguna limpieza.
    expect(
      vinoDeUnaSalidaConBorrador(conMarca.toString()),
      "el fixture no dejó la marca puesta: no hay nada que consumir",
    ).toBe(true);
    const limpio = hrefSinLaMarcaDeSalida(conMarca.toString());
    expect(limpio, "no devolvió un href: la barra se quedaría con la marca puesta").not.toBeNull();
    expect(
      vinoDeUnaSalidaConBorrador(limpio as string),
      "la marca sobrevivió al consumo: una recarga de la pestaña volvería a leerla como un aterrizaje",
    ).toBe(false);
    // La otra mitad, la que hace falsable a la de arriba: consumir NO es vaciar la URL.
    expect(
      new URL(limpio as string).searchParams.get("monto"),
      "se llevó puesto un parámetro de la app: consumir la marca no es vaciar la barra",
    ).toBe("400");

    // (b) CUALQUIER VALOR, no sólo el que el lector acepta. El que LEE es opt-in estricto; el que
    //     CONSUME tiene que sacar el parámetro igual, o la barra queda con la condición viva.
    const otroValor = `${ORIGEN}/enviar?${PARAM_SALIDA}=${encodeURIComponent(`${VALOR_SALIDA}x`)}`;
    expect(
      hrefSinLaMarcaDeSalida(otroValor) === null
        ? null
        : new URL(hrefSinLaMarcaDeSalida(otroValor) as string).searchParams.has(PARAM_SALIDA),
      "un `wb` con otro valor se quedó en la barra: es un nombre de este repo y no se deja a medias",
    ).toBe(false);

    // (c) SIN NADA QUE CONSUMIR ⇒ `null`, y por eso quien llama no toca el historial. Sin esta fila,
    //     la app reescribiría la barra en cada carga que no viene de una salida.
    expect(
      hrefSinLaMarcaDeSalida(`${ORIGEN}/enviar?monto=400`),
      "devolvió un href sin haber marca: quien llama escribiría el historial en cada carga",
    ).toBeNull();
    // (d) Y un href que no se deja leer tampoco produce una barra nueva: no se reescribe lo que no se
    //     puede parsear. Mismo criterio que `vinoDeUnaSalidaConBorrador` y que la rama del `catch` de
    //     `urlDeSalidaAlNavegadorDeLaBilletera`.
    expect(
      hrefSinLaMarcaDeSalida("no-soy-una-url"),
      "un href impareseable produjo una barra nueva, fabricada a partir de algo ilegible",
    ).toBeNull();
    // (e) Y el `?` no queda colgando cuando la marca era el único parámetro: se ve en la barra.
    expect(
      hrefSinLaMarcaDeSalida(`${ORIGEN}/enviar?${PARAM_SALIDA}=${VALOR_SALIDA}`),
      "quedó un `?` colgando en la barra de la persona",
    ).toBe(`${ORIGEN}/enviar`);
  });

  // MUTANTE QUE LO TIENE QUE MATAR: reescribir el prefijo del universal link a mano dentro de
  // `./salida-al-navegador-de-la-billetera.ts` (o cambiarle el `?ref=`) ⇒ deja de coincidir con lo que
  // produce el productor de producción.
  // ⛔ ESTE `it` IMPORTA `phantomBrowseUrl` Y COMPARA CONTRA SU SALIDA. No escribe el prefijo: sería
  // el guard leyéndose a sí mismo, y entonces cambiar los dos lados a la vez lo dejaría verde.
  it("T-372-W1-10: la URL final es byte-idéntica a la que produce `phantomBrowseUrl` sobre el href limpio", () => {
    // (a) Sin nada que limpiar y sin borrador: la salida tiene que ser EXACTAMENTE la de hoy.
    const pelado = `${ORIGEN}/enviar`;
    expect(
      urlDeSalidaAlNavegadorDeLaBilletera({ href: pelado, origin: ORIGEN, hayBorrador: false }),
      "sobre un href sin rastros la salida dejó de ser la de hoy",
    ).toBe(phantomBrowseUrl(pelado, ORIGEN));

    // (b) Con algo que limpiar: el envoltorio sigue siendo el mismo, sobre el href YA limpio. El href
    //     limpio se arma acá con `URL`, que es la misma herramienta que usa el módulo, y ⛔ no se
    //     escribe el prefijo `https://…/ul/browse/` en ninguna parte de este archivo.
    const sucio = `${ORIGEN}/enviar?monto=400&${PARAM_KYC}=${VALOR_VUELTA_KYC}`;
    const esperado = new URL(`${ORIGEN}/enviar`);
    esperado.searchParams.set("monto", "400");
    esperado.searchParams.set(PARAM_SALIDA, VALOR_SALIDA);
    expect(
      urlDeSalidaAlNavegadorDeLaBilletera({ href: sucio, origin: ORIGEN, hayBorrador: true }),
      "el envoltorio dejó de ser el de producción, o la limpieza no produjo el href esperado",
    ).toBe(phantomBrowseUrl(esperado.toString(), ORIGEN));

    // (c) EL HREF QUE NO PARSEA ⇒ el mismo enlace que este repo entrega hoy, ⛔ nunca una URL
    //     inventada. Sin esta fila, una rama que fabricara un destino pasaría sin que nadie la mire.
    const roto = "no-soy-una-url";
    expect(
      urlDeSalidaAlNavegadorDeLaBilletera({ href: roto, origin: ORIGEN, hayBorrador: true }),
      "un href impareseable produjo un destino distinto del que este repo entrega hoy",
    ).toBe(phantomBrowseUrl(roto, ORIGEN));

    // (d) El enlace de instalación apunta a la billetera y no a cualquier lado. ⛔ PROHIBIDO escribir
    //     acá el literal de la URL: se importa la constante y se le lee el hostname, que es el mismo
    //     hostname que produce el productor del universal link.
    expect(
      new URL(URL_INSTALAR_PHANTOM).protocol,
      "el enlace de instalación no es https: mandaría a instalar una billetera por un canal sin cifrar",
    ).toBe("https:");
    expect(
      new URL(URL_INSTALAR_PHANTOM).hostname.split(".")[0],
      "el enlace de instalación no apunta a la misma billetera que el universal link",
    ).toBe(new URL(phantomBrowseUrl(pelado, ORIGEN)).hostname.split(".")[0]);
  });
});
