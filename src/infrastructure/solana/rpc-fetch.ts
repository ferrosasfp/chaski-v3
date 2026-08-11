// `fetch` con reintento para las llamadas al RPC de Solana.
//
// ── EL DEFECTO QUE CIERRA, medido en producción el 2026-08-11 ───────────────────────────────────
//
// Un recorrido real murió con `failed to get recent blockhash: Error: 429` JUSTO ANTES DE FIRMAR.
// El RPC público de devnet limita por ráfaga, y el camino del depósito hace varias llamadas seguidas
// (blockhash, simulación, envío, confirmación): una sola rechazada mata la remesa completa y la
// pantalla dice "Algo salió mal". No había ningún reintento en ninguno de los siete sitios que crean
// una `Connection`.
//
// El blockhash NO se pide desde este repo: lo pide Anchor por dentro
// (`@coral-xyz/anchor/dist/cjs/provider.js:87`). Por eso el reintento NO puede vivir en el sitio de
// la llamada — tiene que estar en el transporte, que es lo único que Anchor comparte con nosotros.
// `Connection` acepta un `fetch` propio y ése es el punto de inyección.
//
// ── POR QUÉ ES SEGURO REINTENTAR AUNQUE ESTO TRANSPORTE ENVÍOS DE TRANSACCIONES ─────────────────
//
// Dos de esos sitios llaman `sendRawTransaction` (`solana-wallet.ts:706` y `:935`), así que un
// reintento descuidado acá podría duplicar un movimiento de dinero. No lo hace, por DOS razones
// independientes, y hacen falta las dos escritas porque una sola no alcanzaría para justificarlo:
//
//   1. **Un 429 es un rechazo, no un procesamiento.** El limitador contesta ANTES de reenviar la
//      transacción a la red, así que la transacción nunca salió y no hay nada que duplicar.
//   2. **Una transacción de Solana es idempotente por su firma.** Se reenvían los MISMOS bytes ya
//      firmados; la red descarta la firma repetida. Aun si el punto 1 fuera falso en algún RPC, dos
//      envíos idénticos no producen dos transferencias.
//
// ⚠️ POR ESO SÓLO SE REINTENTA EL 429, y no los 5xx ni los timeouts. En esos casos el punto 1 NO
// vale —la petición pudo haberse procesado— y quedaría sostenido sólo por el punto 2. La
// idempotencia por firma probablemente alcance, pero eso es una afirmación sobre el
// comportamiento de la red que NO medí, y este archivo transporta dinero. Ampliar el alcance exige
// medirlo primero, no razonarlo.
//
// ⚠️ Y NO SE INVENTA UN ÉXITO. Si se agotan los reintentos, se devuelve la ÚLTIMA respuesta real —el
// 429— para que el error que ve la persona siga siendo el verdadero. Tragarse el fallo y devolver
// algo sintético convertiría un error honesto en un misterio, que es el defecto que este repo viene
// corrigiendo en el resto del camino del dinero.

/** Tope de reintentos. Con la espera de abajo, el peor caso agrega ~5,2 s antes de fallar. */
export const MAX_REINTENTOS = 3;
/** Espera base. Crece ×3: 400 ms, 1200 ms, 3600 ms. */
export const ESPERA_BASE_MS = 400;
/** Techo de lo que se respeta de un `Retry-After` del servidor, para no colgar a quien espera. */
export const RETRY_AFTER_MAX_MS = 5_000;

/** Lee `Retry-After` (segundos o fecha HTTP). Devuelve `undefined` si no dice nada usable. */
export function esperaSugerida(retryAfter: string | null): number | undefined {
  if (retryAfter === null || retryAfter.trim() === "") return undefined;
  const segundos = Number(retryAfter);
  if (Number.isFinite(segundos) && segundos >= 0) {
    return Math.min(segundos * 1000, RETRY_AFTER_MAX_MS);
  }
  const fecha = Date.parse(retryAfter);
  if (Number.isNaN(fecha)) return undefined;
  const delta = fecha - Date.now();
  // Una fecha en el pasado no es una espera: es un servidor con el reloj corrido.
  if (delta <= 0) return undefined;
  return Math.min(delta, RETRY_AFTER_MAX_MS);
}

/** Espera del intento `n` (1-based), preferiendo lo que sugiera el servidor. */
export function esperaDelIntento(n: number, retryAfter: string | null): number {
  return esperaSugerida(retryAfter) ?? ESPERA_BASE_MS * 3 ** (n - 1);
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Devuelve un `fetch` que reintenta ÚNICAMENTE sobre HTTP 429.
 *
 * `dormir` y `fetchBase` se inyectan para que los tests midan el comportamiento sin esperar de
 * verdad ni tocar la red: un test que duerme 5 s se vuelve un test que nadie corre.
 */
export function crearFetchConReintento(
  fetchBase: FetchLike,
  dormir: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  onReintento?: (intento: number, esperaMs: number) => void,
): FetchLike {
  return async function fetchConReintento(input, init) {
    let ultima = await fetchBase(input, init);
    for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
      // Cualquier cosa que no sea 429 se devuelve tal cual, incluidos los errores: este envoltorio
      // NO decide sobre desenlaces, sólo insiste cuando el RPC dijo "ahora no".
      if (ultima.status !== 429) return ultima;
      const espera = esperaDelIntento(intento, ultima.headers.get("retry-after"));
      onReintento?.(intento, espera);
      await dormir(espera);
      ultima = await fetchBase(input, init);
    }
    // Reintentos agotados: se devuelve el 429 REAL, no un éxito inventado ni un error propio.
    return ultima;
  };
}

/**
 * La config que se le pasa a `new Connection(...)` y al `ConnectionProvider`.
 *
 * Vive acá para que los siete sitios que crean una `Connection` deriven de UNA fuente. Siete copias
 * de la misma decisión es la clase de duplicación que en este proyecto ya causó tres fallas de
 * configuración distintas; acá el síntoma sería que el reintento cubra unos caminos y no otros, y
 * que nadie note cuál.
 */
export function configConexionSolana(): { fetch: FetchLike } {
  return {
    fetch: crearFetchConReintento((input, init) => fetch(input, init), undefined, (intento, ms) => {
      // Queda escrito porque un reintento silencioso esconde que el RPC está saturado, y ese dato es
      // lo único que distingue "el proveedor no da" de "la app tiene un bug".
      console.warn(`[rpc-429] el RPC de Solana limitó la llamada; reintento ${intento} en ${ms} ms`);
    }),
  };
}

// ── POR QUÉ ACÁ NO HAY UN `conexionSolanaCliente(url)` ─────────────────────────────────────────
//
// La primera versión exportaba un constructor único que hacía `new Connection(url, config)`, con el
// argumento de que un solo constructor garantiza que el reintento cubra los siete caminos o ninguno.
// **Se descartó al medir el archivo que lo iba a usar.**
//
// `solana-wallet.ts` obtiene `Connection` de un import DINÁMICO (línea 309:
// `const { PublicKey: PublicKeyLazy, Connection } = web3;`), y eso es deliberado — su cabecera
// declara que el módulo no arrastra el árbol de Solana al bundle eager. Un helper con
// `import { Connection } from "@solana/web3.js"` lo habría vuelto estático y habría engordado el
// bundle inicial de toda la app para ahorrar seis líneas.
//
// Así que la config viaja sola y cada sitio la pasa: `new Connection(url, configConexionSolana())`.
// La decisión sigue viviendo en UN lugar, que era el punto; lo que se resigna es la garantía
// estructural de que nadie olvide pasarla. Eso lo cubre un test que cuenta los sitios.
