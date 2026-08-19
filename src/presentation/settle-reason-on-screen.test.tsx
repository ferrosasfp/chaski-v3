// @vitest-environment jsdom
//
// Tests — QUÉ TERMINA VIENDO LA PERSONA cuando el settle no dio un sí, medido de punta a punta.
//
// POR QUÉ ESTE ARCHIVO EXISTE Y NO ALCANZABAN LOS QUE YA HABÍA. Los tests de pantalla construyen la
// remesa fallada a mano (`base.markPayoutFailed(reason, T0)`) y los del use-case miran el snapshot.
// Ninguno de los dos cruza SETTLE_REASONS_BEFORE_BROADCAST con el texto: se puede sacar o agregar un
// reason de esa lista y los dos grupos siguen verdes, porque cada uno mira su mitad. La lista es la
// que decide si a alguien se le dice "no se movió nada" o "no sabemos si te cobramos" sobre SU
// plata, así que acá se recorre el camino entero, del gateway a la frase: ConfirmAndSend real →
// snapshot persistido → TrackView real.
//
// Los dos mutantes que estos tests matan, y son opuestos entre sí:
//   1. sacar `solana_settle_ledger_unavailable` de la lista ⇒ vuelve el "no sabemos" sobre un corte
//      que ocurrió antes del forward (la app duda de algo que sabe).
//   2. meter el enum COMPARTIDO `solana_settle_unavailable` en la lista ⇒ el timeout de 15 s, que es
//      posterior al broadcast, pasaría a afirmar "no se movió nada" (la app asegura algo que no
//      sabe). Éste es el peor de los dos y es el atajo tentador para arreglar el primero.
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Money } from "../domain/money";
import {
  type KycVerification,
  type Quote,
  Remittance,
  type RemittanceState,
} from "../domain/remittance";
import {
  ConfirmAndSend,
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
  SOLANA_SETTLE_LEDGER_UNAVAILABLE,
} from "../application/use-cases/confirm-and-send";
import type { SolanaSettlementFailureReason } from "../application/ports";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeRefundGateway,
  FakeSolanaEscrowDepositProbe,
  FakeSolanaPayoutPrepareGateway,
  FakeSolanaSenderSolBalanceProbe,
  FakePruebaDePosesionPorEnlace,
  FakeSolanaSettlementGateway,
  FakeSolanaWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../test-support/fakes"; import { esperarListo } from "../test-support/desenlaces"; // WKH-356: narrowing de ResultadoDeEnvio. TIRA si execute() suspende donde el test no lo espera.
import { escrowFundsKnowledge, escrowKnowledgeCopy } from "./flow-vm";
import { TrackView } from "./flow";

const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true, realVerified: true, verifiedAt: null,
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

/**
 * Corre el money-path REAL hasta el settle, con el reason que el gateway HTTP habría devuelto y con
 * la respuesta que la cadena le daría al probe, y devuelve el snapshot que quedó persistido. Es el
 * mismo objeto que la pantalla lee después de una recarga, así que lo que se renderice con él es
 * literalmente lo que ve la persona.
 */
async function runSettleFailure(
  reason: SolanaSettlementFailureReason,
  chainSays: "deposited" | "not_deposited" | "unknown",
): Promise<{ snapshot: RemittanceState; probeCalls: number }> {
  const repo = new InMemoryRepo();
  const r = Remittance.create("rem-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  await repo.save(r);

  const probe = new FakeSolanaEscrowDepositProbe(chainSays);
  const out = esperarListo(await new ConfirmAndSend(
    new FakeSolanaWallet(),
    repo,
    new FixedClock(),
    new FakeRefundGateway("no-receipt"), // el adapter de producción no revierte nada
    {
      prepare: new FakeSolanaPayoutPrepareGateway(),
      gateway: new FakeSolanaSettlementGateway({ ok: false, reason }),
      probe,
      senderBalance: new FakeSolanaSenderSolBalanceProbe(), pop: new FakePruebaDePosesionPorEnlace(),
    },
  ).execute({ remittanceId: "rem-1" }));

  return { snapshot: out.snapshot, probeCalls: probe.calls.length };
}

/** La pantalla de seguimiento, con el snapshot que dejó el use-case. Sin wallet conectada: lo que se
 *  mide acá es el TEXTO, no la acción de recuperar (que ya tiene sus propios tests). */
function renderTrack(snapshot: RemittanceState): void {
  render(<TrackView rem={snapshot} sender={null} onRecovered={() => {}} />);
}

describe("del reason del settle a la frase en pantalla (SETTLE_REASONS_BEFORE_BROADCAST)", () => {
  afterEach(() => cleanup());

  // ── MUTANTE 1: sacar el reason nuevo de la lista ────────────────────────────────────────────────
  // El 503 del ledger sale del catch de `listPreparedDepositAddresses`, ANTES del fetch al
  // facilitator (app/api/settle/solana-sponsor/route.ts:126-133 vs 156). La tx no se transmitió, y
  // eso es un hecho que se lee del orden del archivo. Si el reason sale de la lista, el use-case va
  // a `failAfterBroadcast`, el probe contesta lo que sea, y la pantalla pasa a dudar en voz alta.
  it("★ MUTANTE 1: el corte pre-forward dice que no se movió nada, NUNCA 'no sabemos si te cobramos'", async () => {
    // La cadena contesta "unknown", que es lo que devuelve el probe cuando la cuenta no existe: si
    // alguien sacara el reason de la lista, ESTE es el texto que aparecería.
    const { snapshot, probeCalls } = await runSettleFailure(
      SOLANA_SETTLE_LEDGER_UNAVAILABLE,
      "unknown",
    );

    expect(probeCalls).toBe(0); // no se le pregunta a la cadena por una tx que nunca salió
    expect(snapshot.failureReason).toBe(SOLANA_SETTLE_LEDGER_UNAVAILABLE);
    renderTrack(snapshot);

    expect(screen.getByText(/No llegamos a enviar tu depósito/)).toBeInTheDocument();
    expect(screen.getByText(/no se movió ningún USDC de tu wallet/)).toBeInTheDocument();
    expect(screen.getByText(/probá de nuevo en un rato/)).toBeInTheDocument();
    // Ni la duda sobre el cobro, ni el fallo de entrega genérico, ni un reembolso prometido.
    expect(screen.queryByText(/No sabemos todavía/)).toBeNull();
    expect(screen.queryByText(/No pudo entregarse/)).toBeNull();
    expect(screen.queryByText(/te reembolsamos/)).toBeNull();
    expect(screen.queryByText(/Referencia de reembolso/)).toBeNull();
  });

  // El mismo hecho dicho por la otra superficie que habla de la plata: el historial.
  it("★ MUTANTE 1 (historial): el corte pre-forward se lista como 'no llegaste a depositar'", async () => {
    const { snapshot } = await runSettleFailure(SOLANA_SETTLE_LEDGER_UNAVAILABLE, "unknown");

    expect(escrowFundsKnowledge(snapshot)).toBe("no-deposit");
    expect(escrowKnowledgeCopy(escrowFundsKnowledge(snapshot))).toBe("No llegaste a depositar.");
  });

  // ── MUTANTE 2: meter el enum COMPARTIDO en la lista ─────────────────────────────────────────────
  // `solana_settle_unavailable` es el reason del timeout de 15 s del fetch al facilitator
  // (route.ts:156-163) y de cualquier 5xx que no sepamos ubicar: la tx PUDO haber entrado. Éste es
  // el candado que impide que dentro de seis meses alguien "simplifique" el arreglo de arriba
  // agregando el enum compartido a la lista. Se mide con el desenlace más caro: la cadena confirma
  // el depósito. Con el mutante adentro, esta pantalla diría "no llegaste a depositar" a alguien que
  // tiene USDC en el vault, y dejaría de ofrecerle la recuperación.
  it("★★ MUTANTE 2: el timeout de 15 s NUNCA afirma que no se movió nada", async () => {
    const { snapshot, probeCalls } = await runSettleFailure(
      "solana_settle_unavailable",
      "deposited",
    );

    expect(probeCalls).toBe(1); // se le preguntó a la cadena, que es la única que sabe
    expect(snapshot.failureReason).toBe(PRINCIPAL_SETTLED_REFUND_MANUAL);
    expect(escrowFundsKnowledge(snapshot)).toBe("in-escrow");
    expect(escrowFundsKnowledge(snapshot)).not.toBe("no-deposit");
    renderTrack(snapshot);

    expect(screen.getByText(/Tus USDC quedaron en el escrow/)).toBeInTheDocument();
    expect(screen.getByText(/Los USDC siguen ahí, a tu nombre/)).toBeInTheDocument();
    // Y NINGUNA de las frases que afirman que la plata está quieta en la wallet.
    expect(screen.queryByText(/no se movió ningún USDC/)).toBeNull();
    expect(screen.queryByText(/No llegamos a enviar tu depósito/)).toBeNull();
  });

  // La otra mitad del mismo mutante: con la cadena sin respuesta, el timeout tiene que terminar en
  // "no sabemos", que es lo honesto. Si el enum compartido entrara en la lista, esto pasaría a
  // afirmar que no salió.
  it("★★ MUTANTE 2 (bis): timeout + cadena muda ⇒ 'no sabemos', no un 'no salió' de consuelo", async () => {
    const { snapshot, probeCalls } = await runSettleFailure("solana_settle_unavailable", "unknown");

    expect(probeCalls).toBe(1);
    expect(snapshot.failureReason).toBe(PRINCIPAL_STATE_UNKNOWN);
    renderTrack(snapshot);

    expect(screen.getByText(/No sabemos todavía si te cobramos/)).toBeInTheDocument();
    expect(screen.queryByText(/no se movió ningún USDC/)).toBeNull();
  });

  // ── NO-REGRESIÓN: un fallo genuinamente posterior al broadcast sigue yendo a la cadena ──────────
  // Un blockhash vencido (409/502) prueba que la tx no puede entrar DE ACÁ EN MÁS, no que no haya
  // entrado antes. Esta rama no la toca el fix, y por eso está: el reason nuevo no puede haberse
  // llevado puesto el trato de los demás.
  it.each(["solana_settle_broadcast_failed", "solana_settle_unverified"] as const)(
    "no-regresión (%s): sigue preguntándole a la cadena y respeta lo que contesta",
    async (reason) => {
      const { snapshot, probeCalls } = await runSettleFailure(reason, "deposited");

      expect(probeCalls).toBe(1);
      expect(snapshot.failureReason).toBe(PRINCIPAL_SETTLED_REFUND_MANUAL);
      renderTrack(snapshot);
      expect(screen.getByText(/Tus USDC quedaron en el escrow/)).toBeInTheDocument();
    },
  );

  // Y el reverso: los reasons que YA estaban en la lista siguen sin preguntar y sin heredar la frase
  // nueva. El reason nuevo tiene copy propio; los viejos conservan el suyo.
  it.each([
    "solana_settle_rejected",
    "solana_settle_rate_limited",
    "solana_settle_beneficiary_mismatch",
    "solana_settle_beneficiary_unconfirmed",
    "solana_settle_sender_proof_invalid",
  ] as const)("no-regresión (%s): sigue cortando sin preguntar y con su propia frase", async (reason) => {
    const { snapshot, probeCalls } = await runSettleFailure(reason, "deposited");

    expect(probeCalls).toBe(0);
    expect(snapshot.failureReason).toBe(reason);
    renderTrack(snapshot);
    expect(screen.getByText(/No pudo entregarse/)).toBeInTheDocument();
    expect(screen.queryByText(/No llegamos a enviar tu depósito/)).toBeNull();
  });
});
