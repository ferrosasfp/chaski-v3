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

/**
 * 🔴 LA CLAVE DEL MEMO, Y EL TIPO ES EL MECANISMO (AR/BLQ-ALTO-1).
 *
 * Acá había **un solo casillero sin clave** (`private ultima: {rec, atMs} | null`), y el throttle
 * devolvía ese record a CUALQUIER `status()` que llegara dentro de los 20 s. Consecuencia MEDIDA, con
 * una sola instancia del gateway —que es como la cablea `container.ts:127`— y un tick de 1,5 s de la
 * pantalla en el medio:
 *
 *     track.execute({remittanceId:"R1"})  → R1 settled "transfi"     (el ledger dice known/settled)
 *     reloj.avanzar(1500)
 *     track.execute({remittanceId:"R2"})  → R2 settled "transfi"  ← HEREDADO, fetches=1
 *     RecoverEscrowFunds({remittanceId:"R2"}) → refund_not_available
 *
 * O sea: una remesa cuyo payout NO se liquidó quedaba en `settled`, que no está en `RECOVERABLE`
 * (`RECOVERABLE`, `../../application/use-cases/recover-escrow-funds.ts:40`) y no tiene transición de
 * salida ⇒ **el remitente perdía para siempre el camino a sus USDC mientras la pantalla decía
 * "Entregado"**. Y no venía de una rama de error, que es todo lo que el resto de esta clase blinda:
 * venía del CACHÉ.
 *
 * ⛔ POR QUÉ NO ES UN `if` MÁS. Un memo indexado "acordándose" de comparar el `payoutId` depende de que
 * el próximo que lo toque se acuerde. Así que la clave es un tipo BRANDEADO que **sólo** `claveDe()`
 * puede construir: `Map<ClaveLectura, …>` no acepta un `string` pelado, así que **indexar el memo con
 * un `payoutId` a secas no compila**. Es el patrón estructural de WKH-338 (el invariante como
 * obligación del tipo) aplicado al caché.
 *
 * Y la clave lleva la ADDRESS además del `payoutId`, porque el defecto tenía una segunda cara medida:
 * el chequeo de billetera estaba DESPUÉS del throttle, así que cambiar de wallet devolvía el record de
 * la anterior (`A=settled B=settled fetches=1`). Que la address sea parte de la clave obliga a
 * resolverla ANTES de consultar el memo — el orden ya no es una convención, es una dependencia de datos.
 */
declare const CLAVE_LECTURA: unique symbol;
type ClaveLectura = string & { readonly [CLAVE_LECTURA]: true };
/**
 * El ÚNICO constructor de una clave. `\u0000` no puede aparecer en una address base58 ni en un
 * payout_id, así que no hay dos pares distintos que colisionen en la misma clave.
 *
 * ⚠️ RECIBE UN OBJETO CON NOMBRES, no dos strings posicionales, y es deliberado: con `claveDe(a, b)`
 * los dos parámetros son `string` y **`tsc` no puede distinguir un intercambio**. MEDIDO: el mutante
 * `claveDe(payoutId, payoutId)` COMPILABA (lo cazó un test, pero compilaba). Con las propiedades
 * nombradas, dejar la address afuera es un error de compilación y no un argumento mal puesto.
 */
function claveDe(de: { address: string; payoutId: string }): ClaveLectura {
  return `${de.address}\u0000${de.payoutId}` as ClaveLectura;
}

export class LedgerPayoutStatusGateway implements PayoutGateway {
  /** Lo último leído POR (address, payoutId). Un `Map` y no un campo: el throttle es por payout, no
   *  global. Se poda al escribir, así que no crece más allá de los payouts vivos de la sesión. */
  private readonly memo = new Map<ClaveLectura, { readonly rec: PayoutRecord; readonly atMs: number }>();

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

    // 1 · LA BILLETERA, ANTES DEL THROTTLE (AR/BLQ-ALTO-1). El orden ya no es una convención: la address
    // es parte de la clave del memo, así que sin resolverla no hay nada que consultar. Leer el bridge NO
    // toca la red, NO abre el modal y NO pide ninguna firma (`getConnectedAddress`,
    // `../solana-wallet.ts:233`), así que adelantarlo no cuesta nada por tick.
    // Sin billetera conectada no hay a quién preguntarle por SU payout ⇒ no-terminal, y **sin clave no
    // se puede memoizar**: el tipo lo impide, que es justo lo que se quería.
    const address = await this.wallet.getAddress().catch(() => null);
    if (!address) return noSe(payoutId, "payout_status_no_wallet");
    const clave = claveDe({ address, payoutId });

    // 2 · THROTTLE, POR CLAVE. Se devuelve lo último leído PARA ESTE payout Y ESTA address. Un reloj
    // ilegible (NaN) NO abre la compuerta: `NaN - x < y` es `false`, así que cae a leer de nuevo, que es
    // el lado conservador (peor rendimiento, nunca un dato viejo presentado como nuevo).
    const memo = this.memo.get(clave);
    if (memo !== undefined && ahoraMs - memo.atMs < LEDGER_STATUS_MIN_INTERVAL_MS) {
      return memo.rec;
    }

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
      return this.recordar(clave, noSe(payoutId, "payout_status_unreachable"), ahoraMs);
    }

    // 4 · Desenlaces SEPARADOS y no colapsados, misma forma que
    // `../refund/http-solana-remittance-id-resolver.ts:38-40`. Los tres son causas distintas: uno es
    // config nuestra, otro es la prueba, el tercero es la base. Ninguno es un desenlace del payout.
    if (res.status === 501) return this.recordar(clave, noSe(payoutId, "payout_status_not_enabled"), ahoraMs);
    if (res.status === 403) return this.recordar(clave, noSe(payoutId, "payout_status_unverified"), ahoraMs);
    if (res.status === 429) return this.recordar(clave, noSe(payoutId, "payout_status_rate_limited"), ahoraMs);
    if (!res.ok) return this.recordar(clave, noSe(payoutId, "payout_status_unavailable"), ahoraMs);

    let payout: PayoutOutcomeLookup | undefined;
    try {
      payout = ((await res.json()) as { payout?: PayoutOutcomeLookup }).payout;
    } catch {
      // 200 con un body ilegible: el server contestó, pero no entendemos qué. No-terminal.
      return this.recordar(clave, noSe(payoutId, "payout_status_unreadable"), ahoraMs);
    }
    // Un `outcome` que este cliente no reconoce cuenta como "no sé". ⛔ NO se asume `known` por
    // ausencia de campo (M6): eso convertiría un cambio de contrato en un `settled` fabricado.
    if (payout?.outcome !== "known") {
      return this.recordar(clave, noSe(payoutId, "payout_status_unknown"), ahoraMs);
    }
    if (payout.status !== "settled" && payout.status !== "failed") {
      return this.recordar(clave, noSe(payoutId, "payout_status_unknown"), ahoraMs);
    }
    // 🔴 AR/MNR-1 — Y EL `provenance` TAMBIÉN SE VALIDA, porque defender dos de los tres campos y no el
    // tercero es la asimetría que abre la puerta. MEDIDO con
    // `{"outcome":"known","status":"settled","provenance":123}`: el número viajaba tal cual al agregado,
    // y `isPayoutDemo(123)` es `true` (`123 != null` ✓ y `!has(123)` ✓) ⇒ **banner "Modo demo" sobre una
    // remesa REAL y liquidada**. Es DT-6 otra vez, por otra puerta: no por el `""` sino por el tipo.
    // Un `provenance` que no es un string no es una proveniencia ⇒ no sabemos de qué desembolso habla.
    if (typeof payout.provenance !== "string" || payout.provenance.length === 0) {
      return this.recordar(clave, noSe(payoutId, "payout_status_unknown"), ahoraMs);
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
      clave,
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
   *  tráfico que el throttle existe para evitar.
   *
   *  🔴 EL PRIMER PARÁMETRO ES LA CLAVE Y ES OBLIGATORIO (AR/BLQ-ALTO-1). No se puede memoizar "lo
   *  último" sin decir DE QUÉ: `ClaveLectura` sólo la construye `claveDe({ address, payoutId })`, así que
   *  guardar un record sin atarlo a su payout y a su dueño **no compila**. Antes esto era
   *  `recordar(rec, atMs)` sobre un único casillero, y ahí vivía el bug. */
  private recordar(clave: ClaveLectura, rec: PayoutRecord, atMs: number): PayoutRecord {
    // Poda de lo vencido ANTES de escribir: el Map no puede crecer indefinidamente en una sesión larga,
    // y una entrada vencida no le sirve a nadie (el throttle ya la descartaría al leerla).
    for (const [k, v] of this.memo) {
      if (atMs - v.atMs >= LEDGER_STATUS_MIN_INTERVAL_MS) this.memo.delete(k);
    }
    this.memo.set(clave, { rec, atMs });
    return rec;
  }
}
