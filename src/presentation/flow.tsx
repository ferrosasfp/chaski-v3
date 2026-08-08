"use client";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  Check,
  Clock3,
  ExternalLink,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KycVerification,
  OfferedPayoutMethod,
  PayoutMethod,
  Quote,
  RemittanceState,
} from "../domain/remittance";
import {
  MIN_SEND_USD,
  OFFERED_PAYOUT_METHODS,
  Remittance,
  TERMINAL_STATUSES,
  cciDigits,
  isValidCci,
} from "../domain/remittance"; // WKH-187: rehydrate/isQuoteStillValid en el resume (CD-11) · WKH-314: mínimo enviable
import { createContainer, type Container } from "../composition/container";
import {
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
  SOLANA_SENDER_SOL_INSUFFICIENT,
  SOLANA_SETTLE_LEDGER_UNAVAILABLE,
  WALLET_ADDRESS_UNAVAILABLE,
} from "../application/use-cases/confirm-and-send";
import { ESCROW_REFUNDED_BY_SENDER } from "../application/use-cases/recover-escrow-funds";
import {
  PREPARE_NO_AGENT_FOR_CAPABILITY,
  isPrepareRejection,
} from "../application/agent-rejections"; // hallazgo #75: rechazo del agente ≠ payout fallido
import { resolveSolanaNetworkConfig } from "../infrastructure/chain"; // HU-SOL-13: cluster Solana activo (env-driven)
import type {
  CloseableEscrow,
  EscrowRefundConfirmation,
  KycVerdictLookup,
  WalletPossessionProof,
} from "../application/ports";
import {
  CUSTODY_WINDOW_SECS, // la MISMA constante que fija el deadline del depósito
  MAX_CLOSEABLE_CANDIDATES, // la MISMA constante que sondea el descubrimiento de cerrables
  MAX_RECOVERY_CANDIDATES, // la MISMA constante que sondea el fallback de recuperación
} from "../infrastructure/solana-wallet";
import {
  deliveredDisplay,
  escrowFundsAtRisk,
  escrowFundsKnowledge,
  escrowKnowledgeCopy,
  escrowCloseError,
  escrowCloseSentCopy,
  escrowRefundError,
  escrowRentDiscoveryEmpty,
  escrowRentDiscoveryError,
  escrowRentExplainer,
  type FlowError,
  humanError,
  isDemoMode,
  isKycDemo,
  kycOriginNotice,
  lostEscrowRecoveryError,
  shortErrorCode,
  statusDisplay,
} from "./flow-vm";
import { cn } from "./cn";
import { phantomBrowseUrl, useWalletAvailability } from "./wallet-availability"; // el aviso de "acá no hay wallet" (NoWalletHere)
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

/**
 * Cómo se anuncia cada método QUE SE OFRECE. El `Record` sobre `OfferedPayoutMethod` (y no sobre
 * `PayoutMethod`) es el que sostiene la regla: agregar `"yape"` a `OFFERED_PAYOUT_METHODS` sin
 * poder pagarle a nadie por Yape deja este mapa incompleto y el build no compila. La pantalla
 * ofrecía tres botones y dos de esos carriles no existen en ninguna parte del sistema.
 */
const OFFERED_METHOD_COPY: Record<OfferedPayoutMethod, string> = {
  bank_cci: "Depósito a su cuenta bancaria en Perú",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * El sello del modo demo. Decía "Modo demo (sin dinero real)" y esa segunda mitad es falsa acá mismo:
 * la tarjeta del desembolso (`PayoutInProgress`) dice, dos pantallas más adelante, que "el depósito en
 * la cadena sí es real". Los USDC del escrow son tokens reales que se ven en el explorador; lo
 * simulado son los pasos que no llegan a un partner de verdad.
 *
 * El texto nuevo dice lo que `isDemoMode` mide (alguno de los tres pasos, cotización / verificación /
 * desembolso, no está confirmado como real) y ni un gramo más. UNA sola constante para los dos lugares
 * que lo muestran: eran dos literales idénticos y nada impedía que uno se corrigiera y el otro no.
 */
const DEMO_PILL = "Modo demo (con pasos simulados)";

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
  const [error, setError] = useState<FlowError | null>(null);

  // form
  const [amount, setAmount] = useState("400");
  const [recipient, setRecipient] = useState("");
  // El método de desembolso dejó de ser una elección: se ofrece uno solo (OFFERED_PAYOUT_METHODS),
  // así que no hay nada que guardar en estado. Era `useState("yape")`, o sea que el valor por
  // defecto de toda remesa nueva era el único carril por el que este sistema no puede pagar.
  const method: OfferedPayoutMethod = OFFERED_PAYOUT_METHODS[0];
  const [destination, setDestination] = useState("");
  const [scanStage, setScanStage] = useState(0); // 0 idle · 1-3 escaneando · 4 verificado

  // state
  const [preview, setPreview] = useState<Quote | null>(null);
  const [rem, setRem] = useState<RemittanceState | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  // WKH-333: el veredicto de KYC que el servidor ya contestó al conectar. NO es un guard: sólo decide
  // si se gasta un cupo de Didit (el guard del dinero es `prepare`, server-side).
  const [serverVerdict, setServerVerdict] = useState<KycVerdictLookup | undefined>(undefined);
  // La prueba de posesión que se firmó al conectar. Viaja hasta la creación de la sesión de Didit
  // (WKH-333/R-1) para que no haga falta un SEGUNDO prompt de billetera por el mismo motivo.
  const [kycProof, setKycProof] = useState<WalletPossessionProof | undefined>(undefined);
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
    // `method` ya no está en las deps porque dejó de ser estado: mientras se ofrezca un solo método
    // su valor es el mismo en todos los renders. Si vuelve a haber elección, vuelve a la lista.
  }, [amountNum, c]);

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
          setError({ message: "La verificación no pasó. Probá de nuevo." });
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
      setError(
        e instanceof Error
          ? { message: humanError(e.message), code: shortErrorCode(e.message) }
          : { message: "Algo salió mal" },
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const onSend = () =>
    guard(async () => {
      const r = await c.createRemittance.execute({
        amountUsd: amountNum,
        // `cciDigits` y no el crudo: los espacios y los guiones son del papel del banco, no del
        // número. Se guarda lo que el partner necesita, y así el recibo muestra lo mismo que viajó.
        beneficiary: { name: recipient, country: "PE", method, destination: cciDigits(destination) },
      });
      setRem(r.snapshot);
      setScanStage(0);
      setRateUpdated(false); // WKH-187: flujo nuevo, sin indicador de re-cotización heredado
      setStep("connect");
    });

  const onConnect = () =>
    guard(async () => {
      if (!rem) return;
      const {
        address: addr,
        rememberedKyc,
        serverVerdict,
        kycProof: proof,
      } = await c.connectWallet.execute();
      setAddress(addr);
      // WKH-333/AC-20: el veredicto server-side lo resolvió `ConnectWallet`, que es el único momento
      // que corre en TODOS los caminos. Se guarda para pasárselo a `startKyc` sin pedir una segunda
      // firma de billetera.
      setServerVerdict(serverVerdict);
      setKycProof(proof);
      // WKH-187/CD-12: cotizá SIEMPRE apenas conecta (created→quoted), ANTES de cualquier KYC.
      // El quote queda visible en el paso `review` pre-KYC (AC-1).
      const locked = await c.lockQuote.execute({ remittanceId: rem.id });
      setRem(locked.snapshot);
      // 🔴 AR/BLQ-MED-1 — si el servidor CONTESTÓ que no hay veredicto utilizable, el atajo KYC-once
      // no se toma. `StartKyc` tiene el mismo guard y es el que vale (defensa en profundidad); acá se
      // repite por una razón concreta y medible: si se llamara igual, `StartKyc` devolvería
      // `redirect` y esta función descarta la URL (mirá el `else` de abajo) ⇒ se crearía una sesión
      // de Didit que nadie usa, y la pantalla de verificación crearía una SEGUNDA. Un cupo del tier
      // gratuito por cada persona en esta situación, que es justo lo que la HU vino a ahorrar.
      const servidorDiceQueNoHayFila = serverVerdict?.outcome === "absent";
      if (
        !servidorDiceQueNoHayFila &&
        rememberedKyc &&
        rememberedKyc.approved &&
        rememberedKyc.payoutAllowed
      ) {
        // KYC-once: esta wallet ya está verificada → salta review+verify, directo a confirmar (AC-4).
        // ⚠️ Va la variable LOCAL, no el estado: `setServerVerdict` de arriba no se ve dentro de este
        // mismo closure (React no actualiza el estado de forma sincrónica). Leer `serverVerdict` acá
        // daría siempre `undefined` y el salteo nunca ocurriría.
        const res = await c.startKyc.execute({
          remittanceId: rem.id,
          address: addr,
          serverVerdict,
          kycProof: proof,
        });
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
  // Quién es el dueño de lo que se va a listar o recuperar. Con la wallet ya conectada (autoConnect)
  // `connect()` no abre ningún modal: lee el estado del bridge y devuelve la misma address.
  //
  // La recuperación de un envío perdido la necesita por un motivo distinto al del historial: el
  // endpoint del store durable exige una prueba de posesión FIRMADA POR ESA address, así que sin
  // wallet conectada no hay a quién preguntarle.
  const resolveSender = useCallback(async () => {
    const addr = address ?? (await c.connectWallet.execute()).address;
    setAddress(addr);
    return addr;
  }, [address, c]);

  const openHistory = () =>
    guard(async () => {
      const addr = await resolveSender();
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
        // Acá SÍ el estado: este handler corre en otro evento, así que el valor que `onConnect`
        // guardó ya está commiteado. Es el mismo veredicto, no una segunda consulta ni una segunda
        // firma de billetera.
        serverVerdict,
        kycProof,
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
        setError({ message: "No pudimos verificar tu identidad. Intentá de nuevo." });
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
  // El destino ya no es "cualquier cosa no vacía". Ese control alcanzaba cuando la pantalla también
  // ofrecía Yape y Plin, donde un celular de 9 dígitos era un destino legítimo. Ahora el único
  // carril es el depósito bancario: un CCI que no tiene 20 dígitos no es un CCI, y dejarlo pasar
  // termina en una persona que depositó USDC contra una cuenta que no existe.
  const canSend =
    amountNum >= MIN_SEND_USD && Boolean(recipient.trim()) && isValidCci(destination);

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
          <Pill tone="warn">{DEMO_PILL}</Pill>
        </div>
      ) : null}

      {resuming ? (
        <Card className="mt-2 flex-1 space-y-4 text-center">
          <Loader2 className="mx-auto mt-6 h-8 w-8 animate-spin text-cochineal" />
          <div>
            <p className="text-base font-bold">Verificando tu identidad…</p>
            {/* "con Didit" se cayó: con `DIDIT_ENV=mock` la persona vuelve de `/kyc-simulado`, que es
                una página nuestra, y este overlay le decía que estábamos hablando con un proveedor que
                nadie llamó. Esta pantalla no puede distinguir las dos configuraciones (el navegador no
                ve `DIDIT_ENV`), así que dice lo que vale en las dos. */}
            <p className="mx-auto mt-1 max-w-xs text-sm text-stone">
              Estamos confirmando tu verificación. Un segundo.
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
                {/* "la comisión se lleva todo y tu familia no recibiría nada" tenía un input que la
                    falsifica: con $4 (por debajo del mínimo de $5) y una comisión de medio dólar
                    quedan $3,50 y la familia recibiría unos S/13, no nada. La aritmética sólo da cero
                    bien abajo del mínimo, y la pantalla la afirmaba para todo el rango. Lo que sí es
                    cierto en todo el rango es lo que hace el efecto de arriba: por debajo del mínimo
                    no se pide cotización. */}
                {belowMinimum ? (
                  <p className="mt-2 text-xs font-medium text-cochineal" role="alert">
                    El mínimo para enviar es ${MIN_SEND_USD}. Por debajo de eso no cotizamos el
                    envío.
                  </p>
                ) : null}
                <div className="mt-4 rounded-xl bg-verde-bg px-4 py-3">
                  <p className="text-xs font-medium text-verde/80">Tu familia recibe</p>
                  <p className="tabular text-2xl font-extrabold text-verde">
                    {preview ? preview.receive.format() : "—"}
                  </p>
                  {/* "llega en ~N min" prometía una entrega que este sistema no puede cumplir hoy: la
                      release del vault la dispara una persona a mano y la propia pantalla de
                      seguimiento avisa que "puede quedarse acá un buen rato". El número no se borra
                      (es un dato del corredor y sirve para comparar), se le pone dueño: lo estima él,
                      no lo promete Chaski. Mismo criterio en las filas de review y confirm. */}
                  {preview ? (
                    <p className="mt-0.5 text-xs text-verde/70">
                      1 USD ≈ S/ {preview.rate.toFixed(3)} · el corredor estima ~{preview.etaMinutes}{" "}
                      min
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
                {/* Era un selector de tres botones (Yape · Plin · Banco) y dos de esos carriles no
                    existen: no hay integración de pago por Yape ni por Plin en ninguna capa, así
                    que elegirlos llevaba a una remesa que nadie podía desembolsar. Con una sola
                    opción un selector tampoco corresponde: un botón que ya está elegido y no se
                    puede des-elegir sigue diciendo "acá hay una decisión tuya". Se reemplaza por
                    la afirmación de lo que pasa, que es lo único que la pantalla puede sostener. */}
                <div>
                  <span className="mb-1.5 block text-sm font-medium text-stone">¿Cómo recibe?</span>
                  {OFFERED_PAYOUT_METHODS.map((m) => (
                    <p
                      key={m}
                      className="rounded-xl border border-line bg-sand px-3.5 py-2.5 text-sm font-semibold text-ink"
                    >
                      {OFFERED_METHOD_COPY[m]}
                    </p>
                  ))}
                  <p className="mt-1.5 text-xs text-stone">
                    Chaski no manda a Yape ni a Plin. Deposita a una cuenta bancaria.
                  </p>
                </div>
                <Field label="CCI de su cuenta">
                  <TextInput
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    placeholder="002 193 004455667788 99"
                    inputMode="numeric"
                  />
                </Field>
                {/* El aviso aparece recién cuando hay algo escrito: en blanco no hay error todavía,
                    hay un campo sin empezar. Cuenta los dígitos en vez de decir "inválido" porque
                    el error típico es pegar el número de cuenta (que no es el CCI) o un celular. */}
                {destination.trim() && !isValidCci(destination) ? (
                  <p className="text-xs font-medium text-cochineal-ink">
                    Un CCI tiene 20 dígitos y este tiene {cciDigits(destination).length}. Los
                    espacios y los guiones no cuentan.
                  </p>
                ) : null}
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

              {/* La otra puerta, y la que no existía: la lista de arriba sale del almacenamiento de
                  ESTE navegador. Si se borró, o si la persona entra desde otro dispositivo, ahí no
                  hay nada y sus USDC pueden seguir en el vault. */}
              <LostEscrowRecovery refund={c.solanaRefund} resolveSender={resolveSender} />
              {/* WKH-327/AC-8 — la otra pregunta a la misma cadena: qué envíos TERMINADOS siguen con
                  sus cuentas abiertas. Va al lado y NO adentro de la puerta de arriba: aquélla promete
                  encontrar escrows ABIERTOS, y un escrow terminal no está abierto. */}
              <EscrowRentRecovery
                lister={c.solanaCloseableEscrows}
                close={c.closeEscrowAccounts}
                resolveSender={resolveSender}
              />
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
                  {/* "Chaski nunca toca tu plata" es un absoluto y hay quien lo falsifica: el escrow
                      tiene una release-authority, operada por el equipo, que puede liberar el vault
                      hacia el pago (ver `confirm-and-send.ts`:191-197). Lo que sí es verificable, y es
                      lo que hace a esto no custodial, es DÓNDE quedan los USDC: en una cuenta del
                      contrato (ATA de la PDA `escrow_state`, `solana-wallet.ts`:288), nunca en una
                      billetera de Chaski. */}
                  <p className="mx-auto mt-1 max-w-xs text-sm text-stone">
                    Firmás el envío desde tu billetera con USDC. Tus USDC van a un contrato en
                    Solana, no a una cuenta de Chaski.
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
              <NoWalletHere />
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
                {/* TRES frases se cayeron acá, y la tercera es de la misma familia que las dos
                    primeras. Las dos primeras, del barrido anterior:
                    · "Lo hace Didit, un verificador certificado": con `DIDIT_ENV=mock` no lo hace
                      Didit, lo hace `/kyc-simulado`, que es una página nuestra que no verifica nada. Y
                      esta pantalla no puede distinguir las dos configuraciones, porque el navegador no
                      ve `DIDIT_ENV` y todavía no existe ninguna decisión con `provenance`.
                    · "Tus datos no se comparten": sin decir con quién, no hay forma de falsearla ni de
                      cumplirla, y además es falsa en el único sentido literal (el documento y la
                      selfie van al verificador; ese es el punto). Lo que sí está probado es el límite
                      concreto: el body que sale hacia los agentes no lleva `kyc` ni `identity`
                      (`a2a/gateway-client.test.ts`, T-A6.1). Eso es lo que dice ahora.
                    · "Escaneás tu DNI y te sacás una selfie": la que quedó, y la única que describía
                      una ACCIÓN FÍSICA. Con `DIDIT_ENV=mock` la persona aterriza en `/kyc-simulado`,
                      que no pide ni un dato y lo dice con todas las letras. Medido contra producción
                      el 2026-08-05: `POST /api/kyc/session` devuelve un `url` que apunta a
                      `/kyc-simulado`, o sea que ésa ES la configuración con la que se recorre la demo.
                      Se borra, con el mismo criterio que las dos vecinas: la pantalla no puede
                      distinguir las dos configuraciones, así que dice sólo lo que vale en las dos. Lo
                      que la persona va a tener que hacer lo decide el verificador, y este componente
                      no sabe cuál está configurado. */}
                <p className="text-sm text-stone">
                  Por ley, verificamos tu identidad <b>una sola vez</b>. Tu documento y tu selfie no
                  se comparten con los agentes que cotizan y pagan.
                </p>
                {/* LA CUARTA DE LA MISMA FAMILIA, y la que sobrevivió al barrido de arriba porque no
                    era una frase. Acá había `IdCard → ArrowRight → ScanFace`: documento, flecha, cara
                    escaneada. Es la MISMA promesa que se borró del párrafo y del botón ("escaneás tu
                    DNI y te sacás una selfie"), dibujada en vez de escrita, y en el elemento más
                    grande del recuadro. Con `DIDIT_ENV=mock` la persona aterriza en `/kyc-simulado`,
                    que no le pide ni un dato: nadie escanea nada, y esa es la configuración con la
                    que se recorre la demo hoy.
                    Y NO se arregla mostrando un dibujo por modo: `DIDIT_ENV` se lee server-side y no
                    tiene variante `NEXT_PUBLIC_` (`didit-env.ts:66`), así que este componente no sabe
                    qué verificador está configurado — el mismo límite que ya está anotado para las
                    frases vecinas. Queda un ícono que vale en las dos configuraciones: el escudo de
                    "verificación", el mismo del título de la tarjeta y del botón que la arranca. No
                    afirma ninguna acción física, y no cierra la puerta a mostrar el escaneo el día
                    que exista una señal client-visible del modo (eso sería otra HU, no ésta).
                    El `data-testid` es el ancla del test que mata este defecto
                    (`honest-copy.test.tsx`, "el recuadro del paso verify no dibuja el escaneo"). */}
                {scanStage === 0 ? (
                  <div
                    data-testid="verify-idle-icon"
                    className="flex items-center justify-center rounded-xl border border-dashed border-line bg-sand/60 py-7"
                  >
                    <ShieldCheck className="h-8 w-8 text-stone" />
                  </div>
                ) : (
                  <VerificationProgress approved={scanStage >= 4} />
                )}
              </Card>
              <Button disabled={busy} onClick={onVerify}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    {/* La MISMA promesa que la frase de arriba, y en el elemento más grande de la
                        pantalla: "Escanear DNI + selfie" describe una acción física que con el
                        verificador simulado no ocurre. Lo que este botón hace en las dos
                        configuraciones es arrancar la verificación, y eso es lo que dice. */}
                    <ShieldCheck className="h-4 w-4" /> Verificar mi identidad
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
                <Row label="Estimado del corredor" value={`~${rem.quote.etaMinutes} min`} />
                <div className="my-2 h-px bg-line" />
                <Row label="Recibe en" value={`${methodLabel(rem.beneficiary.method)} · ${rem.beneficiary.destination}`} />
              </Card>
              <AgentPlanCard />
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
                <Row label="Estimado del corredor" value={`~${rem.quote.etaMinutes} min`} />
                <div className="my-2 h-px bg-line" />
                <Row label="Recibe en" value={`${methodLabel(rem.beneficiary.method)} · ${rem.beneficiary.destination}`} />
              </Card>
              {rem.kyc ? <IdentityBadge kyc={rem.kyc} /> : null}
              {/* 🔴 TAMBIÉN ACÁ, Y NO ES DUPLICACIÓN. La tarjeta vivía sólo en `review`, y `review`
                  es la pantalla que el flujo SALTEA cuando el KYC ya está hecho: con la identidad
                  recordada se va de `connect` directo a `confirm`. O sea que el preview existía y la
                  persona que ya se verificó una vez NO lo veía nunca, que es justamente la que más
                  veces va a usar la app. Lo encontró el founder recorriéndola, no un test.
                  Va en las DOS pantallas donde se aprueba, porque las dos son "el último momento
                  antes de comprometerse" según por dónde hayas entrado. */}
              <AgentPlanCard />
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
              closeEscrow={c.closeEscrowAccounts}
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
          {error.message}
          {error.code ? (
            <span className="mt-1 block break-all font-mono text-[11px] opacity-60">
              {error.code}
            </span>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

/**
 * Lo que pasa mientras la verificación arranca, dicho como lo que es.
 *
 * 🔴 ACÁ HABÍA UNA BARRA DE PROGRESO INVENTADA, y de dos maneras a la vez. `SCAN_STEPS` listaba tres
 * etapas ("Escaneando tu documento" / "Verificando tu rostro (selfie)" / "Revisando listas de
 * seguridad (AML)") que se pintaban una tras otra.
 *
 * 1. Las etapas 2 y 3 NO EXISTEN. `setScanStage` sólo se llama con 0, 1 y 4 en todo este archivo, así
 *    que la segunda y la tercera fila nunca se prendían: se quedaban grises para siempre y saltaban
 *    directo a un tilde verde. Nadie las midió porque nadie las testeaba.
 * 2. Entre la etapa 1 y la 4 lo único que ocurre es UNA llamada a `startKyc`. Con `DIDIT_ENV=mock`
 *    (la configuración de producción, medida el 2026-08-05: la sesión resuelve a `/kyc-simulado`)
 *    nadie escanea un documento, nadie mira una cara y nadie consulta una lista AML. La pantalla
 *    narraba tres pasos de un verificador que no se estaba ejecutando.
 *
 * Lo que queda es lo único que vale en las dos configuraciones: estamos esperando la respuesta, y
 * después sabemos si volvió aprobada. `approved` sale de `scanStage === 4`, que este archivo setea
 * SÓLO después de comprobar `snapshot.status === "kyc_passed"`. No dice "verificada": de eso se ocupa
 * `IdentityBadge` en la pantalla siguiente, que sí mira la proveniencia.
 */
function VerificationProgress({ approved }: { approved: boolean }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-sand/60 px-4 py-3.5">
      <span
        className={
          approved
            ? "flex h-5 w-5 items-center justify-center rounded-full bg-verde text-white"
            : "flex h-5 w-5 items-center justify-center rounded-full bg-cochineal text-white"
        }
      >
        {approved ? <Check className="h-3 w-3" /> : <Loader2 className="h-3 w-3 animate-spin" />}
      </span>
      <span className="text-sm font-medium text-ink">
        {approved ? "Tu verificación volvió aprobada" : "Preparando tu verificación"}
      </span>
    </div>
  );
}

/**
 * La tarjeta de identidad del paso `confirm`.
 *
 * 🔴 QUÉ ARREGLA. Esto era un solo bloque verde con un tilde que decía "Identidad verificada:" y los
 * datos al lado, SIEMPRE, pasara lo que pasara con la verificación. Con `DIDIT_ENV=mock` (la
 * configuración con la que se recorre la demo) la decisión llega con `provenance: "didit-mock"`, o sea
 * datos de una verificación que no existió, y la pantalla los presentaba como verificados. Peor: el
 * sello de "Modo demo" tampoco se prendía, porque `isDemoMode` sólo reconocía `local-fallback`. Quien
 * mirara esa pantalla veía una app dando por buena una identidad inventada, sin un solo aviso.
 *
 * QUÉ AFIRMA CADA RAMA. La verde afirma una verificación, y por eso exige que el origen esté en
 * `REAL_KYC_PROVENANCES` (comparación exacta, `Set.has`). La otra NO afirma que los datos sean falsos
 * ni que nadie los haya mirado: dice que no podemos llamarlos verificados y muestra el origen crudo,
 * que es lo que hace la frase falsable de un vistazo. Lo desconocido cae en la segunda: sobre-avisar
 * es el error gratis.
 *
 * Los DATOS se muestran en las dos ramas. Sacarlos escondería a quién está por enviar la persona, que
 * es el motivo por el que esta tarjeta existe. Lo que cambia es qué se afirma de ellos.
 */
function IdentityBadge({ kyc }: { kyc: KycVerification }) {
  const id = kyc.identity;
  if (!id) return null;
  const nombre = `${id.firstName} ${id.lastNamePaternal} ${id.lastNameMaternal}`;
  const documento = `${id.documentType} ••••${id.documentNumberLast4}`;
  if (isKycDemo(kyc.provenance)) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-stone/40 bg-sand/60 px-4 py-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-stone" />
        <p className="text-xs text-stone">
          Identidad sin verificar: <b>{nombre}</b> · {documento}. {kycOriginNotice(kyc.provenance)}
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-verde-bg px-4 py-2.5">
      <BadgeCheck className="h-4 w-4 shrink-0 text-verde" />
      <p className="text-xs text-verde/90">
        Identidad verificada: <b>{nombre}</b> · {documento}
      </p>
    </div>
  );
}

/**
 * El aviso que faltaba en la pantalla de conectar.
 *
 * QUÉ PASABA ANTES (medido, no supuesto, con la librería real en jsdom y user agent de Android sin
 * wallet inyectada): tocar "Conectar wallet" abre el selector de la librería, que lista Phantom aunque
 * su `readyState` sea `NotDetected`. Al tocar Phantom, `WalletProviderBase` sale en silencio porque el
 * readyState no es `Installed` ni `Loadable` (`WalletProviderBase.js`:166-172): no intenta conectar y
 * no emite ningún error. 150 ms después el selector se cierra solo y lo único que la persona lee es
 * "Se cerró el selector de wallet sin conectar", que le atribuye una acción que no hizo. El copy de
 * `no_wallet` (`flow-vm.ts:253`) NO aparece nunca por ese camino, porque nadie llega a tirar
 * `WalletNotReadyError`.
 *
 * QUÉ AFIRMA ESTE TEXTO Y QUÉ NO: sólo que en ESTE navegador no hay una wallet expuesta. No dice, y no
 * puede decir, si la persona tiene Phantom instalada: en el celular Phantom está instalada y no se
 * inyecta salvo adentro de su propio navegador, así que "no tenés Phantom" sería falso justo para
 * quien sí la tiene. Ver `SolanaWalletAvailability` en `solana-wallet-bridge.ts`.
 *
 * CON WALLET INYECTADA NO RENDERIZA NADA, y tampoco con "unknown": el escritorio con la extensión y el
 * celular DENTRO del navegador de Phantom quedan byte-idénticos a como estaban.
 */
function NoWalletHere() {
  const availability = useWalletAvailability();
  if (availability !== "none") return null;
  // Sólo se llega acá en el navegador (en el servidor la disponibilidad es "unknown"), pero el guard
  // deja el componente seguro de renderizar en cualquier contexto.
  const href = typeof window !== "undefined" ? window.location.href : "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <div className="space-y-3 rounded-xl2 border border-line bg-sand/60 p-4">
      <div className="flex items-center gap-2">
        <Smartphone className="h-4 w-4 text-cochineal" />
        <p className="text-sm font-bold">No vemos ninguna wallet en este navegador</p>
      </div>
      <p className="text-sm text-stone">
        Esto no dice si tenés una wallet instalada: dice que en este navegador no hay ninguna
        disponible.
      </p>
      <p className="text-sm text-stone">
        En el celular, Phantom solo se conecta desde su propio navegador. Si ya la tenés en este
        dispositivo, abrí Chaski adentro de Phantom.
      </p>
      <a
        href={phantomBrowseUrl(href, origin)}
        rel="noreferrer"
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-cochineal/30 bg-card px-4 text-[15px] font-semibold text-cochineal"
      >
        <ExternalLink className="h-4 w-4" /> Abrir Chaski en Phantom
      </a>
      <p className="text-xs text-stone">
        Si estás en una computadora, instalá la extensión de Phantom o Solflare y recargá la página.
      </p>
    </div>
  );
}

/**
 * Las dos frases que acompañan al botón cuando NO SABEMOS si el depósito entró. Se pide, y decide la
 * cadena.
 *
 * Viven en constantes y no en un literal por pantalla porque ahora las usan DOS estados distintos, y
 * por el mismo motivo: `payout_failed` con `PRINCIPAL_STATE_UNKNOWN` (perdimos la respuesta del settle
 * y la cadena tampoco contestó) y `confirmed` (la persona firmó y nadie registró el desenlace). La
 * duda es la misma y la salida es la misma. Dos literales idénticos es exactamente cómo uno se
 * corrige y el otro se queda viejo.
 */
const RECOVERY_ASK_WHEN_UNKNOWN =
  "Pedí que vuelvan con el botón de acá abajo: si están en el escrow, vuelven a tu wallet; si nunca salieron, no hay nada que devolver.";
const RECOVERY_NEEDS_WALLET = "Para recuperarlos, conectá la misma wallet con la que enviaste.";

const TRACK_STEPS: { key: RemittanceState["status"][]; label: string; manual?: boolean }[] = [
  { key: ["confirmed", "principal_in"], label: "Fondos en camino" },
  // "Pagando a tu familiar" decía más de lo que pasa: en payout_submitted la orden con el partner
  // está creada y los USDC siguen en el vault del escrow, esperando un release que hoy dispara una
  // persona a mano (ver confirm-and-send.ts:174-183). Nadie está pagando todavía.
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
  closeEscrow,
  sender,
  onRecovered,
}: {
  rem: RemittanceState;
  // El use-case, NO el gateway suelto: el gateway devuelve una signature y nada más, y de ahí salía
  // el bug de que un refund exitoso no dejaba rastro en el estado.
  recover?: Container["recoverEscrowFunds"];
  // WKH-327: el use-case del cierre, por la misma razón — acá vive el guard de AC-7 (que la billetera
  // conectada sea la que pagó el alquiler), y saltearlo pasando el gateway suelto lo dejaría afuera.
  closeEscrow?: Container["closeEscrowAccounts"];
  sender: string | null;
  onRecovered: (snapshot: RemittanceState) => void;
}) {
  // HU-SOL-13 (AC-6/AC-7, CD-10): acción refund trustless. Siempre disponible: ninguna configuración
  // la puede apagar.
  //
  // ESTA PANTALLA NO SABE CUÁNDO SE ABRE LA VENTANA, y decirlo es el arreglo. Hasta el 2026-08-01 el
  // deadline del escrow ERA `quote.expiresAt`, así que la UI lo usaba como proxy y acertaba. Ese día
  // el deadline pasó a ser `now + CUSTODY_WINDOW_SECS` (2 h) al construir el depósito, y la cotización
  // sigue venciendo a los 10 minutos: el proxy quedó adelantado casi dos horas. Habilitaba el botón
  // antes de tiempo y, peor, `RefundLockedNotice` renderizaba esa hora equivocada como un instante
  // concreto ("a partir de las 14:35"). Nadie perdía plata, pero la pantalla afirmaba en falso cuándo
  // alguien podía recuperar la suya.
  //
  // El instante real vive en la cuenta del escrow y esta capa no lo lee. Mientras no lo lea, la
  // respuesta honesta es no adivinarlo: se ofrece la acción y decide el guard AUTORITATIVO, que es la
  // lectura on-chain dentro de `wallet.refundEscrow` (aborta con `refund_before_deadline` si
  // `status≠Deposited` o `now<deadline`, ANTES de firmar y sin gastar comisión). Preguntarle a la
  // cadena es barato; inventar una hora no.
  //
  // Refundeable: el deposit puede haber entrado y aún no se recuperó/entregó (escrow potencialmente
  // Deposited on-chain).
  //
  // ⚠️ `confirmed` NO ESTABA ACÁ, y era el agujero: es el estado en el que la persona ya firmó la
  // autorización y nadie registró el desenlace (los hasta 15 s del timeout del settle más el
  // broadcast). El historial SÍ lo listaba y SÍ lo declaraba abrible, porque `escrowFundsKnowledge` lo
  // clasifica como `unverified` (`escrowFundsKnowledge`, `flow-vm.ts:206`): la persona leía "No comprobamos si tus USDC siguen
  // en el escrow", tocaba "Ver seguimiento", y aterrizaba en una pantalla sin ninguna acción. Sus USDC
  // pueden estar en el vault.
  const refundeable =
    rem.status === "confirmed" ||
    rem.status === "principal_in" ||
    rem.status === "payout_submitted" ||
    rem.status === "payout_failed";
  // 🔴 CR/BLQ-BAJO-1 — LA TARJETA SE CONTRADECÍA SOBRE LA PLATA DE LA PERSONA, Y ESTE ES EL TÉRMINO
  // QUE LO CIERRA. Con `prepare_no_agent_for_capability` el DOM de UNA misma tarjeta decía, en este
  // orden: *"No se movió ningún USDC de tu wallet"* → botón **"Recuperar fondos"** → *"El plazo se
  // fija cuando depositás y dura unas 2 horas"*. Las dos mitades no pueden ser ciertas a la vez: o no
  // hay depósito, o hay uno con un plazo corriendo.
  //
  // Se elige TAPAR EL BOTÓN y no suavizar el copy, porque de las dos afirmaciones la del copy es la
  // que se puede sostener: el prepare corre ANTES de `authorizePrincipal`
  // (`failAndRefund`, `../application/use-cases/confirm-and-send.ts:385`, con `"not_deposited"`), o sea antes de que la
  // billetera firme nada. Suavizarla a la forma condicional de la familia de `payout_failed` ("si tus
  // USDC entraron al escrow…") cambiaría un hecho verificable por una duda inventada, que es
  // exactamente el defecto que esta HU vino a sacar de la pantalla.
  //
  // ⚠️ Y NO SE APOYA EN EL `failureReason` A SECAS. El hecho lo afirma `escrowFundsKnowledge`, que es
  // la MISMA función con la que el historial decide qué decir de esa plata: así las dos pantallas no
  // pueden contar dos historias. Si algún día una remesa llega acá con este reason y un depósito que
  // no se puede descartar, este `&&` da `false` y la tarjeta vuelve entera a la familia de
  // `payout_failed` — copy condicional Y botón, que también es coherente. Lo que no puede volver a
  // pasar es la afirmación categórica al lado del botón.
  //
  // Se excluye de `showRefund` y NO de `refundeable`: la familia hermana (`prepareRejected`,
  // `senderSolMissing`, `walletAddressMissing`) queda intacta.
  const noAgentForCapability =
    rem.failureReason === PREPARE_NO_AGENT_FOR_CAPABILITY &&
    escrowFundsKnowledge(rem) === "no-deposit";
  const showRefund =
    refundeable && rem.refundTx == null && !!recover && !!sender && !noAgentForCapability;

  // WKH-327 — ¿se le ofrece cerrar las cuentas y recuperar el alquiler?
  //
  // ⚠️ ESTE GUARD ES DEFENSA EN PROFUNDIDAD, NO LA GARANTÍA. Escribirlo así importa: si alguien lo lee
  // como "la garantía", lo va a relajar el día que moleste. El guard AUTORITATIVO es la lectura
  // on-chain del paso 7 de `closeEscrow`, que aborta con `escrow_not_terminal` ANTES de firmar. Esta
  // capa NO lee la cadena — la misma disciplina que el comentario de acá arriba deja escrita para el
  // refund: esta pantalla no sabe el instante real, así que no lo adivina.
  //
  // AC-4 (client-side): sólo los DOS estados de la FSM que se corresponden con un escrow terminal en
  // cadena — `settled` con `Released` (el operador liberó al beneficiario) y `refunded` con `Refunded`
  // (la persona recuperó sus USDC). `payout_failed` NO va, y es el caso que hay que mirar dos veces: un
  // envío que falló puede tener el principal TODAVÍA adentro del escrow, o sea `Deposited`, que es
  // justo lo que `close` rechaza. Ofrecerlo ahí haría firmar una tx que la cadena revierte.
  //
  // AC-7 (client-side): no se ofrece sin `sender`, ni si la remesa tiene `ownerAddress` y NO coincide
  // con la billetera conectada. 🚫 La comparación es base58 ESTRICTO, nunca `.toLowerCase()` (CD-13):
  // base58 es case-sensitive y bajarlo a minúsculas fabrica colisiones entre addresses distintas.
  const closeableStatus = rem.status === "refunded" || rem.status === "settled";
  const senderOwnsIt = !!sender && (rem.ownerAddress == null || rem.ownerAddress === sender);
  const showClose = closeableStatus && senderOwnsIt && !!closeEscrow && !!sender;

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
    // Y el que ni siquiera es un fallo de entrega: nunca tuvimos la dirección de la wallet, así que el
    // corte fue antes de la primera llamada de red. Decirlo con las palabras de un payout fallido
    // ("si te cobramos, te reembolsamos") deja a la persona esperando un reembolso que no existe, en
    // vez de mandarla a lo único que lo arregla, que es reconectar la wallet.
    const walletAddressMissing = rem.failureReason === WALLET_ADDRESS_UNAVAILABLE;
    // Y el otro que tampoco es un fallo de entrega: la wallet no tenía el SOL del rent de las cuentas
    // del escrow, así que el corte fue antes del prepare y antes de la primera firma. Decirlo como "No
    // pudo entregarse. Si te cobramos, te reembolsamos" deja esperando un reembolso que no existe, por
    // una causa que se arregla cargando unos centavos de SOL.
    const senderSolMissing = rem.failureReason === SOLANA_SENDER_SOL_INSUFFICIENT;
    // Y el tercero que tampoco es un fallo de entrega: el agente de payout RECHAZÓ crear la orden.
    // El prepare corre antes de `authorizePrincipal` (confirm-and-send.ts:381-386), o sea antes de
    // que la wallet firme nada, así que "no se movió ningún USDC" es un hecho que se lee del orden
    // del use-case, no una promesa. Decirlo con las palabras de un payout fallido ("si te cobramos,
    // te reembolsamos") deja esperando un reembolso que no existe.
    const prepareRejected = isPrepareRejection(rem.failureReason);
    // Y el quinto, que es el que esta HU trajo y que NO es ninguno de los anteriores: NINGÚN agente
    // resolvió la capacidad de desembolso, o sea que no hubo agente que rechazara nada.
    //
    // 🔴 POR QUÉ TIENE SU PROPIA RAMA Y NO ENTRA EN `isPrepareRejection` (AR/BLQ-ALTO-1). Sin esto,
    // el enum caía al `else` de abajo, o sea a `humanError("payout_failed")`: "No se pudo entregar…
    // si tus USDC entraron al escrow, los sacás vos firmando desde tu wallet". Esa frase manda a
    // buscar plata a un lugar donde no hay plata — el corte ocurre en el prepare, ANTES de
    // `authorizePrincipal` (`confirm-and-send.ts`:384-388), o sea antes de que la billetera firme
    // nada. Es la misma clase de defecto que WKH-333 dejó documentada para `flow-vm.ts`:701-707.
    // Y tampoco puede entrar a la familia de `prepareRejected`, porque ese copy afirma "El agente de
    // pagos rechazó esta remesa": acá no hubo agente al que atribuirle un acto.
    //
    // El cuerpo sale de `humanError`, no de un literal, para que la frase viva en UN solo lugar
    // (mismo patrón que `senderSolMissing` de acá arriba).
    //
    // ⚠️ `noAgentForCapability` SE CALCULA ARRIBA, junto a `showRefund` (CR/BLQ-BAJO-1): el mismo
    // término que habilita este copy es el que tapa el botón de recuperar, y por eso no puede vivir
    // acá abajo. Leé ahí por qué además exige `escrowFundsKnowledge(rem) === "no-deposit"`.
    // Y el cuarto que tampoco es un fallo de entrega: nuestro servidor no pudo consultar el registro
    // de direcciones preparadas y cortó ANTES de reenviar la transacción al facilitator
    // (route.ts:126-133, antes del fetch de la 156). Hasta que este reason existió, esta causa salía
    // por el PEOR camino de todos: el use-case la mandaba a preguntarle a la cadena, la cadena no
    // encontraba una cuenta que nunca se creó, y la pantalla decía "No sabemos todavía si te
    // cobramos". Dudar en voz alta sobre la plata de alguien cuando el código tiene la certeza es
    // más caro que un diagnóstico pobre: manda a buscar unos USDC que nunca se movieron.
    const settleLedgerUnavailable = rem.failureReason === SOLANA_SETTLE_LEDGER_UNAVAILABLE;
    // ¿Hay una salida a la vista? Si no la hay, el texto no puede mandar a apretar un botón que no
    // está. Ya no hay un segundo estado "esperando el deadline": esta capa no sabe cuándo vence, así
    // que o se ofrece la acción o no hay ninguna.
    const recoveryOffered = showRefund;
    return (
      <Card className="space-y-3">
        <p className="text-sm font-semibold">
          {recoveredBySender
            ? "Recuperaste tus fondos"
            : senderSolMissing
              ? "Te falta SOL en la wallet"
              : walletAddressMissing
              ? "Reconectá tu wallet"
              : prepareRejected
                ? "No pudimos preparar el envío"
                : noAgentForCapability
                ? "No hay quién entregue este envío"
                : settleLedgerUnavailable
                ? "No llegamos a enviar tu depósito"
                : principalUnknown
                ? "No sabemos todavía si te cobramos"
                : principalInEscrow
                  ? "Tus USDC quedaron en el escrow"
                  : "No pudo entregarse"}
        </p>
        <p className="text-sm text-stone">
          {recoveredBySender
            ? "Los USDC volvieron a tu wallet. Esta remesa no se entregó."
            : senderSolMissing
              ? humanError(SOLANA_SENDER_SOL_INSUFFICIENT)
              : walletAddressMissing
              ? humanError(WALLET_ADDRESS_UNAVAILABLE)
              : prepareRejected
                ? "El agente de pagos rechazó esta remesa antes de que firmaras nada: no se movió ningún USDC de tu wallet. Empezá de nuevo con una cotización fresca."
                : noAgentForCapability
                ? humanError(PREPARE_NO_AGENT_FOR_CAPABILITY)
                : settleLedgerUnavailable
                ? humanError(SOLANA_SETTLE_LEDGER_UNAVAILABLE)
                : principalUnknown
                ? "Se cortó la comunicación mientras enviábamos tu depósito, y la cadena tampoco nos contestó. Puede que tus USDC estén en el escrow o que nunca hayan salido de tu wallet: todavía no lo sabemos. Nadie te reembolsó nada."
                : principalInEscrow
                  ? "Tu depósito entró al escrow y el envío no siguió. Los USDC siguen ahí, a tu nombre. Nadie te los reembolsó: los recuperás vos, firmando desde tu wallet."
                  : humanError("payout_failed")}
        </p>
        {(principalUnknown || principalInEscrow) && recoveryOffered ? (
          <p className="text-sm text-stone">{RECOVERY_ASK_WHEN_UNKNOWN}</p>
        ) : null}
        {(principalUnknown || principalInEscrow) && !recoveryOffered ? (
          <p className="text-sm text-stone">{RECOVERY_NEEDS_WALLET}</p>
        ) : null}
        {/* Sólo se muestra un comprobante que EXISTE. El adapter ledger-only devuelve null y esta
            línea no se renderiza: un identificador fabricado al lado de la palabra reembolso es peor
            que no decir nada. */}
        {rem.refundTx ? (
          <p className="text-xs text-stone">Referencia de reembolso: {rem.refundTx}</p>
        ) : null}
        {showRefund && recover && sender ? (
          <div className="space-y-2">
            <RefundAction
              remittanceId={rem.id}
              sender={sender}
              recover={recover}
              onRecovered={onRecovered}
            />
            <RefundWindowNote />
          </div>
        ) : null}
        {/* WKH-327: acá la app ya sabe que hay un escrow de esta persona, así que cubre el caso
            "acabo de recuperar mis fondos y ahora cierro las cuentas" sin ningún descubrimiento. */}
        {showClose && closeEscrow && sender ? (
          <CloseEscrowAction remittanceId={rem.id} sender={sender} close={closeEscrow} explainer="own" />
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
  // `confirmed` = firmamos la autorización del depósito y nunca registramos el desenlace. Es la MISMA
  // duda que `PRINCIPAL_STATE_UNKNOWN` unas líneas más arriba, así que se dice con las MISMAS frases:
  // qué sabemos (la del historial, derivada de `escrowFundsKnowledge`, para que las dos pantallas no
  // cuenten dos historias) y qué se puede hacer.
  const depositUnknown = rem.status === "confirmed";
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
      {waitingOnPerson ? <PayoutInProgress rem={rem} /> : null}
      {depositUnknown ? (
        <div className="space-y-1">
          <p className="text-sm text-stone">{escrowKnowledgeCopy(escrowFundsKnowledge(rem))}</p>
          <p className="text-sm text-stone">
            {showRefund ? RECOVERY_ASK_WHEN_UNKNOWN : RECOVERY_NEEDS_WALLET}
          </p>
        </div>
      ) : null}
      {showRefund && recover && sender ? (
        <div className="space-y-2">
          <RefundAction
            remittanceId={rem.id}
            sender={sender}
            recover={recover}
            onRecovered={onRecovered}
          />
          <RefundWindowNote />
        </div>
      ) : null}
      {/* WKH-327 — ver el comentario del otro punto de montaje. */}
      {showClose && closeEscrow && sender ? (
        <CloseEscrowAction remittanceId={rem.id} sender={sender} close={closeEscrow} explainer="own" />
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
      {sent ? <RefundSentNotice confirmation={sent.confirmation} refundTx={sent.refundTx} /> : null}
      {err ? <p className="text-xs text-cochineal-ink">{err}</p> : null}
    </div>
  );
}

// WKH-327 — "Cerrar y recuperar": cierra las dos cuentas que el depósito dejó abiertas para que vuelva
// el alquiler que la persona pagó. El SENDER firma y paga el fee (es SU alquiler).
//
// DIFERENCIA CONTRA `RefundAction`, y es deliberada: esto NO llama a `onRecovered` ni escribe estado.
// No hay estado que escribir (AC-10) — "estas cuentas ya están cerradas" se lee de la AUSENCIA de
// `escrow_state` en cadena, no de la FSM, así que agregarle un campo a la remesa sería inventar una
// segunda fuente de verdad que se puede desincronizar de la única que manda.
//
// El desenlace NO confirmado es efímero, igual que en `RefundAction` y por la misma razón: afirmaría
// un final que nadie verificó. En `confirmed` muestra el copy de éxito y deja de ofrecer el botón.
//
// 🔴 `explainer` ES OBLIGATORIO Y NO UN BOOLEANO CON DEFAULT (fix-pack CR/MNR-1). Este componente
// montaba el bloque explicativo SIEMPRE, y la puerta de descubrimiento lo monta una vez arriba y
// después mapea un `CloseEscrowAction` por cerrable: el mismo párrafo de cuatro líneas aparecía N+1
// veces (medido: 4 con 3 cerrables; con el tope de 20, 21 veces). Ningún test lo veía porque todos
// usaban listas de 0 o 1 elemento y `toContain`, que es insensible a la multiplicidad.
// Un default habría dejado el N+1 exactamente donde estaba para el próximo call-site en lista.
export function CloseEscrowAction({
  remittanceId,
  sender,
  close,
  explainer: explainerMode,
}: {
  remittanceId: string;
  sender: string;
  close: NonNullable<Container["closeEscrowAccounts"]>;
  /** "own": el componente se explica solo (va suelto en `TrackView`). "inherited": el bloque ya está
   *  montado por quien lo contiene, y repetirlo por ítem es la duplicación de MNR-1. */
  explainer: "own" | "inherited";
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<"confirmed" | "pending" | "unknown" | null>(null);
  // La voz concreta: acá SÍ hay un envío elegido y terminado (ver `escrowRentExplainer`).
  const explainer = escrowRentExplainer("remittance");

  const onClose = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      // NO se le pasa `connectedAddress`: acá vivía `connectedAddress: sender`, la misma variable, y
      // el guard de AC-7 quedaba comparándose consigo mismo (AR/BLQ-BAJO-1). La billetera conectada
      // ahora se la pregunta el use-case al bridge en el momento del click.
      const res = await close.execute({ remittanceId, sender });
      setDone(res.confirmation);
    } catch (e) {
      // enum→copy fijo, sin PII (CD-5). El código crudo NUNCA se interpola en la pantalla.
      setErr(escrowCloseError(e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
    }
  }, [close, remittanceId, sender]);

  return (
    <div className="space-y-2" data-testid="close-escrow-action">
      {explainerMode === "own" ? (
        <>
          <p className="text-sm font-semibold">{explainer.title}</p>
          <p className="text-sm text-stone">{explainer.body}</p>
          <p className="text-xs text-stone">{explainer.notRecovered}</p>
        </>
      ) : null}
      {done !== "confirmed" ? (
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {busy ? "Cerrando…" : done ? "Volver a intentar" : "Cerrar y recuperar"}
        </Button>
      ) : null}
      {done ? <p className="text-sm text-stone">{escrowCloseSentCopy(done)}</p> : null}
      {err ? <p className="text-xs text-cochineal-ink">{err}</p> : null}
    </div>
  );
}

/**
 * Lo que se dice de una orden de recuperación ENVIADA y todavía no confirmada.
 *
 * Se extrajo a un componente porque ahora lo usan las DOS puertas de recuperación (la de una remesa
 * conocida y la del envío perdido), y las dos tienen que decir exactamente lo mismo: el RPC aceptó la
 * transacción, que no es que la plata haya vuelto. El verbo es el de lo que sabemos.
 */
function RefundSentNotice({
  confirmation,
  refundTx,
}: {
  confirmation: Exclude<EscrowRefundConfirmation, "confirmed">;
  refundTx: string;
}) {
  return (
    <div className="space-y-1">
      {/* "Enviamos la orden", NUNCA "volvieron". */}
      <p className="text-xs font-semibold text-ink">Enviamos la orden de recuperación</p>
      <p className="text-xs text-stone">
        {confirmation === "pending"
          ? "Todavía no la vemos confirmada en la cadena. Puede entrar en un rato, o puede no haber entrado. Hasta que se confirme no sabemos si tus USDC volvieron."
          : "No pudimos consultar la cadena para saber si entró. Nadie sabe todavía si tus USDC volvieron; no es que hayan fallado."}
      </p>
      <p className="text-xs text-stone">Orden enviada: {refundTx}</p>
    </div>
  );
}

/**
 * La puerta que faltaba: recuperar un envío que este dispositivo no conoce.
 *
 * 🔴 QUÉ ARREGLA. La recuperación durable ya estaba ENTERA y no tenía ni un consumidor. El endpoint
 * `POST /api/solana/escrow/remittance-ids` está vivo en producción (responde 403 sin PoP), el adapter
 * resuelve el id ausente contra ese store y sondea hasta `MAX_RECOVERY_CANDIDATES` PDAs
 * (`resolveRemittanceIdFromLedger`, `solana-wallet.ts:286`), y el gateway está cableado en el
 * container (`solanaRefund`, `container.ts:169`). Pero
 * la interfaz sólo llamaba a `recoverEscrowFunds`, que arranca con `repo.get(remittanceId)` y tira
 * `remittance_not_found` (`recover-escrow-funds.ts`:49-50). O sea: quien borró los datos del navegador
 * o entra desde otro dispositivo no tenía NINGÚN camino, con el código para dárselo ya escrito.
 *
 * POR QUÉ NO PASA POR `RecoverEscrowFunds`. Ese use-case existe para ESCRIBIR el resultado en la
 * remesa, y acá no hay remesa local que escribir: es justamente el caso en que no existe. Se llama al
 * gateway, que es lo único que puede resolver el id contra el servidor.
 *
 * QUÉ SE DICE ANTES DE ABRIR NINGÚN DIÁLOGO, y por qué es la mitad del arreglo: esto pide DOS firmas
 * a la billetera por motivos distintos (una prueba de posesión, que es un texto, y después la
 * transacción del refund). Una app que abre el diálogo de firma sin haber dicho qué se firma y para
 * qué entrena a la gente a firmar cualquier cosa. Por eso el texto va primero y la acción después.
 */
export function LostEscrowRecovery({
  refund,
  resolveSender,
}: {
  /** El gateway SUELTO, no el use-case: es el único que acepta la llamada sin `remittanceId`. */
  refund?: Container["solanaRefund"];
  /** Devuelve la address del sender, conectando la wallet si hace falta (el PoP la exige). */
  resolveSender: () => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<{
    confirmation: Exclude<EscrowRefundConfirmation, "confirmed">;
    refundTx: string;
  } | null>(null);
  const [recovered, setRecovered] = useState<string | null>(null); // refundTx CONFIRMADO en la cadena

  const onRecover = useCallback(async () => {
    if (!refund) return;
    setBusy(true);
    setErr(null);
    try {
      const sender = await resolveSender();
      // SIN `remittanceId`: es la firma que dispara la resolución contra el store durable.
      const res = await refund.refund({ sender });
      if (res.confirmation === "confirmed") {
        setSent(null);
        setRecovered(res.refundTx);
        return;
      }
      setSent({ confirmation: res.confirmation, refundTx: res.refundTx });
    } catch (e) {
      // El copy de ESTA puerta, no el de la otra: acá "no encontramos nada" no puede leerse como
      // "no tenés fondos" (ver `lostEscrowRecoveryError`).
      setErr(
        lostEscrowRecoveryError(e instanceof Error ? e.message : "", MAX_RECOVERY_CANDIDATES),
      );
    } finally {
      setBusy(false);
    }
  }, [refund, resolveSender]);

  // Sin gateway no hay puerta que ofrecer. El container real siempre lo cablea; el de tests no.
  if (!refund) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-center text-sm font-semibold text-cochineal underline underline-offset-2"
      >
        Recuperar un envío perdido
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-xl2 border border-line bg-sand/60 p-4">
      <p className="text-sm font-bold">Recuperar un envío perdido</p>
      <p className="text-sm text-stone">
        Si borraste los datos del navegador o entrás desde otro dispositivo, tus envíos no aparecen
        en "Ver mis envíos". Los buscamos preguntándole al servidor por tu billetera.
      </p>
      <p className="text-sm text-stone">
        Tu billetera te va a pedir una firma para probar que es tuya: es un texto, no mueve fondos y
        no paga comisión de red. Si encontramos un escrow abierto te va a pedir una segunda firma, y
        esa sí es la transacción que saca tus USDC; su comisión de red la pagás vos.
      </p>
      <Button variant="outline" onClick={onRecover} disabled={busy}>
        {busy ? "Buscando…" : "Buscar mis escrows"}
      </Button>
      {recovered ? (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-ink">Recuperaste tus fondos</p>
          {/* La MISMA frase que el historial usa para ese hecho, no una segunda versión. */}
          <p className="text-xs text-stone">{escrowKnowledgeCopy("returned")}</p>
          <p className="text-xs text-stone">Comprobante: {recovered}</p>
        </div>
      ) : null}
      {sent ? <RefundSentNotice confirmation={sent.confirmation} refundTx={sent.refundTx} /> : null}
      {err ? <p className="text-xs text-cochineal-ink">{err}</p> : null}
    </div>
  );
}

/**
 * WKH-327/AC-8 — la puerta para recuperar el alquiler de envíos que este dispositivo no conoce.
 *
 * POR QUÉ VIVE ACÁ Y NO EN OTRO LADO — las tres razones, con lo que se rompería si se hiciera distinto:
 *
 *  1. NO en `HistoryView`. Esa pantalla declara, en su propio comentario, que NO consulta la cadena, y
 *     toda su honestidad ("son los envíos guardados en este dispositivo") se apoya en eso. Meterle una
 *     lectura on-chain cambia lo que la pantalla ES. Además el historial está scopeado por
 *     `localStorage` y AC-8 exige justamente cubrir lo que NO está ahí.
 *  2. NO adentro de `LostEscrowRecovery`. Esa puerta promete encontrar escrows ABIERTOS con tus USDC, y
 *     su copy de "no encontré nada" lo dice medido: "ninguno de los últimos N envíos… está ABIERTO en
 *     el contrato" (`flow-vm.ts`, `lostEscrowRecoveryError`). Un escrow terminal NO está abierto: meter
 *     los cerrables ahí volvería FALSA una frase que hoy es verdadera. Son dos preguntas distintas a la
 *     misma cadena.
 *  3. SÍ en `send`, al lado: es donde aterriza toda recarga y adonde vuelve "Enviar otra", y ya está
 *     `resolveSender`, que es lo que el PoP del endpoint exige. Cero mecanismo nuevo.
 *
 * QUÉ SE DICE ANTES DE ABRIR NINGÚN DIÁLOGO, igual que su vecina y por la misma razón: acá también hay
 * DOS firmas por motivos distintos (la prueba de posesión, que es un texto, y después la transacción
 * del cierre). Una app que abre el diálogo de firma sin haber dicho qué se firma y para qué entrena a
 * la gente a firmar cualquier cosa.
 */
export function EscrowRentRecovery({
  lister,
  close,
  resolveSender,
}: {
  /** El lister, que es el adapter: la pregunta "¿qué escrows míos siguen abiertos?" es de la cadena. */
  lister?: Container["solanaCloseableEscrows"];
  /** El use-case, NO el gateway suelto: acá vive el guard de AC-7. */
  close?: Container["closeEscrowAccounts"];
  /** Devuelve la address del sender, conectando la wallet si hace falta (el PoP la exige). */
  resolveSender: () => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sender, setSender] = useState<string | null>(null);
  const [found, setFound] = useState<readonly CloseableEscrow[] | null>(null);
  // 🔴 La voz GENÉRICA, y es el fix de CR/BLQ-BAJO-1: este bloque se monta al ABRIR la puerta, cuando
  // todavía no se buscó nada. Con la voz de `CloseEscrowAction` la pantalla decía "Este envío ya
  // terminó, así que se pueden cerrar" sin que existiera ningún envío, y si el descubrimiento fallaba
  // lo decía JUNTO con "no llegamos a preguntar".
  const explainer = escrowRentExplainer("discovery");

  const onSearch = useCallback(async () => {
    if (!lister) return;
    setBusy(true);
    setErr(null);
    try {
      const who = await resolveSender();
      const list = await lister.listCloseable({ sender: who });
      setSender(who);
      setFound(list);
      // Una lista vacía es una RESPUESTA de la cadena, y se dice con las palabras de una respuesta.
      // El caso "no llegamos a preguntar" viaja por el catch y tiene su propia frase. Las DOS frases
      // salen ahora de DOS funciones distintas y no de un parámetro: cuando eran una sola, cualquier
      // código que el guard no reconociera caía en la que afirma haber mirado (AR/BLQ-MED-1).
      // Y que este `[]` sea de verdad una respuesta lo sostiene `listCloseable`, que ahora tira ante
      // las tres degradaciones del registro en vez de dejarlas llegar hasta acá disfrazadas de lista
      // vacía (AR/BLQ-MED-2). Esta rama no puede verificar esa premisa: la hereda.
      if (list.length === 0) {
        setErr(escrowRentDiscoveryEmpty(MAX_CLOSEABLE_CANDIDATES));
      }
    } catch (e) {
      // 🔴 Acá NO se puede decir "no tenés nada": no llegamos a mirar. Y tampoco entra el tope de
      // candidatos, porque nombrar "los últimos 20 envíos" es contar lo que se miró, y no se miró
      // ninguno.
      setErr(escrowRentDiscoveryError(e instanceof Error ? e.message : ""));
      setFound(null);
    } finally {
      setBusy(false);
    }
  }, [lister, resolveSender]);

  // Sin lister no hay puerta que ofrecer. El container real siempre lo cablea; el de tests no.
  if (!lister) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-center text-sm font-semibold text-cochineal underline underline-offset-2"
      >
        Recuperar el depósito de red de envíos anteriores
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-xl2 border border-line bg-sand/60 p-4">
      <p className="text-sm font-bold">{explainer.title}</p>
      <p className="text-sm text-stone">{explainer.body}</p>
      <p className="text-xs text-stone">{explainer.notRecovered}</p>
      <p className="text-sm text-stone">
        Tu billetera te va a pedir una firma para probar que es tuya: es un texto, no mueve fondos y
        no paga comisión de red. Después, por cada envío que cierres, te va a pedir la firma de esa
        transacción, y su comisión de red la pagás vos.
      </p>
      <Button variant="outline" onClick={onSearch} disabled={busy}>
        {busy ? "Buscando…" : "Buscar envíos con cuentas abiertas"}
      </Button>
      {found && found.length > 0 && close && sender ? (
        <div className="space-y-3">
          {found.map((e) => (
            <div key={e.remittanceId} className="space-y-1 border-t border-line pt-2">
              <p className="text-xs text-stone">Envío {e.remittanceId}</p>
              {/* "inherited": el explicativo ya está montado arriba, UNA vez para toda la lista. */}
              <CloseEscrowAction
                remittanceId={e.remittanceId}
                sender={sender}
                close={close}
                explainer="inherited"
              />
            </div>
          ))}
        </div>
      ) : null}
      {err ? <p className="text-xs text-cochineal-ink">{err}</p> : null}
    </div>
  );
}

/**
 * El desembolso, en curso. Es la pantalla que la persona mira más tiempo.
 *
 * QUÉ CAMBIÓ Y POR QUÉ. Antes acá había una sola línea gris: "este paso no avanza solo, la entrega la
 * libera una persona del equipo, puede quedarse acá un buen rato, si preferís no esperar podés
 * recuperar tus USDC". Todo eso es CIERTO y se conserva abajo. El problema era el orden: lo primero
 * que leía la persona era una disculpa y una invitación a cancelar, cuando lo que acababa de pasar es
 * que su plata entró al escrow y la orden de pago salió. El dato importante estaba al final.
 *
 * 🔴 LO QUE ESTA PANTALLA NO DICE, Y NO ES UN OLVIDO. No dice "entregado", no dice "le llegó a tu
 * familia", y no pinta ningún tilde verde de entrega. Este proyecto ya tuvo esa pantalla: el modo
 * demo afirmaba "entregado" sin consultar nada y mostraba el monto COTIZADO como si fuera el
 * entregado. Se sacó, y volver a ponerla con mejor tipografía sería el mismo bug con otro nombre.
 * Lo que se muestra es lo que efectivamente pasó: el proveedor aceptó la orden y está procesando.
 * El verbo es el de lo que sabemos.
 *
 * El sello de entorno de prueba sale de `isDemoMode`, que mira la proveniencia REAL del desembolso
 * (`payoutProvenance`), no una bandera de presentación: si algún día el desembolso es real, el sello
 * desaparece solo porque el dato cambió, no porque alguien se haya acordado de sacarlo.
 */
function PayoutInProgress({ rem }: { rem: RemittanceState }) {
  const simulado = isDemoMode(rem);
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-sand px-4 py-3 text-center">
        <p className="text-xs text-stone">{rem.beneficiary.name} va a recibir</p>
        <p className="tabular text-3xl font-extrabold text-verde">
          {rem.quote ? rem.quote.receive.format() : "—"}
        </p>
        <p className="mt-1 text-xs text-stone">
          en {methodLabel(rem.beneficiary.method)} · {rem.beneficiary.destination}
        </p>
      </div>
      <div className="flex items-start gap-2.5">
        {/* 🔴 RELOJ QUIETO, NUNCA UN SPINNER. Mi primera versión de esta tarjeta puso un spinner y el
            test lo tumbó, con razón: hay una decisión deliberada de que en este paso NADA gire,
            porque un spinner dice "trabajando" y lo que pasa es "esperando". Es el mismo criterio
            que el icono del paso en la lista de arriba. */}
        <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-cochineal" />
        <div>
          {/* "El proveedor está procesando el desembolso" contradecía al comentario de TRACK_STEPS
              quince líneas más arriba, que dice de este mismo estado: "Nadie está pagando todavía".
              En `payout_submitted` lo único que pasó es que el agente aceptó crear la orden; los USDC
              siguen en el vault y el release lo dispara una persona a mano. El verbo ahora es el de
              lo que sabemos: aceptó. */}
          <p className="text-sm font-medium">El proveedor aceptó la orden de pago</p>
          {/* Las dos mitades honestas, JUNTO al titular y no escondidas más abajo. La segunda es la
              frase que estaba antes: este paso no avanza solo. Se conserva el hecho y cambia el
              lugar, porque enterrarlo sería prometer un automatismo que no existe.
              "Tus USDC ya están en el contrato" (presente, continuo) afirmaba más que `principalTx`,
              que prueba un hecho PASADO: la cadena confirmó que el depósito entró. Nadie volvió a
              mirar el vault desde entonces, y de hecho el historial de esta misma remesa lo dice con
              todas las letras ("No comprobamos si tus USDC siguen en el escrow", vía
              `escrowFundsKnowledge` → `unverified`). Dos pantallas no pueden contar dos historias. */}
          <p className="mt-0.5 text-xs text-stone">
            Vimos entrar tus USDC al contrato, a tu nombre. Todavía no tenemos la confirmación de que
            el dinero llegó a destino, así que no te lo vamos a decir hasta tenerla.
          </p>
          <p className="mt-1 text-xs text-stone">
            Este paso no avanza solo: la entrega la libera una persona del equipo, así que puede
            quedarse acá un buen rato. Si preferís no esperar, podés recuperar tus USDC.
          </p>
        </div>
      </div>
      {/* El sello dice lo que la CONDICIÓN mide, y no una cosa distinta. `isDemoMode` es un OR de tres
          proveniencias (cotización, verificación, desembolso), así que se prende también cuando el
          desembolso es real y lo simulado fue la cotización. En esa combinación el texto viejo afirmaba
          dos cosas falsas de una: que el desembolso era simulado y que no se había movido dinero hacia
          ninguna cuenta bancaria, con TransFi habiendo pagado. Decir cuál de los tres pasos fue el
          simulado exigiría distinguirlos acá; se dice menos y no se inventa la distinción.
          Y ya no dice "es simulado": dos de las tres patas (verificación y desembolso) son allowlists,
          así que esto también se prende con una proveniencia DESCONOCIDA, de la que no sabemos si es
          simulada. Lo que la condición mide es que no está confirmada como real, y es lo que dice. */}
      {simulado ? (
        <p className="rounded-lg border border-dashed border-stone/40 px-3 py-2 text-xs text-stone">
          <strong>Entorno de prueba.</strong> Al menos uno de los pasos de este envío (la cotización,
          la verificación o el desembolso) no está confirmado como real. El depósito en la cadena sí
          es real y se puede ver en el explorador.
        </p>
      ) : null}
    </div>
  );
}

/**
 * La leyenda que acompaña a "Recuperar fondos".
 *
 * Antes esto era `RefundLockedNotice` y recibía un `availableAt` para escribir una hora concreta
 * ("a partir de las 14:35"). Esa hora salía de `quote.expiresAt` y desde el 2026-08-01 está mal:
 * ver el comentario largo en el cálculo de `showRefund`. No se reemplazó por otra hora estimada
 * porque no tenemos ninguna que sea verdadera en esta capa; se reemplazó por decir qué sabemos.
 */
// ── Quién va a atender esta remesa ───────────────────────────────────────────────────────────────
// Lo que hace a Chaski distinto de una app de remesas no es la pantalla: es que los pasos no están
// cableados a un proveedor, se piden por CAPACIDAD y los resuelve un catálogo abierto. Eso pasaba y
// no se veía. Esta tarjeta lo muestra ANTES de aprobar, con los datos del catálogo en vivo.
//
// Tres decisiones de honestidad, y las tres tienen su contraparte en `/api/a2a/plan`:
//  · Se dice POR DÓNDE corre hoy cada paso, Y CADA UNO LO DERIVA DE SU PROPIA BANDERA (WKH-336): la
//    COTIZACIÓN del adapter (`resolveValueDeliveryAdapter`, `container.ts:114`) —en `"fallback"` la arma
//    un simulador (`FallbackQuoteGateway`, `container.ts:123`)—; la ENTREGA del settle Solana
//    (`solanaSettleOn`, `container.ts:141`). Pueden traer valores distintos en la misma respuesta, y
//    mostrar la elección del catálogo como la que va a correr sería medir una cosa y afirmar otra.
//  · `verified` se muestra tal cual. Hoy los tres dicen que no. Pintar un tilde sería la mentira
//    más fácil de acá.
//  · La identidad NO aparece como agente: hoy es una integración directa con el proveedor. La
//    tercera fila sería la más vendible y es la que no existe.
//
// 🔴 ACÁ HABÍA UNA CUARTA DECISIÓN —"se dice QUIÉN corre, no sólo por dónde"— Y SE FUE EN W3 CON SU
// FUENTE. Existía porque la tarjeta y la ejecución nombraban agentes DISTINTOS: el catálogo listaba
// uno y la app llamaba por URL a otro, así que la pantalla nombraba a quien no corría. La reparación
// de entonces fue decirlo; la de esta HU es que no pueda volver a pasar, porque ya no hay ninguna URL
// con un nombre adentro. Lo que queda por decir es POR DÓNDE, y eso es lo que cada fila dice.
function AgentPlanCard() {
  type Step = {
    capability: string;
    label: string;
    agent: { id: string; description: string; priceUsdc: number | null; verified: boolean; registry: string } | null;
    /**
     * POR QUÉ no alcanza con `agent === null` (WKH-332/AC-14, CD-18). `null` colapsaba cuatro
     * desenlaces y esta tarjeta afirmaba UNO: *"El catálogo no ofrece a nadie…"*. Un 500 del gateway
     * o un timeout de red nuestro se leían como un hecho SOBRE EL CATÁLOGO. Opcional en el tipo
     * porque durante un deploy el server puede ser todavía el de la versión anterior; ese caso cae en
     * la rama de "no pudimos consultar", que es la que no afirma nada.
     */
    availability?: "ofrecido" | "sin-candidatos" | "no-consultado";
    /** Con qué constraints se preguntó. Es lo que hace falsable la frase "bajo el piso de este paso". */
    constraints?: { minReputation: number; allowTrial?: true };
    /**
     * Por dónde corre hoy ESTE paso. `"punto-a-punto"` salió del dominio en W3 junto con el carril, y
     * `"demo"` NO significa lo mismo en los dos pasos (WKH-336), porque cada leg deriva de su propia
     * bandera:
     * · en la COTIZACIÓN, `"demo"` = el adapter está en `"fallback"` y la arma un simulador local
     *   (`resolveValueDeliveryAdapter`, `container.ts:114`);
     * · en la ENTREGA, `"demo"` = el settle Solana está apagado (`solanaSettleOn`,
     *   `container.ts:141`), y ahí no hay simulador: el envío FALLA CERRADO antes de intentar nada
     *   (`this.solana`, `../application/use-cases/confirm-and-send.ts:336` ⇒ `settlement_unavailable`).
     *   La frase renderizada para `"demo"` dice *"lo simula"*: en este leg es imprecisa, y es un
     *   residual declarado (H1 de WKH-336) porque corregirla exige un TERCER valor de este campo.
     * En los dos casos afirmar "corre por el gateway" sería falso, que es para lo que existe el campo.
     */
    transport: "gateway" | "demo";
    /** 🔴 `runsTodayAgentId` YA NO VIENE. Murió con el carril que lo poblaba (W3): su único valor
     *  posible era el slug cableado en el `fetch`, y ese `fetch` no existe. */
  };
  const [plan, setPlan] = useState<{ steps: Step[]; totalUsdc: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/a2a/plan");
        if (!res.ok) throw new Error("plan_unavailable");
        const d = (await res.json()) as { steps: Step[]; totalUsdc: number };
        if (alive) setPlan(d);
      } catch {
        if (alive) setFailed(true); // no se inventa un plan: se dice que no se pudo
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    return (
      <Card>
        <p className="text-sm font-semibold">Quién va a atender tu envío</p>
        <p className="mt-1 text-xs text-stone">
          No pudimos consultar el catálogo ahora. Tu envío sigue igual: esto es informativo.
        </p>
      </Card>
    );
  }
  if (!plan) return null;

  return (
    <Card>
      <p className="text-sm font-semibold">Quién va a atender tu envío</p>
      {/* "Ninguno de estos pasos está atado a una empresa fija" quedaba desmentido tres renglones
          más abajo por el propio detalle de cada fila: la que decía "hoy se llama directo a X" ERA un
          paso cableado a un agente concreto. Esa fila ya no existe (W3), y aun así la frase de arriba
          sigue describiendo el MODELO (pedimos capacidades) sin afirmar que hoy los tres corran por
          ahí: cada fila lo dice por su cuenta, y en demo la cotización no la da ningún agente. */}
      <p className="mt-1 text-xs text-stone">
        Chaski pide capacidades, no empresas: el catálogo abierto responde quién las cumple, así que
        esta lista puede cambiar sola. Abajo, por dónde corre hoy cada paso.
      </p>
      <div className="mt-3 space-y-2">
        {plan.steps.map((s) => (
          <div key={s.capability} className="rounded-lg border border-line px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{s.label}</span>
              <span className="tabular text-sm">
                {s.agent?.priceUsdc != null ? `${s.agent.priceUsdc} USDC` : "sin precio publicado"}
              </span>
            </div>
            {s.agent ? (
              <>
                <p className="mt-0.5 text-xs text-stone">
                  El catálogo ofrece a {s.agent.id}
                  {s.agent.verified ? " · verificado" : " · sin verificar"}
                </p>
                <AgentRunsToday transport={s.transport} />
              </>
            ) : (
              <AgentUnavailable availability={s.availability} constraints={s.constraints} />
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-baseline justify-between">
        <span className="text-xs text-stone">Precio publicado en el catálogo</span>
        <span className="tabular text-sm font-semibold">{plan.totalUsdc} USDC</span>
      </div>
      {/* La nota se elige leyendo LOS DOS legs, porque habla del número y el número cubre a los dos.
          La regla es "sólo se afirma lo que la pata garantiza": si la ENTREGA no garantiza nada, la
          atribución se acota nombrando la pata de la COTIZACIÓN, y de la otra no se dice nada. Si el leg
          de la cotización no se puede identificar, no se afirma NADA y no se renderiza nota: ver el
          docblock de `AGENT_PRICE_NOTE_*`. */}
      {(() => {
        const cotizacion = plan.steps.find((s) => s.label === FX_STEP_LABEL);
        if (cotizacion === undefined) return null;
        const entrega = plan.steps.find((s) => s.label === PAYOUT_STEP_LABEL);
        // ⚠️ ES `=== "gateway"` Y NO `!== "demo"`, y la dirección ES la decisión. Un `?.` seguido de un
        // `!==` elige un default en silencio: con `entrega === undefined` daría `true` y caería en la
        // afirmación MÁS FUERTE —que se paga el fee del total— justo cuando no se sabe nada de la
        // entrega. Con `=== "gateway"` un `entrega` ausente da `false` y cae en la MÁS DÉBIL.
        const nota =
          cotizacion.transport === "demo"
            ? AGENT_PRICE_NOTE_DEMO
            : entrega?.transport === "gateway"
              ? AGENT_PRICE_NOTE_GATEWAY
              : AGENT_PRICE_NOTE_GATEWAY_SOLO_FX;
        return <p className="mt-1 text-xs text-stone">{nota}</p>;
      })()}
      <PlanConstraintsNote steps={plan.steps} />
      <p className="mt-2 text-xs text-stone">
        Tu identidad no pasa por el catálogo: se verifica con el proveedor directo.
      </p>
    </Card>
  );
}

/**
 * Dice CON QUÉ se preguntó, y es la mitad de AC-14 que se ve en pantalla.
 *
 * 🔴 QUÉ ARREGLA, MEDIDO sobre el árbol previo a WKH-332: el preview llamaba a
 * `/discover?capabilities=X` sin ninguna constraint, mientras la ejecución mandaba
 * `min_reputation: 2`. Esta tarjeta podía mostrar un agente que el envío iba a rechazar, y la persona
 * aprobaba mirando a alguien que no la iba a atender.
 *
 * El número NO está escrito acá: sale de `constraints` de la respuesta, o sea de lo que se preguntó
 * de verdad. Si el server no lo manda (una versión anterior durante un deploy) la frase no se
 * muestra: una afirmación sobre el piso que no se puede sostener con el dato es peor que no decir
 * nada. Input que la deja en blanco: un `steps[]` sin `constraints`.
 */
function PlanConstraintsNote({
  steps,
}: {
  steps: Array<{ constraints?: { minReputation: number } }>;
}) {
  const pisos = steps
    .map((s) => s.constraints?.minReputation)
    .filter((n): n is number => typeof n === "number");
  if (steps.length === 0 || pisos.length !== steps.length) return null;
  const min = Math.min(...pisos);
  const max = Math.max(...pisos);
  return (
    <p className="mt-2 text-xs text-stone">
      Esta lista se consultó con el mismo piso de reputación con el que corre el envío
      {min === max ? ` (${min})` : ` (entre ${min} y ${max}, según el paso)`}: no es una vidriera más
      amplia que lo que se va a ejecutar.
    </p>
  );
}

/**
 * La línea que se muestra cuando NO hay agente que mostrar. Dos motivos distintos, dos frases
 * distintas, y la diferencia entre ellas es el punto de este componente (WKH-332/AC-14, CD-18).
 *
 * 🔴 ACÁ HABÍA UNA SOLA FRASE —"El catálogo no ofrece a nadie para esta capacidad ahora mismo"— y se
 * mostraba también cuando el catálogo no había contestado nada. O sea que un 500 del gateway, un
 * body ilegible o un timeout de red NUESTRO salían en pantalla como una afirmación de hecho sobre el
 * catálogo. "No pude preguntar" no es "no pasó", y decirlo igual convierte una falla nuestra en una
 * acusación al otro.
 *
 * · `sin-candidatos` — el catálogo CONTESTÓ (200) y la lista vino vacía. Se puede afirmar, y se
 *   nombra el piso, porque el piso es la razón por la que la lista puede venir vacía teniendo el
 *   catálogo agentes para esa capacidad. El número sale de `constraints`, o sea de lo que se
 *   preguntó de verdad, no de un literal escrito acá.
 * · `no-consultado` (y el campo AUSENTE, que es un server viejo durante un deploy) — no se afirma
 *   NADA sobre el catálogo. Esta frase NO puede contener "no ofrece a nadie": T-14.5 lo custodia.
 */
function AgentUnavailable({
  availability,
  constraints,
}: {
  availability?: "ofrecido" | "sin-candidatos" | "no-consultado";
  constraints?: { minReputation: number; allowTrial?: true };
}) {
  if (availability === "sin-candidatos") {
    return (
      <p className="mt-0.5 text-xs text-stone">
        El catálogo no ofrece a nadie para esta capacidad
        {typeof constraints?.minReputation === "number"
          ? ` con al menos ${constraints.minReputation} de reputación, que es el piso de este paso`
          : ""}
        .
      </p>
    );
  }
  return (
    <p className="mt-0.5 text-xs text-stone">
      No pudimos consultar el catálogo para este paso. No sabemos quién lo atiende, y eso no dice nada
      sobre si hay alguien.
    </p>
  );
}

/**
 * Qué es ese número, y quién lo cobraría.
 *
 * 🔴 ACÁ DECÍA "Lo que cobran los agentes", y no siempre lo cobra alguien. El número es el precio que
 * los agentes PUBLICAN en el catálogo, y el catálogo lista a quien mejor rankea ahora, que puede no
 * ser quien corra. El dato no se borra (sirve para comparar lo que el catálogo publica): se le pone
 * dueño y tiempo verbal, que es el mismo criterio con el que ya se arregló el "llega en ~30 min".
 *
 * 🔴 LAS DOS FRASES DE ANTES ERAN "gateway" y "punto a punto"; ahora son "gateway" y "demo", y la
 * segunda cambió de contenido, no sólo de nombre. La vieja decía *"la app los llama sin ningún pago y
 * contestan igual"*, que describía el carril punto a punto —un `fetch` liso a un agente real, sin
 * x402 y sin Agent Key—. Ese carril se borró en W3 y la frase se fue con él.
 * 🔴 Y LA QUE LA REEMPLAZÓ TAMBIÉN ERA FALSA (CR2/BLQ-ALTO-1). Decía *"no llama a ninguno de ellos"*, y esta
 * bandera cablea la cotización y el ESTADO del payout (`FallbackQuoteGateway`, `container.ts:123`), NO la entrega:
 * esa la cablea `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` (`solanaSettleOn`, `container.ts:141`). Con el settle en `true`
 * y esta en `"fallback"` el envío llama igual a `/api/payout/prepare`, y ese POST compone contra el gateway: 200
 * y un solo fetch a `/compose` (T-1.2, MEDIDO: `it.each`, `../../app/api/payout/prepare/route.test.ts:1296`). Por
 * eso la frase habla SÓLO de la cotización. Con el gateway el fee lo liquida el gateway contra la Agent Key de
 * Chaski (header `x-a2a-key`): ahí sí se paga, y no lo paga la persona.
 *
 * 🔴 Y EL SELECTOR TENÍA QUE MIRAR EL LEG DEL QUE LA FRASE HABLA (WKH-336/R1). Era
 * `plan.steps.some((s) => s.transport === "demo")`: preguntaba *"¿ALGÚN paso es demo?"* para elegir una
 * nota cuya segunda cláusula afirma algo de la COTIZACIÓN (*"la cotización que estás aprobando la armó la
 * app, no ellos"*). Mientras los dos pasos compartían un `transport` único eso era inocuo. Al derivar por
 * leg apareció el cuadrante `adapter="a2a-gateway"` + settle apagado ⇒ `steps[0]="gateway"`,
 * `steps[1]="demo"` ⇒ el `.some()` se activaba POR LA ENTREGA y mostraba la nota que dice que la
 * cotización la armó la app, cuando la armó el gateway (`A2aQuoteGateway`, `container.ts:123`). Ahora
 * mira `steps[0]`, que es el leg de la cotización, y en los otros tres cuadrantes elige exactamente la
 * misma nota que antes. Input que lo pone en rojo si alguien vuelve al `.some()`: un plan
 * `["gateway","demo"]` y esta nota diciendo que la cotización la armó la app — T-R1 en
 * `agent-plan-card.test.tsx`.
 *
 * ✅ ESE RESIDUAL LO CERRÓ WKH-338, Y ACÁ ESTÁ QUÉ SE CERRÓ Y QUÉ NO. Lo que estaba abierto: WKH-336
 * arregló la cláusula sobre quién ARMÓ la cotización, y dejó la otra mitad —la cláusula sobre quién PAGA
 * el fee— hablando de *"ese fee"*, o sea del NÚMERO, que suma los steps con precio publicado
 * (`withPrice`, `../../app/api/a2a/plan/route.ts:294`) y por lo tanto cubre a las DOS patas cuando las
 * dos publican precio. En el cuadrante `adapter="a2a-gateway"` + settle apagado, parte de ese número es
 * el fee de un paso que no se va a ejecutar: el envío falla cerrado antes de intentarlo (`this.solana`,
 * `../application/use-cases/confirm-and-send.ts:336`). La salida es atribución POR PATA, en modo
 * *"sólo se afirma lo que la pata garantiza"*: son tres notas, y la del cuadrante con las DOS banderas
 * encendidas —los dos legs por el gateway— no cambió una letra, porque ahí *"ese fee"* es cierto y
 * acotarla perdería información verificable.
 *
 * ⚠️ Y DE LA ENTREGA, LA NOTA ACOTADA NO DICE NADA. A PROPÓSITO, Y NO SE "COMPLETA". Lo natural sería
 * agregar *"y el fee de la entrega no lo paga nadie, porque ese paso no corre"*. Es verdad
 * (`this.solana`, `../application/use-cases/confirm-and-send.ts:336`) y está PROHIBIDO escribirlo: en
 * ese mismo cuadrante, tres renglones más arriba en la MISMA tarjeta, la fila de la entrega dice
 * *"esta app está en modo demo y lo simula"* (`simula`, `flow.tsx:2389`). Ese *"lo simula"* es impreciso
 * —con el settle apagado la entrega no se simula, se corta— pero es **H1 de WKH-336**, residual de otra
 * HU que exige un TERCER valor de `transport` con su propia frase, y WKH-338 no lo cierra. Si la nota
 * dijera *"la entrega no corre"* mientras la fila dice *"lo simula"*, la tarjeta se contradiría a sí
 * misma en pantalla, y hay un `it` cuyo eje literal es exactamente eso: *"no niega lo que cada fila
 * afirma"*, en `honest-copy.test.tsx:432`. Es el mismo criterio que este archivo ya escribió dos veces:
 * se dice menos y no se inventa la distinción.
 *
 * ⚠️ LO QUE TAMPOCO SE CERRÓ: el singular. Las tres notas dicen *"al ejecutar el paso"*, y con las dos
 * banderas encendidas son DOS los pasos cuyos fees Chaski paga. Es una imprecisión heredada de
 * WKH-336 y queda DECLARADA: tocar ese fragmento rompería los ocho asserts de
 * `agent-plan-card.test.tsx` que lo matchean, o sea reduciría la cobertura para arreglar la redacción.
 *
 * 🔴 EL INPUT QUE PONE EN ROJO EL SELECTOR NUEVO, y es el que W1 vio rojo antes del fix: renderizar la
 * tarjeta dos veces, con `[fx("gateway"), payout("gateway")]` y con `[fx("gateway"), payout("demo")]`,
 * y comparar el NODO de la nota entre las dos. Si el selector vuelve a mirar sólo el leg de la
 * cotización, los dos textos son el MISMO string. Es T-338.1, y compara el nodo y no el
 * `document.body` porque los dos cuadrantes YA difieren en el body por la FILA de la entrega: sobre el
 * body el test daría verde hoy y sería decorativo para siempre.
 */
/**
 * La llave del leg de la COTIZACIÓN, y por qué es el `label` y no la capacidad (AR/MNR-2).
 *
 * 🔴 ACÁ HABÍA UN ÍNDICE POSICIONAL (`plan.steps[0]`) para elegir una nota cuya semántica es *"el leg de
 * la cotización"*. Hoy el orden del server está clavado —el array es un literal de dos elementos y
 * `route.test.ts` asserta el `label` de cada índice—, pero esta tarjeta FABRICA sus arrays en los tests,
 * así que ningún test verifica que la suposición del cliente coincida con el orden del server: la
 * fragilidad no la cubría nadie. Se elige por la llave semántica que el payload ya trae.
 *
 * ⚠️ Y ES EL `label`, NO LA `capability`, y eso es medible: la capacidad es ENV-OVERRIDEABLE
 * (`route.ts:255` es `process.env.WASIAI_A2A_FX_CAPABILITY ?? FX_QUOTE_CAPABILITY`, y
 * `.env.example:181` documenta ese override como soportado). Un `find` por `"remittance-fx-quote"`
 * devolvería `undefined` en cualquier entorno con el override puesto y la tarjeta caería SIEMPRE en la
 * nota del gateway, en silencio. El `label` es un literal de la route (`route.ts:276`), no sale de
 * ninguna env. Input que pone en rojo el índice posicional: un plan con los pasos al revés
 * (T-R1e en `agent-plan-card.test.tsx`).
 *
 * 🔴 PERO ESTO ES UNA COPY DE USUARIO SOSTENIENDO UNA DECISIÓN DE LÓGICA, y hay que decirlo acá porque
 * es el único lugar donde el próximo lector lo va a leer. **Este literal está DUPLICADO**: la otra copia
 * es el `label` que escribe la route (`route.ts:276`), y son dos archivos distintos.
 *
 * Input concreto que rompía las dos, MEDIDO (CR/BLQ-MED-1): renombrar el `label` de la route a
 * `"Cotizar el tipo de cambio"` da 5 rojos y **los 5 caen en `app/api/a2a/plan/route.test.ts`**
 * (T-336.1 ×3, T-336.3 ×2), ninguno acá. Actualizando esos dos asserts —el arreglo natural y mínimo—
 * la suite vuelve a **102 files / 1630 PASS** con este literal quedándose viejo, y ahí el `find` da
 * `undefined` para siempre. En una familia de HUs cuyo objeto es reescribir copy, eso pasa.
 *
 * ✅ Lo ata **T-336.6 (estático)** en `app/api/a2a/plan/route.test.ts`: extrae el literal de los DOS
 * archivos y exige que sean el MISMO. Renombrar una sola de las dos ⇒ rojo; renombrar las dos ⇒ verde,
 * porque lo que se custodia es el acoplamiento y no la copy. Es el patrón de T-14.3 con los pisos de
 * reputación, en el mismo archivo.
 *
 * ⚠️ Y LA RAMA `undefined` NO AFIRMA NADA, a propósito. Si ningún paso trae este `label`, el consumidor
 * (`AgentPlanCard`) **no renderiza la nota**: `undefined === "demo"` era `false` y caía en
 * `AGENT_PRICE_NOTE_GATEWAY`, o sea en la afirmación MÁS FUERTE de todas —que el fee *"lo paga Chaski
 * con su Agent Key al ejecutar el paso"*— justo cuando no se sabe de qué leg se está hablando. Eso es
 * al revés del criterio de este archivo: `no-consultado` y el campo ausente **no afirman NADA sobre el
 * catálogo** (ver el docblock de `AgentUnavailable`). Callar es lo único cierto en los cuatro
 * cuadrantes, y una nota que falta es un síntoma visible; una nota falsa no. **A ESTA RAMA no se le
 * agrega una frase** porque sería copy nueva, o sea una decisión de UX, no un arreglo. Lo custodia
 * T-R1g. (WKH-338 agregó una tercera nota, pero para el cuadrante en que la COTIZACIÓN sí se
 * identifica y la ENTREGA no garantiza nada: esta rama sigue sin renderizar nada.)
 */
const FX_STEP_LABEL = "Cotizar el cambio";

/**
 * La llave del leg de ENTREGA, y por qué hace falta una segunda (WKH-338).
 *
 * La nota de precio dejó de poder elegirse mirando un solo leg: su cláusula sobre quién paga el fee
 * habla del NÚMERO, y el número cubre a las dos patas. Así que para saber qué se puede afirmar hay que
 * poder identificar las dos, y esta es la llave de la segunda.
 *
 * ⚠️ ES EL `label` Y NO LA `capability`, por la misma razón medible que `FX_STEP_LABEL`: la capacidad es
 * ENV-OVERRIDEABLE (`payoutCapability`, `../../app/api/a2a/plan/route.ts:256` es
 * `process.env.WASIAI_A2A_PAYOUT_CAPABILITY ?? PAYOUT_CAPABILITY`, y `.env.example:182` documenta ese
 * override como soportado). Un `find` por `"remittance-payout"` devolvería `undefined` en cualquier
 * entorno con el override puesto, y la nota se elegiría por la rama del default en silencio. El `label`
 * es un literal de la route (`label`, `../../app/api/a2a/plan/route.ts:284`), no sale de ninguna env.
 *
 * ⚠️ Y EL DRIFT DE ESTE LITERAL NO PESA LO MISMO QUE EL DE `FX_STEP_LABEL`, que es la razón por la que el
 * candado de abajo es defensa en profundidad y no la línea de verdad. Si el `label` de la route se
 * renombra y ESTE se queda viejo, el `find` da `undefined` ⇒ la nota cae en
 * `AGENT_PRICE_NOTE_GATEWAY_SOLO_FX`, la afirmación MÁS DÉBIL de las tres: sub-afirma, no miente. El
 * drift de `FX_STEP_LABEL`, en cambio, apaga la nota entera. Ninguno de los dos produce una afirmación
 * falsa, y eso es deliberado: la dirección del default es que cuando falta información la nota se
 * debilita. Lo custodia T-338.5 en `agent-plan-card.test.tsx`.
 *
 * ✅ Lo ata **T-338.2 (estático)** en `app/api/a2a/plan/route.test.ts`, con la misma forma que T-336.6:
 * extrae el literal de los DOS archivos y exige que sean el MISMO, con dos `toBeTypeOf("string")` antes
 * de la comparación para que el candado no quede aplaudiendo `undefined === undefined`. Renombrar una
 * sola de las dos copias ⇒ rojo; renombrar las dos ⇒ verde a propósito, porque lo que se custodia es el
 * ACOPLAMIENTO y no la copy.
 */
const PAYOUT_STEP_LABEL = "Entregar el dinero";

const AGENT_PRICE_NOTE_DEMO =
  "Es lo que estos agentes publican en el catálogo, no lo que se cobra en este envío: no se suma a lo que enviás, y la cotización que estás aprobando la armó la app, no ellos.";
const AGENT_PRICE_NOTE_GATEWAY =
  "Es lo que estos agentes publican en el catálogo. Por el carril del gateway ese fee lo paga Chaski con su Agent Key al ejecutar el paso, y no se suma a lo que enviás.";
const AGENT_PRICE_NOTE_GATEWAY_SOLO_FX =
  "Es lo que estos agentes publican en el catálogo. Por el carril del gateway, el fee de la cotización lo paga Chaski con su Agent Key al ejecutar el paso, y no se suma a lo que enviás.";

/**
 * La línea que dice POR DÓNDE corre hoy este paso. Dos casos, y ninguno nombra a un agente.
 *
 * 🔴 ERAN CUATRO Y QUEDARON DOS (WKH-332/W3, AC-7). Los dos que se fueron —"Hoy se llama directo a X"
 * y "Hoy no corre ese: la app llama directo a Y"— sólo podían escribirse si existía un slug cableado
 * en el código, y ese carril se borró. No se reemplazaron por un texto equivalente: la afirmación
 * dejó de ser sostenible, así que la frase se fue con ella.
 *
 * · `gateway`: no se llama a ningún slug, se pide la capacidad y el gateway resuelve AL EJECUTAR. El
 *   agente que el catálogo lista primero hoy puede no ser el que corra, así que la línea no lo
 *   nombra: sería inventar una certeza.
 * · `demo`: decir "corre por el gateway" acá sería falso, y por eso `transport` sobrevivió al borrado.
 *   ⚠️ PERO `demo` NO SIGNIFICA LO MISMO EN LOS DOS PASOS, porque cada leg deriva de su propia bandera
 *   (WKH-336). En la COTIZACIÓN significa que el adapter está en `"fallback"` y la arma un simulador
 *   local del navegador (`FallbackQuoteGateway`, `container.ts:123`). En la ENTREGA significa que el
 *   settle Solana está apagado (`solanaSettleOn`, `container.ts:141`). Input que pone en rojo el uso de
 *   una sola bandera para los dos: settle en `"true"` + adapter en `"fallback"`, que tiene que dar
 *   `["demo","gateway"]` — T-336.1 en `app/api/a2a/plan/route.test.ts`.
 *
 * ✅ EL RESIDUAL DE CR2 SE CERRÓ EN WKH-336. Acá decía *"la bandera NO decide la ENTREGA, así que con el
 *   settle en `true` la fila del payout dice de más"*, y era cierto: el preview pegaba el `transport` del
 *   adapter a los dos pasos. Ya no. Lo custodia T-336.1 (`transport`,
 *   `../../app/api/a2a/plan/route.test.ts:518` para la otra mitad, el `=== "true"` literal del settle).
 *
 * ⚠️ LO QUE SIGUE ABIERTO, Y NO ES LO MISMO (H1 de WKH-336). Las dos frases de abajo se renderizan
 *   IGUALES para los dos pasos, y la de `demo` dice *"lo simula"*. Para la cotización es exacto. Para la
 *   ENTREGA es impreciso al revés de lo que se leería: con el settle apagado la entrega no se simula, no
 *   corre — `ConfirmAndSend` falla cerrado antes de intentar nada (`this.solana`,
 *   `../application/use-cases/confirm-and-send.ts:336` ⇒ `settlement_unavailable`). No se corrige acá
 *   porque exige un TERCER valor de `transport` con su propia frase, y hoy los dos strings de abajo están
 *   asserteados literalmente en tres sitios: cambiarlos a medias pone rojos tests ajenos.
 */
function AgentRunsToday({ transport }: { transport: "gateway" | "demo" }) {
  if (transport === "gateway") {
    return (
      <p className="mt-0.5 text-xs text-stone">
        Hoy este paso corre por el gateway, que elige al ejecutar: puede tocarle otro.
      </p>
    );
  }
  return (
    <p className="mt-0.5 text-xs font-medium text-cochineal-ink">
      Hoy este paso no lo corre ningún agente: esta app está en modo demo y lo simula.
    </p>
  );
}

// El "2 horas" estaba escrito a mano al lado de una constante que lo decide. Hoy coincide; el día que
// alguien mueva `CUSTODY_WINDOW_SECS` la frase pasa a ser falsa sin que nada se ponga rojo, que es
// exactamente cómo nació el bug de la hora inventada que este archivo ya arregló una vez. Se deriva
// del MISMO valor que el depósito escribe como deadline (`CUSTODY_WINDOW_SECS`, `solana-wallet.ts:379`), así que no puede
// desincronizarse. No agrega peso al bundle: (`SolanaWalletAdapter`, `container.ts:47`) ya importa este módulo.
const CUSTODY_WINDOW_HOURS = CUSTODY_WINDOW_SECS / 3600;

function RefundWindowNote() {
  return (
    <p className="text-xs text-stone">
      El plazo se fija cuando depositás y dura unas {CUSTODY_WINDOW_HOURS} horas. Si todavía no
      venció, el botón te lo dice sin firmar nada ni cobrarte comisión.
    </p>
  );
}

// La advertencia del botón que BORRA. "¿No sos vos?" llama a ForgetKyc, que además de olvidar el
// KYC hace repo.clearByOwner(address): borra TODAS las remesas del dueño del almacenamiento local
// (forget-kyc.ts:36). Su copy decía sólo "esto borra tu verificación", así que ya mentía por omisión
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
            <Pill tone="warn">{DEMO_PILL}</Pill>
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

/**
 * ⚠️ Las ramas `yape` y `plin` NO son código muerto y no se borran junto con el selector. El
 * historial y el recibo leen remesas guardadas ANTES de este cambio, en el localStorage de cada
 * persona, y algunas dicen `method: "yape"`. Colapsar esto a "cuenta bancaria" haría que una
 * remesa vieja se describiera con un destino que no fue el suyo, que es la misma clase de mentira
 * que sacó a Yape de la primera pantalla. Lo que se ofrece cambió; lo que ya pasó, no.
 */
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
