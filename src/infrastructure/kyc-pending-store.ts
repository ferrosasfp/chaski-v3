// Persiste el KYC en curso (remittanceId + sessionId + address) antes del redirect a Didit,
// para retomar el flujo al volver. localStorage: sobrevive la navegación de página completa.
import type { KycPending, KycPendingStore } from "../application/ports";

/** La clave del pendiente de KYC. SE EXPORTA (HU-066) porque la puerta del splash necesita saber
 *  si hay un KYC esperando ser retomado, y copiar el literal allá habría creado un segundo sitio
 *  de escritura del mismo string: el día que esta clave cambie de versión, el splash se pintaría
 *  encima del aterrizaje del KYC y nada se pondría rojo. Ver `../presentation/splash-puerta.ts`. */
export const CLAVE_KYC_PENDIENTE = "chaski.kyc.pending.v1";

export class LocalKycPendingStore implements KycPendingStore {
  async save(p: KycPending): Promise<void> {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(CLAVE_KYC_PENDIENTE, JSON.stringify(p));
    } catch {
      throw new Error("kyc_pending_unavailable");
    }
  }
  /**
   * 🔴 EL `carril` SE NORMALIZA AL LEER, Y ⛔ LA CLAVE **NO** CAMBIA DE VERSIÓN (WKH-233/DT-3a).
   *
   * POR QUÉ NO UN `.v2`. `CLAVE_KYC_PENDIENTE` es un literal EXPORTADO y consumido por
   * `../presentation/splash-puerta.ts`: subirle la versión dejaría a los pendientes EN VUELO
   * invisibles para la puerta del splash, o sea que quien está volviendo del redirect en ese momento
   * se quedaría sin la pantalla que lo retoma. Migrar el dato al leer no tiene ese costo.
   *
   * POR QUÉ EL DEFAULT ES `"directo"` Y NO `"agente"`. Un pendiente guardado ANTES de esta HU se creó
   * contra el proveedor: su `sessionId` no tiene fila en `kyc_session_tokens`, así que el agente
   * contestaría 401. Asumir `"agente"` haría que `ResumeKyc` lo consultara igual y devolviera
   * `"processing"` para siempre — un spinner infinito. `"directo"` es el lado fail-closed: se dice
   * que no se puede retomar, con una pantalla que tiene salida.
   *
   * ⛔ Y NO se valida "es uno de los dos": cualquier valor que no sea exactamente `"agente"` cae en
   * `"directo"`. Un valor desconocido en un blob de `localStorage` —que es atacante-controlable— no
   * puede abrir el camino que consulta al agente.
   */
  async get(): Promise<KycPending | null> {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(CLAVE_KYC_PENDIENTE);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as KycPending;
      return { ...p, carril: p.carril === "agente" ? "agente" : "directo" };
    } catch {
      return null;
    }
  }
  async clear(): Promise<void> {
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(CLAVE_KYC_PENDIENTE);
    } catch {
      throw new Error("kyc_pending_unavailable");
    }
  }
}
