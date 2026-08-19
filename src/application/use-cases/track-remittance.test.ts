import { describe, expect, it } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FakePayoutGateway,
  FakeRefundGateway,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../../test-support/fakes";
import { LedgerRefundGateway } from "../../infrastructure/refund/ledger-refund-gateway";
import { TrackRemittance } from "./track-remittance";
import type { PayoutGateway, PayoutRecord } from "../ports";

const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true, realVerified: true, verifiedAt: null,
  riskLevel: "low",
  provenance: "didit",
  identity: null,
};

// receive lockeado = 1480 PEN → tolerancia = max(0.02, 1480*0.01) = 14.8 PEN (AC-6/CD-6).
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

// Construye una remesa ya en payout_submitted (lista para track()).
async function seedSubmitted(repo: InMemoryRepo): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0); // WKH-187: cotiza antes del KYC (created→quoted)
  r.startKyc(T0, "0xSender"); // quoted→kyc_pending
  r.applyKyc(passKyc, T0); // kyc_pending→kyc_passed (quote sobrevive)
  r.confirm(T0);
  r.markPrincipalIn("0xprincipal", T0);
  r.markPayoutSubmitted("p-1", T0);
  await repo.save(r);
  return "r-1";
}

describe("TrackRemittance — reconciliación PRE-markSettled (AC-6/CD-6)", () => {
  it("deliveredPen dentro de tolerancia → settled", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const payouts = new FakePayoutGateway({}, { status: "settled", deliveredPen: Money.of(1480, "PEN"), txRef: "0xok" });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), new FakeRefundGateway()).execute({ remittanceId: id });
    expect(out.status).toBe("settled");
    expect(out.snapshot.deliveredPen).toEqual(Money.of(1480, "PEN"));
  });

  it("T-AC5e: propaga la provenance del status() al snapshot al settlear (payout mock → local-fallback)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const payouts = new FakePayoutGateway({}, { status: "settled", deliveredPen: Money.of(1480, "PEN"), txRef: "0xok", provenance: "local-fallback" });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), new FakeRefundGateway()).execute({ remittanceId: id });
    expect(out.status).toBe("settled");
    expect(out.snapshot.payoutProvenance).toBe("local-fallback");
  });

  it("deliveredPen en el borde exacto de la tolerancia (+14.8) → settled", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const payouts = new FakePayoutGateway({}, { status: "settled", deliveredPen: Money.of(1494.8, "PEN"), txRef: "0xok" });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), new FakeRefundGateway()).execute({ remittanceId: id });
    expect(out.status).toBe("settled");
  });

  it("deliveredPen FUERA de tolerancia → refunded razón payout_amount_mismatch, NUNCA settled (AC-6/AC-7)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new FakeRefundGateway();
    const payouts = new FakePayoutGateway({}, { status: "settled", deliveredPen: Money.of(368, "PEN"), txRef: "0xbad" });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({ remittanceId: id });
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("payout_amount_mismatch");
    expect(out.snapshot.refundTx).toBe("refund-fake");
    expect(refund.calls).toHaveLength(1);
    expect(refund.calls[0]?.reason).toBe("payout_amount_mismatch");
    expect(refund.calls[0]?.amountUsd).toEqual(Money.of(400, "USDC")); // se refundea el principal
  });

  it("deliveredPen null (fallback) → settled con null, reconciliación NO corre (regresión byte-idéntica)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new FakeRefundGateway();
    const payouts = new FakePayoutGateway({}, { status: "settled", deliveredPen: null, txRef: null });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({ remittanceId: id });
    expect(out.status).toBe("settled");
    expect(out.snapshot.deliveredPen).toBeNull();
    expect(refund.calls).toHaveLength(0);
  });
});

describe("TrackRemittance — refund-on-failure (AC-7/CD-7)", () => {
  it("status failed → refunded, failureReason preservado, creditBack llamado", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new FakeRefundGateway();
    const payouts = new FakePayoutGateway({}, { status: "failed", failureReason: "partner_down", deliveredPen: null });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({ remittanceId: id });
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("partner_down");
    expect(out.snapshot.refundTx).toBe("refund-fake");
    expect(refund.calls).toHaveLength(1);
  });

  // ── El comprobante que no existe ──────────────────────────────────────────────────────────────
  // Acá el principal está SEGURO en el vault del escrow (se llega desde payout_submitted, con el
  // deposit confirmado on-chain). El adapter REAL de producción no revierte nada; escribir `refunded`
  // sobre eso cerraba la única salida que tiene la persona para sacar su plata.
  it("adapter sin comprobante (el REAL de producción) → payout_failed y refundTx null, NUNCA refunded", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new LedgerRefundGateway(); // el que corre en producción, no un fake
    const payouts = new FakePayoutGateway({}, { status: "failed", failureReason: "partner_down", deliveredPen: null });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({ remittanceId: id });
    expect(out.status).toBe("payout_failed"); // recuperable: el sender todavía puede refundear el escrow
    expect(out.status).not.toBe("refunded"); // `refunded` es terminal y no hay transición de salida
    expect(out.snapshot.refundTx).toBeNull(); // ninguna "referencia de reembolso" inventada
    // Y el estado PERSISTIDO dice lo mismo (no sólo el agregado en memoria).
    const saved = await repo.get(id);
    expect(saved?.status).toBe("payout_failed");
    expect(saved?.snapshot.refundTx).toBeNull();
  });

  it("refund falla (reject) → queda en payout_failed (best-effort, no throw)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new FakeRefundGateway("reject");
    const payouts = new FakePayoutGateway({}, { status: "failed", failureReason: "partner_down", deliveredPen: null });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({ remittanceId: id });
    expect(out.status).toBe("payout_failed");
    expect(out.snapshot.failureReason).toBe("partner_down");
    expect(out.snapshot.refundTx).toBeNull();
  });
});

describe("TrackRemittance — MNR-B: incertidumbre no false-refundea", () => {
  it("status no-terminal 'submitted' (cache-miss del gateway a2a) → NO refunda, queda payout_submitted (recuperable)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new FakeRefundGateway();
    // El A2aPayoutGateway en cache-miss devuelve status:"submitted" (MNR-B): estado NO-terminal.
    const payouts = new FakePayoutGateway({}, { status: "submitted", deliveredPen: null, txRef: null, failureReason: "payout_status_unknown" });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({ remittanceId: id });
    expect(out.status).toBe("payout_submitted"); // NO transiciona a payout_failed
    expect(out.status).not.toBe("refunded");
    expect(refund.calls).toHaveLength(0); // NUNCA refundea sobre incertidumbre
  });
});

describe("TrackRemittance — MNR-D: reconciliación fail-safe (simetría con ConfirmAndSend)", () => {
  it("si la reconciliación LANZA (reconcile_currency_mismatch) → execute() NO rechaza crudo, degrada a failAndRefund", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new FakeRefundGateway();
    // deliveredPen con moneda DIVERGENTE (USDC vs el receive lockeado en PEN) → isDeliveredWithin...
    // lanza reconcile_currency_mismatch. Fuera del try/catch escaparía crudo (rechazo de execute()).
    const payouts = new FakePayoutGateway({}, { status: "settled", deliveredPen: Money.of(1480, "USDC"), txRef: "0xok" });
    const uc = new TrackRemittance(payouts, repo, new FixedClock(), refund);
    // La promesa NO rechaza (fail-safe uniforme); se degrada a refunded con razón estable.
    const out = await uc.execute({ remittanceId: id });
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("reconcile_currency_mismatch");
    expect(refund.calls).toHaveLength(1);
  });
});

describe("TrackRemittance — guard (idempotencia)", () => {
  it("no corre si el estado no es payout_submitted (terminal/otro) → no-op", async () => {
    const repo = new InMemoryRepo();
    // remesa recién creada (created) → el guard corta sin tocar payout
    const r = Remittance.create("r-2", beneficiary(), Money.of(400, "USDC"), T0);
    await repo.save(r);
    const refund = new FakeRefundGateway();
    const payouts = new FakePayoutGateway();
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({ remittanceId: "r-2" });
    expect(out.status).toBe("created");
    expect(refund.calls).toHaveLength(0);
  });
});

// ── WKH-337 · el use-case contra el gateway REAL que lee el ledger ───────────────────────────────────
//
// 🔴 POR QUÉ ACÁ VA EL GATEWAY REAL Y NO `FakePayoutGateway`. Lo que estos dos tests custodian no es el
// use-case (no cambió ni una línea) sino la COMPOSICIÓN: qué termina escrito en el agregado cuando el
// desenlace viene del ledger. Con un doble de payout habría que escribir a mano el `PayoutRecord`, y
// entonces el test afirmaría lo que yo tipeé en vez de lo que el gateway produce — que es exactamente
// donde vive DT-6.
import { LedgerPayoutStatusGateway } from "../../infrastructure/settlement/ledger-payout-status-gateway";
import { RecoverEscrowFunds } from "./recover-escrow-funds";
import { FakeSolanaEscrowRefundGateway } from "../../test-support/fakes";
import { isDemoMode, isPayoutDemo } from "../../presentation/flow-vm";
import { afterEach, vi } from "vitest";

const SENDER_337 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** El gateway REAL, con la prueba ya observada y el `fetch` de la ruta stubeado. */
function gatewayDelLedger(payout: unknown): LedgerPayoutStatusGateway {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ payout }, { status: 200 })),
  );
  return new LedgerPayoutStatusGateway(
    { getAddress: async () => SENDER_337 },
    { peek: () => ({ challenge: "ch", signature: "sig" }) }, // OBSERVADA: el lector no tiene `prove`
    new FixedClock(),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TrackRemittance + el ledger (WKH-337)", () => {
  // ── 🔴 T-337.6 (AC-5 / DT-6) — la trampa de `provenance: ""` ────────────────────────────────────────
  it("T-337.6: un `settled` REAL vía ledger NO prende 'Modo demo', y la proveniencia es 'transfi'", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const payouts = gatewayDelLedger({ outcome: "known", status: "settled", provenance: "transfi" });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), new LedgerRefundGateway()).execute({
      remittanceId: id,
    });
    expect(out.status).toBe("settled");
    // El valor que quedó escrito en el agregado, no el que el gateway devolvió: `markSettled` PISA el
    // campo con cualquier valor distinto de `undefined`.
    expect(out.snapshot.payoutProvenance).toBe("transfi");
    // 🔴 EL ASSERT QUE MATA M4. Con `provenance: ""` en la rama `known`, `isPayoutDemo("")` es `true`
    // (`"" != null` ✓ y `!has("")` ✓) ⇒ una remesa REAL recién liquidada prendería el banner "Modo demo".
    expect(isPayoutDemo(out.snapshot.payoutProvenance)).toBe(false);
    expect(
      isDemoMode(out.snapshot),
      "la remesa se liquidó con evidencia REAL del proveedor y la pantalla diría 'Modo demo'",
    ).toBe(false);
    // Y `deliveredPen` sigue null: el webhook no trae el monto entregado, así que no se inventa ninguno
    // (H-1 declarada — el recibo dice "tiene que recibir", que es cierto).
    expect(out.snapshot.deliveredPen).toBeNull();
  });

  it("una remesa vieja (payout_provenance null ⇒ provenance_not_real) se queda EXACTAMENTE como hoy", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const payouts = gatewayDelLedger({ outcome: "unknown", reason: "provenance_not_real" });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), new LedgerRefundGateway()).execute({
      remittanceId: id,
    });
    expect(out.status).toBe("payout_submitted"); // "Pago en curso", igual que antes de esta HU
    // Y el campo NO se pisó con nada: la ausencia de dato sigue siendo ausencia de dato.
    expect(out.snapshot.payoutProvenance).toBeNull();
  });

  // ── 🔴 T-337.4 (AC-4) — el `failed` real, y la remesa SIGUE recuperable ─────────────────────────────
  it("T-337.4: known/failed ⇒ payout_failed, el refund corre, y la remesa sigue en RECOVERABLE", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const payouts = gatewayDelLedger({ outcome: "known", status: "failed", provenance: "transfi" });
    const refund = new FakeRefundGateway("no-receipt"); // el adapter real es ledger-only: no revierte nada
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({
      remittanceId: id,
    });
    expect(out.status).toBe("payout_failed");
    expect(out.snapshot.failureReason).toBe("payout_failed_provider");
    expect(refund.calls).toHaveLength(1); // el credit-back se intentó en el MISMO execute()

    // 🔴 EL ASSERT QUE IMPORTA, Y ES EJECUTABLE EN VEZ DE UNA AFIRMACIÓN SOBRE UNA LISTA. No se compara
    // el estado contra `RECOVERABLE` (que no se exporta): se corre el use-case que consulta ese guard y
    // se afirma que NO corta. Si `payout_failed` dejara de ser recuperable, esto tira
    // `refund_not_available` y la persona se queda sin camino a sus USDC.
    const recover = new RecoverEscrowFunds(repo, new FixedClock(), new FakeSolanaEscrowRefundGateway());
    await expect(
      recover.execute({ remittanceId: id, sender: SENDER_337 }),
      "una remesa cuyo payout FALLÓ tiene que seguir pudiendo recuperar el principal del escrow",
    ).resolves.toMatchObject({ confirmation: "confirmed" });
  });

  it("y un `settled` real, en cambio, YA NO es recuperable — y eso es correcto, no un bug", async () => {
    // El proveedor le entregó los PEN al beneficiario; devolverle el principal al remitente después de
    // eso sería un doble gasto contra quien adelantó el fiat. Este assert está acá para que nadie
    // "arregle" la dirección inversa: es el par del de arriba.
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const payouts = gatewayDelLedger({ outcome: "known", status: "settled", provenance: "transfi" });
    await new TrackRemittance(payouts, repo, new FixedClock(), new LedgerRefundGateway()).execute({
      remittanceId: id,
    });
    const recover = new RecoverEscrowFunds(repo, new FixedClock(), new FakeSolanaEscrowRefundGateway());
    await expect(recover.execute({ remittanceId: id, sender: SENDER_337 })).rejects.toThrow(
      "refund_not_available",
    );
  });

  it("un no-terminal del ledger NO llama al refund ni mueve el estado (fail-safe, CD-1)", async () => {
    for (const payout of [
      { outcome: "unknown", reason: "no_row" },
      { outcome: "unknown", reason: "not_terminal" },
      { outcome: "unknown", reason: "conflicting_rows" },
      { outcome: "unknown", reason: "provenance_not_real" },
    ]) {
      const repo = new InMemoryRepo();
      const id = await seedSubmitted(repo);
      const refund = new FakeRefundGateway();
      const out = await new TrackRemittance(
        gatewayDelLedger(payout),
        repo,
        new FixedClock(),
        refund,
      ).execute({ remittanceId: id });
      expect(out.status, `payout=${JSON.stringify(payout)}`).toBe("payout_submitted");
      expect(refund.calls, "un 'no sé' no puede disparar un credit-back").toHaveLength(0);
      vi.unstubAllGlobals();
    }
  });
});

// ── 🔴 CR · DEFENSA EN PROFUNDIDAD: el record tiene que hablar del payout que se pidió ───────────────
//
// POR QUÉ EXISTE ESTA LÍNEA, Y POR QUÉ NACE CON TEST. `TrackRemittance` confiaba en que
// `payouts.status(s.payoutId)` devolviera un record DE ESE payout, y WKH-337/AR-BLQ-ALTO-1 fue
// exactamente su violación: un caché sin clave en el gateway devolvía el desenlace de OTRA remesa, y
// como `settled` no está en `RECOVERABLE` el remitente perdía su único camino a sus USDC.
//
// Ese bug se arregló EN EL GATEWAY (la clave del memo es un tipo brandeado). Esta guarda es la segunda
// línea: hace que NINGÚN gateway futuro pueda producir el mismo daño desde acá. Sin este test la guarda
// nacería mutation-dead — el blast radius medido por el CR es 0 tests, porque todos los dobles echoean
// el `payoutId` que se les pide, así que nada la ejercita por accidente.
describe("TrackRemittance — un record de OTRO payout no toca la remesa (CR)", () => {
  /** Doble que MIENTE sobre de qué payout habla: devuelve un terminal con un `payoutId` ajeno. */
  const gatewayMentiroso = (rec: Partial<PayoutRecord>): PayoutGateway => ({
    submit: async () => {
      throw new Error("no se usa");
    },
    status: async () => ({
      payoutId: "payout-de-OTRA-remesa",
      status: "settled",
      deliveredPen: null,
      txRef: null,
      failureReason: null,
      provenance: "transfi",
      ...rec,
    }),
  });

  it("un `settled` cuyo payoutId NO es el de la remesa la deja en `payout_submitted`", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new FakeRefundGateway();
    const out = await new TrackRemittance(
      gatewayMentiroso({}),
      repo,
      new FixedClock(),
      refund,
    ).execute({ remittanceId: id });

    expect(
      out.status,
      "la remesa se liquidó con el desenlace de OTRO payout: `settled` es irreversible (no está en " +
        "RECOVERABLE), así que esto le quita al remitente su único camino a sus USDC",
    ).toBe("payout_submitted");
    expect(out.snapshot.payoutProvenance).toBeNull(); // no se pisó nada
    expect(refund.calls).toHaveLength(0);
  });

  it("y un `failed` ajeno tampoco dispara el credit-back", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new FakeRefundGateway();
    const out = await new TrackRemittance(
      gatewayMentiroso({ status: "failed", failureReason: "payout_failed_provider" }),
      repo,
      new FixedClock(),
      refund,
    ).execute({ remittanceId: id });
    expect(out.status).toBe("payout_submitted");
    expect(refund.calls, "un desenlace ajeno no puede mover plata de esta remesa").toHaveLength(0);
  });

  it("el control positivo: con el payoutId CORRECTO la guarda no estorba", async () => {
    // Sin esto, borrar la guarda y además romper el camino feliz daría verde en los dos `it` de arriba.
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const out = await new TrackRemittance(
      gatewayMentiroso({ payoutId: "p-1" }), // el que `seedSubmitted` usa
      repo,
      new FixedClock(),
      new FakeRefundGateway(),
    ).execute({ remittanceId: id });
    expect(out.status).toBe("settled");
  });
});
