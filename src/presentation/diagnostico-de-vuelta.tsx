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
// 🔴 Y LA SEGUNDA VUELTA DEL INSTRUMENTO SALE DE QUE LA PRIMERA NO ALCANZÓ. Con el arreglo de la
// reanudación YA DESPLEGADO, la captura del teléfono del founder dijo `corte: sin corte`, `viaje=sí`,
// `viaje.paso: conectar`, chip de la billetera presente **y la pantalla en la BIENVENIDA**. O sea: la
// vuelta llegó, la conexión quedó, nadie produjo una causa, y la continuación no ocurrió. Ninguno de
// los campos de la primera versión separa las razones posibles de eso, y todas piden arreglos
// distintos. Los campos NUEVOS son exactamente los que las separan, y ninguno más:
//
//   viaje.remesa     ¿el viaje lleva `remittanceId`, y el repo local conoce esa remesa? Es el gate de
//                    (`remId`, `./flow.tsx:4010`): sin id el productor limpia la barra y **retorna en
//                    silencio**, que es la hipótesis número uno de una captura sin corte y sin
//                    pantalla nueva. Y el `status` del repo es la SEGUNDA fuente: el canal del enlace
//                    no la escribe, así que un id que el repo no conoce dice otra cosa que un id que
//                    sí — la reanudación de (`enCurso`, `./flow.tsx:4079`) además exige `confirmed`.
//   viaje.paso·edad  la edad del viaje contra su ventana de 20 min ((`MAX_EDAD_MS`,
//                    `../infrastructure/solana/deeplink/sesion.ts:111`)). ⛔ ESTE BLOQUE NO APLICA LA
//                    VENTANA (ver `presenciaEnElDisco`), así que un viaje VENCIDO sale `viaje=sí` acá
//                    y el productor lo trata como ausente: sin este número los dos casos se leen
//                    igual, y son el mismo retorno mudo por dos motivos distintos.
//   pop              el ancla de la prueba de posesión, que las CUATRO capturas del founder mostraron
//                    presente. (`leerPruebaPop`, `../infrastructure/solana/deeplink/pop-por-enlace.ts:398`)
//                    la CONSUME, y una que no sirva manda a la persona a firmar de nuevo en vez de
//                    seguir. ⚠️ EL ANCLA **NO TIENE** `remittanceId` —su forma entera está en
//                    (`PasoPop`, `../infrastructure/solana/deeplink/pop-por-enlace.ts:81`)—, así que
//                    «¿es de esta remesa?» NO SE PUEDE CONTESTAR y este bloque no lo finge. Lo que sí
//                    la scopea son otras tres cosas, y son las que se informan: el PROPÓSITO (un ancla
//                    de `pop-payout` no satisface un pedido de `pop-kyc` y viceversa, CD-15), la
//                    CUENTA (se compara contra la del viaje) y el `exp`.
//   pantalla         el `step` del recorrido, que es contra lo que hay que leer «estoy en la
//                    bienvenida». Sin él, «bienvenida» es una descripción de una foto y no un dato.
//   connect          el `estado` que devolvió `connectWallet.execute()` en la vuelta. Es lo que decide
//                    si el recorrido sigue o vuelve a saltar: `hay-que-salir` significa que
//                    (`alConectar`, `./flow.tsx:286`) navega a la billetera OTRA VEZ.
//   continuacion     el desenlace de `onConnect`, con sus cinco valores separados: no corrió · corrió
//                    y navegó a `<paso>` · cortó temprano con su motivo · salió a la billetera. Es la
//                    pregunta «¿la continuación ocurrió?» convertida en dato.
//   error            el código del último error que atrapó (`guard`, `./flow.tsx:300`). ⚠️ NO ES
//                    NUEVO EN LA PANTALLA: el banner de `./flow.tsx:1211` ya lo pinta con
//                    (`shortErrorCode`, `./flow-vm.ts:565`) — lo que cambia es DÓNDE, porque ese
//                    banner se pinta DEBAJO del contenido del paso y en la bienvenida queda fuera de
//                    la captura. Acá está arriba de todo. ⇒ exposición nueva: ninguna.
//
// Los campos de la primera versión que se quedan, con la pregunta que contestan:
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
// ⛔ Y DOS CAMPOS SE FUERON, porque una captura ilegible en un teléfono no sirve para nada:
// `preparado=` y `nonce=` valieron `no` en LAS CUATRO capturas del founder ⇒ no discriminan nada y
// ocupaban ancho. Con ellos también se fueron sus dos lecturas de disco.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ⛔ LAS TRES PROHIBICIONES, Y CÓMO ESTÁN CUMPLIDAS
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 1. ⛔ NINGÚN SECRETO. De todo el `Viaje` este archivo lee CUATRO campos —`paso`, `direccion`,
//    `remittanceId` y `desde`— y ⛔ jamás `secreta`, `session`, `claveBilletera`, `transaccionFirmada`
//    ni `firmaDePatrocinio`. Del ancla del PoP lee `proposito`, `direccion`, `exp` y la PRESENCIA de
//    `firma`/`consumido`, y ⛔ **nunca la firma ni el desafío**. Del blob del repo lee DOS campos:
//    el `id` —para compararlo, nunca para pintarlo— y el `status`, y ⛔ ni el beneficiario, ni el CCI,
//    ni la identidad, ni el monto. La dirección y el id de la remesa van enmascarados con la MISMA
//    receta que el chip del encabezado ((`address`, `./flow.tsx:713`)). Lo miden `T-DIAG-SECRETOS`
//    (los cinco del viaje), `T-DIAG-SECRETOS-3` (la PII del repo) y `T-DIAG-POP-SECRETO` (la firma).
//
// 2. ⛔ SIN EL PARÁMETRO, CERO RENDER Y CERO COMPORTAMIENTO. El componente devuelve `null` y no
//    ejecuta ninguna lectura: ni disco, ni `performance`, ni el `setTimeout` del techo, ni el
//    `setInterval` del refresco, y ⛔ **no registra un solo oyente** — las dos suscripciones se le
//    pasan apagadas a `useSyncExternalStore`. Lo miden `T-DIAG-APAGADO` (cero DOM, cero disco),
//    `T-DIAG-APAGADO-3` (cero oyentes) y `T-DIAG-APAGADO-4` (cero temporizadores).
//
// 3. ⛔ NO TOCA EL RECORRIDO. No llama a `completarVuelta` ni a nada que consuma una marca —consumir
//    una marca ajena **quema el paso** de otro consumidor, que es lo que
//    (`completarVuelta`, `../infrastructure/solana/deeplink/conexion.ts:254`) existe para impedir—,
//    no escribe disco, y ⛔ no usa los lectores del módulo (`leerViaje`, `leerPasoPop`), que LIMPIAN
//    el disco ante basura o ventana vencida, ni `leerPruebaPop`, que BORRA el ancla en el mismo gesto
//    en que la entrega. Lee el crudo con `getItem` y lo parsea acá. Lo mide `T-DIAG-OBSERVADOR`.
//
// ⚠️ EL REFRESCO PERIÓDICO ES NUEVO Y HACE FALTA, y conviene decir por qué antes de que parezca
// decorativo. La primera versión se re-renderizaba TRES veces (la disponibilidad, el techo, un corte),
// y todo lo que este bloque mira cambia DESPUÉS de eso: `leerPruebaPop` consume el ancla, el productor
// puede borrar el viaje, `onConnect` termina segundos más tarde. Una foto de los primeros 3 s no
// distingue «nunca pasó» de «pasó después de que dejé de mirar». Por eso el encabezado publica el
// instante de la foto: la captura se fecha a sí misma.
//
// ⚠️ DÓNDE SE MONTA Y POR QUÉ AHÍ: en `app/page.tsx`, HERMANO de `RemittanceFlow` y no adentro. Así
// `flow.tsx` —[[CENSO src/presentation/flow.tsx lineas=4453]] líneas y [[CENSO src/presentation/flow.tsx entrantes=153]] citas ancladas— no recibe ni una línea por este bloque. Lo que sí necesita de
// ahí adentro —la causa cruda del corte y los cuatro hitos del recorrido— entra por
// (`anotarCorteDeVuelta`, `./bitacora-de-vuelta.ts:43`) y (`anotarHito`, `./bitacora-de-vuelta.ts:101`),
// en líneas que ya existían.
//
// 🔴 EL LÍMITE MÁS IMPORTANTE DE ESTE BLOQUE, Y SALIÓ DE UNA MEDICIÓN, NO DE UN RAZONAMIENTO. Vive
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
import { KEY as CLAVE_DEL_REPO } from "../infrastructure/persistence";
import { type SolanaWalletAvailability, solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import {
  TECHO_DISPONIBILIDAD_MS,
} from "../infrastructure/solana/disponibilidad-decidible";
import { CLAVE_ELECCION, marcaDeVuelta } from "../infrastructure/solana/deeplink/conexion";
import { CLAVE_POP, MARCA_POP_KYC, MARCA_POP_PAYOUT } from "../infrastructure/solana/deeplink/pop-por-enlace";
import { CLAVE as CLAVE_DEL_VIAJE, MARCAS_DE_VUELTA, MAX_EDAD_MS } from "../infrastructure/solana/deeplink/sesion";
import { leerHito, suscribirAlCorteDeVuelta, ultimoCorteDeVuelta } from "./bitacora-de-vuelta";
import { deeplinkEnabled } from "./wallet-availability";

/** El nombre del parámetro que enciende el bloque. Un solo sitio de escritura: el test lo importa. */
export const PARAM_DIAG = "diag";
/** ⛔ IGUALDAD ESTRICTA CONTRA ESTE LITERAL, no «el parámetro está». Es el mismo opt-in estricto que
 *  (`deeplinkEnabled`, `./wallet-availability.ts:156`), y por la misma razón: no puede haber ningún
 *  valor que lo prenda por accidente en la URL de alguien que no lo pidió. */
export const VALOR_DIAG = "1";

/** Cada cuánto se vuelve a mirar el disco y los hitos. ⛔ Sólo con el parámetro puesto. Medio segundo
 *  es lo bastante fino para ver consumirse el ancla del PoP y lo bastante grueso para no ser un costo
 *  en un teléfono; y lo que hace legible a la captura no es el intervalo sino el instante publicado. */
export const REFRESCO_MS = 500;

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
 * Lo que se puede decir del ancla del PoP ⛔ SIN mirar la firma ni el desafío.
 *
 * 🔴 `cuenta` ES UN VEREDICTO Y NO UNA DIRECCIÓN, y eso es lo que permite compararla sin que ninguna
 * dirección cruda salga de este módulo: la comparación pasa adentro de `presenciaEnElDisco`, donde el
 * crudo del viaje y el del ancla están los dos en scope, y lo único que sobrevive es «misma» / «OTRA».
 */
export interface RetratoDelPop {
  /** `pop-kyc` / `pop-payout`, o `"?"` si no es ninguno de los dos. ⛔ Nunca un texto del disco. */
  proposito: string;
  /** Contra `Viaje.direccion`. `"?"` cuando no hay viaje o el viaje no trae dirección con qué cruzar. */
  cuenta: "misma" | "OTRA" | "?";
  /** PRESENCIA de la firma. ⛔ Nunca su valor. */
  firma: boolean;
  /** El anti-replay de la vuelta: un ancla ya consumida no vuelve a entregar nada. */
  usado: boolean;
  /**
   * Segundos que le faltan al `exp` (negativo = vencido), o `null` si el `exp` no es un número.
   *
   * ⚠️ SE COMPARA UN `exp` DEL **SERVIDOR** CONTRA EL RELOJ DE ESTE TELÉFONO, y eso hay que decirlo
   * antes de que alguien lea el número como un hecho: `PasoPop.exp` son segundos epoch que fija el
   * servidor ((`exp`, `../infrastructure/solana/deeplink/pop-por-enlace.ts:119`)), así que un teléfono
   * con el reloj corrido desplaza este campo entero. Sirve para ver un ancla claramente vieja, no
   * para autorizar nada — que es exactamente lo que ese docblock ya declara sobre el `exp`.
   */
  segundosAlExp: number | null;
}

/**
 * Lo que hay en el disco, SIN CONTENIDO salvo los campos que se declaran arriba.
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
  pop: boolean;
  /** `paso` del viaje, sólo si es una marca que este repo escribe. `null` si no hay viaje o no lo es. */
  pasoDelViaje: string | null;
  /** `direccion` del viaje YA ENMASCARADA (`6…4`). ⛔ Nunca la dirección completa. */
  direccionDelViaje: string | null;
  /**
   * `remittanceId` del viaje, **CRUDO**. ⛔ NO SE PINTA ASÍ: quien lo muestre lo enmascara. Se
   * devuelve entero porque hay que cruzarlo contra el blob del repo, y un id truncado no cruza.
   */
  remesaDelViaje: string | null;
  /** `ahora - viaje.desde`. `null` sin viaje o con un `desde` que no es finito. NEGATIVO = el viaje
   *  dice haber empezado en el futuro, que es el cuarto desenlace de `leerViaje` («no-fechable»). */
  edadDelViajeMs: number | null;
  /** `null` si no hay ancla; el retrato si la hay y parsea. Una que no parsea sale `pop: true` con
   *  este campo en `null`, que es lo mismo que el viaje de basura: estar y no poder leerse. */
  retratoDelPop: RetratoDelPop | null;
}

/** Qué sabe el repo LOCAL de la remesa que el viaje nombra. Es la SEGUNDA fuente del cruce: el canal
 *  del enlace no escribe este blob. */
export type EstadoEnElRepo =
  | { tipo: "sin-id" }
  | { tipo: "sin-blob" }
  | { tipo: "ilegible" }
  | { tipo: "no-esta" }
  | { tipo: "esta"; status: string };

/**
 * ⛔ LEE DOS CAMPOS DEL BLOB Y NINGUNO MÁS: el `id` —para COMPARARLO, nunca para devolverlo— y el
 * `status`. El blob del repo tiene beneficiario, CCI, identidad y montos; ⛔ nada de eso se toca, y
 * `T-DIAG-SECRETOS-3` lo mide sembrando esos campos con valores reconocibles.
 *
 * ⛔ Y NO USA `LocalRepo`, que es el lector del módulo: `read()` devuelve un Map VACÍO ante un blob
 * ilegible y ahí «no la encuentro» y «no puedo leer» se colapsan — las dos hipótesis que este campo
 * existe para separar. Es el mismo motivo por el que el viaje se parsea acá y no con `leerViaje`.
 */
export function estadoEnElRepo(crudo: string | null, id: string | null): EstadoEnElRepo {
  if (id === null) return { tipo: "sin-id" };
  if (crudo === null) return { tipo: "sin-blob" };
  let filas: unknown;
  try {
    filas = JSON.parse(crudo);
  } catch {
    return { tipo: "ilegible" };
  }
  if (!Array.isArray(filas)) return { tipo: "ilegible" };
  for (const fila of filas) {
    if (fila === null || typeof fila !== "object") continue;
    const f = fila as { id?: unknown; status?: unknown };
    if (f.id !== id) continue;
    return { tipo: "esta", status: typeof f.status === "string" ? f.status : "?" };
  }
  return { tipo: "no-esta" };
}

/**
 * El retrato del ancla del PoP. `null` cuando el crudo no parsea.
 *
 * ⚠️ RECIBE LA DIRECCIÓN CRUDA DEL VIAJE Y NO DEVUELVE NINGUNA: es el único punto donde las dos
 * direcciones se ven, y sale un veredicto de tres valores.
 */
export function retratoDelPop(crudo: string, direccionDelViaje: string | null, ahoraMs: number): RetratoDelPop | null {
  let a: { proposito?: unknown; direccion?: unknown; exp?: unknown; firma?: unknown; consumido?: unknown };
  try {
    a = JSON.parse(crudo);
  } catch {
    return null;
  }
  if (a === null || typeof a !== "object") return null;
  const proposito =
    a.proposito === MARCA_POP_KYC || a.proposito === MARCA_POP_PAYOUT ? a.proposito : "?";
  const cuenta: RetratoDelPop["cuenta"] =
    typeof a.direccion !== "string" || direccionDelViaje === null
      ? "?"
      : a.direccion === direccionDelViaje
        ? "misma"
        : "OTRA";
  return {
    proposito,
    cuenta,
    firma: typeof a.firma === "string" && a.firma !== "",
    usado: a.consumido === true,
    segundosAlExp: Number.isFinite(a.exp) ? Math.round((a.exp as number) - ahoraMs / 1000) : null,
  };
}

/** La MISMA receta que el chip del encabezado ((`address`, `./flow.tsx:713`)).
 *
 *  ⚠️ EL PISO DE 12 NO ES DECORATIVO: con menos caracteres los dos `slice` se SOLAPAN y el
 *  «enmascarado» devolvería el valor entero. Una dirección de Solana son 32-44 caracteres base58 y un
 *  id de remesa es un UUID de 36, así que el caso corto sólo llega desde un disco con basura — y ahí
 *  no se muestra nada. */
export function enmascarar(direccion: string): string {
  return direccion.length < 12
    ? `(inesperado, ${direccion.length} chars)`
    : `${direccion.slice(0, 6)}…${direccion.slice(-4)}`;
}

/** `4m12s` / `38s`. Se usa para la edad del viaje, que en un teléfono se lee mejor así que en ms. */
export function duracion(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * ⛔ LEE EL CRUDO Y NO USA NINGÚN LECTOR DEL MÓDULO. `leerViaje` y `leerPasoPop` BORRAN el disco ante
 * basura o ventana vencida, y `leerPruebaPop` BORRA el ancla en el mismo gesto en que la entrega. Un
 * observador que destruye lo que observa deja de serlo — y peor, se llevaría puesto el diagnóstico de
 * la carga siguiente, o le quemaría la prueba al recorrido real.
 *
 * ⛔ POR ESO TAMPOCO APLICA LA VENTANA DE 20 MINUTOS: informa lo que HAY en el disco, no lo que el
 * recorrido consideraría vigente. Un viaje presente pero vencido sale `viaje=sí` acá y aun así el
 * productor de montaje lo trataría como ausente. Esa diferencia es justamente lo que `edadDelViajeMs`
 * hace visible, y colapsarla acá borraría la distinción en vez de mostrarla.
 */
export function presenciaEnElDisco(leer: (clave: string) => string | null, ahoraMs: number): PresenciaEnElDisco {
  const vacio: PresenciaEnElDisco = {
    ilegible: true, viaje: false, eleccion: false, pop: false,
    pasoDelViaje: null, direccionDelViaje: null, remesaDelViaje: null, edadDelViajeMs: null,
    retratoDelPop: null,
  };
  let viajeCrudo: string | null;
  let eleccion: string | null;
  let pop: string | null;
  try {
    viajeCrudo = leer(CLAVE_DEL_VIAJE);
    eleccion = leer(CLAVE_ELECCION);
    pop = leer(CLAVE_POP);
  } catch {
    return vacio;
  }
  let pasoDelViaje: string | null = null;
  let direccionDelViaje: string | null = null;
  let direccionCruda: string | null = null;
  let remesaDelViaje: string | null = null;
  let edadDelViajeMs: number | null = null;
  if (viajeCrudo !== null) {
    try {
      // ⛔ SE DESESTRUCTURAN SÓLO CUATRO CAMPOS, y el resto del objeto no se toca ni se pasa a ningún
      // lado: es lo que hace imposible que un campo sensible llegue al DOM por descuido.
      const { paso, direccion, remittanceId, desde } = JSON.parse(viajeCrudo) as {
        paso?: unknown; direccion?: unknown; remittanceId?: unknown; desde?: unknown;
      };
      // ⚠️ SE VALIDA CONTRA `MARCAS_DE_VUELTA` Y NO CONTRA `PasoDelViaje`, que es el conjunto exacto.
      // El motivo es que `esPaso` no está exportado y exportarlo por esto sería tocar el recorrido;
      // `MARCAS_DE_VUELTA` es un SUPERCONJUNTO importado (contiene los tres pasos más las tres marcas
      // que no son pasos), así que lo que se pierde es poder gritar ante un `paso` que sea una marca
      // pero no un paso — un caso que ningún escritor de este repo produce. Lo que NO se pierde es lo
      // que importa: un `paso` de basura sale `"?"` y nunca se pinta un string arbitrario del disco.
      if (typeof paso === "string") {
        pasoDelViaje = (MARCAS_DE_VUELTA as readonly string[]).includes(paso) ? paso : "?";
      }
      if (typeof direccion === "string" && direccion !== "") {
        direccionCruda = direccion;
        direccionDelViaje = enmascarar(direccion);
      }
      // El MISMO predicado que (`remesaDelViaje`, `../infrastructure/solana/deeplink/conexion.ts:400`)
      // aplica antes de contestarle al productor de montaje: un `""` es peor que ausente. Si acá se
      // usara `typeof id === "string"` a secas, este campo diría «hay id» sobre el caso en que el
      // productor contesta `null` y retorna MUDO, o sea justo al revés de lo que hay que ver.
      if (typeof remittanceId === "string" && remittanceId !== "") remesaDelViaje = remittanceId;
      if (Number.isFinite(desde)) edadDelViajeMs = ahoraMs - (desde as number);
    } catch {
      pasoDelViaje = "?"; // un viaje que no parsea SÍ está en el disco: eso ya es información
    }
  }
  return {
    ilegible: false,
    viaje: viajeCrudo !== null,
    eleccion: eleccion !== null,
    pop: pop !== null,
    pasoDelViaje,
    direccionDelViaje,
    remesaDelViaje,
    edadDelViajeMs,
    retratoDelPop: pop === null ? null : retratoDelPop(pop, direccionCruda, ahoraMs),
  };
}

const si = (b: boolean): string => (b ? "sí" : "no");

/** El renglón `viaje.remesa`, con los cinco desenlaces separados. Se saca del componente para poder
 *  medirlo sin montar nada: es el campo del que cuelga la hipótesis número uno. */
export function renglonDeLaRemesa(disco: PresenciaEnElDisco, enElRepo: EstadoEnElRepo): string {
  if (!disco.viaje) return "—";
  if (disco.remesaDelViaje === null) return "SIN ID EN EL VIAJE · repo: —";
  const dice =
    enElRepo.tipo === "esta"
      ? enElRepo.status
      : enElRepo.tipo === "no-esta"
        ? "NO ESTÁ"
        : enElRepo.tipo === "ilegible"
          ? "ILEGIBLE"
          : "sin blob";
  return `${enmascarar(disco.remesaDelViaje)} · repo: ${dice}`;
}

/** El renglón `pop`. `—` cuando no hay ancla; `ILEGIBLE` cuando la hay y no parsea. */
export function renglonDelPop(disco: PresenciaEnElDisco): string {
  if (!disco.pop) return "—";
  const r = disco.retratoDelPop;
  if (r === null) return "ILEGIBLE (hay ancla y no parsea)";
  const exp =
    r.segundosAlExp === null
      ? "exp=?"
      : r.segundosAlExp < 0
        ? `exp=VENCIDO(-${duracion(r.segundosAlExp * 1000)})`
        : `exp=vigente(+${duracion(r.segundosAlExp * 1000)})`;
  return `${r.proposito} cuenta=${r.cuenta} firma=${si(r.firma)} usado=${si(r.usado)} ${exp}`;
}

/** El renglón `viaje.paso`, con la edad contra la ventana que el productor sí aplica. */
export function renglonDelPaso(disco: PresenciaEnElDisco): string {
  if (disco.pasoDelViaje === null) return "—";
  const ventana = `ventana ${duracion(MAX_EDAD_MS)}`;
  if (disco.edadDelViajeMs === null) return `${disco.pasoDelViaje} · edad ? (${ventana})`;
  if (disco.edadDelViajeMs < 0) return `${disco.pasoDelViaje} · EMPEZÓ EN EL FUTURO (+${duracion(disco.edadDelViajeMs)})`;
  const juicio = disco.edadDelViajeMs > MAX_EDAD_MS ? "VENCIDO" : "vigente";
  return `${disco.pasoDelViaje} · edad ${duracion(disco.edadDelViajeMs)} (${ventana}) ⇒ ${juicio}`;
}

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
  // 🔴 EL INSTANTE DE LA FOTO, Y ES LO QUE HACE QUE EL REFRESCO SEA MEDIBLE Y NO UN LATIDO INVISIBLE.
  // Se publica en el encabezado: sin él, una captura que dice `pop=sí` no distingue «el ancla sigue
  // ahí a los 12 s» de «la miré a los 300 ms y nadie la había consumido todavía».
  // 🔴 UN CONTADOR JUNTO AL INSTANTE, Y NO EL INSTANTE SOLO. MEDIDO, no razonado: con
  // `useState(0)` + `setMsFoto(Math.round(performance.now()))`, dos ticks que caen dentro del MISMO
  // milisegundo redondeado le pasan a React el MISMO valor, React descarta el re-render y el bloque se
  // queda con la foto vieja. El síntoma es un `it` que falla 1 de cada N —lo cazó el barrido de
  // mutación de esta HU, no un razonamiento—, y en producción sería peor que un test flaky: sería una
  // captura que dice `pop=sí` cuando el ancla ya no está. Un objeto nuevo por tick no puede colisionar.
  const [refresco, setRefresco] = useState({ n: 0, ms: 0 });
  useEffect(() => {
    if (pedido) setMontado(true);
  }, [pedido]);
  useEffect(() => {
    if (!pedido || disponibilidad === "unknown") return;
    setMsDecision((v) => (v === null ? Math.round(performance.now()) : v));
  }, [pedido, disponibilidad]);
  useEffect(() => {
    // El temporizador del techo, y sólo con el parámetro puesto: sin él la rama «todavía sin decidir»
    // nunca se re-renderiza y no se podría distinguir de «sin decidir al vencer el techo».
    if (!pedido) return;
    const t = setTimeout(() => setVencioElTecho(true), TECHO_DISPONIBILIDAD_MS);
    return () => clearTimeout(t);
  }, [pedido]);
  useEffect(() => {
    // ⛔ EL REFRESCO, Y TAMBIÉN SÓLO CON EL PARÁMETRO. Todo lo que este bloque mira cambia DESPUÉS de
    // los primeros segundos —`leerPruebaPop` consume el ancla, el productor puede borrar el viaje,
    // `onConnect` termina más tarde—, y sin esto la captura sería una foto de los primeros 3 s que no
    // separa «nunca pasó» de «pasó después». Lo mide `T-DIAG-APAGADO-4` por el lado de que no existe
    // sin el parámetro, y `T-DIAG-REFRESCO` por el lado de que sí refresca.
    if (!pedido) return;
    const tomar = () => setRefresco((f) => ({ n: f.n + 1, ms: Math.round(performance.now()) }));
    tomar();
    const t = setInterval(tomar, REFRESCO_MS);
    return () => clearInterval(t);
  }, [pedido]);

  if (!pedido || !montado || foto.current === null) return null;

  const disco = presenciaEnElDisco((k) => window.localStorage.getItem(k), Date.now());
  let crudoDelRepo: string | null = null;
  try {
    crudoDelRepo = window.localStorage.getItem(CLAVE_DEL_REPO);
  } catch {
    crudoDelRepo = null; // un disco que no se deja leer ya salió declarado en `disco.ilegible`
  }
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
      {`DIAG · vuelta por enlace · foto t=${refresco.ms} ms
marca al montar : ${foto.current.marca ?? "sin marca"}
disponibilidad  : ${disponibilidad} · ${decision}
disco           : ${disco.ilegible ? "ILEGIBLE (no se pudo preguntar)" : `viaje=${si(disco.viaje)} eleccion=${si(disco.eleccion)} pop=${si(disco.pop)}`}
viaje.paso      : ${renglonDelPaso(disco)}
viaje.direccion : ${disco.direccionDelViaje ?? "—"}
viaje.remesa    : ${renglonDeLaRemesa(disco, estadoEnElRepo(crudoDelRepo, disco.remesaDelViaje))}
pop             : ${renglonDelPop(disco)}
pantalla        : ${leerHito("pantalla") ?? "—"}
connect         : ${leerHito("connect") ?? "no corrió"}
continuacion    : ${leerHito("continuacion") ?? "no corrió"}
corte           : ${corte ?? "sin corte"}
error           : ${leerHito("error") ?? "sin error"}
enlace          : ${deeplinkEnabled() ? "on" : "off"} · cluster: ${resolveSolanaNetworkConfig().cluster}`}
    </pre>
  );
}
