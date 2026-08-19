// Infrastructure — adapters FALLBACK (corren sin backend/keys: la DApp funciona end-to-end en demo).
// Mismo principio que el provider-pattern del backend. NO mueven plata real (payout mock).
// El REAL de la cotización vive en ./a2a; el del ESTADO del payout, en ./settlement (WKH-337) y ya cableado.

import { Money } from "../../domain/money";
import {
  type KycVerification,
  type Quote,
  toPersistedIdentity,
} from "../../domain/remittance";
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
  /**
   * 🔴 `realVerified: false` NO ES UNA OPINIÓN DE ESTA CLASE, ES SU DEFINICIÓN (WKH-233/D-3). Una
   * simulación no verificó a nadie, así que no puede declarar una verificación real — y por eso
   * `verifiedAt` es `null`: no hay ningún momento observado que declarar, y ⛔ inventar uno sería
   * fabricar evidencia. `approved`/`payoutAllowed` SÍ siguen en `true`, y no es contradictorio: eso
   * es lo que hace que el DEMO llegue a `kyc_passed` y la persona pueda recorrer la app. Lo que NO
   * hace es abrir un desembolso, porque eso lo decide `realVerified` vía el agente.
   */
  private simulated(amountUsd: number): KycVerification {
    return {
      verificationId: `kyc-demo-${Date.now().toString(36)}`, // WKH-233: el prefijo dejó de nombrar al proveedor. Es 1 hit de CÓDIGO y cuenta para el criterio de cierre
      approved: true,
      payoutAllowed: true, realVerified: false, verifiedAt: null,
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
  // MOCK — no desembolsa. `submit` deja el payout "en camino"; `status` NO lo settlea.
  //
  // Acá vivía `status: "settled"` devuelto sin consultar absolutamente nada. Con el flag de
  // settlement Solana encendido y el adapter de value-delivery apagado (la combinación que el repo
  // documenta como default), ese `settled` era lo que el primer tick del poll leía sobre una remesa con
  // los USDC todavía en el vault del escrow: la app decía "Entregado", saltaba al recibo verde y, de
  // paso, desmontaba la pantalla donde vive "Recuperar fondos". Fabricaba un hecho sobre plata ajena.
  //
  // Este adapter no tiene backend al que preguntarle: lo que sabe del payout es NADA. El estado que
  // refleja "nada" es el no-terminal, con la razón explícita — mismo criterio que
  // A2aPayoutGateway.status() (a2a/gateways.ts:181-200): no saber NO es evidencia de entrega, ni de
  // fallo. TrackRemittance no transiciona con "submitted" ⇒ la remesa queda donde está, visible y
  // recuperable, en vez de mentir en cualquiera de las dos direcciones. WKH-337 (AC-6) CONSTRUYÓ la lectura que faltaba —`LedgerPayoutStatusGateway` le pregunta al ledger, que es donde el webhook del proveedor YA escribe el desenlace— y es la que el container cablea hoy (`payouts`, `../../composition/container.ts:127`); esta clase quedó SIN consumidor de producción y no se borra (R-2). Lo que esa capacidad NO revierte es el razonamiento de arriba: sigue sin fabricar un terminal sobre incertidumbre, y ahora eso protege más que antes, porque `settled` pasó a ser alcanzable y es IRREVERSIBLE.
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
      status: "submitted", // NO-terminal: es lo que sabe este adapter, que es nada
      deliveredPen: null,
      txRef: null,
      failureReason: "payout_status_unknown", // marca explícita, no un null que se lea como "todo bien"
      provenance: "local-fallback", // WKH-200: mock → dispara el banner de modo demo
    };
  }
}
