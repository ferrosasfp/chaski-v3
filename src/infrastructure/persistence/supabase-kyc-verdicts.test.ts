// Tests — SupabaseKycVerdictStore + getKycVerdictStore (WKH-333 W1). Cero red, cero DB.
//
// 🔴 EL DOBLE FILTRA DE VERDAD (CD-17). No es un `vi.fn().mockResolvedValue(fila)`: es un mini-store
// con DOS dueños que aplica los `.eq()` / `.neq()` que la cadena le pide, igual que lo haría
// Postgres. Con un doble que aprueba desde arriba, borrar el `.eq("sender_address", …)` del
// repositorio (M-1) dejaría estos tests en verde: el mutante sobreviviría y el IDOR entraría a
// producción con la suite aplaudiendo. Ese es exactamente el aviso de
// `app/api/solana/escrow/remittance-ids/route.test.ts:5-7`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseKycVerdictStore, getKycVerdictStore } from "./supabase-kyc-verdicts";
import { __resetSupabaseClient } from "./supabase-server";

// Pubkeys base58 REALES y fijas: reproducibles corrida a corrida, y `canonicalizeAddress` las acepta.
const OWNER_A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OWNER_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface Row {
  id: string;
  sender_address: string;
  verification_id: string;
  approved: boolean;
  risk_level: string;
  provenance: string;
  verified_at: string;
  updated_at: string;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: `id-${over.sender_address ?? OWNER_A}`,
    sender_address: OWNER_A,
    verification_id: "did-1",
    approved: true,
    risk_level: "low",
    provenance: "didit",
    verified_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** Mini-Postgres honesto: guarda filas, aplica los filtros que la cadena declara, y respeta el índice
 *  único sobre `sender_address` (23505). Registra además los argumentos, para poder afirmar CUÁL
 *  valor se filtró y no sólo que se filtró algo. */
function makeStore(
  seed: Row[],
  opts: { failOn?: "select" | "update" | "insert"; errorCode?: string } = {},
) {
  const rows = [...seed];
  const eqCalls: Array<[string, unknown]> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];

  const client = {
    from: vi.fn(() => {
      let verb: "select" | "update" | "insert" | null = null;
      const filters: Array<{ op: "eq" | "neq"; col: string; val: unknown }> = [];
      let payload: Record<string, unknown> = {};

      const matched = () =>
        rows.filter((r) =>
          filters.every((f) => {
            const cur = (r as unknown as Record<string, unknown>)[f.col];
            return f.op === "eq" ? cur === f.val : cur !== f.val;
          }),
        );

      const settle = (): { data: unknown; error: unknown } => {
        if (opts.failOn === verb) {
          return { data: null, error: { code: opts.errorCode ?? "08006", message: "boom-secreto" } };
        }
        if (verb === "select") {
          const hit = matched()[0];
          return { data: hit ? { ...hit } : null, error: null };
        }
        if (verb === "update") {
          const hits = matched();
          for (const h of hits) Object.assign(h, payload);
          updated.push(payload);
          return { data: hits.map((h) => ({ id: h.id })), error: null };
        }
        // insert — el índice único sobre sender_address es lo que produce 23505.
        if (rows.some((r) => r.sender_address === payload.sender_address)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        inserted.push(payload);
        rows.push(row(payload as Partial<Row>));
        return { data: null, error: null };
      };

      const builder: Record<string, unknown> = {};
      builder.maybeSingle = vi.fn(() => builder);
      builder.eq = vi.fn((col: string, val: unknown) => {
        eqCalls.push([col, val]);
        filters.push({ op: "eq", col, val });
        return builder;
      });
      builder.neq = vi.fn((col: string, val: unknown) => {
        filters.push({ op: "neq", col, val });
        return builder;
      });
      // biome-ignore lint/suspicious/noThenProperty: thenable intencional, replica supabase-js.
      builder.then = (resolve: (v: unknown) => void) => resolve(settle());

      // El verbo lo fija la PRIMERA llamada del encadenamiento: `.select(...)` de entrada es una
      // lectura; el `.select("id")` que cuelga de un `.update(...)` no lo pisa (por eso el `??=`).
      builder.select = vi.fn(() => {
        verb ??= "select";
        return builder;
      });
      builder.update = vi.fn((p: Record<string, unknown>) => {
        verb ??= "update";
        payload = p;
        return builder;
      });
      builder.insert = vi.fn((p: Record<string, unknown>) => {
        verb ??= "insert";
        payload = p;
        return builder;
      });
      return builder;
    }),
  };
  return {
    store: new SupabaseKycVerdictStore(client as unknown as SupabaseClient),
    rows,
    eqCalls,
    inserted,
    updated,
  };
}

describe("SupabaseKycVerdictStore — lectura owner-scoped (WKH-333/AC-1, CD-5)", () => {
  // ── T-REPO-1 ─────────────────────────────────────────────────────────────────────────────────
  it("T-REPO-1: con DOS dueños sembrados, cada uno lee SÓLO su fila (M-1)", async () => {
    const { store, eqCalls } = makeStore([
      row({ sender_address: OWNER_A, verification_id: "did-A" }),
      row({ sender_address: OWNER_B, verification_id: "did-B" }),
    ]);
    const a = await store.get(OWNER_A);
    expect(
      a?.verificationId,
      "la lectura devolvió el veredicto de OTRA dirección: el service key bypassea RLS, así que sin " +
        "el filtro por dueño cualquiera paga con la verificación de identidad de otra persona",
    ).toBe("did-A");
    const b = await store.get(OWNER_B);
    expect(b?.verificationId).toBe("did-B");
    // Y el filtro se declaró con el valor del caller, no con cualquier valor.
    expect(eqCalls).toContainEqual(["sender_address", OWNER_A]);
    expect(eqCalls).toContainEqual(["sender_address", OWNER_B]);
  });

  // ── T-REPO-2 ─────────────────────────────────────────────────────────────────────────────────
  it("T-REPO-2: base58 es CASE-SENSITIVE — otra capitalización es OTRA dirección (M-23)", async () => {
    // MEDIDO: `OWNER_A.toLowerCase()` sigue siendo base58 de 32 bytes válido, así que
    // `canonicalizeAddress` NO tira — decodifica a otros bytes, o sea a OTRA pubkey. Por eso el
    // invariante que hay que asertar no es "revienta", es "no es la misma llave". (Mi primera
    // versión de este test esperaba un throw y midió que no lo hay; ver auto-blindaje.)
    const lower = OWNER_A.toLowerCase();
    expect(lower).not.toBe(OWNER_A);

    // 1) Preguntar por la lowercased NO trae la fila de la original.
    const { store } = makeStore([row({ sender_address: OWNER_A, verification_id: "did-A" })]);
    expect(
      await store.get(lower),
      "una address lowercased se resolvió a la fila de la original: lowercasear base58 colapsa dos " +
        "direcciones distintas en una llave y expone el veredicto de un tercero",
    ).toBeNull();

    // 2) Y al revés: si la fila estuviera guardada lowercased, el dueño real NO la levanta. Es el
    //    input que mata a M-23 (`.toLowerCase()` antes del `.eq`): con el mutante, ESTA lectura
    //    devolvería "did-lower".
    const { store: s2 } = makeStore([row({ sender_address: lower, verification_id: "did-lower" })]);
    expect(
      await s2.get(OWNER_A),
      "el repositorio lowercaseó la dirección antes de filtrar: dos billeteras distintas comparten " +
        "llave y una lee el veredicto de identidad de la otra",
    ).toBeNull();
  });

  it("T-REPO-2b: dirección sin fila ⇒ null (no la del otro dueño)", async () => {
    const { store } = makeStore([row({ sender_address: OWNER_B, verification_id: "did-B" })]);
    expect(await store.get(OWNER_A)).toBeNull();
  });

  it("T-REPO-2c: un `risk_level` fuera del conjunto se lee como 'high', nunca como 'low'", async () => {
    const { store } = makeStore([row({ sender_address: OWNER_A, risk_level: "bajo" })]);
    expect(
      (await store.get(OWNER_A))?.riskLevel,
      "una etiqueta de riesgo que este código no conoce se leyó como riesgo bajo: la pantalla " +
        "afirmaría un riesgo que nadie evaluó",
    ).toBe("high");
  });
});

describe("SupabaseKycVerdictStore — escritura CAS (WKH-333, CD-25)", () => {
  // ── T-REPO-3 ─────────────────────────────────────────────────────────────────────────────────
  it("T-REPO-3: sin fila previa ⇒ 'inserted'", async () => {
    const { store, inserted } = makeStore([]);
    const out = await store.put({
      senderAddress: OWNER_A,
      verificationId: "did-1",
      approved: true,
      riskLevel: "low",
      provenance: "didit",
      verifiedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(out).toBe("inserted");
    expect(inserted[0]?.sender_address).toBe(OWNER_A);
  });

  // ── T-REPO-4 ─────────────────────────────────────────────────────────────────────────────────
  it("T-REPO-4: MISMO verification_id ⇒ 'already_recorded' y `verified_at` NO se mueve (M-10)", async () => {
    const { store, rows } = makeStore([
      row({ sender_address: OWNER_A, verification_id: "did-1", verified_at: "2026-01-01T00:00:00.000Z" }),
    ]);
    const out = await store.put({
      senderAddress: OWNER_A,
      verificationId: "did-1",
      approved: true,
      riskLevel: "low",
      provenance: "didit",
      verifiedAt: "2026-08-07T00:00:00.000Z", // el "ahora" de un re-polleo
    });
    expect(out).toBe("already_recorded");
    expect(
      rows[0]?.verified_at,
      "re-escribir la MISMA verificación movió `verified_at`: la route de decisión se pollea hasta 8 " +
        "veces, así que quien deje la pestaña recargando renueva su verificación para siempre y el " +
        "veredicto no vence nunca",
    ).toBe("2026-01-01T00:00:00.000Z");
  });

  // ── T-REPO-5 ─────────────────────────────────────────────────────────────────────────────────
  it("T-REPO-5: OTRO verification_id ⇒ 'replaced' y `verified_at` SÍ se mueve", async () => {
    const { store, rows } = makeStore([
      row({ sender_address: OWNER_A, verification_id: "did-viejo", verified_at: "2026-01-01T00:00:00.000Z" }),
    ]);
    const out = await store.put({
      senderAddress: OWNER_A,
      verificationId: "did-nuevo",
      approved: true,
      riskLevel: "low",
      provenance: "didit",
      verifiedAt: "2026-08-07T00:00:00.000Z",
    });
    expect(out).toBe("replaced");
    expect(
      rows[0]?.verified_at,
      "una verificación NUEVA no movió `verified_at`: el hecho es otro y la fila seguiría venciendo " +
        "según una verificación que ya no es la vigente",
    ).toBe("2026-08-07T00:00:00.000Z");
    expect(rows[0]?.verification_id).toBe("did-nuevo");
  });

  it("T-REPO-5b: el UPDATE de reemplazo NO alcanza la fila de otro dueño (M-1 en la escritura)", async () => {
    const { store, rows } = makeStore([
      row({ sender_address: OWNER_A, verification_id: "did-A" }),
      row({ sender_address: OWNER_B, verification_id: "did-B" }),
    ]);
    await store.put({
      senderAddress: OWNER_A,
      verificationId: "did-A2",
      approved: true,
      riskLevel: "low",
      provenance: "didit",
      verifiedAt: "2026-08-07T00:00:00.000Z",
    });
    expect(
      rows.find((r) => r.sender_address === OWNER_B)?.verification_id,
      "la escritura de una dirección pisó la fila de OTRA: la víctima pasaría a pagar bajo la " +
        "verificación de identidad de un tercero, sin forma de notarlo",
    ).toBe("did-B");
  });

  // ── T-REPO-6 ─────────────────────────────────────────────────────────────────────────────────
  it("T-REPO-6: error de Postgres ⇒ enum estable con el SQLSTATE, SIN eco del mensaje del driver", async () => {
    const { store } = makeStore([], { failOn: "select", errorCode: "42P01" });
    await expect(store.get(OWNER_A)).rejects.toThrow("kyc_verdict_read_failed:42P01");
    const w = makeStore([], { failOn: "insert", errorCode: "08006" });
    await expect(
      w.store.put({
        senderAddress: OWNER_A,
        verificationId: "did-1",
        approved: true,
        riskLevel: "low",
        provenance: "didit",
        verifiedAt: "2026-08-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("kyc_verdict_insert_failed:08006");
    // Y NO el mensaje del driver: puede traer el valor del filtro (una dirección) o el propio id.
    const w2 = makeStore([], { failOn: "insert", errorCode: "08006" });
    await expect(
      w2.store.put({
        senderAddress: OWNER_A,
        verificationId: "did-1",
        approved: true,
        riskLevel: "low",
        provenance: "didit",
        verifiedAt: "2026-08-01T00:00:00.000Z",
      }),
    ).rejects.not.toThrow("boom-secreto");
  });

  // ── T-REPO-7 ─────────────────────────────────────────────────────────────────────────────────
  it("T-REPO-7: el insert NO lleva PII ni columna de vencimiento (M-13, M-14)", async () => {
    const { store, inserted } = makeStore([]);
    await store.put({
      senderAddress: OWNER_A,
      verificationId: "did-1",
      approved: true,
      riskLevel: "low",
      provenance: "didit",
      verifiedAt: "2026-08-01T00:00:00.000Z",
    });
    const cols = Object.keys(inserted[0] ?? {}).sort();
    expect(
      cols,
      "el insert cambió de columnas: cada columna nueva acá es un dato de identidad de una persona " +
        "que pasa a vivir en nuestra base, o un vencimiento congelado que deja de responder a la " +
        "política vigente",
    ).toEqual([
      "approved",
      "provenance",
      "risk_level",
      "sender_address",
      "verification_id",
      "verified_at",
    ]);
    // Explícito, por si la lista de arriba se "arregla" copiando la salida en vez de leyéndola:
    for (const forbidden of [
      "document_number_last4",
      "document_number",
      "document_type",
      "first_name",
      "last_name",
      "date_of_birth",
      "nationality",
      "expires_at",
      "expires_on",
      "valid_until",
    ]) {
      expect(cols, `el insert persiste \`${forbidden}\``).not.toContain(forbidden);
    }
  });
});

describe("getKycVerdictStore — factory flag-gated (WKH-333/AC-12)", () => {
  beforeEach(() => {
    __resetSupabaseClient();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSupabaseClient();
  });

  // ── T-REPO-8 ─────────────────────────────────────────────────────────────────────────────────
  it("T-REPO-8: flag ausente ⇒ null (aunque las envs de Supabase estén)", () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    expect(getKycVerdictStore()).toBeNull();
  });

  it("T-REPO-8b: flag en 'true' pero SIN envs de Supabase ⇒ null (no un cliente a medias)", () => {
    vi.stubEnv("KYC_VERDICT_STORE_ENABLED", "true");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(getKycVerdictStore()).toBeNull();
  });

  it("T-REPO-8c: 'TRUE' y '1' NO encienden — el flag es exactamente 'true'", () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    vi.stubEnv("KYC_VERDICT_STORE_ENABLED", "TRUE");
    expect(getKycVerdictStore()).toBeNull();
    vi.stubEnv("KYC_VERDICT_STORE_ENABLED", "1");
    expect(getKycVerdictStore()).toBeNull();
  });

  it("T-REPO-8d: flag 'true' + envs presentes ⇒ store construido", () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    vi.stubEnv("KYC_VERDICT_STORE_ENABLED", "true");
    expect(getKycVerdictStore()).not.toBeNull();
  });
});
