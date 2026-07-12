// Infrastructure — adapters A2A (WKH-186). Llaman a los agentes remit-* (remit-corridor-fx /
// remit-cashout-payout) a través de las API routes server-only de chaski-v2 (/api/a2a/*), espejando
// DiditKycGateway→/api/kyc/* y HttpPayoutAuthorityGateway→/api/payout/validate. El gateway NUNCA
// fetchea el agente directo (el REMIT_AGENTS_BASE_URL vive SOLO en el server, CD-9). Se cablean con
// el flag NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER="a2a"; el default sigue siendo Fallback (mock).
// CD-5: errores estables y PII-free (nunca interpolan beneficiary). CD-10: idempotencyKey intacto.
import { Money } from "../../domain/money";
import type { Quote } from "../../domain/remittance";
import type {
  PayoutGateway,
  PayoutRecord,
  PayoutSubmit,
  QuoteGateway,
  QuoteRequest,
} from "../../application/ports";

// ── Shapes crudos de los agentes (§5, SOLO lectura del contrato) ─────────────
interface RawQuoteResult {
  quoteId: string;
  rate: number;
  feeUsd: number;
  netDeliveredLocal: number;
  etaMinutes: number;
  expiresAt: string;
  provenance: string;
}
type RawPayoutStatus = "submitted" | "settled" | "failed" | "blocked";
interface RawPayoutResult {
  status: RawPayoutStatus;
  payoutId: string | null;
  deliveredLocal: number | null;
  txRef: string | null;
  reason: string | null;
  provenance: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Type-guards explícitos (CD-15: sin any). Validan el shape antes de mapear a dominio (AC-5).
function isValidQuoteShape(v: unknown): v is RawQuoteResult {
  if (!isRecord(v)) return false;
  return (
    typeof v.quoteId === "string" &&
    typeof v.rate === "number" &&
    typeof v.feeUsd === "number" &&
    typeof v.netDeliveredLocal === "number" &&
    typeof v.etaMinutes === "number" &&
    typeof v.expiresAt === "string" &&
    typeof v.provenance === "string"
  );
}

function isValidPayoutShape(v: unknown): v is RawPayoutResult {
  if (!isRecord(v)) return false;
  const statusOk =
    v.status === "submitted" || v.status === "settled" || v.status === "failed" || v.status === "blocked";
  if (!statusOk) return false;
  if (!(typeof v.payoutId === "string" || v.payoutId === null)) return false;
  if (!(typeof v.deliveredLocal === "number" || v.deliveredLocal === null)) return false;
  if (!(typeof v.txRef === "string" || v.txRef === null)) return false;
  if (!(typeof v.reason === "string" || v.reason === null)) return false;
  // payoutId null SOLO es válido cuando el payout no se ejecutó (failed/blocked). Si settled/submitted
  // sin payoutId → shape inválido (AC-5): no podríamos trackear el payout.
  if (v.payoutId === null && v.status !== "failed" && v.status !== "blocked") return false;
  return true;
}

function mapResultToQuote(result: RawQuoteResult, req: QuoteRequest): Quote {
  return {
    quoteId: result.quoteId,
    send: Money.of(req.amountUsd, "USDC"), // del REQUEST (no del agente)
    receive: Money.of(result.netDeliveredLocal, "PEN"),
    feeUsd: Money.of(result.feeUsd, "USDC"),
    rate: result.rate,
    etaMinutes: result.etaMinutes,
    expiresAt: result.expiresAt,
    provenance: result.provenance,
  };
}

function mapResultToPayoutRecord(result: RawPayoutResult): PayoutRecord {
  return {
    payoutId: result.payoutId ?? "", // null solo en failed/blocked (validado en el guard)
    status: result.status === "blocked" ? "failed" : result.status, // DT-13: blocked→failed
    deliveredPen: result.deliveredLocal != null ? Money.of(result.deliveredLocal, "PEN") : null,
    txRef: result.txRef,
    failureReason: result.reason,
  };
}

export class A2aQuoteGateway implements QuoteGateway {
  async requestQuote(req: QuoteRequest): Promise<Quote> {
    const res = await fetch("/api/a2a/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amountUsd: req.amountUsd,
        destCountry: req.destCountry,
        payoutMethod: req.method,
      }),
    });
    if (!res.ok) throw new Error("a2a_quote_unavailable"); // AC-5, PII-free
    const { result } = (await res.json()) as { result: unknown };
    if (!isValidQuoteShape(result)) throw new Error("a2a_quote_bad_shape");
    return mapResultToQuote(result, req);
  }
}

export class A2aPayoutGateway implements PayoutGateway {
  // DT-12/AC-14: remit-cashout-payout resuelve TODO en el submit (no hay /status async). status()
  // devuelve el PayoutRecord cacheado del último submit(); id desconocido → failed opaco.
  private last = new Map<string, PayoutRecord>();

  async submit(req: PayoutSubmit): Promise<PayoutRecord> {
    const res = await fetch("/api/a2a/payout/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteId: req.quoteId,
        amountUsd: req.amountUsd,
        kycVerificationId: req.kycVerificationId,
        kycPayoutAllowed: true, // DT-5: sintetizado (la autoridad WKH-180 ya se validó en ConfirmAndSend)
        beneficiary: req.beneficiary, // viaja al server; NUNCA se loguea (CD-5)
        idempotencyKey: req.idempotencyKey, // INTACTO (CD-10)
      }),
    });
    if (!res.ok) throw new Error("a2a_payout_unavailable"); // AC-5, PII-free
    const { result } = (await res.json()) as { result: unknown };
    if (!isValidPayoutShape(result)) throw new Error("a2a_payout_bad_shape");
    const rec = mapResultToPayoutRecord(result);
    this.last.set(rec.payoutId, rec);
    return rec;
  }

  async status(payoutId: string): Promise<PayoutRecord> {
    return (
      this.last.get(payoutId) ?? {
        payoutId,
        status: "failed",
        deliveredPen: null,
        txRef: null,
        failureReason: "payout_status_unknown",
      }
    );
  }
}
