// Tests — ConfirmAndSend, el money-path completo (HU-SOL-13/WKH-216): prepare → firma → settle →
// markPrincipalIn. AC-1: el deposit se cablea con beneficiary/authority resueltos SERVER-SIDE (del
// prepare, NUNCA del body). AC-4/CD-7: prepare !ok / gateway !ok / gateway throw ⇒ failAndRefund,
// NUNCA markPrincipalIn. Cero @solana/web3.js (fakes puros).
import { describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FAKE_SOLANA_AUTHORITY,
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_SIGNATURE,
  FakePayoutAuthorityGateway,
  FakePayoutGateway,
  FakeRefundGateway,
  FakeSolanaEscrowDepositProbe,
  FakeSolanaEscrowRefundGateway,
  FakeSolanaPayoutPrepareGateway,
  FakeSolanaSettlementGateway,
  FakeSolanaWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../../test-support/fakes";
import type { RefundGateway } from "../ports";
import { LedgerRefundGateway } from "../../infrastructure/refund/ledger-refund-gateway";
import {
  ConfirmAndSend,
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
} from "./confirm-and-send";
import { RecoverEscrowFunds } from "./recover-escrow-funds";

const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  riskLevel: "low",
  provenance: "didit",
  identity: null,
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
async function seedQuoted(repo: InMemoryRepo): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  await repo.save(r);
  return "r-1";
}

// Construye el camino real: el 6º arg `solana` (prepare+gateway acoplados). WKH-320: ya no hay 7º/8º
// args (`settlement` EVM y `pop`) porque no hay una segunda VM con la que ser mutuamente excluyente.
function build(
  repo: InMemoryRepo,
  wallet: FakeSolanaWallet,
  prepare: FakeSolanaPayoutPrepareGateway,
  gateway: FakeSolanaSettlementGateway,
  _payouts?: FakePayoutGateway,
  // RefundGateway (la interfaz), NO el fake: los tests tienen que poder cablear el adapter REAL de
  // producción, que es el único que dice la verdad sobre si hubo reembolso.
  refund: RefundGateway = new FakeRefundGateway(),
  // La respuesta de la cadena a "¿entró el principal?". Default "not_deposited" = lo que pasa en los
  // casos que cortan antes del broadcast; los casos donde la tx YA salió pasan el suyo explícito.
  probe: FakeSolanaEscrowDepositProbe = new FakeSolanaEscrowDepositProbe("not_deposited"),
): ConfirmAndSend {
  return new ConfirmAndSend(
    wallet,
    repo,
    new FixedClock(),
    new FakePayoutAuthorityGateway({ authorized: true }),
    refund,
    { prepare, gateway, probe },
  );
}

describe("ConfirmAndSend — el money-path completo (HU-SOL-13)", () => {
  it("T1/AC-1: happy — beneficiary/authority server-side → authorizePrincipal(escrow) → settle → markPrincipalIn + payout_submitted", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);

    const out = await build(repo, wallet, prepare, gateway, payouts).execute({ remittanceId: id });

    // prepare resolvió {beneficiary, authority} server-side (una sola llamada).
    expect(prepare.calls).toHaveLength(1);
    // authorizePrincipal recibió el escrow con beneficiary/authority DEL PREPARE (server-side), NUNCA del body.
    expect(wallet.authorizeCalls).toHaveLength(1);
    expect(wallet.authorizeCalls[0]!.deposit?.escrow).toEqual({
      beneficiary: FAKE_SOLANA_BENEFICIARY,
      authority: FAKE_SOLANA_AUTHORITY,
    });
    // gateway.settle broadcasteó la tx partial-firmada + reference.
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]!.partialSignedTx).toBe("AQID");
    expect(gateway.calls[0]!.remittanceId).toBe("r-1");
    // markPrincipalIn con la signature base58 verificada on-chain por /solana/sponsor.
    expect(out.snapshot.principalTx).toBe(FAKE_SOLANA_SIGNATURE);
    // payout_submitted con el payoutId + provenance de prepare (la orden TransFi ya se creó).
    expect(out.status).toBe("payout_submitted");
    expect(out.snapshot.payoutId).toBe("transfi-sol-po-1");
    expect(out.snapshot.payoutProvenance).toBe("transfi");
    // El submit del payout NO se llama: la release la dispara el facilitator async.
    expect(submitSpy).not.toHaveBeenCalled();
  });

  // Trazabilidad de la plata: la remesa tiene que poder decir QUIÉN dio el beneficiary contra el
  // que la persona firmó. Sin esto, con el carril de estreno encendido, Chaski atestaría una
  // dirección sin poder decir de dónde salió.
  it("guarda con la remesa el agente que dio el beneficiary (slug, carril de estreno incluido)", async () => {
    const repo = new InMemoryRepo();
    const prepare = new FakeSolanaPayoutPrepareGateway({
      ok: true,
      result: {
        beneficiary: FAKE_SOLANA_BENEFICIARY,
        authority: FAKE_SOLANA_AUTHORITY,
        attestation: "att",
        payoutId: "transfi-sol-po-1",
        provenance: "transfi",
        agent: {
          slug: "remit-cashout-payout",
          registry: "WasiAI",
          capability: "remittance-payout",
          trial: true,
        },
      },
    });
    const id = await seedQuoted(repo);

    const out = await build(
      repo,
      new FakeSolanaWallet(),
      prepare,
      new FakeSolanaSettlementGateway(),
    ).execute({ remittanceId: id });

    expect(out.status).toBe("payout_submitted");
    expect(out.snapshot.payoutAgent).toEqual({
      slug: "remit-cashout-payout",
      registry: "WasiAI",
      capability: "remittance-payout",
      trial: true,
    });
  });

  // No saber quién atendió es un estado legítimo y se guarda como tal. Rellenar con un objeto
  // vacío afirmaría que sabemos y no diríamos quién.
  it("sin agente informado, payoutAgent queda null (no un objeto fabricado)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);

    const out = await build(
      repo,
      new FakeSolanaWallet(),
      new FakeSolanaPayoutPrepareGateway(),
      new FakeSolanaSettlementGateway(),
    ).execute({ remittanceId: id });

    expect(out.status).toBe("payout_submitted");
    expect(out.snapshot.payoutAgent).toBeNull();
  });

  it("T2/AC-1: prepare !ok ⇒ failAndRefund ANTES de firmar; authorizePrincipal + settle NUNCA; principalTx null", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway({ ok: false, reason: "prepare_no_deposit_address" });
    const gateway = new FakeSolanaSettlementGateway();
    const id = await seedQuoted(repo);

    const out = await build(repo, wallet, prepare, gateway, new FakePayoutGateway()).execute({
      remittanceId: id,
    });

    expect(wallet.authorizeCalls).toHaveLength(0); // NUNCA firmó
    expect(gateway.calls).toHaveLength(0); // NUNCA broadcasteó
    expect(out.snapshot.principalTx).toBeNull(); // NUNCA markPrincipalIn
    expect(out.status).toBe("refunded"); // refund-on-failure (FakeRefundGateway resuelve)
    expect(out.snapshot.failureReason).toBe("prepare_no_deposit_address");
  });

  it("T2/AC-4: gateway !ok ⇒ failAndRefund; firma SÍ ocurre, markPrincipalIn NUNCA; principalTx null", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway({ ok: false, reason: "solana_settle_rejected" });
    const id = await seedQuoted(repo);

    const out = await build(repo, wallet, prepare, gateway, new FakePayoutGateway()).execute({
      remittanceId: id,
    });

    expect(wallet.authorizeCalls).toHaveLength(1); // firmó (arma la ix deposit)
    expect(gateway.calls).toHaveLength(1); // intentó broadcastear
    expect(out.snapshot.principalTx).toBeNull(); // pero NUNCA markPrincipalIn
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("solana_settle_rejected");
  });

  it("T2/AC-4: gateway throw (red/bug) ⇒ fail-closed solana_settle_unavailable; principalTx null", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway(undefined, "reject"); // settle() throw
    const id = await seedQuoted(repo);

    const out = await build(repo, wallet, prepare, gateway, new FakePayoutGateway()).execute({
      remittanceId: id,
    });

    expect(out.snapshot.principalTx).toBeNull();
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("solana_settle_unavailable");
  });

  // ── El comprobante que no existe ──────────────────────────────────────────────────────────────
  // Con el adapter REAL (LedgerRefundGateway, el que corre en producción) no hay reembolso: no
  // revierte nada. Antes devolvía igual un `refund-ledger-…` fabricado y la remesa terminaba en
  // `refunded` (terminal), mostrándole a la persona una referencia de reembolso inventada.
  it("adapter REAL sin comprobante ⇒ payout_failed con refundTx null, NUNCA refunded ni referencia inventada", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway({ ok: false, reason: "solana_settle_rejected" });
    const id = await seedQuoted(repo);

    const out = await build(
      repo,
      wallet,
      prepare,
      gateway,
      new FakePayoutGateway(),
      new LedgerRefundGateway(), // producción, no fake
    ).execute({ remittanceId: id });

    expect(out.status).toBe("payout_failed");
    expect(out.status).not.toBe("refunded");
    expect(out.snapshot.refundTx).toBeNull();
    // Y nada con forma de comprobante fabricado quedó persistido.
    const saved = await repo.get(id);
    expect(saved?.snapshot.refundTx).toBeNull();
    expect(saved?.snapshot.refundTx ?? "").not.toMatch(/refund-ledger-/);
  });

  it("T2/AC-1: sin envelope solana (wallet no arma el deposit) ⇒ settlement_unverified, sin broadcast", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet(null); // authorizePrincipal devuelve { tx } sin solana
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const id = await seedQuoted(repo);

    const out = await build(repo, wallet, prepare, gateway, new FakePayoutGateway()).execute({
      remittanceId: id,
    });

    expect(gateway.calls).toHaveLength(0); // NUNCA broadcastea sin envelope
    expect(out.snapshot.principalTx).toBeNull();
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("settlement_unverified");
  });
});

// ── Los TRES casos del principal cuando el settle no nos dio un sí ────────────────────────────────
// Antes había dos, y el que faltaba era el peligroso: "no pudimos averiguarlo" se escribía como "no
// entró", y sobre ese "no entró" se emitía un reembolso que nadie hizo. Cada caso se clava por
// separado; si dos colapsan en uno, alguno de estos tests se pone rojo.
describe("ConfirmAndSend: sabemos que no entró / sabemos que sí / no pudimos averiguarlo", () => {
  function afterSettleFailure(
    repo: InMemoryRepo,
    probe: FakeSolanaEscrowDepositProbe,
    gateway: FakeSolanaSettlementGateway,
  ) {
    return build(
      repo,
      new FakeSolanaWallet(),
      new FakeSolanaPayoutPrepareGateway(),
      gateway,
      new FakePayoutGateway(),
      new FakeRefundGateway("no-receipt"), // el adapter REAL no revierte nada
      probe,
    );
  }
  const throwingGateway = () => new FakeSolanaSettlementGateway(undefined, "reject");

  it("CASO 1: la cadena dice que NO entró: se conserva el reason puntual del settle", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("not_deposited");

    const out = await afterSettleFailure(repo, probe, throwingGateway()).execute({
      remittanceId: id,
    });

    expect(out.snapshot.failureReason).toBe("solana_settle_unavailable");
    expect(out.status).toBe("payout_failed");
    expect(out.snapshot.refundTx).toBeNull();
    expect(out.snapshot.principalTx).toBeNull();
  });

  it("CASO 2: la cadena dice que SÍ entró: marca de resolución manual, NUNCA el reason del settle", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("deposited");

    const out = await afterSettleFailure(repo, probe, throwingGateway()).execute({
      remittanceId: id,
    });

    expect(out.snapshot.failureReason).toBe(PRINCIPAL_SETTLED_REFUND_MANUAL);
    expect(out.snapshot.failureReason).not.toBe("solana_settle_unavailable");
    // La plata está en el vault: la remesa NO puede quedar terminal ni mostrar comprobante.
    expect(out.status).toBe("payout_failed");
    expect(out.snapshot.refundTx).toBeNull();
    // markPrincipalIn sigue exigiendo la signature verificada: el probe NO la reemplaza.
    expect(out.snapshot.principalTx).toBeNull();
    // Se le preguntó a la cadena por ESTA remesa y ESTE sender (la PDA se deriva de los dos).
    expect(probe.calls).toEqual([{ remittanceId: "r-1", sender: FAKE_SOLANA_BENEFICIARY }]);
  });

  it("CASO 3: no pudimos averiguarlo: reason propio, y NO se colapsa en ninguno de los otros dos", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("unknown");

    const out = await afterSettleFailure(repo, probe, throwingGateway()).execute({
      remittanceId: id,
    });

    expect(out.snapshot.failureReason).toBe(PRINCIPAL_STATE_UNKNOWN);
    expect(out.snapshot.failureReason).not.toBe("solana_settle_unavailable"); // ni "no entró"
    expect(out.snapshot.failureReason).not.toBe(PRINCIPAL_SETTLED_REFUND_MANUAL); // ni "sí entró"
    expect(out.status).toBe("payout_failed"); // recuperable
    expect(out.snapshot.refundTx).toBeNull(); // sin comprobante inventado
  });

  it("el probe se cae ⇒ unknown: un error al preguntar NO es una respuesta negativa", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("not_deposited", "reject"); // lanza

    const out = await afterSettleFailure(repo, probe, throwingGateway()).execute({
      remittanceId: id,
    });

    expect(out.snapshot.failureReason).toBe(PRINCIPAL_STATE_UNKNOWN);
  });

  // El timeout de 15 s de /api/settle/solana-sponsor llega como `solana_settle_unavailable` con
  // ok:false, NO como excepción (el gateway HTTP ya atrapa el fetch). Es EL caso de producción: el
  // facilitator pudo haber broadcasteado y confirmado el depósito mientras nosotros dejábamos de
  // esperar. Si esta rama no pregunta, el bug sigue vivo por el camino más frecuente.
  it("timeout del settle (ok:false unavailable) ⇒ pregunta a la cadena, no asume que no pasó", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("unknown");
    const gateway = new FakeSolanaSettlementGateway({
      ok: false,
      reason: "solana_settle_unavailable",
    });

    const out = await afterSettleFailure(repo, probe, gateway).execute({ remittanceId: id });

    expect(probe.calls).toHaveLength(1);
    expect(out.snapshot.failureReason).toBe(PRINCIPAL_STATE_UNKNOWN);
  });

  it("200 con shape inválido (unverified) ⇒ pregunta a la cadena: un 200 es compatible con un depósito hecho", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("deposited");
    const gateway = new FakeSolanaSettlementGateway({
      ok: false,
      reason: "solana_settle_unverified",
    });

    const out = await afterSettleFailure(repo, probe, gateway).execute({ remittanceId: id });

    expect(probe.calls).toHaveLength(1);
    expect(out.snapshot.failureReason).toBe(PRINCIPAL_SETTLED_REFUND_MANUAL);
  });

  it("broadcast_failed (409/502) ⇒ pregunta a la cadena: un blockhash vencido no prueba que no entró antes", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("deposited");
    const gateway = new FakeSolanaSettlementGateway({
      ok: false,
      reason: "solana_settle_broadcast_failed",
    });

    const out = await afterSettleFailure(repo, probe, gateway).execute({ remittanceId: id });

    expect(probe.calls).toHaveLength(1);
    expect(out.snapshot.failureReason).toBe(PRINCIPAL_SETTLED_REFUND_MANUAL);
  });

  // La otra mitad de la regla: cuando la respuesta viene de ANTES del broadcast, la cadena no aporta
  // nada y no se la molesta. Sin este test, "preguntar siempre" pasaría igual y perderíamos la
  // distinción entre un no medido y un no supuesto.
  it("rejected (422) y rate_limited (429) ⇒ NO se pregunta: la tx nunca salió", async () => {
    for (const reason of ["solana_settle_rejected", "solana_settle_rate_limited"] as const) {
      const repo = new InMemoryRepo();
      const id = await seedQuoted(repo);
      const probe = new FakeSolanaEscrowDepositProbe("deposited"); // aunque dijera que sí
      const gateway = new FakeSolanaSettlementGateway({ ok: false, reason });

      const out = await afterSettleFailure(repo, probe, gateway).execute({ remittanceId: id });

      expect(probe.calls).toHaveLength(0);
      expect(out.snapshot.failureReason).toBe(reason);
    }
  });

  // LOS DOS REASONS QUE LLEGARON DESPUÉS (guard del destino, S3.5 del settle). Los emite NUESTRA
  // propia route ANTES del forward al facilitator: no hubo broadcast, no se gastó un token de rate
  // limit, no se escribió una fila. O sea que "no entró" acá NO es una suposición, es un hecho, y
  // preguntarle a la cadena sobre un hecho conocido tiene un costo concreto: si el probe contesta
  // cualquier otra cosa, el reason del guard se PIERDE y la remesa deja de poder decir por qué falló.
  // `solana_settle_beneficiary_mismatch` es el único reason de todo el catálogo que describe un
  // ataque en curso: si se sobrescribe con "no sabemos", el ataque se vuelve invisible.
  it("los reasons del guard de destino ⇒ NO se pregunta: la route cortó antes del forward", async () => {
    for (const reason of [
      "solana_settle_beneficiary_mismatch",
      "solana_settle_beneficiary_unconfirmed",
    ] as const) {
      const repo = new InMemoryRepo();
      const id = await seedQuoted(repo);
      const probe = new FakeSolanaEscrowDepositProbe("deposited"); // aunque dijera que sí
      const gateway = new FakeSolanaSettlementGateway({ ok: false, reason });

      const out = await afterSettleFailure(repo, probe, gateway).execute({ remittanceId: id });

      expect(probe.calls).toHaveLength(0);
      expect(out.snapshot.failureReason).toBe(reason);
      expect(out.snapshot.failureReason).not.toBe(PRINCIPAL_STATE_UNKNOWN);
      expect(out.snapshot.refundTx).toBeNull();
      expect(out.snapshot.principalTx).toBeNull();
    }
  });

  // El cierre del círculo: el caso indeterminado tiene que dejar a la persona PODER recuperar. Antes
  // la remesa quedaba en `refunded` y este mismo use-case cortaba con refund_not_available.
  it("tras el caso indeterminado el sender PUEDE recuperar sus fondos del escrow", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("unknown");

    const out = await afterSettleFailure(repo, probe, throwingGateway()).execute({
      remittanceId: id,
    });
    expect(out.snapshot.failureReason).toBe(PRINCIPAL_STATE_UNKNOWN);

    // El sender firma el refund trustless del escrow y la cadena lo confirma.
    const recovered = await new RecoverEscrowFunds(
      repo,
      new FixedClock(),
      new FakeSolanaEscrowRefundGateway(),
    ).execute({ remittanceId: id, sender: FAKE_SOLANA_BENEFICIARY });

    expect(recovered.confirmation).toBe("confirmed");
    expect(recovered.remittance.status).toBe("refunded");
    // Y ESTE comprobante sí existe: es una signature real, no un refund-ledger- inventado.
    expect(recovered.remittance.snapshot.refundTx).toBe(FAKE_SOLANA_SIGNATURE);
  });
});

// ── T7 / DT-8 (WKH-320) — el tapón fail-closed ────────────────────────────────────────────────────
// Este settlement es el ÚNICO que existe: si no está inyectado no hay un camino alternativo al que
// caer, se cae al vacío. Sin este tapón, execute() llegaría al final y devolvería la remesa
// 'confirmed' SIN haber movido nada — un no-op silencioso en el money-path, peor que el throw de antes.
describe("ConfirmAndSend — DT-8: sin `solana` inyectado (WKH-320)", () => {
  it("T7: solana === undefined ⇒ payout_failed/refunded con reason settlement_unavailable", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const refund = new FakeRefundGateway();
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway({ authorized: true }),
      refund,
      // sin 6º arg: flag apagado / envs faltantes
    ).execute({ remittanceId: id });

    // NUNCA 'confirmed' en silencio.
    expect(out.status).toBe("refunded");
    expect(out.status).not.toBe("confirmed");
    expect(out.snapshot.failureReason).toBe("settlement_unavailable");
    // NUNCA markPrincipalIn: no entró un peso.
    expect(out.snapshot.principalTx).toBeNull();
    // Y ni siquiera se le pidió la firma a la wallet.
    expect(authorizeSpy).not.toHaveBeenCalled();
    // El credit-back corrió en el MISMO execute (ninguna remesa queda huérfana).
    expect(refund.calls).toHaveLength(1);
    expect(refund.calls[0]?.reason).toBe("settlement_unavailable");
  });

  it("T7: NINGUNA excepción escapa de execute() (fail-closed controlado, no un throw crudo)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    await expect(
      new ConfirmAndSend(
        new FakeSolanaWallet(),
        repo,
        new FixedClock(),
        new FakePayoutAuthorityGateway({ authorized: true }),
        new FakeRefundGateway(),
      ).execute({ remittanceId: id }),
    ).resolves.toBeDefined();
  });
});
