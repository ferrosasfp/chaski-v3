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
import { OFFERED_PAYOUT_METHODS, cciDigits, isValidCci } from "../../domain/remittance";
import type { Quote, RemittanceState } from "../../domain/remittance";
import { humanError } from "../flow-vm";
import { URL_INSTALAR_PHANTOM } from "../salida-al-navegador-de-la-billetera";
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
import { type Anuncio, anuncioDe, vueltaDeUnSalto } from "./salto";

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

export function Recorrido({
  container,
  pasoDeArranque = PASO_DE_ENTRADA,
  hrefDeAterrizaje,
  identidadYaVerificada = false,
}: PropsDelRecorrido = {}) {
  const c = useMemo(() => container ?? getContainer(), [container]);
  const itin = useMemo(() => itinerario({ identidadYaVerificada }), [identidadYaVerificada]);

  // 🔴 EL ATERRIZAJE SE RESUELVE UNA VEZ, EN EL MONTAJE, Y COMO FUNCIÓN PURA DE LA URL. Un salto
  // remonta el árbol: no hay ningún estado anterior que consultar, y lo único que cruza es la marca.
  const aterrizaje = useState(() => {
    const href =
      hrefDeAterrizaje ?? (typeof window === "undefined" ? "" : window.location.href);
    return vueltaDeUnSalto({ href });
  })[0];

  const [paso, setPaso] = useState<PasoDelRecorrido>(() =>
    aterrizaje.desenlace === "aterriza" ? aterrizaje.paso : pasoDeArranque,
  );
  const [motivo, setMotivo] = useState<string | null>(
    aterrizaje.desenlace === "aterriza" ? aterrizaje.motivo : null,
  );
  const [borrador, setBorrador] = useState<Borrador>(BORRADOR_VACIO);
  const [cotizacion, setCotizacion] = useState<Quote | null>(null);
  const [remesa, setRemesa] = useState<RemittanceState | null>(null);
  const [enVuelo, setEnVuelo] = useState(false);
  const [anuncio, setAnuncio] = useState<Anuncio | null>(null);

  const monto = Number(borrador.monto);
  const montoValido = Number.isFinite(monto) && monto > 0;

  // La cotización en vivo de la pantalla 2. Se pide por el caso de uso, ⛔ nunca por un `fetch` de
  // acá: la pantalla no sabe con quién se cotiza y no tiene por qué saberlo.
  useEffect(() => {
    if (!montoValido) {
      setCotizacion(null);
      return;
    }
    let vivo = true;
    void c
      .previewQuote.execute({ amountUsd: monto, method: OFFERED_PAYOUT_METHODS[0] })
      .then((q) => {
        if (vivo) setCotizacion(q);
      })
      .catch((e: unknown) => {
        if (vivo) setMotivo(humanError(codigoDe(e)));
      });
    return () => {
      vivo = false;
    };
  }, [c, monto, montoValido]);

  const avanzar = useCallback(() => setPaso((p) => siguiente(itin, p)), [itin]);

  /** ⛔ NO LIMPIA NADA. Retrocede un paso y deja el borrador donde estaba (`AC-3`). */
  const volver = useCallback(() => setPaso((p) => anterior(itin, p)), [itin]);

  const conectar = useCallback(() => {
    setMotivo(null);
    void c.connectWallet
      .execute()
      .then((r) => {
        // El caso de uso puede contestar que hay que SALIR. Cuando lo hace, se anuncia ANTES y se
        // muestra el estado en vuelo: ⛔ nunca un salto sin aviso previo.
        if (r.estado === "hay-que-salir") {
          setAnuncio(anuncioDe({ porEnlace: true }));
          return;
        }
        avanzar();
      })
      .catch((e: unknown) => setMotivo(humanError(codigoDe(e))));
  }, [c, avanzar]);

  const salirALaBilletera = useCallback(() => {
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

  const verificar = useCallback(() => {
    setEnVuelo(true);
    avanzar();
  }, [avanzar]);

  const firmar = useCallback(() => {
    setMotivo(null);
    setEnVuelo(true);
    const id = remesa?.id;
    if (id === undefined) {
      setEnVuelo(false);
      return;
    }
    void c.confirmAndSend
      .execute({ remittanceId: id, hrefDeLaVuelta: hrefDeAterrizaje ?? "" })
      .then((r) => {
        if (r.estado === "listo") {
          setRemesa(r.remesa.snapshot);
          setEnVuelo(false);
          avanzar();
        }
      })
      .catch((e: unknown) => {
        setEnVuelo(false);
        setMotivo(humanError(codigoDe(e)));
      });
  }, [c, remesa?.id, hrefDeAterrizaje, avanzar]);

  const puedeSeguir = montoValido && borrador.nombre.trim() !== "" && isValidCci(borrador.cci);

  return (
    <MarcoDelRecorrido>
      <Stepper steps={[...etiquetasDe(itin)]} current={Math.max(indiceEn(itin, paso), 0)} />
      {paso === "entrar" ? (
        <PantallaEntrar
          anuncio={anuncio}
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
          enVuelo={enVuelo}
          motivo={motivo}
          onVerificar={verificar}
          onVolver={volver}
        />
      ) : null}
      {paso === "firmar" ? (
        <PantallaFirmar
          cotizacion={cotizacion}
          destino={ultimosDigitos(borrador.cci)}
          anuncio={anuncioDe({ porEnlace: false })}
          enVuelo={enVuelo}
          motivo={motivo}
          onFirmar={firmar}
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
