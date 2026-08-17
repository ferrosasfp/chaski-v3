// ⚠️ CD-15 · LOS MUTANTES DE ESTE ARCHIVO SE CORRIERON (2026-08-17), no se razonaron. `spawnSync`
// sin pipes, aguja contada con `== 1`, relectura del disco, restauración verificada byte a byte.
// Calibración previa: el que tenía que MORIR dio exit=1; el que tenía que VIVIR, exit=0.
//
// | mutante                                                      | exit | `it` rojos |
// |---|---|---|
// | T-062-6(a)  comparar sólo el `beneficiary`                    | 1 | 2 |
// | T-062-6(b)  `!==` por `===` en la comparación de destino      | 1 | 6 |
// | T-062-8     decidir el salto por `viaje.paso`                 | 1 | 6 |
// | T-062-9(a)  invertir el orden de los dos saltos               | 1 | 6 |
// | T-062-9(b)  `pathname+search` en vez del href completo        | 1 | 6 |
// | T-062-11    `remesaEnCurso: null`                             | 1 | 2 |
// | T-062-12    ignorar la `persistencia`                         | 1 | 3 |
// | T-062-13    tratar los dos motivos de `huerfana` igual        | 1 | 1 |
// | T-062-14    colapsar los dos orígenes del rechazo             | 1 | 1 |
// | T-062-15(a) limpiar ANTES de leer los resultados              | 1 | 2 |
// | T-062-15(b) borrar `terminarViaje` de la salida de éxito      | 1 | 1 |
// | T-062-16    devolver la `secreta` en el desenlace             | 1 | 1 |
// | T-062-17    intercambiar `secreta`/`publica`                   | 1 | 2 |
// WKH-356 · el motor de firma por enlace, contra las DOCE trampas que 061 midió para su llamador.
//
// 🔴 QUÉ SE ESTÁ PROTEGIENDO. `sesion.ts` es una API con filo: `interpretarVuelta` es una ESCRITURA
// con nombre de lectura, `remesaEnCurso: null` apaga un guard y consume igual, `persistencia` vive en
// 3 de 10 variantes y nada obliga a mirarla, `terminarViaje` se lleva los resultados con él, y
// `LecturaDelViaje.hay` expone una clave privada cruda. Este archivo es el primer código del repo que
// la usa, y cada `it` de abajo fija una de esas trampas con el mutante que la vuelve a abrir.
//
// ⛔ NO SE IMPORTAN LOS MAPAS DE NOMBRES DEL PROTOCOLO. El `NOMBRE_DE_LA_CLAVE` de abajo está escrito
// a mano a propósito, igual que en `sesion.test.ts` y `protocol.test.ts`: es el oráculo
// independiente. Importarlo de `protocol.ts` haría que invertir el mapa de producción moviera los dos
// lados a la vez y ningún `it` de este archivo lo notara.
//
// ⚠️ LO QUE ESTE ARCHIVO NO PUEDE CONTESTAR [NO VERIFICADO] (CD-12): que un teléfono real vuelva al
// mismo origen, que conserve `localStorage` a través del salto, y que la billetera devuelva la
// transacción byte-idéntica a la que se le mandó. Acá el almacén es un `Map` y la billetera es una
// función.
import { Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { beforeEach, describe, expect, it } from "vitest";
import type { BilleteraDeeplink } from "./protocol";
import {
  type Almacen,
  type Viaje,
  guardarViaje,
  leerViaje,
} from "./sesion";
import { type Preparado, guardarPreparado, leerPreparado } from "./preparado";
import {
  DEEPLINK_PREPARE_DIVERGED,
  DEEPLINK_RECHAZADO,
  DEEPLINK_RESPUESTA_ILEGIBLE,
  DEEPLINK_SIN_MEMORIA,
  DEEPLINK_TX_ALTERADA,
  DEEPLINK_VIAJE_VENCIDO,
  type DesenlaceDeFirma,
  FirmaPorEnlaceReal,
  type PedidoDeFirma,
} from "./firma-por-enlace";

// ⛔ ESCRITO A MANO A PROPÓSITO: el oráculo independiente. NO lo reemplaces por un `import`.
const NOMBRE_DE_LA_CLAVE: Record<BilleteraDeeplink, string> = {
  phantom: "phantom_encryption_public_key",
  solflare: "solflare_encryption_public_key",
};

const CLAVE_VIAJE = "chaski.billetera.viaje.v1";
const CLAVE_PREPARADO = "chaski.billetera.preparado.v1";
const AHORA = 1_700_000_000_000;
const APP_URL = "https://chaski.test";
const HREF_BASE = "https://chaski.test/enviar?rem=r-1";
const REM = "rem-1";

const SENDER = Keypair.generate();
const BENEFICIARY = Keypair.generate().publicKey.toBase58();
const AUTHORITY = Keypair.generate().publicKey.toBase58();
const REFERENCE = Keypair.generate().publicKey.toBase58();

/** Almacén de mentira. `fallarEscrituraDe` deja simular un disco que rechaza UNA clave. */
function almacenFalso(): Almacen & {
  datos: Map<string, string>;
  borrados: string[];
  fallarEscrituraDe: string | null;
} {
  const datos = new Map<string, string>();
  const a = {
    datos,
    borrados: [] as string[],
    fallarEscrituraDe: null as string | null,
    leer: (k: string) => datos.get(k) ?? null,
    escribir: (k: string, v: string) => {
      if (a.fallarEscrituraDe === k) throw new Error("QuotaExceededError");
      datos.set(k, v);
    },
    borrar: (k: string) => {
      a.borrados.push(k);
      datos.delete(k);
    },
  };
  return a;
}

let par: nacl.BoxKeyPair; // el par de cifrado de ESTA app
let billeteraReal: nacl.BoxKeyPair; // el de la billetera con la que se conectó el viaje

beforeEach(() => {
  par = nacl.box.keyPair();
  billeteraReal = nacl.box.keyPair();
});

/** Un viaje que YA hizo el paso 1: tiene el ancla puesta y la dirección de la persona. */
function viajeConectado(over: Partial<Viaje> = {}): Viaje {
  return {
    billetera: "phantom",
    secreta: bs58.encode(par.secretKey),
    publica: bs58.encode(par.publicKey),
    claveBilletera: bs58.encode(billeteraReal.publicKey),
    session: "sesion-opaca",
    direccion: SENDER.publicKey.toBase58(),
    paso: "firmar-tx",
    remittanceId: REM,
    pasosConsumidos: ["conectar"],
    desde: AHORA,
    ...over,
  };
}

function preparadoBase(over: Partial<Preparado> = {}): Preparado {
  return {
    remittanceId: REM,
    sender: SENDER.publicKey.toBase58(),
    beneficiary: BENEFICIARY,
    authority: AUTHORITY,
    mensajeBase64: "bWVuc2FqZQ==",
    referenceBase58: REFERENCE,
    desde: AHORA,
    ...over,
  };
}

/** Una transacción REAL firmada por el sender: es lo que la billetera devuelve en el paso 2. */
function txFirmadaB58(firmante: Keypair = SENDER): string {
  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [{ pubkey: firmante.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([1, 2, 3]),
    }),
  );
  tx.feePayer = firmante.publicKey;
  tx.recentBlockhash = bs58.encode(new Uint8Array(32).fill(3));
  tx.partialSign(firmante);
  return bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/** La billetera de mentira: cifra como dice la documentación, con el par que se le indique. */
function respuestaDeLaBilletera(
  cuerpo: unknown,
  opciones: { quien?: nacl.BoxKeyPair; billetera?: BilleteraDeeplink } = {},
): Record<string, string> {
  const quien = opciones.quien ?? billeteraReal;
  const billetera = opciones.billetera ?? "phantom";
  const secreto = nacl.box.before(par.publicKey, quien.secretKey);
  const nonce = nacl.randomBytes(24);
  const data = nacl.box.after(new TextEncoder().encode(JSON.stringify(cuerpo)), nonce, secreto);
  return {
    [NOMBRE_DE_LA_CLAVE[billetera]]: bs58.encode(quien.publicKey),
    nonce: bs58.encode(nonce),
    data: bs58.encode(data),
  };
}

function href(marca?: string, extra: Record<string, string> = {}): string {
  const u = new URL(HREF_BASE);
  if (marca) u.searchParams.set("dl", marca);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

let mensajesPedidos: string[] = [];

function pedido(a: Almacen, over: Partial<PedidoDeFirma> = {}): PedidoDeFirma {
  return {
    almacen: a,
    ahora: AHORA,
    hrefActual: href(),
    appUrl: APP_URL,
    remittanceId: REM,
    sender: SENDER.publicKey.toBase58(),
    beneficiary: BENEFICIARY,
    authority: AUTHORITY,
    mensajeBase64: "bWVuc2FqZQ==",
    transaccionBase58: bs58.encode(new Uint8Array(64).fill(9)),
    referenceBase58: REFERENCE,
    mensajeDePatrocinio: (firma: string) => {
      mensajesPedidos.push(firma);
      return new TextEncoder().encode(`autorizo:${firma}`);
    },
    ...over,
  };
}

beforeEach(() => {
  mensajesPedidos = [];
});

const motor = new FirmaPorEnlaceReal();

/** Abre el sobre de una URL saliente con el par que quedó en el disco. Es el test de T-062-17. */
function abrirSobreDeLaUrl(url: string, secretaEnDisco: Uint8Array): Record<string, unknown> {
  const q = new URL(url).searchParams;
  const publicaDeclarada = q.get("dapp_encryption_public_key");
  if (!publicaDeclarada) throw new Error("la URL no declara la clave pública de la app");
  // El sobre lo cerró la app con `nacl.box.after(secretoCompartido(claveBilletera, secretaDeLaApp))`.
  // Para abrirlo desde el lado de la billetera se deriva el MISMO secreto con la privada de la
  // billetera y la pública que la URL declara.
  const secreto = nacl.box.before(bs58.decode(publicaDeclarada), billeteraReal.secretKey);
  const abierto = nacl.box.open.after(
    bs58.decode(q.get("payload") ?? ""),
    bs58.decode(q.get("nonce") ?? ""),
    secreto,
  );
  if (!abierto) throw new Error("el sobre NO abre con el par que quedó en disco");
  void secretaEnDisco;
  return JSON.parse(new TextDecoder().decode(abierto)) as Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-062-6 (AC-5 / CD-5 / T12) — la divergencia de destino
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 POR QUÉ ESTO NO LO CUBRE EL SERVIDOR. El guard S3.5 del settle cruza el beneficiary contra
// `listPreparedDepositAddresses`, que devuelve TODAS las direcciones preparadas para esa remesa y ese
// sender, y hace `includes(...)`. Si una reanudación preparó una SEGUNDA dirección, el servidor
// acepta cualquiera de las dos. Este caso lo cubre el cliente, acá.
describe("T-062-6: el destino tiene que ser el MISMO que el del intento en que se pidió la firma", () => {
  // MUTANTE QUE MATA (a): comparar sólo `beneficiary` ⇒ el caso `authority` sobrevive y este `it` se
  //                       pone rojo. Es por eso que hay un caso POR CAMPO y no uno solo.
  // MUTANTE QUE MATA (b): cambiar el `!==` por `===` ⇒ los dos casos se ponen rojos y además el
  //                       camino feliz de todos los demás `describe` corta.
  it("un `beneficiary` distinto del persistido ⇒ deeplink_prepare_diverged", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a, { beneficiary: Keypair.generate().publicKey.toBase58() }));
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_PREPARE_DIVERGED });
  });

  it("un `authority` distinto del persistido ⇒ deeplink_prepare_diverged", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a, { authority: Keypair.generate().publicKey.toBase58() }));
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_PREPARE_DIVERGED });
  });

  it("ante la divergencia NO se arma ningún salto y NO se pide ninguna firma nueva", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a, { authority: Keypair.generate().publicKey.toBase58() }));
    expect(r.tipo).toBe("corte");
    expect(mensajesPedidos, "se armó un mensaje de patrocinio sobre un destino divergente").toEqual(
      [],
    );
  });

  it("el registro se ESCRIBE en la primera invocación, y el destino coincide consigo mismo", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    const r = motor.resolver(pedido(a));
    expect(r.tipo).toBe("salto"); // no cortó: no había con qué divergir
    const reg = leerPreparado(a, AHORA);
    expect(reg.tipo).toBe("hay");
    expect(reg.tipo === "hay" && reg.preparado.beneficiary).toBe(BENEFICIARY);
    expect(reg.tipo === "hay" && reg.preparado.referenceBase58).toBe(REFERENCE);
  });

  // MUTANTE QUE MATA: envolver el `guardarPreparado` del motor en un `try {} catch {}` ⇒ el salto se
  // pide igual y la persona firma algo contra lo que este dispositivo no va a poder comparar nada.
  it("si el disco no acepta el registro, TIRA y no se salta", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    a.fallarEscrituraDe = CLAVE_PREPARADO;
    expect(() => motor.resolver(pedido(a))).toThrow("QuotaExceededError");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-062-11 (T2) — `remesaEnCurso` NUNCA `null`
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-062-11: `interpretarVuelta` recibe el remittanceId, nunca `null`", () => {
  // 🔴 POR QUÉ ESTO SE MIDE POR COMPORTAMIENTO Y NO CON UN ESPÍA SOBRE EL 4º ARGUMENTO. Un espía
  // afirma "se pasó este valor"; esto afirma "el guard que ese valor enciende CORTÓ". Con `null`,
  // `interpretarVuelta` no compara la remesa Y CONSUME EL PASO IGUAL — o sea que el mutante barato no
  // sólo pasa desapercibido, además quema una firma.
  // MUTANTE QUE MATA: pasarle `null` como 4º argumento ⇒ la vuelta se lee como buena y el desenlace
  // deja de ser un corte.
  it("un viaje de OTRA remesa corta en vez de aplicarse sobre ésta", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ remittanceId: "rem-OTRA" }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(
      pedido(a, {
        hrefActual: href("firmar-tx", respuestaDeLaBilletera({ transaction: txFirmadaB58() })),
      }),
    );
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_VIAJE_VENCIDO });
  });

  it("y con el viaje de LA MISMA remesa la respuesta sí se lee (control del caso de arriba)", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(
      pedido(a, {
        hrefActual: href("firmar-tx", respuestaDeLaBilletera({ transaction: txFirmadaB58() })),
      }),
    );
    expect(r.tipo).toBe("salto");
    expect(r.tipo === "salto" && r.esperando).toBe("firma-patrocinio");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-062-8 (AC-8 / T8) — qué falta se decide POR RESULTADOS, nunca por `viaje.paso`
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-062-8: el salto que falta sale de los RESULTADOS, no de `viaje.paso`", () => {
  // 🔴 `Viaje.paso` queda RANCIO por construcción: dice qué se fue a pedir, no qué se consiguió.
  // MUTANTE QUE MATA: decidir por `viaje.paso` en vez de por `transaccionFirmada`/`firmaDePatrocinio`
  // ⇒ estos dos `it` mandan al salto equivocado y a la persona se le pide dos veces la misma firma.
  // Los `paso:` de abajo están puestos AL REVÉS del resultado a propósito: es lo que hace que el
  // mutante muera.
  it("CON `transaccionFirmada` y SIN patrocinio ⇒ el salto es `firma-patrocinio`", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "conectar", transaccionFirmada: txFirmadaB58() }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    expect(r.tipo).toBe("salto");
    expect(r.tipo === "salto" && r.esperando).toBe("firma-patrocinio");
  });

  it("SIN `transaccionFirmada` ⇒ el salto es `firma-tx` aunque el `paso` diga otra cosa", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-patrocinio" }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    expect(r.tipo).toBe("salto");
    expect(r.tipo === "salto" && r.esperando).toBe("firma-tx");
  });

  it("con las DOS ⇒ ningún salto: `completo`, y con la reference PERSISTIDA", () => {
    const a = almacenFalso();
    const tx = txFirmadaB58();
    guardarViaje(a, viajeConectado({ transaccionFirmada: tx, firmaDePatrocinio: "FIRMA-POP" }));
    // La reference del registro es la de la tx que se mandó a firmar; la de `pedido` sería la de una
    // tx recién armada y descartada. El envelope tiene que llevar la primera.
    guardarPreparado(a, preparadoBase({ referenceBase58: "REFERENCE-DEL-INTENTO-ORIGINAL" }));
    const r = motor.resolver(pedido(a, { referenceBase58: "REFERENCE-NUEVA-Y-DESCARTADA" }));
    expect(r).toEqual({
      tipo: "completo",
      transaccionFirmadaBase58: tx,
      firmaDePatrocinio: "FIRMA-POP",
      referenceBase58: "REFERENCE-DEL-INTENTO-ORIGINAL",
    });
  });

  // AC-8 / CD-7: no se vuelve a pedir una firma ya dada.
  it("con la tx ya firmada NO se pide de nuevo la firma de la transacción", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ transaccionFirmada: txFirmadaB58() }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    expect(r.tipo === "salto" && new URL(r.irA).pathname).toBe("/ul/v1/signMessage");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-062-9 (AC-6 / T9) — las URLs de los dos saltos y el `redirect_link`
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-062-9: cada salto va a SU endpoint, en el orden fijo, con el href COMPLETO de vuelta", () => {
  // MUTANTE QUE MATA (a): invertir el orden de los dos saltos ⇒ el patrocinio se pide antes de que
  //   exista la firma de la transacción que ese mensaje lleva adentro, y los dos `it` se ponen rojos.
  // MUTANTE QUE MATA (b): pasarle `pathname + search` a `enlaceDeVuelta` en vez del href completo ⇒
  //   `new URL(origen)` TIRA (medido en 061, T9) y el `it` del `redirect_link` muere.
  it("el salto 2 va a /ul/v1/signTransaction", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    expect(r.tipo).toBe("salto");
    if (r.tipo !== "salto") return;
    const u = new URL(r.irA);
    expect(u.host).toBe("phantom.app");
    expect(u.pathname).toBe("/ul/v1/signTransaction");
    expect(r.esperando).toBe("firma-tx");
  });

  it("el salto 3 va a /ul/v1/signMessage y sólo después de tener la firma de la tx", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ transaccionFirmada: txFirmadaB58() }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    expect(r.tipo).toBe("salto");
    if (r.tipo !== "salto") return;
    expect(new URL(r.irA).pathname).toBe("/ul/v1/signMessage");
    expect(r.esperando).toBe("firma-patrocinio");
    // El mensaje se armó CON la firma que estaba adentro de la tx recuperada, no con un valor vacío.
    expect(mensajesPedidos).toHaveLength(1);
    expect(mensajesPedidos[0]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,}$/); // firma ed25519 en base58
  });

  it("el `redirect_link` sale del href COMPLETO y conserva los parámetros ajenos", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a, { hrefActual: "https://chaski.test/enviar?rem=r-1&kyc=return" }));
    if (r.tipo !== "salto") throw new Error("no hubo salto");
    const redirect = new URL(r.irA).searchParams.get("redirect_link") ?? "";
    const u = new URL(redirect);
    expect(u.origin).toBe("https://chaski.test");
    expect(u.pathname).toBe("/enviar");
    expect(u.searchParams.get("dl")).toBe("firmar-tx");
    expect(u.searchParams.get("kyc"), "se perdió un parámetro ajeno del origen").toBe("return");
  });

  // 🔴 EL `redirect_link` NO PUEDE ARRASTRAR LA RESPUESTA ANTERIOR. `URLSearchParams.get` devuelve el
  // PRIMERO, así que un `nonce` viejo pegado al nuevo gana. `enlaceDeVuelta` limpia; este `it` fija
  // que el motor le pasa el href de verdad (con la respuesta adentro) y no uno ya lavado a mano.
  it("el `redirect_link` NO arrastra los parámetros de respuesta del salto anterior", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    const respuesta = respuestaDeLaBilletera({ transaction: txFirmadaB58() });
    const r = motor.resolver(pedido(a, { hrefActual: href("firmar-tx", respuesta) }));
    if (r.tipo !== "salto") throw new Error("no hubo salto");
    const redirect = new URL(new URL(r.irA).searchParams.get("redirect_link") ?? "");
    expect(redirect.searchParams.get("nonce")).toBeNull();
    expect(redirect.searchParams.get("data")).toBeNull();
    expect(redirect.searchParams.get("phantom_encryption_public_key")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-062-17 (T10) — `secreta` y `publica` no están intercambiadas
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-062-17: la clave pública que declara la URL corresponde al par cuya privada quedó en disco", () => {
  // 🔴 HOY NADA MÁS DETECTA ESE INTERCAMBIO: `secreta` y `publica` son las DOS base58 de 32 bytes, y
  // un viaje con las dos cruzadas se guarda, se lee y arma URLs sin que nada chille — hasta que la
  // vuelta no abre, en el teléfono de alguien.
  // MUTANTE QUE MATA: en `firma-por-enlace.ts`, `clavePublicaDeLaApp: bs58.decode(conseguido.secreta)`
  // (o derivar el secreto desde `publica`) ⇒ el sobre NO abre y este `it` tira.
  it("se abre un sobre REAL con el par del disco", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    if (r.tipo !== "salto") throw new Error("no hubo salto");

    const enDisco = JSON.parse(a.datos.get(CLAVE_VIAJE) ?? "{}") as Viaje;
    const cuerpo = abrirSobreDeLaUrl(r.irA, bs58.decode(enDisco.secreta));
    expect(cuerpo.session).toBe("sesion-opaca");
    expect(typeof cuerpo.transaction).toBe("string");

    // Y la pública declarada es LA PÚBLICA del par, no la privada.
    const declarada = new URL(r.irA).searchParams.get("dapp_encryption_public_key");
    expect(declarada).toBe(enDisco.publica);
    expect(declarada).not.toBe(enDisco.secreta);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-062-12 (T3) — la `persistencia` se mira SIEMPRE
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-062-12: `no-se-pudo-guardar` corta, y NO se salta de nuevo", () => {
  // 🔴 `persistencia` vive en 3 de las 10 variantes de `Vuelta` y NADA del tipo obliga a mirarla.
  // Si no se mira, el resultado que no se guardó se pierde en el salto siguiente y el proceso muere
  // en ese salto: la persona firma dos veces y no llega a ningún lado.
  // MUTANTE QUE MATA: borrar el `if (vuelta.persistencia === "no-se-pudo-guardar")` ⇒ los dos `it`
  // de abajo pasan a devolver un salto en vez de un corte.
  it("en el paso 2 (tx-firmada)", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    a.fallarEscrituraDe = CLAVE_VIAJE; // el disco acepta el registro pero NO el resultado del viaje
    const r = motor.resolver(
      pedido(a, {
        hrefActual: href("firmar-tx", respuestaDeLaBilletera({ transaction: txFirmadaB58() })),
      }),
    );
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_SIN_MEMORIA });
  });

  it("en el paso 3 (patrocinio-firmado)", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ transaccionFirmada: txFirmadaB58() }));
    guardarPreparado(a, preparadoBase());
    a.fallarEscrituraDe = CLAVE_VIAJE;
    const r = motor.resolver(
      pedido(a, {
        hrefActual: href("firmar-patrocinio", respuestaDeLaBilletera({ signature: "FIRMA-POP" })),
      }),
    );
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_SIN_MEMORIA });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-062-13 (T4 / T6) — `manos-vacias` NO es `sin-viaje`
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-062-13: una vuelta con las manos vacías NO destruye la firma que ya está adentro", () => {
  // 🔴 ES EL MUTANTE QUE BORRA UNA TRANSACCIÓN DEL CAMINO DEL DINERO.
  // MUTANTE QUE MATA: tratar los dos motivos de `huerfana` igual (cortar —y por lo tanto llamar
  // `terminarViaje`— también en `manos-vacias`) ⇒ el `it` de abajo pierde la `transaccionFirmada` que
  // la persona ya firmó, y que no está en memoria de nadie porque la página murió en el salto.
  it("`manos-vacias` con una tx firmada adentro ⇒ sigue al salto que falta, sin limpiar", () => {
    const a = almacenFalso();
    const tx = txFirmadaB58();
    guardarViaje(a, viajeConectado({ transaccionFirmada: tx }));
    guardarPreparado(a, preparadoBase());
    // La marca puesta pero SIN parámetros de respuesta: `interpretarVuelta` devuelve
    // `huerfana`/`manos-vacias` porque en el disco SÍ hay viaje.
    const r = motor.resolver(pedido(a, { hrefActual: href("firmar-tx") }));

    expect(r.tipo, "cortó en vez de seguir: se está tratando `manos-vacias` como `sin-viaje`").toBe(
      "salto",
    );
    expect(r.tipo === "salto" && r.esperando).toBe("firma-patrocinio");
    const despues = leerViaje(a, AHORA);
    expect(
      despues.tipo === "hay" && despues.viaje.transaccionFirmada,
      "se borró una transacción que la persona ya había firmado",
    ).toBe(tx);
  });

  it("`sin-viaje` (disco vacío) ⇒ corte: acá no se pierde nada porque no hay nada", () => {
    const a = almacenFalso();
    guardarPreparado(a, preparadoBase()); // hay registro pero NO hay viaje
    const r = motor.resolver(pedido(a, { hrefActual: href("firmar-tx") }));
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_VIAJE_VENCIDO });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-062-14 (T5) — el `origen` del rechazo decide, no el `codigo`
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-062-14: un rechazo de la billetera y un fallo NUESTRO producen causas distintas", () => {
  // 🔴 EL `errorCode` VIAJA SIN CIFRAR y lo escribe quien arme la URL. Colapsar los dos orígenes es
  // exactamente cómo un fallo de cripto propio termina en la pantalla de alguien como "cancelaste".
  // MUTANTE QUE MATA: devolver `DEEPLINK_RECHAZADO` en las dos ramas del `switch` sobre `origen`.
  it("`origen: billetera` ⇒ deeplink_rechazado", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(
      pedido(a, {
        hrefActual: href("firmar-tx", { errorCode: "4001", errorMessage: "User rejected" }),
      }),
    );
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_RECHAZADO });
  });

  it("`origen: nuestro` (el sobre no abre) ⇒ deeplink_respuesta_ilegible, NUNCA 'cancelaste'", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    // Un sobre cifrado por la clave correcta pero con el payload corrupto: el fallo es de NUESTRO
    // lado leyéndolo, no una cancelación de nadie.
    const respuesta = respuestaDeLaBilletera({ transaction: txFirmadaB58() });
    respuesta.data = bs58.encode(new Uint8Array(64).fill(1));
    const r = motor.resolver(pedido(a, { hrefActual: href("firmar-tx", respuesta) }));
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_RESPUESTA_ILEGIBLE });
  });

  it("una respuesta cifrada por OTRA clave ⇒ deeplink_tx_alterada (no es un rechazo ni una huérfana)", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    const impostor = nacl.box.keyPair();
    const r = motor.resolver(
      pedido(a, {
        hrefActual: href(
          "firmar-tx",
          respuestaDeLaBilletera({ transaction: txFirmadaB58() }, { quien: impostor }),
        ),
      }),
    );
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_TX_ALTERADA });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-062-15 (T6 / T11 / CD-10) — la limpieza, en TODAS las salidas y SIEMPRE después de leer
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-062-15: cada salida deja el viaje y el registro limpios, y los resultados se leen ANTES", () => {
  /** Arma un almacén en el estado que produce cada corte, y devuelve el desenlace. */
  const CORTES: Array<[string, (a: ReturnType<typeof almacenFalso>) => DesenlaceDeFirma]> = [
    [
      "prepare_diverged",
      (a) => {
        guardarViaje(a, viajeConectado());
        guardarPreparado(a, preparadoBase());
        return motor.resolver(pedido(a, { beneficiary: Keypair.generate().publicKey.toBase58() }));
      },
    ],
    [
      "sender_mismatch",
      (a) => {
        guardarViaje(a, viajeConectado({ direccion: Keypair.generate().publicKey.toBase58() }));
        guardarPreparado(a, preparadoBase());
        return motor.resolver(pedido(a));
      },
    ],
    [
      "viaje_vencido (sin viaje)",
      (a) => {
        guardarPreparado(a, preparadoBase());
        return motor.resolver(pedido(a));
      },
    ],
    [
      "viaje_vencido (otra remesa)",
      (a) => {
        guardarViaje(a, viajeConectado({ remittanceId: "rem-OTRA" }));
        guardarPreparado(a, preparadoBase());
        return motor.resolver(
          pedido(a, {
            hrefActual: href("firmar-tx", respuestaDeLaBilletera({ transaction: txFirmadaB58() })),
          }),
        );
      },
    ],
    [
      "viaje_vencido (ya consumida)",
      (a) => {
        guardarViaje(a, viajeConectado({ pasosConsumidos: ["conectar", "firmar-tx"] }));
        guardarPreparado(a, preparadoBase());
        return motor.resolver(
          pedido(a, {
            hrefActual: href("firmar-tx", respuestaDeLaBilletera({ transaction: txFirmadaB58() })),
          }),
        );
      },
    ],
    [
      "tx_alterada (otra clave)",
      (a) => {
        guardarViaje(a, viajeConectado());
        guardarPreparado(a, preparadoBase());
        return motor.resolver(
          pedido(a, {
            hrefActual: href(
              "firmar-tx",
              respuestaDeLaBilletera({ transaction: txFirmadaB58() }, { quien: nacl.box.keyPair() }),
            ),
          }),
        );
      },
    ],
    [
      "rechazado",
      (a) => {
        guardarViaje(a, viajeConectado());
        guardarPreparado(a, preparadoBase());
        return motor.resolver(pedido(a, { hrefActual: href("firmar-tx", { errorCode: "4001" }) }));
      },
    ],
    [
      "respuesta_ilegible",
      (a) => {
        guardarViaje(a, viajeConectado());
        guardarPreparado(a, preparadoBase());
        const resp = respuestaDeLaBilletera({ transaction: txFirmadaB58() });
        resp.data = bs58.encode(new Uint8Array(64).fill(1));
        return motor.resolver(pedido(a, { hrefActual: href("firmar-tx", resp) }));
      },
    ],
    [
      "sin_memoria",
      (a) => {
        guardarViaje(a, viajeConectado());
        guardarPreparado(a, preparadoBase());
        a.fallarEscrituraDe = CLAVE_VIAJE;
        return motor.resolver(
          pedido(a, {
            hrefActual: href("firmar-tx", respuestaDeLaBilletera({ transaction: txFirmadaB58() })),
          }),
        );
      },
    ],
  ];

  // MUTANTE QUE MATA (b): borrar el `terminarViaje` de la salida de éxito ⇒ la x25519 privada
  // sobrevive en el disco hasta que la ventana de 20 minutos la venza.
  for (const [nombre, armar] of CORTES) {
    it(`el corte \`${nombre}\` deja el disco limpio`, () => {
      const a = almacenFalso();
      const r = armar(a);
      expect(r.tipo).toBe("corte");
      expect(a.datos.has(CLAVE_VIAJE), "el viaje quedó en el disco tras un corte").toBe(false);
      expect(a.datos.has(CLAVE_PREPARADO), "el registro quedó en el disco tras un corte").toBe(false);
    });
  }

  // 🔴 MUTANTE QUE MATA (a): mover el `terminarViaje` ANTES de leer `transaccionFirmada` /
  // `firmaDePatrocinio` ⇒ el envelope sale con campos vacíos y este `it` se pone rojo. Es el orden,
  // no la presencia, lo que este caso mide: `terminarViaje` SE LLEVA los resultados con él.
  it("la salida de ÉXITO devuelve los resultados COMPLETOS y recién después limpia", () => {
    const a = almacenFalso();
    const tx = txFirmadaB58();
    guardarViaje(a, viajeConectado({ transaccionFirmada: tx, firmaDePatrocinio: "FIRMA-POP" }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    expect(r.tipo).toBe("completo");
    expect(r.tipo === "completo" && r.transaccionFirmadaBase58).toBe(tx);
    expect(r.tipo === "completo" && r.firmaDePatrocinio).toBe("FIRMA-POP");
    expect(a.datos.has(CLAVE_VIAJE), "la x25519 privada sobrevivió a la salida de éxito").toBe(false);
    expect(a.datos.has(CLAVE_PREPARADO)).toBe(false);
  });

  // ⛔ Y la contracara: un SALTO NO limpia. El viaje tiene que sobrevivir al salto — es su razón de
  // existir. MUTANTE QUE MATA: llamar `terminarViaje` también en la rama del salto ⇒ la persona sale
  // a firmar y vuelve a un dispositivo que no recuerda nada.
  it("un SALTO deja el viaje y el registro INTACTOS", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    expect(r.tipo).toBe("salto");
    expect(a.datos.has(CLAVE_VIAJE)).toBe(true);
    expect(a.datos.has(CLAVE_PREPARADO)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-062-16 (CD-9 / T7) — la clave privada NO cruza el límite del módulo
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-062-16: nada de lo que devuelve el motor contiene la `secreta`", () => {
  // 🔴 `LecturaDelViaje.hay` expone la x25519 privada CRUDA. Devolverla "por comodidad" la manda al
  // puerto, a React, a un mensaje de error y a un `console`.
  // MUTANTE QUE MATA: agregarle al desenlace un campo con la `LecturaDelViaje` (o con `viaje`) ⇒ los
  // tres `it` de abajo encuentran la `secreta` en el JSON.
  const desenlaces: Array<[string, () => DesenlaceDeFirma]> = [
    [
      "salto",
      () => {
        const a = almacenFalso();
        guardarViaje(a, viajeConectado());
        guardarPreparado(a, preparadoBase());
        return motor.resolver(pedido(a));
      },
    ],
    [
      "completo",
      () => {
        const a = almacenFalso();
        guardarViaje(
          a,
          viajeConectado({ transaccionFirmada: txFirmadaB58(), firmaDePatrocinio: "F" }),
        );
        guardarPreparado(a, preparadoBase());
        return motor.resolver(pedido(a));
      },
    ],
    [
      "corte",
      () => {
        const a = almacenFalso();
        guardarViaje(a, viajeConectado());
        guardarPreparado(a, preparadoBase());
        return motor.resolver(pedido(a, { beneficiary: Keypair.generate().publicKey.toBase58() }));
      },
    ],
  ];

  for (const [nombre, producir] of desenlaces) {
    it(`el desenlace \`${nombre}\`, serializado a JSON, no trae la clave privada`, () => {
      const r = producir();
      const json = JSON.stringify(r);
      const secretaB58 = bs58.encode(par.secretKey);
      expect(json).not.toContain(secretaB58);
      expect(json).not.toContain("secreta");
      expect(json).not.toContain("secretaBytes");
      // Y tampoco por pedazos: los primeros 16 bytes ya alcanzarían para reconstruir nada bueno.
      expect(json).not.toContain(secretaB58.slice(0, 20));
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CD-11 / T12 — el sender no sale del canal del enlace
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("el viaje sólo puede COINCIDIR con el sender, nunca sustituirlo", () => {
  // MUTANTE QUE MATA: borrar el `if (viaje.direccion !== p.sender)` ⇒ un connect forjado se queda con
  // el viaje entero y el depósito se arma con una dirección de viaje ajena.
  it("`viaje.direccion` distinta del sender ⇒ deeplink_sender_mismatch", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ direccion: Keypair.generate().publicKey.toBase58() }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    expect(r.tipo).toBe("corte");
    expect(r.tipo === "corte" && r.causa).toBe("deeplink_sender_mismatch");
  });

  // ⛔ NUNCA `.toLowerCase()`: base58 es case-sensitive y bajarlo a minúsculas fabrica colisiones.
  it("la comparación es CASE-SENSITIVE (base58 no se normaliza a minúsculas)", () => {
    const a = almacenFalso();
    const dir = SENDER.publicKey.toBase58();
    guardarViaje(a, viajeConectado({ direccion: dir.toLowerCase() }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a, { sender: dir }));
    expect(r.tipo === "corte" && r.causa).toBe("deeplink_sender_mismatch");
  });
});
