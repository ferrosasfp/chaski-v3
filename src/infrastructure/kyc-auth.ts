// Infrastructure — auth de sesión KYC (WKH-179, hallazgo B1).
// Token HMAC stateless que ata una sesión Didit a su caller: se emite en POST /api/kyc/session
// y se exige (verificación timing-safe) en GET /api/kyc/decision. Cierra el IDOR/PII-leak: un
// atacante con solo el sessionId NO puede forjar el token sin KYC_SESSION_SECRET.
//
// Límite conocido (aceptado para hackathon/prod-inicial): NO prueba posesión de wallet. Si el
// token se filtra (logs/XSS/history) es replayable. SIWE queda deferred (Scope OUT). Ver SDD §3.5.
//
// Crypto: node:crypto (createHmac/timingSafeEqual). NO jsonwebtoken/jose (CD-A).
import { createHmac, timingSafeEqual } from "node:crypto";

// El secreto se lee DENTRO de la función (no en top-level) para que vi.stubEnv funcione en tests.
function secret(): string {
  const s = process.env.KYC_SESSION_SECRET;
  if (!s) throw new Error("KYC_SESSION_SECRET missing"); // la ruta corta antes con 500 (CD-7)
  return s;
}

// Emisión determinística sobre el session_id → stateless, sin storage server-side.
export function issueSessionToken(sessionId: string): string {
  return createHmac("sha256", secret()).update(sessionId).digest("base64url");
}

// Verificación timing-safe. Compara longitud PRIMERO (timingSafeEqual tira con buffers de
// distinta longitud, CD-9). Devuelve false ante cualquier mismatch — sin throw por token inválido.
export function verifySessionToken(sessionId: string, token: string): boolean {
  if (!process.env.KYC_SESSION_SECRET) return false; // defensa; la ruta ya garantiza el 500 (CD-7)
  const expected = issueSessionToken(sessionId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false; // CD-9: longitud primero, sin throw
  return timingSafeEqual(a, b);
}
