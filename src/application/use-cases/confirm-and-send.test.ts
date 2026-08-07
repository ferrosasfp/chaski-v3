// Tests — ConfirmAndSend: los guards que corren ANTES de tocar el money-path.
//
// Alcance de este archivo: SÓLO los guards previos (identidad verificada, autoridad de payout,
// vigencia de la cotización). El paso `payouts.submit` NO se ejerce acá porque es estructuralmente
// inalcanzable: sin `solana` inyectado el use-case corta en el tapón fail-closed DT-8, probado en
// confirm-and-send.money-path.test.ts. DT-11: el port PayoutGateway sigue vivo — TrackRemittance usa
// `payouts.status()`.
//
// El camino completo (prepare → firma → settle) se prueba en confirm-and-send.money-path.test.ts, y el
// ORDEN de sus guards en confirm-and-send.reorder.test.ts.
import { describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakePayoutAuthorityGateway,
  FakeRefundGateway,
  FakeSolanaWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  ScriptedClock,
  T0,
  beneficiary,
} from "../../test-support/fakes";
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

// Construye una remesa lista para confirm() (estado "quoted" con KYC pasado + quote válido).
async function seedQuoted(repo: InMemoryRepo, kyc: KycVerification = passKyc): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0); // WKH-187: cotiza antes del KYC (created→quoted)
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY); // quoted→kyc_pending
  r.applyKyc(kyc, T0); // kyc_pending→kyc_passed (quote sobrevive)
  await repo.save(r);
  return "r-1";
}

// ── ⚠️ ESTE DESCRIBE CAMBIÓ DE EXPECTATIVA EN WKH-333 (DT-20), Y LA RAZÓN VA ACÁ ─────────────────
//
// Se llamaba "enforcement autoridad server-side (WKH-180)" y probaba el PRE-CHECK que
// `ConfirmAndSend` hacía contra la autoridad de KYC antes de mover valor. Ese pre-check SE ELIMINÓ, y
// no por gusto: con el veredicto viviendo en el servidor, este cliente ya no tiene el
// `verificationId` — mandaría `""`, la autoridad devolvería `invalid_verification_id`, y TODA remesa
// moriría en `failAndRefund`. Había que resolverlo sí o sí.
//
// ⛔ LOS CASOS NO SE BORRARON. Se reescribieron para afirmar lo que hoy es cierto, que es MÁS fuerte:
// el use-case ya NO PUEDE consultar a la autoridad (el gateway no está en su constructor: el `tsc`
// de abajo lo prueba), y el enforcement vive entero en `/api/payout/prepare`, server-side, detrás de
// la prueba de posesión y con el identificador sacado de la fila del dueño probado. Ahí lo prueban
// T-PR-7/8/9/10 de `app/api/payout/prepare/route.test.ts`.
//
// Lo que se conserva sin cambios porque sigue siendo verdad y sigue siendo lo que importa: NINGUNA de
// estas remesas le pide una firma a la billetera, y NINGUNA mueve un USDC.
describe("ConfirmAndSend — el pre-check de autoridad SE ELIMINÓ (WKH-333/DT-20)", () => {
  // ── T-CS-1 ──────────────────────────────────────────────────────────────────────────────────────
  it("T-CS-1: el use-case NO consulta a la autoridad de KYC — inyectarla no compila", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const authority = new FakePayoutAuthorityGateway({
      authorized: false,
      reason: "kyc_not_approved",
    });
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      new FakeRefundGateway(),
    ).execute({ remittanceId: id });

    // El doble está construido y NADIE lo tocó: no hay forma de que este use-case llegue a él.
    expect(
      authority.calls,
      "el use-case volvió a consultar a la autoridad de KYC desde el cliente: son dos consultas al " +
        "proveedor de identidad por remesa, y la primera usa un identificador que este navegador ya " +
        "no tiene",
    ).toEqual([]);

    // 🔴 Y no puede volver por la puerta de atrás: el 4º argumento YA NO EXISTE. `tsconfig.json`
    // incluye los tests, así que este `@ts-expect-error` lo EVALÚA `tsc --noEmit` de verdad — si
    // alguien reintrodujera el parámetro, este comentario quedaría "sin usar" y la compilación
    // fallaría. Es el candado, no el `toEqual([])` de arriba.
    // @ts-expect-error — el gateway de autoridad ya no es un parámetro de ConfirmAndSend (DT-20)
    void (() => new ConfirmAndSend(wallet, repo, new FixedClock(), authority, new FakeRefundGateway()));

    // Y lo que este archivo protegía sigue en pie: no se firmó nada y no se movió nada. Muere en el
    // tapón fail-closed DT-8 (sin `solana` inyectado), que es ANTES de cualquier firma.
    expect(out.snapshot.failureReason).toBe("settlement_unavailable");
    expect(out.snapshot.principalTx).toBeNull();
    expect(authorizeSpy).not.toHaveBeenCalled();
  });

  it("T-CS-1b: un `kyc.approved:true` FORJADO en localStorage sigue sin poder mover un USDC", async () => {
    // El caso original ("override server-side gana") probaba que el pre-check ignoraba el booleano
    // del navegador. Hoy la afirmación es más fuerte y NO depende de ningún pre-check: el estado
    // client-side no participa de NINGUNA decisión de dinero. Quien lo forje llega, como cualquiera,
    // al guard server-side de `prepare` — y acá, sin `solana`, ni siquiera a eso.
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const forged: KycVerification = { ...passKyc, approved: true, payoutAllowed: true };
    const id = await seedQuoted(repo, forged);

    const out = await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      new FakeRefundGateway(),
    ).execute({ remittanceId: id });

    expect(out.snapshot.principalTx).toBeNull();
    expect(
      authorizeSpy,
      "un veredicto forjado en el navegador consiguió que se le pidiera la firma a la billetera",
    ).not.toHaveBeenCalled();
  });

  it("T-CS-1c: un veredicto server-side (verificationId null) NO rompe el use-case", async () => {
    // La población nueva: quien saltea la verificación porque el SERVIDOR ya tiene su fila. Su
    // `KycVerification` local llega con `verificationId: null`. Con el pre-check vivo, ese null se
    // convertía en `""`, la autoridad devolvía `invalid_verification_id` y la remesa moría SIEMPRE.
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const fromServer: KycVerification = { ...passKyc, verificationId: null };
    const id = await seedQuoted(repo, fromServer);

    const out = await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      new FakeRefundGateway(),
    ).execute({ remittanceId: id });

    expect(
      out.snapshot.failureReason,
      "una remesa cuyo veredicto vive en el servidor murió por falta del identificador local: es " +
        "TODA la gente que se verificó en otro dispositivo, sin poder enviar nunca",
    ).not.toBe("invalid_verification_id");
    // Llega hasta donde llega cualquier otra: el tapón DT-8.
    expect(out.snapshot.failureReason).toBe("settlement_unavailable");
  });
});

// ── La address que no está ────────────────────────────────────────────────────────────────────────
// El daño: `address` viajaba como `""` hasta la autoridad de payout, que lo canonicaliza (base58) y
// tira; el catch de authority.ts lo convierte en 502 `kyc_reauth_failed`. O sea que "no tengo la
// dirección de la wallet" — local, trivial, y con cero plata movida — se leía como "el proveedor de
// identidad falló", y el flujo moría sin llegar a pedir la firma. Es el 502 indiagnosticable del
// recorrido manual del 2026-08-02.
describe("ConfirmAndSend — sin address de wallet no se le pregunta a la autoridad", () => {
  it("getAddress()→null ⇒ wallet_address_unavailable, NUNCA kyc_reauth_failed", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    vi.spyOn(wallet, "getAddress").mockResolvedValue(null); // la recarga borró el cache en memoria
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      new FakeRefundGateway(),
    ).execute({ remittanceId: id });

    expect(out.snapshot.failureReason).toBe("wallet_address_unavailable");
    // Lo que este test protege de verdad: que la causa NO se disfrace de la otra.
    expect(out.snapshot.failureReason).not.toBe("kyc_reauth_failed");
    // Y que el corte sea ANTES de la primera llamada de red del money-path. El aserto
    // `authority.calls == []` se cayó con el pre-check (WKH-333/DT-20) y su doble ya no se
    // construye; lo que queda mide lo mismo y es lo que importa: no se firmó nada y no se movió nada.
    expect(authorizeSpy).not.toHaveBeenCalled(); // no se le pidió una firma a la wallet
    expect(out.snapshot.principalTx).toBeNull(); // …ni se movió un USDC
  });

  it("getAddress()→'   ' (blanco) ⇒ mismo corte: un espacio no es una dirección", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    vi.spyOn(wallet, "getAddress").mockResolvedValue("   ");
    const authority = new FakePayoutAuthorityGateway({ authorized: true });
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      new FakeRefundGateway(),
    ).execute({ remittanceId: id });

    expect(out.snapshot.failureReason).toBe("wallet_address_unavailable");
    expect(authority.calls).toEqual([]);
  });

  // CANDADO DE NO-REGRESIÓN del camino feliz: con la address presente el guard no existe y el flujo
  // sigue hasta donde llegaba antes (acá, el tapón DT-8 por no tener `solana` inyectado). Si este
  // test se pone rojo, el guard de address se comió el camino de la demo.
  //
  // ⚠️ CAMBIÓ EN WKH-333: el aserto `authority.calls == [{verificationId:"v-1", ...}]` se cayó junto
  // con el pre-check (DT-20). Lo que este caso protege —que el guard de address NO se coma el camino
  // feliz— se mide igual con el desenlace, que es lo que siempre importó.
  it("con address presente: el flujo avanza igual que antes (el guard de address no lo come)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      new FakeRefundGateway(),
    ).execute({ remittanceId: id });

    expect(out.snapshot.failureReason).toBe("settlement_unavailable");
    expect(out.snapshot.failureReason).not.toBe("wallet_address_unavailable");
  });
});

describe("ConfirmAndSend — re-check de vigencia del quote (M2/AC-5)", () => {
  it("AC-5: el quote vence ENTRE confirm y la firma (ScriptedClock) → refunded, SIN firma", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const id = await seedQuoted(repo);

    // 1ª llamada (confirm) = T0 válido; 2ª (re-check) = 18:11 > QUOTE_EXPIRES (18:10).
    const clock = new ScriptedClock([T0, "2026-07-09T18:11:00.000Z"]);
    const out = await new ConfirmAndSend(
      wallet,
      repo,
      clock,
      new FakeRefundGateway(),
    ).execute({ remittanceId: id });

    expect(out.status).toBe("refunded"); // WKH-186: refund-on-failure; guard de expiry intacto
    expect(out.snapshot.failureReason).toBe("quote_expired_before_submit");
    expect(out.snapshot.principalTx).toBeNull();
    expect(authorizeSpy).not.toHaveBeenCalled();
  });
});

describe("ConfirmAndSend — refund-on-failure best-effort (WKH-186 AC-7)", () => {
  // Se conserva el invariante, re-cableado sobre un camino que SÍ existe. Ya iba por su segunda
  // mudanza: nació sobre un payout con status 'failed' (paso 4, inalcanzable post-poda) y pasó al
  // guard de autoridad.
  //
  // ⚠️ CAMBIÓ EN WKH-333 (DT-20): el guard de autoridad tampoco existe ya en este use-case, así que
  // el fallo se dispara desde el tapón fail-closed DT-8 (sin `solana` inyectado). Lo que el test mide
  // NO cambió y es lo único que siempre midió: si el credit-back RECHAZA, la remesa se queda en
  // `payout_failed` —que es el estado desde el cual la persona todavía puede sacar su plata— y
  // `execute()` NO lanza. El `reason` concreto es el disparador, no el objeto de la prueba.
  it("AC-7: si el credit-back falla (reject) la remesa queda en payout_failed, y execute NO lanza", async () => {
    const repo = new InMemoryRepo();
    const refund = new FakeRefundGateway("reject");
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(
      new FakeSolanaWallet(),
      repo,
      new FixedClock(),
      refund,
    ).execute({ remittanceId: id });

    expect(out.status).toBe("payout_failed"); // best-effort: NO escala a refunded ni tira
    expect(
      out.snapshot.refundTx,
      "se escribió una referencia de reembolso aunque el credit-back rechazó: la persona leería un " +
        "comprobante inventado y `refunded` es TERMINAL, así que perdería el botón de recuperar",
    ).toBeNull();
    expect(out.snapshot.failureReason).toBe("settlement_unavailable");
  });

  it("AC-7: el credit-back recibe el monto ENVIADO de la remesa, no otro", async () => {
    const repo = new InMemoryRepo();
    // WKH-333/DT-20: el doble de la autoridad ya no se inyecta en el use-case. El fallo que dispara
    // el credit-back ahora es el tapón DT-8 (sin `solana`), y el MONTO —lo único que este caso
    // mide— no depende de cuál sea la causa.
    const refund = new FakeRefundGateway();
    const id = await seedQuoted(repo);

    await new ConfirmAndSend(
      new FakeSolanaWallet(),
      repo,
      new FixedClock(),
      refund,
    ).execute({ remittanceId: id });

    expect(refund.calls).toHaveLength(1);
    expect(refund.calls[0]?.amountUsd).toEqual(Money.of(400, "USDC"));
    expect(refund.calls[0]?.remittanceId).toBe("r-1");
  });
});

describe("ConfirmAndSend — invariantes de entrada", () => {
  it("remesa inexistente → throw remittance_not_found (no devuelve algo a medias)", async () => {
    const repo = new InMemoryRepo();
    await expect(
      new ConfirmAndSend(
        new FakeSolanaWallet(),
        repo,
        new FixedClock(),
        new FakeRefundGateway(),
      ).execute({ remittanceId: "no-existe" }),
    ).rejects.toThrow("remittance_not_found");
  });
});
