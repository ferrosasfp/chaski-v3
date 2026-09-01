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
import { hrefSinRastroDeVuelta } from "./deeplink/conexion"; // fix-pack · AR/BLQ-MED-1: el `it` nuevo aplica LA MISMA función que el productor, no una limpieza escrita a mano
import { RecorridoPorEnlaceReal } from "./preparacion-por-enlace";
import { SolanaWalletAdapter } from "../solana-wallet";
import { solanaWalletBridge } from "../solana-wallet-bridge";
import { ConnectWallet } from "../../application/use-cases/connect-wallet";
import { Connection, Keypair, Message, SystemProgram, Transaction } from "@solana/web3.js";
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
  // 🔴 LA 3ª CONDICIÓN DEL GATE, DECLARADA ACÁ (fix-pack · AR/BLQ-MED-1). Se declara en el montaje del
  // navegador y no en cada `it` porque es parte del ESTADO DEL MUNDO que el recorrido por enlace
  // necesita, igual que el `localStorage`: sin la bandera prendida el gate del adaptador contesta
  // `null` y ningún `it` de este archivo mide lo que dice medir. El `afterEach` de acá abajo la limpia.
  // ⚠️ Los dos `it` de CONTROL que apagan el gate lo hacen moviendo UNA sola variable (la elección o la
  // disponibilidad) y NO ésta: si apagaran la bandera medirían la condición nueva y no la suya.
  vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
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

  // 🔴 T-065-GATE-5 (AC-9 · fix-pack · AR/BLQ-MED-1) — LA BANDERA APAGADA REPLIEGA EL GATE, Y ESTE `it`
  // ES LA MITAD QUE NO EXISTÍA. Es el caso del rollback: un dispositivo que YA eligió (la elección no
  // expira y hasta el fix-pack nada de producción la borraba) contra un build con la bandera ausente.
  // Antes del fix-pack el gate no leía ninguna `process.env`, así que ese teléfono se quedaba con
  // `caminoPorEnlace()` devolviendo `"phantom"` para siempre y sin puerta de vuelta: la superficie NO
  // era replegable, que es exactamente lo que AC-9 pide poder hacer.
  //
  // ⚠️ ES EL PAR NEGATIVO DEL `it` DE ARRIBA («AC-1: selector → … → `ConnectWallet`»), que monta la
  // MISMA siembra con la bandera PRENDIDA y obtiene `DIRECCION`. Los dos juntos son lo que hace que la
  // bandera sea lo único que decide; uno solo no distingue "replegó" de "nunca se enciende".
  //
  // MUTANTE QUE MATA: en `solana-wallet.ts`, en `caminoPorEnlace()`, borrar
  // `if (!resolveSolanaDeeplinkEnabled()) return null;` ⇒ el gate vuelve a las dos condiciones viejas y
  // este `it` recibe `DIRECCION` en vez de `null`.
  it("T-065-GATE-5: con la bandera del build APAGADA, el gate NO se enciende aunque la elección y la dirección estén", async () => {
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
    solanaWalletBridge.setWalletAvailability("none");
    // CD-18 — LAS DOS CONDICIONES VIEJAS ESTÁN CUMPLIDAS, y hay que probarlo antes de apagar la bandera:
    // con la bandera prendida este mismo estado devuelve la dirección del enlace. Sin esta línea, el
    // `toBeNull()` de abajo podría estar pasando porque la siembra nunca llegó a encender nada.
    expect(recorrido.eleccion(), "el fixture no dejó la elección puesta").toBe("phantom");
    expect((JSON.parse(nav.disco.get(CLAVE_VIAJE) as string) as Viaje).direccion).toBe(DIRECCION);
    expect(
      await new SolanaWalletAdapter().getConnectedAddress(),
      "con la bandera PRENDIDA la siembra tiene que encender el gate, o este `it` no mide la bandera",
    ).toBe(DIRECCION);

    // 🔴 LA ÚNICA VARIABLE QUE SE MUEVE: la bandera del build. El disco no se toca.
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", undefined as unknown as string);
    expect(
      await new SolanaWalletAdapter().getConnectedAddress(),
      "la bandera apagada NO replegó el gate: un build de rollback deja a este dispositivo con el " +
        "camino por enlace encendido y sin ninguna puerta de vuelta (AR/BLQ-MED-1).",
    ).toBeNull();
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
  // ((`cluster`, `../chain.ts:18`)), no una env. El día que se lea de una env, el `it` de abajo es el que hay que
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
// (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`, que trae exit, `it` rojos y el árbol de los 54, y se re-corre con `node scripts/mutacion/bateria-065.mjs`.)
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

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-065-17 (AC-5 / §4.4) — la confirmación le pregunta a la CADENA por la CUENTA, no por la firma
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 LA DISTINCIÓN QUE ESTE BLOQUE PROTEGE: "el RPC aceptó la transacción" **no es** "la cuenta
// existe". Un `sendRawTransaction` que resuelve dice que el nodo la admitió en su cola, no que haya
// entrado en un bloque ni que haya hecho lo que queríamos. El veredicto sale de RELEER la cuenta, y de
// esa relectura salen TRES estados, no dos.
describe("T-065-17: transmitir y confirmar", () => {
  const CLAVE_NONCE = "chaski.billetera.nonce.v1";
  const SENDER = Keypair.generate();

  /** Los 80 bytes de una cuenta de nonce inicializada. Mismo layout que el fixture del módulo. */
  function bytesDeCuentaDeNonce(): Buffer {
    return Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([1, 0, 0, 0]),
      SENDER.publicKey.toBuffer(),
      Keypair.generate().publicKey.toBuffer(),
      Buffer.alloc(8),
    ]);
  }

  /** La cadena de mentira: qué contesta `getAccountInfo` para la PDA del nonce del sender. */
  function mockCadena(respuesta: Buffer | null | "throw") {
    vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation((async () => {
      if (respuesta === "throw") throw new Error("rpc_down");
      return respuesta === null
        ? null
        : { data: respuesta, executable: false, lamports: 1, owner: SystemProgram.programId, rentEpoch: 0 };
    }) as never);
  }

  /** Una transacción firmada por el sender, con su ancla, y el disco listo para su vuelta. */
  function prepararVueltaDelNonce(nav: ReturnType<typeof montarNavegador>) {
    const billetera = nacl.box.keyPair();
    const recorrido = new RecorridoPorEnlaceReal();
    const q = new URL(recorrido.elegir({ billetera: "phantom", remittanceId: REM }).irA).searchParams;
    const publicaDeLaApp = bs58.decode(q.get("dapp_encryption_public_key") as string);
    const redirectLink = q.get("redirect_link") as string;
    nav.navegarA(
      hrefDeVuelta(
        redirectLink,
        respuestaDeLaBilletera({ public_key: SENDER.publicKey.toBase58(), session: "s" }, publicaDeLaApp, billetera),
      ),
    );
    // El connect, por camino de producción: deja el viaje conectado y el ancla `claveBilletera` fijada.
    return { recorrido, publicaDeLaApp, redirectLink, billetera, nav };
  }

  function transaccionFirmada() {
    const tx = new Transaction({
      feePayer: SENDER.publicKey,
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    });
    tx.add(
      SystemProgram.transfer({ fromPubkey: SENDER.publicKey, toPubkey: SENDER.publicKey, lamports: 1 }),
    );
    const mensajeBase64 = Buffer.from(tx.serializeMessage()).toString("base64");
    tx.sign(SENDER);
    return { base58: bs58.encode(tx.serialize()), mensajeBase64 };
  }

  async function volverDelSaltoDelNonce(
    respuestaDeLaCadena: Buffer | null | "throw",
    broadcast: "ok" | "falla",
  ) {
    const nav = montarNavegador();
    const ctx = prepararVueltaDelNonce(nav);
    await ctx.recorrido.completar({ remittanceId: REM }); // consume el connect
    const { base58, mensajeBase64 } = transaccionFirmada();
    nav.disco.set(CLAVE_NONCE, JSON.stringify({ mensajeBase64, desde: Date.now() }));
    const u = new URL(
      hrefDeVuelta(ctx.redirectLink, respuestaDeLaBilletera({ transaction: base58 }, ctx.publicaDeLaApp, ctx.billetera)),
    );
    u.searchParams.set(MARCA, "crear-nonce");
    nav.navegarA(u.toString());
    mockCadena(respuestaDeLaCadena);
    const envio = vi.spyOn(Connection.prototype, "sendRawTransaction");
    if (broadcast === "ok") envio.mockResolvedValue("firma-1" as never);
    else envio.mockRejectedValue(new Error("blockhash not found"));
    return { res: await ctx.recorrido.completar({ remittanceId: REM }), envio, nav };
  }

  // MUTANTE QUE MATA: en `preparacion-por-enlace.ts`, devolver `{estado:"nonce-listo"}` con el
  // resultado del `sendRawTransaction` SIN releer la cuenta. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`, que trae exit, `it` rojos y el árbol de los 54, y se re-corre con `node scripts/mutacion/bateria-065.mjs`.)
  it("el RPC aceptó la tx y la cuenta TODAVÍA no está ⇒ `nonce-en-vuelo`, NUNCA `nonce-listo`", async () => {
    const { res, envio } = await volverDelSaltoDelNonce(null, "ok");
    expect(envio, "no se transmitió nada").toHaveBeenCalledTimes(1);
    expect(
      res,
      "se afirmó que la cuenta existe con el resultado del broadcast: 'el RPC aceptó la tx' no es " +
        "'la cuenta existe'",
    ).toEqual({ estado: "nonce-en-vuelo" });
  });

  it("la cadena confirma la cuenta ⇒ `nonce-listo`, con la firma del broadcast para la traza", async () => {
    const { res } = await volverDelSaltoDelNonce(bytesDeCuentaDeNonce(), "ok");
    expect(res).toEqual({ estado: "nonce-listo", firma: "firma-1" });
  });

  // 🔴 EL TERCER VALOR, que es el que siempre se pierde. ⛔ NO se colapsa en `no-hay`: eso sería
  // convertir "no pude preguntar" en "no pasó".
  it("la cadena no contesta ⇒ `nonce-no-sabemos`, que no afirma NADA sobre la cuenta", async () => {
    const { res } = await volverDelSaltoDelNonce("throw", "ok");
    expect(res).toEqual({ estado: "nonce-no-sabemos" });
  });

  // 🔴 LA CAUSA CAMBIÓ EN EL FIX-PACK, Y NO ES UN RENOMBRE (CR/BLQ-BAJO-6). Salía
  // `deeplink_blockhash_expired`, cuyo copy dice *"Pasó demasiado tiempo y la red ya no acepta esa
  // transacción"*: una afirmación de TIEMPO que este `if` no puede sostener. El CR midió el input que la
  // vuelve falsa —una vuelta con la firma en CERO pasa los cinco pasos de `vueltaDelNonce` (nadie verifica
  // ed25519 en este camino) y termina exactamente acá— o sea el diagnóstico de un reloj para un problema de
  // firma. `deeplink_nonce_no_entro` afirma sólo lo que este `if` sabe.
  // MUTANTE QUE MATA: devolver `DEEPLINK_BLOCKHASH_EXPIRED` acá ⇒ este `it` se pone rojo.
  it("el broadcast falla y la cuenta no está ⇒ corte `deeplink_nonce_no_entro`, con reintento posible", async () => {
    const { res } = await volverDelSaltoDelNonce(null, "falla");
    // ⛔ NO es `nonce-en-vuelo`: nada viajó. Y no es `nonce-no-sabemos`: a la cadena SÍ le preguntamos.
    expect(res).toEqual({ estado: "corte", causa: "deeplink_nonce_no_entro" });
    // ⛔ Y NO es la causa del blockhash: el copy de ésa afirma un vencimiento por TIEMPO que acá no se sabe.
    expect((res as { causa: string }).causa).not.toBe("deeplink_blockhash_expired");
  });

  it("el broadcast falla pero la cuenta YA EXISTÍA ⇒ `nonce-listo` con `firma: null`", async () => {
    // 🔴 EL CASO QUE OBLIGA A QUE `firma` SEA `string | null`: la cuenta existe (la creó un intento
    // anterior que sí entró) y este intento no tiene ninguna firma que declarar. Un `""` acá sería un
    // vacío que se lee como un valor.
    const { res } = await volverDelSaltoDelNonce(bytesDeCuentaDeNonce(), "falla");
    expect(res).toEqual({ estado: "nonce-listo", firma: null });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// AC-5 · `estadoDeLaCuentaDeNonce` (tri-estado) y `crearCuentaDeNonce` (la tx que la crea)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("AC-5: la cuenta de nonce, antes del salto", () => {
  const SENDER = Keypair.generate();

  function mockCadena(respuesta: Buffer | null | "throw") {
    vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation((async () => {
      if (respuesta === "throw") throw new Error("rpc_down");
      return respuesta === null
        ? null
        : { data: respuesta, executable: false, lamports: 1, owner: SystemProgram.programId, rentEpoch: 0 };
    }) as never);
  }

  it("TRES valores, nunca dos, y `no-pudimos-preguntar` NO se colapsa en `falta`", async () => {
    montarNavegador();
    const r = new RecorridoPorEnlaceReal();
    const buenos = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([1, 0, 0, 0]),
      SENDER.publicKey.toBuffer(),
      Keypair.generate().publicKey.toBuffer(),
      Buffer.alloc(8),
    ]);
    mockCadena(buenos);
    expect(await r.estadoDeLaCuentaDeNonce(SENDER.publicKey.toBase58())).toBe("existe");
    mockCadena(null);
    expect(await r.estadoDeLaCuentaDeNonce(SENDER.publicKey.toBase58())).toBe("falta");
    mockCadena("throw");
    expect(
      await r.estadoDeLaCuentaDeNonce(SENDER.publicKey.toBase58()),
      "'no pudimos preguntar' se leyó como 'no la tiene'",
    ).toBe("no-pudimos-preguntar");
  });

  it("una dirección que no parsea NO se contesta como `falta`", async () => {
    montarNavegador();
    mockCadena(null);
    expect(await new RecorridoPorEnlaceReal().estadoDeLaCuentaDeNonce("no-es-base58-###")).toBe(
      "no-pudimos-preguntar",
    );
  });

  it("`crearCuentaDeNonce` arma la tx DE CERO, guarda su ancla de bytes y salta a firmarla", async () => {
    const nav = montarNavegador();
    const recorrido = new RecorridoPorEnlaceReal();
    // El connect primero, por camino de producción: sin viaje conectado no hay canal cifrado.
    const billetera = nacl.box.keyPair();
    const q = new URL(recorrido.elegir({ billetera: "phantom", remittanceId: REM }).irA).searchParams;
    nav.navegarA(
      hrefDeVuelta(
        q.get("redirect_link") as string,
        respuestaDeLaBilletera(
          { public_key: SENDER.publicKey.toBase58(), session: "s" },
          bs58.decode(q.get("dapp_encryption_public_key") as string),
          billetera,
        ),
      ),
    );
    await recorrido.completar({ remittanceId: REM });

    const BLOCKHASH = Keypair.generate().publicKey.toBase58();
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    } as never);

    const { irA } = await recorrido.crearCuentaDeNonce({
      direccion: SENDER.publicKey.toBase58(),
      remittanceId: REM,
    });

    expect(new URL(irA).host).toBe("phantom.app");
    expect(new URL(irA).pathname).toBe("/ul/v1/signTransaction");
    // La vuelta trae la marca PROPIA del nonce, que NO es un paso del viaje del depósito.
    const redirect = new URL(new URL(irA).searchParams.get("redirect_link") as string);
    expect(redirect.searchParams.get(MARCA)).toBe("crear-nonce");
    // Y el ancla quedó guardada ANTES del salto: sin ella, a la vuelta no habría contra qué comparar.
    const ancla = JSON.parse(nav.disco.get("chaski.billetera.nonce.v1") as string);
    expect(typeof ancla.mensajeBase64).toBe("string");
    expect(ancla.mensajeBase64.length).toBeGreaterThan(0);
    expect(ancla.consumido).toBeUndefined();
    // 🔴 Y ESE ANCLA ES DE UNA TX CON EL BLOCKHASH QUE ACABA DE PEDIR: se armó de cero, no se reusó.
    const mensaje = Message.from(Buffer.from(ancla.mensajeBase64, "base64"));
    expect(mensaje.recentBlockhash).toBe(BLOCKHASH);
    expect(mensaje.header.numRequiredSignatures, "la creación pide más de una firma").toBe(1);
  });

  // 🔴 EL TECHO DEL `getLatestBlockhash` (fix-pack · CR/MNR-11) — LO QUE PASABA SIN ÉL, Y NO ERA COSMÉTICO.
  // Este `await` es el único de `crearCuentaDeNonce` que le habla a la red antes de devolver una URL, y su
  // llamador tiene a la persona esperando con el botón deshabilitado. Un RPC que ACEPTA la conexión y no
  // contesta (que no es lo mismo que uno caído) dejaba esa pantalla trabada para siempre: no hay timeout
  // del otro lado y no hay ninguna otra salida en el cuadrante.
  //
  // ⚠️ EL TECHO NO CANCELA LA PETICIÓN, y este `it` NO afirma que lo haga: es un `Promise.race`, así que
  // corta LA ESPERA de quien llama y el `getLatestBlockhash` sigue en vuelo. Lo que se mide acá es que la
  // promesa que la pantalla espera RECHACE, no que la red deje de trabajar.
  //
  // MUTANTE QUE MATA: sacarle el `conTecho(...)` a ese `await` ⇒ la promesa nunca se asienta y este `it`
  // muere por timeout de vitest.
  it("un RPC que acepta y NO contesta vence por el techo: la promesa RECHAZA en vez de colgar la pantalla", async () => {
    vi.useFakeTimers();
    try {
      const nav = montarNavegador();
      const recorrido = new RecorridoPorEnlaceReal();
      const billetera = nacl.box.keyPair();
      const q = new URL(recorrido.elegir({ billetera: "phantom", remittanceId: REM }).irA).searchParams;
      nav.navegarA(
        hrefDeVuelta(
          q.get("redirect_link") as string,
          respuestaDeLaBilletera(
            { public_key: SENDER.publicKey.toBase58(), session: "s" },
            bs58.decode(q.get("dapp_encryption_public_key") as string),
            billetera,
          ),
        ),
      );
      await recorrido.completar({ remittanceId: REM });

      // El RPC que acepta y se queda callado. ⛔ NO es `mockRejectedValue`: eso ya funcionaba antes.
      let colgadas = 0;
      vi.spyOn(Connection.prototype, "getLatestBlockhash").mockImplementation(
        (() => {
          colgadas += 1;
          return new Promise(() => {});
        }) as never,
      );

      const p = recorrido.crearCuentaDeNonce({
        direccion: SENDER.publicKey.toBase58(),
        remittanceId: REM,
      });
      const esperado = expect(p).rejects.toThrow("nonce_probe_timeout");
      await vi.advanceTimersByTimeAsync(5_001);
      await esperado;
      // CD-18 — el fixture fabricó el caso: la petición SE HIZO y quedó colgada. Sin esto, un
      // `crearCuentaDeNonce` que tirara ANTES de llamar a la red pasaría este `it` por el motivo equivocado.
      expect(colgadas, "el RPC no se llegó a llamar: este `it` no está midiendo el techo").toBe(1);
      // ⛔ Y NO SE ESCRIBIÓ NINGÚN ANCLA: el ancla se guarda DESPUÉS de armar la tx, así que un corte acá no
      // deja al disco creyendo que hay una firma pendiente.
      expect(nav.disco.has("chaski.billetera.nonce.v1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-359 · T-067-21 (fix-pack · AR/BLQ-ALTO-1 + AR/BLQ-MED-1) — `completarPop()` LEE EL HREF QUE LE
// PASAN, Y NO `location` EN VIVO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ AGUJERO CIERRA, Y POR QUÉ EL 100 % VERDE NO LO VEÍA. `RecorridoPorEnlaceReal.completarPop()`
// —la implementación REAL, la que corre en el teléfono— no la ejercitaba ningún `it`: sus dos usos en
// la suite eran dobles (`RecorridoPorEnlaceNulo` en `test-support/fakes.ts`, que tira, y
// `RecorridoConVueltaDelPop` en `presentation/flow-reanudacion.test.tsx`, que devuelve un enlatado), y
// `deeplink/pop-por-enlace.test.ts` prueba `vueltaDelPop` pasándole el `hrefActual` a mano. ⇒ **nadie
// probaba quién le pasa ese href en producción**, que era justo la línea rota: el productor
// —(`useVueltaPorEnlace`, `../../presentation/flow.tsx:3956`), en la rama de (`completarPop`, `../../presentation/flow.tsx:4009`)— limpia la barra para TODA vuelta y la
// implementación leía `globalThis.location.href` después de esa limpieza, así que le llegaba una URL
// sin `nonce`, sin `data` y sin la clave de cifrado de la billetera ⇒ el guard write-once de
// `claveBilletera` no encontraba clave y **toda firma buena salía `deeplink_pop_alterado`**.
//
// ⚠️ POR QUÉ ACÁ Y NO EN `flow-reanudacion.test.tsx`: ese archivo corre en jsdom, y bajo jsdom el
// `Uint8Array` de `new TextEncoder().encode(...)` no es `instanceof Uint8Array` del realm de
// `tweetnacl` ⇒ cualquier llamada a `iniciarPop`/`vueltaDelPop` muere en `checkArrayTypes` antes de
// ejercitar una línea de esta HU. Este archivo corre en `node`, con un solo realm, y por eso puede
// firmar ed25519 de verdad. La mitad del productor —que lo que sale de `flow.tsx` conserve el
// rastro— la mide `T-067-11` allá.
//
// ⛔ NADA SE SIEMBRA A MANO: la URL del salto la produce el adaptador REAL (`pedir()`), el sobre lo
// cifra la billetera de mentira con el secreto compartido del canal, y la firma es ed25519 de verdad
// sobre el `popMessage` que el "servidor" mandó. Lo único falso es el `fetch` del desafío y el
// navegador.
describe("T-067-21 (AR/BLQ-ALTO-1): la vuelta del permiso se lee del href que le pasan", () => {
  const FIRMANTE = Keypair.generate(); // la billetera de la persona: acá SÍ tenemos su privada
  const POP_MESSAGE = "chaski:pop:payout:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU:1755400000";

  /** Deja el mundo en el instante EXACTO en el que la billetera acaba de devolver la firma del
   *  desafío, y devuelve las dos versiones del href: la que el navegador tenía al montar (sucia) y la
   *  que el productor deja en la barra (limpia, con LA MISMA función que usa `flow.tsx`). */
  async function volviendoDeFirmarElPermiso() {
    const nav = montarNavegador();
    const recorrido = new RecorridoPorEnlaceReal();
    const billetera = nacl.box.keyPair();

    // 1 · el connect, entero: es lo que fija `claveBilletera`, `session` y `direccion` en el viaje.
    const q = new URL(recorrido.elegir({ billetera: "phantom", remittanceId: REM }).irA).searchParams;
    const publicaDeLaApp = bs58.decode(q.get("dapp_encryption_public_key") as string);
    nav.navegarA(
      hrefDeVuelta(
        q.get("redirect_link") as string,
        respuestaDeLaBilletera(
          { public_key: FIRMANTE.publicKey.toBase58(), session: "sess-1" },
          publicaDeLaApp,
          billetera,
        ),
      ),
    );
    expect(await recorrido.completar({ remittanceId: REM })).toEqual({
      estado: "conectado",
      direccion: FIRMANTE.publicKey.toBase58(),
    });

    // 2 · el salto del permiso, por el camino de producción: `pedir()` del adaptador. Lo único de
    // mentira es la respuesta del emisor del desafío; el ancla y la URL las escribe el código real.
    solanaWalletBridge.setWalletAvailability("none"); // el estado de un teléfono sin extensión
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              popChallenge: "ch-1",
              popMessage: POP_MESSAGE,
              exp: Math.floor(Date.now() / 1000) + 600,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const permiso = await new SolanaWalletAdapter().pedir({
      proposito: "pop-payout",
      direccion: FIRMANTE.publicKey.toBase58(),
    });
    if (permiso.estado !== "hay-que-salir") throw new Error(`el salto no se armó: ${permiso.estado}`);

    // 3 · la billetera firma ed25519 el mensaje ANCLADO y vuelve a nuestro origen.
    const redirect = new URL(permiso.irA).searchParams.get("redirect_link") as string;
    const hrefSucio = hrefDeVuelta(
      redirect,
      respuestaDeLaBilletera(
        { signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(POP_MESSAGE), FIRMANTE.secretKey)) },
        publicaDeLaApp,
        billetera,
      ),
    );
    // 4 · EL PASO 2 DEL PRODUCTOR, con la MISMA función que corre en `flow.tsx:3999`. Acá está el
    // caso: el navegador ya no tiene el rastro, y sólo la variable capturada lo conserva.
    const hrefLimpio = hrefSinRastroDeVuelta(hrefSucio);
    nav.navegarA(hrefLimpio);

    // CD-18 — el fixture fabricó el caso, y las dos mitades se declaran: el sucio TIENE los tres
    // parámetros de respuesta y el limpio NO tiene ninguno. Sin esto, los dos `it` de abajo podrían
    // estar comparando dos URLs iguales.
    for (const p of ["phantom_encryption_public_key", "nonce", "data", MARCA]) {
      expect(new URL(hrefSucio).searchParams.get(p), `el href "sucio" no trae \`${p}\``).not.toBeNull();
      expect(new URL(hrefLimpio).searchParams.get(p), `el href "limpio" todavía trae \`${p}\``).toBeNull();
    }
    return { recorrido, hrefSucio, hrefLimpio };
  }

  // 🔴 MUTANTE QUE MATA: en `preparacion-por-enlace.ts`, volver a `hrefActual: e.href` (lo que decía la
  // línea rechazada) en la llamada a `vueltaDelPop` de `completarPop`.
  it("con la barra YA limpia, el href capturado por el productor alcanza para verificar (`pop-listo`)", async () => {
    const { recorrido, hrefSucio } = await volviendoDeFirmarElPermiso();
    expect(await recorrido.completarPop({ hrefDeLaVuelta: hrefSucio })).toEqual({
      estado: "pop-listo",
      proposito: "pop-payout",
    });
  });

  // ⛔ LA CALIBRACIÓN, en la dirección contraria: con el href que el navegador REALMENTE tiene después
  // del paso 2 —el que leía la versión rechazada— la misma vuelta buena NO llega a `pop-listo`. Es lo
  // que impide que el `it` de arriba dé verde por un `completarPop` que contestara `pop-listo` a
  // cualquier cosa.
  //
  // 🔴 ESTE VALOR CAMBIÓ AL ARREGLAR LA CLAVE FUERA DEL CONNECT, Y EL CAMBIO ES INFORMACIÓN, NO UNA
  // REGRESIÓN. Acá decía `corte` / `deeplink_pop_alterado`, y ese `alterado` **era el defecto**: sobre
  // un href SIN ningún parámetro de respuesta, `vueltaDelPop` comparaba `null !== claveAnclada` y
  // gritaba «alterada» donde no había absolutamente nada que mirar. Con el guard preguntando primero si
  // la URL trae clave, un href limpio cae donde corresponde: `nada`, o sea «acá no volvió ninguna
  // respuesta». La calibración sigue calibrando —discrimina de `pop-listo`, que es lo único que este
  // `it` tiene que impedir— y ahora además dice la verdad sobre lo que pasó.
  it("CALIBRACIÓN: con el href de DESPUÉS de limpiar, la misma firma buena NO se verifica (`nada`)", async () => {
    const { recorrido, hrefLimpio } = await volviendoDeFirmarElPermiso();
    const r = await recorrido.completarPop({ hrefDeLaVuelta: hrefLimpio });
    expect(r).toEqual({ estado: "nada" });
    expect(r, "la calibración existe para descartar ESTE valor").not.toEqual({
      estado: "pop-listo",
      proposito: "pop-payout",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-359 · T-067-24 … T-067-27 (fix-pack · CR/MNR-4) — LAS CUATRO RAMAS DE `pedir()` QUE NINGÚN `it`
// EJERCITABA SOBRE LA IMPLEMENTACIÓN REAL
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ AGUJERO CIERRA, Y CÓMO SE MIDIÓ QUE ERA UN AGUJERO. La enumeración del CR:
// `grep -rn "\.pedir(" --include=*.test.ts --include=*.test.tsx src/ app/` devolvía **un solo**
// call-site ejecutable del `pedir()` real —el (`pedir`, `:769`) de `T-067-21`— y recorría **una** de las cinco
// ramas (desafío fresco ⇒ `hay-que-salir`). Las otras cuatro se afirmaban ÚNICAMENTE a través de
// (`FakePruebaDePosesionPorEnlace`, `../../test-support/fakes.ts:1210`), **cuyo valor de retorno ES la
// conclusión bajo prueba**: el doble contesta `no-corresponde` porque se lo pusieron, no porque el
// gate haya decidido nada. ⇒ el docblock de (`pedir`, `../solana-wallet.ts:2379`) dice de su primera
// línea *"Es la línea que sostiene AC-8"*, y borrarla no ponía roja a la suite.
//
// ⛔ POR QUÉ ESTE ARCHIVO Y NO `solana-wallet.test.ts`, que es donde vive la clase: `pedir()` sólo
// hace algo con un VIAJE CONECTADO, y el connect por enlace entero —`elegir` ⇒ URL ⇒ sobre cifrado ⇒
// `completar`— ya está montado acá y corre en `node`, con un solo realm. Bajo jsdom el `Uint8Array` de
// `new TextEncoder().encode(...)` no es `instanceof Uint8Array` del realm de `tweetnacl` y `iniciarPop`
// muere en `checkArrayTypes` antes de ejercitar una línea de esta HU (es la misma razón, medida, que
// `T-067-21` ya declara en su encabezado).
//
// ⛔ POR QUÉ EL CONNECT SE REPITE ACÁ EN VEZ DE COMPARTIR EL FIXTURE DE `T-067-21`, y es Δ0 y no
// pereza: subir aquel `volviendoDeFirmarElPermiso()` a scope de módulo lo obliga a moverse de línea, y
// este archivo lo citan DOS sitios por número —(`completarPop`, `../../presentation/flow.tsx:4009`) y
// (`completarPop`, `../../presentation/flow-reanudacion.test.tsx:590`), las dos a `:696`—. Lo que se
// comparte de verdad no es el código: es que las dos mitades produzcan el MISMO estado del mundo, y
// eso se verifica solo (si el connect de acá no dejara el viaje conectado, `pedir()` no llegaría a
// ninguna de las cuatro ramas y los cuatro `it` se caerían en el `throw` del fixture).
describe("T-067-24..27 (CR/MNR-4): las cuatro ramas de `pedir()`, sobre el adaptador REAL", () => {
  const FIRMANTE_2 = Keypair.generate();
  const MENSAJE_2 = "chaski:pop:payout:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU:1755400001";

  /** Deja el mundo con el viaje CONECTADO por enlace y la elección persistida, que es la precondición
   *  de las cinco ramas. No toca el ancla del PoP: eso lo hace cada `it` con el `pedir()` real. */
  async function conectadoPorEnlace() {
    const nav = montarNavegador();
    const recorrido = new RecorridoPorEnlaceReal();
    const billetera = nacl.box.keyPair();
    const q = new URL(recorrido.elegir({ billetera: "phantom", remittanceId: REM }).irA).searchParams;
    const publicaDeLaApp = bs58.decode(q.get("dapp_encryption_public_key") as string);
    nav.navegarA(
      hrefDeVuelta(
        q.get("redirect_link") as string,
        respuestaDeLaBilletera(
          { public_key: FIRMANTE_2.publicKey.toBase58(), session: "sess-2" },
          publicaDeLaApp,
          billetera,
        ),
      ),
    );
    const conectado = await recorrido.completar({ remittanceId: REM });
    if (conectado.estado !== "conectado") throw new Error(`el connect no cerró: ${conectado.estado}`);
    solanaWalletBridge.setWalletAvailability("none"); // el estado de un teléfono sin extensión
    return { nav, recorrido, billetera, publicaDeLaApp };
  }

  /** El emisor del desafío, de mentira sólo en el transporte: el JSON tiene la forma que produce
   *  `app/api/a2a/payout/challenge/route.ts`. `status` entra por parámetro para poder medir el 501. */
  function emisorDelDesafio(status = 200, challenge = "ch-24") {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ popChallenge: challenge, popMessage: MENSAJE_2, exp: Math.floor(Date.now() / 1000) + 600 }),
          { status, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  }

  const pedirPayout = () =>
    new SolanaWalletAdapter().pedir({ proposito: "pop-payout", direccion: FIRMANTE_2.publicKey.toBase58() });

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // T-067-24 · AC-8 — EL GATE VA PRIMERO, Y SE MIDE CON UN DISCO QUE TIRA
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  //
  // 🔴 POR QUÉ EL DISCO TIENE QUE TIRAR PARA QUE ESTE `it` VALGA ALGO. El mutante que el CR nombra es
  // *"mover el gate DESPUÉS del disco"*, y con un disco SANO ese mutante sigue contestando
  // `no-corresponde`: las dos versiones son indistinguibles. La única entrada que las separa es un
  // `localStorage` cuyo getter LANZA (modo privado de iOS Safari, cookies bloqueadas), porque ahí
  // (`discoDeEnlace`, `../solana-wallet.ts:2263`) contesta `"no-se-pudo"` y la rama del disco devuelve
  // `no-se-puede`. ⇒ gate primero ⇒ `no-corresponde`; disco primero ⇒ `no-se-puede`.
  // MUTANTES QUE MATA, LOS DOS CORRIDOS (`npx vitest run …/preparacion-por-enlace.test.ts`, cada uno
  // con el árbol restaurado y verificado por md5):
  //   · **M1** mover el `if (this.caminoPorEnlace() === null)` DEBAJO del `if (disco === null || disco
  //     === "no-se-pudo")` ⇒ `1 failed | 27 passed (28)`, y el que cae es éste.
  //   · **M5** borrar esa línea entera —el mutante que el CR nombró como *"no puede poner rojo a
  //     nadie"*— ⇒ `1 failed | 27 passed (28)`, y el que cae es éste. Ya no es cierto.
  // ⛔ Y el `it` de al lado es la CALIBRACIÓN INVERSA: mueve UNA sola variable (la disponibilidad) y el
  // mismo llamado deja de contestar `no-corresponde`. Sin él, un `pedir()` que devolviera
  // `no-corresponde` para TODO pasaría el de arriba — y eso está MEDIDO, no razonado: el mutante **M6**
  // (`if (true) return { estado: "no-corresponde" }`) da `6 failed | 22 passed (28)` y **el de arriba NO
  // está entre los seis**; el que lo caza es el de abajo. Las dos direcciones, cada una con su `it`.
  it("T-067-24: camino inyectado ⇒ `no-corresponde` sin tocar el disco ni la red (AC-8)", async () => {
    await conectadoPorEnlace();
    const fetchSpy = emisorDelDesafio();
    solanaWalletBridge.setWalletAvailability("injected"); // la extensión existe ⇒ el camino de siempre
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denegado por política de almacenamiento");
      },
    });
    expect(await pedirPayout()).toEqual({ estado: "no-corresponde" });
    expect(fetchSpy, "el camino inyectado pidió un desafío: ya no es byte-idéntico").not.toHaveBeenCalled();
  });

  it("T-067-24b CALIBRACIÓN: con la MISMA llamada y sólo la disponibilidad en `none`, ya no es `no-corresponde`", async () => {
    await conectadoPorEnlace();
    emisorDelDesafio();
    expect((await pedirPayout()).estado).toBe("hay-que-salir");
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // T-067-25 · AC-5 — EL 501 NO SALTA A NINGUNA BILLETERA
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  //
  // ⛔ EL CUERPO DEL 501 ES UN DESAFÍO VÁLIDO A PROPÓSITO, y ahí está la mitad que mide: si el corte se
  // decidiera por el JSON y no por el STATUS, este `it` recibiría un `hay-que-salir` perfectamente
  // armado. Es lo que mata el mutante que el CR nombra —cambiar el `!res.ok` por un `catch`— y también
  // el de borrar el `if (!res.ok)` entero — **M2**, corrido: `1 failed | 27 passed (28)`, y el que cae
  // es éste.
  // 🔴 LO QUE SE AFIRMA NO ES SÓLO EL ESTADO: es que **no hay `irA` y no quedó ancla en el disco**. Un
  // ancla escrita sin salto dejaría a la vuelta esperando una firma que nadie fue a pedir.
  it("T-067-25: 501 con cuerpo VÁLIDO ⇒ `no-se-puede`, sin `irA` y sin ancla (AC-5)", async () => {
    const { nav } = await conectadoPorEnlace();
    emisorDelDesafio(501);
    const r = await pedirPayout();
    expect(r).toEqual({ estado: "no-se-puede", causa: "payout_pop_unavailable" });
    expect("irA" in r, "el 501 devolvió una URL: la persona salta a firmar algo ya condenado").toBe(false);
    expect(nav.disco.get("chaski.billetera.pop.v1"), "el 501 dejó un ancla sin salto").toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // T-067-26 · DT-10 — UN SALTO EN CURSO NO QUEMA UN DESAFÍO NUEVO
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  //
  // 🔴 QUÉ PROPIEDAD ES, Y POR QUÉ NO ALCANZA CON MIRAR EL `fetch`. La persona vuelve sin firmar (o
  // recarga la pantalla) y `pedir()` se llama de nuevo: si pidiera un desafío nuevo, el reloj del
  // permiso se reiniciaría en cada reintento y `exp` dejaría de ser la ventana que el SERVIDOR fijó,
  // que es exactamente lo que DT-10 vino a evitar. Se mide en las dos puntas: **el emisor se consulta
  // una sola vez** y **el ancla del disco sigue teniendo el PRIMER `popChallenge` y el PRIMER `exp`**.
  //
  // ⛔ ACÁ NO SE COMPARAN LAS DOS URLs DEL SALTO, Y LA RAZÓN LA MIDIÓ ESTE MISMO `it` PONIÉNDOSE ROJO:
  // la primera versión afirmaba *"mismo desafío y mismo `exp` ⇒ mismo sobre"* y es **falso**. El sobre
  // lo cifra `nacl.box.after` con un `nonce` de (`randomBytes`, `./deeplink/protocol.ts:171`) nuevo en
  // cada llamada, así que dos saltos del MISMO desafío dan dos URLs distintas byte a byte. Comparar
  // URLs medía el generador de aleatorios, no DT-10.
  // MUTANTE QUE MATA, CORRIDO (**M3**): borrar el bloque `if (enCurso !== null && …)` de `pedir()` ⇒ el
  // emisor se consulta DOS veces y el ancla queda con `ch-26-2`, o sea el desafío quemado que DT-10
  // prohíbe. Medido: `1 failed | 27 passed (28)`, y el que cae es éste.
  it("T-067-26: dos `pedir()` con el ancla viva y sin firma reusan el MISMO desafío (DT-10)", async () => {
    const { nav } = await conectadoPorEnlace();
    // El emisor contesta un desafío DISTINTO en cada llamada: sin eso, un segundo `fetch` sería
    // invisible en el disco y el `it` sólo mediría el contador de llamadas.
    let emision = 0;
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            popChallenge: `ch-26-${++emision}`,
            popMessage: MENSAJE_2,
            exp: Math.floor(Date.now() / 1000) + 600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const uno = await pedirPayout();
    if (uno.estado !== "hay-que-salir") throw new Error(`el primer salto no se armó: ${uno.estado}`);
    const anclaPrimera = JSON.parse(nav.disco.get("chaski.billetera.pop.v1") as string);

    const dos = await pedirPayout();
    if (dos.estado !== "hay-que-salir") throw new Error(`el segundo salto no se armó: ${dos.estado}`);
    const anclaSegunda = JSON.parse(nav.disco.get("chaski.billetera.pop.v1") as string);

    expect(fetchSpy, "se pidió un desafío nuevo por un salto que ya estaba en curso").toHaveBeenCalledTimes(1);
    expect(anclaPrimera.popChallenge).toBe("ch-26-1");
    expect(anclaSegunda.popChallenge, "el segundo salto quemó un desafío nuevo (DT-10)").toBe("ch-26-1");
    expect(anclaSegunda.exp, "el reloj del permiso se reinició en el reintento (DT-10)").toBe(anclaPrimera.exp);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // T-067-27 · LA ÚLTIMA PATA DE LA CADENA — `listo`, Y UNA SOLA VEZ (CD-15)
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  //
  // 🔴 ESTO ES EL RECORRIDO COMPLETO Y SIN UN SOLO DATO SEMBRADO: connect real ⇒ `pedir()` real arma el
  // salto ⇒ la billetera firma ed25519 DE VERDAD el `popMessage` anclado ⇒ `completarPop()` real
  // verifica ⇒ `pedir()` real ENTREGA la prueba. Hasta este `it`, el `estado: "listo"` sólo existía
  // como respuesta enlatada de un doble. Lo único de mentira sigue siendo el emisor del desafío y el
  // navegador.
  // ⛔ Y LA SEGUNDA MITAD ES CD-15: el mismo `pedir()`, otra vez, NO vuelve a entregar. El ancla se
  // borra en el gesto de la entrega ((`terminarPasoPop`, `./deeplink/pop-por-enlace.ts:407`)), así que
  // la segunda llamada tiene que salir a buscar un desafío nuevo.
  // MUTANTE QUE MATA, CORRIDO (**M4**): en `leerPruebaPop`, mover el `terminarPasoPop(a)` DESPUÉS del
  // `return` ⇒ la segunda llamada vuelve a contestar `listo` con la MISMA firma. Medido:
  // `1 failed | 27 passed (28)`, y el que cae es éste.
  it("T-067-27: la prueba verificada se entrega como `listo`, y sólo la primera vez (CD-15)", async () => {
    const { nav, recorrido, billetera, publicaDeLaApp } = await conectadoPorEnlace();
    emisorDelDesafio(200, "ch-27");
    const salto = await pedirPayout();
    if (salto.estado !== "hay-que-salir") throw new Error(`el salto no se armó: ${salto.estado}`);

    const hrefSucio = hrefDeVuelta(
      new URL(salto.irA).searchParams.get("redirect_link") as string,
      respuestaDeLaBilletera(
        { signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(MENSAJE_2), FIRMANTE_2.secretKey)) },
        publicaDeLaApp,
        billetera,
      ),
    );
    nav.navegarA(hrefSinRastroDeVuelta(hrefSucio)); // el paso 2 del productor, igual que en producción
    expect(await recorrido.completarPop({ hrefDeLaVuelta: hrefSucio })).toEqual({
      estado: "pop-listo",
      proposito: "pop-payout",
    });

    const entrega = await pedirPayout();
    expect(entrega).toEqual({ estado: "listo", proof: { challenge: "ch-27", signature: expect.any(String) } });
    if (entrega.estado !== "listo") throw new Error("inalcanzable: lo acaba de afirmar el `expect`");
    // La firma es la de la billetera, verificable contra el mensaje anclado: no es un `String` cualquiera.
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(MENSAJE_2),
        bs58.decode(entrega.proof.signature),
        FIRMANTE_2.publicKey.toBytes(),
      ),
      "la firma entregada no verifica contra el `popMessage` anclado",
    ).toBe(true);

    emisorDelDesafio(200, "ch-27-segundo");
    const otraVez = await pedirPayout();
    expect(otraVez.estado, "la prueba se entregó dos veces: el «un solo uso» de CD-15 no está").not.toBe("listo");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// HU-075/gesto · T-075-GESTO-IRA — QUÉ TRAE `r.irA` EN EL SEGUNDO SALTO, MEDIDO SOBRE EL CAMINO REAL
//
// 🔴 POR QUÉ ESTE `it` EXISTE Y POR QUÉ VIVE ACÁ Y NO EN `flow-reanudacion.test.tsx`.
//
// El diagnóstico del teléfono del founder dejó `connect: hay-que-salir` con la persona parada en la
// bienvenida y SIN error, y eso admitía dos causas que la foto no separa:
//   (1) `r.irA` llega VACÍO o mal formado ⇒ la navegación no tiene a dónde ir, y el arreglo sería otro;
//   (2) la URL está bien y el navegador móvil DESCARTA la navegación programática sin gesto.
// Este `it` cierra (1) POR MEDICIÓN: corre el cableado de producción de `container.ts:185` —el 4º
// argumento de `ConnectWallet` es el `SolanaWalletAdapter` REAL— contra el disco que dejó la vuelta
// del connect, y lee el `irA` que sale. Lo único de mentira es la respuesta del emisor del desafío.
//
// ⛔ Y POR QUÉ NO SE PUEDE MEDIR EN jsdom, que es donde vive la pantalla. MEDIDO el 2026-08-30 con una
// sonda temporal (creada, corrida y borrada): en el entorno jsdom de este repo
// `new TextEncoder().encode(…)` devuelve un `Uint8Array` DE OTRO REALM ⇒ `b instanceof Uint8Array`
// es **false**, y `tweetnacl` lo rechaza con `TypeError: unexpected type, use Uint8Array` en
// (`sobre`, `./deeplink/protocol.ts:170`). O sea: `urlFirmarMensaje` —y con él todo `irA` de
// producción— es INALCANZABLE desde cualquier test jsdom de este repo. No es un defecto del producto
// (un navegador real tiene un solo realm); es una costura del aparato de medición, y está escrita acá
// para que nadie intente cerrar (1) del otro lado y crea que "no se puede armar la URL".
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("HU-075/gesto: el `irA` del segundo salto", () => {
  it("T-075-GESTO-IRA: `execute()` suspende con una URL ABSOLUTA de la billetera, ⛔ no con una vacía", async () => {
    const nav = montarNavegador();
    const billetera = nacl.box.keyPair();
    const recorrido = new RecorridoPorEnlaceReal();

    // 1 · el recorrido real hasta que el disco tiene el viaje CONECTADO, igual que el `it` de AC-1.
    const { irA: irAlConnect } = recorrido.elegir({ billetera: "phantom", remittanceId: REM });
    const q = new URL(irAlConnect).searchParams;
    nav.navegarA(
      hrefDeVuelta(
        q.get("redirect_link") as string,
        respuestaDeLaBilletera({ public_key: DIRECCION, session: "sess-1" }, bs58.decode(q.get("dapp_encryption_public_key") as string), billetera),
      ),
    );
    expect(await recorrido.completar({ remittanceId: REM })).toEqual({ estado: "conectado", direccion: DIRECCION });

    // 2 · el teléfono sin extensión, y el emisor del desafío contestando.
    solanaWalletBridge.setWalletAvailability("none");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ popChallenge: "ch-gesto", popMessage: "firmá esto", exp: Math.floor(Date.now() / 1000) + 600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    // 3 · EL CABLEADO DE PRODUCCIÓN. El 3er argumento TIRA si alguien lo llama: este camino sale por la
    //     suspensión del PoP ANTES de consultar veredicto, y si dejara de ser cierto hay que verlo.
    const wallet = new SolanaWalletAdapter();
    const r = await new ConnectWallet(
      wallet,
      new FakeKycStore(),
      { ensure: async () => { throw new Error("se consultó el veredicto: este camino salía antes por la suspensión del PoP"); } } as never,
      wallet,
    ).execute();

    // CD-18 — el fixture reproduce el caso del teléfono: el mismo desenlace que leyó el diagnóstico.
    expect(r.estado, "el fixture no reproduce el caso del diagnóstico: `execute()` no pidió el segundo salto").toBe("hay-que-salir");
    if (r.estado !== "hay-que-salir") throw new Error("inalcanzable");

    // 4 · LA MEDICIÓN. Las tres afirmaciones son las que descartan la hipótesis (1).
    expect(r.irA, "el destino del segundo salto llegó VACÍO: la causa del bloqueo sería otra").not.toBe("");
    const u = new URL(r.irA); // TIRA si no es absoluta: ésa es la mitad "mal formada" de la hipótesis
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe("https://phantom.app/ul/v1/signMessage");
    expect(new URL(u.searchParams.get("redirect_link") as string).origin, "el salto no lleva por dónde volver").toBe(ORIGEN);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-373 · LA COSTURA REAL DEL PASO DEL NONCE: el ESCRITOR de verdad contra el LECTOR de verdad
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 EL HUECO QUE ESTE BLOQUE CIERRA, Y POR QUÉ NINGÚN `it` ANTERIOR LO CUBRÍA. Las dos mitades del
// paso del nonce estaban probadas por separado y ninguna contra la otra:
//   · (`crearCuentaDeNonce`, `./preparacion-por-enlace.ts:351`) tiene su `it` unos bloques más arriba,
//     que verifica que el ancla se guarde y con qué blockhash;
//   · (`vueltaDelNonce`, `./deeplink/conexion.ts:528`) tiene los suyos en `./deeplink/conexion.test.ts`,
//     y su fixture es un `SystemProgram.transfer` SINTÉTICO de una cuenta a sí misma
//     ((`transaccion`, `./deeplink/conexion.test.ts:514`)) — ⛔ **no** la transacción que
//     `construirCreacionDeNonce` arma de verdad. El bloque de `T-065-17` de más arriba hace lo mismo:
//     siembra `CLAVE_NONCE` a mano con `transaccionFirmada()`.
// ⇒ La costura entre el escritor REAL y el lector REAL no la ejercitaba nadie, y es exactamente la que
// el founder pisó primero: hasta su recorrido, el paso 2-BIS **no tenía medición en ningún teléfono**.
//
// ⚠️ Y QUÉ **NO** AFIRMA ESTE BLOQUE: no afirma que la creación funcione en un teléfono. Afirma que
// las dos mitades encajan byte a byte cuando la billetera devuelve lo que se le mandó a firmar, que es
// la precondición de todo lo demás y la única mitad que un runner puede medir.
describe("WKH-373 · `crearCuentaDeNonce` ↔ `vueltaDelNonce`, ida y vuelta REAL", () => {
  const CLAVE_NONCE = "chaski.billetera.nonce.v1";
  const SENDER = Keypair.generate();
  const BLOCKHASH_A = Keypair.generate().publicKey.toBase58();
  const BLOCKHASH_B = Keypair.generate().publicKey.toBase58();

  /** La cadena de mentira: `getAccountInfo` contesta `null` (la cuenta todavía no existe). */
  function cuentaAusente() {
    vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation((async () => null) as never);
  }

  function fijarBlockhash(valor: string) {
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: valor,
      lastValidBlockHeight: 1,
    } as never);
  }

  /** Deja el viaje CONECTADO por camino de producción y devuelve el canal para hablarle a la app. */
  async function conectar(nav: ReturnType<typeof montarNavegador>) {
    const billetera = nacl.box.keyPair();
    const recorrido = new RecorridoPorEnlaceReal();
    const q = new URL(recorrido.elegir({ billetera: "phantom", remittanceId: REM }).irA).searchParams;
    const publicaDeLaApp = bs58.decode(q.get("dapp_encryption_public_key") as string);
    const redirectLink = q.get("redirect_link") as string;
    nav.navegarA(
      hrefDeVuelta(
        redirectLink,
        respuestaDeLaBilletera({ public_key: SENDER.publicKey.toBase58(), session: "s" }, publicaDeLaApp, billetera),
      ),
    );
    await recorrido.completar({ remittanceId: REM });
    return { recorrido, publicaDeLaApp, redirectLink, billetera };
  }

  /**
   * ⛔ ABRE EL SOBRE QUE SALE HACIA LA BILLETERA. Es lo que vuelve REAL a este bloque: la transacción
   * que se firma NO se fabrica acá, se saca de la URL que produjo `crearCuentaDeNonce`. Un fixture que
   * la armara a mano volvería a medir dos mitades que nunca se tocan.
   */
  function transaccionQueSeMandoAFirmar(irA: string, publicaDeLaApp: Uint8Array, billetera: nacl.BoxKeyPair): string {
    const q = new URL(irA).searchParams;
    const secreto = nacl.box.before(publicaDeLaApp, billetera.secretKey);
    const abierto = nacl.box.open.after(
      bs58.decode(q.get("payload") as string),
      bs58.decode(q.get("nonce") as string),
      secreto,
    );
    if (abierto === null) throw new Error("el sobre del salto no abrió: el fixture no habla el protocolo");
    return (JSON.parse(new TextDecoder().decode(abierto)) as { transaction: string }).transaction;
  }

  /** El href con el que la billetera devuelve la transacción FIRMADA del paso del nonce. */
  function vueltaConLaFirma(ctx: Awaited<ReturnType<typeof conectar>>, base58: string): string {
    const u = new URL(
      hrefDeVuelta(ctx.redirectLink, respuestaDeLaBilletera({ transaction: base58 }, ctx.publicaDeLaApp, ctx.billetera)),
    );
    u.searchParams.set(MARCA, "crear-nonce");
    return u.toString();
  }

  /** Firma con el sender la tx que salió del sobre y la re-serializa, como haría la billetera. */
  function firmarComoLaBilletera(base58: string): string {
    const tx = Transaction.from(bs58.decode(base58));
    tx.partialSign(SENDER);
    return bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  }

  it("T-373-4: la tx que la billetera devuelve es la que el ESCRITOR armó, y el LECTOR la acepta", async () => {
    const nav = montarNavegador();
    const ctx = await conectar(nav);
    fijarBlockhash(BLOCKHASH_A);
    cuentaAusente();
    const { irA } = await ctx.recorrido.crearCuentaDeNonce({ direccion: SENDER.publicKey.toBase58(), remittanceId: REM });

    const cruda = transaccionQueSeMandoAFirmar(irA, ctx.publicaDeLaApp, ctx.billetera);
    // CD-18 — el fixture es la transacción REAL de la creación y no un `transfer` sintético: lleva el
    // blockhash que este mismo `it` fijó y pide UNA sola firma (el sender es el `feePayer`).
    const mensaje = Message.from(Transaction.from(bs58.decode(cruda)).serializeMessage());
    expect(mensaje.recentBlockhash, "la tx del sobre no es la que se armó en esta invocación").toBe(BLOCKHASH_A);
    expect(mensaje.header.numRequiredSignatures).toBe(1);
    // Y es EXACTAMENTE la que el ancla describe: ésa es la costura que nadie medía.
    const ancla = JSON.parse(nav.disco.get(CLAVE_NONCE) as string) as { mensajeBase64: string };
    expect(Buffer.from(mensaje.serialize()).toString("base64")).toBe(ancla.mensajeBase64);

    const envio = vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("firma-1" as never);
    nav.navegarA(vueltaConLaFirma(ctx, firmarComoLaBilletera(cruda)));
    const res = await ctx.recorrido.completar({ remittanceId: REM });

    // El desenlace es `nonce-en-vuelo` porque `getAccountInfo` sigue contestando `null` (se transmitió
    // y la red todavía no la confirma). ⛔ Lo que este `it` prohíbe es el OTRO desenlace: un corte.
    expect(res, "la vuelta REAL del paso del nonce salió cortada").toEqual({ estado: "nonce-en-vuelo" });
    expect(envio, "no se transmitió nada: la comparación de bytes cortó antes").toHaveBeenCalledTimes(1);
  });

  // ⛔ EL CONTROL NEGATIVO, y sin él el `it` de arriba no distingue «los bytes coinciden» de «nadie los
  // compara»: con OTRA transacción bien cifrada por el mismo canal, la vuelta tiene que cortar.
  it("T-373-4b: con OTRA transacción, la MISMA costura corta con `deeplink_tx_alterada`", async () => {
    const nav = montarNavegador();
    const ctx = await conectar(nav);
    fijarBlockhash(BLOCKHASH_A);
    cuentaAusente();
    await ctx.recorrido.crearCuentaDeNonce({ direccion: SENDER.publicKey.toBase58(), remittanceId: REM });

    const ajena = new Transaction({ feePayer: SENDER.publicKey, blockhash: BLOCKHASH_B, lastValidBlockHeight: 1 });
    ajena.add(SystemProgram.transfer({ fromPubkey: SENDER.publicKey, toPubkey: SENDER.publicKey, lamports: 1 }));
    ajena.partialSign(SENDER);
    const envio = vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("firma-1" as never);
    nav.navegarA(vueltaConLaFirma(ctx, bs58.encode(ajena.serialize({ requireAllSignatures: false, verifySignatures: false }))));

    expect(await ctx.recorrido.completar({ remittanceId: REM })).toEqual({ estado: "corte", causa: "deeplink_tx_alterada" });
    expect(envio, "se transmitió una transacción que no es la que se mandó a firmar").not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // WKH-373 · EL ANCLA DEL NONCE CONSERVA `consumido`
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // 🔴 MUTANTE QUE MATA: en (`guardarPasoDelNonce`, `./deeplink/conexion.ts:461`), volver a
  // `a.escribir(CLAVE_NONCE, JSON.stringify({ mensajeBase64, desde: ahora }))` — o sea el código de
  // antes de esta HU. El `it` de acá abajo se pone rojo con el mensaje «el segundo toque de "Crear la
  // cuenta" reseteó el anti-replay». ⛔ Y el mutante NO puede morir por un vecino: el `it` de control
  // que le sigue exige lo CONTRARIO (que con bytes distintos el flag SÍ se resetee), así que un
  // "arreglo" que conserve `consumido` siempre lo pone rojo a él.
  it("T-373-2: un segundo «Crear la cuenta» con los MISMOS bytes NO resetea el anti-replay", async () => {
    const nav = montarNavegador();
    const ctx = await conectar(nav);
    fijarBlockhash(BLOCKHASH_A);
    cuentaAusente();
    const { irA } = await ctx.recorrido.crearCuentaDeNonce({ direccion: SENDER.publicKey.toBase58(), remittanceId: REM });
    const cruda = transaccionQueSeMandoAFirmar(irA, ctx.publicaDeLaApp, ctx.billetera);
    const vuelta = vueltaConLaFirma(ctx, firmarComoLaBilletera(cruda));

    const envio = vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("firma-1" as never);
    nav.navegarA(vuelta);
    expect((await ctx.recorrido.completar({ remittanceId: REM })).estado, "la primera vuelta no transmitió").toBe("nonce-en-vuelo");
    expect(JSON.parse(nav.disco.get(CLAVE_NONCE) as string).consumido, "la vuelta no marcó el ancla").toBe(true);

    // 🔴 EL SEGUNDO TOQUE. La persona vuelve a la tarjeta y toca «Crear la cuenta» otra vez: con el
    // MISMO blockhash la transacción es IDÉNTICA, que es justo el caso en que la URL de vuelta vieja
    // todavía casa byte a byte.
    nav.navegarA(HREF);
    const segundo = await ctx.recorrido.crearCuentaDeNonce({ direccion: SENDER.publicKey.toBase58(), remittanceId: REM });
    // CD-18 — el fixture fabricó el caso: los bytes son los MISMOS. Sin esta mitad, un cambio de
    // blockhash volvería verde este `it` por el camino equivocado.
    expect(
      transaccionQueSeMandoAFirmar(segundo.irA, ctx.publicaDeLaApp, ctx.billetera),
      "el fixture armó OTRA transacción: este `it` mediría el caso de al lado",
    ).toBe(cruda);
    expect(
      JSON.parse(nav.disco.get(CLAVE_NONCE) as string).consumido,
      "el segundo toque de «Crear la cuenta» reseteó el anti-replay: la MISMA vuelta se puede volver a transmitir",
    ).toBe(true);

    // Y la consecuencia observable, que es lo que le importa a la persona: la vuelta vieja NO se
    // vuelve a transmitir.
    nav.navegarA(vuelta);
    expect(await ctx.recorrido.completar({ remittanceId: REM })).toEqual({ estado: "corte", causa: "deeplink_nonce_ya_consumido" });
    expect(envio, "se transmitió DOS veces la misma creación de cuenta").toHaveBeenCalledTimes(1);
  });

  // ⛔ EL CONTROL QUE IMPIDE QUE EL ARREGLO SE VUELVA UN BLOQUEO. Conservar `consumido` SIEMPRE dejaría
  // a la persona sin poder volver a crear su cuenta hasta que venciera la ventana de 20 min: se cambia
  // un agujero por una puerta cerrada. Con bytes DISTINTOS el flag se resetea, porque «esto ya se
  // transmitió» deja de ser verdad sobre la transacción nueva.
  it("T-373-2b: con OTRO blockhash el ancla es de OTRA transacción y `consumido` SÍ se resetea", async () => {
    const nav = montarNavegador();
    const ctx = await conectar(nav);
    fijarBlockhash(BLOCKHASH_A);
    cuentaAusente();
    const { irA } = await ctx.recorrido.crearCuentaDeNonce({ direccion: SENDER.publicKey.toBase58(), remittanceId: REM });
    const cruda = transaccionQueSeMandoAFirmar(irA, ctx.publicaDeLaApp, ctx.billetera);
    vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("firma-1" as never);
    nav.navegarA(vueltaConLaFirma(ctx, firmarComoLaBilletera(cruda)));
    await ctx.recorrido.completar({ remittanceId: REM });
    expect(JSON.parse(nav.disco.get(CLAVE_NONCE) as string).consumido).toBe(true);

    nav.navegarA(HREF);
    fijarBlockhash(BLOCKHASH_B); // el reintento pide un blockhash nuevo: OTRA transacción
    const segundo = await ctx.recorrido.crearCuentaDeNonce({ direccion: SENDER.publicKey.toBase58(), remittanceId: REM });
    const nueva = transaccionQueSeMandoAFirmar(segundo.irA, ctx.publicaDeLaApp, ctx.billetera);
    expect(nueva, "el fixture no cambió la transacción: el control no controla nada").not.toBe(cruda);
    expect(
      JSON.parse(nav.disco.get(CLAVE_NONCE) as string).consumido,
      "el ancla de una transacción NUEVA nació consumida: la persona no puede volver a crear su cuenta",
    ).toBeUndefined();

    nav.navegarA(vueltaConLaFirma(ctx, firmarComoLaBilletera(nueva)));
    expect((await ctx.recorrido.completar({ remittanceId: REM })).estado, "el reintento legítimo quedó bloqueado").toBe("nonce-en-vuelo");
  });
});
