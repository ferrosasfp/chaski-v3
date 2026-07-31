"use client";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  Camera,
  Check,
  Clock3,
  IdCard,
  Loader2,
  ScanFace,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Quote, RemittanceState, PayoutMethod } from "../domain/remittance";
import { MIN_SEND_USD, Remittance, TERMINAL_STATUSES } from "../domain/remittance"; // WKH-187: rehydrate/isQuoteStillValid en el resume (CD-11) · WKH-314: mínimo enviable
import { createContainer, type Container } from "../composition/container";
import {
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
} from "../application/use-cases/confirm-and-send";
import { ESCROW_REFUNDED_BY_SENDER } from "../application/use-cases/recover-escrow-funds";
import { resolveSolanaNetworkConfig } from "../infrastructure/chain"; // HU-SOL-13: cluster Solana activo (env-driven)
import {
  deliveredDisplay,
  escrowFundsAtRisk,
  escrowFundsKnowledge,
  escrowKnowledgeCopy,
  escrowRefundError,
  humanError,
  isDemoMode,
  statusDisplay,
} from "./flow-vm";
import { cn } from "./cn";
import { Button, Card, ChaskiMark, Field, Pill, Row, Stepper, TextInput } from "./ui";

// WKH-187: el quote se muestra ANTES del KYC. Orden: send→connect→review(pre-KYC)→verify→confirm(post-KYC)→track→done.
// `history` NO es un paso del flujo: es la puerta de entrada a las remesas que ya existen. Se
// necesita porque `step`/`rem`/`address` son estado de React y una recarga los borra: sin esta
// pantalla, una remesa con USDC en el escrow dejaba de tener camino desde la interfaz.
type Step = "send" | "connect" | "review" | "verify" | "confirm" | "track" | "done" | "history";
const STEP_LABELS = ["Enviar", "Revisar", "Identidad", "Seguir"];
const STEP_INDEX: Record<Step, number> = {
  send: 0,
  connect: 0,
  review: 1,
  verify: 2,
  confirm: 2, // comparte "Identidad" con verify (solape análogo al connect/verify anterior)
  track: 3,
  done: 3,
  history: 0, // fuera de la línea del flujo; el stepper no la representa
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
  // Las remesas ya guardadas de esta wallet. `null` = todavía no las pedimos (que no es lo mismo que
  // "no hay"): la pantalla de historial sólo se renderiza con la lista ya resuelta.
  const [history, setHistory] = useState<RemittanceState[] | null>(null);

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

  // La puerta de entrada a lo que ya existe. Pide la address ANTES de listar porque el historial está
  // scopeado por dueño (repo.list): sin saber quién sos no hay lista que mostrar, y adivinarla sería
  // mostrarle a alguien las remesas de otro. Con la wallet ya conectada (autoConnect) `connect()` no
  // abre ningún modal: lee el estado del bridge y devuelve la misma address.
  const openHistory = () =>
    guard(async () => {
      const addr = address ?? (await c.connectWallet.execute()).address;
      setAddress(addr);
      setHistory(await c.listHistory.execute(addr));
      setStep("history");
    });

  // Retomar una remesa del historial. No reconstruye nada: mete el snapshot guardado en el MISMO
  // estado que usa el flujo y salta a la vista que ya sabe mostrarlo, botón de recuperar incluido.
  // `settled` va al recibo; el resto al seguimiento, que es donde vive "Recuperar fondos".
  const onOpenFromHistory = (entry: RemittanceState) => {
    setError(null);
    setRem(entry);
    setStep(entry.status === "settled" ? "done" : "track");
  };

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

  // Antes de OFRECER el borrado, averiguar qué se va a borrar. La advertencia no puede hablar de
  // remesas con fondos sin comprobar si nunca las miró. Si la consulta falla, `history` queda en
  // `null` y la advertencia dice que no pudo revisar — que no es lo mismo que "no hay nada".
  const onAskReset = async () => {
    setConfirmReset(true);
    if (!address) return;
    try {
      setHistory(await c.listHistory.execute(address));
    } catch {
      setHistory(null);
    }
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
      setHistory(null); // las entries del dueño ya no existen: no se puede seguir mostrando la lista
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
    // El effect DEPENDE de remStatus, así que cada cambio de estado arrancaba un intervalo NUEVO —
    // incluido el salto a `refunded`. 1,5 s después ese intervalo leía el estado PERSISTIDO (viejo si
    // el save había fallado) y lo pisaba: la persona veía "Recuperaste tus fondos" y la pantalla
    // volvía sola a "Preparando el pago", con el botón de nuevo. Sobre un estado que ya no avanza por
    // sí solo no hay nada que pollear, y sí algo que arruinar.
    if (remStatus && (TERMINAL_STATUSES.includes(remStatus) || remStatus === "payout_failed")) return;
    pollRef.current = true;
    let cancelled = false; // el tick en vuelo no puede escribir después de la limpieza
    const iv = setInterval(async () => {
      try {
        const r = await c.trackRemittance.execute({ remittanceId: remId });
        if (cancelled) return;
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
      cancelled = true;
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
              <div className="max-w-[15rem] space-y-1.5 text-right text-xs text-stone">
                <ResetWarning items={history} />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={forgetAndDisconnect}
                    disabled={busy}
                    className="font-semibold text-cochineal underline underline-offset-2"
                  >
                    Borrar igual
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    className="text-stone underline underline-offset-2"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={onAskReset}
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

              {/* La vuelta a lo que ya existe. Vive en `send` porque es donde aterriza toda recarga y
                  también adonde vuelve "Enviar otra": desde acá una remesa con USDC en el escrow
                  siempre tiene camino, sin importar cómo se llegó. */}
              <button
                type="button"
                onClick={openHistory}
                disabled={busy}
                className="w-full text-center text-sm font-semibold text-cochineal underline underline-offset-2 disabled:opacity-50"
              >
                Ver mis envíos
              </button>
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
                    <span className="text-sm font-medium">en Solana {resolveSolanaNetworkConfig().cluster}</span>
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
            <TrackView
              rem={rem}
              recover={c.recoverEscrowFunds}
              sender={address}
              onRecovered={setRem}
            />
          )}

          {step === "history" && history && (
            <HistoryView items={history} onOpen={onOpenFromHistory} onBack={() => setStep("send")} />
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

const TRACK_STEPS: { key: RemittanceState["status"][]; label: string; manual?: boolean }[] = [
  { key: ["confirmed", "principal_in"], label: "Fondos en camino" },
  // "Pagando a tu familiar" decía más de lo que pasa: en payout_submitted la orden con el partner
  // está creada y los USDC siguen en el vault del escrow, esperando un release que hoy dispara una
  // persona a mano (ver confirm-and-send.ts:173-182). Nadie está pagando todavía.
  // `manual`: este paso NO avanza solo. Arreglar la etiqueta no alcanzaba — el spinner que giraba
  // encima seguía afirmando progreso, y giraba para siempre.
  { key: ["payout_submitted"], label: "Preparando el pago a tu familiar", manual: true },
  { key: ["settled"], label: "Entregado" },
];
// Exportado para test directo (HU-SOL-13/T7): testear TrackView en aislamiento cubre exactamente la
// acción refund (AC-6/AC-7) sin montar el flujo entero.
export function TrackView({
  rem,
  recover,
  sender,
  onRecovered,
}: {
  rem: RemittanceState;
  // El use-case, NO el gateway suelto: el gateway devuelve una signature y nada más, y de ahí salía
  // el bug de que un refund exitoso no dejaba rastro en el estado.
  recover?: Container["recoverEscrowFunds"];
  sender: string | null;
  onRecovered: (snapshot: RemittanceState) => void;
}) {
  // HU-SOL-13 (AC-6/AC-7, CD-10): acción refund trustless. Siempre disponible: ninguna configuración
  // la puede apagar.
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
    refundeable && rem.refundTx == null && deadlineReached && !!recover && !!sender;
  // Misma condición SALVO el deadline: existe la salida, todavía no está abierta. Se muestra en vez
  // de esconderse, con la hora en que se abre.
  const refundLocked =
    refundeable && rem.refundTx == null && !deadlineReached && !!recover && !!sender && !!rem.quote;

  // AC-1 (WKH-200): payout_failed/refunded NO están en `order` → idx=-1 renderizaría la vista
  // optimista ("en camino", steps grises). Branch temprano a una vista honesta de fallo/reembolso.
  // Copy vía humanError (enum→copy fijo, PII-free / CD-5): NUNCA interpolar failureReason/beneficiary.
  if (rem.status === "payout_failed" || rem.status === "refunded") {
    // La persona que acaba de recuperar SU plata del escrow no vivió un "no pudo entregarse": vivió
    // una recuperación exitosa. El titular se decide por el enum estable que escribe el use-case,
    // nunca interpolando el failureReason crudo (CD-5).
    const recoveredBySender = rem.failureReason === ESCROW_REFUNDED_BY_SENDER;
    // Los otros dos casos que no pueden seguir escondidos detrás de "No pudo entregarse":
    //   · el depósito ESTÁ en el escrow (la cadena lo mostró)
    //   · NO SABEMOS si entró (perdimos la respuesta del settle y la cadena tampoco contestó)
    // El segundo es el que antes se decía como un fallo con una referencia de reembolso inventada al
    // lado. Ahora se dice lo que es, y se ofrece la salida.
    const principalInEscrow = rem.failureReason === PRINCIPAL_SETTLED_REFUND_MANUAL;
    const principalUnknown = rem.failureReason === PRINCIPAL_STATE_UNKNOWN;
    // ¿Hay una salida a la vista? (el botón, habilitado o esperando el deadline). Si no la hay, el
    // texto no puede mandar a apretar un botón que no está.
    const recoveryOffered = showRefund || refundLocked;
    return (
      <Card className="space-y-3">
        <p className="text-sm font-semibold">
          {recoveredBySender
            ? "Recuperaste tus fondos"
            : principalUnknown
              ? "No sabemos todavía si te cobramos"
              : principalInEscrow
                ? "Tus USDC quedaron en el escrow"
                : "No pudo entregarse"}
        </p>
        <p className="text-sm text-stone">
          {recoveredBySender
            ? "Los USDC volvieron a tu wallet. Esta remesa no se entregó."
            : principalUnknown
              ? "Se cortó la comunicación mientras enviábamos tu depósito, y la cadena tampoco nos contestó. Puede que tus USDC estén en el escrow o que nunca hayan salido de tu wallet: todavía no lo sabemos. Nadie te reembolsó nada."
              : principalInEscrow
                ? "Tu depósito entró al escrow y el envío no siguió. Los USDC siguen ahí, a tu nombre. Nadie te los reembolsó: los recuperás vos, firmando desde tu wallet."
                : humanError("payout_failed")}
        </p>
        {(principalUnknown || principalInEscrow) && recoveryOffered ? (
          <p className="text-sm text-stone">
            Pedí que vuelvan con el botón de acá abajo: si están en el escrow, vuelven a tu wallet; si
            nunca salieron, no hay nada que devolver.
          </p>
        ) : null}
        {(principalUnknown || principalInEscrow) && !recoveryOffered ? (
          <p className="text-sm text-stone">
            Para recuperarlos, conectá la misma wallet con la que enviaste.
          </p>
        ) : null}
        {/* Sólo se muestra un comprobante que EXISTE. El adapter ledger-only devuelve null y esta
            línea no se renderiza: un identificador fabricado al lado de la palabra reembolso es peor
            que no decir nada. */}
        {rem.refundTx ? (
          <p className="text-xs text-stone">Referencia de reembolso: {rem.refundTx}</p>
        ) : null}
        {showRefund && recover && sender ? (
          <RefundAction
            remittanceId={rem.id}
            sender={sender}
            recover={recover}
            onRecovered={onRecovered}
          />
        ) : refundLocked && rem.quote ? (
          <RefundLockedNotice availableAt={rem.quote.expiresAt} />
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
  // En payout_submitted no hay nada moviéndose: los USDC están en el vault y el release lo dispara
  // una persona a mano. Un encabezado que late y dice "en camino" es una animación afirmando lo que
  // el sistema no hace.
  const waitingOnPerson = rem.status === "payout_submitted";
  return (
    <Card className="space-y-4">
      <div className="flex items-center gap-2.5">
        <ChaskiMark className={cn("h-8 w-8", waitingOnPerson ? undefined : "animate-pulse")} />
        <p className="text-sm font-semibold">
          {waitingOnPerson ? "Tu envío está esperando" : "Tu chaski está en camino…"}
        </p>
      </div>
      <ol className="space-y-3">
        {TRACK_STEPS.map((s, i) => {
          const last = order.indexOf(s.key[s.key.length - 1] ?? "settled");
          // Un paso está COMPLETADO cuando el estado lo pasó de largo, no cuando lo alcanzó. Antes
          // era `last <= idx`, así que estar EN payout_submitted pintaba el tilde verde de
          // "pagando a tu familiar": un paso en curso se dibujaba como un paso terminado.
          // La excepción es el último ("Entregado"): no hay ningún estado después, así que ahí
          // completarlo ES estar en él.
          const reached = idx > last || (last === order.length - 1 && idx === last);
          const active = !reached && s.key.includes(rem.status);
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
                {/* Un paso que no avanza solo NO gira: el reloj quieto dice "esperando", el spinner
                    decía "trabajando". */}
                {reached ? (
                  <Check className="h-3.5 w-3.5" />
                ) : active && s.manual ? (
                  <Clock3 className="h-3.5 w-3.5" />
                ) : active ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <span className="text-xs text-stone">{i + 1}</span>
                )}
              </span>
              <span className={reached || active ? "text-sm font-medium text-ink" : "text-sm text-stone"}>
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>
      {waitingOnPerson ? (
        <p className="text-xs text-stone">
          Este paso no avanza solo: la entrega la libera una persona del equipo, así que puede quedarse
          acá un buen rato. Si preferís no esperar, podés recuperar tus USDC.
        </p>
      ) : null}
      {showRefund && recover && sender ? (
        <RefundAction
          remittanceId={rem.id}
          sender={sender}
          recover={recover}
          onRecovered={onRecovered}
        />
      ) : refundLocked && rem.quote ? (
        <RefundLockedNotice availableAt={rem.quote.expiresAt} />
      ) : null}
    </Card>
  );
}

// HU-SOL-13 (AC-6/CD-10): botón "Recuperar fondos" — el SENDER firma+broadcastea el refund del escrow
// (vía el use-case → gateway → wallet.refundEscrow), SIN facilitator ni release-authority. Sólo se
// monta cuando TrackView calculó showRefund (refundeable + now>=deadline). El guard AUTORITATIVO
// (status==Deposited / now>=deadline on-chain) vive en refundEscrow.
//
// El resultado NO se guarda en un useState local. Acá vivía exactamente eso: la signature entraba a
// un estado de componente, el repo nunca se enteraba, y tras una recarga la remesa volvía a
// "payout_submitted". El segundo intento chocaba contra un escrow ya Refunded y la app le decía a la
// persona que había fallado una operación que había funcionado. Ahora el use-case escribe el estado
// y el flujo re-renderiza con la verdad (status refunded + refundTx).
export function RefundAction({
  remittanceId,
  sender,
  recover,
  onRecovered,
}: {
  remittanceId: string;
  sender: string;
  recover: NonNullable<Container["recoverEscrowFunds"]>;
  onRecovered: (snapshot: RemittanceState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Lo enviado que la cadena TODAVÍA no confirmó. Deliberadamente efímero (no toca el estado
  // persistido): afirmaría un final que nadie verificó, y `refunded` es terminal.
  const [sent, setSent] = useState<{ confirmation: "pending" | "unknown"; refundTx: string } | null>(
    null,
  );
  const onRefund = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await recover.execute({ remittanceId, sender });
      if (res.confirmation === "confirmed") {
        setSent(null);
        onRecovered(res.remittance.snapshot); // el estado nuevo manda: la pantalla deja de decir "en camino"
        return;
      }
      // Ni éxito ni fracaso: la orden salió y no sabemos si entró. El botón SIGUE acá.
      setSent({ confirmation: res.confirmation, refundTx: res.refundTx });
    } catch (e) {
      // enum→copy fijo, sin PII (CD-5). Antes era UNA frase para todo, y con el caso indeterminado
      // esa frase mentía: "no encontramos depósito" no es "no pudimos recuperar tus fondos".
      setErr(escrowRefundError(e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
    }
  }, [recover, remittanceId, sender, onRecovered]);

  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={onRefund} disabled={busy}>
        {busy ? "Recuperando…" : sent ? "Volver a intentar" : "Recuperar fondos"}
      </Button>
      {sent ? (
        <div className="space-y-1">
          {/* "Enviamos la orden", NUNCA "volvieron": el verbo tiene que ser el de lo que sabemos. */}
          <p className="text-xs font-semibold text-ink">Enviamos la orden de recuperación</p>
          <p className="text-xs text-stone">
            {sent.confirmation === "pending"
              ? "Todavía no la vemos confirmada en la cadena. Puede entrar en un rato, o puede no haber entrado. Hasta que se confirme no sabemos si tus USDC volvieron."
              : "No pudimos consultar la cadena para saber si entró. Nadie sabe todavía si tus USDC volvieron; no es que hayan fallado."}
          </p>
          <p className="text-xs text-stone">Orden enviada: {sent.refundTx}</p>
        </div>
      ) : null}
      {err ? <p className="text-xs text-cochineal-ink">{err}</p> : null}
    </div>
  );
}

// La recuperación con su condición A LA VISTA. Antes, pre-deadline, no se renderizaba NADA: la persona
// miraba un spinner sin saber que existía una salida ni cuándo se abría (10 minutos, los del quote).
// El botón sigue deshabilitado hasta el deadline — el programa Anchor rechaza un refund anterior
// (DeadlineNotReached) y el adapter aborta antes de firmar: acá no se debilita ningún guard, se
// muestra cuándo deja de aplicar.
function RefundLockedNotice({ availableAt }: { availableAt: string }) {
  const when = Number.isNaN(Date.parse(availableAt))
    ? null
    : new Date(availableAt).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="space-y-2">
      <Button variant="outline" disabled>
        Recuperar fondos
      </Button>
      <p className="text-xs text-stone">
        {when
          ? `Podés recuperar tus USDC a partir de las ${when}. Hasta esa hora el contrato no lo permite.`
          : "Vas a poder recuperar tus USDC cuando venza el plazo del contrato."}
      </p>
    </div>
  );
}

// La advertencia del botón que BORRA. "¿No sos vos?" llama a ForgetKyc, que además de olvidar el
// KYC hace repo.clearByOwner(address): borra TODAS las remesas del dueño del almacenamiento local
// (forget-kyc.ts:25). Su copy decía sólo "esto borra tu verificación", así que ya mentía por omisión
// antes de esta HU. Ahora que las remesas son alcanzables desde el historial, ese borrado se lleva
// puesto el único camino que existe hacia una remesa con USDC en el escrow.
//
// Lo que la advertencia NO dice, y es deliberado: no dice que se pierda la plata. Borrar el
// almacenamiento local no toca el vault. Lo que se pierde es el camino desde esta pantalla, y eso es
// exactamente lo que está escrito.
//
// Tampoco bloquea: el botón existe para un dispositivo compartido (WKH-201, purgar la PII del
// anterior) y ese uso es legítimo. Se avisa y se decide; el paso de confirmación ya estaba.
//
// Dos frases y no una: las remesas cuyo depósito la cadena CONFIRMÓ no se pueden anunciar con la
// misma frase que las que nadie miró. Decir "no comprobamos" sobre plata que sí comprobamos es el
// mismo error de esta pantalla, sólo que hacia el otro lado.
export function ResetWarning({ items }: { items: RemittanceState[] | null }) {
  // `null` = no pudimos leer el historial. Callar sería degradar la advertencia en silencio.
  const atRisk = items === null ? null : escrowFundsAtRisk(items);
  return (
    <>
      <p>Esto borra tu verificación y el registro de tus envíos en este dispositivo.</p>
      {atRisk === null ? (
        <p className="font-semibold text-cochineal-ink">
          No pudimos revisar si tenés envíos con USDC sin comprobar.
        </p>
      ) : null}
      {atRisk !== null && atRisk.inEscrow > 0 ? (
        <p className="font-semibold text-cochineal-ink">
          {atRisk.inEscrow === 1
            ? "Tenés 1 envío con USDC en el escrow, a tu nombre."
            : `Tenés ${atRisk.inEscrow} envíos con USDC en el escrow, a tu nombre.`}{" "}
          Borrarlos no toca esa plata, pero perdés la forma de llegar a ella desde esta pantalla.
        </p>
      ) : null}
      {atRisk !== null && atRisk.unverified > 0 ? (
        <p className="font-semibold text-cochineal-ink">
          {atRisk.unverified === 1
            ? "Tenés 1 envío del que no comprobamos si sus USDC siguen en el escrow."
            : `Tenés ${atRisk.unverified} envíos de los que no comprobamos si sus USDC siguen en el escrow.`}{" "}
          Borrarlos no toca esa plata, pero perdés la forma de llegar a ella desde esta pantalla.
        </p>
      ) : null}
    </>
  );
}

// El historial. Existe porque `step`/`rem`/`address` son estado de React: una recarga los borraba y
// la remesa quedaba sin ningún camino desde la interfaz, con los USDC en el vault. El dato SIEMPRE
// estuvo (el repo las guarda por dueño); lo que faltaba era la pantalla.
//
// Lo que esta pantalla NO hace, y es deliberado: no consulta la cadena. Muestra el snapshot guardado
// y dice de cuál de cuatro cosas se trata (escrowFundsKnowledge), incluido lo que la cadena ya había
// contestado y quedó escrito. Cuando no sabemos dónde están los USDC lo escribe con esas palabras,
// en vez de deducir un final del status.
//
// Exportado para test directo, mismo criterio que TrackView y Receipt.
export function HistoryView({
  items,
  onOpen,
  onBack,
}: {
  items: RemittanceState[];
  onOpen: (rem: RemittanceState) => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4">
      <Card className="space-y-2">
        <p className="text-sm font-semibold">Tus envíos</p>
        {/* De dónde sale esta lista, dicho antes de que la persona saque conclusiones de que esté vacía. */}
        <p className="text-xs text-stone">
          Son los envíos guardados en este dispositivo. Si borraste los datos del navegador o entrás
          desde otro, acá no van a aparecer aunque existan.
        </p>
      </Card>

      {items.length === 0 ? (
        <Card>
          <p className="text-sm text-stone">
            No encontramos envíos guardados para esta wallet en este dispositivo.
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {items.map((rem) => (
            <HistoryEntry key={rem.id} rem={rem} onOpen={onOpen} />
          ))}
        </ul>
      )}

      <Button variant="outline" onClick={onBack}>
        Volver
      </Button>
    </div>
  );
}

function HistoryEntry({
  rem,
  onOpen,
}: {
  rem: RemittanceState;
  onOpen: (rem: RemittanceState) => void;
}) {
  const status = statusDisplay(rem.status);
  const knowledge = escrowFundsKnowledge(rem);
  // Una remesa que nunca autorizó un depósito no tiene nada que seguir: abrirla en el seguimiento
  // renderizaría la vista optimista ("tu chaski está en camino", pasos en gris) sobre un envío que
  // no llegó a existir. Se lista igual, porque es historia de la persona, pero sin esa puerta.
  const openable = knowledge !== "no-deposit";
  return (
    <li>
      <Card className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{rem.beneficiary.name}</p>
            <p className="tabular text-xs text-stone">
              {rem.sendUsd.format()} · {formatEntryDate(rem.createdAt)}
            </p>
          </div>
          <Pill tone={status.tone}>{status.label}</Pill>
        </div>
        <p className="text-xs text-stone">{escrowKnowledgeCopy(knowledge)}</p>
        {openable ? (
          <Button variant="outline" onClick={() => onOpen(rem)}>
            {rem.status === "settled" ? "Ver recibo" : "Ver seguimiento"}
          </Button>
        ) : null}
      </Card>
    </li>
  );
}

/** Fecha corta de la entrada. Un `createdAt` implanteable NO se disfraza de fecha: se dice que no la hay. */
function formatEntryDate(createdAt: string): string {
  const t = Date.parse(createdAt);
  return Number.isNaN(t) ? "sin fecha" : new Date(t).toLocaleDateString("es-PE");
}

// El recibo. Antes afirmaba tres cosas que no sabía: el estado ("Entregado" HARDCODEADO), el monto
// (el cotizado presentado como recibido cuando nadie confirmó cuánto llegó) y la referencia (un uuid
// local). Y no mostraba `principalTx`, que es el ÚNICO dato del flujo verificado on-chain.
// Exportado para test directo, mismo criterio que TrackView: la única forma de probar que el recibo
// no afirma MÁS de lo que dice el estado es renderizarlo con un estado que diga menos.
export function Receipt({ rem, onNew }: { rem: RemittanceState; onNew: () => void }) {
  const { amount, confirmed } = deliveredDisplay(rem);
  const status = statusDisplay(rem.status);
  return (
    <div className="space-y-4">
      <Card className="text-center">
        <div
          className={cn(
            "mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full",
            confirmed ? "bg-verde-bg" : "bg-sand",
          )}
        >
          {confirmed ? (
            <Check className="h-7 w-7 text-verde" />
          ) : (
            <Clock3 className="h-7 w-7 text-stone" />
          )}
        </div>
        {/* "recibió" SÓLO con un monto entregado confirmado. Si no, se dice qué es el número. */}
        <p className="text-sm text-stone">
          {rem.beneficiary.name} {confirmed ? "recibió" : "tiene que recibir"}
        </p>
        <p className={cn("tabular text-4xl font-extrabold", confirmed ? "text-verde" : "text-ink")}>
          {amount ? amount.format() : "—"}
        </p>
        <p className="mt-1 text-xs text-stone">en su {methodLabel(rem.beneficiary.method)}</p>
        {confirmed ? null : (
          <p className="mx-auto mt-2 max-w-xs text-xs text-stone">
            Es el monto cotizado. Todavía no tenemos confirmación de cuánto llegó.
          </p>
        )}
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
        <Row label="Estado" value={<Pill tone={status.tone}>{status.label}</Pill>} />
        {/* El único dato de esta pantalla que alguien verificó contra la cadena. */}
        {rem.principalTx ? (
          <Row label="Depósito en Solana" value={shortTx(rem.principalTx)} />
        ) : null}
        {rem.refundTx ? <Row label="Reembolso" value={shortTx(rem.refundTx)} /> : null}
        <Row label="Referencia" value={rem.id.slice(0, 8)} />
      </Card>
      <Button variant="outline" onClick={onNew}>
        Enviar otra
      </Button>
    </div>
  );
}

/** Firma base58 acortada para la UI (el valor entero no entra en una fila y nadie lo lee completo). */
function shortTx(tx: string): string {
  return tx.length <= 16 ? tx : `${tx.slice(0, 8)}…${tx.slice(-8)}`;
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
