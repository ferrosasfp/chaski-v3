import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock del helper de rate-limit → controlamos el veredicto sin Upstash real.
const { rlMock } = vi.hoisted(() => ({ rlMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/rate-limit", () => ({ checkKycRateLimit: rlMock }));

// WKH-233 — el store del `decisionToken`. Se mockea el MÓDULO (no la base) para poder contar
// llamadas y forzar el fallo de la escritura, que es lo que T-TOK-6 mide.
// hotfix 2026-08-20 · F-2: el pre-vuelo (`probeReachable`) corre ANTES del viaje al agente, así que
// el doble del store tiene que tenerlo o TODO `it` que llegue al agente moriría con un TypeError.
const { putMock, probeMock, storeMock } = vi.hoisted(() => ({
  putMock: vi.fn(),
  probeMock: vi.fn(),
  storeMock: vi.fn(),
}));
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
import { UPSTREAM_INVOKE_SECRET_UNSET } from "../../../../src/infrastructure/kyc/agent-kyc-client";
// hotfix 2026-08-20 · F-3: el doble de la tabla, COMPARTIDO con la suite del store (T-HF3-R).
import { makeKycSessionTokensDb } from "../../../../src/test-support/kyc-session-tokens-db";

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
  probeMock.mockReset();
  probeMock.mockResolvedValue(undefined);
  storeMock.mockReset();
  storeMock.mockReturnValue({ put: putMock, probeReachable: probeMock });
  vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
  // WKH-233 (fix-pack · H-3): la credencial de invoke es OBLIGATORIA desde que `invokeAuthHeader`
  // es fail-closed, así que sembrarla es PRE-REQUISITO de cualquier `it` que llegue al agente —
  // igual que el host de la línea de arriba. Sin esto, 45 `it` de tres archivos morían con
  // `kyc_agent_invoke_secret_unset` antes de llegar a lo que miden.
  vi.stubEnv("KYC_AGENT_INVOKE_SECRET", "invoke-secret-de-test");
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

  it("T-TOK-6b: sin store (envs de Supabase ausentes) ⇒ el MISMO 503, y el agente recibe CERO llamadas", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = fetchOkAgent();
    storeMock.mockReturnValue(null);
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "kyc_session_unavailable" });
    // 🔴 AR/BLQ-BAJO-2 — ESTA ES LA LÍNEA NUEVA, Y NO MIRA EL STATUS: cuenta LLAMADAS. El 503 ya salía
    // antes del fix; lo que NO salía es sin gastar una verificación del proveedor. La resolución del
    // store vivía DESPUÉS de `createAgentKycSession`, así que cada request con las envs de Supabase
    // ausentes creaba una sesión REAL en el agente —cuota quemada— y recién después contestaba 503.
    // Con el limiter en 5/10min, cada IP quemaba 5 cupos por ventana, indefinidamente.
    // 🧬 MUTANTE: bajar `const tokenStore = getKycSessionTokenStore()` a donde estaba (después del
    // agente) ⇒ el doble recibe 1 llamada ⇒ ROJO, con el status todavía en 503.
    expect(
      fetchMock,
      "se creó una sesión REAL en el agente —cuota del proveedor gastada— para después contestar 503 " +
        "por una misconfig NUESTRA que se podía chequear gratis antes de salir a la red",
    ).toHaveBeenCalledTimes(0);
    // ⛔ Y el `put` tampoco: sin store no hay a quién escribirle.
    expect(putMock).toHaveBeenCalledTimes(0);
  });

  // ── AR/BLQ-BAJO-1 — el cliente RECHAZA, y el 502 lo tiene que producir ESTA route ──────────────
  //
  // 🔴 QUÉ AGUJERO CIERRA. T-SE-7/T-SE-7b cubren el camino `{ ok:false, upstream }`, o sea el agente
  // que CONTESTA mal. `createAgentKycSession` tiene otro camino entero: RECHAZA (transporte caído,
  // JSON roto, raíz no-objeto, y cada clave del contrato faltante o con el tipo equivocado). Ese
  // camino no pasaba por ningún `catch` de esta route ⇒ el rechazo escapaba, Next devolvía un **500
  // genérico**, y el `console.warn("[kyc-session] kyc_session_failed", …)` —que existe justamente
  // para que el incidente tenga causa nombrable— NO SE EMITÍA NUNCA.
  it("T-SE-8: agente INALCANZABLE ⇒ 502 `kyc_session_failed` con `upstream: 0`, y CON su log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    // 🧬 MUTANTE: quitarle el `try/catch` a `createAgentKycSession` ⇒ esta promesa RECHAZA ⇒ ROJO.
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(fetchMock, "el caso no llegó a ejercitar el borde").toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "kyc_session_failed", upstream: 0 });
    // 🔴 Y el log, que es la mitad que importa: sin él "suben los 502" no tiene causa nombrable, y
    // una caída del agente se ve igual que un 400 suyo. `atada` sigue siendo un booleano DERIVADO.
    expect(
      warn,
      "la caída del agente —el modo de falla más común de un servicio en otro deployment— salía por " +
        "un 500 genérico y sin una sola línea de log",
    ).toHaveBeenCalledWith("[kyc-session] kyc_session_failed", { atada: true, upstream: 0 });
    // ⛔ Value-free: ni la dirección ni el challenge ni la firma aparecen en el log.
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ADDR_A);
    // ⛔ Y NO se escribió ningún token de una sesión que nunca se creó.
    expect(putMock).toHaveBeenCalledTimes(0);
  });

  it("T-SE-8b: agente que contesta 200 SIN `decisionToken` ⇒ el MISMO 502, sin eco de la clave", async () => {
    // 🔴 EL CASO NUEVO DE ESTA HU, y es exactamente el que la cabecera del cliente dice manejar: el
    // borde no se castea, se ESTRECHA, así que una clave faltante tira
    // `kyc_agent_bad_response:session:decisionToken` en vez de viajar como `undefined` hasta el store.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decisionToken: _sinToken, ...sinCredencial } = AGENT_OK;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => sinCredencial })),
    );
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "kyc_session_failed", upstream: 0 });
    // ⛔ El nombre de la clave que faltó NO sale al cliente ni al log de esta route: viene del
    // `message` del error, que es lo único que este `catch` tiene prohibido tocar.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("kyc_agent_bad_response");
    expect(putMock, "se persistió un token que el agente nunca mandó").toHaveBeenCalledTimes(0);
  });

  // ── re-AR it2 / BLQ-MED-2 — LA MISCONFIG NUESTRA NO SE DISFRAZA DE "EL AGENTE NO CONTESTÓ" ──────
  //
  // 🔴 QUÉ AGUJERO CIERRA, Y ES EL QUE ABRIÓ LA 1ª ITERACIÓN DEL FIX-PACK. El fail-closed de la
  // credencial hacía que el throw saliera por el `catch` del transporte ⇒ `upstream: 0`, o sea el
  // MISMO body que T-SE-8 (agente inalcanzable). El `401` del agente —el único dato del body que
  // apuntaba a la credencial— desaparecía, y el log decía `session_transport_failed`. Dos causas que
  // se arreglan distinto (setear una env vs. mirar el deployment del agente) colapsadas en una.
  //
  // 🧬 MUTANTE: volver el `catch` a `r = { ok: false, upstream: 0 }` ⇒ este `it` ROJO y T-SE-8 verde.
  it("T-SE-8c: SIN `KYC_AGENT_INVOKE_SECRET` ⇒ 502 con un `upstream` PROPIO, y sin gastar el viaje", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", undefined);
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("kyc_session_failed");
    // 1. El `upstream` DISTINGUE. Es lo único que el operador lee del body.
    expect(body.upstream, "la misconfig se ve igual que un agente caído").toBe(
      UPSTREAM_INVOKE_SECRET_UNSET,
    );
    expect(body.upstream).not.toBe(0);
    // 2. Y no salió ningún viaje: no se le preguntó por la identidad de nadie sin acreditarse.
    expect(fetchMock).toHaveBeenCalledTimes(0);
    // 3. El log de la route lleva el mismo valor (el del cliente, con el NOMBRE de la env, lo mide
    //    `T-CLI-4''`).
    expect(warn).toHaveBeenCalledWith("[kyc-session] kyc_session_failed", {
      atada: true,
      upstream: UPSTREAM_INVOKE_SECRET_UNSET,
    });
    expect(putMock).toHaveBeenCalledTimes(0);
  });

  it("✅ calibración: con la respuesta COMPLETA, la misma ruta devuelve 200 (el 502 no es constante)", async () => {
    fetchOkAgent();
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ sessionId: "s1" });
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

// ══════════════════════════════════════════════════════════════════════════════════════════════════
//  HOTFIX 2026-08-20 — la causa en el log (F-1) + la cuota que no se quema por misconfig nuestra (F-2)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// EL HECHO QUE LOS PIDE, medido en producción: `POST /api/kyc/session` → 503 con el log
// `kyc_session_token_write_failed { atada: true }`, y el agente había contestado **200** en el mismo
// segundo ⇒ la sesión SE CREÓ en el proveedor, la cuota SE GASTÓ, y la persona no recibió la URL.
// Dos defectos distintos: (1) el `catch` descartaba el error entero, así que no había causa; (2) lo
// que puede fallar por culpa NUESTRA corría después de gastar la cuota.
describe("POST /api/kyc/session — hotfix: la causa se loguea y la cuota no se quema", () => {
  function fetchOkAgent() {
    const m = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return { ok: true, status: 200, json: async () => AGENT_OK };
    });
    vi.stubGlobal("fetch", m);
    return m;
  }

  /** Captura de TODOS los `console.*` en un solo array, como hace T-TOK-4. */
  function capturarLogs(): string[] {
    const capturado: string[] = [];
    const anotar = (...a: unknown[]) => {
      capturado.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    };
    vi.spyOn(console, "warn").mockImplementation(anotar);
    vi.spyOn(console, "error").mockImplementation(anotar);
    vi.spyOn(console, "log").mockImplementation(anotar);
    return capturado;
  }

  // ── F-2 — EL CANDADO, Y NO MIRA EL STATUS: CUENTA LLAMADAS ───────────────────────────────────
  it("T-HF-1: con la persistencia ROTA, el doble de `fetch` recibe CERO llamadas (y el status es 503)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = fetchOkAgent();
    probeMock.mockRejectedValue(new Error("kyc_session_token_probe_failed:42P01"));
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    // 🧬 MUTANTE: bajar `await tokenStore.probeReachable()` a después de `createAgentKycSession`
    // ⇒ el doble recibe 1 llamada ⇒ ROJO, con el status TODAVÍA en 503. Por eso el assert que vale
    // es el CONTADOR: el 503 ya salía antes del hotfix, y salía DESPUÉS de gastar una verificación.
    expect(
      fetchMock,
      "se creó una sesión REAL en el agente —cuota del proveedor gastada— para después contestar 503 " +
        "por una misconfig NUESTRA que se podía detectar antes de salir a la red",
    ).toHaveBeenCalledTimes(0);
    expect(putMock, "se intentó escribir un token de una sesión que nunca se creó").toHaveBeenCalledTimes(0);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "kyc_session_unavailable" });
  });

  it("✅ calibración inversa: con el pre-vuelo OK el agente recibe EXACTAMENTE 1 llamada", async () => {
    // Sin esta mitad, un pre-vuelo que SIEMPRE cortara pasaría T-HF-1 en verde y nadie podría
    // verificarse nunca.
    const fetchMock = fetchOkAgent();
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(probeMock).toHaveBeenCalledTimes(1);
  });

  it("T-HF-2: el pre-vuelo corre DESPUÉS del limiter y ANTES del agente, y el `put` sigue al final", async () => {
    const orden: string[] = [];
    rlMock.mockImplementation(async () => {
      orden.push("limiter");
      return { ok: true };
    });
    probeMock.mockImplementation(async () => {
      orden.push("prevuelo");
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
    expect(orden).toEqual(["limiter", "prevuelo", "agente", "put"]);
  });

  it("⚠️ LO QUE EL PRE-VUELO **NO** CUBRE: un fallo del INSERT sigue ocurriendo con la cuota YA gastada", async () => {
    // Esto NO es un defecto del test: es el residual declarado. `probeReachable` hace un `select`, y
    // un `select` no ejercita el `insert` (23505, restricciones de columna, GRANT que niega INSERT).
    // El test existe para que nadie lea el verde de T-HF-1 como "ya no puede pasar".
    const capturado = capturarLogs();
    const fetchMock = fetchOkAgent();
    putMock.mockRejectedValue(new Error("kyc_session_token_write_failed:23505"));
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(fetchMock, "la cuota SÍ se gastó en esta clase de fallo, y así se declara").toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    // Y la etiqueta lo distingue: quien lee el log sabe si la verificación se gastó o no.
    expect(capturado.join("\n")).toContain("kyc_session_token_write_failed");
    expect(capturado.join("\n")).not.toContain("kyc_session_token_probe_failed");
  });

  // ── F-1 — LA CAUSA ────────────────────────────────────────────────────────────────────────────
  it("T-HF-3: el 503 de la ESCRITURA loguea el SQLSTATE, no sólo la etiqueta", async () => {
    const capturado = capturarLogs();
    fetchOkAgent();
    putMock.mockRejectedValue(new Error("kyc_session_token_write_failed:42P01"));
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(503);
    // 🧬 MUTANTE: volver a `} catch {` (descartar el error entero) ⇒ ROJO. Y ése ES el mutante: el
    // incidente del 2026-08-20 dejó `{ atada: true }` y nada más, y se diagnosticó con hipótesis.
    expect(console.warn).toHaveBeenCalledWith("[kyc-session] kyc_session_token_write_failed", {
      atada: true,
      errorName: "Error",
      errorCode: "kyc_session_token_write_failed",
      dbCode: "42P01",
    });
    // ⛔ Y el `message` crudo del driver NO viaja: sólo el código.
    expect(capturado.join("\n")).not.toContain("boom");
  });

  it("T-HF-4: `address_canonicalization_failed` NO se disfraza de «no se pudo escribir»", async () => {
    // 🔴 LA SEGUNDA MENTIRA DE LA ETIQUETA VIEJA: `canonicalizeAddress` corre dentro de `put`, o sea
    // dentro del mismo `try`, así que "no se pudo escribir" podía ser en realidad "la dirección no
    // era válida". Dos causas que se arreglan distinto no pueden compartir una etiqueta.
    // ⚠️ Se simula con un `put` que tira ESE error, y se dice por qué: desde esta route el
    // `provedAddress` ya viene canonicalizado por P3, así que ningún input REAL puede llegar acá con
    // una dirección inválida. Lo que este `it` clava es el LOG, no la alcanzabilidad de la rama.
    capturarLogs();
    fetchOkAgent();
    putMock.mockRejectedValue(new Error("address_canonicalization_failed"));
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(503);
    expect(console.warn).toHaveBeenCalledWith("[kyc-session] kyc_session_token_write_failed", {
      atada: true,
      errorName: "Error",
      errorCode: "address_canonicalization_failed",
    });
  });

  it("T-HF-5: el 503 del PRE-VUELO loguea su propio código, con su etiqueta propia", async () => {
    capturarLogs();
    const fetchMock = fetchOkAgent();
    probeMock.mockRejectedValue(new Error("kyc_session_token_probe_failed:PGRST301"));
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(console.warn).toHaveBeenCalledWith("[kyc-session] kyc_session_token_probe_failed", {
      atada: true, // sale de si hubo dirección PROBADA; acá la hubo (el `it` presenta un PoP real)
      errorName: "Error",
      errorCode: "kyc_session_token_probe_failed",
      dbCode: "PGRST301",
    });
  });

  it("T-HF-6: «otra cosa» se ve como otra cosa — un error de runtime no finge ser un SQLSTATE", async () => {
    capturarLogs();
    fetchOkAgent();
    putMock.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'x')"));
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(503);
    // El `message` no arranca con un código en minúsculas ⇒ `errorCode` NO se emite, y `dbCode`
    // tampoco. Lo que queda es `errorName: "TypeError"`, que es exactamente la tercera clase.
    expect(console.warn).toHaveBeenCalledWith("[kyc-session] kyc_session_token_write_failed", {
      atada: true,
      errorName: "TypeError",
    });
  });

  it("T-HF-7: ⛔ VALUE-FREE — ni el token, ni el sessionId, ni la dirección entran al log por el `err`", async () => {
    const capturado = capturarLogs();
    fetchOkAgent();
    // Un `message` que trae TODO lo que no puede salir. El extractor toma el prefijo hasta el primer
    // `:` y nada más, así que la cola —que acá lleva la pubkey y el token— se descarta entera.
    putMock.mockRejectedValue(
      new Error(`kyc_session_token_write_failed: fila ${ADDR_A} token ${TOKEN_CENTINELA} url https://x.test`),
    );
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(503);
    const texto = capturado.join("\n");
    // 🧬 MUTANTE: ecoar `err.message` (o `String(err)`) en vez del código ⇒ ROJO por los TRES.
    expect(texto, "el decisionToken salió en un log").not.toContain(TOKEN_CENTINELA);
    expect(texto, "la dirección de la persona salió en un log").not.toContain(ADDR_A);
    expect(texto, "la cola del message del driver salió en un log").not.toContain("https://x.test");
    // ✅ Calibración: y sin embargo el log SIGUE diciendo la causa (un log vacío también pasaría
    // los tres asserts de arriba, y sería el fallo indiagnosticable que costó este incidente).
    expect(texto).toContain("kyc_session_token_write_failed");
  });

  it("T-HF-8: una cola que NO tiene forma de SQLSTATE no se emite (el filtro es por FORMA, no por confianza)", async () => {
    capturarLogs();
    fetchOkAgent();
    putMock.mockRejectedValue(new Error("kyc_session_token_write_failed:eyJhbGciOiJIUzI1NiJ9.secreto"));
    await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    // `dbCode` AUSENTE: la cola tiene minúsculas y un punto, así que no matchea SQLSTATE/PGRST/unknown.
    expect(console.warn).toHaveBeenCalledWith("[kyc-session] kyc_session_token_write_failed", {
      atada: true,
      errorName: "Error",
      errorCode: "kyc_session_token_write_failed",
    });
  });

  it("T-HF-9: sin `code` del driver, el store escribe `unknown` y el log lo dice (no lo omite)", async () => {
    capturarLogs();
    fetchOkAgent();
    putMock.mockRejectedValue(new Error("kyc_session_token_write_failed:unknown"));
    await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    // "el driver no trajo código" es un dato distinto de "no miré el código", y se distingue.
    expect(console.warn).toHaveBeenCalledWith("[kyc-session] kyc_session_token_write_failed", {
      atada: true,
      errorName: "Error",
      errorCode: "kyc_session_token_write_failed",
      dbCode: "unknown",
    });
  });

  it("T-HF-10: sin PoP el pre-vuelo igual corre, y el log dice `atada:false`", async () => {
    capturarLogs();
    const fetchMock = fetchOkAgent();
    probeMock.mockRejectedValue(new Error("kyc_session_token_probe_failed:42P01"));
    const res = await POST(req({ vendorData: ADDR_A })); // sin PoP ⇒ sesión SIN ATAR
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(console.warn).toHaveBeenCalledWith("[kyc-session] kyc_session_token_probe_failed", {
      atada: false,
      errorName: "Error",
      errorCode: "kyc_session_token_probe_failed",
      dbCode: "42P01",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
//  T-HF3-R — LA SESIÓN QUE EL PROVEEDOR DEVUELVE REPETIDA, CONTRA EL STORE **REAL**
//  (hotfix 2026-08-20 · F-3)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 ACÁ EL `put` NO ES UN DOBLE. Todo el resto de este archivo mockea el módulo del store para poder
// contar llamadas; estos `it` lo traen con `vi.importActual` y lo montan sobre el doble COMPARTIDO de
// la tabla (`src/test-support/kyc-session-tokens-db.ts`, el mismo que usa la suite del store). Sin
// esto, el arreglo de F-3 estaría medido en el store y la route quedaría atada a él sólo por un
// literal copiado a mano — y un literal copiado a mano no lo vigila nadie.
//
// LO QUE REPRODUCE, con su hora: `AGENT_OK.sessionId` es SIEMPRE `"s1"`, o sea que el doble del
// agente devuelve la MISMA sesión en las dos llamadas. Eso no es un atajo del test: es exactamente
// lo que hizo el proveedor el 2026-08-20 (21:22:14 sin atar, 21:43:40 la misma sesión con PoP).
//
// ⚠️ LO QUE **NO** MIDE: nada de la base real. El doble no tiene transacciones, ni concurrencia, ni
// triggers ⇒ el candado de base de la migración de F-3 no se ejercita en ningún verde de acá.
describe("T-HF3-R · la sesión repetida del proveedor, con el store REAL", () => {
  const RUTA_STORE = "../../../../src/infrastructure/persistence/supabase-kyc-session-tokens";

  async function storeReal(seed: Parameters<typeof makeKycSessionTokensDb>[0]) {
    const { SupabaseKycSessionTokenStore } =
      await vi.importActual<typeof import("../../../../src/infrastructure/persistence/supabase-kyc-session-tokens")>(
        RUTA_STORE,
      );
    const db = makeKycSessionTokensDb(seed);
    storeMock.mockReturnValue(new SupabaseKycSessionTokenStore(db.client));
    return db;
  }

  function fetchOkAgent() {
    const m = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return { ok: true, status: 200, json: async () => AGENT_OK };
    });
    vi.stubGlobal("fetch", m);
    return m;
  }

  function capturarLogs(): string[] {
    const capturado: string[] = [];
    const anotar = (...a: unknown[]) => {
      capturado.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    };
    vi.spyOn(console, "warn").mockImplementation(anotar);
    return capturado;
  }

  it("T-HF3-R1: primero SIN PoP y después CON PoP sobre la MISMA sesión ⇒ 200 y la fila queda ATADA", async () => {
    const db = await storeReal([]);
    fetchOkAgent();
    const r1 = await POST(req({ vendorData: ADDR_A })); // 21:22:14 — sin prueba de posesión
    const r2 = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) })); // 21:43:40 — con PoP
    expect(r1.status).toBe(200);
    // 🧬 MUTANTE: el `insert` pelado de antes ⇒ acá 503 y el log `..._write_failed dbCode 23505`,
    // que es LITERALMENTE lo que el founder recibió en producción.
    expect(r2.status, "la segunda llamada sobre la misma sesión del proveedor sigue sin poder atar").toBe(200);
    // Y devuelve lo que la persona necesita para ir a verificarse, no un 503 sin URL:
    expect((await r2.json()) as Record<string, unknown>).toMatchObject({
      sessionId: "s1",
      url: AGENT_OK.url,
    });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]?.owner_address, "la sesión quedó sin atar: no puede autorizar el desembolso").toBe(ADDR_A);
    expect(db.rows[0]?.decision_token).toBe(TOKEN_CENTINELA);
  });

  it("T-HF3-R2: la sesión ya atada a OTRA dirección ⇒ 503, la fila INTACTA y su propia etiqueta en el log", async () => {
    const capturado = capturarLogs();
    const db = await storeReal([
      { session_id: "s1", decision_token: "k1.token-de-B", owner_address: ADDR_B },
    ]);
    fetchOkAgent();
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));

    // Primero la fila: un 503 sin mirar la tabla no distingue "rechazó" de "pisó y después falló".
    expect(
      db.rows[0]?.owner_address,
      "la sesión de otra persona quedó REATADA desde la route: con esa fila, A autoriza el desembolso de B",
    ).toBe(ADDR_B);
    expect(db.rows[0]?.decision_token, "la credencial de B quedó pisada").toBe("k1.token-de-B");
    expect(res.status).toBe(503);
    // El conjunto observable de errores NO cambia: el mismo body que esta route ya devuelve. Desde
    // afuera no se dice si esa sesión existe ni de quién es.
    expect(await res.json()).toEqual({ error: "kyc_session_unavailable" });
    // 🔴 Y ACÁ ESTÁ EL LOCK ENTRE LOS DOS ARCHIVOS: la etiqueta la decide un literal en `route.ts` y
    // el código lo produce el store REAL. 🧬 MUTANTE: renombrar `KYC_SESSION_OWNER_CONFLICT` en el
    // store (o el literal de la route) ⇒ ROJO acá, que es lo único que ata las dos copias.
    expect(console.warn).toHaveBeenCalledWith("[kyc-session] kyc_session_owner_conflict", {
      atada: true,
      errorName: "Error",
      errorCode: "kyc_session_owner_conflict",
    });
    // ⛔ Y no se disfraza de problema de infra: son dos causas que se arreglan distinto.
    expect(capturado.join("\n")).not.toContain("kyc_session_token_write_failed");
    // ⛔ CD-20: la credencial que ya estaba guardada no sale por ningún lado.
    expect(capturado.join("\n")).not.toContain("k1.token-de-B");
  });

  it("T-HF3-R3: ✅ calibración — con el store REAL una sesión NUEVA sigue dando 200 (el 200 no es constante)", async () => {
    const db = await storeReal([]);
    fetchOkAgent();
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    expect(db.inserted).toHaveLength(1);
    expect(db.updates).toHaveLength(0);
  });
});
