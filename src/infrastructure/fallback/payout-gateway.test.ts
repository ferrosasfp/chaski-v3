// Tests — FallbackPayoutGateway (WKH-320 fix-pack). Este archivo existe porque el adapter no tenía
// NINGUNO: su `status()` devolvía "settled" sin consultar nada y ningún test lo notaba.
//
// Lo que se clava acá: que el adapter que corre cuando NO hay backend de value-delivery no puede
// producir un "entregado". No es prolijidad — con el flag de settlement Solana encendido y este
// adapter cableado (`NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`, `container.ts:108`, la configuración de devnet de hoy), ese "settled" fabricado
// llegaba a una remesa con los USDC dentro del vault del escrow.
import { describe, expect, it } from "vitest";
import { Money } from "../../domain/money";
import { Remittance } from "../../domain/remittance";
import { TrackRemittance } from "../../application/use-cases/track-remittance";
import {
  FakeRefundGateway,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../../test-support/fakes";
import { FallbackPayoutGateway } from "./gateways";

const gw = new FallbackPayoutGateway();

// Remesa en payout_submitted: el estado desde el que el poll consulta status(). Es EXACTAMENTE
// donde queda una remesa Solana con el depósito confirmado on-chain y el release todavía sin hacer.
async function submittedRemittance() {
  const repo = new InMemoryRepo();
  const r = Remittance.create("rem-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(
    {
      quoteId: "q",
      send: Money.of(400, "USDC"),
      receive: Money.of(1478.15, "PEN"),
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.7,
      etaMinutes: 30,
      expiresAt: QUOTE_EXPIRES,
      provenance: "local-fallback",
    },
    T0,
  );
  r.startKyc(T0, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  r.applyKyc(
    {
      verificationId: "v-1",
      approved: true,
      payoutAllowed: true,
      riskLevel: "low",
      provenance: "local-fallback",
      identity: null,
    },
    T0,
  );
  r.confirm(T0);
  r.markPrincipalIn("solana-sig", T0);
  r.markPayoutSubmitted("fb-rem-1:q", T0, "local-fallback");
  await repo.save(r);
  return { repo, id: "rem-1" };
}

describe("FallbackPayoutGateway — no fabrica hechos sobre plata ajena", () => {
  it("status() NO devuelve un estado terminal: este adapter no tiene a quién preguntarle", async () => {
    const rec = await gw.status("fb-1");
    expect(rec.status).toBe("submitted");
    expect(rec.status).not.toBe("settled");
  });

  // "No sé" tiene que estar DICHO. Un failureReason null se lee igual que "todo en orden".
  it("status() marca explícitamente que no sabe (payout_status_unknown)", async () => {
    expect((await gw.status("fb-1")).failureReason).toBe("payout_status_unknown");
  });

  // Simétrico y igual de importante: tampoco puede inventar un fallo. No saber NO es evidencia de
  // que falló; fabricar "failed" acá refundearía sobre incertidumbre.
  it("status() tampoco fabrica un fallo", async () => {
    expect((await gw.status("fb-1")).status).not.toBe("failed");
  });

  it("submit() sigue dejando el payout en camino (sin cambios)", async () => {
    const rec = await gw.submit({
      quoteId: "q",
      amountUsd: 400,
      expectedReceivePen: Money.of(1478.15, "PEN"),
      beneficiary: beneficiary(),
      kycVerificationId: "v-1",
      address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      idempotencyKey: "rem-1:q",
    });
    expect(rec.status).toBe("submitted");
    expect(rec.provenance).toBe("local-fallback");
  });

  // El test de significado: el poll consulta y la remesa NO avanza a "Entregado". Antes de este fix
  // el primer tick la settleaba y la UI saltaba al recibo verde con la plata en el vault.
  it("el poll sobre este adapter NO settlea la remesa: se queda en payout_submitted", async () => {
    const { repo, id } = await submittedRemittance();
    const track = new TrackRemittance(gw, repo, new FixedClock(), new FakeRefundGateway());

    for (let i = 0; i < 5; i++) await track.execute({ remittanceId: id });

    const after = await repo.get(id);
    expect(after?.status).toBe("payout_submitted");
    expect(after?.isTerminal).toBe(false);
    expect(after?.snapshot.payoutTx).toBeNull();
    expect(after?.snapshot.deliveredPen).toBeNull();
  });

  // Y tampoco lo manda a payout_failed/refunded: la remesa queda EXACTAMENTE donde estaba.
  it("el poll tampoco falla ni refundea la remesa sobre la incertidumbre", async () => {
    const { repo, id } = await submittedRemittance();
    const track = new TrackRemittance(gw, repo, new FixedClock(), new FakeRefundGateway());

    await track.execute({ remittanceId: id });

    const after = await repo.get(id);
    expect(after?.status).not.toBe("payout_failed");
    expect(after?.status).not.toBe("refunded");
    expect(after?.snapshot.refundTx).toBeNull();
  });
});
