// Infrastructure — vigencia del veredicto de KYC. ISOMÓRFICO y PURO (WKH-333/AC-2, CD-7).
//
// Acá viven los TRES números del vencimiento y la función que lo aplica. Nada más: ni `process.env`,
// ni fetch, ni fecha implícita. Lo importa tanto el navegador (`kyc-store.ts`, que necesita el TTL
// del caché de dispositivo) como el servidor.
//
// 🔴 POR QUÉ EL RESOLVEDOR DE LA ENV NO ESTÁ ACÁ, y no es una preferencia de estilo. Si
// `resolveKycVerdictTtlDays()` viviera en este módulo, `kyc-store.ts` lo arrastraría al bundle del
// browser. Ahí `process.env.KYC_VERDICT_TTL_DAYS` se INLINEA como `undefined` (Next sólo inlinea las
// `NEXT_PUBLIC_`), así que el resolvedor devolvería 365 en silencio en el cliente y el número de la
// env en el servidor: dos verdades sobre la misma política, sin nada que lo señale. Es exactamente la
// familia de defecto que `src/composition/evm-residue-guard.static.test.ts:5-10` documenta. Por eso
// son DOS archivos, y el server-only es `kyc-verdict-ttl-env.ts`.
//
// CD-23: PROHIBIDA una segunda fuente de 365 / 730 / 180 fuera de este archivo. `kyc-store.ts`
// IMPORTA `KYC_CLIENT_HINT_TTL_DAYS`, no redefine el número.

/** Vencimiento por defecto del veredicto server-side, en días. Se usa cuando la env está AUSENTE
 *  (no cuando está presente y mal: eso NO ARRANCA — AC-4). */
export const KYC_VERDICT_DEFAULT_TTL_DAYS = 365;

/** Techo duro. Un TTL por encima de esto es "sin vencimiento" escrito con dígitos, y CD-8 lo prohíbe
 *  igual que prohíbe el `null`. */
export const KYC_VERDICT_MAX_TTL_DAYS = 730;

/** TTL del caché de dispositivo del navegador (`kyc-store.ts`, clave `chaski.kyc.v1`). Es además el
 *  PISO del TTL server-side (AC-15): si el servidor venciera ANTES que el navegador, el cliente
 *  saltearía la verificación apoyado en una entry local que el servidor ya considera vencida, y la
 *  persona llegaría a pagar sin fila utilizable. */
export const KYC_CLIENT_HINT_TTL_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

// Brand nominal (exemplar: didit-env.ts:45-46). `KycVerdictTtlDays` es asignable a `number`, pero un
// `number` NO es asignable a `KycVerdictTtlDays`: pasarle un `365` literal a `isVerdictExpired` no
// compila. La ÚNICA fábrica es `resolveKycVerdictTtlDays()` en `kyc-verdict-ttl-env.ts` — el brand es
// lo que hace imposible un segundo origen del número.
declare const kycVerdictTtlDaysBrand: unique symbol;
export type KycVerdictTtlDays = number & { readonly [kycVerdictTtlDaysBrand]: "kyc-verdict-ttl-days" };

/**
 * ¿Este veredicto está vencido AL MOMENTO DE LEERLO?
 *
 * El vencimiento NO se persiste (AC-2/CD-7): la fila guarda `verified_at`, que es el HECHO, y la
 * política vive en la configuración. Así, cambiar `KYC_VERDICT_TTL_DAYS` cambia el veredicto sobre
 * las filas que ya existen sin backfill y sin dos verdades conviviendo (input que lo muestra:
 * T-TTL-3, la misma `verifiedAt` con TTL 365 y con TTL 180).
 *
 * `verifiedAtIso` ilegible ⇒ **vencido**. Es la dirección fail-safe: el costo de equivocarse hacia
 * "vencido" es que la persona re-verifica; hacia "vigente" es que una fila corrupta autoriza
 * desembolsos para siempre.
 */
export function isVerdictExpired(
  verifiedAtIso: string,
  ttlDays: KycVerdictTtlDays,
  nowMs: number,
): boolean {
  const verifiedAtMs = Date.parse(verifiedAtIso);
  if (!Number.isFinite(verifiedAtMs)) return true; // fail-safe: ver arriba
  return nowMs - verifiedAtMs > ttlDays * DAY_MS;
}
