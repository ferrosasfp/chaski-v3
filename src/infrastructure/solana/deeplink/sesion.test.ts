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
// LA ELECCIÓN DE FONDO DE ESTE ARCHIVO: casi todos los `it` son de caminos que NO son el feliz. Es a
// propósito. El camino feliz de un redirect es trivial; lo caro es el viaje huérfano, el vencido y el
// que vuelve con las manos vacías, que son los tres que se colapsan en "cancelaste" si nadie mira.
import { beforeEach, describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
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
let par: nacl.BoxKeyPair;

beforeEach(() => {
  par = nacl.box.keyPair();
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

/** La billetera de mentira, igual que en `protocol.test.ts`: hace lo que dice la documentación. */
function respuestaDeLaBilletera(cuerpo: unknown, publicaDeLaApp: Uint8Array) {
  const suyo = nacl.box.keyPair();
  const secreto = nacl.box.before(publicaDeLaApp, suyo.secretKey);
  const nonce = nacl.randomBytes(24);
  const data = nacl.box.after(new TextEncoder().encode(JSON.stringify(cuerpo)), nonce, secreto);
  return {
    phantom_encryption_public_key: bs58.encode(suyo.publicKey),
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
  it("«vencido» pasado el máximo, y NO «no-hay»", () => {
    // 🔴 La diferencia importa para la persona: "no hay" es silencio, "venció" es que firmó al pedo
    // y hay que decírselo. MUTANTE QUE MATA: devolver `no-hay` en la rama de la edad.
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    expect(leerViaje(a, AHORA + MAX_EDAD_MS + 1).tipo).toBe("vencido");
  });

  it("justo en el límite todavía vale: el corte es estrictamente mayor", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    expect(leerViaje(a, AHORA + MAX_EDAD_MS).tipo).toBe("hay");
  });

  it("un viaje vencido se LIMPIA al leerlo, no queda dando vueltas", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    leerViaje(a, AHORA + MAX_EDAD_MS + 1);
    expect(a.borrados).toBe(1);
    expect(leerViaje(a, AHORA + MAX_EDAD_MS + 2).tipo).toBe("no-hay");
  });

  it("JSON roto es «no-hay», NO «vencido»: no se puede afirmar que existió algo", () => {
    const a = almacenFalso();
    a.escribir("chaski.billetera.viaje.v1", "{esto no es json");
    expect(leerViaje(a, AHORA).tipo).toBe("no-hay");
  });

  it("un viaje SIN clave secreta no sirve aunque esté fresco", () => {
    // Sin `secreta` no se abre ningún sobre, así que retomarlo sería ofrecer continuar algo que no
    // puede terminar. Se limpia y se contesta «no-hay».
    const a = almacenFalso();
    a.escribir("chaski.billetera.viaje.v1", JSON.stringify({ ...viajeBase(), secreta: undefined }));
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
});

describe("T-VJ-4: interpretar la vuelta — los caminos que NO son el feliz", () => {
  it("sin la marca es «no-volvimos»: entrar a la página de frente no es volver de ningún lado", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    expect(interpretarVuelta(new URLSearchParams(""), leerViaje(a, AHORA)).tipo).toBe("no-volvimos");
  });

  it("una marca inventada tampoco cuenta como vuelta", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const v = interpretarVuelta(new URLSearchParams({ [MARCA]: "cualquier-cosa" }), leerViaje(a, AHORA));
    expect(v.tipo).toBe("no-volvimos");
  });

  it("«huerfana» cuando la URL dice que volvimos y en el disco no hay viaje", () => {
    // 🔴 Pasa de verdad: otro dispositivo, incógnito, un enlace compartido, un viaje ya cerrado.
    // Lo único honesto es decir que no sabemos de qué viaje habla. NO es "cancelaste".
    // MUTANTE QUE MATA: contestar `rechazo` cuando no hay viaje.
    const a = almacenFalso();
    const v = interpretarVuelta(new URLSearchParams({ [MARCA]: "firmar-tx" }), leerViaje(a, AHORA));
    expect(v.tipo).toBe("huerfana");
    if (v.tipo !== "huerfana") return;
    expect(v.paso).toBe("firmar-tx");
  });

  it("«vencida» cuando había viaje pero ya no vale: la persona firmó al pedo y merece saberlo", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ paso: "firmar-patrocinio" }));
    const v = interpretarVuelta(
      new URLSearchParams({ [MARCA]: "firmar-patrocinio" }),
      leerViaje(a, AHORA + MAX_EDAD_MS + 1),
    );
    expect(v.tipo).toBe("vencida");
  });

  it("volver CON la marca pero SIN parámetros de respuesta es «huerfana», no «rechazo»", () => {
    // La billetera nos devolvió con las manos vacías. No declaró un rechazo, así que no se lo
    // podemos atribuir; y tampoco es "no volvimos", porque volvimos.
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const v = interpretarVuelta(new URLSearchParams({ [MARCA]: "conectar" }), leerViaje(a, AHORA));
    expect(v.tipo).toBe("huerfana");
  });

  it("«rechazo» cuando la billetera lo declara, con su código y su paso", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ paso: "firmar-tx" }));
    const v = interpretarVuelta(
      new URLSearchParams({ [MARCA]: "firmar-tx", errorCode: "4001", errorMessage: "User rejected" }),
      leerViaje(a, AHORA),
    );
    expect(v.tipo).toBe("rechazo");
    if (v.tipo !== "rechazo") return;
    expect(v.codigo).toBe("4001");
    expect(v.paso).toBe("firmar-tx");
  });

  it("una URL fabricada a mano NO puede hacerse pasar por una respuesta buena", () => {
    // La marca la escribe cualquiera. Lo que decide es si el sobre abre, y sólo abre con la clave
    // secreta que quedó en ESTE disco. Lo máximo que se logra falsificando la URL es un rechazo.
    const a = almacenFalso();
    guardarViaje(a, viajeBase());
    const otra = nacl.box.keyPair();
    const falsa = respuestaDeLaBilletera({ public_key: "ATACANTE", session: "x" }, otra.publicKey);
    const v = interpretarVuelta(new URLSearchParams({ [MARCA]: "conectar", ...falsa }), leerViaje(a, AHORA));
    expect(v.tipo).toBe("rechazo");
    if (v.tipo !== "rechazo") return;
    expect(v.codigo).toBe("sobre_ilegible");
  });
});

describe("T-VJ-5: interpretar la vuelta — los tres pasos que sí salen bien", () => {
  it("conectar devuelve dirección y sesión", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ paso: "conectar" }));
    const r = respuestaDeLaBilletera({ public_key: "LaCuenta", session: "LaSesion" }, par.publicKey);
    const v = interpretarVuelta(new URLSearchParams({ [MARCA]: "conectar", ...r }), leerViaje(a, AHORA));
    expect(v).toEqual({ tipo: "conectado", direccion: "LaCuenta", session: "LaSesion" });
  });

  it("firmar-tx devuelve la transacción firmada", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ paso: "firmar-tx", session: "s" }));
    const r = respuestaDeLaBilletera({ transaction: "TxFirmada58" }, par.publicKey);
    const v = interpretarVuelta(new URLSearchParams({ [MARCA]: "firmar-tx", ...r }), leerViaje(a, AHORA));
    expect(v).toEqual({ tipo: "tx-firmada", transaccionBase58: "TxFirmada58" });
  });

  it("firmar-patrocinio devuelve la firma", () => {
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ paso: "firmar-patrocinio", session: "s" }));
    const r = respuestaDeLaBilletera({ signature: "FirmaPoP" }, par.publicKey);
    const v = interpretarVuelta(new URLSearchParams({ [MARCA]: "firmar-patrocinio", ...r }), leerViaje(a, AHORA));
    expect(v).toEqual({ tipo: "patrocinio-firmado", firma: "FirmaPoP" });
  });

  it("la respuesta se lee con el paso que dice la URL, no con el que quedó guardado", () => {
    // 🔴 Si se leyera por `viaje.paso`, una vuelta de `firmar-tx` sobre un viaje cuyo disco quedó en
    // `conectar` se interpretaría como una conexión, y la pantalla creería tener una dirección que
    // nadie le dio. Los dos campos existen y pueden divergir; manda la URL, que es la que trae la
    // respuesta que estamos leyendo.
    const a = almacenFalso();
    guardarViaje(a, viajeBase({ paso: "conectar", session: "s" }));
    const r = respuestaDeLaBilletera({ transaction: "T58" }, par.publicKey);
    const v = interpretarVuelta(new URLSearchParams({ [MARCA]: "firmar-tx", ...r }), leerViaje(a, AHORA));
    expect(v.tipo).toBe("tx-firmada");
  });
});
