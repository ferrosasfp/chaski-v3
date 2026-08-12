import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConcurrentModificationError } from "../application/errors";
import { Money } from "../domain/money";
import { type Quote, Remittance } from "../domain/remittance";
import { beneficiary } from "../test-support/fakes";
import { LocalRepo } from "./persistence";

const KEY = "chaski.remittances.v1";
const NOW = "2026-07-11T00:00:00.000Z";

// Stub Storage Map-backed (jsdom NO instalado — env de test = node, sin window). CD-9: tipado
// explícito, sin any. Se limpia en afterEach.
class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
}

let storage: MemStorage;
beforeEach(() => {
  storage = new MemStorage();
  (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: storage };
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const seedQuote: Quote = {
  quoteId: "q",
  send: Money.of(400, "USDC"),
  receive: Money.of(1480, "PEN"),
  feeUsd: Money.of(0.5, "USDC"),
  rate: 3.7,
  etaMinutes: 30,
  expiresAt: "2026-07-11T01:00:00.000Z", // > NOW
  provenance: "fake",
};

function withOwner(id: string, owner: string): Remittance {
  const r = Remittance.create(id, beneficiary(), Money.of(400, "USDC"), NOW);
  r.attachQuote(seedQuote, NOW); // WKH-187: cotiza antes del KYC (created→quoted)
  r.startKyc(NOW, owner); // quoted→kyc_pending, setea ownerAddress
  return r;
}

// WKH-320: estos tests usaban labels `0xAAA`/`0xaaa` como owners y probaban que el scoping por
// wallet era CASE-INSENSITIVE (rama EVM). Esa rama ya no existe: la canonicalización es base58 y
// case-SENSITIVE. Las addresses pasan a ser pubkeys reales; el caso que probaba la
// case-insensibilidad se reemplaza por el que prueba lo contrario (CD-7).
const A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const Z = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // nunca dueña de nada

describe("LocalRepo.list — scope por wallet (AC-5/7, CD-5)", () => {
  it("AC-5: devuelve SOLO entries del address (scoping por owner)", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", A));
    await repo.save(withOwner("b1", B));

    expect((await repo.list(A)).map((s) => s.id)).toEqual(["a1"]);
    // ningún registro de otra wallet
    expect((await repo.list(B)).map((s) => s.id)).toEqual(["b1"]);
    // WKH-320/CD-7: el scoping es CASE-SENSITIVE. Antes este caso probaba que `list` con la misma
    // address en otro case devolvía lo mismo (rama EVM, lowercase). Ahora una variante con otro case
    // es OTRA address: o no matchea, o ni siquiera canonicaliza. Nunca devuelve lo ajeno.
    const altCase = `${A.slice(0, 1)}${A[1] === A[1]!.toLowerCase() ? A[1]!.toUpperCase() : A[1]!.toLowerCase()}${A.slice(2)}`;
    expect(altCase).not.toBe(A);
    const leaked = await repo.list(altCase).catch(() => []);
    expect(leaked.map((s) => s.id)).toEqual([]);
  });

  it("AC-7: remesa sin owner (created, nunca verificó) queda EXCLUIDA de cualquier list scopeada", async () => {
    const repo = new LocalRepo();
    const abandoned = Remittance.create("x1", beneficiary(), Money.of(400, "USDC"), NOW); // sin startKyc
    await repo.save(abandoned);
    await repo.save(withOwner("a1", A));

    expect(abandoned.snapshot.ownerAddress).toBeNull();
    expect((await repo.list(A)).map((s) => s.id)).toEqual(["a1"]);
    // no aparece bajo ninguna address
    expect((await repo.list(Z)).map((s) => s.id)).toEqual([]);
  });
});

describe("LocalRepo.clearByOwner — purga PII del owner en el reset (WKH-201)", () => {
  it("AC-1: borra las entries del owner → list vacío", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", A));
    await repo.save(withOwner("a2", A));

    await repo.clearByOwner(A);

    expect(await repo.list(A)).toEqual([]);
  });

  it("AC-2: NO toca otros owners ni las entries ownerAddress === null", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", A));
    await repo.save(withOwner("b1", B));
    const abandoned = Remittance.create("x1", beneficiary(), Money.of(400, "USDC"), NOW); // sin startKyc
    await repo.save(abandoned);

    await repo.clearByOwner(A);

    // otro owner intacto
    expect((await repo.list(B)).map((s) => s.id)).toEqual(["b1"]);
    // la entry null persiste
    expect(await repo.get("x1")).not.toBeNull();
    expect((await repo.get("x1"))?.snapshot.ownerAddress).toBeNull();
  });

  it("AC-3: borra del blob real (repo fresco re-lee del storage → list [])", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", A));
    await repo.clearByOwner(A);

    // instancia fresca que re-lee del storage real (no un reset in-memory)
    const fresh = new LocalRepo();
    expect(await fresh.list(A)).toEqual([]);
    // el blob JSON ya no contiene el destination (celular Yape) del owner purgado
    expect(storage.getItem(KEY)).not.toContain(beneficiary().destination);
  });
});

describe("LocalRepo.save — CAS / lock optimista (AC-3/AC-4, CD-4)", () => {
  it("AC-3/AC-4: carrera — dos get() (version V), un save() avanza, el save() stale tira ConcurrentModificationError", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("race-1", A)); // persistido version 1

    // Dos lecturas del MISMO id → ambas rehidratan con version 1 (read-stale de la carrera).
    const r1 = await repo.get("race-1");
    const r2 = await repo.get("race-1");
    if (!r1 || !r2) throw new Error("setup");
    expect(r1.snapshot.version).toBe(1);
    expect(r2.snapshot.version).toBe(1);

    // r1 procede: persiste version 2. r2 sigue stale (version 1) → fail-loud.
    await repo.save(r1);
    await expect(repo.save(r2)).rejects.toBeInstanceOf(ConcurrentModificationError);

    // El estado persistido es el del ganador (r1), NO pisado por r2.
    const persisted = await repo.get("race-1");
    expect(persisted?.snapshot.version).toBe(2);
  });

  it("AC-3: secuencial (get→save×N) NO genera falso conflicto", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("seq-1", A));
    for (let i = 0; i < 3; i++) {
      const r = await repo.get("seq-1");
      if (!r) throw new Error("setup");
      await repo.save(r); // cada get() lee la última version → sin conflicto
    }
    expect((await repo.get("seq-1"))?.snapshot.version).toBe(4);
  });

  it("AC-4: 2 confirm concurrentes sobre la misma instancia rehidratada → 1 procede, 1 tira", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("cc-1", A)); // version 1
    // Simula dos ejecuciones que leyeron la MISMA version antes de confirmar.
    const a = await repo.get("cc-1");
    const b = await repo.get("cc-1");
    if (!a || !b) throw new Error("setup");
    const results = await Promise.allSettled([repo.save(a), repo.save(b)]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof ConcurrentModificationError,
    ).length;
    expect(ok).toBe(1);
    expect(failed).toBe(1);
  });
});

describe("LocalRepo.read — defensivo AC-4 (snapshot legacy con PII cruda)", () => {
  // Snapshot escrito ANTES del fix: identity FULL (documentNumber crudo + dateOfBirth + nationality),
  // SIN ownerAddress. El read no debe crashear y debe normalizar al shape reducido.
  const legacy = [
    {
      id: "leg-1",
      status: "kyc_passed",
      beneficiary: beneficiary(),
      sendUsd: { __m: [40000, "USDC"] },
      quote: null,
      kyc: {
        verificationId: "v",
        approved: true,
        payoutAllowed: true,
        riskLevel: "low",
        provenance: "didit",
        identity: {
          firstName: "María Elena",
          lastNamePaternal: "Quispe",
          lastNameMaternal: "Mamani",
          documentType: "DNI",
          documentNumber: "44556677",
          dateOfBirth: "1990-05-14",
          nationality: "PE",
        },
      },
      payoutId: null,
      principalTx: null,
      payoutTx: null,
      refundTx: null,
      deliveredPen: null,
      failureReason: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];

  it("no crashea al leer y normaliza identity al shape reducido (dropea PII cruda)", async () => {
    storage.setItem(KEY, JSON.stringify(legacy));
    const repo = new LocalRepo();
    const r = await repo.get("leg-1");
    expect(r).not.toBeNull();
    const id = r?.snapshot.kyc?.identity;
    expect(id?.firstName).toBe("María Elena");
    expect(id?.documentNumberLast4).toBe("6677");
    // PII cruda ausente del shape reducido
    expect(id && "documentNumber" in id).toBe(false);
    expect(id && "dateOfBirth" in id).toBe(false);
    expect(id && "nationality" in id).toBe(false);
  });

  it("legacy sin ownerAddress → normaliza a null → excluido del list scopeado (AC-4 + AC-7)", async () => {
    storage.setItem(KEY, JSON.stringify(legacy));
    const repo = new LocalRepo();
    expect((await repo.get("leg-1"))?.snapshot.ownerAddress).toBeNull();
    expect(await repo.list(A)).toEqual([]);
  });

  it("AC-4: legacy sin `version` → normaliza a 0 sin crashear (y el próximo save avanza a 1)", async () => {
    storage.setItem(KEY, JSON.stringify(legacy)); // fixture legacy no trae `version`
    const repo = new LocalRepo();
    const r = await repo.get("leg-1");
    expect(r).not.toBeNull();
    expect(r?.snapshot.version).toBe(0);
    if (r) await repo.save(r); // save sobre version 0 → sin falso conflicto
    expect((await repo.get("leg-1"))?.snapshot.version).toBe(1);
  });

  it("T-AC5f: legacy sin `payoutProvenance` → normaliza a null sin crashear (CD-2)", async () => {
    storage.setItem(KEY, JSON.stringify(legacy)); // fixture legacy no trae `payoutProvenance`
    const repo = new LocalRepo();
    const r = await repo.get("leg-1");
    expect(r).not.toBeNull();
    expect(r?.snapshot.payoutProvenance).toBeNull();
  });

  // El criterio de la etapa: la identidad del agente tiene que SOBREVIVIR a una recarga. Acá se
  // prueba contra el blob real de localStorage, ida y vuelta.
  it("la identidad del agente (quote y payout) sobrevive el round-trip por localStorage", async () => {
    const repo = new LocalRepo();
    const r = Remittance.create("ag-1", beneficiary(), Money.of(400, "USDC"), NOW);
    r.attachQuote(
      { ...seedQuote, agent: { slug: "remit-corridor-fx", registry: "WasiAI", trial: true } },
      NOW,
    );
    await repo.save(r);

    // segunda instancia = lo que pasa después de un F5: se lee del storage, no de memoria
    const back = await new LocalRepo().get("ag-1");
    expect(back?.snapshot.quote?.agent).toEqual({
      slug: "remit-corridor-fx",
      registry: "WasiAI",
      trial: true,
    });
  });

  it("legacy sin `payoutAgent` → null: de esa remesa NO sabemos quién la atendió", async () => {
    storage.setItem(KEY, JSON.stringify(legacy)); // fixture legacy no trae `payoutAgent`
    const r = await new LocalRepo().get("leg-1");
    expect(r?.snapshot.payoutAgent).toBeNull();
  });

  it("payoutAgent persistido sin slug → null (no se afirma una identidad sin nombre)", async () => {
    storage.setItem(
      KEY,
      JSON.stringify([{ ...legacy[0], id: "leg-2", payoutAgent: { registry: "WasiAI" } }]),
    );
    const r = await new LocalRepo().get("leg-2");
    expect(r?.snapshot.payoutAgent).toBeNull();
  });

  // Un snapshot escrito por una versión que no guardaba el catálogo. Al releerlo, el campo tiene que
  // seguir AUSENTE: rellenarlo con "" convierte "no lo sabíamos" en "el catálogo era vacío", que es
  // una afirmación que nadie hizo nunca.
  it("payoutAgent persistido sin registry → el campo queda AUSENTE (no cadena vacía)", async () => {
    storage.setItem(
      KEY,
      JSON.stringify([{ ...legacy[0], id: "leg-3", payoutAgent: { slug: "remit-cashout-payout" } }]),
    );
    const r = await new LocalRepo().get("leg-3");
    expect(r?.snapshot.payoutAgent).toEqual({ slug: "remit-cashout-payout" });
    expect(r?.snapshot.payoutAgent).not.toHaveProperty("registry");
  });

  it("raw corrupto no crashea (parse defensivo → mapa vacío)", async () => {
    storage.setItem(KEY, "{not json");
    const repo = new LocalRepo();
    expect(await repo.list(A)).toEqual([]);
    expect(await repo.get("whatever")).toBeNull();
  });
});

// ─── WKH-348 ─────────────────────────────────────────────────────────────────────────────────────
// APPEND: todo lo de arriba (las 320 líneas originales) queda sin editar. Los fixtures y helpers de
// arriba (`withOwner`, `seedQuote`, `A`, `B`, `Z`, `storage`) se reusan; los de acá abajo se agregan.
//
// 🔴 EL PROBLEMA QUE MIDEN ESTOS TESTS. `list()` canonicalizaba el `ownerAddress` de CADA entrada
// dentro del predicado de un `.filter()`. `Array.prototype.filter` no atrapa excepciones del
// predicado ⇒ UNA entrada guardada que no se puede atribuir hacía rechazar la promesa y el historial
// entero desaparecía. `clearByOwner()` usaba el mismo predicado y tiraba igual, y `ForgetKyc` se
// traga esa excepción, así que el reset decía "listo" sin haber borrado nada.
//
// ⛔ LO QUE ESTE CAMBIO NO HACE (AC-5): la entrada cuyo `ownerAddress` no canonicaliza NO se atribuye
// a nadie, y por eso tampoco se borra. No se puede atribuir lo que no canonicaliza. Lo único que
// cambia es que deja de tapar a las demás. Eso lo fija T-3b, que es de PRESERVACIÓN.
//
// Las TRES familias de veneno, cada una con su motivo de estar:
//   · `P_EMPTY` — la cadena vacía: el valor que un productor podía persistir sin darse cuenta.
//   · `P_EVM`   — el literal de `address.test.ts`, que ya prueba que tira. Es una address EVM legítima
//                 (checksum EIP-55 válido), o sea el blob de alguien que venía de la rama EVM.
//   · `P_B58`   — 44 caracteres del alfabeto base58 que NO son una pubkey. Es el input que un
//                 pre-filtro por regex aceptaría, así que si alguien "optimiza" el predicado a un
//                 regex, T-1b se pone rojo.
const P_EMPTY = "";
const P_EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const P_B58 = "z".repeat(44);

/**
 * Gemelo de `withOwner` con destino de remesa VIEJA (`beneficiary("yape")` ⇒ celular, no el CCI de 20
 * dígitos que usan todas las demás).
 *
 * POR QUÉ EXISTE: `withOwner` usa `beneficiary()` sin argumento, y ése devuelve el MISMO `destination`
 * para todas las entradas. Asertar "el blob ya no contiene `beneficiary().destination`" después de un
 * `clearByOwner(A)` sería imposible de poner en verde con `b1` todavía en el blob, y `b1` TIENE que
 * seguir ahí (borrarlo sería el bug de AC-2). Con un destino distinto por dueño, la misma aserción
 * mide las dos cosas: que la PII del owner purgado se fue Y que la del otro owner sigue.
 */
function withOwnerYape(id: string, owner: string): Remittance {
  const r = Remittance.create(id, beneficiary("yape"), Money.of(400, "USDC"), NOW);
  r.attachQuote(seedQuote, NOW);
  r.startKyc(NOW, owner);
  return r;
}

/** Entrada de blob CRUDO (Productor B): el único camino que puede existir en el `localStorage` del
 *  founder y que no pasa por el dominio. Patrón del fixture `legacy` de más arriba. */
function rawState(id: string, ownerAddress: unknown): Record<string, unknown> {
  return {
    id,
    status: "kyc_pending",
    beneficiary: beneficiary(),
    sendUsd: { __m: [40000, "USDC"] },
    quote: null,
    kyc: null,
    payoutId: null,
    principalTx: null,
    payoutTx: null,
    refundTx: null,
    deliveredPen: null,
    failureReason: null,
    ownerAddress,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("LocalRepo.list — una entrada que no se puede atribuir deja de tapar a las demás (WKH-348/AC-1)", () => {
  // ── T-1 ────────────────────────────────────────────────────────────────────────────────────────
  // ROJO ANTES DEL CAMBIO: la promesa RECHAZA con `address_canonicalization_failed` en vez de
  // resolver `["a1"]`. Cubre las dos familias de veneno en el mismo blob.
  it("T-1: con veneno vacío y veneno EVM en el blob, list(A) devuelve las entradas de A", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", A));
    await repo.save(withOwner("p1", P_EMPTY));
    await repo.save(withOwner("p2", P_EVM));

    expect((await repo.list(A)).map((s) => s.id)).toEqual(["a1"]);
  });

  // ── T-1b ───────────────────────────────────────────────────────────────────────────────────────
  // ROJO ANTES DEL CAMBIO por la misma causa. Es el caso que separa la delegación de un pre-filtro
  // por regex: `P_B58` pasa `^[1-9A-HJ-NP-Za-km-z]{32,44}$` y no es una pubkey.
  it("T-1b: el veneno que PASA un regex de base58 tampoco tapa la lista", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", A));
    await repo.save(withOwner("p1", P_EMPTY));
    await repo.save(withOwner("p3", P_B58));

    expect((await repo.list(A)).map((s) => s.id)).toEqual(["a1"]);
  });

  // ── T-2 ────────────────────────────────────────────────────────────────────────────────────────
  // 🔴 EL CANDADO DEL SCOPE POR DUEÑO, medido CON VENENO PRESENTE (la combinación que no existía).
  // ROJO ANTES DEL CAMBIO: rechaza. Si la tolerancia se volviera laxa —matchear de más, lowercasear,
  // o atribuirle al que pregunta la entrada que no se puede atribuir— `list(A)` traería `b1` o `p*`.
  // Es la protección IDOR de HU-SOL-7. Mutante que lo mata: m2 (`.toLowerCase()` en la comparación).
  it("T-2: con 3 dueños y veneno en el blob, cada uno recibe EXACTAMENTE lo suyo y nada más", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", A));
    await repo.save(withOwner("b1", B));
    await repo.save(withOwner("p1", P_EMPTY));
    await repo.save(withOwner("p2", P_EVM));
    const abandoned = Remittance.create("x1", beneficiary(), Money.of(400, "USDC"), NOW); // sin startKyc
    await repo.save(abandoned);

    expect((await repo.list(A)).map((s) => s.id)).toEqual(["a1"]);
    expect((await repo.list(B)).map((s) => s.id)).toEqual(["b1"]);
    expect((await repo.list(Z)).map((s) => s.id)).toEqual([]);
    // Variante de case de A: puede no canonicalizar (⇒ rechaza, AC-3) o canonicalizar a OTRA address
    // (⇒ `[]`). Los dos desenlaces son aceptables y NO se asserta cuál: asertar uno sería afirmar
    // algo que nadie midió. Lo que importa, y lo que se asserta, es que nunca devuelve lo ajeno.
    const altCase = `${A.slice(0, 1)}${A[1] === A[1]!.toLowerCase() ? A[1]!.toUpperCase() : A[1]!.toLowerCase()}${A.slice(2)}`;
    expect(altCase).not.toBe(A);
    const leaked = await repo.list(altCase).catch(() => []);
    expect(leaked.map((s) => s.id)).toEqual([]);
  });

  // ── T-6b ───────────────────────────────────────────────────────────────────────────────────────
  // ROJO ANTES DEL CAMBIO. Productor B: el blob heredado, escrito por una versión anterior y sembrado
  // acá SIN pasar por el dominio. Sin este test, el fix se probaría sólo contra veneno que entró por
  // `withOwner`, y el blob del founder no entró por ahí.
  it("T-6b: veneno sembrado por blob CRUDO (heredado) tampoco tapa la lista", async () => {
    storage.setItem(KEY, JSON.stringify([rawState("a1", A), rawState("leg-evm", P_EVM)]));
    const repo = new LocalRepo();

    expect((await repo.list(A)).map((s) => s.id)).toEqual(["a1"]);
  });

  // ── T-4 ────────────────────────────────────────────────────────────────────────────────────────
  // 🔴 PRESERVACIÓN: verde ANTES y DESPUÉS del cambio. No se disfraza de rojo.
  // Mutantes que lo matan: m3 (envolver el cuerpo de `list()` en un try/catch → `[]`) y canonicalizar
  // el `target` con la variante tolerante.
  //
  // POR QUÉ LA TOLERANCIA SE DETIENE ACÁ Y NO ES SIMETRÍA ROTA: en el `ownerAddress` de una entrada
  // guardada, un valor malo es un DATO que no sabemos de quién es ⇒ excluirlo es decir "no sé". En el
  // `target`, un valor malo es LA IDENTIDAD DEL QUE PREGUNTA ⇒ seguir sería adivinar de quién es la
  // lista y devolvérsela a alguien.
  it("T-4 (PRESERVACIÓN): el target sigue fail-closed, también con veneno ya en el blob", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", A));
    await repo.save(withOwner("p1", P_EMPTY));

    await expect(repo.list("no-base58-!!!")).rejects.toThrow("address_canonicalization_failed");
    await expect(repo.list(P_EVM)).rejects.toThrow("address_canonicalization_failed");
    await expect(repo.clearByOwner("")).rejects.toThrow("address_canonicalization_failed");
  });
});

describe("LocalRepo.clearByOwner — el reset borra de verdad, y no borra lo que no puede atribuir (WKH-348/AC-2)", () => {
  // ── T-3 ────────────────────────────────────────────────────────────────────────────────────────
  // ROJO ANTES DEL CAMBIO: `clearByOwner` rechaza, y `ForgetKyc` se traga esa excepción ⇒ el reset
  // decía "listo" sin haber borrado nada.
  it("T-3: purga las entradas del owner (y su PII del blob) sin tocar al otro owner", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwnerYape("a1", A)); // destino distinto ⇒ PII distinguible en el blob
    await repo.save(withOwnerYape("a2", A));
    await repo.save(withOwner("b1", B));
    await repo.save(withOwner("p1", P_EMPTY));
    const abandoned = Remittance.create("x1", beneficiary(), Money.of(400, "USDC"), NOW);
    await repo.save(abandoned);

    await expect(repo.clearByOwner(A)).resolves.toBeUndefined();

    expect(await repo.list(A)).toEqual([]);
    expect((await repo.list(B)).map((s) => s.id)).toEqual(["b1"]);
    // La misma aserción mide las dos mitades: la PII del owner purgado se fue del blob real, y la del
    // owner que nadie tocó sigue ahí (borrarla sería el bug de AC-2).
    expect(storage.getItem(KEY)).not.toContain(beneficiary("yape").destination);
    expect(storage.getItem(KEY)).toContain(beneficiary().destination);
    // La entrada sin dueño sigue intacta (WKH-201/AC-2).
    expect(await repo.get("x1")).not.toBeNull();
  });

  // ── T-3b ───────────────────────────────────────────────────────────────────────────────────────
  // 🔴 PRESERVACIÓN: verde ANTES y DESPUÉS. Mutante que lo mata: m5 — un `clearByOwner` que borre
  // también las entradas que no se pueden atribuir.
  //
  // POR QUÉ BORRARLA SERÍA UN BUG Y NO UNA LIMPIEZA: borrar lo que no se puede atribuir ES
  // atribuirlo al que pidió el reset (AC-5), y destruye el único dato con el que algún día se podría
  // atribuir. El costo está declarado como residual: si esa entrada contiene PII de un beneficiario,
  // el reset NO la puede purgar.
  it("T-3b (PRESERVACIÓN): el reset NO borra la entrada que no se puede atribuir", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwnerYape("a1", A));
    await repo.save(withOwner("p1", P_EMPTY));

    await repo.clearByOwner(A).catch(() => {}); // antes del cambio rechaza; lo que se mide es el blob

    const p1 = await repo.get("p1");
    expect(p1).not.toBeNull();
    expect(p1?.snapshot.ownerAddress).toBe(P_EMPTY);
  });
});
