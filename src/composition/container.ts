// Composition root — el ÚNICO lugar que conoce adapters concretos. Hoy cablea FALLBACK;
// cuando llegue el sandbox (Fase A) se swappean por los adapters reales ACÁ — cero cambio en
// use-cases ni UI (dependency inversion). Es el mismo principio que las factories del backend.

import { assertNoEvmResidue } from "./evm-residue-guard";
import { AbandonPendingKyc } from "../application/use-cases/abandon-pending-kyc";
import { ConfirmAndSend } from "../application/use-cases/confirm-and-send";
import { ConnectWallet } from "../application/use-cases/connect-wallet";
import { CreateRemittance } from "../application/use-cases/create-remittance";
import { ForgetKyc } from "../application/use-cases/forget-kyc";
import { ListHistory } from "../application/use-cases/list-history";
import { LockQuote } from "../application/use-cases/lock-quote";
import { PreviewQuote } from "../application/use-cases/preview-quote";
import { CloseEscrowAccounts } from "../application/use-cases/close-escrow-accounts";
import { RecoverEscrowFunds } from "../application/use-cases/recover-escrow-funds";
import { ResumeKyc } from "../application/use-cases/resume-kyc";
import { StartKyc } from "../application/use-cases/start-kyc";
import { TrackRemittance } from "../application/use-cases/track-remittance";
import type {
  PopSigner,
  SolanaCloseableEscrowLister,
  SolanaEscrowRefundGateway as SolanaEscrowRefundPort,
} from "../application/ports";
import { A2aPayoutGateway, A2aQuoteGateway } from "../infrastructure/a2a/gateways";
import { HttpPopSigner } from "../infrastructure/auth/http-pop-signer";
import {
  resolveSolanaFacilitatorPubkey,
  resolveSolanaUsdcMint,
} from "../infrastructure/chain";
import { DiditKycGateway } from "../infrastructure/didit/kyc-gateway";
import {
  FallbackKycGateway,
  FallbackPayoutGateway,
  FallbackQuoteGateway,
} from "../infrastructure/fallback/gateways";
import { LocalKycPendingStore } from "../infrastructure/kyc-pending-store";
import { HttpPayoutAuthorityGateway } from "../infrastructure/payout/payout-authority-gateway";
import { LedgerRefundGateway } from "../infrastructure/refund/ledger-refund-gateway";
import { HttpSolanaRemittanceIdResolver } from "../infrastructure/refund/http-solana-remittance-id-resolver";
import { SolanaEscrowCloseGateway } from "../infrastructure/escrow/solana-escrow-close-gateway";
import { SolanaEscrowRefundGateway } from "../infrastructure/refund/solana-escrow-refund-gateway";
import { HttpSolanaPayoutPrepareGateway } from "../infrastructure/settlement/http-solana-prepare-gateway";
import { HttpSolanaSettlementGateway } from "../infrastructure/settlement/http-solana-settlement-gateway";
import { LocalKycStore } from "../infrastructure/kyc-store";
import { LocalRepo } from "../infrastructure/persistence";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { CryptoIds, SystemClock } from "../infrastructure/system";

export interface Container {
  previewQuote: PreviewQuote;
  createRemittance: CreateRemittance;
  connectWallet: ConnectWallet;
  startKyc: StartKyc;
  resumeKyc: ResumeKyc;
  lockQuote: LockQuote;
  confirmAndSend: ConfirmAndSend;
  trackRemittance: TrackRemittance;
  listHistory: ListHistory;
  abandonPendingKyc: AbandonPendingKyc;
  forgetKyc: ForgetKyc;
  // HU-SOL-13 (WKH-216): refund trustless del escrow Solana (AC-6/CD-10). Sigue OPCIONAL en el tipo:
  // el container real siempre lo cablea, pero el test-container lo deja pasar undefined y la UI ya
  // maneja su ausencia. Volverlo requerido sería re-tipar superficie que esta HU no vino a tocar.
  solanaRefund?: SolanaEscrowRefundPort;
  // Recuperación de fondos del escrow CON persistencia del resultado. Es lo que la UI invoca: el
  // gateway suelto (`solanaRefund`) devuelve una signature y nada más, y de ahí salía el bug de
  // reportar como fallada una recuperación exitosa. Opcional por la misma razón que solanaRefund:
  // el test-container lo deja pasar undefined y la UI ya maneja su ausencia.
  recoverEscrowFunds?: RecoverEscrowFunds;
  // WKH-327: cerrar las dos cuentas del escrow para que vuelva el alquiler que el remitente pagó al
  // depositar. SIEMPRE presente en el container real, sin ninguna flag que lo apague — por la misma
  // razón que `solanaRefund` (`:136-137`): es una válvula de recuperación de plata de la persona, y una
  // configuración que la pueda apagar es una configuración que algún día la va a apagar. Opcional en el
  // TIPO sólo para que el test-container pueda pasar undefined, igual que sus dos vecinos de arriba.
  closeEscrowAccounts?: CloseEscrowAccounts;
  // El descubrimiento de cerrables (AC-8): la UI necesita LISTAR antes de poder cerrar, porque los
  // envíos que no están en el localStorage de este navegador no tienen ningún otro camino.
  solanaCloseableEscrows?: SolanaCloseableEscrowLister;
}

// HU-SOL-20/AC-2 — arma el SolanaWalletAdapter CON su resolver de remittanceId en un solo paso (sin setter,
// sin objeto a medio construir y sin una segunda instancia del adapter).
// El ciclo aparente (adapter → resolver → PopSigner → WalletPort=adapter) se rompe DIFIRIENDO la
// construcción del PopSigner: `lazyPop.prove` recién se evalúa en tiempo de refund, cuando `adapter` ya
// existe. Es el mismo wallet que firma el PoP y el que refundea — condición del endpoint, que exige que
// el challenge sea de la MISMA address que pide sus ids.
function createSolanaWallet(): SolanaWalletAdapter {
  const lazyPop: PopSigner = { prove: (address) => new HttpPopSigner(adapter).prove(address) };
  const adapter: SolanaWalletAdapter = new SolanaWalletAdapter(
    new HttpSolanaRemittanceIdResolver(lazyPop),
  );
  return adapter;
}

export function createContainer(): Container {
  // PRIMERA línea, antes de cualquier `new`. La configuración de un camino de settlement que este
  // código ya no tiene vive FUERA del código (panel del proveedor de hosting) y nadie avisa cuando
  // queda huérfana: es lo único que no se resuelve por construcción, así que se resuelve fail-loud.
  assertNoEvmResidue();
  const clock = new SystemClock();
  const ids = new CryptoIds();
  const repo = new LocalRepo();
  const kycStore = new LocalKycStore();
  const kycPending = new LocalKycPendingStore();
  // Flag de composición value-delivery (WKH-186/AC-1/AC-2, DT-4): un solo flag cablea quote+payout
  // (evita quote-real + payout-mock). Default "fallback" → demo byte-idéntico (mock). "a2a" → los
  // agentes remit-* reales vía las API routes server-only.
  const adapter = process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER; // "fallback"(default) | "a2a"
  const useA2a = adapter === "a2a" || adapter === "a2a-gateway"; // WKH-218: gateway también usa los A2a gateways cliente
  const quotes = useA2a ? new A2aQuoteGateway() : new FallbackQuoteGateway();
  // Server-truth: SIEMPRE el gateway Didit, con la simulación como fallback. Si el server tiene
  // key → Didit real; si no (501) → simulación. No depende del inlineado NEXT_PUBLIC del cliente.
  const kyc = new DiditKycGateway(new FallbackKycGateway());
  const payouts = useA2a ? new A2aPayoutGateway() : new FallbackPayoutGateway();
  const payoutAuthority = new HttpPayoutAuthorityGateway(); // autoridad server-side (WKH-180)
  const refund = new LedgerRefundGateway(); // refund-on-failure ledger-only (WKH-186/AC-8, CD-8)
  // La wallet es SIEMPRE el SolanaWalletAdapter: no hay selección posible, y por eso no hay ternario.
  const wallet = createSolanaWallet();
  // HU-SOL-13 (WKH-216) — guard fail-loud money-path Solana. Con el flag ON exige mint+facilitator
  // configurados (client-safe, NEXT_PUBLIC_); la release-authority se resuelve SERVER-SIDE (nunca en
  // el bundle browser, CD-6). Flag OFF → nunca entra acá.
  const solanaSettleOn = process.env.NEXT_PUBLIC_SOLANA_SETTLE_ENABLED === "true";
  if (solanaSettleOn) {
    resolveSolanaUsdcMint(); // fail-loud si falta/malformado
    resolveSolanaFacilitatorPubkey(); // fail-loud si falta/malformado
  }
  // HU-SOL-13 (WKH-216) — inyección Solana ACOPLADA (prepare+gateway), sólo con el flag Solana ON.
  // Undefined ⇒ ConfirmAndSend no recibe 6º arg ⇒ su tapón DT-8 falla la remesa fail-closed en vez de
  // devolverla 'confirmed' sin haber movido nada. El guard de arriba ya validó los envs.
  // El prepare va con su PopSigner: /api/payout/prepare exige el PoP (PR6) y sin él responde 403
  // ANTES de que la wallet pida una sola firma. Es el MISMO HttpPopSigner sobre la MISMA wallet que
  // ya usa el camino de refund (createSolanaWallet), no un mecanismo nuevo.
  // `probe` = el MISMO adapter de wallet, que sabe derivar la PDA `escrow_state` y leerla on-chain.
  // Es la fuente autoritativa de si el principal entró cuando el settle no nos dio respuesta. No se
  // cablea ningún agente acá a propósito: un agente es reemplazable por otro mejor vía discovery, la
  // cadena no, y la verdad sobre el dinero tiene que colgar de lo que no se reemplaza.
  // `senderBalance` = el MISMO adapter otra vez, por la misma razón que `probe`: la pregunta "¿cuánto
  // SOL tiene esta billetera?" se la hace la cadena, no un agente. Existe porque el depósito NO es
  // gasless para el remitente (el fee lo paga el facilitator, el rent de las cuentas del escrow no).
  const solana = solanaSettleOn
    ? {
        prepare: new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)),
        gateway: new HttpSolanaSettlementGateway(),
        probe: wallet,
        senderBalance: wallet,
      }
    : undefined;
  // Refund trustless (AC-6/CD-10): válvula de recuperación (lee on-chain y aborta si no es
  // refundeable). SIEMPRE presente: no hay configuración que la pueda apagar.
  const solanaRefund = new SolanaEscrowRefundGateway(wallet);
  // WKH-327 — cierre de las cuentas del escrow. SIEMPRE presente y sin flag, por la misma razón que
  // `solanaRefund` de acá arriba: el alquiler inmovilizado es plata de la persona, no de la plataforma.
  // `solanaCloseableEscrows` es el MISMO adapter otra vez (como `probe` y `senderBalance`): la pregunta
  // "¿qué escrows míos siguen abiertos?" se la contesta la cadena, no un agente.
  const solanaClose = new SolanaEscrowCloseGateway(wallet);

  return {
    previewQuote: new PreviewQuote(quotes),
    createRemittance: new CreateRemittance(repo, clock, ids),
    connectWallet: new ConnectWallet(wallet, kycStore),
    startKyc: new StartKyc(kyc, kycStore, kycPending, repo, clock),
    resumeKyc: new ResumeKyc(kyc, kycStore, kycPending, repo, clock),
    lockQuote: new LockQuote(quotes, repo, clock),
    confirmAndSend: new ConfirmAndSend(
      wallet,
      repo,
      clock,
      payoutAuthority,
      refund,
      solana, // HU-SOL-13: undefined con el flag off ⇒ el tapón DT-8 del use-case falla fail-closed
    ),
    trackRemittance: new TrackRemittance(payouts, repo, clock, refund),
    listHistory: new ListHistory(repo),
    abandonPendingKyc: new AbandonPendingKyc(kycPending),
    forgetKyc: new ForgetKyc(kycStore, kycPending, repo),
    solanaRefund, // HU-SOL-13: refund trustless del escrow
    recoverEscrowFunds: new RecoverEscrowFunds(repo, clock, solanaRefund),
    // WKH-327. El 2º argumento es el MISMO adapter: el guard de AC-7 le pregunta a la billetera VIVA
    // quién está conectado en el instante del click, en vez de recibirlo del llamador (que le pasaba
    // la misma variable que estaba validando — AR/BLQ-BAJO-1).
    closeEscrowAccounts: new CloseEscrowAccounts(solanaClose, wallet),
    solanaCloseableEscrows: wallet, // WKH-327/AC-8: el descubrimiento se lo pregunta a la cadena
  };
}

let singleton: Container | null = null;
/** Container compartido (browser). */
export function getContainer(): Container {
  if (!singleton) singleton = createContainer();
  return singleton;
}
