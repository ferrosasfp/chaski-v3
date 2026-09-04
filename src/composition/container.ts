// Composition root — el ÚNICO lugar que conoce adapters concretos: se swappean ACÁ, con cero cambio en
// use-cases ni UI (dependency inversion). ⚠️ WKH-337/AC-6: acá decía "hoy cablea FALLBACK; cuando llegue
// el sandbox se swappean por los adapters reales", y del payout ya NO es cierto (`payouts`, `:127`).

import { assertNoEvmResidue } from "./evm-residue-guard";
import { resolveValueDeliveryAdapter, usesRealGateways } from "./value-delivery-adapter";
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
  PopProofRecorder, PopSigner, SolanaCloseableEscrowLister, SolanaEscrowChainStateReader, ConnectedWalletProbe, SolanaRentReader, // HU-079: EN ESTA LÍNEA por lo mismo. // WKH-349: EN ESTA LÍNEA (`:47`, `:50`, `:114`, `:123`, `:127`, `:141`, `:169` y `:196` se citan por número). WKH-354: `ConnectedWalletProbe` entra ACÁ y no en una línea propia, por lo mismo
  SolanaEscrowRefundGateway as SolanaEscrowRefundPort,
} from "../application/ports";
import { A2aQuoteGateway } from "../infrastructure/a2a/gateways";
import { HttpPopSigner } from "../infrastructure/auth/http-pop-signer";
import { InMemoryPopProofStore } from "../infrastructure/auth/pop-proof-store"; import { InMemorySesionStore } from "../infrastructure/auth/sesion-store"; // 🔴 WKH-372/W3.4 — EL IMPORT EN ESTA MISMA LÍNEA (Δ0): `container.ts` recibe citas ancladas por número y una línea de import de más las corre a todas
import { HttpKycVerdictGateway } from "../infrastructure/kyc/http-kyc-verdict-gateway";
import {
  resolveSolanaFacilitatorPubkey,
  resolveSolanaUsdcMint,
} from "../infrastructure/chain";
import { AgentKycGateway } from "../infrastructure/kyc/agent-kyc-gateway";
import {
  FallbackKycGateway, // WKH-337/R-2: los dos *PayoutGateway* de este módulo y del de a2a quedaron sin
  FallbackQuoteGateway, // consumidor de producción y NO se borran — sus docblocks lo dicen (AC-6).
} from "../infrastructure/fallback/gateways";
import { LedgerPayoutStatusGateway } from "../infrastructure/settlement/ledger-payout-status-gateway";
import { LocalKycPendingStore } from "../infrastructure/kyc-pending-store";
import { LedgerRefundGateway } from "../infrastructure/refund/ledger-refund-gateway";
import { HttpSolanaRemittanceIdResolver } from "../infrastructure/refund/http-solana-remittance-id-resolver";
import { SolanaEscrowCloseGateway } from "../infrastructure/escrow/solana-escrow-close-gateway";
import { SolanaEscrowRefundGateway } from "../infrastructure/refund/solana-escrow-refund-gateway";
import { HttpSolanaPayoutPrepareGateway } from "../infrastructure/settlement/http-solana-prepare-gateway";
import { HttpSolanaSettlementGateway } from "../infrastructure/settlement/http-solana-settlement-gateway";
import { LocalKycStore } from "../infrastructure/kyc-store";
import { LocalRepo } from "../infrastructure/persistence";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet"; import { FirmaPorEnlaceReal } from "../infrastructure/solana/deeplink/firma-por-enlace"; import { RecorridoPorEnlaceReal, type PreparacionPorEnlace } from "../infrastructure/solana/preparacion-por-enlace"; // WKH-358: EN ESTA LÍNEA, no en una nueva — este archivo recibe 40 citas ancladas y TODAS apuntan de `:48` para abajo, así que una línea nueva en el bloque de imports las rota a las 40 (medido). Precedente con su motivo escrito: (`solanaWalletBridge`, `../infrastructure/solana-wallet.ts:47`), siete imports en una línea. ⚠️ Y esta línea tiene que seguir conteniendo `SolanaWalletAdapter`, que es lo que cita `flow.tsx` por número
import { CryptoIds, SystemClock } from "../infrastructure/system";

export interface Container extends VentanaYRenovacion { // WKH-339: 2 campos REQUERIDOS, ver el final del archivo
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
  // razón que `solanaRefund`, `:169`: es una válvula de recuperación de plata de la persona, y una
  // configuración que la pueda apagar es una configuración que algún día la va a apagar. Opcional en el
  // TIPO sólo para que el test-container pueda pasar undefined, igual que sus dos vecinos de arriba.
  closeEscrowAccounts?: CloseEscrowAccounts;
  // El descubrimiento de cerrables (AC-8): la UI necesita LISTAR antes de poder cerrar, porque los
  // envíos que no están en el localStorage de este navegador no tienen ningún otro camino.
  solanaCloseableEscrows?: SolanaCloseableEscrowLister; solanaEscrowStates?: SolanaEscrowChainStateReader; connectedWallet: ConnectedWalletProbe; recorridoPorEnlace: PreparacionPorEnlace; solanaRent: SolanaRentReader; // HU-079: EN ESTA LÍNEA, no en una nueva — las citas por número de este archivo están TODAS debajo. Va SIN `?` por la MISMA razón que `connectedWallet` (CD-14): opcional dejaría que borrar su cableado compile y la suite quede verde, y el síntoma sería que la pantalla del cierre deja de mostrar la cifra de la cadena — que es exactamente el defecto que esta HU vino a cerrar, y encima invisible. // WKH-358 (fix-pack/CR-MNR-5): SE LLAMABA `eleccionDeEnlace` Y EL NOMBRE MENTÍA — el campo tipa `PreparacionPorEnlace` ENTERA (siete miembros: la elección, la vuelta, la cadena y el broadcast), no la elección; el nombre venía de W1, cuando el tipo sí era `EleccionDeEnlace`, y no se movió con lo que hace. Hoy nombra lo mismo que las dos implementaciones (`RecorridoPorEnlaceReal`, `RecorridoPorEnlaceNulo`). `recorridoPorEnlace` entra ACÁ y SIN `?` por la misma razón que `connectedWallet` (CD-14): opcional dejaría que borrar su cableado compile y la suite quede verde, y el síntoma sería que el selector de billetera no hace nada en un teléfono, que es justo donde nadie de este equipo mira. WKH-349: EN ESTA LÍNEA, no en una nueva — `:114`, `:123`, `:127`, `:141`, `:169` y `:196` de este archivo los cita otro por número y están TODOS debajo de acá. Opcional sólo por el test-container; el container real SIEMPRE lo cablea (ver el final de `createContainer`). WKH-354/AC-2+AC-3: `connectedWallet` entra ACÁ por lo mismo, y va SIN `?` (CD-14) — opcional dejaría que borrar su cableado compile y la suite quede verde, que es el perfil de mutante que el comentario de `solanaEscrowStates` documenta como el más peligroso del repo
}

// HU-SOL-20/AC-2 — arma el SolanaWalletAdapter CON su resolver de remittanceId en un solo paso (sin setter,
// sin objeto a medio construir y sin una segunda instancia del adapter).
// El ciclo aparente (adapter → resolver → PopSigner → WalletPort=adapter) se rompe DIFIRIENDO la
// construcción del PopSigner: `lazyPop.prove` recién se evalúa en tiempo de refund, cuando `adapter` ya
// existe. Es el mismo wallet que firma el PoP y el que refundea — condición del endpoint, que exige que
// el challenge sea de la MISMA address que pide sus ids.
function createSolanaWallet(proofs: PopProofRecorder): SolanaWalletAdapter { // WKH-337: el observador
  const lazyPop: PopSigner = { prove: (a) => new HttpPopSigner(adapter, proofs).prove(a) }; // ídem
  const adapter: SolanaWalletAdapter = new SolanaWalletAdapter(
    new HttpSolanaRemittanceIdResolver(lazyPop), undefined, new FirmaPorEnlaceReal(), // WKH-358 — el colaborador de enlace se cablea SIN CONDICIÓN, y lo que enciende la rama es el gate del adaptador (`caminoPorEnlace`, `../infrastructure/solana-wallet.ts:2239`): elección del selector Y `availability === "none"`. Con eso el camino inyectado no ejecuta ni una línea de las ramas nuevas y no hace falta ninguna bandera acá. ⚠️ EL `undefined` DEL MEDIO NO ES DECORATIVO: `firmaPorEnlace` es el 3er parámetro POSICIONAL y el 2º (`confirmTimeoutMs`) tiene default, así que sin el hueco esto no compila; pasar `undefined` dispara ese default, que es exactamente el de producción. ⛔ NO importes `REFUND_CONFIRM_TIMEOUT_MS` sólo para esto: sería un import más, y arriba está escrito lo que cuesta un import en este archivo
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
  const popProofs = new InMemoryPopProofStore(clock); const sesiones = new InMemorySesionStore(clock); // WKH-337: OBSERVA las pruebas PoP de los gestos · 🔴 WKH-372/W3.4 — EL ALMACÉN DE LA SESIÓN, EN ESTA MISMA LÍNEA FÍSICA (Δ0) y al lado de su hermano, porque son el mismo patrón con otra credencial. ⛔ TIENE QUE SER UNA SOLA INSTANCIA para los DOS gateways de abajo (`:161` la lee, `:185` la escribe): con dos instancias distintas el veredicto graba en una y el depósito lee la otra, nadie se entera, y la ola entera queda en un no-op VERDE. Lo mide `T-372-W3-16`, por nombre, en `./container.test.ts`, ejercitando `record` de un lado y `peek` del otro. ⚠️ El reloj es el MISMO `clock` inyectado: ni este almacén ni el de al lado llaman `Date.now()`
  // La wallet es SIEMPRE el SolanaWalletAdapter: no hay selección posible, y por eso no hay ternario.
  const wallet = createSolanaWallet(popProofs);
  // WKH-332/AC-3: el valor NO se compara crudo. Con la env en "a2a-gatewayy" la comparación directa
  // daba `false` ⇒ se cableaban los Fallback*Gateway (los simuladores) sin que nada fallara. Ahora
  // pasa por la unión cerrada y un valor no reconocido TIRA acá. La lectura de `process.env` queda
  // EN ESTA LÍNEA como member expression literal a propósito: Next sólo inlinea eso en el bundle del
  // cliente, y adentro del helper no lo sería (mismo motivo que evm-residue-guard.ts).
  const adapter = resolveValueDeliveryAdapter(process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER);
  // WKH-218: el carril por gateway también usa los A2a*Gateway cliente.
  //
  // 🔴 ACÁ ESTABA LA SEGUNDA LISTA (AR/BLQ-ALTO-2). Decía `adapter === "a2a" || adapter ===
  // "a2a-gateway"`: los mismos valores del conjunto cerrado, escritos otra vez, sin nada que los
  // atara. MEDIDO: borrando `adapter === "a2a" ||` la suite entera quedaba verde y, con la env en
  // "a2a" (la de producción), el container cableaba los Fallback*Gateway. El mapeo vive ahora en
  // `usesRealGateways`, junto a la lista, con un switch exhaustivo que `tsc` obliga a mantener.
  const useA2a = usesRealGateways(adapter);
  const quotes = useA2a ? new A2aQuoteGateway() : new FallbackQuoteGateway();
  // Server-truth: SIEMPRE el gateway del AGENTE de KYC, con la simulación como fallback. Si el server
  // tiene host del agente → camino real; si no (501) → simulación. No depende de ningún NEXT_PUBLIC.
  const kyc = new AgentKycGateway(new FallbackKycGateway()); // WKH-233/CD-9: EN ESTA MISMA LÍNEA. Este archivo documenta que OCHO de sus líneas las cita otro por número, y la del gateway de KYC está arriba de cuatro de ellas
  const payouts = new LedgerPayoutStatusGateway(wallet, popProofs, clock); // WKH-337/AC-6, ver `:136`
  // 🔴 WKH-333/DT-20 — acá se construía `payoutAuthority = new HttpPayoutAuthorityGateway()` y se
  // inyectaba en `ConfirmAndSend`. Ese pre-check se eliminó: el cliente ya no tiene el
  // `verificationId`, y la re-consulta que importa la hace `/api/payout/prepare` server-side, detrás
  // del PoP y con el identificador sacado de su propia fila.
  // El PUERTO y la route `/api/payout/validate` SE CONSERVAN a propósito (residual R-6, declarado):
  // borrarlos agrandaría el diff de una HU de money-path sin cerrar nada. Lo que queda es un adapter
  // sin consumidor de producción, y eso está escrito acá para que se vea.
  const refund = new LedgerRefundGateway(); // refund-on-failure ledger-only (WKH-186/AC-8, CD-8)
  // 🔴 WKH-337/AC-6 — la bandera (`adapter`, `:114`) cablea la COTIZACIÓN y nada del seguimiento: default "fallback" ⇒ demo byte-idéntico. Acá decía que "un solo flag cablea quote+payout", y era falso.
  // `payouts` (`:127`) NO cuelga de ninguna bandera y no hay ternario A PROPÓSITO: las dos implementaciones viejas eran CIEGAS, así que el flag nunca discriminó nada observable. Sin evidencia server-side verificada NUNCA fabrica un desenlace terminal.
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
        prepare: new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet, popProofs), sesiones), // 🔴 WKH-372/W3.4 — EL 2º ARGUMENTO EN ESTA MISMA LÍNEA (Δ0). Entra como `SesionReader`: este gateway LEE la sesión que la persona ya se ganó al conectar y presenta esa prueba en vez de pedirle una SEGUNDA firma. ⛔ No puede grabarse una: el tipo no tiene `record`
        gateway: new HttpSolanaSettlementGateway(),
        probe: wallet,
        senderBalance: wallet, pop: wallet, // WKH-359/AC-2 — ⛔ SIN `?`, EN ESTA LÍNEA. `pop` es el MISMO adapter otra vez (como `probe` y `senderBalance`) y no es pereza: la pregunta "¿estamos en el camino por enlace?" la contesta (`caminoPorEnlace`, `../infrastructure/solana-wallet.ts:2239`), que es `private` de esa clase, y el gate y el disco viven ahí. ⛔ Opcional dejaría que BORRAR ESTA LÍNEA compilara con la suite verde, que es la razón que este archivo ya escribió dos veces (`:79` y `:213-220`); requerido lo vuelve un error de compilación en 6 sitios. El único test que ve esta línea es el que ejercita el objeto que ESTA FUNCIÓN DEVUELVE (`container.test.ts`). En el camino inyectado `pedir()` contesta `no-corresponde` y no ejecuta ninguna línea nueva (AC-8).
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
    // WKH-333/AC-20 — la 3ª dependencia es el gateway del veredicto server-side, y ESTA LÍNEA es
    // donde vive el riesgo: si acá no se inyecta nada, `ConnectWallet` sigue compilando y la suite
    // sigue verde (el use-case se construye a mano en su propio test), pero el backfill no corre en
    // NINGÚN camino real y toda persona ya verificada llega a `prepare` sin fila. Por eso tiene test
    // propio en `container.test.ts` (T-CABLE-1), que ejercita el `connectWallet` QUE ESTA LÍNEA
    // DEVUELVE. Es el MISMO HttpPopSigner sobre la MISMA wallet que ya usan el prepare y el refund.
    connectWallet: new ConnectWallet(wallet, kycStore, new HttpKycVerdictGateway(new HttpPopSigner(wallet, popProofs), sesiones), wallet), // WKH-359/AC-3 — el 4º argumento EN ESTA LÍNEA. Es el MISMO adapter otra vez (como `probe`, `senderBalance` y `pop` del bundle de arriba): la pregunta "¿estamos en el camino por enlace?" la contesta `caminoPorEnlace`, que es `private` de esa clase. ⛔ SIN ESTA LÍNEA la sesión de Didit se crea SIN ATAR en todo teléfono sin extensión, el gate `payoutAllowed !== true` de `persistKycVerdict` (en `app/api/kyc/decision/route.ts`) no escribe fila y `prepare` contesta 403 — y ⚠️ NO SE VE, porque una billetera que ya tiene fila cierra igual. Lo ve `container.test.ts` — `T-CABLE-2`, que prende `NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED` **Y** ejercita el `connectWallet` que ESTA LÍNEA devuelve **EN EL MISMO `it`**, que es la única forma de verlo: con la bandera apagada este argumento no hace nada y `pedir()` contesta `no-corresponde` en su primera línea (AC-8). ⚠️ ESTA FRASE FUE FALSA DESDE QUE SE ESCRIBIÓ HASTA EL CIERRE DE F4 (F4/F4-1), y no por poco: el `it` no existía —este archivo tenía la bandera y el `connectWallet` en `it` SEPARADOS—, así que **M4** (el argumento ⇒ `undefined as never`) daba **36 passed (36)** y **M5** (el argumento BORRADO, o sea literalmente «sin esta línea») daba `tsc --noEmit` **exit 0** con la suite COMPLETA en verde. Hoy mueren los dos, y también un tercero que un `toBeDefined()` dejaría pasar: el colaborador INERTE cuyo `pedir()` contesta siempre `no-corresponde`
    startKyc: new StartKyc(kyc, kycStore, kycPending, repo, clock),
    resumeKyc: new ResumeKyc(kyc, kycStore, kycPending, repo, clock),
    lockQuote: new LockQuote(quotes, repo, clock),
    confirmAndSend: new ConfirmAndSend(
      wallet,
      repo,
      clock,
      refund,
      solana, // HU-SOL-13: undefined con el flag off ⇒ el tapón DT-8 del use-case falla fail-closed
    ),
    trackRemittance: new TrackRemittance(payouts, repo, clock, refund),
    listHistory: new ListHistory(repo),
    abandonPendingKyc: new AbandonPendingKyc(kycPending),
    forgetKyc: new ForgetKyc(kycStore, kycPending, repo),
    // ── WKH-339 · las DOS capacidades de la ventana de lectura ────────────────────────────────────
    //
    // ⛔ ESTAS DOS ENTRADAS VAN ACÁ, DEBAJO DE `forgetKyc`, Y NO ES PROLIJIDAD. Este archivo es el que
    // más citas por número recibe del repo: `:47`, `:50`, `:114`, `:123`, `:127`, `:141`, `:169` y
    // `:196` los cita otro archivo, y todos están ARRIBA de esta línea. Una inserción aguas arriba los
    // rota en silencio. Antes de mover esto, medí quién lo cita.
    //
    // `estado` NO se deriva de un segundo almacén ni de una copia del TTL: pregunta al MISMO
    // `popProofs` que observa el gateway de seguimiento (`payouts`, `:127`), así que la comparación de
    // los 8 minutos sigue viviendo en UN solo lugar —`peek`— y no hay un segundo literal de 480 s.
    // ⚠️ `peek()` tiene un efecto secundario idempotente (borra la entrada vencida), y por eso esto se
    // consulta desde un efecto con temporizador, nunca desde un render.
    ventanaDeLectura: { estado: (a) => (popProofs.peek(a) ? "vigente" : "sin-prueba") },
    // 🔴 EL 2º ARGUMENTO —`popProofs`— ES EL MECANISMO ENTERO, Y SIN ÉL ESTO COMPILA. El recorder de
    // `HttpPopSigner` es OPCIONAL (`constructor`, `../infrastructure/auth/http-pop-signer.ts:14`), así
    // que `new HttpPopSigner(wallet)` pasa `tsc`, pide el challenge, abre el popup, la persona firma…
    // y NADIE se entera: la ventana queda en `"sin-prueba"` para siempre y el botón nunca desaparece.
    // Es el mutante más peligroso de esta HU y el ÚNICO test del repo que lo ve es T-339.5, en
    // `container.test.ts`, porque es el único que ejercita el objeto que ESTA LÍNEA devuelve.
    // Mismo `wallet` y mismo `popProofs` que los otros tres gestos: el almacén es compartido a
    // propósito, y que sea el MISMO es lo que `tsc` NO puede garantizar.
    renovarVentana: new HttpPopSigner(wallet, popProofs),
    solanaRefund, // HU-SOL-13: refund trustless del escrow
    recoverEscrowFunds: new RecoverEscrowFunds(repo, clock, solanaRefund),
    // WKH-327. El 2º argumento es el MISMO adapter: el guard de AC-7 le pregunta a la billetera VIVA
    // quién está conectado en el instante del click, en vez de recibirlo del llamador (que le pasaba
    // la misma variable que estaba validando — AR/BLQ-BAJO-1).
    //
    // 🔴 ESTA LÍNEA ES DONDE VIVE EL RIESGO AHORA, y por eso tiene test propio (AR/MNR-5).
    // `ConnectedWalletProbe` es una interfaz de UN método: `{ getConnectedAddress: () =>
    // wallet.getAddress() }` la satisface, compila, y devuelve el CACHE de `connect()` — o sea que
    // reintroduce el bloqueante entero desde acá. Se midió: con esa forma escrita, la suite daba
    // 1297/1297 y `tsc` exit 0, porque el test de AC-7 construye el use-case a mano y no toca el
    // cableado. La red que faltaba está en `container.test.ts` (el describe de AC-7), que ejercita el
    // `closeEscrowAccounts` QUE ESTA LÍNEA DEVUELVE contra el bridge real: con `getAddress()` puesto,
    // se pone rojo.
    closeEscrowAccounts: new CloseEscrowAccounts(solanaClose, wallet),
    solanaCloseableEscrows: wallet, // WKH-327/AC-8: el descubrimiento se lo pregunta a la cadena
    // WKH-349. El MISMO adapter otra vez, y va acá abajo por el mismo motivo que las dos entradas de
    // arriba: las 8 líneas citadas por número de este archivo están todas arriba.
    //
    // 🔴 ESTA LÍNEA ES EL MUTANTE MÁS PELIGROSO DE LA HU, y es el mismo perfil que documenta el
    // comentario de `renovarVentana`: el campo es OPCIONAL en `Container` (lo tiene que ser para que el
    // test-container pueda no pasarlo), así que borrar esta línea deja `tsc` en exit 0 y la suite
    // entera en verde —los tests de la pantalla inyectan su propio doble— mientras EN PRODUCCIÓN el
    // historial no le pregunta nada a la cadena y todas las filas vuelven a decir "no comprobamos".
    // El único test que lo ve es T-C1 en `container.test.ts`, porque ejercita el objeto que ESTA
    // LÍNEA devuelve en vez de uno armado a mano.
    solanaEscrowStates: wallet,
    // WKH-354/AC-2+AC-3. El MISMO adapter otra vez, y va acá abajo por el mismo motivo que sus dos
    // vecinos: las 8 líneas citadas por número de este archivo están TODAS arriba (`:47`, `:50`,
    // `:114`, `:123`, `:127`, `:141`, `:169`, `:196`).
    //
    // 🔴 ESTA LÍNEA ES DONDE VIVE EL RIESGO, y es el mismo perfil que `closeEscrowAccounts` documenta
    // en su comentario de acá arriba: `ConnectedWalletProbe` es una interfaz de UN método, así que
    // `{ getConnectedAddress: () => wallet.getAddress() }` la satisface, compila, y devuelve el CACHE
    // de `connect()` — o sea reintroduce el bug entero desde acá (CD-13). Lo que lo mata es
    // `container.test.ts` (T-354-CABLE-1), que ejercita el `connectedWallet` QUE ESTA LÍNEA DEVUELVE
    // contra el `solanaWalletBridge` real, con `connect()` ya corrido para que haya cache que exponer.
    connectedWallet: wallet, recorridoPorEnlace: new RecorridoPorEnlaceReal(), solanaRent: wallet, // HU-079: EN ESTA LÍNEA — el alquiler se le pregunta a la CADENA, y el adapter que ya habla con ella es el mismo `wallet` que sus tres vecinos. // WKH-358 — va acá abajo por el mismo motivo que sus tres vecinos: las 8 líneas que este archivo tiene citadas por número están TODAS arriba. Es un objeto SIN estado propio (lee y escribe el `localStorage` en cada llamada), así que no hay nada que memoizar ni que invalidar
  };
}

let singleton: Container | null = null;
/** Container compartido (browser). */
export function getContainer(): Container {
  if (!singleton) singleton = createContainer();
  return singleton;
}

// ── WKH-339 · la ventana de lectura del seguimiento, y el gesto que la vuelve a encender ───────────
//
// 🔴 POR QUÉ ESTOS TRES TIPOS VIVEN ACÁ Y NO EN `ports.ts`, Y NO ES UNA PREFERENCIA DE UBICACIÓN.
// `ports.ts` es donde vive `PopProofReader` (`PopProofReader`, `../application/ports.ts:150`), la
// interfaz de UN método cuyo mecanismo entero es NO TENER `prove`: el gateway de seguimiento corre
// dentro de un `setInterval` de 1500 ms y si pudiera pedir una firma abriría un popup por tick
// (600 s ÷ 1,5 s = 400 firmas por sesión de 10 min). Ese invariante lo sostienen tres docblocks de
// `ports.ts` que se leen juntos. Abrir ese archivo para meter un tipo de composición pone en juego esa
// vecindad por cero beneficio: nadie de `application/` consume lo de abajo. Lo consumen el composition
// root y la pantalla, que son exactamente las dos capas que se tocan acá.
// ⛔ NO los "acomodes" en `ports.ts` después: el diff de esta HU deja `ports.ts` byte-idéntico a
// propósito, y eso es lo que mantiene esos tres docblocks fuera de discusión.
//
// 🔴 LA DISTINCIÓN QUE ESTA HU AGREGA, Y QUE HAY QUE LEER JUNTO A ESOS DOCBLOCKS. Cuatro bloques del
// árbol dicen que en el seguimiento *"no se puede pedir una firma"*:
// `PopProofReader` (`../application/ports.ts:150`), el docblock de
// `../infrastructure/auth/pop-proof-store.ts:3-18`, el de
// `../infrastructure/auth/http-pop-signer.ts:31-48` y el de
// `../infrastructure/settlement/ledger-payout-status-gateway.ts:17-23`.
// **Los cuatro SIGUEN SIENDO CIERTOS, y son ciertos DEL GATEWAY**: es él el que corre en el
// `setInterval`, y su aritmética de 400 popups no cambió en un solo dígito. Lo que ahora convive con
// ellos es un CUARTO call-site **del cliente**: **el gateway no puede pedir una firma; la persona sí,
// y sólo sobre su propio gesto** — un toque explícito, y **≤ 3 por MONTAJE del seguimiento, CONTADOS**
// (`MAX_CHALLENGES_POR_MONTAJE`, `../presentation/flow.tsx:1461`), contra los 400 automáticos del ingenuo.
// ⛔ Esos cuatro docblocks NO se relajaron ni se les borró una palabra de la aritmética: los cuatro
// archivos son NO-TOUCH y tienen líneas citadas por número, así que agregarles esta distinción in situ
// las habría desplazado. Vive acá, y acá es donde hay que buscarla.
//
// 🔴 Y SON TRES TIPOS SEPARADOS, DE UN MÉTODO CADA UNO, PORQUE LA SEPARACIÓN ES EL MECANISMO. Las dos
// capacidades no se juntan en un solo puerto:
//  · `VentanaDeLectura` NO tiene `prove` ⇒ **el OBJETO que informa el estado no puede firmar**. Y NO
//    tiene `peek` ⇒ tampoco puede sacar la credencial del almacén y armarse un `fetch` a mano,
//    salteándose el throttle de 20 s del gateway.
//  · `PopSigner` (`PopSigner`, `../application/ports.ts:554`) NO tiene `estado` ni `peek` ⇒ **el OBJETO
//    que firma no puede consultar el estado**, así que no puede "optimizar" saltándose el popup de una
//    operación de dinero reusando una prueba guardada.
// ⛔ UN SOLO PUERTO CON LOS DOS MÉTODOS ES UNA VIOLACIÓN, aunque `PopProofReader` quede intacto.
//
// ⚠️ Y ACÁ HAY QUE SER EXACTO SOBRE HASTA DÓNDE LLEGA `tsc`, porque la versión anterior de este párrafo
// afirmaba de más. Decía que *"el camino de LECTURA no compila si intenta firmar"*, y **eso es falso**:
// MEDIDO, un `setInterval` en `TrackView` que llame a `renovar.prove(...)` **compila con `tsc` exit 0**,
// porque las dos capacidades le llegan al MISMO componente en la MISMA prop y nada le impide tomar la
// otra. Lo que `tsc` garantiza es lo de arriba —**una capacidad por OBJETO**—, no una propiedad del
// CAMINO. El riesgo del popup por tick **sí** está cubierto, pero **por tests** (con ese mutante caen 4
// de `flow.test.tsx`), y esa diferencia importa: un tipo no se puede borrar sin que el compilador grite,
// un test sí. ⇒ **la separación por objeto es estructural; que nadie firme desde el temporizador es una
// propiedad vigilada por la suite.**

/** En qué estado está la ventana de lectura del seguimiento PARA UNA ADDRESS.
 *
 *  DOS valores, y `"sin-prueba"` colapsa a propósito "venció" con "nunca hubo": el almacén no los
 *  distingue (`peek`, `../infrastructure/auth/pop-proof-store.ts:70` devuelve `null` para los dos) y el
 *  segundo caso es real, no teórico — se entra al seguimiento desde el historial tras una recarga y el
 *  almacén, que es en memoria, está vacío desde el primer milisegundo. ⛔ Por eso ninguna copy que
 *  cuelgue de `"sin-prueba"` puede decir "venció" ni usar un verbo en pasado sobre haber revisado:
 *  sería afirmar una historia que el sistema NO puede distinguir. */
export type EstadoVentanaLectura = "vigente" | "sin-prueba";

/** PREGUNTAR EL ESTADO de la ventana. Un método, y `prove` NO está acá (ver el bloque de arriba).
 *
 *  ⚠️ EFECTO SECUNDARIO CONOCIDO Y ACEPTADO: `peek()` BORRA la entrada vencida
 *  (`porAddress`, `../infrastructure/auth/pop-proof-store.ts:79`), así que esto es una consulta con un
 *  efecto idempotente (borrar lo que ya venció). ⛔ Por eso se invoca desde un efecto con temporizador,
 *  JAMÁS desde un render. */
export interface VentanaDeLectura {
  estado(address: string): EstadoVentanaLectura;
}

/** Las dos capacidades que el composition root expone, JUNTAS Y REQUERIDAS.
 *
 *  Requeridas (sin `?`) porque el cableado no puede quedar a la disciplina: así `tsc` obliga a
 *  `createContainer()` **y** a `buildTestContainer()` a proveerlas. Lo que `tsc` NO puede garantizar es
 *  que la ventana se arme sobre el MISMO almacén que observa el gateway — eso lo mata T-339.5, y es el
 *  único test del repo que lo ve. */
export interface VentanaYRenovacion {
  ventanaDeLectura: VentanaDeLectura;
  renovarVentana: PopSigner;
}

// ── WKH-358 · el recorrido por ENLACE PROFUNDO, re-exportado desde acá ─────────────────────────────
//
// 🔴 POR QUÉ ESTOS TRES TIPOS SE RE-EXPORTAN ACÁ Y NO VIVEN EN `ports.ts`, y es EXACTAMENTE el mismo
// argumento que el bloque de `VentanaDeLectura` de acá arriba, con las mismas dos mitades:
//   · nadie de `application/` los consume. Los consumen el composition root (que arma el objeto) y la
//     pantalla (que lo usa). Son las dos capas que se tocan en este archivo.
//   · y `ports.ts` queda **byte-idéntico a propósito**. Ahí vive (`AutorizacionDelPrincipal`,
//     `../application/ports.ts:1170`), cuyo `esperando` es de DOS valores y cuyo docblock dice *"NO
//     incluye `"conectar"`"* — una frase que sigue siendo VERDADERA después de esta HU, porque el
//     connect por enlace NO pasa por ese puerto: pasa antes, y lo resuelve la pantalla. Abrir ese
//     archivo para meter un tipo de composición pondría esa frase en discusión por cero beneficio. Y
//     recibe 20 citas ancladas, así que tocarlo además es caro.
// ⛔ NO los "acomodes" en `ports.ts` después.
//
// ⚠️ QUÉ NO SIGNIFICA ESTE RE-EXPORT: no significa que el depósito por enlace exista. La pata que falta
// es el PoP por enlace (WKH-359) y está declarada en el encabezado de
// `../infrastructure/solana/preparacion-por-enlace.ts`. Lo que esta HU entrega es la máquina de conexión
// y la creación de la cuenta de nonce.
export type {
  EleccionDeEnlace,
  EstadoDeLaCuentaDeNonce,
  PreparacionPorEnlace,
  ResultadoDePreparacion,
  VueltaDeEnlace,
} from "../infrastructure/solana/preparacion-por-enlace";
