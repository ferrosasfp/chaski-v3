// El ORIGEN de una URL, y nada más (WKH-366 · fix-pack AR/BLQ-ALTO-1). PURO: cero `process.env`,
// cero red, cero side-effects. Por eso lo puede importar tanto el transporte (`gateway-kyc-client.ts`)
// como la sonda operativa (`scripts/smoke-kyc-helpers.ts`) sin arrastrarles configuración.
//
// ── POR QUÉ EXISTE ────────────────────────────────────────────────────────────────────────────────
//
// N3 de AC-6 comparaba el par `(slug, registry)` del ejecutor, y el AR midió que **ese par lo publica
// cualquier caller autenticado**: `POST /agents` del Coordinador es auth-only y el slug de
// `a2a_agents` es PK global primero-que-llega, sin scoping por owner; el `registry` de una fila
// self-published sale HARDCODEADO del propio Coordinador, así que apropiarse del slug regala también
// el registry. Los dos campos del par son ELEGIBLES POR EL PUBLICADOR ⇒ no pueden ser lo único que
// sostenga la autorización de un desembolso.
//
// El `invokeUrl` no cierra ese agujero por ser infalsificable —también lo elige el publicador— sino
// por lo contrario: **es la única parte del card que TIENE consecuencia física**. Es la URL a la que
// el Coordinador le habla de verdad. Un impostor que ponga ahí NUESTRO origen consigue que conteste
// NUESTRO agente, o sea que no consigue nada; y si pone el suyo, el origen deja de coincidir con el
// del deploy y esto lo rechaza. La comparación no es contra un dato del catálogo: es contra
// `KYC_AGENT_BASE_URL`, una env del deploy que ningún publicador puede tocar.
//
// ── QUÉ SE COMPARA, Y POR QUÉ ESE RECORTE Y NO OTRO ───────────────────────────────────────────────
//
// Se compara el **origen** (`URL.origin` = esquema + host + puerto no-default), con `===` ESTRICTO.
// Las cinco decisiones de borde, cada una con su motivo, y cada una con su fila en
// `agent-origin.test.ts` (si alguna se cambia, ese archivo se pone rojo):
//
//  1. **Igualdad, NUNCA `endsWith`/`includes`.** Un `endsWith` deja pasar `evil-agentes.test` y
//     `agentes.test.evil.example` — un sufijo se compra registrando un dominio. La igualdad sobre el
//     origen completo hace que el ataque por sufijo sea estructuralmente imposible, no improbable.
//
//  2. **Mayúsculas: no se comparan a mano, las normaliza el parser.** `new URL()` baja el host a
//     minúsculas y aplica punycode por spec WHATWG, así que `https://AGENTES.test` y
//     `https://agentes.test` dan el MISMO origen. ⛔ No se agrega un `.toLowerCase()` encima: sería
//     un segundo normalizador que puede desincronizarse del primero. Se apoya en el parser Y SE
//     MIDE — la fila `HOST` vs `host` del test es lo que impide que esa afirmación envejezca sola.
//
//  3. **El puerto CUENTA, pero el puerto DEFAULT no existe.** `URL.origin` borra `:443` de un
//     `https:` y `:80` de un `http:`, así que `host:443` y `host` son el mismo origen (correcto: son
//     el mismo endpoint). Cualquier OTRO puerto sí discrimina, y tiene que hacerlo: en un host
//     compartido, "otro puerto" es "otro proceso".
//
//  4. **El esquema SÍ entra** (viene incluido en `origin`). No cierra un vector de suplantación —el
//     que no controla el host no sirve ninguno de los dos esquemas— pero sí cierra una DEGRADACIÓN:
//     una fila publicada como `http://<nuestro host>/...` haría que el Coordinador le mande el
//     `decisionToken` a nuestro propio agente EN CLARO. Cuesta cero y no agrega modo de falla nuevo:
//     en prod los dos lados son `https:`.
//
//  5. **La RUTA queda AFUERA, y es obligatorio que quede afuera.** `KYC_AGENT_BASE_URL` apunta a la
//     base del host; las dos filas del catálogo apuntan a `…/api/agents/remit-kyc-{session,decision}/
//     invoke`, que NO es la ruta del validador que compone `agent-env.ts`. Comparar rutas daría
//     siempre distinto: sería un guard que rechaza el camino legítimo.
//
// ⛔ FAIL-CLOSED EN LOS DOS EXTREMOS: lo que no parsea, lo que no es `http:`/`https:` y lo que no es
// un string devuelve `null`, y `null` **nunca** se compara igual a nada (ver `sameOrigin`). No hay
// ninguna entrada que "no se pudo evaluar" y por eso pase.

/**
 * El origen de una URL absoluta `http`/`https`, o `null` si no se puede afirmar cuál es.
 *
 * `null` es un estado real y significa "no sé de qué origen es esto", que bajo fail-closed es un
 * rechazo. ⛔ PROHIBIDO devolver `""`: una cadena vacía compararía igual contra otra cadena vacía y
 * dos "no sé" pasarían por una coincidencia.
 */
export function originOf(url: unknown): string | null {
  if (typeof url !== "string" || url === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Mismo recorte que `resolveKycAgentBaseUrl`. Un esquema exótico produce `origin === "null"` (el
  // STRING), que compararía igual contra otro exótico: por eso se corta acá y no se confía en `origin`.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin;
}

/**
 * ¿Las dos URLs son del MISMO origen? Fail-closed: si alguna de las dos no tiene origen afirmable,
 * la respuesta es `false`.
 *
 * ⚠️ El caso `userinfo` es el que más engaña a un lector humano y por eso tiene su fila en el test:
 * `https://agentes.test@evil.example/x` **no** es `agentes.test`. Su host es `evil.example`, y esta
 * función dice `false`. Un guard escrito con `startsWith`/`includes` sobre el texto habría dicho que sí.
 */
export function sameOrigin(a: unknown, b: unknown): boolean {
  const oa = originOf(a);
  if (oa === null) return false;
  return oa === originOf(b);
}
