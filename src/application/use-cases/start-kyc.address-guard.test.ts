// Tests — el guard de address de `StartKyc` (WKH-348 / AC-4).
//
// 🔴 QUÉ ARREGLA, Y QUÉ NO. Sin el guard, una `address` vacía viajaba hasta el caché de KYC, que
// canonicaliza base58 y tira `address_canonicalization_failed`. Eso es un diagnóstico FALSO y caro:
// manda a mirar la canonicalización de una address, o a reintentar el KYC, cuando lo único que hay que
// hacer es reconectar la billetera. El código correcto ya existe y se REUSA:
// `WALLET_ADDRESS_UNAVAILABLE`, con su copy ya escrita en `flow-vm.ts`.
//
// ⛔ LO QUE ESTA HU NO PUEDE AFIRMAR (y por qué está escrito acá). NO se "cierra el único productor
// vivo" de una `ownerAddress` vacía: ninguno quedó confirmado vivo desde el repo. Medido: el
// `await this.kycStore.get(input.address)` de `StartKyc` es INCONDICIONAL y PRECEDE a todos los
// `repo.save(r)` del use-case, y `LocalKycStore.get` canonicaliza su argumento ⇒ con `address === ""`
// ya tiraba ahí, antes de cualquier escritura. Lo verificable y verdadero es otra cosa, y es lo que
// estos tests miden: (a) el diagnóstico pasa a ser el correcto y (b) la barrera deja de depender del
// throw de un caché declarado NO CRÍTICO y pasa a ser explícita.
//
// Por eso el guard NO se pone en `Remittance.startKyc` (el dominio no conoce "billetera no
// disponible") y `kyc-store.ts` NO se toca en esta HU: aflojar esa canonicalización en el mismo cambio
// abriría el productor mientras se cree que se lo cerró.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { type Quote, Remittance } from "../../domain/remittance";
import {
  FakeKycGateway,
  FakeKycPendingStore,
  FakeKycStore,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../../test-support/fakes";
import { WALLET_ADDRESS_UNAVAILABLE } from "./confirm-and-send";
import { StartKyc } from "./start-kyc";

const ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const quote: Quote = {
  quoteId: "q1",
  send: Money.of(400, "USDC"),
  receive: Money.of(1480, "PEN"),
  feeUsd: Money.of(0.5, "USDC"),
  rate: 3.7,
  etaMinutes: 30,
  expiresAt: QUOTE_EXPIRES,
  provenance: "fake",
};

// WKH-187: se cotiza ANTES del KYC (created→quoted). Sin el quote, `startKyc` tira
// `invalid_transition:created->kyc_pending` y estos tests medirían el andamiaje, no el use-case.
// Helpers copiados de `start-kyc.verdict.test.ts` (el repo ya duplica andamiaje entre archivos).
async function seed(repo: InMemoryRepo): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  await repo.save(r);
  return "r-1";
}

function build() {
  const repo = new InMemoryRepo();
  const kyc = new FakeKycGateway({}, true); // redirect=true ⇒ crear sesión es observable
  const startSpy = vi.spyOn(kyc, "start");
  const uc = new StartKyc(kyc, new FakeKycStore(), new FakeKycPendingStore(), repo, new FixedClock());
  return { repo, kyc, startSpy, uc };
}

// Un espía sobre `Remittance.prototype` que sobreviva a este archivo contaminaría la suite entera.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("StartKyc — el guard de address dice lo que pasó, y corta antes de tocar la remesa (WKH-348/AC-4)", () => {
  // ── T-6 ────────────────────────────────────────────────────────────────────────────────────────
  // ROJO ANTES DEL CAMBIO, y el rojo es EL CÓDIGO DEL ERROR: rechazaba con
  // `address_canonicalization_failed` (lo tiraba `FakeKycStore.get`, espejo del `LocalKycStore.get`
  // real) en vez de `wallet_address_unavailable`. Ése es exactamente el valor de AC-4: el diagnóstico.
  it("T-6: address vacía ⇒ wallet_address_unavailable (no un fallo de canonicalización)", async () => {
    const { repo, uc } = build();
    await seed(repo);

    await expect(uc.execute({ remittanceId: "r-1", address: "" })).rejects.toThrow(
      "wallet_address_unavailable",
    );
  });

  it("T-6: address de puros espacios ⇒ el mismo código (se compara con .trim())", async () => {
    const { repo, uc } = build();
    await seed(repo);

    await expect(uc.execute({ remittanceId: "r-1", address: "   " })).rejects.toThrow(
      "wallet_address_unavailable",
    );
  });

  // El código se REUSA, no se inventa: es la misma marca estable que ya emite el money-path, con su
  // copy ya escrita. El esperado es un literal (CD-19) y además se ata a la constante exportada, así
  // que un código nuevo con el mismo texto o un texto nuevo con el mismo nombre ponen esto rojo.
  it("T-6: el código es la constante que YA existía, no una marca nueva", () => {
    expect(WALLET_ADDRESS_UNAVAILABLE).toBe("wallet_address_unavailable");
  });

  // ── T-6c ───────────────────────────────────────────────────────────────────────────────────────
  // 🔴 LA ÚNICA ASERCIÓN QUE DISTINGUE LAS DOS POSICIONES DEL GUARD. AC-4 exige cortar ANTES de
  // invocar `Remittance.startKyc()`, y el estado persistido NO distingue: en las dos posiciones se
  // revienta antes de `repo.save`, así que la remesa queda igual. El espía es lo único que lo separa.
  // ROJO ANTES DEL CAMBIO: el espía registraba 1 llamada. Mutante que lo mata: m4 (mover el guard
  // después de `r.startKyc(...)`).
  it("T-6c: el guard corta ANTES de invocar Remittance.startKyc, y la remesa queda intacta", async () => {
    const { repo, uc, startSpy } = build();
    await seed(repo);
    const spy = vi.spyOn(Remittance.prototype, "startKyc");

    await expect(uc.execute({ remittanceId: "r-1", address: "" })).rejects.toThrow(
      "wallet_address_unavailable",
    );

    expect(spy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled(); // tampoco se gastó un cupo de sesión de Didit
    const r = await repo.get("r-1");
    expect(r?.snapshot.status).toBe("quoted");
    expect(r?.snapshot.ownerAddress).toBeNull();
  });

  // ── T-6d ───────────────────────────────────────────────────────────────────────────────────────
  // 🔴 PRESERVACIÓN: verde ANTES y DESPUÉS. No se disfraza de rojo.
  // Mutante que lo mata: un guard con la condición de más (`length < 44`, `!isBase58(...)`, o
  // canonicalizar acá) ⇒ dejaría sin poder verificarse a TODO el mundo, que es infinitamente peor que
  // el bug que se está arreglando.
  it("T-6d (PRESERVACIÓN): con una address válida el camino sigue igual (no sobre-bloquea)", async () => {
    const { repo, uc, startSpy } = build();
    await seed(repo);
    const spy = vi.spyOn(Remittance.prototype, "startKyc");

    const res = await uc.execute({ remittanceId: "r-1", address: ADDR });

    expect(res.kind).toBe("redirect");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect((await repo.get("r-1"))?.snapshot.ownerAddress).toBe(ADDR);
  });
});
