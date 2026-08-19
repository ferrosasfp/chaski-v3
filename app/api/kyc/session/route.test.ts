import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock del helper de rate-limit → controlamos el veredicto sin Upstash real.
const { rlMock } = vi.hoisted(() => ({ rlMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/rate-limit", () => ({ checkKycRateLimit: rlMock }));

// WKH-233 — el store del `decisionToken`. Se mockea el MÓDULO (no la base) para poder contar
// llamadas y forzar el fallo de la escritura, que es lo que T-TOK-6 mide.
const { putMock, storeMock } = vi.hoisted(() => ({ putMock: vi.fn(), storeMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/persistence/supabase-kyc-session-tokens", () => ({
  getKycSessionTokenStore: storeMock,
}));

import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import {
  buildSolanaPopMessage,
  issueSolanaPopChallenge,
} from "../../../../src/infrastructure/auth/pop-challenge";
import { POST } from "./route";

// La salida del agente. `decisionToken` es un CENTINELA reconocible: T-TOK-3/T-TOK-4 barren el body,
// las cabeceras y los logs buscándolo. Si aparece en alguno, CD-20 está roto.
const TOKEN_CENTINELA = "k1.CENTINELA-QUE-NO-DEBE-SALIR";
const AGENT_OK = {
  sessionId: "s1",
  url: "https://verificacion.example/session/s1",
  decisionToken: TOKEN_CENTINELA,
  provenance: "didit",
};

// WKH-333/R-1 — la ruta pasa a exigir prueba de posesión de la billetera. Seeds FIJAS: las addresses
// son reproducibles corrida a corrida, así una mutación que hardcodee un valor se puede escribir y
// verificar sin adivinar.
const KP_A = Keypair.fromSeed(new Uint8Array(32).fill(11));
const KP_B = Keypair.fromSeed(new Uint8Array(32).fill(22));
const ADDR_A = KP_A.publicKey.toBase58();
const ADDR_B = KP_B.publicKey.toBase58();
const POP_SECRET = "test-pop-secret";

/** Challenge REAL (HMAC de verdad) + firma ed25519 REAL. `challengeFor` permite emitir el challenge
 *  de una billetera y presentarlo como si fuera de otra. */
function realPop(signer: Keypair, challengeFor: Keypair = signer) {
  const ch = {
    address: challengeFor.publicKey.toBase58(),
    networkId: "solana:devnet",
    nonce: "0123456789abcdef0123456789abcdef",
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const popChallenge = issueSolanaPopChallenge(ch);
  const popSignature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(buildSolanaPopMessage(ch)), signer.secretKey),
  );
  return { popChallenge, popSignature };
}

/** Lee el body que se le mandó a Didit en la llamada `n`. Existe para no repetir `calls[0]![1]!` en
 *  cada aserto: el `!` es la única forma que TypeScript acepta ahí (el `?.` encadenado dispara
 *  `noUnsafeOptionalChaining`, que en este repo es ERROR de lint, no warning). Concentrarlo en un
 *  solo lugar deja los casos legibles y el lint quieto. */
function sentToAgent(m: { mock: { calls: unknown[][] } }, n = 0): Record<string, unknown> {
  const call = m.mock.calls[n];
  if (!call) throw new Error("no hubo llamada al agente");
  const init = call[1] as RequestInit | undefined;
  if (!init?.body) throw new Error("la llamada al agente no llevó body");
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function req(body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/kyc/session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
    body: JSON.stringify(body),
  });
}

function reqWithHeaders(headers: Record<string, string>, body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/kyc/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  rlMock.mockReset();
  rlMock.mockResolvedValue({ ok: true });
  putMock.mockReset();
  putMock.mockResolvedValue(undefined);
  storeMock.mockReset();
  storeMock.mockReturnValue({ put: putMock });
  vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
  vi.stubEnv("KYC_AGENT_INVOKE_SECRET", undefined);
  vi.stubEnv("KYC_SESSION_SECRET", "test-secret-123");
  // WKH-333/R-1: la ruta exige PoP. Sin el secreto responde 503 fail-closed, así que los casos que
  // llegan a Didit tienen que presentarlo.
  vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET);
});

describe("POST /api/kyc/session — guard-order + rate-limit + callback + token (WKH-179)", () => {
  it("T-SES-4: sin KYC_AGENT_BASE_URL → 501, rate-limit NO invocado (AC-4)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req());
    expect(res.status).toBe(501);
    expect(rlMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("con host del agente y sin KYC_SESSION_SECRET → 500 (CD-7)", async () => {
    vi.stubEnv("KYC_SESSION_SECRET", "");
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  it("rate-limit consultado ANTES del viaje al agente (AC-5, CD-1)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => AGENT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    await POST(req({ vendorData: "0xabc" }));
    expect(rlMock).toHaveBeenCalledWith({ ip: "9.9.9.9", address: "0xabc" });
  });

  it("IP viene de x-vercel-forwarded-for (fuente confiable de Vercel); XFF malicioso se ignora (MNR-1)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => AGENT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    // Atacante intenta forjar el leftmost del XFF; Vercel inyecta la IP real en x-vercel-forwarded-for.
    await POST(
      reqWithHeaders(
        { "x-vercel-forwarded-for": "5.5.5.5", "x-forwarded-for": "1.1.1.1, 6.6.6.6" },
        { vendorData: "0xabc" },
      ),
    );
    expect(rlMock).toHaveBeenCalledWith({ ip: "5.5.5.5", address: "0xabc" });
  });

  it("IP cae a x-real-ip cuando no hay x-vercel-forwarded-for; XFF forjado no la cambia (MNR-1)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => AGENT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    await POST(reqWithHeaders({ "x-real-ip": "7.7.7.7", "x-forwarded-for": "1.2.3.4" }));
    expect(rlMock).toHaveBeenCalledWith({ ip: "7.7.7.7", address: undefined });
  });

  it("sin headers de Vercel → XFF como último recurso toma el valor MÁS A LA DERECHA, no el leftmost (MNR-1)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => AGENT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    // 1.1.1.1 lo puede forjar el cliente; 8.8.8.8 (rightmost) lo agrega el proxy de confianza.
    await POST(reqWithHeaders({ "x-forwarded-for": "1.1.1.1, 8.8.8.8" }));
    expect(rlMock).toHaveBeenCalledWith({ ip: "8.8.8.8", address: undefined });
  });

  it("limiter ok:false → 429 + Retry-After, fetch NO llamado (AC-6, AC-7)", async () => {
    rlMock.mockResolvedValue({ ok: false, retryAfter: 42 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: "0xabc" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Upstash ausente (unavailable) → 503 fail-closed, fetch NO llamado (AC-6)", async () => {
    rlMock.mockResolvedValue({ ok: false, unavailable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "rate_limit_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DT-11: el `callback` YA NO EXISTE — no se manda ninguno, ni el del body ni uno construido", async () => {
    // ⚠️ ESTE TEST REEMPLAZA a los dos que medían el callback server-side. El callback se fue con la
    // HU: el agente lo valida contra una allowlist de orígenes que nace VACÍA (fail-closed), así que
    // mandarlo sin esa env sería un 400 garantizado. Lo que el test viejo custodiaba —que
    // `body.callback` no se reenvíe a ciegas— se conserva y es MÁS fuerte: no se reenvía NADA.
    vi.stubEnv("KYC_CALLBACK_BASE_URL", "https://chaski.app");
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      void init;
      return { ok: true, json: async () => AGENT_OK };
    });
    vi.stubGlobal("fetch", fetchMock);
    await POST(req({ callback: "http://evil.com", vendorData: "0xabc", ...realPop(KP_A) }));
    const sent = sentToAgent(fetchMock);
    expect(Object.keys(sent)).toEqual(["identityRef"]);
    expect(JSON.stringify(sent)).not.toContain("evil");
    expect(JSON.stringify(sent)).not.toContain("chaski.app");
  });

  it("éxito → 200 con `{sessionId, url, authToken}` y NADA MÁS (CD-20)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => AGENT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: "0xabc", ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // 🧬 MUTANTE: devolver el `decisionToken` (o el `sessionToken` del proveedor, que tampoco leía
    // nadie) ⇒ una clave de más ⇒ ROJO.
    expect(Object.keys(body).sort()).toEqual(["authToken", "sessionId", "url"]);
    expect(body.sessionId).toBe("s1");
    expect(typeof body.authToken).toBe("string");
  });

  // ── El host del agente: fail-closed (sin default, nunca) ────────────────────
  it("T-SES-4: sin KYC_AGENT_BASE_URL ⇒ 501 (NO 500, NO 502) y NO se crea ninguna sesión", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: "0xabc" }));
    // 🧬 MUTANTE: devolver 500 ⇒ ROJO. El 501 es el que hace que `AgentKycGateway.start` caiga al
    // fallback ⇒ el demo queda byte-idéntico. Un 500 lo rompería.
    expect(res.status).toBe(501);
    // EL assert que importa: esta ruta CREA verificaciones de identidad. Sin host declarado no sale
    // ni un request.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("✅ calibración: CON la env, el fetch va al host del agente y a su ruta", async () => {
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => AGENT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: "0xabc", ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://agentes.test/api/agents/remit-kyc-validator/session",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-333/R-1 — la sesión de KYC se ata a una dirección PROBADA (AC-19, CD-29)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// El daño que esto cierra: `vendor_data` salía del body, así que cualquiera podía crear una sesión de
// verificación a nombre de la dirección de OTRA persona y aprobarla con su propio documento. Didit
// ecoa esa dirección y la route de decisión escribe la fila del veredicto con ella. Mientras el pago
// usaba el identificador guardado en el navegador de cada uno, esa fila ajena era inerte; con el
// veredicto server-side, esa fila ES la fuente de autoridad del pago.
describe("POST /api/kyc/session — el vendor_data sale del PoP, no del body (WKH-333/R-1)", () => {
  function fetchOk() {
    const m = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return { ok: true, json: async () => AGENT_OK };
    });
    vi.stubGlobal("fetch", m);
    return m;
  }

  // ── T-SE-1 — AC-12: el demo queda byte-idéntico ────────────────────────────────────────────────
  it("T-SE-1: sin host del agente ⇒ 501 ANTES del PoP (el demo no pide una firma nueva) (M-33b)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
    const fetchMock = fetchOk();
    const res = await POST(req({ vendorData: ADDR_A })); // SIN PoP, como el demo de hoy
    expect(
      res.status,
      "el bloque de prueba de posesión se movió antes del 501: el demo local, que hoy no pide " +
        "ninguna firma de billetera, empezaría a exigir una",
    ).toBe(501);
    expect(rlMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── T-SE-2 — AC-19 / M-33 · 🔴 REESCRITO POR AR/BLQ-ALTO-2 ────────────────────────────────────
  //
  // ⚠️ ESTE TEST ASSERTABA EL COMPORTAMIENTO QUE ROMPÍA CD-15. Decía "con key y SIN PoP ⇒ 403
  // kyc_session_unverified" y estaba verde: la ruta efectivamente contestaba 403, y ese 403 llegaba
  // a `DiditKycGateway.start`, que lo convertía en `throw didit_session_failed` ⇒ la persona que
  // rechazaba la firma al conectar NO PODÍA VERIFICARSE. O sea que el candado custodiaba el daño.
  //
  // Lo que se clava ahora es la regla verdadera, y es MÁS fuerte que la anterior en lo que importa:
  // sin prueba la sesión se crea (CD-15/AC-13) pero **no queda atada a nada**, y en particular NO
  // queda atada al valor del body. M-33 ("saltear el PoP cuando el body trae vendorData") sigue
  // muriendo acá, y muere por el aserto que importa: a Didit no le llega `body.vendorData`.
  it("T-SE-2: con host y SIN PoP ⇒ la sesión SE CREA, pero SIN atar (el body no ata) (M-33)", async () => {
    const fetchMock = fetchOk();
    const res = await POST(req({ vendorData: ADDR_A }));
    expect(
      res.status,
      "sin prueba de posesión la ruta cortó: rechazar la firma de la billetera deja a la persona sin " +
        "poder INICIAR el KYC, que es exactamente lo que CD-15 prohíbe",
    ).toBe(200);
    const sent = sentToAgent(fetchMock) as unknown as { identityRef?: string };
    expect(
      sent.identityRef,
      "la sesión quedó atada a la dirección que vino en el body: quien la mande puede hacer que la " +
        "fila del veredicto de OTRA persona quede a su nombre, y esa fila es la que autoriza el pago",
    ).toBeUndefined();
    // Y sin `identityRef` el agente omite `identityMatches` ⇒ su `payoutAllowed` es `false` ⇒
    // `app/api/kyc/decision/route.ts` NO escribe fila (T-DEC-1): la sesión sin atar no puede producir
    // autoridad de pago para nadie, y el `owner_address` del token queda NULL, que es el mismo
    // fail-closed por construcción de la query owner-scoped.
  });

  it("T-SE-2b: una prueba PRESENTADA y ROTA sigue dando 403, y NO crea sesión", async () => {
    // La distinción que hace el arreglo: no presentar prueba es el camino de hoy; presentar una que
    // no verifica es un intento fallido. Si esto se pusiera verde con 200, cualquiera con un
    // challenge vencido obtendría una sesión y el guard sería decorativo.
    const fetchMock = fetchOk();
    const res = await POST(req({ vendorData: ADDR_A, popChallenge: "roto", popSignature: "roto" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "kyc_session_unverified" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("T-SE-2c: prueba a medias (challenge sin firma) ⇒ 403, no se trata como ausencia", async () => {
    const fetchMock = fetchOk();
    const { popChallenge } = realPop(KP_A);
    const res = await POST(req({ vendorData: ADDR_A, popChallenge }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── T-SE-3 — AC-19 / M-32: EL CASO DEL ATAQUE ─────────────────────────────────────────────────
  it("T-SE-3: PoP de A + `vendorData` de B ⇒ al agente va la dirección de A (M-32)", async () => {
    const fetchMock = fetchOk();
    const res = await POST(req({ vendorData: ADDR_B, ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    const sent = sentToAgent(fetchMock) as unknown as { identityRef: string };
    expect(
      sent.identityRef,
      "la sesión quedó atada a la dirección que vino en el body: quien la mande puede hacer que la " +
        "fila del veredicto de OTRA persona quede a su nombre, y esa fila es la que autoriza el pago",
    ).toBe(ADDR_A);
    expect(sent.identityRef).not.toBe(ADDR_B);
  });

  it("T-SE-3b: sin `vendorData` en el body, al agente va igual la dirección probada", async () => {
    const fetchMock = fetchOk();
    const res = await POST(req({ ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    const sent = sentToAgent(fetchMock) as unknown as { identityRef: string };
    expect(sent.identityRef).toBe(ADDR_A);
  });

  it("T-SE-3c: un challenge de A firmado por B ⇒ 403 (la firma es lo que ata, no el token)", async () => {
    const fetchMock = fetchOk();
    // `realPop(KP_B, KP_A)`: el challenge dice A, pero lo firma B.
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_B, KP_A) }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── T-SE-4 — M-33c: el limiter sigue ANTES del cripto ─────────────────────────────────────────
  it("T-SE-4: el rate-limit corre ANTES del PoP (CPU-DoS) (M-33c)", async () => {
    rlMock.mockResolvedValue({ ok: false, retryAfter: 42 });
    const fetchMock = fetchOk();
    // Body SIN PoP: si el PoP corriera primero, esto sería 403, no 429.
    const res = await POST(req({ vendorData: ADDR_A }));
    expect(
      res.status,
      "el PoP se movió antes del limiter: verificar un HMAC + una firma ed25519 cuesta CPU, y sin " +
        "límite previo eso es un ataque de denegación que cuesta un `curl`",
    ).toBe(429);
    expect(rlMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("T-SE-4b: el limiter sigue usando `body.vendorData` como hint, como antes (declarado)", async () => {
    fetchOk();
    await POST(req({ vendorData: "0xabc", ...realPop(KP_A) }));
    // Se declara en el código: moverlo a la dirección probada lo pondría DESPUÉS del cripto. Ese
    // valor ya era forjable antes de esta HU, así que no se debilita nada — pero queda medido.
    expect(rlMock).toHaveBeenCalledWith({ ip: "9.9.9.9", address: "0xabc" });
  });

  // ── T-SE-5 — M-4b: los cinco fallos son indistinguibles entre sí ──────────────────────────────
  //
  // ⚠️ EL CASO P1 CAMBIÓ CON AR/BLQ-ALTO-2, y el porqué es el arreglo mismo. Era "sin challenge/firma",
  // que ya NO es un fallo: no presentar prueba es el camino de hoy y devuelve 200 sin atar (T-SE-2).
  // Lo que este test custodia —que los cinco fallos de una prueba PRESENTADA sean indistinguibles— no
  // cambió, así que P1 pasa a ser la prueba INCOMPLETA, que es su forma de fallar hoy. Dejarlo como
  // estaba habría puesto rojo el test correcto por medir un caso que dejó de pertenecer al conjunto.
  it("T-SE-5: los 5 fallos del PoP dan el MISMO status y el MISMO cuerpo, comparados entre sí (M-4b)", async () => {
    fetchOk();
    const good = realPop(KP_A);
    const inputs: Array<[string, Record<string, unknown>]> = [
      ["P1 · challenge presente, firma ausente", { vendorData: ADDR_A, popChallenge: good.popChallenge }],
      ["P2 · challenge con HMAC roto", { popChallenge: "no-es-un-token", popSignature: good.popSignature }],
      ["P3 · challenge de A firmado por B", { ...realPop(KP_B, KP_A) }],
      [
        "P4 · network-id que no es el del server",
        {
          popChallenge: issueSolanaPopChallenge({
            address: ADDR_A,
            networkId: "solana:mainnet",
            nonce: "0123456789abcdef0123456789abcdef",
            exp: Math.floor(Date.now() / 1000) + 300,
          }),
          popSignature: good.popSignature,
        },
      ],
      ["P5 · firma que no verifica", { popChallenge: good.popChallenge, popSignature: bs58.encode(new Uint8Array(64).fill(7)) }],
    ];
    const seen: Array<{ label: string; status: number; body: string }> = [];
    for (const [label, payload] of inputs) {
      const res = await POST(req(payload));
      seen.push({ label, status: res.status, body: await res.text() });
    }
    const first = seen[0]!;
    for (const s of seen) {
      expect(
        { status: s.status, body: s.body },
        `el fallo "${s.label}" se distingue de "${first.label}": cada diferencia le dice a un ` +
          "desconocido en qué paso falló, y eso es un mapa para forjar la prueba de posesión",
      ).toEqual({ status: first.status, body: first.body });
    }
    expect(first.status).toBe(403);
    expect(JSON.parse(first.body)).toEqual({ error: "kyc_session_unverified" });
  });

  it("T-SE-6: con host y SIN PAYOUT_POP_SECRET ⇒ 503 fail-closed, nunca un 500 crudo", async () => {
    // Sin el guard explícito, `verifySolanaPopChallenge` tira "PAYOUT_POP_SECRET missing" y sale una
    // excepción sin manejar. Un deployment así no puede atar la sesión a nadie: no crea ninguna.
    const proof = realPop(KP_A); // se emite CON secreto, se presenta SIN él
    vi.stubEnv("PAYOUT_POP_SECRET", "");
    const fetchMock = fetchOk();
    const res = await POST(req({ vendorData: ADDR_A, ...proof }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "kyc_session_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── T-SE-7 — CR/BLQ-BAJO-2: el 502 de Didit nombra CUÁL de sus causas fue ─────────────────────────
//
// 🔴 QUÉ PROBLEMA CIERRA, Y POR QUÉ ES UN TEST DE OBSERVABILIDAD. `app/api/kyc/session/route.ts` no
// tenía UNA sola línea de log —`command grep -n "logger\.\|console\." app/api/kyc/session/route.ts`
// devolvía exit 1— y su 502 colapsa TODO fallo del proveedor. El modo de falla que introdujo esta HU
// (que Didit rechace el body SIN `vendor_data`, o sea el camino sin atar de AR/BLQ-ALTO-2) se veía
// EXACTAMENTE igual que una caída de Didit, un `workflow_id` inválido o un rate-limit suyo: "suben
// los 502", sin causa nombrable. Es el multiplicador de CR/BLQ-MED-1, porque el supuesto que ese
// hallazgo dejó apoyado en documentación —no en una llamada real— se manifestaría justo acá.
describe("POST /api/kyc/session — el 502 del agente nombra su causa, y sin PII (WKH-333/CR-BLQ-BAJO-2)", () => {
  function fetchFail(status: number) {
    const m = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return { ok: false, status, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", m);
    return m;
  }

  it("T-SE-7: sesión SIN atar rechazada por Didit ⇒ el log dice `atada:false` + el status upstream", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchFail(400);
    const res = await POST(req({ vendorData: ADDR_A })); // SIN PoP ⇒ sesión sin atar
    expect(res.status).toBe(502);
    expect(
      warn,
      "el rechazo de Didit a una sesión SIN `vendor_data` —el modo de falla propio de esta HU— sale " +
        "por el mismo 502 mudo que una caída del proveedor: el incidente no tendría causa nombrable",
    ).toHaveBeenCalledWith("[kyc-session] kyc_session_failed", { atada: false, upstream: 400 });
  });

  it("T-SE-7b: sesión ATADA rechazada ⇒ `atada:true`, y la DIRECCIÓN no aparece en ningún lado", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchFail(503);
    const res = await POST(req({ ...realPop(KP_A) }));
    expect(res.status).toBe(502);
    expect(
      warn,
      "`atada` quedó constante: un log que dice lo mismo pase lo que pase no distingue nada, que es " +
        "el estado del que este candado saca a la ruta",
    ).toHaveBeenCalledWith("[kyc-session] kyc_session_failed", { atada: true, upstream: 503 });
    // VALUE-FREE (CD-2/CD-9): `atada` es un booleano DERIVADO de si hubo dirección probada. Si alguien
    // "mejora" el log poniendo la dirección —o el vendor_data, o el challenge— esto se pone rojo.
    expect(
      JSON.stringify(warn.mock.calls),
      "el log filtró la dirección de la billetera: es el identificador de la persona en este flujo y " +
        "termina en los logs del proveedor de hosting, fuera de la base que tiene el filtro por dueño",
    ).not.toContain(ADDR_A);
  });

  it("T-SE-7c: en el camino FELIZ no se emite nada — este log NO cuenta las sesiones sin atar", async () => {
    // Clava el LÍMITE que el docblock de la ruta declara, para que nadie se apoye en esta línea para
    // dimensionar el consumo de cupo por la deduplicación que Didit pierde cuando falta `vendor_data`.
    // Sólo hay señal en el FALLO. Si algún día se quiere medir el camino feliz, hay que agregar otra.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => AGENT_OK })),
    );
    const res = await POST(req({ vendorData: ADDR_A })); // sin atar, y exitosa
    expect(res.status).toBe(200);
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith("[kyc-session]"))).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-233 — el token at-rest: CD-20 (no sale nunca) y la escritura que NO es best-effort
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("POST /api/kyc/session — T-SES-1/T-TOK-3/T-TOK-4/T-TOK-6", () => {
  function fetchOkAgent() {
    const m = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return { ok: true, status: 200, json: async () => AGENT_OK };
    });
    vi.stubGlobal("fetch", m);
    return m;
  }

  // ── T-SES-1 — AC-8/P-1/CD-1 ────────────────────────────────────────────────────────────────────
  it("T-SES-1: con el limiter AGOTADO, el doble de `fetch` recibe CERO llamadas (no mira el status)", async () => {
    rlMock.mockResolvedValue({ ok: false, retryAfter: 42 });
    const fetchMock = fetchOkAgent();
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    // 🧬 MUTANTE: borrar `checkKycRateLimit` ⇒ el doble recibe 1 llamada ⇒ ROJO. Y el mutante importa:
    // 🔴 EL AGENTE NO TIENE RATE LIMIT. Si el límite sale de acá, no lo cubre nadie, y cada sesión
    // creada consume cuota del proveedor.
    expect(fetchMock, "se gastó cuota del proveedor con el limiter agotado").toHaveBeenCalledTimes(0);
    expect(putMock, "se escribió un token de una sesión que nunca se creó").toHaveBeenCalledTimes(0);
    expect(res.status).toBe(429);
  });

  it("✅ calibración inversa: con el limiter OK, el agente recibe EXACTAMENTE 1 llamada", async () => {
    const fetchMock = fetchOkAgent();
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── T-TOK-3 — CD-20: el barrido de la RESPUESTA ───────────────────────────────────────────────
  it("T-TOK-3: el `decisionToken` NO aparece en el body NI en ninguna cabecera de la respuesta", async () => {
    fetchOkAgent();
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    const cuerpo = await res.text();
    const cabeceras = JSON.stringify([...res.headers.entries()]);
    // 🧬 MUTANTE: devolver el token en el JSON ⇒ ROJO acá, en la primera de las tres rutas barridas.
    expect(cuerpo, "el decisionToken salió en el body: es una credencial del money-path").not.toContain(
      TOKEN_CENTINELA,
    );
    expect(cabeceras, "el decisionToken salió en una cabecera").not.toContain(TOKEN_CENTINELA);
    // ✅ Calibración: la respuesta SÍ trae lo que tiene que traer (un barrido sobre una respuesta
    // vacía también pasaría el assert de arriba).
    expect(JSON.parse(cuerpo)).toMatchObject({ sessionId: "s1", url: AGENT_OK.url });
  });

  // ── T-TOK-4 — CD-20: el barrido de los LOGS ───────────────────────────────────────────────────
  it.each([
    ["camino feliz", true],
    ["camino de fallo del agente", false],
    ["camino de fallo de la escritura", null],
  ])("T-TOK-4: en el %s, ningún `console.*` lleva el token", async (_caso, feliz) => {
    const capturado: string[] = [];
    const anotar = (...a: unknown[]) => {
      capturado.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    };
    vi.spyOn(console, "warn").mockImplementation(anotar);
    vi.spyOn(console, "error").mockImplementation(anotar);
    vi.spyOn(console, "log").mockImplementation(anotar);
    if (feliz === false) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })),
      );
    } else {
      fetchOkAgent();
      if (feliz === null) putMock.mockRejectedValue(new Error("kyc_session_token_write_failed:42P01"));
    }
    await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    // 🧬 MUTANTE: `console.warn("[kyc-session]", { decisionToken })` ⇒ ROJO.
    expect(capturado.join("\n")).not.toContain(TOKEN_CENTINELA);
    // ✅ Y los logs de fallo SIGUEN emitiéndose, value-free: un módulo que no loguea nada también
    // pasaría el assert de arriba, y sería el fallo indiagnosticable que ya costó un incidente.
    if (feliz !== true) expect(capturado.join("\n")).toContain("[kyc-session]");
  });

  // ── T-TOK-6 — la escritura NO es best-effort ──────────────────────────────────────────────────
  it("T-TOK-6: si `put` LANZA ⇒ 503 `kyc_session_unavailable` y el body NO trae `url`", async () => {
    fetchOkAgent();
    putMock.mockRejectedValue(new Error("kyc_session_token_write_failed:42P01"));
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    // 🧬 MUTANTE: tragarse el error y devolver 200 con la url ⇒ ROJO por los DOS asserts. Y el mutante
    // es el caro: la persona escanearía su documento para un veredicto que NADIE va a poder consultar,
    // porque el `decisionToken` no se puede re-emitir (CD-21).
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "kyc_session_unavailable" });
    expect(body.url).toBeUndefined();
  });

  it("T-TOK-6b: sin store (envs de Supabase ausentes) ⇒ el MISMO 503, sin código nuevo", async () => {
    fetchOkAgent();
    storeMock.mockReturnValue(null);
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "kyc_session_unavailable" });
  });

  it("✅ calibración: con `put` OK ⇒ 200, y el token se persistió con el dueño PROBADO", async () => {
    fetchOkAgent();
    const res = await POST(req({ vendorData: ADDR_B, ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    // ⛔ `ownerAddress` sale de la dirección PoP-PROBADA (A), NUNCA de `body.vendorData` (B).
    expect(putMock).toHaveBeenCalledWith({
      sessionId: "s1",
      decisionToken: TOKEN_CENTINELA,
      ownerAddress: ADDR_A,
    });
  });

  it("sin prueba de posesión, el token se persiste con `ownerAddress: null` (sesión SIN ATAR)", async () => {
    fetchOkAgent();
    const res = await POST(req({ vendorData: ADDR_A })); // sin PoP
    expect(res.status).toBe(200);
    // 🔴 Y ese `null` es lo que hace que esta sesión JAMÁS pueda autorizar un desembolso: un
    // `.eq("owner_address", X)` nunca matchea un NULL. No es un chequeo que alguien tenga que
    // recordar: es la forma de la query.
    expect(putMock).toHaveBeenCalledWith({
      sessionId: "s1",
      decisionToken: TOKEN_CENTINELA,
      ownerAddress: null,
    });
  });

  it("la escritura corre DESPUÉS del agente (antes no existe el sessionId) y con el limiter pasado", async () => {
    const orden: string[] = [];
    rlMock.mockImplementation(async () => {
      orden.push("limiter");
      return { ok: true };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        orden.push("agente");
        return { ok: true, status: 200, json: async () => AGENT_OK };
      }),
    );
    putMock.mockImplementation(async () => {
      orden.push("put");
    });
    await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(orden).toEqual(["limiter", "agente", "put"]);
  });
});
