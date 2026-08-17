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
 * a Phantom, y por eso reemplazar las tres lecturas de `viaje.billetera` por `"phantom"` sobrevivía
 * a la suite entera.
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
    // teléfono movido) NO se trata acá a propósito: DT-7 dice que esto no es un control de
    // seguridad, y un reloj atrasado es una situación honesta. Un `Infinity`, no.
    // MUTANTE QUE MATA: volver `Number.isFinite(v?.desde)` a `typeof v?.desde !== "number"`.
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

  it("el crash tampoco pasa si alguien arma la lectura a mano", () => {
    // `leerViaje` ya lo garantiza, pero `interpretarVuelta` recibe una `LecturaDelViaje` que puede
    // construir cualquiera. Defensa en profundidad: contesta un desenlace y limpia el disco.
    const a = almacenFalso();
    const lectura = { tipo: "hay", viaje: viajeBase({ secreta: "!!!no-base58!!!" }) } as const;
    expect(() =>
      interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar" }), lectura, null),
    ).not.toThrow();
    expect(
      interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar" }), lectura, null).tipo,
    ).toBe("huerfana");
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
    expect(interpretarVuelta(a, new URLSearchParams(""), leerViaje(a, AHORA), null).tipo).toBe(
      "no-volvimos",
    );
  });

  it("una marca inventada tampoco cuenta como vuelta", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "cualquier-cosa" }),
      leerViaje(a, AHORA),
      null,
    );
    expect(v.tipo).toBe("no-volvimos");
  });

  it("«huerfana» cuando la URL dice que volvimos y en el disco no hay viaje", () => {
    // 🔴 Pasa de verdad: otro dispositivo, incógnito, un enlace compartido, un viaje ya cerrado.
    // Lo único honesto es decir que no sabemos de qué viaje habla. NO es "cancelaste".
    // MUTANTE QUE MATA: contestar `rechazo` cuando no hay viaje.
    const a = almacenFalso();
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx" }), leerViaje(a, AHORA), null);
    expect(v.tipo).toBe("huerfana");
    if (v.tipo !== "huerfana") return;
    expect(v.paso).toBe("firmar-tx");
  });

  it("«vencida» cuando había viaje pero ya no vale: la persona firmó al pedo y merece saberlo", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ paso: "firmar-patrocinio" }));
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-patrocinio" }),
      leerViaje(a, AHORA + VEINTE_MINUTOS + 1),
      null,
    );
    expect(v.tipo).toBe("vencida");
  });

  it("volver CON la marca pero SIN parámetros de respuesta es «huerfana», no «rechazo»", () => {
    // La billetera nos devolvió con las manos vacías. No declaró un rechazo, así que no se lo
    // podemos atribuir; y tampoco es "no volvimos", porque volvimos.
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar" }), leerViaje(a, AHORA), null);
    expect(v.tipo).toBe("huerfana");
  });

  it("«rechazo» cuando la billetera lo declara, con su código y su paso", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-tx", errorCode: "4001", errorMessage: "User rejected" }),
      leerViaje(a, AHORA),
      null,
    );
    expect(v.tipo).toBe("rechazo");
    if (v.tipo !== "rechazo") return;
    expect(v.codigo).toBe("4001");
    expect(v.paso).toBe("firmar-tx");
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
      leerViaje(a, AHORA),
      null,
    );
    const buena = respuestaDeLaBilletera({ transaction: "TxDeVerdad" }, par.publicKey);
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-tx", ...buena }),
      leerViaje(a, AHORA),
      null,
    );
    expect(v).toEqual({ tipo: "tx-firmada", transaccionBase58: "TxDeVerdad" });
  });
});

describe("T-VJ-6: la respuesta tiene que venir de la billetera con la que se conectó", () => {
  it("el atacante que SÍ conoce la clave PÚBLICA de la app no puede forjar el paso 2", () => {
    // 🔴 ESTE `it` REEMPLAZA A UNO QUE MODELABA LA HIPÓTESIS EQUIVOCADA. El anterior cifraba hacia
    // OTRA clave pública, o sea contra un atacante que NO conoce la de la app: el caso fácil, y por
    // eso era verde sin decir nada. La clave pública de la app no es un secreto — viaja en la URL
    // saliente hacia phantom.app, queda en el historial del navegador y está en `viaje.publica`, en
    // el disco. Quien la tenga se fabrica su propio par, deriva el MISMO secreto compartido por
    // Diffie-Hellman y cifra lo que quiera. Medido en el AR: así se consiguió
    // `{ tipo: "tx-firmada", transaccionBase58: "TX-QUE-NINGUNA-BILLETERA-FIRMO" }`.
    // Lo que lo cierra es fijar la clave de la billetera en el connect y compararla después.
    // MUTANTE QUE MATA: borrar la comparación contra `viaje.claveBilletera`.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const atacante = nacl.box.keyPair(); // sólo necesita `viaje.publica`, que es pública
    const forjada = respuestaDeLaBilletera({ transaction: "TX-QUE-NADIE-FIRMO" }, par.publicKey, {
      quien: atacante,
    });
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-tx", ...forjada }),
      leerViaje(a, AHORA),
      null,
    );
    expect(v.tipo).toBe("otra-clave");
    if (v.tipo !== "otra-clave") return;
    expect(v.motivo).toBe("no-coincide");
  });

  it("y tampoco el paso 3, que es el del patrocinio", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-patrocinio" }));
    const forjada = respuestaDeLaBilletera({ signature: "FIRMA-FORJADA" }, par.publicKey, {
      quien: nacl.box.keyPair(),
    });
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-patrocinio", ...forjada }),
      leerViaje(a, AHORA),
      null,
    );
    expect(v.tipo).toBe("otra-clave");
  });

  it("un paso 2 sobre un viaje que nunca conectó dice «sin-fijar», que es otra cosa", () => {
    // No hay contra qué comparar: el viaje nunca completó el paso 1. Decir «no-coincide» sería
    // afirmar que se conoció otra clave, y no se conoció ninguna. Son dos hechos distintos y el
    // que lo lea necesita saber cuál de los dos le pasó.
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ paso: "firmar-tx" })); // sin `claveBilletera`
    const r = respuestaDeLaBilletera({ transaction: "T" }, par.publicKey);
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-tx", ...r }),
      leerViaje(a, AHORA),
      null,
    );
    expect(v.tipo).toBe("otra-clave");
    if (v.tipo !== "otra-clave") return;
    expect(v.motivo).toBe("sin-fijar");
  });

  it("la billetera de verdad sí pasa: el candado no cierra el camino bueno", () => {
    // Un guard que rechaza todo también pasaría los tres `it` de arriba. Éste es el control.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const r = respuestaDeLaBilletera({ transaction: "TxBuena" }, par.publicKey);
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-tx", ...r }),
      leerViaje(a, AHORA),
      null,
    );
    expect(v).toEqual({ tipo: "tx-firmada", transaccionBase58: "TxBuena" });
  });

  it("[RESIDUAL, NO ARREGLADO] en el paso 1 esa misma forja SÍ entra, y no se cierra acá", () => {
    // 🔴 Esto NO es un candado: es la documentación ejecutable de un agujero que sigue abierto. El
    // connect es el primer contacto y no hay ninguna clave previa contra qué comparar, así que quien
    // conozca la pública de la app puede hacerse pasar por la billetera. Cerrarlo pide verificar el
    // connect contra algo que el atacante no tenga, y eso no vive en este módulo. Si algún día se
    // cierra, este `it` se pone rojo, que es exactamente lo que tiene que pasar.
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
      leerViaje(a, AHORA),
      null,
    );
    expect(v).toEqual({ tipo: "conectado", direccion: "DIRECCION-DEL-ATACANTE", session: "s" });
  });
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

    expect(interpretarVuelta(a, url, leerViaje(a, AHORA), null)).toEqual({
      tipo: "tx-firmada",
      transaccionBase58: "TxFirmada58",
    });
    const segunda = interpretarVuelta(a, url, leerViaje(a, AHORA + 60_000), null);
    expect(segunda.tipo).toBe("ya-consumida");
    if (segunda.tipo !== "ya-consumida") return;
    expect(segunda.paso).toBe("firmar-tx");
  });

  it("«ya-consumida» NO es «rechazo» ni «huerfana»: nadie canceló y el viaje está ahí", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const r = respuestaDeLaBilletera({ transaction: "T" }, par.publicKey);
    const url = new URLSearchParams({ [MARCA]: "firmar-tx", ...r });
    interpretarVuelta(a, url, leerViaje(a, AHORA), null);
    const v = interpretarVuelta(a, url, leerViaje(a, AHORA), null);
    expect(v.tipo).not.toBe("rechazo");
    expect(v.tipo).not.toBe("huerfana");
  });

  it("el resultado del paso queda escrito en el disco, no sólo devuelto", () => {
    // Es lo que hace posible reanudar sin volver a pedir una firma, y es la mitad que faltaba: el
    // estado que hace falta para no repetir vive acá adentro, así que resolverlo acá no es opcional.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ paso: "firmar-tx" }));
    const r = respuestaDeLaBilletera({ transaction: "TxGuardada" }, par.publicKey);
    interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...r }), leerViaje(a, AHORA), null);
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
    interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar", ...conectar }), leerViaje(a, AHORA), null);
    const firmar = respuestaDeLaBilletera({ transaction: "T" }, par.publicKey);
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-tx", ...firmar }),
      leerViaje(a, AHORA),
      null,
    );
    expect(v).toEqual({ tipo: "tx-firmada", transaccionBase58: "T" });
  });

  it("el connect fija la clave de la billetera en el disco: de ahí sale el candado del paso 2", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const r = respuestaDeLaBilletera({ public_key: "LaCuenta", session: "LaSesion" }, par.publicKey);
    interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar", ...r }), leerViaje(a, AHORA), null);
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
      leerViaje(a, AHORA),
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
      leerViaje(a, AHORA),
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
    expect(interpretarVuelta(a, url, leerViaje(a, AHORA), "REMESA-1").tipo).toBe("tx-firmada");

    const b = almacenFalso();
    guardarViaje(b, viajeConectado({ paso: "firmar-tx", remittanceId: "REMESA-1" }));
    expect(interpretarVuelta(b, url, leerViaje(b, AHORA), null).tipo).toBe("tx-firmada");
  });
});

describe("T-VJ-5: interpretar la vuelta — los tres pasos que sí salen bien", () => {
  it.each(LAS_DOS)("%s · conectar devuelve dirección y sesión", (billetera) => {
    // 🔴 EL `it.each` NO ES DECORATIVO ACÁ. Antes este archivo entero corría sólo con Phantom: la
    // billetera de mentira emitía `phantom_encryption_public_key` a mano, así que ningún test podía
    // construir una respuesta de Solflare aunque quisiera. Medido: reemplazar las tres lecturas de
    // `viaje.billetera` por `"phantom"` sobrevivía a los 38 tests, y con ese mutante puesto TODA
    // vuelta de Solflare se degrada a «huerfana» sin que nada avise. Solflare es la mitad del
    // alcance de esta HU.
    // MUTANTE QUE MATA: usar `"phantom"` fijo en vez de `viaje.billetera`.
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ billetera, paso: "conectar" }));
    const r = respuestaDeLaBilletera({ public_key: "LaCuenta", session: "LaSesion" }, par.publicKey, {
      billetera,
    });
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "conectar", ...r }), leerViaje(a, AHORA), null);
    expect(v).toEqual({ tipo: "conectado", direccion: "LaCuenta", session: "LaSesion" });
  });

  it.each(LAS_DOS)("%s · firmar-tx devuelve la transacción firmada", (billetera) => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ billetera, paso: "firmar-tx" }));
    const r = respuestaDeLaBilletera({ transaction: "TxFirmada58" }, par.publicKey, { billetera });
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...r }), leerViaje(a, AHORA), null);
    expect(v).toEqual({ tipo: "tx-firmada", transaccionBase58: "TxFirmada58" });
  });

  it.each(LAS_DOS)("%s · firmar-patrocinio devuelve la firma", (billetera) => {
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ billetera, paso: "firmar-patrocinio" }));
    const r = respuestaDeLaBilletera({ signature: "FirmaPoP" }, par.publicKey, { billetera });
    const v = interpretarVuelta(
      a,
      new URLSearchParams({ [MARCA]: "firmar-patrocinio", ...r }),
      leerViaje(a, AHORA),
      null,
    );
    expect(v).toEqual({ tipo: "patrocinio-firmado", firma: "FirmaPoP" });
  });

  it("una respuesta de Phantom NO se lee como Solflare al atravesar la sesión", () => {
    // El mismo candado que `protocol.test.ts` tiene para `leerRespuesta`, pero de este lado: acá el
    // nombre del parámetro sale de `viaje.billetera`, que es el que el mutante de arriba borra.
    const a = almacenFalso();
    guardarViaje(a, viajeConectado({ billetera: "solflare", paso: "firmar-tx" }));
    const r = respuestaDeLaBilletera({ transaction: "T" }, par.publicKey, { billetera: "phantom" });
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...r }), leerViaje(a, AHORA), null);
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
      leerViaje(a, AHORA),
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
    const v = interpretarVuelta(a, new URLSearchParams({ [MARCA]: "firmar-tx", ...r }), leerViaje(a, AHORA), null);
    expect(v.tipo).toBe("tx-firmada");
  });
});
