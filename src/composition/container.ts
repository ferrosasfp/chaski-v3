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
import type { SolanaEscrowRefundGateway as SolanaEscrowRefundPort } from "../application/ports";
import { A2aPayoutGateway, A2aQuoteGateway } from "../infrastructure/a2a/gateways";
import { HttpPopSigner } from "../infrastructure/auth/http-pop-signer";
import {
  resolveActiveVm,
  resolveReceiverAddress,
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
import { SolanaEscrowRefundGateway } from "../infrastructure/refund/solana-escrow-refund-gateway";
import { HttpPayoutPrepareGateway } from "../infrastructure/settlement/http-payout-prepare-gateway";
import { HttpSettlementGateway } from "../infrastructure/settlement/http-settlement-gateway";
import { HttpSolanaPayoutPrepareGateway } from "../infrastructure/settlement/http-solana-prepare-gateway";
import { HttpSolanaSettlementGateway } from "../infrastructure/settlement/http-solana-settlement-gateway";
import { LocalKycStore } from "../infrastructure/kyc-store";
import { LocalRepo } from "../infrastructure/persistence";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
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
  // HU-SOL-13 (WKH-216): refund trustless del escrow Solana. OPCIONAL: sólo se cablea con
  // resolveActiveVm()==="solana" (undefined en EVM/demo ⇒ la UI no muestra la acción). AC-6/CD-10.
  solanaRefund?: SolanaEscrowRefundPort;
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
    if (adapter !== "a2a" && adapter !== "a2a-gateway") throw new Error("eip3009_requires_a2a_adapter"); // CD-3 (WKH-218: a2a-gateway también es adapter real)
    if (!process.env.NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS) throw new Error("eip3009_requires_receiver"); // CD-4 (presencia)
    if (!process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS) throw new Error("eip3009_requires_usdc_contract"); // CD-16 (presencia)
    // MNR-A: además de presencia, validar FORMATO (isAddress) fail-loud — un receiver malformado
    // (typo / checksum válido) firmaría al destino equivocado en Fase A. La app NO arranca con un
    // receiver malformado; el error surge acá (construcción), NUNCA en sign-time. Simétrico con usdc.
    resolveReceiverAddress(); // throws payout_receiver_not_configured si el formato es inválido
  }
  const useA2a = adapter === "a2a" || adapter === "a2a-gateway"; // WKH-218: gateway también usa los A2a gateways cliente
  const quotes = useA2a ? new A2aQuoteGateway() : new FallbackQuoteGateway();
  // Server-truth: SIEMPRE el gateway Didit, con la simulación como fallback. Si el server tiene
  // key → Didit real; si no (501) → simulación. No depende del inlineado NEXT_PUBLIC del cliente.
  const kyc = new DiditKycGateway(new FallbackKycGateway());
  const payouts = useA2a ? new A2aPayoutGateway() : new FallbackPayoutGateway();
  const payoutAuthority = new HttpPayoutAuthorityGateway(); // autoridad server-side (WKH-180)
  const refund = new LedgerRefundGateway(); // refund-on-failure ledger-only (WKH-186/AC-8, CD-8)
  // Dispatcher de wallet gateado por VM (AC-4): un solo resolveActiveVm() gobierna el wiring; imposible
  // modo mixto silencioso. El adapter Solana es React-free (seam AC-3) → import estático seguro para el
  // bundle EVM. VM=evm/unset → pickWallet() EVM INTACTO. VM inválida → resolveActiveVm() throw (AC-5).
  const solanaWallet = resolveActiveVm() === "solana" ? new SolanaWalletAdapter() : null;
  const wallet = solanaWallet ?? pickWallet();
  // HU-SOL-13 (WKH-216) — guard fail-loud money-path Solana, análogo al EIP-3009 de arriba. MUTUAMENTE
  // EXCLUYENTE con el path EVM: si la VM activa es Solana, EIP-3009 DEBE estar OFF (nunca se inyectan
  // `settlement` y `solana` juntos — CD-2/CD-14). Con el flag Solana ON exige mint+facilitator
  // configurados (client-safe, NEXT_PUBLIC_); la release-authority se resuelve SERVER-SIDE (nunca en el
  // bundle browser, CD-6). Default (flags OFF) → nunca entra acá ⇒ EVM/demo byte-idéntico.
  const solanaSettleOn = process.env.NEXT_PUBLIC_SOLANA_SETTLE_ENABLED === "true";
  if (solanaWallet && process.env.NEXT_PUBLIC_EIP3009_ENABLED === "true") {
    throw new Error("solana_vm_excludes_eip3009"); // mutua exclusión (CD-14)
  }
  if (solanaSettleOn) {
    if (!solanaWallet) throw new Error("solana_settle_requires_solana_vm"); // flag sin VM Solana
    resolveSolanaUsdcMint(); // fail-loud si falta/malformado
    resolveSolanaFacilitatorPubkey(); // fail-loud si falta/malformado
  }
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
  // WKH-211 [SDD-GAP #1]: el `prepare` gateway va ACOPLADO dentro de `settlement` (no un 9º param
  // suelto) → `settlement !== undefined ⇔ modo real ⇔ gateway Y prepare presentes juntos`, preservando
  // el invariante anti-fail-open del ex-`receiver`. El `receiver` se REMUEVE: el `to` ahora es el
  // depositAddress ATESTADO por remesa que devuelve `prepare` (el use-case ya no lee un receiver global).
  // Ambos se instancian con el MISMO flag; el guard fail-loud de arriba ya validó adapter=a2a + envs.
  const settlement =
    process.env.NEXT_PUBLIC_EIP3009_ENABLED === "true"
      ? { gateway: new HttpSettlementGateway(), prepare: new HttpPayoutPrepareGateway() }
      : undefined;
  // Proof-of-possession opt-in (WKH-206/AC-1, CD-2): se instancia SOLO con el flag on. Off ⇒
  // `undefined` → ConfirmAndSend no recibe 8º arg → demo byte-idéntico por construcción (el use-case
  // nunca lee env — CD-13). Doble flag coordinado con el server PAYOUT_POP_SECRET (idéntico a EIP3009).
  const pop =
    process.env.NEXT_PUBLIC_PAYOUT_POP_ENABLED === "true" ? new HttpPopSigner(wallet) : undefined;
  // HU-SOL-13 (WKH-216) — inyección Solana ACOPLADA (prepare+gateway), MUTUAMENTE EXCLUYENTE con
  // `settlement` (EVM): sólo con VM Solana + el flag Solana ON. Undefined en EVM/demo ⇒ ConfirmAndSend
  // no recibe 9º arg ⇒ path EVM byte-idéntico (CD-2/CD-14). El guard de arriba ya validó los envs.
  const solana =
    solanaWallet && solanaSettleOn
      ? { prepare: new HttpSolanaPayoutPrepareGateway(), gateway: new HttpSolanaSettlementGateway() }
      : undefined;
  // Refund trustless (AC-6/CD-10): disponible en modo Solana como válvula de recuperación (lee on-chain
  // y aborta si no es refundeable). undefined en EVM/demo ⇒ la UI no muestra la acción.
  const solanaRefund = solanaWallet ? new SolanaEscrowRefundGateway(solanaWallet) : undefined;

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
      pop, // WKH-206: undefined con el flag off ⇒ AC-5 por construcción
      solana, // HU-SOL-13: undefined en EVM/demo ⇒ path EVM byte-idéntico por construcción
    ),
    trackRemittance: new TrackRemittance(payouts, repo, clock, refund),
    listHistory: new ListHistory(repo),
    abandonPendingKyc: new AbandonPendingKyc(kycPending),
    forgetKyc: new ForgetKyc(kycStore, kycPending, repo),
    solanaRefund, // HU-SOL-13: undefined en EVM/demo ⇒ la UI no muestra la acción refund
  };
}

let singleton: Container | null = null;
/** Container compartido (browser). */
export function getContainer(): Container {
  if (!singleton) singleton = createContainer();
  return singleton;
}
