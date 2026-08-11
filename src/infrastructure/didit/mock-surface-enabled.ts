// ¿Está encendida la superficie de PRUEBA de Didit? Una sola función para TODOS los sitios que sólo
// deben existir con el mock declarado.
//
// ── EL PRINCIPIO, que ya estaba escrito y aplicado a medias ──────────────────────────────────────
//
// `app/api/mock-didit/v3/session/route.ts` lo dice desde su cabecera: *"un mock alcanzable en un
// entorno que se cree productivo es peor que no tenerlo, porque el 404 es lo que hace verificable que
// está apagado"*. Esa ruta lo cumplía. `app/kyc-simulado/page.tsx` no: **no tenía ningún gate**, así
// que su URL respondía con cualquier `DIDIT_ENV`, incluso con el Didit real configurado. Y su propio
// comentario decía *"la ruta que emite el link ni siquiera responde, así que nadie llega hasta acá"* —
// que es cierto sobre el EMISOR y falso sobre la PÁGINA: cualquiera la abre escribiendo la URL. Medido
// el 2026-08-11: cero apariciones de `DIDIT_ENV`, `process.env` o `notFound` en ese archivo.
//
// La página describe una verificación que se aprueba sola. Servida en un despliegue que habla con el
// Didit real, eso no es sólo una pantalla huérfana: es una pantalla que describe un comportamiento que
// ese despliegue NO tiene.
//
// ── FAIL-CLOSED, y las tres entradas que apagan ─────────────────────────────────────────────────
//
// `resolveDiditEnvironment()` es fail-loud: TIRA si `DIDIT_ENV` falta o no parsea. Acá eso se traduce a
// `false`, nunca a "asumamos mock": ausente, `live` y un typo dan los tres apagado. El único `true` es
// el operador declarando `mock` explícitamente.
import { resolveDiditEnvironment } from "./didit-env";

/** `true` sólo si el operador DECLARÓ mock. Cualquier otra cosa (live, ausente, typo) ⇒ apagado. */
export function mockDiditSurfaceEnabled(): boolean {
  try {
    return resolveDiditEnvironment() === "mock";
  } catch {
    return false; // sin DIDIT_ENV no se asume nada, ni siquiera para un mock
  }
}
