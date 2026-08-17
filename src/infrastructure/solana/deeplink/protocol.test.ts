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
  soloTextos,
  urlConectar,
  urlFirmarMensaje,
  urlFirmarTransaccion,
} from "./protocol";

const LAS_DOS: BilleteraDeeplink[] = ["phantom", "solflare"];

// ⛔ ESTE MAPA ESTÁ ESCRITO A MANO A PROPÓSITO. NO lo reemplaces por un `import` de `protocol.ts`
// aunque parezca duplicación: es el ORÁCULO INDEPENDIENTE que hace que `T-DL-2` mida algo. Medido en
// el CR de esta HU: invertir phantom↔solflare en el mapa de producción mata 11 de los tests de este
// archivo. Si acá se importara el mapa, ese mutante sobreviviría entero —los dos lados se moverían
// juntos— y `T-DL-2` pasaría a ser vacuamente verde sin que nadie se entere.
const CLAVE_EN_RESPUESTA: Record<BilleteraDeeplink, string> = {
  phantom: "phantom_encryption_public_key",
  solflare: "solflare_encryption_public_key",
};

/** El validador del cuerpo del connect. Tipado con `DatosDeConexion` para que los dos no se despeguen. */
const FORMA_CONEXION: (crudo: unknown) => DatosDeConexion | null = soloTextos("public_key", "session");

/**
 * La billetera de mentira: hace lo que dicen las dos documentaciones, ni más ni menos.
 *
 * `cuerpoCrudo` existe para poder cifrar algo que NO es JSON, que es lo único que ejercita la rama
 * `json_ilegible`. Ninguna billetera que siga la documentación produce eso; una app rota, sí.
 */
function billeteraQueContesta(publicaDeLaApp: Uint8Array, cuerpo: unknown, cuerpoCrudo?: string) {
  const suyo = nacl.box.keyPair();
  const secreto = nacl.box.before(publicaDeLaApp, suyo.secretKey);
  const nonce = nacl.randomBytes(24);
  const texto = cuerpoCrudo ?? JSON.stringify(cuerpo);
  const data = nacl.box.after(new TextEncoder().encode(texto), nonce, secreto);
  return { clave: bs58.encode(suyo.publicKey), nonce: bs58.encode(nonce), data: bs58.encode(data) };
}

describe("T-DL-1: el pedido de conectar", () => {
  it.each(LAS_DOS)("%s · va al host correcto y cada parámetro lleva SU valor", (billetera) => {
    // 🔴 ESTE `it` VERIFICA VALORES Y NO PRESENCIA, y la diferencia se midió: mientras sólo pedía
    // `toBeTruthy()` sobre los cuatro nombres, INTERCAMBIAR `app_url` con `redirect_link` dejaba los
    // 38 tests en verde. Con el intercambio puesto, la billetera devuelve a `https://chaski-v2...`
    // SIN la marca `dl`, `interpretarVuelta` contesta `no-volvimos`, y la persona firma sin que la
    // app se entere nunca. `redirect_link` es el mecanismo entero de esta HU.
    // MUTANTE QUE MATA: intercambiar los valores de `app_url` y `redirect_link` en `urlConectar`.
    const par = nuevoParDeCifrado();
    const u = new URL(
      urlConectar({
        billetera,
        appUrl: "https://chaski-v2.vercel.app",
        redirectLink: "https://chaski-v2.vercel.app/?dl=conectar",
        clavePublicaDeLaApp: par.publica,
        cluster: "devnet",
      }),
    );
    expect(u.host).toBe(billetera === "phantom" ? "phantom.app" : "solflare.com");
    expect(u.pathname).toBe("/ul/v1/connect");
    expect(u.searchParams.get("app_url")).toBe("https://chaski-v2.vercel.app");
    expect(u.searchParams.get("redirect_link")).toBe("https://chaski-v2.vercel.app/?dl=conectar");
    expect(u.searchParams.get("dapp_encryption_public_key")).toBe(bs58.encode(par.publica));
    expect(u.searchParams.get("cluster")).toBe("devnet");
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
    const d = leerRespuesta(billetera, params, par.secreta, FORMA_CONEXION);
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
    expect(leerRespuesta("solflare", params, par.secreta, FORMA_CONEXION).tipo).toBe("ninguno");
  });
});

describe("T-DL-6: la forma del cuerpo descifrado se valida, no se castea", () => {
  it("un cuerpo sin los campos esperados es «forma_inesperada», no un «ok» con undefined adentro", () => {
    // 🔴 Medido antes del arreglo: `{ ok: true }` en el paso conectar devolvía
    // `{ tipo: "ok", datos: { ... } }` con `public_key === undefined` TIPADO `string`, y ese
    // `undefined` seguía viaje hacia el facilitator disfrazado de dirección. El `as T` no es una
    // verificación: es una afirmación sobre datos de un tercero.
    // MUTANTE QUE MATA: volver a `JSON.parse(...) as T` sin llamar a `forma`.
    const par = nuevoParDeCifrado();
    const r = billeteraQueContesta(par.publica, { ok: true });
    const params = new URLSearchParams({ phantom_encryption_public_key: r.clave, nonce: r.nonce, data: r.data });
    const d = leerRespuesta("phantom", params, par.secreta, FORMA_CONEXION);
    expect(d.tipo).toBe("rechazo");
    if (d.tipo !== "rechazo") return;
    expect(d.codigo).toBe("forma_inesperada");
  });

  it("una cadena VACÍA no es un campo presente: `public_key: \"\"` no es una cuenta", () => {
    // 🔴 MEDIDO EN EL RE-AR: un connect con `{"public_key":"","session":""}` salía
    // `{"tipo":"conectado","direccion":"","session":""}`. El validador exigía que el campo fuera un
    // `string` y no que tuviera contenido, así que una cadena vacía viajaba hacia el camino del
    // dinero disfrazada de cuenta de Solana. Es el mismo defecto que el `undefined` tipado `string`
    // que este bloque ya cerraba, con otra máscara: el tipo se cumple y el valor no existe.
    // MUTANTE QUE MATA: sacar el `|| v === ""` de `soloTextos`.
    const par = nuevoParDeCifrado();
    const r = billeteraQueContesta(par.publica, { public_key: "", session: "" });
    const params = new URLSearchParams({ phantom_encryption_public_key: r.clave, nonce: r.nonce, data: r.data });
    const d = leerRespuesta("phantom", params, par.secreta, FORMA_CONEXION);
    expect(d.tipo).toBe("rechazo");
    if (d.tipo !== "rechazo") return;
    expect(d.codigo).toBe("forma_inesperada");
  });

  it("y basta con que UNO de los dos venga vacío", () => {
    // El control de granularidad: un validador que sólo mirara el primer campo pasaría el `it` de
    // arriba. Acá `public_key` es legítimo y `session` está vacío.
    const par = nuevoParDeCifrado();
    const r = billeteraQueContesta(par.publica, { public_key: "EjPubKey", session: "" });
    const params = new URLSearchParams({ phantom_encryption_public_key: r.clave, nonce: r.nonce, data: r.data });
    expect(leerRespuesta("phantom", params, par.secreta, FORMA_CONEXION).tipo).toBe("rechazo");
  });

  it("un cuerpo que falta UN campo de dos tampoco pasa", () => {
    // El caso alcanzable sin billetera hostil: el mismo secreto compartido sirve para los tres
    // pasos, así que un sobre del paso 2 se descifra perfecto si se lo lee como paso 3.
    const par = nuevoParDeCifrado();
    const r = billeteraQueContesta(par.publica, { public_key: "A" });
    const params = new URLSearchParams({ phantom_encryption_public_key: r.clave, nonce: r.nonce, data: r.data });
    const d = leerRespuesta("phantom", params, par.secreta, FORMA_CONEXION);
    expect(d.tipo).toBe("rechazo");
    if (d.tipo !== "rechazo") return;
    expect(d.codigo).toBe("forma_inesperada");
  });

  it.each([
    ["null", "null"],
    ["un escalar", '"solo-un-string"'],
    ["una lista", "[1,2,3]"],
  ])("%s adentro del sobre NO revienta y NO es «ok»", (_nombre, crudo) => {
    // 🔴 `null` era el peor: `JSON.parse("null") as T` pasaba el cast y el mapper reventaba con
    // `Cannot read properties of null (reading 'transaction')` — excepción no capturada MEDIDA, en
    // la función que el docblock promete que "NO revienta".
    const par = nuevoParDeCifrado();
    const r = billeteraQueContesta(par.publica, undefined, crudo);
    const params = new URLSearchParams({ phantom_encryption_public_key: r.clave, nonce: r.nonce, data: r.data });
    expect(() => leerRespuesta("phantom", params, par.secreta, FORMA_CONEXION)).not.toThrow();
    expect(leerRespuesta("phantom", params, par.secreta, FORMA_CONEXION).tipo).toBe("rechazo");
  });

  it("un sobre que abre pero NO trae JSON es «json_ilegible», y esa rama existe", () => {
    // Esta rama del código nunca la había ejecutado ningún test: la billetera de mentira siempre
    // cifraba `JSON.stringify(...)`, así que era imposible llegar. Medido: reemplazarla entera por
    // un `ok` sobrevivía a los 38 tests.
    // MUTANTE QUE MATA: devolver `{ tipo: "ok" }` en vez de `json_ilegible`.
    const par = nuevoParDeCifrado();
    const r = billeteraQueContesta(par.publica, undefined, "{esto no es json");
    const params = new URLSearchParams({ phantom_encryption_public_key: r.clave, nonce: r.nonce, data: r.data });
    const d = leerRespuesta("phantom", params, par.secreta, FORMA_CONEXION);
    expect(d.tipo).toBe("rechazo");
    if (d.tipo !== "rechazo") return;
    expect(d.codigo).toBe("json_ilegible");
  });

  it("«json_ilegible» y «forma_inesperada» NO son el mismo código: se rompieron cosas distintas", () => {
    // Uno dice "lo que mandaron no es JSON", el otro "es JSON y no tiene lo que hace falta". Quien
    // los mezcle pierde la única pista de qué hay que mirar.
    const par = nuevoParDeCifrado();
    const roto = billeteraQueContesta(par.publica, undefined, "{no");
    const otraForma = billeteraQueContesta(par.publica, { ok: true });
    const codigo = (r: { clave: string; nonce: string; data: string }) => {
      const d = leerRespuesta(
        "phantom",
        new URLSearchParams({ phantom_encryption_public_key: r.clave, nonce: r.nonce, data: r.data }),
        par.secreta,
        FORMA_CONEXION,
      );
      return d.tipo === "rechazo" ? d.codigo : d.tipo;
    };
    expect(codigo(roto)).not.toBe(codigo(otraForma));
  });
});

describe("T-DL-3: los TRES desenlaces, y que ninguno colapsa en otro", () => {
  it("«ninguno» cuando la URL no trae respuesta: entrar a la página de frente NO es cancelar", () => {
    // 🔴 EL `it` MÁS IMPORTANTE DEL ARCHIVO. Colapsar esto en «rechazo» le diría "cancelaste" a
    // alguien que nunca fue a ninguna billetera. Ya pasó con Mobile Wallet Adapter y costó una noche.
    // MUTANTE QUE MATA: devolver `rechazo` cuando falta alguno de los tres parámetros.
    const par = nuevoParDeCifrado();
    const forma = FORMA_CONEXION;
    expect(leerRespuesta("phantom", new URLSearchParams(""), par.secreta, forma).tipo).toBe("ninguno");
    expect(
      leerRespuesta("phantom", new URLSearchParams({ nonce: "x" }), par.secreta, forma).tipo,
    ).toBe("ninguno");
  });

  it("«rechazo» cuando la billetera lo dice con errorCode, y el código llega tal cual", () => {
    const par = nuevoParDeCifrado();
    const d = leerRespuesta(
      "phantom",
      new URLSearchParams({ errorCode: "4001", errorMessage: "User rejected the request." }),
      par.secreta,
      FORMA_CONEXION,
    );
    expect(d.tipo).toBe("rechazo");
    if (d.tipo !== "rechazo") return;
    expect(d.codigo).toBe("4001");
    expect(d.mensaje).toContain("rejected");
    expect(d.origen).toBe("billetera");
  });

  it("el `origen` separa lo que escribe la URL de lo que escribimos nosotros", () => {
    // 🔴 MEDIDO EN EL CR: `?errorCode=sobre_ilegible` fabricado a mano y un fallo real de cripto de
    // este archivo devolvían el MISMO objeto. El `errorCode` no está autenticado —lo escribe quien
    // arme la URL— así que fundir su espacio de valores con el de nuestros diagnósticos internos
    // dejaba que cualquiera se hiciera pasar por un fallo nuestro, y al revés.
    //
    // El candado mira los TRES códigos nuestros y no sólo uno: el defecto era del campo, no de un
    // valor, así que un `origen` puesto a mano en una sola de las tres ramas no debe alcanzar.
    // MUTANTE QUE MATA: devolver `origen: "billetera"` en cualquiera de las tres ramas internas de
    // `leerRespuesta`, o `origen: "nuestro"` en la rama del `errorCode`.
    const par = nuevoParDeCifrado();
    const codigoYOrigen = (params: URLSearchParams, secreta = par.secreta) => {
      const d = leerRespuesta("phantom", params, secreta, FORMA_CONEXION);
      return d.tipo === "rechazo" ? `${d.origen}:${d.codigo}` : d.tipo;
    };
    const conSobre = (r: { clave: string; nonce: string; data: string }) =>
      new URLSearchParams({ phantom_encryption_public_key: r.clave, nonce: r.nonce, data: r.data });

    // Los tres nuestros.
    expect(codigoYOrigen(conSobre(billeteraQueContesta(par.publica, { public_key: "A", session: "B" })), nuevoParDeCifrado().secreta)).toBe("nuestro:sobre_ilegible");
    expect(codigoYOrigen(conSobre(billeteraQueContesta(par.publica, undefined, "{no")))).toBe("nuestro:json_ilegible");
    expect(codigoYOrigen(conSobre(billeteraQueContesta(par.publica, { ok: true })))).toBe("nuestro:forma_inesperada");

    // Y los MISMOS tres nombres, fabricados a mano en la URL, salen del otro lado. Ésta es la
    // colisión exacta que el CR midió: sin `origen`, estas seis llamadas dan tres pares idénticos.
    for (const codigo of ["sobre_ilegible", "json_ilegible", "forma_inesperada"]) {
      expect(codigoYOrigen(new URLSearchParams({ errorCode: codigo }))).toBe(`billetera:${codigo}`);
    }
  });

  it("«rechazo» con sobre_ilegible si la clave secreta no es la del viaje, y NO revienta", () => {
    // Pasa de verdad: dos pestañas, o alguien que reabrió el enlace viejo. Tiene que ser un desenlace
    // del viaje, no una excepción que rompa la pantalla.
    const delViaje = nuevoParDeCifrado();
    const otra = nuevoParDeCifrado();
    const r = billeteraQueContesta(delViaje.publica, { public_key: "A", session: "B" });
    const params = new URLSearchParams({ phantom_encryption_public_key: r.clave, nonce: r.nonce, data: r.data });
    const d = leerRespuesta("phantom", params, otra.secreta, FORMA_CONEXION);
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
    expect(() => leerRespuesta("phantom", params, par.secreta, FORMA_CONEXION)).not.toThrow();
    expect(leerRespuesta("phantom", params, par.secreta, FORMA_CONEXION).tipo).toBe("rechazo");
  });
});

describe("T-DL-4: firmar la transacción, SIN que la billetera la envíe", () => {
  it.each(LAS_DOS)("%s · pega en /signTransaction y NUNCA en /signAndSendTransaction", (billetera) => {
    // ⛔ El depósito de Chaski es PATROCINADO: el facilitator es el feePayer y transmite él, después
    // de verificar. Si la billetera lo mandara sola, se rompe ese diseño entero.
    // MUTANTE QUE MATA: cambiar el método por `signAndSendTransaction`.
    //
    // 🔴 Y ADEMÁS SE CONGELAN LOS PARÁMETROS, que es lo que este `it` no hacía. Medido: borrar
    // `redirect_link`, borrar `dapp_encryption_public_key` o mandar las dos billeteras a
    // `phantom.app` sobrevivía a los 38 tests. Ninguna de esas tres roturas hace ruido: producen un
    // viaje que se firma y no vuelve nunca, en el paso donde se firma el depósito. El `it.each` de
    // dos billeteras DABA LA APARIENCIA de distinguirlas y sólo miraba el `pathname`, que es igual
    // para las dos.
    // MUTANTES QUE MATA: borrar `redirect_link`; borrar `dapp_encryption_public_key`; usar
    // `BASE.phantom` fijo en vez de `BASE[d.billetera]`.
    const par = nuevoParDeCifrado();
    const u = new URL(
      urlFirmarTransaccion({
        billetera,
        appUrl: "https://x.test",
        redirectLink: "https://x.test/?dl=firmar-tx",
        clavePublicaDeLaApp: par.publica,
        secreto: nacl.box.before(nuevoParDeCifrado().publica, par.secreta),
        session: "s",
        transaccionBase58: "3QJmV3qfvL9SuYo34YihAf3sRCW3qSinyC8hDeaneiTX",
      }),
    );
    expect(u.host).toBe(billetera === "phantom" ? "phantom.app" : "solflare.com");
    expect(u.pathname).toBe("/ul/v1/signTransaction");
    expect(u.pathname).not.toContain("signAndSend");
    expect(u.searchParams.get("redirect_link")).toBe("https://x.test/?dl=firmar-tx");
    expect(u.searchParams.get("dapp_encryption_public_key")).toBe(bs58.encode(par.publica));
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
    // Mismos tres candados que en T-DL-4, por la misma razón: éste es el paso del patrocinio y sus
    // parámetros tampoco los miraba nadie.
    // MUTANTES QUE MATA: borrar `redirect_link`; borrar `dapp_encryption_public_key`; host fijo.
    const u = new URL(
      urlFirmarMensaje({
        billetera,
        appUrl: "https://x.test",
        redirectLink: "https://x.test/?dl=firmar-patrocinio",
        clavePublicaDeLaApp: app.publica,
        secreto: secretoApp,
        session: "s",
        mensaje: new TextEncoder().encode("Chaski · autorizás el patrocinio de..."),
      }),
    );
    expect(u.host).toBe(billetera === "phantom" ? "phantom.app" : "solflare.com");
    expect(u.pathname).toBe("/ul/v1/signMessage");
    expect(u.searchParams.get("redirect_link")).toBe("https://x.test/?dl=firmar-patrocinio");
    expect(u.searchParams.get("dapp_encryption_public_key")).toBe(bs58.encode(app.publica));
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
    expect(leerRespuesta("phantom", params, app.secreta, FORMA_CONEXION).tipo).toBe("ok");
    expect(
      leerRespuesta("phantom", params, nuevoParDeCifrado().secreta, FORMA_CONEXION).tipo,
    ).toBe("rechazo");
  });
});
