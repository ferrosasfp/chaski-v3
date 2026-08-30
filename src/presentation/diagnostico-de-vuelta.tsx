"use client";
// HU-075/diagnóstico — EL BLOQUE QUE HACE VISIBLE LA VUELTA POR ENLACE, DETRÁS DE UN PARÁMETRO DE URL.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 POR QUÉ EXISTE, Y QUÉ PREGUNTA CONTESTA CADA CAMPO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// El reporte de campo es: «lo intenté por phantom, por solflare y nada, después de darle aceptar a la
// firma de conección me vota a la página principal». Falla con las DOS billeteras, el servidor no
// registra ningún 4xx/5xx, y el productor de montaje tiene un retorno **MUDO**
// ((`remId`, `./flow.tsx:4010`)) que termina exactamente igual que un corte que nadie leyó: sin
// banner y en la pantalla de entrada. Desde afuera esos dos casos son indistinguibles, y por eso tres
// arreglos seguidos (la carrera de arranque, los guards del reloj, el aviso que expulsaba) no
// movieron el síntoma: ninguno estaba mirando la rama que se ejecuta.
//
// Este bloque no arregla nada. Hace **distinguibles** esos casos en UNA captura de pantalla:
//
//   marca al montar  ¿la billetera volvió a NUESTRA página con NUESTRA marca?  Si dice «sin marca»,
//                    el problema está antes de esta app (el `redirect_link` no se respetó o se
//                    perdió) y todo lo de abajo es ruido.
//   disponibilidad   ¿la carrera de arranque quedó cerrada en ESTE teléfono? Es el único campo que
//                    mide el arreglo anterior en el aparato de la persona y no en la suite.
//   disco            ¿este navegador es el MISMO que empezó el viaje? `viaje=no` con `eleccion=no` es
//                    un `localStorage` vacío —otra partición de almacenamiento, u otro navegador—, y
//                    `viaje=no` con `eleccion=sí` es un viaje que murió en un disco que sí es nuestro.
//                    Esas dos hipótesis piden arreglos distintos y ningún otro campo las separa.
//   viaje            ¿el connect llegó a completarse en el disco? La `direccion` la escribe la vuelta
//                    del connect, así que su presencia dice que el sobre abrió aunque la pantalla no
//                    muestre nada.
//   corte            ¿el recorrido produjo una causa? «sin corte» convierte «no vi ningún error» de
//                    reporte humano en medición, que es lo que separa el retorno mudo de un corte.
//   enlace/cluster   ¿la bandera del BUILD que sirve este dominio está prendida, y qué red se le pide
//                    a la billetera? Las dos son propiedades del artefacto desplegado, que nadie
//                    midió, y una `NEXT_PUBLIC_` no se lee en runtime: se inlinea en el build.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ⛔ LAS TRES PROHIBICIONES, Y CÓMO ESTÁN CUMPLIDAS
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 1. ⛔ NINGÚN SECRETO. De todo el `Viaje` este archivo lee DOS campos —`paso` y `direccion`— y
//    ⛔ jamás `secreta`, `session`, `claveBilletera`, `transaccionFirmada` ni `firmaDePatrocinio`.
//    De las otras cuatro claves del recorrido no lee **nada**: sólo si el `getItem` devolvió algo, o
//    sea un booleano. La dirección va enmascarada con la MISMA receta que el chip del encabezado
//    ((`address`, `./flow.tsx:713`)). Lo mide `T-DIAG-SECRETOS`, que le siembra al disco un viaje con
//    los cinco campos sensibles poblados y exige que ninguno aparezca en el DOM.
//
// 2. ⛔ SIN EL PARÁMETRO, CERO RENDER Y CERO COMPORTAMIENTO. El componente devuelve `null` y no
//    ejecuta ninguna lectura: ni disco, ni `performance`, ni el `setTimeout` del techo, y ⛔ **no
//    registra un solo oyente** — las dos suscripciones se le pasan apagadas a `useSyncExternalStore`.
//    Lo miden `T-DIAG-APAGADO` (cero DOM, cero disco) y `T-DIAG-APAGADO-3` (cero oyentes).
//
// 3. ⛔ NO TOCA EL RECORRIDO. No llama a `completarVuelta` ni a nada que consuma una marca —consumir
//    una marca ajena **quema el paso** de otro consumidor, que es lo que
//    (`completarVuelta`, `../infrastructure/solana/deeplink/conexion.ts:254`) existe para impedir—,
//    no escribe disco, y ⛔ no usa los lectores del módulo (`leerViaje`, `leerPasoDelNonce`), que
//    LIMPIAN el disco ante basura o ventana vencida. Lee el crudo con `getItem` y lo parsea acá.
//    Lo mide `T-DIAG-OBSERVADOR`.
//
// ⚠️ DÓNDE SE MONTA Y POR QUÉ AHÍ: en `app/page.tsx`, HERMANO de `RemittanceFlow` y no adentro. Así
// `flow.tsx` —[[CENSO src/presentation/flow.tsx lineas=4421]] líneas y [[CENSO src/presentation/flow.tsx entrantes=149]] citas ancladas— no recibe ni una línea por este bloque. La única cosa
// que sí necesita de ahí adentro es la causa cruda del corte, y eso entra por
// (`anotarCorteDeVuelta`, `./bitacora-de-vuelta.ts:43`), en la línea que ya existía.
//
// ⛔ EL LÍMITE MÁS IMPORTANTE DE ESTE BLOQUE, Y SALIÓ DE UNA MEDICIÓN, NO DE UN RAZONAMIENTO. Vive
// adentro de `<Providers>`, que monta su subárbol con `next/dynamic({ssr:false})`
// (`providers.tsx:6`). MEDIDO sobre el artefacto que el servidor sirve: el HTML prerenderizado de `/`
// (`.next/server/app/index.html`) **no contiene ni `data-diag`, ni «Empezar un envío», ni «Conectá tu
// wallet»** ⇒ nada de la app se renderiza en el servidor, y este bloque tampoco.
// ⇒ SI EL CHUNK DE `SolanaProviders` NO CARGA, ESTE BLOQUE TAMPOCO SE PINTA. Ese caso es real y está
// escrito en (`esperarDisponibilidadDecidible`, `../infrastructure/solana/disponibilidad-decidible.ts:72`),
// y su síntoma es una **página en blanco**, no un bloque que dice poco. ⛔ Quien pida la captura tiene
// que saberlo: «no aparece nada» y «aparece y dice X» son dos reportes distintos, y el primero NO
// significa que el bloque no funcione.
//
// ⚠️ EL PARÁMETRO SOBREVIVE AL VIAJE REDONDO, y eso es lo que hace usable a este bloque: el
// `redirect_link` lo arma (`enlaceDeVuelta`, `../infrastructure/solana/deeplink/sesion.ts:495`) sobre
// `window.location.href` y sólo borra los parámetros de respuesta más la marca, y la limpieza de la
// barra ((`hrefSinRastroDeVuelta`, `../infrastructure/solana/deeplink/conexion.ts:362`)) borra
// exactamente los mismos. O sea que quien abre la app con el parámetro puesto lo sigue teniendo
// cuando vuelve de la billetera. Lo mide `T-DIAG-VIAJE-REDONDO`.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { resolveSolanaNetworkConfig } from "../infrastructure/chain";
import { type SolanaWalletAvailability, solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import {
  TECHO_DISPONIBILIDAD_MS,
} from "../infrastructure/solana/disponibilidad-decidible";
import { CLAVE_ELECCION, CLAVE_NONCE, marcaDeVuelta } from "../infrastructure/solana/deeplink/conexion";
import { CLAVE as CLAVE_DEL_PREPARADO } from "../infrastructure/solana/deeplink/preparado";
import { CLAVE_POP } from "../infrastructure/solana/deeplink/pop-por-enlace";
import { CLAVE as CLAVE_DEL_VIAJE, MARCAS_DE_VUELTA } from "../infrastructure/solana/deeplink/sesion";
import { suscribirAlCorteDeVuelta, ultimoCorteDeVuelta } from "./bitacora-de-vuelta";
import { deeplinkEnabled } from "./wallet-availability";

/** El nombre del parámetro que enciende el bloque. Un solo sitio de escritura: el test lo importa. */
export const PARAM_DIAG = "diag";
/** ⛔ IGUALDAD ESTRICTA CONTRA ESTE LITERAL, no «el parámetro está». Es el mismo opt-in estricto que
 *  (`deeplinkEnabled`, `./wallet-availability.ts:156`), y por la misma razón: no puede haber ningún
 *  valor que lo prenda por accidente en la URL de alguien que no lo pidió. */
export const VALOR_DIAG = "1";

/** ¿Esta URL pide el bloque? **PURA**, y `false` ante un href que no parsea (no se puede afirmar que
 *  lo pida algo que no se puede leer). */
export function diagnosticoPedido(href: string): boolean {
  try {
    return new URL(href).searchParams.get(PARAM_DIAG) === VALOR_DIAG;
  } catch {
    return false;
  }
}

/**
 * Lo que hay en el disco, SIN CONTENIDO salvo los dos campos que se declaran arriba.
 *
 * `ilegible: true` es el tercer valor que un booleano perdería: un `localStorage` que no se deja leer
 * (modo privado, cookies bloqueadas) NO es «no hay nada guardado», y confundirlos acá haría que el
 * bloque afirmara un disco vacío —la hipótesis de la partición distinta— cuando lo que pasó es que no
 * pudimos preguntar. Es la misma disciplina que
 * (`MotivoParaNoMostrar`, `./splash-puerta.ts:68`) ya tiene escrita.
 */
export interface PresenciaEnElDisco {
  ilegible: boolean;
  viaje: boolean;
  eleccion: boolean;
  preparado: boolean;
  nonce: boolean;
  pop: boolean;
  /** `paso` del viaje, sólo si es una marca que este repo escribe. `null` si no hay viaje o no lo es. */
  pasoDelViaje: string | null;
  /** `direccion` del viaje YA ENMASCARADA (`6…4`). ⛔ Nunca la dirección completa. */
  direccionDelViaje: string | null;
}

/** La MISMA receta que el chip del encabezado ((`address`, `./flow.tsx:713`)).
 *
 *  ⚠️ EL PISO DE 12 NO ES DECORATIVO: con menos caracteres los dos `slice` se SOLAPAN y el
 *  «enmascarado» devolvería el valor entero. Una dirección de Solana son 32-44 caracteres base58, así
 *  que el caso corto sólo llega desde un disco con basura — y ahí no se muestra nada. */
export function enmascarar(direccion: string): string {
  return direccion.length < 12
    ? `(inesperado, ${direccion.length} chars)`
    : `${direccion.slice(0, 6)}…${direccion.slice(-4)}`;
}

/**
 * ⛔ LEE EL CRUDO Y NO USA NINGÚN LECTOR DEL MÓDULO. `leerViaje` y `leerPasoDelNonce` BORRAN el disco
 * ante basura o ventana vencida, y un observador que destruye lo que observa deja de serlo — y peor,
 * se llevaría puesto el diagnóstico de la carga siguiente.
 *
 * ⛔ POR ESO TAMPOCO MIRA LA VENTANA DE 20 MINUTOS: informa lo que HAY en el disco, no lo que el
 * recorrido consideraría vigente. Un viaje presente pero vencido sale `viaje=sí` acá y aun así el
 * productor de montaje lo trataría como ausente. Esa diferencia se lee cruzando este campo con
 * `corte`, y colapsarla acá borraría justamente la distinción.
 */
export function presenciaEnElDisco(leer: (clave: string) => string | null): PresenciaEnElDisco {
  const vacio: PresenciaEnElDisco = {
    ilegible: true, viaje: false, eleccion: false, preparado: false, nonce: false, pop: false,
    pasoDelViaje: null, direccionDelViaje: null,
  };
  let viajeCrudo: string | null;
  let eleccion: string | null;
  let preparado: string | null;
  let nonce: string | null;
  let pop: string | null;
  try {
    viajeCrudo = leer(CLAVE_DEL_VIAJE);
    eleccion = leer(CLAVE_ELECCION);
    preparado = leer(CLAVE_DEL_PREPARADO);
    nonce = leer(CLAVE_NONCE);
    pop = leer(CLAVE_POP);
  } catch {
    return vacio;
  }
  let pasoDelViaje: string | null = null;
  let direccionDelViaje: string | null = null;
  if (viajeCrudo !== null) {
    try {
      // ⛔ SE DESESTRUCTURAN SÓLO DOS CAMPOS, y el resto del objeto no se toca ni se pasa a ningún
      // lado: es lo que hace imposible que un campo sensible llegue al DOM por descuido.
      const { paso, direccion } = JSON.parse(viajeCrudo) as { paso?: unknown; direccion?: unknown };
      // ⚠️ SE VALIDA CONTRA `MARCAS_DE_VUELTA` Y NO CONTRA `PasoDelViaje`, que es el conjunto exacto.
      // El motivo es que `esPaso` no está exportado y exportarlo por esto sería tocar el recorrido;
      // `MARCAS_DE_VUELTA` es un SUPERCONJUNTO importado (contiene los tres pasos más las tres marcas
      // que no son pasos), así que lo que se pierde es poder gritar ante un `paso` que sea una marca
      // pero no un paso — un caso que ningún escritor de este repo produce. Lo que NO se pierde es lo
      // que importa: un `paso` de basura sale `"?"` y nunca se pinta un string arbitrario del disco.
      if (typeof paso === "string") {
        pasoDelViaje = (MARCAS_DE_VUELTA as readonly string[]).includes(paso) ? paso : "?";
      }
      if (typeof direccion === "string" && direccion !== "") direccionDelViaje = enmascarar(direccion);
    } catch {
      pasoDelViaje = "?"; // un viaje que no parsea SÍ está en el disco: eso ya es información
    }
  }
  return {
    ilegible: false,
    viaje: viajeCrudo !== null,
    eleccion: eleccion !== null,
    preparado: preparado !== null,
    nonce: nonce !== null,
    pop: pop !== null,
    pasoDelViaje,
    direccionDelViaje,
  };
}

const si = (b: boolean): string => (b ? "sí" : "no");

/** ⛔ LA SUSCRIPCIÓN QUE NO SUSCRIBE. `useSyncExternalStore` exige un `subscribe`, y ésta es la forma
 *  de dárselo sin registrar nada cuando el bloque está apagado. Devuelve el desuscriptor que su
 *  contrato pide. */
const NO_SUSCRIBIR = (): (() => void) => () => {};
/** Los `getSnapshot` del caso apagado. Devuelven PRIMITIVOS estables: un objeto nuevo por llamada haría
 *  que React entrara en un bucle de re-render, que es el modo de falla clásico de este hook. */
const DISPONIBILIDAD_SIN_MEDIR = (): SolanaWalletAvailability => "unknown";
const SIN_CORTE = (): string | null => null;
/** ⛔ EL MISMO SINGLETON QUE LEE (`useWalletAvailability`, `./wallet-availability.ts:36`), no una
 *  segunda opinión: son literalmente sus dos funciones. Lo que cambia acá es sólo CUÁNDO se suscribe. */
const SUSCRIBIR_DISPONIBILIDAD = (f: () => void): (() => void) =>
  solanaWalletBridge.subscribeWalletAvailability(f);
const LEER_DISPONIBILIDAD = (): SolanaWalletAvailability => solanaWalletBridge.getWalletAvailability();

/**
 * ⚠️ LA MARCA SE CAPTURA EN EL PRIMER RENDER Y NO EN UN EFECTO, y ésa es la única razón por la que
 * este campo sirve para algo: el paso 2 del productor de montaje
 * ((`limpiarLaBarra`, `./flow.tsx:4023`)) BORRA la marca de la barra con `replaceState`, así que una
 * lectura tardía diría «sin marca» **siempre**, incluidas todas las vueltas que sí funcionaron. El
 * primer render de cualquier componente del árbol ocurre antes de que corra un solo `useEffect`, así
 * que esta captura no depende del orden entre hermanos.
 *
 * ⛔ `marcaDeVuelta` es el lector PURO del módulo (su docblock:
 * (`marcaDeVuelta`, `../infrastructure/solana/deeplink/conexion.ts:338`) lo declara: no toca el disco
 * y no consume nada), así que llamarlo acá no rompe DT-12 ni le quita la vuelta a nadie.
 */
export function DiagnosticoDeVuelta(): React.JSX.Element | null {
  // ── Hooks, TODOS incondicionales y antes de cualquier salida ────────────────────────────────────
  //
  // 🔴 EL `useRef` VA PRIMERO A PROPÓSITO: es lo que permite que `pedido` esté decidido ANTES de las
  // dos suscripciones, y con eso ⛔ **sin el parámetro no se registra un solo oyente**. Con
  // `useWalletAvailability()` a secas —que es lo que había acá— el bloque le agregaba un listener al
  // bridge en CADA carga de página de CADA persona, y cada cambio de disponibilidad disparaba un
  // `setState` sobre un componente que pinta `null`. Es un costo despreciable, y aun así es un
  // comportamiento, o sea justo lo que la condición para desplegar esto un domingo dice que no hay.
  // ⛔ Un `if` alrededor de un hook no sirve (React exige el mismo ORDEN, siempre); lo que sí se puede
  // es pasarle a `useSyncExternalStore` una suscripción que no suscribe. Lo mide `T-DIAG-APAGADO-3`.
  const foto = useRef<{ pedido: boolean; marca: string | null; msMontaje: number } | null>(null);
  if (foto.current === null && typeof window !== "undefined") {
    const href = window.location.href;
    const pedido = diagnosticoPedido(href);
    // ⛔ NADA MÁS SE EJECUTA SIN EL PARÁMETRO: ni `marcaDeVuelta`, ni `performance`, ni el disco.
    foto.current = pedido
      ? { pedido, marca: marcaDeVuelta(href), msMontaje: Math.round(performance.now()) }
      : { pedido, marca: null, msMontaje: 0 };
  }
  const pedido = foto.current?.pedido === true;
  // Las cuatro funciones son CONSTANTES DE MÓDULO y no lambdas de render: `useSyncExternalStore`
  // re-suscribe cuando la identidad de `subscribe` cambia, y `pedido` no cambia después del primer
  // render, así que acá no hay re-suscripciones.
  const disponibilidad = useSyncExternalStore(
    pedido ? SUSCRIBIR_DISPONIBILIDAD : NO_SUSCRIBIR,
    pedido ? LEER_DISPONIBILIDAD : DISPONIBILIDAD_SIN_MEDIR,
    DISPONIBILIDAD_SIN_MEDIR, // en el servidor, «no lo medimos» — nunca «no hay» (`wallet-availability.ts:33`)
  );
  const corte = useSyncExternalStore(
    pedido ? suscribirAlCorteDeVuelta : NO_SUSCRIBIR,
    pedido ? ultimoCorteDeVuelta : SIN_CORTE,
    SIN_CORTE,
  );
  // `montado` existe para que el HTML del servidor y el del primer render del cliente sean los dos
  // `null`: sin él, con el parámetro puesto el servidor pintaría `""` y el primer render del cliente
  // el bloque, o sea un desajuste de hidratación en cada carga. ⚠️ HOY ESE CASO NO SE DA EN EL ÁRBOL
  // REAL Y ESTÁ MEDIDO: `.next/server/app/index.html` no contiene `data-diag` ni un solo control de la
  // pantalla, porque `Providers` monta el subárbol con `next/dynamic({ssr:false})`
  // (`providers.tsx:6`) y eso lo saltea entero en el SSR. ⇒ `montado` y el `typeof window` de arriba
  // son defensas contra que esa composición cambie, no contra algo que pase hoy. Lo declaro acá en vez
  // de dejar que alguien lo lea como necesidad, y `T-DIAG-HIDRATACION` mide `montado` con un fixture
  // sintético, que es lo que corresponde a una defensa cuyo caso el árbol no tiene.
  const [montado, setMontado] = useState(false);
  const [vencioElTecho, setVencioElTecho] = useState(false);
  const [msDecision, setMsDecision] = useState<number | null>(null);
  useEffect(() => {
    if (pedido) setMontado(true);
  }, [pedido]);
  useEffect(() => {
    if (!pedido || disponibilidad === "unknown") return;
    setMsDecision((v) => (v === null ? Math.round(performance.now()) : v));
  }, [pedido, disponibilidad]);
  useEffect(() => {
    // El único temporizador, y sólo con el parámetro puesto: sin él la rama «todavía sin decidir»
    // nunca se re-renderiza y no se podría distinguir de «sin decidir al vencer el techo».
    if (!pedido) return;
    const t = setTimeout(() => setVencioElTecho(true), TECHO_DISPONIBILIDAD_MS);
    return () => clearTimeout(t);
  }, [pedido]);

  if (!pedido || !montado || foto.current === null) return null;

  const disco = presenciaEnElDisco((k) => window.localStorage.getItem(k));
  const decision =
    msDecision === null
      ? vencioElTecho
        ? `sin decidir al vencer el techo (${TECHO_DISPONIBILIDAD_MS} ms)`
        : "todavía sin decidir"
      : // ⚠️ SI YA ESTABA DECIDIDA CUANDO ESTE BLOQUE MONTÓ, NO SE AFIRMA HABER MEDIDO LA CARRERA: el
        // número sería el del montaje y no el de la transición, o sea una carrera que se ve más rápida
        // de lo que fue. Se dice cuál de las dos cosas se está informando.
        msDecision <= foto.current.msMontaje
        ? `ya decidida al montar el bloque (${msDecision} ms)`
        : `decidida a los ${msDecision} ms (techo ${TECHO_DISPONIBILIDAD_MS})`;

  return (
    <pre
      data-diag="bloque"
      style={{
        margin: 0,
        padding: "10px 12px",
        background: "#111",
        color: "#c9f77c",
        font: "600 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {`DIAG · vuelta por enlace
marca al montar : ${foto.current.marca ?? "sin marca"}
disponibilidad  : ${disponibilidad} · ${decision}
disco           : ${disco.ilegible ? "ILEGIBLE (no se pudo preguntar)" : `viaje=${si(disco.viaje)} eleccion=${si(disco.eleccion)} preparado=${si(disco.preparado)} nonce=${si(disco.nonce)} pop=${si(disco.pop)}`}
viaje.paso      : ${disco.pasoDelViaje ?? "—"}
viaje.direccion : ${disco.direccionDelViaje ?? "—"}
corte           : ${corte ?? "sin corte"}
enlace          : ${deeplinkEnabled() ? "on" : "off"} · cluster: ${resolveSolanaNetworkConfig().cluster}`}
    </pre>
  );
}
