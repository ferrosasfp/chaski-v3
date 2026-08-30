// WKH-359 · EL PASO DE LA PRUEBA DE POSESIÓN POR ENLACE.
//
// 🔴 QUÉ SE ESTÁ PROTEGIENDO ACÁ Y QUÉ NO. Los `it` recorren el camino de PRODUCCIÓN de punta a punta
// —abrir el viaje, conectar, anclar el desafío, sacar la URL, fabricar la respuesta de la billetera
// con la clave que el módulo publicó, volver— y **nunca escriben el disco a mano** para llegar al
// estado que van a medir. Un fixture que siembra el resultado final mide el `expect` y no el código.
//
// 🔴 Y UNA DISCIPLINA PROPIA DE ESTE ARCHIVO, que su vecino del nonce NO tiene y lo dice en su propio
// docblock: **el fixture del caso POSITIVO firma con la clave que el viaje declara**. El de
// `conexion.test.ts` firma con un `Keypair.generate()` que no es `viaje.direccion`, y por eso ahí no
// se puede agregar la verificación ed25519 sin re-fabricar siete fixtures. Acá el guard y el fixture
// nacieron juntos a propósito: un caso positivo que no satisface el guard es un guard que el próximo
// que lo vea rojo va a aflojar.
//
// ⚠️ LO QUE ESTE ARCHIVO NO PUEDE CONTESTAR, con las mismas palabras que sus vecinos: los nombres de
// los parámetros del protocolo están escritos a mano de los dos lados, así que si Phantom cambiara
// uno todos estos `it` siguen verdes. Y **nadie corrió el paso `signMessage` del protocolo en un
// teléfono de verdad** ([NC-3] de la HU): esto se prueba con dobles, y ningún verde de acá autoriza
// a decir que funciona en un dispositivo real.
import { beforeEach, describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import type { BilleteraDeeplink } from "./protocol";
import { MARCA, type Almacen } from "./sesion";
import { completarVuelta, iniciarConexion } from "./conexion";
import { DEEPLINK_POP_ALTERADO, DEEPLINK_POP_VENCIDO, DEEPLINK_RECHAZADO, DEEPLINK_TX_ALTERADA, DEEPLINK_VIAJE_VENCIDO } from "./firma-por-enlace";
import {
  MARCA_POP_KYC,
  MARCA_POP_PAYOUT,
  iniciarPop,
  leerPasoPop,
  leerPruebaPop,
  vueltaDelPop,
} from "./pop-por-enlace";

/** Almacén de mentira: un `Map`. Mismo doble que `conexion.test.ts`, a propósito: los dos módulos
 *  hablan con la MISMA interfaz. */
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
/** El `exp` del SERVIDOR, en SEGUNDOS epoch. 10 min después de `AHORA`, como el TTL real. */
const EXP = Math.floor(AHORA / 1000) + 10 * 60;
const REM = "rem-1";
const HREF = "https://chaski.test/enviar?kyc=return";
const APP = "https://chaski.test";
const CLUSTER = "devnet";
const CLAVE_VIAJE = "chaski.billetera.viaje.v1";
const CLAVE_POP = "chaski.billetera.pop.v1";
const DESAFIO = "chaski.test quiere verificar que controlás esta cuenta.\nnonce: abc123\nexp: 1700000600";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.token-opaco-del-servidor";

// ⛔ ESCRITO A MANO A PROPÓSITO, igual que en `conexion.test.ts`: es el oráculo independiente.
// Importarlo de `protocol.ts` movería los dos lados a la vez y ningún `it` lo notaría.
const NOMBRE_DE_LA_CLAVE: Record<BilleteraDeeplink, string> = {
  phantom: "phantom_encryption_public_key",
  solflare: "solflare_encryption_public_key",
};

/** El par de CIFRADO de la billetera (x25519). Nada que ver con el de firma. */
let billeteraReal: nacl.BoxKeyPair;
/** 🔴 El par de FIRMA (ed25519) de la cuenta. Su pública ES la `direccion` del viaje: sin eso, el
 *  caso positivo no podría satisfacer el guard que este archivo existe para medir. */
let cuenta: nacl.SignKeyPair;
let DIRECCION: string;
beforeEach(() => {
  billeteraReal = nacl.box.keyPair();
  cuenta = nacl.sign.keyPair();
  DIRECCION = bs58.encode(cuenta.publicKey);
});

const pedido = (a: Almacen, over: Record<string, unknown> = {}) => ({
  almacen: a,
  ahora: AHORA,
  hrefActual: HREF,
  appUrl: APP,
  ...over,
});

/** La billetera de mentira. ⛔ La clave de la app NO se inventa acá: se lee de la URL que produjo el
 *  módulo, que es lo que hace que el recorrido sea el de producción. */
function respuestaDeLaBilletera(
  cuerpo: unknown,
  publicaDeLaApp: Uint8Array,
  opciones: { billetera?: BilleteraDeeplink; quien?: nacl.BoxKeyPair } = {},
): Record<string, string> {
  const billetera = opciones.billetera ?? "phantom";
  const quien = opciones.quien ?? billeteraReal;
  const secreto = nacl.box.before(publicaDeLaApp, quien.secretKey);
  const nonce = nacl.randomBytes(24);
  const data = nacl.box.after(new TextEncoder().encode(JSON.stringify(cuerpo)), nonce, secreto);
  return {
    [NOMBRE_DE_LA_CLAVE[billetera]]: bs58.encode(quien.publicKey),
    nonce: bs58.encode(nonce),
    data: bs58.encode(data),
  };
}

function hrefDeVuelta(redirectLink: string, params: Record<string, string>): string {
  const u = new URL(redirectLink);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** Deja el viaje CONECTADO por el camino de producción: connect + vuelta del connect. */
function viajeConectado(a: Almacen, billetera: BilleteraDeeplink = "phantom") {
  const { irA } = iniciarConexion({
    almacen: a,
    ahora: AHORA,
    hrefActual: HREF,
    appUrl: APP,
    remittanceId: REM,
    cluster: CLUSTER,
    billetera,
  });
  const q = new URL(irA).searchParams;
  const publicaDeLaApp = bs58.decode(q.get("dapp_encryption_public_key") as string);
  const href = hrefDeVuelta(
    q.get("redirect_link") as string,
    respuestaDeLaBilletera({ public_key: DIRECCION, session: "sess-1" }, publicaDeLaApp, { billetera }),
  );
  const r = completarVuelta({
    almacen: a,
    ahora: AHORA,
    hrefActual: href,
    appUrl: APP,
    remittanceId: REM,
    cluster: CLUSTER,
  });
  if (r.tipo !== "conectado") throw new Error(`el fixture no conectó: ${JSON.stringify(r)}`);
  return { publicaDeLaApp };
}

/** El salto del PoP por el camino de producción. Devuelve la clave que la app publicó EN ESE SALTO. */
function saltoDelPop(
  a: Almacen,
  proposito: typeof MARCA_POP_PAYOUT | typeof MARCA_POP_KYC = MARCA_POP_PAYOUT,
  over: { exp?: number; popMessage?: string; ahora?: number } = {},
) {
  const { irA } = iniciarPop({
    ...pedido(a, { ahora: over.ahora ?? AHORA }),
    proposito,
    popChallenge: TOKEN,
    popMessage: over.popMessage ?? DESAFIO,
    exp: over.exp ?? EXP,
  } as Parameters<typeof iniciarPop>[0]);
  const q = new URL(irA).searchParams;
  return {
    irA,
    q,
    publicaDeLaApp: bs58.decode(q.get("dapp_encryption_public_key") as string),
    redirectLink: q.get("redirect_link") as string,
  };
}

/** Firma `texto` con la cuenta del viaje (la buena) o con la que se le pase (la mala). */
function firmar(texto: string, quien: nacl.SignKeyPair = cuenta): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(texto), quien.secretKey));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// LA IDA — el ancla se escribe ANTES que la URL, y la URL es la del paso `signMessage`
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("`iniciarPop` ancla el desafío y produce la URL del salto", () => {
  // MUTANTE QUE MATA: devolver la URL sin llamar a `guardarPasoPop` ⇒ el disco queda sin ancla y este
  // `it` se pone rojo en el primer `expect`.
  it("escribe el ancla con el desafío ENTERO y salta a `/signMessage` con la marca propia", () => {
    const a = almacenFalso();
    viajeConectado(a);
    // CD-18 — el fixture fabricó el caso: antes del salto NO hay ancla.
    expect(a.datos.get(CLAVE_POP)).toBeUndefined();

    const { irA, redirectLink } = saltoDelPop(a);

    const ancla = leerPasoPop(a, AHORA);
    expect(ancla).not.toBeNull();
    // Los DOS se guardan: el `popMessage` porque es contra esos bytes que se verifica lo que vuelve,
    // y el `popChallenge` porque `prepare` exige el PAR y la firma sola no sirve.
    expect(ancla?.popMessage).toBe(DESAFIO);
    expect(ancla?.popChallenge).toBe(TOKEN);
    expect(ancla?.exp, "la ventana no es la del servidor").toBe(EXP);
    expect(ancla?.direccion, "el ancla no guardó contra qué cuenta verificar").toBe(DIRECCION);
    expect(ancla?.consumido).toBeUndefined();
    expect(ancla?.firma).toBeUndefined();

    expect(new URL(irA).host).toBe("phantom.app");
    expect(new URL(irA).pathname).toBe("/ul/v1/signMessage");
    const vuelta = new URL(redirectLink);
    expect(vuelta.origin).toBe(APP);
    expect(vuelta.searchParams.get(MARCA)).toBe("pop-payout");
    expect(vuelta.searchParams.get("kyc"), "se perdió un parámetro ajeno del origen").toBe("return");
  });

  // MUTANTE QUE MATA: envolver el `guardarPasoPop` de `iniciarPop` en un `try {} catch {}` ⇒ devuelve
  // la URL igual y este `it` se pone rojo. Es el "⛔ No envolver esto en un `try`" del docblock.
  it("TIRA si el disco no acepta el ancla, y NO devuelve ninguna URL", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const roto: Almacen = {
      leer: a.leer,
      escribir: (k, v) => {
        if (k === CLAVE_POP) throw new Error("QuotaExceededError");
        a.escribir(k, v);
      },
      borrar: a.borrar,
    };
    expect(() =>
      iniciarPop({
        almacen: roto,
        ahora: AHORA,
        hrefActual: HREF,
        appUrl: APP,
        proposito: MARCA_POP_PAYOUT,
        popChallenge: TOKEN,
        popMessage: DESAFIO,
        exp: EXP,
      }),
    ).toThrow("QuotaExceededError");
  });

  it("TIRA si el viaje no está conectado: sin canal no se le puede pedir nada a nadie", () => {
    const a = almacenFalso();
    expect(() =>
      iniciarPop({
        almacen: a,
        ahora: AHORA,
        hrefActual: HREF,
        appUrl: APP,
        proposito: MARCA_POP_PAYOUT,
        popChallenge: TOKEN,
        popMessage: DESAFIO,
        exp: EXP,
      }),
    ).toThrow(DEEPLINK_VIAJE_VENCIDO);
    expect(a.datos.get(CLAVE_POP), "ancló igual sobre un viaje que no existe").toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// LA VUELTA — el camino feliz, y que la prueba se entrega UNA vez
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("`vueltaDelPop` verifica la firma y la deja anclada", () => {
  it("camino feliz: firma buena ⇒ `pop-firmado`, y `leerPruebaPop` entrega el PAR", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const { publicaDeLaApp, redirectLink } = saltoDelPop(a);

    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ signature: firmar(DESAFIO) }, publicaDeLaApp),
    );
    expect(vueltaDelPop(pedido(a, { hrefActual: href }))).toEqual({
      tipo: "pop-firmado",
      proposito: MARCA_POP_PAYOUT,
    });

    const prueba = leerPruebaPop(a, AHORA, MARCA_POP_PAYOUT);
    expect(prueba?.popChallenge, "`prepare` exige el PAR: la firma sola no sirve").toBe(TOKEN);
    expect(prueba?.firma).toBe(firmar(DESAFIO));
    expect(prueba?.popMessage).toBe(DESAFIO);
  });

  // MUTANTE QUE MATA: mover el `terminarPasoPop` de `leerPruebaPop` DESPUÉS del `return`, o borrarlo.
  it("CD-15: la prueba se entrega UNA sola vez — la segunda lectura es `null`", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const { publicaDeLaApp, redirectLink } = saltoDelPop(a);
    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ signature: firmar(DESAFIO) }, publicaDeLaApp),
    );
    vueltaDelPop(pedido(a, { hrefActual: href }));

    expect(leerPruebaPop(a, AHORA, MARCA_POP_PAYOUT)).not.toBeNull();
    expect(
      leerPruebaPop(a, AHORA, MARCA_POP_PAYOUT),
      "la prueba se pudo reusar: eso es saltearse un prompt del money-path (CD-5)",
    ).toBeNull();
    expect(a.datos.get(CLAVE_POP), "el ancla sobrevivió a su entrega").toBeUndefined();
  });

  // MUTANTE QUE MATA: escribir el `consumido` DESPUÉS del `return` de `vueltaDelPop` (o sacarlo).
  it("T-067-12: la MISMA URL una segunda vez NO se vuelve a procesar (ancla consumida)", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const { publicaDeLaApp, redirectLink } = saltoDelPop(a);
    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ signature: firmar(DESAFIO) }, publicaDeLaApp),
    );
    expect(vueltaDelPop(pedido(a, { hrefActual: href })).tipo).toBe("pop-firmado");

    // 🔴 ESTO PRUEBA QUE EL FLAG LO ESCRIBIÓ LA VUELTA Y NO UNA ESCRITURA DIRECTA: se lee del disco.
    expect(leerPasoPop(a, AHORA)?.consumido).toBe(true);
    const segunda = vueltaDelPop(pedido(a, { hrefActual: href }));
    expect(segunda).toEqual({ tipo: "corte", causa: DEEPLINK_POP_VENCIDO });
  });

  it("un disco que no deja escribir NO entrega la prueba: `deeplink_sin_memoria`", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const { publicaDeLaApp, redirectLink } = saltoDelPop(a);
    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ signature: firmar(DESAFIO) }, publicaDeLaApp),
    );
    let bloquear = false;
    const roto: Almacen = {
      leer: a.leer,
      escribir: (k, v) => {
        if (bloquear && k === CLAVE_POP) throw new Error("QuotaExceededError");
        a.escribir(k, v);
      },
      borrar: a.borrar,
    };
    bloquear = true;
    expect(vueltaDelPop({ almacen: roto, ahora: AHORA, hrefActual: href, appUrl: APP }).tipo).toBe("corte");
    expect(leerPruebaPop(a, AHORA, MARCA_POP_PAYOUT)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-067-7 (AC-4) — LA FIRMA QUE NO VERIFICA
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-067-7 (AC-4): una firma que no verifica corta con causa PROPIA", () => {
  // 🔴 MUTANTE QUE MATA: borrar la llamada a `verificaPop` en `vueltaDelPop` (o hacerla devolver
  // `true` siempre) ⇒ la firma de otra cuenta pasa como buena. Es exactamente el hueco que
  // `vueltaDelNonce` tiene DECLARADO y que acá no se puede dejar abierto, porque después de este
  // punto nadie más rechaza.
  it("firmada por OTRA cuenta ⇒ `deeplink_pop_alterado`, y no se entrega ninguna prueba", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const { publicaDeLaApp, redirectLink } = saltoDelPop(a);

    const impostor = nacl.sign.keyPair();
    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ signature: firmar(DESAFIO, impostor) }, publicaDeLaApp),
    );
    expect(vueltaDelPop(pedido(a, { hrefActual: href }))).toEqual({
      tipo: "corte",
      causa: DEEPLINK_POP_ALTERADO,
    });
    expect(leerPruebaPop(a, AHORA, MARCA_POP_PAYOUT)).toBeNull();
  });

  it("firma válida pero sobre OTRO texto ⇒ `deeplink_pop_alterado` (el chequeo 5, por criptografía)", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const { publicaDeLaApp, redirectLink } = saltoDelPop(a);

    // La cuenta correcta firmando el desafío de OTRA sesión. Es el canal cruzado, no un ataque.
    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ signature: firmar(`${DESAFIO} y una coma de más`) }, publicaDeLaApp),
    );
    expect(vueltaDelPop(pedido(a, { hrefActual: href })).tipo).toBe("corte");
    expect(leerPruebaPop(a, AHORA, MARCA_POP_PAYOUT)).toBeNull();
  });

  it("una firma ilegible se trata igual que una que no verifica, y NO tira", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const { publicaDeLaApp, redirectLink } = saltoDelPop(a);
    for (const basura of ["", "no-es-base58-!!!", bs58.encode(new Uint8Array(10))]) {
      const href = hrefDeVuelta(redirectLink, respuestaDeLaBilletera({ signature: basura }, publicaDeLaApp));
      expect(() => vueltaDelPop(pedido(a, { hrefActual: href }))).not.toThrow();
      expect(vueltaDelPop(pedido(a, { hrefActual: href })).tipo).toBe("corte");
    }
  });

  // 🔴 LA MITAD DEL AC QUE SE OLVIDA: "distinguible de `deeplink_rechazado` y de
  // `deeplink_tx_alterada`". Sin esto, colapsar las tres en una sola causa daría verde arriba.
  it("la causa es DISTINTA de `deeplink_rechazado` y de `deeplink_tx_alterada`", () => {
    expect(DEEPLINK_POP_ALTERADO).not.toBe(DEEPLINK_RECHAZADO);
    expect(DEEPLINK_POP_ALTERADO).not.toBe(DEEPLINK_TX_ALTERADA);
    // Y el rechazo explícito de la billetera SIGUE saliendo como rechazo, no como alteración: si no,
    // la persona leería "algo no coincide" cuando lo que hizo fue apretar «Cancelar».
    const a = almacenFalso();
    viajeConectado(a);
    const { redirectLink } = saltoDelPop(a);
    const href = hrefDeVuelta(redirectLink, { errorCode: "-32603", errorMessage: "User rejected" });
    expect(vueltaDelPop(pedido(a, { hrefActual: href }))).toEqual({
      tipo: "corte",
      causa: DEEPLINK_RECHAZADO,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-067-8 (AC-4) — TRAS EL CORTE NO SE AVANZA Y NO SE PIDE OTRA FIRMA
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-067-8 (AC-4): después del corte, las invocaciones 2 y 3 dan lo mismo", () => {
  // MUTANTE QUE MATA: marcar el ancla como consumida (o borrarla) en la rama del corte ⇒ la
  // invocación 2 cambiaría de causa, que es la definición de un estado que se va corriendo.
  it("el mismo corte, tres veces, y NUNCA una prueba entregable", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const { publicaDeLaApp, redirectLink } = saltoDelPop(a);
    const impostor = nacl.sign.keyPair();
    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ signature: firmar(DESAFIO, impostor) }, publicaDeLaApp),
    );

    const uno = vueltaDelPop(pedido(a, { hrefActual: href }));
    const dos = vueltaDelPop(pedido(a, { hrefActual: href }));
    const tres = vueltaDelPop(pedido(a, { hrefActual: href }));
    expect(uno).toEqual({ tipo: "corte", causa: DEEPLINK_POP_ALTERADO });
    expect(dos, "la invocación 2 no dio el mismo corte: el estado se está corriendo solo").toEqual(uno);
    expect(tres).toEqual(uno);
    expect(leerPruebaPop(a, AHORA, MARCA_POP_PAYOUT)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-067-17 (CD-15 / CD-5) — UN SOLO PROPÓSITO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-067-17 (CD-15): el ancla es de UN solo propósito", () => {
  // MUTANTE QUE MATA: borrar el `if (ancla.proposito !== proposito) return null;` de `leerPruebaPop`.
  it("un permiso del KYC NO satisface un pedido del payout, ni al revés", () => {
    for (const [sacado, pedido_] of [
      [MARCA_POP_KYC, MARCA_POP_PAYOUT],
      [MARCA_POP_PAYOUT, MARCA_POP_KYC],
    ] as const) {
      const a = almacenFalso();
      viajeConectado(a);
      const { publicaDeLaApp, redirectLink } = saltoDelPop(a, sacado);
      const href = hrefDeVuelta(
        redirectLink,
        respuestaDeLaBilletera({ signature: firmar(DESAFIO) }, publicaDeLaApp),
      );
      expect(vueltaDelPop(pedido(a, { hrefActual: href })).tipo).toBe("pop-firmado");

      expect(
        leerPruebaPop(a, AHORA, pedido_),
        `un permiso de \`${sacado}\` autorizó un pedido de \`${pedido_}\`: eso es reusar una prueba ` +
          "para saltearse un prompt del money-path (CD-5)",
      ).toBeNull();
      // Refutación del instrumento: con el propósito CORRECTO sí la entrega. Sin esto, un
      // `leerPruebaPop` que devolviera `null` siempre daría verde arriba sin vigilar nada.
      expect(leerPruebaPop(a, AHORA, sacado)).not.toBeNull();
    }
  });

  it("el pedido del otro propósito NO borra el ancla en curso", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const { publicaDeLaApp, redirectLink } = saltoDelPop(a, MARCA_POP_KYC);
    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ signature: firmar(DESAFIO) }, publicaDeLaApp),
    );
    vueltaDelPop(pedido(a, { hrefActual: href }));

    leerPruebaPop(a, AHORA, MARCA_POP_PAYOUT); // el pedido "equivocado"
    expect(
      leerPruebaPop(a, AHORA, MARCA_POP_KYC),
      "pedir el PoP del payout canceló el del KYC que ya estaba conseguido",
    ).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-067-18 (DT-10 / CD-5) — LA VENTANA ES EL `exp` DEL SERVIDOR
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-067-18 (DT-10): la ventana la fija el `exp` del servidor, no un reloj de acá", () => {
  // 🔴 MUTANTE QUE MATA: cambiar la ventana de `leerPasoPop` a `MAX_EDAD_MS` (20 min desde `desde`).
  // Con este fixture —`desde` RECIENTE (1 minuto) y `exp` YA VENCIDO— el ancla sobreviviría, llegaría
  // al `prepare` y volvería 403 `payout_pop_unverified`: el diagnóstico de una falsificación para un
  // simple vencimiento. Ése es el bug entero que DT-10 cierra, y este fixture es el único que lo ve.
  it("`exp` vencido con `desde` RECIENTE ⇒ el ancla no sirve, aunque `MAX_EDAD_MS` la dejaría viva", () => {
    const a = almacenFalso();
    viajeConectado(a);
    // Se ancla con un `exp` que vence 5 minutos después de anclarlo...
    saltoDelPop(a, MARCA_POP_PAYOUT, { exp: Math.floor(AHORA / 1000) + 5 * 60 });
    // ...y se lee 6 minutos más tarde. `desde` tiene 6 min de edad: MUY dentro de los 20 de
    // `MAX_EDAD_MS`, y sin embargo el desafío ya está muerto.
    const seisMinutosDespues = AHORA + 6 * 60 * 1000;
    expect(leerPasoPop(a, seisMinutosDespues)).toBeNull();
    expect(leerPruebaPop(a, seisMinutosDespues, MARCA_POP_PAYOUT)).toBeNull();
    // Refutación del fixture: a los 4 minutos —antes del `exp`— el ancla SÍ está viva. Sin esto, un
    // `leerPasoPop` que devolviera `null` siempre daría verde arriba.
    const a2 = almacenFalso();
    viajeConectado(a2);
    saltoDelPop(a2, MARCA_POP_PAYOUT, { exp: Math.floor(AHORA / 1000) + 5 * 60 });
    expect(leerPasoPop(a2, AHORA + 4 * 60 * 1000)).not.toBeNull();
  });

  it("la vuelta con el `exp` vencido corta con `deeplink_pop_vencido`, no con `_alterado`", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const { publicaDeLaApp, redirectLink } = saltoDelPop(a, MARCA_POP_PAYOUT, {
      exp: Math.floor(AHORA / 1000) + 5 * 60,
    });
    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ signature: firmar(DESAFIO) }, publicaDeLaApp),
    );
    expect(vueltaDelPop({ almacen: a, ahora: AHORA + 6 * 60 * 1000, hrefActual: href, appUrl: APP })).toEqual({
      tipo: "corte",
      causa: DEEPLINK_POP_VENCIDO,
    });
  });

  // ══ WKH-075 · ADDENDUM DEL RELOJ · testigo I (PoP) ═══════════════════════════════════════════════
  //
  // 🔴 ESTE `it` YA EXISTÍA Y AFIRMABA QUE EL ANCLA «SE LIMPIA». Lo que borraba era un `PasoPop` con la
  // `firma` del PoP YA DADA adentro (`firma`, `./pop-por-enlace.ts:136`), y el disparador no es un
  // atacante: `Date.now()` es reloj de pared y una corrección NTP hacia atrás mientras la persona está
  // en la billetera produce exactamente este estado. El retorno SIGUE siendo `null` —esta función no
  // gana forma nueva y eso también se afirma acá— y lo que cambia es que ⛔ ya no destruye.
  //
  // ⛔ EL RETROCESO SE EXPRESA CON `ahora` POR PARÁMETRO: `leerPasoPop` recibe el instante
  // (`leerPasoPop`, `./pop-por-enlace.ts:189`), así que son dos llamadas con `ahora` decreciente. Nada
  // depende del reloj del runner.
  // MUTANTE QUE MATA: devolverle el `terminarPasoPop(a)` a la rama del futuro ⇒ `expected undefined to
  //   be defined` en el `expect` del disco. ⚠️ El vecino NO lo puede matar: la otra mitad del `if` es
  //   `ahora / 1000 >= x.exp`, y con `ahora` 60 s ANTES de `desde` el `exp` está lejísimos de vencer,
  //   así que un rojo acá sólo puede venir de esta rama.
  it("T-075-RELOJ-I-POP · un ancla del FUTURO no se entrega, y ⛔ NO SE BORRA (la firma vive adentro)", () => {
    const a = almacenFalso();
    viajeConectado(a);
    saltoDelPop(a, MARCA_POP_PAYOUT, { ahora: AHORA });
    const antes = a.datos.get(CLAVE_POP);
    // Se lee con un `ahora` ANTERIOR al `desde` del ancla: el reloj retrocedió un minuto.
    expect(leerPasoPop(a, AHORA - 60_000), "la forma del retorno cambió: sigue siendo `null`").toBeNull();
    expect(a.datos.get(CLAVE_POP), "el guard de futuro borró un ancla que puede tener la firma del PoP adentro").toBe(antes);
    expect(a.borrados, "una LECTURA no destruye lo que no entrega").toBe(0);
    // Y en cuanto el reloj vuelve a pasar su `desde`, la MISMA ancla vuelve a servir.
    expect(leerPasoPop(a, AHORA)).not.toBeNull();
  });

  it("T-075-RELOJ-I-POP-J · CONTROL NEGATIVO: con retroceso CERO el ancla se entrega igual que siempre", () => {
    // ⛔ Sin esto, un `leerPasoPop` roto que devolviera `null` siempre dejaría verde al `it` de arriba.
    const a = almacenFalso();
    viajeConectado(a);
    saltoDelPop(a, MARCA_POP_PAYOUT, { ahora: AHORA });
    expect(leerPasoPop(a, AHORA)).not.toBeNull();
    expect(a.borrados).toBe(0);
  });

  it("basura en el disco no tira, devuelve `null`, y LIMPIA", () => {
    const a = almacenFalso();
    a.escribir(CLAVE_POP, "{esto no es json");
    expect(() => leerPasoPop(a, AHORA)).not.toThrow();
    expect(leerPasoPop(a, AHORA)).toBeNull();
    expect(a.datos.get(CLAVE_POP)).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// EL ANCLA WRITE-ONCE DEL CANAL (chequeo 4) Y LA PUREZA DEL MÓDULO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("el chequeo 4: la respuesta tiene que venir de la MISMA clave que contestó el connect", () => {
  // MUTANTE QUE MATA: borrar la comparación contra `viaje.claveBilletera`.
  it("un sobre de OTRA clave de billetera ⇒ `deeplink_pop_alterado`", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const { publicaDeLaApp, redirectLink } = saltoDelPop(a);
    const otra = nacl.box.keyPair();
    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ signature: firmar(DESAFIO) }, publicaDeLaApp, { quien: otra }),
    );
    expect(vueltaDelPop(pedido(a, { hrefActual: href }))).toEqual({
      tipo: "corte",
      causa: DEEPLINK_POP_ALTERADO,
    });
  });

  it("sin viaje en el disco la vuelta corta y no entrega nada", () => {
    const a = almacenFalso();
    viajeConectado(a);
    const { publicaDeLaApp, redirectLink } = saltoDelPop(a);
    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ signature: firmar(DESAFIO) }, publicaDeLaApp),
    );
    a.datos.delete(CLAVE_VIAJE);
    expect(vueltaDelPop(pedido(a, { hrefActual: href }))).toEqual({
      tipo: "corte",
      causa: DEEPLINK_VIAJE_VENCIDO,
    });
  });
});
