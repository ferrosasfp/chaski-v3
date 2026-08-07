// Tests — ConnectWallet + el veredicto de KYC server-side (WKH-333/AC-20, CD-15).
//
// 🔴 LO QUE ESTE ARCHIVO CUSTODIA, Y POR QUÉ ES EL RIESGO MÁS CARO DE LA HU. El relleno de la fila
// del veredicto tiene que correr AL CONECTAR, no al iniciar el KYC. Está medido en `start-kyc.ts`:
// cuando el store local tiene un veredicto aprobado, ese use-case SALE ANTES sin consultar nada. Esa
// es exactamente la población que HOY ya está verificada en su navegador. Con el relleno allá, esa
// gente nunca lo ejecutaría, llegaría a `prepare` sin fila, y con el corte sin respaldo de AC-17 la
// app se rompe para los usuarios actuales. Además `flow.tsx` los manda de `connect` directo a
// `confirm`: la pantalla de verificación ni se muestra.
import { describe, expect, it, vi } from "vitest";
import type { KycVerdictEnsureResult, KycVerdictGateway } from "../ports";
import { FAKE_WALLET_ADDRESS, FakeKycStore, FakeWallet } from "../../test-support/fakes";
import { toPersistedIdentity } from "../../domain/remittance";
import { ConnectWallet } from "./connect-wallet";

// La MISMA constante que devuelve el doble de billetera: escribirla a mano acá haría que
// `peek(ADDR)` mirara una llave distinta de la que `save()` escribió, y el test pasaría a
// medir el andamiaje en vez del use-case.
const ADDR = FAKE_WALLET_ADDRESS;

function kyc(verificationId: string | null = "did-del-navegador") {
  return {
    verificationId,
    approved: true,
    payoutAllowed: true,
    riskLevel: "low" as const,
    provenance: "didit",
    identity: toPersistedIdentity({
      firstName: "Test",
      lastNamePaternal: "Quispe",
      lastNameMaternal: "Mamani",
      documentType: "DNI",
      documentNumber: "12345678",
      dateOfBirth: "1990-01-01",
      nationality: "PE",
    }),
  };
}

/** Gateway espía: registra CADA llamada con sus argumentos, para poder afirmar el VALOR de la pista
 *  y no sólo que se llamó. */
function spyGateway(result: KycVerdictEnsureResult, opts: { throws?: boolean } = {}) {
  const calls: Array<{ address: string; candidate?: string }> = [];
  const gw: KycVerdictGateway = {
    async ensure(address, candidate) {
      calls.push({ address, candidate });
      if (opts.throws) throw new Error("kyc_verdict_unavailable");
      return result;
    },
  };
  return { gw, calls };
}

const USABLE: KycVerdictEnsureResult = {
  lookup: {
    outcome: "usable",
    verdict: { riskLevel: "low", provenance: "didit", verifiedAt: "2026-08-01T00:00:00.000Z" },
  },
  proof: { challenge: "ch-1", signature: "sig-1" },
};

describe("ConnectWallet — el veredicto se asegura AL CONECTAR (WKH-333/AC-20)", () => {
  // ── T-CW-1 — M-34 ──────────────────────────────────────────────────────────────────────────────
  it("T-CW-1: al conectar se llama `ensure` EXACTAMENTE una vez, con la pista de `peek` (M-34)", async () => {
    const wallet = new FakeWallet();
    const store = new FakeKycStore();
    await store.save(ADDR, kyc("did-viejo-de-este-navegador"));
    const { gw, calls } = spyGateway(USABLE);

    const out = await new ConnectWallet(wallet, store, gw).execute();

    expect(
      calls.length,
      "el relleno del veredicto NO corrió al conectar: si vive en StartKyc, toda persona ya " +
        "verificada en este navegador lo saltea (StartKyc sale antes) y llega a pagar sin fila — o " +
        "sea que la app se rompe justo para los usuarios actuales",
    ).toBe(1);
    expect(calls[0]?.address).toBe(ADDR);
    expect(
      calls[0]?.candidate,
      "la pista salió de `get()` en vez de `peek()`: `get()` devuelve null a los 181 días, así que " +
        "el relleno nunca alcanzaría a quien se verificó hace más de 180 días — que es justamente " +
        "la población que existe para salvar",
    ).toBe("did-viejo-de-este-navegador");
    expect(out.serverVerdict?.outcome).toBe("usable");
    // La prueba de posesión viaja para que la sesión de Didit no pida una SEGUNDA firma (R-1).
    expect(out.kycProof).toEqual({ challenge: "ch-1", signature: "sig-1" });
  });

  it("T-CW-1b: sin entry local, `ensure` se llama igual y sin pista", async () => {
    const { gw, calls } = spyGateway({ lookup: { outcome: "absent", reason: "absent" } });
    const out = await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw).execute();
    expect(calls).toEqual([{ address: ADDR, candidate: undefined }]);
    expect(out.serverVerdict).toEqual({ outcome: "absent", reason: "absent" });
  });

  // ── T-CW-2 — M-20 ──────────────────────────────────────────────────────────────────────────────
  it("T-CW-2: si `ensure` TIRA, conectar devuelve igual y el flujo sigue (M-20)", async () => {
    const { gw } = spyGateway({ lookup: { outcome: "absent", reason: "absent" } }, { throws: true });
    const out = await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw).execute();
    expect(
      out.address,
      "una caída de NUESTRA API de veredictos rompió el connect: conectar la billetera es la puerta " +
        "de entrada a todo, así que la persona no podría ni empezar un envío",
    ).toBe(ADDR);
    expect(out.serverVerdict).toBeUndefined(); // ⇒ camino de hoy (se crea la sesión de Didit)
    expect(out.kycProof).toBeUndefined();
  });

  it("T-CW-2b: si `peek` TIRA (localStorage roto), conectar sigue y `ensure` corre sin pista", async () => {
    const store = new FakeKycStore();
    vi.spyOn(store, "peek").mockRejectedValue(new Error("storage_broken"));
    const { gw, calls } = spyGateway({ lookup: { outcome: "absent", reason: "absent" } });
    const out = await new ConnectWallet(new FakeWallet(), store, gw).execute();
    expect(out.address).toBe(ADDR);
    expect(calls).toEqual([{ address: ADDR, candidate: undefined }]);
  });

  // ── Sin gateway: byte-idéntico a antes de la HU ────────────────────────────────────────────────
  it("sin gateway cableado, `execute` se comporta EXACTAMENTE como antes (AC-12)", async () => {
    const store = new FakeKycStore();
    await store.save(ADDR, kyc());
    const out = await new ConnectWallet(new FakeWallet(), store).execute();
    expect(out.address).toBe(ADDR);
    expect(out.rememberedKyc?.approved).toBe(true);
    expect(out.serverVerdict).toBeUndefined();
  });
});
