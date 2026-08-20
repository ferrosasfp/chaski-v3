// La página que el mock de Didit devuelve como `url` de la sesión. En el flujo real, ese `url` abre
// la verificación hospedada de Didit, donde una persona escanea su documento y se saca una selfie.
//
// Acá no se escanea nada, y la pantalla lo dice. Es deliberado que ESTA sea la pantalla y no un
// formulario que pida datos: pedirlos daría a entender que se validan, y no se valida ninguno.
//
// 🔴 SÓLO RESPONDE CON `MOCK_KYC_SURFACE_ENABLED=true`, y eso es un gate y no una esperanza.
//
// ⚠️ ACÁ DECÍA `DIDIT_ENV=mock`, Y ESA ENV ESTÁ MUERTA (WKH-233 fix-pack · H-10). No la lee ni una
// línea de código del repo: el único gate es (`mockDiditSurfaceEnabled`, `../../src/infrastructure/mock-surface.ts:51`),
// que compara `MOCK_KYC_SURFACE_ENABLED` contra el literal exacto `"true"`. Un operador que siguiera
// la línea vieja setearía una env que no hace nada y la página seguiría apagada, sin ningún error que
// se lo diga. Son DOS envs distintas y el cambio está declarado en `.env.example`.
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
import { mockDiditSurfaceEnabled } from "../../src/infrastructure/mock-surface";

export const metadata = { title: "Verificación simulada · Chaski" };

// 🔴 SIN ESTO EL GATE SE EVALÚA UNA SOLA VEZ, AL COMPILAR. Medido el 2026-08-11: `npm run build`
// marcaba esta ruta `○ (Static)`, o sea prerenderizada, así que `mockDiditSurfaceEnabled()` corría con
// la env del BUILD y el resultado quedaba horneado en el HTML. Consecuencia concreta: apagar
// `MOCK_KYC_SURFACE_ENABLED` en el proveedor **no cerraría esta página** hasta un rebuild, y el 404 dejaría
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
  // pantalla no se renderiza. `notFound()` corta con la señal de 404 del framework.
  //
  // ⚠️ ACÁ DECÍA que eso da *"la misma respuesta observable que la ruta hermana"*, Y ES FALSO —MEDIDO,
  // no deducido (WKH-233 fix-pack · H-12)—. Contra un build local de este árbol, con un centinela que
  // prueba que el servidor servía ese build: esta página devuelve **HTTP 200** con el cuerpo del
  // not-found de Next, mientras `POST /api/mock-didit/v3/session` devuelve **404**. Dos sondas
  // mínimas (`force-dynamic` + `notFound()` a secas, y la misma sin `force-dynamic`) también dieron
  // 200 ⇒ **ninguna página de esta app devuelve 404 desde `notFound()`**; una URL que de verdad no
  // existe sí. No es algo que esta página pueda arreglar sola.
  //
  // ⇒ LO QUE SÍ ES CIERTO: el contenido del simulador NO se sirve. Lo que NO es cierto: que el status
  // lo delate. Un monitor externo que pregunte "¿está apagado?" por el código HTTP va a leer que no.
  // ⛔ PROHIBIDO volver a escribir "da el 404" sin una medición nueva que lo sostenga. El candado que
  // mide el corte —no el texto de esta línea— es `T-GATE-3'` en `kyc-simulado-gate.test.ts`.
  if (!mockDiditSurfaceEnabled()) notFound();

  const { session = "", vendor = "" } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-aire pb-segura-b pl-segura-l pr-segura-r pt-segura-t">
      <div className="rounded-caja border-2 border-dashed border-stone/40 p-5">
        <p className="text-label font-semibold uppercase tracking-wider text-stone">Entorno de prueba</p>
        {/* `text-xl` (20px) → `title` (17px). ⛔ NO `money`: ese rol es el de la CIFRA, y usarlo acá
            porque "queda de un tamaño parecido" es justo el error que nombrar por rol hace visible. */}
        <h1 className="mt-ajustado text-title font-semibold">Verificación de identidad simulada</h1>
        <p className="mt-normal text-support text-stone">
          En el flujo real, acá se abre la verificación de Didit y una persona escanea su documento y
          se saca una selfie. <strong>Esta pantalla no verifica nada</strong> y no pide ningún dato:
          existe para que se pueda recorrer la aplicación completa sin usar el documento de una
          persona real.
        </p>
        <p className="mt-normal text-support text-stone">
          La verificación se va a aprobar sola en unos segundos, con datos evidentemente falsos. Podés
          volver a la aplicación ahora: te va a estar esperando.
        </p>
      </div>

      <div className="rounded-control border border-stone/20 p-holgado text-label text-stone">
        <p className="font-medium text-ink">Por qué esto no puede hacerse pasar por real</p>
        <p className="mt-ajustado">
          La decisión que sale de esta sesión queda etiquetada como <code>didit-mock</code>. El agente
          que desembolsa el dinero sólo acepta <code>didit</code>, así que una verificación simulada
          no puede desbloquear un desembolso real. No es una convención: es la única rama que abre.
        </p>
        {session ? (
          <p className="mt-normal break-all">
            Sesión: <code>{session}</code>
          </p>
        ) : null}
        {vendor ? (
          <p className="mt-ajustado break-all">
            Billetera: <code>{vendor}</code>
          </p>
        ) : null}
      </div>

      <Link
        href="/"
        className="inline-flex min-h-[52px] w-full items-center justify-center rounded-caja bg-ink px-holgado text-center text-body font-medium text-white"
      >
        Volver a Chaski
      </Link>
    </main>
  );
}
