// Infrastructure — PopSigner sobre HTTP (WKH-206). Pide un challenge server-emitido a
// /api/a2a/payout/challenge para `address`, lo firma con la wallet conectada (personal_sign) y
// devuelve { challenge, signature } para que el use-case lo adjunte al submit del payout.
//
// Contrato 501-vs-otros-errores (DT-2, fix-pack AR-MNR-1):
//   · 501 (`pop_not_configured`, secreto server-only ausente = mecanismo APAGADO) ⇒ devuelve `null`:
//     el use-case lo trata como SKIP y NO adjunta campos ⇒ el submit sigue byte-idéntico al demo.
//   · Cualquier OTRO !ok (400 request malo, 5xx en un deployment genuinamente ON) o un fallo de red
//     (fetch rechaza) ⇒ LANZA: el use-case lo degrada CONTROLADO por su camino de error (failAndRefund),
//     nunca deja la remesa varada. (Antes lanzaba en TODO !ok, incluido el 501 — divergía de DT-2.)
import type { PopProofRecorder, PopSigner, WalletPort } from "../../application/ports";

export class HttpPopSigner implements PopSigner {
  constructor(private readonly wallet: WalletPort, private readonly recorder?: PopProofRecorder) {}

  async prove(address: string): Promise<{ challenge: string; signature: string } | null> {
    const res = await fetch("/api/a2a/payout/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    });
    if (res.status === 501) return null; // DT-2: mecanismo apagado server-side ⇒ SKIP (no adjunta campos)
    if (!res.ok) throw new Error("pop_challenge_unavailable"); // 400/5xx en ON ⇒ fail-closed controlado
    const { popChallenge, popMessage } = (await res.json()) as {
      popChallenge: string;
      popMessage: string;
    };
    // El cliente firma el popMessage VERBATIM (CD-10): NO reconstruye el string.
    const signature = await this.wallet.signMessage(popMessage);
    const proof = { challenge: popChallenge, signature };
    // ── WKH-337 · el 2º argumento OPCIONAL es un OBSERVADOR, no un caché ──────────────────────────────
    // ⛔ ESTE BLOQUE NO VA ARRIBA, EN EL DOCBLOCK DEL ARCHIVO, y no es una preferencia de estilo: las
    // líneas 1 a 23 de acá tienen que quedar BYTE-IDÉNTICAS a `07882f6`, porque `flow-vm.test.ts:520`
    // cita `http-pop-signer.ts:23` por número y ese archivo está fuera del Scope IN de esta HU. MEDIDO:
    // con el docblock arriba del `import`, el barrido de inbounds reportaba esa cita como ROTA. ⛔ Antes
    // de mover esto, buscá quién cita este archivo por número de línea.
    //
    // Por qué existe: el seguimiento de la remesa necesita una prueba de posesión para leer el desenlace
    // del payout, y NO PUEDE pedirla — corre en un `setInterval` de 1,5 s
    // (`}, 1500);`, `../../presentation/flow.tsx:613`), así que pedir abriría un popup de billetera cada
    // tick. Entonces la OBSERVA de acá, que es donde cada firma cuelga de un gesto de la persona.
    //
    // 🔴 EL COMPORTAMIENTO DE ESTA CLASE NO CAMBIA, Y ESO ES UNA CD (CD-6). Sigue pidiendo la firma CADA
    // VEZ, exactamente como antes: la firma YA ocurrió en la línea de arriba y el observador se notifica
    // DESPUÉS. ⛔ PROHIBIDO convertirlo en un signer que REUSE una prueba guardada para SALTARSE un popup
    // del money-path: eso reduciría las veces que la persona firma conscientemente una operación de
    // dinero, y no es lo que esta HU vino a hacer. Sin el 2º argumento el comportamiento es
    // BYTE-IDÉNTICO — es lo que hace el `test-container`, y por eso los 71 tests de `flow.test.tsx` no
    // ven nada de esto.
    //
    // Se aísla en un try/catch porque observar es SECUNDARIO: si el observador tirara, la prueba que el
    // caller pidió se perdería por un problema de un consumidor que no es el que la pidió.
    if (this.recorder) {
      try {
        this.recorder.record(address, proof);
      } catch {
        // Observar es best-effort: sin prueba observada el seguimiento simplemente no lee (R-1).
      }
    }
    return proof;
  }
}
