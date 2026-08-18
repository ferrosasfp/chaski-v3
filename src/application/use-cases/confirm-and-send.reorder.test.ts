// Tests — ConfirmAndSend: el ORDEN de los guards del camino no-custodial (WKH-211 / HU-SOL-13).
//
// Orden que se clava: confirm → expiry → rent → prepare → authorizePrincipal → settle →
// markPrincipalIn → markPayoutSubmitted. Un guard movido de lugar pone esto rojo.
//
// ⚠️ ESTA CADENA CAMBIÓ EN WKH-333 (DT-20), Y ES EL CAMBIO QUE ESTE ARCHIVO EXISTE PARA DETECTAR.
// Decía `confirm → autoridad → expiry → prepare → …`, y "autoridad" SALIÓ: el pre-check que
// `ConfirmAndSend` hacía contra el proveedor de identidad se eliminó del use-case. No es que el guard
// se relajó — es que se MUDÓ, entero, a `/api/payout/prepare`, donde corre server-side, detrás de la
// prueba de posesión de la billetera y con el identificador sacado de la fila del dueño probado, o
// sea estrictamente más fuerte que acá. El caso que lo probaba se reescribió más abajo con esa razón
// al lado; no se borró.
//
// Lo que este archivo sigue clavando, y no cambió: NINGÚN guard que corría antes de `prepare` corre
// después. Crear una orden de payout real es irreversible del lado del proveedor, así que todo lo que
// puede decir que no tiene que decirlo antes.
import { describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FAKE_SOLANA_AUTHORITY,
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_SIGNATURE,
  FakePayoutGateway,
  FakeRefundGateway,
  FakeSolanaEscrowDepositProbe,
  FakeSolanaPayoutPrepareGateway,
  FakeSolanaSenderSolBalanceProbe,
  FakePruebaDePosesionPorEnlace,
  FakeSolanaSettlementGateway,
  FakeSolanaWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  ScriptedClock,
  T0,
  beneficiary,
} from "../../test-support/fakes"; import { esperarListo } from "../../test-support/desenlaces"; // WKH-356: narrowing de ResultadoDeEnvio. TIRA si execute() suspende donde el test no lo espera.
import { ConfirmAndSend } from "./confirm-and-send";

const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  riskLevel: "low",
  provenance: "didit",
  identity: null,
};
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

async function seedQuoted(repo: InMemoryRepo): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  await repo.save(r);
  return "r-1";
}

/** El número de orden de la PRIMERA invocación de un espía. Lanza si nunca se llamó, en vez de
 *  comparar `undefined` (que en JS produce `NaN` y hace que cualquier `toBeLessThan` falle por el
 *  motivo equivocado). Concentra además el `!` que TypeScript exige acá. */
function firstCallOrder(spy: { mock: { invocationCallOrder: number[] } }): number {
  const n = spy.mock.invocationCallOrder[0];
  if (n === undefined) throw new Error("el espía nunca se invocó");
  return n;
}

describe("ConfirmAndSend — orden de los guards del camino no-custodial (WKH-211 / HU-SOL-13)", () => {
  it("AC-1: orden = prepare → authorizePrincipal → settle; el escrow firmado es el de prepare", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const prepareSpy = vi.spyOn(prepare, "prepare");
    const settleSpy = vi.spyOn(gateway, "settle");
    const id = await seedQuoted(repo);

    await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      new FakeRefundGateway(),
      { prepare, gateway, probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(), pop: new FakePruebaDePosesionPorEnlace() },
    ).execute({ remittanceId: id });

    // Orden REAL de invocación: prepare ANTES de firmar ANTES de settle.
    expect(firstCallOrder(prepareSpy)).toBeLessThan(firstCallOrder(authorizeSpy));
    expect(firstCallOrder(authorizeSpy)).toBeLessThan(firstCallOrder(settleSpy));
    // AC-1: authorizePrincipal recibió el beneficiary+authority RESUELTOS SERVER-SIDE por prepare,
    // nunca algo del body. Si alguien invirtiera la fuente, esto se pone rojo.
    expect(authorizeSpy.mock.calls[0]![2]).toEqual({
      address: FAKE_SOLANA_BENEFICIARY,
      escrow: { beneficiary: FAKE_SOLANA_BENEFICIARY, authority: FAKE_SOLANA_AUTHORITY },
    });
  });

  // ⚠️ ESTE CASO CAMBIÓ DE EXPECTATIVA EN WKH-333 (DT-20). Se llamaba "la AUTORIDAD corre ANTES que
  // prepare: authority false ⇒ prepare NUNCA se invoca" y afirmaba, con un
  // `FakePayoutAuthorityGateway({authorized:false, reason:"kyc_not_approved"})`, que el use-case
  // cortaba antes de crear la orden. Hoy ese pre-check no existe: `prepare` SÍ se invoca, y es la
  // route la que corta —con el mismo fail-closed y dos guards más— antes de crear ninguna orden real.
  //
  // ⛔ NO SE BORRÓ. Se reescribió para clavar la propiedad que sí sigue siendo del use-case y que sí
  // se puede perder acá: que `prepare` es lo PRIMERO que toca la red del money-path, y que todo lo
  // que el use-case puede decidir solo lo decide ANTES. El caso "authority false ⇒ no se crea la
  // orden" vive ahora en `app/api/payout/prepare/route.test.ts` (T-PR-9), que es donde el guard está.
  it("prepare es la PRIMERA llamada de red del money-path: nada lo precede salvo guards locales", async () => {
    const repo = new InMemoryRepo();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const prepareSpy = vi.spyOn(prepare, "prepare");
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const gateway = new FakeSolanaSettlementGateway();
    const settleSpy = vi.spyOn(gateway, "settle");
    const id = await seedQuoted(repo);

    await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      new FakeRefundGateway(),
      { prepare, gateway, probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(), pop: new FakePruebaDePosesionPorEnlace() },
    ).execute({ remittanceId: id });

    expect(prepareSpy).toHaveBeenCalledTimes(1);
    // Y sigue corriendo ANTES de que la billetera firme y ANTES del broadcast: si esto se invirtiera,
    // se le pediría la firma a la persona para una orden que todavía no existe.
    expect(
      firstCallOrder(prepareSpy),
      "se le pidió la firma a la billetera ANTES de crear la orden de payout",
    ).toBeLessThan(firstCallOrder(authorizeSpy));
    expect(firstCallOrder(prepareSpy)).toBeLessThan(firstCallOrder(settleSpy));
  });

  // T-CS-2 (§0.5) — UNA sola consulta al proveedor de identidad por remesa, no dos.
  //
  // ⚠️ QUÉ SE MIDE ACÁ, exactamente: que el use-case produce UN SOLO call-site capaz de disparar esa
  // consulta (el `prepare` server-side). NO se cuentan peticiones HTTP contra Didit: eso no es
  // observable desde un test de use-case y NO SE PUDO VERIFICAR por ejecución de red. Antes había
  // dos: el pre-check de `ConfirmAndSend` (vía `HttpPayoutAuthorityGateway` → /api/payout/validate →
  // resolvePayoutAuthority) y el de la route de prepare. El primero ya no puede existir: su gateway
  // no está en el constructor, y el `@ts-expect-error` de `confirm-and-send.test.ts` (T-CS-1) es el
  // candado de compilación que lo impide.
  it("T-CS-2: una remesa completa dispara UNA sola consulta a la autoridad de KYC, no dos", async () => {
    const repo = new InMemoryRepo();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const prepareSpy = vi.spyOn(prepare, "prepare");
    const id = await seedQuoted(repo);

    await new ConfirmAndSend(
      new FakeSolanaWallet(),
      repo,
      new FixedClock(),
      new FakeRefundGateway(),
      { prepare, gateway: new FakeSolanaSettlementGateway(), probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(), pop: new FakePruebaDePosesionPorEnlace() },
    ).execute({ remittanceId: id });

    expect(
      prepareSpy.mock.calls.length,
      "la remesa disparó más de un camino hacia la autoridad de KYC: cada uno gasta un cupo del " +
        "tier gratuito del proveedor, y el primero usaba un identificador que el navegador ya no tiene",
    ).toBe(1);
  });

  it("el EXPIRY corre ANTES que prepare: quote vencido ⇒ prepare NUNCA se invoca", async () => {
    const repo = new InMemoryRepo();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const prepareSpy = vi.spyOn(prepare, "prepare");
    const id = await seedQuoted(repo);

    const clock = new ScriptedClock([T0, "2026-07-09T18:11:00.000Z"]); // vence en el re-check
    const out = esperarListo(await new ConfirmAndSend(
      new FakeSolanaWallet(),
      repo,
      clock,
      new FakeRefundGateway(),
      { prepare, gateway: new FakeSolanaSettlementGateway(), probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(), pop: new FakePruebaDePosesionPorEnlace() },
    ).execute({ remittanceId: id }));

    expect(prepareSpy).not.toHaveBeenCalled();
    expect(out.snapshot.failureReason).toBe("quote_expired_before_submit");
  });

  it("AC-7: prepare !ok ⇒ failAndRefund SIN authorizePrincipal (la wallet NUNCA firma un destino no confirmado)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const gateway = new FakeSolanaSettlementGateway();
    const settleSpy = vi.spyOn(gateway, "settle");
    const refund = new FakeRefundGateway();
    const id = await seedQuoted(repo);
    // prepare devuelve !ok (agente caído / depositAddress null server-side).
    const prepare = new FakeSolanaPayoutPrepareGateway({
      ok: false,
      reason: "prepare_no_deposit_address",
    });

    const out = esperarListo(await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      refund,
      { prepare, gateway, probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(), pop: new FakePruebaDePosesionPorEnlace() },
    ).execute({ remittanceId: id }));

    expect(authorizeSpy).not.toHaveBeenCalled(); // AC-7: NUNCA se pidió la firma
    expect(settleSpy).not.toHaveBeenCalled();
    expect(out.snapshot.principalTx).toBeNull(); // el principal NUNCA entró
    expect(out.snapshot.failureReason).toBe("prepare_no_deposit_address");
    expect(refund.calls[0]?.reason).toBe("prepare_no_deposit_address");
  });

  it("DT-7: el camino real NO llama payouts.submit; marca payout_submitted con el payoutId de prepare", async () => {
    const repo = new InMemoryRepo();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);

    const out = esperarListo(await new ConfirmAndSend(
      new FakeSolanaWallet(),
      repo,
      new FixedClock(),
      new FakeRefundGateway(),
      {
        prepare: new FakeSolanaPayoutPrepareGateway(),
        gateway: new FakeSolanaSettlementGateway(),
        probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(), pop: new FakePruebaDePosesionPorEnlace(),
      },
    ).execute({ remittanceId: id }));

    // DT-7/DT-11: el use-case ya ni recibe el PayoutGateway; este spy no puede dispararse ni por
    // accidente. El PEN lo libera el proveedor al detectar el depósito on-chain.
    expect(submitSpy).not.toHaveBeenCalled();
    expect(out.snapshot.status).toBe("payout_submitted");
    // markPrincipalIn SOLO con la signature VERIFICADA on-chain (CD-6), nunca con la firma cruda.
    expect(out.snapshot.principalTx).toBe(FAKE_SOLANA_SIGNATURE);
  });

  it("markPrincipalIn ocurre DESPUÉS del settle, nunca antes (el orden que la HU vino a proteger)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    // El settle falla ⇒ si markPrincipalIn corriera antes, la remesa quedaría diciendo "plata
    // adentro" sobre un depósito que nunca se confirmó. Ese es exactamente el bug.
    const gateway = new FakeSolanaSettlementGateway({
      ok: false,
      reason: "solana_settle_rejected",
    });

    const out = esperarListo(await new ConfirmAndSend(
      new FakeSolanaWallet(),
      repo,
      new FixedClock(),
      new FakeRefundGateway(),
      { prepare: new FakeSolanaPayoutPrepareGateway(), gateway, probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(), pop: new FakePruebaDePosesionPorEnlace() },
    ).execute({ remittanceId: id }));

    expect(out.snapshot.principalTx).toBeNull();
    expect(out.snapshot.failureReason).toBe("solana_settle_rejected");
    expect(out.snapshot.status).not.toBe("principal_in");
  });
});
