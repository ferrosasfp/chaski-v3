// Tests — la sesión de posesión server-only (WKH-372 / W3.1).
//
// 🔴 LOS TRES `it` DE ESTE ARCHIVO MIDEN LAS TRES COSAS DE LAS QUE CUELGA LA SEGURIDAD DEL MÓDULO:
// que el secreto es PROPIO (`T-372-W3-9`), que el HMAC es un HMAC de verdad y no un adorno
// (`T-372-W3-14`), y que el cluster está atado a lo que resuelve el servidor (`T-372-W3-15`).
//
// ⛔ LOS TRES LLEVAN SU MITAD POSITIVA, y no es cortesía: un verificador que devolviera `null`
// SIEMPRE pasaría las tres mitades negativas sin despeinarse. Sin la mitad positiva, este archivo
// mediría que el módulo sabe decir que no, que es exactamente lo que un módulo roto también sabe.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSolanaNetworkId } from "../chain";
import {
  SESION_TIPO,
  SESION_TTL_SECONDS,
  emitirSesionDePosesion,
  verificarSesionDePosesion,
} from "./sesion-de-posesion";

const DIRECCION = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // base58 devnet válida
const AHORA = Date.parse("2026-08-31T12:00:00.000Z");
// ⛔ LOS DOS SECRETOS SON DISTINTOS A PROPÓSITO. Con el mismo valor, el `it` del secreto propio no
// distinguiría NADA: un módulo que leyera la env equivocada daría exactamente el mismo verde.
const SECRETO_SESION = "secreto-de-la-sesion-w3";
const SECRETO_POP = "secreto-del-desafio-pop";

/** El emisor de referencia del `it` del CAIP-2: firma con el MISMO algoritmo y el MISMO formato que el
 *  módulo, pero deja el `networkId` como parámetro. ⛔ No se escribe un token a mano: se ACUÑA, así el
 *  único campo que cambia entre la mitad positiva y la negativa es el que el `it` dice medir. */
function acunarCon(networkId: string, clave: string, exp: number): string {
  const payloadB64 = Buffer.from(
    JSON.stringify({ tipo: SESION_TIPO, address: DIRECCION, networkId, exp }),
    "utf8",
  ).toString("base64url");
  return `${payloadB64}.${createHmac("sha256", clave).update(payloadB64).digest("base64url")}`;
}

beforeEach(() => {
  vi.stubEnv("PAYOUT_SESSION_SECRET", SECRETO_SESION);
  vi.stubEnv("PAYOUT_POP_SECRET", SECRETO_POP);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · EL SECRETO ES PROPIO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W3.1 · la sesión tiene secreto propio", () => {
  // MUTANTE QUE LO TIENE QUE MATAR: en `./sesion-de-posesion.ts`, que `secret()` caiga a
  // `PAYOUT_POP_SECRET` — o sea `process.env.PAYOUT_SESSION_SECRET || process.env.PAYOUT_POP_SECRET`.
  // Con el mutante, la mitad (b) de este `it` emite un token y deja de ser `null`.
  // ⛔ FALSO KILLED A EVITAR: un `it` que pusiera las DOS envs con el MISMO valor no distinguiría
  // nada. Por eso `SECRETO_SESION !== SECRETO_POP`, y por eso la mitad (c) lo verifica explícito.
  it("T-372-W3-9: con SÓLO `PAYOUT_POP_SECRET` puesta, `emitir` y `verificar` devuelven null", () => {
    // (a) MITAD POSITIVA. Sin esto, un módulo que devolviera `null` siempre daría verde abajo.
    const vivo = emitirSesionDePosesion(DIRECCION, resolveSolanaNetworkId(), AHORA);
    expect(vivo, "con su propia env el emisor no acuña nada: el módulo no hace nada").not.toBe(null);
    expect(verificarSesionDePosesion(vivo as string, AHORA)?.address, "no verifica su propio token").toBe(
      DIRECCION,
    );

    // (b) LA MITAD QUE IMPORTA: se apaga SÓLO la env de la sesión y queda la del desafío.
    vi.stubEnv("PAYOUT_SESSION_SECRET", "");
    expect(
      emitirSesionDePosesion(DIRECCION, resolveSolanaNetworkId(), AHORA),
      "el emisor acuñó una sesión leyendo `PAYOUT_POP_SECRET`: cualquier anónimo se emite una",
    ).toBe(null);
    expect(
      verificarSesionDePosesion(vivo as string, AHORA),
      "el verificador aceptó una sesión leyendo `PAYOUT_POP_SECRET`",
    ).toBe(null);

    // (c) Y UN TOKEN FIRMADO CON EL SECRETO DEL DESAFÍO NO VALE COMO SESIÓN, con la env de la sesión
    //     puesta. Es el caso real: quien tiene el secreto del PoP no puede acuñar sesiones.
    vi.stubEnv("PAYOUT_SESSION_SECRET", SECRETO_SESION);
    expect(
      verificarSesionDePosesion(
        acunarCon(resolveSolanaNetworkId(), SECRETO_POP, Math.floor(AHORA / 1000) + 600),
        AHORA,
      ),
      "un token firmado con el secreto del DESAFÍO pasó como sesión: los dos secretos son el mismo",
    ).toBe(null);
    expect(SECRETO_SESION, "los dos secretos de este archivo son iguales: no mide nada").not.toBe(
      SECRETO_POP,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · EL HMAC ES UN HMAC
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W3.1 · el round-trip y las dos adulteraciones", () => {
  // MUTANTES QUE LO TIENEN QUE MATAR, y se corren POR SEPARADO:
  //   (i)  comparar el MAC con `===` en vez de `timingSafeEqual` ⇒ dos `Buffer` distintos nunca son
  //        `===`, así que la mitad POSITIVA (el round-trip) se cae. Sin esa mitad, el mutante
  //        sobrevive: las tres mitades negativas seguirían dando `null`.
  //   (ii) quitar `esperado.length !== recibido.length` ⇒ `timingSafeEqual` TIRA con buffers de
  //        distinta longitud, y la mitad del MAC TRUNCADO deja de devolver `null` y explota.
  it("T-372-W3-14: round-trip completo; un byte cambiado en el MAC o en el payload ⇒ null", () => {
    const token = emitirSesionDePosesion(DIRECCION, resolveSolanaNetworkId(), AHORA) as string;

    // (a) LOS CUATRO CAMPOS, y el `exp` derivado del TTL, no de un número escrito acá.
    const sesion = verificarSesionDePosesion(token, AHORA);
    expect(sesion, "el round-trip no cierra").not.toBe(null);
    expect(sesion).toEqual({
      tipo: SESION_TIPO,
      address: DIRECCION,
      networkId: resolveSolanaNetworkId(),
      exp: Math.floor(AHORA / 1000) + SESION_TTL_SECONDS,
    });

    const [payloadB64, macB64] = token.split(".");
    // Fail-loud y no un default: si el emisor dejara de producir dos partes, el resto de este `it`
    // mediría strings vacíos y daría verde. ⛔ Un `?? ""` acá sería justamente eso.
    if (!payloadB64 || !macB64) throw new Error("el emisor no produjo un token de dos partes");
    // (b) UN BYTE CAMBIADO EN EL MAC, mismo largo ⇒ muere en `timingSafeEqual`.
    const otroChar = macB64[0] === "A" ? "B" : "A";
    expect(
      verificarSesionDePosesion(`${payloadB64}.${otroChar}${macB64.slice(1)}`, AHORA),
      "un MAC adulterado pasó: el HMAC no se está comparando",
    ).toBe(null);
    // (c) EL MAC TRUNCADO ⇒ tiene que morir en el chequeo de LONGITUD, y ⛔ NO en una excepción. Las
    //     dos mitades son necesarias: sin `.not.toThrow()`, el mutante que borra el chequeo mata este
    //     `it` con un `TypeError` crudo de `node:crypto` en vez de con una aserción NOMBRADA, y un
    //     rojo sin nombre no dice qué propiedad se rompió.
    const truncado = () => verificarSesionDePosesion(`${payloadB64}.${macB64.slice(0, -4)}`, AHORA);
    expect(truncado, "un MAC de otra longitud hizo TIRAR a `timingSafeEqual`: falta el chequeo de largo").not.toThrow();
    expect(truncado(), "un MAC de otra longitud no cortó").toBe(null);
    // (d) EL PAYLOAD CAMBIADO (otra dirección) con el MAC original ⇒ el HMAC ya no cierra.
    const payloadAjeno = Buffer.from(
      JSON.stringify({
        tipo: SESION_TIPO,
        address: "So11111111111111111111111111111111111111112",
        networkId: resolveSolanaNetworkId(),
        exp: Math.floor(AHORA / 1000) + SESION_TTL_SECONDS,
      }),
      "utf8",
    ).toString("base64url");
    expect(
      verificarSesionDePosesion(`${payloadAjeno}.${macB64}`, AHORA),
      "se cambió la dirección del payload y el token siguió valiendo",
    ).toBe(null);
    // (e) Y VENCER ES `null`, no una excepción: el caller vuelve a pedir la firma, como hoy.
    expect(
      verificarSesionDePosesion(token, AHORA + SESION_TTL_SECONDS * 1000),
      "una sesión vencida siguió valiendo",
    ).toBe(null);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · EL CLUSTER LO RESUELVE EL SERVIDOR
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W3.1 · el `networkId` se compara contra el resuelto server-side", () => {
  // MUTANTE QUE LO TIENE QUE MATAR: en `./sesion-de-posesion.ts`, aflojar la comparación del
  // `networkId` a un chequeo de tipo (`typeof networkId !== "string" || !networkId.trim()`), o sea
  // aceptar cualquiera ⇒ la mitad (b) deja de devolver `null`.
  // ⛔ ESTE `it` NO ESCRIBE `"solana:devnet"` EN NINGÚN LADO: importa `resolveSolanaNetworkId`. Un
  // literal copiado acá volvería el guard un espejo el día que el cluster cambie.
  it("T-372-W3-15: un token de OTRO cluster no verifica, y el del cluster resuelto sí", () => {
    const exp = Math.floor(AHORA / 1000) + 600;
    const propio = resolveSolanaNetworkId();
    // (a) MITAD POSITIVA: el cluster que el servidor resuelve, verificado.
    expect(
      verificarSesionDePosesion(acunarCon(propio, SECRETO_SESION, exp), AHORA)?.networkId,
      "el token del cluster propio no verifica: este `it` no puede decir que sí",
    ).toBe(propio);
    // (b) LA MITAD QUE IMPORTA: otro cluster, firmado con el secreto CORRECTO ⇒ igual muere.
    const ajeno = `${propio}-de-otro-cluster`;
    expect(ajeno, "el cluster ajeno de este `it` es el mismo que el propio").not.toBe(propio);
    expect(
      verificarSesionDePosesion(acunarCon(ajeno, SECRETO_SESION, exp), AHORA),
      "un token de otro cluster verificó: el binding CAIP-2 no existe",
    ).toBe(null);
  });
});
