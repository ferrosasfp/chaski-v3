import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk } from "next/font/google";
import { Providers } from "@/presentation/providers";
import "./globals.css";

const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Chaski — mandá plata a Perú",
  // Decía "Reciben soles en su Yape" y es el texto que sale en Google y en toda vista previa de un
  // enlace compartido. Chaski no manda a Yape: deposita a una cuenta bancaria peruana (CCI), y
  // desde este cambio la primera pantalla tampoco lo ofrece. La descripción nombra el mismo destino
  // que la pantalla, así que las dos se rompen juntas si algún día divergen.
  description:
    "Mandá plata a tu familia en Perú con solo pedirlo. Reciben soles depositados en su cuenta bancaria.",
  manifest: "/manifest.json",
  // Los genera scripts/generate-icons.py desde la geometría de ChaskiMark. Sin esto el sitio no
  // tenía NINGÚN icono (/favicon.ico daba 404 y el manifiesto traía "icons": []), y toda wallet o
  // navegador que pide el icono de la app mostraba un recuadro vacío al lado del dominio.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Chaski" },
};

export const viewport: Viewport = {
  themeColor: "#CB2A54",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={hanken.variable}>
      <body className="min-h-dvh bg-paper text-ink">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
