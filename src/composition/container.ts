// Composition root — el ÚNICO lugar que conoce adapters concretos. Hoy cablea FALLBACK;
// cuando llegue el sandbox (Fase A) se swappean por los adapters reales ACÁ — cero cambio en
// use-cases ni UI (dependency inversion). Es el mismo principio que las factories del backend.

import { AbandonPendingKyc } from "../application/use-cases/abandon-pending-kyc";
import { ConfirmAndSend } from "../application/use-cases/confirm-and-send";
import { ConnectWallet } from "../application/use-cases/connect-wallet";
import { CreateRemittance } from "../application/use-cases/create-remittance";
import { ForgetKyc } from "../application/use-cases/forget-kyc";
import { ListHistory } from "../application/use-cases/list-history";
import { LockQuote } from "../application/use-cases/lock-quote";
import { PreviewQuote } from "../application/use-cases/preview-quote";
import { ResumeKyc } from "../application/use-cases/resume-kyc";
import { StartKyc } from "../application/use-cases/start-kyc";
import { TrackRemittance } from "../application/use-cases/track-remittance";
import { A2aPayoutGateway, A2aQuoteGateway } from "../infrastructure/a2a/gateways";
import { resolveReceiverAddress } from "../infrastructure/chain";
import { DiditKycGateway } from "../infrastructure/didit/kyc-gateway";
import {
  FallbackKycGateway,
  FallbackPayoutGateway,
  FallbackQuoteGateway,
} from "../infrastructure/fallback/gateways";
import { LocalKycPendingStore } from "../infrastructure/kyc-pending-store";
import { HttpPayoutAuthorityGateway } from "../infrastructure/payout/payout-authority-gateway";
import { LedgerRefundGateway } from "../infrastructure/refund/ledger-refund-gateway";
import { HttpSettlementGateway } from "../infrastructure/settlement/http-settlement-gateway";
import { LocalKycStore } from "../infrastructure/kyc-store";
import { LocalRepo } from "../infrastructure/persistence";
import { CryptoIds, SystemClock } from "../infrastructure/system";
import { pickWallet } from "../infrastructure/wallet";

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
}

export function createContainer(): Container {
  const clock = new SystemClock();
  const ids = new CryptoIds();
  const repo = new LocalRepo();
  const kycStore = new LocalKycStore();
  const kycPending = new LocalKycPendingStore();
  // Flag de composición value-delivery (WKH-186/AC-1/AC-2, DT-4): un solo flag cablea quote+payout
  // (evita quote-real + payout-mock). Default "fallback" → demo byte-idéntico (mock). "a2a" → los
  // agentes remit-* reales vía las API routes server-only.
  const adapter = process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER; // "fallback"(default) | "a2a"
  // Guard fail-loud money-path (WKH-186/AC-11, CD-3/4/16): EIP-3009 encendido SIN adapter=a2a /
  // receiver / usdc → throw en construcción, la app NO arranca. Imposible un modo mixto silencioso
  // (firma real + payout mock). Default (EIP-3009 off) → nunca entra acá.
  if (process.env.NEXT_PUBLIC_EIP3009_ENABLED === "true") {
    if (adapter !== "a2a") throw new Error("eip3009_requires_a2a_adapter"); // CD-3
    if (!process.env.NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS) throw new Error("eip3009_requires_receiver"); // CD-4 (presencia)
    if (!process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS) throw new Error("eip3009_requires_usdc_contract"); // CD-16 (presencia)
    // MNR-A: además de presencia, validar FORMATO (isAddress) fail-loud — un receiver malformado
    // (typo / checksum válido) firmaría al destino equivocado en Fase A. La app NO arranca con un
    // receiver malformado; el error surge acá (construcción), NUNCA en sign-time. Simétrico con usdc.
    resolveReceiverAddress(); // throws payout_receiver_not_configured si el formato es inválido
  }
  const useA2a = adapter === "a2a";
  const quotes = useA2a ? new A2aQuoteGateway() : new FallbackQuoteGateway();
  // Server-truth: SIEMPRE el gateway Didit, con la simulación como fallback. Si el server tiene
  // key → Didit real; si no (501) → simulación. No depende del inlineado NEXT_PUBLIC del cliente.
  const kyc = new DiditKycGateway(new FallbackKycGateway());
  const payouts = useA2a ? new A2aPayoutGateway() : new FallbackPayoutGateway();
  const payoutAuthority = new HttpPayoutAuthorityGateway(); // autoridad server-side (WKH-180)
  const refund = new LedgerRefundGateway(); // refund-on-failure ledger-only (WKH-186/AC-8, CD-8)
  const wallet = pickWallet(); // wallet REAL (MetaMask) si está inyectada, si no la demo
  // Settlement real del principal (WKH-168/AC-5, CD-1): se instancia SOLO con el flag on. Con el
  // flag off queda `undefined` → ConfirmAndSend no recibe 7º arg → "modo demo" byte-idéntico a
  // pre-HU, POR CONSTRUCCIÓN (el use-case nunca lee una env — CD-14). El guard fail-loud de arriba
  // ya garantizó adapter=a2a + receiver + usdc antes de llegar acá: imposible firma-real+payout-mock.
  //
  // AR/MNR-4 + CR/MNR-2: el receiver se INYECTA acoplado al gateway (antes el use-case lo resolvía
  // importando infrastructure/chain → application→infrastructure). Acá es gratis: es el mismo valor
  // que el guard de arriba ya resolvió y validó fail-loud. `resolveReceiverAddress()` es puro e
  // idempotente y sólo se evalúa con el flag ON (el ternario corta antes) ⇒ AC-5 intacto, y no
  // puede throwear acá sin haber throweado ya en el guard (que queda BYTE-IDÉNTICO).
  const settlement =
    process.env.NEXT_PUBLIC_EIP3009_ENABLED === "true"
      ? { gateway: new HttpSettlementGateway(), receiver: resolveReceiverAddress() }
      : undefined;

  return {
    previewQuote: new PreviewQuote(quotes),
    createRemittance: new CreateRemittance(repo, clock, ids),
    connectWallet: new ConnectWallet(wallet, kycStore),
    startKyc: new StartKyc(kyc, kycStore, kycPending, repo, clock),
    resumeKyc: new ResumeKyc(kyc, kycStore, kycPending, repo, clock),
    lockQuote: new LockQuote(quotes, repo, clock),
    confirmAndSend: new ConfirmAndSend(
      wallet,
      payouts,
      repo,
      clock,
      payoutAuthority,
      refund,
      settlement, // WKH-168: undefined con el flag off ⇒ AC-5 por construcción
    ),
    trackRemittance: new TrackRemittance(payouts, repo, clock, refund),
    listHistory: new ListHistory(repo),
    abandonPendingKyc: new AbandonPendingKyc(kycPending),
    forgetKyc: new ForgetKyc(kycStore, kycPending, repo),
  };
}

let singleton: Container | null = null;
/** Container compartido (browser). */
export function getContainer(): Container {
  if (!singleton) singleton = createContainer();
  return singleton;
}
