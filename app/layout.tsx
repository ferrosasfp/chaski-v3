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
  // Los genera scripts/generate-icons.py. ⚠️ ACÁ DECÍA "desde la geometría de ChaskiMark" Y HU-066 LO
  // VOLVIÓ FALSO: `ChaskiMark` dejó de ser geometría escrita a mano y el script ahora compone
  // `public/marca-chaski.png` sobre el cuadrado de tinta. No era un comentario viejo y nada más — el
  // script SEGUÍA dibujando el logo anterior, así que correrlo habría pisado estos iconos con la marca
  // vieja, en silencio y con exit 0. Sin ellos el sitio no tenía NINGÚN icono (/favicon.ico daba 404 y
  // el manifiesto traía "icons": []), y toda wallet o navegador que pide el icono de la app mostraba
  // un recuadro vacío al lado del dominio.
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

// Acá había `maximumScale: 1`, o sea un techo de zoom de 1x declarado para toda la app. Quien no ve
// bien de cerca no podía agrandar NINGUNA pantalla de Chaski, ni el CCI que tiene que revisar antes
// de mandar plata.
//
// Se OMITE, no se sube a `maximumScale: 5`: omitirlo deja el techo que trae el navegador; poner un
// número pone un techo nuevo que nadie pidió. `initialScale: 1` se queda — fija el zoom de ENTRADA,
// no el máximo.
//
// El candado es `app/viewport.test.ts` (T-341-1): se pone en rojo si `maximumScale` o
// `user-scalable` vuelven a este bloque.
// `viewportFit: "cover"` (D-1) es la mitad que vive acá del manejo de área segura. Sin él, el
// navegador encoge la ventana hasta el rectángulo seguro y las cuatro variables
// `env(safe-area-inset-*)` valen 0 SIEMPRE: los tokens `p-segura-*` de `tailwind.config.ts`
// existirían y no harían nada. Con él, la ventana ocupa la pantalla entera y el padding del
// contenedor es lo único que separa el contenido del notch. Las dos mitades sólo sirven juntas, y
// romper cualquiera de las dos devuelve el defecto original.
//
// Se agrega una PROPIEDAD al bloque y no se lo reformatea: el candado (`hasta`,
// `viewport.test.ts:42`) recorta el fuente desde `export const viewport` hasta el primer cierre a
// comienzo de línea, así que colapsar este objeto a una línea lo dejaría midiendo otra cosa.
export const viewport: Viewport = {
  themeColor: "#CB2A54",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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
