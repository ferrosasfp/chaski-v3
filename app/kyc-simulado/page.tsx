// La página que el mock de Didit devuelve como `url` de la sesión. En el flujo real, ese `url` abre
// la verificación hospedada de Didit, donde una persona escanea su documento y se saca una selfie.
//
// Acá no se escanea nada, y la pantalla lo dice. Es deliberado que ESTA sea la pantalla y no un
// formulario que pida datos: pedirlos daría a entender que se validan, y no se valida ninguno.
//
// Sólo existe cuando `DIDIT_ENV=mock`. Con el Didit real configurado, la ruta que emite el link ni
// siquiera responde, así que nadie llega hasta acá.
import Link from "next/link";

export const metadata = { title: "Verificación simulada · Chaski" };

export default async function KycSimuladoPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string; vendor?: string }>;
}) {
  const { session = "", vendor = "" } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 p-6">
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
