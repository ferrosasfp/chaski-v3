// Tests — el guard de RENT del camino no-custodial: ¿le alcanza el SOL al remitente para las cuentas
// que crea la ix `deposit`?
//
// POR QUÉ EXISTE ESTE ARCHIVO. El depósito no es gasless para quien envía. Medido en devnet sobre las
// 3 transacciones patrocinadas que existen: el feePayer (facilitator) quedó en -10.000 lamports y el
// REMITENTE en -4.002.000, que es el rent de `escrow_state` (1.962.720) más el del vault (2.039.280).
// Sin este guard, alguien con USDC y sin SOL firmaba dos veces, el facilitator co-firmaba, el
// validador rechazaba por rent, y la pantalla terminaba diciendo "No sabemos todavía si te cobramos"
// — el mensaje reservado para cuando el dinero PUEDE estar en el escrow. No se había movido nada.
//
// Los tres comportamientos se clavan por separado, y a propósito: sacar el chequeo, invertir el
// comparador y hacer que un RPC caído bloquee ponen rojo tres tests DISTINTOS de este archivo.
import { describe, expect, it } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_SIGNATURE,
  FakePayoutAuthorityGateway,
  FakeRefundGateway,
  FakeSolanaEscrowDepositProbe,
  FakeSolanaPayoutPrepareGateway,
  FakeSolanaSenderSolBalanceProbe,
  FakeSolanaSettlementGateway,
  FakeSolanaWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../../test-support/fakes";
import { SENDER_MIN_LAMPORTS_FOR_DEPOSIT } from "../solana-escrow-rent";
import { ConfirmAndSend, SOLANA_SENDER_SOL_INSUFFICIENT } from "./confirm-and-send";

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

/** El camino real, con TODO lo demás en verde: lo único que varía entre casos es el saldo de SOL. */
function build(
  repo: InMemoryRepo,
  wallet: FakeSolanaWallet,
  prepare: FakeSolanaPayoutPrepareGateway,
  gateway: FakeSolanaSettlementGateway,
  senderBalance: FakeSolanaSenderSolBalanceProbe,
): ConfirmAndSend {
  return new ConfirmAndSend(
    wallet,
    repo,
    new FixedClock(),
    new FakePayoutAuthorityGateway({ authorized: true }),
    // "no-receipt" = lo que hace el adapter REAL de producción (LedgerRefundGateway): no fabrica un
    // comprobante de reembolso, así que la remesa queda en payout_failed CON su reason a la vista. Con
    // el fake que sí lo fabrica, el estado terminal sería `refunded` y el reason quedaría tapado detrás
    // de un reembolso que nunca ocurrió — justo la mentira que este repo ya arrancó una vez.
    new FakeRefundGateway("no-receipt"),
    {
      prepare,
      gateway,
      probe: new FakeSolanaEscrowDepositProbe(),
      senderBalance,
    },
  );
}

describe("ConfirmAndSend — guard de rent: el SOL del remitente ANTES de armar y firmar", () => {
  it("saldo MEDIDO e insuficiente ⇒ reason propio, y la wallet NUNCA llega a que le pidan la firma", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const senderBalance = new FakeSolanaSenderSolBalanceProbe(SENDER_MIN_LAMPORTS_FOR_DEPOSIT - 1);
    const id = await seedQuoted(repo);

    const out = await build(repo, wallet, prepare, gateway, senderBalance).execute({
      remittanceId: id,
    });

    // 1. El reason es SUYO. No es "payout_failed", no es PRINCIPAL_STATE_UNKNOWN, no es un 502 del
    //    facilitator: es la causa real, y es local.
    expect(out.snapshot.failureReason).toBe(SOLANA_SENDER_SOL_INSUFFICIENT);
    expect(out.snapshot.status).toBe("payout_failed");
    // 2. NO SE PIDIÓ NINGUNA FIRMA. Es la mitad del valor de este guard: la persona no atraviesa dos
    //    prompts de billetera para enterarse después de que le faltaban centavos de SOL.
    expect(wallet.authorizeCalls).toHaveLength(0);
    // 3. Tampoco se creó una orden de payout server-side ni se broadcasteó nada: el corte es ANTES.
    expect(prepare.calls).toHaveLength(0);
    expect(gateway.calls).toHaveLength(0);
    // 4. Y se le preguntó a la cadena por LA MISMA address que iba a firmar.
    expect(senderBalance.calls).toEqual([{ sender: FAKE_SOLANA_BENEFICIARY }]);
    // 5. Nada se movió ⇒ no hay principal en el escrow que reportar.
    expect(out.snapshot.principalTx).toBeFalsy();
  });

  // CANDADO DE NO-REGRESIÓN DE LA DEMO. Este es el test que se pone rojo si alguien invierte el
  // comparador: con saldo de sobra el flujo tiene que llegar hasta el final, exactamente como hoy.
  it("saldo suficiente ⇒ el flujo avanza IDÉNTICO: firma, settle, principal_in y payout_submitted", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const id = await seedQuoted(repo);

    const out = await build(
      repo,
      wallet,
      prepare,
      gateway,
      new FakeSolanaSenderSolBalanceProbe(1_000_000_000), // 1 SOL
    ).execute({ remittanceId: id });

    expect(out.snapshot.status).toBe("payout_submitted");
    expect(out.snapshot.failureReason).toBeFalsy();
    expect(wallet.authorizeCalls).toHaveLength(1); // sí se firmó
    expect(prepare.calls).toHaveLength(1);
    expect(out.snapshot.principalTx).toBe(FAKE_SOLANA_SIGNATURE);
  });

  // EL BORDE EXACTO, del lado que deja pasar: el umbral es lo que la transacción NECESITA, así que
  // tenerlo justo alcanza. Un `<=` en vez de `<` rechazaría a quien tiene exactamente lo suficiente.
  it("saldo EXACTAMENTE igual al umbral ⇒ deja pasar (el umbral es lo que hace falta, no un extra)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const id = await seedQuoted(repo);

    const out = await build(
      repo,
      wallet,
      new FakeSolanaPayoutPrepareGateway(),
      new FakeSolanaSettlementGateway(),
      new FakeSolanaSenderSolBalanceProbe(SENDER_MIN_LAMPORTS_FOR_DEPOSIT),
    ).execute({ remittanceId: id });

    expect(out.snapshot.status).toBe("payout_submitted");
    expect(wallet.authorizeCalls).toHaveLength(1);
  });

  // ── "NO PUDE PREGUNTAR" NO ES "NO TENÉS SALDO" ─────────────────────────────────────────────────
  // Las dos formas en que la medición no ocurre, y las dos dejan seguir. Bloquear acá convertiría un
  // RPC caído en una acusación a la billetera de la persona, y dejaría a TODO el mundo sin poder
  // enviar por una causa que no tiene nada que ver con su saldo. El guard duro de verdad sigue siendo
  // el runtime de Solana, que rechaza la transacción si el rent no alcanza, con este chequeo caído o no.
  it("el probe TIRA (RPC caído) ⇒ el flujo SIGUE, no se bloquea ni se acusa a la wallet", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const id = await seedQuoted(repo);

    const out = await build(
      repo,
      wallet,
      new FakeSolanaPayoutPrepareGateway(),
      new FakeSolanaSettlementGateway(),
      new FakeSolanaSenderSolBalanceProbe(0, "reject"), // el 0 no se lee: el probe ni contesta
    ).execute({ remittanceId: id });

    expect(out.snapshot.failureReason).not.toBe(SOLANA_SENDER_SOL_INSUFFICIENT);
    expect(out.snapshot.status).toBe("payout_submitted");
    expect(wallet.authorizeCalls).toHaveLength(1); // se llegó a firmar, como cuando no había guard
  });

  it("el probe contesta 'unknown' ⇒ el flujo SIGUE (la indeterminación no se colapsa en insuficiente)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const id = await seedQuoted(repo);

    const out = await build(
      repo,
      wallet,
      new FakeSolanaPayoutPrepareGateway(),
      new FakeSolanaSettlementGateway(),
      new FakeSolanaSenderSolBalanceProbe(0, "unknown"),
    ).execute({ remittanceId: id });

    expect(out.snapshot.failureReason).not.toBe(SOLANA_SENDER_SOL_INSUFFICIENT);
    expect(out.snapshot.status).toBe("payout_submitted");
    expect(wallet.authorizeCalls).toHaveLength(1);
  });
});
