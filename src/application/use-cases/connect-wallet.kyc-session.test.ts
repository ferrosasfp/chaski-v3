// Tests — DE PUNTA A PUNTA: rechazar la firma al conectar NO puede impedir iniciar el KYC
// (WKH-333/CD-15, AC-13 · AR/BLQ-ALTO-2).
//
// 🔴 POR QUÉ NINGÚN TEST DE UNIDAD VEÍA ESTO. El daño no vivía en ninguna pieza: vivía en la JUNTA.
//   · `connect-wallet.test.ts` (T-CW-2) mide que `ConnectWallet` no rompe. Cierto, y no alcanza.
//   · `start-kyc.verdict.test.ts` mide que `not_asked` cae al camino de hoy (llama a `kyc.start`).
//     Cierto, y no alcanza: su `kyc` es un doble.
//   · `app/api/kyc/session/route.test.ts` (T-SE-2) medía que sin PoP la ruta contesta 403 — o sea
//     ASSERTABA el comportamiento que rompe CD-15, en verde.
// Las tres verdes, y la persona que rechazaba la firma no podía verificarse: el 403 llegaba a
// `AgentKycGateway.start`, que lo convierte en `throw kyc_session_failed`.
//
// Por eso este archivo NO mockea ninguno de los eslabones del medio. Arranca en `ConnectWallet` con
// un `PopSigner` que RECHAZA (que es lo que hace la billetera cuando la persona dice que no) y
// termina midiendo el body que salió hacia el proveedor de identidad. Los únicos dobles son los
// bordes del mundo: la billetera, el `localStorage`, el reloj y la red.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// El limiter de la route: sin Upstash env el real es fail-closed y ningún caso llegaría a medirse.
// Es infraestructura de borde, no el eslabón bajo prueba.
const { rlMock } = vi.hoisted(() => ({ rlMock: vi.fn() }));
vi.mock("../../infrastructure/rate-limit", () => ({ checkKycRateLimit: rlMock }));

// WKH-233 — el store del `decisionToken`. También es un borde del mundo (la base), como el limiter:
// sin él la route contesta 503 a propósito (la escritura NO es best-effort) y ningún caso llegaría a
// medirse. Lo que este archivo mide sigue siendo la JUNTA, no la persistencia.
const { putMock } = vi.hoisted(() => ({ putMock: vi.fn() }));
vi.mock("../../infrastructure/persistence/supabase-kyc-session-tokens", () => ({
  getKycSessionTokenStore: () => ({ put: putMock }),
}));

import { POST as KYC_SESSION_POST } from "../../../app/api/kyc/session/route";
import { Money } from "../../domain/money";
import { type Quote, Remittance } from "../../domain/remittance";
import { FallbackKycGateway } from "../../infrastructure/fallback/gateways";
import { AgentKycGateway } from "../../infrastructure/kyc/agent-kyc-gateway";
import { HttpKycVerdictGateway } from "../../infrastructure/kyc/http-kyc-verdict-gateway";
import type { PopSigner, WalletPort } from "../ports";
import {
  FAKE_WALLET_ADDRESS,
  FakeKycPendingStore,
  FakeKycStore,
  FakeWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../../test-support/fakes";
import { ConnectWallet } from "./connect-wallet";
import { StartKyc } from "./start-kyc";
import { esperarConectado } from "../../test-support/desenlaces"; // WKH-359: ConnectWallet.execute() ahora tiene DOS desenlaces. Este helper TIRA si suspendió donde el test no lo espera, en vez de dejar un `undefined` viajando por media suite.
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildSolanaPopMessage, issueSolanaPopChallenge } from "../../infrastructure/auth/pop-challenge"; // WKH-359: el emisor REAL del desafío. Es server-side (importa `node:crypto`) y por eso sólo puede vivir en un test o en una route, NUNCA en el módulo del cliente (CD-13).
import { resolveSolanaNetworkId } from "../../infrastructure/chain";

const AGENT_OK = {
  sessionId: "s1",
  url: "https://verificacion.example/session/s1",
  decisionToken: "k1.token-del-agente",
  provenance: "didit",
};

const quote: Quote = {
  quoteId: "q1",
  send: Money.of(400, "USDC"),
  receive: Money.of(1480, "PEN"),
  feeUsd: Money.of(0.5, "USDC"),
  rate: 3.7,
  etaMinutes: 30,
  expiresAt: QUOTE_EXPIRES,
  provenance: "fake",
};

/** El firmante que RECHAZA: es exactamente lo que devuelve la billetera cuando la persona cierra el
 *  prompt. Los otros tres caminos sin prueba (`prove` → null, y el 429/502 del emisor) terminan en el
 *  mismo lugar y están cubiertos por el caso `null` de más abajo. */
const popQueRechaza: PopSigner = {
  async prove() {
    throw new Error("user_rejected_signature");
  },
};
const popApagado: PopSigner = {
  async prove() {
    return null;
  },
};

/** Todas las llamadas de red que salieron, con su URL y su body. La route y el gateway comparten el
 *  MISMO `fetch` global, así que acá se ve la cadena entera: el `POST /api/kyc/verdict` del gateway,
 *  el `POST /api/kyc/session` del adapter, y el `POST …/api/agents/…/session` que la route le hace al agente. */
let llamadas: Array<{ url: string; body: unknown }>;

function installFetch(): void {
  llamadas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      llamadas.push({ url: u, body });
      if (u === "/api/kyc/session") {
        // 🔴 LA ROUTE DE VERDAD, no un doble. Es la única forma de que este test hable del sistema:
        // el 403 que rompía CD-15 lo producía ella.
        return KYC_SESSION_POST(
          new Request("http://localhost/api/kyc/session", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
            body: String(init?.body ?? "{}"),
          }),
        );
      }
      if (u.includes("/api/agents/")) {
        return new Response(JSON.stringify(AGENT_OK), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // `/api/kyc/verdict` — la tabla apagada, que es el default de producción hoy. Nunca se alcanza
      // en estos casos (el gateway sale antes, sin prueba), y está acá para que si algún día se
      // alcanzara no fuera un `undefined` silencioso.
      return new Response(JSON.stringify({ error: "kyc_verdict_not_enabled" }), { status: 501 });
    }),
  );
}

async function seed(repo: InMemoryRepo): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  await repo.save(r);
  return "r-1";
}

/** La cadena real: conectar → (sin prueba) → iniciar KYC. Devuelve lo que salió a Didit. */
async function conectarYArrancarKyc(pop: PopSigner) {
  const kycStore = new FakeKycStore();
  const repo = new InMemoryRepo();
  const id = await seed(repo);
  const connect = new ConnectWallet(new FakeWallet(), kycStore, new HttpKycVerdictGateway(pop));
  const conectado = esperarConectado(await connect.execute());

  const startKyc = new StartKyc(
    new AgentKycGateway(new FallbackKycGateway()),
    kycStore,
    new FakeKycPendingStore(),
    repo,
    new FixedClock(),
  );
  const res = await startKyc.execute({
    remittanceId: id,
    address: conectado.address,
    serverVerdict: conectado.serverVerdict,
    kycProof: conectado.kycProof,
  });
  const alAgente = llamadas.find((l) => l.url.includes("/api/agents/"));
  return { conectado, res, alAgente };
}

describe("rechazar la firma al conectar NO impide iniciar el KYC (CD-15/AC-13, AR/BLQ-ALTO-2)", () => {
  beforeEach(() => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test"); // CON host: el camino real, no el demo
    vi.stubEnv("KYC_SESSION_SECRET", "kyc-session-secret");
    vi.stubEnv("PAYOUT_POP_SECRET", "test-pop-secret");
    rlMock.mockReset();
    rlMock.mockResolvedValue({ ok: true });
    installFetch();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ── T-CW-3 — el caso que el AR midió ───────────────────────────────────────────────────────────
  it("T-CW-3: la persona RECHAZA la firma ⇒ la sesión de Didit SE CREA igual, y la remesa queda con salida", async () => {
    const { conectado, res, alAgente } = await conectarYArrancarKyc(popQueRechaza);

    // 1. El desenlace del veredicto es el que corresponde, y no una excepción.
    expect(conectado.serverVerdict).toEqual({ outcome: "not_asked", reason: "pop_declined" });
    expect(conectado.kycProof).toBeUndefined();

    // 2. 🔴 EL ASERTO QUE FALTABA EN TODA LA SUITE: la verificación de identidad ARRANCA. Antes del
    //    arreglo, acá salía `throw kyc_session_failed` y este `await` rompía.
    expect(
      alAgente,
      "rechazar la firma de la billetera dejó a la persona sin poder INICIAR el KYC: no se creó " +
        "ninguna sesión de verificación, así que no puede verificarse y por lo tanto no puede pagar " +
        "(CD-15 lo prohíbe textualmente)",
    ).toBeDefined();
    expect(res.kind).toBe("redirect");
    if (res.kind !== "redirect") throw new Error("unreachable");
    expect(res.url).toBe(AGENT_OK.url);

    // 3. Y la sesión queda SIN ATAR: `identityRef` no viaja. Es la mitad que no se puede sacrificar
    //    para conseguir la de arriba — atarla a un valor del body es el ataque de R-1.
    const enviado = alAgente?.body as { identityRef?: string } | undefined;
    expect(
      enviado?.identityRef,
      "la sesión sin firma quedó atada a una dirección que nadie probó: eso es exactamente R-1, y " +
        "esa fila es la que autoriza el pago",
    ).toBeUndefined();
    expect(JSON.stringify(enviado)).not.toContain(FAKE_WALLET_ADDRESS);
  });

  // ── T-CW-4 — el mecanismo apagado, mismo desenlace ─────────────────────────────────────────────
  it("T-CW-4: con el emisor del PoP apagado (`prove` → null) la sesión también se crea", async () => {
    const { conectado, alAgente } = await conectarYArrancarKyc(popApagado);
    expect(conectado.serverVerdict).toEqual({ outcome: "not_asked", reason: "pop_disabled" });
    expect(
      alAgente,
      "apagar el emisor del challenge dejó a todo el mundo sin poder verificarse: un flag de " +
        "infraestructura nuestra no puede cerrar la puerta de entrada",
    ).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-359 · T-067-6 (AC-3) — CON LA PRUEBA CONSEGUIDA POR ENLACE, LA SESIÓN SE CREA **ATADA**
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 ES LA OTRA MITAD DE T-CW-3, Y NO EXISTÍA. Todo este archivo mide el caso SIN prueba (la sesión se
// crea sin atar, que es lo correcto), y **ningún test del repo afirmaba que el `identityRef` VIAJA
// cuando la prueba SÍ está** (verificado: el único `identityRef` asertado en la suite era el
// `toBeUndefined` de T-CW-3). O sea que el camino ATADO —el que produce la fila del veredicto y por lo
// tanto el que autoriza a pagar— no lo vigilaba nadie.
//
// ⛔ Y ES EL ESLABÓN DE §0.1: sin `payoutAllowed`, `../../../app/api/kyc/decision/route.ts` hace
// `if (!mapped.vendorData) return;` y NO ESCRIBE FILA; sin fila, `prepare` contesta 403
// `prepare_kyc_verdict_missing` **sin ningún respaldo**.
describe("T-067-6 (WKH-359/AC-3): con la prueba del enlace, la sesión de Didit se crea ATADA", () => {
  beforeEach(() => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    vi.stubEnv("KYC_SESSION_SECRET", "kyc-session-secret");
    vi.stubEnv("PAYOUT_POP_SECRET", "test-pop-secret");
    rlMock.mockReset();
    rlMock.mockResolvedValue({ ok: true });
    installFetch();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // 🔴 MUTANTE QUE MATA: no propagar `yaConseguida` al `ensure()` de `HttpKycVerdictGateway`, o no
  // devolver `proof` desde `ConnectWallet` ⇒ `kycProof` llega `undefined` a `StartKyc`, la route crea
  // la sesión SIN ATAR y `identityRef` desaparece del body. Es §0.1 entera.
  it("T-067-6: `identityRef` VIAJA, y es la dirección PROBADA (no la del body)", async () => {
    // La cuenta, con su privada: sin eso la firma no verificaría y la route contestaría 403. ⛔ No se
    // usa `FakeWallet`, cuya `signMessage` devuelve una firma de mentira: contra esta route eso no
    // pasaría P5, y un test que “pasa” con una firma inválida no estaría midiendo el binding.
    const cuenta = nacl.sign.keyPair();
    const direccion = bs58.encode(cuenta.publicKey);
    const walletDelEnlace: WalletPort = {
      async connect() {
        return direccion;
      },
      async getAddress() {
        return direccion;
      },
      async authorizePrincipal() {
        return { estado: "listo" as const, tx: "no-se-usa" };
      },
      async signMessage() {
        // ⛔ TIRA A PROPÓSITO: en el camino por enlace NO hay bridge, y si algo llamara acá el test
        // estaría midiendo el camino inyectado disfrazado. Es el `wallet_sign_not_available` real.
        throw new Error("wallet_sign_not_available");
      },
    };

    // El desafío SALE DEL EMISOR REAL y la firma es ed25519 de verdad: es lo que el salto por enlace
    // trae de vuelta, y lo que la route va a verificar en P2..P5.
    const exp = Math.floor(Date.now() / 1000) + 600;
    const datos = { address: direccion, networkId: resolveSolanaNetworkId(), nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90", exp };
    const proof = {
      challenge: issueSolanaPopChallenge(datos),
      signature: bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(buildSolanaPopMessage(datos)), cuenta.secretKey),
      ),
    };

    const kycStore = new FakeKycStore();
    const repo = new InMemoryRepo();
    const id = await seed(repo);
    const connect = new ConnectWallet(kycStore ? walletDelEnlace : walletDelEnlace, kycStore, new HttpKycVerdictGateway(popQueRechaza), {
      pedir: () => Promise.resolve({ estado: "listo" as const, proof }),
    });
    const conectado = esperarConectado(await connect.execute());

    // 1 · La prueba sobrevivió al gateway y sale del `connect`. ⛔ El `catch` de `:78-84` NO la tragó.
    expect(
      conectado.kycProof,
      "la prueba del enlace se perdió en el connect: la sesión se va a crear sin atar",
    ).toEqual(proof);

    const startKyc = new StartKyc(
      new AgentKycGateway(new FallbackKycGateway()),
      kycStore,
      new FakeKycPendingStore(),
      repo,
      new FixedClock(),
    );
    await startKyc.execute({
      remittanceId: id,
      address: conectado.address,
      serverVerdict: conectado.serverVerdict,
      kycProof: conectado.kycProof,
    });

    // 2 · 🔴 LA AFIRMACIÓN QUE NO EXISTÍA EN LA SUITE: el `identityRef` VIAJA.
    const alAgente = llamadas.find((l) => l.url.includes("/api/agents/"));
    expect(alAgente, "no se creó ninguna sesión de verificación").toBeDefined();
    const enviado = alAgente?.body as { identityRef?: string } | undefined;
    expect(
      enviado?.identityRef,
      "la sesión se creó SIN ATAR teniendo la prueba en la mano: `decision/route.ts:100` no va a " +
        "escribir fila y `prepare` va a contestar 403 a esta persona, para siempre",
    ).toBe(direccion);

    // 3 · Y es la dirección PROBADA, no una que el caller escribió: la route saca `ch.address` del
    // token verificado por HMAC y NUNCA la compara contra `body.vendorData` (es el guard-que-se-mira-
    // al-espejo que su CD-18 prohíbe). Sin esta mitad, atar sería el ataque de R-1.
    expect(enviado?.identityRef).not.toBe(FAKE_WALLET_ADDRESS);
  });
});
