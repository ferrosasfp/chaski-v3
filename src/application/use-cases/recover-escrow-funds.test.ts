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

function snapshotAt(
  stage: "confirmed" | "principal_in" | "payout_submitted" | "payout_failed" | "settled",
): RemittanceState {
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
      payoutAllowed: true, realVerified: true, verifiedAt: null,
      riskLevel: "low",
      provenance: "didit",
      identity: null,
    },
    T0,
  );
  r.confirm(T0);
  // La ventana que este use-case no cubría: firmamos la autorización del depósito y nadie registró el
  // desenlace. Sin `markPrincipalIn` no hay `principalTx`, que es justo por lo que no sabemos nada.
  if (stage === "confirmed") return r.snapshot;
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

    const res = await uc.execute(input);
    const r = res.remittance;

    expect(res.confirmation).toBe("confirmed");
    expect(res.refundTx).toBe(FAKE_SOLANA_SIGNATURE);
    expect(r.status).toBe("refunded");
    expect(r.snapshot.refundTx).toBe(FAKE_SOLANA_SIGNATURE);
    const saved = await repo.get("rem-1");
    expect(saved?.status).toBe("refunded"); // lo que sobrevive a la recarga
    expect(saved?.snapshot.refundTx).toBe(FAKE_SOLANA_SIGNATURE);
    expect(saved?.snapshot.failureReason).toBe(ESCROW_REFUNDED_BY_SENDER);
  });

  // El estado que quedaba afuera de RECOVERABLE, y el que deja a alguien sin salida: cerró el
  // navegador entre la firma y el registro del desenlace. Sus USDC pueden estar en el vault y el
  // use-case cortaba antes de preguntarle a la cadena.
  it("desde confirmed: llega a la cadena y persiste refunded (la ventana del navegador cerrado)", async () => {
    const { repo, gateway, uc } = await setup("confirmed");

    const res = await uc.execute(input);

    expect(gateway.calls).toHaveLength(1); // preguntó: ANTES cortaba con refund_not_available
    expect(res.confirmation).toBe("confirmed");
    const saved = await repo.get("rem-1");
    expect(saved?.status).toBe("refunded"); // confirmed → payout_failed → refunded, las dos en la FSM
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

    const { remittance } = await uc.execute(input);

    expect(remittance.status).toBe("refunded");
    expect(remittance.snapshot.refundTx).toBe(FAKE_SOLANA_SIGNATURE);
  });
});

// ── El estado terminal EXIGE confirmación de la cadena ───────────────────────────────────────────
// El daño: la persona aprieta recuperar, firma en Phantom, tarda 40 s. El RPC acepta y devuelve la
// signature; el blockhash vence antes de que la tx entre en un bloque y la tx se cae. Con el terminal
// escrito sobre esa signature, la persona leía "Recuperaste tus fondos", los USDC seguían en el vault
// y el botón NO volvía nunca (refunded es terminal, sin transición de salida: el segundo intento corta
// con refund_not_available). "El RPC la aceptó" es un tercer valor, ni confirmado ni fallado.
describe("RecoverEscrowFunds — sin confirmación no hay terminal", () => {
  for (const confirmation of ["pending", "unknown"] as const) {
    it(`confirmation="${confirmation}" ⇒ NO escribe refunded y la remesa sigue recuperable`, async () => {
      const gateway = new FakeSolanaEscrowRefundGateway(FAKE_SOLANA_SIGNATURE, "resolve", confirmation);
      const { repo, uc } = await setup("payout_submitted", gateway);

      const res = await uc.execute(input);

      // (1) lo que se devuelve dice exactamente lo que se sabe: se envió, no se confirmó.
      expect(res.confirmation).toBe(confirmation);
      expect(res.refundTx).toBe(FAKE_SOLANA_SIGNATURE);
      // (2) el agregado NO quedó terminal, ni en memoria ni en disco.
      expect(res.remittance.status).toBe("payout_submitted");
      expect(res.remittance.snapshot.refundTx).toBeNull();
      const saved = await repo.get("rem-1");
      expect(saved?.status).toBe("payout_submitted");
      expect(saved?.snapshot.refundTx).toBeNull();
      expect(saved?.snapshot.failureReason).toBeNull(); // tampoco se marcó un fallo que no ocurrió
    });

    it(`confirmation="${confirmation}" ⇒ el SEGUNDO intento todavía es posible (el camino no se cierra)`, async () => {
      const gateway = new FakeSolanaEscrowRefundGateway(FAKE_SOLANA_SIGNATURE, "resolve", confirmation);
      const { uc } = await setup("payout_submitted", gateway);

      await uc.execute(input);
      // Sin esto la 2ª llamada moriría en el guard RECOVERABLE con refund_not_available: la persona
      // quedaba sin reintento sobre una tx que pudo no haber entrado nunca.
      await expect(uc.execute(input)).resolves.toMatchObject({ confirmation });
      expect(gateway.calls).toHaveLength(2); // llegó a la cadena las dos veces
    });
  }

  it("desde payout_failed sin confirmar: conserva su razón original y NO la pisa con la del refund", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway(FAKE_SOLANA_SIGNATURE, "resolve", "pending");
    const { repo, uc } = await setup("payout_failed", gateway);

    await uc.execute(input);

    const saved = await repo.get("rem-1");
    expect(saved?.status).toBe("payout_failed");
    expect(saved?.snapshot.failureReason).toBe("partner_down");
    expect(saved?.snapshot.refundTx).toBeNull();
  });
});
