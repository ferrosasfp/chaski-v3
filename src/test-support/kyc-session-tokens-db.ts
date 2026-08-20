// Doble de la tabla `kyc_session_tokens` — un mini-Postgres en memoria, SÓLO PARA TESTS.
//
// ⛔ NO ES CÓDIGO DE PRODUCCIÓN y nada de `src/` fuera de los tests lo importa. Vive acá —y no
// dentro de un `*.test.ts`— por UN motivo concreto: lo usan DOS suites (el store, y la route de
// `/api/kyc/session` corriendo contra el store REAL vía `vi.importActual`), y dos copias del mismo
// doble son exactamente cómo se desincronizan los dos verdes. Es el mismo criterio que ya escribió
// `fakes.ts` para la allowlist de proveniencias ("un segundo Set con los mismos valores es
// exactamente cómo se desincronizan las dos capas").
//
// 🔴 APLICA EL ÍNDICE ÚNICO Y APLICA EL `WHERE` — las dos cosas, y por eso sirve para medir el
// hotfix 2026-08-20 · F-3. Un `insert` sobre un `session_id` que ya está devuelve `23505` igual que
// Postgres (el SQLSTATE literal del incidente de las 21:43:40 UTC), y un `update` sólo toca las
// filas que cumplen TODOS los filtros de la cadena, incluido `.is("owner_address", null)`. Con un
// doble que acepte cualquier escritura, el mutante que convierte el guard en un `upsert` ingenuo
// sobreviviría y el secuestro de identidad entraría a producción con la suite en verde.
//
// ⚠️ LO QUE ESTE DOBLE **NO** ES: no es Postgres. No tiene transacciones, no tiene concurrencia real
// y no ejecuta triggers — así que el candado de base
// (`supabase/migrations/20260820T000000_kyc_session_tokens_owner_binding_immutable.sql`) NO se mide
// acá, y no hay ningún verde de este archivo que se pueda leer como "el trigger anda".
//
// Verbos soportados: `select` (+`eq`/`is`/`limit`/`maybeSingle`), `insert` (con el índice único),
// `update` (+`eq`/`is`, y `select()` DESPUÉS del update devuelve las filas AFECTADAS, que es como
// supabase-js informa cuántas fueron).
import type { SupabaseClient } from "@supabase/supabase-js";

export interface KycSessionTokenRow {
  session_id: string;
  decision_token: string;
  owner_address: string | null;
  updated_at?: string;
}

export function makeKycSessionTokensDb(
  seed: KycSessionTokenRow[],
  opts: { failOn?: "select" | "insert" | "update"; errorCode?: string } = {},
) {
  const rows: KycSessionTokenRow[] = seed.map((r) => ({ ...r }));
  const eqCalls: Array<[string, unknown]> = [];
  const isCalls: Array<[string, unknown]> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const updates: Array<{
    patch: Record<string, unknown>;
    filtros: Array<{ col: string; val: unknown; op: "eq" | "is" }>;
    afectadas: number;
  }> = [];
  const client = {
    from: (() => {
      let verb: "select" | "insert" | "update" | null = null;
      const filters: Array<{ col: string; val: unknown; op: "eq" | "is" }> = [];
      let payload: Record<string, unknown> = {};
      const matched = () =>
        rows.filter((r) =>
          filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.val),
        );
      const settle = (): { data: unknown; error: unknown } => {
        if (opts.failOn === verb) {
          return { data: null, error: { code: opts.errorCode ?? "42P01", message: "boom-secreto" } };
        }
        if (verb === "select") {
          const hit = matched()[0];
          return { data: hit ? { ...hit } : null, error: null };
        }
        if (verb === "update") {
          // El `WHERE` de verdad: sólo las filas que cumplen TODOS los filtros. Devuelve las
          // AFECTADAS (lo que `.select()` después de un PATCH trae en supabase-js).
          const hits = matched();
          for (const r of hits) Object.assign(r, payload);
          updates.push({ patch: { ...payload }, filtros: [...filters], afectadas: hits.length });
          return { data: hits.map((r) => ({ session_id: r.session_id })), error: null };
        }
        if (rows.some((r) => r.session_id === payload.session_id)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        inserted.push(payload);
        rows.push(payload as unknown as KycSessionTokenRow);
        return { data: null, error: null };
      };
      const builder: Record<string, unknown> = {};
      builder.maybeSingle = (() => builder);
      // hotfix 2026-08-20 · F-2: lo usa el pre-vuelo `probeReachable`.
      builder.limit = (() => builder);
      builder.eq = ((col: string, val: unknown) => {
        eqCalls.push([col, val]);
        filters.push({ col, val, op: "eq" });
        return builder;
      });
      // hotfix 2026-08-20 · F-3: el guard "sólo si NO tiene dueño" del camino que ATA.
      builder.is = ((col: string, val: unknown) => {
        isCalls.push([col, val]);
        filters.push({ col, val, op: "is" });
        return builder;
      });
      // biome-ignore lint/suspicious/noThenProperty: thenable intencional, replica supabase-js.
      builder.then = (resolve: (v: unknown) => void) => resolve(settle());
      builder.select = (() => {
        verb ??= "select";
        return builder;
      });
      builder.insert = ((p: Record<string, unknown>) => {
        verb ??= "insert";
        payload = p;
        return builder;
      });
      builder.update = ((p: Record<string, unknown>) => {
        verb ??= "update";
        payload = p;
        return builder;
      });
      return builder;
    }),
  };
  return {
    client: client as unknown as SupabaseClient,
    rows,
    eqCalls,
    isCalls,
    inserted,
    updates,
  };
}
