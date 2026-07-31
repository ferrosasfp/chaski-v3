// Infrastructure: adapters A2A (WKH-186). Llaman a los agentes remit-* a través de las API routes
// server-only de esta app (/api/a2a/*), espejando DiditKycGateway→/api/kyc/* y
// HttpPayoutAuthorityGateway→/api/payout/validate. El gateway NUNCA fetchea el agente directo (el
// REMIT_AGENTS_BASE_URL vive SOLO en el server, CD-9). Se cablean con el flag
// NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER="a2a"; el default sigue siendo Fallback (mock).
// CD-5: errores estables y PII-free (nunca interpolan beneficiary).
//
// Hoy la ÚNICA ruta viva de este par es /api/a2a/quote. La del payout (/api/a2a/payout/submit) la
// borró WKH-320; ver el comentario de A2aPayoutGateway.submit, que es lo único que quedó de ese lado.
// El payout del camino Solana lo arma el server en /api/payout/prepare, no este adapter.
import { Money } from "../../domain/money";
import { isParseableIso } from "../../domain/remittance";
import type { AgentRef, Quote } from "../../domain/remittance";
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
    isParseableIso(v.expiresAt) && // WKH-198 AC-4: rechaza fecha no-parseable
    typeof v.provenance === "string"
  );
}

/** Lee el `agent` que la route agrega al 200. Sin `slug` string no-vacío ⇒ `undefined`: la remesa
 *  queda diciendo "no sé quién cotizó" en vez de afirmar un agente sin nombre. NUNCA rompe el
 *  quote: quién lo emitió no cambia si la cotización es válida (eso lo dice isValidQuoteShape). */
function readAgentRef(raw: unknown): AgentRef | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.slug !== "string" || !raw.slug) return undefined;
  return {
    slug: raw.slug,
    // Ausente ⟹ ausente. Un "" de relleno afirmaría un catálogo vacío (ver AgentRef en el dominio).
    ...(typeof raw.registry === "string" && raw.registry ? { registry: raw.registry } : {}),
    ...(typeof raw.capability === "string" ? { capability: raw.capability } : {}),
    ...(typeof raw.trial === "boolean" ? { trial: raw.trial } : {}),
  };
}

function mapResultToQuote(result: RawQuoteResult, req: QuoteRequest, agent?: AgentRef): Quote {
  return {
    quoteId: result.quoteId,
    send: Money.of(req.amountUsd, "USDC"), // del REQUEST (no del agente)
    receive: Money.of(result.netDeliveredLocal, "PEN"),
    feeUsd: Money.of(result.feeUsd, "USDC"),
    rate: result.rate,
    etaMinutes: result.etaMinutes,
    expiresAt: result.expiresAt,
    provenance: result.provenance,
    // Viaja DENTRO del quote y no en un campo suelto: el quote es lo que se persiste con la remesa,
    // así que la identidad del que cotizó sobrevive a una recarga por el mismo camino que la tasa.
    ...(agent ? { agent } : {}),
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
    const { result, agent } = (await res.json()) as { result: unknown; agent?: unknown };
    if (!isValidQuoteShape(result)) throw new Error("a2a_quote_bad_shape");
    return mapResultToQuote(result, req, readAgentRef(agent));
  }
}

export class A2aPayoutGateway implements PayoutGateway {
  /**
   * ⛔ NO HAY RUTA DEL OTRO LADO. Este método posteaba a `/api/a2a/payout/submit`, borrada por
   * WKH-320 (la ausencia del directorio está asertada en `src/composition/no-evm-surface.test.ts:124`).
   *
   * Por qué tira ACÁ y no después del fetch: el `if (!res.ok) throw new Error("a2a_payout_unavailable")`
   * que había antes reportaba un 404 permanente y estructural (la ruta NO EXISTE) con el mismo error
   * que un 502 transitorio del agente. Eso manda a buscar el problema a la red y al deploy del agente,
   * cuando lo que falta es una ruta que nadie va a levantar. El nombre del error es el diagnóstico.
   *
   * Por qué la clase sigue viva: `status()` SÍ se usa en producción (`TrackRemittance` lo llama vía el
   * puerto `PayoutGateway`, `track-remittance.ts:38`) y el container la cablea (`container.ts:96`). Lo
   * muerto es este método, no el adapter. Y hoy NADIE lo invoca: el único consumidor del puerto es
   * `TrackRemittance`, que sólo llama a `status()`.
   *
   * Si algún día vuelve a hacer falta un submit desde el cliente, hay que construir la ruta primero.
   * Este throw es lo que impide que se "arregle" apuntándolo a cualquier otro lado.
   */
  async submit(_req: PayoutSubmit): Promise<PayoutRecord> {
    throw new Error("a2a_payout_submit_route_removed"); // PII-free, como el resto de los errores (CD-5)
  }

  async status(payoutId: string): Promise<PayoutRecord> {
    // Acá vivía un Map con el último PayoutRecord del `submit`. Sin submit no hay nada que cachear:
    // sería un caché que no se puede llenar. Lo que queda es lo que ya devolvía en el cache-miss, que
    // era el caso real en producción (recarga → container nuevo → Map vacío).
    //
    // MNR-B (money-path): no saber el estado de un payout NO es evidencia de que FALLÓ. Fabricar
    // "failed" acá false-refundearía un payout que pudo ser exitoso. Devolvemos un estado NO-TERMINAL
    // ("submitted", flag payout_status_unknown) ⇒ TrackRemittance NO transiciona a payout_failed ni
    // refundea sobre incertidumbre; la remesa queda RECUPERABLE. Principio: NUNCA refundear/fallar
    // sobre un payout que no sabemos que falló. El fix real (polling async / persistir el estado del
    // submit) es Fase A (AC-14).
    return {
      payoutId,
      status: "submitted",
      deliveredPen: null,
      txRef: null,
      failureReason: "payout_status_unknown",
      provenance: "", // WKH-200: record fabricado (nunca settlea) → cosmético, no marca demo/real
    };
  }
}
