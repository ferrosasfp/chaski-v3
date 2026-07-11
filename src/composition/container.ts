// Composition root — el ÚNICO lugar que conoce adapters concretos. Hoy cablea FALLBACK;
// cuando llegue el sandbox (Fase A) se swappean por los adapters reales ACÁ — cero cambio en
// use-cases ni UI (dependency inversion). Es el mismo principio que las factories del backend.

import { AbandonPendingKyc } from "../application/use-cases/abandon-pending-kyc";
import { ConfirmAndSend } from "../application/use-cases/confirm-and-send";
import { ConnectWallet } from "../application/use-cases/connect-wallet";
import { CreateRemittance } from "../application/use-cases/create-remittance";
import { ListHistory } from "../application/use-cases/list-history";
import { LockQuote } from "../application/use-cases/lock-quote";
import { PreviewQuote } from "../application/use-cases/preview-quote";
import { ResumeKyc } from "../application/use-cases/resume-kyc";
import { StartKyc } from "../application/use-cases/start-kyc";
import { TrackRemittance } from "../application/use-cases/track-remittance";
import { DiditKycGateway } from "../infrastructure/didit/kyc-gateway";
import {
  FallbackKycGateway,
  FallbackPayoutGateway,
  FallbackQuoteGateway,
} from "../infrastructure/fallback/gateways";
import { LocalKycPendingStore } from "../infrastructure/kyc-pending-store";
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
}

export function createContainer(): Container {
  const clock = new SystemClock();
  const ids = new CryptoIds();
  const repo = new LocalRepo();
  const kycStore = new LocalKycStore();
  const kycPending = new LocalKycPendingStore();
  const quotes = new FallbackQuoteGateway();
  // Server-truth: SIEMPRE el gateway Didit, con la simulación como fallback. Si el server tiene
  // key → Didit real; si no (501) → simulación. No depende del inlineado NEXT_PUBLIC del cliente.
  const kyc = new DiditKycGateway(new FallbackKycGateway());
  const payouts = new FallbackPayoutGateway();
  const wallet = pickWallet(); // wallet REAL (MetaMask) si está inyectada, si no la demo

  return {
    previewQuote: new PreviewQuote(quotes),
    createRemittance: new CreateRemittance(repo, clock, ids),
    connectWallet: new ConnectWallet(wallet, kycStore),
    startKyc: new StartKyc(kyc, kycStore, kycPending, repo, clock),
    resumeKyc: new ResumeKyc(kyc, kycStore, kycPending, repo, clock),
    lockQuote: new LockQuote(quotes, repo, clock),
    confirmAndSend: new ConfirmAndSend(wallet, payouts, repo, clock),
    trackRemittance: new TrackRemittance(payouts, repo, clock),
    listHistory: new ListHistory(repo),
    abandonPendingKyc: new AbandonPendingKyc(kycPending),
  };
}

let singleton: Container | null = null;
/** Container compartido (browser). */
export function getContainer(): Container {
  if (!singleton) singleton = createContainer();
  return singleton;
}
