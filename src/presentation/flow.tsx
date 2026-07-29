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
import { MIN_SEND_USD, Remittance } from "../domain/remittance"; // WKH-187: rehydrate/isQuoteStillValid en el resume (CD-11) · WKH-314: mínimo enviable
import { createContainer, type Container } from "../composition/container";
import { resolveActiveVm, resolveChain } from "../infrastructure/chain"; // WKH-209/HU-SOL-13: red + VM activa (env-driven, NEXT_PUBLIC_)
import { deliveredDisplay, humanError, isDemoMode, isFallbackWalletAddress } from "./flow-vm";
import { Button, Card, ChaskiMark, Field, Pill, Row, Stepper, TextInput } from "./ui";

// WKH-187: el quote se muestra ANTES del KYC. Orden: send→connect→review(pre-KYC)→verify→confirm(post-KYC)→track→done.
type Step = "send" | "connect" | "review" | "verify" | "confirm" | "track" | "done";
const STEP_LABELS = ["Enviar", "Revisar", "Identidad", "Seguir"];
const STEP_INDEX: Record<Step, number> = {
  send: 0,
  connect: 0,
  review: 1,
  verify: 2,
  confirm: 2, // comparte "Identidad" con verify (solape análogo al connect/verify anterior)
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

// WKH-188: timing del resume-loop de KYC, alineado al estándar de UX (SDD §5.1).
// Escape < límite de atención 10 s (NN/g); poll total 20 s dentro del rango 15-30 s de
// auto-poll post-redirect de verificadores hospedados.
const RESUME_ESCAPE_DELAY_MS = 5000;   // el escape aparece a los 5 s
const RESUME_POLL_INTERVAL_MS = 2500;  // intervalo de poll (sin cambio vs WKH-178)
const RESUME_MAX_POLLS = 8;            // 8 × 2500 ms = 20 s total (antes 40 = ~100 s)

export function RemittanceFlow({ container }: { container?: Container } = {}) {
  const c = useMemo(() => container ?? createContainer(), [container]);
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
  const [confirmReset, setConfirmReset] = useState(false); // control "¿No sos vos?" (WKH-184)
  const [rateUpdated, setRateUpdated] = useState(false); // WKH-187: el quote se re-cotizó tras expirar durante el KYC
  const [showResumeEscape, setShowResumeEscape] = useState(false); // WKH-188: botón de escape a los 5 s
  const cancelledRef = useRef(false); // WKH-188: corta el resume-loop tras el escape

  const amountNum = Number(amount) || 0;

  // preview en vivo (debounced)
  useEffect(() => {
    // WKH-314: por debajo del mínimo no se pide cotización. El agente la rechaza igual, así que
    // pedirla sería un viaje garantizado a un error — y, antes de esta HU, una promesa de cero.
    if (amountNum < MIN_SEND_USD) {
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
      for (let i = 0; i < RESUME_MAX_POLLS; i++) {
        if (cancelledRef.current) return; // CD-CANCEL: no dispara otra iteración tras el escape
        let res: Awaited<ReturnType<typeof c.resumeKyc.execute>>;
        try {
          res = await c.resumeKyc.execute();
        } catch {
          break;
        }
        if (!alive) return;
        // BLQ-MED-1 (WKH-188): 3er punto de suspensión. Si el escape corrió mientras execute()
        // estaba en vuelo, cortar ANTES de tocar `resuming`/navegar → el overlay no re-cuelga.
        if (cancelledRef.current) return; // CD-CANCEL: cubre el `await execute()`, no solo top+post-sleep
        if (res.kind === "none") {
          setResuming(false);
          return;
        }
        if (res.kind === "processing") {
          setResuming(true);
          await sleep(RESUME_POLL_INTERVAL_MS);
          if (cancelledRef.current) return; // CD-CANCEL: no dispara otra iteración tras el escape
          continue;
        }
        setResuming(false);
        if (res.kind === "passed") {
          setRem(res.snapshot); // el snapshot ya trae el quote lockeado pre-redirect (WKH-187)
          // CD-11: re-check de expiry con la lógica del dominio (single-source-of-truth), NO recalcular en la UI.
          const valid = Remittance.rehydrate(res.snapshot).isQuoteStillValid(new Date().toISOString());
          if (valid) {
            if (alive) setStep("confirm"); // AC-6: quote vigente → NO re-cotiza
          } else {
            try {
              const prev = res.snapshot.quote?.receive; // lo que vio pre-KYC
              const locked = await c.lockQuote.execute({ remittanceId: res.snapshot.id }); // AUTO re-quote (kyc_passed→quoted)
              if (alive) {
                setRem(locked.snapshot);
                // AC-5: indicador solo si el monto cambió; NUNCA re-pide escanear DNI (state.kyc intacto).
                if (prev && locked.snapshot.quote && prev.minor !== locked.snapshot.quote.receive.minor) {
                  setRateUpdated(true);
                }
                setStep("confirm");
              }
            } catch {
              if (alive) setStep("confirm"); // el paso confirm ofrece Recotizar (onRelock) si falta quote/expiró
            }
          }
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

  // WKH-188: mientras el overlay `resuming` está visible, ofrecer un escape a los 5 s (AC-1).
  // Time-based (no atado al conteo de iteraciones). Al caer `resuming` (terminal temprano o timeout),
  // limpia el timer y resetea el flag → el botón nunca aparece indebido (AC-6).
  useEffect(() => {
    if (!resuming) {
      setShowResumeEscape(false);
      return;
    }
    const t = setTimeout(() => setShowResumeEscape(true), RESUME_ESCAPE_DELAY_MS);
    return () => clearTimeout(t);
  }, [resuming]);

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
      setRateUpdated(false); // WKH-187: flujo nuevo, sin indicador de re-cotización heredado
      setStep("connect");
    });

  const onConnect = () =>
    guard(async () => {
      if (!rem) return;
      const { address: addr, rememberedKyc } = await c.connectWallet.execute();
      setAddress(addr);
      // WKH-187/CD-12: cotizá SIEMPRE apenas conecta (created→quoted), ANTES de cualquier KYC.
      // El quote queda visible en el paso `review` pre-KYC (AC-1).
      const locked = await c.lockQuote.execute({ remittanceId: rem.id });
      setRem(locked.snapshot);
      if (rememberedKyc && rememberedKyc.approved && rememberedKyc.payoutAllowed) {
        // KYC-once: esta wallet ya está verificada → salta review+verify, directo a confirmar (AC-4).
        const res = await c.startKyc.execute({ remittanceId: rem.id, address: addr });
        if (res.kind === "done") {
          setRem(res.snapshot);
          setStep("confirm");
        } else {
          setStep("review");
        }
      } else {
        setStep("review");
      }
    });

  // WKH-187/AC-2: la CTA "Continuar" del review lleva al KYC pero NO lo auto-inicia (navegación pura).
  const onContinue = () => setStep("verify");

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
      // done: simulación (sin key) o KYC-once. El quote ya está lockeado desde onConnect (WKH-187).
      setRem(res.snapshot);
      if (res.snapshot.status !== "kyc_passed") {
        setScanStage(0);
        setError("No pudimos verificar tu identidad. Intentá de nuevo.");
        return;
      }
      setScanStage(4);
      await sleep(400);
      setStep("confirm");
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

  // WKH-188 (AC-2/AC-3): escape manual del overlay `resuming`. Detiene el loop, limpia el pending
  // ANTES de navegar (CD-2), y vuelve a `send` (estado usable, anterior al gate — CD-1).
  const onCancelResume = async () => {
    cancelledRef.current = true; // síncrono: el loop lo ve tras su sleep en curso
    try {
      await c.abandonPendingKyc.execute(); // CD-2: abandon ANTES de navegar
    } catch {
      /* best-effort — el reset de estado corre igual (patrón forgetAndDisconnect) */
    }
    setShowResumeEscape(false);
    setResuming(false);
    resetTo(setStep, setRem, setPreview); // → paso `send`
  };

  // A4: tras el timeout del KYC, reintentar sin refrescar (resetea a un flujo fresco en "send").
  const onRetryKyc = () => {
    setTimedOut(false);
    setError(null);
    resetTo(setStep, setRem, setPreview);
  };

  // Reset explícito (WKH-184): olvida el KYC-once de esta address + pending, y vuelve a estado fresco
  // exigiendo reconexión. SEPARADO de resetTo (que preserva address para "enviar otra" — CD-7).
  const forgetAndDisconnect = () =>
    guard(async () => {
      try {
        if (address) await c.forgetKyc.execute({ address });
      } catch {
        /* best-effort — el reset del estado corre igual (AC-5/CD-8) */
      }
      setAddress(null);
      setRem(null);
      setPreview(null);
      // Limpia la PII del beneficiario de la persona anterior (mismo threat-model que esta HU):
      // en un dispositivo compartido, la persona B no debe aterrizar con el nombre/celular de A.
      setRecipient("");
      setDestination("");
      setScanStage(0);
      setAmount("400"); // no es PII → vuelve al default inicial (evita form con monto en blanco)
      setRateUpdated(false); // WKH-187
      setStep("send");
      setConfirmReset(false);
    });

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
        // AC-2 (WKH-200): payout_failed NO es terminal (→ refunded) pero el poll debe frenar igual
        // (UI-only, sin tocar TERMINAL_STATUSES / CD-1). El setStep("done") sigue gateado por settled.
        if (r.isTerminal || r.status === "payout_failed") {
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

  // WKH-314: por debajo del mínimo la comisión se come el envío entero y la cotización
  // entregaría cero. El agente lo rechaza igual (es él quien protege); esto es para que la
  // persona se entere ANTES de poner el nombre, el KYC y la plata, no después.
  const belowMinimum = amountNum > 0 && amountNum < MIN_SEND_USD;
  const canSend =
    amountNum >= MIN_SEND_USD && Boolean(recipient.trim()) && Boolean(destination.trim());

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-10 pt-6">
      <header className="mb-5 flex items-center gap-2.5">
        <ChaskiMark className="h-9 w-9" />
        <div>
          <p className="text-[15px] font-bold leading-none tracking-heading">Chaski</p>
          <p className="text-xs text-stone">tu plata a Perú, sin vueltas</p>
        </div>
        {address ? (
          <div className="ml-auto flex flex-col items-end gap-1">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-sand px-2.5 py-1 text-xs font-semibold text-ink">
              <span className="h-1.5 w-1.5 rounded-full bg-verde"></span>
              {address.slice(0, 6)}…{address.slice(-4)}
            </span>
            {confirmReset ? (
              <div className="flex items-center gap-2 text-xs text-stone">
                <span>Esto borra tu verificación en este dispositivo.</span>
                <button
                  type="button"
                  onClick={forgetAndDisconnect}
                  disabled={busy}
                  className="font-semibold text-cochineal underline underline-offset-2"
                >
                  Empezar de nuevo
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmReset(false)}
                  className="text-stone underline underline-offset-2"
                >
                  Cancelar
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                className="text-xs text-stone underline underline-offset-2"
              >
                ¿No sos vos?
              </button>
            )}
          </div>
        ) : null}
      </header>
      <div className="mb-6">
        <Stepper steps={STEP_LABELS} current={STEP_INDEX[step]} />
      </div>

      {address && isFallbackWalletAddress(address) ? (
        <div className="mb-4 flex items-center justify-center">
          <Pill tone="warn">
            Sin aislamiento por wallet en este dispositivo. Conectá MetaMask o WalletConnect.
          </Pill>
        </div>
      ) : null}

      {rem && isDemoMode(rem) && (step === "review" || step === "confirm" || step === "track" || step === "verify") ? (
        <div className="mb-4 flex items-center justify-center">
          <Pill tone="warn">Modo demo (sin dinero real)</Pill>
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
          {showResumeEscape ? (
            <div className="space-y-2">
              <p className="text-sm text-stone">¿No completaste la verificación?</p>
              <Button variant="outline" onClick={onCancelResume}>
                Empezar de nuevo
              </Button>
            </div>
          ) : null}
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
                {belowMinimum ? (
                  <p className="mt-2 text-xs font-medium text-cochineal" role="alert">
                    El mínimo para enviar es ${MIN_SEND_USD}. Por debajo de eso la comisión se
                    lleva todo y tu familia no recibiría nada.
                  </p>
                ) : null}
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
                        type="button"
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
                    Firmás el envío desde tu billetera con USDC. Chaski nunca toca tu plata, solo la
                    dirige.
                  </p>
                </div>
                <div className="rounded-xl bg-verde-bg px-4 py-2.5 text-left">
                  <p className="text-xs text-verde/80">Vas a enviar</p>
                  <p className="tabular text-lg font-extrabold text-verde">
                    {rem ? rem.sendUsd.format() : "—"}{" "}
                    <span className="text-sm font-medium">en {resolveChain().name}</span>
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
                  una selfie. Lo hace <b>Didit</b>, un verificador certificado. Tus datos no se
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

          {/* WKH-187: paso `review` pre-KYC — muestra el VALOR (cuánto recibe la familia) antes de verificar. */}
          {step === "review" && rem?.quote && (
            <div className="space-y-4">
              <Card>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-semibold">Revisá el envío</p>
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
              <Button disabled={busy} onClick={onContinue}>
                Continuar <ArrowRight className="h-4 w-4" />
              </Button>
              <p className="text-center text-xs text-stone">
                Para enviar, verificás tu identidad una sola vez (por ley).
              </p>
            </div>
          )}

          {/* WKH-187: paso `confirm` post-KYC — el review con badge de identidad + confirmar/relock. */}
          {step === "confirm" && rem?.quote && (
            <div className="space-y-4">
              {rateUpdated ? (
                <div className="flex items-center justify-center">
                  <Pill tone="active">
                    La tasa se actualizó · tu familia recibe {rem.quote.receive.format()} ahora
                  </Pill>
                </div>
              ) : null}
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

          {step === "track" && rem && (
            <TrackView rem={rem} refundGateway={c.solanaRefund} sender={address} />
          )}

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
// Exportado para test directo (HU-SOL-13/T7): el render del flujo completo en modo Solana toca
// isFallbackWalletAddress (flow-vm, Scope OUT) que no canonicaliza el FALLBACK EVM en base58; testear
// TrackView en aislamiento evita ese acople y cubre exactamente la acción refund (AC-6/AC-7).
export function TrackView({
  rem,
  refundGateway,
  sender,
}: {
  rem: RemittanceState;
  refundGateway?: Container["solanaRefund"];
  sender: string | null;
}) {
  // HU-SOL-13 (AC-6/AC-7, CD-10): acción refund trustless SOLO en modo Solana. resolveActiveVm() lee
  // NEXT_PUBLIC_VM (client-safe); throw en VM inválida ⇒ try/catch → false (nunca rompe el render). En
  // EVM/demo isSolana=false ⇒ NINGÚN nodo nuevo ⇒ UI byte-idéntica (CD-2).
  let isSolana = false;
  try {
    isSolana = resolveActiveVm() === "solana";
  } catch {
    isSolana = false;
  }
  // Deadline on-chain = floor(Date.parse(quote.expiresAt)/1000) (fijado por HU-SOL-5, AH-14/NC-3). La UI
  // usa el mismo instante como proxy DEFENSIVO (defensa en profundidad): el guard AUTORITATIVO es la
  // lectura on-chain dentro de wallet.refundEscrow (aborta si status≠Deposited o now<deadline).
  const deadlineReached = rem.quote ? Date.now() >= Date.parse(rem.quote.expiresAt) : false;
  // Refundeable: el deposit entró y aún no se recuperó/entregó (escrow potencialmente Deposited on-chain).
  const refundeable =
    rem.status === "principal_in" ||
    rem.status === "payout_submitted" ||
    rem.status === "payout_failed";
  const showRefund =
    isSolana && refundeable && rem.refundTx == null && deadlineReached && !!refundGateway && !!sender;

  // AC-1 (WKH-200): payout_failed/refunded NO están en `order` → idx=-1 renderizaría la vista
  // optimista ("en camino", steps grises). Branch temprano a una vista honesta de fallo/reembolso.
  // Copy vía humanError (enum→copy fijo, PII-free / CD-5): NUNCA interpolar failureReason/beneficiary.
  if (rem.status === "payout_failed" || rem.status === "refunded") {
    return (
      <Card className="space-y-3">
        <p className="text-sm font-semibold">No pudo entregarse</p>
        <p className="text-sm text-stone">{humanError("payout_failed")}</p>
        {rem.refundTx ? (
          <p className="text-xs text-stone">Referencia de reembolso: {rem.refundTx}</p>
        ) : null}
        {showRefund && refundGateway && sender ? (
          <RefundAction remittanceId={rem.id} sender={sender} gateway={refundGateway} />
        ) : null}
      </Card>
    );
  }
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
      {showRefund && refundGateway && sender ? (
        <RefundAction remittanceId={rem.id} sender={sender} gateway={refundGateway} />
      ) : null}
    </Card>
  );
}

// HU-SOL-13 (AC-6/CD-10): botón "Recuperar fondos" — el SENDER firma+broadcastea el refund del escrow
// (vía el gateway → wallet.refundEscrow), SIN facilitator ni release-authority. Estado local: idle →
// firmando → hecho/error. Sólo se monta cuando TrackView calculó showRefund (vm=solana + refundeable +
// now>=deadline). El guard AUTORITATIVO (status==Deposited / now>=deadline on-chain) vive en refundEscrow.
function RefundAction({
  remittanceId,
  sender,
  gateway,
}: {
  remittanceId: string;
  sender: string;
  gateway: NonNullable<Container["solanaRefund"]>;
}) {
  const [busy, setBusy] = useState(false);
  const [refundTx, setRefundTx] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const onRefund = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const { refundTx: tx } = await gateway.refund({ remittanceId, sender });
      setRefundTx(tx);
    } catch {
      setErr("No pudimos recuperar los fondos. Intentá de nuevo."); // enum→copy fijo, sin PII (CD-5)
    } finally {
      setBusy(false);
    }
  }, [gateway, remittanceId, sender]);

  if (refundTx) {
    return <p className="text-xs text-stone">Refund enviado: {refundTx}</p>;
  }
  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={onRefund} disabled={busy}>
        {busy ? "Recuperando…" : "Recuperar fondos"}
      </Button>
      {err ? <p className="text-xs text-cochineal-ink">{err}</p> : null}
    </div>
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
            <Pill tone="warn">Modo demo (sin dinero real)</Pill>
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
