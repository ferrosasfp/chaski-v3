"use client";

// WKH-374 · W1.2 — EL ANFITRIÓN DEL RECORRIDO NUEVO
//
// Un solo punto de montaje, una máquina de estado sobre `./pasos.ts`, y el único sitio del árbol
// nuevo que habla con el `Container`. Las cinco pantallas reciben todo por props.
//
// 🔴 ACÁ NO SE CAMBIA DE PANTALLA NAVEGANDO. Se cambia por ESTADO. La razón no es de estilo: la
// vuelta del verificador está clavada a la raíz del sitio en producción, así que con rutas del App
// Router esa vuelta aterrizaría en la pantalla de entrada, que es exactamente lo que el invariante
// prohíbe con la palabra NUNCA. ⛔ Nada de hooks de router de cliente, nada de enlaces blandos, y
// ⛔ ninguna ruta nueva.
//
// ⛔ Y ESTE ARCHIVO NO TOCA `localStorage`, `sessionStorage`, `document.cookie` NI LA BARRA DE
// DIRECCIONES. La única lectura de la URL es la del `href` en el montaje, que se le PASA a la
// función pura de `./salto.ts`: leer no es escribir, y escribir no pasa.
// ⚠️ De eso, `T-374-W1-12` mide las OCHO formas de su tabla y ⛔ NADA MÁS. Acá decía «lo mide» a
// secas y era falso para media docena de variantes de la salida (CR/BLQ-ALTO-1); qué queda afuera
// está enumerado en ese `it` y ⛔ acá no se afirma más que eso.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Container } from "../../composition/container";
import { getContainer } from "../../composition/container";
import { MIN_SEND_USD, OFFERED_PAYOUT_METHODS, cciDigits, isValidCci } from "../../domain/remittance";
import type { Quote, RemittanceState } from "../../domain/remittance";
import { humanError } from "../flow-vm";
import { URL_INSTALAR_PHANTOM } from "../salida-al-navegador-de-la-billetera";
import { urlDeVueltaDeKyc } from "../splash-puerta";
import { Stepper } from "../ui";
import {
  MarcoDelRecorrido,
  PantallaEntrar,
  PantallaEnvio,
  PantallaFirmar,
  PantallaIdentidad,
  PantallaSeguimiento,
} from "./pantallas";
import {
  PASO_DE_ENTRADA,
  type PasoDelRecorrido,
  anterior,
  etiquetaDe,
  etiquetasDe,
  indiceEn,
  itinerario,
  siguiente,
} from "./pasos";
import { anuncioDe, aterrizajeDelAnfitrion, volvioPorEnlace, vueltaDeUnSalto } from "./salto";

/**
 * ⚠️ `pasoDeArranque` ES UNA COSTURA DE TEST, Y SE DECLARA COMO TAL. Mismo molde que `container`: el
 * DEFAULT es lo que corre en producción, así que la app real no pasa nada y arranca en la pantalla de
 * entrada. Los tests que hablan de una pantalla del medio la piden en voz alta, en vez de recorrer
 * pantallas de las que no hablan.
 *
 * 🔴 POR QUÉ EL DEFAULT ES LA PANTALLA DE ENTRADA Y NO UNA DEL MEDIO, y es la mitad que importa: con
 * un default distinto, olvidarse de pasarlo en el punto de montaje haría desaparecer la primera
 * pantalla en producción con la suite entera en verde. Ese es el perfil de «default que degrada en
 * silencio» que este repo ya tiene documentado. Como está, el olvido no existe.
 *
 * ⛔ Y EL NOMBRE ES `pasoDeArranque` Y NO EL DEL ÁRBOL VIEJO, por un candado real: hay un `it` que lee
 * el fuente entero del punto de montaje y prohíbe la palabra del árbol viejo ahí, comentarios
 * incluidos. Dos costuras con el mismo nombre volverían ambiguo ese candado.
 */
export interface PropsDelRecorrido {
  container?: Container;
  pasoDeArranque?: PasoDelRecorrido;
  /** El `href` con el que se aterrizó. Default: el de esta ventana. ⛔ Se LEE, nunca se escribe. */
  hrefDeAterrizaje?: string;
  /** ¿Esta persona ya tiene la identidad verificada? Decide el itinerario (`AC-4`).
   *  ⚠️ HOY ⛔ NO TIENE PRODUCTOR fuera de los tests: el punto de montaje arma `<Recorrido />` sin
   *  props ⇒ vale `false` ⇒ el paso de la identidad aparece siempre. El porqué de que no se cablee
   *  todavía está en el docblock de `PantallaIdentidad` (CR/BLQ-MED-1). */
  identidadYaVerificada?: boolean;
}

/** Lo que la persona cargó. ⛔ Retroceder NO lo limpia (`AC-3`). */
interface Borrador {
  monto: string;
  nombre: string;
  cci: string;
}

const BORRADOR_VACIO: Borrador = { monto: "", nombre: "", cci: "" };

/** Los mismos milisegundos que el debounce de la cotización del árbol viejo (`../flow.tsx`, el
 *  efecto «preview en vivo (debounced)»). ⛔ Cita SIN ancla: ese archivo lleva marcadores de censo.
 *  🔴 SE EXPORTA PARA QUE `T-374-W1-19` LO COMPARE CON EL ORIGINAL (CR/MNR-1): estaba duplicado sin
 *  testigo, y ponerlo en `0` dejaba la suite entera en verde. ⛔ No se extrajo a un módulo
 *  compartido porque eso obligaría a editar `../flow.tsx`, que esta ola deja con Δ0. */
export const MS_DE_ESPERA_DE_LA_COTIZACION = 300;

/**
 * ⛔ NI `verificar` NI `firmar` PUEDEN SEGUIR SIN UN ENVÍO, y hasta el fix-pack se volvían de vuelta
 * en silencio (AR/BLQ-BAJO-2). El caso REAL que lo produce: la vuelta de un salto que aterriza en el
 * paso de firmar remonta el árbol, así que esta pestaña ya no tiene la remesa que se estaba armando.
 *
 * ⛔ NO DICE QUE FALLÓ EL ENVÍO: no falló, lo que falta son los datos EN ESTA PESTAÑA.
 *
 * 🔴 Y MANDA AL PASO DONDE HAY ALGO QUE CARGAR (CR/BLQ-BAJO-2). Decía «Volvé un paso», y un paso
 * atrás desde el de firmar es el de la identidad, donde ⛔ no hay ningún dato que volver a escribir.
 * O sea que el copy del caso central —volver de la billetera y encontrarse sin envío— mandaba a la
 * persona a una pantalla que no la podía ayudar. ⛔ El nombre del paso NO SE ESCRIBE: sale de la
 * tabla, que es el único sitio donde las etiquetas están escritas.
 */
const MOTIVO_SIN_ENVIO = `Este navegador ya no tiene los datos de este envío, así que todavía no hay nada que firmar. Volvé hasta «${etiquetaDe("envio")}» y cargalo de nuevo: tu billetera sigue conectada.`;

/** La misma frase que el árbol viejo muestra para el mismo desenlace. ⛔ No pasa por `humanError`:
 *  el caso de uso no tira, contesta un snapshot que no llegó a `kyc_passed`. */
const MOTIVO_KYC_NO_PASO = "No pudimos verificar tu identidad. Intentá de nuevo.";

export function Recorrido({
  container,
  pasoDeArranque = PASO_DE_ENTRADA,
  hrefDeAterrizaje,
  identidadYaVerificada = false,
}: PropsDelRecorrido = {}) {
  const c = useMemo(() => container ?? getContainer(), [container]);
  const itin = useMemo(() => itinerario({ identidadYaVerificada }), [identidadYaVerificada]);

  // 🔴 LA ÚNICA LECTURA DE LA URL, UNA VEZ, EN EL MONTAJE. ⛔ Se LEE, nunca se escribe.
  const [hrefDeMontaje] = useState(
    () => hrefDeAterrizaje ?? (typeof window === "undefined" ? "" : window.location.href),
  );

  // 🔴 EL ATERRIZAJE SE RESUELVE UNA VEZ, EN EL MONTAJE, Y COMO FUNCIÓN PURA DE LA URL. Un salto
  // remonta el árbol: no hay ningún estado anterior que consultar, y lo único que cruza es la marca.
  //
  // 🔴 Y LOS TRES DESENLACES LOS RESUELVE `aterrizajeDelAnfitrion`, ⛔ NO UN `? :` DE ACÁ. Acá había
  // `aterrizaje.desenlace === "aterriza" ? aterrizaje.paso : pasoDeArranque`, o sea el tercer valor
  // COLAPSADO contra el default: con `?dl=` de una marca que este repo no escribió, la persona
  // aterrizaba en la PANTALLA DE ENTRADA y sin motivo, que es el caso que `AC-8` nombra con esas
  // palabras (AR/BLQ-ALTO-1). La diferencia existía en el tipo de `Vuelta` y se perdía en el ternario.
  const [desenlace] = useState(() =>
    aterrizajeDelAnfitrion(vueltaDeUnSalto({ href: hrefDeMontaje }), pasoDeArranque),
  );

  const [paso, setPaso] = useState<PasoDelRecorrido>(desenlace.paso);
  const [motivo, setMotivo] = useState<string | null>(desenlace.motivo);
  const [borrador, setBorrador] = useState<Borrador>(BORRADOR_VACIO);
  const [cotizacion, setCotizacion] = useState<Quote | null>(null);
  const [remesa, setRemesa] = useState<RemittanceState | null>(null);
  const [enVuelo, setEnVuelo] = useState(false);
  /** ⇒ hay un caso de uso corriendo. Lo leen las pantallas para apagar los controles y decirlo. */
  const [enCurso, setEnCurso] = useState(false);
  /**
   * 🔴 LA GUARDA DE REENTRADA, Y POR QUÉ UN `ref` Y ⛔ NO EL ESTADO DE ARRIBA (CR/BLQ-MED-4). Medido
   * antes: tres clics daban TRES llamadas, y del otro lado hay un depósito y una cuota de proveedor.
   * El `disabled` de las pantallas es la mitad que se VE; ésta es la que decide, porque ⛔ no depende
   * de que un render haya llegado a pintarse entre dos toques.
   */
  const enCursoRef = useRef(false);
  /** La dirección que `connectWallet` contestó. La necesita `startKyc` y ⛔ no se lee del disco. */
  const [direccion, setDireccion] = useState<string | null>(null);
  /** A dónde hay que ir a firmar. `null` = todavía no hay ningún salto pendiente. */
  const [destinoDelSalto, setDestinoDelSalto] = useState<string | null>(null);
  /** Ídem, para la pantalla del verificador de identidad. */
  const [destinoDelVerificador, setDestinoDelVerificador] = useState<string | null>(null);
  /**
   * 🔴 ¿ESTE RECORRIDO VA POR ENLACE PROFUNDO? UN SOLO VALOR POR SESIÓN, Y LAS DOS MITADES SALEN DE
   * PRODUCCIÓN (AR/BLQ-BAJO-1). Antes esto estaba escrito a mano DOS veces, `true` en la pantalla de
   * entrada y `false` en la de firmar, así que la misma sesión anunciaba dos cantidades de firmas
   * distintas. Arranca leyendo la marca de la URL —lo único que cruza un salto— y lo prende también
   * el caso de uso del connect cuando contesta que hay que salir.
   */
  const [porEnlace, setPorEnlace] = useState(() => volvioPorEnlace(hrefDeMontaje));

  /** El origen con el que se arma la vuelta del verificador. ⛔ Sale del MISMO `href` del montaje. */
  const origenDeLaVuelta = useMemo(() => {
    try {
      return new URL(hrefDeMontaje).origin;
    } catch {
      return "";
    }
  }, [hrefDeMontaje]);

  const monto = Number(borrador.monto);
  // 🔴 EL CORTE POR EL MÍNIMO, COPIADO DEL ÁRBOL VIEJO CON SU MOTIVO (AR/BLQ-MED-3): por debajo del
  // mínimo el agente rechaza la cotización igual, así que pedirla es un viaje garantizado a un error.
  // La constante es la de producción; ⛔ acá no se escribe ningún número.
  const montoCotizable = Number.isFinite(monto) && monto >= MIN_SEND_USD;
  /** 🔴 EL MISMO CORTE, PERO PARA DECIRLO (CR/BLQ-MED-2). ⛔ Pide un monto ESCRITO Y MAYOR A CERO: el
   *  campo vacío también está por debajo del mínimo, y gritarle a alguien que todavía no escribió
   *  nada es la otra forma de que la pantalla hable de más. Mismo predicado que el árbol viejo. */
  const porDebajoDelMinimo = Number.isFinite(monto) && monto > 0 && monto < MIN_SEND_USD;

  // La cotización en vivo de la pantalla 2. Se pide por el caso de uso, ⛔ nunca por un `fetch` de
  // acá: la pantalla no sabe con quién se cotiza y no tiene por qué saberlo.
  //
  // 🔴 TRES COSAS QUE ARREGLÓ EL `BLQ-MED-3` DEL AR, y cada una se medía sola:
  //   1. UNA COTIZACIÓN POR TECLA. Sin espera, tipear «25» disparaba dos pedidos (medido: los montos
  //      `[2, 25]`, o sea que el primero era además un monto que la persona nunca pidió cotizar).
  //   2. SIN CORTE POR EL MÍNIMO ⇒ el primero de esos dos pedidos era un viaje garantizado a un error.
  //   3. EL ERROR QUEDABA PEGADO: `motivo` no se limpiaba nunca en el camino feliz, así que la
  //      pantalla mostraba el banner de «no pudimos terminar ese paso» JUNTO a la cotización correcta.
  //      ⛔ Eso es copy que dice que algo falló cuando no falló.
  useEffect(() => {
    if (!montoCotizable) {
      setCotizacion(null);
      return;
    }
    let vivo = true;
    const t = setTimeout(() => {
      void c.previewQuote
        .execute({ amountUsd: monto, method: OFFERED_PAYOUT_METHODS[0] })
        .then((q) => {
          if (!vivo) return;
          setCotizacion(q);
          setMotivo(null); // el camino feliz LIMPIA: llegó la cifra, no hay nada que reportar
        })
        .catch((e: unknown) => {
          if (!vivo) return;
          setCotizacion(null); // ⛔ y no se deja la cifra vieja al lado de un error
          setMotivo(humanError(codigoDe(e)));
        });
    }, MS_DE_ESPERA_DE_LA_COTIZACION);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [c, monto, montoCotizable]);

  /**
   * 🔴 EL APAGADOR DEL ESTADO EN VUELO, Y ES UN ARREGLO DE COPY ANTES QUE UNO DE ESTADO
   * (CR/BLQ-MED-3). `setEnVuelo(false)` no aparecía NI UNA VEZ: un flag que se prendía y no se
   * apagaba, compartido por tres pantallas. Reproducción: enlace del verificador, «Volver»,
   * «Seguir» ⇒ «Estamos en el verificador» con el navegador quieto. Cambiar de paso lo apaga: si la
   * persona se mueve por el recorrido, no está en la otra app.
   */
  // ⚠️ `paso` ⛔ NO SE LEE ADENTRO: es el DISPARADOR. El efecto existe para correr CUANDO el paso
  // cambia, así que sacarlo de la lista —que es lo que el linter propone— lo dejaría corriendo una
  // sola vez en el montaje y el apagador no apagaría nada. Lo mide `T-374-W1-22` en su aserción (A).
  // ⛔ La supresión va en UNA sola línea y pegada al `useEffect`: partida en varias, el linter la
  // reporta como supresión sin efecto y la regla queda igual de encendida (medido).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `paso` es el disparador, no una lectura
  useEffect(() => {
    setEnVuelo(false);
  }, [paso]);

  /**
   * Y LA SEGUNDA MITAD, PARA EL CASO QUE MÁS DUELE: volver del salto SIN cambiar de paso, que es lo
   * que pasa en un teléfono. `visibilitychange` ⇒ la pestaña volvió a estar a la vista; `pageshow` ⇒
   * la página volvió desde la caché de ida y vuelta.
   * ⚠️ EL LÍMITE: si el toque ⛔ no produce NADA y la pestaña nunca se esconde, ninguno de los dos
   * llega y el único apagador es el de arriba. ⛔ Eso no se afirma cerrado.
   */
  useEffect(() => {
    if (!enVuelo) return;
    const apagar = () => {
      if (document.visibilityState === "visible") setEnVuelo(false);
    };
    window.addEventListener("pageshow", apagar);
    document.addEventListener("visibilitychange", apagar);
    return () => {
      window.removeEventListener("pageshow", apagar);
      document.removeEventListener("visibilitychange", apagar);
    };
  }, [enVuelo]);

  /**
   * El molde es el `guard` del árbol viejo (`../flow.tsx`; ⛔ cita SIN ancla: ese archivo lleva
   * marcadores de censo). ⛔ El `finally` no es decorativo: sin él, un caso de uso que tira deja los
   * controles apagados para siempre y a la persona sin forma de reintentar.
   */
  const conGuarda = useCallback(async (fn: () => Promise<unknown>) => {
    if (enCursoRef.current) return;
    enCursoRef.current = true;
    setEnCurso(true);
    try {
      await fn();
    } finally {
      enCursoRef.current = false;
      setEnCurso(false);
    }
  }, []);

  const avanzar = useCallback(() => setPaso((p) => siguiente(itin, p)), [itin]);

  /** ⛔ NO LIMPIA NADA. Retrocede un paso y deja el borrador donde estaba (`AC-3`). */
  const volver = useCallback(() => setPaso((p) => anterior(itin, p)), [itin]);

  const conectar = useCallback(() => {
    setMotivo(null);
    void conGuarda(() =>
      c.connectWallet
        .execute()
        .then((r) => {
          setDireccion(r.address);
          // El caso de uso puede contestar que hay que SALIR. Cuando lo hace, se anuncia ANTES —el
          // anuncio se pinta porque hay destino— y el salto queda como algo que la persona TOCA:
          // ⛔ nunca un salto sin aviso previo, y ⛔ nunca una navegación programática (ver `Salir`).
          if (r.estado === "hay-que-salir") {
            setPorEnlace(true);
            setDestinoDelSalto(r.irA);
            return;
          }
          avanzar();
        })
        .catch((e: unknown) => setMotivo(humanError(codigoDe(e)))),
    );
  }, [c, avanzar, conGuarda]);

  /**
   * ⛔ NO NAVEGA. Lo dispara el `onClick` del `<a href>`, que es quien navega, y lo único que hace es
   * prender el estado EN VUELO para que quede algo con palabras mientras la pestaña se va.
   *
   * 🔴 ES UNO SOLO Y ⛔ NO DOS (CR/MNR-2). Había dos `useCallback` con el MISMO cuerpo y un motivo
   * inventado al lado: «va aparte porque el TEXTO en vuelo es otro». Falso: el texto lo elige cada
   * pantalla al renderizar y este gesto ⛔ no lo toca.
   */
  const salirDeLaApp = useCallback(() => {
    setEnVuelo(true);
  }, []);

  const seguirDelEnvio = useCallback(() => {
    setMotivo(null);
    void conGuarda(() =>
      c.createRemittance
        .execute({
          amountUsd: monto,
          beneficiary: {
            name: borrador.nombre,
            country: "PE",
            method: OFFERED_PAYOUT_METHODS[0],
            destination: cciDigits(borrador.cci),
          },
        })
        .then((r) => {
          setRemesa(r.snapshot);
          avanzar();
        })
        .catch((e: unknown) => setMotivo(humanError(codigoDe(e)))),
    );
  }, [c, monto, borrador.nombre, borrador.cci, avanzar, conGuarda]);

  /**
   * 🔴 VERIFICAR LLAMA A `startKyc`. Acá había `setEnVuelo(true); avanzar();` y nada más, o sea que la
   * pantalla decía «estamos en el verificador» con el navegador quieto Y DABA LA IDENTIDAD POR
   * VERIFICADA SIN VERIFICAR NADA (AR/BLQ-ALTO-2: `startKyc` llamado 0 veces, y avanzaba igual).
   *
   * Los tres desenlaces del caso de uso, cada uno con su consecuencia y ninguno avanzando de más:
   *   · `redirect` ⇒ hay una pantalla del verificador a la que ir ⇒ el control pasa a ser el enlace
   *     que la persona toca. ⛔ No se avanza: se avanza al VOLVER, y de eso se ocupa el aterrizaje.
   *   · `done` con la verificación pasada ⇒ se guarda el snapshot y recién ahí se avanza.
   *   · `done` sin pasar ⇒ ⛔ NO se avanza, y se dice por qué.
   */
  const verificar = useCallback(() => {
    setMotivo(null);
    const id = remesa?.id;
    if (id === undefined) {
      setMotivo(MOTIVO_SIN_ENVIO);
      return;
    }
    void conGuarda(() =>
      c.startKyc
        .execute({
          remittanceId: id,
          address: direccion ?? "",
          callbackUrl: origenDeLaVuelta === "" ? undefined : urlDeVueltaDeKyc(origenDeLaVuelta),
        })
        .then((res) => {
          if (res.kind === "redirect") {
            setDestinoDelVerificador(res.url);
            return;
          }
          if (res.snapshot.status !== "kyc_passed") {
            setMotivo(MOTIVO_KYC_NO_PASO);
            return;
          }
          setRemesa(res.snapshot);
          avanzar();
        })
        .catch((e: unknown) => setMotivo(humanError(codigoDe(e)))),
    );
  }, [c, remesa?.id, direccion, origenDeLaVuelta, avanzar, conGuarda]);

  /**
   * 🔴 EL CAMINO POR ENLACE YA NO SE DESCARTA EN SILENCIO. Acá había un `if (r.estado === "listo")`
   * SIN `else`, o sea que el desenlace `hay-que-salir` —el del camino del que trata esta HU— caía al
   * vacío: sin salto, sin motivo y sin avance (AR/BLQ-ALTO-2).
   *
   * ⛔ Y `enVuelo` NO se prende acá: mientras el caso de uso piensa, el navegador está quieto y decir
   * «estamos en tu billetera» sería afirmar un hecho falso. Se prende cuando la persona toca el enlace.
   */
  const firmar = useCallback(() => {
    setMotivo(null);
    const id = remesa?.id;
    if (id === undefined) {
      setMotivo(MOTIVO_SIN_ENVIO);
      return;
    }
    void conGuarda(() =>
      c.confirmAndSend
        .execute({ remittanceId: id, hrefDeLaVuelta: hrefDeMontaje })
        .then((r) => {
          if (r.estado === "hay-que-salir") {
            setDestinoDelSalto(r.irA);
            return;
          }
          setRemesa(r.remesa.snapshot);
          avanzar();
        })
        .catch((e: unknown) => setMotivo(humanError(codigoDe(e)))),
    );
  }, [c, remesa?.id, hrefDeMontaje, avanzar, conGuarda]);

  // ⛔ EL MISMO CORTE QUE LA COTIZACIÓN, y no dos reglas distintas: si por debajo del mínimo no se
  // cotiza, tampoco se puede seguir con un envío del que no hay cifra. Es el gate del árbol viejo.
  const puedeSeguir = montoCotizable && borrador.nombre.trim() !== "" && isValidCci(borrador.cci);

  /** El anuncio de la pantalla de entrada aparece SÓLO cuando hay a dónde ir. `porEnlace` sale de un
   *  solo lugar, así que las dos pantallas anuncian la MISMA lista de firmas (AR/BLQ-BAJO-1). */
  const anuncio = useMemo(
    () => (destinoDelSalto === null ? null : anuncioDe({ porEnlace })),
    [destinoDelSalto, porEnlace],
  );

  return (
    <MarcoDelRecorrido>
      <Stepper steps={[...etiquetasDe(itin)]} current={Math.max(indiceEn(itin, paso), 0)} />
      {paso === "entrar" ? (
        <PantallaEntrar
          anuncio={anuncio}
          destinoDelSalto={destinoDelSalto}
          enVuelo={enVuelo}
          enCurso={enCurso}
          motivo={motivo}
          urlParaInstalar={URL_INSTALAR_PHANTOM}
          onConectar={conectar}
          onSalirALaBilletera={salirDeLaApp}
        />
      ) : null}
      {paso === "envio" ? (
        <PantallaEnvio
          monto={borrador.monto}
          nombre={borrador.nombre}
          cci={borrador.cci}
          cotizacion={cotizacion}
          porDebajoDelMinimo={porDebajoDelMinimo}
          motivo={motivo}
          puedeSeguir={puedeSeguir}
          enCurso={enCurso}
          onMonto={(v) => setBorrador((b) => ({ ...b, monto: v }))}
          onNombre={(v) => setBorrador((b) => ({ ...b, nombre: v }))}
          onCci={(v) => setBorrador((b) => ({ ...b, cci: v }))}
          onSeguir={seguirDelEnvio}
          onVolver={volver}
        />
      ) : null}
      {paso === "identidad" ? (
        <PantallaIdentidad
          verificador="nuestro verificador de identidad"
          destinoDelVerificador={destinoDelVerificador}
          enVuelo={enVuelo}
          enCurso={enCurso}
          motivo={motivo}
          onVerificar={verificar}
          onSalirAlVerificador={salirDeLaApp}
          onVolver={volver}
        />
      ) : null}
      {paso === "firmar" ? (
        <PantallaFirmar
          cotizacion={cotizacion}
          destino={ultimosDigitos(borrador.cci)}
          anuncio={anuncioDe({ porEnlace })}
          destinoDelSalto={destinoDelSalto}
          enVuelo={enVuelo}
          enCurso={enCurso}
          motivo={motivo}
          onFirmar={firmar}
          onSalirALaBilletera={salirDeLaApp}
          onVolver={volver}
        />
      ) : null}
      {paso === "seguimiento" ? (
        <PantallaSeguimiento remesa={remesa} motivo={motivo} onVolver={volver} />
      ) : null}
    </MarcoDelRecorrido>
  );
}

/** El código crudo de un error, para que (`humanError`, `../flow-vm.ts:572`) lo vuelva legible.
 *  ⛔ Acá no se escribe ni un mensaje de error nuevo. */
function codigoDe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Los últimos dígitos del CCI, que es lo único del destino que se muestra al firmar. */
function ultimosDigitos(cci: string): string {
  return cciDigits(cci).slice(-4);
}
