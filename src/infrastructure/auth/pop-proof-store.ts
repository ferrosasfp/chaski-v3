// Infrastructure — almacén EN MEMORIA de las pruebas de posesión que ya se produjeron (WKH-337).
//
// 🔴 POR QUÉ EXISTE, Y ES UNA MEDICIÓN, NO UNA PREFERENCIA. El seguimiento de una remesa corre dentro
// de un `setInterval` de 1500 ms (`}, 1500);`, `../../presentation/flow.tsx:661`). Si el gateway que
// lee el desenlace pudiera PEDIR una prueba de posesión, cada tick abriría un popup de la billetera:
// 600 s ÷ 1,5 s = 400 firmas por sesión de 10 minutos. Y contra el rate-limit: los buckets de esta app
// tienen presupuestos de 5 a 60 requests por "10 m", así que 400 los revienta por un orden de magnitud.
//
// La salida es que la prueba se OBSERVE en vez de pedirse. `HttpPopSigner` ya la produce en los tres
// call-sites del composition root, y los tres cuelgan de un gesto de la persona (conectar, preparar el
// depósito, recuperar el escrow). Este almacén se entera de esas pruebas; el gateway de seguimiento
// SÓLO LEE.
//
// ⛔ Y EL MECANISMO ES EL TIPO, NO LA DISCIPLINA. `PopProofReader` no tiene `prove`
// (`PopProofReader`, `../../application/ports.ts:150`), así que el gateway no puede pedir una firma
// aunque alguien quiera: `tsc` lo impide. Es el mismo patrón estructural que el campo `garantia`
// obligatorio de WKH-338. Esta clase implementa las DOS interfaces porque es el mismo objeto visto
// desde los dos lados, pero lo que se le inyecta al gateway es el tipo de SÓLO LECTURA.
import type { Clock, PopProof, PopProofReader, PopProofRecorder } from "../../application/ports";

/**
 * Cuánto vale una prueba observada. **8 minutos**, y el número está derivado:
 *
 *   POP_PROOF_TTL_MS  <  POP_CHALLENGE_TTL_SECONDS × 1000  =  10 × 60 × 1000  =  600 000 ms
 *
 * Estrictamente MENOR que la vida del challenge que el server emite y verifica
 * (`POP_CHALLENGE_TTL_SECONDS`, `./pop-challenge.ts:22`), para que este almacén NUNCA entregue una
 * prueba que el server ya va a rechazar por vencida. Los 2 minutos de margen absorben el desfase de
 * reloj entre el navegador y el server, que es el único plazo que no controlamos.
 *
 * ⚠️ ES UN SEGUNDO LITERAL Y NO SE PUEDE DERIVAR POR IMPORT: `pop-challenge.ts` importa `node:crypto`
 * (`import { createHmac, timingSafeEqual } from "node:crypto";`, `./pop-challenge.ts:18`), así que
 * importarlo desde acá rompería el bundle del browser — y este archivo se instancia en el composition
 * root, que es código de cliente. Un segundo literal es exactamente el punto ciego que el
 * Auto-Blindaje de WKH-336 nombra, así que **la relación se ata con un candado estático, no con
 * disciplina**: `pop-proof-store.test.ts` lee los DOS archivos con `readFileSync` y compara los
 * números. ⛔ Si cambiás uno, el candado se pone rojo: no lo "arregles" tocando el otro sin releer
 * esta derivación.
 */
const POP_PROOF_TTL_MS = 8 * 60 * 1000;

interface Observada {
  readonly proof: PopProof;
  readonly atMs: number;
}

export class InMemoryPopProofStore implements PopProofReader, PopProofRecorder {
  private readonly porAddress = new Map<string, Observada>();

  constructor(private readonly clock: Clock) {}

  /** El reloj es el puerto inyectado, no `Date.now()`: `Clock` es `{ nowIso(): string }` y NO tiene
   *  `nowMs()` (`Clock`, `../../application/ports.ts:974`). ⛔ No ampliar el puerto por esto. */
  private ahoraMs(): number {
    return Date.parse(this.clock.nowIso());
  }

  record(address: string, proof: PopProof): void {
    // La última gana: una prueba más nueva siempre es preferible, y sobrescribir evita que el Map
    // crezca por address. NO se valida la prueba acá — el único que puede verificarla es el server,
    // que tiene el secreto del HMAC. Este almacén transporta, no juzga.
    this.porAddress.set(address, { proof, atMs: this.ahoraMs() });
  }

  /** `null` significa DOS cosas que para el caller son la misma: no hay prueba, o la que hay venció.
   *  Las dos llevan al mismo lado —el gateway devuelve un estado NO-TERMINAL— así que colapsarlas no
   *  pierde ninguna decisión. ⛔ Lo que NO se puede hacer es devolver una vencida: el server la
   *  rechazaría con 403 y el gateway lo trataría como "no sé", o sea el mismo desenlace pagando una
   *  request y una verificación de firma. */
  peek(address: string): PopProof | null {
    const obs = this.porAddress.get(address);
    if (!obs) return null;
    // Un `nowIso()` ilegible daría NaN, y toda comparación con NaN es `false` ⇒ la prueba se leería
    // como VÁLIDA PARA SIEMPRE. Se chequea explícitamente para que la ausencia de reloj caiga del lado
    // seguro (sin prueba), igual que el resto del money-path.
    const ahora = this.ahoraMs();
    if (!Number.isFinite(ahora)) return null;
    if (ahora - obs.atMs >= POP_PROOF_TTL_MS) {
      this.porAddress.delete(address); // vencida: no vuelve a mirarse
      return null;
    }
    return obs.proof;
  }
}
