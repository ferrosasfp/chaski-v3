// Infrastructure — almacén EN MEMORIA de la sesión de posesión que el servidor ya emitió
// (WKH-372/W3.4). Calcado de `./pop-proof-store.ts`, que es el mismo problema con otra credencial.
//
// 🔴 QUÉ TRANSPORTA. `/api/kyc/verdict` acuña la sesión DESPUÉS de verificar la primera firma de la
// persona (`emitirSesionDePosesion`, `./sesion-de-posesion.ts:95`), y la manda en el cuerpo de sus
// cinco respuestas 200. El gateway del veredicto la graba acá; el gateway del depósito la lee y la
// presenta en vez de pedir una SEGUNDA firma que prueba exactamente lo mismo. Ése es todo el
// mecanismo: una firma menos, sin aflojar un solo guard del servidor.
//
// ⛔ SERVER-ONLY NO: ESTE ARCHIVO CORRE EN EL NAVEGADOR, y por eso NO importa `node:crypto` ni
// `./sesion-de-posesion.ts`. Es exactamente el motivo, ya medido y escrito, por el que
// `./pop-proof-store.ts` DUPLICA su literal de TTL en vez de importarlo: *«importarlo desde acá
// rompería el bundle del browser»* (`POP_PROOF_TTL_MS`, `./pop-proof-store.ts:40`). Este archivo se
// instancia en el composition root, que es código de cliente.
//
// 🔴 Y EN MEMORIA, ⛔ NUNCA EN `localStorage`, `sessionStorage`, `IndexedDB`, UNA COOKIE NI LA URL.
// Tres razones que se refuerzan:
//   1. Una sesión que sobreviviera a una recarga saltearía la PRIMERA firma. En memoria, «la recarga
//      vuelve a pedir la primera firma» se cumple POR CONSTRUCCIÓN, sin un guard que alguien tenga
//      que acordarse de mantener. Lo mide `T-372-W3-8`, por nombre, en
//      `../../presentation/sesion-borra-la-segunda-firma.test.tsx`.
//   2. Es una credencial al portador: at-rest en el navegador es superficie que no hace falta abrir.
//   3. El camino por enlace profundo pierde esta sesión en cada salto (el árbol de React se remonta)
//      ⇒ cae al PoP solo, sin que haya que escribir una línea para lograrlo. El respaldo por enlace
//      conserva EXACTAMENTE el comportamiento de hoy, gratis.
//
// ⛔ Y VIAJA EN EL CUERPO, NO EN UNA COOKIE. El repo no tiene ninguna infraestructura de cookies
// (medido: cero `next/headers`, cero `Set-Cookie`, cero `cookies()` en `src/` y `app/`), y una cookie
// que el navegador adjuntara sola a `POST /api/payout/prepare` abriría una superficie de CSRF que hoy
// no existe, porque hoy la credencial es un campo del cuerpo que un sitio de terceros no puede
// fabricar.
import type { Clock, SesionReader, SesionRecorder } from "../../application/ports";

/**
 * Cuánto vale una sesión guardada del lado del cliente. **28 minutos**, y el número está derivado:
 *
 *   SESION_STORE_TTL_MS  <  SESION_TTL_SECONDS × 1000  =  30 × 60 × 1000  =  1 800 000 ms
 *
 * Estrictamente MENOR que la vida del token que el servidor firma y verifica
 * (`SESION_TTL_SECONDS`, `./sesion-de-posesion.ts:61`), para que este almacén NUNCA entregue una
 * sesión que el servidor ya va a rechazar por vencida. Los 2 minutos de margen absorben el desfase
 * de reloj entre el navegador y el servidor, que es el único plazo que no controlamos.
 *
 * ⚠️ ES UN SEGUNDO LITERAL Y NO SE PUEDE DERIVAR POR IMPORT, por el motivo del docblock de arriba
 * (`node:crypto`). Un segundo literal sin candado es un punto ciego, así que **la relación se ata con
 * un candado estático, no con disciplina**: `./sesion-store.test.ts` lee los DOS archivos con
 * `readFileSync` y compara los números. ⛔ Si cambiás uno, el candado se pone rojo: no lo "arregles"
 * tocando el otro sin releer esta derivación.
 *
 * ⚠️ Y VENCERSE NO ES FALLAR. Cuando esto devuelve `null`, el gateway del depósito pide la firma
 * igual que siempre y la persona ve el prompt de su billetera, indistinguible del funcionamiento
 * normal. ⛔ No hay ni un string de error para este caso, y esa ausencia es la decisión.
 */
const SESION_STORE_TTL_MS = 28 * 60 * 1000;

interface Guardada {
  readonly token: string;
  readonly atMs: number;
}

export class InMemorySesionStore implements SesionReader, SesionRecorder {
  private readonly porAddress = new Map<string, Guardada>();

  constructor(private readonly clock: Clock) {}

  /** El reloj es el puerto inyectado, no `Date.now()`: `Clock` es `{ nowIso(): string }` y NO tiene
   *  `nowMs()` (`Clock`, `../../application/ports.ts:975`). ⛔ No ampliar el puerto por esto. */
  private ahoraMs(): number {
    return Date.parse(this.clock.nowIso());
  }

  record(address: string, token: string): void {
    // La última gana: una sesión más nueva siempre es preferible, y sobrescribir evita que el Map
    // crezca por address. NO se valida el token acá — el único que puede verificarlo es el servidor,
    // que tiene el secreto del HMAC. Este almacén transporta, no juzga.
    this.porAddress.set(address, { token, atMs: this.ahoraMs() });
  }

  /** `null` significa DOS cosas que para el caller son la misma: no hay sesión, o la que hay venció.
   *  Las dos llevan al mismo lado —se le pide la firma a la persona, como hoy— así que colapsarlas no
   *  pierde ninguna decisión. ⛔ Lo que NO se puede hacer es devolver una vencida: el servidor la
   *  rechazaría con 403 y el gateway tendría que replegarse igual, pagando una request de más. */
  peek(address: string): string | null {
    const g = this.porAddress.get(address);
    if (!g) return null;
    // Un `nowIso()` ilegible daría NaN, y toda comparación con NaN es `false` ⇒ la sesión se leería
    // como VÁLIDA PARA SIEMPRE. Se chequea explícitamente para que la ausencia de reloj caiga del
    // lado seguro (sin sesión), igual que el resto del money-path.
    const ahora = this.ahoraMs();
    if (!Number.isFinite(ahora)) return null;
    if (ahora - g.atMs >= SESION_STORE_TTL_MS) {
      this.porAddress.delete(address); // vencida: no vuelve a mirarse
      return null;
    }
    return g.token;
  }
}
