import { describe, expect, it, vi } from "vitest";
import { Money } from "../domain/money";
import { ConfirmAndSend } from "./use-cases/confirm-and-send";
import { ConnectWallet } from "./use-cases/connect-wallet";
import { CreateRemittance } from "./use-cases/create-remittance";
import { LockQuote } from "./use-cases/lock-quote";
import { PreviewQuote } from "./use-cases/preview-quote";
import { ResumeKyc } from "./use-cases/resume-kyc";
import { StartKyc } from "./use-cases/start-kyc";
import { TrackRemittance } from "./use-cases/track-remittance";
import { FallbackKycGateway } from "../infrastructure/fallback/gateways";
import type { KycPendingStore, KycStore } from "./ports";
import {
  beneficiary,
  FakeKycGateway,
  FakeKycPendingStore,
  FakeKycStore,
  FakePayoutGateway,
  FakeQuoteGateway,
  FakeRefundGateway,
  FakeSolanaEscrowDepositProbe,
  FakeSolanaPayoutPrepareGateway,
  FakeSolanaSenderSolBalanceProbe,
  FakePruebaDePosesionPorEnlace,
  FakeSolanaSettlementGateway,
  FakeSolanaWallet,
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_SIGNATURE,
  FixedClock,
  InMemoryRepo,
  SeqIds,
  ThrowingKycPendingStore,
  ThrowingSaveKycStore,
} from "../test-support/fakes"; import { esperarListo } from "../test-support/desenlaces"; // WKH-356: narrowing de ResultadoDeEnvio. TIRA si execute() suspende donde el test no lo espera.
import { esperarConectado } from "../test-support/desenlaces"; // WKH-359: ConnectWallet.execute() ahora tiene DOS desenlaces. Este helper TIRA si suspendió donde el test no lo espera, en vez de dejar un `undefined` viajando por media suite.

function setup(opts?: {
  kyc?: FakeKycGateway;
  payout?: FakePayoutGateway;
  kycStore?: KycStore;
  pending?: KycPendingStore;
  solanaGateway?: FakeSolanaSettlementGateway;
}) {
  const repo = new InMemoryRepo();
  const clock = new FixedClock();
  const ids = new SeqIds();
  const payout = opts?.payout ?? new FakePayoutGateway();
  const kycStore = opts?.kycStore ?? new FakeKycStore();
  const pending = opts?.pending ?? new FakeKycPendingStore();
  // WKH-320: el e2e corre sobre el CAMINO REAL. Antes usaba la FakeWallet demo y llegaba a
  // payouts.submit (paso 4), que post-poda es estructuralmente inalcanzable: sin `solana` inyectado
  // el tapón DT-8 falla la remesa fail-closed. Se inyecta el par prepare+gateway Solana, así el
  // recorrido create → lock → kyc → confirm → track sigue probado punta a punta.
  const wallet = new FakeSolanaWallet();
  const kycGw = opts?.kyc ?? new FakeKycGateway();
  return {
    repo,
    clock,
    kycStore,
    pending,
    create: new CreateRemittance(repo, clock, ids),
    connect: new ConnectWallet(wallet, kycStore),
    startKyc: new StartKyc(kycGw, kycStore, pending, repo, clock),
    resumeKyc: new ResumeKyc(kycGw, kycStore, pending, repo, clock),
    lock: new LockQuote(new FakeQuoteGateway(), repo, clock),
    confirm: new ConfirmAndSend(wallet, repo, clock, new FakeRefundGateway(), {
      prepare: new FakeSolanaPayoutPrepareGateway(),
      gateway: opts?.solanaGateway ?? new FakeSolanaSettlementGateway(),
      probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(), pop: new FakePruebaDePosesionPorEnlace(),
    }),
    track: new TrackRemittance(payout, repo, clock, new FakeRefundGateway()),
  };
}

const kycInput = (remittanceId: string) => ({
  remittanceId,
  address: FAKE_SOLANA_BENEFICIARY,
  purpose: "family support",
});

describe("Use-cases — money-path", () => {
  it("happy path: create → lock → kyc → confirm → track → settled", async () => {
    const { create, startKyc, lock, confirm, track } = setup();
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    let r = await lock.execute({ remittanceId: id }); // WKH-187: cotiza PRIMERO (created→quoted)
    expect(r.status).toBe("quoted");
    expect((await startKyc.execute(kycInput(id))).kind).toBe("done"); // quoted→kyc_pending→kyc_passed
    r = esperarListo(await confirm.execute({ remittanceId: id }));
    expect(r.status).toBe("payout_submitted");
    r = await track.execute({ remittanceId: id });
    expect(r.status).toBe("settled"); // delivered dentro de tolerancia del receive lockeado (AC-6)
    expect(r.snapshot.deliveredPen).toEqual(Money.of(1478.15, "PEN"));
    expect(r.snapshot.principalTx).toBe(FAKE_SOLANA_SIGNATURE);
  });

  it("payout settled con deliveredPen null → settled preserva null (AC-1, no coalesce a S/0)", async () => {
    const { create, startKyc, lock, confirm, track } = setup({
      payout: new FakePayoutGateway({}, { deliveredPen: null }),
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC
    await startKyc.execute(kycInput(id));
    await confirm.execute({ remittanceId: id });
    const r = await track.execute({ remittanceId: id });
    expect(r.snapshot.status).toBe("settled");
    expect(r.snapshot.deliveredPen).toBeNull();
  });

  it("KYC no pasa → kyc_failed terminal, re-lock falla (el dominio fuerza el orden)", async () => {
    const { create, startKyc, lock } = setup({
      kyc: new FakeKycGateway({ approved: false, payoutAllowed: false }),
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC (created→quoted)
    const res = await startKyc.execute(kycInput(id)); // quoted→kyc_pending→kyc_failed
    expect(res.kind).toBe("done");
    if (res.kind === "done") expect(res.snapshot.status).toBe("kyc_failed");
    // kyc_failed es terminal: no se puede re-cotizar tras un KYC rechazado
    await expect(lock.execute({ remittanceId: id })).rejects.toThrow(/invalid_transition/);
  });

  it("no se puede startKyc antes de cotizar (WKH-187: created→kyc_pending inválido)", async () => {
    const { create, startKyc } = setup();
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    await expect(startKyc.execute(kycInput(r0.snapshot.id))).rejects.toThrow(
      /invalid_transition/,
    );
  });

  // WKH-320: antes este caso forzaba el fallo con un payout status:'failed' (paso 4, inalcanzable
  // post-poda). Se re-cablea sobre el settle, que es donde vive hoy el fallo del money-path.
  //
  // ⚠️ LEER LA CONDICIÓN: este caso corre con un adapter de refund que SÍ devuelve un comprobante
  // ("refund-fake"). Ése es el único escenario que autoriza `refunded`. El adapter que corre en
  // PRODUCCIÓN (LedgerRefundGateway) no revierte nada y devuelve null, así que ahí la remesa se queda
  // en payout_failed (recuperable) y sin ninguna referencia de reembolso. Ese otro caso está
  // cubierto en confirm-and-send.money-path.test.ts; no lo leas de acá.
  it("con un adapter que SÍ revierte, el settle falla → refunded, failureReason preservado (WKH-186)", async () => {
    const { create, startKyc, lock, confirm } = setup({
      solanaGateway: new FakeSolanaSettlementGateway({ ok: false, reason: "solana_settle_rejected" }),
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC
    await startKyc.execute(kycInput(id));
    const r = esperarListo(await confirm.execute({ remittanceId: id }));
    // Antes de WKH-186 la remesa quedaba clavada en payout_failed; ahora el refund la avanza a
    // refunded en el mismo execute(). markRefunded solo patchea refundTx → failureReason sobrevive.
    expect(r.status).toBe("refunded");
    expect(r.snapshot.failureReason).toBe("solana_settle_rejected");
    expect(r.snapshot.refundTx).toBe("refund-fake");
    expect(r.snapshot.principalTx).toBeNull(); // el depósito no se confirmó ⇒ nunca principal_in
  });

  it("PreviewQuote no crea remesa", async () => {
    const q = await new PreviewQuote(new FakeQuoteGateway()).execute({
      amountUsd: 400,
      method: "yape",
    });
    expect(q.receive.currency).toBe("PEN");
    expect(q.send.major).toBe(400);
  });

  it("ConnectWallet devuelve address + KYC recordado (login de la DApp)", async () => {
    const kycStore = new FakeKycStore();
    const { connect } = setup({ kycStore });
    let res = esperarConectado(await connect.execute());
    expect(res.address).toBe(FAKE_SOLANA_BENEFICIARY);
    expect(res.rememberedKyc).toBeNull();
    await kycStore.save(FAKE_SOLANA_BENEFICIARY, {
      verificationId: "v",
      approved: true,
      payoutAllowed: true, realVerified: true, verifiedAt: null,
      riskLevel: "low",
      provenance: "didit",
      identity: null,
    });
    res = esperarConectado(await connect.execute());
    expect(res.rememberedKyc?.approved).toBe(true);
  });

  // ⚠️ ESTE `it` SE RENOMBRÓ PORQUE SU NOMBRE AFIRMABA LO QUE NO MEDÍA (re-AR it2 · MNR-2). Decía
  // *"KYC-once: la 2da remesa de la misma wallet reusa el KYC (sin re-verificar)"*, y no medía ni el
  // reuso ni el "sin re-verificar": el doble trae `realVerified: false` (`fakes.ts:183`), o sea que el
  // atajo NO se toma y la 2da remesa llega a `kyc_passed` por el camino LARGO, verificándose de nuevo.
  // Medido por el AR: el mutante que devuelve el atajo a `payoutAllowed` deja este `it` VERDE.
  // ⇒ El nombre dice ahora lo que el cuerpo hace, y el atajo de verdad lo mide el `it` de abajo.
  it("la 2da remesa de la misma wallet vuelve a pasar el KYC y termina en `kyc_passed`", async () => {
    const kycStore = new FakeKycStore();
    const { create, startKyc, lock } = setup({ kycStore });
    const r1 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    await lock.execute({ remittanceId: r1.snapshot.id }); // WKH-187: cotiza antes del KYC
    await startKyc.execute(kycInput(r1.snapshot.id)); // verifica + guarda en el store
    const r2 = await create.execute({ amountUsd: 200, beneficiary: beneficiary() });
    await lock.execute({ remittanceId: r2.snapshot.id });
    const res = await startKyc.execute({ remittanceId: r2.snapshot.id, address: FAKE_SOLANA_BENEFICIARY });
    expect(res.kind).toBe("done");
    if (res.kind === "done") expect(res.snapshot.status).toBe("kyc_passed");
  });

  // ── EL ATAJO KYC-once DE VERDAD, y lo que lo separa del `it` de arriba es UN booleano ────────────
  //
  // 🔴 QUÉ MIDE, Y POR QUÉ HACE FALTA UN `it` NUEVO. "Reusa el KYC" no es "termina en `kyc_passed`":
  // las dos remesas terminan ahí por caminos distintos. Lo único que distingue el atajo es que **al
  // gateway NO se le pide nada**, y eso se mide contando llamadas, no mirando el status final.
  // El gate del atajo es `realVerified` (WKH-233 fix-pack · H-2b): el doble por defecto lo trae en
  // `false`, así que este `it` lo pone en `true` a propósito — que es lo que hace un agente cuando la
  // verificación fue REAL y habilita el pago.
  it("KYC-once: con `realVerified: true`, la 2da remesa NO le pide nada al gateway", async () => {
    const kycStore = new FakeKycStore();
    const kyc = new FakeKycGateway({ realVerified: true });
    const { create, startKyc, lock } = setup({ kycStore, kyc });
    const r1 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    await lock.execute({ remittanceId: r1.snapshot.id });
    await startKyc.execute(kycInput(r1.snapshot.id));
    const espia = vi.spyOn(kyc, "start");
    const r2 = await create.execute({ amountUsd: 200, beneficiary: beneficiary() });
    await lock.execute({ remittanceId: r2.snapshot.id });
    const res = await startKyc.execute({ remittanceId: r2.snapshot.id, address: FAKE_SOLANA_BENEFICIARY });
    expect(res.kind).toBe("done");
    // 🧬 MUTANTE: volver el gate del atajo a `approved && payoutAllowed` ⇒ el atajo se toma igual y
    // esta línea sigue verde; volverlo a `false` o borrarlo ⇒ `start` se llama y esto se pone ROJO.
    // ⇒ lo que este `it` clava es que el atajo EXISTE y ahorra el viaje, no cuál es su gate (eso lo
    // clavan `T-SK-REAL` y `T-AC4c`, uno por sitio).
    expect(espia, "la 2da remesa volvió a pedirle una verificación al gateway: no hubo atajo").not.toHaveBeenCalled();
  });

  it("Didit redirect → resume aplica la decisión y pasa el KYC (flujo móvil)", async () => {
    const { create, startKyc, lock, resumeKyc } = setup({ kyc: new FakeKycGateway({}, true) });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    await lock.execute({ remittanceId: r0.snapshot.id }); // WKH-187: cotiza antes del KYC
    const start = await startKyc.execute({ remittanceId: r0.snapshot.id, address: FAKE_SOLANA_BENEFICIARY });
    expect(start.kind).toBe("redirect"); // te manda a Didit

    const res = await resumeKyc.execute(); // simula el retorno de Didit
    expect(res.kind).toBe("passed");
    if (res.kind === "passed") expect(res.snapshot.status).toBe("kyc_passed");
  });

  it("AC-2: ResumeKyc persiste kyc_passed pese al fallo del cache (kycStore.save lanza)", async () => {
    const { create, startKyc, lock, resumeKyc, repo } = setup({
      kyc: new FakeKycGateway({}, true), // fuerza redirect (path resume)
      kycStore: new ThrowingSaveKycStore(), // save() SIEMPRE lanza
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC
    const start = await startKyc.execute({ remittanceId: id, address: FAKE_SOLANA_BENEFICIARY });
    expect(start.kind).toBe("redirect");

    // ThrowingSaveKycStore.save lanza SIEMPRE (más agresivo que el try/catch del store real): prueba
    // el reorder en aislamiento — repo.save YA corrió antes del kycStore.save que lanza, así que el
    // KYC queda persistido pese a la excepción del cache. Sin el reorder, el repo NO tendría kyc_passed.
    await expect(resumeKyc.execute()).rejects.toThrow(/kyc_store_unavailable/);
    expect((await repo.get(id))?.snapshot.status).toBe("kyc_passed"); // AC-2: persistido en el repo
  });

  it("AC-3: StartKyc completed persiste kyc_passed pese al fallo del cache (kycStore.save lanza)", async () => {
    const { create, startKyc, lock, repo } = setup({
      kycStore: new ThrowingSaveKycStore(), // save() SIEMPRE lanza; FakeKycGateway default → completed
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC
    // rama "completed": repo.save YA corrió antes del kycStore.save que lanza → kyc_passed persistido.
    await expect(startKyc.execute(kycInput(id))).rejects.toThrow(/kyc_store_unavailable/);
    expect((await repo.get(id))?.snapshot.status).toBe("kyc_passed"); // AC-3: persistido en el repo
  });

  it("V1 ⭐ AC-1/2/3: si pending.save falla en el redirect, la remesa NO queda huérfana en kyc_pending", async () => {
    const { create, startKyc, lock, repo } = setup({
      kyc: new FakeKycGateway({}, true), // fuerza redirect
      pending: new ThrowingKycPendingStore(), // save() siempre lanza
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC (created→quoted)
    await expect(
      startKyc.execute({ remittanceId: id, address: FAKE_SOLANA_BENEFICIARY }),
    ).rejects.toThrow(/kyc_pending_unavailable/); // AC-1: re-lanza el Error, no crudo; AC-3: no {kind:"redirect"}
    const persisted = await repo.get(id);
    expect(persisted?.snapshot.status).toBe("quoted"); // AC-2 ⭐ WKH-187: último estado guardado = quoted, NO "kyc_pending"
  });

  it("V1 AC-4: tras un pending que falló, el retry con store sano avanza sin invalid_transition", async () => {
    // repo/clock compartidos para simular fallo → retry sobre la MISMA remesa persistida.
    const repo = new InMemoryRepo();
    const clock = new FixedClock();
    const createShared = new CreateRemittance(repo, clock, new SeqIds());
    const r0 = await createShared.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await new LockQuote(new FakeQuoteGateway(), repo, clock).execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC

    const kycGw = new FakeKycGateway({}, true);
    const kycStore = new FakeKycStore();
    const failing = new StartKyc(kycGw, kycStore, new ThrowingKycPendingStore(), repo, clock);
    await expect(failing.execute({ remittanceId: id, address: FAKE_SOLANA_BENEFICIARY })).rejects.toThrow();
    expect((await repo.get(id))?.snapshot.status).toBe("quoted"); // WKH-187: último estado guardado = quoted

    const healthy = new StartKyc(kycGw, kycStore, new FakeKycPendingStore(), repo, clock);
    const res = await healthy.execute({ remittanceId: id, address: FAKE_SOLANA_BENEFICIARY }); // quoted→kyc_pending válido
    expect(res.kind).toBe("redirect");
    expect((await repo.get(id))?.snapshot.status).toBe("kyc_pending");
  });

  it("resume sin KYC pendiente → none (carga normal de la app)", async () => {
    const { resumeKyc } = setup();
    expect((await resumeKyc.execute()).kind).toBe("none");
  });

  it("AC-6: tras startKyc, el snapshot persistido queda con ownerAddress == caller.address", async () => {
    const { create, startKyc, lock, repo } = setup();
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    expect(r0.snapshot.ownerAddress).toBeNull(); // creada sin owner
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC
    await startKyc.execute({ remittanceId: id, address: FAKE_SOLANA_BENEFICIARY });
    const saved = await repo.get(id);
    expect(saved?.snapshot.ownerAddress).toBe(FAKE_SOLANA_BENEFICIARY);
  });

  it("AC-12: flujo fallback (sin sandbox Didit) queda verde con identity REDUCIDA presente", async () => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock();
    const ids = new SeqIds();
    const create = new CreateRemittance(repo, clock, ids);
    const startKyc = new StartKyc(
      new FallbackKycGateway(),
      new FakeKycStore(),
      new FakeKycPendingStore(),
      repo,
      clock,
    );
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    await new LockQuote(new FakeQuoteGateway(), repo, clock).execute({ remittanceId: r0.snapshot.id }); // WKH-187: cotiza antes del KYC
    const res = await startKyc.execute({ remittanceId: r0.snapshot.id, address: FAKE_SOLANA_BENEFICIARY });
    expect(res.kind).toBe("done");
    if (res.kind === "done") {
      expect(res.snapshot.status).toBe("kyc_passed");
      const idn = res.snapshot.kyc?.identity;
      expect(idn?.firstName).toBe("María Elena"); // fixture demo preservado (AC-12)
      expect(idn?.documentNumberLast4).toBe("6677"); // reducida
      expect(idn && "documentNumber" in idn).toBe(false); // sin PII cruda
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-073-2d (HU 073 / AC-2) — el candado de COMPORTAMIENTO del desenlace D-3
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ FRASE MATA, Y POR QUÉ NINGÚN TEST ANTERIOR PODÍA MATARLA. La card vieja del resume decía «No
// pudimos confirmar tu identidad a tiempo» para TODOS los finales, incluido el `catch` de
// (`catch`, `flow.tsx:215`). Los dos tests que se iban a usar como evidencia (`T-073-2a` y
// (`catch`, `barra-destinos.test.tsx:627-639`)) construyen el throw TEMPRANO, o sea el único sub-caso donde esa
// frase era casi cierta. **La cobertura y la falsedad estaban en cuadrantes distintos.**
//
// Este `it` construye el PEOR estado: se preguntó, contestaron, el veredicto fue terminal y APROBADO, y
// el resume tiró DESPUÉS, al persistirlo. Ahí la frase vieja es falsa dos veces: sí se preguntó, y la
// verificación de esa persona puede haber pasado.
//
// LOS DOS ASSERTS SON DOS A PROPÓSITO:
//   (a) `rejects` — la FORMA: el resume terminó tirando, o sea que esto ES D-3.
//   (b) `decisionSpy === 1` — el COMPORTAMIENTO: la consulta SALIÓ y fue contestada.
// Con (b) solo no hay D-3; con (a) solo no se prueba que se preguntó. Juntas son la contradicción.
describe("T-073-2d · D-3 puede ocurrir DESPUÉS de una consulta contestada (HU 073)", () => {
  it("🔴 el resume TIRA con el veredicto ya en la mano: se preguntó, contestaron, y aun así es D-3", async () => {
    const repoReal = new InMemoryRepo();
    const clock = new FixedClock();
    const kycStore = new FakeKycStore();
    const pending = new FakeKycPendingStore();
    const kycGw = new FakeKycGateway({}, true); // `true` = fuerza el redirect ⇒ deja un pendiente
    const create = new CreateRemittance(repoReal, clock, new SeqIds());
    const lock = new LockQuote(new FakeQuoteGateway(), repoReal, clock);
    const startKyc = new StartKyc(kycGw, kycStore, pending, repoReal, clock);

    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id });
    expect((await startKyc.execute({ remittanceId: id, address: FAKE_SOLANA_BENEFICIARY })).kind).toBe("redirect");

    // El pendiente se resuelve por el carril del AGENTE: es el camino que llega hasta `decision`.
    const p = await pending.get();
    expect(p, "sin pendiente no hay resume que medir").not.toBeNull();
    await pending.save({ ...(p as NonNullable<typeof p>), carril: "agente" });

    // El repositorio que NO deja guardar: el throw ocurre en `repo.save`, o sea DESPUÉS de la consulta.
    const repoQueNoGuarda = {
      save: async () => {
        throw new Error("repo_no_disponible");
      },
      get: (i: string) => repoReal.get(i),
      list: (a: string) => repoReal.list(a),
      clearByOwner: (a: string) => repoReal.clearByOwner(a),
    };
    const decisionSpy = vi.spyOn(kycGw, "decision");
    const uc = new ResumeKyc(kycGw, kycStore, pending, repoQueNoGuarda as never, clock);

    // (a) FORMA — 🧬 MUTANTE: que `repo.save` RESUELVA ⇒ el `rejects` cae ⇒ el test dejó de construir
    // el peor estado y hay que venir a leer esto.
    await expect(
      uc.execute(),
      "el resume ya no termina tirando: este `it` dejó de construir el desenlace D-3",
    ).rejects.toThrow();
    // (b) COMPORTAMIENTO — la consulta salió y volvió con un veredicto.
    expect(
      decisionSpy,
      "no se llegó a preguntar: sin esto, el `rejects` de arriba también lo daría un throw ANTERIOR a " +
        "la consulta, que es justo el sub-caso donde la frase vieja no era falsa",
    ).toHaveBeenCalledTimes(1);
  });
});
