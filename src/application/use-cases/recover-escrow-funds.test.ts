// Tests — RecoverEscrowFunds. Lo que se clava: que el resultado de un refund on-chain exitoso queda
// ESCRITO, y que uno fallido no escribe nada. El bug que motivó el use-case reportaba como fallada
// una recuperación que había funcionado, porque la signature moría en un useState de la UI.
import { describe, expect, it } from "vitest";
import { Money } from "../../domain/money";
import { Remittance, type RemittanceState } from "../../domain/remittance";
import {
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_SIGNATURE,
  FakeSolanaEscrowRefundGateway,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../../test-support/fakes";
import { ESCROW_REFUNDED_BY_SENDER, RecoverEscrowFunds } from "./recover-escrow-funds";

function snapshotAt(stage: "principal_in" | "payout_submitted" | "payout_failed" | "settled"): RemittanceState {
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
      provenance: "didit",
    },
    T0,
  );
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(
    {
      verificationId: "v-1",
      approved: true,
      payoutAllowed: true,
      riskLevel: "low",
      provenance: "didit",
      identity: null,
    },
    T0,
  );
  r.confirm(T0);
  r.markPrincipalIn("solana-sig", T0);
  if (stage === "principal_in") return r.snapshot;
  if (stage === "payout_failed") {
    r.markPayoutFailed("partner_down", T0);
    return r.snapshot;
  }
  r.markPayoutSubmitted("transfi-po-1", T0, "transfi");
  if (stage === "settled") r.markSettled("tx", Money.of(1478.15, "PEN"), T0);
  return r.snapshot;
}

async function setup(
  stage: Parameters<typeof snapshotAt>[0],
  gateway = new FakeSolanaEscrowRefundGateway(),
) {
  const repo = new InMemoryRepo();
  await repo.save(Remittance.rehydrate(snapshotAt(stage)));
  return {
    repo,
    gateway,
    uc: new RecoverEscrowFunds(repo, new FixedClock(), gateway),
  };
}

const input = { remittanceId: "rem-1", sender: FAKE_SOLANA_BENEFICIARY };

describe("RecoverEscrowFunds — el refund exitoso deja rastro", () => {
  it("desde payout_submitted: persiste refunded + la signature del refund", async () => {
    const { repo, uc } = await setup("payout_submitted");

    const r = await uc.execute(input);

    expect(r.status).toBe("refunded");
    expect(r.snapshot.refundTx).toBe(FAKE_SOLANA_SIGNATURE);
    const saved = await repo.get("rem-1");
    expect(saved?.status).toBe("refunded"); // lo que sobrevive a la recarga
    expect(saved?.snapshot.refundTx).toBe(FAKE_SOLANA_SIGNATURE);
    expect(saved?.snapshot.failureReason).toBe(ESCROW_REFUNDED_BY_SENDER);
  });

  it("desde principal_in: mismo resultado (el depósito entró y el payout ni se creó)", async () => {
    const { repo, uc } = await setup("principal_in");
    await uc.execute(input);
    expect((await repo.get("rem-1"))?.status).toBe("refunded");
  });

  it("desde payout_failed: NO re-marca el fallo y conserva su razón original", async () => {
    const { repo, uc } = await setup("payout_failed");

    await uc.execute(input);

    const saved = await repo.get("rem-1");
    expect(saved?.status).toBe("refunded");
    expect(saved?.snapshot.failureReason).toBe("partner_down"); // el motivo real no se pisa
    expect(saved?.snapshot.refundTx).toBe(FAKE_SOLANA_SIGNATURE);
  });

  it("el refund on-chain corre ANTES de escribir: si lanza, el estado queda intacto", async () => {
    const { repo, uc } = await setup(
      "payout_submitted",
      new FakeSolanaEscrowRefundGateway(FAKE_SOLANA_SIGNATURE, "reject"),
    );

    await expect(uc.execute(input)).rejects.toThrow("solana_refund_boom");

    const saved = await repo.get("rem-1");
    expect(saved?.status).toBe("payout_submitted"); // sigue recuperable: se puede reintentar
    expect(saved?.snapshot.refundTx).toBeNull();
  });

  // Un estado sin salida en la FSM no puede registrar el resultado ⇒ no se dispara la operación.
  // Disparar sin poder escribir es exactamente el bug original.
  it("desde un estado terminal NO toca la cadena: corta antes con refund_not_available", async () => {
    const { uc, gateway } = await setup("settled");

    await expect(uc.execute(input)).rejects.toThrow("refund_not_available");
    expect(gateway.calls).toHaveLength(0);
  });

  it("remesa inexistente ⇒ remittance_not_found, sin tocar la cadena", async () => {
    const { uc, gateway } = await setup("payout_submitted");
    await expect(uc.execute({ ...input, remittanceId: "nope" })).rejects.toThrow(
      "remittance_not_found",
    );
    expect(gateway.calls).toHaveLength(0);
  });

  // Si el refund YA ocurrió on-chain, un fallo de persistencia no puede volverse un "falló".
  it("si el repo no puede guardar, igual devuelve la verdad de esta sesión (refunded)", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    const repo = new InMemoryRepo();
    await repo.save(Remittance.rehydrate(snapshotAt("payout_submitted")));
    const brokenSave = {
      get: repo.get.bind(repo),
      list: repo.list.bind(repo),
      clearByOwner: repo.clearByOwner.bind(repo),
      save: async () => {
        throw new Error("quota_exceeded");
      },
    };
    const uc = new RecoverEscrowFunds(brokenSave, new FixedClock(), gateway);

    const r = await uc.execute(input);

    expect(r.status).toBe("refunded");
    expect(r.snapshot.refundTx).toBe(FAKE_SOLANA_SIGNATURE);
  });
});
