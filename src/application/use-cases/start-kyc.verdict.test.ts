// Tests — StartKyc y el veredicto server-side (WKH-333/AC-7', AC-13; CD-15, CD-16).
//
// La regla que custodian: SÓLO `usable` saltea la creación de la sesión de Didit. Los otros ocho
// desenlaces (cuatro `absent`, cuatro `not_asked`) caen al camino de hoy.
//
// 🔴 POR QUÉ EL COLAPSO ES CARO EN LA DIRECCIÓN CONTRARIA (M-19). Tratar `not_asked` como `usable`
// no rompe nada visible en el camino feliz: la persona sigue, la pantalla dice "verificado". Lo que
// pasa es que NUNCA obtiene sesión de KYC, así que el servidor nunca escribe su fila, y cuando llega
// a pagar `prepare` la corta por falta de fila. Queda sin verificación y sin poder enviar, y el
// desenlace que lo dispara —`not_asked`— es el MÁS probable de los tres: lo produce una bandera
// apagada o un rechazo de firma, no una caída.
import { describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { type Quote, Remittance } from "../../domain/remittance";
import type { KycVerdictLookup } from "../ports";
import {
  FakeKycGateway,
  FakeKycPendingStore,
  FakeKycStore,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../../test-support/fakes";
import { StartKyc } from "./start-kyc";

const ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

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

// WKH-187: se cotiza ANTES del KYC (created→quoted). Sin el quote, `startKyc` tira
// `invalid_transition:created->kyc_pending` y estos tests medirían el andamiaje, no el use-case.
async function seed(repo: InMemoryRepo): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  await repo.save(r);
  return "r-1";
}

function build(store = new FakeKycStore()) {
  const repo = new InMemoryRepo();
  const kyc = new FakeKycGateway({}, true); // redirect=true ⇒ crear sesión es observable
  const startSpy = vi.spyOn(kyc, "start");
  const uc = new StartKyc(kyc, store, new FakeKycPendingStore(), repo, new FixedClock());
  return { repo, kyc, startSpy, uc, store };
}

const USABLE: KycVerdictLookup = {
  outcome: "usable",
  verdict: { riskLevel: "medium", provenance: "didit", verifiedAt: "2026-08-01T00:00:00.000Z" },
};

describe("StartKyc — sólo un veredicto USABLE saltea la sesión de Didit (WKH-333/AC-7')", () => {
  // ── T-SK-1 ─────────────────────────────────────────────────────────────────────────────────────
  it("T-SK-1: con veredicto local aprobado ⇒ camino de hoy, SIN red y sin mirar el server", async () => {
    const store = new FakeKycStore();
    await store.save(ADDR, {
      verificationId: "did-local",
      approved: true,
      payoutAllowed: true,
      riskLevel: "low",
      provenance: "didit",
      identity: null,
    });
    const { repo, uc, startSpy } = build(store);
    const id = await seed(repo);
    const res = await uc.execute({ remittanceId: id, address: ADDR });
    expect(res.kind).toBe("done");
    expect(
      startSpy,
      "el camino KYC-once local dejó de cortar antes: se gastaría un cupo del proveedor para alguien " +
        "que este navegador ya sabe verificado",
    ).not.toHaveBeenCalled();
  });

  // ── T-SK-2 — AC-7' ─────────────────────────────────────────────────────────────────────────────
  it("T-SK-2: `serverVerdict.usable` ⇒ NO se crea sesión de Didit, y la remesa queda kyc_passed", async () => {
    const { repo, uc, startSpy } = build();
    const id = await seed(repo);
    const res = await uc.execute({ remittanceId: id, address: ADDR, serverVerdict: USABLE });
    expect(
      startSpy,
      "se creó una sesión nueva de verificación para alguien que el servidor ya tiene verificado: " +
        "es el cupo que la misma persona gasta dos veces por entrar desde el teléfono y desde la " +
        "computadora, que es el problema que esta HU vino a resolver",
    ).not.toHaveBeenCalled();
    expect(res.kind).toBe("done");
    if (res.kind !== "done") throw new Error("unreachable");
    expect(res.snapshot.status).toBe("kyc_passed");
    // El navegador NO tiene el identificador, y eso es literal (AC-6): no se fabrica ninguno.
    expect(res.snapshot.kyc?.verificationId).toBeNull();
    expect(res.snapshot.kyc?.riskLevel).toBe("medium");
    expect(res.snapshot.kyc?.provenance).toBe("didit");
    // Tampoco se escribe el caché de dispositivo: una segunda verdad que envejece sola.
    expect(await new FakeKycStore().get(ADDR)).toBeNull();
  });

  // ── T-SK-3..5 — M-19 ───────────────────────────────────────────────────────────────────────────
  const noSaltean: Array<[string, KycVerdictLookup | undefined]> = [
    ["absent/absent", { outcome: "absent", reason: "absent" }],
    ["absent/expired", { outcome: "absent", reason: "expired" }],
    ["absent/simulated", { outcome: "absent", reason: "simulated" }],
    ["absent/not_approved", { outcome: "absent", reason: "not_approved" }],
    ["not_asked/pop_disabled", { outcome: "not_asked", reason: "pop_disabled" }],
    ["not_asked/pop_rejected", { outcome: "not_asked", reason: "pop_rejected" }],
    ["not_asked/pop_declined", { outcome: "not_asked", reason: "pop_declined" }],
    ["not_asked/store_disabled", { outcome: "not_asked", reason: "store_disabled" }],
    ["ausente (undefined)", undefined],
  ];
  for (const [label, sv] of noSaltean) {
    it(`T-SK-3..5: \`${label}\` ⇒ SÍ se crea la sesión de Didit (camino de hoy) (M-19)`, async () => {
      const { repo, uc, startSpy } = build();
      const id = await seed(repo);
      const res = await uc.execute({ remittanceId: id, address: ADDR, serverVerdict: sv });
      expect(
        startSpy,
        `\`${label}\` se trató como "ya está verificada": la persona nunca obtiene sesión de KYC, el ` +
          "servidor nunca escribe su fila, y al pagar se corta por falta de fila — queda sin " +
          "verificación y sin poder enviar",
      ).toHaveBeenCalledTimes(1);
      expect(res.kind).toBe("redirect");
    });
  }

  // ── R-1: la prueba de posesión viaja hasta la creación de la sesión ────────────────────────────
  it("la prueba de posesión obtenida al conectar viaja a `kyc.start` (R-1, cero prompts nuevos)", async () => {
    const { repo, uc, startSpy } = build();
    const id = await seed(repo);
    await uc.execute({
      remittanceId: id,
      address: ADDR,
      kycProof: { challenge: "ch-1", signature: "sig-1" },
    });
    const sent = startSpy.mock.calls[0]?.[0] as { popChallenge?: string; popSignature?: string };
    expect(
      sent.popChallenge,
      "la prueba no viajó: `/api/kyc/session` la exige, así que o la persona ve un SEGUNDO prompt de " +
        "billetera, o directamente no puede verificarse",
    ).toBe("ch-1");
    expect(sent.popSignature).toBe("sig-1");
  });

  it("sin prueba, `kyc.start` la recibe como undefined (el demo sin key sigue igual)", async () => {
    const { repo, uc, startSpy } = build();
    const id = await seed(repo);
    await uc.execute({ remittanceId: id, address: ADDR });
    const sent = startSpy.mock.calls[0]?.[0] as { popChallenge?: string };
    expect(sent.popChallenge).toBeUndefined();
  });
});
