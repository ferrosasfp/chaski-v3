// WKH-358 / OLA 4 · LA PATA `CONECTAR` DEL RECORRIDO POR ENLACE.
//
// 🔴 QUÉ SE ESTÁ PROTEGIENDO ACÁ Y QUÉ NO. Este archivo mide el módulo que abre el viaje y que lee la
// vuelta del connect. Los `it` recorren el camino de PRODUCCIÓN de punta a punta —abrir el viaje,
// sacar la URL, fabricar la respuesta de la billetera con la clave que el módulo publicó, volver— y
// **nunca escriben el disco a mano** para llegar al estado que van a medir. Esa disciplina es la que
// hace que un mutante en el medio del camino tenga por dónde matar: un fixture que siembra el
// resultado final mide el `expect` y no el código.
//
// ⚠️ LO QUE ESTE ARCHIVO NO PUEDE CONTESTAR, con las mismas palabras que `sesion.test.ts`: los nombres
// de los parámetros del protocolo están escritos a mano de los dos lados. Si Phantom cambiara uno,
// todos estos `it` siguen verdes. Y tampoco contesta si un teléfono de verdad vuelve a nuestro origen
// con el `localStorage` intacto: eso lo mide un teléfono, y está declarado como `[NO VERIFICADO]`.
//
// ⛔ Y LO QUE ESTA HU NO ENTREGA: el DEPÓSITO por enlace no cierra con esto. `prepare()` exige una
// prueba de posesión firmada por el bridge y en un móvil sin extensión el bridge está vacío, así que
// todo depósito por enlace muere en `payout_pop_unavailable` antes de la rama de enlace. Es WKH-359.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import nacl from "tweetnacl";
import bs58 from "bs58";
import type { BilleteraDeeplink } from "./protocol";
import { MARCA, type Almacen, type Viaje, guardarViaje } from "./sesion";
import {
  MARCA_CREAR_NONCE,
  completarVuelta,
  guardarEleccion,
  hrefSinRastroDeVuelta,
  iniciarConexion,
  leerEleccion,
  marcaDeVuelta,
  olvidarEleccion,
  remesaDelViaje,
} from "./conexion";

/** Almacén de mentira: un `Map`. Cuenta borrados, que es lo que prueba la higiene. Mismo doble que
 *  `sesion.test.ts`, a propósito: los dos módulos hablan con la MISMA interfaz. */
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
const REM = "rem-1";
const HREF = "https://chaski.test/enviar?kyc=return";
const APP = "https://chaski.test";
const CLUSTER = "devnet";
const CLAVE_VIAJE = "chaski.billetera.viaje.v1";
const DIRECCION = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// ⛔ ESCRITO A MANO A PROPÓSITO, igual que en `sesion.test.ts` y `protocol.test.ts`: es el oráculo
// independiente. Importarlo de `protocol.ts` movería los dos lados a la vez y ningún `it` lo notaría.
const NOMBRE_DE_LA_CLAVE: Record<BilleteraDeeplink, string> = {
  phantom: "phantom_encryption_public_key",
  solflare: "solflare_encryption_public_key",
};

/** El par de cifrado de LA BILLETERA. En un viaje real la app lo conoce recién al volver el connect. */
let billeteraReal: nacl.BoxKeyPair;
beforeEach(() => {
  billeteraReal = nacl.box.keyPair();
});

const pedido = (a: Almacen, over: Partial<Parameters<typeof completarVuelta>[0]> = {}) => ({
  almacen: a,
  ahora: AHORA,
  hrefActual: HREF,
  appUrl: APP,
  remittanceId: REM,
  cluster: CLUSTER,
  ...over,
});

/** La billetera de mentira: hace lo que dice la documentación, cifrando contra la clave que ESTE
 *  módulo publicó en la URL. ⛔ La clave de la app NO se inventa acá: se lee de la URL que produjo
 *  `iniciarConexion`, que es lo que hace que el recorrido sea el de producción. */
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

/** Abre el viaje por el camino de producción y devuelve la URL de la billetera + la clave que la app
 *  publicó, sacada de esa MISMA URL. */
function abrirViaje(a: Almacen, billetera: BilleteraDeeplink = "phantom") {
  const { irA } = iniciarConexion({ ...pedido(a), billetera });
  const q = new URL(irA).searchParams;
  const publicaDeLaApp = bs58.decode(q.get("dapp_encryption_public_key") as string);
  return { irA, q, publicaDeLaApp, redirectLink: q.get("redirect_link") as string };
}

/** El href con el que la billetera nos devuelve el control: el `redirect_link` que ella recibió, más
 *  los parámetros de respuesta. ⛔ La marca `dl=` ya viene adentro del `redirect_link`: la puso
 *  `enlaceDeVuelta`, no este helper. */
function hrefDeVuelta(redirectLink: string, params: Record<string, string>): string {
  const u = new URL(redirectLink);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-065-1 (AC-1) — el viaje inicial y la URL del connect
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-065-1: `iniciarConexion` abre el viaje y produce la URL del connect", () => {
  it("escribe un viaje NUEVO con par propio, `paso:\"conectar\"`, el `remittanceId` y `desde`", () => {
    const a = almacenFalso();
    const { publicaDeLaApp } = abrirViaje(a);

    const v = JSON.parse(a.datos.get(CLAVE_VIAJE) as string) as Viaje;
    expect(v.paso).toBe("conectar");
    expect(v.remittanceId, "el viaje se abrió sin dueño: el cruce de remesas no puede cortar (CD-5)").toBe(REM);
    expect(v.desde).toBe(AHORA);
    expect(v.billetera).toBe("phantom");
    // El par es NUEVO y es EL MISMO que viajó en la URL: si el módulo publicara una clave que no es la
    // que guardó, ningún sobre de la billetera se podría abrir a la vuelta.
    expect(bs58.decode(v.publica)).toEqual(publicaDeLaApp);
    expect(bs58.decode(v.secreta)).toHaveLength(nacl.box.secretKeyLength);
    // ⛔ Los TRES del connect NO están todavía: los escribe la vuelta, y `claveBilletera` es de una
    // sola escritura.
    expect(v.claveBilletera).toBeUndefined();
    expect(v.session).toBeUndefined();
    expect(v.direccion).toBeUndefined();
  });

  // MUTANTE QUE MATA: en `conexion.ts`, en `iniciarConexion`, borrar `cluster` del objeto que se le
  // pasa a `urlConectar` ⇒ `tsc` lo caza, y si se le pasara `""` este `it` se pone rojo. (MEDIDO en la
  // batería de §9.)
  it("la URL es la de `urlConectar`, con `cluster` EXPLÍCITO y el `redirect_link` marcado", () => {
    const a = almacenFalso();
    const { irA, q, redirectLink } = abrirViaje(a);

    expect(new URL(irA).host).toBe("phantom.app");
    expect(new URL(irA).pathname).toBe("/ul/v1/connect");
    // 🔴 EL DEFAULT DE LAS DOS BILLETERAS ES `mainnet-beta`: sin esto la persona autoriza en la red
    // equivocada. El valor se compara contra el que se le PASÓ, no contra un literal de producción.
    expect(q.get("cluster")).toBe(CLUSTER);
    expect(q.get("app_url")).toBe(APP);
    // El `redirect_link` vuelve a NUESTRO origen, con la marca del paso y sin los parámetros de
    // respuesta que el href de entrada pudiera traer.
    const vuelta = new URL(redirectLink);
    expect(vuelta.origin).toBe(APP);
    expect(vuelta.searchParams.get(MARCA)).toBe("conectar");
    expect(vuelta.searchParams.get("kyc"), "se perdió un parámetro ajeno del origen").toBe("return");
  });

  it("cada viaje estrena par: dos aperturas seguidas no comparten la clave privada", () => {
    const a1 = almacenFalso();
    const a2 = almacenFalso();
    abrirViaje(a1);
    abrirViaje(a2);
    const p1 = (JSON.parse(a1.datos.get(CLAVE_VIAJE) as string) as Viaje).secreta;
    const p2 = (JSON.parse(a2.datos.get(CLAVE_VIAJE) as string) as Viaje).secreta;
    expect(p1).not.toBe(p2);
  });

  it("si el disco no acepta el viaje, TIRA — no se salta a ciegas", () => {
    const a = almacenFalso();
    a.escribir = () => {
      throw new Error("cuota_llena");
    };
    expect(() => iniciarConexion({ ...pedido(a), billetera: "phantom" })).toThrow("cuota_llena");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-065-2 / T-065-5 (AC-1, AC-2) — la vuelta del connect, por camino de producción
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-065-2 / T-065-5: la vuelta `?dl=conectar` completa el viaje", () => {
  // MUTANTE QUE MATA: en `conexion.ts`, en la rama `conectar` de `completarVuelta`, reemplazar la
  // llamada al lector de la vuelta por una escritura directa con `guardarViaje` ⇒ el paso no queda
  // marcado como consumido y el `it` de anti-replay de más abajo se pone rojo. (MEDIDO en §9.)
  it("T-065-5: `conectado` se alcanza por camino de producción, SIN escribir el disco a mano", () => {
    const a = almacenFalso();
    const { publicaDeLaApp, redirectLink } = abrirViaje(a);

    // CD-18 — el fixture fabricó el caso: antes de la vuelta NO hay ninguna dirección en el disco.
    expect((JSON.parse(a.datos.get(CLAVE_VIAJE) as string) as Viaje).direccion).toBeUndefined();

    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ public_key: DIRECCION, session: "sess-1" }, publicaDeLaApp),
    );
    const r = completarVuelta(pedido(a, { hrefActual: href }));

    expect(r).toEqual({ tipo: "conectado", direccion: DIRECCION });
    const v = JSON.parse(a.datos.get(CLAVE_VIAJE) as string) as Viaje;
    expect(v.direccion, "la dirección no quedó en el disco: se pierde en el salto siguiente").toBe(DIRECCION);
    expect(v.session).toBe("sess-1");
    expect(v.claveBilletera).toBe(bs58.encode(billeteraReal.publicKey));
    expect(v.remittanceId, "el dueño cruzado se perdió en la vuelta").toBe(REM);
  });

  it("T-065-2: la MISMA URL una segunda vez NO vuelve a aplicarse (el paso quedó consumido)", () => {
    const a = almacenFalso();
    const { publicaDeLaApp, redirectLink } = abrirViaje(a);
    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ public_key: DIRECCION, session: "sess-1" }, publicaDeLaApp),
    );
    expect(completarVuelta(pedido(a, { hrefActual: href })).tipo).toBe("conectado");

    // 🔴 ESTO ES LO QUE PRUEBA QUE LA VUELTA LA PROCESÓ EL LECTOR DEL PROTOCOLO Y NO UNA ESCRITURA
    // DIRECTA: el anti-replay vive en `pasosConsumidos`, y sólo lo escribe ese lector, en la MISMA
    // escritura en la que devuelve el resultado.
    expect((JSON.parse(a.datos.get(CLAVE_VIAJE) as string) as Viaje).pasosConsumidos).toContain("conectar");
    const segunda = completarVuelta(pedido(a, { hrefActual: href }));
    expect(segunda.tipo).toBe("corte");
  });

  it("una vuelta de OTRA remesa no se aplica sobre la que está en curso", () => {
    const a = almacenFalso();
    const { publicaDeLaApp, redirectLink } = abrirViaje(a);
    const href = hrefDeVuelta(
      redirectLink,
      respuestaDeLaBilletera({ public_key: DIRECCION, session: "s" }, publicaDeLaApp),
    );
    const r = completarVuelta(pedido(a, { hrefActual: href, remittanceId: "otra-remesa" }));
    expect(r.tipo).toBe("corte");
    expect((JSON.parse(a.datos.get(CLAVE_VIAJE) as string) as Viaje).direccion).toBeUndefined();
  });

  it("un rechazo de la billetera se distingue de un fallo NUESTRO", () => {
    const a = almacenFalso();
    const { redirectLink } = abrirViaje(a);
    const rechazo = completarVuelta(
      pedido(a, {
        hrefActual: hrefDeVuelta(redirectLink, { errorCode: "4001", errorMessage: "User rejected" }),
      }),
    );
    expect(rechazo).toEqual({ tipo: "corte", causa: "deeplink_rechazado" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-065-3 (AC-1 / CD-5) — el connect forjado TARDÍO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// MUTANTE QUE MATA: en `sesion.ts`, invertir la comparación del ancla `claveBilletera` (el `if` del
// bloque `claveEnLaUrl`) ⇒ un segundo connect de OTRA clave pisa el ancla y este `it` se pone rojo.
// (MEDIDO en la batería de §9.)
describe("T-065-3: un connect forjado TARDÍO no puede pisar el ancla", () => {
  it("otra clave después del connect bueno sale `corte` y NO cambia la dirección", () => {
    const a = almacenFalso();
    const { publicaDeLaApp, redirectLink } = abrirViaje(a);
    // 1 · el connect de la billetera REAL entra y fija el ancla.
    completarVuelta(
      pedido(a, {
        hrefActual: hrefDeVuelta(
          redirectLink,
          respuestaDeLaBilletera({ public_key: DIRECCION, session: "s" }, publicaDeLaApp),
        ),
      }),
    );
    const anclaBuena = (JSON.parse(a.datos.get(CLAVE_VIAJE) as string) as Viaje).claveBilletera;

    // 2 · el forjador sólo necesita `viaje.publica`, que es PÚBLICA: viaja en la URL del connect.
    const atacante = nacl.box.keyPair();
    // CD-18 — el fixture fabricó el ataque: es OTRA clave, no la misma.
    expect(bs58.encode(atacante.publicKey)).not.toBe(anclaBuena);
    const forjado = completarVuelta(
      pedido(a, {
        hrefActual: hrefDeVuelta(
          redirectLink,
          respuestaDeLaBilletera({ public_key: "OTRA-CUENTA", session: "s2" }, publicaDeLaApp, {
            quien: atacante,
          }),
        ),
      }),
    );

    expect(forjado.tipo).toBe("corte");
    const v = JSON.parse(a.datos.get(CLAVE_VIAJE) as string) as Viaje;
    expect(v.claveBilletera, "el ancla write-once se pisó").toBe(anclaBuena);
    expect(v.direccion, "el forjador sustituyó al depositante").toBe(DIRECCION);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-065-4 (AC-1 / CD-11) — las marcas del MOTOR no se tocan
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 LA LÍNEA MÁS PELIGROSA DEL MÓDULO. `firmar-tx` y `firmar-patrocinio` son vueltas que el MOTOR
// necesita consumir: el lector del protocolo marca el paso consumido en la MISMA escritura en la que
// devuelve el resultado, así que leerlas acá QUEMARÍA una firma que la persona sí dio.
//
// MUTANTE QUE MATA: en `conexion.ts`, hacer que la rama `firmar-tx` también llame al lector de la
// vuelta ⇒ el disco cambia y este `it` se pone rojo por el byte-a-byte. (MEDIDO en §9.)
describe("T-065-4: `completarVuelta` no consume los pasos del motor", () => {
  const AJENAS = ["firmar-tx", "firmar-patrocinio", MARCA_CREAR_NONCE, "marca-que-nadie-escribio"];

  for (const marca of AJENAS) {
    it(`\`dl=${marca}\` ⇒ "nada", y el disco queda BYTE A BYTE igual`, () => {
      const a = almacenFalso();
      const { publicaDeLaApp, redirectLink } = abrirViaje(a);
      const antes = a.datos.get(CLAVE_VIAJE) as string;
      const borradosAntes = a.borrados;

      // Una respuesta VÁLIDA y bien cifrada, con otra marca: el punto es que ni siquiera se mira.
      const u = new URL(
        hrefDeVuelta(
          redirectLink,
          respuestaDeLaBilletera({ public_key: DIRECCION, session: "s" }, publicaDeLaApp),
        ),
      );
      u.searchParams.set(MARCA, marca);
      // CD-18 — el fixture fabricó el caso: la marca es la ajena, y la respuesta es abrible.
      expect(u.searchParams.get(MARCA)).toBe(marca);
      expect(u.searchParams.get("data")).toBeTruthy();

      expect(completarVuelta(pedido(a, { hrefActual: u.toString() }))).toEqual({ tipo: "nada" });
      expect(a.datos.get(CLAVE_VIAJE), "se consumió un paso que el motor necesita").toBe(antes);
      expect(a.borrados, "se limpió algo que no era de este módulo").toBe(borradosAntes);
    });
  }

  it("sin ninguna marca nuestra en la URL, no se toca el disco", () => {
    const a = almacenFalso();
    abrirViaje(a);
    const antes = a.datos.get(CLAVE_VIAJE) as string;
    expect(completarVuelta(pedido(a, { hrefActual: "https://chaski.test/enviar" }))).toEqual({ tipo: "nada" });
    expect(a.datos.get(CLAVE_VIAJE)).toBe(antes);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// El almacén de la ELECCIÓN, y de dónde sale el `remittanceId` a la vuelta
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("la elección del selector", () => {
  it("lo que se guarda vuelve, y la basura NO", () => {
    const a = almacenFalso();
    expect(leerEleccion(a)).toBeNull();
    guardarEleccion(a, "solflare");
    expect(leerEleccion(a)).toBe("solflare");
    for (const basura of ["PHANTOM", "phantom ", "", "{}"]) {
      a.escribir("chaski.billetera.eleccion.v1", basura);
      expect(leerEleccion(a), `el disco coló ${JSON.stringify(basura)}`).toBeNull();
    }
  });

  it("un disco que no deja LEER contesta `null` en vez de tirar (corre en el camino del dinero)", () => {
    const a = almacenFalso();
    a.leer = () => {
      throw new Error("cookies_bloqueadas");
    };
    expect(() => leerEleccion(a)).not.toThrow();
    expect(leerEleccion(a)).toBeNull();
    // Y olvidar tampoco tira: es limpieza.
    a.borrar = () => {
      throw new Error("no_se_puede_borrar");
    };
    expect(() => olvidarEleccion(a)).not.toThrow();
  });

  it("`remesaDelViaje` devuelve el dueño anotado, y `null` cuando no hay viaje utilizable", () => {
    const a = almacenFalso();
    expect(remesaDelViaje(a, AHORA)).toBeNull();
    abrirViaje(a);
    expect(remesaDelViaje(a, AHORA)).toBe(REM);
    // Un `remittanceId` vacío es peor que ausente: `"" === ""` compara `true`.
    const v = JSON.parse(a.datos.get(CLAVE_VIAJE) as string) as Viaje;
    guardarViaje(a, { ...v, remittanceId: "" });
    expect(remesaDelViaje(a, AHORA)).toBeNull();
    // Y un disco que no deja leer no rompe el montaje de la pantalla.
    a.leer = () => {
      throw new Error("cookies_bloqueadas");
    };
    expect(remesaDelViaje(a, AHORA)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// AC-4 · `hrefSinRastroDeVuelta` y `marcaDeVuelta`, las dos PURAS
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("AC-4: la limpieza de la barra", () => {
  it("saca los parámetros de respuesta y la marca, y NADA MÁS", () => {
    const sucio =
      "https://chaski.test/enviar?kyc=return&dl=conectar&phantom_encryption_public_key=K&nonce=N&data=D&errorCode=4001&errorMessage=x&otro=1";
    const limpio = hrefSinRastroDeVuelta(sucio);
    const q = new URL(limpio).searchParams;
    for (const p of [MARCA, "phantom_encryption_public_key", "nonce", "data", "errorCode", "errorMessage"]) {
      expect(q.get(p), `quedó \`${p}\``).toBeNull();
    }
    // 🔴 LA MITAD QUE IMPORTA: lo ajeno sigue viajando. `?kyc=return` es de OTRO recorrido.
    expect(q.get("kyc")).toBe("return");
    expect(q.get("otro")).toBe("1");
    expect(new URL(limpio).pathname).toBe("/enviar");
  });

  it("también saca la clave de Solflare, no sólo la de Phantom", () => {
    const limpio = hrefSinRastroDeVuelta("https://chaski.test/e?solflare_encryption_public_key=K&a=1");
    expect(new URL(limpio).searchParams.get("solflare_encryption_public_key")).toBeNull();
    expect(new URL(limpio).searchParams.get("a")).toBe("1");
  });

  it("cuando no queda ningún parámetro, no deja el `?` colgando en la barra", () => {
    expect(hrefSinRastroDeVuelta("https://chaski.test/enviar?dl=conectar&nonce=N")).toBe(
      "https://chaski.test/enviar",
    );
    // Y el hash sobrevive: es parte de la ubicación de la persona.
    expect(hrefSinRastroDeVuelta("https://chaski.test/enviar?dl=conectar#abajo")).toBe(
      "https://chaski.test/enviar#abajo",
    );
  });

  it("un href sin nada nuestro vuelve IDÉNTICO (así el productor no escribe la barra de nadie)", () => {
    const igual = "https://chaski.test/enviar?kyc=return";
    expect(hrefSinRastroDeVuelta(igual)).toBe(igual);
  });

  it("un href que no parsea se devuelve tal cual en vez de tirar", () => {
    expect(hrefSinRastroDeVuelta("/enviar?dl=conectar")).toBe("/enviar?dl=conectar");
    expect(marcaDeVuelta("/enviar?dl=conectar")).toBeNull();
  });

  it("`marcaDeVuelta` devuelve lo que haya, incluida una marca que nadie escribió", () => {
    expect(marcaDeVuelta("https://chaski.test/e?dl=firmar-tx")).toBe("firmar-tx");
    expect(marcaDeVuelta("https://chaski.test/e?dl=inventada")).toBe("inventada");
    expect(marcaDeVuelta("https://chaski.test/e")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-065-PUREZA (DT-7) — el módulo no conoce el mundo
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 LAS TRES REGLAS DE CD-19, Y LA (c) ES LA QUE SIEMPRE FALTA:
//   (a) se descuentan los comentarios, porque el encabezado de `conexion.ts` NOMBRA las cuatro cosas
//       prohibidas para declarar que no las usa;
//   (b) se asserta que después del descuento TODAVÍA QUEDA el código que este barrido cree mirar;
//   (c) se asserta que el descuento **cambia una cantidad medida** — si neutralizarlo no moviera
//       ningún número, el descuento sería decorativo y el barrido estaría mirando otra cosa.
//
// MUTANTE QUE MATA: agregar `const x = Date.now();` adentro de `completarVuelta`. (MEDIDO en §9.)
describe("T-065-PUREZA: `conexion.ts` no lee `window`, ni `Date`, ni `fetch`, ni `process.env`", () => {
  const RUTA = path.join(__dirname, "conexion.ts");
  const PROHIBIDOS = ["window", "Date", "fetch(", "process.env"];

  /** Saca comentarios de línea y de bloque. Deliberadamente tosco: acá no hay ningún `//` adentro de
   *  un string, y si algún día lo hubiera, el assert (b) es el que avisa. */
  function sinComentarios(fuente: string): string {
    return fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  it("ninguno de los cuatro aparece en el CÓDIGO, y el descuento de comentarios es load-bearing", () => {
    const bruto = readFileSync(RUTA, "utf8");
    const codigo = sinComentarios(bruto);

    // (b) el descuento no se comió el código que este barrido cree estar mirando.
    for (const ancla of ["export function completarVuelta", "export function iniciarConexion", "guardarViaje("]) {
      expect(codigo, `el descuento de comentarios se llevó \`${ancla}\``).toContain(ancla);
    }

    // (c) el descuento CAMBIA una cantidad medida: los prohibidos SÍ están en la prosa. Sin esta
    // afirmación, un `sinComentarios` que devolviera la fuente entera pasaría igual y nadie lo vería.
    const enBruto = PROHIBIDOS.filter((p) => bruto.includes(p));
    expect(
      enBruto.length,
      "ningún prohibido aparece en los comentarios ⇒ descontarlos no cambia nada y este barrido es decorativo",
    ).toBeGreaterThan(0);
    const enCodigo = PROHIBIDOS.filter((p) => codigo.includes(p));
    expect(enCodigo.length).toBeLessThan(enBruto.length);

    // (a) y el barrido propiamente dicho.
    expect(enCodigo, "`conexion.ts` dejó de ser puro (DT-7)").toEqual([]);
  });
});
