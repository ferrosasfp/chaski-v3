// ¿Está encendida la superficie de PRUEBA del KYC? Una sola función para TODOS los sitios que sólo
// deben existir con el simulador declarado.
//
// ── EL PRINCIPIO, que ya estaba escrito y aplicado a medias ──────────────────────────────────────
//
// `app/api/mock-didit/v3/session/route.ts` lo dice desde su cabecera: *"un mock alcanzable en un
// entorno que se cree productivo es peor que no tenerlo, porque el 404 es lo que hace verificable que
// está apagado"*. Esa ruta lo cumplía. `app/kyc-simulado/page.tsx` no: **no tenía ningún gate**, así
// que su URL respondía con cualquier configuración, incluso con el verificador real detrás. Y su
// propio comentario decía *"la ruta que emite el link ni siquiera responde, así que nadie llega hasta
// acá"* — que es cierto sobre el EMISOR y falso sobre la PÁGINA: cualquiera la abre escribiendo la
// URL. La página describe una verificación que se aprueba sola; servida en un despliegue que habla
// con el verificador real, eso no es sólo una pantalla huérfana: describe un comportamiento que ese
// despliegue NO tiene.
//
// ── 🔴 WKH-233/DT-9 — ESTE MÓDULO SE MUDÓ Y CAMBIÓ DE ENV, Y LAS DOS COSAS TIENEN CONSECUENCIA ────
//
// ANTES vivía en `src/infrastructure/didit/` y derivaba su respuesta de `resolveDiditEnvironment()`.
// Ese directorio entero se borró: Chaski ya no le habla al proveedor de KYC por ningún camino, así
// que ya no tiene un "ambiente del proveedor" del que colgar nada. El gate necesitaba su PROPIA
// señal, y ésta es.
//
// 🔴 SON DOS ENVS DISTINTAS, Y ÉSA ES LA CONSECUENCIA QUE HAY QUE LEER ANTES DE PENSAR QUE ES UN BUG:
// antes el mock se encendía con `DIDIT_ENV=mock`; ahora con `MOCK_KYC_SURFACE_ENABLED=true`. ⇒ **si
// nadie setea la nueva, el simulador queda APAGADO.** Es fail-closed y es CORRECTO, y rompe el
// recorrido manual de punta a punta que usa este simulador hasta que un operador la setee. Está
// aceptado y declarado (`.env.example`); **no es un bug a arreglar** y ⛔ no se le pone un default.
//
// ── FAIL-CLOSED: el único `true` es el literal exacto ────────────────────────────────────────────
//
// Ausente, un typo, `"TRUE"`, `"1"`, `" true"` con espacio: los cinco dan APAGADO. El único encendido
// es el operador escribiendo exactamente `true`. ⛔ PROHIBIDO un `!== "false"` (que encendería con
// cualquier cosa) y ⛔ prohibido un `.trim().toLowerCase()`, que convertiría un typo en un permiso.

/** El nombre de la env, exportado para que `.env.example` y los tests no lo copien a mano. */
export const MOCK_KYC_SURFACE_ENV = "MOCK_KYC_SURFACE_ENABLED";

/**
 * `true` sólo si el operador DECLARÓ el simulador, con el literal exacto. Cualquier otra cosa apaga.
 *
 * 🔴 EL NOMBRE EXPORTADO **NO CAMBIA** (`mockDiditSurfaceEnabled`), y no es inercia: las cuatro
 * aserciones TEXTUALES del candado `app/kyc-simulado/kyc-simulado-gate.test.ts` comparan el CUERPO de
 * la página contra este identificador (`toContain("mockDiditSurfaceEnabled")`,
 * `toMatch(/if\s*\(!mockDiditSurfaceEnabled\(\)\)\s*notFound\(\)/)`). Renombrarlo apagaría ese candado
 * en silencio, que es exactamente el modo de falla que el candado existe para cazar. El nombre sigue
 * nombrando al simulador que hay, y el simulador que hay imita al proveedor: no es una mentira.
 *
 * La env se lee DENTRO de la función, en runtime: a nivel de módulo quedaría horneada en el build y
 * un operador que apague el simulador no cerraría la superficie hasta un re-deploy.
 */
export function mockDiditSurfaceEnabled(): boolean {
  return process.env[MOCK_KYC_SURFACE_ENV] === "true";
}
