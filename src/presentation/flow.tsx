"use client";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
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
  isPrepareRejection, isPrepareUnreachable, // WKH-358 (fix-pack): EN ESTA LÍNEA, no en una nueva — este archivo recibe 131 citas por número (ver `:44`) y una línea de import de más las corre a todas
} from "../application/agent-rejections"; // hallazgo #75: rechazo del agente ≠ payout fallido
import { resolveSolanaExplorerTxUrl, resolveSolanaNetworkConfig } from "../infrastructure/chain"; import { canonicalizeAddress } from "../infrastructure/address"; // HU-SOL-13: cluster Solana activo (env-driven) · WKH-346: la URL del visor que enlaza el comprobante · WKH-354/AC-3: `canonicalizeAddress` entra EN ESTA LÍNEA, no en una nueva. ⛔ EL NÚMERO, CON SU INSTRUMENTO AL LADO — Y EL INSTRUMENTO ES UN ARCHIVO DEL REPO, NO UNA DEFINICIÓN EN PROSA. Acá vivía un "74" falso (CR/MNR-5) y después un "131 (98 largas desde 30 archivos, 8 internas, + 33 auto) a 79 destinos" que NO SE RE-DERIVA DE NINGUNA LECTURA: el re-AR it2 probó ocho y ninguna da esos números (BLQ-BAJO-4). Una definición escrita a mano no se puede correr; un archivo sí. ⇒ SE MIDE CON EL INSTRUMENTO DE `citas-ancladas.test.ts`: su regex `ANCLADA` (`ANCLADA`, `../composition/citas-ancladas.test.ts:62`) más su resolución de destino, contando las entrantes largas + las auto-citas ANCLADAS y filtrando por destino. Es el MISMO instrumento que reproduce al byte los censos de `solana-wallet.ts` (2362 líneas, 116 citas, 65 por debajo de `:906`). RE-MEDIDO en el árbol de este commit: **82 citas ancladas** (68 largas desde 25 archivos, 3 de ellas dentro de este mismo archivo, + 14 auto-citas) a **56 líneas destino distintas**, y **las 82 apuntan más abajo de esta línea** (la más alta arriba es ninguna; la mínima es `:163`). ⚠️ LO QUE ESTE NÚMERO NO CUENTA, Y HAY QUE DECIRLO: las citas SUELTAS —`flow.tsx:NNN` sin símbolo delante— también se rompen con una línea nueva y NINGÚN candado las mira. Medidas con el mismo barrido, aflojando el regex a `` `…flow.tsx:NNN` `` más `` `:NNN` `` de este archivo: **205** (123 largas desde 36 archivos, 8 internas, + 82 auto) a 106 destinos. ⚠️ ES UNA FOTO Y ENVEJECE SOLA: medido corriendo el mismo barrido sobre `a301c44`, el fix-pack la movió de 76 a 82 ancladas y de 185 a 205 sueltas, sólo escribiendo comentarios. El número se re-deriva, no se hereda; el invariante que justifica el Δ0 es que TODO lo que está más abajo se corre con una línea nueva acá
import type {
  CloseableEscrow, EscrowChainState, SolanaEscrowChainStateReader, // WKH-349: EN ESTA LÍNEA, no en dos nuevas. Decía "las 19 citas … apuntan de `:243` para abajo" y las dos mitades eran falsas (CR/MNR-5), y después decía 131, que tampoco se re-derivaba (re-AR it2 · BLQ-BAJO-4). El número, su instrumento y su fecha viven en UN solo lugar, `:44`, y este renglón no los repite. Lo que sí vale, y es el argumento: TODAS apuntan más abajo de `:44`, así que dos líneas nuevas acá las corren todas
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
  escrowKnowledgeCopy, escrowOutcome, escrowOutcomeDisplay, type EscrowChainAnswer, historyGroupFor, HISTORY_GROUP_ORDER, HISTORY_GROUP_HEADING, type HistoryGroup, // WKH-349: EN ESTA LÍNEA, no en tres nuevas — mismo motivo que `:46` y que la línea de `statusDisplay,` de abajo
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
  statusDisplay, lecturaSeguimiento, gestoDespuesDeProve, type GestoRenovacion, REVISION_APAGADA, REVISION_FIRMANDO, REVISION_GESTO, REVISION_MECANISMO_APAGADO, REVISION_NO_SE_PUDO_PEDIR, REVISION_SIN_BILLETERA, REVISION_SIN_FIRMA, REVISION_TECHO_ALCANZADO, esVentanaSinAbiertos, // WKH-339: EN ESTA LÍNEA. `flow.tsx:661` lo citan 6 archivos (`ports.ts`, `container.test.ts`, `http-pop-signer.ts`, `pop-proof-store.ts`, `ledger-payout-status-gateway.ts`, `solana-providers.tsx`) más 2 sitios de acá, y NINGUNA de las 8 es una cita anclada ⇒ si se mueve, nada se pone rojo y los 8 comentarios rotan en silencio. ⛔ Acá decía `632`, que era el número correcto en `ce4f31e` y lo dejó de ser en esta rama: los 6 archivos SÍ se remapearon a 661 y esta línea, que es la que NOMBRA el número, quedó atrás (CR/BLQ-BAJO-1) · WKH-346 fix-pack: `esVentanaSinAbiertos` entra acá por lo mismo (Δ0)
  cruceDeCuenta, seVerificoLaCuenta } from "./flow-vm"; // WKH-359/AC-6 — los dos EN ESTA LÍNEA (Δ0: este archivo recibe 83 citas ancladas y una línea nueva acá arriba las corre a todas). ⚠️ Van ACÁ y no al final de `:74` porque esa línea TERMINA en comentario: pegar un import ahí lo deja comentado, y `tsc` no lo caza hasta que algo lo use. Me pasó dos veces en esta HU.
import { cn } from "./cn";
import { phantomBrowseUrl, useWalletAvailability, useConnectedWalletAddress, mwaEnabled, useMwaOffered, deeplinkEnabled } from "./wallet-availability"; import type { BilleteraDeeplink } from "../infrastructure/solana/deeplink/protocol"; import { hrefSinRastroDeVuelta, marcaDeVuelta } from "../infrastructure/solana/deeplink/conexion"; import type { EstadoDeLaCuentaDeNonce } from "../composition/container"; import { NONCE_ACCOUNT_RENT_LAMPORTS, formatLamportsAsSol } from "../application/solana-escrow-rent"; // WKH-358: los dos EN ESTA MISMA LÍNEA, por lo mismo que los dos de WKH-MWA // el aviso de "acá no hay wallet" (NoWalletHere) · WKH-354/AC-6: `useConnectedWalletAddress` para el banner (CuentaCambiada) · WKH-MWA: los dos últimos, EN ESTA MISMA LÍNEA (el censo de citas por número de `:44` `flow.tsx:NNNN` cuelgan de que este archivo no cambie de largo)
import { Aviso, Button, Card, ChaskiMark, Field, Money, Muted, Pill, Row, Stepper, TextInput } from "./ui"; import { BarraDestinos, type Destino, VolverAlInicio, esDestino } from "./barra-destinos"; import { Bienvenida } from "./bienvenida"; import { DestinoRecuperar, QUE_RECUPERA } from "./recuperar"; import { LEMA } from "./marca"; import { urlDeVueltaDeKyc } from "./splash-puerta"; // HU-066: los DOS EN ESTA LÍNEA, no en dos nuevas, por lo mismo que dice el resto de este renglón. `LEMA` es el lema del header, que el splash repite y que hasta esta HU estaba escrito a mano acá abajo; `urlDeVueltaDeKyc` arma el callback de Didit, que hasta esta HU era un literal y que la puerta del splash necesita LEER: eran dos escrituras del mismo string en dos archivos, sin nada que las atara // ola 2: los nombres nuevos entran EN ESTA LÍNEA, no en una nueva. Este archivo recibe MUCHAS citas por número, y una sola línea de import de más corre todas las que apuntan más abajo. ⛔ EL NÚMERO NO SE ESCRIBE ACÁ: vive en UN solo lugar, con su definición y su fecha, en el comentario de `:44` (fix-pack, CR/MNR-5). Acá había un valor y el mismo archivo llevaba otros cuatro distintos para el mismo hecho, cada uno copiado de un vecino en vez de medido · WKH-063: los TRES imports nuevos entran acá por lo mismo (Δ0 líneas)

// WKH-187: el quote se muestra ANTES del KYC. Orden: send→connect→review(pre-KYC)→verify→confirm(post-KYC)→track→done.
// `history` NO es un paso del flujo: es la puerta de entrada a las remesas que ya existen. Se
// necesita porque `step`/`rem`/`address` son estado de React y una recarga los borra: sin esta
// pantalla, una remesa con USDC en el escrow dejaba de tener camino desde la interfaz.
// WKH-063: esa distinción ("esto no es un paso") dejó de ser un comentario y es un tipo. Los DESTINOS
// —`bienvenida`, `history`, `recuperar`— se declaran en `./barra-destinos` y `Step` los DERIVA de ahí,
// así que un destino nuevo entra en un solo lugar y la barra lo reconoce sola. La regla que los
// separa, y por qué `done` NO es un destino, están en el docblock de ese archivo.
type Step = Destino | "send" | "connect" | "review" | "verify" | "confirm" | "track" | "done";
const STEP_LABELS = ["Enviar", "Revisar", "Identidad", "Seguir"];
export const STEP_INDEX: Record<Step, number> = { // exportado para el candado de AC-3/AC-4: recorre esta tabla ENTERA, así que un paso nuevo no puede quedarse sin clasificar en silencio
  send: 0,
  connect: 0,
  review: 1,
  verify: 2,
  confirm: 2, // comparte "Identidad" con verify (solape análogo al connect/verify anterior)
  track: 3,
  done: 3,
  history: 0, bienvenida: 0, recuperar: 0, // los TRES destinos: fuera de la línea del flujo, y el stepper no los representa (ni los pinta: ver el ternario de su sitio de render)
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

/**
 * ⚠️ `pasoInicial` ES UNA COSTURA DE TEST, Y SE DECLARA COMO TAL. Mismo molde que `container`: el
 * DEFAULT es lo que corre en producción, así que la app real no pasa nada y arranca en la pantalla de
 * confianza (AC-1). Los tests que hablan del FORMULARIO piden `pasoInicial="send"` en voz alta, en vez
 * de recorrer una pantalla de la que no hablan.
 *
 * 🔴 POR QUÉ EL DEFAULT ES EL VALOR NUEVO Y NO EL VIEJO, y es la mitad que importa: con
 * `pasoInicial = "send"` por defecto, olvidarse de pasarlo en `app/page.tsx` haría desaparecer la
 * primera pantalla en producción con la suite entera en verde. Ese es el perfil de "default que
 * degrada en silencio" que este repo ya tiene documentado. Como está, el olvido no existe.
 * El candado que impide que producción pase este prop está en `barra-destinos.test.tsx`.
 */
export function RemittanceFlow({ container, pasoInicial = "bienvenida" }: { container?: Container; pasoInicial?: Step } = {}) {
  const c = useMemo(() => container ?? createContainer(), [container]);
  const [step, setStep] = useState<Step>(pasoInicial);
  const [busy, setBusy] = useState(false); const disponibilidadWallet = useWalletAvailability(); const mwaEnElSelector = useMwaOffered(); const conectarEsCallejon = disponibilidadWallet === "none" && mwaEnElSelector && !mwaEnabled(); const mostrarSelectorDeEnlace = disponibilidadWallet === "none" && deeplinkEnabled(); // WKH-358: `mostrarSelectorDeEnlace` EN ESTA LÍNEA por lo mismo. Las DOS condiciones van juntas acá y no repartidas por el JSX: `deeplinkEnabled()` sola dejaría el selector visible en un escritorio con extensión, donde el gate del adaptador NUNCA se enciende y el botón llevaría a un salto que al volver corre por el camino inyectado igual. H1: los cuatro EN ESTA LÍNEA y no en cuatro nuevas — `flow.tsx` recibe ~muchas citas por número y una sola línea de más corre todas las que apuntan más abajo (el número y su definición viven en UN solo lugar, `:44`). Qué significa `conectarEsCallejon` está escrito donde se usa, en `step === "connect"`.
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
  const [preview, setPreview] = useState<Quote | null>(null); const [estadoCotiza, setEstadoCotiza] = useState<"pidiendo" | "ok" | "falla" | "corto">("pidiendo"); // H2: `preview === null` significaba TRES cosas (todavía no llegó · falló · el monto no llega al mínimo) y la pantalla las mostraba con el MISMO guión. Un `Quote | null` ya había perdido el tercer valor; esto lo repone. Va EN ESTA LÍNEA porque `flow.tsx` recibe ~muchas citas por número (el número y su definición viven en UN solo lugar, `:44`).
  const [rem, setRem] = useState<RemittanceState | null>(null); const onElegirBilleteraDeEnlace = (b: BilleteraDeeplink) => { if (rem === null) return; yaInteractuoRef.current = true; try { window.location.href = c.recorridoPorEnlace.elegir({ billetera: b, remittanceId: rem.id }).irA; } catch (e) { setError({ message: humanError((e as Error).message) }); } }; // WKH-358 — EN ESTA LÍNEA (Δ0 de citas, `:44`) y ACÁ ABAJO porque necesita `rem`, que se declara en esta misma línea. TRES cosas que no son obvias: (1) `rem === null` NO puede saltar — el viaje se abre CON el `remittanceId` desde el primer byte (CD-5) y sin remesa no hay dueño cruzado que comparar a la vuelta; (2) marca `yaInteractuoRef` porque esto ES una interacción de la persona, y sin eso un resume que resuelva mientras ella está en la app de la billetera navegaría por encima al volver; (3) el `catch` traduce en vez de tirar: `elegir` sube una causa del vocabulario del enlace cuando el disco no acepta el viaje, y eso hay que DECIRLO, no dejarlo como excepción sin causa. ⚠️ Y LA CAUSA SE DERIVA DEL ERROR, NUNCA SE ESCRIBE ACÁ COMO LITERAL: el candado de copy de `deeplink-callers.test.ts` cuenta las causas del vocabulario del enlace que aparecen en `src/presentation`, y hasta que exista el `Record` con todas (once en W5, catorce desde el re-AR it2) escribir una sola acá lo rompe a propósito. Hoy `humanError` la manda a su default, que es exactamente lo que el docblock del motor declara
  const [address, setAddress] = useState<string | null>(null);
  // WKH-333: el veredicto de KYC que el servidor ya contestó al conectar. NO es un guard: sólo decide
  // si se gasta un cupo de Didit (el guard del dinero es `prepare`, server-side).
  const [serverVerdict, setServerVerdict] = useState<KycVerdictLookup | undefined>(undefined);
  // La prueba de posesión que se firmó al conectar. Viaja hasta la creación de la sesión de Didit
  // (WKH-333/R-1) para que no haga falta un SEGUNDO prompt de billetera por el mismo motivo.
  const [kycProof, setKycProof] = useState<WalletPossessionProof | undefined>(undefined);
  const [resuming, setResuming] = useState(false); const [estadoNonce, setEstadoNonce] = useState<EstadoDeLaCuentaDeNonce | "en-vuelo" | null>(null); // retomando KYC al volver de Didit · WKH-358/AC-5: `estadoNonce` EN ESTA LÍNEA (Δ0 de citas, `:44`). `null` = "todavía no le preguntamos a la cadena", que NO es ninguno de los cuatro estados y por eso no es uno de sus valores: con `null` la tarjeta no se pinta. El quinto valor, `"en-vuelo"`, no viene de la cadena sino del broadcast, y por eso vive acá y no en `EstadoDeLaCuentaDeNonce`
  const [timedOut, setTimedOut] = useState(false); // el resume-loop agotó el timeout
  const [confirmReset, setConfirmReset] = useState(false); // control "¿No sos vos?" (WKH-184)
  const [rateUpdated, setRateUpdated] = useState(false); // WKH-187: el quote se re-cotizó tras expirar durante el KYC
  const [showResumeEscape, setShowResumeEscape] = useState(false); // WKH-188: botón de escape a los 5 s
  const cancelledRef = useRef(false); const yaInteractuoRef = useRef(false); const [avisoKyc, setAvisoKyc] = useState<{ destino: "confirm" | "verify"; snapshot: RemittanceState; error?: string } | null>(null); // WKH-188: corta el resume-loop tras el escape · WKH-063 (fix-pack 3) los otros dos. LOS TRES EN ESTA LÍNEA porque este archivo recibe muchas citas por número (la definición y su fecha viven en UN solo lugar, `:44`) y una línea de más las corre todas. ⛔ `yaInteractuoRef` ES UN `useRef` Y NO ESTADO A PROPÓSITO: nadie lo pinta, sólo lo LEE el resume-loop, así que un `setState` sería un re-render de la pantalla entera por un dato invisible. 🔴 SU SEMÁNTICA CAMBIÓ EN EL FIX-PACK 3 Y ES TODO EL ARREGLO: el fix-pack 2 lo llamaba `eligioDestinoRef` y lo marcaba SÓLO en `irADestino`, o sea "eligió un destino con la barra", y eso dejaba afuera el embudo (medido: entrar por «Empezar un envío» y tipear un monto aterrizaba en `confirm` igual, sin aviso). Hoy es "la persona ya interactuó", y los dos únicos puntos de entrada que hay en la ventana están marcados: la barra (`irADestino`, `:426`) y el CTA de la bienvenida (`:1195`). ⚠️ QUE ESOS DOS SEAN TODOS ESTÁ MEDIDO, no razonado: en el montaje del resume (default `bienvenida`) el censo de botones habilitados es exactamente `["Empezar un envío", "Enviar", "Mis envíos", "Recuperar"]`, y las puertas de `recuperar` y el «Volver» del historial sólo se pintan DESPUÉS de que una pestaña de la barra ya marcó el ref, así que `openHistory` (`:412`) no necesita marca propia. `avisoKyc` SÍ es estado porque se pinta (el aviso de `:757`), y ya no es un booleano: LLEVA EL SNAPSHOT, que es lo que permite no pisar la remesa en curso.
  // Las remesas ya guardadas de esta wallet. `null` = todavía no las pedimos (que no es lo mismo que
  // "no hay"): la pantalla de historial sólo se renderiza con la lista ya resuelta.
  const [history, setHistory] = useState<RemittanceState[] | null>(null);

  const amountNum = Number(amount) || 0;

  // preview en vivo (debounced)
  useEffect(() => {
    // WKH-314: por debajo del mínimo no se pide cotización. El agente la rechaza igual, así que
    // pedirla sería un viaje garantizado a un error — y, antes de esta HU, una promesa de cero.
    if (amountNum < MIN_SEND_USD) {
      setPreview(null); setEstadoCotiza("corto"); // H2: "corto" no es "falla" — no se pidió nada, así que no hay nada que reintentar ni de qué culpar a la red.
      return;
    }
    setEstadoCotiza("pidiendo"); const t = setTimeout(async () => { // H2: "pidiendo" se declara ANTES del debounce y no adentro. Los 300 ms de espera son parte de la demora que la persona ve (medido: 3661 ms de punta a punta), así que durante ese tramo la caja también tiene que decir que está calculando.
      try {
        const q = await c.previewQuote.execute({ amountUsd: amountNum, method }); setPreview(q); setEstadoCotiza("ok"); // el orden importa: el estado se mueve DESPUÉS de que la cifra está, nunca antes
      } catch {
        setPreview(null); setEstadoCotiza("falla"); // H2: acá se perdía la causa. Sin esto, un corredor caído y un monto de $2 se ven idénticos.
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
    let alive = true; const aterrizar = (destino: "confirm" | "verify", snapshot: RemittanceState, err?: string) => { if (yaInteractuoRef.current) { setAvisoKyc({ destino, snapshot, error: err }); return; } setRem(snapshot); if (err !== undefined) setError({ message: err }); setStep(destino); }; // 🔴 WKH-063 (fix-pack 3) · EL PISÓN, GATEADO, Y LOS DOS DESTINOS POR EL MISMO GATE. Va EN ESTA LÍNEA y adentro del efecto por dos razones distintas: la primera es Δ0 de citas (`:44`); la segunda es que así NO entra en las deps del efecto (es local, y `setStep`/`setAvisoKyc`/`setRem`/`setError`/el ref son estables) — como `useCallback` de arriba habría que sumarla a `[c]`. QUÉ CAMBIA: la ventana entre el montaje y la PRIMERA respuesta del resume no tiene overlay (`resuming` arranca en `false`), así que la pantalla está viva y es correcta; si la persona hace algo ahí, hasta el fix-pack 2 el resume llegaba después y navegaba encima. Ahora no navega: avisa. 🔴 TRES COSAS SE MOVIERON ACÁ ADENTRO Y CADA UNA CIERRA UN CAMINO MEDIDO. (1) `setRem` DEJÓ DE CORRER ANTES DEL GATE, y era una pérdida de datos, no un matiz: el fix-pack 2 lo dejaba afuera "porque el botón del aviso necesita la remesa en estado", y con eso el resume REEMPLAZABA la remesa que la persona estaba creando. Medido: entrar por «Empezar un envío», tipear 137 y «Continuar» deja una fila `created` con `ownerAddress: null` en el repo, y `ownerAddress` sólo se puebla en `startKyc` (`startKyc`, `../domain/remittance.ts:325`), así que esa fila NO la lista `repo.list(address)` ni aparece nunca en "Mis envíos": pisar `rem` la volvía inalcanzable. Ahora el snapshot viaja en `avisoKyc` y se aplica cuando la persona toca el botón. (2) `destino` es parámetro porque el resume tiene DOS aterrizajes y el fix-pack 2 gateaba uno: el `failed` hacía `setStep("verify")` derecho (`:271`). (3) `err` viaja con el aterrizaje porque el banner de error habla de la pantalla a la que se llega; prenderlo sin navegar lo pondría sobre una pantalla que no es la suya. Y el gate sigue siendo "ya interactuó", no "no navegar": con `pasoInicial="send"` y sin ningún toque el ref sigue en `false` y el resume aterriza igual, que es lo que deja verdes T-AC6, T-REQUOTE, T-354-3g y T-354-3h (los cuatro montan `send` y no tocan nada).
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
        // ── WKH-354 (fix-pack AR · BLQ-BAJO-1) · QUIÉN ES EL DUEÑO DE LO QUE SE ACABA DE RETOMAR ───
        //
        // La vuelta de Didit es una RECARGA (`window.location.href = res.url`, misma pestaña en
        // móvil), así que este montaje arranca con `address` en `null` y hasta acá nada la ponía: el
        // resume hacía `setRem` + `setStep` y nada más. Se aterrizaba en `confirm` con la sesión
        // vacía, y ahí el copy de `wallet_account_changed` mandaba a "usá el aviso de arriba" sobre
        // un banner que NO se pinta sin sesión (es la primera condición de `CuentaCambiada`).
        //
        // 🔴 SE REPUEBLA CON EL `ownerAddress` DEL SNAPSHOT Y NO CON LA BILLETERA VIVA, y la
        // diferencia ES el arreglo, no un matiz: `address` significa "con qué cuenta está operando
        // esta sesión", y la sesión que se retoma es la de la cuenta que empezó el envío. Con la viva,
        // `sesion` y `viva` quedarían IGUALES y el banner seguiría sin pintarse: el mismo agujero con
        // otro valor. Medido: esa variante deja T-354-3g en rojo igual.
        if (alive && res.snapshot.ownerAddress) setAddress(res.snapshot.ownerAddress);
        if (res.kind === "passed") {
          // ⛔ ACÁ VIVÍA UN `setRem(res.snapshot)` SUELTO (fix-pack 2) Y SE FUE A `aterrizar` (`:208`) A PROPÓSITO: corría ANTES del gate, así que la remesa que la persona estaba creando en la ventana se perdía aunque la navegación se frenara. El snapshot ya trae el quote lockeado pre-redirect (WKH-187) y ahora viaja como argumento hasta el aterrizaje, que es el único punto que decide si se aplica ya o si espera el botón del aviso. Δ0 de líneas: esta línea reemplaza a la que había.
          // CD-11: re-check de expiry con la lógica del dominio (single-source-of-truth), NO recalcular en la UI.
          const valid = Remittance.rehydrate(res.snapshot).isQuoteStillValid(new Date().toISOString());
          if (valid) {
            if (alive) aterrizar("confirm", res.snapshot); // AC-6: quote vigente → NO re-cotiza. El gate del pisón vive en `aterrizar` (arriba, en la línea del `let alive`), no acá.
          } else {
            try {
              const prev = res.snapshot.quote?.receive; // lo que vio pre-KYC
              const locked = await c.lockQuote.execute({ remittanceId: res.snapshot.id }); // AUTO re-quote (kyc_passed→quoted)
              if (alive) {
                // El `setRem(locked.snapshot)` que había acá también se fue a `aterrizar` (`:208`): es el MISMO motivo que el de arriba, y acá pesa más porque el snapshot que vale es el RE-COTIZADO, no el que trajo el resume. Δ0 de líneas.
                // AC-5: indicador solo si el monto cambió; NUNCA re-pide escanear DNI (state.kyc intacto).
                if (prev && locked.snapshot.quote && prev.minor !== locked.snapshot.quote.receive.minor) {
                  setRateUpdated(true); // ⚠️ ESTE SÍ SE PRENDE AUNQUE EL GATE FRENE, y es correcto: el indicador se pinta en `confirm`, o sea recién cuando la persona toca el botón del aviso y llega. No afirma nada sobre la pantalla en la que está ahora.
                }
                aterrizar("confirm", locked.snapshot);
              }
            } catch {
              if (alive) aterrizar("confirm", res.snapshot); // el paso confirm ofrece Recotizar (onRelock) si falta quote/expiró. El snapshot es el del resume porque el re-quote NO llegó a existir.
            }
          }
        } else {
          // 🔴 EL SEGUNDO CAMINO QUE EL FIX-PACK 2 DEJÓ ABIERTO, CERRADO ACÁ (WKH-063 · fix-pack 3). Eran tres sentencias sueltas —`setRem` + `setStep("verify")` + `setError`— y ninguna pasaba por el gate: medido, tocar «Recuperar» en la ventana y recibir después un `failed` reemplazaba la pantalla elegida por `verify` con los controles `["¿No sos vos?", "Verificar mi identidad"]`, indistinguible del caso en que la persona no tocó nada. Las tres viven ahora en `aterrizar` (`:208`), que decide. Δ0 de líneas: esta línea y las dos de abajo reemplazan a las tres que había.
          // ⚠️ EL COPY DEL AVISO NO PUEDE SER EL DE `passed` EN ESTA RAMA, y de eso se ocupa `:757`: "tu verificación quedó lista" sería falso acá. La variante dice que necesita otro intento y su botón lleva a `verify`, que es donde se reintenta.
          aterrizar("verify", res.snapshot, "La verificación no pasó. Probá de nuevo.");
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
  }, [c]); useVueltaPorEnlace({ c, yaInteractuo: yaInteractuoRef, alConectar: (r) => { setAddress(r.address); if (r.estado !== "listo") { window.location.href = r.irA; return; } setServerVerdict(r.serverVerdict); setKycProof(r.kycProof); }, alFallar: (causa) => setError({ message: humanError(causa) }), alReanudar: (r) => { if (r.estado === "hay-que-salir") { window.location.href = r.irA; return; } setRem(r.remesa.snapshot); setStep(r.remesa.status === "settled" ? "done" : "track"); }, alAvisar: (m) => setError({ message: m }), alSaberDelNonce: setEstadoNonce }); // WKH-358/AC-1+AC-3+AC-5 — EN ESTA LÍNEA (Δ0 de citas, `:44`). El cuerpo vive al FINAL del archivo, con todo su razonamiento, por lo que dice el comentario de `:44`: ~60 líneas acá adentro corren las 131 citas por número que este archivo recibe. ⛔ La causa se traduce con `humanError` y NUNCA se escribe una causa del enlace como literal en este archivo (el candado de copy de `deeplink-callers.test.ts` cuenta los que aparecen en `src/presentation`). ⛔ Y NO hay ningún `setRem`: el gate del pisón vive adentro del hook y esto sólo repuebla lo que `onConnect` repuebla

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
      const rc = await c.connectWallet.execute(); if (rc.estado === "hay-que-salir") { window.location.href = rc.irA; return; } const { // WKH-359/AC-3 — LA NAVEGACIÓN, EN ESTA LÍNEA Y SIN AGREGAR NINGUNA (Δ0: `:330` recibe 75 citas ancladas y `:507`/`:521`, que están más abajo, 55 y 52). Igual que las otras dos suspensiones de esta pantalla, acá SÓLO se navega: la URL viene armada por el protocolo de la billetera y no se parsea, no se reescribe, no se le agrega nada
        address: addr,
        rememberedKyc,
        serverVerdict,
        kycProof: proof,
      } = rc;
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
  const onContinue = () => setStep("verify"); const mirarLaCuentaDeNonce = async (direccion: string) => { setEstadoNonce(await c.recorridoPorEnlace.estadoDeLaCuentaDeNonce(direccion)); }; const onVolverAMirarLaCuentaDeNonce = () => guard(async () => { const dir = await c.connectedWallet.getConnectedAddress(); if (dir !== null) await mirarLaCuentaDeNonce(dir); }); const onCrearCuentaDeNonce = () => guard(async () => { if (rem === null) return; yaInteractuoRef.current = true; const dir = await c.connectedWallet.getConnectedAddress(); if (dir === null) return; window.location.href = (await c.recorridoPorEnlace.crearCuentaDeNonce({ direccion: dir, remittanceId: rem.id })).irA; }); // WKH-358/AC-5 — LOS TRES EN ESTA LÍNEA (Δ0 de citas, `:44`). ⚠️ `onCrearCuentaDeNonce` marca `yaInteractuoRef` porque ES una interacción de la persona: sin eso, un resume que resuelva mientras ella está en la app de la billetera navegaría por encima al volver. ⛔ La dirección sale de `getConnectedAddress()` y NO de `address`: en el camino por enlace el estado de React se pierde en el salto y el puerto lee el disco

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
    // WKH-354/AC-2. Se le pregunta a la billetera VIVA, no al `useState`. El `address ??` que estaba
    // acá cacheaba la primera cuenta para siempre: cambiar de cuenta en Phantom sin recargar dejaba
    // estas tres puertas hablando de la cuenta vieja.
    //
    // El fallback ante `null` es CONECTAR y no "servir la vieja", y eso es deliberado: `null` es "no
    // hay ninguna billetera conectada" (`ConnectedWalletProbe`, `../application/ports.ts:541`).
    // Servir la vieja ahí mandaría a `LostEscrowRecovery` a pedirle al store durable una prueba de
    // posesión firmada por una dirección que nadie tiene conectada: una firma condenada, que es justo
    // lo que esta HU vino a evitar.
    const live = await c.connectedWallet.getConnectedAddress();
    const addr = live ?? (await c.connectWallet.execute()).address;
    setAddress(addr);
    return addr;
  }, [c]);

  const openHistory = () =>
    guard(async () => {
      const addr = await resolveSender();
      setHistory(await c.listHistory.execute(addr));
      setStep("history");
    });

  // WKH-063/AC-4 — tocar una pestaña de la barra. `history` NO es un `setStep` y nunca lo fue: la
  // lista está scopeada por dueño, así que hay que resolver la billetera y pedirla ANTES de tener
  // pantalla que mostrar (por eso pasa por `openHistory`, con su `guard`). Los otros dos destinos no
  // le preguntan nada a nadie: son estado local. ⛔ Y NINGUNO mueve plata — es la contracara de la
  // regla de la barra: si una pestaña necesitara una firma para renderizarse, sería una acción
  // disfrazada de destino. El `setError(null)` es porque el error en pantalla habla de la pantalla que
  // se está dejando.
  const irADestino = (destino: Destino) => { yaInteractuoRef.current = true; // WKH-063 (fix-pack 2, renombrado en el 3): el ref se marca ACÁ ARRIBA, antes del `return openHistory()`, porque "Mis envíos" sale por esa rama y también es una interacción. Por eso `openHistory` (`:412`) no lleva marca propia: no tiene otro llamador. Δ0 de líneas (`:44`).
    if (destino === "history") return openHistory();
    setError(null);
    setStep(destino);
  };

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
        typeof window !== "undefined" ? urlDeVueltaDeKyc(window.location.origin) : undefined; // HU-066: era el literal del callback escrito acá. La puerta del splash tiene que reconocer ESE parámetro para no pintarse encima del aterrizaje del KYC, así que el string se escribe en UN solo lugar ((`urlDeVueltaDeKyc`, `./splash-puerta.ts:54`)) y los dos lo leen de ahí
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
      // ── WKH-354/AC-3 · guard ANTES de pedir NINGUNA firma ────────────────────────────────────
      // Este guard es de EXPERIENCIA, no de seguridad, y decirlo importa para que nadie lo lea al
      // revés en un AR: la seguridad ya está y es criptográfica. Un challenge de PoP emitido para A
      // firmado con la clave de B no valida contra la pubkey de A (`app/api/payout/prepare/route.ts`,
      // ed25519), el `prepare` contesta 403 `payout_pop_unverified`, y `confirm-and-send.ts` corta
      // ANTES de `authorizePrincipal`. Eso está medido y candado en T-354-5, que corre a nivel
      // use-case y SIN este guard. Lo que este guard evita es el POPUP DE FIRMA CONDENADO y el
      // "no pudimos preparar tu pago. Intentá de nuevo" que reintentaba para siempre.
      //
      // ⚠️ Y NO LO EVITA SIEMPRE: hay un residuo, y va acá porque el párrafo de arriba afirmaba sin
      // condiciones (AR r4 · MENOR-4). Este guard sólo puede acusar lo que el bridge le cuente, y el
      // bridge se alimenta del `publicKey` del adapter. En `@solana/wallet-adapter-phantom` 0.9.29
      // (`node_modules/@solana/wallet-adapter-phantom/lib/cjs/adapter.js:48-63`), el handler de
      // `accountChanged` sale SIN tocar `_publicKey` en dos ramas: cuando no había `_publicKey`
      // previa, y cuando el `new PublicKey(newPublicKey.toBytes())` tira (ahí emite `error` y
      // retorna). En esa segunda rama el bridge sigue diciendo A, el banner de `CuentaCambiada` no se
      // pinta, este guard no dispara, y el popup sale igual.
      //
      // 🚧 SUPUESTO NO MEDIDO, declarado como tal: no pudimos reproducir con QUÉ argumento emite
      // Phantom ese evento cuando la cuenta nueva no es usable, así que NO sabemos si esa rama es
      // alcanzable en la práctica ni con qué frecuencia. Lo que sí está leído es el código del
      // adapter. Quien vaya a cerrarlo: lo que falta medir es el evento, no la rama.
      //
      // 🔵 NO ES TAUTOLÓGICO: la izquierda es el bridge, por el puerto inyectado; la derecha es el snapshot persistido por `r.startKyc` (`../domain/remittance.ts:270`). Fuentes independientes, y ninguna de las dos la elige el llamador. ⚠️ ESO VALE EN EL CAMINO INYECTADO Y NO EN EL DE ENLACE (fix-pack · AR/BLQ-BAJO-4): con el gate del adaptador encendido, `getConnectedAddress()` lee `Viaje.direccion` del disco, y `ownerAddress` se escribió en `startKyc` con ESA MISMA lectura ⇒ las dos mitades salen del mismo disco y el cruce es TIME-OF-CHECK, no fuente-independiente. Sigue cortando la sustitución POSTERIOR a `startKyc` (ahí `ownerAddress` ya está congelado en el repo), y no la anterior. El razonamiento entero, con su techo, está en el bloque de CD-11 de `../infrastructure/solana/deeplink/firma-por-enlace.ts`
      //
      // ⚠️ `null` NO dispara el guard (CD-17): `null` es "no hay ninguna billetera conectada", nunca
      // "cambió la identidad". Acusar ahí convertiría un árbol todavía sin montar en una acusación
      // falsa y rompería media suite. Ídem `rem.ownerAddress == null`: no hay contra qué comparar.
      const live = await c.connectedWallet.getConnectedAddress();
      const cruce = cruceDeCuenta(live, rem.ownerAddress ?? null); if (seVerificoLaCuenta(cruce) && live != null && rem.ownerAddress != null) { // WKH-359/AC-6 — EL TRI-ESTADO, EN LA LÍNEA QUE EXISTE (⛔ Δ0: hay 55 citas ancladas de acá para abajo). El `if` mudo de antes hacía que "no se comparó" fuera indistinguible de "se comparó y coincidió"; ahora el caso `null` produce un valor con nombre y ⛔ `seVerificoLaCuenta` contesta `false` para los DOS. ⚠️ RESIDUAL SIN SUAVIZAR ([NC-1]): esto NO es un evento observable en producción y esta HU no inventa uno — el razonamiento entero, y por qué el caso `null` NO se convierte en corte, está en el docblock de (`CruceDeCuenta`, `./flow-vm.ts:1531`)
        // 🚫 NUNCA `.toLowerCase()` (CD-6): base58 es CASE-SENSITIVE y bajarlo a minúsculas fabrica
        // colisiones. `canonicalizeAddress` TIRA ante lo que no parsea, y eso se trata como
        // DESACUERDO (fail-closed), igual que `close-escrow-accounts.ts:75-80`: una dirección que no
        // podemos parsear es una que no podemos probar que sea la misma.
        let mismaCuenta: boolean;
        try {
          mismaCuenta = canonicalizeAddress(live) === canonicalizeAddress(rem.ownerAddress);
        } catch {
          mismaCuenta = false;
        }
        if (!mismaCuenta) throw new Error("wallet_account_changed");
      }
      const res = await c.confirmAndSend.execute({ remittanceId: rem.id }); // WKH-356: TRES desenlaces
      if (res.estado === "hay-que-salir") { window.location.href = res.irA; return; } // AC-1 — SÓLO navegar, igual que el redirect a Didit de `:457-461` (decía `:428-432`, que es donde vivía en `ce4f31e`: CR/BLQ-BAJO-1). La URL ya viene armada por el protocolo de la billetera: acá NO se parsea, NO se reescribe, NO se le agrega ningún parámetro. La remesa quedó persistida en `confirmed`, que es el estado que la reanudación vuelve re-ejecutable (AC-3). ⛔ Δ0 OBLIGATORIO en estas tres líneas: medido el 2026-08-17 con la definición de `:44`, hay 54 líneas destino de este archivo citadas por número más abajo (84 ocurrencias), y una línea de más las rota a todas en silencio
      setRem(res.remesa.snapshot); setStep(res.remesa.status === "settled" ? "done" : "track");
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
      setStep("bienvenida"); // fix-pack AR/BLQ-BAJO-1: decía `"send"`, y hasta WKH-063 eso ERA el inicio. Hoy `send` es el paso 1 de un envío, así que un dispositivo recién limpiado ("no soy yo" + "Borrar igual") aterrizaba EN EL MEDIO DEL FORMULARIO, con "Paso 1 de 4" arriba y sin barra. `bienvenida` es el destino de entrada y es lo que este gesto significa: volver al principio. Lo camina `T-063-23`
      setConfirmReset(false);
    });

  // WKH-354/AC-6 · adoptar la cuenta que la billetera tiene activa AHORA, sin destruir nada.
  //
  // 🔴 ES OTRO GESTO QUE "Borrar igual" (DT-5), y la diferencia no es de matiz: aquél existe para
  // "no soy yo, quiero un dispositivo limpio" y borra el KYC y las entries del owner
  // (`forgetAndDisconnect`, acá arriba). Éste NO llama a `ForgetKyc.execute()` ni a
  // `repo.clearByOwner()` (CD-8), ni de la cuenta vieja ni de la nueva.
  //
  // Reusa `ConnectWallet` y no un use-case nuevo, por tres razones medidas: (a) es el único llamador
  // que refresca LAS DOS cachés — la de React vía `setAddress` y la del adapter vía `connect()`;
  // (b) resuelve el KYC POR DIRECCIÓN con el camino ya probado (`connect-wallet.ts:58-85`), así que
  // si la cuenta nueva ya estaba verificada se reconoce sola (AC-4); y (c) su constructor NO recibe
  // `RemittanceRepository`, o sea que `clearByOwner` está fuera de su alcance POR TIPO y no por
  // disciplina.
  //
  // Se asignan las MISMAS tres cosas que `onConnect` saca del resultado (`address`, `serverVerdict`,
  // `kycProof`) y ninguna más: lo que `onConnect` hace después (lockQuote + el atajo KYC-once) es
  // sobre la remesa EN CURSO, y acá esa remesa se descarta. El envío nuevo vuelve a pasar por
  // `onConnect` entero, así que el KYC-once de la cuenta adoptada se resuelve por el mismo camino de
  // siempre y no por una copia de acá.
  //
  // ⚠️ Si hay una remesa en vuelo, SE RESETEA (CD-18). Esa remesa tiene `ownerAddress = A`, con quote
  // y KYC de A: conservarla bajo la sesión B la dejaría en un callejón (el guard de `onConfirm` la
  // bloquearía para siempre) y, peor, sería el primer paso del camino que CD-1 prohíbe. Un envío con
  // otra cuenta es un envío nuevo, y el copy del banner lo dice.
  //
  // 💸 R-1 · EL GESTO CUESTA DOS FIRMAS, y vive acá porque hasta ahora vivía sólo en el SDD, que está
  // gitignoreado y desaparece al mergear. `c.connectWallet.execute()` de abajo pide una (la prueba de
  // posesión con la que se consulta el veredicto, `ensure`, `../application/use-cases/connect-wallet.ts:120`)
  // y el `onConnect` del envío nuevo pide la otra. ⛔ NO se cachea la primera para ahorrarse la
  // segunda: `http-pop-signer.ts:43-49` prohíbe reusar una prueba guardada para saltarse un popup del
  // money-path. El costo está aceptado por el founder; lo que NO está resuelto es que el copy del
  // banner no lo anticipa (dice "Podés pasarte a ella sin perder nada" y no habla de firmas).
  const adoptarCuentaConectada = () =>
    guard(async () => {
      const r = await c.connectWallet.execute();
      setAddress(r.address); if (r.estado === "hay-que-salir") { window.location.href = r.irA; return; } // WKH-359/AC-3 — EN ESTA LÍNEA (Δ0: este archivo recibe 83 citas ancladas). La dirección se aplica IGUAL antes de salir, porque el `connect()` ya corrió y ya la conocemos: perderla obligaría a re-conectar al volver del salto
      setServerVerdict(r.serverVerdict);
      setKycProof(r.kycProof);
      if (rem) resetTo(setStep, setRem, setPreview); // → paso `send`
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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col pb-segura-b pl-segura-l pr-segura-r pt-segura-t">
      <header className="mb-aire flex flex-wrap items-center gap-ajustado">
        <ChaskiMark className="h-icono-lg w-auto" />
        <div>
          {/* Tres clases se fueron y ninguna se reemplazó por otra:
              · `leading-none` — en 40f0b68 era el ÚNICO interlineado declarado de todo el árbol, y
                el rol `title` ya trae el suyo (1.3).
              · `tracking-heading` — el rol también declara el suyo (-0.02em). ⚠️ Y NO SE DEJARON LOS
                DOS: `cn` no los resuelve (son grupos distintos para `tailwind-merge`, así que
                sobreviven ambos) y cuál gana lo decide el orden en que Tailwind emite las reglas,
                que no lo elige nadie. Es exactamente el defecto que `cn.ts` documenta para `p-4`.
              · `text-[15px]` — pasa a `title` (17px), que es el rol de un título de pantalla. */}
          <h1 className="text-title font-bold">Chaski</h1>
          <Muted escala="label">{LEMA}</Muted>{/* HU-066: era el literal `tu plata a Perú, sin vueltas` escrito acá. El splash lo repite, y dos literales idénticos en dos archivos son cómo uno se corrige y el otro no. La constante vive en `./marca.ts` */}
        </div>
        {/* ⚠️ WKH-354 (re-AR · MENOR-2) · ESTE PILL SE PINTA CON `address` Y NO CON LA BILLETERA VIVA,
            y desde esta HU eso alcanza estados nuevos: tras volver de Didit, `address` se repuebla con
            el `ownerAddress` del snapshot, así que el pill declara una cuenta aunque la billetera haya
            quedado DESCONECTADA. El banner de `CuentaCambiada` no lo matiza porque exige `viva != null`.
            Las dos lecturas, y por eso no se cambió nada:
              · defendible — mientras la conexión automática no terminó, "estás operando como A" es
                cierto: A es el dueño de la sesión que se retomó, y ninguna acción monetaria pasa sin
                que el guard de `onConfirm` vuelva a leer la billetera viva.
              · incómoda — el pill parece decir "conectado", y no hay firma posible en ese instante.
            Si alguien decide que hay que distinguirlos, el cambio es de ESTE ternario, no del banner. */}
        {address ? (
          <div className="ml-auto flex flex-col items-end gap-1">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-sand px-2.5 py-1 text-label font-semibold text-ink">
              {/* `h-1.5 w-1.5` NO entra en la escala de íconos de S-4 y se queda: no es un ícono,
                  es el punto de estado de la píldora. Meterlo ahí sería contar mal para que el
                  número cerrara, que es lo que el propio docblock de `size` declara. */}
              <span className="h-1.5 w-1.5 rounded-full bg-verde"></span>
              {address.slice(0, 6)}…{address.slice(-4)}
            </span>
            {confirmReset ? (
              <div className="max-w-[15rem] space-y-ajustado text-right text-label text-stone">
                <ResetWarning items={history} />
                <div className="flex items-center justify-end gap-ajustado">
                  <button
                    type="button"
                    onClick={forgetAndDisconnect}
                    disabled={busy}
                    className="inline-flex min-h-[44px] items-center px-2 font-semibold text-cochineal underline underline-offset-2"
                  >
                    Borrar igual
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    className="inline-flex min-h-[44px] items-center px-2 text-stone underline underline-offset-2"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={onAskReset}
                className="inline-flex min-h-[44px] items-center px-2 text-label text-stone underline underline-offset-2"
              >
                ¿No sos vos?
              </button>
            )}
          </div>
        ) : null}
        <CuentaCambiada sesion={address} enVuelo={rem != null} onAdoptar={adoptarCuentaConectada} disabled={busy} />
      </header>
      {/* WKH-063 · EL STEPPER NO SE PINTA EN LOS DESTINOS, y no es cosmética: dice "Paso 1 de 4"
          sobre pantallas que no son un paso de nada. En la de bienvenida era además la primera cosa
          que la persona veía —una barra de progreso de un envío que todavía no empezó—, que es la
          mitad del defecto que AC-1 vino a cerrar. `STEP_INDEX` sigue teniendo fila para los tres
          destinos: el tipo la exige y borrarla no compila. Lo que cambia es quién la lee. */}
      {esDestino(step) ? null : (<div className="mb-aire">
        <Stepper steps={STEP_LABELS} current={STEP_INDEX[step]} />
      </div>)}
      {avisoKyc !== null ? (<Aviso tono={avisoKyc.destino === "verify" ? "atencion" : "bueno"} className="mb-holgado text-body"><span className="block font-semibold">{avisoKyc.destino === "verify" ? "Tu verificación necesita otro intento" : "Tu verificación quedó lista"}</span><span className="mt-ajustado block">No te sacamos de esta pantalla porque la estabas usando vos. El envío que dejaste a medias sigue guardado.</span><Button variant="outline" className="mt-normal" onClick={() => { const a = avisoKyc; setAvisoKyc(null); setRem(a.snapshot); if (a.error !== undefined) setError({ message: a.error }); setStep(a.destino); }}>{avisoKyc.destino === "verify" ? "Reintentar la verificación" : "Seguir con ese envío"}</Button></Aviso>) : null}{/* 🔴 WKH-063 (fix-pack 2, con SUS DOS CAMINOS ABIERTOS CERRADOS EN EL 3) · EL AVISO QUE REEMPLAZA AL PISÓN, y es NO MODAL a propósito: no tapa nada, no roba el foco y no navega. Se prende cuando el resume terminó y `yaInteractuoRef` (`:175`) está en `true`, o sea cuando antes había una navegación no pedida. 🔴 SON DOS VARIANTES Y NO UNA (fix-pack 3), porque el resume tiene dos desenlaces terminales y el `failed` también pisaba: con `destino === "verify"` el título NO puede decir que la verificación quedó lista, y el `tono` tampoco puede ser `bueno` (el verde de esta app es el del dinero que llega). La segunda frase es la MISMA en las dos ramas a propósito, y por eso dice "la estabas usando" y no "la habías elegido": el fix-pack 3 sumó el embudo, donde la persona no eligió un destino con la barra sino que entró a tipear, y "elegido" habría sido falso en ese camino. ⛔ EL BOTÓN NO ES DECORACIÓN, y desde el fix-pack 3 es más que un `setStep`: APLICA EL SNAPSHOT (`setRem`) que `aterrizar` (`:208`) no aplicó. Es el único camino de vuelta medido — la barra sólo ofrece los tres destinos, "Empezar un envío" crea una remesa NUEVA, y "Mis envíos" tampoco sirve para una remesa sin depósito autorizado, que se lista SIN control de fila (`openable`, `:3412`). ⚠️ VA ACÁ Y NO ABAJO DEL BLOQUE DE ERROR: a 375x667 las tres pantallas de destino miden más que el viewport (medido en el encabezado de `recuperar-composicion.test.tsx`), así que un aviso puesto al lado de la barra nace debajo del pliegue. ⛔ Δ0 DE LÍNEAS: entra en la línea en blanco que había acá, por las citas por número de este archivo (`:44`). */}{estadoNonce !== null ? (<TarjetaDeCuentaDeNonce estado={estadoNonce} ocupado={busy} onCrear={onCrearCuentaDeNonce} onVolverAMirar={onVolverAMirarLaCuentaDeNonce} onSeguirSinCrearla={() => setEstadoNonce(null)} />) : null}{/* WKH-358/AC-5 — EN ESTA LÍNEA (Δ0 de citas, `:44`) y ACÁ ARRIBA, junto al aviso del KYC, por el mismo motivo que ése: a 375x667 las pantallas miden más que el viewport, así que algo puesto al final nace debajo del pliegue. El componente vive al FINAL del archivo, con todo su razonamiento. ⛔ «Seguir sin crearla» sólo apaga la tarjeta y NO limpia nada: el corte del adaptador por cuenta de nonce ausente sigue siendo el cinturón y trae a la persona de vuelta a esta misma oferta */}
      {rem && isDemoMode(rem) && (step === "review" || step === "confirm" || step === "track" || step === "verify") ? (
        <div className="mb-holgado flex items-center justify-center">
          <Pill tone="prueba">{DEMO_PILL}</Pill>
        </div>
      ) : null}

      {resuming ? (
        <Card className="mt-ajustado flex-1 space-y-holgado text-center">
          <Loader2 className="mx-auto mt-aire size-icono-lg animate-spin text-cochineal" />
          <div>
            <h2 className="text-title font-bold">Verificando tu identidad…</h2>
            {/* "con Didit" se cayó: con `DIDIT_ENV=mock` la persona vuelve de `/kyc-simulado`, que es
                una página nuestra, y este overlay le decía que estábamos hablando con un proveedor que
                nadie llamó. Esta pantalla no puede distinguir las dos configuraciones (el navegador no
                ve `DIDIT_ENV`), así que dice lo que vale en las dos. */}
            <Muted className="mx-auto mt-ajustado max-w-xs">
              Estamos confirmando tu verificación. Un segundo.
            </Muted>
          </div>
          {showResumeEscape ? (
            <div className="space-y-ajustado">
              <Muted>¿No completaste la verificación?</Muted>
              <Button variant="outline" onClick={onCancelResume}>
                Empezar de nuevo
              </Button>
            </div>
          ) : null}
        </Card>
      ) : timedOut ? (
        <Card className="mt-ajustado flex-1 space-y-holgado text-center">
          <div>
            <h2 className="text-title font-bold">La verificación está tardando</h2>
            <Muted className="mx-auto mt-ajustado max-w-xs">
              No pudimos confirmar tu identidad a tiempo. Podés reintentar sin recargar la página.
            </Muted>
          </div>
          <Button onClick={onRetryKyc}>Reintentar</Button>
        </Card>
      ) : (
      <MotionConfig reducedMotion="user"><AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.22 }}
          className="flex flex-1 flex-col"
        >{/* WKH-063 (2º pase) · `flex flex-col` ENTRA EN LA LÍNEA DE ARRIBA Y NO EN UNA NUEVA, y este comentario cuelga del `>` por lo mismo: este archivo recibe muchas citas por número y una línea de más corre todas las que apuntan más abajo (el número y su definición están en `:44`, medidos UNA vez; acá decía "74", copiado de allá cuando allá ya era falso, que es el antipatrón que el auto-blindaje de esta HU prohíbe). 🔴 POR QUÉ HACÍA FALTA, medido sobre el build de producción con Chrome a 412x915: la bienvenida tenía 381px de vacío entre el CTA y la barra (42% del viewport), y para centrar su bloque hacía falta una altura contra la que centrarse. `min-h-full`/`h-full` en el hijo NO SIRVEN, y está MEDIDO y no razonado: con este `<div>` en `flex-1` a secas, el hijo con `min-height:100%` medía 644px dentro de un padre de 728px, o sea que la clase emitía una regla que resolvía a nada. Es el peor modo de falla posible (compila, se ve igual, no hace nada), el mismo que el docblock de `borderRadius` en `tailwind.config.ts` describe para un `rounded-xl2` olvidado. Con el padre en `flex flex-col`, un hijo que pide `flex-1` sí se estira a los 728px. ⛔ ESTO NO CENTRA NADA POR SÍ SOLO: el `justify-center` y el `flex-1` viven en el hijo (`Bienvenida`, `bienvenida.tsx:175`), así que las demás pantallas siguen ancladas arriba, que es lo que un formulario tiene que hacer. Los otros pasos pasan de bloque a ítem flex SIN cambiar de alto: un ítem flex sin `flex-grow` mide su contenido, y cada rama de acá abajo renderiza UN solo elemento. */}
          {step === "send" && (
            <div className="space-y-holgado"><VolverAlInicio onVolver={() => setStep("bienvenida")} disabled={busy} />{/* WKH-063 · LA ÚNICA SALIDA DEL FLUJO HACIA LOS DESTINOS, y sin ella la barra sería una trampa: los pasos del envío no la pintan (AC-3), así que quien entra al formulario se quedaba sin ninguna forma de volver a "Mis envíos" o a "Recuperar" salvo recargar la página. Va SÓLO en `send` y no en los pasos siguientes a propósito: de `connect` en adelante hay una cotización fijada y una identidad en juego, y ahí "volver al inicio" no es navegar, es abandonar algo empezado. ⚠️ ESA JUSTIFICACIÓN CUBRE 5 DE LOS 6 PASOS, NO LOS 6 (fix-pack, AR/MNR-5): a `track` y a `done` también se llega ABRIENDO UN ENVÍO VIEJO desde "Mis envíos" (`onOpenFromHistory`, `:435-439`), y en ESE camino no hay nada empezado que abandonar — la persona venía de un destino a mirar un envío que ya pasó. Medido: desde ahí no hay barra (son pasos del flujo) y `track` no expone ninguna salida NO DESTRUCTIVA. ⚠️ ACÁ DECÍA "no expone NINGÚN control de salida", y afirmaba de menos (fix-pack 2 · AR-it2/MNR-2): censo de botones de `track` abierto desde el historial, medido en jsdom ⇒ `["¿No sos vos?", "Recuperar fondos"]`. El primero SÍ saca de la pantalla, pero es el gesto de dispositivo limpio (borra el KYC de la address y la PII del beneficiario), así que ofrecerlo como forma de "dejar de mirar un envío viejo" es peor que recargar; el segundo no sale de `track`. Lo que se puede afirmar es que no hay salida barata, no que no haya ninguna. El dead-end es PRE-EXISTENTE a WKH-063 (`flow-vm.ts:946-949` ya lo tenía medido y escrito para el seguimiento); lo que esta HU agregó encima es la justificación de arriba, que no describe este camino. ⛔ NO SE ARREGLA ACÁ, y el motivo es el mismo que el de AR/MNR-3: poner `VolverAlInicio` en `track` mezcla dos entradas con significados opuestos ("abandonar el envío que estoy haciendo" y "dejar de mirar uno viejo") y decidir bien qué dice el control en cada una es diseño, no un renglón de fix-pack. Queda como defecto ABIERTO y sin candado. No borra nada de lo escrito en el formulario (sólo mueve `step`), así que volver a entrar devuelve el monto y el destino tal como estaban. */}
              <Card>
                <Field label="Enviás">
                  {/* 🔴 EL ÚNICO SITIO DE LA APP DONDE LA MONEDA PUEDE PESAR MENOS QUE LA CIFRA, y no
                      es una preferencia: acá el símbolo ya vive en su propio `<span>` porque el
                      `<input>` sólo contiene dígitos. En los otros cuatro sitios el número llega de
                      `Money.format()`, que devuelve símbolo y dígitos PEGADOS en un solo string
                      ("S/1,500.00"), y hay dos asserts que exigen que ese string sea UN nodo de texto
                      directo (`getByText(/^S\/[\d,]+\.\d{2}$/)` y `getByText("S/1,500.00")`, los dos
                      en `flow.test.tsx`). Partirlo en dos `<span>` los rompe, y uno de los dos es el
                      guard de que la pantalla nunca muestre "S/0.00". No se debilita un guard del
                      money-path para conseguir un matiz tipográfico.
                      Se replica a mano la composición de `<Money>` (moneda en `title` + `semibold` +
                      opacidad, cifra en `money` + `extrabold`) porque el componente no puede envolver
                      un `<input>`: sus hijos van adentro de un `<span>`. */}
                  <div className="flex items-baseline gap-ajustado">
                    <span className="text-title font-semibold text-stone opacity-70">$</span>
                    <input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                      inputMode="decimal"
                      className="w-full bg-transparent text-money font-extrabold tabular-nums outline-none"
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
                  <p className="mt-ajustado text-label font-medium text-cochineal" role="alert">
                    El mínimo para enviar es ${MIN_SEND_USD}. Por debajo de eso no cotizamos el
                    envío.
                  </p>
                ) : null}
                {/* Una de las tres cajas verdes que S-3 midió. `Aviso tono="bueno"` emite la MISMA
                    superficie: `bg-verde-bg`, `rounded-control` (=`rounded-xl`, los dos 0.75rem),
                    `px-holgado` (=`px-4`) y `py-normal` (=`py-3`). Cero pixeles de diferencia. */}
                <Aviso tono="bueno" className="mt-holgado">
                  <p className="text-label font-medium text-verde/80">Tu familia recibe</p>
                  {estadoCotiza === "pidiendo" ? (<span role="status" aria-label="Calculando cuánto recibe tu familia" className="my-ajustado block h-9 w-44 animate-pulse rounded-control bg-verde/15" />) : (<Money tono="verde">{preview ? preview.receive.format() : "—"}</Money>)}{/* H2 · POR QUÉ UN BLOQUE QUE PALPITA Y NO EL GUIÓN. Medido en producción el 2026-08-16: la cifra tarda 3661 ms desde que arranca la navegación (300 ms de debounce + la ida al corredor). Durante casi cuatro segundos, el número más importante de la pantalla era un guión dentro de una caja verde grande, y eso no se lee como "estoy calculando": se lee como roto. El guión SIGUE siendo el valor correcto para "corto" (el monto no llega al mínimo, no se pidió nada) y para "falla" (ahí además hay una frase abajo que dice qué pasó). ⚠️ El `aria-label` no es adorno: un `<span>` vacío no tiene texto que anunciar, y sin él quien usa lector de pantalla no se entera de que hay algo en curso. */}
                  {/* "llega en ~N min" prometía una entrega que este sistema no puede cumplir hoy: la
                      release del vault la dispara una persona a mano y la propia pantalla de
                      seguimiento avisa que "puede quedarse acá un buen rato". El número no se borra
                      (es un dato del corredor y sirve para comparar), se le pone dueño: lo estima él,
                      no lo promete Chaski. Mismo criterio en las filas de review y confirm. */}
                  {estadoCotiza === "falla" ? (<p className="mt-ajustado text-label text-cochineal">No pudimos calcular la tasa ahora. Revisá tu conexión: el monto vuelve a cotizarse solo cuando lo cambies.</p>) : preview ? (
                    <p className="mt-ajustado text-label text-verde/70">
                      1 USD ≈ S/ {preview.rate.toFixed(3)} · el corredor estima ~{preview.etaMinutes}{" "}
                      min
                    </p>
                  ) : null}
                </Aviso>
              </Card>

              <Card className="space-y-normal">
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
                  {/* La MISMA receta que la etiqueta de `<Field>`, escrita a mano acá porque este
                      bloque no es un campo (no envuelve ningún control). Se migra igual que aquélla
                      para que no queden dos etiquetas de campo con dos tamaños. */}
                  <span className="mb-ajustado block text-label font-medium text-stone">¿Cómo recibe?</span>
                  {OFFERED_PAYOUT_METHODS.map((m) => (
                    <p
                      key={m}
                      className="rounded-control border border-line bg-sand px-3.5 py-2.5 text-body font-semibold text-ink"
                    >
                      {OFFERED_METHOD_COPY[m]}
                    </p>
                  ))}
                  <Muted escala="label" className="mt-ajustado">
                    Chaski no manda a Yape ni a Plin. Deposita a una cuenta bancaria.
                  </Muted>
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
                  <p className="text-label font-medium text-cochineal-ink">
                    Un CCI tiene 20 dígitos y este tiene {cciDigits(destination).length}. Los
                    espacios y los guiones no cuentan.
                  </p>
                ) : null}
              </Card>

              <Button disabled={!canSend || busy} onClick={onSend}>
                Continuar <ArrowRight className="size-icono-sm" />
              </Button>

              {/* WKH-063 · ACÁ VIVÍAN LAS TRES PUERTAS, Y SE FUERON ENTERAS. El grupo "¿Ya enviaste
                  antes?" tenía "Ver mis envíos", `<LostEscrowRecovery>` y `<EscrowRentRecovery>`: hoy
                  la primera es la pestaña "Mis envíos" de la barra y las otras dos viven en el destino
                  "Recuperar" (`DestinoRecuperar`). ⛔ NO QUEDÓ NINGÚN FALLBACK REDUCIDO, y es una
                  decisión: dejar la barra Y los enlaces duplica la entrada a los mismos dos destinos,
                  o sea que la pantalla vuelve a ofrecer cuatro caminos donde hay un formulario. La
                  medición que motivó el grupo sigue valiendo y ahora se cumple por construcción: en
                  esta pantalla «Continuar» es la única acción con el peso del CTA porque es la única
                  acción. El `min-h-[52px]` de las tres NO se relajó — se mudó con ellas, y
                  `touch-targets.test.tsx` las sigue midiendo donde están (la pestaña, en
                  `barra-destinos.tsx`; las otras dos, en su propio componente, intactas). */}
            </div>
          )}

          {step === "connect" && (
            <div className="space-y-holgado">
              <Card className="space-y-holgado text-center">
                {/* `h-14 w-14` NO es un tamaño de ícono y por eso no está en la escala de S-4: es el
                    círculo que lo CONTIENE. El ícono de adentro sí migró. */}
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-sand">
                  <Wallet className="size-icono-md text-cochineal" />
                </div>
                <h2 className="text-title font-bold">Conectá tu wallet</h2>
                {/* La segunda de las tres cajas verdes de S-3. ⚠️ Ésta tenía `py-2.5` (10px) y las
                    otras dos `py-3` (12px): tres cajas del mismo tono en tres paddings distintos era
                    justo el síntoma. `Aviso` las deja en uno solo, así que acá el alto crece 2px por
                    lado. `text-left` va como `className` porque la disposición del contenido la pone
                    el sitio de llamada: es lo que en las tres cambia. */}
                <Aviso tono="bueno" className="text-left">
                  <p className="text-label text-verde/80">Vas a enviar</p>
                  {/* 🔴 LA SEXTA RECETA DE MONTO, que la lista de S-5 no tenía. El docblock de
                      `<Money>` enumeró cinco (`text-3xl` ×3, `text-4xl` ×2, `text-2xl` ×2) y ésta era
                      `tabular text-lg font-extrabold text-verde`: un séptimo sitio y un sexto tamaño.
                      Queda anotado acá porque el conteo de aquel docblock se lee como cerrado.
                      ⛔ NO pasa por `<Money>`, y el motivo es el sufijo: "en Solana devnet" comparte
                      el `<p>` con la cifra, y `<Money>` mete a sus hijos adentro de un `<span>` propio.
                      Además ésta no es la cifra héroe de la pantalla (es "lo que estás por firmar",
                      con la red al lado): a 32px taparía al CTA. Se le da el rol `title`. */}
                  <p className="tabular-nums text-title font-extrabold text-verde">
                    {rem ? rem.sendUsd.format() : "—"}{" "}
                    <span className="text-body font-medium">en Solana {resolveSolanaNetworkConfig().cluster}</span>
                  </p>
                </Aviso>
              </Card>
              {mostrarSelectorDeEnlace ? <SelectorDeEnlace onElegir={onElegirBilleteraDeEnlace} deshabilitado={busy} /> : null}{mostrarSelectorDeEnlace ? <OlvidarBilleteraDeEnlace recorrido={c.recorridoPorEnlace} deshabilitado={busy} /> : null}<NoWalletHere />{/* WKH-358 · EL SELECTOR VA ARRIBA Y `NoWalletHere` QUEDA COMO SALIDA SECUNDARIA, y las dos mitades de esa jerarquía son deliberadas. ARRIBA porque con la bandera prendida el selector es la acción resolutiva del cuadrante `none`. Y `NoWalletHere` ⛔ NO SE BORRA Y NO SE DEGRADA A NOTA AL PIE: hoy el enlace a Phantom es el ÚNICO camino por el que una persona en un teléfono completó un depósito verificado en cadena (dos del founder, 2026-08-16), mientras que el camino por enlace todavía NO cierra el depósito (WKH-359). Ofrecer primero lo que conecta y dejar debajo lo que además paga es honesto sólo mientras eso siga siendo cierto: el día que el PoP por enlace exista, esta jerarquía hay que volver a discutirla. ⚠️ `mostrarSelectorDeEnlace` lleva la bandera Y `availability === "none"` adentro (ver `:147`), así que con la bandera apagada esto es `null` y la pantalla queda BYTE-IDÉNTICA (lo mide T-065-21). H1 · POR QUÉ ACÁ ABAJO PUEDE NO HABER NINGÚN BOTÓN, y es lo contrario de un descuido. MEDIDO el 2026-08-16 en el teléfono del founder: en Chrome de Android sin wallet inyectada, lo ÚNICO que el selector ofrece es la entrada de Mobile Wallet Adapter, y tocarla no abre nada — ni siquiera pide permiso. O sea que el CTA más grande y más rojo de la pantalla llevaba a un callejón, justo debajo de un cartel que dice "no vemos ninguna wallet en este navegador". La pantalla se contradecía a sí misma, y quien la lee le cree al botón, no a la prosa. ⛔ QUITAR EL ADAPTER NO ERA LA SALIDA: no es nuestro, lo antepone `@solana/wallet-adapter-react` solo (ver el docblock de `MWA_WALLET_NAME` en `../infrastructure/solana-wallet-bridge.ts`). Lo único nuestro es si ofrecemos la puerta. ✅ QUÉ LA REEMPLAZA: `NoWalletHere` asciende "Abrir Chaski en Phantom" a acción resolutiva — el camino que SÍ está verificado en cadena (dos depósitos del founder, 2026-08-16). Un camino que funciona vale más que dos donde uno muere. 🔑 EL `!mwaEnabled()` ES LO QUE HACE HONESTA A LA BANDERA: significa "alguien ya probó MWA en un teléfono de verdad". Prendida, MWA deja de ser un callejón y el botón vuelve solo. ⚠️ NO afecta al escritorio: sin extensión `mwaEnElSelector` es `false`, así que el botón sigue estando y el selector sigue listando qué instalar. */}
              {conectarEsCallejon ? null : (<Button disabled={busy} onClick={onConnect}>
                {busy ? (
                  <Loader2 className="size-icono-sm animate-spin" />
                ) : (
                  <>
                    <Wallet className="size-icono-sm" /> Conectar wallet
                  </>
                )}
              </Button>)}
              {/* WKH-063/AC-6 · ESTAS DOS FRASES SE MOVIERON, NO SE BORRARON, y la posición ES el
                  cambio: estaban ARRIBA, entre el título y la acción, y eran el tercero de los tres
                  bloques de prosa que se leían antes de poder tocar nada. Ahora la pantalla es título
                  → cuánto vas a firmar → botón, y la honestidad queda como nota al pie, que es donde
                  no tapa la acción principal.
                  ⛔ EL TEXTO ES BYTE POR BYTE EL DE ANTES, y el tamaño también (`Muted` sin `escala`,
                  o sea `support`). Bajarlo a `label` para que "quepa mejor" abajo sería exactamente
                  "presentarlo mejor" = "verlo menos", que es lo que CD-3 prohíbe.
                  "Chaski nunca toca tu plata" es un absoluto y hay quien lo falsifica: el escrow
                  tiene una release-authority, operada por el equipo, que puede liberar el vault
                  hacia el pago (ver `confirm-and-send.ts`:191-197). Lo que sí es verificable, y es
                  lo que hace a esto no custodial, es DÓNDE quedan los USDC: en una cuenta del
                  contrato (ATA de la PDA `escrow_state`, `solana-wallet.ts`:288), nunca en una
                  billetera de Chaski. */}
              <Muted className="mx-auto max-w-xs text-center">
                Firmás el envío desde tu billetera con USDC. Tus USDC van a un contrato en Solana, no
                a una cuenta de Chaski.
              </Muted>
            </div>
          )}

          {step === "verify" && (
            <div className="space-y-holgado">
              <Card className="space-y-holgado">
                <div className="flex items-center gap-ajustado text-verde">
                  <ShieldCheck className="size-icono-md" />
                  {/* Sigue siendo un `<p>`: promoverlo a encabezado es trabajo de la ola 1 (D-3), que
                      dejó explícito qué sub-encabezados quedaban afuera y por qué. Esta ola sólo le
                      cambia el rol tipográfico. */}
                  <p className="text-body font-semibold">Verificación única</p>
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
                <Muted>
                  Por ley, verificamos tu identidad <b>una sola vez</b>. Tu documento y tu selfie no
                  se comparten con los agentes que cotizan y pagan.
                </Muted>
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
                    className="flex items-center justify-center rounded-control border border-dashed border-line bg-sand/60 py-7"
                  >
                    <ShieldCheck className="size-icono-lg text-stone" />
                  </div>
                ) : (
                  <VerificationProgress approved={scanStage >= 4} />
                )}
              </Card>
              <Button disabled={busy} onClick={onVerify}>
                {busy ? (
                  <Loader2 className="size-icono-sm animate-spin" />
                ) : (
                  <>
                    {/* La MISMA promesa que la frase de arriba, y en el elemento más grande de la
                        pantalla: "Escanear DNI + selfie" describe una acción física que con el
                        verificador simulado no ocurre. Lo que este botón hace en las dos
                        configuraciones es arrancar la verificación, y eso es lo que dice. */}
                    <ShieldCheck className="size-icono-sm" /> Verificar mi identidad
                  </>
                )}
              </Button>
            </div>
          )}

          {/* WKH-187: paso `review` pre-KYC — muestra el VALOR (cuánto recibe la familia) antes de verificar. */}
          {step === "review" && rem?.quote && (
            <div className="space-y-holgado">
              <Card>
                <div className="mb-ajustado flex items-center justify-between">
                  <h2 className="text-title font-semibold">Revisá el envío</h2>
                  <Pill tone="active">tasa fijada</Pill>
                </div>
                {/* 🔴 LA CIFRA SALIÓ DE LA CAJA GRIS (M-2). Estaba adentro de un `bg-sand` con el
                    mismo peso visual que las filas de abajo, o sea que el dato por el que la persona
                    entró a la app se leía igual que la comisión. Sin caja, lo que la separa es el
                    TAMAÑO y el aire, que es lo que una jerarquía tiene que hacer. ⛔ No se agregó
                    ninguna línea nueva debajo: el destino ya está en la fila "Recibe en" de esta
                    misma tarjeta, y repetirlo acá sería copy nueva. */}
                <div className="mb-aire mt-normal text-center">
                  <Muted escala="label">{rem.beneficiary.name} recibe</Muted>
                  <Money tono="verde" className="mt-ajustado">
                    {rem.quote.receive.format()}
                  </Money>
                </div>
                <Row label="Enviás" value={rem.sendUsd.format()} />
                <Row label="Comisión" value={rem.quote.feeUsd.format()} />
                <Row label="Tipo de cambio" value={`S/ ${rem.quote.rate.toFixed(3)}`} />
                <Row label="Estimado del corredor" value={`~${rem.quote.etaMinutes} min`} />
                <div className="my-ajustado h-px bg-line" />
                <Row label="Recibe en" value={`${methodLabel(rem.beneficiary.method)} · ${rem.beneficiary.destination}`} />
              </Card>
              <AgentPlanCard />
              <Button disabled={busy} onClick={onContinue}>
                Continuar <ArrowRight className="size-icono-sm" />
              </Button>
              <Muted escala="label" className="text-center">
                Para enviar, verificás tu identidad una sola vez (por ley).
              </Muted>
            </div>
          )}

          {/* WKH-187: paso `confirm` post-KYC — el review con badge de identidad + confirmar/relock. */}
          {step === "confirm" && rem?.quote && (
            <div className="space-y-holgado">
              {rateUpdated ? (
                <div className="flex items-center justify-center">
                  <Pill tone="active">
                    La tasa se actualizó · tu familia recibe {rem.quote.receive.format()} ahora
                  </Pill>
                </div>
              ) : null}
              <Card>
                <div className="mb-ajustado flex items-center justify-between">
                  <h2 className="text-title font-semibold">Revisá antes de enviar</h2>
                  <Pill tone="active">tasa fijada</Pill>
                </div>
                {/* 🔴 LA CIFRA SALIÓ DE LA CAJA GRIS (M-2). Estaba adentro de un `bg-sand` con el
                    mismo peso visual que las filas de abajo, o sea que el dato por el que la persona
                    entró a la app se leía igual que la comisión. Sin caja, lo que la separa es el
                    TAMAÑO y el aire, que es lo que una jerarquía tiene que hacer. ⛔ No se agregó
                    ninguna línea nueva debajo: el destino ya está en la fila "Recibe en" de esta
                    misma tarjeta, y repetirlo acá sería copy nueva. */}
                <div className="mb-aire mt-normal text-center">
                  <Muted escala="label">{rem.beneficiary.name} recibe</Muted>
                  <Money tono="verde" className="mt-ajustado">
                    {rem.quote.receive.format()}
                  </Money>
                </div>
                <Row label="Enviás" value={rem.sendUsd.format()} />
                <Row label="Comisión" value={rem.quote.feeUsd.format()} />
                <Row label="Tipo de cambio" value={`S/ ${rem.quote.rate.toFixed(3)}`} />
                <Row label="Estimado del corredor" value={`~${rem.quote.etaMinutes} min`} />
                <div className="my-ajustado h-px bg-line" />
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
              {error ? ( // JERARQUÍA RELATIVA (la regla, en `ui.tsx`): este `?` REEMPLAZA a "Confirmar y enviar", o sea que en esta rama el camino feliz NO ESTÁ. Recotizar es lo único que desatasca el envío ⇒ es la acción que RESUELVE ⇒ `primary`, no `outline`. Era el segundo sitio con cero `primary` habiendo una acción resolutiva.
                <Button disabled={busy} onClick={onRelock}>
                  {busy ? <Loader2 className="size-icono-sm animate-spin" /> : "Recotizar tasa"}
                </Button>
              ) : (
                <>
                  <Button disabled={busy} onClick={onConfirm}>
                    {busy ? <Loader2 className="size-icono-sm animate-spin" /> : `Confirmar y enviar ${rem.sendUsd.format()}`}
                  </Button>
                  <Muted escala="label" className="text-center">
                    Al confirmar, autorizás el envío de {rem.sendUsd.format()} desde tu wallet.
                  </Muted>
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
              // WKH-339 — las DOS capacidades van JUNTAS o ninguna: preguntar el estado sin poder
              // renovar deja la pantalla sin salida, y poder renovar sin saber el estado es el botón
              // siempre visible que la aritmética del cupo rechaza. Los dos campos del Container son
              // REQUERIDOS (sin `?`), así que `tsc` obliga a que esta línea exista. Lo que `tsc` NO
              // puede garantizar es que sean el MISMO almacén que observa el gateway: eso lo mata
              // T-339.5 en `container.test.ts`.
              revision={{ ventana: c.ventanaDeLectura, renovar: c.renovarVentana }}
              onRecovered={setRem}
            />
          )}

          {step === "history" && history && ( // fix-pack AR/BLQ-BAJO-1 · el `onBack` decía `setStep("send")`, o sea que el único botón grande del historial te metía ADENTRO del embudo (paso 1 de 4, sin barra). Va a `bienvenida`, que es el destino de entrada. ⚠️ Y EL BOTÓN SE QUEDA pese a que la barra ya ofrece "Enviar": con la billetera colgada (AR/MNR-3) es la única salida NO DESTRUCTIVA que sobrevive. 🔴 ACÁ DECÍA "es el ÚNICO control de esta pantalla que NO honra `disabled={busy}`" Y ES FALSO, medido (fix-pack 2 · AR-it2/MNR-2): en el árbol congelado con la lista pintada los botones vivos son TRES ⇒ `["¿No sos vos?", "Ver seguimiento", "Volver"]`. El gesto del header tampoco honra `busy` y el botón de fila tampoco, pero uno es destructivo y el otro no sale del destino. Las dos mitades las mide `T-063-22`; si mañana se le pone `disabled`, el botón deja de tener motivo y se borra
            <HistoryView items={history} onOpen={onOpenFromHistory} onBack={() => setStep("bienvenida")} reader={c.solanaEscrowStates} sender={address} />
          )}

          {step === "done" && rem && <Receipt rem={rem} onNew={() => resetTo(setStep, setRem, setPreview)} />}

          {/* WKH-063/AC-1+AC-2 — la primera pantalla. No recibe `rem` ni `preview` NI PUEDE: su
              contenido no depende de ningún estado del envío, que es la mitad de lo que la hace la
              pantalla de entrada (una recarga la deja igual). Su única acción entra al formulario por
              la MISMA máquina de `Step` que el resto: sin ruta nueva y sin router (CD-4). 🔴 Y ES EL SEGUNDO PUNTO QUE MARCA `yaInteractuoRef` (`:175`), que es la mitad del fix-pack 3. El fix-pack 2 sólo marcaba la barra, y por eso el EMBUDO quedaba afuera: en la ventana del resume esta pantalla tiene cuatro botones habilitados (medido: el CTA + las tres pestañas) y éste era el único sin marca, así que entrar a tipear un monto y recibir después un `passed` aterrizaba en `confirm` sin aviso. Se marca en el handler y no adentro de `Bienvenida`: el componente no sabe nada del resume, y meterle esa responsabilidad sería cablear el KYC en la pantalla de entrada. Δ0 de líneas: la marca entra en el handler que ya existía. */}
          {step === "bienvenida" && <Bienvenida onEmpezar={() => { yaInteractuoRef.current = true; setStep("send"); }} disabled={busy} />}

          {/* WKH-063 — el destino "Recuperar". Los dos componentes son los MISMOS de antes, con el
              mismo cableado que tenían al pie de `send`: lo único que cambió es desde dónde se montan
              (DT-2). ⛔ Si el container no trae sus gateways cada uno devuelve `null` solo, así que la
              carcasa no puede afirmar cuántas puertas hay — y su copy no lo afirma. */}
          {step === "recuperar" && (
            <DestinoRecuperar>
              <LostEscrowRecovery refund={c.solanaRefund} resolveSender={resolveSender} />
              <EscrowRentRecovery lister={c.solanaCloseableEscrows} close={c.closeEscrowAccounts} resolveSender={resolveSender} />
            </DestinoRecuperar>
          )}
        </motion.div>
      </AnimatePresence></MotionConfig>
      )}

      {error ? (
        // La caja de error era una de las 14 recetas copiadas que S-3 midió, y es la única del tono
        // `atencion`. `Aviso` emite la MISMA superficie: `px-holgado`=16px=`px-4` y
        // `py-normal`=12px=`py-3`, así que el marco no se mueve; lo que cambia es que ahora hay UN
        // lugar donde vive.
        <Aviso tono="atencion" className="mt-holgado text-body">
          {error.message}
          {error.code ? (
            // `break-all` se queda: una firma o un código sin espacios desborda la única columna de
            // la app. `text-[11px]` pasa a `text-mono` (13px), que es el rol de códigos y firmas y
            // el único que declara la pila monoespaciada que `font-mono` estaba usando sin tema.
            <span className="mt-ajustado block break-all font-mono text-mono opacity-60">
              {error.code}
            </span>
          ) : null}
        </Aviso>
      ) : null}

      {/* WKH-063/AC-3+AC-4 · LA BARRA. Dos mitades: `step` es un DESTINO **y no hay overlay arriba**. La segunda la agregó el fix-pack (AR/BLQ-MED-1). Un paso nuevo del flujo nace sin barra y un destino nuevo nace con ella: el candado recorre `STEP_INDEX` entero contra una tabla a mano, así que un `Step` nuevo obliga a clasificarlo.
          🔴 POR QUÉ `!resuming && !timedOut`, y es el camino del video: el KYC vuelve de Didit como RECARGA (`window.location.href` en el `redirect` de `:457-461`), así que el resume corre AL MONTAR — y con el default `pasoInicial = "bienvenida"` el `step` de ese montaje ya es un destino. Medido antes del arreglo, con `resumeKyc` devolviendo `processing`: la barra se pintaba debajo de "Verificando tu identidad…" con las tres pestañas HABILITADAS, y al tocar una quedaba marcada `aria-current="page"` mientras la pantalla seguía en el overlay. O sea: la barra afirmaba un lugar donde la persona no estaba, y AC-3 pide lo contrario (hay un envío en curso ⇒ no hay barra).
          ⛔ LOS DOS OVERLAYS VIVEN EN EL TERNARIO DE ARRIBA (`:764-796`), y por eso esta línea nombra sus banderas y no una lista de pasos. ⚠️ Un TERCER overlay que nazca mañana en ese ternario NO queda cubierto por esta línea, y eso no se declara en prosa: `T-063-20` lee este archivo, saca las banderas de las ramas del ternario y exige que cada una esté negada acá. Una rama nueva sin su `!bandera` se pone roja sola.
          ✅ LO QUE ESTA LÍNEA NO ARREGLABA, Y HOY ESTÁ CERRADO EN OTRO LUGAR (fix-pack 2 · AR-it2/BLQ-MED-1). Acá decía que una elección hecha en la ventana ANTERIOR a la primera respuesta se pisaba igual, y que cortar el `setStep` era peor porque dejaría "una identidad ya verificada sin ninguna pantalla que la retome". LAS DOS MITADES DE ESA JUSTIFICACIÓN ESTABAN MEDIDAS AL REVÉS: la identidad la persiste `ResumeKyc` (`kycStore`, `../application/use-cases/resume-kyc.ts:49` — el AR-it2 y su verificación independiente decían `:47` los dos, y `:47` es el `applyKyc`; el `kycStore.save` está DOS líneas más abajo, inmediatamente después del `repo.save` de `:48`, así que el hecho aguanta y el número no lo hacía. Lo cazó `citas-ancladas.test.ts`, no una relectura) ANTES de que la UI navegue, y el atajo KYC-once de `onConnect` (`:356-377`) la retoma con CERO llamadas a Didit — lo que se perdía era un formulario, no el KYC pagado; y la ventana no dura "cientos de ms" sino HASTA 10 s (`AbortSignal`, `../../app/api/kyc/decision/route.ts:57`) y SIN TECHO cuando la petición no llega, que es el caso plausible en una recarga desde un redirect externo en red móvil. El gate vive en `aterrizar` (`:208`) y `T-063-21` congela hoy el comportamiento NUEVO, con sus controles. ✅ Y LOS DOS CAMINOS QUE ACÁ QUEDABAN DECLARADOS Y ABIERTOS SE CERRARON EN EL FIX-PACK 3, con el candado que cada uno pedía. (1) EL EMBUDO: el gate era "ya eligió un destino CON LA BARRA", así que entrar por «Empezar un envío» y tipear no contaba. Hoy el ref es `yaInteractuoRef` (`:175`) y lo marcan los DOS puntos de entrada de la ventana, la barra y el CTA de la bienvenida (`:1195`). Sonda de antes: controles finales `["¿No sos vos?", "Confirmar y enviar $400.00"]`, sin aviso. Sonda de ahora: la entrada de monto sigue en pantalla con lo tipeado y los controles son `["¿No sos vos?", "Seguir con ese envío", "Volver al inicio", "Continuar"]`. Lo cubren dos `it` de `T-063-21` y el mutante G3 (borrarle la marca al CTA) mata esos dos y nada más. Se agrega una pérdida de datos que este renglón NO nombraba: el `setRem` corría antes del gate y REEMPLAZABA la remesa en curso, que sin `ownerAddress` no la lista "Mis envíos" ni tiene control de fila (`openable`, `:3412`) ⇒ quedaba inalcanzable. Hoy el snapshot viaja en el aviso y lo aplica el botón; el mutante G5 (devolver el `setRem` al frente del gate) mata el `it` que lo mide, y sólo ése. (2) EL RESUME `failed`: pasa por el mismo `aterrizar` con su propio copy ("Tu verificación necesita otro intento", `tono="atencion"`, botón a `verify`), y el banner de error se prende al llegar y no antes. Lo cubren un `it` gateado + un control, y el mutante G4 (devolverle las tres sentencias sueltas) mata el gateado. ⛔ QUÉ NO AFIRMA ESTE RENGLÓN: no dice "ya no puede pasar". Dice que lo que está medido y congelado son esos cuatro `it` sobre el resume del KYC en jsdom, con la ventana simulada por una promesa diferida y no por latencia real; y que `setAddress` (`:246`) sigue corriendo aunque el gate frene, porque WKH-354 lo necesita y no es parte de ninguno de los dos caminos. La retoma de la remesa del KYC es de UNA SOLA DIRECCIÓN: al usar el botón, la remesa que la persona estaba creando queda sin fila que la liste (los valores del formulario sí sobreviven en estado).
          ⛔ VA ÚLTIMA DENTRO DEL `<main>`, y no es orden estético: su `mt-auto` sólo la empuja al borde
          inferior si es el último hijo de la columna flex. Debajo del bloque de error a propósito, y no
          por descuido: un error habla de la pantalla en la que estás, no de la navegación que la
          rodea. */}
      {esDestino(step) && !resuming && !timedOut ? <BarraDestinos activo={step} onIr={irADestino} disabled={busy} /> : null}
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
    <div className="flex items-center gap-normal rounded-control bg-sand/60 px-holgado py-normal">
      <span
        className={
          approved
            ? "flex h-5 w-5 items-center justify-center rounded-full bg-verde text-white"
            : "flex h-5 w-5 items-center justify-center rounded-full bg-cochineal text-white"
        }
      >
        {approved ? <Check className="size-icono-sm" /> : <Loader2 className="size-icono-sm animate-spin" />}
      </span>
      <span className="text-body font-medium text-ink">
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
      // El punteado sobre arena ES el tono `prueba` de S-3, byte por byte: `border border-dashed
      // border-stone/40 bg-sand/60`. `flex items-start` va como `className` y no adentro del
      // componente porque de las cajas medidas una es `flex items-center`, otra `text-left` y otra
      // ninguna de las dos: la superficie la aporta `Aviso`, la disposición el sitio de llamada.
      <Aviso tono="prueba" className="flex items-start gap-normal">
        <ShieldAlert className="mt-0.5 size-icono-sm shrink-0 text-stone" />
        <p className="text-label text-stone">
          Identidad sin verificar: <b>{nombre}</b> · {documento}. {kycOriginNotice(kyc.provenance)}
        </p>
      </Aviso>
    );
  }
  return (
    <Aviso tono="bueno" className="flex items-center gap-normal">
      <BadgeCheck className="size-icono-sm shrink-0 text-verde" />
      <p className="text-label text-verde/90">
        Identidad verificada: <b>{nombre}</b> · {documento}
      </p>
    </Aviso>
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
  const availability = useWalletAvailability(); const mwaOfrecido = useMwaOffered(); const mwaListo = mwaOfrecido && mwaEnabled(); const esElUnicoCamino = mwaOfrecido && !mwaEnabled(); // WKH-MWA: los hooks EN ESTA LÍNEA — la de abajo la citan `solana-providers.tsx:67` y `solana-providers.test.tsx:400` por número, y el resto del archivo, 85 veces. H1: `esElUnicoCamino` = el selector ofrece MWA y nadie verificó todavía que MWA funcione, o sea que `conectarEsCallejon` (arriba, en `step === "connect"`) escondió el CTA y este enlace quedó SOLO.
  if (availability !== "none") return null;
  // Sólo se llega acá en el navegador (en el servidor la disponibilidad es "unknown"), pero el guard
  // deja el componente seguro de renderizar en cualquier contexto.
  const href = typeof window !== "undefined" ? window.location.href : "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    // `space-y-3 rounded-xl2 border border-line bg-sand/60 p-4` era la receta más repetida de las 14
    // que S-3 midió (3 sitios, más 1 casi igual). ⚠️ Y el `p-4` de la receta NO es lo que emite
    // `Aviso` (`px-holgado py-normal`, o sea 16 y 12): acá el alto baja 4px por lado. Se elige la
    // superficie del componente y no un `className` que la deshaga, porque tres cajas iguales con un
    // padding propio cada una es de donde venía el problema.
    <Aviso className="space-y-normal">
      <div className="flex items-center gap-ajustado">
        <Smartphone className="size-icono-sm text-cochineal" />
        <h2 className="text-title font-bold">No vemos ninguna wallet en este navegador</h2>
      </div>
      <Muted>
        Esto no dice si tenés una wallet instalada: dice que en este navegador no hay ninguna
        disponible.
      </Muted>
      <Muted>
        {/* WKH-MWA · las dos frases viven al final del archivo (`NO_WALLET_*`) por el largo, no por gusto. */}
        {mwaListo ? NO_WALLET_CON_MWA : NO_WALLET_SIN_MWA}
      </Muted>
      {/* H1 · DOS ALTOS, Y EL QUE MANDA ES SI HAY OTRO CTA. Con `esElUnicoCamino` este enlace ES la acción de la pantalla (el `<Button>` de abajo no se renderiza), así que toma el alto y el color del CTA primario.
          La receta se copia a mano de `./ui.tsx:66` + `BTN_VARIANTS.primary` (`./ui.tsx:47`) porque `Button` emite un `<button>` y esto tiene que ser un `<a>` para que el deep link de Phantom navegue; el candado que impide que las dos se separen es T-H1-3 en `wallet-availability.test.tsx`, que LEE el alto de un `<Button>` renderizado. `h-[52px]` va literal y no como token: `touch-targets.test.tsx:64` lo lee con `/h-\[(\d+)px\]/` sobre el className RENDERIZADO.
          ⛔ SIN `esElUnicoCamino` SE QUEDA EN `h-11` (44px), que era la regla vieja y sigue vigente: ahí SÍ hay un CTA primario abajo, y empatarle el alto es lo contrario de lo que M-4 pide. 44px sigue cumpliendo el mínimo de toque de WCAG 2.5.5. */}
      <a
        href={phantomBrowseUrl(href, origin)}
        rel="noreferrer"
        className={esElUnicoCamino ? "inline-flex h-[52px] w-full items-center justify-center gap-ajustado rounded-caja bg-cochineal px-5 text-body font-semibold text-white shadow-lift" : "inline-flex h-11 w-full items-center justify-center gap-ajustado rounded-control border border-cochineal/30 bg-card px-holgado text-body font-semibold text-cochineal"}
      >
        <ExternalLink className="size-icono-sm" /> Abrir Chaski en Phantom
      </a>
      <Muted escala="label">
        Si estás en una computadora, instalá la extensión de Phantom o Solflare y recargá la página.
      </Muted>
    </Aviso>
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
/**
 * WKH-339 — cada cuánto se le pregunta a la ventana en qué estado está. **5000 ms**, y el número está
 * DERIVADO, no elegido:
 *
 * lo único que este temporizador cambia es UNA ETIQUETA. La cadencia que tiene que sombrear no es la
 * del poll de la pantalla (1500 ms) sino la de la LECTURA, que es `LEDGER_STATUS_MIN_INTERVAL_MS` =
 * 20 000 ms (`LEDGER_STATUS_MIN_INTERVAL_MS`, `../infrastructure/settlement/ledger-payout-status-gateway.ts:48`).
 * Con 5000 ms la etiqueta nunca puede quedar vieja durante un ciclo entero de lectura
 * (20 000 ÷ 5 000 = 4 chequeos por ciclo), y el costo por tick es UN `Map.get`: cero red, cero firma,
 * cero I/O.
 *
 * ⛔ PROHIBIDO ponerlo en `1500` reusando el literal del poll. Con 1500 la pantalla funciona igual —
 * por eso esto NO tiene test y la prohibición está escrita acá en vez de fingir un candado. El daño de
 * hacerlo es crear un SEGUNDO literal de una cadencia AJENA, que es el punto ciego que el Auto-Blindaje
 * de WKH-336 nombra; y `flow.tsx:661` (el literal del poll) ya lo citan 6 archivos por número. Un
 * candado que comparara dos números que no tienen por qué ser iguales sería un guard que se compara
 * consigo mismo.
 */
const VENTANA_CHECK_MS = 5000;

/**
 * WKH-339 — cuántos challenges puede pedir el gesto de revisar, POR MONTAJE del seguimiento. **3**, y el
 * número **no es nuevo**: es el techo que la aritmética de la HU ya declaraba. Lo que cambia es que
 * ahora **se cuenta**, y por eso es un techo y no una expectativa.
 *
 * 🔴 POR QUÉ HACE FALTA CONTARLO. Los dos frenos que la aritmética invocaba eran el `disabled` mientras
 * firma y que el botón desaparece al renovar con éxito. **Ninguno de los dos acota el camino de FALLO**:
 * tras un fallo el botón vuelve a estar habilitado, no hay cooldown, y el copy del estado 7 **invita a
 * reintentar**. MEDIDO antes de este arreglo: `prove` que rechaza, **6 toques ⇒ 6 challenges**.
 *
 * Y el daño no era teórico. `PAYOUT_CHALLENGE_RL` son **10 requests por "10 m", IP-only y compartidos**
 * (`PAYOUT_CHALLENGE_RL`, `../infrastructure/rate-limit.ts:70`), y con el secreto seteado el limitador
 * corre **después** del 501, así que cada toque consume un token. ⇒ **un solo remitente podía vaciar el
 * cupo de su IP**, y el siguiente detrás del mismo NAT veía su envío caer por `prepare_unavailable`.
 * Sin pérdida de principal —no se depositó nada— pero un envío caído por el uso normal de otra pantalla.
 *
 * De dónde sale el 3, y es la MISMA derivación que ya estaba: la ventana vive 480 s y una sola renovación
 * la reabre entera ⇒ `⌈600 / 480⌉ = 2` dentro de una sesión de 10 min, **+1** por el arranque en frío
 * (recarga / historial, cuando el almacén está vacío). ⇒ el camino legítimo cabe **exacto** en 3.
 *
 * ⛔ Es por MONTAJE y no por sesión, a propósito: remontar el seguimiento es lo mismo que recargar, y una
 * recarga ya vacía el almacén de pruebas (es en memoria). Atarlo a algo más largo exigiría persistir un
 * contador, o sea estado nuevo para acotar una molestia.
 * ⛔ Y NO se toca `rate-limit.ts` ni ninguna env del cupo: el techo se acota del lado que lo consume.
 */
const MAX_CHALLENGES_POR_MONTAJE = 3;

/**
 * WKH-339/CR-BLQ-MED-2 — dónde vive el contador para que el techo **sobreviva a un remonte**.
 *
 * ⛔⛔ ESTO **NO ES UN LÍMITE DE SEGURIDAD**, Y HAY QUE LEERLO ASÍ O ENGAÑA. `sessionStorage` es **por
 * pestaña**: una pestaña nueva, otra ventana, o un navegador en incógnito lo reinician, y nada impide
 * abrir diez. Lo único que esto acota es el **agotamiento ACCIDENTAL** — la persona que toca frustrada,
 * recarga, y vuelve a tocar. Es una **barrera contra el uso normal repetido**, no contra nadie que quiera
 * gastar el cupo.
 *
 * 🔴 EL TECHO REAL POR REMITENTE SIGUE SIENDO **WKH-340** (contar el cupo del challenge por sender en vez
 * de por red compartida) Y **NO SE CIERRA ACÁ**: agregar el bucket por address no sube el techo por IP, y
 * contar por sender exige parsear el body ANTES del limiter, o sea rehacer la derivación de CPU-DoS de la
 * ruta. ⛔ No leas esta función como si cerrara ese riesgo.
 *
 * Se elige `sessionStorage` y no `localStorage` a propósito: aguanta la recarga —que es el camino medido—
 * y **se limpia al cerrar la pestaña**, así que no deja a nadie sin gesto mañana. La clave lleva la
 * address para que dos billeteras en la misma pestaña no compartan contador.
 *
 * ⚠️ Todo va en `try/catch` y detrás de `typeof window`: `sessionStorage` puede tirar (modo privado,
 * cuota, iframe con storage bloqueado) y esto es una MITIGACIÓN — si falla, el comportamiento cae al
 * techo por montaje que ya había, nunca a "sin techo" ni a una pantalla rota. Es el mismo molde que
 * `LocalRepo` usa para `localStorage` (`../infrastructure/persistence.ts:86`).
 */
function claveIntentos(sender: string | null): string {
  return `wkh339:revisiones:${sender ?? "sin-sender"}`;
}
function leerIntentosGuardados(sender: string | null): number {
  if (typeof window === "undefined") return 0;
  try {
    const n = Number(window.sessionStorage.getItem(claveIntentos(sender)));
    // Un valor ilegible NO abre la compuerta ni la cierra: cae a 0, que es el techo por montaje de antes.
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_CHALLENGES_POR_MONTAJE) : 0;
  } catch {
    return 0;
  }
}
function guardarIntentos(sender: string | null, n: number): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(claveIntentos(sender), String(n));
  } catch {
    // Best-effort: sin persistencia el techo vuelve a ser por montaje, que es lo que había.
  }
}

// Exportado para test directo (HU-SOL-13/T7): testear TrackView en aislamiento cubre exactamente la
// acción refund (AC-6/AC-7) sin montar el flujo entero.
export function TrackView({
  rem,
  recover,
  closeEscrow,
  sender,
  onRecovered,
  revision,
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
  // ── WKH-339 · UNA prop, OPCIONAL, y las dos capacidades JUNTAS ─────────────────────────────────
  //
  // Es UNA sola prop porque las dos mitades no tienen sentido separadas: preguntar el estado sin poder
  // renovar deja la pantalla sin salida, y poder renovar sin saber el estado es un botón siempre
  // visible, que es lo que la aritmética del cupo del challenge rechaza.
  //
  // Es OPCIONAL, y con `revision === undefined` el render es BYTE-IDÉNTICO al de antes de esta HU. Eso
  // es honesto, no una concesión: el copy de hoy NO afirma que esté revisando, así que su ausencia no
  // deja ninguna afirmación falsa en pantalla. ⇒ los 22 mounts de `<TrackView` que ya existen en los
  // tests NO se editan y siguen midiendo lo mismo.
  //
  // 🔴 LOS TIPOS SE DERIVAN DEL `Container`, NO SE IMPORTAN. Dos razones y las dos son medibles: un
  // `import` nuevo arriba desplazaría `flow.tsx:661`, que 6 archivos citan por número y NINGUNA de las
  // 6 es una cita anclada (el ancla `` `}, 1500);` `` empieza con `}` y el regex del candado exige
  // `[A-Za-z_$]`) ⇒ si se mueve, nada se pone rojo y los 6 comentarios rotan en silencio. Y derivar del
  // `Container` es además la única fuente: si mañana la firma de `estado` cambia, esto no compila.
  // Es el mismo molde que `recover` y `closeEscrow` de acá arriba.
  //
  // ⛔ `ventana` NO tiene `prove` y `renovar` NO tiene `estado`, y eso es el mecanismo, no estilo: **el
  // OBJETO que informa el estado no puede firmar** y **el OBJETO que firma no puede consultar el estado**
  // (lo segundo mata a un signer que se "ahorre" el popup de una operación de dinero reusando una prueba
  // guardada). ⛔ NO los unifiques en un solo objeto con los dos métodos.
  //
  // ⚠️ LO QUE `tsc` **NO** GARANTIZA, y acá se afirmaba que sí: que *"el camino de LECTURA no compile si
  // intenta firmar"*. MEDIDO: un `setInterval` de este mismo componente que llame a `renovar.prove(...)`
  // **compila, `tsc` exit 0** — las dos capacidades llegan juntas en esta prop y nada impide tomar la
  // otra. Ese riesgo lo cubren los tests (con ese mutante caen 4 de `flow.test.tsx`), no los tipos.
  revision?: {
    readonly ventana: Container["ventanaDeLectura"];
    readonly renovar: Container["renovarVentana"];
  };
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
  // (`failAndRefund`, `../application/use-cases/confirm-and-send.ts:481`, con `"not_deposited"`), o sea antes de que la
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

  // ── WKH-339 · en qué estado está la ventana de lectura del seguimiento ───────────────────────────
  //
  // ⛔ VAN ACÁ, ANTES DEL `return` TEMPRANO DE ABAJO: son hooks, y después de una salida condicional
  // React los llamaría un número distinto de veces según el estado de la remesa.
  //
  // 🔴 `estado()` SE CONSULTA DESDE EL EFECTO, JAMÁS DESDE EL RENDER, y no es una preferencia: `peek()`
  // BORRA la entrada vencida (`porAddress`, `../infrastructure/auth/pop-proof-store.ts:79`), o sea que
  // la consulta tiene un efecto secundario. Es idempotente (borra lo que ya venció), pero un render de
  // React puede correr más de una vez y no puede tener efectos.
  //
  // `ventanaPort` se extrae a una variable propia para que la dependencia del efecto sea la CAPACIDAD y
  // no el objeto `revision`, que el montaje construye nuevo en cada render: con `revision` en las
  // dependencias el efecto se re-montaría en cada render y el `setInterval` se recrearía sin parar.
  const ventanaPort = revision?.ventana;
  const [ventana, setVentana] = useState<ReturnType<Container["ventanaDeLectura"]["estado"]>>(
    "sin-prueba", // arranque en frío: el almacén es en memoria y está vacío. Es el caso real de una recarga.
  );
  const [gesto, setGesto] = useState<GestoRenovacion>("idle");
  // Re-lee el estado AHORA. Se usa tras un gesto exitoso para que el control desaparezca en el acto en
  // vez de esperar hasta el próximo tick — y desaparece porque `estado()` pasó a `"vigente"`, no porque
  // alguien se acuerde de esconderlo.
  const releerVentana = useCallback(() => {
    if (ventanaPort && sender) setVentana(ventanaPort.estado(sender));
  }, [ventanaPort, sender]);
  useEffect(() => {
    if (!ventanaPort || !sender) return;
    const leer = () => {
      const v = ventanaPort.estado(sender);
      setVentana(v);
      // 🔴 EL TEXTO DE UN FALLO VIEJO NO PUEDE SOBREVIVIR A LA RAZÓN QUE LO PRODUJO. Sin esto, un fallo
      // de firma dejaba su frase puesta; otro gesto de la app (por ejemplo "Recuperar fondos", que graba
      // en el MISMO almacén) volvía la ventana `"vigente"` y escondía el bloque; y al cruzarse el plazo
      // otra vez el bloque REAPARECÍA con el texto viejo, dando como razón actual de que no estamos
      // revisando un fallo de firma que ya no es la razón. Se limpia en la transición a `"vigente"`.
      // ⛔ NO se limpia durante `"firmando"`: ahí puede haber un popup abierto y su desenlace todavía va
      // a escribir el estado local.
      if (v === "vigente") setGesto((g) => (g === "firmando" ? g : "idle"));
    };
    leer(); // la primera lectura no espera al primer tick: la pantalla no puede quedarse muda 5 s
    const t = setInterval(leer, VENTANA_CHECK_MS);
    return () => clearInterval(t); // sin esto el temporizador sobrevive al unmount (M10)
  }, [ventanaPort, sender]);

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
    // El prepare corre antes de `authorizePrincipal` ((`prepare_unavailable`, `confirm-and-send.ts:477`)), o sea antes de
    // que la wallet firme nada, así que "no se movió ningún USDC" es un hecho que se lee del orden
    // del use-case, no una promesa. Decirlo con las palabras de un payout fallido ("si te cobramos,
    // te reembolsamos") deja esperando un reembolso que no existe.
    const prepareRejected = isPrepareRejection(rem.failureReason); const prepareUnreachable = isPrepareUnreachable(rem.failureReason); // WKH-358 (fix-pack · AR/BLQ-MED-2) — EN ESTA LÍNEA (Δ0 obligatorio, `:44`). 🔴 QUÉ CAÍA ACÁ ANTES Y POR QUÉ ERA GRAVE: `payout_pop_unavailable` y `prepare_unavailable` no son `prepareRejection` (medido: los 4 enums de esa familia no los incluyen) y ninguna rama los nombraba, así que caían en el `else` del final ⇒ `humanError("payout_failed")` ⇒ *"si tus USDC entraron al escrow, los sacás vos firmando"*. Los dos salen de `failAndRefund(..., "not_deposited")`, o sea que "no entró ningún USDC" es CERTEZA y no una duda: esa frase mandaba a buscar plata donde se sabe que no hay. ⛔ Y NO entran a la familia `prepareRejected`, cuyo copy afirma "El agente de pagos rechazó esta remesa": acá NO hubo respuesta de nadie. El razonamiento entero, con el residual de por qué el copy no puede negar la firma, está en (`isPrepareUnreachable`, `../application/agent-rejections.ts:266`)
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
      <Card className="space-y-normal">
        <p className="text-title font-semibold">
          {recoveredBySender
            ? "Recuperaste tus fondos"
            : senderSolMissing
              ? "Te falta SOL en la wallet"
              : walletAddressMissing
              ? "Reconectá tu wallet"
              : prepareRejected
                ? "No pudimos preparar el envío" : prepareUnreachable ? "No llegamos a preparar el envío" // ⚠️ «No LLEGAMOS a preparar» y no «No PUDIMOS»: la de arriba es un NO de alguien, ésta es que no hubo respuesta de nadie. EN ESTA LÍNEA por Δ0 (el censo de citas vive en `:44`)
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
        <Muted>
          {recoveredBySender
            ? "Los USDC volvieron a tu wallet. Esta remesa no se entregó."
            : senderSolMissing
              ? humanError(SOLANA_SENDER_SOL_INSUFFICIENT)
              : walletAddressMissing
              ? humanError(WALLET_ADDRESS_UNAVAILABLE)
              : prepareRejected
                ? "El agente de pagos rechazó esta remesa antes de que firmaras nada: no se movió ningún USDC de tu wallet. Empezá de nuevo con una cotización fresca." : prepareUnreachable ? humanError(rem.failureReason ?? "") // 🔴 EL CUERPO SALE DE `humanError` Y NO DE UN LITERAL, igual que `senderSolMissing`: la frase vive en UN solo lugar (la rama de los dos enums en `flow-vm.ts`) y los dos productores comparten copy. ⛔ Y SE LE PASA EL `failureReason`, no un enum fijo: el `??` sólo existe porque el tipo es `string | null`, y con `prepareUnreachable === true` ese `null` es imposible por construcción (el predicado lo rechaza). EN ESTA LÍNEA por Δ0
                : noAgentForCapability
                ? humanError(PREPARE_NO_AGENT_FOR_CAPABILITY)
                : settleLedgerUnavailable
                ? humanError(SOLANA_SETTLE_LEDGER_UNAVAILABLE)
                : principalUnknown
                ? "Se cortó la comunicación mientras enviábamos tu depósito, y la cadena tampoco nos contestó. Puede que tus USDC estén en el escrow o que nunca hayan salido de tu wallet: todavía no lo sabemos. Nadie te reembolsó nada."
                : principalInEscrow
                  ? "Tu depósito entró al escrow y el envío no siguió. Los USDC siguen ahí, a tu nombre. Nadie te los reembolsó: los recuperás vos, firmando desde tu wallet."
                  : humanError("payout_failed")}
        </Muted>
        {(principalUnknown || principalInEscrow) && recoveryOffered ? (
          <Muted>{RECOVERY_ASK_WHEN_UNKNOWN}</Muted>
        ) : null}
        {(principalUnknown || principalInEscrow) && !recoveryOffered ? (
          <Muted>{RECOVERY_NEEDS_WALLET}</Muted>
        ) : null}
        {/* Sólo se muestra un comprobante que EXISTE. El adapter ledger-only devuelve null y esta
            línea no se renderiza: un identificador fabricado al lado de la palabra reembolso es peor
            que no decir nada. */}
        {rem.refundTx ? (
          <Muted escala="label">Referencia de reembolso: <TxProof signature={rem.refundTx} /></Muted>
        ) : null}
        {showRefund && recover && sender ? ( // ⇒ `resolutiva`: en ESTA rama el envío ya no se entrega, o sea que el camino feliz MURIÓ, y recuperar es lo único que le devuelve sus USDC. Es el defecto que el founder vio: la única acción posible de la pantalla, pintada como secundaria. La regla está en `ui.tsx`; el candado, en `jerarquia-relativa.test.tsx`.
          <div className="space-y-ajustado">
            <RefundAction
              remittanceId={rem.id}
              sender={sender}
              recover={recover}
              onRecovered={onRecovered} prominencia="resolutiva"
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
    <Card className="space-y-holgado">
      <div className="flex items-center gap-normal">
        <ChaskiMark className={cn("h-icono-lg w-auto", waitingOnPerson ? undefined : "animate-pulse")} />
        <p className="text-title font-semibold">
          {waitingOnPerson ? "Tu envío está esperando" : "Tu chaski está en camino…"}
        </p>
      </div>
      {/* ── M-3 · los tres pasos son un CAMINO, no una lista ────────────────────────────────────
          🔴 ACÁ DECÍA que «el camino escalonado del Qhapaq Ñan ya está dibujado en `ChaskiMark`, tres renglones más arriba», Y HU-066 LO VOLVIÓ FALSO: la marca nueva es el mensajero corriendo y no tiene ningún camino escalonado — ese dibujo bajó a ser el fondo del splash (`Grecas`, `./splash.tsx:245`). ⛔ EL PÁRRAFO SE REESCRIBE EN ESTAS MISMAS 4 LÍNEAS y no en 6: este archivo recibe muchas citas por número (`:44`) y dos renglones de comentario de más corren todas las que apuntan más abajo, que es un defecto silencioso en 30 archivos ajenos por una edición de prosa.
          EL GESTO SE SOSTIENE IGUAL, y ahora sin apoyarse en el dibujo de al lado: la marca de Chaski
          ES un mensajero que RECORRE, así que sus tres pasos se dibujan como un camino y no como una
          lista. Acá abajo eran una lista plana de puntos sueltos.
          Es UNA LÍNEA QUE PROGRESA, no una ilustración: 2px, el mismo verde del tilde cuando el tramo
          ya se recorrió y el mismo gris del borde cuando todavía no. Sin animación (en
          `payout_submitted` no avanza nada y un tramo que se llenara solo afirmaría un progreso que
          no existe: es el mismo criterio por el que ese paso muestra un reloj y no un spinner). */}
      <ol className="space-y-normal">
        {TRACK_STEPS.map((s, i) => {
          const last = order.indexOf(s.key[s.key.length - 1] ?? "settled");
          // Un paso está COMPLETADO cuando el estado lo pasó de largo, no cuando lo alcanzó. Antes
          // era `last <= idx`, así que estar EN payout_submitted pintaba el tilde verde de
          // "pagando a tu familiar": un paso en curso se dibujaba como un paso terminado.
          // La excepción es el último ("Entregado"): no hay ningún estado después, así que ahí
          // completarlo ES estar en él.
          const reached = idx > last || (last === order.length - 1 && idx === last);
          const active = !reached && s.key.includes(rem.status);
          // El último no lleva tramo: un camino que sigue después del final promete un paso más.
          const conConector = i < TRACK_STEPS.length - 1;
          return (
            // `relative` + `items-start`: el tramo se ancla al `<li>` y arranca DEBAJO del ícono, así
            // que su largo no depende de cuánto envuelva la etiqueta. Con `items-center` (lo que
            // había) una etiqueta de dos líneas correría el ícono hacia abajo y el tramo quedaría
            // colgando en el aire.
            <li key={s.label} className="relative flex items-start gap-normal">
              {conConector ? (
                // ⛔ ES UN `<div>` Y NO UN `<span>`, y eso NO es estilo: `flow.test.tsx` lee el tono de
                // cada paso con `li.querySelector("span")`, o sea el PRIMER `<span>` del `<li>` en
                // orden de documento, y espera el círculo del ícono. Un `<span>` acá adelante le
                // devolvería el tramo y los tres asserts de color pasarían a medir otra cosa. Medido
                // antes de escribirlo: es el test de `toneOf`, en "los tildes del tracking no marcan
                // como hecho lo que está en curso".
                // La geometría: `top-aire` = 24px = el alto exacto del círculo, y `-bottom-normal` =
                // -12px = el `space-y-normal` del `<ol>`, así que el tramo llega justo al círculo
                // siguiente. `left-[11px]` centra 2px sobre un círculo de 24. Los tres números están
                // atados a algo, ninguno es a ojo.
                <div
                  aria-hidden="true"
                  data-testid={`camino-tramo-${i}`}
                  className={cn(
                    "absolute left-[11px] top-aire -bottom-normal w-0.5 rounded-full",
                    reached ? "bg-verde" : "bg-line",
                  )}
                />
              ) : null}
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
                  <Check className="size-icono-sm" />
                ) : active && s.manual ? (
                  <Clock3 className="size-icono-sm" />
                ) : active ? (
                  <Loader2 className="size-icono-sm animate-spin" />
                ) : (
                  <span className="text-label text-stone">{i + 1}</span>
                )}
              </span>
              <span className={reached || active ? "text-body font-medium text-ink" : "text-body text-stone"}>
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>
      {waitingOnPerson ? <PayoutInProgress rem={rem} /> : null}
      {/* WKH-339 — el bloque de la ventana de lectura. Va JUNTO a `PayoutInProgress` y NO adentro: ese
          bloque quedó byte-idéntico a propósito (fue auditado, y el criterio es "la pantalla no puede
          afirmar que mira cuando dejó de mirar", no "tiene que afirmar que mira"). Cuál de los estados
          se muestra —o ninguno— lo decide una función PURA, no un `&&` armado acá. */}
      {revision ? (
        <RevisionDelSeguimiento
          estado={lecturaSeguimiento({ status: rem.status, sender, ventana })}
          gesto={gesto}
          sender={sender}
          renovar={revision.renovar}
          onGesto={setGesto}
          onRenovada={releerVentana}
        />
      ) : null}
      {depositUnknown ? (
        <div className="space-y-ajustado">
          <Muted>{escrowKnowledgeCopy(escrowFundsKnowledge(rem))}</Muted>
          <Muted>
            {showRefund ? RECOVERY_ASK_WHEN_UNKNOWN : RECOVERY_NEEDS_WALLET}
          </Muted>
        </div>
      ) : null}
      {showRefund && recover && sender ? ( // ⇒ `alternativa`, y es el MISMO componente que la rama de fallo pinta `primary`: acá el envío TODAVÍA puede entregarse, así que recuperar no resuelve la situación, la ABANDONA. Ese es el par que hace falsa la lectura "la variante es del botón".
        <div className="space-y-ajustado">
          <RefundAction
            remittanceId={rem.id}
            sender={sender}
            recover={recover}
            onRecovered={onRecovered} prominencia="alternativa"
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

/**
 * WKH-339 — el bloque que dice en qué estado está la lectura del payout, y ofrece el gesto.
 *
 * 🔴 UN `switch` EXHAUSTIVO SOBRE LA UNIÓN, y el `never` del final es el mecanismo: el día que aparezca
 * un quinto valor de `LecturaSeguimiento`, esto NO COMPILA. Es estructural, no enumerativo — una
 * cadena de `&&` en el JSX habría dejado el valor nuevo sin renderizar nada, en silencio.
 *
 * 🔴 PEDIR LA FIRMA TIENE **CUATRO** DESENLACES, Y COLAPSARLOS CULPA A QUIEN NUNCA VIO UN POPUP. Los
 * cuatro salen de `HttpPopSigner.prove` y están medidos en su código, no supuestos:
 *   1. `null` ⇐ 501: el mecanismo está apagado server-side (sin `PAYOUT_POP_SECRET`, que es el DEFAULT
 *      documentado). **Nunca se abrió un popup**, y reintentar **NO sirve** ⇒ `"mecanismo-apagado"`.
 *   2. `throw "pop_challenge_unavailable"` ⇐ 400 / 5xx / **429 del cupo de la IP** / 503: nuestro server
 *      no pudo emitir el challenge (`pop_challenge_unavailable`, `../infrastructure/auth/http-pop-signer.ts:23`). **Nunca se
 *      abrió un popup**, y reintentar puede servir más tarde ⇒ `"no-se-pudo-pedir"`.
 *   3. 🔴 `throw` de algo que **NO es de la billetera**: el `TypeError` crudo de `fetch` cuando no hay
 *      red —su propio docblock lo declara, *"o un fallo de red (fetch rechaza) ⇒ LANZA"*
 *      (`../infrastructure/auth/http-pop-signer.ts:8`)—, o `wallet_sign_not_available`, que el bridge tira
 *      **antes de cualquier popup** (`signMsgHandle`, `../infrastructure/solana-wallet-bridge.ts:127`), o un
 *      `throw` que no es un `Error`. **Tampoco hubo popup** ⇒ `"no-se-pudo-pedir"`.
 *   4. `throw` de un error que la billetera **declara como suyo**: hubo popup y no se completó ⇒
 *      `"sin-firma"`.
 *
 * 🔴 EL 3 ES EL QUE FALTABA, Y ERA EL MÁS COMÚN DE TODOS. Acá había un `else`: todo `throw` que no fuera
 * `pop_challenge_unavailable` se trataba como *"hubo popup y no se completó"*. El input más frecuente de
 * una app de remesas en celular es **perder conectividad**, y ahí la pantalla le decía a la persona que
 * **su** firma falló cuando lo que se cayó fue **nuestra** red. ⛔ Un booleano perdería tres valores; un
 * `else` perdía este. La clasificación vive ahora en `gestoDespuesDeProve` (`./flow-vm.ts`), con el
 * default del lado que **no acusa**: sólo un `name` que la librería de wallets etiqueta como suyo llega a
 * `"sin-firma"`.
 *
 * ⚠️ EL 429 ES ALCANZABLE DE VERDAD, no un caso de borde. `PAYOUT_CHALLENGE_RL` es 10 requests por
 * "10 m" **por IP y compartido** entre los cuatro gestos, y esta app es de remesas para LATAM: dos
 * personas mandando desde la misma casa, oficina o cíber llegan al margen cero. Cuando pase, el peor
 * caso es una MOLESTIA y no un daño: la pantalla cae en el estado 6, que no miente y no culpa a nadie;
 * el refund trustless sigue disponible (`payout_submitted` **está** en `RECOVERABLE`); no se fabrica
 * ningún terminal; y se recupera en la próxima ventana. La salida de verdad es contar el cupo por
 * remitente, que es **WKH-340** y NO se cierra acá: agregar el bucket por address no sube el techo por
 * IP, y contar por sender exige parsear el body ANTES del limiter, o sea rehacer la derivación de
 * CPU-DoS de la ruta.
 *
 * ⛔ Y NADA DE ACÁ ESCRIBE EL AGREGADO. El gesto llama `prove()` —un challenge y una firma— y el
 * observador escribe un `Map` en memoria. Ninguna rama puede producir `settled` ni `refunded`, que son
 * los dos terminales irreversibles: `settled` no está en `RECOVERABLE` y le cerraría al remitente su
 * único camino a sus USDC, para siempre.
 */
function RevisionDelSeguimiento({
  estado,
  gesto,
  sender,
  renovar,
  onGesto,
  onRenovada,
}: {
  estado: ReturnType<typeof lecturaSeguimiento>;
  gesto: GestoRenovacion;
  sender: string | null;
  renovar: Container["renovarVentana"];
  onGesto: (g: GestoRenovacion) => void;
  onRenovada: () => void;
}) {
  // 🔴 EL TECHO SE HACE VALER CON UN `useRef`, NO CON ESTADO DE REACT, y la diferencia es lo único que
  // lo vuelve un techo. MEDIDO: con un contador en `useState`, una ráfaga de clicks SÍNCRONOS (un
  // doble-tap en celular, o dos eventos en el mismo batch) ve TODAS las closures con el MISMO valor
  // viejo, así que las 6 pasan. Y el `disabled` tampoco alcanza solo: es una propiedad del DOM que se
  // actualiza DESPUÉS del commit, o sea después de que la ráfaga ya salió.
  // ⇒ el `ref` es la guarda (se incrementa sincrónicamente, en el mismo turno); el `useState` de al lado
  // existe SÓLO para que el render se entere, y el `disabled` es lo que lo hace visible. Los tres hacen
  // falta y ninguno reemplaza a los otros.
  //
  // 🔴 Y SOBREVIVE AL REMONTE, porque un techo por montaje no era un techo (CR/BLQ-MED-2). MEDIDO antes:
  // 5 toques ⇒ 3 challenges · `unmount()` · `render()` · 5 toques ⇒ **total 6**. Y el camino existe en
  // producción: recargar deja el flujo en la pantalla de entrada (el `step` no persiste) → pestaña "Mis envíos" → la entrada
  // → `onOpenFromHistory` ⇒ **seguimiento montado de nuevo, contador en 0**. Y el almacén vacío por la
  // recarga es justamente el estado que MUESTRA el botón.
  const intentosRef = useRef(leerIntentosGuardados(sender));
  const [intentosUsados, setIntentosUsados] = useState(intentosRef.current);
  const sinIntentos = intentosUsados >= MAX_CHALLENGES_POR_MONTAJE;
  const onRevisar = useCallback(async () => {
    if (!sender) return;
    // Se cuenta ANTES de pedir: lo que consume el cupo de la IP es la request, no su desenlace.
    if (intentosRef.current >= MAX_CHALLENGES_POR_MONTAJE) return;
    intentosRef.current += 1;
    guardarIntentos(sender, intentosRef.current);
    setIntentosUsados(intentosRef.current);
    onGesto("firmando");
    try {
      const prueba = await renovar.prove(sender);
      const siguiente = gestoDespuesDeProve(prueba === null ? { tipo: "null" } : { tipo: "prueba" });
      onGesto(siguiente);
      // Sólo el desenlace feliz re-lee la ventana. `"mecanismo-apagado"` no grabó nada.
      if (siguiente === "idle") onRenovada();
    } catch (e) {
      // 🔴 LA CLASIFICACIÓN VIVE EN `gestoDespuesDeProve` (`flow-vm.ts`) Y NO ACÁ, y no es sólo prolijidad:
      // acá había un `else` que mandaba TODO `throw` no reconocido a `"sin-firma"`, o sea a *"La firma no
      // se completó"*. Eso es FALSO para el input más común de una app de remesas en celular —quedarse
      // sin red, donde `fetch` rechaza con un `TypeError` crudo— y también para
      // `wallet_sign_not_available`, que el bridge tira ANTES de cualquier popup. La pantalla le achacaba
      // a la persona una firma que nunca le pedimos. Ahora el default es `"no-se-pudo-pedir"` y sólo un
      // error que la billetera DECLARA como suyo llega a `"sin-firma"`.
      onGesto(gestoDespuesDeProve({ tipo: "error", error: e }));
    }
  }, [sender, renovar, onGesto, onRenovada]);

  switch (estado) {
    // Estado 1 (`mirando`) y el caso en que no hay nada que leer: NINGÚN texto nuevo. El criterio es
    // que la pantalla no puede afirmar que mira cuando dejó de mirar, no que tenga que afirmar que mira.
    case "no-aplica":
    case "mirando":
      return null;
    // Estado 5 — sin billetera no hay a quién pedirle la firma, así que NO se ofrece el gesto. Ofrecerlo
    // sería un botón que no puede funcionar; el gateway ya corta por su lado con `payout_status_no_wallet`.
    case "sin-billetera":
      return <p className="text-label text-stone">{REVISION_SIN_BILLETERA}</p>;
    // Estado 2 — la ventana está apagada. Presente puro: qué NO está pasando, sin contar qué pasó antes.
    case "sin-prueba":
      return (
        <div className="space-y-ajustado">
          <p className="text-label text-stone">{REVISION_APAGADA}</p>
          {/* ⛔ `disabled` POR DOS RAZONES DISTINTAS, y las dos son frenos del cupo:
              · MIENTRAS FIRMA ⇒ un gesto = como máximo UN challenge. Sin esto, N toques abren N popups.
              · SIN INTENTOS ⇒ el techo de `MAX_CHALLENGES_POR_MONTAJE`. Sin esto el camino de FALLO no
                tiene techo: el botón vuelve habilitado, el copy invita a reintentar, y 6 toques eran 6
                challenges de un cupo de 10 COMPARTIDO POR IP.
              ⚠️ El botón NO desaparece cuando se agota: se deshabilita y se dice por qué. Esconderlo
              dejaría la pantalla sin explicar por qué ya no hay salida. */}
          {/* ── M-4 · los dos botones de esta pantalla dejan de pesar igual ─────────────────────
              🔴 EL ESTADO MEDIDO ERA PEOR QUE "PESAN IGUAL", y va dicho porque el encargo decía otra
              cosa: en 4c24324 este botón era `primary` (cochineal sólido + `shadow-lift`, la única
              variante con sombra) y "Recuperar fondos" era `outline`. O sea que el control que sólo
              CONSULTA era el elemento más fuerte del seguimiento, y el que SACA LOS USDC DEL
              CONTRATO estaba un escalón por debajo. No era empate: estaba al revés.

              ⛔ Y EL ARREGLO NO ES SUBIR "Recuperar fondos" A `primary` **EN ESTA RAMA**: acá el envío
              todavía puede entregarse, o sea que el camino feliz SIGUE VIVO y recuperar no lo resuelve,
              lo abandona. Además este repo ya tiene la lección en `touch-targets.test.tsx` (T-341-6):
              agrandar el control destructivo invita el toque accidental. Se BAJA el que consulta.

              🔴 ACÁ DECÍA "el seguimiento no tiene ningún `primary`, y eso es correcto". Vale para ESTA rama —esperar no es una acción— y era FALSO generalizado a la pantalla:
              en la rama de FALLO el camino feliz murió y recuperar SÍ es `primary` (`showRefund`, `:1795`; decía `:1741`, su línea en `ce4f31e`). La regla, en `ui.tsx`; el candado, en `jerarquia-relativa.test.tsx`.

              El `disabled` no cambia de sentido ni de causas, y el alto tampoco: `h-[52px]` está en
              la clase base del `<Button>` y ninguna variante lo toca. */}
          <Button
            variant="ghost"
            disabled={gesto === "firmando" || sinIntentos}
            onClick={onRevisar}
          >
            {REVISION_GESTO}
          </Button>
          {/* Estado 3 — el popup está abierto. Es texto propio y NO el label del botón, para que el
              control siga siendo alcanzable por su nombre mientras está deshabilitado. */}
          {gesto === "firmando" ? <p className="text-label text-stone">{REVISION_FIRMANDO}</p> : null}
          {/* Estado 6b — el mecanismo está apagado: reintentar NO sirve, y la copy lo dice. Se separa del
              6 porque son la diferencia entre "probá más tarde" y "esto no se arregla probando". */}
          {gesto === "mecanismo-apagado" ? (
            <p className="text-label text-stone">{REVISION_MECANISMO_APAGADO}</p>
          ) : null}
          {gesto === "no-se-pudo-pedir" ? (
            <p className="text-label text-stone">{REVISION_NO_SE_PUDO_PEDIR}</p>
          ) : null}
          {gesto === "sin-firma" ? <p className="text-label text-stone">{REVISION_SIN_FIRMA}</p> : null}
          {sinIntentos && gesto !== "firmando" ? (
            <p className="text-label text-stone">{REVISION_TECHO_ALCANZADO}</p>
          ) : null}
        </div>
      );
  }
  // ⛔ NO ES UN `default`, y la diferencia es la que hace que esto sea un candado: un `default` aceptaría
  // cualquier valor nuevo de la unión y lo renderizaría como nada. Esta línea lo rechaza en `tsc`.
  const nuncaLlega: never = estado;
  return nuncaLlega;
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
  onRecovered, prominencia,
}: {
  remittanceId: string; sender: string;
  recover: NonNullable<Container["recoverEscrowFunds"]>;
  onRecovered: (snapshot: RemittanceState) => void;
  prominencia: "resolutiva" | "alternativa"; // ⛔ OBLIGATORIA Y SIN DEFAULT, por lo mismo que el `explainer` de `CloseEscrowAction`: un default deja que el próximo sitio de montaje herede una decisión que nadie tomó, y acá esa decisión es cuál es la ACCIÓN PRINCIPAL DE UNA PANTALLA. `"resolutiva"` = el camino feliz de esa pantalla ya no existe y esto es lo que la saca del pozo ⇒ `primary`. `"alternativa"` = el camino feliz sigue vivo y esto lo ABANDONA ⇒ `outline`. Los dos sitios de montaje están en `TrackView` y pasan valores distintos. La regla, en `ui.tsx`. ⚠️ Este renglón y el de arriba están apretados en una línea A PROPÓSITO: el hunk tiene que ser línea-neutra o desplaza ~30 citas `flow.tsx:NN` de otros archivos, y a la mayoría no las vigila `citas-ancladas.test.ts`.
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Las órdenes enviadas que la cadena TODAVÍA no confirmó. Deliberadamente efímero (no toca el estado
  // persistido): afirmaría un final que nadie verificó, y `refunded` es terminal.
  //
  // 🔴 UNA LISTA APPEND-ONLY, Y LA FORMA DEL ESTADO **ES** EL ARREGLO. Acá había un
  // `{confirmation, refundTx} | null` que "Volver a intentar" SOBRESCRIBÍA, y encima un `set…(null)` en
  // el camino confirmado. Lo que guarda es la firma de un refund YA TRANSMITIDO cuyo desenlace NADIE
  // conoce — `confirmation` sólo puede ser `"pending"` o `"unknown"` (`EscrowRefundConfirmation`,
  // `ports.ts:339`) —, o sea EXACTAMENTE la firma que la persona necesita para ir al visor a averiguar
  // si entró, y que no está en ningún otro lado: el use-case NO la persiste (sólo escribe `refundTx`
  // cuando confirma), así que este array es su único ejemplar.
  //
  // Es el MISMO defecto que el fix-pack de WKH-346 arregló en la puerta de al lado
  // (`LostEscrowRecovery`, `:2340`) y dejó declarado acá sin tocar, porque AC-9/CD-2 le prohibían este
  // camino de firma. La propiedad "ningún comprobante ya mostrado desaparece" es de la FORMA de CADA
  // estado y no del componente: de "aquella variable es append-only" no se deduce nada sobre esta.
  const [enviados, setEnviados] = useState<
    readonly { confirmation: Exclude<EscrowRefundConfirmation, "confirmed">; refundTx: string }[]
  >([]);
  const onRefund = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await recover.execute({ remittanceId, sender });
      if (res.confirmation === "confirmed") {
        // ⛔ ACÁ NO VA NINGÚN `setEnviados([])`. Acá vivía un `setSent(null)`, y borraba la firma de una
        // orden ANTERIOR cuyo desenlace nadie conoce: si esta confirmó, aquella probablemente no entró,
        // pero "probablemente" no es un hecho que justifique destruir la única prueba de que se
        // transmitió. Lo confirmado tiene su propio lugar durable (`refundTx` en la remesa).
        onRecovered(res.remittance.snapshot); // el estado nuevo manda: la pantalla deja de decir "en camino"
        return;
      }
      // Ni éxito ni fracaso: la orden salió y no sabemos si entró. El botón SIGUE acá.
      // El `confirmation` se saca a un const ANTES del updater porque TypeScript pierde el estrechado
      // del `return` de arriba dentro de una clausura: ahí `res.confirmation` vuelve a incluir
      // `"confirmed"`, que este estado no acepta por tipo. Updater FUNCIONAL a propósito: así
      // `enviados` no entra en el array de deps y el camino que FIRMA queda byte-idéntico. El `some`
      // evita que un reintento que devuelva la MISMA firma duplique la `key` del `.map()`.
      const sinDesenlace = res.confirmation;
      setEnviados((prev) =>
        prev.some((e) => e.refundTx === res.refundTx)
          ? prev
          : [...prev, { confirmation: sinDesenlace, refundTx: res.refundTx }],
      );
    } catch (e) {
      // enum→copy fijo, sin PII (CD-5). Antes era UNA frase para todo, y con el caso indeterminado
      // esa frase mentía: "no encontramos depósito" no es "no pudimos recuperar tus fondos".
      setErr(escrowRefundError(e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
    }
  }, [recover, remittanceId, sender, onRecovered]);

  return (
    <div className="space-y-ajustado">
      <Button variant={prominencia === "resolutiva" ? "primary" : "outline"} onClick={onRefund} disabled={busy}>
        {busy ? "Recuperando…" : enviados.length > 0 ? "Volver a intentar" : "Recuperar fondos"}
      </Button>
      {/* UNA por orden transmitida, y no la última: cada una es una tx distinta cuyo desenlace nadie
          conoce todavía, y la firma es lo único con lo que se puede ir a mirar la cadena. */}
      {enviados.map((e) => (
        <RefundSentNotice key={e.refundTx} confirmation={e.confirmation} refundTx={e.refundTx} />
      ))}
      {err ? <p className="text-label text-cochineal-ink">{err}</p> : null}
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
    <div className="space-y-ajustado" data-testid="close-escrow-action">
      {explainerMode === "own" ? (
        <>
          <p className="text-title font-semibold">{explainer.title}</p>
          <p className="text-body text-stone">{explainer.body}</p>
          <p className="text-label text-stone">{explainer.notRecovered}</p>
        </>
      ) : null}
      {done !== "confirmed" ? (
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {busy ? "Cerrando…" : done ? "Volver a intentar" : "Cerrar y recuperar"}
        </Button>
      ) : null}
      {done ? <p className="text-body text-stone">{escrowCloseSentCopy(done)}</p> : null}
      {err ? <p className="text-label text-cochineal-ink">{err}</p> : null}
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
    <div className="space-y-ajustado">
      {/* "Enviamos la orden", NUNCA "volvieron". */}
      <p className="text-label font-semibold text-ink">Enviamos la orden de recuperación</p>
      <p className="text-label text-stone">
        {confirmation === "pending"
          ? "Todavía no la vemos confirmada en la cadena. Puede entrar en un rato, o puede no haber entrado. Hasta que se confirme no sabemos si tus USDC volvieron."
          : "No pudimos consultar la cadena para saber si entró. Nadie sabe todavía si tus USDC volvieron; no es que hayan fallado."}
      </p>
      <p className="text-label text-stone">Orden enviada: <TxProof signature={refundTx} /></p>
    </div>
  );
}

/**
 * La puerta que faltaba: recuperar un envío que este dispositivo no conoce.
 *
 * 🔴 QUÉ ARREGLA. La recuperación durable ya estaba ENTERA y no tenía ni un consumidor. El endpoint
 * `POST /api/solana/escrow/remittance-ids` está vivo en producción (responde 403 sin PoP), el adapter
 * resuelve el id ausente contra ese store y sondea hasta `MAX_RECOVERY_CANDIDATES` PDAs
 * (`resolveRemittanceIdFromLedger`, `solana-wallet.ts:353`), y el gateway está cableado en el
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
  // 🔴 APPEND-ONLY TAMBIÉN ACÁ, y es el MISMO defecto en el casillero de al lado (AR-2/BLQ-BAJO-1).
  // Esto era un `{confirmation, refundTx} | null` que el desenlace siguiente sobrescribía, y lo que
  // guarda es la firma de un refund YA TRANSMITIDO cuyo desenlace NADIE conoce: `confirmation` es
  // `"pending"` o `"unknown"` (`EscrowRefundConfirmation`, `ports.ts:339`). O sea EXACTAMENTE la firma
  // que la persona necesita para ir al visor a averiguar si entró, y esta HU la volvió prominente y
  // enlazable (`RefundSentNotice`, `:2298`, que la imprime como "Orden enviada:"). Medido antes del arreglo: con `pending` y después
  // `confirmed`, la primera firma desaparecía del DOM; con dos `pending`, quedaba UN solo href.
  //
  // ⚠️ El `sender` va PEGADO a cada entrada, no aparte: es lo que hace que la pantalla no mezcle dos
  // identidades (ver `duenio` abajo).
  const [enviados, setEnviados] = useState<
    readonly {
      sender: string;
      confirmation: Exclude<EscrowRefundConfirmation, "confirmed">;
      refundTx: string;
    }[]
  >([]);
  // 🔴 UNA LISTA APPEND-ONLY, Y LA FORMA DEL ESTADO **ES** EL ARREGLO (AR/BLQ-BAJO-1). Acá había un
  // `useState<string | null>` que el segundo éxito SOBRESCRIBÍA: `SIG2` reemplazaba a `SIG1` y `SIG1`
  // desaparecía del DOM. Y esta puerta existe justamente para escrows que el dispositivo NO conoce —
  // `SIG1` no está en `localStorage`, no está en "Mis envíos", y esto es estado de componente —,
  // así que se destruía la única evidencia en pantalla de un movimiento de dinero que ya ocurrió. La
  // plata no se pierde (la cadena es autoritativa); se pierde la prueba que esta HU vino a hacer
  // usable. La población afectada es EXACTAMENTE la que motivó la frase de AC-7: quien tiene dos o
  // más envíos perdidos.
  //
  // De las cinco variantes evaluadas, acumular es la ÚNICA en la que "ningún comprobante ya mostrado
  // desaparece" no depende de que nadie vuelva a tocar el disparador: con una lista append-only no hay
  // edición de UNA línea que pierda un comprobante sin cambiar la forma del estado. Deshabilitar el
  // botón tras el primer éxito lo cumplía también, pero borrando la feature que AC-7 existe para
  // habilitar; persistir en `localStorage` cambia lo que esta puerta ES.
  //
  // ⚠️ ALCANCE EXACTO DE ESA GARANTÍA, y acá mi primera versión afirmaba de más (AR-2/BLQ-BAJO-1).
  // Decía "imposible de violar POR CONSTRUCCIÓN", y eso valía para ESTA VARIABLE, no para el
  // componente: al lado vivía `sent`, un casillero único con la firma de un refund ya transmitido, y se
  // sobrescribía igual que `recovered` antes. La propiedad es de la FORMA de cada estado, y sólo cubre
  // los estados que tienen esa forma. Hoy los DOS la tienen (`enviados` arriba), y por eso la frase se
  // puede sostener para los dos comprobantes; lo que no se puede es deducirla del componente.
  const [recuperados, setRecuperados] = useState<readonly { sender: string; refundTx: string }[]>([]);
  // 🔴 EL SENDER cuya última búsqueda dijo "en la ventana que miramos no hay ninguno abierto", NO un
  // booleano (AR-2/MNR-9). Como booleano, esto decidía con el `recuperados` de la identidad ANTERIOR:
  // la billetera A recuperaba, se cambiaba de billetera, la B contestaba `escrow_not_found`, y la
  // pantalla contaba como UN relato el comprobante de A y el cierre de ventana de B, suprimiendo el
  // error de B con un éxito que no fue de B. Cada frase era cierta; el compuesto y el "esta billetera"
  // no. Los códigos que NO lo prenden están enumerados en `esVentanaSinAbiertos`
  // (`esVentanaSinAbiertos`, `flow-vm.ts:1138`), en su docblock. ⚠️ Y desde el fix-pack de WKH-347 `escrow_index_absent` SÍ lo prende: es cierto (a ese código se llega con la ventana del servidor ya recorrida y sin ninguno abierto) y sin eso el cierre de ventana no se prendía para NINGUNA billetera existente. El motivo medido está en ese mismo docblock.
  const [sinAbiertos, setSinAbiertos] = useState<string | null>(null);
  // La identidad de la ÚLTIMA búsqueda. Todo lo que la tarjeta muestra se filtra por acá: la frase de
  // cierre dice "esta billetera", así que no puede estar al lado del comprobante de otra.
  const [duenio, setDuenio] = useState<string | null>(null);

  // Derivados puros, no estados nuevos que puedan quedar desincronizados.
  const misRecuperados = recuperados.filter((r) => r.sender === duenio);
  const misEnviados = enviados.filter((e) => e.sender === duenio);
  // "No queda ninguno abierto" es el final EXITOSO del camino sólo si YA SE RECUPERÓ ALGO **DE ESTA
  // MISMA BILLETERA**. Si no se recuperó nada, `escrow_not_found` en el primer click sigue siendo el
  // error de siempre y se pinta como tal (regresión T-346-16); y si lo recuperado es de otra identidad,
  // tampoco: para esta billetera no hubo ningún éxito en el que apoyarse.
  const caminoTerminado =
    duenio !== null && sinAbiertos === duenio && misRecuperados.length > 0;

  const onRecover = useCallback(async () => {
    if (!refund) return;
    setBusy(true);
    setErr(null);
    // Se reinicia en CADA búsqueda porque describe a la ÚLTIMA: volvemos a preguntar, así que todavía
    // no sabemos. ⛔ Lo que NO se reinicia acá es `recuperados` ni `enviados`: resetearlos es el bug de
    // arriba formalizado, y haría desaparecer `SIG1` al hacer click, antes de saber nada.
    setSinAbiertos(null);
    // La identidad hace falta en el `catch` y `sender` vive dentro del `try`: si `resolveSender()` es lo
    // que falla, no hay ninguna billetera a la que atribuirle la respuesta, y queda `null`.
    let quien: string | null = null;
    try {
      const sender = await resolveSender();
      quien = sender;
      setDuenio(sender);
      // SIN `remittanceId`: es la firma que dispara la resolución contra el store durable.
      const res = await refund.refund({ sender });
      if (res.confirmation === "confirmed") {
        // Updater FUNCIONAL a propósito: así `recuperados` no entra en el array de deps de este
        // `useCallback` y el camino que FIRMA queda byte-idéntico (CD-24 / AC-9). El `some` evita que
        // una firma repetida duplique la `key` del `.map()` del render.
        setRecuperados((prev) =>
          prev.some((r) => r.refundTx === res.refundTx)
            ? prev
            : [...prev, { sender, refundTx: res.refundTx }],
        );
        return;
      }
      // ⛔ ACÁ NO VA NINGÚN `setEnviados([...])` NI NINGÚN reset: la orden anterior sigue sin desenlace
      // conocido, así que su comprobante sigue siendo la única forma de averiguarlo.
      // El `confirmation` se saca a un const ANTES del updater porque TypeScript pierde el estrechado
      // del `return` de arriba dentro de una clausura: `res.confirmation` ahí vuelve a incluir
      // `"confirmed"`, que este estado no acepta por tipo.
      const sinDesenlace = res.confirmation;
      setEnviados((prev) =>
        prev.some((e) => e.refundTx === res.refundTx)
          ? prev
          : [...prev, { sender, confirmation: sinDesenlace, refundTx: res.refundTx }],
      );
    } catch (e) {
      // El copy de ESTA puerta, no el de la otra: acá "no encontramos nada" no puede leerse como
      // "no tenés fondos" (ver `lostEscrowRecoveryError`).
      const code = e instanceof Error ? e.message : "";
      setErr(lostEscrowRecoveryError(code, MAX_RECOVERY_CANDIDATES));
      // 🔴 LO PRENDEN DOS DESENLACES Y NO UNO (fix-pack r2 de WKH-347: acá decía "SÓLO este desenlace" y el `if` de abajo ya había cambiado de dominio). Son `escrow_not_found` y `escrow_index_absent`: los dos significan "se miró y no hay ninguno abierto".
      // Los demás NO, y el caro es `escrow_index_unreadable` — no pudimos leer la cadena, así que ahí "puede haber más" sigue siendo verdad. Igual `escrow_recovery_unavailable`, que llega con cinco
      // productores (`escrow_id_unavailable`, `flow-vm.ts:329`) y ninguno afirma que la ventana esté vacía. Quién los separa es el predicado de abajo, delegando en el copy; no hay una lista de códigos acá.
      // Prenderlo para cualquier error es el mutante N-4 y lo mata `T-346-15`; que el índice ausente SÍ entre lo prueban los tres `it` nuevos de `lost-escrow-recovery.test.tsx`.
      // Se guarda CUÁL billetera lo dijo: prenderlo sin identidad deja que el éxito de otra lo lea como
      // el final de su camino (AR-2/MNR-9, mutante N-6).
      if (quien !== null && esVentanaSinAbiertos(code, MAX_RECOVERY_CANDIDATES)) setSinAbiertos(quien);
    } finally {
      setBusy(false);
    }
  }, [refund, resolveSender]);

  // Sin gateway no hay puerta que ofrecer. El container real siempre lo cablea; el de tests no.
  if (!refund) return null;

  if (!open) {
    return ( // WKH-063 (2º pase) · EL ENVOLTORIO Y EL RENGLÓN ENTRAN EN LA LÍNEA DE ABAJO Y EN LA DEL `</button>`, no en líneas nuevas: `flow.tsx:2477` es una cita ANCLADA de `touch-targets.test.tsx` y una línea de más la corre. 🔴 QUÉ ARREGLA EL RENGLÓN: esta puerta era un enlace subrayado con su nombre y NADA MÁS, igual que su vecina, así que para saber cuál de las dos era la tuya había que abrir una y leerle tres párrafos. `QUE_RECUPERA` (`recuperar.tsx`) dice en una línea lo único que permite elegir sin clickear: esta busca USDC, la otra busca SOL. Vive allá y no acá porque el riesgo del par es que los dos renglones digan lo mismo, y eso sólo se ve leyéndolos juntos. ⛔ El `min-h-[52px]` sigue en el `<button>` y no en este `<div>`: lo que AC-5 mide es el área que la persona TOCA, y el renglón no es tocable.
      <div className="space-y-ajustado py-normal"><button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[52px] w-full items-center justify-start text-left text-label font-medium text-cochineal underline underline-offset-2"
      >
        Recuperar un envío perdido
      </button><Muted escala="label">{QUE_RECUPERA.envioPerdido}</Muted></div>
    );
  }

  return (
    <Aviso className="space-y-normal">
      <h2 className="text-title font-bold">Recuperar un envío perdido</h2>
      <p className="text-body text-stone">
        Si borraste los datos del navegador o entrás desde otro dispositivo, tus envíos no aparecen
        en "Mis envíos". Los buscamos preguntándole al servidor por tu billetera.
      </p>
      <p className="text-body text-stone">
        Tu billetera te va a pedir una firma para probar que es tuya: es un texto, no mueve fondos y
        no paga comisión de red. Si encontramos un escrow abierto te va a pedir una segunda firma, y
        esa sí es la transacción que saca tus USDC; su comisión de red la pagás vos.
      </p>
      <Button variant="outline" onClick={onRecover} disabled={busy}>
        {busy ? "Buscando…" : "Buscar mis escrows"}
      </Button>
      {/* 🔴 LAS DOS FRASES DEL FINAL VIVEN ADENTRO DE ESTE BLOQUE, y la POSICIÓN es la mitad del
        * arreglo: montadas afuera, la tarjeta afirmaría "puede haber más envíos con fondos por
        * recuperar" recién abierta la puerta, sin haberle preguntado nada a la cadena. Es la SEGUNDA
        * encarnación del mismo defecto en este archivo: el CR de WKH-327 lo arregló en el componente
        * INMEDIATAMENTE SIGUIENTE (`explainer`, `flow.tsx:2587`), a unas pocas decenas de líneas de
        * donde nació este. ⚠️ Acá decía "48 líneas" y era una CIFRA QUE ENVEJECE SOLA: es una
        * distancia, y mis propias inserciones la movieron a 60 sin que ningún barrido la cazara
        * (AR-2/MNR-7). Lo que no envejece es la relación estructural, y es la que importa. Un test de
        * PRESENCIA no lo ve; sólo lo ve uno que mire el DOM ANTES de buscar (`T-346-12`). */}
      {misRecuperados.length > 0 ? (
        <div className="space-y-ajustado">
          <p className="text-label font-semibold text-ink">Recuperaste tus fondos</p>
          {/* La MISMA frase que el historial usa para ese hecho, no una segunda versión. Sigue en
              singular a propósito: "Recuperaste 2 envíos" es un número que SÍ sabemos, pero es alcance
              nuevo y no lo pidió nadie. El encabezado funciona en singular y en plural. */}
          <p className="text-label text-stone">{escrowKnowledgeCopy("returned")}</p>
          {misRecuperados.map((r) => (
            <p key={r.refundTx} className="text-label text-stone">
              Comprobante: <TxProof signature={r.refundTx} />
            </p>
          ))}
          <p className="text-label text-stone">
            {caminoTerminado
              ? recoveryWindowExhausted(MAX_RECOVERY_CANDIDATES)
              : recoveryMoreEscrowsHint(MAX_RECOVERY_CANDIDATES)}
          </p>
        </div>
      ) : null}
      {/* UNA por orden transmitida, y no la última: cada una es una tx distinta cuyo desenlace nadie
          conoce todavía. `RefundSentNotice` sigue BYTE-IDÉNTICO y lo comparte con `RefundAction`
          (`RefundAction`, `flow.tsx:2138`), que hoy acumula igual: WKH-346 no pudo (AC-9), otra HU sí. ⚠️ Decía `:1952`, y eso NO es regresión de WKH-063: en `ce4f31e` la línea 1952 ya era `onRenovada,` — la cita nació rota y el candado no la veía porque su predicado sólo miraba comentarios que ARRANCAN la línea, y ésta es la continuación de un bloque (CR/BLQ-BAJO-1). Ahora sí la ve. */}
      {misEnviados.map((e) => (
        <RefundSentNotice key={e.refundTx} confirmation={e.confirmation} refundTx={e.refundTx} />
      ))}
      {/* 🔴 `!caminoTerminado`: que la app informe "no queda ninguno abierto" DESPUÉS de haber
          recuperado al menos uno es el final EXITOSO del camino, no un error, y por eso no se pinta con
          el color del error. Sin esta guarda la tarjeta decía al mismo tiempo "Recuperaste tus fondos",
          el comprobante, y en `text-cochineal-ink` que ninguno de los últimos N está abierto: la app
          acababa de averiguar que terminó y seguía hablando como si algo hubiera fallado. ⛔ Con
          `recuperados` vacío la guarda no aplica y el error se pinta igual que siempre (T-346-16). */}
      {err && !caminoTerminado ? <p className="text-label text-cochineal-ink">{err}</p> : null}
    </Aviso>
  );
}

/**
 * WKH-327/AC-8 — la puerta para recuperar el alquiler de envíos que este dispositivo no conoce.
 *
 * POR QUÉ VIVE ACÁ Y NO EN OTRO LADO — las tres razones, con lo que se rompería si se hiciera distinto:
 *
 *  1. NO en `HistoryView`. ⚠️ La PREMISA original de esta razón se cayó con WKH-349: esa pantalla sí
 *     consulta la cadena ahora, por el estado de las PDAs de sus propias filas. La CONCLUSIÓN no se
 *     cayó, y el motivo que la sostiene solo es el otro que ya estaba escrito acá: el historial está
 *     scopeado por `localStorage` y AC-8 exige justamente cubrir los envíos que NO están ahí.
 *  2. NO adentro de `LostEscrowRecovery`. Esa puerta promete encontrar escrows ABIERTOS con tus USDC, y
 *     su copy de "no encontré nada" lo dice medido: "ninguno de los últimos N envíos… está ABIERTO en
 *     el contrato" (`flow-vm.ts`, `lostEscrowRecoveryError`). Un escrow terminal NO está abierto: meter
 *     los cerrables ahí volvería FALSA una frase que hoy es verdadera. Son dos preguntas distintas a la
 *     misma cadena.
 *  3. SÍ al lado de su vecina, y ya está `resolveSender`, que es lo que el PoP del endpoint exige: cero mecanismo nuevo. ⚠️ ACÁ DECÍA "SÍ en `send`, porque es donde aterriza toda recarga", y esa PREMISA se cayó con WKH-063: la recarga aterriza en la pantalla de entrada y las dos puertas viven en el destino "Recuperar" (`DestinoRecuperar`), a un toque de la barra.
 *     La CONCLUSIÓN no se cayó y es lo que esta lista defiende: las dos juntas, en la misma pantalla, y ninguna adentro del historial. Que desde los DOS aterrizajes (la entrada y `send`) siga habiendo camino hasta ahí es un invariante con test propio en `history.test.tsx`. Reemplazo línea-neutra, 2 por 2: agregar líneas acá corre las ~muchas citas por número de este archivo (el número y su definición viven en UN solo lugar, `:44`).
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
    return ( // WKH-063 (2º pase) · MISMA receta que su vecina y por el MISMO motivo (`flow.tsx:2627` también es una cita anclada de `touch-targets.test.tsx`): el envoltorio va en la línea de abajo y el renglón pegado al `</button>`. Este es el que más falta hacía de los dos, porque su nombre visible es el que un AR ya marcó como jerga: "el depósito de red de envíos anteriores" no dice que lo que vuelve es SOL y no USDC, ni que sólo se puede con un envío YA TERMINADO — las dos cosas están en `escrowRentExplainer("discovery")`, o sea a un click de distancia y no antes.
      <div className="space-y-ajustado py-normal"><button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[52px] w-full items-center justify-start text-left text-label font-medium text-cochineal underline underline-offset-2"
      >
        Recuperar el depósito de red de envíos anteriores
      </button><Muted escala="label">{QUE_RECUPERA.depositoDeRed}</Muted></div>
    );
  }

  return (
    <Aviso className="space-y-normal">
      <h2 className="text-title font-bold">{explainer.title}</h2>
      <p className="text-body text-stone">{explainer.body}</p>
      <p className="text-label text-stone">{explainer.notRecovered}</p>
      <p className="text-body text-stone">
        Tu billetera te va a pedir una firma para probar que es tuya: es un texto, no mueve fondos y
        no paga comisión de red. Después, por cada envío que cierres, te va a pedir la firma de esa
        transacción, y su comisión de red la pagás vos.
      </p>
      <Button variant="outline" onClick={onSearch} disabled={busy}>
        {busy ? "Buscando…" : "Buscar envíos con cuentas abiertas"}
      </Button>
      {found && found.length > 0 && close && sender ? (
        <div className="space-y-normal">
          {found.map((e) => (
            <div key={e.remittanceId} className="space-y-ajustado border-t border-line pt-ajustado">
              <p className="text-label text-stone">Envío {e.remittanceId}</p>
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
      {err ? <p className="text-label text-cochineal-ink">{err}</p> : null}
    </Aviso>
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
    <div className="space-y-normal">
      {/* La cifra héroe COMPLETA, y es el único sitio donde ya estaban las tres piezas que M-2
          pide: rótulo arriba, cifra, y el destino debajo en tono secundario. Lo que faltaba era la
          jerarquía: los tres se leían con el mismo peso adentro de la misma caja gris. */}
      <div className="text-center">
        <Muted escala="label">{rem.beneficiary.name} va a recibir</Muted>
        <Money tono="verde" className="mt-ajustado">
          {rem.quote ? rem.quote.receive.format() : "—"}
        </Money>
        <Muted escala="label" className="mt-ajustado">
          en {methodLabel(rem.beneficiary.method)} · {rem.beneficiary.destination}
        </Muted>
      </div>
      <div className="flex items-start gap-ajustado.5">
        {/* 🔴 RELOJ QUIETO, NUNCA UN SPINNER. Mi primera versión de esta tarjeta puso un spinner y el
            test lo tumbó, con razón: hay una decisión deliberada de que en este paso NADA gire,
            porque un spinner dice "trabajando" y lo que pasa es "esperando". Es el mismo criterio
            que el icono del paso en la lista de arriba. */}
        <Clock3 className="mt-0.5 size-icono-sm shrink-0 text-cochineal" />
        <div>
          {/* "El proveedor está procesando el desembolso" contradecía al comentario de TRACK_STEPS
              quince líneas más arriba, que dice de este mismo estado: "Nadie está pagando todavía".
              En `payout_submitted` lo único que pasó es que el agente aceptó crear la orden; los USDC
              siguen en el vault y el release lo dispara una persona a mano. El verbo ahora es el de
              lo que sabemos: aceptó. */}
          <p className="text-body font-medium">El proveedor aceptó la orden de pago</p>
          {/* Las dos mitades honestas, JUNTO al titular y no escondidas más abajo. La segunda es la
              frase que estaba antes: este paso no avanza solo. Se conserva el hecho y cambia el
              lugar, porque enterrarlo sería prometer un automatismo que no existe.
              "Tus USDC ya están en el contrato" (presente, continuo) afirmaba más que `principalTx`,
              que prueba un hecho PASADO: la cadena confirmó que el depósito entró. Nadie volvió a
              mirar el vault DESDE ACÁ. Desde WKH-349 el historial de esta misma remesa sí lo mira y
              dice qué contestó el contrato. La regla no cambia —dos pantallas no pueden contar dos
              historias— y la relación es: el historial mide, ésta no, y por eso ésta no afirma más. */}
          <p className="mt-0.5 text-label text-stone">
            Vimos entrar tus USDC al contrato, a tu nombre. Todavía no tenemos la confirmación de que
            el dinero llegó a destino, así que no te lo vamos a decir hasta tenerla.
          </p>
          <p className="mt-ajustado text-label text-stone">
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
        // M-6 · la SEGUNDA señal de "esto es un entorno de prueba". Era un punteado sobre nada, con
        // un padding propio (12/8) y sin fondo; la píldora de arriba era una superficie sólida sin
        // borde. Ahora las dos hablan el punteado sobre arena que `Aviso tono="prueba"` ya declaraba.
        // ⛔ El texto no se fusiona con el de la píldora: son dos afirmaciones distintas.
        <Aviso tono="prueba">
          <p className="text-label text-stone">
            <strong>Entorno de prueba.</strong> Al menos uno de los pasos de este envío (la
            cotización, la verificación o el desembolso) no está confirmado como real. El depósito en
            la cadena sí es real y se puede ver en el explorador.
          </p>
        </Aviso>
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
     *   (`this.solana`, `../application/use-cases/confirm-and-send.ts:390` ⇒ `settlement_unavailable`).
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
        <p className="text-title font-semibold">Quién va a atender tu envío</p>
        <p className="mt-ajustado text-label text-stone">
          No pudimos consultar el catálogo ahora. Tu envío sigue igual: esto es informativo.
        </p>
      </Card>
    );
  }
  if (!plan) return null;

  return (
    <Card>
      <p className="text-title font-semibold">Quién va a atender tu envío</p>
      {/* "Ninguno de estos pasos está atado a una empresa fija" quedaba desmentido tres renglones
          más abajo por el propio detalle de cada fila: la que decía "hoy se llama directo a X" ERA un
          paso cableado a un agente concreto. Esa fila ya no existe (W3), y aun así la frase de arriba
          sigue describiendo el MODELO (pedimos capacidades) sin afirmar que hoy los tres corran por
          ahí: cada fila lo dice por su cuenta, y en demo la cotización no la da ningún agente. */}
      <p className="mt-ajustado text-label text-stone">
        Chaski pide capacidades, no empresas: el catálogo abierto responde quién las cumple, así que
        esta lista puede cambiar sola. Abajo, por dónde corre hoy cada paso.
      </p>
      <div className="mt-normal space-y-ajustado">
        {plan.steps.map((s) => (
          <div key={s.capability} className="rounded-control border border-line px-normal py-ajustado">
            <div className="flex items-baseline justify-between gap-ajustado">
              <span className="text-body font-medium">{s.label}</span>
              <span className="tabular-nums text-body">
                {s.agent?.priceUsdc != null ? `${s.agent.priceUsdc} USDC` : "sin precio publicado"}
              </span>
            </div>
            {s.agent ? (
              <>
                <p className="mt-0.5 text-label text-stone">
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
      <div className="mt-normal flex items-baseline justify-between">
        <span className="text-label text-stone">Precio publicado en el catálogo</span>
        <span className="tabular-nums text-body font-semibold">{plan.totalUsdc} USDC</span>
      </div>
      {/* La nota se elige leyendo LOS DOS legs, porque habla del número, y el número suma los steps con
          precio publicado. La regla es "sólo se afirma lo que la pata garantiza": si la ENTREGA no
          garantiza nada, la atribución se acota nombrando la pata de la COTIZACIÓN, y de la otra no se
          dice nada. Si el leg de la cotización no se puede identificar, no se afirma NADA y no se
          renderiza nota: ver el docblock de `AGENT_PRICE_NOTE_*`. */}
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
        return <p className="mt-ajustado text-label text-stone">{nota}</p>;
      })()}
      <PlanConstraintsNote steps={plan.steps} />
      <p className="mt-ajustado text-label text-stone">
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
    <p className="mt-ajustado text-label text-stone">
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
      <p className="mt-0.5 text-label text-stone">
        El catálogo no ofrece a nadie para esta capacidad
        {typeof constraints?.minReputation === "number"
          ? ` con al menos ${constraints.minReputation} de reputación, que es el piso de este paso`
          : ""}
        .
      </p>
    );
  }
  return (
    <p className="mt-0.5 text-label text-stone">
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
 * bandera cablea la cotización (`FallbackQuoteGateway`, `container.ts:123`) —el ESTADO del payout ya no: WKH-337 lo lee del ledger—, NO la entrega:
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
 * `../application/use-cases/confirm-and-send.ts:390`). La salida es atribución POR PATA, en modo
 * *"sólo se afirma lo que la pata garantiza"*: son tres notas, y la del cuadrante con las DOS banderas
 * encendidas —los dos legs por el gateway— no cambió una letra, porque ahí *"ese fee"* es cierto y
 * acotarla perdería información verificable.
 *
 * ⚠️ Y DE LA ENTREGA, LA NOTA ACOTADA NO DICE NADA. A PROPÓSITO, Y NO SE "COMPLETA". Lo natural sería
 * agregar *"y el fee de la entrega no lo paga nadie, porque ese paso no corre"*. Es verdad
 * (`this.solana`, `../application/use-cases/confirm-and-send.ts:390`) y está PROHIBIDO escribirlo: en
 * ese mismo cuadrante, tres renglones más arriba en la MISMA tarjeta, la fila de la entrega dice
 * *"esta app está en modo demo y lo simula"* (`simula`, `flow.tsx:3209`). Ese *"lo simula"* es impreciso
 * —con el settle apagado la entrega no se simula, se corta— pero es **H1 de WKH-336**, residual de otra
 * HU que exige un TERCER valor de `transport` con su propia frase, y WKH-338 no lo cierra. Si la nota
 * dijera *"la entrega no corre"* mientras la fila dice *"lo simula"*, la tarjeta se contradiría a sí
 * misma en pantalla, y hay un `it` cuyo eje literal es exactamente eso: *"no niega lo que cada fila
 * afirma"*, en `honest-copy.test.tsx:432`. Es el mismo criterio que este archivo ya escribió dos veces:
 * se dice menos y no se inventa la distinción.
 *
 * ⚠️ LO QUE TAMPOCO SE CERRÓ: el singular. Las DOS notas que atribuyen el pago dicen *"al ejecutar el
 * paso"*, y con las dos banderas encendidas Chaski paga DOS. (La del demo no atribuye.) Heredada de
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
 * habla del NÚMERO, y el número suma los steps con precio publicado, o sea que cubre a las DOS patas
 * sólo cuando las dos publican precio. Para afirmar algo hay que identificarlas, y ésta es la segunda.
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

// 🔴 ACÁ DECÍA ", no lo que se cobra en este envío", Y SE BORRÓ (WKH-338/H-1). Era la variante ELIDIDA
// del claim que el AR de WKH-336 ya refutó una vez —*"nadie lo cobra"*, acotado entonces a *"la persona
// no lo paga"*—: no dice quién no cobra, así que se lee como que el número no se le cobra a nadie. Y esta
// nota se muestra también en el cuadrante adapter en `"fallback"` + settle ENCENDIDO, donde el fee de la
// ENTREGA sí se cobra, contra la Agent Key de Chaski (`solanaSettleOn`, `container.ts:141`). La cláusula
// que sigue —"no se suma a lo que enviás"— ya dice lo verdadero y acotado a la persona, así que la de
// arriba no aportaba y podía leerse falsa. Es una SUPRESIÓN, no una reescritura: no toca "la armó la app,
// no ellos", que es lo que los asserts de este texto matchean. Lo custodia T-338.4.
const AGENT_PRICE_NOTE_DEMO =
  "Es lo que estos agentes publican en el catálogo: no se suma a lo que enviás, y la cotización que estás aprobando la armó la app, no ellos.";
const AGENT_PRICE_NOTE_GATEWAY =
  "Es lo que estos agentes publican en el catálogo. Por el carril del gateway ese fee lo paga Chaski con su Agent Key al ejecutar el paso, y no se suma a lo que enviás.";
// 🔴 LA ÚLTIMA CLÁUSULA DICE "ninguno de estos precios" Y NO "no", Y ESO ES EL ARREGLO DE AR/MNR-3.
// Decía *"…, y no se suma a lo que enviás"*, y al acotar la atribución a la pata de la cotización el
// sujeto de ESA garantía se acotó con ella: se leía como que sólo el fee de la cotización no se le suma
// a la persona. La garantía es más ancha y es **cierta en los cuatro cuadrantes para las DOS patas** (lo
// dice el encabezado de `agent-plan-card.test.tsx`: *"no se le cobra a la persona, no se suma a lo que
// envía"*), así que acotarla era perder información cierta y verificable. Acotar la ATRIBUCIÓN no obliga
// a acotar la GARANTÍA: son dos afirmaciones distintas sobre el mismo número.
// ⚠️ Y el sujeto es "estos precios", en plural, y NO "esto": *"nada de esto"* deja el antecedente
// ambiguo entre el fee de la cotización —el sujeto inmediatamente anterior— y los precios de catálogo,
// que es justo la ambigüedad que hizo perder la información. "estos precios" lo ata al sujeto plural de
// la primera oración (*"estos agentes publican"*). Y no afirma QUÉ suma el número (CD-9): habla de los
// precios que se muestran, no de la composición del total. Lo custodia T-338.3 en el cuadrante 2.
const AGENT_PRICE_NOTE_GATEWAY_SOLO_FX =
  "Es lo que estos agentes publican en el catálogo. Por el carril del gateway, el fee de la cotización lo paga Chaski con su Agent Key al ejecutar el paso, y ninguno de estos precios se suma a lo que enviás.";

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
 *   `../application/use-cases/confirm-and-send.ts:390` ⇒ `settlement_unavailable`). No se corrige acá
 *   porque exige un TERCER valor de `transport` con su propia frase, y hoy los dos strings de abajo están
 *   asserteados literalmente en tres sitios: cambiarlos a medias pone rojos tests ajenos.
 */
function AgentRunsToday({ transport }: { transport: "gateway" | "demo" }) {
  if (transport === "gateway") {
    return (
      <p className="mt-0.5 text-label text-stone">
        Hoy este paso corre por el gateway, que elige al ejecutar: puede tocarle otro.
      </p>
    );
  }
  return (
    <p className="mt-0.5 text-label font-medium text-cochineal-ink">
      Hoy este paso no lo corre ningún agente: esta app está en modo demo y lo simula.
    </p>
  );
}

// El "2 horas" estaba escrito a mano al lado de una constante que lo decide. Hoy coincide; el día que
// alguien mueva `CUSTODY_WINDOW_SECS` la frase pasa a ser falsa sin que nada se ponga rojo, que es
// exactamente cómo nació el bug de la hora inventada que este archivo ya arregló una vez. Se deriva
// del MISMO valor que el depósito escribe como deadline (`CUSTODY_WINDOW_SECS`, `solana-wallet.ts:593`), así que no puede
// desincronizarse. No agrega peso al bundle: (`SolanaWalletAdapter`, `container.ts:47`) ya importa este módulo.
const CUSTODY_WINDOW_HOURS = CUSTODY_WINDOW_SECS / 3600;

function RefundWindowNote() {
  return (
    <p className="text-label text-stone">
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
// mismo error de esta pantalla, sólo que hacia el otro lado. ⚠️ R-2 (WKH-349) — RESIDUAL VIVO, EN ESTA LÍNEA para no rotar las citas por número que este archivo recibe: `escrowFundsAtRisk` cuenta el bucket `unverified` SÓLO con el snapshot local, así que desde WKH-349 la pantalla de al lado puede saber más que esta advertencia. El input que lo demuestra: una remesa `unverified` cuya PDA está `Released` — el historial dice que sus USDC ya salieron del escrow y acá se la sigue contando entre las que "no comprobamos". Es el MISMO defecto que esa HU arregló, en otra pantalla; quedó fuera de su alcance y NO se arregló acá.
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
// QUÉ CONSULTA ESTA PANTALLA, desde WKH-349. Muestra el snapshot guardado y dice de cuál de cuatro
// cosas se trata (escrowFundsKnowledge), incluido lo que la cadena ya había contestado y quedó
// escrito. Y para el ÚNICO bucket que ese cálculo no puede resolver —`unverified`, que es "se depositó
// y nadie volvió a mirar"— le pregunta a la cadena, en el MENOR NÚMERO DE LLAMADAS —el batch se trocea a `ESCROW_STATE_BATCH_CEILING`, así que desde la fila 101 son dos—, en qué estado
// está la PDA `escrow_state` de esas filas. Nunca pregunta por las otras tres: su desenlace ya está
// determinado localmente y una respuesta de cadena sólo podría contradecir un marcador ya escrito.
//
// QUÉ SIGUE SIN CONSULTAR, y es la honestidad del párrafo de abajo ("son los envíos guardados en este
// dispositivo"): los envíos que NO están en este `localStorage`. La consulta se arma con los ids que
// la lista ya trae, así que un envío que este navegador no conoce sigue sin aparecer acá. Esa frase
// sigue siendo verdadera después de esta HU, y el input que la refutaría es un envío ajeno a este
// almacenamiento apareciendo en la lista.
//
// QUÉ NO PRUEBA LA RESPUESTA: que la PDA no exista no dice a dónde fue la plata (no distingue "nunca
// entró" de "ya se cerró"), y que el vault se haya liberado no dice que la familia haya cobrado. Cada
// valor lo declara en su propio bullet, en el docblock de `EscrowChainState` (`../application/ports`).
//
// Y lo que NO hace, que se decidió y no se olvidó: no firma nada. Ni prueba de posesión, ni
// `signMessage`, ni una transacción. Una app que pide una firma por mirar una lista entrena a la
// gente a firmar cualquier cosa.
//
// Exportado para test directo, mismo criterio que TrackView y Receipt.
export function HistoryView({
  items,
  onOpen,
  onBack,
  reader,
  sender,
}: {
  items: RemittanceState[];
  onOpen: (rem: RemittanceState) => void;
  onBack: () => void;
  // WKH-349. ⚠️ LAS DOS SON OPCIONALES A PROPÓSITO, y no es tolerancia: `history.test.tsx` renderiza
  // esta pantalla con tres props y sin ellas ese render deja de compilar. Además son el input del caso
  // "no se preguntó" —distinto de "no pudimos preguntar"—, que sin opcionalidad no se podría escribir.
  reader?: SolanaEscrowChainStateReader;
  sender?: string | null;
}) {
  // AC-1 + AC-6 + AC-8, en una línea: se pregunta por el COMPLEMENTO EXACTO de lo que el snapshot ya
  // sabe. Las filas `no-deposit`, `in-escrow` y `returned` no entran, así que no cuestan ni una cuenta
  // en el batch ni pueden recibir un desenlace de cadena que contradiga su marcador local.
  const idsAConsultar = useMemo(
    () => items.filter((r) => escrowFundsKnowledge(r) === "unverified").map((r) => r.id),
    [items],
  );
  // Tres formas y no un booleano: "no se preguntó" (`not-asked`), "se preguntó y no volvió"
  // (`pending`) y "contestó" (el Map). Colapsar la primera con la tercera haría que una pantalla sin
  // reader cableado acusara un fallo de una consulta que nunca existió.
  const [chain, setChain] = useState<"not-asked" | "pending" | ReadonlyMap<string, EscrowChainState>>(
    "not-asked",
  );
  // 🔴 LA CONSULTA VIVE ACÁ Y NO EN `openHistory` (`:412`; decía `:396`, su línea en `ce4f31e`), y el motivo es la persona, no la prolijidad:
  // `openHistory` corre dentro de `guard(...)`, que catchea y manda el error al banner ANTES de
  // `setStep("history")`. Un RPC caído ahí deja a la persona SIN PANTALLA. Acá deja la pantalla entera
  // y una frase por fila que dice que no pudimos preguntar. Candado: T-U6 en `history-onchain.test.tsx`.
  useEffect(() => {
    // Sin reader, sin dueño resuelto o sin filas que preguntar NO se emite ninguna llamada, y el estado
    // queda en `"not-asked"`: la pantalla dice exactamente lo que decía antes de esta HU.
    if (!reader || !sender || idsAConsultar.length === 0) return;
    let cancelled = false;
    setChain("pending");
    reader
      .readEscrowStates({ sender, remittanceIds: idsAConsultar })
      .then((states) => {
        if (!cancelled) setChain(states);
      })
      .catch(() => {
        // El adapter TIRA cuando no puede ni empezar (sender que no es base58, un import que falla).
        // Se arma el mapa de `"unknown"` explícito en vez de dejar un Map vacío: un vacío se leería
        // igual fila por fila, pero por accidente y no por decisión.
        if (!cancelled)
          setChain(new Map(idsAConsultar.map((id) => [id, "unknown" as EscrowChainState])));
      });
    return () => {
      cancelled = true;
    };
  }, [reader, sender, idsAConsultar]);
  // `idsAConsultar` sale de un `useMemo` sobre `items`: entre dos renders con la misma lista es el
  // MISMO array, así que este efecto corre una vez por apertura y no una vez por render. Candado: T-U9.
  const answerFor = (id: string): EscrowChainAnswer =>
    chain === "not-asked" || chain === "pending" ? chain : (chain.get(id) ?? "unknown");
  return (
    <div className="space-y-holgado">
      <Card className="space-y-ajustado">
        <h2 className="text-title font-semibold">Tus envíos</h2>
        {/* De dónde sale esta lista, dicho antes de que la persona saque conclusiones de que esté vacía. */}
        <p className="text-label text-stone">
          Son los envíos guardados en este dispositivo. Si borraste los datos del navegador o entrás
          desde otro, acá no van a aparecer aunque existan.
        </p>
      </Card>

      {items.length === 0 ? (
        <Card>
          <p className="text-body text-stone">
            No encontramos envíos guardados para esta wallet en este dispositivo.
          </p>
        </Card>
      ) : (
        // WKH-350 · AC-1/AC-4/AC-5: las 4 secciones. El componente vive al final del archivo y no acá,
        // por lo mismo que TxProof (:3303): un bloque nuevo en este punto desplaza las 3 citas ancladas
        // de abajo (:3142, :3199, :3323). Las citas por número que este archivo recibe, y su definición, están en `:44`; a esta zona apuntan 4.
        // Números sin backticks: son una foto, no anclas. Reemplazo línea-neutra, 5 líneas por 5.
        <HistoryGroups items={items} onOpen={onOpen} answerFor={answerFor} />
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
  answer,
}: {
  rem: RemittanceState;
  onOpen: (rem: RemittanceState) => void;
  answer: EscrowChainAnswer;
}) {
  // WKH-351 · AC-1: acá NO se calcula el estado del trámite. El encabezado del grupo ya afirma sobre la plata, y entre las dos afirmaciones hay contradicción ALCANZABLE en 3 de los 4 grupos. (`statusDisplay`, `flow-vm.ts:133`) sigue viva, y la sigue mostrando (`Receipt`, `:3455`), que es una sola remesa y no tiene encabezado con el que chocar. Reemplazo línea-neutra, 1 línea por 1: borrar esta línea desplaza las referencias de abajo, y a la mayoría no las vigila ningún test.
  const knowledge = escrowFundsKnowledge(rem);
  // WKH-349. El texto Y el peso visual salen de la MISMA función: un copy que dice "siguen en el
  // escrow" con el mismo gris que "no pudimos preguntar" pierde la mitad de AC-2. Y para los cuatro
  // desenlaces locales devuelve, byte a byte, el copy de siempre. WKH-351 sacó el Pill que iba abajo.
  const desenlace = escrowOutcomeDisplay(escrowOutcome(rem, answer));
  // Una remesa que nunca autorizó un depósito no tiene nada que seguir: abrirla en el seguimiento
  // renderizaría la vista optimista ("tu chaski está en camino", pasos en gris) sobre un envío que
  // no llegó a existir. Se lista igual, porque es historia de la persona, pero sin esa puerta.
  const openable = knowledge !== "no-deposit";
  return (
    <li>
      <Card className="space-y-ajustado">
        <div className="flex items-start justify-between gap-normal">
          <div>
            <p className="text-body font-semibold">{rem.beneficiary.name}</p>
            <p className="tabular-nums text-label text-stone">
              {rem.sendUsd.format()} · {formatEntryDate(rem.createdAt)}
            </p>
          </div>
          {/* WKH-351 · AC-1: acá iba el Pill de statusDisplay. Se fue: bajo el encabezado "Necesitan tu firma" decía "Pago en curso" al lado de la frase que dice que el plazo venció. El div de arriba se queda: con un solo hijo, justify-between deja el bloque en flex-start. Que eso además se vea bien NO lo prueba ningún test: jsdom no hace layout. Reemplazo línea-neutra, 1 línea por 1. */}
        </div>
        <p
          className={
            desenlace.emphasis === "strong"
              ? "text-label font-semibold text-cochineal-ink"
              : "text-label text-stone"
          }
        >
          {desenlace.copy}
        </p>
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
    <div className="space-y-holgado">
      <Card className="text-center">
        <div
          className={cn(
            "mx-auto mb-normal flex h-14 w-14 items-center justify-center rounded-full",
            confirmed ? "bg-verde-bg" : "bg-sand",
          )}
        >
          {confirmed ? (
            <Check className="size-icono-md text-verde" />
          ) : (
            <Clock3 className="size-icono-md text-stone" />
          )}
        </div>
        {/* "recibió" SÓLO con un monto entregado confirmado. Si no, se dice qué es el número. */}
        <p className="text-body text-stone">
          {rem.beneficiary.name} {confirmed ? "recibió" : "tiene que recibir"}
        </p>
        <Money tono={confirmed ? "verde" : "ink"} className="mt-ajustado">
          {amount ? amount.format() : "—"}
        </Money>
        <p className="mt-ajustado text-label text-stone">en su {methodLabel(rem.beneficiary.method)}</p>
        {confirmed ? null : (
          <p className="mx-auto mt-ajustado max-w-xs text-label text-stone">
            Es el monto cotizado. Todavía no tenemos confirmación de cuánto llegó.
          </p>
        )}
        {isDemoMode(rem) ? (
          <div className="mt-normal flex items-center justify-center">
            <Pill tone="prueba">{DEMO_PILL}</Pill>
          </div>
        ) : null}
      </Card>
      <Card>
        <h2 className="mb-ajustado text-title font-semibold">Recibo</h2>
        <Row label="Enviaste" value={rem.sendUsd.format()} />
        {rem.quote ? <Row label="Tipo de cambio" value={`S/ ${rem.quote.rate.toFixed(3)}`} /> : null}
        <Row label="Estado" value={<Pill tone={status.tone}>{status.label}</Pill>} />
        {/* El único dato de esta pantalla que alguien verificó contra la cadena. */}
        {rem.principalTx ? (
          <Row label="Depósito en Solana" value={<TxProof signature={rem.principalTx} />} />
        ) : null}
        {rem.refundTx ? <Row label="Reembolso" value={<TxProof signature={rem.refundTx} />} /> : null}
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

/**
 * WKH-346 / AC-7 — las DOS frases del final del camino de recuperación. Reemplazan a la constante
 * `RECOVERY_MORE_ESCROWS_HINT` (AR/MNR-3), que prometía algo que la ventana no da.
 *
 * POR QUÉ NO LLEVAN LA CUENTA DE ESCROWS PENDIENTES, que sigue siendo el punto. La recuperación
 * resuelve UN escrow por vez: `resolveRemittanceIdFromLedger` sondea hasta `MAX_RECOVERY_CANDIDATES`
 * PDAs y devuelve el PRIMERO en estado (`Deposited`, `solana-wallet.ts:400`), la línea que dice "el
 * primero refundeable gana". Su tipo de retorno es `Promise<string>`: **no expone cuántos quedan**. Así que "te quedan 2
 * envíos" sería una afirmación que el código no respalda, y "no te queda ninguno" también. Contar los
 * restantes es cambio de lógica y está fuera del alcance de esta HU. ⛔ CD-6 NO se relaja.
 *
 * 🔴 POR QUÉ SÍ LLEVAN EL TAMAÑO DE LA VENTANA, que es OTRO número (AR/MNR-3). Son dos cifras
 * distintas y sólo una de las dos la sabe el código:
 *  · cuántos escrows le QUEDAN a la persona ⇒ el código NO lo sabe. Prohibido decirlo.
 *  · cuántos MIRA cada búsqueda ⇒ el código sí lo sabe, porque es la constante con la que sondea.
 * La versión vieja decía 'volvé a apretar "Buscar mis escrows" para revisar los que falten', y con más
 * de `MAX_RECOVERY_CANDIDATES` depósitos perdidos eso es falso: el orden es `created_at desc`, así que
 * volver a apretar NUNCA alcanza a los más viejos que la ventana. El copy hermano de esta misma
 * tarjeta ya nombra el número (`sinAbiertosCopy`, `flow-vm.ts:327`), así que el estándar del repo para
 * esta pantalla es decirlo.
 *
 * POR QUÉ SON FUNCIONES Y NO CONSTANTES: `maxCandidates` entra por parámetro, con el molde exacto de
 * `lostEscrowRecoveryError` (`flow-vm.ts:302`). El llamador pasa la MISMA constante que sondea, así
 * que el copy no puede quedar diciendo un número que el código dejó de usar. Un `10` escrito a mano
 * acá lo mata `T-346-17`, que las llama con un valor distinto del real.
 */
export function recoveryMoreEscrowsHint(maxCandidates: number): string {
  return `Puede haber más envíos con fondos por recuperar. Volvé a apretar "Buscar mis escrows": cada búsqueda mira los últimos ${maxCandidates} envíos guardados de esta billetera, así que los más viejos que eso no van a aparecer.`;
}

/**
 * El final EXITOSO del camino: la última búsqueda dijo que en la ventana no queda ninguno abierto, y
 * antes se recuperó al menos uno. Ver `caminoTerminado` en `LostEscrowRecovery`.
 *
 * ⚠️ Esta frase NO dice "no te quedan envíos": dice que no queda ninguno **entre los que miramos**, y
 * después dice qué NO significa. Es la misma voz de (`sinAbiertosCopy`, `flow-vm.ts:327`): el hecho
 * primero, el límite del hecho después. (Iba a `:352` de este archivo, que es una línea de comentario y no la declaración de nada, y sin la coma entre los dos backticks el candado ni la miraba: el arreglo son las dos mitades, el número Y el formato. ⛔ ESE NÚMERO SE ESCRIBÍA `:336`, que es la línea que ese mismo comentario ocupaba en `ce4f31e`: una nota histórica que cita un número se vuelve falsa sin que nadie la edite, y esta se corrigió en el fix-pack junto con las otras cinco desplazadas.)
 */
export function recoveryWindowExhausted(maxCandidates: number): string {
  return `Ya no queda ninguno abierto entre los últimos ${maxCandidates} envíos guardados de esta billetera. Si tenés envíos más viejos que eso, esta búsqueda no llega a ellos.`;
}

/**
 * WKH-346 — el comprobante de una transacción Solana: truncado, enlazado al visor y copiable.
 *
 * Los cinco sitios que le muestran una firma a la persona pasan por acá. Tres la imprimían ENTERA (87 u 88 caracteres, y 88 en la mayoría de los casos: una firma ed25519 son 64 bytes y su largo en base58 depende del primer byte. Medido, 4000 muestras: 80,2 % dan 88. Los 87 con los que se mide en los tests son propiedad de `FAKE_SOLANA_SIGNATURE`, no de una firma cualquiera — AR/MNR-2)
 * y desbordaban la única columna de la app; los
 * otros dos ya truncaban con `shortTx` (`shortTx`, `:3512`) y no llevaban a ninguna parte. Un solo
 * componente en vez de cinco es lo que impide que el próximo sitio nazca con la tercera variante.
 *
 * 🔴 POR QUÉ VIVE ACÁ Y NO EN `src/presentation/tx-proof.tsx`, que era lo natural. Un archivo nuevo
 * obliga a una sentencia `import` nueva ARRIBA de este archivo, y esa línea desplaza todo lo que viene
 * después: **la mayoría de las referencias `flow.tsx:NNN` del árbol quedan apuntando a otra cosa, y la
 * mayoría de ESAS sin que ningún test se ponga rojo**, porque el candado vigila una minoría. Como
 * apéndice al final el desplazamiento es CERO.
 *
 * ⚠️ ACÁ HABÍA TRES NÚMEROS EN PRESENTE —"39 referencias, 27 sin test, el candado vigila 12"— Y LOS
 * TRES ENVEJECIERON POR MI PROPIA MANO (AR-2/MNR-3): esta HU escribió referencias nuevas, así que
 * medido al cierre son **48 / 31 / 17** (dos instrumentos independientes coinciden en el 17: mi barrido
 * y el parser del propio candado). No los creas: **derivalos**, igual que `deriveTables()` en el otro
 * repo. El comando está en `doc/sdd/052-wkh-346-comprobante-truncado-y-enlazado/story-file.md` §12.1bis.
 * La DECISIÓN que estos números justifican no cambia —48 es peor que 39, y la minoría vigilada sigue
 * siendo minoría—; lo que cambia es que una cifra en presente sobre el propio árbol se vuelve falsa sin
 * que nadie la edite. Es una medición con fecha, no una preferencia de estilo. Mismo criterio de export que
 * `Receipt` de este archivo: exportado para poder montarlo directo en un test, sin número de línea
 * porque el nombre ya lo localiza y un número acá sería una cita más que envejece sola.
 *
 * 🔴 POR QUÉ EL BOTÓN DE COPIAR TIENE TRES ESTADOS Y NO DOS. `navigator.clipboard` puede ser
 * `undefined` (contexto no seguro) y `writeText` puede RECHAZAR (permiso denegado, rarezas de iOS). Un
 * control de dos estados que se pinta de "Copiado" en el `finally` afirma un hecho que no ocurrió, y
 * sobre el único dato de esta pantalla que alguien puede verificar contra la cadena. Cuando falla, la
 * pantalla lo dice; el `href` y el `title` siguen siendo las otras dos vías de recuperar el valor
 * entero. Sin `setTimeout` que revierta a "idle": un temporizador agrega limpieza en `unmount`, un
 * `setState` después de desmontar y un test con relojes falsos, todo para un revert cosmético.
 *
 * ⚠️ LO QUE ESTE COMPONENTE NO GARANTIZA. `break-all` y `min-h-[44px]` son NOMBRES DE CLASE: que
 * produzcan el quiebre y los 44 px lo hace Tailwind y ningún test de esta HU lo mide (jsdom no hace
 * layout). Y el copiado se probó contra un `navigator.clipboard` stubbeado: que Safari en iOS acepte
 * `writeText` en este handler no se verificó — y por eso hay un tercer estado y no dos.
 */
export function TxProof({ signature }: { signature: string }) {
  const [copia, setCopia] = useState<"idle" | "copiada" | "sin-copiar">("idle");
  const copiar = async () => {
    try {
      // `?.` y no un `if`: sin API de portapapeles el `await undefined` no tira, así que el desenlace
      // se decide igual que el rechazo — "no pudimos", nunca "copiado".
      const escritura = navigator.clipboard?.writeText(signature);
      if (escritura === undefined) {
        setCopia("sin-copiar");
        return;
      }
      await escritura;
      setCopia("copiada");
    } catch {
      setCopia("sin-copiar"); // NUNCA "copiada" en un `finally`: sería afirmar un hecho que no ocurrió
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 break-all" data-testid="tx-proof">
      <a
        href={resolveSolanaExplorerTxUrl(signature)}
        target="_blank"
        rel="noopener noreferrer"
        title={signature}
        className="inline-flex items-center gap-1 text-cochineal underline underline-offset-2"
      >
        {shortTx(signature)}
        <ExternalLink className="size-icono-sm shrink-0" />
      </a>
      <button
        type="button"
        onClick={copiar}
        className="inline-flex min-h-[44px] items-center gap-1 text-stone underline underline-offset-2"
      >
        {copia === "copiada" ? (
          <>
            Copiado
            <Check className="size-icono-sm shrink-0 text-verde" />
          </>
        ) : copia === "sin-copiar" ? (
          "No pudimos copiar"
        ) : (
          "Copiar"
        )}
      </button>
    </span>
  );
}

/**
 * WKH-350 · LAS 4 SECCIONES DEL HISTORIAL.
 *
 * Reparte las filas que ya vienen en `items` entre los 4 grupos de (`HistoryGroup`,
 * `flow-vm.ts:1332`) —el reparto lo hace (`historyGroupFor`, `flow-vm.ts:1370`)— y las renderiza en el
 * orden de (`HISTORY_GROUP_ORDER`, `flow-vm.ts:1335`), que es severidad decreciente. No calcula ningún
 * desenlace: usa el mismo (`escrowOutcome`, `flow-vm.ts:1194`) que la tarjeta ya usaba, y la tarjeta se
 * invoca igual que antes.
 *
 * UN SOLO PASE SOBRE `items`, con push, y NADA de `.sort()` ni de cuatro `.filter()`. El orden dentro
 * de cada grupo tiene que ser el que la lista ya traía, y un solo pase lo garantiza por construcción
 * en vez de por acuerdo. Candado: T-H7.
 *
 * EL GRUPO SIN FILAS NO SE RENDERIZA, ni el encabezado ni un "0 envíos". Un encabezado sobre un
 * conjunto vacío es una afirmación vacía, y un cero es peor: un número invita a leerse como una
 * medición. Que esto sea inocuo depende de que la partición sea total, y eso está argumentado en el
 * docblock de (`HistoryGroup`, `flow-vm.ts:1332`) —no en el de `historyGroupFor`, que habla del `??`—;
 * si alguien agrega un grupo que pueda quedar vacío significando "no medimos", esto hay que revisarlo.
 *
 * DEVUELVE UN FRAGMENT Y NO UN `div`. El padre es un `space-y-holgado`, y `space-y-*` sólo alcanza a los
 * hijos DIRECTOS: un div envolvente dejaría los 4 grupos a un nivel de profundidad y les comería el
 * espaciado. Y va un `<ul>` por grupo en vez de uno solo con separadores, porque la tarjeta devuelve
 * un `<li>` (`HistoryEntry`, `:3394`) y un encabezado suelto entre `<li>` es HTML inválido.
 *
 * ⚠️ POR QUÉ VIVE ACÁ ABAJO Y NO JUNTO A (`HistoryView`, `:3303`), QUE ES DONDE SE LEERÍA MEJOR: por
 * lo mismo que (`TxProof`, `:3616`). Un bloque nuevo en el medio de este archivo desplaza todo lo que
 * viene después, y a este archivo lo apuntan citas por número desde todo el árbol más las autocitas
 * `:NNN` de sus propios docblocks. De todas ellas, el candado de citas sólo vigila las ANCLADAS —las
 * que llevan el símbolo delante de la coma—; las SUELTAS, que son mayoría, se romperían sin que ningún
 * test se ponga rojo, y eso lo declara el propio candado en su cabecera
 * (`src/composition/citas-ancladas.test.ts`). El número no se escribe acá porque envejece con cada
 * commit y porque las dos poblaciones no son la misma: se deriva con
 * `grep -rEo "flow\.tsx:[0-9]+" --include=*.ts --include=*.tsx src app scripts contracts`, y las
 * ancladas con esa misma cadena precedida de un símbolo entre backticks y una coma.
 * Como apéndice el desplazamiento es CERO. Cuesta legibilidad y compra eso. Las declaraciones de
 * función se hoistean, así que usarlo arriba y declararlo acá funciona; este archivo ya lo hace con
 * `TxProof`.
 *
 * LO QUE ESTE COMPONENTE NO GARANTIZA: `space-y-ajustado` y `space-y-normal` son NOMBRES DE CLASE, y que
 * produzcan el espaciado lo hace Tailwind. Ningún test de esta HU lo mide, porque jsdom no hace
 * layout. Misma limitación ya declarada para `TxProof`.
 */
function HistoryGroups({
  items,
  onOpen,
  answerFor,
}: {
  items: RemittanceState[];
  onOpen: (rem: RemittanceState) => void;
  answerFor: (id: string) => EscrowChainAnswer;
}) {
  const porGrupo = new Map<HistoryGroup, RemittanceState[]>();
  for (const rem of items) {
    const g = historyGroupFor(escrowOutcome(rem, answerFor(rem.id)));
    const acumulado = porGrupo.get(g);
    if (acumulado === undefined) porGrupo.set(g, [rem]);
    else acumulado.push(rem);
  }
  return (
    <>
      {HISTORY_GROUP_ORDER.map((g) => {
        const filas = porGrupo.get(g);
        if (filas === undefined || filas.length === 0) return null;
        return (
          <div key={g} className="space-y-ajustado" data-testid={`grupo-${g}`}>
            <p className="text-title font-semibold">{HISTORY_GROUP_HEADING[g]}</p>
            <ul className="space-y-normal">
              {filas.map((rem) => (
                <HistoryEntry key={rem.id} rem={rem} onOpen={onOpen} answer={answerFor(rem.id)} />
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

/**
 * WKH-354/AC-6 · El aviso de que la billetera tiene activa otra cuenta, y el gesto para adoptarla.
 *
 * NO RENDERIZA NADA salvo en el estado donde el gesto tiene sentido, y las TRES condiciones son
 * load-bearing:
 *  · `sesion != null`  — nadie conectó todavía. Lo que esta condición evita es el banner en la PRIMERA
 *                        PANTALLA de cualquiera: con `autoConnect` la billetera puede tener cuenta
 *                        activa antes de que la persona elija ninguna, y ahí `viva !== sesion` es
 *                        cierto sin que haya cambiado nada (R-5). Lo sostiene UN solo test y no la
 *                        suite, medido: el detalle y la medición están en T-354-6d, que es el test
 *                        que por eso no se puede borrar.
 *  · `viva != null`    — el bridge todavía no midió nada. `null` NO es "cambió la cuenta".
 *  · `viva !== sesion` — sin esta comparación el banner se pinta siempre (T-354-6b lo mide).
 *
 * ⚠️ ESTE COMPONENTE LEE EL BRIDGE GLOBAL y no el puerto inyectado. `useSyncExternalStore` exige un
 * `getSnapshot` SÍNCRONO y `ConnectedWalletProbe` es `async`, así que la SUSCRIPCIÓN no puede pasar
 * por el puerto. El precedente es `NoWalletHere`, que ya consume `useWalletAvailability()` al lado de
 * un container inyectado. Ojo con el alcance: lo que el hook obliga es la SUSCRIPCIÓN. El valor
 * podría resolverse por el puerto dentro de un efecto; los dos se leen del bridge porque es más
 * simple, no porque no haya otra forma.
 *
 * 🔴 Y LOS DOS LECTORES NO APLICAN EL MISMO PREDICADO, así que su equivalencia no la da el tipo:
 *   · (`useConnectedWalletAddress`, `./wallet-availability.ts:62`) devuelve `publicKey` crudo: no mira
 *     `connected` y no valida base58.
 *   · (`getConnectedAddress`, `../infrastructure/solana-wallet.ts:252`) exige las dos cosas y devuelve
 *     `null` si falla cualquiera.
 * Hoy coinciden por una razón medible y no por construcción: en producción hay UN SOLO escritor del
 * bridge (`setState`, `./solana/solana-providers.tsx:178`, único llamador fuera de `*.test.*`) y ahí
 * `publicKey` y `connected` salen del MISMO commit de React, así que el par incoherente
 * (`publicKey != null` con `connected === false`) no se produce. Lo que rompería la equivalencia:
 * un segundo escritor del bridge, o una `publicKey` que no parsee como base58. En cualquiera de esos
 * dos casos el banner acusaría un cambio de cuenta que el guard de `onConfirm` no ve.
 *
 * Consecuencia para quien escriba tests: un test que combine este banner con el guard de `onConfirm`
 * tiene que setear LAS DOS costuras (`solanaWalletBridge.setState` Y el `connectedWallet` inyectado),
 * porque en producción son el mismo adapter sobre el mismo bridge y un test que las ponga en
 * desacuerdo está midiendo un estado que no existe.
 *
 * La comparación es cruda (`!==`) y no `canonicalizeAddress`: los dos lados salen de la MISMA fuente
 * base58 (el bridge y el `setAddress` que viene del mismo bridge), así que no hay dos
 * representaciones que reconciliar. El guard que SÍ decide algo (`onConfirm`) usa
 * `canonicalizeAddress` porque ahí un lado viene del snapshot persistido.
 */
function CuentaCambiada({
  sesion,
  enVuelo,
  onAdoptar,
  disabled,
}: {
  sesion: string | null;
  enVuelo: boolean;
  onAdoptar: () => void;
  disabled: boolean;
}) {
  const viva = useConnectedWalletAddress();
  if (sesion == null || viva == null || viva === sesion) return null;
  return (
    <Aviso className="mt-normal w-full space-y-ajustado">
      <div className="flex items-center gap-ajustado">
        <Wallet className="size-icono-sm text-cochineal" />
        <h2 className="text-title font-bold">Estás conectado con otra cuenta</h2>
      </div>
      <p className="text-body text-stone">
        Tu billetera tiene activa una cuenta distinta de la que estás usando acá. Podés pasarte a ella
        sin perder nada: no se borra tu verificación ni tus envíos guardados, ni de esta cuenta ni de
        la otra.
      </p>
      {enVuelo ? (
        <p className="text-body text-stone">
          Este envío quedó a nombre de la cuenta anterior, así que empezás uno nuevo.
        </p>
      ) : null}
      <Button variant="outline" onClick={onAdoptar} disabled={disabled}>
        Usar esta cuenta
      </Button>
    </Aviso>
  );
}

/**
 * WKH-MWA · Las dos frases del aviso de "acá no hay wallet", según haya o no una salida en ESTE
 * navegador.
 *
 * ⛔ VIVEN AL FINAL DEL ARCHIVO, y no al lado del componente que las usa, por una razón mecánica y no
 * estética: 85 comentarios del repo citan `flow.tsx:NNNN` por número. Meter cuatro líneas en el medio
 * corre todo lo que está debajo y rompe las citas SIN que ningún barrido del diff lo note, porque el
 * texto que miente no es el que se editó. Agregar al final no corre nada.
 *
 * LA FRASE SIN MWA ES LA DE SIEMPRE, palabra por palabra. Con la bandera apagada esta pantalla queda
 * byte-idéntica a como estaba, y eso lo mide T-UI-1/T-UI-2, que siguen buscando este mismo texto.
 *
 * LA FRASE CON MWA NO PROMETE QUE VAYA A FUNCIONAR, y esa restricción es deliberada. Lo único que
 * sabemos cuando `mwaListo` es `true` es que la librería puso esa entrada en el selector; NO sabemos
 * si hay una app de billetera instalada, ni si esa app sabe firmar sin enviar (ver el docblock de
 * `MWA_WALLET_NAME`). Por eso dice "puede abrirse" y no "se abre", y por eso el enlace a Phantom sigue
 * abajo: si no se abre, la salida de siempre está a un toque.
 */
const NO_WALLET_SIN_MWA =
  "En el celular, Phantom solo se conecta desde su propio navegador. Si ya la tenés en este dispositivo, abrí Chaski adentro de Phantom.";
/**
 * WKH-358/AC-1 · EL SELECTOR DEL CAMINO POR ENLACE — las dos billeteras que hablan el protocolo.
 *
 * 🔴 SÓLO EN EL CUADRANTE `none`, y son tres razones, dos de ellas mecánicas:
 *   1. en `injected` ofrecerlo **viola AC-6 por construcción**, porque el gate del adaptador
 *      (`caminoPorEnlace`, `../infrastructure/solana-wallet.ts:2239`) exige `"none"`: el botón saltaría
 *      a la billetera y al volver el recorrido correría por el camino inyectado igual. Una puerta que
 *      no lleva a donde dice.
 *   2. en `unknown` este repo ya tiene la disciplina de no afirmar
 *      (`useWalletAvailability`, `./wallet-availability.ts:36` contesta `"unknown"` en el servidor).
 *   3. el navegador interno de Phantom **es `injected`** (lo mide `T-CABLE-2`), y ahí el camino de hoy
 *      funciona y está verificado en cadena.
 *
 * ⛔ ESTE SELECTOR NO PROMETE QUE SE PUEDA PAGAR POR ENLACE, y el copy está escrito para no insinuarlo.
 * Hoy el DEPÓSITO por enlace no cierra: `prepare()` exige un PoP firmado por el bridge, que en un
 * teléfono sin extensión está vacío (WKH-359). Lo que este camino sí completa es CONECTAR la billetera y
 * crear la cuenta de nonce. Por eso dice "Conectar" y nunca "Pagar", y por eso el enlace a Phantom
 * (`NoWalletHere`) sigue abajo como salida: es el único camino con un depósito medido en cadena.
 *
 * ⚠️ EL ALTO SE LEE DE UN `<Button>` DE VERDAD, no se escribe. Cada opción ES un `<Button>`, así que no
 * hay ninguna receta copiada que se pueda desincronizar — que es justo el problema que el `<a>` de
 * `NoWalletHere` tiene que resolver con `T-H1-3` porque necesita ser un `<a>`. Acá no: un `<button>`
 * sirve, porque la navegación la hace el handler.
 *
 * ⛔ SIN EM DASHES en el texto que ve la persona (CD-16).
 */
function SelectorDeEnlace({
  onElegir,
  deshabilitado,
}: {
  onElegir: (b: BilleteraDeeplink) => void;
  deshabilitado: boolean;
}) {
  return (
    <Aviso className="space-y-normal">
      <div className="flex items-center gap-ajustado">
        <Smartphone className="size-icono-sm text-cochineal" />
        <h2 className="text-title font-bold">Conectá desde tu app de billetera</h2>
      </div>
      <Muted>
        Vas a salir a tu billetera para autorizar la conexión y volvés acá. Elegí cuál usás.
      </Muted>
      <Button disabled={deshabilitado} onClick={() => onElegir("phantom")}>
        <ExternalLink className="size-icono-sm" /> Conectar con Phantom
      </Button>
      <Button variant="outline" disabled={deshabilitado} onClick={() => onElegir("solflare")}>
        <ExternalLink className="size-icono-sm" /> Conectar con Solflare
      </Button>
      {/* ⚠️ ESTA FRASE NO ES UN ADORNO: es lo único que distingue este camino del de abajo para alguien
          que sólo quiere mandar plata. Decir qué se consigue acá (conectar) y no prometer lo que no
          cierra (pagar) es la diferencia entre una puerta honesta y una que frustra en el paso 4. */}
      <Muted escala="label">
        Si tu billetera no vuelve a esta página, usá el enlace de abajo para abrir Chaski adentro de
        Phantom.
      </Muted>
    </Aviso>
  );
}

const NO_WALLET_CON_MWA =
  "En este navegador, al tocar Conectar wallet puede abrirse la app de tu billetera para que autorices desde ahí. Si eso no pasa, usá el enlace de abajo y abrí Chaski adentro de Phantom.";

// ═══ WKH-358/AC-1 · EL PRODUCTOR DE MONTAJE DE LA VUELTA POR ENLACE ══════════════════════════════
//
// 🔴 POR QUÉ ES UN HOOK AL FINAL DEL ARCHIVO Y NO UN `useEffect` ADENTRO DE `RemittanceFlow`, que es
// donde estaría si sólo importara la legibilidad: este archivo recibe 131 citas por número a 79 líneas
// destino (el censo y su fecha viven en UN solo lugar, `:44`), así que meter ~60 líneas en el medio del
// componente las corre TODAS. La regla de esta HU es explícita: lo nuevo va al final, donde rompe 0.
// El componente lo invoca en UNA línea ya existente.
//
// ⛔ UN EFECTO, UN REF, Y EL MISMO GATE DE PISÓN QUE EL RESUME (DT-12 + CD-7 + CD-11). Cada mitad tiene
// su motivo medido y ninguna es decorativa:
//
//   · **UN REF.** `completar()` llega hasta el lector de la vuelta de `sesion.ts`, que consume el paso
//     de forma IRREVERSIBLE en la misma escritura en la que devuelve el resultado (⚠️ el nombre de esa
//     función NO se escribe en este archivo: un candado de `deeplink-callers.test.ts` prohíbe que
//     `src/presentation` la MENCIONE, y es a propósito). Con `reactStrictMode: true`
//     React invoca los efectos DOS veces, y la segunda lectura devolvería `ya-consumida` sobre una
//     respuesta que la billetera sí dio. Sin el ref, la vuelta buena se quema sola.
//   · **`remesaEnCurso()` PRIMERO, y si contesta `null` no se llama a `completar()`.** El salto mata el
//     proceso de la pestaña: al volver, `rem` es `null` y el `remittanceId` sólo sobrevivió adentro del
//     viaje. Su residual —que con ese id el guard `otra-remesa` no puede cortar en la vuelta del
//     connect— está escrito entero en
//     (`remesaDelViaje`, `../infrastructure/solana/deeplink/conexion.ts:400`).
//   · **EL GATE DEL PISÓN.** La vuelta del enlace es otra recarga, igual que la de Didit, así que le
//     toca el mismo trato: si la persona ya interactuó, esto no toca la pantalla. Es el mutante G5 del
//     fix-pack 3 de WKH-063: pisar una remesa `created` con `ownerAddress: null` la vuelve inalcanzable
//     porque `repo.list(address)` no la lista nunca. ⛔ Y acá directamente NO HAY NINGÚN `setRem`.
//
// ── EL ORDEN DE LAS TRES COSAS QUE HACE, Y POR QUÉ ES ÉSE (DT-10 + AC-3 + AC-4) ──────────────────
//
//   1. **LEE** la vuelta (`completar()`).
//   2. **LIMPIA LA BARRA** (`history.replaceState`) — ⛔ DESPUÉS de leer, nunca antes: antes borraría
//      la respuesta que nadie leyó todavía. Y se limpia SIEMPRE, también tras un corte, porque un
//      `errorCode` que queda en la barra hace que la invocación SIGUIENTE repita el mismo corte y la
//      persona no pueda reintentar (el caso que la ola 2 mide con tres invocaciones idénticas).
//   3. **REANUDA** `confirmAndSend.execute()` si el paso del que se volvió es del MOTOR.
//
// 🔴 EL GATE DE LA REANUDACIÓN ES FAIL-CLOSED Y TIENE DOS CONDICIONES, no una:
//   · la marca de la que se volvió es `firmar-tx` o `firmar-patrocinio` — nunca `conectar` ni
//     `crear-nonce`, que ocurren ANTES de que exista ninguna orden de pago; y
//   · la remesa **está en `confirmed`**, verificado leyendo el repo por el dueño
//     (`listHistory.execute(direccion)`), que es una fuente **independiente del canal del enlace**.
// ⛔ Sin la segunda condición, una URL con `?dl=firmar-tx` puesta a mano sobre una remesa que la
// persona todavía NO confirmó haría que `execute()` la confirmara y siguiera hasta `prepare()`, o sea
// una orden de pago real disparada por un enlace. La condición del `status` NO es cosmética.
//
// ⚠️ CÓMO AVISA, Y SU RESIDUAL DECLARADO. Cuando la persona ya interactuó, esto **no navega y no toca
// `rem`**: prende el banner de error global (`:1211`), que es la única superficie que ya existe y que
// avisa sin navegar. ⛔ NO reusa el aviso de Didit (`:757`): su copy habla de la verificación y su
// botón aplica un snapshot de KYC, así que decirle eso a alguien que volvió de firmar una transacción
// sería falso. El residual: ese banner **no trae un botón para retomar**, y la vuelta es por «Mis
// envíos», que sí lista una remesa `confirmed` con dueño. Un aviso propio pide una variante nueva en
// el render de `RemittanceFlow`, y eso es una pantalla nueva, no una línea.
function useVueltaPorEnlace(i: {
  c: Container;
  yaInteractuo: { readonly current: boolean };
  alConectar: (r: Awaited<ReturnType<Container["connectWallet"]["execute"]>>) => void;
  alFallar: (causaCruda: string) => void;
  alReanudar: (r: Awaited<ReturnType<Container["confirmAndSend"]["execute"]>>) => void;
  alAvisar: (mensaje: string) => void;
  /** El estado de la cuenta de nonce, con el quinto valor (`"en-vuelo"`) que NO viene de la cadena
   *  sino del broadcast. ⛔ Los tres de la cadena NO se colapsan: `no-pudimos-preguntar` no es
   *  `falta`. */
  alSaberDelNonce: (estado: EstadoDeLaCuentaDeNonce | "en-vuelo") => void;
}): void {
  const { c, yaInteractuo, alConectar, alFallar, alReanudar, alAvisar, alSaberDelNonce } = i;
  const yaCorrioRef = useRef(false);
  // 🔴 DOS REFS Y NO UN `let alive`, Y ACÁ ESTÁ LA DIFERENCIA CON EL EXEMPLAR DEL RESUME DE DIDIT
  // (`:205-286`), que sí usa `let alive`. **MEDIDO**: con esa forma, bajo `<React.StrictMode>` —que es
  // lo que corre `next dev`, `next.config.mjs:22`— este productor **no hace NADA**. React 18 monta,
  // corre el efecto, lo LIMPIA y lo vuelve a correr: la limpieza del primer pase pone `alive = false`
  // y mata el trabajo que ya arrancó, y el segundo pase se va por el `return` del ref. Neto: cero
  // llamadas. Lo cazó `T-065-7`, que monta en StrictMode y exige exactamente UNA.
  //
  // Con un REF en vez de una variable local, el segundo pase del doble montaje **vuelve a prenderlo**
  // (`vivoRef.current = true` es la primera línea) y el trabajo del primer pase sigue vivo. En un
  // desmontaje de verdad no hay segundo pase, así que la limpieza gana y el trabajo se aborta, que es
  // lo que corresponde. `yaCorrioRef` sigue garantizando lo que CD-11 pide: la vuelta se consume UNA
  // sola vez, pase lo que pase con los montajes.
  const vivoRef = useRef(true);
  // `alConectar`/`alFallar`/`alReanudar`/`alAvisar` cambian de identidad en cada render y NO van en las
  // deps A PROPÓSITO: el efecto corre UNA sola vez (lo garantiza `yaCorrioRef`) y agregarlas sólo
  // agregaría re-suscripciones que el ref después descarta. `yaInteractuo` es un ref y es estable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ver el párrafo de arriba
  useEffect(() => {
    vivoRef.current = true; // ⚠️ PRIMERO Y SIEMPRE: es lo que repone el segundo pase de StrictMode
    if (yaCorrioRef.current) return;
    yaCorrioRef.current = true;
    const vivo = { get valor() { return vivoRef.current; } };
    (async () => {
      // El href se captura ANTES de todo: el paso 2 lo va a borrar de la barra y el paso 3 necesita
      // saber de qué salto se volvió. ⚠️ `marcaDeVuelta` es un LECTOR PURO —no toca el disco y no
      // consume nada—, así que llamarlo antes que `completar()` no rompe DT-12.
      const hrefAlMontar = window.location.href;
      const marca = marcaDeVuelta(hrefAlMontar);
      const limpiarLaBarra = () => {
        const limpio = hrefSinRastroDeVuelta(hrefAlMontar);
        // El `!==` NO es una optimización: sin él, los ~100 `it` que montan esta pantalla sin ninguna
        // marca llamarían igual a `replaceState`, y este productor estaría escribiendo la barra de
        // recorridos que no tienen nada que ver con el enlace.
        if (limpio !== hrefAlMontar) window.history.replaceState(null, "", limpio);
      };
      const remId = c.recorridoPorEnlace.remesaEnCurso();
      if (remId === null) {
        // No hay viaje, pero la barra puede traer el rastro de uno que ya murió: se limpia igual.
        limpiarLaBarra();
        return;
      }
      let res: Awaited<ReturnType<Container["recorridoPorEnlace"]["completar"]>>;
      try {
        res = await c.recorridoPorEnlace.completar({ remittanceId: remId });
      } catch (e) {
        // ⛔ NO SE TRAGA. Una vuelta que revienta es algo que la persona tiene que poder leer. La causa
        // se DERIVA del error y nunca se escribe como literal en este archivo: el candado de copy
        // cuenta las causas del vocabulario del enlace que aparecen en `src/presentation`, y hasta que exista el
        // `Record` con todas (once al cerrar la ola 4, catorce desde el re-AR it2), escribir una sola acá lo rompe a propósito.
        limpiarLaBarra();
        if (vivo.valor) alFallar((e as Error).message);
        return;
      }
      limpiarLaBarra(); // paso 2, y SIEMPRE: también tras un corte (AC-4, el `errorCode` que se repite)
      if (!vivo.valor) return;
      if (res.estado === "corte") {
        alFallar(res.causa); // ídem: la causa se DERIVA del desenlace, no se escribe acá. 🔴 POR QUÉ ESTA SALIDA **NO** LLEVA EL GATE DEL PISÓN QUE SÍ LLEVA LA DE `:4034`, Y LAS TRES DE `:4056`/`:4060`/`:4064` TAMPOCO (re-AR it2 · MNR-3): el gate existe porque la rama `conectado` NAVEGA POR ENCIMA de lo que la persona está haciendo (le pide un `connect()` a la billetera, después va a la CADENA a leer la cuenta de nonce, y `alConectar` repuebla el estado de la conexión). Estas cuatro no hacen nada de eso: (`alFallar`, `:286`) es un `setError` y (`alSaberDelNonce`, `:286`) es el `setEstadoNonce` a secas — ⛔ ninguna de las cuatro llama a `setStep`, ni a `setRem`, ni a `window.location`, así que no se pierde ni un carácter de lo tipeado. ⚠️ LO QUE SÍ PUEDE PASAR, Y VA ESCRITO: `completar()` tarda segundos y en esa ventana estas cuatro PINTAN sobre la pantalla viva — un banner de error, o la tarjeta de la cuenta de nonce de `:757`, que va arriba del pliegue. O sea que a alguien tipeando le puede aparecer algo que no pidió. Se acepta a cambio de no perder el diagnóstico: gatearlas lo tiraría a la basura, porque nadie lo vuelve a pedir. Si un día hay que gatearlas, la salida honesta es diferirlas, no descartarlas
        return;
      }
      if (res.estado === "conectado") {
        // 🔴 EL GATE DEL PISÓN, ANTES DE TOCAR LA PANTALLA. La dirección ya quedó en el disco (la
        // escribió el lector de la vuelta, adentro de `completar()`), así que no se pierde nada por no
        // aplicarla acá: el recorrido la encuentra igual cuando la persona siga. Lo que sí se pierde
        // si se aplica es lo que ella estaba haciendo.
        if (yaInteractuo.current) return;
        try {
          // `connect()` del adaptador contesta `Viaje.direccion` SIN tocar el bridge cuando el gate
          // está activo, así que este gesto es exactamente el del botón "Conectar wallet" y el atajo
          // KYC-once sigue funcionando sin un cambio (AC-1).
          const r = await c.connectWallet.execute();
          if (!vivo.valor) return;
          alConectar(r); if (r.estado === "hay-que-salir") return; // WKH-359/AC-3 — EN ESTA LÍNEA (Δ0). `alConectar` ya navegó; sin este `return` el recorrido seguiría preguntándole a la CADENA por la cuenta de nonce mientras el navegador se va a la billetera, o sea una lectura de red que nadie va a leer
          // 🔴 Y RECIÉN ACÁ SE LE PREGUNTA A LA CADENA POR LA CUENTA DE NONCE (AC-5), que es el motivo
          // por el que esta pregunta vive en `connect` y no en `confirm`: allá cada intento cuesta una
          // orden de payout REAL. El razonamiento entero está en `TarjetaDeCuentaDeNonce`.
          const estado = await c.recorridoPorEnlace.estadoDeLaCuentaDeNonce(res.direccion);
          if (vivo.valor) alSaberDelNonce(estado);
        } catch (e) {
          if (vivo.valor) alFallar((e as Error).message);
        }
        return;
      }
      // La vuelta del salto que pidió la firma de la CREACIÓN de la cuenta. Los tres desenlaces se
      // mapean uno a uno y ⛔ ninguno se colapsa: `nonce-en-vuelo` no dice "ya está" ni "falló", y
      // `nonce-no-sabemos` no dice nada sobre la cuenta.
      if (res.estado === "nonce-listo") {
        alSaberDelNonce("existe"); // sin gate, por lo mismo que `:4026` (las tres de este bloque)
        return;
      }
      if (res.estado === "nonce-en-vuelo") {
        alSaberDelNonce("en-vuelo");
        return;
      }
      if (res.estado === "nonce-no-sabemos") {
        alSaberDelNonce("no-pudimos-preguntar");
        return;
      }
      // ── 3 · LA REANUDACIÓN (AC-3) ────────────────────────────────────────────────────────────
      // Sólo los pasos del MOTOR. `conectar` salió por la rama de arriba; `crear-nonce` y cualquier
      // marca que nadie escribió caen acá y NO reanudan nada: pasan antes de que exista ninguna orden.
      if (marca === "pop-kyc") { let vk: Awaited<ReturnType<Container["recorridoPorEnlace"]["completarPop"]>>; try { vk = await c.recorridoPorEnlace.completarPop(); } catch (e) { if (vivo.valor) alFallar((e as Error).message); return; } if (!vivo.valor) return; if (vk.estado === "corte") { alFallar(vk.causa); return; } if (vk.estado !== "pop-listo") return; if (yaInteractuo.current) { alAvisar(AVISO_REANUDACION_POR_ENLACE); return; } try { const rk = await c.connectWallet.execute(); if (vivo.valor) alConectar(rk); } catch (e) { if (vivo.valor) alFallar((e as Error).message); } return; } if (marca === "pop-payout") { let vp: Awaited<ReturnType<Container["recorridoPorEnlace"]["completarPop"]>>; try { vp = await c.recorridoPorEnlace.completarPop(); } catch (e) { if (vivo.valor) alFallar((e as Error).message); return; } if (!vivo.valor) return; if (vp.estado === "corte") { alFallar(vp.causa); return; } if (vp.estado !== "pop-listo") return; } else       if (marca !== "firmar-tx" && marca !== "firmar-patrocinio") return; // WKH-359/AC-7 — LA RAMA DEL PERMISO, PEGADA A LA LÍNEA QUE EXISTE (Δ0: hay 4 citas ancladas de acá para abajo y ésta es la única línea de este archivo que esta HU toca; `:286`, `:330`, `:507` y `:521` reciben 77, 75, 55 y 52 y NO se tocan). 🔴 LA REANUDACIÓN SIGUE SIENDO POR RESULTADOS Y NUNCA POR `viaje.paso` (AC-7): esto no pregunta en qué paso dice el viaje que está —el campo (`paso`, `../infrastructure/solana/deeplink/sesion.ts:154`) de `Viaje` queda RANCIO por construcción, dice qué se fue a pedir en el salto en curso y no qué se consiguió— sino que lee el ancla y sigue SÓLO si la firma volvió y VERIFICÓ. Cuando sigue, cae al MISMO bloque de abajo que la reanudación de siempre: el dueño, la remesa en `confirmed`, y `execute()`. ⛔ Y no se le vuelve a pedir ninguna firma ya dada: `execute()` encuentra la prueba anclada y `pedir()` la entrega sin saltar (lo mide `T-067-11`). ⚠️ El motor NO tocó nada al pasar por acá: `pop-payout` no es un `PasoDelViaje`, así que `completar()` de más arriba contestó `nada` sin consumir ni destruir el viaje del depósito (CD-11, `T-067-16`)
      // La segunda condición, y es la fail-closed: la remesa tiene que estar EN `confirmed`, leído del
      // repo por el dueño. ⛔ `getConnectedAddress()` es la del enlace, y `repo.list` filtra por
      // `ownerAddress`, que lo escribe `startKyc` — o sea que esto además cruza el canal del enlace
      // contra una fuente que ese canal no puede escribir.
      const dueño = await c.connectedWallet.getConnectedAddress();
      if (!vivo.valor || dueño === null) return;
      const enCurso = (await c.listHistory.execute(dueño)).find((r) => r.id === remId);
      if (!vivo.valor) return;
      if (enCurso === undefined || enCurso.status !== "confirmed") return;
      if (yaInteractuo.current) {
        // Avisa y NO navega. ⛔ Y NO llama a `execute()`: reanudar por debajo mientras la persona usa
        // la pantalla es la misma pisada, con la orden de pago adentro.
        alAvisar(AVISO_REANUDACION_POR_ENLACE);
        return;
      }
      try {
        const r = await c.confirmAndSend.execute({ remittanceId: remId });
        if (vivo.valor) alReanudar(r);
      } catch (e) {
        if (vivo.valor) alFallar((e as Error).message);
      }
    })();
    return () => {
      vivoRef.current = false;
    };
  }, [c]);
}

/** WKH-358/AC-3 — lo que lee la persona cuando volvió de firmar y ya estaba usando la pantalla.
 *
 *  ⛔ NO afirma que se movió plata, y no puede: en este punto la firma volvió pero `execute()` **no se
 *  llamó**, justamente porque llamarlo sería pisar lo que ella está haciendo. Nombra el camino de
 *  vuelta que EXISTE hoy —«Mis envíos» lista una remesa `confirmed` con dueño— en vez de un botón que
 *  esta pantalla no tiene. Sin em dashes (CD-16). */
const AVISO_REANUDACION_POR_ENLACE =
  "Volviste de tu billetera y dejamos ese envío como estaba, porque estabas usando esta pantalla. Lo encontrás en Mis envíos para seguir desde donde quedó.";

/**
 * WKH-358/AC-5 — LA CUENTA DE NONCE DEL REMITENTE, CON SUS CUATRO ESTADOS.
 *
 * 🔴 POR QUÉ SE PIDE ACÁ Y NO EN `confirm`, que es donde el corte por cuenta de nonce ausente la reclama.
 * Tres razones medidas, en orden de peso:
 *   1. **En `confirm` cuesta una orden de payout REAL por intento.** El bloque del nonce del adaptador
 *      corre DESPUÉS de `prepare()`, así que un remitente nuevo por enlace pagaría 1 orden TransFi +
 *      1 atestación + 1 fila de ledger + 1 cargo a la Agent Key **antes** de que se le pueda decir que
 *      le falta una cuenta, y otra por cada reintento. Acá no hay `prepare()` y no queda nada huérfano.
 *   2. **En `confirm` la ventana de 20 minutos tendría que cubrir cuatro saltos humanos.** Acá el salto
 *      cae al principio de la ventana, y la cuenta queda creada PARA SIEMPRE: el envío siguiente no la
 *      vuelve a pedir.
 *   3. **Acá la persona todavía no firmó nada del dinero.** Si rechaza, no hay nada que reembolsar.
 *
 * ⛔ Y EL CINTURÓN NO SE AFLOJA: el corte del adaptador por cuenta ausente sigue siendo
 * fail-closed. Si alguien llega a `confirm` sin cuenta, el depósito **no** se pide.
 *
 * ⚠️ LA CIFRA SE DERIVA, NUNCA SE ESCRIBE (AC-5 / CD-20): sale de `NONCE_ACCOUNT_RENT_LAMPORTS` por
 * `formatLamportsAsSol`. Un literal en el CÓDIGO de acá abajo es exactamente lo que este AC prohíbe, y
 * lo mide `T-065-12` con DOS fuentes.
 *
 * Hoy esa derivación da **0,0015 SOL** (1.447.680 lamports, la renta de una cuenta de 80 bytes en
 * devnet). ⚠️ Ese número está ACÁ, en un comentario, y NO en el código, y la diferencia es el punto
 * entero: el barrido de `T-065-12` descuenta los comentarios y después exige que en el código no quede
 * **ninguna** cifra con coma. Este renglón es además lo que vuelve load-bearing a ese descuento (regla
 * (c) de CD-19): sin una cifra en la prosa, descontarla no cambiaría ningún número medido y el barrido
 * estaría mirando otra cosa. ⛔ Y envejece solo: si la renta de devnet cambiara, el que tiene razón es
 * el RPC y no este párrafo — quien lo mide es el `it` de `solana-escrow-rent.test.ts`. ⛔ Sin em dashes en ningún texto (CD-16). ⛔ Y NINGÚN texto de esta tarjeta afirma
 * que se movió plata: en los cuatro estados no se movió ninguna.
 */
export function TarjetaDeCuentaDeNonce({
  estado,
  ocupado,
  onCrear,
  onVolverAMirar,
  onSeguirSinCrearla,
}: {
  estado: EstadoDeLaCuentaDeNonce | "en-vuelo";
  ocupado: boolean;
  onCrear: () => void;
  onVolverAMirar: () => void;
  onSeguirSinCrearla: () => void;
}) {
  if (estado === "existe") {
    // Sin cifra: acá no se paga nada. Decir un número sobre una cuenta que ya está sería pedir plata
    // que nadie va a cobrar.
    return (
      <Aviso tono="bueno" className="mb-holgado text-body">
        <span className="block font-semibold">Tu cuenta ya está lista.</span>
      </Aviso>
    );
  }
  if (estado === "en-vuelo") {
    // ⛔ Ni "ya está" ni "falló": la red todavía no contestó y las dos cosas serían inventadas.
    return (
      <Aviso tono="neutro" className="mb-holgado text-body">
        <span className="block">
          Mandamos la transacción y la red todavía no la confirmó. Podés esperar unos segundos y volver
          a mirar.
        </span>
        <Button variant="outline" className="mt-normal" disabled={ocupado} onClick={onVolverAMirar}>
          Volver a mirar
        </Button>
      </Aviso>
    );
  }
  if (estado === "no-pudimos-preguntar") {
    // La misma forma que el resto de la app le da a "no llegamos a preguntar": lo que se niega es
    // haber recibido una respuesta, no la existencia de la cuenta.
    return (
      <Aviso tono="atencion" className="mb-holgado text-body">
        <span className="block">
          No pudimos preguntarle a la red si la cuenta quedó creada. Esto no es una respuesta sobre tu
          cuenta: no llegamos a preguntar.
        </span>
        <Button variant="outline" className="mt-normal" disabled={ocupado} onClick={onVolverAMirar}>
          Volver a mirar
        </Button>
      </Aviso>
    );
  }
  return (
    <Aviso tono="atencion" className="mb-holgado text-body">
      <span className="block font-semibold">Falta una cuenta para poder pagar desde tu billetera</span>
      <span className="mt-ajustado block">
        Para pagar por enlace, Solana necesita una cuenta tuya que guarda un valor de un solo uso. Se
        crea una vez y te sirve para todos tus envíos. Cuesta {formatLamportsAsSol(NONCE_ACCOUNT_RENT_LAMPORTS)} SOL
        de alquiler, que quedan inmovilizados en esa cuenta y Chaski no te los devuelve con ningún
        botón. Más la comisión de red de esta transacción, que también la pagás vos.
      </span>
      <Button className="mt-normal" disabled={ocupado} onClick={onCrear}>
        Crear la cuenta
      </Button>
      {/* 🔴 ACÁ DECÍA «LA SALIDA SECUNDARIA NO ES UN CALLEJÓN», Y ES FALSO (AR/BLQ-BAJO-1). El argumento era que el corte del adaptador por cuenta ausente ((`deeplink_nonce_ausente`, `../infrastructure/solana-wallet.ts:818`)) la traería de vuelta a esta misma oferta. Ese corte vive DESPUÉS de `prepare()`, y en el camino por enlace `prepare()` muere primero con `payout_pop_unavailable` (WKH-359), así que `deeplink_nonce_ausente` es INALCANZABLE por este camino: la remesa termina en el desenlace de `prepareUnreachable` (`:1712`) y hay que empezar de nuevo con otra cotización.
          ⇒ QUÉ ES DE VERDAD ESTE BOTÓN, y por eso se sigue ofreciendo igual: es la salida para quien NO quiere pagar el alquiler ahora. Lo que cuesta usarlo es la remesa en curso, no un toque. ⛔ NO se le pone un `disabled` ni se lo esconde: forzar a crear una cuenta que cuesta SOL para poder salir de una pantalla es peor que un callejón declarado.
          ⚠️ Y NO SE PROMETE que el depósito por enlace cierre cuando la cuenta exista: nadie de este equipo lo corrió en un teléfono y el PoP sigue siendo WKH-359. Lo que la cuenta habilita hoy es el paso del nonce, no el pago. */}
      <Button variant="ghost" className="mt-ajustado" disabled={ocupado} onClick={onSeguirSinCrearla}>
        Seguir sin crearla
      </Button>
    </Aviso>
  );
}

/**
 * WKH-358 (fix-pack · AR/BLQ-MED-1 + AR/BLQ-BAJO-3 + CR/BLQ-BAJO-4) — LA SALIDA DE LA ELECCIÓN.
 *
 * 🔴 QUÉ AGUJERO CIERRA, Y ES DE COMPORTAMIENTO, NO DE PROSA. Hasta el fix-pack, elegir una billetera
 * en el selector escribía una preferencia que **no expiraba y que nada de producción borraba**: el
 * único borrador, (`olvidar`, `../infrastructure/solana/preparacion-por-enlace.ts:246`), tenía CERO
 * llamadores de producción (todos en `*.test.*`). Consecuencia medida: una vez elegido Phantom, el gate
 * del adaptador quedaba armado para ese origen para siempre, sin ninguna puerta de vuelta en la
 * pantalla. Este control ES esa puerta, y es la mitad que la bandera del build no puede dar: la bandera
 * repliega el BUILD (`caminoPorEnlace`, `../infrastructure/solana-wallet.ts:2239`), esto repliega EL
 * DISPOSITIVO de quien ya eligió.
 *
 * ⛔ VIVE AL FINAL DEL ARCHIVO por la razón mecánica de siempre (`:44`): este archivo recibe citas por
 * número y agregar en el medio las corre todas. El componente se monta en UNA línea ya existente.
 *
 * 🔴 POR QUÉ LEE LA ELECCIÓN EN UN EFECTO Y NO EN EL RENDER, que es lo que parece más simple.
 * `eleccion()` toca `localStorage`, y leer el disco durante el render de un componente que Next puede
 * renderizar en el servidor produce dos árboles distintos (en el servidor `entorno()` contesta `null`).
 * Hoy el paso `connect` no se renderiza nunca en el servidor —el default es `bienvenida`—, pero apoyarse
 * en eso sería apoyarse en un dato de OTRO componente. El efecto además da el re-render que hace falta
 * después de olvidar: `olvidar()` escribe el disco y React no se enteraría sola.
 * ⚠️ Es idempotente bajo StrictMode a propósito (el doble montaje repite una LECTURA pura), así que no
 * necesita el `ref` que sí necesita el productor de la vuelta.
 *
 * ⛔ NO SE MUESTRA SI NADIE ELIGIÓ: `elegida === null` ⇒ `null`. Un control que ofrece deshacer algo que
 * no pasó es ruido, y además mentiría sobre el estado del disco.
 *
 * ⚠️ QUÉ NO HACE, dicho para que nadie se apoye en su presencia: no desconecta ninguna billetera y no
 * toca la cadena. Borra la preferencia de ESTE navegador y el viaje abierto (las dos mitades, por lo que
 * está escrito en el docblock de `olvidar()`), y con eso el próximo gesto vuelve al camino inyectado.
 * Sin em dashes en el texto que ve la persona (CD-16).
 */
function OlvidarBilleteraDeEnlace({
  recorrido,
  deshabilitado,
}: {
  recorrido: Pick<Container["recorridoPorEnlace"], "eleccion" | "olvidar">;
  deshabilitado: boolean;
}) {
  const [elegida, setElegida] = useState<BilleteraDeeplink | null>(null);
  useEffect(() => {
    setElegida(recorrido.eleccion());
  }, [recorrido]);
  if (elegida === null) return null;
  return (
    <Button
      variant="ghost"
      className="mt-ajustado"
      disabled={deshabilitado}
      onClick={() => {
        recorrido.olvidar();
        setElegida(null);
      }}
    >
      Cambiar de billetera
    </Button>
  );
}
