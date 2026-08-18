// Tests — ConfirmAndSend, el money-path completo (HU-SOL-13/WKH-216): prepare → firma → settle →
// markPrincipalIn. AC-1: el deposit se cablea con beneficiary/authority resueltos SERVER-SIDE (del
// prepare, NUNCA del body). AC-4/CD-7: prepare !ok / gateway !ok / gateway throw ⇒ failAndRefund,
// NUNCA markPrincipalIn. Cero @solana/web3.js (fakes puros).
import { describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FAKE_SOLANA_AUTHORITY,
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_REFERENCE,
  FAKE_SOLANA_SIGNATURE,
  FakePayoutGateway,
  FakeRefundGateway,
  FakeSolanaEscrowDepositProbe,
  FakeSolanaEscrowRefundGateway,
  FakeSolanaPayoutPrepareGateway,
  type FakeSolanaPrepareResult, // WKH-354/AC-5: la forma de la respuesta del prepare, para el doble que VERIFICA la PoP
  FakeKycStore, // WKH-354/AC-5: el KYC de A, que el candado verifica que sigue entero
  FakeSolanaSenderSolBalanceProbe,
  FakePruebaDePosesionPorEnlace,
  FakeSolanaSettlementGateway,
  FakeSolanaWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../../test-support/fakes"; import { esperarListo } from "../../test-support/desenlaces"; // WKH-356: narrowing de ResultadoDeEnvio. TIRA si execute() suspende donde el test no lo espera.
import type { AutorizacionDelPrincipal, PruebaDePosesionPorEnlace, RefundGateway, SolanaPayoutPrepareGateway, WalletPort } from "../ports"; // WKH-356/AR/BLQ-BAJO-1: el doble que SUSPENDE una vez implementa el puerto REAL, así que no puede quedarse corto de contrato
import type { Beneficiary } from "../../domain/remittance"; // WKH-354/AC-5: el doble de prepare implementa el puerto REAL, así que declara el contrato real
import { LedgerRefundGateway } from "../../infrastructure/refund/ledger-refund-gateway";
import {
  ConfirmAndSend,
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
  SOLANA_SETTLE_LEDGER_UNAVAILABLE,
} from "./confirm-and-send";
import { RecoverEscrowFunds } from "./recover-escrow-funds";

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

// Construye el camino real: el 6º arg `solana` (prepare+gateway acoplados). WKH-320: ya no hay 7º/8º
// args (`settlement` EVM y `pop`) porque no hay una segunda VM con la que ser mutuamente excluyente.
function build(
  repo: InMemoryRepo,
  wallet: FakeSolanaWallet,
  // WKH-354/AC-5: el tipo es el PUERTO, no el doble concreto. Antes era `FakeSolanaPayoutPrepareGateway`
  // y eso obligaba a castear cualquier otro doble que implemente el mismo contrato; un `as unknown as`
  // acá apagaría justamente el chequeo que hace que el doble nuevo tenga que respetar el puerto real.
  prepare: SolanaPayoutPrepareGateway,
  gateway: FakeSolanaSettlementGateway,
  _payouts?: FakePayoutGateway,
  // RefundGateway (la interfaz), NO el fake: los tests tienen que poder cablear el adapter REAL de
  // producción, que es el único que dice la verdad sobre si hubo reembolso.
  refund: RefundGateway = new FakeRefundGateway(),
  // La respuesta de la cadena a "¿entró el principal?". Default "not_deposited" = lo que pasa en los
  // casos que cortan antes del broadcast; los casos donde la tx YA salió pasan el suyo explícito.
  probe: FakeSolanaEscrowDepositProbe = new FakeSolanaEscrowDepositProbe("not_deposited"),
  // El saldo de SOL del remitente. Default = 1 SOL, muy por encima del rent de las cuentas del escrow:
  // ningún test de este archivo va sobre el guard de rent, así que todos siguen recorriendo el camino
  // completo. Los que SÍ van sobre el guard viven en confirm-and-send.sol-balance.test.ts.
  senderBalance: FakeSolanaSenderSolBalanceProbe = new FakeSolanaSenderSolBalanceProbe(),
  // WKH-359 — el puerto de la prueba de posesión por enlace. Default `no-corresponde` = el camino
  // INYECTADO, que es el de todos los `it` de este archivo (AC-8): si el paso nuevo tocara ese camino,
  // se pondrían rojos ellos y no habría que escribir un `it` para notarlo.
  pop: PruebaDePosesionPorEnlace = new FakePruebaDePosesionPorEnlace(),
): ConfirmAndSend {
  return new ConfirmAndSend(
    wallet,
    repo,
    new FixedClock(),
    refund,
    { prepare, gateway, probe, senderBalance, pop },
  );
}

describe("ConfirmAndSend — el money-path completo (HU-SOL-13)", () => {
  it("T1/AC-1: happy — beneficiary/authority server-side → authorizePrincipal(escrow) → settle → markPrincipalIn + payout_submitted", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);

    const out = esperarListo(await build(repo, wallet, prepare, gateway, payouts).execute({ remittanceId: id }));

    // prepare resolvió {beneficiary, authority} server-side (una sola llamada).
    expect(prepare.calls).toHaveLength(1);
    // authorizePrincipal recibió el escrow con beneficiary/authority DEL PREPARE (server-side), NUNCA del body.
    expect(wallet.authorizeCalls).toHaveLength(1);
    expect(wallet.authorizeCalls[0]!.deposit?.escrow).toEqual({
      beneficiary: FAKE_SOLANA_BENEFICIARY,
      authority: FAKE_SOLANA_AUTHORITY,
    });
    // gateway.settle broadcasteó la tx partial-firmada + reference.
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]!.partialSignedTx).toBe("AQID");
    expect(gateway.calls[0]!.remittanceId).toBe("r-1");
    // markPrincipalIn con la signature base58 verificada on-chain por /solana/sponsor.
    expect(out.snapshot.principalTx).toBe(FAKE_SOLANA_SIGNATURE);
    // payout_submitted con el payoutId + provenance de prepare (la orden TransFi ya se creó).
    expect(out.status).toBe("payout_submitted");
    expect(out.snapshot.payoutId).toBe("transfi-sol-po-1");
    expect(out.snapshot.payoutProvenance).toBe("transfi");
    // El submit del payout NO se llama: la release la dispara el facilitator async.
    expect(submitSpy).not.toHaveBeenCalled();
  });

  // ── T-062-1 (AC-2 / CD-1) ───────────────────────────────────────────────────────────────────────
  //
  // 🔴 EL CANDADO DE LA REGRESIÓN BYTE-IDÉNTICA. WKH-356 metió un envoltorio (`{ estado: "listo", … }`)
  // en el retorno de `authorizePrincipal` y otro (`{ estado: "listo", remesa }`) en el de `execute()`.
  // Lo ÚNICO que puede cambiar es ese envoltorio: ni un campo del envelope, ni el orden de los guards,
  // ni lo que llega al settle. Este `it` fija los TRES campos que el use-case saca del envelope y los
  // cruza contra los que la billetera devolvió, uno por uno.
  //
  // ⚠️ QUÉ MIDE Y QUÉ NO. Esto mide que el use-case no perdió ni cambió nada al desenvolver. Que el
  // ADAPTADOR real siga produciendo los mismos bytes lo mide `solana-wallet.test.ts`, cuyos ~40 `it`
  // pasaron esta HU **sin que se tocara un solo dato de expectativa** — el control es
  // `git diff -U0 -- '*.test.ts*' | grep '^[-+].*expect('`, que en W0 devolvió CERO líneas.
  //
  // MUTANTE QUE MATA: cambiar cualquiera de los tres campos que el use-case pasa al settle
  // (`partialSignedTx`, `reference`, `popSignature`), o devolver la `Remittance` sin envolver. Si este
  // `it` muere por OTRA cosa, el cambio no fue neutral y hay que mirar qué se movió.
  // ⚠️ CD-15 · MUTANTE CORRIDO (2026-08-17, re-medido en el fix-pack 1 con la suite completa): cambiar
  // `reference: reference.toBase58()` por una constante en el envelope del adaptador REAL ⇒ exit=1 con 2
  // `it` rojos, los dos de `solana-wallet.test.ts` que fijan el envelope. Este `it` NO lo caza (usa un
  // doble), y eso está dicho arriba: el candado del adaptador es su propia suite, sin datos de
  // expectativa tocados.
  // ── AR/BLQ-BAJO-1 — LO QUE LA REANUDACIÓN LE CUESTA AL `prepare()`, MEDIDO ────────────────────────
  //
  // 🔴 ESTE `it` NO CELEBRA NADA: fija el precio de la decisión para que nadie tenga que descubrirlo en
  // producción. La reanudación vuelve a llamar `prepare()` ÍNTEGRO, y eso significa una orden de payout
  // real por invocación (más su atestación y su fila de ledger), con la remesa guardando sólo el ÚLTIMO
  // `payoutId`. No se puede evitar sin perder la atestación server-side (DT-4(b)), y por eso está
  // escrito acá en vez de acotado con una palabra amable.
  //
  // ⚠️ Y FIJA LO ÚNICO QUE ESTE CLIENTE SÍ PUEDE GARANTIZAR: la `idempotencyKey` es la MISMA en las dos
  // invocaciones. Si el servidor deduplica algún día por `(remittanceId, quoteId)`, esto es lo que hace
  // que ese dedupe funcione; y si no deduplica, esto es lo que hace que la duplicación sea diagnosticable
  // en el ledger en vez de invisible. La idempotencia del lado del servidor es una PRECONDICIÓN de AC-5
  // que este repo no puede medir, y así queda declarada.
  // MUTANTE QUE MATA (MEDIDO: exit=1, 1 `it` rojo, éste): meterle el reloj a la `idempotencyKey`
  //   (`${s.id}:${quote.quoteId}:${Date.now()}`) ⇒ las dos claves dejan de coincidir. Es el mutante
  //   barato que hoy no detectaría nada más.
  //
  // ⚠️ MUTANTE QUE **SOBREVIVE**, y va escrito porque medirlo es lo que lo vuelve honesto: sacarle el
  //   `quoteId` a la clave (dejar `${s.id}`) da **exit=0**. O sea que lo que está bajo candado es la
  //   ESTABILIDAD de la clave entre invocaciones, NO su contenido. Si algún día el servidor deduplica
  //   por `(remittanceId, quoteId)`, el contenido pasa a importar y ahí hace falta un `it` que lo fije;
  //   hoy no existe y decirlo es más útil que fingir que sí.
  it("AR/BLQ-BAJO-1: la reanudación vuelve a llamar `prepare()` (2 órdenes) con la MISMA idempotencyKey", async () => {
    const repo = new InMemoryRepo();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const id = await seedQuoted(repo);

    /** Una billetera que SUSPENDE la primera vez y completa la segunda: es el recorrido por enlace. */
    class BilleteraQueSuspendeUnaVez implements WalletPort {
      public autorizaciones: Array<{ beneficiary?: string; authority?: string }> = [];
      async connect(): Promise<string> {
        return FAKE_SOLANA_BENEFICIARY;
      }
      async getAddress(): Promise<string | null> {
        return FAKE_SOLANA_BENEFICIARY;
      }
      async authorizePrincipal(
        _q: Quote,
        _rem: string,
        deposit?: { address: string; escrow?: { beneficiary: string; authority: string } },
      ): Promise<AutorizacionDelPrincipal> {
        this.autorizaciones.push({
          beneficiary: deposit?.escrow?.beneficiary,
          authority: deposit?.escrow?.authority,
        });
        if (this.autorizaciones.length === 1) {
          return { estado: "hay-que-salir", irA: "https://phantom.app/ul/v1/x", esperando: "firma-tx" };
        }
        return {
          estado: "listo",
          tx: "AQID",
          solana: {
            vm: "solana",
            partialSignedTx: "AQID",
            reference: FAKE_SOLANA_REFERENCE,
            popSignature: "POP",
          },
        };
      }
      async signMessage(): Promise<string> {
        return "sig";
      }
    }

    const wallet = new BilleteraQueSuspendeUnaVez();
    const uc = new ConfirmAndSend(wallet, repo, new FixedClock(), new FakeRefundGateway(), {
      prepare,
      gateway,
      probe: new FakeSolanaEscrowDepositProbe("not_deposited"),
      senderBalance: new FakeSolanaSenderSolBalanceProbe(),
      pop: new FakePruebaDePosesionPorEnlace(), // WKH-359: `no-corresponde` = camino inyectado (AC-8)
    });

    // Invocación 1: suspende. La remesa QUEDA en `confirmed`, que es la precondición de AC-3.
    const primera = await uc.execute({ remittanceId: id });
    expect(primera.estado).toBe("hay-que-salir");
    expect((await repo.get(id))?.status).toBe("confirmed");

    // Invocación 2: la reanudación. Cierra.
    const segunda = esperarListo(await uc.execute({ remittanceId: id }));
    expect(segunda.status).toBe("payout_submitted");

    // EL COSTO, dicho con un número: DOS prepare ⇒ DOS órdenes de payout server-side, y la remesa se
    // queda con el `payoutId` de la última. La primera queda huérfana y la levanta la reconciliación.
    expect(prepare.calls).toHaveLength(2);
    // LA GARANTÍA: la misma clave las dos veces, y el mismo destino atestado en las dos firmas.
    const claves = prepare.calls.map((c) => c.idempotencyKey);
    expect(new Set(claves).size, `la idempotencyKey cambió entre invocaciones: ${claves.join(" | ")}`).toBe(1);
    expect(wallet.autorizaciones).toEqual([
      { beneficiary: FAKE_SOLANA_BENEFICIARY, authority: FAKE_SOLANA_AUTHORITY },
      { beneficiary: FAKE_SOLANA_BENEFICIARY, authority: FAKE_SOLANA_AUTHORITY },
    ]);
  });

  it("T-062-1/AC-2: el camino inyectado llega a markPrincipalIn + payout_submitted con el envelope INTACTO", async () => {
    const repo = new InMemoryRepo();
    // El envelope se declara acá, explícito, para poder cruzarlo campo por campo contra lo que llega
    // al settle. Un default compartido dejaría el `toBe` comparándose consigo mismo.
    const envelope = {
      vm: "solana" as const,
      partialSignedTx: "QUdJRC1JTllFQ1RBRE8=",
      // Valores LITERALES y distintos de los defaults del doble a propósito: con los defaults, un
      // `toBe` contra la constante compartida se compararía consigo mismo y pasaría aunque el
      // use-case leyera el campo equivocado.
      reference: "REFERENCE-DEL-INTENTO-062-1",
      popSignature: "POP-DEL-VIAJE-062-1",
    };
    const wallet = new FakeSolanaWallet(envelope);
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const id = await seedQuoted(repo);

    const res = await build(repo, wallet, prepare, gateway).execute({ remittanceId: id });

    // 1. El desenlace es `listo` y NO una suspensión: el camino inyectado no suspende nunca.
    expect(
      res.estado,
      "el camino de la billetera inyectada devolvió una suspensión: eso es el camino de enlace " +
        "profundo, que al cerrar 062 no tiene activación de producción (CD-13)",
    ).toBe("listo");
    if (res.estado !== "listo") return;
    const out = res.remesa;

    // 2. Los TRES campos del envelope llegan al settle SIN cambiar (el `tx` de la unión es el mismo
    //    `partialSignedTx`, que es el shape base del puerto).
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]!.partialSignedTx).toBe(envelope.partialSignedTx);
    expect(gateway.calls[0]!.reference).toBe(envelope.reference);
    expect(gateway.calls[0]!.popSignature).toBe(envelope.popSignature);
    expect(gateway.calls[0]!.remittanceId).toBe("r-1");

    // 3. Y el orden de los guards no se movió: el prepare corrió UNA vez y ANTES de la firma.
    expect(prepare.calls).toHaveLength(1);
    expect(wallet.authorizeCalls).toHaveLength(1);
    expect(wallet.authorizeCalls[0]!.deposit?.escrow).toEqual({
      beneficiary: FAKE_SOLANA_BENEFICIARY,
      authority: FAKE_SOLANA_AUTHORITY,
    });

    // 4. El desenlace de siempre: principal_in con la signature verificada + payout_submitted.
    expect(out.snapshot.principalTx).toBe(FAKE_SOLANA_SIGNATURE);
    expect(out.status).toBe("payout_submitted");
    expect(out.snapshot.payoutId).toBe("transfi-sol-po-1");
  });

  // Trazabilidad de la plata: la remesa tiene que poder decir QUIÉN dio el beneficiary contra el
  // que la persona firmó. Sin esto, con el carril de estreno encendido, Chaski atestaría una
  // dirección sin poder decir de dónde salió.
  it("guarda con la remesa el agente que dio el beneficiary (slug, carril de estreno incluido)", async () => {
    const repo = new InMemoryRepo();
    const prepare = new FakeSolanaPayoutPrepareGateway({
      ok: true,
      result: {
        beneficiary: FAKE_SOLANA_BENEFICIARY,
        authority: FAKE_SOLANA_AUTHORITY,
        attestation: "att",
        payoutId: "transfi-sol-po-1",
        provenance: "transfi",
        agent: {
          slug: "remit-cashout-payout",
          registry: "WasiAI",
          capability: "remittance-payout",
          trial: true,
        },
      },
    });
    const id = await seedQuoted(repo);

    const out = esperarListo(await build(
      repo,
      new FakeSolanaWallet(),
      prepare,
      new FakeSolanaSettlementGateway(),
    ).execute({ remittanceId: id }));

    expect(out.status).toBe("payout_submitted");
    expect(out.snapshot.payoutAgent).toEqual({
      slug: "remit-cashout-payout",
      registry: "WasiAI",
      capability: "remittance-payout",
      trial: true,
    });
  });

  // No saber quién atendió es un estado legítimo y se guarda como tal. Rellenar con un objeto
  // vacío afirmaría que sabemos y no diríamos quién.
  it("sin agente informado, payoutAgent queda null (no un objeto fabricado)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);

    const out = esperarListo(await build(
      repo,
      new FakeSolanaWallet(),
      new FakeSolanaPayoutPrepareGateway(),
      new FakeSolanaSettlementGateway(),
    ).execute({ remittanceId: id }));

    expect(out.status).toBe("payout_submitted");
    expect(out.snapshot.payoutAgent).toBeNull();
  });

  it("T2/AC-1: prepare !ok ⇒ failAndRefund ANTES de firmar; authorizePrincipal + settle NUNCA; principalTx null", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway({ ok: false, reason: "prepare_no_deposit_address" });
    const gateway = new FakeSolanaSettlementGateway();
    const id = await seedQuoted(repo);

    const out = esperarListo(await build(repo, wallet, prepare, gateway, new FakePayoutGateway()).execute({
      remittanceId: id,
    }));

    expect(wallet.authorizeCalls).toHaveLength(0); // NUNCA firmó
    expect(gateway.calls).toHaveLength(0); // NUNCA broadcasteó
    expect(out.snapshot.principalTx).toBeNull(); // NUNCA markPrincipalIn
    expect(out.status).toBe("refunded"); // refund-on-failure (FakeRefundGateway resuelve)
    expect(out.snapshot.failureReason).toBe("prepare_no_deposit_address");
  });

  it("T2/AC-4: gateway !ok ⇒ failAndRefund; firma SÍ ocurre, markPrincipalIn NUNCA; principalTx null", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway({ ok: false, reason: "solana_settle_rejected" });
    const id = await seedQuoted(repo);

    const out = esperarListo(await build(repo, wallet, prepare, gateway, new FakePayoutGateway()).execute({
      remittanceId: id,
    }));

    expect(wallet.authorizeCalls).toHaveLength(1); // firmó (arma la ix deposit)
    expect(gateway.calls).toHaveLength(1); // intentó broadcastear
    expect(out.snapshot.principalTx).toBeNull(); // pero NUNCA markPrincipalIn
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("solana_settle_rejected");
  });

  it("T2/AC-4: gateway throw (red/bug) ⇒ fail-closed solana_settle_unavailable; principalTx null", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway(undefined, "reject"); // settle() throw
    const id = await seedQuoted(repo);

    const out = esperarListo(await build(repo, wallet, prepare, gateway, new FakePayoutGateway()).execute({
      remittanceId: id,
    }));

    expect(out.snapshot.principalTx).toBeNull();
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("solana_settle_unavailable");
  });

  // ── El comprobante que no existe ──────────────────────────────────────────────────────────────
  // Con el adapter REAL (LedgerRefundGateway, el que corre en producción) no hay reembolso: no
  // revierte nada. Antes devolvía igual un `refund-ledger-…` fabricado y la remesa terminaba en
  // `refunded` (terminal), mostrándole a la persona una referencia de reembolso inventada.
  it("adapter REAL sin comprobante ⇒ payout_failed con refundTx null, NUNCA refunded ni referencia inventada", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway({ ok: false, reason: "solana_settle_rejected" });
    const id = await seedQuoted(repo);

    const out = esperarListo(await build(
      repo,
      wallet,
      prepare,
      gateway,
      new FakePayoutGateway(),
      new LedgerRefundGateway(), // producción, no fake
    ).execute({ remittanceId: id }));

    expect(out.status).toBe("payout_failed");
    expect(out.status).not.toBe("refunded");
    expect(out.snapshot.refundTx).toBeNull();
    // Y nada con forma de comprobante fabricado quedó persistido.
    const saved = await repo.get(id);
    expect(saved?.snapshot.refundTx).toBeNull();
    expect(saved?.snapshot.refundTx ?? "").not.toMatch(/refund-ledger-/);
  });

  it("T2/AC-1: sin envelope solana (wallet no arma el deposit) ⇒ settlement_unverified, sin broadcast", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet(null); // authorizePrincipal devuelve { tx } sin solana
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const id = await seedQuoted(repo);

    const out = esperarListo(await build(repo, wallet, prepare, gateway, new FakePayoutGateway()).execute({
      remittanceId: id,
    }));

    expect(gateway.calls).toHaveLength(0); // NUNCA broadcastea sin envelope
    expect(out.snapshot.principalTx).toBeNull();
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("settlement_unverified");
  });
});

// ── Los TRES casos del principal cuando el settle no nos dio un sí ────────────────────────────────
// Antes había dos, y el que faltaba era el peligroso: "no pudimos averiguarlo" se escribía como "no
// entró", y sobre ese "no entró" se emitía un reembolso que nadie hizo. Cada caso se clava por
// separado; si dos colapsan en uno, alguno de estos tests se pone rojo.
describe("ConfirmAndSend: sabemos que no entró / sabemos que sí / no pudimos averiguarlo", () => {
  function afterSettleFailure(
    repo: InMemoryRepo,
    probe: FakeSolanaEscrowDepositProbe,
    gateway: FakeSolanaSettlementGateway,
  ) {
    return build(
      repo,
      new FakeSolanaWallet(),
      new FakeSolanaPayoutPrepareGateway(),
      gateway,
      new FakePayoutGateway(),
      new FakeRefundGateway("no-receipt"), // el adapter REAL no revierte nada
      probe,
    );
  }
  const throwingGateway = () => new FakeSolanaSettlementGateway(undefined, "reject");

  it("CASO 1: la cadena dice que NO entró: se conserva el reason puntual del settle", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("not_deposited");

    const out = esperarListo(await afterSettleFailure(repo, probe, throwingGateway()).execute({
      remittanceId: id,
    }));

    expect(out.snapshot.failureReason).toBe("solana_settle_unavailable");
    expect(out.status).toBe("payout_failed");
    expect(out.snapshot.refundTx).toBeNull();
    expect(out.snapshot.principalTx).toBeNull();
  });

  it("CASO 2: la cadena dice que SÍ entró: marca de resolución manual, NUNCA el reason del settle", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("deposited");

    const out = esperarListo(await afterSettleFailure(repo, probe, throwingGateway()).execute({
      remittanceId: id,
    }));

    expect(out.snapshot.failureReason).toBe(PRINCIPAL_SETTLED_REFUND_MANUAL);
    expect(out.snapshot.failureReason).not.toBe("solana_settle_unavailable");
    // La plata está en el vault: la remesa NO puede quedar terminal ni mostrar comprobante.
    expect(out.status).toBe("payout_failed");
    expect(out.snapshot.refundTx).toBeNull();
    // markPrincipalIn sigue exigiendo la signature verificada: el probe NO la reemplaza.
    expect(out.snapshot.principalTx).toBeNull();
    // Se le preguntó a la cadena por ESTA remesa y ESTE sender (la PDA se deriva de los dos).
    expect(probe.calls).toEqual([{ remittanceId: "r-1", sender: FAKE_SOLANA_BENEFICIARY }]);
  });

  it("CASO 3: no pudimos averiguarlo: reason propio, y NO se colapsa en ninguno de los otros dos", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("unknown");

    const out = esperarListo(await afterSettleFailure(repo, probe, throwingGateway()).execute({
      remittanceId: id,
    }));

    expect(out.snapshot.failureReason).toBe(PRINCIPAL_STATE_UNKNOWN);
    expect(out.snapshot.failureReason).not.toBe("solana_settle_unavailable"); // ni "no entró"
    expect(out.snapshot.failureReason).not.toBe(PRINCIPAL_SETTLED_REFUND_MANUAL); // ni "sí entró"
    expect(out.status).toBe("payout_failed"); // recuperable
    expect(out.snapshot.refundTx).toBeNull(); // sin comprobante inventado
  });

  it("el probe se cae ⇒ unknown: un error al preguntar NO es una respuesta negativa", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("not_deposited", "reject"); // lanza

    const out = esperarListo(await afterSettleFailure(repo, probe, throwingGateway()).execute({
      remittanceId: id,
    }));

    expect(out.snapshot.failureReason).toBe(PRINCIPAL_STATE_UNKNOWN);
  });

  // El timeout de 15 s de /api/settle/solana-sponsor llega como `solana_settle_unavailable` con
  // ok:false, NO como excepción (el gateway HTTP ya atrapa el fetch). Es EL caso de producción: el
  // facilitator pudo haber broadcasteado y confirmado el depósito mientras nosotros dejábamos de
  // esperar. Si esta rama no pregunta, el bug sigue vivo por el camino más frecuente.
  it("timeout del settle (ok:false unavailable) ⇒ pregunta a la cadena, no asume que no pasó", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("unknown");
    const gateway = new FakeSolanaSettlementGateway({
      ok: false,
      reason: "solana_settle_unavailable",
    });

    const out = esperarListo(await afterSettleFailure(repo, probe, gateway).execute({ remittanceId: id }));

    expect(probe.calls).toHaveLength(1);
    expect(out.snapshot.failureReason).toBe(PRINCIPAL_STATE_UNKNOWN);
  });

  it("200 con shape inválido (unverified) ⇒ pregunta a la cadena: un 200 es compatible con un depósito hecho", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("deposited");
    const gateway = new FakeSolanaSettlementGateway({
      ok: false,
      reason: "solana_settle_unverified",
    });

    const out = esperarListo(await afterSettleFailure(repo, probe, gateway).execute({ remittanceId: id }));

    expect(probe.calls).toHaveLength(1);
    expect(out.snapshot.failureReason).toBe(PRINCIPAL_SETTLED_REFUND_MANUAL);
  });

  it("broadcast_failed (409/502) ⇒ pregunta a la cadena: un blockhash vencido no prueba que no entró antes", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("deposited");
    const gateway = new FakeSolanaSettlementGateway({
      ok: false,
      reason: "solana_settle_broadcast_failed",
    });

    const out = esperarListo(await afterSettleFailure(repo, probe, gateway).execute({ remittanceId: id }));

    expect(probe.calls).toHaveLength(1);
    expect(out.snapshot.failureReason).toBe(PRINCIPAL_SETTLED_REFUND_MANUAL);
  });

  // La otra mitad de la regla: cuando la respuesta viene de ANTES del broadcast, la cadena no aporta
  // nada y no se la molesta. Sin este test, "preguntar siempre" pasaría igual y perderíamos la
  // distinción entre un no medido y un no supuesto.
  it("rejected (422) y rate_limited (429) ⇒ NO se pregunta: la tx nunca salió", async () => {
    for (const reason of ["solana_settle_rejected", "solana_settle_rate_limited"] as const) {
      const repo = new InMemoryRepo();
      const id = await seedQuoted(repo);
      const probe = new FakeSolanaEscrowDepositProbe("deposited"); // aunque dijera que sí
      const gateway = new FakeSolanaSettlementGateway({ ok: false, reason });

      const out = esperarListo(await afterSettleFailure(repo, probe, gateway).execute({ remittanceId: id }));

      expect(probe.calls).toHaveLength(0);
      expect(out.snapshot.failureReason).toBe(reason);
    }
  });

  // LOS DOS REASONS QUE LLEGARON DESPUÉS (guard del destino, S3.5 del settle). Los emite NUESTRA
  // propia route ANTES del forward al facilitator: no hubo broadcast, no se gastó un token de rate
  // limit, no se escribió una fila. O sea que "no entró" acá NO es una suposición, es un hecho, y
  // preguntarle a la cadena sobre un hecho conocido tiene un costo concreto: si el probe contesta
  // cualquier otra cosa, el reason del guard se PIERDE y la remesa deja de poder decir por qué falló.
  // `solana_settle_beneficiary_mismatch` es el único reason de todo el catálogo que describe un
  // ataque en curso: si se sobrescribe con "no sabemos", el ataque se vuelve invisible.
  it("los reasons del guard de destino ⇒ NO se pregunta: la route cortó antes del forward", async () => {
    for (const reason of [
      "solana_settle_beneficiary_mismatch",
      "solana_settle_beneficiary_unconfirmed",
    ] as const) {
      const repo = new InMemoryRepo();
      const id = await seedQuoted(repo);
      const probe = new FakeSolanaEscrowDepositProbe("deposited"); // aunque dijera que sí
      const gateway = new FakeSolanaSettlementGateway({ ok: false, reason });

      const out = esperarListo(await afterSettleFailure(repo, probe, gateway).execute({ remittanceId: id }));

      expect(probe.calls).toHaveLength(0);
      expect(out.snapshot.failureReason).toBe(reason);
      expect(out.snapshot.failureReason).not.toBe(PRINCIPAL_STATE_UNKNOWN);
      expect(out.snapshot.refundTx).toBeNull();
      expect(out.snapshot.principalTx).toBeNull();
    }
  });

  // ── EL TERCER REASON DEL GUARD S3.5: "no pude preguntarle al ledger" ──────────────────────────
  // Sale del catch de `listPreparedDepositAddresses` (route.ts:126-133), que está ANTES del fetch al
  // facilitator: no hubo forward, no hay tx viajando. Antes de tener reason propio compartía enum
  // con el timeout de 15 s y por eso caía afuera de la lista: se le preguntaba a la cadena, la
  // cadena no encontraba una cuenta que nunca se creó, y la remesa terminaba con
  // PRINCIPAL_STATE_UNKNOWN. Este test es EL candado de que el reason esté en la lista: sacarlo de
  // SETTLE_REASONS_BEFORE_BROADCAST vuelve a llamar al probe y vuelve a pisar el reason.
  it("★ ledger_unavailable ⇒ NO se pregunta a la cadena y el reason sobrevive: la route cortó antes del forward", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    // El probe contesta "deposited" a propósito: si alguien lo llamara, PISARÍA el reason con la
    // marca de resolución manual y la pantalla mandaría a recuperar unos USDC que nunca salieron.
    const probe = new FakeSolanaEscrowDepositProbe("deposited");
    const gateway = new FakeSolanaSettlementGateway({
      ok: false,
      reason: SOLANA_SETTLE_LEDGER_UNAVAILABLE,
    });

    const out = esperarListo(await afterSettleFailure(repo, probe, gateway).execute({ remittanceId: id }));

    expect(probe.calls).toHaveLength(0);
    expect(out.snapshot.failureReason).toBe(SOLANA_SETTLE_LEDGER_UNAVAILABLE);
    expect(out.snapshot.failureReason).not.toBe(PRINCIPAL_STATE_UNKNOWN); // ni "no sabemos"
    expect(out.snapshot.failureReason).not.toBe(PRINCIPAL_SETTLED_REFUND_MANUAL); // ni "está adentro"
    expect(out.snapshot.principalTx).toBeNull();
    expect(out.snapshot.refundTx).toBeNull();
  });

  // ── EL CANDADO QUE PROTEGE AL OTRO LADO, y es el más importante de los dos ─────────────────────
  // El atajo tentador para arreglar lo de arriba era meter `solana_settle_unavailable` en
  // SETTLE_REASONS_BEFORE_BROADCAST. Ese enum ES el del timeout de 15 s del fetch al facilitator, o
  // sea un corte POSTERIOR al broadcast: con el atajo, una remesa cuyo depósito la cadena confirma
  // pasaría a decir "no entró". Este test lo mata explícitamente, y por eso mira el desenlace más
  // caro: probe = "deposited". Si el mutante entra, `failureReason` deja de ser la marca de
  // resolución manual y quien tenga USDC en el vault deja de tener quién se lo diga.
  it("★ MUTANTE: si `solana_settle_unavailable` entrara en la lista, el timeout de 15 s afirmaría en falso", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("deposited");
    const gateway = new FakeSolanaSettlementGateway({
      ok: false,
      reason: "solana_settle_unavailable", // el 503 del timeout, POSTERIOR al broadcast
    });

    const out = esperarListo(await afterSettleFailure(repo, probe, gateway).execute({ remittanceId: id }));

    // Se le preguntó a la cadena. Con el enum compartido en la lista, esto sería 0.
    expect(probe.calls).toHaveLength(1);
    // Y lo que quedó escrito es lo que la cadena contestó, NO el reason del settle.
    expect(out.snapshot.failureReason).toBe(PRINCIPAL_SETTLED_REFUND_MANUAL);
    expect(out.snapshot.failureReason).not.toBe("solana_settle_unavailable");
    // El reason nuevo tampoco se filtra acá: son dos enums distintos y este flujo usa el compartido.
    expect(out.snapshot.failureReason).not.toBe(SOLANA_SETTLE_LEDGER_UNAVAILABLE);
    expect(out.status).toBe("payout_failed"); // recuperable: la plata está en el vault
  });

  // El cierre del círculo: el caso indeterminado tiene que dejar a la persona PODER recuperar. Antes
  // la remesa quedaba en `refunded` y este mismo use-case cortaba con refund_not_available.
  it("tras el caso indeterminado el sender PUEDE recuperar sus fondos del escrow", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const probe = new FakeSolanaEscrowDepositProbe("unknown");

    const out = esperarListo(await afterSettleFailure(repo, probe, throwingGateway()).execute({
      remittanceId: id,
    }));
    expect(out.snapshot.failureReason).toBe(PRINCIPAL_STATE_UNKNOWN);

    // El sender firma el refund trustless del escrow y la cadena lo confirma.
    const recovered = await new RecoverEscrowFunds(
      repo,
      new FixedClock(),
      new FakeSolanaEscrowRefundGateway(),
    ).execute({ remittanceId: id, sender: FAKE_SOLANA_BENEFICIARY });

    expect(recovered.confirmation).toBe("confirmed");
    expect(recovered.remittance.status).toBe("refunded");
    // Y ESTE comprobante sí existe: es una signature real, no un refund-ledger- inventado.
    expect(recovered.remittance.snapshot.refundTx).toBe(FAKE_SOLANA_SIGNATURE);
  });
});

// ── T7 / DT-8 (WKH-320) — el tapón fail-closed ────────────────────────────────────────────────────
// Este settlement es el ÚNICO que existe: si no está inyectado no hay un camino alternativo al que
// caer, se cae al vacío. Sin este tapón, execute() llegaría al final y devolvería la remesa
// 'confirmed' SIN haber movido nada — un no-op silencioso en el money-path, peor que el throw de antes.
describe("ConfirmAndSend — DT-8: sin `solana` inyectado (WKH-320)", () => {
  it("T7: solana === undefined ⇒ payout_failed/refunded con reason settlement_unavailable", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const refund = new FakeRefundGateway();
    const id = await seedQuoted(repo);

    const out = esperarListo(await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      refund,
      // sin 6º arg: flag apagado / envs faltantes
    ).execute({ remittanceId: id }));

    // NUNCA 'confirmed' en silencio.
    expect(out.status).toBe("refunded");
    expect(out.status).not.toBe("confirmed");
    expect(out.snapshot.failureReason).toBe("settlement_unavailable");
    // NUNCA markPrincipalIn: no entró un peso.
    expect(out.snapshot.principalTx).toBeNull();
    // Y ni siquiera se le pidió la firma a la wallet.
    expect(authorizeSpy).not.toHaveBeenCalled();
    // El credit-back corrió en el MISMO execute (ninguna remesa queda huérfana).
    expect(refund.calls).toHaveLength(1);
    expect(refund.calls[0]?.reason).toBe("settlement_unavailable");
  });

  it("T7: NINGUNA excepción escapa de execute() (fail-closed controlado, no un throw crudo)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    await expect(
      new ConfirmAndSend(
        new FakeSolanaWallet(),
        repo,
        new FixedClock(),
        new FakeRefundGateway(),
      ).execute({ remittanceId: id }),
    ).resolves.toBeDefined();
  });
});

// ── WKH-354/AC-5 ─────────────────────────────────────────────────────────────────────────────────
// La cuenta que la wallet tiene activa AHORA (B) es distinta de la que este envío verificó (A).
//
// 🔒 ESTE DESCRIBE ES EL CANDADO DE LA HU, y lo que prueba es que el fail-closed vive EN EL
// MONEY-PATH y no en la pantalla: corre a nivel use-case, sin montar nada de UI y SIN el guard de
// `onConfirm`. Pasó con el código de `1e4fe62` (o sea, antes de que WKH-354 tocara la UI), que es
// justamente lo que lo vuelve un candado de regresión y no la prueba de una feature nueva.
const CUENTA_B = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8"; // base58, la cuenta que la persona activó DESPUÉS

/**
 * El doble del `/api/payout/prepare` que VERIFICA la prueba de posesión.
 *
 * 🔴 DERIVA su respuesta; NO lleva una bandera. Recibe la clave que firma de verdad (`signerAddress`)
 * y contesta comparándola contra el `address` que le llega en el input, que es exactamente el
 * criterio del servidor: el challenge se emite para `ch.address` y la firma se verifica ed25519
 * contra ESA pubkey (`app/api/payout/prepare/route.ts`, `verifySolanaPop`).
 *
 * Un `boolean okOrNot` / `shouldFail` / `mode: "reject"` en vez de esta comparación convertiría el
 * candado en una tautología: el test estaría afirmando lo que él mismo configuró, y el mismo doble
 * haría pasar los cinco asserts sin probar nada sobre la comparación. Por eso la ÚNICA entrada
 * permitida es `signerAddress`, y por eso existe el control de acá abajo.
 */
class FakePopVerifyingPrepareGateway implements SolanaPayoutPrepareGateway {
  public calls: Array<{ address: string }> = [];
  constructor(private readonly signerAddress: string) {}
  async prepare(input: {
    remittanceId: string;
    quoteId: string;
    address: string;
    amountUsd: number;
    beneficiary: Beneficiary;
    idempotencyKey: string;
  }): Promise<FakeSolanaPrepareResult> {
    this.calls.push({ address: input.address });
    // El challenge fue emitido para `input.address`; quien firma es `signerAddress`. Si no son la
    // misma pubkey, la verificación ed25519 no cierra y el server contesta 403.
    if (input.address !== this.signerAddress) {
      return { ok: false as const, reason: "payout_pop_unverified" };
    }
    return {
      ok: true as const,
      result: {
        beneficiary: FAKE_SOLANA_BENEFICIARY,
        authority: FAKE_SOLANA_AUTHORITY,
        attestation: "solana-deposit-att-fake",
        payoutId: "transfi-sol-po-1",
        provenance: "transfi",
      },
    };
  }
}

describe("WKH-354/AC-5 · una firma de B NO puede pagar un depósito emitido para A", () => {
  it("T-354-5: la wallet cambió a B ⇒ el prepare corta con payout_pop_unverified y NUNCA se pide la firma del depósito", async () => {
    const repo = new InMemoryRepo();
    // El cache de `connect()`: `getAddress()` devuelve A, que es la cuenta con la que se armó el envío.
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    // Quien firma de verdad AHORA es B: la persona cambió de cuenta en Phantom sin recargar.
    const prepare = new FakePopVerifyingPrepareGateway(CUENTA_B);
    const gateway = new FakeSolanaSettlementGateway();
    // El KYC de A, que esta HU NO tiene que destruir. `ConfirmAndSend` ni siquiera recibe el store:
    // el assert (5) es estructural, y por eso vale — no hay camino por el que este use-case lo toque.
    const kycStore = new FakeKycStore();
    await kycStore.save(FAKE_SOLANA_BENEFICIARY, passKyc);
    const id = await seedQuoted(repo);

    const out = esperarListo(await build(
      repo,
      wallet,
      prepare,
      gateway,
      new FakePayoutGateway(),
      // Sin comprobante de reembolso la remesa se QUEDA en `payout_failed` en vez de pasar a
      // `refunded` (`isRealRefundReceipt`, `../refund-receipt.ts:15`). Medido: con el default
      // `FakeRefundGateway("resolve")` el status es `refunded`, no `payout_failed`. Se elige el
      // no-receipt porque `payout_failed` es el estado desde el que la persona todavía puede sacar
      // su plata, que es el que esta HU tiene que preservar.
      new FakeRefundGateway("no-receipt"),
    ).execute({ remittanceId: id }));

    // (1) el envío NO avanzó: quedó en el estado del que se puede salir.
    expect(out.snapshot.status).toBe("payout_failed");
    // (2) y el motivo es el del `prepare`, con el principal declarado "not_deposited".
    expect(out.snapshot.failureReason).toBe("payout_pop_unverified");
    // (3) 🔴 EL ASSERT QUE ES LA HU ENTERA: nunca se pidió la firma del depósito. Sin esto el test
    //     pasaría igual con una remesa que SÍ depositó y falló después, y "firmó y salió mal" no es
    //     lo mismo que "nunca firmó".
    expect(authorizeSpy).toHaveBeenCalledTimes(0);
    // (4) no hay ninguna firma de depósito escrita.
    expect(out.snapshot.principalTx).toBeNull();
    // (5) el KYC de A sigue entero y B no ganó ninguna entrada por este camino.
    expect(await kycStore.get(FAKE_SOLANA_BENEFICIARY)).not.toBeNull();
    expect(await kycStore.get(CUENTA_B)).toBeNull();
    // El challenge se pidió para A (la cuenta del envío), no para B: es lo que hace que la firma de B
    // no verifique, y lo que separa este caso de "el doble rechaza siempre".
    expect(prepare.calls).toEqual([{ address: FAKE_SOLANA_BENEFICIARY }]);
  });

  it("T-354-5(control): sin cambio de cuenta (firma A) el MISMO doble contesta ok y la firma del depósito SÍ se pide", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    // Lo ÚNICO que cambia respecto de T-354-5: quien firma es A, la misma cuenta del envío.
    const prepare = new FakePopVerifyingPrepareGateway(FAKE_SOLANA_BENEFICIARY);
    const gateway = new FakeSolanaSettlementGateway();
    const id = await seedQuoted(repo);

    const out = esperarListo(await build(
      repo,
      wallet,
      prepare,
      gateway,
      new FakePayoutGateway(),
      new FakeRefundGateway("no-receipt"),
    ).execute({ remittanceId: id }));

    // El doble NO rechaza siempre: con la misma cuenta contesta ok:true.
    expect(prepare.calls).toEqual([{ address: FAKE_SOLANA_BENEFICIARY }]);
    // Y el camino sigue: se pide la firma del depósito.
    expect(authorizeSpy).toHaveBeenCalledTimes(1);
    // La remesa NO quedó en el estado de fallo.
    expect(out.snapshot.status).not.toBe("payout_failed");
    expect(out.snapshot.failureReason).not.toBe("payout_pop_unverified");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-359 · T-067-3 (AC-2) y T-067-9 (AC-5) — EL PASO DE LA PRUEBA DE POSESIÓN, ANTES DEL `prepare`
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("WKH-359 · el permiso del payout se consigue ANTES de `prepare` (AC-2, AC-5)", () => {
  // 🔴 MUTANTE QUE MATA (el del Story File, y es el que define dónde va el paso): mover la llamada a
  // `pop.pedir()` ADENTRO del `try` de `confirm-and-send.ts:464`. El `catch` de `:476` se traga la
  // suspensión —que ahí ya no sube por el tipo sino que se pierde— y `execute()` devuelve
  // `{estado:"listo"}` con `failureReason: "prepare_unavailable"`, o sea el diagnóstico de un prepare
  // que NUNCA CORRIÓ. Este `it` se pone rojo en los dos `expect` de abajo.
  it("T-067-3: invocación 1 por enlace ⇒ `hay-que-salir` con `firma-pop-payout`, y `prepare` NO se llamó", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const pop = new FakePruebaDePosesionPorEnlace({ estado: "hay-que-salir", irA: "https://phantom.app/ul/v1/signMessage?x=1" });
    const id = await seedQuoted(repo);

    const r = await build(repo, wallet, prepare, gateway, undefined, undefined, undefined, undefined, pop).execute({
      remittanceId: id,
    });

    expect(r).toEqual({
      estado: "hay-que-salir",
      irA: "https://phantom.app/ul/v1/signMessage?x=1",
      esperando: "firma-pop-payout",
    });
    // 🔴 LAS DOS MITADES QUE IMPORTAN, y la segunda es la que el mutante rompe:
    expect(prepare.calls, "se posteó al prepare sin el permiso: eso vuelve 403 y quema una orden").toHaveLength(0);
    expect(wallet.authorizeCalls, "se le pidió a la persona una firma de transacción antes del permiso").toHaveLength(0);
    // Y la remesa NO se tocó: queda `confirmed`, que es la precondición de que la reanudación funcione.
    const enDisco = await repo.get(id);
    expect(enDisco?.status).toBe("confirmed");
    expect(enDisco?.snapshot.failureReason ?? null, "se escribió un diagnóstico de fallo por una suspensión").toBeNull();
  });

  it("T-067-3b: se pide UNA vez y con el propósito del PAYOUT (nunca el del KYC)", async () => {
    const repo = new InMemoryRepo();
    const pop = new FakePruebaDePosesionPorEnlace({ estado: "hay-que-salir", irA: "https://phantom.app/x" });
    const id = await seedQuoted(repo);
    await build(repo, new FakeSolanaWallet(), new FakeSolanaPayoutPrepareGateway(), new FakeSolanaSettlementGateway(), undefined, undefined, undefined, undefined, pop).execute({ remittanceId: id });

    expect(pop.llamadas).toHaveLength(1);
    expect(pop.llamadas[0]!.proposito, "un permiso del KYC no autoriza un payout (CD-15)").toBe("pop-payout");
  });

  // 🔴 T-067-9 (AC-5) — EL 501 NO SALTA A NINGUNA BILLETERA. La marca es la MISMA que este camino ya
  // producía antes de la HU, así que la persona lee lo de siempre y no aparece un enum nuevo.
  // MUTANTE QUE MATA: tratar el `no-se-puede` como `hay-que-salir` (o darle un `irA`) ⇒ el primer
  // `expect` cambia de forma y el `estado` deja de ser `listo`.
  it("T-067-9: emisor 501 ⇒ corte con `payout_pop_unavailable` y CERO navegaciones a la billetera", async () => {
    const repo = new InMemoryRepo();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const pop = new FakePruebaDePosesionPorEnlace({ estado: "no-se-puede", causa: "payout_pop_unavailable" });
    const id = await seedQuoted(repo);

    const r = await build(repo, new FakeSolanaWallet(), prepare, new FakeSolanaSettlementGateway(), undefined, undefined, undefined, undefined, pop).execute({
      remittanceId: id,
    });

    expect(r.estado, "con el emisor apagado el recorrido saltó igual a la billetera").toBe("listo");
    expect(r.estado === "listo" && r.remesa.snapshot.failureReason).toBe("payout_pop_unavailable");
    expect(prepare.calls, "se gastó un POST y un token de rate-limit en un rechazo ya determinado").toHaveLength(0);
  });

  // Con la prueba YA conseguida, el recorrido sigue y `prepare` la recibe: es la invocación 2, la de
  // después del salto. MUTANTE QUE MATA: no propagar `pop.proof` al input de `prepare` ⇒ el gateway
  // real volvería a pedirle una firma al bridge, que en un móvil está vacío.
  it("con la prueba conseguida, `prepare` la recibe en su input y el recorrido sigue", async () => {
    const repo = new InMemoryRepo();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const pop = new FakePruebaDePosesionPorEnlace({
      estado: "listo",
      proof: { challenge: "token-opaco", signature: "firma-del-enlace" },
    });
    const id = await seedQuoted(repo);

    const out = esperarListo(await build(repo, new FakeSolanaWallet(), prepare, new FakeSolanaSettlementGateway(), undefined, undefined, undefined, undefined, pop).execute({ remittanceId: id }));

    expect(prepare.calls).toHaveLength(1);
    expect(prepare.calls[0]!.proof, "la prueba no viajó: el gateway va a pedirle otra al bridge vacío").toEqual({
      challenge: "token-opaco",
      signature: "firma-del-enlace",
    });
    expect(out.snapshot.failureReason ?? null).toBeNull();
  });
});
