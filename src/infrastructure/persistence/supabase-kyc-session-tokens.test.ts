// T-TOK-1/T-TOK-2 — el token at-rest y su filtro de dueño (WKH-233/W2.5, CD-19). Cero red, cero DB.
//
// 🔴 EL DOBLE FILTRA DE VERDAD. No es un `vi.fn().mockResolvedValue(fila)`: es un mini-store con dos
// dueños que APLICA los `.eq()` que la cadena le pide, igual que lo haría Postgres. Con un doble que
// aprueba desde arriba, borrar el `.eq("owner_address", …)` del repositorio dejaría estos tests en
// verde: el mutante sobreviviría y el IDOR entraría a producción con la suite aplaudiendo. Exemplar:
// `supabase-kyc-verdicts.test.ts`.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SupabaseKycSessionTokenStore,
  getKycSessionTokenStore,
} from "./supabase-kyc-session-tokens";
import { __resetSupabaseClient } from "./supabase-server";

// Pubkeys base58 REALES y fijas: reproducibles corrida a corrida, y `canonicalizeAddress` las acepta.
const OWNER_A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OWNER_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface Row {
  session_id: string;
  decision_token: string;
  owner_address: string | null;
}

function makeStore(seed: Row[], opts: { failOn?: "select" | "insert"; errorCode?: string } = {}) {
  const rows = [...seed];
  const eqCalls: Array<[string, unknown]> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const client = {
    from: vi.fn(() => {
      let verb: "select" | "insert" | null = null;
      const filters: Array<{ col: string; val: unknown }> = [];
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
        if (rows.some((r) => r.session_id === payload.session_id)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        inserted.push(payload);
        rows.push(payload as unknown as Row);
        return { data: null, error: null };
      };
      const builder: Record<string, unknown> = {};
      builder.maybeSingle = vi.fn(() => builder);
      builder.eq = vi.fn((col: string, val: unknown) => {
        eqCalls.push([col, val]);
        filters.push({ col, val });
        return builder;
      });
      // biome-ignore lint/suspicious/noThenProperty: thenable intencional, replica supabase-js.
      builder.then = (resolve: (v: unknown) => void) => resolve(settle());
      builder.select = vi.fn(() => {
        verb ??= "select";
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
    store: new SupabaseKycSessionTokenStore(client as unknown as SupabaseClient),
    rows,
    eqCalls,
    inserted,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  __resetSupabaseClient();
});

describe("T-TOK-1 · CD-19 — `getForOwner` AÍSLA: el filtro por dueño es el guard, no un adorno", () => {
  const semilla: Row[] = [
    { session_id: "ses-A", decision_token: "k1.token-de-A", owner_address: OWNER_A },
    { session_id: "ses-B", decision_token: "k1.token-de-B", owner_address: OWNER_B },
  ];

  it("pedir la sesión de A con el `ownerAddress` de B ⇒ `null` (no la fila ajena)", async () => {
    const { store } = makeStore(semilla);
    // 🧬 MUTANTE: borrar el `.eq("owner_address", …)` ⇒ devuelve `k1.token-de-A` ⇒ ROJO.
    // Y el mutante NO es teórico: ese token es lo único que autoriza un desembolso de esa sesión.
    expect(await store.getForOwner("ses-A", OWNER_B)).toBeNull();
  });

  it("✅ calibración inversa: con el dueño CORRECTO devuelve SU token (no deniega todo)", async () => {
    const { store } = makeStore(semilla);
    expect(await store.getForOwner("ses-A", OWNER_A)).toBe("k1.token-de-A");
    expect(await store.getForOwner("ses-B", OWNER_B)).toBe("k1.token-de-B");
  });

  it("la cadena filtra por los DOS: `session_id` y `owner_address` CANONICALIZADO", async () => {
    const { store, eqCalls } = makeStore(semilla);
    await store.getForOwner("ses-A", OWNER_A);
    expect(eqCalls).toEqual([
      ["session_id", "ses-A"],
      ["owner_address", OWNER_A],
    ]);
  });

  it("una address malformada TIRA antes de tocar la base (fail-closed, no filtra por basura)", async () => {
    const { store, eqCalls } = makeStore(semilla);
    await expect(store.getForOwner("ses-A", "no-es-base58!!")).rejects.toThrow(
      /address_canonicalization_failed/,
    );
    expect(eqCalls).toHaveLength(0);
  });

  it("un error del driver NO ecoa el message (puede traer el valor del filtro): sólo el SQLSTATE", async () => {
    const { store } = makeStore(semilla, { failOn: "select", errorCode: "42P01" });
    await expect(store.getForOwner("ses-A", OWNER_A)).rejects.toThrow(
      /kyc_session_token_read_failed:42P01/,
    );
    await expect(store.getForOwner("ses-A", OWNER_A)).rejects.not.toThrow(/boom-secreto/);
  });

  it("`getForOwner` devuelve EL TOKEN y nada más (nunca el row: ni `owner_address`)", async () => {
    const { store } = makeStore(semilla);
    expect(typeof (await store.getForOwner("ses-A", OWNER_A))).toBe("string");
  });
});

describe("T-TOK-2 · una sesión SIN ATAR (owner_address NULL) jamás autoriza un desembolso", () => {
  const semilla: Row[] = [
    { session_id: "ses-sin-atar", decision_token: "k1.token-sin-atar", owner_address: null },
  ];

  it.each([
    ["el dueño A", OWNER_A],
    ["el dueño B", OWNER_B],
  ])("`getForOwner` con %s ⇒ `null` (un `.eq` NUNCA matchea un NULL)", async (_c, addr) => {
    const { store } = makeStore(semilla);
    // 🧬 MUTANTE: que el doble haga matchear el `null` (o que el store omita el filtro) ⇒ ROJO.
    // Esto es lo que hace que `owner_address` nullable REFUERCE el guard en vez de debilitarlo.
    expect(await store.getForOwner("ses-sin-atar", addr)).toBeNull();
  });

  it("✅ y sin embargo `readForVerifiedSession` SÍ la devuelve, con `ownerAddress: null`", async () => {
    const { store } = makeStore(semilla);
    // Es la excepción declarada de CD-19: el camino de PANTALLA no tiene dueño al que filtrar, y su
    // guard equivalente (el HMAC) corre ANTES. Sin esta mitad, quien no firmó no podría leer su
    // propio veredicto — el agujero que costó un bloqueante cerrar.
    expect(await store.readForVerifiedSession("ses-sin-atar")).toEqual({
      token: "k1.token-sin-atar",
      ownerAddress: null,
    });
  });

  it("`readForVerifiedSession` de una sesión inexistente ⇒ `null`", async () => {
    const { store } = makeStore(semilla);
    expect(await store.readForVerifiedSession("ses-que-no-existe")).toBeNull();
  });

  it("`readForVerifiedSession` NO filtra por dueño (por eso es la excepción, y por eso G-5 la vigila)", async () => {
    const { store, eqCalls } = makeStore(semilla);
    await store.readForVerifiedSession("ses-sin-atar");
    expect(eqCalls).toEqual([["session_id", "ses-sin-atar"]]);
  });
});

describe("`put` — el dueño se escribe PROBADO o NULL, nunca rellenado", () => {
  it("con dirección probada, la escribe canonicalizada", async () => {
    const { store, inserted } = makeStore([]);
    await store.put({ sessionId: "ses-1", decisionToken: "k1.t", ownerAddress: OWNER_A });
    expect(inserted[0]).toEqual({
      session_id: "ses-1",
      decision_token: "k1.t",
      owner_address: OWNER_A,
    });
  });

  it("sin dirección probada escribe `null` de verdad (⛔ ningún centinela)", async () => {
    const { store, inserted } = makeStore([]);
    await store.put({ sessionId: "ses-2", decisionToken: "k1.t", ownerAddress: null });
    expect(inserted[0]?.owner_address).toBeNull();
  });

  it("un fallo de escritura TIRA (su call site lo convierte en 503, NO es best-effort)", async () => {
    const { store } = makeStore([], { failOn: "insert", errorCode: "42P01" });
    await expect(
      store.put({ sessionId: "ses-3", decisionToken: "k1.t", ownerAddress: null }),
    ).rejects.toThrow(/kyc_session_token_write_failed:42P01/);
  });

  it("una address malformada TIRA y no escribe nada", async () => {
    const { store, inserted } = makeStore([]);
    await expect(
      store.put({ sessionId: "ses-4", decisionToken: "k1.t", ownerAddress: "$$$" }),
    ).rejects.toThrow(/address_canonicalization_failed/);
    expect(inserted).toHaveLength(0);
  });
});

describe("`getKycSessionTokenStore` — sin envs de Supabase devuelve null (misconfig NUESTRA)", () => {
  it("sin SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ⇒ null", () => {
    vi.stubEnv("SUPABASE_URL", undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    __resetSupabaseClient();
    expect(getKycSessionTokenStore()).toBeNull();
  });

  it("✅ con las dos envs devuelve un store (el `null` no es incondicional)", () => {
    vi.stubEnv("SUPABASE_URL", "https://proyecto.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key-de-prueba");
    __resetSupabaseClient();
    expect(getKycSessionTokenStore()).toBeInstanceOf(SupabaseKycSessionTokenStore);
  });
});
