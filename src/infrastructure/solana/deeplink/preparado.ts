// El registro de lo que hubo que recordar del intento en el que se pidió la firma (WKH-356).
//
// 🔴 QUÉ PROBLEMA RESUELVE. Firmar por enlace profundo parte `authorizePrincipal` en dos o tres
// invocaciones separadas por un salto a otra app: el proceso de JavaScript que armó la transacción
// DEJA DE EXISTIR antes de que vuelva la firma. Todo lo que la vuelta necesite saber del intento
// anterior tiene que estar en el disco, porque no queda nada más.
//
// ⛔ LO QUE ACÁ NO SE GUARDA NUNCA: ninguna clave privada. Ni la x25519 del canal (esa vive en el
// `Viaje` de `sesion.ts`, que es de otro ciclo de vida), ni nada derivado de la billetera. Lo que hay
// acá son identificadores y bytes públicos.
//
// ⚠️ Y LO QUE ESTO NO ES: no es la fuente de la verdad del destino del depósito. Los
// `beneficiary`/`authority` que se FIRMAN salen siempre de un `prepare()` server-side atestado en
// ESTE proceso; lo de acá sirve sólo para COMPARAR contra ellos. Esa asimetría es a propósito: un
// disco adulterado puede producir un falso NEGATIVO (se corta un envío legítimo) y jamás un falso
// positivo (firmar contra un destino que el servidor no atestó).
//
// DT-7 — este módulo NO lee `window`, `Date`, `fetch` ni `process.env`. El almacén y el instante
// entran por parámetro, igual que en `sesion.ts`.
import type { Almacen } from "./sesion";
import { MAX_EDAD_MS } from "./sesion";

/**
 * CLAVE PROPIA, distinta de la del `Viaje` (`"chaski.billetera.viaje.v1"`).
 *
 * ⛔ NO reusar la del viaje. Son dos ciclos de vida: el viaje se puede terminar y volver a empezar
 * —cada corte lo limpia y reintentar es empezar de cero— mientras que el `Preparado` describe el
 * intento en el que se pidió la PRIMERA firma y es contra ése que hay que comparar. Compartir clave
 * haría que limpiar uno se llevara el otro, que es exactamente el bug que hay que evitar.
 */
const CLAVE = "chaski.billetera.preparado.v1";

/** Lo que hay que recordar del intento en el que se pidió la firma. ⛔ NINGUNA clave privada. */
export interface Preparado {
  remittanceId: string;
  sender: string;
  beneficiary: string;
  authority: string;
  /**
   * base64 de `tx.serializeMessage()` de la tx que se mandó a firmar. Es contra ESTO que se compara
   * lo que devuelve la billetera.
   *
   * ⛔ NUNCA contra una tx RECONSTRUIDA. Una reconstrucción no coincidiría jamás: la `reference` es
   * un `Keypair.generate()` nuevo en cada llamada, el `deadline` sale del reloj y el blockhash
   * cambia. Un chequeo que siempre falla es un chequeo que alguien termina borrando.
   */
  mensajeBase64: string;
  /**
   * La `reference` de ESA tx, base58.
   *
   * Va acá porque el envelope que sale de la reanudación tiene que llevar la reference que está
   * DENTRO de la transacción firmada, no la de la tx que esa invocación armó y descartó. Sin este
   * campo, `SolanaPrincipalAuthorization.reference` declararía una reference que no es la de su
   * propia transacción y la traza del depósito quedaría rota.
   */
  referenceBase58: string;
  /** ms epoch del momento en que se guardó. */
  desde: number;
}

/** El resultado de leer el disco. Dos valores, no tres: acá "vencido" y "no hay" se tratan igual. */
export type LecturaDelPreparado = { tipo: "hay"; preparado: Preparado } | { tipo: "no-hay" };

/**
 * ⚠️ ESTA SÍ PUEDE TIRAR, Y ES DELIBERADO — igual que `guardarViaje`. `localStorage.setItem` lanza
 * con la cuota llena y en el modo privado de algunos navegadores. Acá se llama ANTES del salto: si
 * el registro no se pudo guardar, saltar sería mandar a la persona a firmar algo contra lo que este
 * dispositivo no va a poder comparar nada al volver, y la comparación de destino (AC-5) es lo único
 * que hay del lado del cliente contra una sustitución de depositante. Que el que llama se entere y
 * NO salte es el comportamiento correcto.
 */
export function guardarPreparado(a: Almacen, p: Preparado): void {
  a.escribir(CLAVE, JSON.stringify(p));
}

/**
 * Borra el registro. NO tira: es limpieza, igual que `terminarViaje`. Un almacén que no deja borrar
 * deja basura, y decírselo al que llama no le da ninguna decisión mejor que seguir.
 */
export function terminarPreparado(a: Almacen): void {
  try {
    a.borrar(CLAVE);
  } catch {
    // Ver arriba. Tirar acá rompería una salida entera por una limpieza.
  }
}

/** Un campo que después se compara o se decodifica: tiene que ser un string con algo adentro. */
function esTextoUtil(x: unknown): x is string {
  return typeof x === "string" && x.trim() !== "";
}

/**
 * QUÉ SE VALIDA DEL DISCO Y POR QUÉ ESTA LISTA.
 *
 * Todo lo que sale de acá viene de un `JSON.parse` sobre una cadena que escribe cualquiera que pueda
 * ejecutar en este origen (o editar el disco a mano): el `as Preparado` no verifica NADA. Se valida
 * **todo campo que se use como algo más que un dato opaco**, y acá TODOS lo son:
 *   · los seis strings se COMPARAN (`beneficiary`/`authority` contra el prepare de la invocación en
 *     curso, `sender` contra la dirección del viaje, `mensajeBase64` contra los bytes que devolvió la
 *     billetera) o se COPIAN AL ENVELOPE que va al settle (`referenceBase58`). Un `undefined` que
 *     llegue a una comparación la vuelve `false` en silencio — o sea, un corte inexplicable — y uno
 *     que llegue al envelope viaja al servidor como la cadena `"undefined"`.
 *   · un string VACÍO es peor que ausente: `"" === ""` da `true`, así que dos campos vacíos
 *     "coinciden" y el guard de destino aplaude. Por eso `esTextoUtil` y no `typeof === "string"`.
 *   · `desde` se resta contra `ahora`, así que tiene que ser un número FINITO. `Number.isFinite` y no
 *     `typeof === "number"`, porque `JSON.parse` produce `Infinity` con `1e999` y su `typeof` es
 *     `"number"`.
 *     ⚠️ HONESTIDAD SOBRE ESTA LÍNEA, medida por la batería de mutación de WKH-356: degradarla a
 *     `typeof === "number"` **NO pone rojo ningún test**, porque los dos únicos valores que la
 *     distinguen (`±Infinity`) los cortan igual los dos guards de abajo —el del futuro y el de la
 *     ventana— y `NaN` no es JSON válido. Se queda por corrección y porque el día que
 *     `LecturaDelPreparado` gane un tercer valor pasa a ser observable (es exactamente lo que ocurre
 *     en `leerViaje`, que sí distingue «vencido» de «no-hay»), pero **no está bajo candado**. El
 *     detalle input por input está en el `it` correspondiente de `preparado.test.ts`.
 *
 * Y ante cualquier basura se LIMPIA el disco antes de contestar. La lección es medida en 061: un
 * campo inválido que hace tirar y NO limpia repite la excepción en cada carga de la página.
 */
export function leerPreparado(a: Almacen, ahora: number): LecturaDelPreparado {
  let crudo: string | null;
  try {
    crudo = a.leer(CLAVE);
  } catch {
    // Un almacén que ni siquiera deja LEER (cookies bloqueadas, modo privado) no tiene un registro
    // vencido: es que acá no hay nada que este dispositivo pueda recordar.
    return { tipo: "no-hay" };
  }
  if (!crudo) return { tipo: "no-hay" };
  let p: Preparado;
  try {
    p = JSON.parse(crudo) as Preparado;
  } catch {
    terminarPreparado(a);
    return { tipo: "no-hay" };
  }
  if (
    !esTextoUtil(p?.remittanceId) ||
    !esTextoUtil(p?.sender) ||
    !esTextoUtil(p?.beneficiary) ||
    !esTextoUtil(p?.authority) ||
    !esTextoUtil(p?.mensajeBase64) ||
    !esTextoUtil(p?.referenceBase58) ||
    !Number.isFinite(p?.desde)
  ) {
    terminarPreparado(a);
    return { tipo: "no-hay" };
  }
  // 🔴 UN REGISTRO QUE EMPEZÓ EN EL FUTURO ES BASURA, NO UNO JOVEN. `ahora - desde` es negativo, así
  // que nunca supera `MAX_EDAD_MS`: un `desde` adelantado X días lo mantiene vivo X días más veinte
  // minutos. Es el mismo agujero que 061 midió en `leerViaje` (`desde` +10 días ⇒ «hay» diez días
  // después) y se cierra igual. Lo que esto rompe, dicho: un reloj corregido HACIA ATRÁS en medio
  // del viaje mata el registro y hay que empezar de nuevo. Se prefiere eso a una ventana cuya
  // duración la elige quien haya movido el reloj.
  if (p.desde > ahora) {
    terminarPreparado(a);
    return { tipo: "no-hay" };
  }
  // La MISMA ventana que el viaje, importada y no copiada: los dos describen el mismo recorrido, y
  // dos números con el mismo criterio escritos en dos lugares es exactamente cómo se desincronizan.
  // Un `Preparado` que sobreviviera a su viaje sólo podría producir comparaciones contra un intento
  // que ya nadie puede completar.
  if (ahora - p.desde > MAX_EDAD_MS) {
    terminarPreparado(a);
    return { tipo: "no-hay" };
  }
  return { tipo: "hay", preparado: p };
}
