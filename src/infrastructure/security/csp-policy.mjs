// La política de Content-Security-Policy de la DApp.
//
// ── POR QUÉ ARRANCA EN `Report-Only` ────────────────────────────────────────────────────────────
//
// Un CSP mal puesto en esta app no se manifiesta como una página rota: se manifiesta AL FIRMAR. El
// árbol del wallet adapter, la conexión al RPC (incluido su WebSocket) y la ventana del proveedor de
// identidad abren conexiones que una política incompleta bloquea, y el usuario lo descubre en el peor
// momento posible — con la transacción armada. Por eso la primera vuelta NO bloquea nada: el
// navegador sólo REPORTA qué habría bloqueado, contra `/api/csp-report`, y la política definitiva se
// arma con ese dato en vez de con una lista de dominios sacada a mano del código.
//
// ── EL ORIGEN DEL RPC SE DERIVA, NO SE COPIA ────────────────────────────────────────────────────
//
// `connect-src` sale de `NEXT_PUBLIC_SOLANA_RPC_URL`, que es LA MISMA variable con la que el
// navegador construye su `Connection`. Escribir `api.devnet.solana.com` a mano acá crearía dos
// listas que tienen que coincidir y que nada obliga a coincidir: el día que esa env apunte a otro
// proveedor, la política seguiría autorizando el anterior y bloquearía el nuevo. El síntoma sería,
// otra vez, una firma que falla.
//
// De una URL `https://host` se derivan DOS orígenes: el `https://` de las llamadas JSON-RPC y el
// `wss://` de las suscripciones. web3.js abre el WebSocket solo, derivando el host de la misma URL;
// omitirlo bloquea la confirmación de transacciones y no el envío, que es justo el modo de falla más
// confuso de diagnosticar.
//
// ── LO QUE ESTA POLÍTICA TODAVÍA NO PUEDE AFIRMAR ───────────────────────────────────────────────
//
// ⚠️ `script-src` incluye `'unsafe-inline'`. Next.js inyecta scripts en línea para hidratar, y la
// alternativa correcta es un nonce por request, que exige mover las cabeceras a un middleware. Con
// `'unsafe-inline'` presente, `script-src` NO protege contra XSS inyectado en el HTML: es la
// directiva más importante de la política y hoy es la más débil. Está así para que la primera vuelta
// mida el resto sin ahogarse en ruido, y el nonce es el paso siguiente, no un detalle.
//
// ⚠️ Esta lista se escribió leyendo el bundle SERVIDO (los únicos orígenes externos que aparecen son
// el RPC y `vercel.live`), no adivinando. Aun así es una hipótesis hasta que el recorrido real la
// confirme: por eso `Report-Only`.

/** Deriva `https://host` y `wss://host` de la URL del RPC. Devuelve `[]` si la URL no sirve. */
export function rpcOrigins(rpcUrl) {
  if (typeof rpcUrl !== "string" || rpcUrl.trim() === "") return [];
  let u;
  try {
    u = new URL(rpcUrl);
  } catch {
    // Una URL rota NO se convierte en un origen inventado. Sin orígenes, el recorrido va a reportar
    // el bloqueo del RPC y eso es exactamente lo que hay que ver.
    return [];
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return [];
  const ws = u.protocol === "https:" ? "wss:" : "ws:";
  return [`${u.protocol}//${u.host}`, `${ws}//${u.host}`];
}

/**
 * Arma el valor de la cabecera. `extraConnectSrc` existe para orígenes que no salen de una env
 * (hoy: la barra de Vercel), y se pasa explícito para que quede a la vista de quien lea el config.
 */
export function buildCspPolicy({ rpcUrl, extraConnectSrc = [], reportUri = "/api/csp-report" } = {}) {
  const connect = ["'self'", ...rpcOrigins(rpcUrl), ...extraConnectSrc];
  const directivas = [
    // Todo lo que no tenga su propia directiva cae acá: mismo origen y nada más.
    ["default-src", ["'self'"]],
    // Impide que una inyección reescriba la base de las URLs relativas.
    ["base-uri", ["'self'"]],
    // No hay <object>/<embed> en la app; declararlo cierra un vector clásico.
    ["object-src", ["'none'"]],
    // Equivalente moderno de X-Frame-Options: DENY, que la app ya manda.
    ["frame-ancestors", ["'none'"]],
    // Un formulario inyectado no puede postear los datos a otro host.
    ["form-action", ["'self'"]],
    ["script-src", ["'self'", "'unsafe-inline'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // `data:` para los iconos de las billeteras, que el adapter embebe; `blob:` para QR generados.
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", connect],
    ["frame-src", ["'self'"]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    // `report-uri` está deprecado y es el que TODOS los navegadores implementan hoy; `report-to`
    // es el sucesor y necesita además la cabecera `Reporting-Endpoints`. Se mandan los dos: sin el
    // viejo se pierden los reportes de los navegadores que no implementan el nuevo, y perder
    // reportes en la única vuelta de medición es perder el recorrido de una persona.
    ["report-uri", [reportUri]],
    ["report-to", ["csp"]],
  ];
  return directivas.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}
