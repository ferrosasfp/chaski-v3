// T-TOK-1/T-TOK-2 — el token at-rest y su filtro de dueño (WKH-233/W2.5, CD-19). Cero red, cero DB.
// T-HF3 — y la sesión que el proveedor devuelve REPETIDA (hotfix 2026-08-20 · F-3).
//
// 🔴 EL DOBLE FILTRA DE VERDAD. No es un `vi.fn().mockResolvedValue(fila)`: aplica los `.eq()`/`.is()`
// que la cadena le pide y el índice único de la tabla, igual que lo haría Postgres. Con un doble que
// aprueba desde arriba, borrar el `.eq("owner_address", …)` del repositorio dejaría estos tests en
// verde: el mutante sobreviviría y el IDOR entraría a producción con la suite aplaudiendo. Exemplar:
// `supabase-kyc-verdicts.test.ts`.
//
// ⚠️ EL DOBLE YA NO VIVE ACÁ: se mudó a `src/test-support/kyc-session-tokens-db.ts` cuando F-3 sumó
// una segunda suite que lo necesita (la route corriendo contra el store REAL). Dos copias del mismo
// doble es cómo se desincronizan dos verdes. Su cabecera dice qué aplica y qué NO (no es Postgres:
// sin transacciones, sin concurrencia, sin triggers).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SupabaseKycSessionTokenStore,
  getKycSessionTokenStore,
} from "./supabase-kyc-session-tokens";
import { __resetSupabaseClient } from "./supabase-server";
import {
  type KycSessionTokenRow,
  makeKycSessionTokensDb,
} from "../../test-support/kyc-session-tokens-db";

// Pubkeys base58 REALES y fijas: reproducibles corrida a corrida, y `canonicalizeAddress` las acepta.
const OWNER_A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OWNER_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type Row = KycSessionTokenRow;

/**
 * El store REAL sobre el doble COMPARTIDO (`src/test-support/kyc-session-tokens-db.ts`) — el mismo
 * que usa `app/api/kyc/session/route.test.ts` en T-HF3-R. Su cabecera dice qué aplica (el índice
 * único y el `WHERE`) y qué no (no es Postgres: sin transacciones, sin concurrencia, sin triggers).
 */
function makeStore(seed: Row[], opts: Parameters<typeof makeKycSessionTokensDb>[1] = {}) {
  const db = makeKycSessionTokensDb(seed, opts);
  return { store: new SupabaseKycSessionTokenStore(db.client), ...db };
}

/**
 * El desenlace de un `put`, como STRING, sin assertion de por medio.
 *
 * 🔴 EXISTE POR EL ORDEN DE LOS `expect`, y el orden es la mitad del valor del test. Con
 * `await expect(...).rejects.toThrow(...)` primero, un mutante que REESCRIBE la fila y además
 * resuelve muere con «promise resolved "undefined" instead of rejecting» — cierto, pero no dice lo
 * único que importa: que la sesión de otra persona quedó reatada. Capturando el desenlace acá, los
 * `expect` que leen LA FILA corren PRIMERO y el mensaje del mutante es el del daño.
 */
async function desenlaceDe(p: Promise<void>): Promise<string> {
  try {
    await p;
    return "RESOLVIÓ SIN ERROR";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
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

describe("`probeReachable` — el pre-vuelo que corre ANTES de gastar cuota (hotfix 2026-08-20 · F-2)", () => {
  it("con la tabla ausente TIRA con el SQLSTATE, y NO ecoa el message del driver", async () => {
    const { store } = makeStore([], { failOn: "select", errorCode: "42P01" });
    // 42P01 = la tabla no existe ⇒ falta la migración. Es una misconfig NUESTRA, y el punto del
    // pre-vuelo es que se sepa ANTES de crear la sesión en el proveedor.
    await expect(store.probeReachable()).rejects.toThrow(/kyc_session_token_probe_failed:42P01/);
    await expect(store.probeReachable()).rejects.not.toThrow(/boom-secreto/);
  });

  it("la etiqueta es PROPIA: `probe_failed`, nunca `write_failed` (son dos momentos distintos)", async () => {
    const { store } = makeStore([], { failOn: "select", errorCode: "42501" });
    // 🧬 MUTANTE: reusar `kyc_session_token_write_failed` acá ⇒ ROJO. Y el mutante importa: la
    // etiqueta es lo único que le dice a quien lee el log si la cuota del proveedor SE GASTÓ o no.
    await expect(store.probeReachable()).rejects.not.toThrow(/write_failed/);
  });

  it("✅ calibración: con la tabla sana NO tira, y NO devuelve ninguna fila", async () => {
    const { store } = makeStore([
      { session_id: "ses-A", decision_token: "k1.token-de-A", owner_address: OWNER_A },
    ]);
    // Devuelve `void` a propósito: `data` no sale de la función, así que no hay fila que un dueño
    // equivocado pueda leer (no es la lectura sin filtro que vigila G-5).
    await expect(store.probeReachable()).resolves.toBeUndefined();
  });

  it("⚠️ NO ejercita el INSERT, y por eso el `put` puede fallar igual después (declarado, no tapado)", async () => {
    // El doble falla SÓLO en el insert: el pre-vuelo pasa y el `put` tira. Es exactamente la clase de
    // fallo que este pre-vuelo NO cubre y que sigue ocurriendo DESPUÉS de gastar la cuota.
    //
    // ⚠️ ACÁ DECÍA `23505`, Y EL HOTFIX F-3 LO VOLVIÓ FALSO — se cambia la sonda, no el punto. Desde
    // F-3, un `session_id` duplicado YA NO es un fallo de escritura: es "esa sesión ya existe", y
    // `put` la ATA o la RECHAZA por dueño (`kyc_session_owner_conflict`). Este `it` mide otra cosa
    // —que un `select` no prueba que el `insert` vaya a andar—, así que la sonda pasa a `42501`
    // (`insufficient_privilege`: un GRANT que da SELECT y niega INSERT), que es la MISMA clase de
    // fallo, sigue siendo invisible para el pre-vuelo, y sigue ocurriendo después de la cuota.
    const { store } = makeStore([], { failOn: "insert", errorCode: "42501" });
    await expect(store.probeReachable()).resolves.toBeUndefined();
    await expect(
      store.put({ sessionId: "ses-9", decisionToken: "k1.t", ownerAddress: null }),
    ).rejects.toThrow(/kyc_session_token_write_failed:42501/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
//  T-HF3 — LA SESIÓN QUE EL PROVEEDOR DEVUELVE REPETIDA (hotfix 2026-08-20 · F-3)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// EL INCIDENTE, con su hora: 21:22:14 UTC entró una sesión SIN ATAR; 21:43:40 UTC el proveedor
// devolvió LA MISMA sesión, ahora con prueba de posesión, y el `insert` pelado murió con `23505`
// (`kyc_session_token_write_failed { atada: true, dbCode: '23505' }`). Medido contra bdwv: 5 filas,
// los 5 `session_id` distintos ⇒ la fila que falló nunca entró y la persona no pudo verificarse.
//
// 🔴 LO QUE ESTOS `it` MIDEN NO ES "QUE NO FALLE": es que el arreglo NO sea un `upsert` ingenuo.
// Un `upsert(..., { onConflict: "session_id" })` pasaría el primer `it` de acá abajo y convertiría
// esta tabla —que guarda la credencial que gatea el desembolso— en algo que una segunda llamada
// puede reatar a otra persona. Por eso cada caso permitido viene con su caso PROHIBIDO al lado, y
// el prohibido se verifica LEYENDO LA FILA DESPUÉS, no mirando si la promesa se rechazó.
describe("T-HF3 · `put` sobre una sesión que YA existe — atar sí, secuestrar no", () => {
  const TOKEN_1 = "k1.token-de-la-primera-llamada";
  const TOKEN_2 = "k1.token-de-la-sesion-repetida";

  it("T-HF3-1 · NULL → dirección: ATA la fila que la primera llamada dejó sin atar", async () => {
    const { store, rows, inserted } = makeStore([]);
    // 21:22:14 — sin prueba de posesión.
    await store.put({ sessionId: "ses-1", decisionToken: TOKEN_1, ownerAddress: null });
    // 21:43:40 — el proveedor devuelve LA MISMA sesión, ahora con PoP. Esto es lo que daba 23505.
    // 🧬 MUTANTE: volver `put` al `insert` pelado de antes ⇒ ROJO acá con `..._write_failed:23505`,
    // que es LITERALMENTE el error de producción.
    await expect(
      store.put({ sessionId: "ses-1", decisionToken: TOKEN_2, ownerAddress: OWNER_A }),
    ).resolves.toBeUndefined();
    expect(rows).toHaveLength(1); // no duplicó la sesión
    expect(inserted).toHaveLength(1); // el segundo `put` NO insertó: actualizó
    expect(rows[0]?.owner_address).toBe(OWNER_A);
    // Y desde el producto, no sólo desde el doble:
    expect(await store.getForOwner("ses-1", OWNER_A)).toBe(TOKEN_2);
  });

  it("T-HF3-2 · dirección A → dirección B: FALLA CERRADO, y la fila NO se reescribe", async () => {
    const { store, rows } = makeStore([
      { session_id: "ses-1", decision_token: TOKEN_1, owner_address: OWNER_A },
    ]);
    // 🧬 MUTANTE (el que importa): cambiar el `.is("owner_address", null)` del intento que ATA por un
    // `upsert`/un update sin guard de dueño ⇒ este `it` se pone ROJO con el mensaje:
    //   «la sesión de otra persona quedó reatada: su `owner_address` cambió de A a B. Con esa fila,
    //    B autoriza el desembolso de A»
    const desenlace = await desenlaceDe(
      store.put({ sessionId: "ses-1", decisionToken: TOKEN_2, ownerAddress: OWNER_B }),
    );

    // 🔴 LA MITAD QUE VALE, Y VA PRIMERO: se LEE LA FILA DESPUÉS DEL INTENTO. Un `rejects.toThrow`
    // solo no distingue "rechazó sin escribir" de "escribió y después tiró".
    expect(
      rows[0]?.owner_address,
      "la sesión de otra persona quedó REATADA: su `owner_address` pasó de A a B. Con esa fila, B " +
        "autoriza el desembolso de A",
    ).toBe(OWNER_A);
    expect(
      rows[0]?.decision_token,
      "la credencial de A quedó pisada por la de la segunda llamada",
    ).toBe(TOKEN_1);
    expect(
      desenlace,
      "no falló cerrado: `put` aceptó una segunda llamada sobre la sesión de OTRA dirección",
    ).toBe("kyc_session_owner_conflict");
    // Y el guard del money-path sigue diciendo lo mismo que antes del intento:
    expect(await store.getForOwner("ses-1", OWNER_B)).toBeNull();
    expect(await store.getForOwner("ses-1", OWNER_A)).toBe(TOKEN_1);
  });

  it("T-HF3-3 · dirección A → la MISMA dirección A: idempotente, no es un error", async () => {
    const { store, rows } = makeStore([
      { session_id: "ses-1", decision_token: TOKEN_1, owner_address: OWNER_A },
    ]);
    // 🧬 MUTANTE: hacer que el conflicto se dispare por "la fila ya tiene dueño" sin comparar CUÁL
    // ⇒ ROJO acá. Fail-closed no puede significar "nadie puede reintentar nunca": el proveedor
    // devuelve la misma sesión también cuando es la misma persona.
    await expect(
      store.put({ sessionId: "ses-1", decisionToken: TOKEN_2, ownerAddress: OWNER_A }),
    ).resolves.toBeUndefined();
    expect(rows[0]?.owner_address).toBe(OWNER_A);
  });

  it("T-HF3-4 · el `decision_token` SE ACTUALIZA (la sesión repetida trae uno nuevo)", async () => {
    // Las TRES transiciones permitidas tienen que refrescar la credencial: si el agente emitió otra,
    // la vieja puede no servir para leer el veredicto, y sin veredicto no hay desembolso.
    // 🧬 MUTANTE: sacar `decision_token` del `patch` (dejar sólo `updated_at`) ⇒ ROJO en las tres.
    const casos: Array<[string, string | null, string | null]> = [
      ["atando una sesión sin atar", null, OWNER_A],
      ["repitiendo el MISMO dueño", OWNER_A, OWNER_A],
      ["repitiendo una sesión SIN ATAR", null, null],
    ];
    for (const [caso, duenoPrevio, duenoNuevo] of casos) {
      const { store, rows } = makeStore([
        { session_id: "ses-1", decision_token: TOKEN_1, owner_address: duenoPrevio },
      ]);
      await store.put({ sessionId: "ses-1", decisionToken: TOKEN_2, ownerAddress: duenoNuevo });
      expect(rows[0]?.decision_token, `no se refrescó el token ${caso}`).toBe(TOKEN_2);
      expect(rows[0]?.owner_address, `cambió el dueño ${caso}`).toBe(duenoNuevo ?? duenoPrevio);
      // `updated_at` se escribe a mano porque su `default now()` sólo corre en el INSERT.
      expect(typeof rows[0]?.updated_at, `no se movió updated_at ${caso}`).toBe("string");
    }
  });

  it("T-HF3-5 · SIN dirección probada sobre una fila YA ATADA: falla cerrado, no la desata", async () => {
    const { store, rows } = makeStore([
      { session_id: "ses-1", decision_token: TOKEN_1, owner_address: OWNER_A },
    ]);
    // Quien no prueba posesión de la billetera no puede tocar la sesión de quien sí la probó — ni
    // para borrarle el dueño, ni para refrescarle la credencial en silencio.
    // 🧬 MUTANTE: que el intento sin dueño filtre sólo por `session_id` ⇒ ROJO con «se desató» o con
    // «se le refrescó la credencial a una sesión ajena sin probar posesión».
    const desenlace = await desenlaceDe(
      store.put({ sessionId: "ses-1", decisionToken: TOKEN_2, ownerAddress: null }),
    );
    expect(rows[0]?.owner_address, "se DESATÓ una sesión que estaba atada").toBe(OWNER_A);
    expect(
      rows[0]?.decision_token,
      "se le refrescó la credencial a una sesión ajena sin probar posesión de la billetera",
    ).toBe(TOKEN_1);
    expect(desenlace, "no falló cerrado sobre una fila ya atada").toBe("kyc_session_owner_conflict");
  });

  it("T-HF3-6 · el intento del MISMO dueño ni siquiera manda `owner_address` en el payload", async () => {
    const { store, updates } = makeStore([
      { session_id: "ses-1", decision_token: TOKEN_1, owner_address: OWNER_A },
    ]);
    await store.put({ sessionId: "ses-1", decisionToken: TOKEN_2, ownerAddress: OWNER_A });
    // Son DOS updates: (1) intentar ATAR — 0 filas, la fila ya tiene dueño; (2) el mismo dueño.
    expect(updates).toHaveLength(2);
    expect(updates[0]?.afectadas).toBe(0);
    expect(updates[0]?.filtros).toEqual([
      { col: "session_id", val: "ses-1", op: "eq" },
      { col: "owner_address", val: null, op: "is" },
    ]);
    expect(updates[1]?.afectadas).toBe(1);
    expect(updates[1]?.filtros).toEqual([
      { col: "session_id", val: "ses-1", op: "eq" },
      { col: "owner_address", val: OWNER_A, op: "eq" },
    ]);
    // 🧬 MUTANTE: agregar `owner_address` al payload de este segundo intento ⇒ ROJO. Hoy ese camino
    // es ESTRUCTURALMENTE incapaz de cambiar de dueño, no sólo improbable: no manda la columna.
    expect(
      Object.keys(updates[1]?.patch ?? {}).sort(),
      "el intento del dueño repetido pasó a poder escribir `owner_address`",
    ).toEqual(["decision_token", "updated_at"]);
  });

  it("T-HF3-7 · un fallo del driver en el UPDATE sale como `write_failed:<SQLSTATE>`, sin el message", async () => {
    const { store } = makeStore(
      [{ session_id: "ses-1", decision_token: TOKEN_1, owner_address: null }],
      { failOn: "update", errorCode: "42501" },
    );
    // Un problema de infra en el camino nuevo NO puede disfrazarse de conflicto de dueño: se
    // arreglan distinto (uno es un GRANT, el otro es quién pide la sesión de quién).
    await expect(
      store.put({ sessionId: "ses-1", decisionToken: TOKEN_2, ownerAddress: OWNER_A }),
    ).rejects.toThrow(/kyc_session_token_write_failed:42501/);
    await expect(
      store.put({ sessionId: "ses-1", decisionToken: TOKEN_2, ownerAddress: OWNER_A }),
    ).rejects.not.toThrow(/boom-secreto/);
  });

  it("T-HF3-8 · un `insert` que falla por OTRA cosa que 23505 no intenta ningún UPDATE", async () => {
    const { store, updates } = makeStore([], { failOn: "insert", errorCode: "42P01" });
    // 42P01 = falta la tabla. ⛔ No es "la fila ya existe": no hay nada que atar, y reintentar por
    // otro camino sólo enmascararía la misconfig.
    await expect(
      store.put({ sessionId: "ses-1", decisionToken: TOKEN_1, ownerAddress: OWNER_A }),
    ).rejects.toThrow(/kyc_session_token_write_failed:42P01/);
    expect(updates).toHaveLength(0);
  });

  it("T-HF3-9 · ✅ calibración: el camino de siempre —sesión NUEVA— sigue siendo UN insert y CERO updates", async () => {
    const { store, inserted, updates } = makeStore([]);
    // Sin esto, todo lo de arriba daría verde también si `put` hubiera dejado de insertar y
    // resolviera siempre por update: el caso normal (una sesión que no existía) es el 99%.
    await store.put({ sessionId: "ses-nueva", decisionToken: TOKEN_1, ownerAddress: OWNER_A });
    expect(inserted).toEqual([
      { session_id: "ses-nueva", decision_token: TOKEN_1, owner_address: OWNER_A },
    ]);
    expect(updates).toHaveLength(0);
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
