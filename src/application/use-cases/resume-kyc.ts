import type { RemittanceState } from "../../domain/remittance";
import type { Clock, KycGateway, KycPendingStore, KycStore, RemittanceRepository } from "../ports";

/**
 * Retoma el KYC al volver del redirect a Didit. Lee el pendiente (sessionId), consulta la
 * decisión y la aplica. Si Didit aún procesa (no terminal) → "processing" (la UI reintenta).
 */
export type ResumeKycResult =
  | { kind: "none" }
  | { kind: "processing" }
  | { kind: "passed"; snapshot: Readonly<RemittanceState> }
  | { kind: "failed"; snapshot: Readonly<RemittanceState> };

export class ResumeKyc {
  constructor(
    private readonly kyc: KycGateway,
    private readonly kycStore: KycStore,
    private readonly pending: KycPendingStore,
    private readonly repo: RemittanceRepository,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<ResumeKycResult> {
    const p = await this.pending.get();
    if (!p) return { kind: "none" };

    const r = await this.repo.get(p.remittanceId);
    if (!r) {
      await this.pending.clear();
      return { kind: "none" };
    }
    // Si la remesa ya salió de kyc_pending (retomada antes), no reaplicar.
    if (r.snapshot.status !== "kyc_pending") {
      await this.pending.clear();
      return { kind: "none" };
    }
    if (p.carril !== "agente") { await this.pending.clear(); return { kind: "failed", snapshot: r.snapshot }; } // 🔴 WKH-233/D-5 — EN ESTA LÍNEA (era una línea en blanco): `splash-puerta.ts:26` cita `:24` y `flow.tsx`/`barra-destinos.test.tsx` citan `:49` de este archivo POR NÚMERO, así que insertar una línea las rompe a las tres. · QUÉ HACE: enruta por el CARRIL con el que la sesión NACIÓ, ⛔ NUNCA por el valor actual de una env — un pendiente en vuelo tiene que resolverse por su propio camino, o quitar `KYC_AGENT_BASE_URL` (que es el rollback de la HU) cortaría a quien está a mitad del flujo. · POR QUÉ `"directo"` NO SE PUEDE RESOLVER Y HAY QUE DECIRLO: su `sessionId` es del proveedor, no tiene fila en `kyc_session_tokens` y el agente contestaría 401 ⇒ si llamáramos igual, esto devolvería `"processing"` PARA SIEMPRE y la persona quedaría girando hasta el timeout, sin salida y sin explicación. · ⛔ SIN `applyKyc`: no inventamos un veredicto sobre esa persona, sólo decimos que NO PUDIMOS RETOMAR. `flow.tsx` ya tiene el aterrizaje de `failed` —copy "Tu verificación necesita otro intento", `tono="atencion"`, botón a `verify`—, así que cae en una pantalla CON SALIDA. · Un pendiente anterior a la HU no trae el campo y el store lo normaliza a `"directo"`, que es este lado.
    let dec: Awaited<ReturnType<KycGateway["decision"]>>;
    try {
      dec = await this.kyc.decision(p.sessionId, p.sessionToken);
    } catch {
      return { kind: "processing" }; // reintentable
    }
    if (!dec.terminal) return { kind: "processing" };

    const v = dec.verification;
    r.applyKyc(v, this.clock.nowIso());
    await this.repo.save(r);
    if (v.approved && v.payoutAllowed) await this.kycStore.save(p.address, v);
    await this.pending.clear();
    return { kind: r.status === "kyc_passed" ? "passed" : "failed", snapshot: r.snapshot };
  }
}
