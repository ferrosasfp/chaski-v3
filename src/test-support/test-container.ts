// Test-support — arma un Container con los 11 dobles de fakes.ts para renderizar RemittanceFlow
// bajo RTL sin infra real (WKH-185). Imita el orden de construcción de (`Container`, `container.ts:49`),
// compartiendo repo/clock/ids entre use-cases (createRemittance → startKyc → lockQuote operan
// sobre el mismo estado). Overrides a nivel gateway y escape-hatch a nivel use-case (useCases).
// CD-11: cero I/O real acá (la única excepción, FallbackQuoteGateway, la inyecta el test).

import type { Container } from "../composition/container";
import { PreviewQuote } from "../application/use-cases/preview-quote";
import { RecoverEscrowFunds } from "../application/use-cases/recover-escrow-funds";
import { CreateRemittance } from "../application/use-cases/create-remittance";
import { ConnectWallet } from "../application/use-cases/connect-wallet";
import { StartKyc } from "../application/use-cases/start-kyc";
import { ResumeKyc } from "../application/use-cases/resume-kyc";
import { LockQuote } from "../application/use-cases/lock-quote";
import { ConfirmAndSend } from "../application/use-cases/confirm-and-send";
import { TrackRemittance } from "../application/use-cases/track-remittance";
import { ListHistory } from "../application/use-cases/list-history";
import { AbandonPendingKyc } from "../application/use-cases/abandon-pending-kyc";
import { ForgetKyc } from "../application/use-cases/forget-kyc";
import type {
  Clock,
  KycGateway,
  KycPendingStore,
  KycStore,
  PayoutAuthorityGateway,
  PayoutGateway,
  QuoteGateway,
  RefundGateway,
  RemittanceRepository,
  SolanaCloseableEscrowLister,
  SolanaEscrowRefundGateway,
  WalletPort,
} from "../application/ports";
import {
  FakeQuoteGateway,
  FakeKycGateway,
  FakeWallet,
  FakeKycStore,
  FakeKycPendingStore,
  FakePayoutGateway,
  FakePayoutAuthorityGateway,
  FakeRefundGateway,
  FixedClock,
  SeqIds,
  InMemoryRepo,
} from "./fakes";

export interface TestContainerOverrides {
  quotes?: QuoteGateway; // default: new FakeQuoteGateway()
  kyc?: KycGateway; // default: new FakeKycGateway()
  wallet?: WalletPort; // default: new FakeWallet()
  kycStore?: KycStore; // default: new FakeKycStore()
  pending?: KycPendingStore; // default: new FakeKycPendingStore()
  payouts?: PayoutGateway; // default: new FakePayoutGateway()
  payoutAuthority?: PayoutAuthorityGateway; // default: new FakePayoutAuthorityGateway()
  refund?: RefundGateway; // default: new FakeRefundGateway() (regresión-neutral, WKH-186)
  // El settlement real se arma con `useCases.confirmAndSend` (ver confirm-and-send.money-path.test).
  // HU-SOL-13: sin override queda UNDEFINED → la acción de refund NO se muestra.
  solanaRefund?: SolanaEscrowRefundGateway;
  // WKH-327: sin override queda UNDEFINED ⇒ la puerta de descubrimiento no se muestra. Es la misma
  // disciplina que `solanaRefund`: un test que no lo inyecta no lo ve.
  //
  // 🔴 NO HAY `solanaClose` ACÁ, y su ausencia es la decisión (2º fix-pack, AR/MNR-5). La había, con
  // `closeEscrowAccounts: new CloseEscrowAccounts(o.solanaClose, { getConnectedAddress: () =>
  // wallet.getAddress() })`. Eso es el CACHE de `connect()` — exactamente lo que el docblock de
  // `ConnectedWalletProbe` llama "la respuesta equivocada" — y encima era código muerto: ningún test
  // seteaba el override, así que la línea nunca corría y nadie la podía ver mal. Un ejemplo
  // equivocado esperando a que alguien lo copie. Los tests del cierre montan el use-case con el probe
  // que corresponda (`escrow-rent-recovery.test.tsx` usa el adapter real contra el bridge).
  solanaCloseableEscrows?: SolanaCloseableEscrowLister;
  clock?: Clock; // default: new FixedClock()
  // Repo COMPARTIDO por todos los use-cases (default: new InMemoryRepo()). Se inyecta para poder
  // SEMBRARLO antes de renderizar: es la única forma de testear el historial, que por definición
  // habla de remesas que existían antes de que el componente montara.
  repo?: RemittanceRepository;
  useCases?: Partial<Container>; // escape hatch (ej. resumeKyc stub para T3)
}

export function buildTestContainer(o: TestContainerOverrides = {}): Container {
  const clock = o.clock ?? new FixedClock();
  const ids = new SeqIds();
  const repo = o.repo ?? new InMemoryRepo();
  const quotes = o.quotes ?? new FakeQuoteGateway();
  const kyc = o.kyc ?? new FakeKycGateway();
  const wallet = o.wallet ?? new FakeWallet();
  const kycStore = o.kycStore ?? new FakeKycStore();
  const pending = o.pending ?? new FakeKycPendingStore();
  const payouts = o.payouts ?? new FakePayoutGateway();
  const payoutAuthority = o.payoutAuthority ?? new FakePayoutAuthorityGateway();
  const refund = o.refund ?? new FakeRefundGateway();

  const base: Container = {
    previewQuote: new PreviewQuote(quotes),
    createRemittance: new CreateRemittance(repo, clock, ids),
    connectWallet: new ConnectWallet(wallet, kycStore),
    startKyc: new StartKyc(kyc, kycStore, pending, repo, clock),
    resumeKyc: new ResumeKyc(kyc, kycStore, pending, repo, clock),
    lockQuote: new LockQuote(quotes, repo, clock),
    confirmAndSend: new ConfirmAndSend(wallet, repo, clock, payoutAuthority, refund),
    trackRemittance: new TrackRemittance(payouts, repo, clock, refund),
    listHistory: new ListHistory(repo),
    abandonPendingKyc: new AbandonPendingKyc(pending),
    forgetKyc: new ForgetKyc(kycStore, pending, repo),
    solanaRefund: o.solanaRefund, // HU-SOL-13: undefined ⇒ la UI no muestra la acción refund
    // Se arma sobre el MISMO repo/clock que el resto: un test que dispara el refund tiene que poder
    // leer el estado persistido después, que es justo lo que el bug no hacía.
    recoverEscrowFunds: o.solanaRefund
      ? new RecoverEscrowFunds(repo, clock, o.solanaRefund)
      : undefined,
    solanaCloseableEscrows: o.solanaCloseableEscrows,
  };
  return { ...base, ...(o.useCases ?? {}) };
}
