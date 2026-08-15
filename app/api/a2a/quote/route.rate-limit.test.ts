// ── WKH-355 · EL CANDADO DEL LIMITADOR DE `/api/a2a/quote` ──────────────────────────────────────────
//
// QUÉ AGUJERO VIGILA. La ruta es pública, sin autenticación, y cada POST compone contra el gateway
// GASTANDO el saldo de la Agent Key prepaga. Sin limitador, agotar ese saldo con `curl` cuesta cero y
// deja al producto entero sin cotizar ni enviar (el gateway pasa a 402 y la ruta a 502).
//
// 🔴 POR QUÉ ESTE ARCHIVO EXISTE APARTE DE `route.test.ts`, que es la parte que importa. Ese archivo
// MOCKEA `checkRouteRateLimit` y su default es `{ ok: true }`. Ese mock es necesario allá (si no, sus
// 22 casos cortarían con el 503 fail-closed), pero convierte a la mitad de ese archivo en un testigo
// inútil para ESTA propiedad: con el limitador borrado de la ruta, todos sus casos de camino feliz
// siguen en VERDE, porque un doble que nadie llama no se queja. Acá NO se mockea `rate-limit`: corre
// el módulo real.
//
// ⚠️ LAS DOS TRAMPAS QUE ESTE REPO YA PISÓ, Y CÓMO SE ESQUIVAN ACÁ:
//
//  1. «Un candado que deriva su expectativa del mismo código que vigila aprueba cualquier cosa». Acá
//     NINGUNA expectativa se lee de `QUOTE_RL`: los status (503), el enum del body
//     (`quote_rate_limit_unavailable`) y el techo (30) están escritos a mano en este archivo. Si
//     alguien sube el default a 3000, T-355.3 se pone rojo; un `expect(QUOTE_RL.ip.defMax)
//     .toBe(QUOTE_RL.ip.defMax)` habría aplaudido.
//
//  2. «Un test que afirma una propiedad que el elemento nuevo también tiene se confirma con lo que
//     vino a detectar». La forma en que eso pasaría acá: montar un fixture donde la ruta NO pueda
//     llegar a 200 igual (por ejemplo sin configurar el gateway) y festejar un corte que en realidad
//     produce el 501. Por eso T-355.1 configura el gateway ENTERO y le pone al `fetch` una respuesta
//     de `/compose` VÁLIDA: sin el limitador, ese mismo fixture devuelve 200 con una cotización real
//     — o sea, el defecto exacto. El caso negativo se corre sobre el fixture del caso positivo.
//
// ⛔ LO QUE ESTE CANDADO NO PRUEBA, declarado: no prueba que Upstash cuente bien, ni que la ventana
// deslizante expire cuando dice. Prueba que la ruta CONSULTA al limitador antes de gastar y que
// OBEDECE su veredicto. Contar es responsabilidad de `@upstash/ratelimit` y no se testea acá.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEPOSIT_PREPARE_RL,
  ESCROW_RECOVERY_RL,
  KYC_RL,
  KYC_VERDICT_RL,
  PAYOUT_CHALLENGE_RL,
  PAYOUT_STATUS_RL,
  PAYOUT_VALIDATE_RL,
  QUOTE_RL,
  __resetKycRateLimitClient,
} from "../../../../src/infrastructure/rate-limit";
import { POST } from "./route";

const GW = "https://gateway.example.com";
const KEY = "ak_secret";

/** El shape que la ruta acepta como cotización válida. Copiado de `route.test.ts` a propósito: si
 *  este objeto dejara de ser válido, T-355.1 pasaría a medir el 502 de shape en vez del limitador. */
const validResult = {
  quoteId: "cfx-1",
  rate: 3.7,
  feeUsd: 0.5,
  netDeliveredLocal: 1478.15,
  etaMinutes: 30,
  expiresAt: "2026-07-09T18:10:00.000Z",
  provenance: "fx-quote-provider",
};

function req(payload: unknown): Request {
  return new Request("http://localhost/api/a2a/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetKycRateLimitClient(); // vacía los limiters memoizados entre stubs de env
  // El gateway, CONFIGURADO Y SANO. Ver trampa 2 del encabezado: este fixture tiene que poder dar 200.
  vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GW);
  vi.stubEnv("WASIAI_A2A_AGENT_KEY", KEY);
  // Upstash AUSENTE. Es el estado del runner, y se declara igual: un `.env` que apareciera mañana no
  // puede cambiar en silencio lo que este archivo mide.
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, steps: [{ output: validResult }] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __resetKycRateLimitClient();
});

describe("WKH-355 — /api/a2a/quote consulta al limitador ANTES de gastar la Agent Key", () => {
  // ── T-355.1 · EL CANDADO PRINCIPAL ────────────────────────────────────────────────────────────────
  // Es el que se pone rojo si alguien saca el limitador de la ruta. Mutación medida: comentando el
  // bloque `checkRouteRateLimit` de `route.ts`, este caso devuelve 200 con `result` (la cotización
  // real) y `fetchMock` con 1 llamada a `${GW}/compose` — o sea, el agujero, reproducido.
  it("T-355.1: sin Upstash configurado la ruta FALLA CERRADA (503) y NO gasta un solo fetch al gateway", async () => {
    const res = await POST(req({ amountUsd: 100, destCountry: "PE", payoutMethod: "yape" }));

    expect(res.status, "la ruta contestó sin pasar por el limitador").toBe(503);
    expect(await res.json()).toEqual({ error: "quote_rate_limit_unavailable" });
    // 🔴 LA MITAD QUE DE VERDAD MIDE EL DINERO. El status por sí solo no dice que no se gastó: una
    // ruta que compone y DESPUÉS contesta 503 daría el mismo status y habría debitado igual.
    expect(
      fetchMock,
      "la ruta llamó al gateway igual: eso es saldo de la Agent Key gastado antes de preguntar",
    ).not.toHaveBeenCalled();
  });

  // ── T-355.2 · LA OTRA MITAD DE LA MUTACIÓN ────────────────────────────────────────────────────────
  // T-355.1 solo no alcanza: un `return 503` incondicional al tope del handler también lo pondría en
  // verde, y eso NO es un limitador, es la ruta apagada. Acá se demuestra que el 503 depende de la
  // CONFIG del limitador y no del handler: con Upstash presente la ruta deja de cortar en 503 y
  // vuelve a componer.
  //
  // ⚠️ El `fetch` global stubeado es TAMBIÉN el transporte de `@upstash/redis` (es un cliente REST).
  // Con la env presente, `getLimiters` construye el cliente y `limiter.limit()` pega contra este
  // mismo doble; su respuesta no tiene forma de Upstash, así que el `.limit()` tira y
  // `checkRouteRateLimit` cae en su rama fail-OPEN documentada (error transitorio ⇒ `{ ok: true }`).
  // Ese camino es justamente el que hace falta acá: prueba que con limitador operativo la ruta SIGUE.
  it("T-355.2: el 503 no es un apagón del handler — con Upstash configurado la ruta vuelve a componer", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.example.com");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "tok");
    __resetKycRateLimitClient();
    vi.spyOn(console, "warn").mockImplementation(() => {}); // el fail-open loguea

    const res = await POST(req({ amountUsd: 100, destCountry: "PE", payoutMethod: "yape" }));

    expect(res.status, "la ruta corta en 503 pase lo que pase: eso no es un limitador").not.toBe(503);
    expect(fetchMock).toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/compose")),
      "con el limitador operativo la ruta ya no llega a componer",
    ).toBe(true);
  });

  // ── T-355.3 · EL TECHO, PINEADO CONTRA LITERALES ESCRITOS A MANO ──────────────────────────────────
  // Un limitador con el techo en 100.000 pasa T-355.1 y T-355.2 sin despeinarse: el limitador está,
  // se consulta, obedece, y no limita nada. Este caso es el que impide que el número se afloje solo.
  //
  // Los tres números salen de la aritmética escrita en `QUOTE_RL` y se repiten acá A PROPÓSITO: un
  // pin que leyera el valor del módulo no pinearía nada.
  //  · 0,03 USDC por cotización — MEDIDO el 2026-08-15 contra el catálogo vivo (`GET /api/a2a/plan`
  //    en prod ⇒ `remittance-fx-quote`, `priceUsdc: 0.03`). ⚠️ Es una FOTO: el precio lo publica el
  //    agente y puede cambiar sin que nadie toque este repo. Si cambia, lo que hay que rehacer es la
  //    cuenta, no el número de acá.
  //  · 30 por IP y por ventana = 10 cotizaciones de una persona × 3 personas detrás de una IP.
  //  · ⇒ 0,90 USDC por IP cada 10 minutos. El tope de política es 1 USDC.
  it("T-355.3: el techo por IP y ventana es 30, o sea <= 1 USDC de saldo por IP cada 10 minutos", () => {
    expect(QUOTE_RL.ip.defMax, "el techo por IP se movió sin rehacer la cuenta").toBe(30);
    expect(QUOTE_RL.ip.defWindow).toBe("10 m");

    const USDC_POR_COTIZACION = 0.03; // foto 2026-08-15, ver arriba
    const TOPE_USDC_POR_IP_Y_VENTANA = 1;
    expect(
      QUOTE_RL.ip.defMax * USDC_POR_COTIZACION,
      "el techo dejó de ser un techo: esto es saldo de la Agent Key que el limitador aprueba",
    ).toBeLessThanOrEqual(TOPE_USDC_POR_IP_Y_VENTANA);
  });

  // ── T-355.4 · CONTADOR PROPIO ─────────────────────────────────────────────────────────────────────
  // Compartir `bucketPrefix` con otra ruta no rompe nada visible y hace dos daños a la vez: el
  // tráfico legítimo de la cotización (que es el más alto del sitio, porque es la primera pantalla)
  // apagaría al otro endpoint, y el techo de 30 dejaría de significar 30 cotizaciones.
  // Se compara contra las OTRAS configs del módulo, no contra sí misma.
  it("T-355.4: el bucket de la cotización no comparte contador con ninguna otra ruta", () => {
    const ajenos = [
      KYC_RL,
      KYC_VERDICT_RL,
      PAYOUT_VALIDATE_RL,
      PAYOUT_CHALLENGE_RL,
      DEPOSIT_PREPARE_RL,
      ESCROW_RECOVERY_RL,
      PAYOUT_STATUS_RL,
    ].map((c) => c.bucketPrefix);
    expect(ajenos, "el fixture se quedó sin las otras rutas contra las que comparar").toHaveLength(7);
    expect(ajenos).not.toContain(QUOTE_RL.bucketPrefix);
  });
});
