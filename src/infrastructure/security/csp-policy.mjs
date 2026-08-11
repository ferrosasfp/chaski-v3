// La política de Content-Security-Policy de la DApp.
//
// ── ESTA POLÍTICA BLOQUEA, Y SE VALIDÓ CON UN RECORRIDO REAL ANTES DE HACERLO ───────────────────
//
// Un CSP mal puesto en esta app no se manifiesta como una página rota: se manifiesta AL FIRMAR. El
// árbol del wallet adapter, la conexión al RPC (incluido su WebSocket) y la ventana del proveedor de
// identidad abren conexiones que una política incompleta bloquea, y el usuario lo descubre en el peor
// momento posible — con la transacción armada. Por eso la primera vuelta corrió en `Report-Only`,
// sin bloquear nada, y la persona que firma recorrió la aplicación completa mientras el navegador
// reportaba qué HABRÍA bloqueado.
//
// RESULTADO DE ESE RECORRIDO (2026-08-11, cotización → 3 firmas → depósito de 12 USDC confirmado en
// devnet): **cero violaciones atribuibles a esta aplicación.** En particular cero de `connect-src`,
// que era el riesgo real — ni las llamadas JSON-RPC ni el WebSocket del RPC se bloquearon.
//
// ⚠️ SÍ HUBO CINCO VIOLACIONES, Y NINGUNA ES DE ACÁ: las cinco las produce la barra de herramientas
// que Vercel inyecta (`vercel.live/_next-live/feedback/feedback.js`), que carga su propia tipografía
// desde Google Fonts y necesita `eval`. Se comprobó que no son nuestras midiendo el repo: `DM Sans`
// y `gstatic` no aparecen NI UNA VEZ en el código, el HTML servido ni el JS de la app, y ningún
// chunk del cliente contiene `eval(`. La tipografía propia es Hanken Grotesk vía `next/font/google`,
// que Next **auto-hospeda** al compilar — por eso `font-src 'self' data:` alcanza y no hubo ninguna
// violación por ella.
//
// DECISIÓN, y es la parte que importa: **esas cinco NO se autorizan.** Autorizarlas costaría agregar
// `fonts.googleapis.com`, `fonts.gstatic.com`, `vercel.live` y —lo más caro— `'unsafe-eval'`, o sea
// debilitar permanentemente la política de TODOS los visitantes para acomodar una herramienta que
// sólo ve quien está logueado en Vercel. La barra pierde su tipografía y su widget; la aplicación no
// pierde nada. Si molesta, se apaga la barra en la configuración del proyecto.
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
// ⚠️ Y UNA CORRECCIÓN QUE VALE MÁS QUE LA LISTA: la primera versión de este archivo afirmaba que
// "los únicos orígenes externos son el RPC y vercel.live", medido grepeando el bundle servido. **Era
// incompleto y se presentó como completo.** Google Fonts no aparecía porque la tipografía se pide
// desde un `<link>` del `<head>`, no desde el JavaScript: el método miraba el lugar equivocado. Lo
// destapó el recorrido en `Report-Only`, que es exactamente para lo que existe ese modo. Grepear un
// bundle NO enumera los orígenes de una página.

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
 * Arma el valor de la cabecera. `extraConnectSrc` existe para orígenes que no salen de una env, y se
 * pasa explícito para que quede a la vista de quien lea el config. HOY NO SE USA.
 */
export function buildCspPolicy({ rpcUrl, extraConnectSrc = [], reportUri = "/api/csp-report" } = {}) {
  // `extraConnectSrc` queda para orígenes que no salgan de una env, y HOY VA VACÍO a propósito: lo
  // único que había ahí era `vercel.live`, que resultó ser de la barra de Vercel y no de la app.
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
