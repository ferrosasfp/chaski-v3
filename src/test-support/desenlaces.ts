// Test support — los dos narrowings de las uniones de WKH-356.
//
// 🔴 POR QUÉ ARCHIVO PROPIO Y NO `fakes.ts`, medido y no por gusto:
//   1. `fakes.ts:835` (`FAKE_SOLANA_SIGNATURE`) lo citan 5 archivos POR NÚMERO y el propio archivo lo
//      declara en su `fakes.ts:49`: "dos líneas de más los rotan en silencio". (Esa cita acá iba SIN
//      el nombre del archivo, o sea que se leía como una línea DE ESTE archivo.) Meter dos funciones ahí es
//      exactamente eso.
//   2. `solana-wallet.test.ts` y `solana-deposit-beneficiary.test.ts` stubean la cadena con cuidado, y
//      arrastrarles el módulo `fakes` entero (con `bs58` y una docena de dobles) para leer un campo es
//      superficie que nadie pidió. ⚠️ ACÁ DECÍA que esos dos archivos "hoy NO importan nada de
//      `test-support/`", y era FALSO DESDE EL COMMIT QUE LO ESCRIBIÓ (MNR-CR-5): los dos importan de
//      `test-support/desenlaces` —de este archivo— justamente por el cambio de esta HU. Lo que sigue
//      siendo cierto, y es la razón de fondo, es que no importan `fakes`.
//
// 🔴 POR QUÉ LOS DOS TIRAN Y NO DEVUELVEN `undefined` NI UN DEFAULT. Un helper que degrada convierte
// "el código suspendió donde este test no lo esperaba" en un `undefined` que viaja por media suite y
// revienta lejos, en un `expect` que habla de otra cosa. Tirando acá, el test se pone rojo en el punto
// exacto y el mensaje dice qué se esperaba y qué vino. Es la misma disciplina fail-loud que el resto
// del money-path: NO adivinar cuando no se sabe.
//
// ⚠️ LO QUE ESTOS HELPERS NO HACEN: no verifican NADA del contenido. `esperarListo` no mira la remesa
// y `esperarAutorizacionLista` no mira la `tx` ni el envelope. Sólo descartan la variante de
// suspensión. Lo que se afirme sobre los campos lo tiene que assertar el test.
import type { AutorizacionDelPrincipal, SolanaPrincipalAuthorization } from "../application/ports";
import type { ResultadoDeEnvio } from "../application/use-cases/confirm-and-send";
import type { Remittance } from "../domain/remittance";

/**
 * El retorno de `ConfirmAndSend.execute()` cuando el test da por hecho que no hubo suspensión.
 * TIRA si el use-case suspendió: eso es un cambio de comportamiento, no un dato faltante.
 */
export function esperarListo(res: ResultadoDeEnvio): Remittance {
  if (res.estado !== "listo") {
    throw new Error(
      `esperarListo: execute() suspendió (estado="${res.estado}", esperando="${res.esperando}", irA="${res.irA}") ` +
        "y este test da por hecho que no. Si la suspensión es lo correcto, el test tiene que assertarla, no ignorarla.",
    );
  }
  return res.remesa;
}

/**
 * Ídem para `WalletPort.authorizePrincipal`. Devuelve el `{ tx, solana? }` de siempre, sin el
 * envoltorio: los datos de expectativa de los tests que ya existían no cambian ni un carácter.
 */
export function esperarAutorizacionLista(res: AutorizacionDelPrincipal): {
  tx: string;
  solana?: SolanaPrincipalAuthorization;
} {
  if (res.estado !== "listo") {
    throw new Error(
      `esperarAutorizacionLista: authorizePrincipal suspendió (estado="${res.estado}", esperando="${res.esperando}", irA="${res.irA}") ` +
        "y este test da por hecho que no. Si la suspensión es lo correcto, el test tiene que assertarla, no ignorarla.",
    );
  }
  return { tx: res.tx, solana: res.solana };
}
