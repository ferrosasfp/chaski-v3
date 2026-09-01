// Infrastructure — KycVerdictStore sobre Supabase (WKH-333 W1). SERVER-ONLY (CD-11): usa el cliente
// de supabase-server.ts (SUPABASE_SERVICE_ROLE_KEY / BYPASSRLS). PROHIBIDO importarlo desde el
// browser, desde `src/presentation/**` o desde cualquier módulo "use client".
//
// Persiste el VEREDICTO de la verificación de identidad y nada más: sender_address, verification_id,
// approved, risk_level, provenance cruda y verified_at. NUNCA PII (CD-2): ni nombre, ni tipo/número
// de documento —tampoco sus últimos 4—, ni fecha de nacimiento, ni nacionalidad. Y NUNCA una columna
// de vencimiento (CD-7): el vencimiento se computa al leer, con `isVerdictExpired`.
//
// 🔴 EL GUARD REAL DE OWNERSHIP ES APP-LAYER. El cliente usa el service key y BYPASSEA RLS, así que
// el `.eq("sender_address", canonicalizeAddress(...))` de cada cadena NO es una optimización: es lo
// único que impide que una dirección lea o pise el veredicto de otra (CD-5). La política RLS de la
// migración es defensa en profundidad ante un cliente con anon-key, no el guard.
//
// Factory getKycVerdictStore(): null si KYC_VERDICT_STORE_ENABLED !== "true" O el cliente Supabase es
// null (envs ausentes) ⇒ el endpoint del veredicto responde 501. La env se lee DENTRO de la factory,
// en runtime (CD-14).
//
// 🔴 Y NO: `prepare` NO "conserva su comportamiento actual". Acá decía exactamente esa frase, y este
// es el QUINTO sitio donde sobrevivió después de que se midiera falsa (AR/BLQ-ALTO-1; la encontró acá
// CR/BLQ-BAJO-1). Es el peor lugar posible para que sobreviviera: este archivo produce el `null` y es
// el ÚNICO lector de la env, o sea exactamente donde aterriza quien greppee el flag en medio de un
// incidente. Leer "prepare conserva su comportamiento actual", apagar el flag y cortar el money-path
// entero es un movimiento de un solo paso.
//
// LO MEDIDO: sin store, `prepare` no tiene de dónde sacar el identificador de la verificación —el del
// cliente ya NO se acepta (CD-26), y eso es la HU entera— y responde **503 a TODO pagador**. El
// candado es `app/api/payout/prepare/route.flag-off.test.ts`, que NO mockea la autoridad de KYC.
// ⇒ APAGAR ESTE FLAG NO ES UN ROLLBACK: ES UN CORTE. El rollback es re-desplegar el código anterior a
// WKH-333 y RECIÉN ENTONCES apagarlo. Coincide con `.env.example` (sección WKH-333) y con el `_down`
// de `20260806T000000_create_kyc_verdicts.sql`, que dicen lo mismo.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { KycVerdictRecord, KycVerdictStore, KycVerdictWriteOutcome } from "../../application/ports";
import { canonicalizeAddress } from "../address";
import { getSupabaseServerClient } from "./supabase-server";

const TABLE = "kyc_verdicts";

/** Columnas que se leen. `verification_id` viaja porque el consumidor SERVER-SIDE lo necesita para
 *  hablar con la autoridad de KYC — nunca para responderlo (AC-6/CD-9). */
const READ_COLUMNS = "sender_address, verification_id, approved, risk_level, provenance, verified_at";

interface RawRow {
  sender_address: string;
  verification_id: string;
  approved: boolean;
  risk_level: string;
  provenance: string;
  verified_at: string;
}

/** El `risk_level` de la fila es `text`, así que puede traer algo fuera del conjunto (una versión
 *  vieja del mapeo, un proveedor nuevo). Lo desconocido cuenta como `"high"`: es la dirección
 *  fail-safe. ⚠️ ACÁ SE CITABA `resolveRiskLevel` en `didit/decision.ts` como si existiera: WKH-233
 *  borró ese módulo y esa función, así que la comparación ya no se puede seguir (el lector vivo con el
 *  mismo criterio es (`readRiskLevel`, `../kyc/http-kyc-verdict-gateway.ts:57`)) cuando no reconoce la
 *  señal. Input que lo refuta: una fila con `risk_level = 'bajo'` — si esto devolviera `"low"`, la
 *  pantalla afirmaría un riesgo que nadie evaluó. */
function readRiskLevel(raw: string): "low" | "medium" | "high" {
  return raw === "low" || raw === "medium" ? raw : "high";
}

export class SupabaseKycVerdictStore implements KycVerdictStore {
  constructor(private readonly client: SupabaseClient) {}

  async get(senderAddress: string): Promise<KycVerdictRecord | null> {
    // OWNER-SCOPED. `canonicalizeAddress` es base58 CASE-SENSITIVE y tira con lo malformado
    // (address.ts:13): PROHIBIDO `.toLowerCase()` acá (CD-10) — lowercasear abriría una colisión
    // entre dos direcciones distintas.
    const owner = canonicalizeAddress(senderAddress);
    const { data, error } = await this.client
      .from(TABLE)
      .select(READ_COLUMNS)
      .eq("sender_address", owner) // ← EL GUARD
      .maybeSingle();
    // NUNCA se ecoa el mensaje del driver (puede traer el valor del filtro). Sólo el SQLSTATE, que es
    // un enum estable y sirve para diagnosticar (42P01 = la tabla no existe ⇒ falta la migración).
    if (error) throw new Error(`kyc_verdict_read_failed:${error.code ?? "unknown"}`);
    if (!data) return null;
    const row = data as unknown as RawRow;
    return {
      senderAddress: row.sender_address,
      verificationId: row.verification_id,
      approved: row.approved,
      riskLevel: readRiskLevel(row.risk_level),
      provenance: row.provenance, // CRUDA: el juicio sobre si es real vive en el LECTOR (AC-11)
      verifiedAt: row.verified_at,
    };
  }

  /**
   * Escritura CAS, **sin lectura previa**. Todo el estado previo que importa viaja en el WHERE, igual
   * que el contrato de `recordSolanaPrincipalIn` en el ledger de evidencia.
   *
   * 🔴 POR QUÉ NO ES UN `upsert`. Un upsert sobre `sender_address` pisaría `verified_at` en CADA
   * escritura, y `app/api/kyc/decision/route.ts` se pollea hasta 8 veces por verificación
   * (`flow.tsx`, RESUME_MAX_POLLS). Con un upsert, cualquiera que deje la pestaña recargando renueva
   * su verificación indefinidamente: el veredicto NO VENCERÍA NUNCA (CD-25, mutante M-10). Los tres
   * desenlaces existen precisamente para que "es la misma verificación" sea distinguible de "es otra".
   *
   * 1. UPDATE … WHERE sender_address = X AND verification_id <> nuevo ⇒ `'replaced'` (mueve
   *    `verified_at`: el hecho es OTRO).
   * 2. Si no afectó filas → INSERT. `23505` contra `uq_kyc_verdicts_sender` significa que la fila ya
   *    existe con el MISMO `verification_id` ⇒ `'already_recorded'`, NO-OP, `verified_at` intacto.
   * 3. Insert exitoso ⇒ `'inserted'`.
   */
  async put(record: KycVerdictRecord): Promise<KycVerdictWriteOutcome> {
    const owner = canonicalizeAddress(record.senderAddress);
    const columns = {
      verification_id: record.verificationId,
      approved: record.approved,
      risk_level: record.riskLevel,
      provenance: record.provenance,
      verified_at: record.verifiedAt,
    };

    // 1. ¿Hay una fila de ESTA dirección con OTRA verificación? Entonces es una verificación nueva.
    const { data: replaced, error: replaceErr } = await this.client
      .from(TABLE)
      .update({ ...columns, updated_at: new Date().toISOString() })
      .eq("sender_address", owner) // ← EL GUARD
      .neq("verification_id", record.verificationId)
      .select("id");
    if (replaceErr) throw new Error(`kyc_verdict_replace_failed:${replaceErr.code ?? "unknown"}`);
    if ((replaced ?? []).length > 0) return "replaced";

    // 2. No había fila, o la que había es la MISMA verificación. El índice único sobre
    //    `sender_address` resuelve cuál de las dos, sin una lectura que pueda quedar obsoleta entre
    //    el SELECT y el INSERT.
    const { error: insertErr } = await this.client
      .from(TABLE)
      .insert({ sender_address: owner, ...columns });
    if (insertErr) {
      // 23505 = unique_violation. La fila ya está con el MISMO verification_id ⇒ NO-OP deliberado:
      // `verified_at` NO se toca (CD-25). Que approved/risk_level pudieran haber cambiado sin cambiar
      // el verification_id no abre nada: el momento del dinero re-consulta a la autoridad igual
      // (CD-12), así que esta fila no es la que decide.
      if (insertErr.code === "23505") return "already_recorded";
      throw new Error(`kyc_verdict_insert_failed:${insertErr.code ?? "unknown"}`);
    }
    return "inserted";
  }
}

/**
 * Factory del store. `null` cuando KYC_VERDICT_STORE_ENABLED !== "true" (flag OFF) **o** el cliente
 * Supabase es `null` (envs ausentes).
 *
 * 🔴 CONSECUENCIA DEL `null`, MEDIDA (CR/BLQ-BAJO-1 — SEXTO sitio de la frase que AR/BLQ-ALTO-1
 * demolió): el endpoint del veredicto responde 501 **y `prepare` responde 503 a TODO pagador**. Acá
 * decía "y `prepare` conserva su comportamiento actual (AC-12)", y es FALSO desde el fix-pack del AR.
 * Candado: `app/api/payout/prepare/route.flag-off.test.ts`.
 *
 * POR QUÉ LA ENV SE LEE EN RUNTIME (CD-14) — la justificación TAMBIÉN cambió, y hay que decirlo.
 * Decía "a nivel de módulo quedaría congelada en el build y el flag no se podría apagar sin
 * re-deployar": apagar el flag ya no es una operación que nadie quiera hacer sola —corta los pagos—,
 * así que esa razón dejó de sostenerse sola. La que SÍ se sostiene es la INVERSA, y es el paso 3 del
 * orden de despliegue (§11 del Story File): el flag se ENCIENDE en el proveedor con el código todavía
 * sin desplegar, y el deploy tiene que levantar ese valor YA encendido. Congelarlo en el build es lo
 * que rompería ese orden y reabriría la ventana de corte total. Que además se pueda apagar sin
 * re-deployar es un efecto secundario, no el propósito, y sólo es seguro DESPUÉS de haber
 * re-desplegado el código anterior a WKH-333.
 */
export function getKycVerdictStore(): KycVerdictStore | null {
  if (process.env.KYC_VERDICT_STORE_ENABLED !== "true") return null;
  const client = getSupabaseServerClient();
  if (!client) return null;
  return new SupabaseKycVerdictStore(client);
}
