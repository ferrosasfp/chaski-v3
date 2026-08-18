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
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { BilleteraDeeplink } from "./protocol";
import { MARCA, MAX_EDAD_MS, type Almacen, type Viaje, guardarViaje } from "./sesion"; // MAX_EDAD_MS entra EN ESTA LÍNEA (Δ0): lo usa la refutación del fixture de `T-065-22`, que necesita el MISMO número que el código, no una copia
import {
  MARCA_CREAR_NONCE, guardarPasoDelNonce, // el segundo EN ESTA LÍNEA (Δ0): `T-065-22` re-ancla el paso del nonce por el camino de producción y no con `a.escribir`
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
  // pasa a `urlConectar` ⇒ `tsc` lo caza, y si se le pasara `""` este `it` se pone rojo. (MEDIDO: ver LA BATERÍA al final de `deeplink/conexion.test.ts`.)
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
  // marcado como consumido y el `it` de anti-replay de más abajo se pone rojo. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`.)
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
// (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`, que trae exit, `it` rojos y el árbol de los 56, y se re-corre con `node scripts/mutacion/bateria-065.mjs`.)
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
// vuelta ⇒ el disco cambia y este `it` se pone rojo por el byte-a-byte. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`.)
describe("T-065-4: `completarVuelta` no consume los pasos del motor", () => {
  // ⛔ `MARCA_CREAR_NONCE` NO está en esta lista, y no es un olvido: desde la wave del nonce tiene su
  // propia rama. Que ESA rama tampoco toque el viaje del depósito lo mide el `it` de más abajo.
  const AJENAS = ["firmar-tx", "firmar-patrocinio", "marca-que-nadie-escribio"];

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
// MUTANTE QUE MATA: agregar `const x = Date.now();` adentro de `completarVuelta`. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`.)
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

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-065-15 / T-065-16 (AC-5) — la vuelta del paso del NONCE: bytes contra bytes, y una sola vez
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ PROTEGE LA COMPARACIÓN DE BYTES. Un sobre bien cifrado que traiga OTRA transacción se
// transmitiría igual si nadie compara: el canal prueba que quien contestó tiene la clave del viaje, no
// que la transacción sea la que mandamos a firmar. Ese es el ataque que este bloque cierra, y por eso
// la comparación es contra el ancla guardada ANTES del salto y nunca contra una reconstrucción.
//
// ⚠️ Y LO QUE NO PROTEGE, dicho para que nadie se apoye en su verde: no verifica la firma ed25519 del
// sender. Los bytes del mensaje coinciden igual con la firma en cero, porque las firmas no son parte
// del mensaje. 🔴 ACÁ DECÍA «esa verificación vive en el adaptador, que es el que conoce la pubkey», Y
// ERA UN PUNTERO FALSO (CR/BLQ-BAJO-6): ese sitio es la verificación del DEPÓSITO, en la rama de
// `authorizePrincipal`, y por el camino del nonce NO PASA NADIE POR AHÍ. En este camino no la verifica
// nadie, ni acá ni después. Se corrigió en `conexion.ts:521` y esta línea quedó contradiciéndolo (re-AR
// it2 · BLQ-BAJO-2): el argumento entero de por qué alcanza igual —la cadena rechaza una tx sin la firma
// de su `feePayer`, así que el desenlace es "la cuenta no se creó"— vive en el docblock de
// (`vueltaDelNonce`, `./conexion.ts:528`), con su costo medido de agregarla.
describe("T-065-15 / T-065-16: la vuelta del paso del nonce", () => {
  const CLAVE_NONCE = "chaski.billetera.nonce.v1";

  /** Una transacción de verdad, firmada por `firmante` si se le pide, y su mensaje en base64. */
  function transaccion(firmante?: Keypair) {
    const pagador = firmante ?? Keypair.generate();
    const tx = new Transaction({
      feePayer: pagador.publicKey,
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    });
    tx.add(
      SystemProgram.transfer({ fromPubkey: pagador.publicKey, toPubkey: pagador.publicKey, lamports: 1 }),
    );
    const mensajeBase64 = Buffer.from(tx.serializeMessage()).toString("base64");
    if (firmante) tx.sign(firmante);
    const base58 = bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    return { base58, mensajeBase64 };
  }

  /** Deja el disco listo: viaje CONECTADO por camino de producción + el ancla del paso del nonce. */
  function prepararSalto(a: ReturnType<typeof almacenFalso>, mensajeBase64: string) {
    const { publicaDeLaApp, redirectLink } = abrirViaje(a);
    completarVuelta(
      pedido(a, {
        hrefActual: hrefDeVuelta(
          redirectLink,
          respuestaDeLaBilletera({ public_key: DIRECCION, session: "s" }, publicaDeLaApp),
        ),
      }),
    );
    a.escribir(CLAVE_NONCE, JSON.stringify({ mensajeBase64, desde: AHORA }));
    return { publicaDeLaApp, redirectLink };
  }

  /** El href de vuelta del paso del nonce: el mismo `redirect_link` pero con la marca del nonce. */
  function vueltaDelNonce(redirectLink: string, params: Record<string, string>): string {
    const u = new URL(hrefDeVuelta(redirectLink, params));
    u.searchParams.set(MARCA, MARCA_CREAR_NONCE);
    return u.toString();
  }

  it("con los bytes que coinciden, devuelve la transacción para transmitir", () => {
    const a = almacenFalso();
    const { base58, mensajeBase64 } = transaccion(Keypair.generate());
    const { publicaDeLaApp, redirectLink } = prepararSalto(a, mensajeBase64);

    const r = completarVuelta(
      pedido(a, {
        hrefActual: vueltaDelNonce(
          redirectLink,
          respuestaDeLaBilletera({ transaction: base58 }, publicaDeLaApp),
        ),
      }),
    );
    expect(r).toEqual({ tipo: "nonce-firmado", transaccionBase58: base58 });
  });

  // MUTANTE QUE MATA: en `conexion.ts`, en la rama del nonce, borrar la comparación del
  // `mensajeBase64` contra el ancla. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`, que trae exit, `it` rojos y el árbol de los 56, y se re-corre con `node scripts/mutacion/bateria-065.mjs`.)
  it("T-065-15: con OTRA transacción bien cifrada, corta y NO la devuelve", () => {
    const a = almacenFalso();
    const propia = transaccion(Keypair.generate());
    const ajena = transaccion(Keypair.generate());
    // CD-18 — el fixture fabricó el caso: son dos transacciones DISTINTAS.
    expect(ajena.mensajeBase64).not.toBe(propia.mensajeBase64);
    const { publicaDeLaApp, redirectLink } = prepararSalto(a, propia.mensajeBase64);

    const r = completarVuelta(
      pedido(a, {
        hrefActual: vueltaDelNonce(
          redirectLink,
          respuestaDeLaBilletera({ transaction: ajena.base58 }, publicaDeLaApp),
        ),
      }),
    );
    expect(r).toEqual({ tipo: "corte", causa: "deeplink_tx_alterada" });
  });

  // MUTANTE QUE MATA: en `conexion.ts`, dejar de escribir el flag `consumido`. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`.)
  it("T-065-16: la MISMA URL una segunda vez NO vuelve a devolver la transacción", () => {
    const a = almacenFalso();
    const { base58, mensajeBase64 } = transaccion(Keypair.generate());
    const { publicaDeLaApp, redirectLink } = prepararSalto(a, mensajeBase64);
    const href = vueltaDelNonce(
      redirectLink,
      respuestaDeLaBilletera({ transaction: base58 }, publicaDeLaApp),
    );

    expect(completarVuelta(pedido(a, { hrefActual: href })).tipo).toBe("nonce-firmado");
    // 🔴 El anti-replay de este paso es SU PROPIO flag: `interpretarVuelta` no participa.
    expect(JSON.parse(a.datos.get(CLAVE_NONCE) as string).consumido).toBe(true);
    const segunda = completarVuelta(pedido(a, { hrefActual: href }));
    expect(segunda.tipo, "se transmitiría dos veces").toBe("corte");
    // 🔴 Y LA CAUSA IMPORTA, NO SÓLO QUE SEA UN CORTE (fix-pack · AR/BLQ-BAJO-2). Acá salía
    // `deeplink_viaje_vencido`, cuyo copy dice «No se firmó nada. Empezá el envío de nuevo.»: las DOS
    // mitades son falsas en esta rama —la billetera YA devolvió la transacción firmada, y esto no es el
    // envío sino la creación de una cuenta—. El `it` viejo miraba sólo `.tipo`, así que el copy falso le
    // pasaba por al lado.
    // MUTANTE QUE MATA: devolver `DEEPLINK_VIAJE_VENCIDO` en la rama `consumido === true`.
    expect((segunda as { causa: string }).causa).toBe("deeplink_nonce_ya_consumido");
    expect(
      (segunda as { causa: string }).causa,
      "volvió a la causa cuyo copy niega la firma que la billetera SÍ dio",
    ).not.toBe("deeplink_viaje_vencido");
  });

  // 🔴 T-065-22 · LOS DOS RELOJES (re-AR it2 · BLQ-BAJO-1), Y ES EL CASO QUE UNA PERSONA LEE MAL.
  //
  // El fix-pack arregló la rama `consumido` de arriba y dejó escrito que las OTRAS tres salidas de
  // `vueltaDelNonce` seguían en `deeplink_viaje_vencido` pero que ahí «las dos mitades del copy SÍ son
  // ciertas (son pre-firma)». Es falso: son PRE-LECTURA. Llegar a esa función significa que la barra
  // trae `MARCA_CREAR_NONCE`, que sólo vive en el `redirect_link` que le dimos a la billetera, así que
  // ya volvimos de ella; las tres cortan antes de mirar un solo parámetro y por lo tanto NO SABEN si se
  // firmó.
  //
  // ⚠️ Y NO ES UN CASO DE LABORATORIO: son DOS relojes con la MISMA `MAX_EDAD_MS` y arranques distintos.
  // El del VIAJE arranca en `iniciarConexion` (al tocar el selector) y `consumir` conserva su `desde`;
  // el del ANCLA arranca en `guardarPasoDelNonce`, cuando se pide la firma, mucho después ⇒ el viaje
  // SIEMPRE vence primero, y esta salida se alcanza con el ancla viva. Este `it` recorre eso: selector
  // en t=0, «Crear la cuenta» en t=15m, firma, vuelta en t=21m.
  //
  // MUTANTE QUE MATA: devolver `DEEPLINK_VIAJE_VENCIDO` en la rama `lectura.tipo !== "hay"` de
  // `vueltaDelNonce`. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de este archivo.)
  it("T-065-22: el ancla viva y el viaje vencido cortan con deeplink_nonce_sin_contexto, no con el copy que niega la firma", () => {
    const a = almacenFalso();
    const { base58, mensajeBase64 } = transaccion(Keypair.generate());
    const { publicaDeLaApp, redirectLink } = prepararSalto(a, mensajeBase64);
    // El ancla se re-escribe 15 min después del viaje, por el MISMO camino que produce el salto real.
    const QUINCE_MIN = 15 * 60 * 1000;
    guardarPasoDelNonce(a, mensajeBase64, AHORA + QUINCE_MIN);
    const enVuelta = AHORA + 21 * 60 * 1000;
    // CD-18 — el fixture FABRICA el caso, y se refuta con la constante del código y no con una copia:
    // a los 21 min el ancla tiene 6 (viva) y el viaje 21 (vencido).
    expect(enVuelta - (AHORA + QUINCE_MIN), "el ancla tendría que estar VIVA").toBeLessThan(MAX_EDAD_MS);
    expect(enVuelta - AHORA, "el viaje tendría que estar VENCIDO").toBeGreaterThan(MAX_EDAD_MS);

    const r = completarVuelta(
      pedido(a, {
        ahora: enVuelta,
        hrefActual: vueltaDelNonce(
          redirectLink,
          respuestaDeLaBilletera({ transaction: base58 }, publicaDeLaApp),
        ),
      }),
    );
    expect(r.tipo).toBe("corte");
    expect((r as { causa: string }).causa).toBe("deeplink_nonce_sin_contexto");
    expect(
      (r as { causa: string }).causa,
      "la causa cuyo copy dice «No se firmó nada. Empezá el envío de nuevo.» a alguien que acaba de firmar",
    ).not.toBe("deeplink_viaje_vencido");
  });

  // MUTANTE QUE MATA: devolver `DEEPLINK_VIAJE_VENCIDO` en la rama `ancla === null`.
  it("T-065-22b: la vuelta SIN ancla del paso corta con la misma causa post-vuelta", () => {
    const a = almacenFalso();
    const { base58, mensajeBase64 } = transaccion(Keypair.generate());
    const { publicaDeLaApp, redirectLink } = prepararSalto(a, mensajeBase64);
    a.borrar(CLAVE_NONCE); // el disco perdió el ancla mientras la persona estaba en la billetera
    expect(a.datos.has(CLAVE_NONCE), "el fixture no llegó al estado que dice medir").toBe(false);

    const r = completarVuelta(
      pedido(a, {
        hrefActual: vueltaDelNonce(
          redirectLink,
          respuestaDeLaBilletera({ transaction: base58 }, publicaDeLaApp),
        ),
      }),
    );
    expect(r).toEqual({ tipo: "corte", causa: "deeplink_nonce_sin_contexto" });
  });

  it("un sobre de OTRA clave no pasa el ancla write-once del viaje", () => {
    const a = almacenFalso();
    const { base58, mensajeBase64 } = transaccion(Keypair.generate());
    const { publicaDeLaApp, redirectLink } = prepararSalto(a, mensajeBase64);
    const r = completarVuelta(
      pedido(a, {
        hrefActual: vueltaDelNonce(
          redirectLink,
          respuestaDeLaBilletera({ transaction: base58 }, publicaDeLaApp, { quien: nacl.box.keyPair() }),
        ),
      }),
    );
    expect(r).toEqual({ tipo: "corte", causa: "deeplink_tx_alterada" });
  });

  it("un rechazo explícito de la billetera se lee como rechazo, no como alterada", () => {
    const a = almacenFalso();
    const { mensajeBase64 } = transaccion();
    const { redirectLink } = prepararSalto(a, mensajeBase64);
    const r = completarVuelta(
      pedido(a, {
        hrefActual: vueltaDelNonce(redirectLink, { errorCode: "4001", errorMessage: "User rejected" }),
      }),
    );
    expect(r).toEqual({ tipo: "corte", causa: "deeplink_rechazado" });
  });

  it("sin ancla viva, no se transmite nada (y una ancla vencida no cuenta)", () => {
    const a = almacenFalso();
    const { base58, mensajeBase64 } = transaccion(Keypair.generate());
    const { publicaDeLaApp, redirectLink } = prepararSalto(a, mensajeBase64);
    const href = vueltaDelNonce(
      redirectLink,
      respuestaDeLaBilletera({ transaction: base58 }, publicaDeLaApp),
    );
    // Sin ancla: se borra y no hay contra qué comparar.
    a.borrar(CLAVE_NONCE);
    expect(completarVuelta(pedido(a, { hrefActual: href })).tipo).toBe("corte");
    // Con ancla VENCIDA: veinte minutos y un milisegundo después.
    a.escribir(CLAVE_NONCE, JSON.stringify({ mensajeBase64, desde: AHORA - 1_200_001 }));
    expect(completarVuelta(pedido(a, { hrefActual: href })).tipo).toBe("corte");
    expect(a.datos.has(CLAVE_NONCE), "el ancla vencida no se limpió").toBe(false);
  });

  it("la vuelta del nonce NO toca el viaje del depósito: son dos ciclos de vida", () => {
    const a = almacenFalso();
    const { base58, mensajeBase64 } = transaccion(Keypair.generate());
    const { publicaDeLaApp, redirectLink } = prepararSalto(a, mensajeBase64);
    const viajeAntes = a.datos.get(CLAVE_VIAJE) as string;

    completarVuelta(
      pedido(a, {
        hrefActual: vueltaDelNonce(
          redirectLink,
          respuestaDeLaBilletera({ transaction: base58 }, publicaDeLaApp),
        ),
      }),
    );
    expect(a.datos.get(CLAVE_VIAJE), "la vuelta del nonce consumió un paso del viaje").toBe(viajeAntes);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 LA BATERÍA DE MUTACIÓN DE WKH-358 (CD-17 / CD-23) — CORRIDA, RE-DERIVABLE, Y CON EL `it` QUE MUERE
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// ⚠️ EL «MEDIDO» DE CADA MUTANTE DE ESTA HU APUNTA ACÁ Y NO SE REPITE EN CADA SITIO, a propósito: un
// conteo escrito en dos lugares se desincroniza, y este repo ya tiene la lección medida (el «6» de
// `T-062-15(a)` pasó a 7 y a 8 sin que nadie editara la línea). Acá vive UNA sola copia.
//
// ══ CÓMO SE RE-CORRE, Y ESTO ES LO QUE FALTABA (fix-pack · CR/BLQ-BAJO-3) ══════════════════════════
//
//     node scripts/mutacion/bateria-065.mjs           # los 56, ≈20 s cada uno
//     node scripts/mutacion/bateria-065.mjs --dry     # sólo verifica que cada aguja exista 1 vez
//     node scripts/mutacion/bateria-065.mjs --solo T-065-15
//
// 🔴 QUÉ ESTABA MAL Y POR QUÉ ERA BLOQUEANTE. Esta tabla citaba `scratchpad/bateria.mjs` +
// `scratchpad/mutantes.json`, y esos dos archivos **no existían ni en git ni en el disco**: la única vía
// de re-correrla se había ido con la sesión que la escribió. Encima el «sha» decía *"`8ef2409` más tres
// `it`"*, que no es un árbol direccionable, tres filas se llamaban `(mío)` (sin id, o sea no citables) y
// `SW-BASE58` se citaba desde `solana-wallet.test.ts` como un id que la tabla no tenía. Una medición que
// no se puede repetir no es una medición: es una declaración. El harness y la especificación de los 56
// están COMMITEADOS en `scripts/mutacion/`, cada fila tiene id único, y el sha es un sha.
//
// 🔴 CUÁNDO SE MIDIÓ, Y ESTO ES LO QUE ENVEJECE: sobre el árbol **`b4f7e6d`**, con la suite en
// `Tests 2689 passed (2689)` / `Test Files 143 passed (143)` y exit 0 ANTES de mutar nada (el harness
// exige las dos cosas: árbol limpio y base verde, y aborta si no). ⚠️ EL RE-AR it2 OBLIGÓ A RE-CORRERLA
// ENTERA, y no por prolijidad: sumó dos `it` (`T-065-22` / `T-065-22b`), y un conteo de `it` rojos es una
// propiedad del árbol. Resultado de esa corrida: **54 mueren, 2 viven** —`CALIBRACION-VIVE`, que TIENE que
// vivir, y `T-065-11b-a`—, y **55 de las 56 filas reproducen exit + rojos + veredicto exactos** contra la
// tabla anterior. La única que difiere es `T-065-COPY-2`, que trae +1, y ese +1 **no es cobertura**: es el
// flake de `bienvenida-composicion.test.tsx › cada renglón anuncia un tramo…`, un archivo que esta HU no
// toca. Está sensible a CARGA y el re-AR lo reprodujo por mecanismo (sin carga 0 de 12; con 24 workers
// ocupados 5 de 6; en `7db4508`, antes de que esta HU existiera, 6 de 6), o sea que es PRE-EXISTENTE y
// AJENO. ⛔ Se deja el 2 que la corrida dio, con el motivo escrito al lado, en vez de publicar el 1 que
// «debería» ser: la tabla es la salida de una corrida, no una corrección a mano.
// ⚠️ Y LA PRIMERA CORRIDA DE ESTE MISMO ÁRBOL SE DESCARTÓ POR LO MISMO, dicho para que se entienda el
// costo: el flake cayó adentro de `CALIBRACION-VIVE` y la mitad del instrumento que TIENE que sobrevivir
// reportó un KILL FALSO. Si la calibración no da `VIVE`, la corrida entera no vale.
// ⚠️ QUÉ HAY ENTRE `b4f7e6d` Y EL COMMIT QUE TRAE ESTA TABLA, dicho con un criterio y no con un número
// (la 1ª versión de este renglón decía «el ÚNICO diff es este bloque», que era falso, y la 2ª decía «más
// 8 archivos de test», que envejeció al commit siguiente): hay ESTE bloque y **nada más**, o sea puras
// líneas de COMENTARIO, **ninguna de ellas código ejecutable**. Eso está MEDIDO y no razonado: la suite
// sigue en `143 archivos / 2689 tests` con exit 0 después de todas. Un comentario no puede mover un
// conteo de `it`; lo que sí puede mover son citas por número, y de eso se ocupa `citas-ancladas.test.ts`,
// que también está verde.
// ⇒ SI ALGUIEN DUDA, EL CONTROL ES DE UNA LÍNEA: `git diff b4f7e6d..HEAD -- src app`, y lo que hay que
// mirar es **cuántas líneas `+`/`-` NO arrancan con `//`: son 2, y las 2 son COMENTARIO IGUAL**. 🔴 ESE
// «2» ES LA LECCIÓN Y NO UN RESIDUO: las dos son el MISMO renglón, `:569`, donde cambió «el árbol de los
// 54» por «los 56», y no las ve el barrido porque el comentario está INDENTADO (`  //`) en vez de arrancar
// la línea. O sea que este control tiene el mismo agujero que `citas-ancladas.test.ts` ya midió y cerró en
// su escáner. El criterio que sí vale, medido con `node` y no con un pipe: **líneas `+`/`-` que no son
// comentario, 0**. ⛔ Y NO SE MIDE REDIRIGIENDO LA SALIDA (`git diff … > archivo`): en este entorno esa
// redirección se come contenido en silencio y el mismo conteo dio 0 sobre el archivo truncado. ⛔ El total de líneas del diff NO se
// escribe acá y ya se intentó: puse "261" y al commitear ESE MISMO renglón pasó a 267, porque el renglón
// es parte del diff que mide. Un número que se auto-incluye no se puede escribir; el "2" sí, porque es
// invariante ante agregar comentarios. ⚠️ EN LA TABLA ANTERIOR ESE INVARIANTE DABA 2, y las 2 eran el
// MISMO renglón (`flow.tsx:162`) antes y después: lo que había cambiado ahí es el comentario que va
// PEGADO al final de una línea de código, que es la técnica línea-neutra de este repo y por eso un
// barrido por «la línea arranca con `//`» no puede verlas. Acá da 0 porque este commit no toca ninguna
// línea de código. No hace falta creerle a este renglón: el comando está arriba. Un conteo de `it` rojos es una propiedad del ÁRBOL y no del mutante: cualquier `it` nuevo
// lo mueve. ⛔ No se hereda, se re-corre.
//
// EL PROTOCOLO, ENTERO Y **VERIFICADO POR EL HARNESS** en vez de declarado acá (cada regla está escrita
// en el encabezado de `scripts/mutacion/bateria-065.mjs`, al lado del código que la implementa):
// respaldo POR COPIA (nunca `git checkout --`) · la aguja contada y exigida `== 1` · el texto RESULTANTE
// verificado (no sólo el count) · el línea-neutro verificado cuando la fila lo declara · la suite
// COMPLETA con `NO_COLOR=1 FORCE_COLOR=0`, por `spawnSync` y **SIN PIPES** (el exit sale de `status`) ·
// el conteo leído de la línea `Tests N failed` y **nunca** contando `×` · restauración verificada por
// `md5` **y** por `git status --short` completo después de CADA mutante, con ABORTO si no vuelve.
// **Los 56: md5 restaurado OK y `git status` sin residuos.**
//
// ── CÓMO SE LEE LA COLUMNA «`it` QUE MUERE», que es la que CD-23(3) exige y la tabla vieja no tenía ──
//
// Es lo único que distingue un mutante que mata del que **mata por el motivo equivocado**, y esta HU
// tiene el caso medido: la fila `T-065-GATE-1` decía «muere, 1 rojo» y el `it` que moría era de OTRO
// archivo — su fixture montaba con `injected`, así que el gate cortaba en la 1ª condición y nunca leía la
// elección (CR/BLQ-BAJO-1). Con la columna puesta, eso se ve de un vistazo.
//
// La celda trae **el primer `it` de CONDUCTA**, y entre paréntesis cuántos más cayeron.
// ⚠️ `⚠️+citas` significa que el candado `citas-ancladas.test.ts` también se puso rojo, y eso **NO es
// cobertura de comportamiento**. Son DOS causas distintas y conviene no confundirlas:
//   · por DESPLAZAMIENTO — el mutante agrega o quita líneas y corre las citas de más abajo. Los tres que
//     desplazan están declarados en su fila (`T-065-SYNC` +1, `T-065-11` −2, `T-065-COPY-1` +1).
//   · por SÍMBOLO — el mutante es LÍNEA-NEUTRO y aun así borra de una línea citada el símbolo que la
//     ancla. Es el caso de `T-065-CD11-a` (se lleva `ownerAddress` de `flow.tsx:507`, que cita
//     `firma-por-enlace.ts:665`) y de `SW-BASE58` (se lleva `PublicKey`). Esos dos rojos son legítimos y
//     dicen algo real: esa línea la cita alguien.
// `SÓLO el candado de citas ⚠️` querría decir que el mutante no mató NINGÚN `it` de conducta. No hay
// ninguna fila así.
//
// | id | mutante · sitio exacto | exit | rojos | `it` QUE MUERE (el 1º de conducta) | veredicto |
// |---|---|---|---|---|---|
// | CALIBRACION-MUERE | sesion.ts · `MAX_EDAD_MS` un segundo menos (la mitad del instrumento que TIENE que morir)                                                                                                                                                                                                       | exit=1 |  2 | sesion.test.ts › la ventana son 20 minutos, dichos en número y no con la propia constante (+1)                                                                 | muere |
// | CALIBRACION-VIVE  | conexion.ts · una `const` sin efecto, LÍNEA-NEUTRA (la mitad que TIENE que vivir)                                                                                                                                                                                                               | exit=0 |  0 | — (ninguno)                                                                                                                                                    | VIVE |
// | T-065-GATE-1      | solana-wallet.ts · `caminoPorEnlace`: devolver una billetera SIN leer la elección del disco                                                                                                                                                                                                     | exit=1 |  2 | container.test.ts › T-065-GATE-1b (AC-6b): con `none` y un viaje CONECTADO en el disco pero SIN elección, el container real NO entra al camino por enlace (+1) | muere |
// | T-065-GATE-2      | solana-wallet.ts · `caminoPorEnlace`: borrar la condición de disponibilidad                                                                                                                                                                                                                     | exit=1 |  3 | solana-wallet.test.ts › T-065-GATE-2: `injected` + elección en disco ⇒ ni `:769` ni `:897`, y sin pedir el umbral del enlace (+2)                              | muere |
// | T-065-GATE-3      | solana-wallet.ts · `caminoPorEnlace`: `!== "none"` por `=== "injected"` (o sea, tratar `unknown` como enlace)                                                                                                                                                                                   | exit=1 |  1 | solana-wallet.test.ts › T-065-GATE-3: `unknown` ⇒ el gate degrada al camino conocido (fail-closed), no al de enlace                                            | muere |
// | T-065-GATE-4      | solana-wallet.ts · invertir el `if` de la rama de enlace de `authorizePrincipal` (la PRIMERA de las dos: la del nonce durable). ⚠️ La aguja pelada aparece DOS veces en el archivo, por eso lleva la línea de arriba adentro                                                                    | exit=1 | 47 | solana-wallet.test.ts › AC-1: arma la ix deposit (programId DR5G…SE4x, discriminator, accounts del IDL + PDAs/ATA) (+46)                                       | muere |
// | T-065-GATE-5      | solana-wallet.ts · `caminoPorEnlace`: borrar la TERCERA condición (la bandera del build) — el mutante del fix-pack                                                                                                                                                                              | exit=1 |  1 | preparacion-por-enlace.test.ts › T-065-GATE-5: con la bandera del build APAGADA, el gate NO se enciende aunque la elección y la dirección estén                | muere |
// | SW-BASE58         | solana-wallet.ts · `direccionDelViajeConectado`: borrar el guard de base58 del `Viaje.direccion`                                                                                                                                                                                                | exit=1 |  2 | solana-wallet.test.ts › una dirección que no parsea muere ANTES de la rama de enlace: el motor no recibe NADA ⚠️+citas                                         | muere |
// | T-062-21          | container.ts · descablear el colaborador de enlace del `SolanaWalletAdapter`                                                                                                                                                                                                                    | exit=1 |  1 | container.test.ts › T-062-21 (INVERTIDO): el `SolanaWalletAdapter` del container se construye CON el colaborador de enlace                                     | muere |
// | T-062-10          | flow.tsx · nombrar `interpretarVuelta(` en un comentario de presentación (el candado prohíbe la MENCIÓN)                                                                                                                                                                                        | exit=1 |  2 | deeplink-callers.test.ts › hay exactamente DOS sitios de producción: el motor y la pata `conectar` (+1)                                                        | muere |
// | T-065-20          | chain.ts · `resolveSolanaDeeplinkEnabled`: tolerar mayúsculas y espacios (aflojar el opt-in estricto)                                                                                                                                                                                           | exit=1 |  1 | wallet-availability.test.tsx › T-065-20: sólo el literal `true` prende; ausente, vacía, `1`, `TRUE` y `true ` NO                                               | muere |
// | T-065-21          | flow.tsx · borrar el gate `deeplinkEnabled()` de `mostrarSelectorDeEnlace`                                                                                                                                                                                                                      | exit=1 |  2 | wallet-availability.test.tsx › T-065-21: con la bandera APAGADA el paso `connect` es byte-idéntico al de hoy (+1)                                              | muere |
// | T-UI-3            | flow.tsx · montar el selector sin mirar `disponibilidadWallet`                                                                                                                                                                                                                                  | exit=1 |  1 | wallet-availability.test.tsx › T-065-21b: con la bandera PRENDIDA y una wallet inyectada, el selector NO aparece                                               | muere |
// | T-065-OLVIDAR     | flow.tsx · borrar del paso `connect` el montaje del control «Cambiar de billetera» (el único llamador de producción de `olvidar()`)                                                                                                                                                             | exit=1 |  1 | wallet-availability.test.tsx › T-065-OLVIDAR: con una elección puesta, el control «Cambiar de billetera» aparece y BORRA la elección                           | muere |
// | T-065-1           | conexion.ts · `iniciarConexion`: vaciar el `cluster` de la URL del connect                                                                                                                                                                                                                      | exit=1 |  2 | preparacion-por-enlace.test.ts › el `cluster` de la URL sale de la configuración de red y NO de un literal del módulo (+1)                                     | muere |
// | T-065-2           | conexion.ts · `completarVuelta`: pasarle `null` como `remittanceId` al lector (apaga el guard de cruce entre remesas). ⚠️ NO es el mutante que la tabla vieja describía («escritura directa en vez del lector»), que no se puede expresar como UNA sustitución: se reemplazó por éste y se dice | exit=1 |  1 | conexion.test.ts › una vuelta de OTRA remesa no se aplica sobre la que está en curso                                                                           | muere |
// | T-065-3           | sesion.ts · no comparar el ancla write-once `claveBilletera`                                                                                                                                                                                                                                    | exit=1 | 10 | firma-por-enlace.test.ts › una respuesta cifrada por OTRA clave ⇒ deeplink_tx_alterada (no es un rechazo ni una huérfana) (+9)                                 | muere |
// | T-065-4           | conexion.ts · que `firmar-tx` caiga al lector de la vuelta (quemarle el paso al motor)                                                                                                                                                                                                          | exit=1 |  2 | preparacion-por-enlace.test.ts › una vuelta con la marca del MOTOR sale `nada` y NO quema el paso que el motor necesita (+1)                                   | muere |
// | T-065-5           | conexion.ts · que la rama `conectado` devuelva un corte en vez de la dirección                                                                                                                                                                                                                  | exit=1 |  3 | preparacion-por-enlace.test.ts › la dirección que devuelve `ConnectWallet` es la que contestó la billetera por el enlace (+2)                                  | muere |
// | T-065-PUREZA      | conexion.ts · un `Date.now()` adentro de `completarVuelta` (DT-7: el módulo es puro)                                                                                                                                                                                                            | exit=1 |  1 | conexion.test.ts › ninguno de los cuatro aparece en el CÓDIGO, y el descuento de comentarios es load-bearing                                                   | muere |
// | T-065-SYNC        | preparacion-por-enlace.ts · un `await` como 1ª línea de `completar()` (CD-26: reabre la ventana de read-modify-write)                                                                                                                                                                           | exit=1 |  1 | preparacion-por-enlace.test.ts › el primer segmento de `completar()` es SÍNCRONO, y el descuento de comentarios es load-bearing                                | muere |
// | T-065-CD11-a      | flow.tsx · borrar `&& rem.ownerAddress != null` del cruce                                                                                                                                                                                                                                       | exit=1 |  2 | flow.test.tsx › con `rem.ownerAddress` en `null` y una dirección viva, el envío SIGUE ⚠️+citas                                                                 | muere |
// | T-065-CD11-b      | flow.tsx · borrar el `throw wallet_account_changed` del cruce                                                                                                                                                                                                                                   | exit=1 |  5 | flow.test.tsx › T-354-3a: con la cuenta cambiada, 'Confirmar y enviar' no llama al use-case y explica por qué (+4)                                             | muere |
// | T-065-CD11-c      | solana-wallet.ts · descablear el link-aware de `getConnectedAddress()`                                                                                                                                                                                                                          | exit=1 |  9 | container.test.ts › T-065-GATE-1b (AC-6b): con `none` y un viaje CONECTADO en el disco pero SIN elección, el container real NO entra al camino por enlace (+8) | muere |
// | T-065-7           | flow.tsx · borrar el ref de montaje del productor de la vuelta (bajo StrictMode consume el paso dos veces)                                                                                                                                                                                      | exit=1 |  1 | flow-reanudacion.test.tsx › con `dl=firmar-tx` y la remesa en `confirmed`, llama a `execute()` EXACTAMENTE una vez                                             | muere |
// | T-065-8           | flow.tsx · saltear el gate del pisón en la rama `conectado`                                                                                                                                                                                                                                     | exit=1 |  1 | flow-reanudacion.test.tsx › T-065-8b: y con la vuelta del CONNECT, si la persona ya interactuó tampoco se conecta por debajo                                   | muere |
// | T-065-9           | flow.tsx · `history.replaceState` por `location.assign` al limpiar la barra                                                                                                                                                                                                                     | exit=1 |  5 | flow-reanudacion.test.tsx › con la remesa SIN confirmar, NO llama a `execute()` aunque la barra traiga la marca (+4)                                           | muere |
// | T-065-10          | flow.tsx · limpiar la barra ANTES de leer la vuelta (DT-10)                                                                                                                                                                                                                                     | exit=1 |  1 | flow-reanudacion.test.tsx › T-065-10: con un `errorCode` en la barra, el PRIMER montaje avisa y el SEGUNDO ya no repite                                        | muere |
// | RESUME-CONFIRMED  | flow.tsx · borrar el gate `status === "confirmed"` de la reanudación                                                                                                                                                                                                                            | exit=1 |  1 | flow-reanudacion.test.tsx › con la remesa SIN confirmar, NO llama a `execute()` aunque la barra traiga la marca                                                | muere |
// | RESUME-MARCA      | flow.tsx · que CUALQUIER marca reanude (no sólo los dos pasos del motor)                                                                                                                                                                                                                        | exit=1 |  1 | flow-reanudacion.test.tsx › con una marca que NO es del motor, NO reanuda: sólo `firmar-*` viene después de una orden                                          | muere |
// | T-065-11          | nonce-duradero.ts · `createAccount` en vez de `createAccountWithSeed` ⇒ la cuenta nueva pasa a ser FIRMANTE y la tx necesita 2 firmas                                                                                                                                                           | exit=1 |  5 | nonce-duradero.test.ts › son 2 ix, `numRequiredSignatures === 1`, y el único firmante es el sender (+4)                                                        | muere |
// | T-065-11b-a       | nonce-duradero.ts · `space: 80` escrito a mano en vez de la constante (mutante EQUIVALENTE: hoy `NONCE_ACCOUNT_LENGTH` vale 80)                                                                                                                                                                 | exit=0 |  0 | — (ninguno)                                                                                                                                                    | VIVE |
// | T-065-11b-b       | nonce-duradero.ts · `space: 81` (el que SÍ distingue: es el que prueba que el `space` se mide)                                                                                                                                                                                                  | exit=1 |  1 | nonce-duradero.test.ts › T-065-11b: el `space` es el `NONCE_ACCOUNT_LENGTH` de la librería                                                                     | muere |
// | T-065-12-a        | flow.tsx · la cifra del alquiler escrita a mano en la tarjeta del nonce en vez de derivada                                                                                                                                                                                                      | exit=1 |  1 | flow.test.tsx › T-065-12: la cifra se DERIVA en el código, y no hay ningún literal de SOL en la tarjeta                                                        | muere |
// | T-065-12-b        | solana-escrow-rent.ts · mover `NONCE_ACCOUNT_RENT_LAMPORTS` un lamport                                                                                                                                                                                                                          | exit=1 |  2 | solana-escrow-rent.test.ts › la renta de la cuenta de nonce coincide con la fórmula pública de rent (dos fuentes, no un literal) (+1)                          | muere |
// | T-065-13          | solana-wallet.ts · `console.warn` en vez de cortar cuando la cuenta de nonce NO está                                                                                                                                                                                                            | exit=1 |  2 | solana-wallet.test.ts › ★ T-26: la cuenta de nonce AUSENTE ⇒ deeplink_nonce_ausente, sin firmar NADA y sin limpiar el disco (+1)                               | muere |
// | T-065-14          | solana-wallet.ts · limpiar el disco ANTES del corte por «no pudimos preguntar» (⚠️ la aguja aparece DOS veces en el archivo: por eso lleva el comentario de arriba adentro)                                                                                                                     | exit=1 |  1 | solana-wallet.test.ts › ★ T-065-14: la cuenta de nonce que NO se puede leer ⇒ deeplink_blockhash_desconocido, y el disco queda INTACTO                         | muere |
// | T-065-15          | conexion.ts · borrar la comparación de bytes contra el ancla en la vuelta del nonce                                                                                                                                                                                                             | exit=1 |  1 | conexion.test.ts › T-065-15: con OTRA transacción bien cifrada, corta y NO la devuelve                                                                         | muere |
// | T-065-16          | conexion.ts · dejar de escribir el flag `consumido` del paso del nonce (anti-replay)                                                                                                                                                                                                            | exit=1 |  1 | conexion.test.ts › T-065-16: la MISMA URL una segunda vez NO vuelve a devolver la transacción                                                                  | muere |
// | T-065-16b         | conexion.ts · devolver `DEEPLINK_VIAJE_VENCIDO` en la rama `consumido === true` (el copy que NIEGA la firma que la billetera sí dio)                                                                                                                                                            | exit=1 |  1 | conexion.test.ts › T-065-16: la MISMA URL una segunda vez NO vuelve a devolver la transacción                                                                  | muere |
// | T-065-22          | conexion.ts · `vueltaDelNonce`: devolver `DEEPLINK_VIAJE_VENCIDO` en la rama `lectura.tipo !== "hay"` (la salida del viaje vencido, la ALCANZABLE con el ancla viva)                                                                                 | exit=1 |  1 | conexion.test.ts › T-065-22: el ancla viva y el viaje vencido cortan con deeplink_nonce_sin_contexto, no con el copy que niega la firma                        | muere |
// | T-065-22b         | conexion.ts · `vueltaDelNonce`: devolver `DEEPLINK_VIAJE_VENCIDO` en la rama `ancla === null`                                                                                                                                                                   | exit=1 |  1 | conexion.test.ts › T-065-22b: la vuelta SIN ancla del paso corta con la misma causa post-vuelta                                                                | muere |
// | T-065-17          | preparacion-por-enlace.ts · que el resultado del broadcast decida en vez de la relectura de la cadena                                                                                                                                                                                           | exit=1 |  2 | preparacion-por-enlace.test.ts › el RPC aceptó la tx y la cuenta TODAVÍA no está ⇒ `nonce-en-vuelo`, NUNCA `nonce-listo` (+1)                                  | muere |
// | T-065-17b         | preparacion-por-enlace.ts · cambiar la causa del corte del broadcast por otra del vocabulario                                                                                                                                                                                                   | exit=1 |  1 | preparacion-por-enlace.test.ts › el broadcast falla y la cuenta no está ⇒ corte `deeplink_nonce_no_entro`, con reintento posible                               | muere |
// | T-065-19          | solana-wallet.ts · volver FAIL-CLOSED el guard de saldo del enlace (`unknown` deja de dejar pasar)                                                                                                                                                                                              | exit=1 |  1 | solana-wallet.test.ts › ★ T-27: saldo `unknown` (el RPC no contesta) ⇒ FAIL-OPEN, el flujo SIGUE                                                               | muere |
// | T-065-6           | firma-por-enlace.ts · restaurar la promesa vieja del `case "conectado"` («pasa a ser alcanzable»)                                                                                                                                                                                               | exit=1 |  1 | deeplink-callers.test.ts › T-065-6: el docblock del `case "conectado"` del motor ya NO promete que la rama se vuelve alcanzable                                | muere |
// | T-065-COPY-1      | firma-por-enlace.ts + flow-vm.ts · una causa nueva cuyo «copy» es SÓLO un comentario (el mutante del CR, re-corrido)                                                                                                                                                                            | exit=1 |  2 | deeplink-callers.test.ts › TODAS las causas derivadas tienen copy PROPIO (no basta con que el texto aparezca en un comentario) ⚠️+citas                        | muere |
// | T-065-COPY-2      | flow-vm.ts · colapsar dos de los tres pares del mensaje al MISMO texto                                                                                                                                                                                                                          | exit=1 |  2 | deeplink-callers.test.ts › T-065-COPY-2: los tres pares del mensaje son textos DISTINTOS entre sí                                                              | muere |
// | T-065-COPY-3      | flow-vm.ts · meter «se debitó» en una de las causas del `Record`                                                                                                                                                                                                                                | exit=1 |  1 | flow-vm.test.ts › T-065-COPY-3: NINGÚN copy afirma que se movió plata, y ninguno tiene em dashes                                                               | muere |
// | T-065-COPY-4      | flow-vm.ts · mover el lookup EXACTO del `Record` al final de `humanError`, después de la cadena de `includes` (DT-8)                                                                                                                                                                            | exit=1 |  1 | flow-vm.test.ts › T-065-COPY-4: el lookup exacto corre ANTES de la cadena de `includes`                                                                        | muere |
// | T-065-18          | flow-vm.ts · la cifra del umbral escrita a mano en el copy de saldo insuficiente en vez de derivada                                                                                                                                                                                             | exit=1 |  1 | flow-vm.test.ts › T-065-18: y esa cifra se DERIVA en el código: no hay ningún literal de SOL en el `Record`                                                    | muere |
// | T-065-CD11b-1     | firma-por-enlace.ts · borrar «camino inyectado» del docblock de `PedidoDeFirma.sender` (la frase vieja no calificaba el camino)                                                                                                                                                                 | exit=1 |  1 | deeplink-callers.test.ts › T-065-CD11b: los TRES sitios de CD-11 califican el camino, y ninguno se borró                                                       | muere |
// | T-065-CD11b-2     | firma-por-enlace.ts · borrar «coherencia interna» de la justificación del guard                                                                                                                                                                                                                 | exit=1 |  1 | deeplink-callers.test.ts › T-065-CD11b: los TRES sitios de CD-11 califican el camino, y ninguno se borró                                                       | muere |
// | T-065-CD11b-3     | solana-wallet.ts · borrar «COHERENCIA INTERNA» del bloque de CD-11 del adaptador                                                                                                                                                                                                                | exit=1 |  1 | deeplink-callers.test.ts › T-065-CD11b: los TRES sitios de CD-11 califican el camino, y ninguno se borró                                                       | muere |
// | T-065-UNREACH     | flow.tsx · apagar `prepareUnreachable` en el dispatch de `track` (los dos enums vuelven al copy del payout fallido)                                                                                                                                                                             | exit=1 |  2 | flow.test.tsx › NO LLEGAMOS A PREPARAR (payout_pop_unavailable): no lo dice como un payout fallido y no manda a sacar del escrow (+1)                          | muere |
// | T-065-TECHO       | preparacion-por-enlace.ts · sacarle el techo al `getLatestBlockhash` de `crearCuentaDeNonce`                                                                                                                                                                                                    | exit=1 |  1 | preparacion-por-enlace.test.ts › un RPC que acepta y NO contesta vence por el techo: la promesa RECHAZA en vez de colgar la pantalla                           | muere |
//
// ── LOS DOS QUE NO MUEREN, Y NINGUNO ES UN AGUJERO ────────────────────────────────────────────────
//
// · **`T-065-11b-a`** (`space: 80` a mano) VIVE, y estaba PREDICHO en el `it` antes de correrlo:
//   `NONCE_ACCOUNT_LENGTH` vale 80 hoy, así que el literal y la constante dan lo mismo y **ningún input
//   los distingue**. Es un mutante EQUIVALENTE, no una falta de cobertura. El que sí distingue es
//   `T-065-11b-b` (`space: 81`), que mata. La segunda fuente (`NONCE_ACCOUNT_LENGTH === 80` escrita a
//   mano en el `it`) es lo que hace que un bump de la librería se caiga en un test y no en producción.
// · **`CALIBRACION-VIVE`** (la `const` sin efecto) vive por diseño: es la mitad que valida el
//   instrumento. Su hermana `CALIBRACION-MUERE` tiene que morir, y muere. Si las dos murieran o las dos
//   vivieran, la batería no estaría midiendo el árbol.
//
// ── LO QUE LA BATERÍA DESCUBRIÓ, Y ES SU VALOR REAL ───────────────────────────────────────────────
//
// **En la corrida original de F3**, cuatro mutantes sobrevivieron y ninguno era equivalente. Los cuatro
// se cerraron:
//   1. **`T-065-19`** (borrar `saldo.status === "known" &&`) vivía porque era EQUIVALENTE: con
//      `status: "unknown"`, `saldo.lamports` es `undefined` y `undefined < N` es `false`, así que el
//      guard tampoco cortaba. El mutante que sí distingue es volverlo **fail-CLOSED**, y ése mata.
//      ⚠️ Lección: un mutante que sobrevive puede estar midiendo mal el MUTANTE, no el test.
//   2. **`T-065-CD11-a`** (borrar `&& rem.ownerAddress != null`) no mataba a NADIE, y el comentario de
//      `T-065-CD11` afirmaba que «mata a los que miden el residual». No existía ninguno. Se escribió.
//   3. **`RESUME-MARCA`** (que cualquier marca reanude) sobrevivía porque el `it` de `dl=conectar`
//      cortaba ANTES del gate de la marca: su fixture no llegaba a lo que decía medir. Se agregó un
//      `it` con una marca que nadie escribió, que es la que llega.
//   4. **`T-065-14`** (limpiar el disco antes del corte por «no pudimos preguntar») sobrevivía porque
//      el `it` que existía mide el OTRO `throw` del mismo mensaje —el de la vuelta, no el de la ida—.
//      Son dos sitios y sólo uno tenía candado. Se escribió el que faltaba.
//
// **En la corrida del FIX-PACK**, con el harness ya commiteado, sobrevivió UNO más y tampoco era
// equivalente:
//   5. 🔴 **`T-065-8`** (apagar el gate del pisón de la rama `conectado`). `flow.tsx` tiene DOS
//      `if (yaInteractuo.current)` en el mismo productor y sólo el de la REANUDACIÓN tenía `it`. Con
//      `if (false) return;` en el del CONNECT la suite quedaba **2685 passed, exit 0**: ese gate no lo
//      custodiaba nadie. Sin él, volver del connect mientras la persona tipea le pide un `connect()` a la
//      billetera y después va a la CADENA a leer la cuenta de nonce, en el medio de un formulario. Se
//      escribieron `T-065-8b` y su par negativo, y con ellos el mutante muere con 1 rojo.
//
// ⚠️ Y DOS HALLAZGOS SOBRE EL INSTRUMENTO, los dos de la regla 2 de CD-23 (contar la aguja y exigir
// `== 1`), que es la que impide que un mutante toque dos sitios y su veredicto no valga:
//   · `T-065-14` arrancó roto en F3: su aguja (`throw new Error("deeplink_blockhash_desconocido");`)
//     aparece **DOS veces** en el adaptador. Hoy la fila lleva el comentario de arriba adentro de la
//     aguja, y está declarado en la propia fila.
//   · `T-065-GATE-4` arrancó roto en el FIX-PACK, por lo mismo:
//     `if (this.firmaPorEnlace && this.caminoPorEnlace() !== null) {` aparece **DOS veces**. Se copió del
//     texto de la tabla vieja, que lo describía por número de línea (`:897`); un número de línea no es
//     una aguja. Se amplió con la línea de arriba.
//
// ⚠️ POR QUÉ `GATE-4` DA UN NÚMERO GRANDE (**47**): invierte el `if` de la rama del nonce durable, así
// que TODO el `describe` del adaptador entra por el camino equivocado. Los 47 `it` que mueren son de
// `solana-wallet.test.ts` y `solana-deposit-beneficiary.test.ts`, o sea del adaptador, los 47 (verificado
// leyendo la columna `itsRojos` de la corrida de `b4f7e6d`).
//
// 🔴 EL MOVIMIENTO 56 → 47 NO SE EXPLICA COMO DECÍA ACÁ, y la explicación vieja la refuta la medición
// (re-AR it2 · BLQ-BAJO-3). Decía: «los `it` del adaptador declaran ahora las TRES condiciones del gate,
// así que varios cortan antes por la bandera en vez de por la inversión». **Falso por las dos puntas.**
// La descomposición real tiene TRES tramos y sólo el último es del árbol:
//
//     56  ← medido en F3 **con la aguja ROTA**, la pelada, que aparece DOS veces en el archivo
//     52  ← `a301c44` (base del fix-pack) con la aguja BUENA · medición del re-AR it2
//     47  ← `a8c0692` y también `b4f7e6d` con la aguja buena · re-derivado acá
//
// ⇒ **4 de los 9 puntos son cambio de INSTRUMENTO, no del árbol**, y esta misma tabla lo dice cinco
// líneas más arriba: la aguja pelada tocaba dos sitios. Y los 5 restantes **no son `it` del adaptador**:
// son de `agent-plan-card`, `bienvenida-composicion` (el flake), `flow.test`, `honest-copy` y
// `refund-perdido-registro-mudo` — cuatro de esos archivos el fix-pack ni los toca, y **cero `it` nuevos
// entraron al conjunto**. Son `it` de UI sensibles a carga, no cobertura perdida.
// ⛔ QUÉ NO ES MÍO EN ESE CUADRO: los tramos `56` y `52` los midió el re-AR it2 sobre `a301c44`, y **no
// los re-derivé**. Lo que sí re-derivé es el `47` y su composición. Quien quiera el cuadro entero lo
// re-corre con `--solo T-065-GATE-4` sobre cada sha.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
