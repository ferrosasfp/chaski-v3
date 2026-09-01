// WKH-373 — QUÉ INFORMA `formaDelHref`, Y SOBRE TODO QUÉ **NO**.
//
// 🔴 Este renglón es el único que separa la causa raíz de esta HU —que la barra se limpia ANTES de que
// el único lector de la vuelta del depósito la mire— de las otras cuatro hipótesis del mismo copy. Y
// va a una captura de pantalla que el founder manda por chat, así que la mitad que hay que probar con
// la misma dureza que el contenido es la de los SECRETOS: el `data` es el sobre cifrado y la clave
// pública de la billetera es el otro extremo del canal.
import { describe, expect, it } from "vitest";
import { formaDelHref } from "./forma-del-href";
import { CLAVE_EN_RESPUESTA } from "./protocol";

const ORIGEN = "https://chaski.test/enviar";
const DATA = "2Fk9WkH7pJpTz3ZQ5ZC3RnQueEsElSobreCifrado";
const NONCE = "3HqTh8HFEZ6zMbTuxHmYVX";
const CLAVE = "8TB7whSu6PvhWWNQnZRZBpTsCTZKm3Y6y1WVHZE8gWy3";

describe("WKH-373: `formaDelHref`", () => {
  it("T-373-HREF-1: una vuelta COMPLETA sale con los cuatro campos, y ⛔ sin un solo valor adentro", () => {
    const href = `${ORIGEN}?kyc=return&dl=firmar-tx&nonce=${NONCE}&data=${DATA}&${CLAVE_EN_RESPUESTA.phantom}=${CLAVE}`;
    const r = formaDelHref(href);
    expect(r).toBe("dl=firmar-tx nonce=sí data=sí key=sí");
    // ⛔ LOS TRES SECRETOS NO SALIERON. Sin esta mitad, una implementación que devolviera el href
    // entero pasaría el `toBe` de arriba si alguien lo relajara a un `toContain`.
    for (const secreto of [DATA, NONCE, CLAVE]) expect(r, "un valor de la vuelta salió al renglón").not.toContain(secreto);
  });

  // 🔴 LA MITAD QUE DESCRIBE EL DEFECTO: así se ve el href DESPUÉS de `limpiarLaBarra()`. Es el
  // renglón que, en una captura del founder, dice «se lo borramos nosotros» y no «la billetera
  // devolvió otra cosa».
  it("T-373-HREF-2: la barra ya limpiada se distingue de un vistazo", () => {
    expect(formaDelHref(`${ORIGEN}?kyc=return`)).toBe("dl=— nonce=no data=no key=no");
  });

  // ⛔ LA MARCA SE VALIDA CONTRA EL CONJUNTO CERRADO: la escribe cualquiera, así que un valor de fuera
  // NUNCA se pinta. Es el mismo criterio que el bloque de diagnóstico ya aplica al paso del viaje.
  it("T-373-HREF-3: una marca de fuera del vocabulario sale `?`, y ⛔ nunca su texto", () => {
    const r = formaDelHref(`${ORIGEN}?dl=<script>alert(1)</script>`);
    expect(r).toBe("dl=? nonce=no data=no key=no");
    expect(r).not.toContain("script");
  });

  it("T-373-HREF-4: `key=sí` también con la clave de Solflare (las DOS billeteras, del mapa)", () => {
    expect(formaDelHref(`${ORIGEN}?${CLAVE_EN_RESPUESTA.solflare}=${CLAVE}`)).toBe("dl=— nonce=no data=no key=sí");
  });

  // ⛔ «No se pudo leer» NO es «no trae nada»: un href que no parsea no tiene parámetros que informar,
  // y decir `no` a los cuatro sería afirmar que se preguntó. Misma disciplina que el resto del
  // recorrido con `no-pudimos-preguntar`.
  it("T-373-HREF-5: un href que no parsea dice ILEGIBLE con su largo, y ⛔ no finge cuatro `no`", () => {
    expect(formaDelHref("no-es-una-url")).toBe("ILEGIBLE (13 chars)");
    expect(formaDelHref("")).toBe("ILEGIBLE (0 chars)");
  });
});
