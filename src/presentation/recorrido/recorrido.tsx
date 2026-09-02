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
// función pura de `./salto.ts` — leer no es escribir, y escribir no pasa. Lo mide `T-374-W1-12`.

import { useCallback, useEffect, useMemo, useState } from "react";
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
  /** ¿Esta persona ya tiene la identidad verificada? Decide el itinerario (`AC-4`). */
  identidadYaVerificada?: boolean;
}

/** Lo que la persona cargó. ⛔ Retroceder NO lo limpia (`AC-3`). */
interface Borrador {
  monto: string;
  nombre: string;
  cci: string;
}

const BORRADOR_VACIO: Borrador = { monto: "", nombre: "", cci: "" };

/** Los mismos 300 ms que el debounce de la cotización del árbol viejo (`../flow.tsx`, el efecto
 *  «preview en vivo (debounced)»). ⛔ Cita SIN ancla a propósito: ese archivo lleva marcadores de
 *  censo de citas ancladas entrantes por número, y anclar una nueva obligaría a editarlos. */
const MS_DE_ESPERA_DE_LA_COTIZACION = 300;

/**
 * ⛔ NI `verificar` NI `firmar` PUEDEN SEGUIR SIN UN ENVÍO, y hasta el fix-pack se volvían de vuelta
 * en silencio (AR/BLQ-BAJO-2). El caso REAL que lo produce: la vuelta de un salto que aterriza en el
 * paso de firmar remonta el árbol, así que esta pestaña ya no tiene la remesa que se estaba armando.
 *
 * ⛔ NO DICE QUE FALLÓ EL ENVÍO: no falló, lo que falta son los datos EN ESTA PESTAÑA.
 */
const MOTIVO_SIN_ENVIO =
  "Este navegador ya no tiene los datos de este envío, así que todavía no hay nada que firmar. Volvé un paso y cargalo de nuevo: tu billetera sigue conectada.";

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

  const avanzar = useCallback(() => setPaso((p) => siguiente(itin, p)), [itin]);

  /** ⛔ NO LIMPIA NADA. Retrocede un paso y deja el borrador donde estaba (`AC-3`). */
  const volver = useCallback(() => setPaso((p) => anterior(itin, p)), [itin]);

  const conectar = useCallback(() => {
    setMotivo(null);
    void c.connectWallet
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
      .catch((e: unknown) => setMotivo(humanError(codigoDe(e))));
  }, [c, avanzar]);

  /** ⛔ NO NAVEGA. Lo dispara el `onClick` del `<a href>`, que es quien navega, y lo único que hace
   *  es prender el estado EN VUELO para que quede algo con palabras mientras la pestaña se va. */
  const salirALaBilletera = useCallback(() => {
    setEnVuelo(true);
  }, []);

  /** El mismo gesto, para el salto al verificador. Va aparte porque el TEXTO en vuelo es otro. */
  const salirAlVerificador = useCallback(() => {
    setEnVuelo(true);
  }, []);

  const seguirDelEnvio = useCallback(() => {
    setMotivo(null);
    void c.createRemittance
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
      .catch((e: unknown) => setMotivo(humanError(codigoDe(e))));
  }, [c, monto, borrador.nombre, borrador.cci, avanzar]);

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
    void c.startKyc
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
      .catch((e: unknown) => setMotivo(humanError(codigoDe(e))));
  }, [c, remesa?.id, direccion, origenDeLaVuelta, avanzar]);

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
    void c.confirmAndSend
      .execute({ remittanceId: id, hrefDeLaVuelta: hrefDeMontaje })
      .then((r) => {
        if (r.estado === "hay-que-salir") {
          setDestinoDelSalto(r.irA);
          return;
        }
        setRemesa(r.remesa.snapshot);
        avanzar();
      })
      .catch((e: unknown) => setMotivo(humanError(codigoDe(e))));
  }, [c, remesa?.id, hrefDeMontaje, avanzar]);

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
          motivo={motivo}
          urlParaInstalar={URL_INSTALAR_PHANTOM}
          onConectar={conectar}
          onSalirALaBilletera={salirALaBilletera}
        />
      ) : null}
      {paso === "envio" ? (
        <PantallaEnvio
          monto={borrador.monto}
          nombre={borrador.nombre}
          cci={borrador.cci}
          cotizacion={cotizacion}
          motivo={motivo}
          puedeSeguir={puedeSeguir}
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
          motivo={motivo}
          onVerificar={verificar}
          onSalirAlVerificador={salirAlVerificador}
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
          motivo={motivo}
          onFirmar={firmar}
          onSalirALaBilletera={salirALaBilletera}
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
