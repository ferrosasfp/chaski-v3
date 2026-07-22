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
  description:
    "Mandá plata a tu familia en Perú con solo pedirlo. Reciben soles en su Yape, rápido y claro.",
  manifest: "/manifest.json",
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
