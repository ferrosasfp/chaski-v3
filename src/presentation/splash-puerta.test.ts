// Tests · HU-066 · la puerta del splash.
//
// 🔴 QUÉ VIGILAN Y POR QUÉ SON ESTOS. El defecto que esta HU puede introducir no es "el splash se ve
// feo": es **el splash tapando el aterrizaje de un KYC ya pagado o de una vuelta de billetera**. Los
// dos recorridos vuelven con una recarga de página completa, así que el splash y el aterrizaje pelean
// por el MISMO montaje. Por eso lo primero que se prueba no es que el splash aparezca: es que NO
// aparezca en los cuatro caminos de vuelta, más el quinto (no se pudo preguntar).
//
// ⛔ Y LAS CLAVES NO SE ESCRIBEN A MANO EN ESTE ARCHIVO. Se importan de los MISMOS módulos que las
// escriben, así que si mañana `chaski.kyc.pending.v1` pasa a `.v2` en su productor, esta suite sigue
// midiendo la clave verdadera en vez de quedar verde sobre una vieja. Lo que sí se escribe a mano es
// el ORDEN de precedencia y el conjunto de motivos, que son la decisión de esta HU.
//
// LOS MUTANTES SE APLICARON Y SE MIDIERON, uno por uno, sobre el árbol de esta rama. No es una lista
// de lo que "debería" fallar: es la salida de correrlos (el archivo tiene 12 tests):
//   · la puerta mira SÓLO la URL (se borran las dos lecturas de disco)   ⇒ 4 failed |  8 passed (12)
//   · la puerta mira SÓLO el disco (se borran las dos señales de URL)    ⇒ 2 failed | 10 passed (12)
//   · el `catch` del disco devuelve `null` en vez de `"disco-ilegible"`  ⇒ 1 failed | 11 passed (12)
//   · `params.has(MARCA)` pasa a comparar contra un paso fijo            ⇒ 3 failed |  9 passed (12)
// El primero es el que importa: es la versión "fácil" de esta puerta —mirar sólo la barra de
// direcciones— y se lleva puestos cuatro tests, los dos de disco más los dos de precedencia.
import { describe, expect, it } from "vitest";
import { CLAVE_KYC_PENDIENTE } from "../infrastructure/kyc-pending-store";
import { CLAVE as CLAVE_DEL_VIAJE, MARCA } from "../infrastructure/solana/deeplink/sesion";
import {
  motivoParaNoMostrar,
  PARAM_KYC,
  urlDeVueltaDeKyc,
  VALOR_VUELTA_KYC,
  volvioPorLaVueltaDeKyc,
  type MotivoParaNoMostrar,
} from "./splash-puerta";

const LIMPIA = "https://chaski.test/";

/** Un disco de mentira. `vacio` es el caso base: la app abierta a mano, sin nada pendiente. */
function disco(entradas: Record<string, string> = {}) {
  return (k: string) => entradas[k] ?? null;
}

/** Un disco que NO se deja leer (modo privado, cuota, un getter que tira). */
const discoRoto = () => {
  throw new Error("SecurityError");
};

describe("HU-066 · la puerta deja pasar el splash sólo cuando no hay nada que atender", () => {
  it("app abierta a mano, URL limpia y disco vacío ⇒ no hay motivo (se muestra)", () => {
    // EL CONTROL, y va primero: sin él, una puerta que devolviera un motivo SIEMPRE pasaría los seis
    // tests de abajo y el splash no se vería nunca. Un candado que sólo prueba el "no" no distingue
    // "cierra bien" de "no abre nunca".
    expect(motivoParaNoMostrar({ href: LIMPIA, leer: disco() })).toBeNull();
  });

  it("la URL de vuelta de Didit ⇒ no se muestra, y la URL la ARMA el mismo módulo", () => {
    // 🔴 LA MITAD QUE IMPORTA ES LA SEGUNDA. El href no se escribe a mano acá: se lo pide a
    // `urlDeVueltaDeKyc`, que es la MISMA función con la que `flow.tsx` arma el callback que le pasa a
    // Didit. Si alguien cambia el parámetro en un solo lado, este test se pone rojo; con el literal
    // escrito a mano se habría quedado verde midiendo un parámetro que ya nadie manda.
    const href = urlDeVueltaDeKyc("https://chaski.test");
    expect(href).toContain(`${PARAM_KYC}=${VALOR_VUELTA_KYC}`);
    expect(motivoParaNoMostrar({ href, leer: disco() })).toBe("vuelta-de-kyc-en-la-url");
  });

  it.each(["conectar", "firmar-tx", "crear-nonce", "una-marca-que-nadie-escribio"])(
    "la marca de vuelta por enlace `%s` ⇒ no se muestra",
    (paso) => {
      // Las cuatro con el MISMO resultado, incluida la que este repo no escribe: la puerta no valida
      // contra el conjunto cerrado de pasos a propósito. Cualquier marca nuestra en la barra significa
      // "volvimos de un salto", y frente a la duda no se pinta encima. Es la misma dirección
      // fail-closed que el resto del archivo.
      const href = `${LIMPIA}?${MARCA}=${paso}`;
      expect(motivoParaNoMostrar({ href, leer: disco() })).toBe("vuelta-por-enlace-en-la-url");
    },
  );

  it("🔴 URL LIMPIA pero KYC pendiente en el disco ⇒ no se muestra", () => {
    // ESTE ES EL AGUJERO QUE UNA PUERTA "MIRO LA URL" DEJA ABIERTA, y no es hipotético: el resume del
    // KYC NO se dispara con `?kyc=return`, se dispara con esta clave. Volver con el botón «atrás»,
    // recargar, o que el callback se pierda deja la URL limpia y el resume corriendo igual.
    expect(motivoParaNoMostrar({ href: LIMPIA, leer: disco({ [CLAVE_KYC_PENDIENTE]: "{}" }) })).toBe(
      "kyc-pendiente-en-el-disco",
    );
  });

  it("🔴 URL LIMPIA pero viaje de billetera en el disco ⇒ no se muestra", () => {
    // El gemelo del de arriba para el otro recorrido: `useVueltaPorEnlace` sale temprano si no hay
    // viaje guardado, o sea que el viaje —y no la marca— es la condición.
    expect(motivoParaNoMostrar({ href: LIMPIA, leer: disco({ [CLAVE_DEL_VIAJE]: "{}" }) })).toBe(
      "viaje-de-billetera-en-el-disco",
    );
  });

  it("un disco que no se deja leer NO se lee como «no hay nada»", () => {
    // "No pude preguntar" no es "no". Con un booleano este caso habría caído del lado de mostrar.
    expect(motivoParaNoMostrar({ href: LIMPIA, leer: discoRoto })).toBe("disco-ilegible");
  });

  it("un href que no parsea tampoco se lee como «no hay nada»", () => {
    expect(motivoParaNoMostrar({ href: "no soy una url", leer: disco() })).toBe("disco-ilegible");
  });

  it("las dos claves que mira son EXACTAMENTE las que escriben sus productores", () => {
    // El candado contra la copia: si alguien reescribe los literales adentro de la puerta, estos dos
    // discos dejan de coincidir con lo que mira y los dos `it` de arriba caen.
    expect(CLAVE_KYC_PENDIENTE).toBe("chaski.kyc.pending.v1");
    expect(CLAVE_DEL_VIAJE).toBe("chaski.billetera.viaje.v1");
    expect(MARCA).toBe("dl");
  });

  it("la precedencia está fijada: la URL contesta antes que el disco", () => {
    // No cambia la decisión (los dos casos no muestran el splash), pero SÍ el motivo que se publica en
    // el DOM y que la medición en el navegador lee. Que sea estable es lo que hace que esa evidencia
    // signifique algo.
    const motivos: MotivoParaNoMostrar[] = [];
    motivos.push(
      motivoParaNoMostrar({
        href: urlDeVueltaDeKyc("https://chaski.test"),
        leer: disco({ [CLAVE_KYC_PENDIENTE]: "{}", [CLAVE_DEL_VIAJE]: "{}" }),
      }) as MotivoParaNoMostrar,
    );
    motivos.push(
      motivoParaNoMostrar({
        href: LIMPIA,
        leer: disco({ [CLAVE_KYC_PENDIENTE]: "{}", [CLAVE_DEL_VIAJE]: "{}" }),
      }) as MotivoParaNoMostrar,
    );
    expect(motivos).toEqual(["vuelta-de-kyc-en-la-url", "kyc-pendiente-en-el-disco"]);
  });
});

// ── HU 073 / AC-5 · `volvioPorLaVueltaDeKyc` ──────────────────────────────────────────────────────
//
// ⛔ El parámetro NO se escribe a mano en ningún assert de acá: se arma con las dos constantes que usa
// el único productor de esa URL. Si mañana el callback cambia, esta suite mide el valor verdadero en
// vez de quedar verde sobre uno viejo.
describe("HU 073 / AC-5 · reconocer la vuelta del verificador, con TRES valores y no dos", () => {
  it("con la marca que escribe `urlDeVueltaDeKyc` ⇒ true", () => {
    expect(volvioPorLaVueltaDeKyc(urlDeVueltaDeKyc("https://chaski.test"))).toBe(true);
  });

  it("con el parámetro armado a partir de las constantes ⇒ true, y con otro valor ⇒ false", () => {
    expect(volvioPorLaVueltaDeKyc(`${LIMPIA}?${PARAM_KYC}=${VALOR_VUELTA_KYC}`)).toBe(true);
    // 🧬 MUTANTE: comparar con `params.has(PARAM_KYC)` en vez del VALOR ⇒ esto se pone rojo. La
    // diferencia importa: `?kyc=cualquier-cosa` no es una vuelta nuestra.
    expect(volvioPorLaVueltaDeKyc(`${LIMPIA}?${PARAM_KYC}=otra-cosa`)).toBe(false);
  });

  it("sin el parámetro ⇒ false, y ⛔ ese `false` NO significa «no volvió»", () => {
    // El `false` es «no hay marca». La app no puede distinguir «abrió la app a mano» de «volvió del
    // verificador y un redirect intermedio se comió el parámetro», y por eso la Ola A ⛔ no escribe
    // NINGUNA frase a partir de este valor. El candado de que no la escribe es `T-073-5`, en
    // `flow.test.tsx`: los dos montajes tienen que leer IGUAL.
    expect(volvioPorLaVueltaDeKyc(LIMPIA)).toBe(false);
  });

  it("un href que no parsea ⇒ false, sin tirar", () => {
    expect(volvioPorLaVueltaDeKyc("no-soy-una-url")).toBe(false);
  });
});
