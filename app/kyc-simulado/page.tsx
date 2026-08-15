// La página que el mock de Didit devuelve como `url` de la sesión. En el flujo real, ese `url` abre
// la verificación hospedada de Didit, donde una persona escanea su documento y se saca una selfie.
//
// Acá no se escanea nada, y la pantalla lo dice. Es deliberado que ESTA sea la pantalla y no un
// formulario que pida datos: pedirlos daría a entender que se validan, y no se valida ninguno.
//
// 🔴 SÓLO RESPONDE CON `DIDIT_ENV=mock`, y eso ahora es un gate y no una esperanza.
//
// Lo que decía antes: *"la ruta que emite el link ni siquiera responde, así que nadie llega hasta
// acá"*. La primera mitad es cierta — `app/api/mock-didit/v3/session/route.ts` devuelve 404 sin mock —
// y la conclusión NO se sigue de ella: esto es una página, y una URL se escribe a mano. Medido el
// 2026-08-11: este archivo no tenía ni una aparición de `DIDIT_ENV`, `process.env` ni `notFound`, así
// que respondía con cualquier configuración, incluida la que habla con el Didit REAL. Una pantalla que
// dice "la verificación se va a aprobar sola en unos segundos" servida por un despliegue que verifica
// de verdad no es una página huérfana: describe un comportamiento que ese despliegue no tiene.
//
// El principio ya estaba escrito en la ruta hermana, y ahora lo cumplen las dos desde el MISMO lugar
// (`mockDiditSurfaceEnabled`): *un mock alcanzable en un entorno que se cree productivo es peor que no
// tenerlo, porque el 404 es lo que hace verificable que está apagado.*
import { notFound } from "next/navigation";
import Link from "next/link";
import { mockDiditSurfaceEnabled } from "../../src/infrastructure/didit/mock-surface-enabled";

export const metadata = { title: "Verificación simulada · Chaski" };

// 🔴 SIN ESTO EL GATE SE EVALÚA UNA SOLA VEZ, AL COMPILAR. Medido el 2026-08-11: `npm run build`
// marcaba esta ruta `○ (Static)`, o sea prerenderizada, así que `mockDiditSurfaceEnabled()` corría con
// el `DIDIT_ENV` del BUILD y el resultado quedaba horneado en el HTML. Consecuencia concreta: pasar
// `DIDIT_ENV` a `live` en el proveedor **no cerraría esta página** hasta un rebuild, y el 404 dejaría
// de significar lo que la ruta hermana dice que significa. Es la misma familia de trampa que "un
// redeploy no recompila las variables": la que hace que apagar algo no lo apague.
//
// `force-dynamic` mueve la decisión a cada request. El costo es no cachear una pantalla que existe sólo
// en entorno de prueba, que es exactamente donde el caché no vale nada.
export const dynamic = "force-dynamic";

export default async function KycSimuladoPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string; vendor?: string }>;
}) {
  // ⛔ ANTES de leer los parámetros y antes de renderizar nada: si el mock no está declarado, esta
  // pantalla no existe. `notFound()` da el 404 de Next, o sea la misma respuesta observable que la ruta
  // hermana, que es lo que hace verificable desde afuera que la superficie de prueba está apagada.
  if (!mockDiditSurfaceEnabled()) notFound();

  const { session = "", vendor = "" } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-5 pb-segura-b pl-segura-l pr-segura-r pt-segura-t">
      <div className="rounded-xl border-2 border-dashed border-stone/40 p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-stone">Entorno de prueba</p>
        <h1 className="mt-1 text-xl font-semibold">Verificación de identidad simulada</h1>
        <p className="mt-3 text-sm text-stone">
          En el flujo real, acá se abre la verificación de Didit y una persona escanea su documento y
          se saca una selfie. <strong>Esta pantalla no verifica nada</strong> y no pide ningún dato:
          existe para que se pueda recorrer la aplicación completa sin usar el documento de una
          persona real.
        </p>
        <p className="mt-3 text-sm text-stone">
          La verificación se va a aprobar sola en unos segundos, con datos evidentemente falsos. Podés
          volver a la aplicación ahora: te va a estar esperando.
        </p>
      </div>

      <div className="rounded-xl border border-stone/20 p-4 text-xs text-stone">
        <p className="font-medium text-ink">Por qué esto no puede hacerse pasar por real</p>
        <p className="mt-2">
          La decisión que sale de esta sesión queda etiquetada como <code>didit-mock</code>. El agente
          que desembolsa el dinero sólo acepta <code>didit</code>, así que una verificación simulada
          no puede desbloquear un desembolso real. No es una convención: es la única rama que abre.
        </p>
        {session ? (
          <p className="mt-3 break-all">
            Sesión: <code>{session}</code>
          </p>
        ) : null}
        {vendor ? (
          <p className="mt-1 break-all">
            Billetera: <code>{vendor}</code>
          </p>
        ) : null}
      </div>

      <Link
        href="/"
        className="rounded-lg bg-ink px-4 py-2.5 text-center text-sm font-medium text-white"
      >
        Volver a Chaski
      </Link>
    </main>
  );
}
