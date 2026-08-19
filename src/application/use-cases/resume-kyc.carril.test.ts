// T-CARR-1/T-CARR-2 — `ResumeKyc` se enruta por el CARRIL de la sesión (WKH-233/DT-3a, D-5).
//
// 🔴 POR QUÉ ESTE ARCHIVO EXISTE, MEDIDO: al 2026-08-19 `resume-kyc.ts` NO TENÍA NINGÚN TEST
// (`ls src/application/use-cases/ | command grep resume` devolvía sólo el `.ts`). O sea que el
// use-case que decide qué ve una persona al volver del redirect de verificación de identidad no
// estaba cubierto por nada.
//
// 🔴 Y ES EL TEST QUE HACE QUE LA BANDERA DE ROLLBACK EXISTA DE VERDAD. El rollback de WKH-233 es
// QUITAR `KYC_AGENT_BASE_URL`. Si el enrutado mirara esa env en vez del `carril` persistido, apagarla
// cortaría a toda la gente que está a mitad de una verificación: su sesión ya existe, ya escaneó el
// documento, y al volver caería por el camino equivocado. Sin este archivo, "el rollback es seguro"
// sería una afirmación sin instrumento.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import type { KycPending } from "../ports";
import {
  FakeKycPendingStore,
  FakeKycStore,
  FixedClock,
  InMemoryRepo,
  T0,
  beneficiary,
} from "../../test-support/fakes";
import { Remittance } from "../../domain/remittance";
import { ResumeKyc } from "./resume-kyc";

const ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const VERIFICACION = {
  verificationId: "sess-1",
  approved: true,
  payoutAllowed: true,
  realVerified: true,
  verifiedAt: "2026-08-19T10:00:00.000Z",
  riskLevel: "low" as const,
  provenance: "didit",
  identity: null,
};

/** Doble del gateway que CUENTA llamadas. El assert de estos tests es el CONTADOR, no el status: un
 *  test sobre el desenlace no distingue "no llamó" de "llamó y el doble contestó igual". */
function gatewayQueCuenta() {
  const decision = vi.fn(async () => ({ terminal: true, verification: VERIFICACION }));
  return { start: vi.fn(), decision } as unknown as {
    start: ReturnType<typeof vi.fn>;
    decision: ReturnType<typeof vi.fn>;
  };
}

async function sembrar(): Promise<{ repo: InMemoryRepo; id: string }> {
  const repo = new InMemoryRepo();
  const r = Remittance.create("rem-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(
    {
      quoteId: "q1",
      send: Money.of(400, "USDC"),
      receive: Money.of(1480, "PEN"),
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.7,
      etaMinutes: 30,
      expiresAt: "2099-01-01T00:00:00.000Z",
      provenance: "fake",
    },
    T0,
  );
  r.startKyc(T0, ADDR);
  await repo.save(r);
  return { repo, id: r.snapshot.id };
}

async function construir(pending: KycPending) {
  const { repo, id } = await sembrar();
  const pendingStore = new FakeKycPendingStore();
  await pendingStore.save({ ...pending, remittanceId: id });
  const kycStore = new FakeKycStore();
  const kyc = gatewayQueCuenta();
  const uc = new ResumeKyc(
    kyc as never,
    kycStore,
    pendingStore,
    repo,
    new FixedClock(),
  );
  return { uc, kyc, pendingStore, kycStore, repo, id };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("T-CARR-1 · un pendiente `carril:\"agente\"` se lee por el carril del agente", () => {
  it("`kyc.decision` recibe EXACTAMENTE 1 llamada y el desenlace es `passed`", async () => {
    const { uc, kyc } = await construir({
      remittanceId: "x",
      sessionId: "sess-1",
      address: ADDR,
      sessionToken: "hmac-tok",
      carril: "agente",
    });
    const res = await uc.execute();
    expect(kyc.decision).toHaveBeenCalledTimes(1);
    expect(kyc.decision).toHaveBeenCalledWith("sess-1", "hmac-tok");
    expect(res.kind).toBe("passed");
  });

  it.each([
    ["la env PRESENTE", "https://agentes.test"],
    ["la env AUSENTE (el rollback de la HU)", undefined],
  ])(
    "🔴 el enrutado NO consulta ninguna env: con %s el resultado es el MISMO",
    async (_caso, valor) => {
      // 🧬 MUTANTE: enrutar por `process.env.KYC_AGENT_BASE_URL` ⇒ el segundo caso dejaría de llamar
      // al gateway ⇒ ROJO. Y es el mutante que importa: sin esto, apagar la bandera CORTA a toda la
      // gente que está a mitad de una verificación, con el documento ya escaneado.
      vi.stubEnv("KYC_AGENT_BASE_URL", valor as string | undefined);
      const { uc, kyc } = await construir({
        remittanceId: "x",
        sessionId: "sess-1",
        address: ADDR,
        carril: "agente",
      });
      const res = await uc.execute();
      expect(kyc.decision).toHaveBeenCalledTimes(1);
      expect(res.kind).toBe("passed");
    },
  );

  it("un fallo transitorio del gateway devuelve `processing` (reintentable) y NO limpia el pendiente", async () => {
    const { uc, kyc, pendingStore } = await construir({
      remittanceId: "x",
      sessionId: "sess-1",
      address: ADDR,
      carril: "agente",
    });
    kyc.decision.mockRejectedValue(new Error("kyc_decision_failed"));
    expect((await uc.execute()).kind).toBe("processing");
    expect(await pendingStore.get()).not.toBeNull();
  });
});

describe("T-CARR-2 · un pendiente SIN carril (los de antes de la HU) ⇒ `directo` ⇒ no se puede retomar", () => {
  it("🔴 devuelve `failed`, limpia el pendiente, y `kyc.decision` recibe CERO llamadas", async () => {
    // El store normaliza a `"directo"` lo que no sea exactamente `"agente"`. Acá se fuerza el caso
    // real: un blob de `localStorage` guardado antes de WKH-233, que no trae el campo.
    const { uc, kyc, pendingStore, kycStore } = await construir({
      remittanceId: "x",
      sessionId: "sess-vieja-del-proveedor",
      address: ADDR,
      carril: "directo",
    });
    const guardar = vi.spyOn(kycStore, "save");
    const res = await uc.execute();

    // 🧬 MUTANTE: default `"agente"` ⇒ llamaría al agente ⇒ ROJO. Y el daño del mutante es preciso:
    // esa sesión no tiene fila en `kyc_session_tokens`, el agente contestaría 401, esto devolvería
    // `"processing"` PARA SIEMPRE y la persona quedaría girando hasta el timeout, sin salida.
    expect(kyc.decision, "se consultó al agente por una sesión que él no emitió").toHaveBeenCalledTimes(0);
    expect(res.kind).toBe("failed");
    expect(await pendingStore.get(), "el pendiente quedó vivo: el próximo arranque vuelve a girar").toBeNull();
    // ⛔ SIN `applyKyc` y SIN escribir el caché: no inventamos un veredicto sobre esa persona, sólo
    // decimos que no pudimos retomar. `flow.tsx` ya tiene el aterrizaje de `failed`, con salida.
    expect(guardar, "se persistió un veredicto que nadie emitió").not.toHaveBeenCalled();
  });

  it("el snapshot que devuelve es el de la remesa, para que la pantalla tenga qué mostrar", async () => {
    const { uc, id } = await construir({
      remittanceId: "x",
      sessionId: "sess-vieja",
      address: ADDR,
      carril: "directo",
    });
    const res = await uc.execute();
    expect(res.kind).toBe("failed");
    if (res.kind === "failed") expect(res.snapshot.id).toBe(id);
  });

  it("✅ calibración inversa: el MISMO pendiente con `carril:\"agente\"` SÍ llama al gateway", async () => {
    const { uc, kyc } = await construir({
      remittanceId: "x",
      sessionId: "sess-vieja",
      address: ADDR,
      carril: "agente",
    });
    await uc.execute();
    expect(kyc.decision).toHaveBeenCalledTimes(1);
  });
});

describe("los guards de siempre siguen delante del carril", () => {
  it("sin pendiente ⇒ `none`, sin tocar el gateway", async () => {
    const { repo } = await sembrar();
    const kyc = gatewayQueCuenta();
    const uc = new ResumeKyc(
      kyc as never,
      new FakeKycStore(),
      new FakeKycPendingStore(),
      repo,
      new FixedClock(),
    );
    expect((await uc.execute()).kind).toBe("none");
    expect(kyc.decision).toHaveBeenCalledTimes(0);
  });

  it("una remesa que ya salió de `kyc_pending` ⇒ `none` y limpia, ANTES de mirar el carril", async () => {
    const { uc, kyc, pendingStore, repo, id } = await construir({
      remittanceId: "x",
      sessionId: "sess-1",
      address: ADDR,
      carril: "directo",
    });
    const r = await repo.get(id);
    if (!r) throw new Error("seed rota");
    r.applyKyc(VERIFICACION, T0);
    await repo.save(r);

    const res = await uc.execute();
    // El orden importa: si el carril corriera antes, esto devolvería `failed` y la pantalla diría
    // "tu verificación necesita otro intento" sobre una verificación que YA se aplicó.
    expect(res.kind).toBe("none");
    expect(kyc.decision).toHaveBeenCalledTimes(0);
    expect(await pendingStore.get()).toBeNull();
  });
});
