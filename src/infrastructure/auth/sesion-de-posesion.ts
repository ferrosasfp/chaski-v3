// Infrastructure — la SESIÓN DE POSESIÓN, server-only (WKH-372 / W3.1).
//
// 🔴 QUÉ PROBLEMA RESUELVE. Hoy se piden DOS firmas de billetera que prueban lo mismo: que la
// dirección es suya. Una la pide `ConnectWallet` para el veredicto de KYC
// (`HttpKycVerdictGateway`, `../kyc/http-kyc-verdict-gateway.ts:61`); la otra, el gateway del depósito
// antes de `POST /api/payout/prepare`. Las dos existen porque **la app no tiene sesión**: cada request
// re-prueba la posesión desde cero. Este módulo emite esa sesión y `prepare` acepta la prueba YA hecha.
//
// ⛔ SERVER-ONLY, y no es preferencia: importa `node:crypto`. Su gemelo del navegador —el almacén que
// transporta el token— vive aparte, por el MISMO motivo por el que `./pop-proof-store.ts` DUPLICA un
// literal en vez de importarlo de acá: *«rompería el bundle del browser»*
// (`POP_PROOF_TTL_MS`, `./pop-proof-store.ts:40`).
//
// ── LAS CINCO REGLAS DEL MÓDULO ──────────────────────────────────────────────────────────────────
//
// 1 · FORMATO, calcado del exemplar. `${b64url(JSON.stringify(payload))}.${b64url(hmac(payloadB64))}`,
//     con el HMAC sobre el STRING base64url y NO sobre el JSON crudo, por la razón que el exemplar ya
//     dejó escrita: *«así verify() re-HMACea el string recibido tal cual y no depende de que
//     JSON.stringify re-serialice idéntico»* (`Formato`, `./pop-challenge.ts:9`).
//     ⛔ No se inventa un formato nuevo.
//
// 2 · 🔴 SECRETO PROPIO: `PAYOUT_SESSION_SECRET`, leído DENTRO de `secret()` para que `vi.stubEnv`
//     funcione — el patrón obligatorio del repo (`secret`, `./pop-challenge.ts:25`).
//     ⛔ PROHIBIDO leer `PAYOUT_POP_SECRET`. Y el motivo NO es la pureza:
//     `POST /api/a2a/payout/challenge` emite un token firmado con ESE secreto para CUALQUIER
//     dirección **sin pedir ninguna firma** (medido en `T-372-W3-0b`,
//     `../../presentation/sesion-borra-la-segunda-firma.test.tsx`). Si esto compartiera secreto y
//     forma, cualquier anónimo se emitiría una sesión para la dirección de otro con un solo `curl`, y
//     eso no reabriría un oráculo: **autorizaría un desembolso**. ⚠️ El dominio solo (el campo `tipo`)
//     NO alcanza: el payload del challenge no tiene `tipo` hoy, y lo edita cualquier HU futura sin
//     saber que hay algo colgando. Con secreto propio, un cambio allá **no puede** producir sesión.
//
// 3 · ORDEN DE VERIFICACIÓN, idéntico al del exemplar: formato → secreto → HMAC (con el chequeo de
//     longitud ANTES de `timingSafeEqual`, que TIRA con buffers de distinta longitud) → parse en
//     try/catch → tipo de CADA campo → `tipo === SESION_TIPO` → red → expiración. `null` ante
//     cualquier problema, fail-closed → 403 opaco (`expected.length`, `./pop-challenge.ts:83`).
//     ⚠️ EL `networkId` SE COMPARA CONTRA `resolveSolanaNetworkId()`, ⛔ nunca contra un literal ni
//     contra un regex de clusters: un token de devnet no puede valer en mainnet (anti-replay
//     cross-cluster). Lo mide `T-372-W3-15` en `./sesion-de-posesion.test.ts`. La ruta repite esta
//     comparación en su guard `S5`, y esa repetición es DELIBERADA: se lee como intención en el sitio
//     donde se decide el pago, igual que `S3` repite el chequeo de dominio.
//
// 4 · TTL = 30 MINUTOS. ⚠️ **Es una hipótesis sobre cuánto tarda el recorrido, no una medición**:
//     cuánto tarda de verdad sigue SIN MEDIR. Por eso lo que pasa al vencerse es **lo de hoy** (se
//     pide la firma) y NO un error, que es la regla 5.
//
// 5 · 🔴 LA AUSENCIA DE LA ENV ES EL MECANISMO DE ORDEN DE DESPLIEGUE, y por eso NO hay ningún flag
//     nuevo. Sin `PAYOUT_SESSION_SECRET`: `emitirSesionDePosesion` devuelve `null` ⇒ `/api/kyc/verdict`
//     no agrega el campo ⇒ ningún cliente tiene sesión ⇒ todos mandan PoP; y
//     `verificarSesionDePosesion` devuelve `null` ⇒ `/api/payout/prepare` no acepta ninguna sesión ⇒
//     el único camino es el PoP. **Desplegar el código de W3 con la env ausente es un no-op
//     verificable, y quitarla es el repliegue.**
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveSolanaNetworkId } from "../chain";

/** El dominio del token. Es lo que hace que un `popChallenge` crudo presentado como sesión muera en
 *  un guard que **se lee como intención**, aunque el secreto propio de la regla 2 ya lo mate. */
export const SESION_TIPO = "chaski-sesion-de-posesion-v1";

/** 30 minutos. Ver la regla 4: es una hipótesis, no una medición. */
export const SESION_TTL_SECONDS = 30 * 60;

export interface SesionDePosesion {
  tipo: typeof SESION_TIPO;
  address: string; // base58 canónico, case-sensitive (⛔ PROHIBIDO .toLowerCase(): abre aliasing)
  networkId: string; // CAIP-2 (`resolveSolanaNetworkId`, `../chain.ts:32`) — ⛔ NUNCA del body
  exp: number; // epoch SEGUNDOS, igual que el exemplar (`exp`, `./pop-challenge.ts:47`)
}

// Regla 2: DENTRO de la función, nunca en top-level, para que `vi.stubEnv` funcione (CD-14).
// ⛔ Y no tira: quien lo llama decide qué hacer con la ausencia (ver la regla 5).
function secret(): string | null {
  return process.env.PAYOUT_SESSION_SECRET || null;
}

function firmar(payloadB64: string, clave: string): string {
  return createHmac("sha256", clave).update(payloadB64).digest("base64url");
}

function esRegistro(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Acuña una sesión para una dirección que YA probó posesión.
 *
 * ⛔ `null` cuando falta `PAYOUT_SESSION_SECRET`: la ruta simplemente no agrega el campo y todo sigue
 * como hoy (regla 5). ⛔ **NUNCA lanza**: un emisor que tirara convertiría un 200 legítimo de
 * `/api/kyc/verdict` en un 500, o sea que apagar el mecanismo rompería la consulta del veredicto.
 *
 * ⛔ `address` y `networkId` los pone el LLAMADOR con valores que él probó y resolvió server-side.
 * Este módulo no canonicaliza ni resuelve nada: si lo hiciera, sería un segundo lugar donde el
 * binding se decide, y el binding tiene que decidirse en UN solo lado.
 */
export function emitirSesionDePosesion(address: string, networkId: string, nowMs: number): string | null {
  const clave = secret();
  if (!clave) return null;
  const payload: SesionDePosesion = {
    tipo: SESION_TIPO,
    address,
    networkId,
    exp: Math.floor(nowMs / 1000) + SESION_TTL_SECONDS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${firmar(payloadB64, clave)}`;
}

/**
 * Mirror de `verifySolanaPopChallenge` (`./pop-challenge.ts:68`): mismo orden, misma disciplina.
 * Devuelve `null` ante CUALQUIER problema — fail-closed → 403 opaco, sin decir cuál de los pasos
 * falló (no-oracle). ⛔ Los cinco modos de fallar colapsan en el mismo `null` A PROPÓSITO: un enum
 * propio le diría al caller cuál de los dos mecanismos de identidad rechazó su pedido.
 */
export function verificarSesionDePosesion(token: string, nowMs: number): SesionDePosesion | null {
  // 1. Formato: exactamente 2 partes no vacías.
  if (typeof token !== "string") return null;
  const partes = token.split(".");
  if (partes.length !== 2) return null;
  const [payloadB64, macB64] = partes;
  if (!payloadB64 || !macB64) return null;

  // 2. Sin secreto no se verifica nada (regla 5: la env ausente es el repliegue).
  const clave = secret();
  if (!clave) return null;

  // 3. HMAC PRIMERO — la longitud ANTES de la comparación timing-safe, porque `timingSafeEqual` TIRA
  //    con buffers de distinta longitud (`if (expected.length`, `./pop-challenge.ts:83`).
  const esperado = Buffer.from(firmar(payloadB64, clave));
  const recibido = Buffer.from(macB64);
  if (esperado.length !== recibido.length) return null;
  if (!timingSafeEqual(esperado, recibido)) return null;

  // 4. Parse DENTRO de try/catch: un payload base64 válido puede no ser JSON.
  let parseado: unknown;
  try {
    parseado = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!esRegistro(parseado)) return null;

  // 5. El tipo de CADA campo, y el dominio.
  const { tipo, address, networkId, exp } = parseado;
  if (tipo !== SESION_TIPO) return null;
  if (typeof address !== "string" || !address.trim()) return null;
  if (typeof networkId !== "string" || networkId !== resolveSolanaNetworkId()) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;

  // 6. Expiración. ⚠️ Vencer NO es fallar: quien recibe el `null` vuelve a pedir la firma, que es
  //    exactamente lo que la app hace hoy (AC-3-3).
  if (exp * 1000 <= nowMs) return null;

  return { tipo: SESION_TIPO, address, networkId, exp };
}
