"use client";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

/** Marca Chaski — el Qhapaq Ñan (camino escalonado andino) rematando en un nudo de khipu. */
export function ChaskiMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} role="img" aria-label="Chaski">
      <rect width="40" height="40" rx="10" fill="#17130F" />
      <path
        d="M7 27 L7 23 L11 23 L11 19 L15 19 L15 15 L19 15"
        stroke="#FBFAF7"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="square"
      />
      <circle cx="27" cy="15" r="5.2" fill="#CB2A54" />
      <circle cx="27" cy="15" r="1.8" fill="#17130F" />
    </svg>
  );
}

const BTN_VARIANTS: Record<string, string> = {
  primary: "bg-cochineal text-white hover:bg-cochineal-ink shadow-lift",
  outline: "border border-line bg-card text-ink hover:bg-sand",
  ghost: "bg-transparent text-stone hover:bg-sand hover:text-ink",
};

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "outline" | "ghost" }) {
  return (
    <button
      className={cn(
        "inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-xl2 px-5 text-[15px] font-semibold transition-[transform,background-color] active:scale-[0.99] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cochineal",
        BTN_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-xl2 border border-line bg-card p-5 shadow-card", className)}>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    // <Field> es un wrapper generico: el control real llega por `children` (siempre un <TextInput>
    // en los call sites) y el <label> lo ENVUELVE, que es una asociacion valida. La regla no puede
    // verlo porque `children` es opaco en analisis estatico.
    // biome-ignore lint/a11y/noLabelWithoutControl: el control llega por `children` (ver arriba).
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-stone">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-stone">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-12 w-full rounded-xl border border-line bg-card px-3.5 text-[15px] text-ink outline-none transition-colors placeholder:text-stone/60 focus:border-cochineal",
        className,
      )}
      {...props}
    />
  );
}

export function Row({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-1.5">
      <span className="text-sm text-stone">{label}</span>
      <span className={cn("tabular text-[15px] font-semibold", accent ? "text-verde" : "text-ink")}>
        {value}
      </span>
    </div>
  );
}

const PILL: Record<string, string> = {
  neutral: "bg-sand text-stone",
  active: "bg-cochineal/10 text-cochineal-ink",
  ok: "bg-verde-bg text-verde",
  bad: "bg-cochineal/10 text-cochineal-ink",
  warn: "bg-sand text-ink",
};
export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "active" | "ok" | "bad" | "warn";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold",
        PILL[tone],
      )}
    >
      {children}
    </span>
  );
}

// ══ Ola 1 de rediseño · piezas NUEVAS, todavía sin sitios de llamada ═══════════════════════════
//
// ⚠️ LEER ESTO ANTES DE JUZGAR LA COBERTURA. Lo que sigue se CREA en esta ola y se CABLEA en la
// ola 2. O sea que hoy sus únicos llamadores son los tests, y este repo ya tiene escrita la lección
// de que un componente cuyos únicos llamadores viven en `*.test.*` NO tiene cableado probado. Acá
// eso es deliberado y no un descuido: mover los sitios de llamada es lo que cambia las pantallas, y
// se quiso que el cambio de vocabulario y el cambio de pantallas fueran dos revisiones separadas.
// Mientras tanto, lo único que se puede afirmar de estas piezas es que emiten lo que dicen emitir.
// Que la app las use no se puede afirmar todavía, y no se afirma.

/**
 * S-2 · El texto secundario, que estaba escrito 76 veces a mano.
 *
 * LO QUE HABÍA, medido en 40f0b68 sobre los `.tsx` que no son test: `text-xs text-stone` 50 veces y
 * `text-sm text-stone` 26. Setenta y seis decisiones idénticas tomadas de a una, que es la forma en
 * que una de ellas termina distinta sin que nadie se entere.
 *
 * 🔴 EMITE `text-stone` Y NO UN COLOR EQUIVALENTE, Y ESO ES UN REQUISITO, NO UNA PREFERENCIA.
 * `history-onchain.test.tsx` assertea `expect(devuelto.className).toContain("text-stone")` sobre el
 * párrafo REALMENTE renderizado, y lo usa para distinguir la fila que ya se resolvió de la que
 * todavía tiene plata recuperable. Un componente que "hiciera lo mismo" con otra clase del mismo
 * gris rompería ese candado, y el candado está cuidando una distinción sobre plata de una persona.
 */
export function Muted({
  escala = "support",
  as: Tag = "p",
  className,
  children,
}: {
  /** `support` para la explicación que se lee de corrido; `label` para etiquetas y renglones. */
  escala?: "support" | "label";
  as?: "p" | "span" | "div";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag className={cn(escala === "label" ? "text-label" : "text-support", "text-stone", className)}>
      {children}
    </Tag>
  );
}

/**
 * S-3 · Las cajas de aviso, que eran 14 sitios y 6 recetas copiadas.
 *
 * MEDIDO en `flow.tsx` de 40f0b68, y el encargo decía 18 cajas: los sitios que coinciden EXACTO con
 * alguna de las recetas son 14, no 18. Se anota el número medido y no el heredado.
 *   · `space-y-3 rounded-xl2 border border-line bg-sand/60 p-4`      ×3  (más 1 casi igual)
 *   · `rounded-xl bg-sand px-4 py-3 text-center`                     ×3
 *   · `rounded-xl bg-verde-bg px-4 py-*`                             ×3  (en tres paddings distintos)
 *   · punteadas sobre `bg-sand/60`                                   ×3
 *   · la caja de error `border-cochineal/20 bg-cochineal/5`          ×1
 *   · `rounded-lg border border-line px-3 py-2`                      ×1
 * Ninguna de las 14 pasa por `<Card>`.
 *
 * POR QUÉ UN COMPONENTE CON `tono` Y NO CUATRO COMPONENTES: es la forma que este archivo ya usa para
 * `<Pill tone>` y para `<Button variant>`, así que no inventa un patrón nuevo para el mismo problema.
 *
 * ⚠️ Y POR QUÉ NO TRAE `flex`: de las tres cajas verdes, una es `flex items-center`, otra es
 * `text-left` a secas y la tercera no tiene ninguna de las dos. La caja aporta la SUPERFICIE (radio,
 * borde, fondo, padding), que es lo que las 14 repiten; la disposición del contenido la pone el
 * sitio de llamada, que es lo que en las 14 cambia. Meter el `flex` adentro habría obligado a tres
 * props para desactivarlo.
 */
const AVISO: Record<string, string> = {
  /** El bloque informativo de fondo arena. El más usado. */
  neutro: "border border-line bg-sand/60",
  /** Algo salió bien, o algo está garantizado. */
  bueno: "bg-verde-bg",
  /** Algo requiere atención o falló. Es el único que trae color de texto propio. */
  atencion: "border border-cochineal/20 bg-cochineal/5 text-cochineal-ink",
  /** Entorno de prueba. El punteado es lo que dice "esto no es real" sin escribir una palabra. */
  prueba: "border border-dashed border-stone/40 bg-sand/60",
};

export function Aviso({
  tono = "neutro",
  className,
  children,
}: {
  tono?: "neutro" | "bueno" | "atencion" | "prueba";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("rounded-control px-holgado py-normal", AVISO[tono], className)}>
      {children}
    </div>
  );
}

/**
 * S-5 · El monto. Era el producto de la app y tenía cinco recetas incompatibles.
 *
 * MEDIDO en `flow.tsx` de 40f0b68, y acá el encargo decía TRES recetas: son cinco.
 *   · `tabular text-3xl font-extrabold text-verde`                    ×3
 *   · `tabular text-4xl font-extrabold` + ternario de color           ×1
 *   · `text-2xl font-bold text-stone` (el signo `$`)                  ×1
 *   · `tabular text-2xl font-extrabold text-verde`                    ×1  ← la que faltaba en la lista
 *   · `tabular text-4xl font-extrabold tracking-heading` (la entrada) ×1  ← y esta también
 * Cinco tamaños distintos (18, 24, 30, 36) y dos pesos para la MISMA cosa: la cifra que la persona
 * vino a ver. Con la escala cerrada de S-1 son todas `text-money`.
 *
 * LA MONEDA VA EN PESO MENOR QUE LA CIFRA porque el dato es el número: "S/" no cambia entre
 * pantallas y el número sí. Al mismo peso, los dos compiten y ninguno gana.
 *
 * ⚠️ USA `tabular-nums` DE TAILWIND Y NO LA CLASE `.tabular`. `.tabular` es CSS escrito a mano en
 * `app/globals.css` (11 usos en 40f0b68) que hace exactamente lo que la utilidad de fábrica: no es
 * un token, es una regla suelta que ningún tema conoce. Se deja en su lugar porque los 11 sitios se
 * mueven en la ola 2; lo que NO se hace es sumarle un uso nuevo desde acá.
 *
 * Por qué importa que las cifras sean de ancho fijo: en `track` el monto se actualiza en el lugar, y
 * con cifras de ancho variable el número entero se corre de costado en cada refresco.
 */
export function Money({
  moneda,
  tono = "ink",
  className,
  children,
}: {
  /** "S/", "$", "USDC". Se pinta más chico y más liviano que la cifra. */
  moneda?: string;
  tono?: "ink" | "verde" | "stone";
  className?: string;
  children: ReactNode;
}) {
  const color = tono === "verde" ? "text-verde" : tono === "stone" ? "text-stone" : "text-ink";
  return (
    <span className={cn("inline-flex items-baseline gap-ajustado tabular-nums", color, className)}>
      {moneda === undefined ? null : (
        <span className="text-title font-semibold opacity-70">{moneda}</span>
      )}
      <span className="text-money font-extrabold">{children}</span>
    </span>
  );
}

/** Stepper de progreso del flujo. */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    // El aria-label vivia en este <div>, que tiene rol implicito `generic` y por lo tanto NO lo
    // expone a lectores de pantalla (el texto no se anunciaba). Se reemplaza por texto real
    // visualmente oculto: se anuncia de verdad y no cambia el layout (sr-only sale del flujo).
    <div className="flex items-center gap-1.5">
      <span className="sr-only">{`Paso ${current + 1} de ${steps.length}`}</span>
      {steps.map((s, i) => (
        <div
          key={s}
          className={cn(
            "h-1.5 flex-1 rounded-full transition-colors",
            i <= current ? "bg-cochineal" : "bg-line",
          )}
        />
      ))}
    </div>
  );
}
