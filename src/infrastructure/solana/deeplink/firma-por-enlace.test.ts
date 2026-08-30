// ⚠️ CD-15 · LAS 32 FILAS DE ESTA TABLA SON MEDICIONES, no declaraciones. Las 26 primeras se corrieron
// en el fix-pack 1 (2026-08-17); las 5 siguientes —de `CALIB` para abajo— en el fix-pack 2, y en esa
// vuelta se RE-CORRIERON cuatro filas viejas: `CALIB` (35 → 39), `ALTO1-a` (10 → 12), `ALTO1-b` (1 → 5, y
// su sitio se movió) y `MED1-a` (1 → 2). Las cuatro subieron porque el FP2 agregó `it` que pasan por su
// código; ninguna bajó, que es la mitad que importaba mirar. `spawnSync` sin
// pipes, suite COMPLETA (136 archivos) por mutante, aguja contada con `== 1`, relectura del disco,
// restauración verificada byte a byte.
//
// ⚠️ EL FIX-PACK 3 (AR-it3) AGREGÓ 2 `it` —la última fila, `IT3-MNR4`— y ESO OBLIGÓ A RE-CORRER FILAS
// VIEJAS, porque un `it` nuevo que pasa por el código de un mutante viejo le sube el conteo sin que nadie
// edite su fila. Baseline del FP3: `136 passed` / `2466 passed`, exit 0 (eran 2464 antes de los dos `it`).
// Re-corridas: `CALIB` (39 → 41), `ALTO1-a` (12 → 13), `BAJO1-b` (1 → 2) y `T-062-15(a)` (6 → 8; el FP4 midió que ese 6 era CIERTO en el FP1 y se podrió solo —ver su nota— y re-corrió `CALIB` sobre dba48f9: 41, sin cambio).
// Re-corridas Y SIN CAMBIO, que es la mitad que se suele no mirar: `ALTO1-b` (5) y
// `BAJO1-a` (4) — los dos preservan igual porque el patrocinio del fixture nuevo está definido y tiene
// forma de firma. Las que NO se re-corrieron es porque los dos `it` nuevos cortan en el paso 6 y no
// alcanzan su código (ninguno escribe ancla, ninguno llega a `completo`, ninguno arma un salto).
//
// 🔒 EL NÚMERO VIEJO DE OTRO ARCHIVO QUEDÓ CERRADO EN EL FP4, Y ERAN DOS SITIOS, NO UNO: `CALIB` es el
// MISMO mutante que `solana-wallet.test.ts` anota como `T-062-7`, y allá la fila decía **39** y su
// cabecera **35** donde son **41** (los rojos nuevos caen en ESTE archivo, pero el mutante es uno y su
// conteo es global). Los dos sitios se corrigieron con el conteo RE-MEDIDO sobre dba48f9 y con el commit
// escrito en la misma línea, y ahora cada tabla cita a la otra con el formato anclado
// (`viaje.direccion`, `../../solana-wallet.test.ts:1330`) para que el candado de citas se ponga rojo si
// una se mueve sin la otra: el candado NO compara los números, así que eso es todo lo que hay.
//
// 🔴 CALIBRACIÓN, Y ESTA VEZ SIRVIÓ DE VERDAD: el mutante que tenía que MORIR dio exit=1 con 35 `it`
// rojos (39 en el FP2 y 41 en el FP3 y en el FP4, con los `it` nuevos de cada vuelta); el que tenía que VIVIR dio **exit=0**. En el primer intento los DOS dieron exit=1 y eso
// delató el instrumento roto (el árbol tenía el candado de citas en rojo y el parser leía la salida
// con códigos ANSI adentro). Sin la calibración, las filas de abajo habrían sido mentiras.
//
// ⚠️ Y EL INSTRUMENTO DEL FIX-PACK 2 TAMBIÉN SE CALIBRÓ, por dos fallas ya medidas en este repo: (1)
// `npx vitest > archivo` bajo el hook `rtk` deja el archivo en **36 bytes** con exit 0, así que la
// corrida se hace con `spawnSync` y el archivo lo escribe node (27.569 bytes en el baseline); y (2) el
// reporter imprime la lista de fallas DOS veces, así que contar líneas `×` da el DOBLE — el número que
// vale es el de la línea `Tests N failed`.
//
// ⚠️ CADA "MUTANTE QUE MATA" DE ESTE ARCHIVO ESTÁ EN ESTA TABLA Y CADA FILA TIENE SU CLAIM. Eso es
// CD-15, y estuvo en FAIL dos revisiones seguidas: primero 42 claims contra 43 filas; después 26 filas
// contra 27 mutantes, y el que faltaba era justo el de CALIBRACIÓN de toda la batería (el de 39 rojos).
// Ese es el que entra abajo como `CALIB`, y es EL MISMO que la tabla de `solana-wallet.test.ts` anota
// como `T-062-7`: es un solo mutante que mata `it` en los dos archivos, no dos mutantes.
//
// ⛔ Y ACÁ VA EL RESIDUO, porque este borde ya falló tres revisiones seguidas: la correspondencia
// fila ↔ claim se verifica A MANO, no hay candado. Un candado por CONTEO no alcanza, y el motivo NO es
// que "se compare consigo mismo" (esa cláusula estaba acá y era FALSA, AR-it3/MNR-5: contar filas contra
// contar sitios de claim cruza DOS artefactos independientes del archivo, y eso es cruce): es que la
// relación NO es 1:1 por sitio. LA ARITMÉTICA COMPLETA, re-derivada en el FP4 sobre dba48f9 porque la
// receta que estuvo acá NO reproducía: 34 apariciones de la frase − 1 la cabecera de :37 − 3 que remiten
// a un mutante YA tabulado (:825 → el 15(a) de :798 · :1071 → el ALTO1-a de :859 · :1297 → el MED1-a de
// :1208) + 1 porque :1394 declara DOS en un solo comentario (`MED2-a` y `MED2-b`) + 1 por la fila
// `T-062-11`, cuyo claim está en :377 y NO usa la frase vigilada (dice otra) = 32, contra las 32 filas
// de :58-:89. La receta vieja nombraba 2 de las 3 cross-refs y no nombraba la fila de :377: esos dos
// errores se COMPENSAN (−1 y +1), así que cerraba en 32 de casualidad, y sin restar la cabecera da 33. El
// candado honesto —taguear los 32 claims con el nombre de su fila y comparar conjuntos— sigue PROPUESTO. 🔴 Y ESA ARITMÉTICA YA NO CIERRA, PORQUE EL COMMIT DEL ADDENDUM DEL RELOJ LA VOLVIÓ FALSA SIN QUE NADIE EDITARA ESTE PÁRRAFO — es el MISMO defecto que el AR encontró en otros tres conteos de este commit, y éste es el cuarto (AR-fp/BLQ-MED-3, hallazgo agregado por el Dev). RE-DERIVADO HOY con la receta de arriba: 39 apariciones − 1 − 3 + 1 + 1 = **37 claims contra 32 filas**. FALTAN CINCO FILAS Y SE NOMBRAN, para que la deuda sea visible en vez de silenciosa: `F` (:1638), `G-1` (:1654), `G-1b` (:1656) y `G-2` (:1666), las cuatro del commit del addendum, y `X6` (:1689), la de este fix-pack. ⛔ NO SE ESCRIBEN CON NÚMEROS INVENTADOS: la tercera columna es un conteo de `it` rojos SOBRE LA SUITE ENTERA, y hoy la suite tiene un flake medido de ~13 % en `PUERTA 2` de `../../presentation/vuelta-por-enlace-carrera.test.tsx`, así que una sola corrida por mutante daría un número que no reproduce. La receta para cerrarlo, cuando se decida pagarlo: correr cada uno de los cinco con `spawnSync` sobre la suite completa, DOS veces, y descartar el rojo de `PUERTA 2` si aparece. De `X6` ya está medido lo que se pudo medir sin eso: exit=1 y **1 `it` rojo en ESTE archivo** (`72 passed | 1 failed (73)`), y la suite ENTERA en verde SIN el testigo, que es el falso KILLED que lo motivó.
//
// | mutante                                                          | exit | `it` rojos |
// |---|---|---|
// | T-062-6(a)  comparar sólo el `beneficiary`                        | 1 | 2 |
// | T-062-6(b)  `!==` por `===` en la comparación de destino          | 1 | 27 |
// | T-062-6(c)  `guardarPreparado` se traga la excepción del disco     | 1 | 2 |
// | T-062-8     decidir el salto por `viaje.paso`                     | 1 | 11 |
// | T-062-9(a)  el salto 2 apunta al endpoint del 3                   | 1 | 10 |
// | T-062-9(b)  `pathname+search` en vez del href completo            | 1 | 16 |
// | T-062-11    `remesaEnCurso: null` (ver la nota de su `describe`)   | 1 | 2 |
// | T-062-12    ignorar la `persistencia`                             | 1 | 4 |
// | T-062-13    tratar los dos motivos de `huerfana` igual            | 1 | 1 |
// | T-062-14    colapsar los dos orígenes del rechazo                 | 1 | 1 |
// | T-062-15(a) limpiar ANTES de leer, SITIO A (ver su nota)          | 1 | 8 (re-medido en dba48f9; el 6 era del FP1) |
// | T-062-15(b) volver a limpiar en la salida de éxito del motor      | 1 | 1 |
// | T-062-15(c) `terminarViaje` también en la rama del salto          | 1 | 3 |
// | T-062-16    devolver la `secreta` en el desenlace                 | 1 | 2 |
// | T-062-17    intercambiar `secreta`/`publica`                       | 1 | 2 |
// | ALTO1-a     volver `cortar` incondicional                         | 1 | 13 (re-medido en FP3; 12 en FP2, 10 en FP1) |
// | ALTO1-b     `!== undefined` en vez del predicado de preservación   | 1 | 5 (re-medido en FP2) |
// | MED1-a      escribir el ancla UNA vez y no refrescarla            | 1 | 2 (re-medido en FP2) |
// | MED1-b      refrescar el ancla SIEMPRE (aun con firma dada)       | 1 | 1 |
// | MED1-c      refrescar `desde` en cada invocación                  | 1 | 1 |
// | MED1-d      borrar el corte «hay firma y no hay ancla»            | 1 | 3 |
// | MED2-a      no comparar el `remittanceId` del registro            | 1 | 1 |
// | MED2-b      no comparar el `sender` del registro                  | 1 | 1 |
// | MED2-c      borrar el guard del `remittanceId` del viaje          | 1 | 1 |
// | CONECTADO   borrar el guard `!estaConectado(viaje)`               | 1 | 1 |
// | MNR2        borrar la validación `esFirmaUtil` de los resultados   | 1 | 1 |
// | CALIB       invertir `viaje.direccion !== p.sender` (el que DEBÍA morir) | 1 | 41, en dos archivos (RE-MEDIDO en dba48f9/FP4; 39 en el FP2, 35 en el FP1) |
// | BAJO1-a     preservar con `esFirmaUtil` sola (el predicado viejo)   | 1 | 4 (re-corrido en el FP3, SIN cambio) |
// | BAJO1-b     `tieneFormaDeFirma` mide 32 bytes en vez de 64         | 1 | 2 (re-medido en FP3; el control positivo + el `it` de la limitación de `IT3-MNR4`) |
// | BAJO1-c     `tieneFormaDeFirma` acepta cualquier cosa              | 1 | 1 + 1 de refilón (ver abajo) |
// | MNR3        borrar el corte `firmaDelSender === null` del paso 9    | 1 | 1 |
// | IT3-MNR4    borrar el corte «patrocinio sin transacción» del paso 6 | 1 | 2 (los dos `it` del último `describe`) |
//
// ⚠️ `BAJO1-c` AGREGA LÍNEAS, y eso pone rojo **de refilón** al candado de citas ancladas
// (`citas-ancladas.test.ts`), porque desplaza el destino de una cita a `firma-por-enlace.ts`. Va dicho:
// el `it` de comportamiento que lo caza es UNO, no dos, y quien lea "2 rojos" sin esta línea va a creer
// que dos tests de comportamiento lo cazaron.
//
// (Las tres filas de `guardarPreparado`/`leerPreparado` que viven en `preparado.ts` están en la tabla
// de `preparado.test.ts`, con las otras 14: son mutantes de ESE archivo.)
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
  DEEPLINK_RECHAZADO, DEEPLINK_RELOJ_INCONSISTENTE, // el segundo EN ESTA LÍNEA (Δ0): este archivo recibe una cita anclada en `:1532` y una línea nueva acá la correría
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
  // MUTANTE QUE MATA (a): comparar sólo `beneficiary` ⇒ MEDIDO: exit=1, 2 `it` rojos, y son los del
  //                       caso `authority`. Por eso hay un caso POR CAMPO y no uno solo.
  // MUTANTE QUE MATA (b): cambiar el `!==` por `===` ⇒ MEDIDO: exit=1, 27 `it` rojos — los dos casos de
  //                       acá y el camino feliz de todos los demás `describe`, que empieza a cortar.
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

  // MUTANTE QUE MATA (MEDIDO: exit=1, 2 `it` rojos, éste y el de `preparado.test.ts` que fija que la
  // función TIRA): que `guardarPreparado` se trague la excepción del disco (su `a.escribir` envuelto en
  // `try {} catch {}`) ⇒ el salto se pide igual y la persona firma algo contra lo que este dispositivo
  // no va a poder comparar nada al volver.
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
  // ⚠️ MUTANTE CORRIDO, Y SU CLAIM CAMBIÓ CON EL FIX-PACK. Pasarle `null` como 4º argumento sigue
  // muriendo (exit=1), pero **ya NO mata este `it`**, y decirlo es la mitad del valor de haberlo
  // corrido: con `null`, `interpretarVuelta` no compara la remesa, pero el guard NUEVO
  // `viaje.remittanceId !== p.remittanceId` corta igual y el desenlace de acá no se mueve. Lo que el
  // mutante SÍ mata son los 2 `it` de «otra remesa» de T-062-15: sin el 4º argumento el paso se
  // CONSUME —el daño real de T2, que es irreversible— y la firma recién escrita queda en el disco, así
  // que la aserción de limpieza cambia de valor. O sea: el `null` se paga en el consumo del paso, no en
  // la causa. MEDIDO: exit=1, 2 `it` rojos, ninguno de este `describe`.
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
  // MUTANTE QUE MATA (MEDIDO: exit=1, 11 `it` rojos): decidir por `viaje.paso` en vez de por
  // `transaccionFirmada`/`firmaDePatrocinio` ⇒ estos `it` mandan al salto equivocado y a la persona se
  // le pide dos veces la misma firma.
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
    guardarPreparado(
      a,
      preparadoBase({
        referenceBase58: "REFERENCE-DEL-INTENTO-ORIGINAL",
        mensajeBase64: "MENSAJE-DEL-INTENTO-ORIGINAL",
      }),
    );
    const r = motor.resolver(
      pedido(a, {
        referenceBase58: "REFERENCE-NUEVA-Y-DESCARTADA",
        mensajeBase64: "MENSAJE-NUEVO-Y-DESCARTADO",
      }),
    );
    // Los DOS campos que describen la transacción salen del ANCLA, no del pedido: la tx que vale es la
    // que está firmada, no la que esta invocación armó. Con `mensajeBase64` tomado del pedido, el
    // adaptador compararía los bytes devueltos contra una transacción que nadie firmó (AR/BLQ-MED-1).
    expect(r).toEqual({
      tipo: "completo",
      transaccionFirmadaBase58: tx,
      firmaDePatrocinio: "FIRMA-POP",
      referenceBase58: "REFERENCE-DEL-INTENTO-ORIGINAL",
      mensajeBase64: "MENSAJE-DEL-INTENTO-ORIGINAL",
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
  // MUTANTE QUE MATA (a): que el salto 2 apunte al endpoint del 3 (`urlFirmarMensaje` en la rama de
  //   `firma-tx`) ⇒ se le pide firmar un mensaje que todavía no puede existir, porque lleva adentro la
  //   firma de la transacción. MEDIDO: exit=1, 10 `it` rojos (incluidos los del adaptador).
  // MUTANTE QUE MATA (b): pasarle `pathname + search` a `enlaceDeVuelta` en vez del href completo ⇒
  //   `new URL(origen)` TIRA (medido en 061, T9). MEDIDO: exit=1, 16 `it` rojos.
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
  // MUTANTE QUE MATA (MEDIDO: exit=1, 2 `it` rojos): en `firma-por-enlace.ts`,
  // `clavePublicaDeLaApp: bs58.decode(viaje.secreta)` (o derivar el secreto desde `publica`) ⇒ el sobre
  // NO abre y este `it` tira.
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
  // MUTANTE QUE MATA (MEDIDO: exit=1, 4 `it` rojos): borrar el `if (vuelta.persistencia === "no-se-pudo-guardar")` ⇒ los dos `it`
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
  // MUTANTE QUE MATA (MEDIDO: exit=1, 1 `it` rojo, éste): tratar los dos motivos de `huerfana` igual (cortar —y por lo tanto llamar
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
  // MUTANTE QUE MATA (MEDIDO: exit=1, 1 `it` rojo, el de `origen: nuestro`): devolver
  // `DEEPLINK_RECHAZADO` en las dos ramas del `switch` sobre `origen`.
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

  // MUTANTE QUE MATA (15(a), RE-MEDIDO en el FP4 sobre dba48f9: exit=1, **8** `it` rojos, 1 archivo): limpiar
  // ANTES de leer los resultados, en el SITIO A —y el sitio va escrito porque el número solo no alcanza—: un
  // `terminarViaje(p.almacen)` pegado encima de `const txFirmadaCruda =` (firma-por-enlace.ts:629), arriba de
  // la lectura del paso 6 ⇒ el éxito sale con el disco vacío. Es el ORDEN, no la presencia, lo que se mide. El
  // SITIO B que la descripción también admite —adentro de `cortar`, arriba de su `leerViaje` (:439)— da **13**
  // y es INDISTINGUIBLE de `ALTO1-a`: destruir antes de leer hace que `hayAlgoQueSalvar` sea siempre `false`.
  // ⛔ EL RESIDUO DEL FP3 (su número viejo era **6** y no reprodujo) YA NO ES HIPÓTESIS, Y LA QUE EL FP3 DEJÓ
  // ERA FALSA: supuso que el 6 se midió cuando el paso 6 releía el disco, y ese segundo `leerViaje` ya no
  // existía en fba7ea0 (FP1), el commit donde el 6 se escribió. Medido corriendo el mutante en un worktree de
  // fba7ea0: ahí daba exit=1 y **6** rojos, y son los MISMOS 6 de hoy; los otros 2 son `it` agregados después
  // (uno en 93b22ee, uno en dba48f9) que este mutante también mata. El 6 era CIERTO al escribirse y se podrió
  // solo: 6 → 7 → 8 sin que nadie lo tocara (`candados-que-se-pudren-solos`); por eso el número lleva commit.
  for (const [nombre, armar] of CORTES) {
    it(`el corte \`${nombre}\` deja el disco limpio`, () => {
      const a = almacenFalso();
      const r = armar(a);
      expect(r.tipo).toBe("corte");
      expect(a.datos.has(CLAVE_VIAJE), "el viaje quedó en el disco tras un corte").toBe(false);
      expect(a.datos.has(CLAVE_PREPARADO), "el registro quedó en el disco tras un corte").toBe(false);
    });
  }

  // 🔴 LA SALIDA DE ÉXITO DEL MOTOR YA NO LIMPIA, Y ES A PROPÓSITO (AR/MNR-3). La limpieza del camino
  // de éxito la hace el adaptador DESPUÉS de verificar los bytes y de preguntarle a la cadena por el
  // blockhash: si se limpiara acá, un RPC que no contesta dejaría a la persona sin nada que reanudar
  // sobre un recorrido cuyas dos firmas estaban perfectas. Que el disco quede limpio al final del
  // camino de éxito lo mide `solana-wallet.test.ts`, que es donde termina el uso.
  // MUTANTE QUE MATA (a): mover una limpieza ANTES de armar el desenlace ⇒ los dos primeros `expect`
  //   se ponen rojos (el desenlace sale con campos vacíos).
  // MUTANTE QUE MATA (b): volver a poner `terminarViaje`/`terminarPreparado` al final del `completo` ⇒
  //   los dos últimos `expect` se ponen rojos, y con ellos se pierde la única cosa que le permite al
  //   adaptador reintentar cuando el que falla es nuestro propio RPC.
  it("la salida de ÉXITO devuelve los resultados COMPLETOS y NO limpia: eso es del adaptador", () => {
    const a = almacenFalso();
    const tx = txFirmadaB58();
    guardarViaje(a, viajeConectado({ transaccionFirmada: tx, firmaDePatrocinio: "FIRMA-POP" }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    expect(r.tipo).toBe("completo");
    expect(r.tipo === "completo" && r.transaccionFirmadaBase58).toBe(tx);
    expect(r.tipo === "completo" && r.firmaDePatrocinio).toBe("FIRMA-POP");
    expect(
      a.datos.has(CLAVE_VIAJE),
      "el motor limpió el viaje en la salida de éxito: el adaptador todavía tiene que verificar los bytes y el blockhash",
    ).toBe(true);
    expect(a.datos.has(CLAVE_PREPARADO)).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 🔴 UN CORTE NO PUEDE DESTRUIR UNA FIRMA QUE LA PERSONA YA DIO — AR/BLQ-ALTO-1
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // Éste es el hallazgo más caro de la HU y su test es la otra mitad del arreglo: el `it` de arriba
  // congelaba el comportamiento equivocado porque su fixture NO tenía `transaccionFirmada`, así que
  // assertaba el disco limpio SIN VER la pérdida. Acá los mismos cortes se corren con una transacción
  // firmada adentro del viaje —un depósito del camino del dinero que no está en memoria de nadie,
  // porque la página murió en el salto— y lo que se exige es que sobreviva.
  //
  // 🔴 Y DOS DE ESTOS CORTES LOS DISPARA TEXTO DE URL QUE NADIE AUTENTICÓ (`errorCode` viaja sin
  // cifrar): un enlace pegado en un chat, abierto a mitad de recorrido, tiraba la firma a la basura.
  //
  // MUTANTE QUE MATA (ALTO1-a, RE-MEDIDO en el FP3: exit=1, **13** `it` rojos; eran 12 en el FP2 y 10 en
  // el FP1): volver `cortar` incondicional (borrar el `if (!hayAlgoQueSalvar)`) ⇒ se ponen rojos los ocho
  // casos de abajo, el control positivo del patrocinio, el `it` del costo de preservar, el «tx firmada SIN
  // ancla», el «viaje de OTRA remesa» y —el 13º, que agregó el FP3— el `it` de la limitación de
  // `IT3-MNR4`, que exige que el corte del patrocinio-sin-tx tampoco borre. Y los nueve casos de arriba
  // siguen VERDES, que es exactamente por qué hacían falta los dos conjuntos.
  describe("un corte NO borra un viaje que tiene una firma adentro (AR/BLQ-ALTO-1)", () => {
    const FIRMADA = txFirmadaB58();
    /** Los mismos cortes de arriba, pero con el viaje YA con la firma del paso 2 adentro. */
    const CON_FIRMA: Array<[string, (a: ReturnType<typeof almacenFalso>) => DesenlaceDeFirma]> = [
      [
        "prepare_diverged",
        (a) => {
          guardarViaje(a, viajeConectado({ transaccionFirmada: FIRMADA }));
          guardarPreparado(a, preparadoBase());
          return motor.resolver(pedido(a, { beneficiary: Keypair.generate().publicKey.toBase58() }));
        },
      ],
      [
        "sender_mismatch",
        (a) => {
          guardarViaje(
            a,
            viajeConectado({
              direccion: Keypair.generate().publicKey.toBase58(),
              transaccionFirmada: FIRMADA,
            }),
          );
          guardarPreparado(a, preparadoBase());
          return motor.resolver(pedido(a));
        },
      ],
      [
        "viaje_vencido (otra remesa)",
        (a) => {
          guardarViaje(a, viajeConectado({ remittanceId: "rem-OTRA", transaccionFirmada: FIRMADA }));
          guardarPreparado(a, preparadoBase());
          return motor.resolver(
            pedido(a, {
              hrefActual: href("firmar-tx", respuestaDeLaBilletera({ transaction: txFirmadaB58() })),
            }),
          );
        },
      ],
      // 🔴 EL CASO DE LA RECARGA / BOTÓN ATRÁS. Es el más común de todos y era el más caro.
      [
        "viaje_vencido (ya consumida)",
        (a) => {
          guardarViaje(
            a,
            viajeConectado({
              pasosConsumidos: ["conectar", "firmar-tx"],
              transaccionFirmada: FIRMADA,
            }),
          );
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
          guardarViaje(a, viajeConectado({ transaccionFirmada: FIRMADA }));
          guardarPreparado(a, preparadoBase());
          return motor.resolver(
            pedido(a, {
              hrefActual: href(
                "firmar-patrocinio",
                respuestaDeLaBilletera({ signature: "F" }, { quien: nacl.box.keyPair() }),
              ),
            }),
          );
        },
      ],
      // 🔴 ENTRADA DE UN TERCERO: el `errorCode` no está autenticado y lo escribe quien arme la URL.
      [
        "rechazado (errorCode pegado a mano)",
        (a) => {
          guardarViaje(a, viajeConectado({ transaccionFirmada: FIRMADA }));
          guardarPreparado(a, preparadoBase());
          return motor.resolver(
            pedido(a, { hrefActual: href("firmar-patrocinio", { errorCode: "4001" }) }),
          );
        },
      ],
      [
        "respuesta_ilegible",
        (a) => {
          guardarViaje(a, viajeConectado({ transaccionFirmada: FIRMADA }));
          guardarPreparado(a, preparadoBase());
          const resp = respuestaDeLaBilletera({ signature: "F" });
          resp.data = bs58.encode(new Uint8Array(64).fill(1));
          return motor.resolver(pedido(a, { hrefActual: href("firmar-patrocinio", resp) }));
        },
      ],
      [
        "sin_memoria (el disco no acepta el resultado nuevo)",
        (a) => {
          guardarViaje(a, viajeConectado({ transaccionFirmada: FIRMADA }));
          guardarPreparado(a, preparadoBase());
          a.fallarEscrituraDe = CLAVE_VIAJE;
          return motor.resolver(
            pedido(a, { hrefActual: href("firmar-patrocinio", respuestaDeLaBilletera({ signature: "F" })) }),
          );
        },
      ],
    ];

    for (const [nombre, armar] of CON_FIRMA) {
      it(`el corte \`${nombre}\` NO se lleva la transacción ya firmada`, () => {
        const a = almacenFalso();
        const r = armar(a);
        expect(r.tipo).toBe("corte");
        const enDisco = leerViaje(a, AHORA);
        expect(
          enDisco.tipo,
          "el corte BORRÓ el viaje, y adentro había un depósito del camino del dinero que la persona ya firmó y que no está en memoria de nadie",
        ).toBe("hay");
        expect(enDisco.tipo === "hay" && enDisco.viaje.transaccionFirmada).toBe(FIRMADA);
        // Y el ancla también: el `mensajeBase64` del registro es lo ÚNICO contra lo que esa firma se
        // puede verificar. Guardar la firma y borrar su ancla es guardar algo que ya no sirve.
        expect(
          a.datos.has(CLAVE_PREPARADO),
          "se preservó la firma y se borró el ancla contra la que se verifica",
        ).toBe(true);
      });
    }

    // ⛔ LA CONTRACARA, para que "no borrar" no se convierta en "no borrar nunca": lo que no le sirve al
    // recorrido NO es una firma, y preservarlo lo deja trabado hasta que la ventana lo mate, sin nada que
    // salvar.
    //
    // 🔴 ACÁ EL FIXTURE PROBABA MENOS DE LO QUE EL CÓDIGO AFIRMABA (AR-it2/BLQ-BAJO-1). Era UN caso y era
    // `"   "`, o sea el ÚNICO valor que `esFirmaUtil` rechaza: el `it` daba verde sobre un predicado que
    // aceptaba cualquier basura no blanca, y con `"no-soy-una-transaccion"` en el disco cinco invocaciones
    // idénticas daban las cinco `deeplink_tx_alterada` con el viaje INTACTO. Es el patrón
    // `el-test-del-camino-feliz-ejercitaba-el-agujero`, del lado del caso negativo. Los cuatro valores de
    // abajo son los que el AR midió, incluido el que NO es basura sintáctica.
    // MUTANTE QUE MATA (ALTO1-b, RE-MEDIDO en el FP2 porque su sitio se movió de `cortar` a
    //   `resultadoPreservable`: exit=1, **5** `it` rojos, los cuatro casos de abajo más el del residuo):
    //   decidir la preservación con `!== undefined` en los dos campos. Antes mataba 1 —cuando el único
    //   fixture era `"   "`—, y que ahora mate 5 es la medida de lo que el fixture viejo no probaba.
    // MUTANTE QUE MATA (BAJO1-a, MEDIDO: exit=1, **4** `it` rojos): volver la preservación a
    //   `esFirmaUtil` sola (el predicado viejo, sin exigir que la tx decodifique ni que traiga la firma
    //   del sender) ⇒ el caso `blanco` sigue verde —es el único que el predicado viejo también rechazaba,
    //   y es exactamente por qué este fixture no podía quedar solo— y se ponen rojos los otros tres más
    //   el del residuo.
    // MUTANTE QUE MATA (BAJO1-b, RE-MEDIDO en el FP3: exit=1, **2** `it` rojos, era 1):
    //   `tieneFormaDeFirma` midiendo 32 bytes en vez de 64 ⇒ muere el CONTROL POSITIVO de más abajo, no el
    //   4º caso (con 32 el string de basura tampoco decodifica). Que mate uno y no el otro es lo que
    //   prueba que los dos hacen falta. El 2º rojo lo agregó el FP3: el `it` de la limitación de
    //   `IT3-MNR4` usa un patrocinio de 64 bytes y con la medida en 32 deja de ser preservable, así que el
    //   corte limpia y ese `it` lo nota.
    // MUTANTE QUE MATA (BAJO1-c, MEDIDO: exit=1, 1 `it` rojo de comportamiento —el 4º caso— más el
    //   candado de citas de refilón, porque el mutante agrega líneas): `tieneFormaDeFirma` aceptando
    //   cualquier cosa.
    const NO_ES_FIRMA: Array<[string, Partial<Viaje>]> = [
      ["blanco", { transaccionFirmada: "   " }],
      ["una tx que no decodifica", { transaccionFirmada: "no-soy-una-transaccion" }],
      // 🔴 NO ES BASURA SINTÁCTICA: decodifica perfecto, y no trae la entrada del sender. Es lo que puede
      // entregar el canal, y el paso 9 corta sobre ella en CADA vuelta.
      ["una tx sin la firma del sender", { transaccionFirmada: txFirmadaB58(Keypair.generate()) }],
      ["un patrocinio sin forma de firma ed25519", { firmaDePatrocinio: "no-soy-una-firma" }],
    ];

    for (const [nombre, campos] of NO_ES_FIRMA) {
      it(`\`${nombre}\` NO cuenta como firma: el corte SÍ limpia y el recorrido no queda trabado`, () => {
        const a = almacenFalso();
        guardarViaje(a, viajeConectado(campos));
        guardarPreparado(a, preparadoBase());
        const r = motor.resolver(pedido(a, { beneficiary: Keypair.generate().publicKey.toBase58() }));
        expect(r.tipo).toBe("corte");
        expect(
          a.datos.has(CLAVE_VIAJE),
          "se preservó un resultado inservible: el recorrido queda trabado hasta que la ventana lo mate",
        ).toBe(false);
        expect(a.datos.has(CLAVE_PREPARADO)).toBe(false);
      });
    }

    // EL CONTROL POSITIVO del 4º caso, y es lo que impide que el arreglo se convierta en "borrar
    // siempre": una firma de patrocinio con la forma de una ed25519 (64 bytes en base58) SÍ se preserva,
    // aunque este módulo no tenga con qué verificarla.
    it("un `firmaDePatrocinio` de 64 bytes SÍ se preserva (control del caso de arriba)", () => {
      const a = almacenFalso();
      const firmaReal = bs58.encode(nacl.sign.detached(new Uint8Array([1, 2, 3]), SENDER.secretKey));
      expect(bs58.decode(firmaReal).length, "el fixture no es una firma ed25519").toBe(64);
      guardarViaje(a, viajeConectado({ firmaDePatrocinio: firmaReal }));
      guardarPreparado(a, preparadoBase());
      const r = motor.resolver(pedido(a, { beneficiary: Keypair.generate().publicKey.toBase58() }));
      expect(r.tipo).toBe("corte");
      expect(a.datos.has(CLAVE_VIAJE), "se borró una firma que sí tiene forma de firma").toBe(true);
      expect(a.datos.has(CLAVE_PREPARADO)).toBe(true);
    });

    // ⚠️ EL RESIDUO DEL PREDICADO, ESCRITO Y MEDIDO, no descubierto por el próximo que lea el código: la
    // pregunta es por la firma de `p.sender`, la cuenta de ESTA invocación. Si la persona cambió de cuenta
    // en su billetera, el corte es `deeplink_sender_mismatch` y la firma de la cuenta VIEJA no se preserva.
    // La alternativa —preguntar por `viaje.direccion`, que sale del disco— reabre el agujero completo:
    // quien pueda escribir el disco pone una `direccion` propia y una tx firmada por SU par, y vuelve a
    // tener un viaje que ningún corte limpia. No se pierde plata: esa transacción nunca se transmitió.
    // ⚠️ EL COSTO DE PRESERVAR, MEDIDO ACÁ Y NO SÓLO AFIRMADO EN UN COMENTARIO (AR-it2/MNR-2). El código
    // decía como consuelo que "el que abandona de verdad tiene su propia limpieza", y esa salida
    // (`abandonarAutorizacion`) NO corre en el camino del corte: el `throw` sube desde
    // `authorizePrincipal` y su único llamador de producción no lo atrapa, así que `failAndRefund` —el
    // único sitio que la llama— no se ejecuta nunca. Consecuencia: con la URL de rechazo todavía en la
    // barra, cada invocación repite el mismo corte. Este `it` fija las DOS mitades, porque una sola sería
    // la mitad que asusta o la mitad que tranquiliza.
    // MUTANTE QUE MATA: `ALTO1-a` (volver `cortar` incondicional) ⇒ la primera invocación borra y ni las
    // repeticiones ni la retomada existen. Está contado en su fila.
    it("con la URL de rechazo pegada, 3 invocaciones repiten el corte sin tocar el disco; con el href limpio RETOMA", () => {
      const a = almacenFalso();
      const tx = txFirmadaB58();
      guardarViaje(a, viajeConectado({ transaccionFirmada: tx }));
      guardarPreparado(a, preparadoBase());
      const antes = a.datos.get(CLAVE_VIAJE);

      // El `errorCode` viaja SIN cifrar y lo escribe quien arme el enlace: esto es una URL fabricada.
      const hrefDeRechazo = href("firmar-patrocinio", { errorCode: "4001" });
      for (const intento of [1, 2, 3]) {
        const r = motor.resolver(pedido(a, { hrefActual: hrefDeRechazo }));
        expect(r, `la invocación ${intento} no repitió el mismo corte`).toEqual({
          tipo: "corte",
          causa: DEEPLINK_RECHAZADO,
        });
        expect(a.datos.get(CLAVE_VIAJE), "el disco se movió entre invocaciones idénticas").toBe(antes);
      }
      expect(a.borrados, "algo borró el disco en el camino del corte").toEqual([]);

      // Y la única salida que existe HOY: volver con el href limpio. Nadie limpia el query string por
      // nosotros (ola 4 / HU-357), y esta línea es la que prueba que lo preservado sí sirve.
      const retoma = motor.resolver(pedido(a, { hrefActual: href() }));
      expect(retoma.tipo === "salto" && retoma.esperando).toBe("firma-patrocinio");
    });

    it("con la cuenta CAMBIADA, la firma de la cuenta vieja no se preserva (residuo declarado)", () => {
      const a = almacenFalso();
      const cuentaVieja = Keypair.generate();
      guardarViaje(
        a,
        viajeConectado({
          direccion: cuentaVieja.publicKey.toBase58(),
          transaccionFirmada: txFirmadaB58(cuentaVieja), // firma REAL, de la cuenta vieja
        }),
      );
      guardarPreparado(a, preparadoBase());
      const r = motor.resolver(pedido(a)); // `p.sender` sigue siendo SENDER
      expect(r).toEqual({ tipo: "corte", causa: "deeplink_sender_mismatch" });
      expect(a.datos.has(CLAVE_VIAJE)).toBe(false);
    });
  });

  // ⛔ Y la contracara: un SALTO NO limpia. El viaje tiene que sobrevivir al salto — es su razón de
  // existir. MUTANTE QUE MATA (MEDIDO: exit=1, 3 `it` rojos): llamar `terminarViaje` también en la rama
  // del salto ⇒ la persona sale a firmar y vuelve a un dispositivo que no recuerda nada.
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
  // MUTANTE QUE MATA (MEDIDO: exit=1, 2 `it` rojos): agregarle al desenlace del `"completo"` un campo
  // con la `secreta` del viaje (o la `LecturaDelViaje` entera "por comodidad") ⇒ los `it` de abajo la
  // encuentran en el JSON. Que sean 2 y no 3: el mutante se puso en la rama del `"completo"`, así que
  // el caso `corte` no lo ve — y está bien, porque ese objeto no lo arma.
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
// 🔴 EL ANCLA Y LA TX QUE SE MANDA A FIRMAR SON LA MISMA COSA, EN TODA INVOCACIÓN — AR/BLQ-MED-1
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Éste es el recorrido COMPLETO con las cuatro invocaciones que produce un salto pedido dos veces, que
// es el caso más común que existe: la persona sale a la billetera, vuelve sin haber firmado, y se le
// pide de nuevo. Antes del arreglo el `Preparado` se escribía UNA sola vez y no se refrescaba nunca,
// mientras cada invocación rearmaba la tx con `reference`, `deadline` y blockhash nuevos ⇒ se le pedía
// firmar txB con el ancla en msgA, y la invocación final cortaba con `deeplink_tx_alterada` —una causa
// FALSA— y destruía las dos firmas. El recorrido era ESTRUCTURALMENTE INCAPAZ DE CERRAR.
//
// ⚠️ NINGÚN `it` de este archivo podía verlo, y el CR nombró el hueco de método: el único test con dos
// invocaciones sembraba el `Preparado` A MANO, así que nadie medía la relación entre lo que el motor
// persiste y lo que se compara en la invocación siguiente. Acá no se siembra nada: el disco es el que
// el motor deja.
describe("BLQ-MED-1: el ancla describe la tx que se está mandando a firmar, invocación por invocación", () => {
  function anclaEnDisco(a: Almacen): Preparado {
    const r = leerPreparado(a, AHORA);
    if (r.tipo !== "hay") throw new Error("no quedó ancla en el disco");
    return r.preparado;
  }

  // MUTANTE QUE MATA (a): escribir el ancla UNA sola vez (`if (ancla === null) guardarPreparado(...)`)
  //   ⇒ la invocación B deja el ancla en MSG-A y el `completo` final devuelve MSG-A, o sea el bug
  //   original. MEDIDO: exit=1, 1 `it` rojo, éste.
  // MUTANTE QUE MATA (b): refrescar el ancla SIEMPRE (una escritura de más, afuera del
  //   `if (txFirmada === undefined)`) ⇒ la invocación C la mueve a MSG-C y el `completo` devuelve el
  //   mensaje de una tx que NADIE firmó. MEDIDO: exit=1, 1 `it` rojo, éste.
  // MUTANTE QUE MATA (c): refrescar `desde` en cada invocación (`desde: p.ahora`) ⇒ la ventana de 20
  //   min arranca de nuevo en cada vuelta. MEDIDO: exit=1, 1 `it` rojo, éste.
  //   ⚠️ Y ESTE MUTANTE ESTUVO VIVO EN EL DISCO un rato: la batería se abortó a mano en medio de su
  //   corrida y quedó escrito en `firma-por-enlace.ts`. Lo cazó ESTE `it`, no el `git status`.
  it("dos pedidos del paso 2 ⇒ el ancla queda sobre la SEGUNDA tx, y el recorrido cierra", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());

    // ── invocación A: primera vez que se pide la firma de la transacción ──────────────────────────
    const invA = motor.resolver(pedido(a, { mensajeBase64: "MSG-A", referenceBase58: "REF-A" }));
    expect(invA.tipo === "salto" && invA.esperando).toBe("firma-tx");
    expect(anclaEnDisco(a).mensajeBase64).toBe("MSG-A");
    expect(anclaEnDisco(a).referenceBase58).toBe("REF-A");
    expect(anclaEnDisco(a).desde).toBe(AHORA);

    // ── invocación B: la persona volvió SIN respuesta y se le pide de nuevo ───────────────────────
    // La tx es OTRA (reference nueva, deadline nuevo, blockhash nuevo): el ancla tiene que moverse con
    // ella o la comparación final va a hablar de una transacción que ya no existe.
    const invB = motor.resolver(
      pedido(a, { ahora: AHORA + 60_000, mensajeBase64: "MSG-B", referenceBase58: "REF-B" }),
    );
    expect(invB.tipo === "salto" && invB.esperando).toBe("firma-tx");
    expect(
      anclaEnDisco(a).mensajeBase64,
      "el ancla se quedó en la tx de la invocación anterior: la billetera va a firmar otra cosa y el corte final va a mentir la causa",
    ).toBe("MSG-B");
    expect(anclaEnDisco(a).referenceBase58).toBe("REF-B");
    // ⚠️ Y `desde` NO se refresca: si se refrescara, la ventana de 20 min arrancaría de nuevo en cada
    // invocación, o sea que su duración la elegiría quien pueda provocar invocaciones.
    expect(anclaEnDisco(a).desde, "el refresco del ancla movió la ventana de vencimiento").toBe(AHORA);

    // ── invocación C: ahora sí volvió la transacción firmada ──────────────────────────────────────
    const firmada = txFirmadaB58();
    const invC = motor.resolver(
      pedido(a, {
        ahora: AHORA + 120_000,
        mensajeBase64: "MSG-C",
        referenceBase58: "REF-C",
        hrefActual: href("firmar-tx", respuestaDeLaBilletera({ transaction: firmada })),
      }),
    );
    expect(invC.tipo === "salto" && invC.esperando).toBe("firma-patrocinio");
    // 🔴 ACÁ EL ANCLA **NO** SE MUEVE, y es la otra mitad del invariante: ya hay una tx firmada, y el
    // ancla describe LA QUE SE FIRMÓ. Moverla a MSG-C haría que el adaptador compare la tx firmada
    // contra una transacción que esta invocación armó y descartó.
    expect(anclaEnDisco(a).mensajeBase64, "el ancla se movió cuando ya había una firma dada").toBe(
      "MSG-B",
    );

    // ── invocación D: volvió el patrocinio ⇒ completo ─────────────────────────────────────────────
    const invD = motor.resolver(
      pedido(a, {
        ahora: AHORA + 180_000,
        mensajeBase64: "MSG-D",
        referenceBase58: "REF-D",
        hrefActual: href("firmar-patrocinio", respuestaDeLaBilletera({ signature: "POP" })),
      }),
    );
    expect(invD.tipo, "el recorrido con un segundo pedido del paso 2 no cerró").toBe("completo");
    if (invD.tipo !== "completo") return;
    expect(invD.transaccionFirmadaBase58).toBe(firmada);
    expect(invD.firmaDePatrocinio).toBe("POP");
    // Los dos campos que describen la transacción son los de la tx QUE SE FIRMÓ (la B), no los de la
    // primera ni los de la última invocación.
    expect(invD.mensajeBase64).toBe("MSG-B");
    expect(invD.referenceBase58).toBe("REF-B");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ⚠️ LIMITACIÓN DECLARADA (AR-it2/BLQ-BAJO-2): EL ANCLA ES **UN SLOT** Y EL SALTO B PISA EL DE A
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  //
  // ⛔ ESTE `it` NO CONGELA UN COMPORTAMIENTO DESEADO: congela el residual del invariante de arriba, para
  // que se lea en la suite y no lo descubra el próximo. El invariante es correcto para el pedido EN CURSO;
  // el problema es el ANTERIOR, que sigue siendo contestable. Si la billetera contesta el pedido A cuando
  // el ancla ya es la de B, la firma que la persona SÍ dio queda inverificable, el adaptador la borra, y la
  // causa que llega afirma "no es lo que se pidió firmar" cuando sí lo era, un pedido antes.
  //
  // Por qué NO se arregla acá: el disparador —que una billetera conteste un pedido que ya no es el último—
  // es una afirmación sobre runtime móvil que NADIE midió (CD-4/CD-12). Y "no re-anclar mientras haya un
  // salto sin respuesta" es literalmente el mutante MED1-a de arriba. Las dos salidas están escritas en el
  // código, en el bloque del re-anclaje, para la ola 4.
  //
  // MUTANTE QUE MATA: **el mismo `MED1-a` de arriba**, y ése es el candado que le queda a esta
  // limitación. MEDIDO en el fix-pack 2: con el ancla escrita una sola vez, exit=1 y **2** `it` rojos —el
  // de MED1 y éste—, porque con el ancla clavada en A los bytes SÍ coinciden y el `not.toBe` final se
  // rompe. Por eso la fila `MED1-a` de la tabla pasó de 1 a 2.
  // ⛔ LO QUE ESTE `it` NO PUEDE MEDIR, y no se declara como si pudiera: un arreglo de N slots. Eso
  // cambia el formato del disco y no es un mutante de una línea, así que la responsabilidad de revisar
  // este `it` es de quien lo escriba.
  it("la billetera contesta el pedido ANTERIOR ⇒ el ancla ya es del último y los bytes NO van a coincidir", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    /** El `mensajeBase64` REAL de una transacción, que es lo que el adaptador compara (DT-10). */
    const mensajeDe = (txB58: string): string =>
      Transaction.from(bs58.decode(txB58)).serializeMessage().toString("base64");

    // Dos transacciones REALES y distintas, las dos firmadas por el sender: son la del pedido A y la del
    // pedido B (cada invocación rearma con `reference`, `deadline` y blockhash nuevos).
    const txA = txFirmadaB58();
    const txB = txFirmadaB58();
    expect(mensajeDe(txA), "las dos tx del fixture son iguales: el caso no se estaría midiendo").not.toBe(
      mensajeDe(txB),
    );

    // ── pedido A ────────────────────────────────────────────────────────────────────────────────────
    const invA = motor.resolver(
      pedido(a, { mensajeBase64: mensajeDe(txA), transaccionBase58: txA, referenceBase58: "REF-A" }),
    );
    expect(invA.tipo === "salto" && invA.esperando).toBe("firma-tx");
    expect(anclaEnDisco(a).mensajeBase64).toBe(mensajeDe(txA));

    // ── pedido B: la persona volvió sin firmar ⇒ el ancla PASA a B (el invariante de BLQ-MED-1) ─────
    const invB = motor.resolver(
      pedido(a, {
        ahora: AHORA + 60_000,
        mensajeBase64: mensajeDe(txB),
        transaccionBase58: txB,
        referenceBase58: "REF-B",
      }),
    );
    expect(invB.tipo === "salto" && invB.esperando).toBe("firma-tx");
    expect(anclaEnDisco(a).mensajeBase64).toBe(mensajeDe(txB));

    // ── y ahora contesta el pedido A, con txA FIRMADA ───────────────────────────────────────────────
    const invC = motor.resolver(
      pedido(a, {
        ahora: AHORA + 120_000,
        hrefActual: href("firmar-tx", respuestaDeLaBilletera({ transaction: txA })),
      }),
    );
    // El motor no puede notarlo: la firma es buena, es del sender, y sigue al salto que falta.
    expect(invC.tipo === "salto" && invC.esperando).toBe("firma-patrocinio");

    const invD = motor.resolver(
      pedido(a, {
        ahora: AHORA + 180_000,
        hrefActual: href("firmar-patrocinio", respuestaDeLaBilletera({ signature: "POP" })),
      }),
    );
    expect(invD.tipo).toBe("completo");
    if (invD.tipo !== "completo") return;
    // Acá está el daño, medido: la tx es la de A y el ancla es la de B.
    expect(invD.transaccionFirmadaBase58).toBe(txA);
    expect(invD.mensajeBase64).toBe(mensajeDe(txB));
    expect(
      mensajeDe(invD.transaccionFirmadaBase58),
      "si estos dos coincidieran, la limitación estaría cerrada y este `it` habría que reescribirlo",
    ).not.toBe(invD.mensajeBase64);
    // ⇒ el adaptador compara los bytes contra el ancla, no coinciden, y tira `deeplink_tx_alterada`
    // limpiando el recorrido: la firma que la persona dio se pierde. Plata en riesgo: ninguna, nunca
    // hubo POST al settle.
  });

  // Hay una firma en el disco y NO hay ancla contra la que verificarla: sin `mensajeBase64` no existe la
  // comparación bytes-contra-bytes, y aceptar lo que devuelva el canal sin ella es aceptar cualquier
  // cosa. Este corte antes vivía en el adaptador, donde NINGÚN test podía alcanzarlo (AR/MNR-5).
  // MUTANTE QUE MATA (MEDIDO: exit=1, 3 `it` rojos): borrar el
  // `if (ancla === null) return cortar(DEEPLINK_SIN_MEMORIA)` ⇒ el desenlace sale con un
  // `mensajeBase64` de `undefined` que el adaptador compara contra los bytes reales. (Con `tsc` puesto
  // ese mutante además no compila —el ancla es `Preparado | null`—; se corrió igual porque vitest no
  // typechequea, y así se mide qué hace el CÓDIGO y no qué promete el tipo.)
  it("una tx firmada SIN ancla ⇒ deeplink_sin_memoria, y la firma NO se borra", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ transaccionFirmada: txFirmadaB58(), firmaDePatrocinio: "POP" }));
    // sin `guardarPreparado`: el registro venció, se limpió por basura, o era de otra remesa
    const r = motor.resolver(pedido(a));
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_SIN_MEMORIA });
    expect(leerViaje(a, AHORA).tipo).toBe("hay");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 UN REGISTRO (O UN VIAJE) DE OTRA REMESA NO ES DE ESTA REMESA — AR/BLQ-MED-2
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Las dos claves del disco son SINGLETONS del origen: no llevan la remesa ni la cuenta adentro. Antes
// el guard comparaba `beneficiary`/`authority` y nada más, y los dos campos que sí dicen de quién es el
// registro se persistían y no los leía nadie: una cache key sin `user_id`.
describe("BLQ-MED-2: el registro y el viaje tienen que ser de ESTA remesa y de ESTA cuenta", () => {
  // MUTANTE QUE MATA (dos, uno por campo, MEDIDOS: exit=1 y 1 `it` rojo CADA UNO): borrar la
  // comparación de `remittanceId`, o la de `sender`, del cálculo del ancla ⇒ el registro ajeno se
  // adopta y el `completo` sale con el `mensajeBase64` y la `reference` de otra remesa. Que cada
  // mutante mate un `it` DISTINTO es lo que prueba que los dos casos de abajo miden campos distintos.
  it("un `Preparado` de OTRA remesa NO se adopta como ancla", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ transaccionFirmada: txFirmadaB58(), firmaDePatrocinio: "POP" }));
    guardarPreparado(
      a,
      preparadoBase({ remittanceId: "rem-DE-OTRA-REMESA", mensajeBase64: "ANCLA-AJENA" }),
    );
    const r = motor.resolver(pedido(a));
    // No se adopta: sin ancla propia, lo único honesto es que este dispositivo no puede verificar.
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_SIN_MEMORIA });
    expect(
      JSON.stringify(r),
      "el ancla ajena se filtró al desenlace",
    ).not.toContain("ANCLA-AJENA");
  });

  it("un `Preparado` de OTRA cuenta (mismo par beneficiary/authority) NO se adopta como ancla", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ transaccionFirmada: txFirmadaB58(), firmaDePatrocinio: "POP" }));
    guardarPreparado(
      a,
      preparadoBase({ sender: Keypair.generate().publicKey.toBase58(), mensajeBase64: "ANCLA-AJENA" }),
    );
    const r = motor.resolver(pedido(a));
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_SIN_MEMORIA });
  });

  // Y el viaje: `interpretarVuelta` compara la remesa SÓLO cuando la URL trae respuesta (`otra-remesa`).
  // Por el camino `no-volvimos` nadie la comparaba, y los resultados de otra remesa entraban como si
  // fueran de ésta.
  // MUTANTE QUE MATA (MEDIDO: exit=1, 1 `it` rojo, éste): borrar el
  // `if (viaje.remittanceId !== p.remittanceId)` ⇒ este `it` recibe un salto de patrocinio armado sobre
  // la transacción firmada de OTRA remesa.
  it("un viaje de OTRA remesa corta aunque la URL no traiga ninguna respuesta", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ remittanceId: "rem-OTRA", transaccionFirmada: txFirmadaB58() }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a)); // href SIN marca `dl`: `no-volvimos`
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_VIAJE_VENCIDO });
    // Y la firma de esa otra remesa sigue en el disco: no es nuestra, pero tampoco es basura.
    expect(leerViaje(a, AHORA).tipo).toBe("hay");
  });

  // El registro ajeno se SOBRE-ESCRIBE recién cuando ya se validó que el viaje es de esta remesa y se va
  // a mandar una tx a firmar. Ahí sí: sin viaje propio, ese registro no le sirve a nadie.
  it("con el viaje de ESTA remesa, el registro ajeno se reemplaza por el propio", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado());
    guardarPreparado(a, preparadoBase({ remittanceId: "rem-OTRA", mensajeBase64: "ANCLA-AJENA" }));
    const r = motor.resolver(pedido(a, { mensajeBase64: "ANCLA-PROPIA" }));
    expect(r.tipo).toBe("salto");
    const reg = leerPreparado(a, AHORA);
    expect(reg.tipo === "hay" && reg.preparado.remittanceId).toBe(REM);
    expect(reg.tipo === "hay" && reg.preparado.mensajeBase64).toBe("ANCLA-PROPIA");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Trampa 1 de la ola 4 + AR/MNR-2 — los dos guards que el CR midió SIN TEST
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("los guards que no tenían test", () => {
  // 🔴 EL GUARD MÁS IMPORTANTE PARA LA OLA 4, y sobrevivía a su mutante: el motor EXIGE un viaje con
  // `claveBilletera` + `session` + `direccion`, que sólo produce el connect de la ola 4. Con el motor
  // cableado y sin ese connect, TODO cae acá — y si nadie lo mide, se lee como un bug del motor.
  // MUTANTE QUE MATA (MEDIDO: exit=1, 1 `it` rojo, éste): borrar el `if (!estaConectado(viaje))` ⇒
  // `secretoCompartido` recibe `undefined` y el desenlace deja de ser el corte que este `it` espera.
  // ⚠️ Este guard SOBREVIVÍA a su mutante antes del fix-pack (el CR lo midió como M7): no tenía test.
  it("un viaje sin `claveBilletera` (connect incompleto) ⇒ deeplink_viaje_vencido", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ claveBilletera: undefined }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_VIAJE_VENCIDO });
  });

  // 🔴 AR/MNR-2 — `firmaDePatrocinio` es el ÚNICO campo del disco que se COPIA A LA RED (va como
  // `popSignature` al settle) y llegaba al envelope sin ninguna validación. MEDIDO en el AR: con
  // `{"no":"soy un string"}` en el disco, `authorizePrincipal` devolvía `{ estado: "listo" }` con un
  // `popSignature` de tipo `object`.
  // MUTANTE QUE MATA (MEDIDO: exit=1, 1 `it` rojo, éste): borrar la validación `esFirmaUtil` de los
  // resultados ⇒ el desenlace sale `completo` con un objeto adentro en vez de cortar.
  it("una `firmaDePatrocinio` que no es un string ⇒ corte, no un envelope con un objeto adentro", () => {
    const a = almacenFalso();
    // Se escribe el disco a mano: `guardarViaje` acepta el tipo, pero el disco lo escribe cualquiera
    // que pueda ejecutar en este origen, y `leerViaje` NO valida los resultados (su docblock lo dice).
    a.escribir(
      CLAVE_VIAJE,
      JSON.stringify({
        ...viajeConectado({ transaccionFirmada: txFirmadaB58() }),
        firmaDePatrocinio: { no: "soy un string" },
      }),
    );
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_TX_ALTERADA });
  });

  // 🔴 AR-it2/MNR-3 — LA RAMA QUE SEGUÍA SIN TEST Y SE ALCANZA CON UN FIXTURE: lo que volvió decodifica
  // como transacción y NO trae la entrada del sender, así que no hay firma con la que armar el mensaje de
  // patrocinio (que la lleva adentro). El helper `txFirmadaB58` ya tenía el parámetro `firmante` para
  // esto y sus 20 usos no lo pasaban nunca: ésta es la primera vez.
  // MUTANTE QUE MATA (MNR3, MEDIDO: exit=1, 1 `it` rojo, éste): borrar el
  // `if (firma === null) return cortar(DEEPLINK_TX_ALTERADA)` ⇒ sale un salto de patrocinio armado sobre
  // un mensaje que no tiene ninguna firma adentro.
  it("una tx que decodifica pero SIN la firma del sender ⇒ deeplink_tx_alterada, y no se arma ningún mensaje", () => {
    const a = almacenFalso();
    const otro = Keypair.generate();
    guardarViaje(a, viajeConectado({ transaccionFirmada: txFirmadaB58(otro) }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_TX_ALTERADA });
    expect(mensajesPedidos, "se armó un mensaje de patrocinio sin firma de la transacción").toEqual([]);
  });

  it("una `transaccionFirmada` vacía ⇒ corte (un string vacío no es una transacción)", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ transaccionFirmada: "" }));
    guardarPreparado(a, preparadoBase());
    const r = motor.resolver(pedido(a));
    // ⚠️ Vacío entra por el camino de "falta la tx" (`"" === undefined` es falso, pero `esFirmaUtil` lo
    // rechaza), así que lo que importa es que NO salga un `completo` ni un salto de patrocinio armado
    // sobre la nada.
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_TX_ALTERADA });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CD-11 / T12 — el sender no sale del canal del enlace
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("el viaje sólo puede COINCIDIR con el sender, nunca sustituirlo", () => {
  // MUTANTE QUE MATA (CALIB, RE-CORRIDO en el FP4 sobre dba48f9: exit=1, **41 `it` rojos** en dos archivos —41 también en el FP3; 39 en el FP2 y 35 en el FP1—; es el mutante de
  // calibración de toda la batería, el que tenía que morir, y la fila que la tabla de arriba se había
  // dejado afuera dos revisiones seguidas): invertir la comparación `viaje.direccion !== p.sender`
  // ⇒ un connect forjado se queda con el viaje entero y el depósito se arma con una dirección ajena.
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AR-it3/MNR-4 — un patrocinio SIN transacción es un viaje que ya no puede cerrar
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ SE MIDIÓ ANTES DE ELEGIR, porque el corte no era la única salida y la otra era "declararlo".
// SIN el corte: la invocación 1 manda a firmar la tx, la persona firma, y la 2 devuelve `completo` con
// el patrocinio VIEJO y la tx NUEVA (la 3, lo mismo). `mensajesPedidos` queda en `[]`: el motor no arma
// NUNCA el mensaje de patrocinio de esa tx, así que el viaje no puede conseguir uno que corresponda, y
// tampoco puede pedirlo, porque `pasosConsumidos` ya trae `firmar-patrocinio`.
//
// ⚠️ Y LA PRECONDICIÓN NO ES UN DISCO ESCRITO A MANO: alcanza una billetera que contesta
// `dl=firmar-patrocinio` cuando se le pidió la tx. El paso que volvió lo dice la URL y T8 prohíbe
// decidir por `viaje.paso`, así que ese resultado se persiste igual. El primer `it` de abajo lo arma con
// la billetera falsa, partiendo de un viaje SIN tx y SIN patrocinio, y no toca el disco a mano.
//
// ⚠️ LO QUE EL CORTE CUESTA, y por eso el segundo `it` congela una LIMITACIÓN y no un deseo: el
// patrocinio tiene forma de firma, así que `resultadoPreservable` preserva y el corte se repite hasta
// que la ventana mate el viaje. Se elige igual: la alternativa era gastarle a la persona una firma REAL
// del camino del dinero y POSTear al settle un `popSignature` que no puede corresponder a la tx que va
// en el mismo envelope, esperando que lo pare un guard que vive en OTRO servicio y que este repo no
// puede ver (`[NO VERIFICADO]`).
describe("MNR-4: un patrocinio sin transacción NO manda a firmar nada, corta", () => {
  // MUTANTE QUE MATA (IT3-MNR4, MEDIDO: exit=1, 2 `it` rojos, los dos de acá): borrar el
  //   `if (patrocinio !== undefined && txFirmada === undefined) return cortar(...)` ⇒ el primer `it` ve
  //   un `salto` de `firma-tx` donde esperaba el corte, y el segundo ve un `completo` con el patrocinio
  //   viejo en la invocación 2.
  it("una vuelta de patrocinio sin tx en el disco ⇒ corte, y NO se manda a firmar la transacción", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado()); // ni tx ni patrocinio: el disco no se toca a mano
    const inventada = bs58.encode(nacl.sign.detached(new Uint8Array([7]), SENDER.secretKey));
    // La app la mandó a `firmar-tx`; la billetera vuelve con la marca del paso 3.
    const r = motor.resolver(
      pedido(a, {
        hrefActual: href("firmar-patrocinio", respuestaDeLaBilletera({ signature: inventada })),
      }),
    );
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_VIAJE_VENCIDO });
    expect(
      mensajesPedidos,
      "se armó un mensaje de patrocinio sobre una transacción que no existe",
    ).toEqual([]);
    // El corte va ANTES del paso 8, así que no re-ancla nada: sin esto, un estado que no puede cerrar
    // dejaría además un registro nuevo con su ventana.
    expect(a.datos.has(CLAVE_PREPARADO), "el corte escribió un ancla igual").toBe(false);
  });

  // ⚠️ LIMITACIÓN DECLARADA, NO COMPORTAMIENTO DESEADO (el mismo formato que el `it` de BLQ-BAJO-2): el
  // corte preserva porque el patrocinio tiene forma de firma, así que la única salida es la ventana de
  // 20 min. Si mañana alguien hace que este caso limpie, este `it` se pone rojo y tiene que leer el
  // costo del otro lado —un corte que borra el disco por texto de URL no autenticado es BLQ-ALTO-1—.
  it("el corte se REPITE con el disco intacto: la única salida es la ventana (limitación)", () => {
    const a = almacenFalso();
    const patrocinioViejo = bs58.encode(nacl.sign.detached(new Uint8Array([9]), SENDER.secretKey));
    expect(bs58.decode(patrocinioViejo).length, "el fixture no es una firma ed25519").toBe(64);
    guardarViaje(a, viajeConectado({ firmaDePatrocinio: patrocinioViejo }));
    const causas = [1, 2, 3].map(() => {
      const r = motor.resolver(pedido(a));
      return r.tipo === "corte" ? r.causa : r.tipo;
    });
    expect(causas).toEqual([DEEPLINK_VIAJE_VENCIDO, DEEPLINK_VIAJE_VENCIDO, DEEPLINK_VIAJE_VENCIDO]);
    expect(a.datos.has(CLAVE_VIAJE), "el corte borró una firma que la persona dio").toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-075 · ADDENDUM DEL RELOJ — testigos F y G: el motor en un retroceso de reloj
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ MIDE ESTE `describe` Y POR QUÉ NO ALCANZABA CON LOS UNITARIOS DE `sesion.test.ts`. Los de allá
// prueban que `leerViaje` degrada sin borrar. Acá se mide la AMPLIFICACIÓN, que es un defecto del motor
// y no del lector: cuando el guard de futuro borraba el viaje ADENTRO de `leerViaje`, el `cortar` de
// más arriba lo releía y ya no estaba ⇒ `enDisco.tipo !== "hay"` ⇒ `hayAlgoQueSalvar === false` ⇒ el
// motor llamaba ADEMÁS a `terminarPreparado`. O sea que el guard de futuro era la ÚNICA rama del módulo
// que destruía un resultado sin pasar por `resultadoPreservable`, y encima se llevaba puesto el ancla.
// ⛔ Por eso los `expect` son sobre LAS DOS CLAVES: verificar sólo el viaje no ve la amplificación.
//
// ⛔ EL RETROCESO SE EXPRESA CON `ahora` POR PARÁMETRO —`pedido()` fija `ahora: AHORA` y el disco se
// siembra con `desde: AHORA + 1`—, nunca con un reloj real. Un testigo que dependiera de que el reloj
// del runner retroceda quedaría VERDE con el bug adentro en cualquier CI con el reloj disciplinado por
// slew, que es peor que rojo: apaga la revisión.
describe("T-075-RELOJ-F/G: un retroceso de reloj NO destruye, y la causa que sale no miente", () => {
  /** Una firma REAL del sender adentro del viaje: es lo que `resultadoPreservable` exige para preservar. */
  function conFirmaDelSender(over: Partial<Viaje> = {}): Viaje {
    return viajeConectado({ transaccionFirmada: txFirmadaB58(), ...over });
  }

  // MUTANTE QUE MATA (F): volver `hayAlgoQueSalvar` a `enDisco.tipo === "hay" && …` ⇒ el `no-fechable`
  //   deja de contar como algo que salvar, el corte limpia las DOS claves y saltan los dos `expect` del
  //   disco con `expected false to be true`. ⚠️ Ese mutante es LÍNEA-NEUTRO y no lo mata ningún vecino:
  //   con `desde` en el futuro la ventana no se alcanza (la resta es negativa) y el viaje es válido en
  //   todo lo demás, así que ninguna otra rama toca el disco en esta invocación.
  it("T-075-RELOJ-F · con los DOS discos sin fechar, el corte preserva el viaje Y el `Preparado`", () => {
    const a = almacenFalso();
    guardarViaje(a, conFirmaDelSender({ desde: AHORA + 1 }));
    guardarPreparado(a, preparadoBase({ desde: AHORA + 1 }));
    const r = motor.resolver(pedido(a));
    expect(r.tipo).toBe("corte");
    expect(a.datos.has(CLAVE_VIAJE), "el retroceso de reloj borró una transacción firmada").toBe(true);
    expect(a.datos.has(CLAVE_PREPARADO), "el retroceso borró el ancla contra la que esa firma se verifica").toBe(true);
    expect(a.borrados, "una lectura destruyó algo que no entregó").toEqual([]);
  });

  // MUTANTE QUE MATA (G-1): emitir `DEEPLINK_VIAJE_VENCIDO` en el sitio del `leerPreparado` ⇒
  //   `expected "deeplink_viaje_vencido" to be "deeplink_reloj_inconsistente"`.
  // MUTANTE QUE MATA (G-1b): emitir `DEEPLINK_SIN_MEMORIA` ahí ⇒ mismo `expect`, con el otro literal.
  // ⚠️ ESTO PRUEBA QUE LA CAUSA LA EMITE EL MOTOR POR EJECUCIÓN, no que la constante exista: un
  //   mecanismo sin llamador no es una defensa.
  it("T-075-RELOJ-G1 · el `Preparado` sin fechar corta con `deeplink_reloj_inconsistente`", () => {
    const a = almacenFalso();
    guardarViaje(a, conFirmaDelSender({ desde: AHORA + 1 }));
    guardarPreparado(a, preparadoBase({ desde: AHORA + 1 }));
    expect(motor.resolver(pedido(a))).toEqual({ tipo: "corte", causa: DEEPLINK_RELOJ_INCONSISTENTE });
  });

  // MUTANTE QUE MATA (G-2): borrar el primer `if` de `:685`, o cambiarle la causa a
  //   `DEEPLINK_VIAJE_VENCIDO` ⇒ `expected "deeplink_viaje_vencido" to be
  //   "deeplink_reloj_inconsistente"`. ⚠️ ES OTRO SITIO QUE EL DE ARRIBA y por eso es otro `it`: acá el
  //   `Preparado` está perfectamente fechado y quien no se puede fechar es el VIAJE, así que el corte
  //   sale del paso 2 y no del paso 1. Arreglar uno solo dejaría este `it` rojo.
  it("T-075-RELOJ-G2 · el VIAJE sin fechar corta con `deeplink_reloj_inconsistente`, y preserva", () => {
    const a = almacenFalso();
    guardarViaje(a, conFirmaDelSender({ desde: AHORA + 1 }));
    guardarPreparado(a, preparadoBase({ desde: AHORA }));
    expect(motor.resolver(pedido(a))).toEqual({ tipo: "corte", causa: DEEPLINK_RELOJ_INCONSISTENTE });
    expect(a.datos.has(CLAVE_VIAJE)).toBe(true);
    expect(a.datos.has(CLAVE_PREPARADO)).toBe(true);
  });

  // 🔴 EL SITIO `:608` NO TENÍA TESTIGO PROPIO, y `T-075-RELOJ-G1` de acá arriba NO LO CUBRE aunque
  // su comentario diga que sí (AR-fp/BLQ-MED-1). Ese `it` siembra los DOS discos en el futuro, así que con
  // `:608` muerto el corte lo emite igual el vecino de `:685` CON LA MISMA CAUSA y nadie se entera: es un
  // FALSO KILLED, y está medido — `if (false && registro.tipo === "no-fechable")` dejó la suite ENTERA en
  // 162 archivos / 3323 tests VERDE, cero rojos.
  //
  // EL INPUT QUE SÍ LO AÍSLA es un retroceso PARCIAL, y es el único orden alcanzable bajo el invariante
  // (`Preparado.desde`, `./firma-por-enlace.ts:457`): el viaje todavía se puede fechar y el `Preparado` no.
  // Ahí el guard de `:685` no se alcanza y el corte tiene que salir de `:608` o no salir de ningún lado.
  // MUTANTE QUE MATA (X6): neutralizar el `if` de `:608` ⇒ `expected "deeplink_sin_memoria" to be
  //   "deeplink_reloj_inconsistente"`. ⚠️ Y ese desenlace no es "otro código": su copy dice «Este navegador
  //   no puede guardar los datos del envío», que es el copy que el addendum prohibió POR NOMBRE para este
  //   caso porque el disco funciona perfecto — lo que no se puede es FECHAR lo que hay adentro.
  it("T-075-RELOJ-G3 · con el VIAJE fechable y el `Preparado` NO, el corte sale de `:608` y es el del reloj", () => {
    const a = almacenFalso();
    guardarViaje(a, conFirmaDelSender({ desde: AHORA }));
    guardarPreparado(a, preparadoBase({ desde: AHORA + 1 }));
    // ⛔ LA PRECONDICIÓN VA PRIMERO Y EN DURO: si el viaje NO fuera fechable, el corte podría venir de
    // `:685` y este `it` sería una segunda copia de `G2` con otro nombre, verde para siempre.
    expect(leerViaje(a, AHORA).tipo, "el viaje no es fechable: este `it` no está aislando `:608`").toBe("hay");
    expect(motor.resolver(pedido(a))).toEqual({ tipo: "corte", causa: DEEPLINK_RELOJ_INCONSISTENTE });
    expect(a.datos.has(CLAVE_VIAJE), "el retroceso parcial borró una transacción firmada").toBe(true);
    expect(a.datos.has(CLAVE_PREPARADO), "el retroceso parcial borró el ancla contra la que esa firma se verifica").toBe(true);
  });

  // ⛔ CONTROL NEGATIVO, obligatorio: sin esto nada distingue «el motor discrimina el retroceso» de «el
  // motor contesta `deeplink_reloj_inconsistente` a cualquier cosa».
  it("T-075-RELOJ-G-J · CONTROL NEGATIVO: con retroceso CERO el motor NO emite la causa nueva", () => {
    const a = almacenFalso();
    guardarViaje(a, conFirmaDelSender({ desde: AHORA }));
    guardarPreparado(a, preparadoBase({ desde: AHORA }));
    const r = motor.resolver(pedido(a));
    expect(r.tipo === "corte" ? r.causa : null).not.toBe(DEEPLINK_RELOJ_INCONSISTENTE);
  });

  // ⛔ Y EL OTRO CONTROL NEGATIVO, el que separa la causa nueva de la vieja: un viaje VENCIDO —el caso
  // para el que `deeplink_viaje_vencido` sí es honesto— tiene que seguir saliendo por la causa vieja.
  // Si las dos salieran por la nueva, el arreglo habría borrado una distinción en vez de agregarla.
  it("T-075-RELOJ-G-J2 · un viaje VENCIDO sigue siendo `deeplink_viaje_vencido`, no el reloj", () => {
    const a = almacenFalso();
    guardarViaje(a, conFirmaDelSender({ desde: AHORA - 20 * 60 * 1000 - 1 }));
    const r = motor.resolver(pedido(a));
    expect(r).toEqual({ tipo: "corte", causa: DEEPLINK_VIAJE_VENCIDO });
  });
});
