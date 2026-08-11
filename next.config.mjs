import { buildCspPolicy } from "./src/infrastructure/security/csp-policy.mjs";

// El CSP **BLOQUEA**. Estuvo en `Report-Only` una vuelta, la persona que firma recorrió la
// aplicación completa, y el navegador no reportó ni una violación atribuible a esta app — cero de
// `connect-src`, que era el riesgo real, ni en las llamadas al RPC ni en su WebSocket.
//
// `report-uri` SIGUE ACTIVO en modo bloqueo, y eso no es redundante: si mañana aparece un origen
// nuevo, la violación queda escrita en el log además de bloqueada, así que se diagnostica leyendo en
// vez de adivinando.
//
// LAS CINCO VIOLACIONES QUE SÍ HUBO NO SE AUTORIZARON, a propósito: las produce la barra que Vercel
// inyecta, no la aplicación (medido: `DM Sans`, `gstatic` y `eval(` no aparecen en el repo, el HTML
// servido ni el JS del cliente). Autorizarlas exigiría `'unsafe-eval'` y tres dominios más para
// TODOS los visitantes, por una herramienta que sólo ve quien está logueado en Vercel. El detalle
// está en `csp-policy.mjs`.
const CSP = buildCspPolicy({
  rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Declara el destino que `report-to` nombra en la política. Sin esta cabecera, la
          // directiva `report-to csp` no apunta a ningún lado y se pierden los reportes de los
          // navegadores que ya no implementan `report-uri`.
          {
            key: "Reporting-Endpoints",
            value: 'csp="/api/csp-report"',
          },
          { key: "Content-Security-Policy", value: CSP },
        ],
      },
    ];
  },
};
export default nextConfig;
