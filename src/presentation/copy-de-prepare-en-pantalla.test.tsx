// @vitest-environment jsdom
//
// Tests — QUÉ LEE LA PERSONA cuando el `prepare` del payout corta, medido EN LA PANTALLA.
//
// 🔴 POR QUÉ ESTE ARCHIVO EXISTE, Y ES LA LECCIÓN DE LA ITERACIÓN 1 DEL FIX-PACK (AR/BLQ-ALTO-1).
// El arreglo anterior le dio a `payout_authority_unavailable` una rama propia en `humanError()` y lo
// midió llamando a `humanError()`. La función devolvía el copy nuevo, así que el test daba verde —
// pero `TrackView` **nunca llamaba a `humanError` con ese motivo**: su cadena de ternarios sólo le
// pasaba el `failureReason` en la rama de `prepareUnreachable`, y todo lo demás caía en un
// `humanError("payout_failed")` HARDCODEADO. O sea: la función arreglada, la pantalla igual que antes.
//
// ⇒ Acá no se llama a ninguna función de copy: se **renderiza `TrackView`** con el snapshot que dejó
// el use-case REAL, y se afirma sobre el texto que queda en el DOM. Es el camino que recorre la
// persona, no la unidad que se tocó.
//
// LOS DOS MUTANTES QUE ESTOS TESTS MATAN, y son opuestos entre sí:
//   1. volver el `else` de `flow.tsx` a `humanError("payout_failed")` ⇒ los enums del `prepare` vuelven
//      a mandar a sacar USDC de un escrow donde con CERTEZA no hay nada (T-PANT-1 y T-PANT-2 rojos).
//   2. hacer que el copy que promete el escrow no salga NUNCA ⇒ una remesa cuyo depósito puede estar
//      en el vault se quedaría sin la única frase que la manda a recuperarlo (T-PANT-3 rojo).
//
// ⚠️ LO QUE ESTE ARCHIVO **NO** MIDE, declarado: el salto `HTTP status ⇒ enum` que hace el `switch` de
// `app/api/payout/prepare/route.ts` (fuera del Scope IN de este fix-pack: ese archivo queda con CERO
// diff). Acá se entra por el enum ya emitido. El eslabón del medio lo cubre
// `app/api/payout/prepare/route.test.ts`. Lo que sí se deriva del archivo de la route, sin escribirlo
// a mano, es **el conjunto de enums** (T-PANT-2): esa lista es la que ya envejeció sola dos veces.
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Money } from "../domain/money";
import { type KycVerification, type Quote, Remittance, type RemittanceState } from "../domain/remittance";
import { ConfirmAndSend } from "../application/use-cases/confirm-and-send";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeRefundGateway,
  FakeSolanaEscrowDepositProbe, FakeSolanaRentReader, // HU-079: EN ESTA LÍNEA, no en una nueva — este archivo recibe (o alimenta) citas ancladas por número, y una línea de más las corre a todas.
  FakeSolanaPayoutPrepareGateway,
  FakeSolanaSenderSolBalanceProbe,
  FakePruebaDePosesionPorEnlace,
  FakeSolanaSettlementGateway,
  FakeSolanaWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../test-support/fakes";
import { esperarListo } from "../test-support/desenlaces";
import { humanError } from "./flow-vm";
import { TrackView } from "./flow";

const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  realVerified: true,
  verifiedAt: null,
  riskLevel: "low",
  provenance: "didit",
  identity: null,
};
const quote: Quote = {
  quoteId: "q1",
  send: Money.of(400, "USDC"),
  receive: Money.of(1480, "PEN"),
  feeUsd: Money.of(0.5, "USDC"),
  rate: 3.7,
  etaMinutes: 30,
  expiresAt: QUOTE_EXPIRES,
  provenance: "fake",
};

/**
 * LA PROMESA DEL ESCROW, DERIVADA Y NO COPIADA. Es el catch-all de `code.includes("payout")`, o sea
 * el ÚNICO `return` de `humanError` que le dice a la persona que vaya a sacar USDC del escrow
 * (medido sobre el cuerpo de la función: un solo literal de retorno contiene la palabra "escrow").
 * Se obtiene llamando a la función con un código que no tiene rama propia, así que si alguien reescribe
 * la frase, este archivo la sigue sin editarse — y si alguien BORRA el catch-all, el control positivo
 * de `:PROMESA` de más abajo se pone rojo en vez de dejar un barrido comparando contra un fantasma.
 */
const PROMESA_DEL_ESCROW = humanError("payout_un_codigo_que_nadie_mapeó");

/**
 * Corre el money-path REAL hasta el `prepare` del payout, con el enum que el gateway HTTP habría
 * propagado 1:1 desde la route, y devuelve el snapshot persistido. Es el mismo objeto que la pantalla
 * lee después de una recarga.
 *
 * ⛔ El `prepare` corre ANTES de `authorizePrincipal`, así que en este camino la billetera NUNCA firma
 * una transacción: el snapshot que sale de acá tiene `principalTx === null`. Eso no es una suposición
 * del test — es lo que `T-PANT-0` mide antes de que corra ningún otro `it`.
 */
async function runPrepareFailure(enumDeLaRoute: string): Promise<RemittanceState> {
  const repo = new InMemoryRepo();
  const r = Remittance.create("rem-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  await repo.save(r);

  const out = esperarListo(
    await new ConfirmAndSend(new FakeSolanaWallet(), repo, new FixedClock(), new FakeRefundGateway("no-receipt"), {
      prepare: new FakeSolanaPayoutPrepareGateway({ ok: false, reason: enumDeLaRoute }),
      gateway: new FakeSolanaSettlementGateway(),
      probe: new FakeSolanaEscrowDepositProbe("not_deposited"),
      senderBalance: new FakeSolanaSenderSolBalanceProbe(),
      pop: new FakePruebaDePosesionPorEnlace(), rent: new FakeSolanaRentReader(4_002_000, "unknown"), /* HU-079: modo `unknown` a propósito — deja el umbral en el RESPALDO (8.874.560), que es el valor que estos tests ya asumían. Un doble que contestara la lectura de hoy bajaría el umbral a 6.503.880 y cambiaría el resultado de tests que no van sobre esto. */
    }).execute({ remittanceId: "rem-1" , hrefDeLaVuelta: "https://chaski.test/enviar" }),
  );
  return out.snapshot;
}

/** El MISMO fallo, pero sobre una remesa cuyo depósito SÍ pudo entrar al vault. Es el control
 *  positivo del barrido: acá la promesa del escrow es la frase correcta y tiene que aparecer. */
function conDepositoEnVuelo(reason: string): RemittanceState {
  const r = Remittance.create("rem-2", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPrincipalIn("sig-del-deposito", T0); // la cadena vio entrar los USDC
  r.markPayoutFailed(reason, T0);
  return r.snapshot;
}

/** La pantalla de seguimiento, y su texto plano. Sin wallet conectada: lo que se mide es el TEXTO. */
function textoEnPantalla(snapshot: RemittanceState): string {
  render(<TrackView rem={snapshot} sender={null} onRecovered={() => {}} />);
  return document.body.textContent ?? "";
}

/**
 * LOS ENUMS, DERIVADOS DEL ARCHIVO QUE LOS EMITE. No es una lista a mano: la lista a mano es
 * exactamente lo que envejeció dos veces (WKH-333 le dio rama propia a `payout_not_authorized` y
 * tampoco llegaba a la pantalla; el fix-pack la repitió con `payout_authority_unavailable`).
 *
 * ⚠️ Lee `app/api/payout/prepare/route.ts` SIN importarlo: importar la route arrastraría todo su
 * contenedor (Supabase, HMAC, ed25519) a un test de pantalla. Se leen los literales de los
 * `NextResponse.json({ error: … })`, incluido el ternario de la respuesta del agente.
 */
function enumsDeLaFuente(src: string): string[] {
  const vistos = new Set<string>();
  for (const m of src.matchAll(/error:\s*([^}]*)\}/g)) {
    for (const s of (m[1] as string).matchAll(/"([a-z][a-z0-9_]*)"/g)) {
      const e = s[1] as string;
      if (e.startsWith("prepare_") || e.startsWith("payout_")) vistos.add(e);
    }
  }
  return [...vistos].sort();
}

function enumsQueEmiteLaRoute(): string[] {
  return enumsDeLaFuente(readFileSync(path.resolve(process.cwd(), "app/api/payout/prepare/route.ts"), "utf8"));
}

const ENUMS = enumsQueEmiteLaRoute();

// ── EL PIN, Y POR QUÉ NO ES UN PISO (re-AR it3 · MNR-2) ───────────────────────────────────────
//
// 🔴 QUÉ DEFECTO CIERRA, CON EL MUTANTE QUE LO ENCONTRÓ. Acá había `toBeGreaterThanOrEqual(13)`
// contra **14** enums medidos, y el AR construyó el input que lo derrota: en la route, cambiar
// `{ error: "prepare_rate_limited" }` por `{ error: UNA_CONSTANTE }` —mover un literal a una
// constante, el refactor más común que existe—. El regex de arriba lee LITERALES, así que el enum
// desaparece del conjunto, el barrido pasa a recorrer 13, y `13 >= 13` deja el archivo en **4 passed,
// exit 0**. O sea: un enum se sale del barrido y NADA se pone rojo.
//
// ⛔ Y SUBIR EL PISO A 14 NO ARREGLA NADA A FUTURO: cualquier piso deja que el conjunto se DESGASTE
// hasta él. El problema no es el valor, es la forma: un `>=` sólo puede ver que el barrido se vacía,
// nunca que pierde de a uno. Ésta es exactamente la clase de candado que se pudre solo — el mutante
// que lo derrotaba era CIERTO el día que se escribió.
//
// ⇒ SE PINNEA EL CONJUNTO EXACTO, no un número. Cualquier diferencia —para arriba o para abajo—
// pone rojo y obliga a que alguien lo mire:
//   · un enum que SALE del barrido (literal → constante, un `error:` que se mueve a un helper, un
//     rename) ⇒ rojo, y el mensaje lo nombra;
//   · un enum NUEVO y legítimo ⇒ rojo también, a propósito. Agregarlo acá es barato y es el momento
//     en que alguien decide si su copy en pantalla es el correcto. Un enum nuevo entrando en silencio
//     es justo lo que ya pasó dos veces en esta HU.
//
// ⚠️ ESTA LISTA **NO** ALIMENTA EL BARRIDO. `T-PANT-2` sigue recorriendo `ENUMS`, que se DERIVA de la
// route; el pin sólo compara. Si la lista alimentara el barrido, sería un guard que se compara consigo
// mismo y el mutante de arriba lo pasaría igual.
//
// ⚠️ LO QUE EL PIN NO HACE: no entiende la route. No sigue una constante, no resuelve un `import`, no
// mira el `switch` de `HTTP status ⇒ enum`. Sólo afirma «el conjunto que el regex deriva HOY es
// exactamente éste». Hacerlo seguir la indirección se descartó a propósito: las formas de indirección
// son ilimitadas (constante, template, import, computado) y cada una que el escáner no entienda
// volvería a perder un enum EN SILENCIO. El pin no puede perder ninguno, porque no razona.
const ENUMS_PINNEADOS: readonly string[] = [
  "payout_authority_unavailable",
  "payout_not_authorized",
  "payout_pop_unavailable",
  "payout_pop_unverified",
  "prepare_invalid_request",
  "prepare_kyc_verdict_missing",
  "prepare_kyc_verdict_unavailable",
  "prepare_no_deposit_address",
  "prepare_not_configured",
  "prepare_rate_limit_unavailable",
  "prepare_rate_limited",
  "prepare_solana_authority_unavailable",
  "prepare_unavailable",
  "prepare_upstream_error",
];

describe("del enum del `prepare` a la frase que la persona LEE en la pantalla de seguimiento", () => {
  afterEach(() => cleanup());

  // ── T-PANT-0 — LA PRECONDICIÓN DEL ARCHIVO ENTERO ────────────────────────────────────────────
  //
  // Sin esto, los dos `it` de abajo podrían pasar por la razón equivocada: si el use-case dejara el
  // snapshot con un depósito en vuelo, la ausencia de la promesa del escrow sería un BUG y este
  // archivo la estaría bendiciendo. Acá se mide que el corte del `prepare` deja `principalTx === null`,
  // que es lo que vuelve CIERTA la frase "no salió ningún USDC de tu wallet".
  it("T-PANT-0: un corte en el `prepare` deja la remesa SIN depósito (`principalTx === null`)", async () => {
    const s = await runPrepareFailure("payout_authority_unavailable");
    expect(s.status).toBe("payout_failed");
    expect(s.principalTx, "el `prepare` corta antes de `authorizePrincipal`: nadie firmó nada").toBeNull();
    expect(s.failureReason).toBe("payout_authority_unavailable");
    // 🧪 CONTROL POSITIVO EN LA MISMA CORRIDA: el otro constructor SÍ produce un depósito, así que la
    // aserción de arriba puede distinguir los dos casos y no es un `toBeNull()` que siempre pasa.
    expect(conDepositoEnVuelo("payout_authority_unavailable").principalTx).not.toBeNull();
  });

  // ── T-PANT-1 — AR/BLQ-ALTO-1: el copy de `payout_authority_unavailable` LLEGA a la pantalla ────
  //
  // La cadena entera, y ejecutada salvo el eslabón declarado arriba: el agente de KYC contesta 401 ⇒
  // `kyc_reauth_failed`/502 ⇒ el `default` del `switch` de la route ⇒ `payout_authority_unavailable` ⇒
  // el gateway lo propaga 1:1 ⇒ `failAndRefund(..., "not_deposited")` ⇒ ESTA pantalla.
  it("T-PANT-1: `payout_authority_unavailable` muestra su copy propio, no la promesa del escrow", async () => {
    const texto = textoEnPantalla(await runPrepareFailure("payout_authority_unavailable"));
    expect(texto).toContain("No llegamos a una respuesta de quien autoriza los pagos");
    expect(
      texto,
      "la pantalla manda a sacar del escrow unos USDC que nunca salieron de la billetera",
    ).not.toContain(PROMESA_DEL_ESCROW);
    // Y el titular tampoco puede afirmar que los USDC quedaron en el escrow.
    expect(screen.queryByText(/Tus USDC quedaron en el escrow/)).toBeNull();
  });

  // ── T-PANT-2 — AR/BLQ-MED-1: EL CANDADO, sobre el conjunto y no sobre un enum ─────────────────
  //
  // 🔴 POR QUÉ UN BARRIDO Y NO UN `it` POR ENUM. Un arreglo por enum ya falló DOS veces con el mismo
  // patrón. Lo que este `it` clava no es "estos N enums están bien": es que **ningún** enum que la
  // route pueda emitir alcanza la promesa del escrow desde un estado en el que sabemos que no hubo
  // depósito. Si mañana aparece un enum nuevo en la route, entra solo a este barrido — y si el
  // mecanismo de la pantalla se debilita, se pone rojo sin que nadie agregue un test.
  it("T-PANT-2: NINGÚN enum del `prepare` promete el escrow cuando no hubo depósito", async () => {
    // ⛔ NO ES UN PISO (re-AR it3 · MNR-2): es el conjunto EXACTO. Un piso deja que el barrido pierda
    // enums de a uno y siga verde — el mutante está escrito arriba, en el docblock de `ENUMS_PINNEADOS`.
    expect(
      ENUMS,
      "el conjunto que el regex deriva de la route dejó de ser el pinneado. Si un enum FALTA, se salió " +
        "del barrido (¿un literal que pasó a constante?) y hay que hacerlo volver, NO borrarlo del pin. " +
        "Si SOBRA, es un enum nuevo: sumalo al pin DESPUÉS de mirar qué lee la persona en pantalla.",
    ).toEqual([...ENUMS_PINNEADOS]);
    const rotos: string[] = [];
    for (const e of ENUMS) {
      const texto = textoEnPantalla(await runPrepareFailure(e));
      if (texto.includes(PROMESA_DEL_ESCROW)) rotos.push(e);
      cleanup();
    }
    expect(rotos, "estos enums mandan a buscar USDC a un escrow vacío").toEqual([]);
  });

  // ── T-PANT-4 — EL CONTROL DEL PIN, con fuente SINTÉTICA (re-AR it3 · MNR-2) ───────────────────
  //
  // El pin de `T-PANT-2` sólo sirve si el escáner que lo alimenta puede EFECTIVAMENTE perder un enum.
  // Acá se ejercita el mutante del AR sin tocar `prepare/route.ts` (que queda con CERO diff): la misma
  // función de derivación, contra tres fuentes de mentira. Las dos direcciones en la misma corrida.
  it("T-PANT-4: el escáner PIERDE un enum si el literal se va a una constante (y por eso el pin es exacto)", () => {
    const conLiteral = `return NextResponse.json({ error: "prepare_rate_limited" }, { status: 429 });`;
    const conConstante = `const E = "prepare_rate_limited";\nreturn NextResponse.json({ error: E }, { status: 429 });`;
    const conUnoNuevo = `${conLiteral}\nreturn NextResponse.json({ error: "prepare_flamante" }, { status: 500 });`;

    // CONTROL POSITIVO: con el literal, el escáner lo ve.
    expect(enumsDeLaFuente(conLiteral)).toEqual(["prepare_rate_limited"]);
    // EL MUTANTE M-B DEL AR: el enum se sale del barrido en silencio. Un `>=` no puede verlo.
    expect(
      enumsDeLaFuente(conConstante),
      "si esto deja de estar vacío, el escáner aprendió a seguir constantes y el pin puede relajarse",
    ).toEqual([]);
    // Y LA DIRECCIÓN CONTRARIA: un enum nuevo entra solo al conjunto, así que el pin también lo caza.
    expect(enumsDeLaFuente(conUnoNuevo)).toEqual(["prepare_flamante", "prepare_rate_limited"]);

    // ⇒ las dos derivas mueven el conjunto, y `toEqual` las ve a las dos. Un piso sólo veía la 1ª
    //   cuando llegaba a cero.
    expect(ENUMS_PINNEADOS).toHaveLength(14);
    expect(new Set(ENUMS_PINNEADOS).size, "el pin no puede traer duplicados").toBe(14);
  });

  // ── T-PANT-3 — EL REVÉS, que es el mutante peligroso ──────────────────────────────────────────
  //
  // Callar la promesa del escrow siempre pondría verde a T-PANT-2 sin arreglar nada y ROMPERÍA lo
  // único que le devuelve sus USDC a quien sí depositó. Este `it` es el control positivo del de
  // arriba: mismo enum, mismo render, la única diferencia es que la cadena vio entrar el depósito.
  it("T-PANT-3: con el depósito en vuelo, la MISMA falla sí muestra la promesa del escrow", () => {
    const texto = textoEnPantalla(conDepositoEnVuelo("payout_authority_unavailable"));
    expect(
      texto,
      "se le calló a alguien que puede tener USDC en el vault la única frase que lo manda a sacarlos",
    ).toContain(PROMESA_DEL_ESCROW);
  });
});
