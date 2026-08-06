// Didit environment — ÚNICA fuente de verdad del host de Didit para TODO el repo.
//
// ⚠️ POR QUÉ EXISTE ESTE MÓDULO (incidente de config, eje PII):
// hasta este fix el MISMO literal estaba duplicado en 3 lugares de este repo:
//   · app/api/kyc/session/route.ts    → crea sesiones de verificación
//   · app/api/kyc/decision/route.ts   → lee decisiones (con PII)
//   · src/infrastructure/payout/authority.ts → re-valida el KYC del payout
// los tres con `process.env.DIDIT_BASE_URL ?? "https://verification.didit.me"`. O sea: sin ninguna
// env seteada, el default apuntaba a la PRODUCCIÓN de Didit. Es la misma forma de defecto que el
// incidente de TransFi (ver el exemplar `transfi-env.ts` de wasiai-remittance-agents), pero el eje
// que pone en riesgo NO es plata: son DOCUMENTOS DE IDENTIDAD de personas reales. Una corrida mal
// configurada (un preview de Vercel que hereda las envs de producción, un e2e con la key real)
// creaba verificaciones DE VERDAD, con PII real, contra la cuenta productiva y consumiendo cuota.
//
// Las 3 reglas de este módulo (en orden de importancia):
//  1. FAIL-CLOSED: sin `DIDIT_ENV` explícita NO se resuelve ningún host. Un servicio que no sabe
//     contra qué API de identidad habla no debe hablar. NUNCA se infiere el ambiente en silencio.
//  2. UNA SOLA FUENTE: `resolveDiditBaseUrl()` es la ÚNICA forma de obtener un host de Didit.
//     Está garantizado POR EL COMPILADOR: los call sites usan un `DiditBaseUrl` (tipo BRANDED) y
//     solo esta función puede producir uno. Un `string` cualquiera (un default nuevo, un literal
//     hardcodeado) NO compila. Los 3 call sites no pueden divergir por construcción.
//  3. El override `DIDIT_BASE_URL` NO puede CONTRADECIR a `DIDIT_ENV`: declarar `mock` y apuntar al
//     host real de Didit es un throw, no una advertencia.
//
// 🔴 DIFERENCIA DELIBERADA CON EL EXEMPLAR DE TRANSFI — leer antes de "arreglar" esto:
// TransFi publica DOS hosts (`sandbox-api.transfi.com` / `api.transfi.com`), así que allá el
// ambiente SELECCIONA un host. **Didit no publica un host de sandbox.** Su modo de prueba es el
// free tier (500 verificaciones/mes) sobre EL MISMO host productivo, separado por API key +
// workflow, no por URL (ver `.env.example`, sección KYC). Por eso acá los valores NO son
// `sandbox|production`: inventar un `https://sandbox-verification.didit.me` sería fabricar un
// endpoint de un tercero que no existe, y el fix quedaría peor que el bug (todo apuntando a un
// host que no resuelve). El conjunto honesto es:
//   · `live` → el host real de Didit. Consume cuota y crea verificaciones REALES.
//   · `mock` → un endpoint NUESTRO (mock local / CI). Exige `DIDIT_BASE_URL`, porque no hay
//              ningún host canónico de mock que se pueda asumir.
// La separación free-tier vs producción sigue viviendo donde Didit la puso: en `DIDIT_API_KEY` y
// `DIDIT_WORKFLOW_ID`. Este módulo agrega el eje que faltaba (la INTENCIÓN de hablarle a Didit),
// no reemplaza a ese.

/** Ambientes de Didit. Conjunto CERRADO: no existe "sandbox" (Didit no publica uno), ni "staging". */
export type DiditEnvironment = "mock" | "live";

// Brand nominal: `DiditBaseUrl` es asignable a `string`, pero un `string` NO es asignable a
// `DiditBaseUrl`. Es lo que hace imposible (a nivel de tipos) un segundo origen de host.
declare const diditBaseUrlBrand: unique symbol;
export type DiditBaseUrl = string & { readonly [diditBaseUrlBrand]: "didit-base-url" };

/** Host canónico de Didit. ÚNICO literal del repo: si aparece un segundo, el fix se perdió. */
export const DIDIT_LIVE_BASE_URL = "https://verification.didit.me";

/** Hosts a los que se permite `http://` (mocks locales de CI). Cualquier otro exige `https`. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isDiditDomain(hostname: string): boolean {
  return hostname === "didit.me" || hostname.endsWith(".didit.me");
}

/**
 * Resuelve el ambiente declarado. FAIL-CLOSED: sin `DIDIT_ENV` lanza.
 *
 * 🔴 PROHIBIDO agregar acá un `?? "mock"` ni derivar el ambiente de `NODE_ENV`, del host, o de la
 * presencia de `DIDIT_API_KEY`. El operador DECLARA el ambiente; el código no lo adivina. Un default
 * (cualquiera, incluso el seguro) devuelve el bug de origen: N lugares que creen cosas distintas.
 */
export function resolveDiditEnvironment(): DiditEnvironment {
  const raw = process.env.DIDIT_ENV?.trim().toLowerCase();
  if (!raw) {
    throw new Error(
      "didit_env_unset: seteá DIDIT_ENV=live (host real de Didit, crea verificaciones REALES con " +
        "PII y consume cuota) o DIDIT_ENV=mock + DIDIT_BASE_URL (endpoint propio) antes de usar el " +
        "KYC. No se asume ningún ambiente: un servicio que no sabe contra qué API de identidad " +
        "habla no habla.",
    );
  }
  if (raw !== "mock" && raw !== "live") {
    // Valor de config de un conjunto cerrado (nunca un secreto ni PII): se ecoa para diagnosticar
    // typos. OJO: "sandbox" cae acá A PROPÓSITO — Didit no tiene sandbox (ver cabecera).
    throw new Error(
      `didit_env_invalid:${raw} (valores válidos: mock | live — "sandbox" NO existe en Didit: ` +
        "su modo de prueba es el free tier sobre el host real, vía DIDIT_API_KEY/DIDIT_WORKFLOW_ID)",
    );
  }
  if (raw === "live") {
    assertLiveIsAllowedHere();
  }
  return raw;
}

/**
 * Declaración EXPLÍCITA del operador para correr `live` fuera de Vercel (el free tier local contra
 * el host real, que `.env.example` documenta). Sólo se consulta cuando NO hay señal de Vercel: ver
 * `assertLiveIsAllowedHere()`.
 */
const ALLOW_LIVE_OUTSIDE_VERCEL_ENV = "DIDIT_ALLOW_LIVE_OUTSIDE_VERCEL";

/**
 * ¿Este entorno puede hablarle al Didit REAL? Lanza si no.
 *
 * 🔴 LA SEÑAL DE ENTORNO TIENE TRES ESTADOS, NO DOS. Acá había un `isNonProductionVercelScope()`
 * que devolvía un `boolean`, y por eso colapsaba "estoy en producción" con "no sé dónde estoy":
 * con `VERCEL_ENV` AUSENTE devolvía `false` y el guard DEJABA PASAR `live`. La combinación exacta
 * que lo disparaba: `DIDIT_ENV=live` + `VERCEL_ENV` sin setear, o sea `next dev`, `next start` en
 * un contenedor, un script del repo, un cron — todo lo que corre fuera de Vercel. Ahí, con una
 * `DIDIT_API_KEY` real puesta, `/api/kyc/session` creaba verificaciones DE VERDAD contra la cuenta
 * productiva: documentos y caras de personas reales.
 *
 *   · presente y `"production"`  → SÍ. El único scope de Vercel que le habla a Didit.
 *   · presente y otra cosa       → NO. Preview/development heredan las envs de producción (es el
 *                                  default de Vercel): el vector que este guard ya cubría.
 *   · AUSENTE / vacía            → NO SE PUDO ESTABLECER el entorno ⇒ NO. La ausencia de una señal
 *                                  no es un permiso.
 *
 * El criterio no es nuevo en este módulo: es EXACTAMENTE el de `resolveDiditEnvironment()` un nivel
 * más arriba (líneas 65-74), donde `DIDIT_ENV` sin setear LANZA en vez de asumir un ambiente. Su
 * test es `didit-env.test.ts:21`. Acá se aplica el mismo principio a la otra señal.
 *
 * ⚠️ POR QUÉ `VERCEL_ENV` Y NO `NODE_ENV` (no lo "unifiques" con el módulo hermano de
 * wasiai-remittance-agents sin leer esto): esto es una app Next.js en Vercel, y ahí `NODE_ENV` vale
 * `"production"` TAMBIÉN en los deploys de preview. `NODE_ENV` no puede distinguir preview de
 * producción; `VERCEL_ENV` sí. Lo que estaba mal no era elegir `VERCEL_ENV`: era tratar su AUSENCIA
 * como permiso.
 *
 * El flujo local con el free tier NO desaparece — deja de ser una inferencia y pasa a ser una
 * declaración: `DIDIT_ALLOW_LIVE_OUTSIDE_VERCEL=true` (el literal exacto; ni `TRUE`, ni `1`, ni
 * `yes`). Se ignora DENTRO de Vercel a propósito: si también valiera ahí, setearla por error en el
 * panel reabriría el agujero de preview.
 */
function assertLiveIsAllowedHere(): void {
  const scope = process.env.VERCEL_ENV?.trim();

  if (scope) {
    if (scope !== "production") {
      throw new Error(
        `didit_env_live_outside_vercel_production: DIDIT_ENV=live con VERCEL_ENV=${scope} ` +
          "— un deploy que NO es el de producción no crea verificaciones reales con PII. Seteá " +
          "DIDIT_ENV=live SOLO en el scope Production de Vercel (en Preview: mock + DIDIT_BASE_URL).",
      );
    }
    return;
  }

  // Sin señal de Vercel. Fail-closed salvo declaración explícita del operador.
  if (process.env[ALLOW_LIVE_OUTSIDE_VERCEL_ENV] === "true") return;

  throw new Error(
    "didit_env_live_without_vercel_scope: DIDIT_ENV=live pero VERCEL_ENV está ausente o vacía, así " +
      "que no se puede establecer en qué entorno corre esto (script, contenedor, `next dev`, cron). " +
      "Sin esa certeza NO se habilita el verificador de identidad real. Para el free tier local " +
      `declaralo: ${ALLOW_LIVE_OUTSIDE_VERCEL_ENV}=true (el literal exacto). Si no querés tocar ` +
      "Didit: DIDIT_ENV=mock + DIDIT_BASE_URL.",
  );
}

/**
 * Resuelve el base URL de Didit. ÚNICA fábrica de `DiditBaseUrl` del repo.
 *
 * ⚠️ Se llama LAZY (dentro del handler, DESPUÉS de los guards de credenciales), NUNCA a nivel de
 * módulo. Consecuencia deliberada: un deploy SIN `DIDIT_API_KEY` sigue devolviendo sus 501/503 de
 * siempre y NO explota por falta de `DIDIT_ENV` — lo que hoy es inerte y correcto sigue igual.
 * Si esto se evaluara al importar, el fail-closed voltearía rutas que ni le hablan a Didit.
 * (Esto REVIERTE a propósito la nota de WKH-202 "PROHIBIDO mover BASE dentro de la función":
 * esa nota protegía el momento de lectura de la env cuando el default era productivo; con
 * fail-closed, leerlo al importar es exactamente lo que hay que evitar.)
 */
export function resolveDiditBaseUrl(): DiditBaseUrl {
  const environment = resolveDiditEnvironment();
  const override = process.env.DIDIT_BASE_URL?.trim();

  if (!override) {
    if (environment === "mock") {
      // No hay host canónico de mock que asumir: exigirlo es el fail-closed correcto.
      throw new Error(
        "didit_base_url_required_for_mock: con DIDIT_ENV=mock hay que setear DIDIT_BASE_URL " +
          "(no existe un host de mock canónico que asumir).",
      );
    }
    return DIDIT_LIVE_BASE_URL as DiditBaseUrl;
  }

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error("didit_base_url_invalid: DIDIT_BASE_URL no es una URL absoluta válida.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" && !LOCAL_HOSTS.has(hostname)) {
    // La API key viaja en el header `x-api-key` y las respuestas traen PII: sobre http se filtran
    // en claro. Solo un mock en localhost puede ser http.
    throw new Error(
      `didit_base_url_insecure_scheme:${parsed.protocol.replace(":", "")} ` +
        "(solo https, salvo un mock en localhost)",
    );
  }

  if (environment === "mock" && isDiditDomain(hostname)) {
    // El caso exacto del incidente, invertido: declarar mock y apuntar al Didit real. Un "test"
    // que cree verificaciones reales con PII es peor que un test que no corre.
    throw new Error(
      "didit_base_url_env_conflict: DIDIT_ENV=mock pero DIDIT_BASE_URL apunta a un host de Didit. " +
        "Corregí una de las dos: el ambiente no se resuelve a medias.",
    );
  }
  if (environment === "live" && !isDiditDomain(hostname)) {
    // En `live` el KYC habla con Didit, no con un mock: un mock que responda "Approved" es un
    // bypass del gate de compliance.
    throw new Error(
      "didit_base_url_non_didit_host_in_live: con DIDIT_ENV=live el host debe ser de Didit " +
        "(los mocks son solo para DIDIT_ENV=mock).",
    );
  }

  // Normalización: sin la barra final, porque los call sites concatenan `/v3/session/...`.
  return override.replace(/\/+$/, "") as DiditBaseUrl;
}
