// Candado del `fetch` con reintento del RPC de Solana.
//
// Este envoltorio transporta ENVÍOS DE TRANSACCIONES (`solana-wallet.ts:706` y `:935`), así que lo
// que estos tests vigilan no es "que reintente" — es **hasta dónde** reintenta y qué NO hace:
//
//  · Sólo sobre 429. Un 429 es un rechazo del limitador ANTES de procesar, así que no hay nada que
//    duplicar. En un 5xx o un timeout eso NO vale, y ampliar el alcance ahí sería apoyarse sólo en la
//    idempotencia por firma de Solana — que probablemente alcance, pero no se midió.
//  · No inventa un éxito. Agotados los reintentos, devuelve el 429 REAL, para que el error que ve la
//    persona siga siendo el verdadero.
//  · Reenvía los MISMOS bytes. Si el `init` no viaja intacto, un reintento podría mandar OTRA
//    transacción, y ahí sí se duplicaría un movimiento de dinero.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ESPERA_BASE_MS,
  MAX_REINTENTOS,
  RETRY_AFTER_MAX_MS,
  crearFetchConReintento,
  esperaDelIntento,
  esperaSugerida,
} from "./rpc-fetch";

const resp = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(status === 204 ? null : "{}", { status, headers });

/** Un `fetch` falso que devuelve la secuencia dada y registra cómo lo llamaron. */
function fetchFalso(secuencia: Response[]) {
  const llamadas: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  let i = 0;
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ input, init });
    const r = secuencia[Math.min(i, secuencia.length - 1)];
    i++;
    return r as Response;
  });
  return { fn, llamadas };
}

const sinDormir = async (): Promise<void> => {};

describe("candado · fetch con reintento del RPC de Solana", () => {
  // ── Sólo el 429 ──────────────────────────────────────────────────────────────────────────────
  it("T-RPC-1: un 200 pasa derecho, con UNA sola llamada", async () => {
    const { fn } = fetchFalso([resp(200)]);
    const f = crearFetchConReintento(fn, sinDormir);
    expect((await f("https://rpc.test")).status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503, 504, 400, 401, 403])(
    "T-RPC-2: un %i NO se reintenta — su semántica es ambigua y esto transporta dinero",
    async (status) => {
      const { fn } = fetchFalso([resp(status)]);
      const f = crearFetchConReintento(fn, sinDormir);
      expect((await f("https://rpc.test")).status).toBe(status);
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );

  it("T-RPC-3: un 429 seguido de 200 se resuelve solo, en 2 llamadas", async () => {
    const { fn } = fetchFalso([resp(429), resp(200)]);
    const f = crearFetchConReintento(fn, sinDormir);
    expect((await f("https://rpc.test")).status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ── No inventa un éxito ──────────────────────────────────────────────────────────────────────
  it("T-RPC-4: con 429 permanente devuelve el 429 REAL y no un éxito sintético", async () => {
    const { fn } = fetchFalso([resp(429)]);
    const f = crearFetchConReintento(fn, sinDormir);
    const r = await f("https://rpc.test");
    expect(r.status).toBe(429);
    // 1 intento inicial + MAX_REINTENTOS. Se afirma la fórmula y no un número pelado, para que el
    // test siga midiendo lo mismo si el tope cambia.
    expect(fn).toHaveBeenCalledTimes(1 + MAX_REINTENTOS);
  });

  // ── Reenvía los MISMOS bytes: es la propiedad que evita duplicar un movimiento ────────────────
  it("T-RPC-5: cada reintento manda el MISMO cuerpo y la MISMA URL", async () => {
    const { fn, llamadas } = fetchFalso([resp(429), resp(429), resp(200)]);
    const f = crearFetchConReintento(fn, sinDormir);
    const cuerpo = JSON.stringify({ method: "sendTransaction", params: ["FIRMADA"] });
    await f("https://rpc.test", { method: "POST", body: cuerpo });
    expect(llamadas).toHaveLength(3);
    for (const l of llamadas) {
      expect(l.input).toBe("https://rpc.test");
      expect(l.init?.body).toBe(cuerpo);
      expect(l.init?.method).toBe("POST");
    }
  });

  // ── La espera crece, y se puede observar ─────────────────────────────────────────────────────
  it("T-RPC-6: la espera crece ×3 entre intentos", async () => {
    const esperas: number[] = [];
    const { fn } = fetchFalso([resp(429)]);
    const f = crearFetchConReintento(fn, async (ms) => void esperas.push(ms));
    await f("https://rpc.test");
    expect(esperas).toEqual([ESPERA_BASE_MS, ESPERA_BASE_MS * 3, ESPERA_BASE_MS * 9]);
  });

  it("T-RPC-7: avisa de cada reintento — un reintento silencioso esconde un RPC saturado", async () => {
    const avisos: Array<[number, number]> = [];
    const { fn } = fetchFalso([resp(429), resp(200)]);
    const f = crearFetchConReintento(fn, sinDormir, (i, ms) => void avisos.push([i, ms]));
    await f("https://rpc.test");
    expect(avisos).toEqual([[1, ESPERA_BASE_MS]]);
  });

  // ── `Retry-After`: se respeta, pero con techo ────────────────────────────────────────────────
  it("T-RPC-8: en segundos se respeta", () => {
    expect(esperaSugerida("2")).toBe(2000);
  });

  it("T-RPC-9: se recorta al techo — el servidor no puede colgar a quien está esperando", () => {
    expect(esperaSugerida("3600")).toBe(RETRY_AFTER_MAX_MS);
  });

  it("T-RPC-10: una fecha HTTP futura se respeta y también se recorta", () => {
    const dentroDe2s = new Date(Date.now() + 2000).toUTCString();
    const v = esperaSugerida(dentroDe2s);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(RETRY_AFTER_MAX_MS);
  });

  it.each([
    ["ausente", null],
    ["vacío", "   "],
    ["basura", "cuando-pueda"],
  ])("T-RPC-11: un Retry-After %s cae a la espera propia, no a cero", (_caso, valor) => {
    expect(esperaSugerida(valor)).toBeUndefined();
    expect(esperaDelIntento(1, valor)).toBe(ESPERA_BASE_MS);
  });

  // Una fecha en el pasado NO es "esperá 0": es un servidor con el reloj corrido. Tratarla como 0
  // convertiría el backoff en un bucle apretado, que es justo lo que dispara más 429.
  it("T-RPC-12: una fecha en el PASADO no produce espera cero", () => {
    const hace1h = new Date(Date.now() - 3_600_000).toUTCString();
    expect(esperaSugerida(hace1h)).toBeUndefined();
    expect(esperaDelIntento(2, hace1h)).toBe(ESPERA_BASE_MS * 3);
  });

  it("T-RPC-13: el Retry-After del servidor gana sobre la espera propia", async () => {
    const esperas: number[] = [];
    const { fn } = fetchFalso([resp(429, { "retry-after": "1" }), resp(200)]);
    const f = crearFetchConReintento(fn, async (ms) => void esperas.push(ms));
    await f("https://rpc.test");
    expect(esperas).toEqual([1000]);
  });

  // ── El peor caso tiene que ser tolerable para quien espera con la billetera abierta ──────────
  it("T-RPC-14: el peor caso agrega menos de 6 s antes de fallar", () => {
    const total = Array.from({ length: MAX_REINTENTOS }, (_, i) => esperaDelIntento(i + 1, null)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBeLessThan(6000);
  });

  // ── El candado que reemplaza la garantía estructural ────────────────────────────────────────
  //
  // Se descartó un `conexionSolanaCliente(url)` único porque habría vuelto ESTÁTICO un import que
  // `solana-wallet.ts` hace dinámico a propósito (línea 309), engordando el bundle inicial de toda la
  // app. El costo de esa decisión es que ahora CADA sitio tiene que acordarse de pasar la config, y
  // el que se olvide sería justo el camino que nadie probó — el 429 volvería a matar el recorrido
  // por la mitad y el síntoma no diría dónde falta.
  //
  // Esto lo cierra contando: cada `new Connection(` de ese archivo tiene que llevar la config.
  it("T-RPC-15: TODOS los `new Connection(` de solana-wallet.ts pasan la config con reintento", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "src", "infrastructure", "solana-wallet.ts"),
      "utf8",
    );
    // Cada constructor abarca varias líneas; se corta en el `)` de cierre para no mezclar sitios.
    const bloques = src.split("new Connection(").slice(1);
    expect(bloques.length).toBeGreaterThanOrEqual(7); // hoy 7; si crecen, el caso sigue valiendo
    const sinConfig = bloques
      .map((b, i) => ({ i, cabeza: b.slice(0, b.indexOf(");")) }))
      .filter((x) => !x.cabeza.includes("configConexionSolana()"))
      .map((x) => x.i + 1);
    expect(sinConfig).toEqual([]);
  });

  // El árbol del wallet adapter habla con el RPC por SU propia Connection. Si ésa queda sin la
  // config, el reintento cubre las lecturas y no el camino que usa la billetera.
  it("T-RPC-16: el ConnectionProvider también lleva la config", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "presentation", "solana", "solana-providers.tsx"),
      "utf8",
    );
    expect(src).toMatch(/<ConnectionProvider[^>]*config=\{configConexionSolana\(\)\}/);
  });
});
