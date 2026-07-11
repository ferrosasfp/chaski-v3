"use client";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  Camera,
  Check,
  IdCard,
  Loader2,
  ScanFace,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Quote, RemittanceState, PayoutMethod } from "../domain/remittance";
import { createContainer } from "../composition/container";
import { deliveredDisplay, humanError, isDemoMode } from "./flow-vm";
import { Button, Card, ChaskiMark, Field, Pill, Row, Stepper, TextInput } from "./ui";

type Step = "send" | "connect" | "verify" | "review" | "track" | "done";
const STEP_LABELS = ["Enviar", "Identidad", "Revisar", "Seguir"];
const STEP_INDEX: Record<Step, number> = {
  send: 0,
  connect: 1,
  verify: 1,
  review: 2,
  track: 3,
  done: 3,
};

const METHODS: { id: PayoutMethod; label: string }[] = [
  { id: "yape", label: "Yape" },
  { id: "plin", label: "Plin" },
  { id: "bank_cci", label: "Banco (CCI)" },
];

// Etapas del escaneo Didit (documento → selfie/liveness → screening AML). Simuladas en demo;
// en real es la sesión hospedada de Didit que extrae la identidad del documento.
const SCAN_STEPS = [
  "Escaneando tu documento",
  "Verificando tu rostro (selfie)",
  "Revisando listas de seguridad (AML)",
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function RemittanceFlow() {
  const c = useMemo(() => createContainer(), []);
  const [step, setStep] = useState<Step>("send");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // form
  const [amount, setAmount] = useState("400");
  const [recipient, setRecipient] = useState("");
  const [method, setMethod] = useState<PayoutMethod>("yape");
  const [destination, setDestination] = useState("");
  const [scanStage, setScanStage] = useState(0); // 0 idle · 1-3 escaneando · 4 verificado

  // state
  const [preview, setPreview] = useState<Quote | null>(null);
  const [rem, setRem] = useState<RemittanceState | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false); // retomando KYC al volver de Didit
  const [timedOut, setTimedOut] = useState(false); // el resume-loop agotó el timeout

  const amountNum = Number(amount) || 0;

  // preview en vivo (debounced)
  useEffect(() => {
    if (amountNum <= 0) {
      setPreview(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setPreview(await c.previewQuote.execute({ amountUsd: amountNum, method }));
      } catch {
        setPreview(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [amountNum, method, c]);

  // Retomar el KYC al volver del redirect de Didit (móvil, misma pestaña). Corre una vez al montar:
  // si hay un KYC pendiente, consulta la decisión (reintenta si Didit aún procesa) y sigue el flujo.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    let alive = true;
    (async () => {
      for (let i = 0; i < 40; i++) {
        let res: Awaited<ReturnType<typeof c.resumeKyc.execute>>;
        try {
          res = await c.resumeKyc.execute();
        } catch {
          break;
        }
        if (!alive) return;
        if (res.kind === "none") {
          setResuming(false);
          return;
        }
        if (res.kind === "processing") {
          setResuming(true);
          await sleep(2500);
          continue;
        }
        setResuming(false);
        if (res.kind === "passed") {
          setRem(res.snapshot);
          try {
            const locked = await c.lockQuote.execute({ remittanceId: res.snapshot.id });
            if (alive) setRem(locked.snapshot);
          } catch {
            /* si la cotización falla, el review re-cotiza */
          }
          if (alive) setStep("review");
        } else {
          setRem(res.snapshot);
          setStep("verify");
          setError("La verificación no pasó. Probá de nuevo.");
        }
        return;
      }
      if (alive) {
        setResuming(false);
        await c.abandonPendingKyc.execute(); // limpia el pending (CD-6): próximo reload no repite el bloqueo
        setTimedOut(true);
        // La card de timedOut ya comunica el mensaje; no seteamos error para no duplicarlo (MENOR-A).
      }
    })();
    return () => {
      alive = false;
    };
  }, [c]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? humanError(e.message) : "Algo salió mal");
    } finally {
      setBusy(false);
    }
  }, []);

  const onSend = () =>
    guard(async () => {
      const r = await c.createRemittance.execute({
        amountUsd: amountNum,
        beneficiary: { name: recipient, country: "PE", method, destination },
      });
      setRem(r.snapshot);
      setScanStage(0);
      setStep("connect");
    });

  const onConnect = () =>
    guard(async () => {
      if (!rem) return;
      const { address: addr, rememberedKyc } = await c.connectWallet.execute();
      setAddress(addr);
      if (rememberedKyc && rememberedKyc.approved && rememberedKyc.payoutAllowed) {
        // KYC-once: esta wallet ya está verificada → saltear identidad, directo a cotizar/revisar.
        const res = await c.startKyc.execute({ remittanceId: rem.id, address: addr });
        if (res.kind === "done") {
          setRem(res.snapshot);
          const locked = await c.lockQuote.execute({ remittanceId: rem.id });
          setRem(locked.snapshot);
          setStep("review");
        } else {
          setStep("verify");
        }
      } else {
        setStep("verify");
      }
    });

  const onVerify = () =>
    guard(async () => {
      if (!rem) return;
      setScanStage(1);
      const callbackUrl =
        typeof window !== "undefined" ? `${window.location.origin}/?kyc=return` : undefined;
      const res = await c.startKyc.execute({
        remittanceId: rem.id,
        address: address ?? "",
        callbackUrl,
      });
      if (res.kind === "redirect") {
        // Redirect en la MISMA pestaña a Didit (suave en móvil). La página navega y se retoma
        // sola al volver (ver el efecto de resume). No seguimos acá.
        window.location.href = res.url;
        return;
      }
      // done: simulación (sin key) o KYC-once.
      setRem(res.snapshot);
      if (res.snapshot.status !== "kyc_passed") {
        setScanStage(0);
        setError("No pudimos verificar tu identidad. Intentá de nuevo.");
        return;
      }
      setScanStage(4);
      await sleep(400);
      const locked = await c.lockQuote.execute({ remittanceId: rem.id });
      setRem(locked.snapshot);
      setStep("review");
    });

  const onConfirm = () =>
    guard(async () => {
      if (!rem) return;
      const r = await c.confirmAndSend.execute({ remittanceId: rem.id });
      setRem(r.snapshot);
      setStep(r.status === "settled" ? "done" : "track");
    });

  // MNR-1 (AR): si el quote venció en review, re-cotizar sin dead-end.
  const onRelock = () =>
    guard(async () => {
      if (!rem) return;
      const r = await c.lockQuote.execute({ remittanceId: rem.id });
      setRem(r.snapshot);
    });

  // A4: tras el timeout del KYC, reintentar sin refrescar (resetea a un flujo fresco en "send").
  const onRetryKyc = () => {
    setTimedOut(false);
    setError(null);
    resetTo(setStep, setRem, setPreview);
  };

  // polling en tracking
  const remId = rem?.id;
  const remStatus = rem?.status;
  const pollRef = useRef(false);
  useEffect(() => {
    if (step !== "track" || !remId || pollRef.current) return;
    pollRef.current = true;
    const iv = setInterval(async () => {
      try {
        const r = await c.trackRemittance.execute({ remittanceId: remId });
        setRem(r.snapshot);
        if (r.isTerminal) {
          clearInterval(iv);
          pollRef.current = false;
          if (r.status === "settled") setStep("done");
        }
      } catch {
        /* reintenta */
      }
    }, 1500);
    return () => {
      clearInterval(iv);
      pollRef.current = false;
    };
  }, [step, remId, remStatus, c]);

  const canSend = amountNum > 0 && recipient.trim() && destination.trim();

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-10 pt-6">
      <header className="mb-5 flex items-center gap-2.5">
        <ChaskiMark className="h-9 w-9" />
        <div>
          <p className="text-[15px] font-bold leading-none tracking-heading">Chaski</p>
          <p className="text-xs text-stone">tu plata a Perú, sin vueltas</p>
        </div>
        {address ? (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-sand px-2.5 py-1 text-xs font-semibold text-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-verde"></span>
            {address.slice(0, 6)}…{address.slice(-4)}
          </span>
        ) : null}
      </header>
      <div className="mb-6">
        <Stepper steps={STEP_LABELS} current={STEP_INDEX[step]} />
      </div>

      {rem && isDemoMode(rem) && (step === "review" || step === "track") ? (
        <div className="mb-4 flex items-center justify-center">
          <Pill tone="warn">Modo demo — sin dinero real</Pill>
        </div>
      ) : null}

      {resuming ? (
        <Card className="mt-2 flex-1 space-y-4 text-center">
          <Loader2 className="mx-auto mt-6 h-8 w-8 animate-spin text-cochineal" />
          <div>
            <p className="text-base font-bold">Verificando tu identidad…</p>
            <p className="mx-auto mt-1 max-w-xs text-sm text-stone">
              Estamos confirmando tu verificación con Didit. Un segundo.
            </p>
          </div>
        </Card>
      ) : timedOut ? (
        <Card className="mt-2 flex-1 space-y-4 text-center">
          <div>
            <p className="text-base font-bold">La verificación está tardando</p>
            <p className="mx-auto mt-1 max-w-xs text-sm text-stone">
              No pudimos confirmar tu identidad a tiempo. Podés reintentar sin recargar la página.
            </p>
          </div>
          <Button onClick={onRetryKyc}>Reintentar</Button>
        </Card>
      ) : (
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.22 }}
          className="flex-1"
        >
          {step === "send" && (
            <div className="space-y-4">
              <Card>
                <Field label="Enviás">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl font-bold text-stone">$</span>
                    <input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                      inputMode="decimal"
                      className="tabular w-full bg-transparent text-4xl font-extrabold tracking-heading outline-none"
                      aria-label="Monto en dólares"
                    />
                  </div>
                </Field>
                <div className="mt-4 rounded-xl bg-verde-bg px-4 py-3">
                  <p className="text-xs font-medium text-verde/80">Tu familia recibe</p>
                  <p className="tabular text-2xl font-extrabold text-verde">
                    {preview ? preview.receive.format() : "—"}
                  </p>
                  {preview ? (
                    <p className="mt-0.5 text-xs text-verde/70">
                      1 USD ≈ S/ {preview.rate.toFixed(3)} · llega en ~{preview.etaMinutes} min
                    </p>
                  ) : null}
                </div>
              </Card>

              <Card className="space-y-3">
                <Field label="¿A quién?">
                  <TextInput
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    placeholder="Nombre de tu familiar"
                  />
                </Field>
                <div>
                  <span className="mb-1.5 block text-sm font-medium text-stone">¿Cómo recibe?</span>
                  <div className="grid grid-cols-3 gap-2">
                    {METHODS.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setMethod(m.id)}
                        className={
                          method === m.id
                            ? "rounded-xl border-2 border-cochineal bg-cochineal/5 py-2.5 text-sm font-semibold text-cochineal-ink"
                            : "rounded-xl border border-line bg-card py-2.5 text-sm font-medium text-stone"
                        }
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                <Field label={method === "bank_cci" ? "CCI del banco" : "Número de celular"}>
                  <TextInput
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    placeholder={method === "bank_cci" ? "002-193-..." : "999 888 777"}
                    inputMode={method === "bank_cci" ? "numeric" : "tel"}
                  />
                </Field>
              </Card>

              <Button disabled={!canSend || busy} onClick={onSend}>
                Continuar <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          )}

          {step === "connect" && (
            <div className="space-y-4">
              <Card className="space-y-4 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-sand">
                  <Wallet className="h-7 w-7 text-cochineal" />
                </div>
                <div>
                  <p className="text-base font-bold">Conectá tu wallet</p>
                  <p className="mx-auto mt-1 max-w-xs text-sm text-stone">
                    Firmás el envío desde tu billetera con USDC. Chaski nunca toca tu plata — solo la
                    dirige.
                  </p>
                </div>
                <div className="rounded-xl bg-verde-bg px-4 py-2.5 text-left">
                  <p className="text-xs text-verde/80">Vas a enviar</p>
                  <p className="tabular text-lg font-extrabold text-verde">
                    {rem ? rem.sendUsd.format() : "—"}{" "}
                    <span className="text-sm font-medium">en Avalanche</span>
                  </p>
                </div>
              </Card>
              <Button disabled={busy} onClick={onConnect}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Wallet className="h-4 w-4" /> Conectar wallet
                  </>
                )}
              </Button>
            </div>
          )}

          {step === "verify" && (
            <div className="space-y-4">
              <Card className="space-y-4">
                <div className="flex items-center gap-2 text-verde">
                  <ShieldCheck className="h-5 w-5" />
                  <p className="text-sm font-semibold">Verificación única</p>
                </div>
                <p className="text-sm text-stone">
                  Por ley, verificamos tu identidad <b>una sola vez</b>. Escaneás tu DNI y te sacás
                  una selfie — lo hace <b>Didit</b>, un verificador certificado. Tus datos no se
                  comparten.
                </p>
                {scanStage === 0 ? (
                  <div className="flex items-center justify-center gap-3 rounded-xl border border-dashed border-line bg-sand/60 py-7">
                    <IdCard className="h-8 w-8 text-stone" />
                    <ArrowRight className="h-4 w-4 text-stone/60" />
                    <ScanFace className="h-8 w-8 text-stone" />
                  </div>
                ) : (
                  <ol className="space-y-2.5 rounded-xl bg-sand/60 px-4 py-3.5">
                    {SCAN_STEPS.map((s, i) => {
                      const stageNo = i + 1;
                      const done = scanStage > stageNo || scanStage === 4;
                      const active = scanStage === stageNo;
                      return (
                        <li key={s} className="flex items-center gap-2.5">
                          <span
                            className={
                              done
                                ? "flex h-5 w-5 items-center justify-center rounded-full bg-verde text-white"
                                : active
                                  ? "flex h-5 w-5 items-center justify-center rounded-full bg-cochineal text-white"
                                  : "flex h-5 w-5 items-center justify-center rounded-full bg-line"
                            }
                          >
                            {done ? (
                              <Check className="h-3 w-3" />
                            ) : active ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : null}
                          </span>
                          <span
                            className={
                              done || active
                                ? "text-sm font-medium text-ink"
                                : "text-sm text-stone"
                            }
                          >
                            {s}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </Card>
              <Button disabled={busy} onClick={onVerify}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Camera className="h-4 w-4" /> Escanear DNI + selfie
                  </>
                )}
              </Button>
            </div>
          )}

          {step === "review" && rem?.quote && (
            <div className="space-y-4">
              <Card>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-semibold">Revisá antes de enviar</p>
                  <Pill tone="active">tasa fijada</Pill>
                </div>
                <div className="mb-3 rounded-xl bg-sand px-4 py-3 text-center">
                  <p className="text-xs text-stone">{rem.beneficiary.name} recibe</p>
                  <p className="tabular text-3xl font-extrabold text-verde">
                    {rem.quote.receive.format()}
                  </p>
                </div>
                <Row label="Enviás" value={rem.sendUsd.format()} />
                <Row label="Comisión" value={rem.quote.feeUsd.format()} />
                <Row label="Tipo de cambio" value={`S/ ${rem.quote.rate.toFixed(3)}`} />
                <Row label="Llega en" value={`~${rem.quote.etaMinutes} min`} />
                <div className="my-2 h-px bg-line" />
                <Row label="Recibe en" value={`${methodLabel(rem.beneficiary.method)} · ${rem.beneficiary.destination}`} />
              </Card>
              {rem.kyc?.identity ? (
                <div className="flex items-center gap-2.5 rounded-xl bg-verde-bg px-4 py-2.5">
                  <BadgeCheck className="h-4 w-4 shrink-0 text-verde" />
                  <p className="text-xs text-verde/90">
                    Identidad verificada:{" "}
                    <b>
                      {rem.kyc.identity.firstName} {rem.kyc.identity.lastNamePaternal}{" "}
                      {rem.kyc.identity.lastNameMaternal}
                    </b>{" "}
                    · {rem.kyc.identity.documentType} ••••{rem.kyc.identity.documentNumberLast4}
                  </p>
                </div>
              ) : null}
              {error ? (
                <Button variant="outline" disabled={busy} onClick={onRelock}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Recotizar tasa"}
                </Button>
              ) : (
                <>
                  <Button disabled={busy} onClick={onConfirm}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : `Confirmar y enviar ${rem.sendUsd.format()}`}
                  </Button>
                  <p className="text-center text-xs text-stone">
                    Al confirmar, autorizás el envío de {rem.sendUsd.format()} desde tu wallet.
                  </p>
                </>
              )}
            </div>
          )}

          {step === "track" && rem && <TrackView rem={rem} />}

          {step === "done" && rem && <Receipt rem={rem} onNew={() => resetTo(setStep, setRem, setPreview)} />}
        </motion.div>
      </AnimatePresence>
      )}

      {error ? (
        <div className="mt-4 rounded-xl border border-cochineal/20 bg-cochineal/5 px-4 py-3 text-sm text-cochineal-ink">
          {error}
        </div>
      ) : null}
    </main>
  );
}

const TRACK_STEPS: { key: RemittanceState["status"][]; label: string }[] = [
  { key: ["confirmed", "principal_in"], label: "Fondos en camino" },
  { key: ["payout_submitted"], label: "Pagando a tu familiar" },
  { key: ["settled"], label: "Entregado" },
];
function TrackView({ rem }: { rem: RemittanceState }) {
  const order: RemittanceState["status"][] = [
    "confirmed",
    "principal_in",
    "payout_submitted",
    "settled",
  ];
  const idx = order.indexOf(rem.status);
  return (
    <Card className="space-y-4">
      <div className="flex items-center gap-2.5">
        <ChaskiMark className="h-8 w-8 animate-pulse" />
        <p className="text-sm font-semibold">Tu chaski está en camino…</p>
      </div>
      <ol className="space-y-3">
        {TRACK_STEPS.map((s, i) => {
          const reached = order.indexOf(s.key[s.key.length - 1] ?? "settled") <= idx;
          const active = s.key.includes(rem.status);
          return (
            <li key={s.label} className="flex items-center gap-3">
              <span
                className={
                  reached
                    ? "flex h-6 w-6 items-center justify-center rounded-full bg-verde text-white"
                    : active
                      ? "flex h-6 w-6 items-center justify-center rounded-full bg-cochineal text-white"
                      : "flex h-6 w-6 items-center justify-center rounded-full bg-line"
                }
              >
                {reached ? <Check className="h-3.5 w-3.5" /> : active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="text-xs text-stone">{i + 1}</span>}
              </span>
              <span className={reached || active ? "text-sm font-medium text-ink" : "text-sm text-stone"}>
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function Receipt({ rem, onNew }: { rem: RemittanceState; onNew: () => void }) {
  const delivered = deliveredDisplay(rem);
  return (
    <div className="space-y-4">
      <Card className="text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-verde-bg">
          <Check className="h-7 w-7 text-verde" />
        </div>
        <p className="text-sm text-stone">{rem.beneficiary.name} recibió</p>
        <p className="tabular text-4xl font-extrabold text-verde">{delivered ? delivered.format() : "—"}</p>
        <p className="mt-1 text-xs text-stone">en su {methodLabel(rem.beneficiary.method)}</p>
        {isDemoMode(rem) ? (
          <div className="mt-3 flex items-center justify-center">
            <Pill tone="warn">Modo demo — sin dinero real</Pill>
          </div>
        ) : null}
      </Card>
      <Card>
        <p className="mb-2 text-sm font-semibold">Recibo</p>
        <Row label="Enviaste" value={rem.sendUsd.format()} />
        {rem.quote ? <Row label="Tipo de cambio" value={`S/ ${rem.quote.rate.toFixed(3)}`} /> : null}
        <Row label="Estado" value={<Pill tone="ok">Entregado</Pill>} />
        <Row label="Referencia" value={rem.id.slice(0, 8)} />
      </Card>
      <Button variant="outline" onClick={onNew}>
        Enviar otra
      </Button>
    </div>
  );
}

function methodLabel(m: PayoutMethod): string {
  return m === "yape" ? "Yape" : m === "plin" ? "Plin" : "cuenta bancaria";
}
function resetTo(
  setStep: (s: Step) => void,
  setRem: (r: RemittanceState | null) => void,
  setPreview: (q: Quote | null) => void,
): void {
  setRem(null);
  setPreview(null);
  setStep("send");
}
