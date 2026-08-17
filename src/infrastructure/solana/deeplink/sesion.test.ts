// OLA 2 · CANDADOS DEL VIAJE QUE SOBREVIVE A LA MUERTE DE LA PÁGINA.
//
// 🔴 QUÉ SE ESTÁ PROTEGIENDO. Cuando se firma por enlace profundo, la pestaña deja de existir. Todo
// lo que estaba en memoria se pierde y lo único que vuelve es el disco más la URL. Estos `it`
// congelan las dos mitades de eso: qué se guarda, y sobre todo **qué se contesta cuando las dos
// fuentes no coinciden**, que es donde se inventan las mentiras.
//
// ⚠️ LO QUE NO VERIFICA: que el navegador de verdad conserve `localStorage` al volver de la app de la
// billetera. Acá el almacén es un objeto de mentira. Que la pestaña nueva sea del mismo origen —y por
// lo tanto vea el mismo disco— es un hecho de la plataforma, y quien lo prueba es un teléfono.
//
// ⚠️ LO QUE TAMPOCO VERIFICA, dicho con las palabras del CR de esta HU: los NOMBRES de los parámetros
// del protocolo (`phantom_encryption_public_key`, el orden de los argumentos del Diffie-Hellman, la
// forma de cada cuerpo) están escritos a mano de los dos lados, acá y en `protocol.ts`. Si la
// documentación de Phantom estuviera mal, o si Phantom cambiara un nombre, todos estos `it` siguen
// verdes. Eso es lo que este archivo NO puede contestar.
//
// LA ELECCIÓN DE FONDO DE ESTE ARCHIVO: casi todos los `it` son de caminos que NO son el feliz. Es a
// propósito. El camino feliz de un redirect es trivial; lo caro es el viaje huérfano, el vencido, el
// que vuelve con las manos vacías, el que ya se leyó y el que contestó otro, que son los que se
// colapsan en "cancelaste" si nadie mira.
import { beforeEach, describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import type { BilleteraDeeplink } from "./protocol";
import {
  type Almacen,
  MARCA,
  MAX_EDAD_MS,
  type Viaje,
  enlaceDeVuelta,
  guardarViaje,
  interpretarVuelta,
  leerViaje,
  terminarViaje,
} from "./sesion";

/** Almacén de mentira: un `Map`. Deja además contar borrados, que es lo que prueba la higiene. */
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
const LAS_DOS: BilleteraDeeplink[] = ["phantom", "solflare"];

// ⛔ ESCRITO A MANO A PROPÓSITO, igual que en `protocol.test.ts`: es el oráculo independiente. Si acá
// se importara `CLAVE_EN_RESPUESTA` de `protocol.ts`, invertir el mapa de producción movería los dos
// lados a la vez y ningún `it` de este archivo lo notaría. NO lo reemplaces por un `import`.
const NOMBRE_DE_LA_CLAVE: Record<BilleteraDeeplink, string> = {
  phantom: "phantom_encryption_public_key",
  solflare: "solflare_encryption_public_key",
};

/** Los 20 minutos de `MAX_EDAD_MS`, escritos como número y no como la constante. Ver T-VJ-2. */
const VEINTE_MINUTOS = 1_200_000;

const CLAVE_EN_DISCO = "chaski.billetera.viaje.v1";

let par: nacl.BoxKeyPair;
/** El par de cifrado de LA BILLETERA. En un viaje real lo conoce la app recién al volver el connect. */
let billeteraReal: nacl.BoxKeyPair;

beforeEach(() => {
  par = nacl.box.keyPair();
  billeteraReal = nacl.box.keyPair();
});

function viajeBase(over: Partial<Viaje> = {}): Viaje {
  return {
    billetera: "phantom",
    secreta: bs58.encode(par.secretKey),
    publica: bs58.encode(par.publicKey),
    paso: "conectar",
    desde: AHORA,
    ...over,
  };
}

/** Un viaje que YA hizo el paso 1: tiene fijada la clave de cifrado de la billetera. */
function viajeConectado(over: Partial<Viaje> = {}): Viaje {
  return viajeBase({
    claveBilletera: bs58.encode(billeteraReal.publicKey),
    session: "s",
    pasosConsumidos: ["conectar"],
    ...over,
  });
}

/**
 * La billetera de mentira: hace lo que dice la documentación.
 *
 * Está parametrizada por billetera (el nombre del parámetro es lo único que las distingue) y por el
 * par de claves, porque fijar QUIÉN contesta es justamente lo que estos `it` miden. Antes hardcodeaba
 * a Phantom, y por eso reemplazar las lecturas de `viaje.billetera` por `"phantom"` sobrevivía a la
 * suite entera.
 *
 * ⚠️ CUÁNTAS SON ESAS LECTURAS: acá decía **tres** y hoy son **CUATRO** (`sesion.ts:613, 646, 661,
 * 668`). La cuarta la agregó el ancla de un fix-pack posterior y el número se quedó viejo solo, sin
 * que nadie tocara esta línea. Y no era una cifra decorativa: la cuarta —la del ancla— era
 * justamente la ÚNICA sin candado, porque el bloque de ataque `T-VJ-6` corría entero con Phantom.
 * Medido en el fix-pack 4, un mutante por lectura (`"phantom"` fijo en cada una):
 *   ANTES del fix-pack:  613 VIVO 96/96 · 646 muere (1 rojo) · 661 muere (2) · 668 muere (1)
 *   DESPUÉS:             613 muere (4)  · 646 muere (2)      · 661 muere (3) · 668 muere (1)
 * Las cuatro lecturas tienen candado y **los cuatro rojos de la 613 son casos `solflare`**, que es
 * exactamente el agujero que faltaba. Los conteos son de una fecha, no una propiedad: si tocás el
 * bloque de abajo, se re-corren.
 */
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

describe("T-VJ-1: guardar, leer y terminar", () => {
  it("lo guardado vuelve igual", () => {
    const a = almacenFalso();
    const v = viajeBase({ session: "s", direccion: "D", remittanceId: "r1" });
    guardarViaje(a, v);
    const l = leerViaje(a, AHORA);
    expect(l.tipo).toBe("hay");
    if (l.tipo !== "hay") return;
    expect(l.viaje).toEqual(v);
  });

  it("terminar deja el disco sin nada, y leer contesta «no-hay»", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    terminarViaje(a);
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
  });

  it("[LÍMITE DECLARADO] un viaje que salió BIEN no lo limpia nadie: limpiar es del que llama", () => {
    // 🔴 ESTE `it` NO ES UN CANDADO: es la documentación ejecutable de una frase que era FALSA. El
    // bloque que justifica guardar una clave privada x25519 en `localStorage` (DT-6) decía "se crea
    // una por viaje y se BORRA al terminar", y el re-AR midió lo contrario (Q-6): tras los tres
    // pasos con la billetera real la `secreta` seguía en el disco y `leerViaje` seguía contestando
    // «hay». `terminarViaje` sólo tiene llamadores dentro de `leerViaje`, en sus ramas de basura y
    // vencimiento; NINGÚN camino de éxito lo llama.
    //
    // 🔴 POR QUÉ EL MÓDULO NO LIMPIA SOLO, que es la parte que hay que entender antes de "arreglarlo":
    //   1. Los resultados y el disco son la MISMA cosa. Borrar al consumir el paso 3 se llevaría
    //      `transaccionFirmada` —la firma del paso 2— y el que llama no la tiene en memoria: la
    //      página se murió en el salto, por eso existe este módulo. Se destruiría un dato del camino
    //      del dinero exactamente en el momento en que hace falta.
    //   2. Este módulo NO SABE cuándo terminó el que llama. El orden de DT-3 no lo verifica nadie
    //      acá (medido: un paso 3 sobre un viaje que nunca firmó el paso 2 sale
    //      `patrocinio-firmado`), y el propio docblock de `otra-clave/sin-fijar` dice que afirmar
    //      ese orden sería inventar. "El tercer paso es el último" es justamente la suposición sobre
    //      el flujo ajeno que el módulo se niega a hacer en todo lo demás.
    // Así que la frase se corrigió en vez de fabricar un borrado que adivina. Lo que queda vivo
    // hasta que la ventana lo venza está medido acá abajo, sin adornos.
    //
    // ⚠️ SI ALGÚN DÍA SE AGREGA EL BORRADO AUTOMÁTICO, ESTE `it` SE PONE ROJO. Eso es lo que tiene
    // que pasar: es la señal de que la frase del docblock de `secreta` hay que cambiarla con él, que
    // es la divergencia que este `it` existe para impedir. Verificado en el fix-pack 3 con un
    // mutante que llama a `terminarViaje` tras consumir el paso 3: el `it` lo MATA. Y con él se
    // ponen rojos otros DOS que ya existían ("la lista de consumidos ACUMULA los tres pasos" y
    // "procesar el paso 3 NO borra del disco el resultado del paso 2"), o sea que la suite ya
    // exigía en dos lugares que el paso 3 NO limpie: agregar el borrado no era corregir una
    // omisión, era rehacer lo que otros dos `it` protegen. Lo que faltaba era decirlo arriba.
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const conectar = respuestaDeLaBilletera({ public_key: "C", session: "S" }, par.publicKey);
    expect(
      interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar", ...conectar }), AHORA, null).tipo,
    ).toBe("conectado");
    const firmar = respuestaDeLaBilletera({ transaction: "TX" }, par.publicKey);
    expect(
      interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...firmar }), AHORA, null).tipo,
    ).toBe("tx-firmada");
    const patrocinio = respuestaDeLaBilletera({ signature: "F" }, par.publicKey);
    expect(
      interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-patrocinio", ...patrocinio }), AHORA, null)
        .tipo,
    ).toBe("patrocinio-firmado");

    // Los tres pasos salieron bien y NADIE borró nada.
    expect(a.borrados).toBe(0);
    const l = leerViaje(a, AHORA);
    expect(l.tipo).toBe("hay");
    if (l.tipo !== "hay") return;
    // La clave PRIVADA, entera, sigue ahí. Es el dato que la frase corregida promete que sobrevive.
    expect(l.viaje.secreta).toBe(bs58.encode(par.secretKey));
    expect(l.viaje.claveBilletera).toBe(bs58.encode(billeteraReal.publicKey));
    expect(l.viaje.pasosConsumidos).toEqual(["conectar", "firmar-tx", "firmar-patrocinio"]);

    // Y la otra mitad, que es la que hace honesta a la frase nueva: el que llama TIENE con qué
    // limpiar. Pasarle el trabajo a alguien que no puede hacerlo sería la misma mentira de vuelta.
    terminarViaje(a);
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
  });
});

describe("T-VJ-2: los TRES desenlaces de leer, y que «vencido» no se disfrace de «no-hay»", () => {
  it("la ventana son 20 minutos, dichos en número y no con la propia constante", () => {
    // 🔴 ESTE `it` EXISTE POR UN MUTANTE QUE SOBREVIVÍA: cambiar `MAX_EDAD_MS` de 20 minutos a 20
    // HORAS dejaba los 38 tests en verde, porque todos escribían `AHORA + MAX_EDAD_MS + 1`, o sea
    // comparaban la constante consigo misma. Un guardián que recalcula la fórmula que vigila aplaude
    // cualquier cosa. Acá y en los dos `it` de abajo el número está escrito a mano.
    // MUTANTE QUE MATA: cualquier cambio del valor de `MAX_EDAD_MS`.
    expect(MAX_EDAD_MS).toBe(VEINTE_MINUTOS);
  });

  it("«vencido» pasado el máximo, y NO «no-hay»", () => {
    // 🔴 La diferencia importa para la persona: "no hay" es silencio, "venció" es que firmó al pedo
    // y hay que decírselo. MUTANTE QUE MATA: devolver `no-hay` en la rama de la edad.
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    expect(leerViaje(a, AHORA + VEINTE_MINUTOS + 1).tipo).toBe("vencido");
  });

  it("justo en el límite todavía vale: el corte es estrictamente mayor", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    expect(leerViaje(a, AHORA + VEINTE_MINUTOS).tipo).toBe("hay");
  });

  it("un viaje vencido se LIMPIA al leerlo, no queda dando vueltas", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    leerViaje(a, AHORA + VEINTE_MINUTOS + 1);
    expect(a.borrados).toBe(1);
    expect(leerViaje(a, AHORA + VEINTE_MINUTOS + 2).tipo).toBe("no-hay");
  });

  it("JSON roto es «no-hay», NO «vencido»: no se puede afirmar que existió algo", () => {
    const a = almacenFalso();
    a.escribir(CLAVE_EN_DISCO, "{esto no es json");
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
  });

  it("y el JSON roto además se LIMPIA, que es la mitad que nadie miraba", () => {
    // El docblock de esa rama promete dos cosas ("se limpia y se contesta no hay") y sólo la segunda
    // tenía candado: sacar el `a.borrar(CLAVE)` sobrevivía a la suite. Sin la limpieza, la basura se
    // vuelve a parsear en cada carga de la página.
    // MUTANTE QUE MATA: borrar el `a.borrar(CLAVE)` de la rama de JSON roto.
    const a = almacenFalso();
    a.escribir(CLAVE_EN_DISCO, "{esto no es json");
    leerViaje(a, AHORA);
    expect(a.borrados).toBe(1);
    expect(a.datos.has(CLAVE_EN_DISCO)).toBe(false);
  });

  it("un viaje SIN clave secreta no sirve aunque esté fresco, y se limpia", () => {
    // Sin `secreta` no se abre ningún sobre, así que retomarlo sería ofrecer continuar algo que no
    // puede terminar. Se limpia y se contesta «no-hay».
    const a = almacenFalso();
    a.escribir(CLAVE_EN_DISCO, JSON.stringify({ ...viajeBase(), secreta: undefined }));
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
    expect(a.borrados).toBe(1);
  });

  it("un viaje SIN `desde` tampoco: si no, no vencería NUNCA", () => {
    // 🔴 Quitar la mitad `desde` de esa validación sobrevivía a la suite entera, y la consecuencia
    // es silenciosa: `ahora - undefined` es `NaN`, `NaN > MAX_EDAD_MS` es `false`, así que ese viaje
    // nunca vence y la ventana de 20 minutos queda anulada sin que ningún test se ponga rojo.
    // MUTANTE QUE MATA: sacar la validación de `desde` de la forma mínima.
    const a = almacenFalso();
    a.escribir(CLAVE_EN_DISCO, JSON.stringify({ ...viajeBase(), desde: undefined }));
    expect(leerViaje(a, AHORA + VEINTE_MINUTOS * 100).tipo).toBe("no-hay");
  });

  it("un `desde` que no es finito no compra un viaje eterno", () => {
    // 🔴 `JSON.parse('{"desde":1e999}')` produce `Infinity`, y `typeof Infinity === "number"`, así
    // que pasaba la validación de forma. `ahora - Infinity > MAX_EDAD_MS` es `false` para siempre:
    // medido, el viaje contestaba «hay» diez años después. Un `desde` en el futuro (reloj del
    // teléfono movido) lo trata el `it` del `desde` en el futuro, más abajo.
    //
    // ⚠️ ESTE `it` NO PINCHA `Number.isFinite`, Y ANTES DECÍA QUE SÍ. Acá decía «MUTANTE QUE MATA:
    // volver `Number.isFinite(v?.desde)` a `typeof v?.desde !== "number"`», y el re-AR aplicó
    // exactamente ese mutante (M13) y midió los 92 tests en verde. La causa es el mismo fix-pack que
    // escribió la frase: el guard `v.desde > ahora` SUBSUME este caso, porque `Infinity > ahora` es
    // `true` y el viaje muere ahí aunque `Number.isFinite` no exista. Un «MUTANTE QUE MATA» falso es
    // peor que no tener el comentario: promete una cobertura que no existe, y quien borre la
    // validación confiando en este `it` no ve nada rojo.
    // QUÉ MATA ESTE `it`, dicho de verdad: dejar `desde` sin mirar en las DOS validaciones a la vez.
    // Quien pincha `Number.isFinite` por sí solo es el `it` de abajo, el de `-1e999`.
    //
    // ⚠️ El `desde` se escribe A MANO en el JSON y no con `JSON.stringify`, porque
    // `JSON.stringify(Infinity)` produce `null` y el viaje moriría por la otra mitad de la
    // validación: el test pasaría sin haber ejercitado nunca esta rama. Los dos `expect` del
    // instrumento están para que eso no vuelva a pasar en silencio si alguien toca el fixture.
    const a = almacenFalso();
    const crudo = JSON.stringify(viajeBase()).replace(`"desde":${AHORA}`, '"desde":1e999');
    expect(crudo).toContain("1e999");
    expect(JSON.parse(crudo).desde).toBe(Number.POSITIVE_INFINITY);
    a.escribir(CLAVE_EN_DISCO, crudo);
    expect(leerViaje(a, AHORA + VEINTE_MINUTOS * 100_000).tipo).toBe("no-hay");
  });

  it("un `desde` no finito NEGATIVO es basura, y basura NO es «vencido»", () => {
    // 🔴 ÉSTE ES EL QUE PINCHA `Number.isFinite` SOLO, y existe porque el `it` de arriba prometía
    // hacerlo y no lo hacía (M13 del re-AR, VIVO). `-1e999` es `-Infinity`, que NO cae en el guard
    // de futuro —`-Infinity > ahora` es `false`—, así que es el único valor que llega a depender de
    // la validación de finitud. Si ésta se debilita a `typeof === "number"`, el viaje pasa la forma
    // y sale por la rama de la EDAD, porque `ahora - (-Infinity)` es `Infinity`.
    //
    // Y ahí está el delta que importa, que no es cosmético: «vencido» es una afirmación sobre la
    // persona —"hubo un viaje tuyo y se te pasó el tiempo", o sea que firmó al pedo— y de un `desde`
    // que no es un instante no se puede afirmar que existiera ningún viaje. Es exactamente el
    // criterio ya escrito para el JSON roto: se limpia y se contesta «no-hay», porque decir
    // «venció» sería afirmar que existió algo que no sabemos si existió.
    //
    // ⚠️ EL DISCO NO DISCRIMINA ACÁ: las dos ramas limpian, así que un `expect` sobre `borrados`
    // pasaría con mutante y sin mutante. Lo único que separa las dos versiones del código es CUÁL de
    // los dos desenlaces sale, y por eso el `expect` es sobre `tipo`.
    // MUTANTE QUE MATA: volver `Number.isFinite(v?.desde)` a `typeof v?.desde !== "number"`.
    // Medido en el fix-pack 3: sin mutante `no-hay`, con mutante `vencido`.
    const a = almacenFalso();
    const crudo = JSON.stringify(viajeBase()).replace(`"desde":${AHORA}`, '"desde":-1e999');
    // Los dos `expect` del instrumento, por la misma razón que en el `it` de arriba: si el fixture
    // dejara de producir un `-Infinity`, este test pasaría sin haber ejercitado nunca la rama.
    expect(crudo).toContain("-1e999");
    expect(JSON.parse(crudo).desde).toBe(Number.NEGATIVE_INFINITY);
    a.escribir(CLAVE_EN_DISCO, crudo);
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
  });

  it("una `secreta` que no decodifica es «no-hay» y se limpia: NO revienta", () => {
    // 🔴 ESTE ERA UN CRASH MEDIDO. `typeof v.secreta === "string"` daba el viaje por bueno y
    // `bs58.decode` reventaba una capa más arriba, FUERA de todo `try`, con `Non-base58 character`.
    // Y como esa rama no limpiaba nada, la excepción se repetía en CADA carga de la página: la
    // persona no tenía cómo salir salvo esperar 20 minutos o limpiar el navegador. Contradecía el
    // contrato escrito del módulo: una respuesta que no se puede abrir es un desenlace, no un error
    // de programación.
    // MUTANTE QUE MATA: sacar la validación `decodificarSecreta` de `leerViaje`.
    const a = almacenFalso();
    a.escribir(CLAVE_EN_DISCO, JSON.stringify(viajeBase({ secreta: "!!!no-base58!!!" })));
    expect(() => leerViaje(a, AHORA)).not.toThrow();
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
    expect(a.datos.has(CLAVE_EN_DISCO)).toBe(false);
  });

  it("una `secreta` base58 válida pero del largo equivocado tampoco sirve", () => {
    // Una x25519 son 32 bytes. Con cualquier otro largo no se abre ningún sobre nunca, así que el
    // viaje es inservible igual que sin `secreta` — y decirle «rechazo» a la persona sería culpar a
    // la billetera de algo que está roto de este lado.
    const a = almacenFalso();
    a.escribir(CLAVE_EN_DISCO, JSON.stringify(viajeBase({ secreta: "abc" })));
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
  });

  it("y `interpretarVuelta` tampoco revienta con esa basura, porque lee el disco por su cuenta", () => {
    // Antes esto había que probarlo armando una `LecturaDelViaje` a mano, porque `interpretarVuelta`
    // recibía el snapshot de quien la llamara y había que suponer un llamador que le pasara algo que
    // `leerViaje` nunca produce. Ahora lee ella, así que este camino se ejercita como se da de
    // verdad: basura en el disco, la función se la come sola. La rama defensiva que existía adentro
    // (`secreta === null` → limpiar + huerfana) se BORRÓ en vez de dejarla sin test: era código al
    // que ya no llega nadie, y el re-AR la tenía marcada como mutante vivo (M7) justo por eso.
    // MUTANTE QUE MATA: sacar la validación `decodificarSecreta` de `leerViaje`.
    //
    // ⚠️ PERO NO POR EL MOTIVO QUE ACÁ DECÍA, Y ESO CAMBIA QUÉ ASERTO HAY QUE CUIDAR. Decía «sin
    // ella, `interpretarVuelta` no tendría bytes que usar y el `bs58.decode` volvería a reventar»:
    // desde el fix-pack 2 `interpretarVuelta` **no llama a `bs58` en ninguna línea** —quien decodifica
    // es `leerViaje`, adentro de un `try`— así que el `not.toThrow()` de abajo ya no puede fallar por
    // esa causa y no es lo que mata al mutante. Medido en el fix-pack 4: con el mutante puesto, este
    // `it` muere en el **aserto del disco** (el viaje basura sobrevive a la lectura y no se limpia),
    // y la última línea también sale `huerfana` igual que sin mutante. El `not.toThrow()` se conserva
    // como control de regresión de la clase de falla, no como el candado de esta línea.
    const a = almacenFalso();
    a.escribir(CLAVE_EN_DISCO, JSON.stringify(viajeBase({ secreta: "!!!no-base58!!!" })));
    expect(() =>
      interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar" }), AHORA, null),
    ).not.toThrow();
    // 🔴 ÉSTE es el aserto que mata al mutante. No lo muevas ni lo aflojes sin re-correrlo.
    expect(a.datos.has(CLAVE_EN_DISCO)).toBe(false);
    expect(
      interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar" }), AHORA, null).tipo,
    ).toBe("huerfana");
  });

  it("un `pasosConsumidos` que no es una lista es basura: «no-hay», se LIMPIA y no revienta", () => {
    // 🔴 MISMA FIRMA DE FALLA QUE LA `secreta` NO-BASE58, con el campo que agregó el fix-pack
    // anterior. Medido en el re-AR con `pasosConsumidos: 7`:
    //   `THROW: viaje.pasosConsumidos?.includes is not a function | sigue en disco: true`
    // Excepción no capturada MÁS disco sucio, o sea que se repetía en CADA carga de la página hasta
    // que venciera la ventana. El arreglo de la iteración 1 había cerrado la instancia (`secreta`) y
    // no la clase: todo campo del disco que se USE como estructura hay que validarlo como estructura.
    // MUTANTE QUE MATA: sacar la validación de `pasosConsumidos` de `leerViaje`.
    const a = almacenFalso();
    a.escribir(CLAVE_EN_DISCO, JSON.stringify({ ...viajeBase(), pasosConsumidos: 7 }));
    expect(() =>
      interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar" }), AHORA, null),
    ).not.toThrow();
    expect(a.datos.has(CLAVE_EN_DISCO)).toBe(false);
  });

  it("un `pasosConsumidos` que es un STRING no consume pasos por subcadena", () => {
    // 🔴 El otro lado del mismo agujero, y es peor que el crash porque es silencioso: `.includes` en
    // un string busca SUBCADENAS. Medido: con `pasosConsumidos: "firmar-tx-y-mas"` la respuesta
    // buena del paso 2 salía `{"tipo":"ya-consumida","paso":"firmar-tx"}` — un campo basura
    // quemando un paso que nadie consumió, con la firma de la persona en la mano.
    //
    // ⚠️ ACÁ HABÍA UN «MUTANTE QUE MATA» QUE NACIÓ FALSO, y su premisa de JavaScript era incorrecta.
    // Decía: «validar `pasosConsumidos` con `typeof === "object"` en vez de `Array.isArray` (un
    // string sigue entrando)». No entra: `typeof "firmar-tx-y-mas"` es `"string"`, no `"object"`.
    // Medido en el fix-pack 4 aplicando ese mutante literal
    // (`typeof x === "object" && (x as PasoDelViaje[]).every(esPaso)`): **VIVO, 96/96**, y es
    // equivalente al código de hoy para todo lo que este archivo prueba. O sea que el comentario
    // prometía una cobertura que nunca existió — y el `it` pasaba igual porque su ÚNICA aserción era
    // negativa (`not.toBe("ya-consumida")`), que la satisface cualquier desenlace, incluido uno roto.
    //
    // ⚠️ Y LA CAUSA ES DISTINTA DE LA DEL OTRO «MUTANTE QUE MATA» FALSO DE ESTE ARCHIVO (el del
    // `desde` infinito): aquél era verdadero cuando se escribió y se pudrió cuando un fix-pack
    // posterior agregó un guard que lo subsumía. Éste **nació falso**: nunca fue cierto, y ninguna
    // regla del tipo "re-correr los mutantes de lo que solapa" lo habría cazado, porque no hubo
    // ningún cambio posterior. Lo único que lo caza es CORRER el mutante que se declara.
    //
    // MUTANTE QUE MATA (medido, y este `it` es el ÚNICO que se pone rojo con él): hacer que
    // `esListaDePasos` acepte también un `string` —
    // `return Array.isArray(x) ? x.every(esPaso) : typeof x === "string";`—, que es la forma en que
    // un campo del disco vuelve a llegar con vida al `.includes`. Sin mutante sale `huerfana` (el
    // disco es basura y se limpia); con mutante, `ya-consumida`.
    const a = almacenFalso();
    a.escribir(
      CLAVE_EN_DISCO,
      JSON.stringify({ ...viajeConectado({ paso: "firmar-tx" }), pasosConsumidos: "firmar-tx-y-mas" }),
    );
    const r = respuestaDeLaBilletera({ transaction: "TxBuena" }, par.publicKey);
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...r }), AHORA, null);
    // 🔴 LA ASERCIÓN ES POSITIVA Y NO `not.toBe(...)`: un `it` cuya única exigencia es "no salió ESTE
    // valor" no discrimina entre el código bueno y nueve formas de romperlo. Lo que tiene que pasar
    // está dicho entero: el viaje es basura, se limpia, y la vuelta sale huérfana POR NO HABER VIAJE
    // (no por manos vacías: la URL sí traía una respuesta buena).
    expect(v).toEqual({ tipo: "huerfana", paso: "firmar-tx", motivo: "sin-viaje" });
    expect(a.datos.has(CLAVE_EN_DISCO)).toBe(false);
  });

  it("una lista con un nombre de paso inventado tampoco pasa", () => {
    // `["conectar","borrar-todo"]` es tan basura como `7`: el tipo declara TRES nombres y cualquier
    // otro sólo puede venir de algo que no escribió este módulo.
    const a = almacenFalso();
    a.escribir(
      CLAVE_EN_DISCO,
      JSON.stringify({ ...viajeBase(), pasosConsumidos: ["conectar", "borrar-todo"] }),
    );
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
    expect(a.datos.has(CLAVE_EN_DISCO)).toBe(false);
  });

  it("un viaje que empezó en el FUTURO es basura, no un viaje eterno", () => {
    // 🔴 `ahora - desde` es NEGATIVO, así que nunca supera `MAX_EDAD_MS`. Medido en el re-AR: con
    // `desde` adelantado 10 días el viaje contestaba «hay» diez días después, y con él seguían vivas
    // `secreta`, `claveBilletera` y la ventana en la que el paso 1 se puede forjar.
    //
    // El fix-pack anterior no lo cerró con el argumento de que "la ventana no es un control de
    // seguridad" (DT-7). Ese argumento dejó de ser cierto en cuanto el paso 1 quedó declarado como
    // residual: hoy la ventana es la ÚNICA contención que le queda en esta capa, así que su duración
    // no la puede elegir quien mueva el reloj del teléfono.
    // MUTANTE QUE MATA: sacar la rama `v.desde > ahora` de `leerViaje`.
    const a = almacenFalso();
    const DIEZ_DIAS = 10 * 24 * 60 * 60 * 1000;
    guardarViaje(a, viajeBase({ desde: AHORA + DIEZ_DIAS }));
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
    expect(a.datos.has(CLAVE_EN_DISCO)).toBe(false);
  });

  it("pero el instante exacto todavía vale: el corte es estrictamente mayor", () => {
    // El control del `it` de arriba. Un guard que matara `desde === ahora` mataría todo viaje que se
    // lea en el mismo milisegundo en que se escribió, que es el caso normal de la primera lectura.
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ desde: AHORA }));
    expect(leerViaje(a, AHORA).tipo).toBe("hay");
  });

  it("y UN MILISEGUNDO adelantado ya es basura: ese borde no tiene tolerancia de reloj", () => {
    // 🔴 EL BORDE DE ESE GUARD NO LO PINCHABA NADIE, y son los dos `it` de arriba los que lo dejan
    // sin pinchar: uno usa `desde` +10 días y el otro exactamente `ahora`, así que todo el intervalo
    // `(ahora, ahora + 20 min]` quedaba libre. Medido en el re-AR: meter una tolerancia de reloj de
    // 20 minutos (`v.desde > ahora + MAX_EDAD_MS`) dejaba los 92 tests en verde (M37), y en el
    // fix-pack 3 se midió que ni siquiera hace falta tanto — `+ 1` también sobrevivía (M37b).
    //
    // Por qué el borde de ESTE guard y no de cualquier otro: con esa tolerancia un viaje vive 40
    // minutos en vez de 20, y la ventana es —por el docblock del propio guard— la ÚNICA contención
    // que le queda en esta capa al residual del paso 1. Un límite que se puede aflojar sin que nada
    // se ponga rojo convierte ese argumento en una frase. La tolerancia además la elegiría quien
    // mueva el reloj del teléfono, que es justo de quien la ventana no tiene que depender.
    // MUTANTE QUE MATA: cualquier `v.desde > ahora + N` con `N > 0`. Medido: +1 ms da `no-hay` hoy,
    // y `hay` con la tolerancia puesta.
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ desde: AHORA + 1 }));
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
    expect(a.datos.has(CLAVE_EN_DISCO)).toBe(false);
  });

  it("un almacén que ni siquiera deja LEER contesta «no-hay», no revienta", () => {
    // Cookies bloqueadas o modo privado: `localStorage` puede tirar hasta en la lectura. Eso no es
    // un viaje vencido, es que este dispositivo no puede recordar nada.
    // MUTANTE QUE MATA: sacar el `try` de alrededor de `a.leer(CLAVE)`.
    const a: Almacen = {
      leer: () => {
        throw new Error("SecurityError");
      },
      escribir: () => undefined,
      borrar: () => undefined,
    };
    expect(() => leerViaje(a, AHORA)).not.toThrow();
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
  });
});

describe("T-VJ-3: el enlace de vuelta", () => {
  it("le agrega la marca al origen sin romper lo que ya tenía", () => {
    const u = new URL(enlaceDeVuelta("https://chaski-v2.vercel.app/?kyc=return", "firmar-tx"));
    expect(u.searchParams.get(MARCA)).toBe("firmar-tx");
    expect(u.searchParams.get("kyc")).toBe("return"); // no pisa lo que ya estaba
    expect(u.origin).toBe("https://chaski-v2.vercel.app");
  });

  it("LIMPIA la respuesta que el origen ya trajera, para no mandarla de paseo otra vez", () => {
    // 🔴 El origen natural que va a pasarle la ola 3 es `window.location.href`, o sea la URL en la
    // que estamos parados — que después del paso 1 YA CONTIENE una respuesta. Sin la limpieza, el
    // `redirect_link` del paso 2 sale con el `nonce`, el `data` y la clave del paso 1 adentro, y si
    // la billetera AGREGA los suyos en vez de reemplazarlos, `URLSearchParams.get` devuelve el
    // primero: el viejo. Que agregue o reemplace es [NO VERIFICADO] y no hace falta saberlo para
    // decidir esto — limpiar es correcto en los dos casos.
    // MUTANTE QUE MATA: sacar el bucle que borra `PARAMS_DE_RESPUESTA`.
    //
    // Los seis nombres van escritos A MANO y no importados: si se importaran, borrar uno de la lista
    // de producción lo borraría también de la expectativa y el mutante sobreviviría.
    const sucio =
      "https://chaski.app/?dl=firmar-tx&nonce=VIEJO&data=VIEJO&errorCode=4001&errorMessage=viejo" +
      "&phantom_encryption_public_key=VIEJA&solflare_encryption_public_key=VIEJA&remesa=R1";
    const u = new URL(enlaceDeVuelta(sucio, "firmar-patrocinio"));
    for (const p of [
      "nonce",
      "data",
      "errorCode",
      "errorMessage",
      "phantom_encryption_public_key",
      "solflare_encryption_public_key",
    ]) {
      expect(u.searchParams.get(p), `quedó ${p} del salto anterior`).toBeNull();
    }
    expect(u.searchParams.get(MARCA)).toBe("firmar-patrocinio");
    expect(u.searchParams.get("remesa")).toBe("R1"); // lo que no es del protocolo sigue viajando
  });
});

describe("T-VJ-4: interpretar la vuelta — los caminos que NO son el feliz", () => {
  it("sin la marca es «no-volvimos»: entrar a la página de frente no es volver de ningún lado", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    expect(interpretarVuelta(a, new URLSearchParams(""), AHORA, null).tipo).toBe(
      "no-volvimos",
    );
  });

  it("una marca inventada tampoco cuenta como vuelta", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "cualquier-cosa" }),
      AHORA,
      null,
    );
    expect(v.tipo).toBe("no-volvimos");
  });

  it("«huerfana» cuando la URL dice que volvimos y en el disco no hay viaje", () => {
    // 🔴 Pasa de verdad: otro dispositivo, incógnito, un enlace compartido, un viaje ya cerrado.
    // Lo único honesto es decir que no sabemos de qué viaje habla. NO es "cancelaste".
    // MUTANTE QUE MATA: contestar `rechazo` cuando no hay viaje.
    const a = almacenFalso();
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx" }), AHORA, null);
    expect(v.tipo).toBe("huerfana");
    if (v.tipo !== "huerfana") return;
    expect(v.paso).toBe("firmar-tx");
    expect(v.motivo).toBe("sin-viaje");
  });

  it("«huerfana» NO colapsa «no hay viaje» con «hay un viaje con una firma adentro»", () => {
    // 🔴 ESTE `it` EXISTE POR UNA TRAMPA MEDIDA, y es la más cara de las que este módulo le deja a la
    // ola 3. Antes del fix-pack 4 `huerfana` era UN solo valor y estos dos estados —que el módulo
    // distingue perfectamente— salían idénticos:
    //     disco VACÍO                            -> { tipo: "huerfana", paso }
    //     disco CON viaje + `transaccionFirmada` -> { tipo: "huerfana", paso }
    // El llamador no tenía con qué separarlos, y el docblock del tipo remataba diciendo que era "lo
    // único honesto que se puede decir" — falso en el segundo caso, donde SÍ hay viaje.
    //
    // 🔴 LA CONSECUENCIA NO ES DE PROLIJIDAD. Un llamador razonable que lea "huérfana" y reaccione con
    // "empezá de nuevo" + `terminarViaje` **borra una transacción que la persona ya firmó**, que es un
    // dato del camino del dinero y que no está en la memoria de nadie: la página se murió en el salto,
    // que es la razón de existir de este módulo. Con `motivo` el llamador tiene la única pregunta que
    // necesita contestar antes de limpiar: ¿hay algo ahí adentro?
    //
    // MUTANTES QUE MATA, los dos sentidos del colapso, MEDIDOS (y con el conteo que salió, no con el
    // que se esperaba: la primera versión de este comentario decía "sólo este `it` se pone rojo" y
    // la corrida dijo otra cosa — el instrumento manda):
    //   · `motivo: "sin-viaje"` también en la rama `ninguno` de `traducir` -> 2 rojos: éste y
    //     «volver CON la marca pero SIN parámetros de respuesta es huerfana, no rechazo».
    //   · `motivo: "manos-vacias"` en la rama `no-hay` de `interpretarVuelta` -> 3 rojos: éste, el de
    //     «huerfana cuando la URL dice que volvimos y en el disco no hay viaje» y el del
    //     `pasosConsumidos` string.
    // Que sean varios no lo debilita: lo que este `it` agrega y ninguno de los otros tiene es medir
    // los DOS estados en la MISMA corrida y comprobar que el disco del segundo tiene la firma dentro.
    const vacio = almacenFalso();
    const sinViaje = interpretarVuelta(
      vacio,
      new URLSearchParams({ [MARCA]: "firmar-patrocinio" }),
      AHORA,
      null,
    );

    // El segundo caso, armado como se da de verdad: el paso 2 firmó y quedó en el disco, y la vuelta
    // del paso 3 llega SIN parámetros de respuesta (la billetera nos devolvió con las manos vacías).
    const conFirma = almacenFalso();
    guardarViaje(conFirma, viajeConectado({ paso: "firmar-tx" }));
    interpretarVuelta(
      conFirma,
      new URLSearchParams({
        [MARCA]: "firmar-tx",
        ...respuestaDeLaBilletera({ transaction: "TX-QUE-LA-PERSONA-FIRMO" }, par.publicKey),
      }),
      AHORA,
      null,
    );
    const manosVacias = interpretarVuelta(
      conFirma,
      new URLSearchParams({ [MARCA]: "firmar-patrocinio" }),
      AHORA,
      null,
    );

    // Los dos son «huerfana» —eso no cambió, `CD-4`: no se colapsó ni se renombró ningún valor— y el
    // llamador PUEDE distinguirlos.
    expect(sinViaje).toEqual({ tipo: "huerfana", paso: "firmar-patrocinio", motivo: "sin-viaje" });
    expect(manosVacias).toEqual({
      tipo: "huerfana",
      paso: "firmar-patrocinio",
      motivo: "manos-vacias",
    });

    // Y lo que estaba en juego: en el segundo caso hay una firma adentro que un `terminarViaje` a
    // ciegas se llevaría puesta. Esto es lo que el `motivo` le está avisando al llamador.
    const l = leerViaje(conFirma, AHORA);
    expect(l.tipo).toBe("hay");
    if (l.tipo !== "hay") return;
    expect(l.viaje.transaccionFirmada).toBe("TX-QUE-LA-PERSONA-FIRMO");
  });

  it("«vencida» cuando había viaje pero ya no vale: la persona firmó al pedo y merece saberlo", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ paso: "firmar-patrocinio" }));
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-patrocinio" }),
      AHORA + VEINTE_MINUTOS + 1,
      null,
    );
    expect(v.tipo).toBe("vencida");
  });

  it("volver CON la marca pero SIN parámetros de respuesta es «huerfana», no «rechazo»", () => {
    // La billetera nos devolvió con las manos vacías. No declaró un rechazo, así que no se lo
    // podemos atribuir; y tampoco es "no volvimos", porque volvimos.
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar" }), AHORA, null);
    // Y el `motivo` dice cuál de las dos huérfanas es: acá el viaje EXISTE en el disco.
    expect(v).toEqual({ tipo: "huerfana", paso: "conectar", motivo: "manos-vacias" });
  });

  it("«rechazo» cuando la billetera lo declara, con su código y su paso", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-tx", errorCode: "4001", errorMessage: "User rejected" }),
      AHORA,
      null,
    );
    expect(v.tipo).toBe("rechazo");
    if (v.tipo !== "rechazo") return;
    expect(v.codigo).toBe("4001");
    expect(v.paso).toBe("firmar-tx");
    expect(v.origen).toBe("billetera");
  });

  it("un `?errorCode=` fabricado a mano NO se hace pasar por un diagnóstico NUESTRO", () => {
    // 🔴 MEDIDO EN EL CR: una URL fabricada con `?errorCode=sobre_ilegible` y un fallo REAL de cripto
    // de este módulo devolvían **exactamente el mismo objeto**. Los dos `codigo` salían del mismo
    // campo `string` y el llamador no tenía con qué separarlos, en un módulo que tiene escrito —dos
    // veces, en `interpretarVuelta` y en `pasosConsumidos`— que el `errorCode` viaja SIN cifrar y lo
    // escribe cualquiera. O sea: el espacio de valores de un tercero podía hacerse pasar por el
    // nuestro, y al revés. La consecuencia para la pantalla es decir "cancelaste" ante un fallo
    // propio de cifrado, o tratar una cancelación real como un bug nuestro.
    //
    // Lo que separa los dos no es renombrar los códigos —el atacante escribe el nombre que quiera—
    // sino el ORIGEN, que es el único hecho observable: uno salió de la URL, el otro lo escribió
    // `leerRespuesta` mirando el sobre.
    // MUTANTE QUE MATA: devolver `origen: "billetera"` fijo (o `"nuestro"` fijo) en `leerRespuesta`.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const fabricado = interpretarVuelta(
      a,
      // El código NUESTRO, escrito a mano en la barra de direcciones. Nadie lo autenticó.
      new URLSearchParams({ [MARCA]: "firmar-tx", errorCode: "sobre_ilegible" }),
      AHORA,
      null,
    );

    // El fallo real: un sobre cifrado por alguien que NO es la billetera del ancla... no sirve, ése
    // sale `otra-clave`. El que llega de verdad a la cripto es un `data` que no abre con la clave del
    // viaje: la MISMA billetera del ancla, con el sobre corrupto.
    const b = almacenFalso();
    guardarViaje(b, viajeConectado({ paso: "firmar-tx" }));
    const bueno = respuestaDeLaBilletera({ transaction: "T" }, par.publicKey);
    const real = interpretarVuelta(
      b,
      new URLSearchParams({ [MARCA]: "firmar-tx", ...bueno, data: bs58.encode(new Uint8Array(48)) }),
      AHORA,
      null,
    );

    // El `codigo` es EL MISMO string en los dos. Eso es lo que hacía indistinguibles a los dos casos.
    expect(fabricado.tipo === "rechazo" && fabricado.codigo).toBe("sobre_ilegible");
    expect(real.tipo === "rechazo" && real.codigo).toBe("sobre_ilegible");
    // Y el `origen` es lo que los separa.
    expect(fabricado.tipo === "rechazo" && fabricado.origen).toBe("billetera");
    expect(real.tipo === "rechazo" && real.origen).toBe("nuestro");
  });

  it("un «rechazo» NO consume el paso: el `errorCode` no viene cifrado y lo escribe cualquiera", () => {
    // 🔴 Si un rechazo consumiera el paso, alcanzaría una URL fabricada a mano con `?errorCode=4001`
    // para QUEMAR el paso antes de que llegue la respuesta buena, y la firma real de la persona
    // volvería como «ya-consumida». Sólo consume lo que vino dentro de un sobre que abrió.
    // MUTANTE QUE MATA: marcar consumido también en la rama de `rechazo`.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-tx", errorCode: "4001" }),
      AHORA,
      null,
    );
    const buena = respuestaDeLaBilletera({ transaction: "TxDeVerdad" }, par.publicKey);
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-tx", ...buena }),
      AHORA,
      null,
    );
    expect(v).toEqual({ tipo: "tx-firmada", transaccionBase58: "TxDeVerdad", persistencia: "guardado" });
  });
});

describe("T-VJ-6: la respuesta tiene que venir de la billetera con la que se conectó", () => {
  // 🔴 POR QUÉ ESTE BLOQUE ENTERO CORRE CON LAS DOS BILLETERAS, y no es simetría decorativa.
  //
  // Hasta el fix-pack 4 los 8 `it` de acá usaban Phantom, porque `viajeBase()` fija
  // `billetera: "phantom"`. Consecuencia medida: el ancla —el único guard de seguridad que este
  // módulo tiene, el que costó tres iteraciones de AR construir— NO tenía candado para Solflare, que
  // es la mitad del alcance de la HU. DOS mutantes independientes sobrevivían **96/96**:
  //   · `clavePublicaEnRespuesta("phantom", params)` fijo en `sesion.ts:613`;
  //   · excluir Solflare del guard (`claveEnLaUrl !== null && viaje.billetera !== "solflare"`).
  // Con cualquiera de los dos, una vuelta FORJADA de los pasos 2 y 3 sobre un viaje Solflare vuelve
  // como `tx-firmada` / `patrocinio-firmado`: el ataque que este bloque existe para impedir, abierto
  // entero para una de las dos billeteras, con la suite en verde.
  //
  // ⚠️ Y ES LA SEGUNDA VEZ QUE SE REPORTA ESTA CLASE. El CR de la iteración 1 ya había dicho "la rama
  // Solflare no la ejercita nadie"; se cerró parametrizando los caminos FELICES (`T-VJ-5`) y en el
  // mismo fix-pack se agregó el ancla sin parametrizar el bloque de ATAQUE. Se cerró la instancia y
  // no la clase. La regla que queda, para el que agregue el próximo guard: un guard que lee
  // `viaje.billetera` no está probado hasta que su `it` corre con las DOS; el camino feliz
  // parametrizado no cubre el camino de ataque, son ramas distintas del mismo `if`.
  //
  // ✅ Y ESTA VEZ SE BARRIÓ LA CLASE ENTERA, NO LA INSTANCIA. Los sitios de los dos archivos donde el
  // comportamiento depende de CUÁL billetera es son OCHO, y se midió un mutante por sitio
  // (`"phantom"` fijo), más los dos mapas invertidos. Los diez mueren:
  //   `sesion.ts:613` ancla (4 rojos, los 4 `solflare`) · `:646` connect (2) · `:661` tx (3) ·
  //   `:668` patrocinio (1) · `protocol.ts` `BASE[...]` en las tres URLs (1 cada una) ·
  //   `clavePublicaEnRespuesta` (12) · mapa `CLAVE_EN_RESPUESTA` invertido (58) · `BASE` invertido (6).
  // Al 2026-08-16 no queda ningún punto donde el par phantom/solflare decida algo sin candado. Es una
  // foto: el barrido es `grep -n "billetera\]\|viaje.billetera" src/infrastructure/solana/deeplink/`.
  it.each(LAS_DOS)(
    "%s · el atacante que SÍ conoce la clave PÚBLICA de la app no puede forjar el paso 2",
    (billetera) => {
      // 🔴 ESTE `it` REEMPLAZA A UNO QUE MODELABA LA HIPÓTESIS EQUIVOCADA. El anterior cifraba hacia
      // OTRA clave pública, o sea contra un atacante que NO conoce la de la app: el caso fácil, y por
      // eso era verde sin decir nada. La clave pública de la app no es un secreto — viaja en la URL
      // saliente hacia phantom.app, queda en el historial del navegador y está en `viaje.publica`, en
      // el disco. Quien la tenga se fabrica su propio par, deriva el MISMO secreto compartido por
      // Diffie-Hellman y cifra lo que quiera. Medido en el AR: así se consiguió
      // `{ tipo: "tx-firmada", transaccionBase58: "TX-QUE-NINGUNA-BILLETERA-FIRMO" }`.
      // Lo que lo cierra es fijar la clave de la billetera en el connect y compararla después.
      // MUTANTES QUE MATA: borrar la comparación contra `viaje.claveBilletera`; usar `"phantom"` fijo
      // en `clavePublicaEnRespuesta` (muere sólo por el caso `solflare`); excluir Solflare del guard.
      const a = almacenFalso();
      guardarViaje(a, viajeConectado({ billetera, paso: "firmar-tx" }));
      const atacante = nacl.box.keyPair(); // sólo necesita `viaje.publica`, que es pública
      const forjada = respuestaDeLaBilletera({ transaction: "TX-QUE-NADIE-FIRMO" }, par.publicKey, {
        billetera,
        quien: atacante,
      });
      const v = interpretarVuelta(
        a,
        new URLSearchParams({ [MARCA]: "firmar-tx", ...forjada }),
        AHORA,
        null,
      );
      expect(v.tipo).toBe("otra-clave");
      if (v.tipo !== "otra-clave") return;
      expect(v.motivo).toBe("no-coincide");
      // Y la transacción forjada no llegó a ningún lado: el disco no la tiene.
      const l = leerViaje(a, AHORA);
      if (l.tipo !== "hay") return;
      expect(l.viaje.transaccionFirmada).toBeUndefined();
    },
  );

  it.each(LAS_DOS)("%s · y tampoco el paso 3, que es el del patrocinio", (billetera) => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ billetera, paso: "firmar-patrocinio" }));
    const forjada = respuestaDeLaBilletera({ signature: "FIRMA-FORJADA" }, par.publicKey, {
      billetera,
      quien: nacl.box.keyPair(),
    });
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-patrocinio", ...forjada }),
      AHORA,
      null,
    );
    expect(v.tipo).toBe("otra-clave");
  });

  it.each(LAS_DOS)(
    "%s · un paso 2 sobre un viaje que nunca conectó dice «sin-fijar», que es otra cosa",
    (billetera) => {
      // No hay contra qué comparar: el viaje nunca completó el paso 1. Decir «no-coincide» sería
      // afirmar que se conoció otra clave, y no se conoció ninguna. Son dos hechos distintos y el
      // que lo lea necesita saber cuál de los dos le pasó.
      const a = almacenFalso();
      guardarViaje(a, viajeBase({ billetera, paso: "firmar-tx" })); // sin `claveBilletera`
      const r = respuestaDeLaBilletera({ transaction: "T" }, par.publicKey, { billetera });
      const v = interpretarVuelta(
        a,
        new URLSearchParams({ [MARCA]: "firmar-tx", ...r }),
        AHORA,
        null,
      );
      expect(v.tipo).toBe("otra-clave");
      if (v.tipo !== "otra-clave") return;
      expect(v.motivo).toBe("sin-fijar");
    },
  );

  it.each(LAS_DOS)(
    "%s · la billetera de verdad sí pasa: el candado no cierra el camino bueno",
    (billetera) => {
      // Un guard que rechaza todo también pasaría los `it` de arriba. Éste es el control, y también
      // con las dos: sin el control por billetera, un mutante que rompiera el guard Y el camino bueno
      // de Solflare a la vez seguiría pareciendo un candado.
      const a = almacenFalso();
      guardarViaje(a, viajeConectado({ billetera, paso: "firmar-tx" }));
      const r = respuestaDeLaBilletera({ transaction: "TxBuena" }, par.publicKey, { billetera });
      const v = interpretarVuelta(
        a,
        new URLSearchParams({ [MARCA]: "firmar-tx", ...r }),
        AHORA,
        null,
      );
      expect(v).toEqual({ tipo: "tx-firmada", transaccionBase58: "TxBuena", persistencia: "guardado" });
    },
  );

  it("[RESIDUAL, NO ARREGLADO] quien gana el paso 1 gana el VIAJE ENTERO y expulsa a la real", () => {
    // 🔴 Esto NO es un candado: es la documentación ejecutable de un agujero que sigue abierto. El
    // connect es el primer contacto y no hay ninguna clave previa contra qué comparar, así que quien
    // conozca la pública de la app puede hacerse pasar por la billetera. Si algún día se cierra,
    // este `it` se pone rojo, que es exactamente lo que tiene que pasar.
    //
    // ⚠️ LA CONSECUENCIA REAL, QUE ESTE COMENTARIO ANTES DECÍA DE MENOS. No es "un paso forjado".
    // Medido en el re-AR, sobre un viaje limpio:
    //   connect forjado            -> {"tipo":"conectado","direccion":"DIR-ATACANTE","session":"s"}
    //   paso 2 firmado por él      -> {"tipo":"tx-firmada","transaccionBase58":"TX-DEL-ATACANTE"}
    //   paso 3 firmado por él      -> {"tipo":"patrocinio-firmado","firma":"FIRMA-ATACANTE"}
    //   paso 2 de la billetera REAL-> {"tipo":"otra-clave","paso":"firmar-tx","motivo":"no-coincide"}
    // Su clave queda fijada como ancla, así que los tres pasos le pertenecen y la billetera de
    // verdad queda EXPULSADA del viaje hasta que venza la ventana.
    //
    // ⛔ Y EL `ya-consumida` NO ES UNA MITIGACIÓN, aunque una versión anterior de este archivo lo
    // presentaba así. Es al revés: es el mecanismo que FIJA al atacante y BLOQUEA al legítimo.
    // Escribirlo como mitigación es prosa que afirma de más y apaga la revisión de quien la lea.
    //
    // ✅ LO ÚNICO QUE SÍ ACOTA ESTO ACÁ, y por eso está en el código: el ancla de UNA SOLA ESCRITURA
    // (ver el `it` de abajo). Sin ella, un connect forjado TARDÍO gana incluso después de que la
    // billetera real haya conectado; con ella, el atacante tiene que llegar ANTES. Eso baja el costo
    // del ataque, no lo cierra. La segunda contención es la ventana de 20 minutos, que ahora sí es
    // una ventana (ver el `it` del `desde` en el futuro).
    //
    // 🔴 EL CORTE TIENE QUE VENIR DE FUERA DEL CANAL DEL DEEPLINK, y la solución que se le ocurre a
    // cualquiera no sirve: un token de un solo uso en el `redirect_link` viaja por la MISMA URL
    // saliente que la clave pública de la app, o sea el mismo historial y los mismos servidores de
    // la billetera. Cualquier secreto que la app mande en el connect se filtra por donde ya se
    // filtra lo demás.
    //
    // 🔴 REQUISITO PARA LA HU 062, dicho acá para que lo lea quien la escriba:
    //   1. `viaje.direccion` NO es la cuenta de la persona: es "la cuenta que alguien afirmó por el
    //      canal del deeplink". Todo lo que se construya con ese valor hereda la forja.
    //   2. "Una dirección no puede creerse hasta que una firma la pruebe" NO ALCANZA como requisito
    //      —así estaba escrito y es insuficiente—: el que forjó el connect también produce la firma
    //      del paso 3, y verifica perfecto contra SU dirección. Una firma prueba control de una
    //      clave; no prueba que esa clave sea la de la persona.
    //   3. El escenario concreto que 062 tiene que descartar explícitamente es la **sustitución de
    //      depositante**: el `remittanceId` de la víctima atado a un escrow cuyo depositante (y por
    //      lo tanto cuyo destinatario de reembolso) es el atacante.
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const forjada = respuestaDeLaBilletera(
      { public_key: "DIRECCION-DEL-ATACANTE", session: "s" },
      par.publicKey,
      { quien: nacl.box.keyPair() },
    );
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "conectar", ...forjada }),
      AHORA,
      null,
    );
    expect(v).toEqual({
      tipo: "conectado",
      direccion: "DIRECCION-DEL-ATACANTE",
      session: "s",
      persistencia: "guardado",
    });
  });

  it.each(LAS_DOS)(
    "%s · el ancla es de UNA SOLA ESCRITURA: un connect posterior con otra clave no la pisa",
    (billetera) => {
      // 🔴 ESTO ES LO QUE ACOTA EL RESIDUAL DE ARRIBA. Medido en el re-AR: con el ancla pisable, un
      // connect forjado que llegaba DESPUÉS del connect real reemplazaba `claveBilletera` y
      // `direccion`, y a partir de ahí los pasos 2 y 3 volvían a ser falsificables con sólo la clave
      // pública de la app — el candado de la iteración 1 se deshacía entero. Con el ancla write-once,
      // ganar el paso 1 exige llegar ANTES que la billetera real, no en cualquier momento.
      //
      // El fixture tiene el ancla puesta y `pasosConsumidos` VACÍO a propósito: es la única forma de
      // ejercitar este guard y no el de `ya-consumida`, y es un estado que el tipo permite
      // (`pasosConsumidos` es opcional, así que cualquier `Viaje` que arme la ola 3 puede tener ancla
      // sin marca). Sin este `it`, borrar la comparación del paso 1 sobrevive a la suite.
      // MUTANTE QUE MATA: volver el guard a `paso !== "conectar" && ...` (o sea, no comparar el ancla
      // en el paso 1). Y con Solflare mata además los dos mutantes de la cabecera de este bloque: con
      // `"phantom"` fijo, `claveEnLaUrl` sale `null`, el guard no corre Y el `consumir` de abajo
      // escribe `claveBilletera: undefined` — o sea que el ancla no sólo no se compara, se BORRA.
      const a = almacenFalso();
      guardarViaje(a, viajeConectado({ billetera, pasosConsumidos: [] }));
      const forjada = respuestaDeLaBilletera({ public_key: "DIR-ATACANTE", session: "s2" }, par.publicKey, {
        billetera,
        quien: nacl.box.keyPair(),
      });
      const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar", ...forjada }), AHORA, null);
      expect(v.tipo).toBe("otra-clave");
      if (v.tipo !== "otra-clave") return;
      expect(v.motivo).toBe("no-coincide");

      // Y el disco quedó intacto: ni la clave ni la sesión se movieron.
      const l = leerViaje(a, AHORA);
      expect(l.tipo).toBe("hay");
      if (l.tipo !== "hay") return;
      expect(l.viaje.claveBilletera).toBe(bs58.encode(billeteraReal.publicKey));
      expect(l.viaje.direccion).toBeUndefined();
      expect(l.viaje.session).toBe("s");
    },
  );

  it.each(LAS_DOS)(
    "%s · pero la MISMA billetera sí puede volver a conectar sobre su propia ancla",
    (billetera) => {
      // El control del `it` de arriba: un guard que rechazara todo connect con ancla puesta también
      // pasaría ese test, y dejaría el paso 1 imposible de repetir para la billetera legítima.
      const a = almacenFalso();
      guardarViaje(a, viajeConectado({ billetera, pasosConsumidos: [] }));
      const r = respuestaDeLaBilletera({ public_key: "LaCuenta", session: "s2" }, par.publicKey, {
        billetera,
      });
      const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar", ...r }), AHORA, null);
      expect(v).toEqual({
        tipo: "conectado",
        direccion: "LaCuenta",
        session: "s2",
        persistencia: "guardado",
      });
    },
  );
});

describe("T-VJ-7: la misma URL no se aplica dos veces", () => {
  it("la segunda lectura de la misma respuesta es «ya-consumida», no otro «tx-firmada»", () => {
    // 🔴 La URL sobrevive: botón atrás, recarga, historial, enlace pegado en un chat. Medido antes
    // del arreglo: tres lecturas de la misma URL daban tres `tx-firmada` idénticas, y la tercera con
    // el viaje YA avanzado y el resultado YA guardado. Quien consume esto no tenía cómo distinguir
    // "la persona acaba de firmar" de "esta URL ya se procesó" — en el camino del dinero.
    // MUTANTE QUE MATA: no mirar `viaje.pasosConsumidos` en `interpretarVuelta`.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const r = respuestaDeLaBilletera({ transaction: "TxFirmada58" }, par.publicKey);
    const url = new URLSearchParams({ [MARCA]: "firmar-tx", ...r });

    expect(interpretarVuelta(a, url, AHORA, null)).toEqual({
      tipo: "tx-firmada",
      transaccionBase58: "TxFirmada58",
      persistencia: "guardado",
    });
    const segunda = interpretarVuelta(a, url, AHORA + 60_000, null);
    expect(segunda.tipo).toBe("ya-consumida");
    if (segunda.tipo !== "ya-consumida") return;
    expect(segunda.paso).toBe("firmar-tx");
  });

  it("«ya-consumida» NO es «rechazo» ni «huerfana»: nadie canceló y el viaje está ahí", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const r = respuestaDeLaBilletera({ transaction: "T" }, par.publicKey);
    const url = new URLSearchParams({ [MARCA]: "firmar-tx", ...r });
    interpretarVuelta(a, url, AHORA, null);
    const v = interpretarVuelta(a, url, AHORA, null);
    expect(v.tipo).not.toBe("rechazo");
    expect(v.tipo).not.toBe("huerfana");
  });

  it("el resultado del paso queda escrito en el disco, no sólo devuelto", () => {
    // Es lo que hace posible reanudar sin volver a pedir una firma, y es la mitad que faltaba: el
    // estado que hace falta para no repetir vive acá adentro, así que resolverlo acá no es opcional.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const r = respuestaDeLaBilletera({ transaction: "TxGuardada" }, par.publicKey);
    interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...r }), AHORA, null);
    const l = leerViaje(a, AHORA);
    expect(l.tipo).toBe("hay");
    if (l.tipo !== "hay") return;
    expect(l.viaje.transaccionFirmada).toBe("TxGuardada");
    expect(l.viaje.pasosConsumidos).toContain("firmar-tx");
  });

  it("consumir un paso no consume los otros dos", () => {
    // Colapsar los tres pasos en una sola marca de "ya usado" rompería el viaje entero después del
    // primer salto.
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const conectar = respuestaDeLaBilletera({ public_key: "C", session: "S" }, par.publicKey);
    interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar", ...conectar }), AHORA, null);
    const firmar = respuestaDeLaBilletera({ transaction: "T" }, par.publicKey);
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-tx", ...firmar }),
      AHORA,
      null,
    );
    expect(v).toEqual({ tipo: "tx-firmada", transaccionBase58: "T", persistencia: "guardado" });
  });

  it("el paso 1 también se consume: el segundo connect es «ya-consumida»", () => {
    // 🔴 MUTANTE VIVO DEL RE-AR (M16). Los cinco `it` de este bloque consumían `firmar-tx`, y el
    // único que tocaba `conectar` verificaba lo contrario (que consumir uno no consuma los otros).
    // Resultado: hacer que `ya-consumida` NO aplicara al paso `conectar` dejaba los 71 tests en
    // verde. Justo el paso 1, que es el que tiene el residual declarado.
    // MUTANTE QUE MATA: excluir `conectar` de la comprobación de `pasosConsumidos`.
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const r = respuestaDeLaBilletera({ public_key: "LaCuenta", session: "LaSesion" }, par.publicKey);
    const url = new URLSearchParams({ [MARCA]: "conectar", ...r });
    expect(interpretarVuelta(a, url, AHORA, null).tipo).toBe("conectado");
    const segunda = interpretarVuelta(a, url, AHORA, null);
    expect(segunda.tipo).toBe("ya-consumida");
    if (segunda.tipo !== "ya-consumida") return;
    expect(segunda.paso).toBe("conectar");
  });

  it("la lista de consumidos ACUMULA los tres pasos, no se pisa con el último", () => {
    // 🔴 MUTANTE VIVO DEL RE-AR (M5). Reemplazar `[...(viaje.pasosConsumidos ?? []), paso]` por
    // `[paso]` sobrevivía a los 71 tests, y la consecuencia es exactamente el agujero del `it` de
    // arriba: consumir el paso 2 BORRA la marca del paso 1, y un connect forjado vuelve a entrar
    // sobre un viaje que ya había conectado. Ningún test miraba la lista completa después de dos
    // pasos; éste la mira después de los tres.
    // MUTANTE QUE MATA: `pasosConsumidos: [paso]` en `consumir`.
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const conectar = respuestaDeLaBilletera({ public_key: "C", session: "S" }, par.publicKey);
    interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar", ...conectar }), AHORA, null);
    const firmar = respuestaDeLaBilletera({ transaction: "T" }, par.publicKey);
    interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...firmar }), AHORA, null);
    const patrocinio = respuestaDeLaBilletera({ signature: "F" }, par.publicKey);
    interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-patrocinio", ...patrocinio }), AHORA, null);

    const l = leerViaje(a, AHORA);
    expect(l.tipo).toBe("hay");
    if (l.tipo !== "hay") return;
    expect(l.viaje.pasosConsumidos).toEqual(["conectar", "firmar-tx", "firmar-patrocinio"]);
    // Y los tres resultados siguen ahí: avanzar un paso no borra lo que consiguió el anterior.
    expect(l.viaje.direccion).toBe("C");
    expect(l.viaje.transaccionFirmada).toBe("T");
    expect(l.viaje.firmaDePatrocinio).toBe("F");
  });

  it("[DECIDIDO, NO ES UN BUG] una SEGUNDA firma legítima del mismo paso se descarta", () => {
    // La marca de consumo es por NOMBRE de paso, no por pedido, así que un viaje sirve para UN
    // pedido de cada paso. Si la ola 3 vuelve a pedir la misma firma dentro del mismo viaje
    // (cotización refrescada, reintento tras un timeout), la segunda firma —buena, de la billetera
    // real— vuelve como `ya-consumida` y se tira. Este `it` NO celebra eso: lo congela para que sea
    // una decisión visible y no un descubrimiento en producción. Re-pedir una firma exige un viaje
    // NUEVO.
    //
    // Se evaluó discriminar por `nonce` y se descartó con un motivo medible: el `nonce` sólo existe
    // en las respuestas que traen sobre, así que una URL con `errorCode` no tiene ninguno y un paso
    // YA firmado quedaría expuesto a un `?errorCode=` pegado a mano (que hoy sale `ya-consumida`).
    // Se prefiere perder una firma repetida a poder fabricar un «cancelaste» sobre algo ya firmado.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const primera = respuestaDeLaBilletera({ transaction: "TX-1" }, par.publicKey);
    const segunda = respuestaDeLaBilletera({ transaction: "TX-2" }, par.publicKey);
    expect(
      interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...primera }), AHORA, null).tipo,
    ).toBe("tx-firmada");
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...segunda }), AHORA, null);
    expect(v.tipo).toBe("ya-consumida");
    // Y TX-2 no pisó a TX-1 en el disco: lo que quedó guardado es lo primero que se dio por bueno.
    const l = leerViaje(a, AHORA);
    if (l.tipo !== "hay") return;
    expect(l.viaje.transaccionFirmada).toBe("TX-1");
  });

  it("el connect fija la clave de la billetera en el disco: de ahí sale el candado del paso 2", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const r = respuestaDeLaBilletera({ public_key: "LaCuenta", session: "LaSesion" }, par.publicKey);
    interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar", ...r }), AHORA, null);
    const l = leerViaje(a, AHORA);
    expect(l.tipo).toBe("hay");
    if (l.tipo !== "hay") return;
    expect(l.viaje.claveBilletera).toBe(bs58.encode(billeteraReal.publicKey));
    expect(l.viaje.direccion).toBe("LaCuenta");
    expect(l.viaje.session).toBe("LaSesion");
  });
});

describe("T-VJ-8: una vuelta de otra remesa no se aplica a la que está en curso", () => {
  it("«otra-remesa» cuando el viaje del disco es de una remesa distinta", () => {
    // 🔴 El campo `remittanceId` existía desde la ola 2 con un comentario que decía "sin esto, una
    // vuelta podría aplicarse sobre otra" — y NADIE lo comparaba: se escribía y no se leía nunca.
    // Medido: una respuesta capturada mientras el viaje era de REMESA-1 se entregaba tal cual como
    // resultado de REMESA-2. Era la primera línea de ataque del encargo, abierta, con un comentario
    // que apagaba la revisión de quien lo leyera.
    // MUTANTE QUE MATA: no comparar `viaje.remittanceId` contra `remesaEnCurso`.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx", remittanceId: "REMESA-1" }));
    const r = respuestaDeLaBilletera({ transaction: "TX-DE-REMESA-1" }, par.publicKey);
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-tx", ...r }),
      AHORA,
      "REMESA-2",
    );
    expect(v.tipo).toBe("otra-remesa");
    if (v.tipo !== "otra-remesa") return;
    expect(v.delViaje).toBe("REMESA-1");
    expect(v.enCurso).toBe("REMESA-2");
  });

  it("un viaje SIN remesa tampoco se hace pasar por la que está en curso", () => {
    // "No sé de qué remesa es" no es "es de ésta". El tercer valor otra vez.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const r = respuestaDeLaBilletera({ transaction: "T" }, par.publicKey);
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-tx", ...r }),
      AHORA,
      "REMESA-2",
    );
    expect(v.tipo).toBe("otra-remesa");
    if (v.tipo !== "otra-remesa") return;
    expect(v.delViaje).toBeNull();
  });

  it("la misma remesa pasa, y `null` significa que quien llama no tiene ninguna en contexto", () => {
    // `remesaEnCurso` es obligatorio y admite `null` a propósito: si fuera opcional, olvidarlo se
    // vería igual que decidirlo, y la protección se apagaría sola en el primer llamador distraído.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx", remittanceId: "REMESA-1" }));
    const r = respuestaDeLaBilletera({ transaction: "T" }, par.publicKey);
    const url = new URLSearchParams({ [MARCA]: "firmar-tx", ...r });
    expect(interpretarVuelta(a, url, AHORA, "REMESA-1").tipo).toBe("tx-firmada");

    const b = almacenFalso();
    guardarViaje(b, viajeConectado({ paso: "firmar-tx", remittanceId: "REMESA-1" }));
    expect(interpretarVuelta(b, url, AHORA, null).tipo).toBe("tx-firmada");
  });

  it("el ORDEN de decisión que el docblock declara es el que corre: remesa, luego consumo, luego clave", () => {
    // 🔴 EL ORDEN ESTÁ DECLARADO EN PROSA Y NO LO FIJABA NINGÚN TEST. El docblock de
    // `interpretarVuelta` dice, textual, "quién decide es, en este orden: que el viaje sea de la
    // remesa en curso, que ese paso no se haya leído ya, que la respuesta venga de la clave que fijó
    // el connect". Medido en el fix-pack 4: **intercambiar los dos primeros guards deja 96/96 en
    // verde**, o sea que la frase no la sostenía nada. Todos los `it` de los tres guards violan UNO
    // solo por vez, y con una sola violación cualquier orden da el mismo resultado.
    //
    // Y la diferencia ES observable, que es lo que hace que valga un candado y no un comentario: el
    // llamador recibe tres desenlaces distintos, con datos distintos adentro (`otra-remesa` trae los
    // dos identificadores, `ya-consumida` no trae ninguno), y la pantalla que los muestre le va a
    // decir a la persona tres cosas distintas.
    //
    // POR QUÉ ESTE ORDEN Y NO OTRO: de lo más ajeno a lo más íntimo. "Este viaje no es de la remesa
    // que tenés en pantalla" es cierto sin mirar nada más y es lo que el llamador necesita primero;
    // "ya lo leí" es un hecho de este viaje; y la clave es lo último porque es lo único que exige
    // haber abierto la URL. Contestar `otra-clave` sobre un viaje de OTRA remesa sería hablar de un
    // ancla que no es la que el llamador tiene en curso.
    //
    // MUTANTES QUE MATA (medidos, los dos): intercambiar los guards de `otra-remesa` y
    // `ya-consumida`; intercambiar los de `ya-consumida` y el ancla.
    const forjada = respuestaDeLaBilletera({ transaction: "TX-FORJADA" }, par.publicKey, {
      quien: nacl.box.keyPair(),
    });
    const url = new URLSearchParams({ [MARCA]: "firmar-tx", ...forjada });
    /** Un viaje que viola los TRES guards a la vez: otra remesa, paso ya consumido, clave ajena. */
    const conLosTres = () => {
      const a = almacenFalso();
      guardarViaje(
        a,
        viajeConectado({
          paso: "firmar-tx",
          remittanceId: "REMESA-1",
          pasosConsumidos: ["conectar", "firmar-tx"],
        }),
      );
      return a;
    };

    // Con los tres violados manda el primero.
    expect(interpretarVuelta(conLosTres(), url, AHORA, "REMESA-2").tipo).toBe("otra-remesa");
    // Sacando el primero de la ecuación (la remesa coincide) manda el segundo, no el tercero.
    expect(interpretarVuelta(conLosTres(), url, AHORA, "REMESA-1").tipo).toBe("ya-consumida");
    // Y sin los dos primeros queda el ancla, que es el control de que el tercero sigue vivo.
    const soloClave = almacenFalso();
    guardarViaje(soloClave, viajeConectado({ paso: "firmar-tx", remittanceId: "REMESA-1" }));
    expect(interpretarVuelta(soloClave, url, AHORA, "REMESA-1").tipo).toBe("otra-clave");
  });
});

describe("T-VJ-5: interpretar la vuelta — los tres pasos que sí salen bien", () => {
  it.each(LAS_DOS)("%s · conectar devuelve dirección y sesión", (billetera) => {
    // 🔴 EL `it.each` NO ES DECORATIVO ACÁ. Antes este archivo entero corría sólo con Phantom: la
    // billetera de mentira emitía `phantom_encryption_public_key` a mano, así que ningún test podía
    // construir una respuesta de Solflare aunque quisiera. Medido: reemplazar las CUATRO lecturas de
    // `viaje.billetera` por `"phantom"` sobrevivía a los 38 tests, y con ese mutante puesto TODA
    // vuelta de Solflare se degrada a «huerfana» sin que nada avise. Solflare es la mitad del
    // alcance de esta HU.
    // MUTANTE QUE MATA: usar `"phantom"` fijo en la lectura de `sesion.ts:646` (la del connect).
    // Medido en el fix-pack 4: 2 `it` rojos, éste y el control del ancla de `T-VJ-6` para Solflare.
    // (Antes del fix-pack era 1 solo, éste; el número cambió porque `T-VJ-6` pasó a correr con las
    // dos billeteras. Es una medición con fecha, no una propiedad del test.) Las otras tres lecturas
    // las cubren los dos `it.each` de abajo y, la del ancla, el bloque `T-VJ-6`.
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ billetera, paso: "conectar" }));
    const r = respuestaDeLaBilletera({ public_key: "LaCuenta", session: "LaSesion" }, par.publicKey, {
      billetera,
    });
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar", ...r }), AHORA, null);
    expect(v).toEqual({
      tipo: "conectado",
      direccion: "LaCuenta",
      session: "LaSesion",
      persistencia: "guardado",
    });
  });

  it.each(LAS_DOS)("%s · firmar-tx devuelve la transacción firmada", (billetera) => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ billetera, paso: "firmar-tx" }));
    const r = respuestaDeLaBilletera({ transaction: "TxFirmada58" }, par.publicKey, { billetera });
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...r }), AHORA, null);
    expect(v).toEqual({ tipo: "tx-firmada", transaccionBase58: "TxFirmada58", persistencia: "guardado" });
  });

  it.each(LAS_DOS)("%s · firmar-patrocinio devuelve la firma", (billetera) => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ billetera, paso: "firmar-patrocinio" }));
    const r = respuestaDeLaBilletera({ signature: "FirmaPoP" }, par.publicKey, { billetera });
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-patrocinio", ...r }),
      AHORA,
      null,
    );
    expect(v).toEqual({ tipo: "patrocinio-firmado", firma: "FirmaPoP", persistencia: "guardado" });
  });

  it("una respuesta de Phantom NO se lee como Solflare al atravesar la sesión", () => {
    // El mismo candado que `protocol.test.ts` tiene para `leerRespuesta`, pero de este lado: acá el
    // nombre del parámetro sale de `viaje.billetera`, que es el que el mutante de arriba borra.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ billetera: "solflare", paso: "firmar-tx" }));
    const r = respuestaDeLaBilletera({ transaction: "T" }, par.publicKey, { billetera: "phantom" });
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...r }), AHORA, null);
    expect(v.tipo).toBe("huerfana");
  });

  it("un cuerpo sin los campos esperados NO sale como un paso bueno con undefined adentro", () => {
    // 🔴 Medido: `{ public_key, session }` leído en el paso 3 devolvía
    // `{ tipo: "patrocinio-firmado", firma: undefined }`, con `firma` TIPADA `string`. Y es
    // alcanzable SIN billetera hostil: el mismo secreto compartido sirve para los tres pasos, así
    // que un sobre del paso 2 se descifra perfecto si se lo lee como paso 3. Ese `undefined` iba
    // camino al facilitator disfrazado de firma.
    // MUTANTE QUE MATA: sacar el validador `soloTextos` y volver al `as T`.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-patrocinio" }));
    const r = respuestaDeLaBilletera({ public_key: "A", session: "B" }, par.publicKey);
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-patrocinio", ...r }),
      AHORA,
      null,
    );
    expect(v.tipo).toBe("rechazo");
    if (v.tipo !== "rechazo") return;
    expect(v.codigo).toBe("forma_inesperada");
  });

  it("la respuesta se lee con el paso que dice la URL, no con el que quedó guardado", () => {
    // 🔴 Si se leyera por `viaje.paso`, una vuelta de `firmar-tx` sobre un viaje cuyo disco quedó en
    // `conectar` se interpretaría como una conexión, y la pantalla creería tener una dirección que
    // nadie le dio. Los dos campos existen y pueden divergir; manda la URL, que es la que trae la
    // respuesta que estamos leyendo.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "conectar" }));
    const r = respuestaDeLaBilletera({ transaction: "T58" }, par.publicKey);
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...r }), AHORA, null);
    expect(v.tipo).toBe("tx-firmada");
  });
});

describe("T-VJ-9: `interpretarVuelta` lee el disco ELLA, no recibe el snapshot de nadie", () => {
  // 🔴 QUÉ CLASE DE DEFECTO CIERRA ESTE BLOQUE. La función recibía una `LecturaDelViaje` del
  // llamador, leía de ahí la marca de consumo y después escribía pisando el almacén entero: un
  // read-modify-write sobre un snapshot ajeno, o sea un lost-update de manual. Los 71 tests de la
  // iteración anterior no lo veían porque TODOS re-leían el disco justo antes de llamar — la suite
  // codificaba un protocolo de uso que la API no obligaba, no documentaba y no verificaba.
  //
  // Estos `it` son la contracara: ninguno re-lee entre llamadas, que es exactamente lo que hace un
  // llamador normal cuando calcula la lectura en un render o en un `useMemo` y llama a la función en
  // un efecto (y `next.config.mjs` tiene `reactStrictMode: true`, o sea efectos invocados dos veces
  // en desarrollo).

  it("la misma respuesta procesada dos veces seguidas NO devuelve dos «tx-firmada»", () => {
    // Medido en el re-AR con el snapshot reusado: `P-A v1` y `P-A v2` daban las dos
    // `{"tipo":"tx-firmada","transaccionBase58":"TX-REAL"}`. Acá no hay nada que reusar.
    // MUTANTE QUE MATA: volver a recibir la lectura por parámetro (no compila) o cachear la lectura
    // fuera del cuerpo de la función.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const url = new URLSearchParams({
      [MARCA]: "firmar-tx",
      ...respuestaDeLaBilletera({ transaction: "TX-REAL" }, par.publicKey),
    });
    expect(interpretarVuelta(a, url, AHORA, null).tipo).toBe("tx-firmada");
    expect(interpretarVuelta(a, url, AHORA, null).tipo).toBe("ya-consumida");
  });

  it("procesar el paso 3 NO borra del disco el resultado del paso 2", () => {
    // 🔴 Medido en el re-AR con dos pestañas que leían antes de que la primera escribiera: el disco
    // pasaba de `"pasosConsumidos":["conectar","firmar-tx"],"transaccionFirmada":"TX-REAL"` a
    // `"pasosConsumidos":["conectar","firmar-patrocinio"],"firmaDePatrocinio":"FIRMA"`. Se PERDÍA una
    // firma que la persona ya había dado, y el paso volvía a estar disponible para un replay.
    // Acá las dos llamadas usan sólo el almacén, sin ninguna lectura intermedia del test.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    interpretarVuelta(
      a,
      new URLSearchParams({
        [MARCA]: "firmar-tx",
        ...respuestaDeLaBilletera({ transaction: "TX-REAL" }, par.publicKey),
      }),
      AHORA,
      null,
    );
    interpretarVuelta(
      a,
      new URLSearchParams({
        [MARCA]: "firmar-patrocinio",
        ...respuestaDeLaBilletera({ signature: "FIRMA" }, par.publicKey),
      }),
      AHORA,
      null,
    );
    const l = leerViaje(a, AHORA);
    expect(l.tipo).toBe("hay");
    if (l.tipo !== "hay") return;
    expect(l.viaje.transaccionFirmada).toBe("TX-REAL");
    expect(l.viaje.firmaDePatrocinio).toBe("FIRMA");
    expect(l.viaje.pasosConsumidos).toEqual(["conectar", "firmar-tx", "firmar-patrocinio"]);
  });

  it("un viaje que venció ENTRE la escritura y la vuelta sale «vencida», no se lee igual", () => {
    // El otro lado de que la función lea sola: la ventana se evalúa con el `ahora` de cuando actúa,
    // no con el de cuando el llamador armó su lectura. Antes esos dos instantes podían ser
    // cualquiera y la función no tenía cómo saberlo.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const url = new URLSearchParams({
      [MARCA]: "firmar-tx",
      ...respuestaDeLaBilletera({ transaction: "T" }, par.publicKey),
    });
    expect(interpretarVuelta(a, url, AHORA + VEINTE_MINUTOS + 1, null).tipo).toBe("vencida");
  });
});

describe("T-VJ-10: un disco que no acepta la escritura no puede tirarle una excepción a una firma buena", () => {
  /** Un almacén que deja leer y borrar, pero cuyo `setItem` lanza. Cuota llena, modo privado. */
  function almacenQueNoDejaEscribir(): Almacen & { datos: Map<string, string> } {
    const datos = new Map<string, string>();
    return {
      datos,
      leer: (k) => datos.get(k) ?? null,
      escribir: () => {
        throw new Error("QuotaExceededError");
      },
      borrar: (k) => void datos.delete(k),
    };
  }

  it("la firma vuelve igual, con «no-se-pudo-guardar», y NO como excepción", () => {
    // 🔴 MEDIDO EN EL RE-AR: `P-F resultado: THROW: QuotaExceededError`. La persona saltó a la
    // billetera, firmó, volvió — y en vez de `tx-firmada` recibía una excepción no capturada. Nació
    // del rediseño anterior: antes `interpretarVuelta` era pura y ningún fallo del disco la tocaba;
    // al empezar a escribir, el `setItem` quedó DESPUÉS de la firma, que es el peor momento posible.
    // El propio módulo tiene escrito, para el caso análogo, que "una respuesta que no se puede abrir
    // es un desenlace del viaje, no un error de programación": un disco que no se puede escribir es
    // lo mismo.
    // MUTANTE QUE MATA: sacar el `try/catch` de `consumir`.
    const a = almacenQueNoDejaEscribir();
    // El viaje se siembra a mano porque `guardarViaje` con este almacén tira a propósito (ver abajo).
    a.datos.set(CLAVE_EN_DISCO, JSON.stringify(viajeConectado({ paso: "firmar-tx" })));
    const url = new URLSearchParams({
      [MARCA]: "firmar-tx",
      ...respuestaDeLaBilletera({ transaction: "TX-REAL" }, par.publicKey),
    });
    expect(() => interpretarVuelta(a, url, AHORA, null)).not.toThrow();
    expect(interpretarVuelta(a, url, AHORA, null)).toEqual({
      tipo: "tx-firmada",
      transaccionBase58: "TX-REAL",
      persistencia: "no-se-pudo-guardar",
    });
  });

  it("y lo DICE: no se disfraza de «guardado», porque el anti-repetición no quedó vigente", () => {
    // Tragarse el fallo sería mentir de la peor forma: sin la marca en el disco, la MISMA URL vuelve
    // a anunciar el mismo resultado en la próxima lectura y el que llama no tiene cómo distinguir
    // "acaba de firmar" de "esto ya lo procesé". El desenlace lleva ese hecho pegado.
    // MUTANTE QUE MATA: devolver siempre `"guardado"` desde `consumir`.
    const a = almacenQueNoDejaEscribir();
    a.datos.set(CLAVE_EN_DISCO, JSON.stringify(viajeConectado({ paso: "firmar-tx" })));
    const url = new URLSearchParams({
      [MARCA]: "firmar-tx",
      ...respuestaDeLaBilletera({ transaction: "TX-REAL" }, par.publicKey),
    });
    const primera = interpretarVuelta(a, url, AHORA, null);
    expect(primera.tipo === "tx-firmada" && primera.persistencia).toBe("no-se-pudo-guardar");
    // Y se comprueba la consecuencia, no sólo la etiqueta: la segunda lectura vuelve a entregar la
    // misma transacción en vez de decir «ya-consumida».
    expect(interpretarVuelta(a, url, AHORA, null).tipo).toBe("tx-firmada");
  });

  it("el camino normal dice «guardado»: la etiqueta no es decorativa", () => {
    // El control. Un `consumir` que devolviera siempre `"no-se-pudo-guardar"` pasaría los dos `it`
    // de arriba.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const url = new URLSearchParams({
      [MARCA]: "firmar-tx",
      ...respuestaDeLaBilletera({ transaction: "TX-REAL" }, par.publicKey),
    });
    const v = interpretarVuelta(a, url, AHORA, null);
    expect(v.tipo === "tx-firmada" && v.persistencia).toBe("guardado");
  });

  it("[LÍMITE DECLARADO] «guardado» dice que el `setItem` no tiró, no que el valor siga ahí", () => {
    // 🔴 ESTE `it` NO ES UN CANDADO: congela la distancia entre lo que el tipo `Persistencia` puede
    // afirmar y lo que decía. Decía que con «guardado» "el resultado y la marca quedaron en el disco,
    // el anti-repetición vale", y lo único que el código observa es que la escritura no lanzó.
    // `localStorage` no tiene compare-and-swap, así que entre nuestra lectura y nuestra escritura
    // otra pestaña puede escribir y nuestro `setItem` la pisa —o la de ella pisa la nuestra— sin que
    // ninguna de las dos se entere.
    //
    // El re-AR lo midió (P-16) y ese número vivía sólo en un reporte que no vuelve a correr nadie.
    // Acá el intercalado es físico y explícito: la pestaña B corre ENTERA dentro del `leer` de A, así
    // que A escribe a partir de un estado que ya quedó viejo. No mide con qué probabilidad pasa en un
    // teléfono real —eso es [NO VERIFICADO]—, mide que es POSIBLE, que es lo que la frase necesitaba.
    //
    // ⚠️ LA PEOR CONSECUENCIA, dicha sin adornos: una firma que la persona YA dio desaparece del
    // disco y su paso vuelve a estar disponible. NO es una escalada de privilegio (el ancla sigue
    // intacta y la re-jugada devuelve la misma firma legítima), es pérdida de un resultado del camino
    // del dinero. Que la HU 062 decida qué hace con eso es un requisito, no un detalle.
    //
    // ⚠️ SI ALGÚN DÍA SE AGREGA COMPARE-AND-SWAP, ESTE `it` SE PONE ROJO — y ahí el docblock de
    // `Persistencia` vuelve a poder prometer lo que hoy no puede. Esa es su función.
    const datos = new Map<string, string>();
    /** Un almacén pelado sobre el mismo `Map`, para leer el final sin disparar el intercalado. */
    const plano: Almacen = {
      leer: (k) => datos.get(k) ?? null,
      escribir: (k, v) => void datos.set(k, v),
      borrar: (k) => void datos.delete(k),
    };
    let bDevolvio: unknown = null;
    let yaCorrioB = false;
    const conIntercalado: Almacen = {
      leer: (k) => {
        const valor = datos.get(k) ?? null;
        if (!yaCorrioB) {
          yaCorrioB = true;
          // La pestaña B, entera, DESPUÉS de que A leyó y ANTES de que A escriba.
          bDevolvio = interpretarVuelta(
            plano,
            new URLSearchParams({
              [MARCA]: "firmar-patrocinio",
              ...respuestaDeLaBilletera({ signature: "FIRMA-DE-B" }, par.publicKey),
            }),
            AHORA,
            null,
          );
        }
        return valor;
      },
      escribir: (k, v) => void datos.set(k, v),
      borrar: (k) => void datos.delete(k),
    };
    guardarViaje(plano, viajeConectado({ paso: "firmar-tx" }));

    const aDevolvio = interpretarVuelta(
      conIntercalado,
      new URLSearchParams({
        [MARCA]: "firmar-tx",
        ...respuestaDeLaBilletera({ transaction: "TX-DE-A" }, par.publicKey),
      }),
      AHORA,
      null,
    );

    // Las dos pestañas contestaron que guardaron.
    expect(bDevolvio).toEqual({
      tipo: "patrocinio-firmado",
      firma: "FIRMA-DE-B",
      persistencia: "guardado",
    });
    expect(aDevolvio).toEqual({
      tipo: "tx-firmada",
      transaccionBase58: "TX-DE-A",
      persistencia: "guardado",
    });

    // Y una de las dos no guardó nada: ni la firma de B ni su marca de consumo están en el disco.
    const l = leerViaje(plano, AHORA);
    expect(l.tipo).toBe("hay");
    if (l.tipo !== "hay") return;
    expect(l.viaje.firmaDePatrocinio).toBeUndefined();
    expect(l.viaje.pasosConsumidos).not.toContain("firmar-patrocinio");
  });

  it("`guardarViaje` SÍ tira, y es deliberado: pasa ANTES del salto", () => {
    // La asimetría es la decisión. Antes del salto no hay nada que perder y saltar igual sería
    // mandar a la persona a firmar algo cuya vuelta este dispositivo no va a poder reconocer
    // (`huerfana` garantizada). Que el llamador se entere y NO salte es lo correcto; tragárselo acá
    // sería fabricar el viaje roto en silencio.
    // MUTANTE QUE MATA: envolver `guardarViaje` en un `try/catch` que se coma el error.
    const a = almacenQueNoDejaEscribir();
    expect(() => guardarViaje(a, viajeBase())).toThrow();
  });

  it("`terminarViaje` no tira: limpiar no le deja al que llama ninguna decisión mejor", () => {
    // La limpieza corre en cada rama de basura de `leerViaje`. Si tirara, un disco que no deja
    // borrar rompería la LECTURA entera por una operación de higiene.
    // MUTANTE QUE MATA: sacar el `try/catch` de `terminarViaje`.
    const a: Almacen = {
      leer: () => "{esto no es json",
      escribir: () => undefined,
      borrar: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() => terminarViaje(a)).not.toThrow();
    expect(() => leerViaje(a, AHORA)).not.toThrow();
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
  });
});
