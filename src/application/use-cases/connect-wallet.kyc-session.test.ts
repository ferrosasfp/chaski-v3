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
// `DiditKycGateway.start`, que lo convierte en `throw didit_session_failed`.
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

import { POST as KYC_SESSION_POST } from "../../../app/api/kyc/session/route";
import { Money } from "../../domain/money";
import { type Quote, Remittance } from "../../domain/remittance";
import { FallbackKycGateway } from "../../infrastructure/fallback/gateways";
import { DiditKycGateway } from "../../infrastructure/didit/kyc-gateway";
import { HttpKycVerdictGateway } from "../../infrastructure/kyc/http-kyc-verdict-gateway";
import type { PopSigner } from "../ports";
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

const DIDIT_OK = {
  session_id: "s1",
  url: "https://verify.didit.me/session/s1",
  session_token: "didit-tok",
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
 *  el `POST /api/kyc/session` del adapter, y el `POST …/v3/session/` que la route le hace a Didit. */
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
      if (u.includes("/v3/session/")) {
        return new Response(JSON.stringify(DIDIT_OK), {
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
  const conectado = await connect.execute();

  const startKyc = new StartKyc(
    new DiditKycGateway(new FallbackKycGateway()),
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
  const aDidit = llamadas.find((l) => l.url.includes("/v3/session/"));
  return { conectado, res, aDidit };
}

describe("rechazar la firma al conectar NO impide iniciar el KYC (CD-15/AC-13, AR/BLQ-ALTO-2)", () => {
  beforeEach(() => {
    vi.stubEnv("DIDIT_API_KEY", "didit-key"); // CON key: el camino real, no el demo
    vi.stubEnv("DIDIT_WORKFLOW_ID", "wf-1");
    vi.stubEnv("KYC_SESSION_SECRET", "kyc-session-secret");
    vi.stubEnv("PAYOUT_POP_SECRET", "test-pop-secret");
    vi.stubEnv("DIDIT_ENV", "mock");
    vi.stubEnv("DIDIT_BASE_URL", "http://localhost:9999/didit-mock");
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
    const { conectado, res, aDidit } = await conectarYArrancarKyc(popQueRechaza);

    // 1. El desenlace del veredicto es el que corresponde, y no una excepción.
    expect(conectado.serverVerdict).toEqual({ outcome: "not_asked", reason: "pop_declined" });
    expect(conectado.kycProof).toBeUndefined();

    // 2. 🔴 EL ASERTO QUE FALTABA EN TODA LA SUITE: la verificación de identidad ARRANCA. Antes del
    //    arreglo, acá salía `throw didit_session_failed` y este `await` rompía.
    expect(
      aDidit,
      "rechazar la firma de la billetera dejó a la persona sin poder INICIAR el KYC: no se creó " +
        "ninguna sesión de verificación, así que no puede verificarse y por lo tanto no puede pagar " +
        "(CD-15 lo prohíbe textualmente)",
    ).toBeDefined();
    expect(res.kind).toBe("redirect");
    if (res.kind !== "redirect") throw new Error("unreachable");
    expect(res.url).toBe(DIDIT_OK.url);

    // 3. Y la sesión queda SIN ATAR: `vendor_data` no viaja. Es la mitad que no se puede sacrificar
    //    para conseguir la de arriba — atarla a un valor del body es el ataque de R-1.
    const enviado = aDidit?.body as { vendor_data?: string } | undefined;
    expect(
      enviado?.vendor_data,
      "la sesión sin firma quedó atada a una dirección que nadie probó: eso es exactamente R-1, y " +
        "esa fila es la que autoriza el pago",
    ).toBeUndefined();
    expect(JSON.stringify(enviado)).not.toContain(FAKE_WALLET_ADDRESS);
  });

  // ── T-CW-4 — el mecanismo apagado, mismo desenlace ─────────────────────────────────────────────
  it("T-CW-4: con el emisor del PoP apagado (`prove` → null) la sesión también se crea", async () => {
    const { conectado, aDidit } = await conectarYArrancarKyc(popApagado);
    expect(conectado.serverVerdict).toEqual({ outcome: "not_asked", reason: "pop_disabled" });
    expect(
      aDidit,
      "apagar el emisor del challenge dejó a todo el mundo sin poder verificarse: un flag de " +
        "infraestructura nuestra no puede cerrar la puerta de entrada",
    ).toBeDefined();
  });
});
