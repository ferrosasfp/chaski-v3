// Test-support — arma un Container con los 11 dobles de fakes.ts para renderizar RemittanceFlow
// bajo RTL sin infra real (WKH-185). Imita el orden de construcción de (`Container`, `container.ts:50`),
// compartiendo repo/clock/ids entre use-cases (createRemittance → startKyc → lockQuote operan
// sobre el mismo estado). Overrides a nivel gateway y escape-hatch a nivel use-case (useCases).
// CD-11: cero I/O real acá (la única excepción, FallbackQuoteGateway, la inyecta el test).

import type { Container, PreparacionPorEnlace } from "../composition/container"; import { InMemoryPopProofStore } from "../infrastructure/auth/pop-proof-store"; // WKH-358: `EleccionDeEnlace` entra ACÁ, en la línea que ya existe, y se toma del re-export del composition root y no del módulo de infraestructura, que es exactamente para lo que ese re-export se escribió. WKH-339: el import va EN ESTA LÍNEA, no en una nueva, porque `container.test.ts:413` cita `test-container.ts:87` por número y una línea de más lo rota en silencio (mismo motivo que `flow-vm.ts:25`)
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
  SolanaCloseableEscrowLister, SolanaEscrowChainStateReader, ConnectedWalletProbe, // WKH-349: EN ESTA LÍNEA, no en una nueva — mismo motivo que el import de `:7`: `container.test.ts:413` cita `test-container.ts:87` por número. WKH-354: `ConnectedWalletProbe` entra ACÁ por lo mismo
  SolanaEscrowRefundGateway,
  WalletPort,
} from "../application/ports";
import {
  FakeQuoteGateway,
  FakeKycGateway,
  FakeWallet,
  FakeKycStore,
  FakeKycPendingStore,
  FakePayoutGateway, FakeConnectedWallet, RecorridoPorEnlaceNulo, // WKH-358: `RecorridoPorEnlaceNulo` EN ESTA LÍNEA por lo mismo. ⚠️ Acá decía `EleccionDeEnlaceNula`, que es como se llamaba el doble en W1 y que NO existe desde W4 (CR/MNR-3): el nombre se movió con lo que la clase hace y este comentario se quedó atrás. WKH-354: `FakeConnectedWallet` EN ESTA LÍNEA — `:87` (`const payouts`) se cita por número desde 3 sitios y está debajo de este bloque
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
  solanaCloseableEscrows?: SolanaCloseableEscrowLister; solanaEscrowStates?: SolanaEscrowChainStateReader; connectedWallet?: ConnectedWalletProbe; recorridoPorEnlace?: PreparacionPorEnlace; // WKH-358: `recorridoPorEnlace` entra ACÁ por lo mismo. WKH-349: EN ESTA LÍNEA (`:87` se cita por número). Misma disciplina que sus dos vecinos: sin override queda UNDEFINED ⇒ el historial NO pregunta nada a la cadena y dice el copy de siempre. WKH-354: `connectedWallet` entra ACÁ por lo mismo; su default NO es undefined sino `new FakeConnectedWallet(null)` = "no hay ninguna billetera conectada", que es el estado real de un test que no montó ningún árbol
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
  // WKH-333/DT-20: el doble de la autoridad ya NO se construye acá — `ConfirmAndSend` dejó de
  // recibirla. La OPCIÓN `o.payoutAuthority` se conserva en el tipo para no romper llamadores,
  // y se descarta explícitamente para que quede escrito que no llega a ningún lado.
  void o.payoutAuthority;
  const refund = o.refund ?? new FakeRefundGateway();
  // WKH-339: UN almacén para las dos capacidades de abajo. Se declara ACÁ y no arriba porque
  // `container.test.ts:413` cita la línea 87 de este archivo (`const payouts = …`) por número.
  const popProofs = new InMemoryPopProofStore(clock);

  const base: Container = {
    previewQuote: new PreviewQuote(quotes),
    createRemittance: new CreateRemittance(repo, clock, ids),
    connectWallet: new ConnectWallet(wallet, kycStore),
    startKyc: new StartKyc(kyc, kycStore, pending, repo, clock),
    resumeKyc: new ResumeKyc(kyc, kycStore, pending, repo, clock),
    lockQuote: new LockQuote(quotes, repo, clock),
    // WKH-333/DT-20: `payoutAuthority` ya NO se inyecta. El pre-check de autoridad que lo usaba se
    // eliminó del use-case; la opción `o.payoutAuthority` se conserva para los tests que todavía
    // construyen el doble, pero ya no llega a ningún lado desde acá.
    confirmAndSend: new ConfirmAndSend(wallet, repo, clock, refund),
    trackRemittance: new TrackRemittance(payouts, repo, clock, refund),
    listHistory: new ListHistory(repo),
    abandonPendingKyc: new AbandonPendingKyc(pending),
    forgetKyc: new ForgetKyc(kycStore, pending, repo),
    // ── WKH-339 · la ventana de lectura, sobre UN ÚNICO almacén ───────────────────────────────────
    //
    // 🔴 UNA SOLA INSTANCIA PARA LOS DOS CAMPOS, igual que en producción. Dos almacenes distintos
    // compilarían igual, y el `renovarVentana` grabaría en uno mientras `ventanaDeLectura` leería del
    // otro: el gesto nunca encendería nada. Que sea el MISMO es lo que `tsc` no puede garantizar.
    //
    // El default es LA VENTANA APAGADA, y es el caso real, no una comodidad del test: el almacén es en
    // memoria y arranca vacío, que es exactamente lo que se encuentra alguien que recarga y entra al
    // seguimiento desde el historial. Un test que quiera la ventana vigente tiene que GRABAR una
    // prueba, o sea hacer lo que hace un gesto.
    //
    // ⚠️ `FixedClock` por default ⇒ el reloj no avanza solo. Una prueba grabada NO vence en el medio de
    // un test, y eso es deseable: el cruce del TTL se mide en T-339.3, con un reloj que se avanza a
    // mano, no por el paso del tiempo real de una corrida.
    ventanaDeLectura: { estado: (a) => (popProofs.peek(a) ? "vigente" : "sin-prueba") },
    renovarVentana: { prove: async (a) => { const p = { challenge: "c-test", signature: "s-test" }; popProofs.record(a, p); return p; } },
    solanaRefund: o.solanaRefund, // HU-SOL-13: undefined ⇒ la UI no muestra la acción refund
    // Se arma sobre el MISMO repo/clock que el resto: un test que dispara el refund tiene que poder
    // leer el estado persistido después, que es justo lo que el bug no hacía.
    recoverEscrowFunds: o.solanaRefund
      ? new RecoverEscrowFunds(repo, clock, o.solanaRefund)
      : undefined,
    solanaCloseableEscrows: o.solanaCloseableEscrows,
    solanaEscrowStates: o.solanaEscrowStates, // WKH-349: undefined ⇒ el historial no consulta la cadena
    // WKH-354/CD-13. El default es `new FakeConnectedWallet(null)` y NADA MÁS. Está PROHIBIDO
    // escribir `{ getConnectedAddress: () => wallet.getAddress() }`: es el CACHE de `connect()`, o
    // sea "la respuesta equivocada que compila" que el docblock de `ConnectedWalletProbe` nombra, y
    // este mismo archivo ya cuenta más arriba (en el bloque de `solanaClose`) que esa forma vivió
    // acá, muerta, esperando a que alguien la copiara. `null` significa "no hay ninguna billetera
    // conectada", que es exactamente el estado de un test que no montó el árbol de providers. Un
    // test que quiera una cuenta viva la inyecta.
    connectedWallet: o.connectedWallet ?? new FakeConnectedWallet(null), recorridoPorEnlace: o.recorridoPorEnlace ?? new RecorridoPorEnlaceNulo(), // WKH-358 — EN ESTA LÍNEA, misma disciplina que sus vecinos. El default NO es `undefined` ni el objeto real: es el doble que dice "esta persona no eligió ninguna billetera por enlace", que es el estado real de un test que no montó ningún selector
  };
  return { ...base, ...(o.useCases ?? {}) };
}
