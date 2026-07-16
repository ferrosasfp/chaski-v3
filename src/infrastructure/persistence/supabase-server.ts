// Infrastructure — cliente Supabase SERVER-ONLY para el ledger de settlements (WKH-207).
//
// ⚠️ CD-11: server-only. PROHIBIDO importarlo desde cualquier módulo "use client" / componente /
// browser — usa SUPABASE_SERVICE_ROLE_KEY (BYPASSRLS), que NUNCA debe llegar al bundle del cliente.
//
// Patrón exemplar: rate-limit.ts:107-140 (factory lazy memoizada null-safe). Lee las envs DENTRO de
// la función en runtime (CD-14) y devuelve null si faltan ⇒ el ledger se apaga con gracia
// (byte-idéntico, AC-2/AC-10). NO lee envs en el top-level del módulo.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Memoización por proceso (una sola conexión por lambda). __resetSupabaseClient() lo vacía entre
// tests (patrón __resetKycRateLimitClient).
let cached: SupabaseClient | null = null;

/** Devuelve el cliente Supabase server-only, o `null` si faltan las envs (SUPABASE_URL /
 *  SUPABASE_SERVICE_ROLE_KEY). Null ⇒ el ledger se apaga (CD-14: envs leídas en runtime). */
export function getSupabaseServerClient(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  // CD-17/AC-10: createClient() LANZA sincrónicamente ante una URL malformada (ej. `abc.supabase.co`
  // sin scheme — typo de deploy). Fuera del try/catch best-effort de las rutas eso sería un 500 crudo
  // que tumbaría el money-path DESPUÉS de broadcastear/forwardear. Degradamos a null (byte-idéntico
  // OFF), igual que envs ausentes. NO logueamos url/key (sin PII/secretos).
  try {
    cached = createClient(url, key, { auth: { persistSession: false } });
  } catch {
    return null;
  }
  return cached;
}

/** Solo para tests: resetea el cliente memoizado entre stubs de env. */
export function __resetSupabaseClient(): void {
  cached = null;
}
