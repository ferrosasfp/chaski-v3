import { buildCspPolicy } from "./src/infrastructure/security/csp-policy.mjs";

// El CSP arranca en `Report-Only`: el navegador NO bloquea nada y sólo reporta qué habría bloqueado.
//
// POR QUÉ NO SE ACTIVA DE UNA. Una política incompleta en esta app no rompe la página, rompe LA
// FIRMA: el wallet adapter, el WebSocket del RPC y la ventana del proveedor de identidad abren
// conexiones que un `connect-src` corto bloquea, y eso se descubre con la transacción ya armada. La
// lista de orígenes se puede leer del bundle —y se leyó—, pero leerla no prueba que esté completa.
// La prueba es un recorrido real con la política mirando sin intervenir.
//
// EL PASO SIGUIENTE, para que no quede a medias: cuando el recorrido no reporte violaciones nuevas,
// esta clave pasa a `Content-Security-Policy` y hace falta OTRO recorrido corto que confirme que
// sigue firmando. Dejar esto en `Report-Only` para siempre es tener la cabecera y no la protección.
const CSP = buildCspPolicy({
  rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
  // `vercel.live` es la barra de herramientas de Vercel, que se inyecta en los despliegues y abre su
  // propia conexión. Aparece en el bundle servido. No sale de ninguna env, así que va explícito.
  extraConnectSrc: ["https://vercel.live"],
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
          { key: "Content-Security-Policy-Report-Only", value: CSP },
        ],
      },
    ];
  },
};
export default nextConfig;
