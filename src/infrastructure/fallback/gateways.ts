// Infrastructure — adapters FALLBACK (corren sin backend/keys: la DApp funciona end-to-end en demo).
// Mismo principio que el provider-pattern del backend. NO mueven plata real (payout mock).
// Los adapters REALES (que llaman a los agentes remit-* vía las API routes) van en ./a2a (post-sandbox).

import { Money } from "../../domain/money";
import { type KycVerification, type Quote, toPersistedIdentity } from "../../domain/remittance";
import type {
  KycDecision,
  KycGateway,
  KycRequest,
  KycStartResult,
  PayoutGateway,
  PayoutRecord,
  PayoutSubmit,
  QuoteGateway,
  QuoteRequest,
} from "../../application/ports";

const SPREAD_BPS = 250; // 2.5% declarado, en contra del cliente
const FLAT_FEE_USD = 0.5;
const STATIC_USD_PEN = 3.75;
const QUOTE_TTL_MS = 10 * 60_000;

let midCache: { rate: number; at: number } | null = null;
async function usdToPen(): Promise<number> {
  if (midCache && Date.now() - midCache.at < 5 * 60_000) return midCache.rate;
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const d = (await res.json()) as { rates?: { PEN?: number } };
      const pen = Number(d?.rates?.PEN);
      if (pen > 0) {
        midCache = { rate: pen, at: Date.now() };
        return pen;
      }
    }
  } catch {
    // cae al estático
  }
  return STATIC_USD_PEN;
}

export class FallbackQuoteGateway implements QuoteGateway {
  async requestQuote(req: QuoteRequest): Promise<Quote> {
    const mid = await usdToPen();
    const rate = mid * (1 - SPREAD_BPS / 10000);
    const netUsd = Math.max(0, req.amountUsd - FLAT_FEE_USD);
    return {
      quoteId: `fb-${Date.now().toString(36)}`,
      send: Money.of(req.amountUsd, "USDC"),
      receive: Money.of(netUsd * rate, "PEN"), // único redondeo = Money.of (dominio); sin doble round (V4)
      feeUsd: Money.of(FLAT_FEE_USD, "USDC"),
      rate: Number(rate.toFixed(6)),
      etaMinutes: 30,
      expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
      provenance: "local-fallback",
    };
  }
}

export class FallbackKycGateway implements KycGateway {
  // Simula el resultado de una sesión Didit: la identidad se EXTRAE del documento escaneado
  // (no la tipea el usuario). start() resuelve directo (sin redirect); decision() por si se consulta.
  // SIEMPRE aprueba (approved:true, payoutAllowed:true); NUNCA representa un rechazo.
  // En prod su alcance está contenido por el gate server-side de WKH-180
  // (/api/payout/validate: sin DIDIT_API_KEY + prod → 503 fail-loud, nunca autoriza por default).
  async start(req: KycRequest): Promise<KycStartResult> {
    return { kind: "completed", verification: this.simulated(req.amountUsd) };
  }
  async decision(_sessionId: string): Promise<KycDecision> {
    return { terminal: true, verification: this.simulated(0) };
  }
  private simulated(amountUsd: number): KycVerification {
    return {
      verificationId: `didit-demo-${Date.now().toString(36)}`,
      approved: true,
      payoutAllowed: true,
      riskLevel: amountUsd >= 1000 ? "medium" : "low",
      provenance: "local-fallback",
      identity: toPersistedIdentity({
        firstName: "María Elena",
        lastNamePaternal: "Quispe",
        lastNameMaternal: "Mamani",
        documentType: "DNI",
        documentNumber: "44556677",
        dateOfBirth: "1990-05-14",
        nationality: "PE",
      }),
    };
  }
}

export class FallbackPayoutGateway implements PayoutGateway {
  // MOCK — no desembolsa. `submit` deja el payout "en camino"; `status` lo settlea (para
  // que la UI muestre la progresión submitted → settled). deliveredPen null (la UI usa el quote).
  async submit(req: PayoutSubmit): Promise<PayoutRecord> {
    return {
      payoutId: `fb-${req.idempotencyKey}`,
      status: "submitted",
      deliveredPen: null,
      txRef: null,
      failureReason: null,
      provenance: "local-fallback", // WKH-200: mock → dispara el banner de modo demo
    };
  }
  async status(payoutId: string): Promise<PayoutRecord> {
    return {
      payoutId,
      status: "settled",
      deliveredPen: null,
      txRef: null,
      failureReason: null,
      provenance: "local-fallback", // WKH-200: mock → dispara el banner de modo demo
    };
  }
}
