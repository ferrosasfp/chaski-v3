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
import {
  QUOTE_NO_AGENT_FOR_CAPABILITY,
  QUOTE_REJECTED,
  RELAYABLE_QUOTE_REJECTIONS,
} from "../../application/agent-rejections";
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

/**
 * ¿El 4xx que devolvió la route es un RECHAZO del agente, y con qué detalle?
 *
 * Devuelve el código a tirar, o `undefined` si esto no fue un rechazo (⇒ el caller sigue con
 * `a2a_quote_unavailable`, que es lo que decía antes para TODO no-2xx). El enum de la route es
 * nuestro y su body es `{ error, reason? }`: se lee `reason` si vino, y si no el `error` de
 * familia. Nada de texto libre — los dos campos ya salieron filtrados por una allow-list del lado
 * del server (`agent-rejections.ts`).
 */
async function readQuoteRejection(res: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return undefined; // body ilegible ⇒ no podemos afirmar que fue un rechazo
  }
  if (!isRecord(body)) return undefined;
  // WKH-332/AC-13 — "no hay quién" NO es un rechazo (nadie leyó el pedido), pero SÍ tiene que llegar
  // al caller con su propio nombre. Sin este renglón el 422 de la route caía en el `undefined` de
  // abajo, el caller tiraba `a2a_quote_unavailable` y la pantalla volvía a decir "el otro lado se
  // cayó, probá de nuevo" — o sea que el enum nuevo existiría en la route y no lo vería nadie. Se
  // propaga 1:1 y sin `reason`: es un enum NUESTRO, no un eco del gateway.
  if (body.error === QUOTE_NO_AGENT_FOR_CAPABILITY) return QUOTE_NO_AGENT_FOR_CAPABILITY;
  if (body.error !== QUOTE_REJECTED) return undefined;
  return typeof body.reason === "string" && RELAYABLE_QUOTE_REJECTIONS.includes(body.reason)
    ? body.reason
    : QUOTE_REJECTED;
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
    // Un rechazo del agente y una caída del agente ya no comparten error. Acá TODO no-2xx era
    // `a2a_quote_unavailable`, que `humanError()` no reconocía y terminaba en "Algo salió mal.
    // Intentá de nuevo" — un consejo activamente equivocado para un monto fuera de rango, porque
    // intentar de nuevo con el mismo monto vuelve a fallar. El código que se tira es el enum que ya
    // filtró el server; este adapter no interpreta ni traduce nada (AC-5, PII-free).
    if (!res.ok) {
      throw new Error((await readQuoteRejection(res)) ?? "a2a_quote_unavailable");
    }
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
   * puerto `PayoutGateway`, `track-remittance.ts:8`) y el container la cablea (`NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`, `container.ts:114`). Lo
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
