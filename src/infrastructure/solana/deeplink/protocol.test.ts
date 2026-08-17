// OLA 1 · CANDADOS DEL PROTOCOLO DE ENLACES PROFUNDOS.
//
// 🔬 CÓMO SE PRUEBA ALGO QUE HABLA CON UNA APP DE TERCEROS SIN TENER LA APP. Este archivo implementa
// **el otro lado**: una billetera de mentira que hace exactamente lo que dice la documentación de
// Phantom y de Solflare (genera su par x25519, deriva el mismo secreto por Diffie-Hellman, cifra la
// respuesta con `nacl.box.after`). Si nuestro `leerRespuesta` abre ese sobre, es porque el esquema
// que implementamos es el que ellos describen.
//
// ⚠️ LO QUE ESTO **NO** PRUEBA, y hay que decirlo antes de que alguien lea el verde como una
// promesa: que Phantom y Solflare de verdad se comporten así. Acá no hay ninguna app de billetera.
// Esto verifica que nuestra mitad es coherente con la documentación; que la documentación describa
// el comportamiento real sólo lo prueba un teléfono. Es la misma frontera que ya declara
// `wallet-availability.test.tsx` sobre Mobile Wallet Adapter.
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  type BilleteraDeeplink,
  type DatosDeConexion,
  leerRespuesta,
  nuevoParDeCifrado,
  urlConectar,
  urlFirmarMensaje,
  urlFirmarTransaccion,
} from "./protocol";

const LAS_DOS: BilleteraDeeplink[] = ["phantom", "solflare"];
const CLAVE_EN_RESPUESTA: Record<BilleteraDeeplink, string> = {
  phantom: "phantom_encryption_public_key",
  solflare: "solflare_encryption_public_key",
};

/** La billetera de mentira: hace lo que dicen las dos documentaciones, ni más ni menos. */
function billeteraQueContesta(publicaDeLaApp: Uint8Array, cuerpo: unknown) {
  const suyo = nacl.box.keyPair();
  const secreto = nacl.box.before(publicaDeLaApp, suyo.secretKey);
  const nonce = nacl.randomBytes(24);
  const data = nacl.box.after(new TextEncoder().encode(JSON.stringify(cuerpo)), nonce, secreto);
  return { clave: bs58.encode(suyo.publicKey), nonce: bs58.encode(nonce), data: bs58.encode(data) };
}

describe("T-DL-1: el pedido de conectar", () => {
  it.each(LAS_DOS)("%s · va al host correcto y lleva los cuatro parámetros obligatorios", (billetera) => {
    const par = nuevoParDeCifrado();
    const u = new URL(
      urlConectar({
        billetera,
        appUrl: "https://chaski-v2.vercel.app",
        redirectLink: "https://chaski-v2.vercel.app/?dl=connect",
        clavePublicaDeLaApp: par.publica,
        cluster: "devnet",
      }),
    );
    expect(u.host).toBe(billetera === "phantom" ? "phantom.app" : "solflare.com");
    expect(u.pathname).toBe("/ul/v1/connect");
    for (const p of ["app_url", "dapp_encryption_public_key", "redirect_link", "cluster"]) {
      expect(u.searchParams.get(p), `falta ${p}`).toBeTruthy();
    }
  });

  it.each(LAS_DOS)("%s · el cluster viaja EXPLÍCITO, porque el default de las dos es mainnet", (billetera) => {
    // 🔴 ESTE `it` NO ES BUROCRACIA. Las dos billeteras asumen `mainnet-beta` si el parámetro falta.
    // Omitirlo haría que la persona autorice sobre la red equivocada, y en una app de plata eso no es
    // un detalle de configuración. MUTANTE QUE MATA: borrar `cluster` de `urlConectar`.
    const u = new URL(
      urlConectar({
        billetera,
        appUrl: "https://x.test",
        redirectLink: "https://x.test/?dl=connect",
        clavePublicaDeLaApp: nuevoParDeCifrado().publica,
        cluster: "devnet",
      }),
    );
    expect(u.searchParams.get("cluster")).toBe("devnet");
  });

  it("el connect NO va cifrado, y es correcto: todavía no hay secreto compartido", () => {
    const u = new URL(
      urlConectar({
        billetera: "phantom",
        appUrl: "https://x.test",
        redirectLink: "https://x.test/?dl=connect",
        clavePublicaDeLaApp: nuevoParDeCifrado().publica,
        cluster: "devnet",
      }),
    );
    expect(u.searchParams.get("payload")).toBeNull();
    expect(u.searchParams.get("nonce")).toBeNull();
  });
});

describe("T-DL-2: la vuelta del connect se abre y se lee", () => {
  it.each(LAS_DOS)("%s · ida y vuelta completa contra una billetera que sigue la documentación", (billetera) => {
    const par = nuevoParDeCifrado();
    const r = billeteraQueContesta(par.publica, { public_key: "EjPubKey", session: "sesion-opaca" });
    const params = new URLSearchParams({
      [CLAVE_EN_RESPUESTA[billetera]]: r.clave,
      nonce: r.nonce,
      data: r.data,
    });
    const d = leerRespuesta<DatosDeConexion>(billetera, params, par.secreta);
    expect(d.tipo).toBe("ok");
    if (d.tipo !== "ok") return;
    expect(d.datos.public_key).toBe("EjPubKey");
    expect(d.datos.session).toBe("sesion-opaca");
  });

  it("una respuesta de Phantom NO se lee como Solflare: el nombre de la clave los distingue", () => {
    // Sin esto, un solo nombre de parámetro serviría para los dos y el mapa sobraría — o peor,
    // leeríamos la respuesta de una billetera creyendo que es de la otra.
    const par = nuevoParDeCifrado();
    const r = billeteraQueContesta(par.publica, { public_key: "A", session: "B" });
    const params = new URLSearchParams({ phantom_encryption_public_key: r.clave, nonce: r.nonce, data: r.data });
    expect(leerRespuesta("solflare", params, par.secreta).tipo).toBe("ninguno");
  });
});

describe("T-DL-3: los TRES desenlaces, y que ninguno colapsa en otro", () => {
  it("«ninguno» cuando la URL no trae respuesta: entrar a la página de frente NO es cancelar", () => {
    // 🔴 EL `it` MÁS IMPORTANTE DEL ARCHIVO. Colapsar esto en «rechazo» le diría "cancelaste" a
    // alguien que nunca fue a ninguna billetera. Ya pasó con Mobile Wallet Adapter y costó una noche.
    // MUTANTE QUE MATA: devolver `rechazo` cuando falta alguno de los tres parámetros.
    const par = nuevoParDeCifrado();
    expect(leerRespuesta("phantom", new URLSearchParams(""), par.secreta).tipo).toBe("ninguno");
    expect(leerRespuesta("phantom", new URLSearchParams({ nonce: "x" }), par.secreta).tipo).toBe("ninguno");
  });

  it("«rechazo» cuando la billetera lo dice con errorCode, y el código llega tal cual", () => {
    const par = nuevoParDeCifrado();
    const d = leerRespuesta(
      "phantom",
      new URLSearchParams({ errorCode: "4001", errorMessage: "User rejected the request." }),
      par.secreta,
    );
    expect(d.tipo).toBe("rechazo");
    if (d.tipo !== "rechazo") return;
    expect(d.codigo).toBe("4001");
    expect(d.mensaje).toContain("rejected");
  });

  it("«rechazo» con sobre_ilegible si la clave secreta no es la del viaje, y NO revienta", () => {
    // Pasa de verdad: dos pestañas, o alguien que reabrió el enlace viejo. Tiene que ser un desenlace
    // del viaje, no una excepción que rompa la pantalla.
    const delViaje = nuevoParDeCifrado();
    const otra = nuevoParDeCifrado();
    const r = billeteraQueContesta(delViaje.publica, { public_key: "A", session: "B" });
    const params = new URLSearchParams({ phantom_encryption_public_key: r.clave, nonce: r.nonce, data: r.data });
    const d = leerRespuesta("phantom", params, otra.secreta);
    expect(d.tipo).toBe("rechazo");
    if (d.tipo !== "rechazo") return;
    expect(d.codigo).toBe("sobre_ilegible");
  });

  it("basura en base58 tampoco revienta: cae en rechazo", () => {
    const par = nuevoParDeCifrado();
    const params = new URLSearchParams({
      phantom_encryption_public_key: "no-es-base58-000",
      nonce: "!!!",
      data: "???",
    });
    expect(() => leerRespuesta("phantom", params, par.secreta)).not.toThrow();
    expect(leerRespuesta("phantom", params, par.secreta).tipo).toBe("rechazo");
  });
});

describe("T-DL-4: firmar la transacción, SIN que la billetera la envíe", () => {
  it.each(LAS_DOS)("%s · pega en /signTransaction y NUNCA en /signAndSendTransaction", (billetera) => {
    // ⛔ El depósito de Chaski es PATROCINADO: el facilitator es el feePayer y transmite él, después
    // de verificar. Si la billetera lo mandara sola, se rompe ese diseño entero.
    // MUTANTE QUE MATA: cambiar el método por `signAndSendTransaction`.
    const par = nuevoParDeCifrado();
    const u = new URL(
      urlFirmarTransaccion({
        billetera,
        appUrl: "https://x.test",
        redirectLink: "https://x.test/?dl=sign",
        clavePublicaDeLaApp: par.publica,
        secreto: nacl.box.before(nuevoParDeCifrado().publica, par.secreta),
        session: "s",
        transaccionBase58: "3QJmV3qfvL9SuYo34YihAf3sRCW3qSinyC8hDeaneiTX",
      }),
    );
    expect(u.pathname).toBe("/ul/v1/signTransaction");
    expect(u.pathname).not.toContain("signAndSend");
    expect(u.searchParams.get("payload")).toBeTruthy();
    expect(u.searchParams.get("nonce")).toBeTruthy();
  });

  it("el sobre lo abre la billetera y adentro está la transacción y la sesión", () => {
    // Se verifica lo que VIAJA, no sólo que haya un parámetro: un `payload` con basura adentro
    // pasaría un test que sólo mire que existe.
    const app = nuevoParDeCifrado();
    const wallet = nacl.box.keyPair();
    const secretoApp = nacl.box.before(wallet.publicKey, app.secreta);
    const u = new URL(
      urlFirmarTransaccion({
        billetera: "phantom",
        appUrl: "https://x.test",
        redirectLink: "https://x.test/?dl=sign",
        clavePublicaDeLaApp: app.publica,
        secreto: secretoApp,
        session: "la-sesion",
        transaccionBase58: "TxEnBase58",
      }),
    );
    const secretoWallet = nacl.box.before(app.publica, wallet.secretKey);
    const abierto = nacl.box.open.after(
      bs58.decode(u.searchParams.get("payload") as string),
      bs58.decode(u.searchParams.get("nonce") as string),
      secretoWallet,
    );
    expect(abierto).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(abierto as Uint8Array))).toEqual({
      transaction: "TxEnBase58",
      session: "la-sesion",
    });
  });

  it("dos pedidos seguidos usan nonces DISTINTOS", () => {
    // Un nonce repetido con el mismo secreto rompe la garantía de la caja. Que salga de
    // `nacl.randomBytes` no lo prueba: alguien podría fijarlo "para que los tests sean estables".
    const app = nuevoParDeCifrado();
    const secreto = nacl.box.before(nuevoParDeCifrado().publica, app.secreta);
    const comun = {
      billetera: "phantom" as const,
      appUrl: "https://x.test",
      redirectLink: "https://x.test/?dl=sign",
      clavePublicaDeLaApp: app.publica,
      secreto,
      session: "s",
      transaccionBase58: "T",
    };
    const a = new URL(urlFirmarTransaccion(comun)).searchParams.get("nonce");
    const b = new URL(urlFirmarTransaccion(comun)).searchParams.get("nonce");
    expect(a).not.toBe(b);
  });
});

describe("T-DL-5: firmar el mensaje de patrocinio", () => {
  it.each(LAS_DOS)("%s · pega en /signMessage y pide que la persona LEA lo que firma", (billetera) => {
    // `display: "utf8"` hace que la billetera muestre el texto en vez de un bloque de bytes. El
    // mensaje canónico de SDD 037 existe justamente para que se pueda leer; mandarlo en hexa sería
    // conservar la firma y tirar el motivo de que exista.
    const app = nuevoParDeCifrado();
    const wallet = nacl.box.keyPair();
    const secretoApp = nacl.box.before(wallet.publicKey, app.secreta);
    const u = new URL(
      urlFirmarMensaje({
        billetera,
        appUrl: "https://x.test",
        redirectLink: "https://x.test/?dl=pop",
        clavePublicaDeLaApp: app.publica,
        secreto: secretoApp,
        session: "s",
        mensaje: new TextEncoder().encode("Chaski · autorizás el patrocinio de..."),
      }),
    );
    expect(u.pathname).toBe("/ul/v1/signMessage");
    const abierto = nacl.box.open.after(
      bs58.decode(u.searchParams.get("payload") as string),
      bs58.decode(u.searchParams.get("nonce") as string),
      nacl.box.before(app.publica, wallet.secretKey),
    );
    const dentro = JSON.parse(new TextDecoder().decode(abierto as Uint8Array));
    expect(dentro.display).toBe("utf8");
    expect(new TextDecoder().decode(bs58.decode(dentro.message))).toContain("autorizás el patrocinio");
  });
});

describe("T-DL-0(instrumento): la billetera de mentira de este archivo sirve para medir", () => {
  it("si el secreto NO coincide, la billetera de mentira produce algo que NO se abre", () => {
    // Se mide el instrumento antes de usarlo. Si `billeteraQueContesta` produjera algo que abre con
    // cualquier clave, todos los `it` de arriba serían vacuamente verdes.
    const app = nuevoParDeCifrado();
    const r = billeteraQueContesta(app.publica, { public_key: "A", session: "B" });
    const params = new URLSearchParams({ phantom_encryption_public_key: r.clave, nonce: r.nonce, data: r.data });
    expect(leerRespuesta("phantom", params, app.secreta).tipo).toBe("ok");
    expect(leerRespuesta("phantom", params, nuevoParDeCifrado().secreta).tipo).toBe("rechazo");
  });
});
