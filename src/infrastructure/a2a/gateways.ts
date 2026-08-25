// Infrastructure: adapters A2A (WKH-186). Piden CAPACIDADES a través de las API routes server-only de
// esta app (/api/a2a/*), espejando DiditKycGateway→/api/kyc/* y
// HttpPayoutAuthorityGateway→/api/payout/validate. Este adapter corre en el BROWSER y no conoce
// ninguna URL de agente ni de gateway: sólo llama a su propia route, que resuelve la capacidad
// server-side (CD-9). Se cablean con el flag NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER en `"a2a-gateway"`; el
// default sigue siendo Fallback (mock), y cualquier otro valor TIRA en el arranque del container.
// CD-5: errores estables y PII-free (nunca interpolan beneficiary).
//
// Hoy la ÚNICA ruta viva de este par es /api/a2a/quote. La del payout (/api/a2a/payout/submit) la
// borró WKH-320; ver el comentario de A2aPayoutGateway.submit, que es lo único que quedó de ese lado.
// El payout del camino Solana lo arma el server en /api/payout/prepare, no este adapter.
import {
  QUOTE_NO_AGENT_FOR_CAPABILITY,
  QUOTE_REJECTED,
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
  // ✅ WKH-335 — ESTE `if` YA LEE UN ENUM CON PRODUCTOR VIVO. Hasta acá decía lo contrario (AR/MNR-1),
  // y era cierto: entre WKH-332/W3 y WKH-335 nadie lo emitía. Ahora lo emite
  // `app/api/a2a/quote/route.ts` cuando el gateway manda `code: "step_failed"` +
  // `agentFailure: "INPUT_REJECTED"`. Es la MISMA declaración que lleva el docblock de su constante
  // (`QUOTE_REJECTED`, `../../application/agent-rejections.ts:52`), escrita también acá, un nivel
  // arriba, porque acá es donde se lee.
  //
  // MEDIDO (2026-08-25, `grep -n 'NextResponse.json({ error' app/api/a2a/quote/route.ts`): el universo
  // de `error` que esa route puede devolver desde el corte del gateway pasó de CUATRO a CINCO, y
  // `a2a_quote_rejected` ahora SÍ está entre ellos —
  // (`a2a_not_configured`, `../../../app/api/a2a/quote/route.ts:168`),
  // (`QUOTE_REJECTED`, `../../../app/api/a2a/quote/route.ts:174`),
  // (`QUOTE_NO_AGENT_FOR_CAPABILITY`, `../../../app/api/a2a/quote/route.ts:182`),
  // (`a2a_unavailable`, `../../../app/api/a2a/quote/route.ts:183`) y
  // (`a2a_bad_shape`, `../../../app/api/a2a/quote/route.ts:186`).
  // (Los dos del limitador de tasa están antes del corte del gateway y esta función no los ve.)
  //
  // ⚠️ ESTOS CINCO NÚMEROS VAN EN FORMATO ANCLADO A PROPÓSITO, y no es cosmético. Los CUATRO de la
  // versión anterior estaban escritos sueltos (`:116`, `:124`, `:125`, `:128`) y APUNTABAN A PROSA:
  // los returns reales vivían en `:161/:169/:170/:173`. Se pudrieron solos y no los cazó nadie
  // porque `src/composition/citas-ancladas.test.ts` —que SÍ existe y SÍ corre en `npm test`— sólo
  // verifica el formato `(`símbolo`, `ruta:NN`)`; una cita suelta es su agujero declarado #1.
  // Anclarlas las pone bajo ese candado. Se re-midieron con el `grep` de arriba, no se recalcularon
  // con una resta.
  // ⛔ Y SIGUE SIN SER CÓDIGO MUERTO por los otros motivos, que es la razón por la que W4 borró la
  // allow-list y NO borró esto: el body puede traer este enum desde un server driftado, desde una
  // versión anterior de la route durante un deploy o desde un intermediario, y desde el
  // `failureReason` de una remesa guardada antes del deploy de W3. ESO es lo que miden los 4 casos de
  // (`rejects`, `gateways.test.ts:128`) y (`rejects`, `gateways.test.ts:140`): que si el enum llega, se
  // colapse sin propagar `reason` — y eso NO cambió, porque lo que WKH-335 agrega es una CLASE, no el
  // `reason` del agente.
  if (body.error !== QUOTE_REJECTED) return undefined;
  // 🔴 ACÁ SE LEÍA `body.reason` FILTRADO POR `RELAYABLE_QUOTE_REJECTIONS`, Y ESE FILTRO SE FUE EN
  // WKH-332/W4 CON EL CANAL QUE LO ALIMENTABA (AC-5). El `reason` sólo existía en la respuesta del
  // carril punto a punto, que leía el body de error del agente invocado por su slug: la route ya no lo
  // emite y `/compose` no lo trae. Un filtro sobre un campo que nunca viene no filtra, aparenta. Lo
  // que queda es el enum de FAMILIA, que es una palabra nuestra.
  // Input que lo pone en rojo si alguien vuelve a relayar el vocabulario del agente: el candado
  // "AC-5: `fx_*` … cae en el default" de `src/presentation/flow-vm.test.ts`.
  return QUOTE_REJECTED;
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
   * Por qué NO se borró, que no es lo mismo que estar viva (CR/BLQ-MED-1): acá decía que `status()` "SÍ
   * se usa en producción" y que "el container la cablea", y WKH-337 volvió falsas las DOS mitades. MEDIDO:
   * cero apariciones de `A2aPayoutGateway` en `container.ts`, y `useA2a` tiene UN solo consumidor, las
   * quotes (`quotes`, `../../composition/container.ts:123`). Hoy cablea (`payouts`, `../../composition/container.ts:127`). Se conserva por R-2.
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
    // sobre un payout que no sabemos que falló.
    //
    // 🔴 WKH-337 (AC-6) — LA LECTURA QUE FALTABA YA EXISTE, Y ESTE RAZONAMIENTO NO SE REVIRTIÓ. Acá
    // decía que el fix real quedaba para una fase posterior; ya no está pendiente. Pero el fix NO fue
    // re-apuntar una bandera: este método y el de `FallbackPayoutGateway` eran los DOS ciegos, así que
    // ninguna configuración discriminaba nada observable. Lo que se construyó es
    // `LedgerPayoutStatusGateway`, que le pregunta al ledger —donde el webhook del proveedor YA escribía
    // el desenlace y no lo leía nadie—, y es el que el container cablea
    // (`payouts`, `../../composition/container.ts:127`). Esta clase quedó SIN consumidor de producción y
    // NO se borra (R-2): comparte archivo con `A2aQuoteGateway`, que sí se cablea
    // (`quotes`, `../../composition/container.ts:123`).
    //
    // ⚠️ Y EL PRINCIPIO DE ARRIBA PROTEGE MÁS QUE ANTES, no menos. Mientras nada llegaba a `settled` por
    // polling, un terminal de más era cosmético. Hoy `settled` es alcanzable y es IRREVERSIBLE —no está
    // en `RECOVERABLE` (`RECOVERABLE`, `../../application/use-cases/recover-escrow-funds.ts:40`) y no
    // tiene transición de salida—, así que fabricar uno le quita al remitente su único camino a sus
    // USDC. El gateway nuevo hereda esta regla entera: toda degradación cae al NO-TERMINAL.
    return {
      payoutId,
      status: "submitted",
      deliveredPen: null,
      txRef: null,
      failureReason: "payout_status_unknown",
      // 🔴 WKH-337/DT-6 — ESTE `""` DEPENDE DE UNA PREMISA QUE HOY ES FALSA, y queda escrito acá porque
      // el récord sigue siendo inalcanzable por OTRA razón (esta clase ya no se cablea, R-2). El
      // "nunca settlea" era cierto mientras ningún gateway leyera el desenlace; ya no lo es. Y `""` NO es
      // cosmético: `markSettled` PISA `payoutProvenance` con cualquier valor ≠ `undefined`
      // (`markSettled`, `../../domain/remittance.ts:375`) e `isPayoutDemo("")` es `true` (`"" != null` ✓
      // y `!has("")` ✓), así que un `""` que llegara al agregado prendería "Modo demo" sobre una remesa
      // REAL recién liquidada. ⛔ Si alguien vuelve a cablear esta clase, esto es lo PRIMERO que hay que
      // cambiar: el gateway del ledger usa `"n/a"` en sus ramas no-terminales por este mismo motivo.
      provenance: "",
    };
  }
}
