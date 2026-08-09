// Infrastructure — `PayoutGateway` que LEE el desenlace del payout del ledger (WKH-337/AC-1).
//
// 🔴 QUÉ CAPACIDAD AGREGA, Y POR QUÉ NO ERA UN PROBLEMA DE CABLEADO. `TrackRemittance` le pregunta el
// estado a un `PayoutGateway`, y las DOS implementaciones que existían son CIEGAS: no tienen un solo
// `fetch`, no usan el `payoutId`, y devuelven siempre la misma constante `status:"submitted"`. Las dos
// lo DECLARAN en su propio comentario. O sea que no había ningún gateway "correcto" al que apuntar la
// bandera: re-cablearla era un no-op medido. Lo que faltaba era la lectura, y es esta clase.
//
// 🔴 LO QUE SE PRESERVA ÍNTEGRO ES EL RAZONAMIENTO DE ESOS DOS COMENTARIOS, porque sigue siendo la
// garantía del producto y no una limitación superada: **no saber el estado de un payout NO es evidencia
// de nada**, ni de entrega ni de fallo. `status()` NUNCA lanza y NUNCA devuelve un terminal fabricado.
// El mecanismo de daño, medido: `settled` no está en `RECOVERABLE`
// (`RECOVERABLE`, `../../application/use-cases/recover-escrow-funds.ts:40`) y no tiene transición de
// salida ⇒ un `settled` de más le quita al remitente su ÚNICO camino a sus USDC, PARA SIEMPRE. Cada vez
// que dudes de una rama de error acá, la respuesta es la misma: NO-TERMINAL.
//
// ⛔ EL LECTOR DE PRUEBAS NO TIENE `prove`, Y ESO ES DELIBERADO. Esta clase corre dentro de un
// `setInterval` de 1500 ms (`}, 1500);`, `../../presentation/flow.tsx:525`). Si pudiera pedir una firma,
// pediría un popup de billetera cada 1,5 s — 400 por sesión de 10 min. Que no pueda no depende de que
// nadie la llame: depende de que el método NO EXISTA en `PopProofReader`
// (`PopProofReader`, `../../application/ports.ts:150`), así que `tsc` lo impide. Es el patrón estructural
// de WKH-338 (el invariante como forma del tipo). ⛔ PROHIBIDO pasarle un `PopSigner` "para
// simplificar": reintroduce el defecto entero, y no compila.
import type {
  Clock,
  PayoutGateway,
  PayoutOutcomeLookup,
  PayoutRecord,
  PayoutSubmit,
  PopProofReader,
  WalletPort,
} from "../../application/ports";

/**
 * Cada cuánto se le pregunta al ledger, como MÍNIMO. **20 000 ms**, y el número está derivado:
 *
 *   el evento subyacente es el webhook `fund_settled` de TransFi, que llega en MINUTOS.
 *   Leer más rápido no adelanta nada: 600 s ÷ 20 s = 30 lecturas por sesión de 10 min.
 *
 * Ese 30 es el que sostiene el presupuesto del bucket de la ruta: 30 × 2 senders detrás de una misma
 * IP/NAT = 60, que es el default de `PAYOUT_STATUS_RL` (`PAYOUT_STATUS_RL`, `../rate-limit.ts:262`).
 * ⛔ Bajar este número sin subir ese bucket pone a un usuario legítimo contra el límite: los dos
 * números son el mismo cálculo visto de los dos lados.
 *
 * Sin este throttle, el poll de 1,5 s produciría 400 requests por sesión: 40× el presupuesto.
 */
const LEDGER_STATUS_MIN_INTERVAL_MS = 20_000;

/** El no-terminal, en un solo lugar. Es el valor de "no sé", y el `failureReason` dice POR QUÉ no sé —
 *  que no es lo mismo que un motivo de fallo: `TrackRemittance` sólo ramifica sobre `status`, y con
 *  `"submitted"` no transiciona (`this.payouts`, `../../application/use-cases/track-remittance.ts:47`).
 *  ⛔ Ninguna rama de error puede devolver otra cosa que esto. */
function noSe(payoutId: string, porQue: string): PayoutRecord {
  return {
    payoutId,
    status: "submitted",
    deliveredPen: null,
    txRef: null,
    failureReason: porQue,
    // 🔴 NUNCA `""` acá. `markSettled` PISA `payoutProvenance` con cualquier valor distinto de
    // `undefined` (`markSettled`, `../../domain/remittance.ts:375`) e `isPayoutDemo("")` es `true`
    // (`isPayoutDemo`, `../../presentation/flow-vm.ts:29`), así que un `""` que llegara al agregado
    // prendería el banner "Modo demo". En la rama no-terminal `provenance` hoy no lo lee nadie —
    // `TrackRemittance` no entra a ninguna rama con `"submitted"`— pero el motivo va escrito acá porque
    // es justo la clase de premisa que caduca, y fue la trampa más cara de esta HU (DT-6).
    provenance: "n/a",
  };
}

export class LedgerPayoutStatusGateway implements PayoutGateway {
  /** Último desenlace leído + cuándo, para el throttle. `null` = todavía no se leyó nada. */
  private ultima: { readonly rec: PayoutRecord; readonly atMs: number } | null = null;

  constructor(
    private readonly wallet: Pick<WalletPort, "getAddress">,
    private readonly proofs: PopProofReader, // ← SIN `prove`. No es un olvido, es el mecanismo.
    private readonly clock: Clock,
  ) {}

  /**
   * ⛔ No hay ruta que reciba un submit desde el cliente, y no se va a "arreglar" apuntando esto a
   * cualquier otro lado. `app/api/a2a/payout/submit` se BORRÓ en WKH-320 y su ausencia está asertada
   * (`no-evm-surface.test.ts:124`). El puerto conserva `submit()` porque `status()` —la costura donde
   * esta HU se enchufa— vive en el mismo puerto; el método no tiene ni un llamador de producción (R-3,
   * declarado). El error es un enum estable y PII-free (CD-5).
   */
  async submit(_req: PayoutSubmit): Promise<PayoutRecord> {
    throw new Error("ledger_payout_status_gateway_is_read_only");
  }

  async status(payoutId: string): Promise<PayoutRecord> {
    const ahoraMs = Date.parse(this.clock.nowIso());
    // 1 · THROTTLE. Se devuelve la última respuesta si todavía no pasó el intervalo. Un reloj ilegible
    // (NaN) NO abre la compuerta: `NaN - x < y` es `false`, así que cae a leer de nuevo, que es el lado
    // conservador (peor rendimiento, nunca un dato viejo presentado como nuevo).
    if (this.ultima !== null && ahoraMs - this.ultima.atMs < LEDGER_STATUS_MIN_INTERVAL_MS) {
      return this.ultima.rec;
    }

    // 2 · Sin billetera conectada no hay a quién preguntarle por SU payout. No-terminal.
    const address = await this.wallet.getAddress().catch(() => null);
    if (!address) return noSe(payoutId, "payout_status_no_wallet");

    // 3 · La prueba se LEE. ⛔ ACÁ NO SE PIDE NADA: no hay `prove` que llamar (ver el docblock).
    // Sin prueba —o con la ventana de 8 min vencida— el seguimiento simplemente NO LEE, y la remesa se
    // queda donde está (R-1, declarado). No miente: calla.
    const proof = this.proofs.peek(address);
    if (!proof) return noSe(payoutId, "payout_status_no_proof");

    let res: Response;
    try {
      res = await fetch("/api/payout/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sender: address,
          payoutId,
          popChallenge: proof.challenge,
          popSignature: proof.signature,
        }),
      });
    } catch {
      // La red falló. Eso NO dice nada del payout. ⛔ Tratarlo como `failed` false-refundearía un pago
      // que pudo ser exitoso (M5).
      return this.recordar(noSe(payoutId, "payout_status_unreachable"), ahoraMs);
    }

    // 4 · Desenlaces SEPARADOS y no colapsados, misma forma que
    // `../refund/http-solana-remittance-id-resolver.ts:38-40`. Los tres son causas distintas: uno es
    // config nuestra, otro es la prueba, el tercero es la base. Ninguno es un desenlace del payout.
    if (res.status === 501) return this.recordar(noSe(payoutId, "payout_status_not_enabled"), ahoraMs);
    if (res.status === 403) return this.recordar(noSe(payoutId, "payout_status_unverified"), ahoraMs);
    if (res.status === 429) return this.recordar(noSe(payoutId, "payout_status_rate_limited"), ahoraMs);
    if (!res.ok) return this.recordar(noSe(payoutId, "payout_status_unavailable"), ahoraMs);

    let payout: PayoutOutcomeLookup | undefined;
    try {
      payout = ((await res.json()) as { payout?: PayoutOutcomeLookup }).payout;
    } catch {
      // 200 con un body ilegible: el server contestó, pero no entendemos qué. No-terminal.
      return this.recordar(noSe(payoutId, "payout_status_unreadable"), ahoraMs);
    }
    // Un `outcome` que este cliente no reconoce cuenta como "no sé". ⛔ NO se asume `known` por
    // ausencia de campo (M6): eso convertiría un cambio de contrato en un `settled` fabricado.
    if (payout?.outcome !== "known") {
      return this.recordar(noSe(payoutId, "payout_status_unknown"), ahoraMs);
    }
    if (payout.status !== "settled" && payout.status !== "failed") {
      return this.recordar(noSe(payoutId, "payout_status_unknown"), ahoraMs);
    }

    // 5 · EL ÚNICO camino a un terminal, y llega con evidencia server-side verificada.
    //
    // `deliveredPen: null` y `txRef: null` son MEDIDOS, no una simplificación: el webhook escribe SÓLO
    // el status (`recordWebhookOutcome`, `../../application/ports.ts:967` — sólo `payoutId`+`status`).
    // `value_minor` es el
    // principal en USDC, no los PEN entregados; usarlo como `deliveredPen` sería un error de categoría
    // Y de moneda (`isDeliveredWithinReceiveTolerance` TIRA `reconcile_currency_mismatch`).
    // Consecuencia, ya descrita por el propio use-case: con `deliveredPen: null` la guarda de
    // reconciliación es falsa ⇒ `markSettled(null)` byte-idéntico
    // (`markSettled`, `../../application/use-cases/track-remittance.ts:55`). Cero lógica nueva.
    //
    // 🔴 `provenance` es LA DE LA FILA, jamás `""` (DT-6). La ruta sólo la devuelve cuando está en la
    // allowlist de proveniencias reales, así que este valor no puede prender el banner de demo.
    return this.recordar(
      {
        payoutId,
        status: payout.status,
        deliveredPen: null,
        txRef: null,
        failureReason: payout.status === "failed" ? "payout_failed_provider" : null,
        provenance: payout.provenance,
      },
      ahoraMs,
    );
  }

  /** Memoiza para el throttle. Se cachean TAMBIÉN los no-terminales a propósito: si no, un ledger caído
   *  o una prueba ausente harían que cada tick de 1,5 s reintentara, que es exactamente el patrón de
   *  tráfico que el throttle existe para evitar. */
  private recordar(rec: PayoutRecord, atMs: number): PayoutRecord {
    this.ultima = { rec, atMs };
    return rec;
  }
}
