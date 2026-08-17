// WKH-358 / OLA 4 · LA COSTURA DEL RECORRIDO POR ENLACE, CABLEADA CONTRA EL NAVEGADOR.
//
// 🔴 QUÉ MIDE ESTE ARCHIVO Y QUÉ MIDE `conexion.test.ts`. Allá está la lógica PURA (qué se escribe en
// el disco, qué dice la URL, qué desenlace sale de cada vuelta) y se puede probar sin navegador. Acá
// se mide **el cableado**: que esta clase le pase el mundo real —el `localStorage`, la URL, el reloj,
// el cluster— a esa lógica, y que no lo pase mal. Un `it` de acá que no toque `globalThis` está
// midiendo lo de allá otra vez.
//
// ⛔ Y LO QUE ESTA HU NO ENTREGA: el depósito por enlace NO cierra con esto (`prepare()` exige un PoP
// del bridge, que en un móvil sin extensión está vacío ⇒ `payout_pop_unavailable`). Es WKH-359.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import nacl from "tweetnacl";
import bs58 from "bs58";
import type { BilleteraDeeplink } from "./deeplink/protocol";
import type { Viaje } from "./deeplink/sesion";
import { MARCA } from "./deeplink/sesion";
import { RecorridoPorEnlaceReal } from "./preparacion-por-enlace";
import { SolanaWalletAdapter } from "../solana-wallet";
import { solanaWalletBridge } from "../solana-wallet-bridge";
import { ConnectWallet } from "../../application/use-cases/connect-wallet";
import { FakeKycStore } from "../../test-support/fakes";
import { resolveSolanaNetworkConfig } from "../chain";

const CLAVE_VIAJE = "chaski.billetera.viaje.v1";
const CLAVE_ELECCION = "chaski.billetera.eleccion.v1";
const REM = "rem-1";
const ORIGEN = "https://chaski.test";
const HREF = `${ORIGEN}/enviar?kyc=return`;
const DIRECCION = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// ⛔ ESCRITO A MANO A PROPÓSITO (mismo criterio que `sesion.test.ts`): es el oráculo independiente.
const NOMBRE_DE_LA_CLAVE: Record<BilleteraDeeplink, string> = {
  phantom: "phantom_encryption_public_key",
  solflare: "solflare_encryption_public_key",
};

/** `localStorage` de mentira, con la misma superficie que usa el código de producción. */
function montarNavegador(href = HREF) {
  const disco = new Map<string, string>();
  const storage = {
    getItem: (k: string) => disco.get(k) ?? null,
    setItem: (k: string, v: string) => void disco.set(k, v),
    removeItem: (k: string) => void disco.delete(k),
    clear: () => disco.clear(),
    key: () => null,
    length: 0,
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("location", { href, origin: ORIGEN });
  return {
    disco,
    /** Mueve la URL de este "navegador" sin re-montar nada, igual que una vuelta de la billetera. */
    navegarA: (nuevo: string) => vi.stubGlobal("location", { href: nuevo, origin: ORIGEN }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  solanaWalletBridge.setWalletAvailability("unknown");
  solanaWalletBridge.setState({ publicKey: null, connected: false });
});

function respuestaDeLaBilletera(
  cuerpo: unknown,
  publicaDeLaApp: Uint8Array,
  quien: nacl.BoxKeyPair,
  billetera: BilleteraDeeplink = "phantom",
): Record<string, string> {
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

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// EL CRITERIO DE SALIDA DE LA WAVE, EN UN SOLO `it` (AC-1)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 EL RECORRIDO ENTERO Y SIN ATAJOS: la persona elige en el selector ⇒ sale la URL del connect ⇒ la
// billetera contesta a NUESTRO origen ⇒ la dirección queda en el disco ⇒ `ConnectWallet` la devuelve
// **sin tocar el bridge**. Nada de esto se siembra a mano: cada paso recibe lo que produjo el anterior.
//
// ⚠️ POR QUÉ EL BRIDGE VACÍO ES LA MITAD QUE IMPORTA: en un teléfono sin extensión ése ES el estado
// real, y hasta esta HU `getAddress()` sólo sabía preguntarle a él. Un `it` que dejara el bridge con
// una cuenta puesta no distinguiría el camino nuevo del de siempre.
describe("AC-1: selector → URL → vuelta → disco → `ConnectWallet`, sin tocar el bridge", () => {
  it("la dirección que devuelve `ConnectWallet` es la que contestó la billetera por el enlace", async () => {
    const nav = montarNavegador();
    const billetera = nacl.box.keyPair();
    const recorrido = new RecorridoPorEnlaceReal();

    // 1 · el gesto de la persona en el selector.
    const { irA } = recorrido.elegir({ billetera: "phantom", remittanceId: REM });
    expect(recorrido.eleccion(), "la elección no se persistió: el gate del adaptador no se enciende").toBe("phantom");
    expect(recorrido.remesaEnCurso()).toBe(REM);

    // 2 · la URL que produjo el módulo. La clave de la app sale DE ACÁ, no de un fixture.
    const q = new URL(irA).searchParams;
    const publicaDeLaApp = bs58.decode(q.get("dapp_encryption_public_key") as string);
    const redirectLink = q.get("redirect_link") as string;
    expect(new URL(irA).host).toBe("phantom.app");
    expect(new URL(redirectLink).origin).toBe(ORIGEN);

    // 3 · la billetera vuelve a NUESTRO origen. El "navegador" cambia de URL, como en un redirect.
    nav.navegarA(
      hrefDeVuelta(
        redirectLink,
        respuestaDeLaBilletera({ public_key: DIRECCION, session: "sess-1" }, publicaDeLaApp, billetera),
      ),
    );

    // CD-18 — el fixture fabricó el caso: ANTES de completar no hay ninguna dirección en el disco.
    expect((JSON.parse(nav.disco.get(CLAVE_VIAJE) as string) as Viaje).direccion).toBeUndefined();

    const res = await recorrido.completar({ remittanceId: REM });
    expect(res).toEqual({ estado: "conectado", direccion: DIRECCION });

    // 4 · el gate del adaptador. `availability === "none"` es lo que hay en un teléfono sin extensión.
    solanaWalletBridge.setWalletAvailability("none");
    expect(
      solanaWalletBridge.getState().publicKey,
      "el bridge tiene una cuenta: este `it` ya no mide el camino por enlace",
    ).toBeNull();

    const wallet = new SolanaWalletAdapter();
    const r = await new ConnectWallet(wallet, new FakeKycStore()).execute();

    expect(r.address, "`ConnectWallet` no encontró la cuenta del enlace: el recorrido no cierra").toBe(DIRECCION);
    expect(await wallet.getAddress()).toBe(DIRECCION);
    expect(await wallet.getConnectedAddress()).toBe(DIRECCION);
  });

  it("CONTROL: sin la elección persistida, el gate está apagado y el bridge vuelve a mandar", async () => {
    const nav = montarNavegador();
    const recorrido = new RecorridoPorEnlaceReal();
    recorrido.elegir({ billetera: "phantom", remittanceId: REM });
    const q = new URL(recorrido.elegir({ billetera: "phantom", remittanceId: REM }).irA).searchParams;
    const publicaDeLaApp = bs58.decode(q.get("dapp_encryption_public_key") as string);
    nav.navegarA(
      hrefDeVuelta(
        q.get("redirect_link") as string,
        respuestaDeLaBilletera({ public_key: DIRECCION, session: "s" }, publicaDeLaApp, nacl.box.keyPair()),
      ),
    );
    await recorrido.completar({ remittanceId: REM });
    expect((JSON.parse(nav.disco.get(CLAVE_VIAJE) as string) as Viaje).direccion).toBe(DIRECCION);

    // 🔴 LA ÚNICA VARIABLE QUE SE MUEVE: se borra la elección. El disco sigue teniendo la dirección.
    nav.disco.delete(CLAVE_ELECCION);
    solanaWalletBridge.setWalletAvailability("none");
    expect(await new SolanaWalletAdapter().getConnectedAddress()).toBeNull();
  });

  it("CONTROL: con `availability === \"injected\"` el gate tampoco se enciende (AC-6)", async () => {
    const nav = montarNavegador();
    const recorrido = new RecorridoPorEnlaceReal();
    const q = new URL(recorrido.elegir({ billetera: "phantom", remittanceId: REM }).irA).searchParams;
    nav.navegarA(
      hrefDeVuelta(
        q.get("redirect_link") as string,
        respuestaDeLaBilletera(
          { public_key: DIRECCION, session: "s" },
          bs58.decode(q.get("dapp_encryption_public_key") as string),
          nacl.box.keyPair(),
        ),
      ),
    );
    await recorrido.completar({ remittanceId: REM });
    // CD-18 — el fixture fabricó el caso: la elección ESTÁ y la dirección ESTÁ. Lo único distinto es
    // la disponibilidad.
    expect(recorrido.eleccion()).toBe("phantom");
    expect((JSON.parse(nav.disco.get(CLAVE_VIAJE) as string) as Viaje).direccion).toBe(DIRECCION);

    solanaWalletBridge.setWalletAvailability("injected");
    expect(await new SolanaWalletAdapter().getConnectedAddress()).toBeNull(); // el bridge está vacío y MANDA
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// El cableado del mundo: disco ausente, cluster, orden de las escrituras
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("el cableado contra el navegador", () => {
  it("sin `localStorage`, `elegir` TIRA y `completar` corta con una causa traducible", async () => {
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("location", { href: HREF, origin: ORIGEN });
    const recorrido = new RecorridoPorEnlaceReal();
    expect(() => recorrido.elegir({ billetera: "phantom", remittanceId: REM })).toThrow("deeplink_sin_memoria");
    // ⛔ Y NO `{estado:"nada"}`: "no había marca nuestra" y "no podemos leer el disco" son cosas
    // distintas, y colapsarlas dejaría a la persona sin ningún diagnóstico tras volver del salto.
    expect(await recorrido.completar({ remittanceId: REM })).toEqual({
      estado: "corte",
      causa: "deeplink_sin_memoria",
    });
    expect(recorrido.remesaEnCurso()).toBeNull();
    expect(() => recorrido.olvidar()).not.toThrow();
  });

  // 🔴 DOS FUENTES, COMO PIDE CD-20, y por qué hacen falta las dos: la primera compara la URL contra
  // el valor que ESCRIBE la configuración de red; la segunda ata esa configuración a la cadena
  // `"devnet"` escrita A MANO acá. Con una sola, mover el cluster de producción movería los dos lados
  // a la vez y ningún `it` lo notaría — y el default de las dos billeteras es `mainnet-beta`, o sea
  // que el modo de falla es "la persona autoriza sobre la red equivocada".
  // ⚠️ Y LO QUE ESTE PAR NO PRUEBA: hoy `resolveSolanaNetworkConfig()` devuelve una constante pinneada
  // (`chain.ts:18`), no una env. El día que se lea de una env, el `it` de abajo es el que hay que
  // mover, y el de arriba tiene que seguir verde sin tocarse.
  it("el `cluster` de la URL sale de la configuración de red y NO de un literal del módulo", () => {
    const nav = montarNavegador();
    const q = new URL(
      new RecorridoPorEnlaceReal().elegir({ billetera: "solflare", remittanceId: REM }).irA,
    ).searchParams;
    expect(q.get("cluster")).toBe(resolveSolanaNetworkConfig().cluster);
    expect(nav.disco.get(CLAVE_ELECCION)).toBe("solflare");
  });

  it("y esa configuración es `devnet` — la cadena va escrita a mano, que es la SEGUNDA fuente", () => {
    expect(resolveSolanaNetworkConfig().cluster).toBe("devnet");
  });

  it("PRIMERO la elección y DESPUÉS el viaje: un disco que rechaza el viaje deja la elección puesta", () => {
    const nav = montarNavegador();
    const real = nav.disco.set.bind(nav.disco);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => nav.disco.get(k) ?? null,
      setItem: (k: string, v: string) => {
        // ⚠️ El orden inverso dejaría a la persona volviendo del salto SIN elección, y con eso el gate
        // `caminoPorEnlace()` apagado: el recorrido caería al camino inyectado EN SILENCIO.
        if (k === CLAVE_VIAJE) throw new Error("cuota_llena");
        real(k, v);
      },
      removeItem: (k: string) => void nav.disco.delete(k),
      clear: () => nav.disco.clear(),
      key: () => null,
      length: 0,
    });
    expect(() => new RecorridoPorEnlaceReal().elegir({ billetera: "phantom", remittanceId: REM })).toThrow("cuota_llena");
    expect(nav.disco.get(CLAVE_ELECCION), "la elección se perdió con el viaje").toBe("phantom");
  });

  it("`olvidar` borra la elección Y el viaje: cambiar de billetera no puede dejar el ancla vieja", () => {
    const nav = montarNavegador();
    const recorrido = new RecorridoPorEnlaceReal();
    recorrido.elegir({ billetera: "phantom", remittanceId: REM });
    expect(nav.disco.has(CLAVE_VIAJE)).toBe(true);
    recorrido.olvidar();
    expect(nav.disco.has(CLAVE_ELECCION)).toBe(false);
    expect(nav.disco.has(CLAVE_VIAJE), "quedó el viaje de la billetera anterior: el ancla es write-once").toBe(false);
  });

  it("un montaje SIN vuelta contesta `nada` y no toca el disco", async () => {
    const nav = montarNavegador();
    const recorrido = new RecorridoPorEnlaceReal();
    recorrido.elegir({ billetera: "phantom", remittanceId: REM });
    const antes = nav.disco.get(CLAVE_VIAJE) as string;
    expect(await recorrido.completar({ remittanceId: REM })).toEqual({ estado: "nada" });
    expect(nav.disco.get(CLAVE_VIAJE)).toBe(antes);
  });

  it("una vuelta con la marca del MOTOR sale `nada` y NO quema el paso que el motor necesita", async () => {
    const nav = montarNavegador();
    const recorrido = new RecorridoPorEnlaceReal();
    const q = new URL(recorrido.elegir({ billetera: "phantom", remittanceId: REM }).irA).searchParams;
    const u = new URL(
      hrefDeVuelta(
        q.get("redirect_link") as string,
        respuestaDeLaBilletera(
          { public_key: DIRECCION, session: "s" },
          bs58.decode(q.get("dapp_encryption_public_key") as string),
          nacl.box.keyPair(),
        ),
      ),
    );
    u.searchParams.set(MARCA, "firmar-tx");
    nav.navegarA(u.toString());
    const antes = nav.disco.get(CLAVE_VIAJE) as string;
    expect(await recorrido.completar({ remittanceId: REM })).toEqual({ estado: "nada" });
    expect(nav.disco.get(CLAVE_VIAJE)).toBe(antes);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-065-SYNC (CD-26 / DT-7) — cero `await` ANTES de leer la vuelta
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ PROTEGE Y POR QUÉ NO ALCANZA UN `it` DE COMPORTAMIENTO. La atomicidad del lector de la vuelta
// depende de que la lectura del disco y su escritura vivan en el MISMO tick: es un read-modify-write
// sobre `localStorage`, que es compartido entre pestañas del mismo origen. Un `await` metido antes
// reabre exactamente la ventana que el fix-pack 2 de la ola 1 cerró — y **no la abre en la corrida del
// test**, porque nada intercala en un runner de un solo hilo. Por eso el candado es TEXTUAL: mide que
// no exista la forma, no que una corrida no la haya ejercido.
//
// ⚠️ LO QUE ESTE CANDADO NO VE, dicho antes de que alguien se apoye en su verde: un `await` escondido
// adentro de una función que `completar()` llame antes de leer la vuelta. Mira el cuerpo de este
// método, no su árbol de llamadas.
//
// LAS TRES REGLAS DE CD-19: (a) descuenta comentarios —el docblock de `completar()` escribe la palabra
// `await` para prohibirla—; (b) asserta que después del descuento QUEDA el código que cree mirar; y
// (c) asserta que el descuento **cambia una cantidad medida**.
//
// MUTANTE QUE MATA: insertar `await Promise.resolve();` como PRIMERA línea del cuerpo de `completar()`.
// (MEDIDO en la batería de §9.)
describe("T-065-SYNC: en `completar()` no hay ningún `await` antes de leer la vuelta", () => {
  const RUTA = path.join(__dirname, "preparacion-por-enlace.ts");

  function sinComentarios(fuente: string): string {
    return fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  }

  it("el primer segmento de `completar()` es SÍNCRONO, y el descuento de comentarios es load-bearing", () => {
    const bruto = readFileSync(RUTA, "utf8");
    const desde = bruto.indexOf("async completar(i: { remittanceId: string })");
    expect(desde, "no se encontró `completar` en el archivo").toBeGreaterThan(0);
    // El método termina donde arranca la llave de cierre de la clase. Se corta en el `switch`, que es
    // lo último del primer segmento síncrono: todo lo de después ya puede tener `await`.
    const hasta = bruto.indexOf("switch (vuelta.tipo)", desde);
    expect(hasta, "no se encontró el final del primer segmento").toBeGreaterThan(desde);

    const cuerpo = sinComentarios(bruto.slice(desde, hasta));

    // (b) el descuento no se comió el código que este barrido cree estar mirando.
    for (const ancla of ["completarVuelta({", "this.entorno()", "Date.now()"]) {
      expect(cuerpo, `el descuento de comentarios se llevó \`${ancla}\``).toContain(ancla);
    }

    // (c) el descuento CAMBIA una cantidad medida: la palabra prohibida SÍ está en el docblock. Sin
    // esta afirmación, un `sinComentarios` roto pasaría igual y nadie lo notaría.
    const brutoDelBloque = bruto.slice(desde - 1400, hasta);
    const awaitsEnBruto = (brutoDelBloque.match(/await/g) ?? []).length;
    const awaitsDescontado = (sinComentarios(brutoDelBloque).match(/await/g) ?? []).length;
    expect(
      awaitsEnBruto,
      "la palabra `await` no aparece en los comentarios ⇒ descontarlos no cambia nada y el barrido es decorativo",
    ).toBeGreaterThan(awaitsDescontado);

    // (a) y el barrido: cero `await` en el primer segmento.
    expect(
      cuerpo.includes("await"),
      "`completar()` tiene un `await` ANTES de leer la vuelta (CD-26): eso reabre la ventana de " +
        "read-modify-write sobre `localStorage` que el fix-pack 2 de la ola 1 cerró.",
    ).toBe(false);
  });
});
