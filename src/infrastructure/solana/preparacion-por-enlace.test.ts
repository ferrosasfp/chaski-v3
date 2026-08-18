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
