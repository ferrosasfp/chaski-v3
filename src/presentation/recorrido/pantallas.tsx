// WKH-374 · W1.1 — LAS CINCO PANTALLAS DEL RECORRIDO NUEVO
//
// Cinco componentes, uno por paso de la tabla de `./pasos.ts`. Cada uno recibe por props todo lo que
// muestra y todo lo que dispara: ⛔ ninguno toca `localStorage`, `sessionStorage`, `document.cookie`
// ni la barra de direcciones, y ⛔ ninguno llama al `Container` por su cuenta. Quien habla con los
// casos de uso es el anfitrión, `./recorrido.tsx`, en un solo sitio.
//
// 🔴 POR QUÉ ESA COSTURA ES LO IMPORTANTE DE ESTE ARCHIVO, y no un gusto de arquitectura: es lo que
// va a dejar mover el borrador a otro almacén sin tocar una sola pantalla. Y ⛔ no es una promesa en
// prosa: es falsable con un barrido estático, y lo mide `T-374-W1-12`.
//
// ⛔ EL SISTEMA DE DISEÑO ES EL DE LA CASA (`../ui.tsx`). No se escribe uno nuevo, y ⛔ no se usan los
// tamaños de texto de fábrica: el vocabulario es por ROL (`text-body`, `text-label`, `text-support`,
// `text-title`), y lo mide la pata (b) de `T-374-W1-12`.
//
// ⛔ Y ESTE ÁRBOL NO USA NAVEGACIÓN BLANDA. Se cambia de pantalla por ESTADO, en un solo punto de
// montaje. Nada de hooks de router de cliente, nada de enlaces blandos: lo vigila
// `../el-salto-remonta-el-arbol.test.tsx` sobre las cuatro raíces del árbol.

import type { ReactNode } from "react";
import type { Quote, RemittanceState } from "../../domain/remittance";
import { escrowRentExplainer, statusDisplay } from "../flow-vm";
import { Aviso, Button, Card, Field, Money, Muted, Pill, Row, TextInput } from "../ui";
import type { Anuncio } from "./salto";
import { TEXTO_EN_VUELO, TEXTO_EN_VUELO_IDENTIDAD } from "./salto";

/**
 * La afirmación no custodial (`AC-16`). Se escribe UNA vez y la usan las pantallas que hablan de
 * fondos: ⛔ ninguna pantalla del recorrido ofrece, menciona ni integra una billetera custodial o
 * embebida, y la frase que lo dice no puede quedar en una sola de ellas.
 */
export const NO_CUSTODIAL = "Tus fondos y tus llaves son tuyos. Chaski no los guarda ni firma por vos.";

/** El encabezado común: título de la pantalla y, debajo, una línea de qué se hace acá. */
function Encabezado({ titulo, bajada }: { titulo: string; bajada: string }) {
  return (
    <header className="mb-holgado">
      <h1 className="text-title font-extrabold text-ink">{titulo}</h1>
      <Muted className="mt-ajustado">{bajada}</Muted>
    </header>
  );
}

/** La salida no destructiva (`AC-3`). ⛔ Retrocede UN paso y no borra nada: lo cargado vive en el
 *  estado del anfitrión y esta función sólo avisa que hay que retroceder. */
function Volver({ onVolver }: { onVolver: () => void }) {
  return (
    <Button variant="ghost" onClick={onVolver} type="button">
      Volver
    </Button>
  );
}

/** El motivo legible de una vuelta que salió mal (`AC-8`). ⛔ Se muestra en el MISMO paso donde
 *  estaba la persona, ⛔ nunca mandándola al principio, y ⛔ nunca obligándola a recargar a mano. */
function Motivo({ motivo }: { motivo: string | null }) {
  if (motivo === null) return null;
  return (
    <Aviso tono="atencion" className="mb-normal">
      <p className="text-body font-semibold text-ink">No pudimos terminar ese paso</p>
      <Muted className="mt-ajustado">{motivo}</Muted>
    </Aviso>
  );
}

/**
 * 🔴 EL CONTROL QUE SALE DE LA APP, Y EL ARREGLO ENTERO DEL `BLQ-ALTO-2` DEL AR ESTÁ ACÁ.
 *
 * Tiene DOS formas y ⛔ no son intercambiables:
 *   · `destino === null` ⇒ un `<button>`: todavía no sabemos a dónde hay que ir, así que lo que el
 *     gesto dispara es el CASO DE USO que lo averigua (`onPedir`).
 *   · `destino` con URL ⇒ un `<a href>`: el destino ya está, y la persona lo TOCA.
 *
 * 🔴 POR QUÉ UN `<a href>` Y ⛔ NO UN `onClick` QUE ASIGNE `location.href`, con las dos razones:
 *   1. Es el patrón que este repo YA tiene desplegado y medido para el caso equivalente: el árbol
 *      viejo navegaba desde un efecto de montaje, los navegadores móviles lo descartaban SIN ERROR y
 *      la persona se quedaba mirando la pantalla de entrada (el razonamiento entero, con la foto del
 *      teléfono, vive en el comentario de `../flow.tsx:286`; ⛔ cita SIN ancla a propósito: ese
 *      archivo lleva marcadores de censo de citas entrantes por número).
 *   2. `T-374-W1-12` prohíbe toda asignación de `window.location` DENTRO de este árbol, y con razón:
 *      una pantalla que navega por su cuenta es la costura que ese barrido existe para cerrar. Un
 *      `<a href>` no navega por su cuenta, navega porque alguien lo tocó.
 *
 * ⚠️ `onSalir` en el `<a>` ⛔ NO NAVEGA: sólo prende el estado EN VUELO (`AC-6`), para que lo que
 * quede montado mientras la pestaña se va diga con palabras qué está pasando.
 */
function Salir(p: {
  destino: string | null;
  etiqueta: string;
  onPedir: () => void;
  onSalir: () => void;
}) {
  if (p.destino === null) {
    return (
      <Button onClick={p.onPedir} type="button">
        {p.etiqueta}
      </Button>
    );
  }
  return (
    // `min-h-[52px]` y ⛔ no `h-`: en una pantalla angosta esta etiqueta envuelve, y con alto fijo
    // quedaría recortada. Es el mismo criterio, y las mismas clases, que el enlace de salto del árbol
    // viejo. ⛔ El `href` va TAL CUAL: no se parsea, no se reescribe y no se le agrega un parámetro.
    <a
      href={p.destino}
      rel="noreferrer"
      onClick={p.onSalir}
      className="inline-flex min-h-[52px] w-full items-center justify-center gap-ajustado rounded-caja bg-cochineal px-5 text-body font-semibold text-white shadow-lift"
    >
      {p.etiqueta}
    </a>
  );
}

/**
 * EL ANUNCIO DEL SALTO (`AC-5`) — el bloque que dice QUÉ se va a firmar y POR QUÉ, ANTES de salir.
 * ⛔ Nunca un salto sin aviso previo.
 *
 * ⛔ EL NÚMERO DE FIRMAS NO SE ESCRIBE: sale de contar la misma lista que se enumera abajo
 * (`CD-W1-6`), así que no puede quedar diciendo un número y mostrando otra cosa.
 */
export function AnuncioDelSalto({
  anuncio,
  destino,
  onPedir,
  onSalir,
}: { anuncio: Anuncio; destino: string | null; onPedir: () => void; onSalir: () => void }) {
  return (
    <Aviso tono="atencion" className="mb-normal">
      <p className="text-body font-semibold text-ink">{anuncio.titulo}</p>
      <Muted className="mt-ajustado">{anuncio.aDondeVas}</Muted>
      <p className="mt-normal text-label font-semibold text-ink">
        {`Te va a pedir ${anuncio.firmas.length} ${anuncio.firmas.length === 1 ? "firma" : "firmas"}:`}
      </p>
      <ul className="mt-ajustado list-disc pl-5">
        {anuncio.firmas.map((f) => (
          <li key={f.queSeFirma} className="text-support text-stone">
            <span className="font-semibold text-ink">{f.queSeFirma}</span>
            {". "}
            {f.porQue}
          </li>
        ))}
      </ul>
      <Muted className="mt-normal">{anuncio.volves}</Muted>
      <div className="mt-normal">
        <Salir destino={destino} etiqueta={anuncio.boton} onPedir={onPedir} onSalir={onSalir} />
      </div>
    </Aviso>
  );
}

/**
 * EL ESTADO EN VUELO (`AC-6`) — lo que queda montado mientras la persona está en la otra app.
 * ⛔ Ni pantalla vacía ni un indicador mudo: con TEXTO.
 *
 * ⚠️ EL LÍMITE, declarado y no disimulado: mientras la persona está en la billetera, esta pantalla
 * NO está a la vista. Lo que garantiza es lo que encuentra al volver la vista atrás.
 */
export function EnVuelo({ texto }: { texto: string }) {
  return (
    <Aviso tono="neutro" className="mb-normal">
      <p className="text-body font-semibold text-ink">{texto}</p>
    </Aviso>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1 · ENTRAR
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 CONECTAR ES LO PRIMERO (`AC-1`). Esta pantalla tiene UN botón y ⛔ no pide monto, ni quién
 * recibe, ni el CCI: eso es la pantalla 2, y ese orden es lo que da una dirección conectada antes de
 * que exista un envío que guardar.
 *
 * ⚠️ Y SI EL CAMINO QUE LE TOCA A ESTE NAVEGADOR SALE A LA BILLETERA, ESTA PANTALLA LO DICE ANTES DE
 * QUE LA PERSONA TOQUE EL BOTÓN (`AC-5`). El anuncio no es un extra: es la mitad del invariante.
 */
export function PantallaEntrar(p: {
  anuncio: Anuncio | null;
  /** A dónde hay que ir, cuando el caso de uso ya lo contestó. `null` ⇒ todavía no hay destino. */
  destinoDelSalto: string | null;
  enVuelo: boolean;
  motivo: string | null;
  urlParaInstalar: string;
  onConectar: () => void;
  onSalirALaBilletera: () => void;
}) {
  return (
    <Card>
      <Encabezado
        titulo="Entrar"
        bajada="Chaski manda USDC desde tu billetera a una cuenta bancaria en Perú."
      />
      <Motivo motivo={p.motivo} />
      {p.enVuelo ? <EnVuelo texto={TEXTO_EN_VUELO} /> : null}
      {p.anuncio === null ? null : (
        <AnuncioDelSalto
          anuncio={p.anuncio}
          destino={p.destinoDelSalto}
          onPedir={p.onConectar}
          onSalir={p.onSalirALaBilletera}
        />
      )}
      <Button onClick={p.onConectar} type="button">
        Conectar mi billetera
      </Button>
      <Muted className="mt-normal">{NO_CUSTODIAL}</Muted>
      <Muted escala="label" className="mt-ajustado">
        <a className="underline" href={p.urlParaInstalar} target="_blank" rel="noreferrer">
          ¿Todavía no tenés billetera? Instalá una.
        </a>
      </Muted>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2 · CUÁNTO Y PARA QUIÉN
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * La única pantalla donde se escribe algo, y ⛔ LA ÚNICA QUE NO SALTA A NINGÚN LADO. Eso no es una
 * casualidad: es consecuencia directa de que conectar sea lo primero, y es lo que hace que ningún
 * envío a medio escribir tenga que sobrevivir a un salto.
 *
 * La cotización va EN ESTA MISMA PANTALLA: cuánto llega en PEN, la comisión y quién la cobra.
 */
export function PantallaEnvio(p: {
  monto: string;
  nombre: string;
  cci: string;
  cotizacion: Quote | null;
  motivo: string | null;
  puedeSeguir: boolean;
  onMonto: (v: string) => void;
  onNombre: (v: string) => void;
  onCci: (v: string) => void;
  onSeguir: () => void;
  onVolver: () => void;
}) {
  return (
    <Card>
      <Encabezado titulo="Cuánto y para quién" bajada="Se guarda solo mientras lo completás." />
      <Motivo motivo={p.motivo} />
      <div className="space-y-normal">
        <Field label="Cuánto mandás" hint="En USDC, desde tu billetera.">
          <TextInput
            inputMode="decimal"
            value={p.monto}
            onChange={(e) => p.onMonto(e.target.value)}
            aria-label="Cuánto mandás"
          />
        </Field>
        <Field label="Quién recibe">
          <TextInput
            value={p.nombre}
            onChange={(e) => p.onNombre(e.target.value)}
            aria-label="Quién recibe"
          />
        </Field>
        <Field label="CCI de la cuenta" hint="Los 20 dígitos que imprime el banco.">
          <TextInput
            inputMode="numeric"
            value={p.cci}
            onChange={(e) => p.onCci(e.target.value)}
            aria-label="CCI de la cuenta"
          />
        </Field>
      </div>
      <div className="mt-holgado">
        {p.cotizacion === null ? (
          <Muted>Escribí el monto y te decimos cuánto llega.</Muted>
        ) : (
          <Cotizacion quote={p.cotizacion} />
        )}
      </div>
      <div className="mt-holgado space-y-ajustado">
        <Button onClick={p.onSeguir} type="button" disabled={!p.puedeSeguir}>
          Seguir
        </Button>
        <Volver onVolver={p.onVolver} />
      </div>
      <Muted className="mt-normal">{NO_CUSTODIAL}</Muted>
    </Card>
  );
}

/** La cotización en vivo: cuánto llega, la comisión, y QUIÉN la cobra. */
function Cotizacion({ quote }: { quote: Quote }) {
  return (
    <div>
      <Money moneda="S/" tono="verde">
        {quote.receive.major.toFixed(2)}
      </Money>
      <Muted escala="label" className="mt-ajustado">
        Es lo que le llega a quien recibe.
      </Muted>
      <div className="mt-normal">
        <Row label="Mandás" value={`${quote.send.major.toFixed(2)} USDC`} />
        <Row label="Comisión" value={`${quote.feeUsd.major.toFixed(2)} USDC`} />
        <Row
          label="La cobra"
          value={quote.agent?.slug ?? "No sabemos quién cotizó este envío."}
        />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3 · TU IDENTIDAD
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Sólo la primera vez (`AC-4`): quien ya se verificó nunca ve esta pantalla, y por eso el indicador
 * de progreso recibe el ITINERARIO y no la tabla.
 *
 * Dice qué se verifica, con quién, y —lo que importa para el invariante— que se sale a otra pantalla
 * Y SE VUELVE ACÁ MISMO. La vuelta del verificador aterriza en este paso, ⛔ no en el principio.
 */
export function PantallaIdentidad(p: {
  verificador: string;
  /** La pantalla del verificador, cuando el caso de uso ya la devolvió. `null` ⇒ todavía no se pidió. */
  destinoDelVerificador: string | null;
  enVuelo: boolean;
  motivo: string | null;
  onVerificar: () => void;
  onSalirAlVerificador: () => void;
  onVolver: () => void;
}) {
  return (
    <Card>
      <Encabezado
        titulo="Tu identidad"
        bajada="Una vez sola. Después de esto, tus próximos envíos no la vuelven a pedir."
      />
      <Motivo motivo={p.motivo} />
      {p.enVuelo ? <EnVuelo texto={TEXTO_EN_VUELO_IDENTIDAD} /> : null}
      <Aviso tono="neutro" className="mb-normal">
        <p className="text-body font-semibold text-ink">Qué se verifica</p>
        <Muted className="mt-ajustado">
          Un documento y una foto tuya, para que el banco de destino pueda acreditar el envío. Lo
          revisa {p.verificador}, no Chaski.
        </Muted>
        <Muted className="mt-ajustado">
          Se abre la pantalla del verificador y, cuando termines, volvés a este mismo paso.
        </Muted>
      </Aviso>
      <div className="space-y-ajustado">
        {/* 🔴 DOS FORMAS, Y LA SEGUNDA ES EL ARREGLO: antes esto era un `<Button>` que ⛔ NO llamaba a
            `startKyc` y avanzaba igual, o sea que daba la identidad por verificada sin verificar
            nada (AR/BLQ-ALTO-2). Hoy el botón PIDE la sesión de verificación y, cuando el caso de uso
            contesta con una pantalla a la que hay que ir, el control pasa a ser el enlace que la
            persona toca. */}
        <Salir
          destino={p.destinoDelVerificador}
          etiqueta="Verificar mi identidad"
          onPedir={p.onVerificar}
          onSalir={p.onSalirAlVerificador}
        />
        <Volver onVolver={p.onVolver} />
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4 · FIRMAR Y ENVIAR
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * QUÉ SE FIRMA, EXACTAMENTE, Y CUÁNTO SALE: el monto, la comisión y el alquiler que la red retiene
 * por las cuentas del envío. Y A DÓNDE VA LA PLATA.
 *
 * ⛔ EL NÚMERO DE FIRMAS NO SE ESCRIBE ACÁ NI EN NINGÚN LADO (`CD-W1-6`): el anuncio enumera las
 * firmas que el camino elegido va a pedir y muestra el largo de esa lista.
 *
 * El texto del alquiler se REUSA de (`escrowRentExplainer`, `../flow-vm.ts:426`) en su voz
 * `discovery`, que es la que describe el mecanismo sin afirmar que ya haya pasado: acá todavía no
 * pasó nada. ⛔ No se escribe una segunda explicación del mismo hecho.
 */
export function PantallaFirmar(p: {
  cotizacion: Quote | null;
  /** Los últimos dígitos de la cuenta de destino, o `""` si esta pestaña no los tiene. */
  destino: string;
  anuncio: Anuncio;
  /** A dónde hay que ir a firmar, cuando el caso de uso ya lo contestó. */
  destinoDelSalto: string | null;
  enVuelo: boolean;
  motivo: string | null;
  onFirmar: () => void;
  onSalirALaBilletera: () => void;
  onVolver: () => void;
}) {
  const alquiler = escrowRentExplainer("discovery");
  return (
    <Card>
      <Encabezado titulo="Firmar y enviar" bajada="Revisá lo que vas a firmar antes de salir." />
      <Motivo motivo={p.motivo} />
      {p.enVuelo ? <EnVuelo texto={TEXTO_EN_VUELO} /> : null}
      {p.cotizacion === null ? (
        <Muted>Todavía no tenemos la cotización de este envío.</Muted>
      ) : (
        <div>
          <Row label="Sale de tu billetera" value={`${p.cotizacion.send.major.toFixed(2)} USDC`} />
          <Row label="Comisión" value={`${p.cotizacion.feeUsd.major.toFixed(2)} USDC`} />
          <Row
            label="Llega a la cuenta"
            value={`S/ ${p.cotizacion.receive.major.toFixed(2)}`}
            accent
          />
        </div>
      )}
      {/* ⛔ SIN DÍGITOS NO SE ESCRIBE LA FRASE (AR/BLQ-BAJO-2). Acá quedaba «A dónde va: a la cuenta
          que termina en .» con el punto colgando cada vez que la vuelta de un salto remontaba el árbol
          y esta pestaña ya no tenía el envío. Una frase a la que le falta el dato no es una frase más
          corta: es una que dice algo que no sabe. */}
      {p.destino === "" ? null : (
        <Muted className="mt-normal">A dónde va: a la cuenta que termina en {p.destino}.</Muted>
      )}
      <Aviso tono="neutro" className="mt-normal">
        <p className="text-body font-semibold text-ink">{alquiler.title}</p>
        <Muted className="mt-ajustado">{alquiler.body}</Muted>
      </Aviso>
      <div className="mt-normal">
        <AnuncioDelSalto
          anuncio={p.anuncio}
          destino={p.destinoDelSalto}
          onPedir={p.onFirmar}
          onSalir={p.onSalirALaBilletera}
        />
      </div>
      <Volver onVolver={p.onVolver} />
      <Muted className="mt-normal">{NO_CUSTODIAL}</Muted>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5 · SEGUIMIENTO
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Dónde va el envío, y el recibo cuando cierra. Estado terminal del recorrido.
 *
 * La etiqueta y el tono salen de (`statusDisplay`, `../flow-vm.ts:133`), que es donde este repo ya
 * decide cómo se nombra cada estado: ⛔ acá no se inventa un vocabulario paralelo, y sobre todo no se
 * disfraza de entregado un estado que no llegó al recibo.
 */
export function PantallaSeguimiento(p: {
  remesa: RemittanceState | null;
  motivo: string | null;
  onVolver: () => void;
}) {
  const display = p.remesa === null ? null : statusDisplay(p.remesa.status);
  return (
    <Card>
      <Encabezado titulo="Seguimiento" bajada="Acá vas viendo dónde está tu envío." />
      <Motivo motivo={p.motivo} />
      {p.remesa === null || display === null ? (
        <Muted>Todavía no hay ningún envío en curso.</Muted>
      ) : (
        <div>
          <Pill tone={display.tone}>{display.label}</Pill>
          <div className="mt-normal">
            <Row label="Mandaste" value={`${p.remesa.sendUsd.major.toFixed(2)} USDC`} />
            <Row label="Recibe" value={p.remesa.beneficiary.name} />
            {p.remesa.deliveredPen === null ? null : (
              <Row
                label="Se acreditó"
                value={`S/ ${p.remesa.deliveredPen.major.toFixed(2)}`}
                accent
              />
            )}
          </div>
        </div>
      )}
      <div className="mt-holgado">
        <Volver onVolver={p.onVolver} />
      </div>
      <Muted className="mt-normal">{NO_CUSTODIAL}</Muted>
    </Card>
  );
}

/** Envoltura común de todas las pantallas: deja al anfitrión poner el indicador de progreso arriba
 *  sin que cada pantalla tenga que saber que existe. */
export function MarcoDelRecorrido({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-md space-y-normal p-holgado">{children}</div>;
}
