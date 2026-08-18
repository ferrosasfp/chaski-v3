"use client";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";
import { MARCA_SRC, NOMBRE } from "./marca";

/**
 * Marca Chaski — el mensajero andino corriendo, con su manta de tocapu y la estela de velocidad.
 *
 * 🔴 ERA UN `<svg>` INLINE Y AHORA ES LA IMAGEN DE LA MARCA (HU-066). El dibujo viejo era un camino
 * escalonado blanco rematando en un círculo de cochinilla sobre un cuadrado redondeado de tinta:
 * geometría escrita a mano que ya no es la marca de Chaski. El docblock que estaba acá describía ESE
 * dibujo ("el Qhapaq Ñan rematando en un nudo de khipu") y quedó falso con el cambio de marca, igual
 * que el comentario de la tarjeta de seguimiento (`flow.tsx`, el que abre los tres pasos).
 *
 * ⛔ EL FONDO OSCURO NO VUELVE, y la decisión se tomó MIRÁNDOLA RENDERIZADA, no razonándola. El `<svg>`
 * pintaba su propio `<rect fill="#17130F" rx="10">`, así que la marca traía un cuadrado de tinta
 * pegado. El PNG nuevo es transparente y sus colores son saturados (violeta, naranja, cian), que es
 * justo el rango que sobrevive sobre el papel claro de la app (`paper`, #FBFAF7). Medido sobre el
 * build de producción a 390x844: la marca en el header sobre el fondo de la app se lee entera y no
 * necesita ninguna superficie que la separe. Y devolverle el cuadrado sería peor que redundante: en el
 * splash, que ya es oscuro, un rectángulo de tinta con esquinas redondeadas sobre un fondo de tinta se
 * ve como un parche. El único lugar donde ese cuadrado sigue existiendo es el ÍCONO de la app
 * (`public/icon-*.png`), que es lo que un ícono necesita para recortarse contra el escritorio.
 *
 * ⛔ `object-contain` NO ES DECORATIVO Y ES LO QUE SOSTIENE EL CONTRATO DE ESTA FUNCIÓN. El `<svg>`
 * viejo tenía `viewBox="0 0 40 40"`, o sea cuadrado, y los dos sitios de llamada le pasan
 * `size-icono-lg` (32x32). El PNG es 1154x765 = **1,51:1**: sin `object-contain` el navegador lo
 * aplasta a un cuadrado y el mensajero queda deformado. Con él, la CAJA la sigue fijando el
 * `className` de quien llama —que es lo que esta función promete— y la tinta entra adentro con su
 * proporción. Los dos llamadores siguen andando sin cambiar una letra, incluido el `animate-pulse`
 * condicional de la tarjeta de seguimiento: `animate-pulse` anima la opacidad del elemento, y un
 * `<img>` la respeta igual que un `<svg>`.
 *
 * ⛔ EL NOMBRE ACCESIBLE SIGUE SIENDO "Chaski", Y SE DICE UNA SOLA VEZ. Antes era `role="img"` +
 * `aria-label="Chaski"` sobre un `<svg>`, que no tiene ninguno de los dos de fábrica. Un `<img>` sí:
 * su rol implícito ES `img` y su nombre accesible sale del `alt`. Así que el par de atributos se
 * reemplaza por UN `alt`, y NO por `alt` + `role` + `aria-label`.
 * ⚠️ ESTO NO ES UNA PREFERENCIA MÍA: escribir `role="img"` acá lo rechaza el linter del repo
 * (`a11y/noRedundantRoles`, y es ERROR, no warning), y poner `aria-label` junto al `alt` haría que el
 * nombre accesible saliera del `aria-label` con el `alt` de adorno — dos sitios para el mismo nombre y
 * uno invisible. Lo mide `marca.test.tsx` pidiendo el nodo por ROL y por NOMBRE a la vez, que es lo
 * que un lector de pantalla resuelve, y el mutante que vacía el `alt` lo pone rojo.
 */
export function ChaskiMark({ className }: { className?: string }) {
  // biome-ignore lint/performance/noImgElement: ver la nota de PAYLOAD del reporte de HU-066. `<img>` sirve el PNG tal cual (medido: 447 KB para una caja de 32x32) y `next/image` lo bajaría a un par de KB, pero pide un `sizes` en píxeles, y ese número adentro de este componente contradice su único contrato —que el tamaño lo fije el `className` de quien llama—. Queda como defecto ABIERTO y medido, no como algo que no se vio.
  return <img src={MARCA_SRC} alt={NOMBRE} className={cn("object-contain", className)} />;
}

/**
 * Los tres niveles de prominencia (ola 2 · M-4) y la regla, que esta ola corrigió.
 *
 * 🔴 LA JERARQUÍA ES RELATIVA A LO QUE **ESTA** PANTALLA OFRECE, NO UNA PROPIEDAD FIJA DEL BOTÓN. Un mismo componente puede pintarse `primary` en una pantalla y `outline` en otra, y eso es correcto por diseño: quien decide es la pantalla, no el botón.
 *
 *   `primary` → la acción que SACA A LA PERSONA DE DONDE ESTÁ. Como máximo una por pantalla. Mientras el camino feliz esté disponible, es él. Cuando el camino feliz YA NO EXISTE —el envío no se entregó, la cotización venció— la toma la acción que RESUELVE la situación, aunque mueva plata: en esa pantalla no hay nada más importante que ofrecer.
 *   `outline` → una acción real que NO resuelve la situación de esta pantalla: una alternativa, una vuelta atrás, o un escape mientras el camino feliz sigue vivo. Incluye las que mueven plata: tienen borde y superficie propia, o sea que se ven como un botón y se tocan a propósito.
 *   `ghost`   → una acción que sólo CONSULTA. Sin borde ni fondo.
 *
 * ⛔ CERO `primary` NO ES UN DEFECTO POR SÍ SOLO: una pantalla que sólo informa, o una donde lo único
 * que se puede hacer es esperar, no tiene ninguna acción resolutiva que promover. El defecto es cero
 * `primary` HABIENDO una, y es lo que el founder vio en la rama de FALLO del seguimiento: la única
 * acción posible era "Recuperar fondos" y se pintaba secundaria. Candado: `jerarquia-relativa.test.tsx`.
 *
 * 🔴 `ghost` DEJÓ DE SER `text-stone`, y no es gusto: es contraste medido. `#8A8178` sobre el fondo de la
 * app (`#FBFAF7`) da **3.66:1**, y el texto del `<Button>` es de 15px `font-semibold`, o sea texto NORMAL
 * para WCAG (el umbral de "texto grande" es 18.66px en negrita o 24px). El mínimo AA para texto normal es
 * 4.5:1, así que la variante como estaba no lo alcanzaba. `cochineal-ink` (`#9E1C40`) sobre el mismo fondo
 * da **7.46:1**. Las dos cuentas son la fórmula de luminancia relativa de WCAG 2.x sobre los hex del tema,
 * no una impresión. Y `ghost` no tenía NINGÚN sitio de llamada en 4c24324 (`grep -c 'variant="ghost"'` daba 0): era una variante muerta con un defecto de contraste esperando su primer uso, y M-4 es ese uso.
 *
 * ⛔ LO QUE LA JERARQUÍA NO PUEDE TOCAR ES EL ÁREA DE TOQUE: el `h-[52px]` vive en la clase base y NINGUNA variante lo modifica, así que subir o bajar de nivel cambia color y borde, nunca el alto (T-O2-7). `touch-targets.test.tsx` lo lee del botón renderizado.
 */
const BTN_VARIANTS: Record<string, string> = {
  primary: "bg-cochineal text-white hover:bg-cochineal-ink shadow-lift",
  outline: "border border-line bg-card text-ink hover:bg-sand",
  ghost: "bg-transparent text-cochineal-ink hover:bg-sand",
};

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "outline" | "ghost" }) {
  return (
    <button
      className={cn(
        // ⛔ `h-[52px]` SE ESCRIBE ASÍ Y NO CON UN TOKEN. `touch-targets.test.tsx` lo lee con una
        // expresión regular sobre el `className` RENDERIZADO (`h-\[(\d+)px\]`, `touch-targets.test.tsx:80`)
        // y usa ese número como la referencia contra la que mide las tres puertas de recuperar plata.
        // Un `h-cta` del tema se vería igual en pantalla y dejaría ese candado sin nada que leer.
        // `px-5` (20px) también se queda: la escala de S-4 tiene 8/12/16/24 y ninguno vale 20, así que
        // migrarlo movería el ancho del CTA. Migrar no es redondear.
        "inline-flex h-[52px] w-full items-center justify-center gap-ajustado rounded-caja px-5 text-body font-semibold transition-[transform,background-color] active:scale-[0.99] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cochineal",
        BTN_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    // `p-5` (20px) NO se migra: la escala de S-4 no tiene ese valor y el paso más cercano hacia
    // abajo (`holgado`, 16px) angostaría 4px cada tarjeta de la app. La superficie sí se migra:
    // `caja` vale exactamente lo mismo que `xl2` (S-4), así que el radio no se mueve un pixel.
    <div className={cn("rounded-caja border border-line bg-card p-5 shadow-card", className)}>
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
      {/* La etiqueta de un campo es el caso textual de `label` en S-1 ("etiquetas, píldoras,
          encabezados de fila"), y acá el cambio de rol es DELIBERADO y se ve: 14px → 12px. Es la
          contrapartida de M-2 — la etiqueta encoge para que la cifra pueda crecer sin que las dos
          compitan. `mb-ajustado` (8px) sí es un cambio de valor (era 6px): la escala no tiene 6. */}
      <span className="mb-ajustado block text-label font-medium text-stone">{label}</span>
      {children}
      {hint ? (
        <Muted as="span" escala="label" className="mt-ajustado block">
          {hint}
        </Muted>
      ) : null}
    </label>
  );
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        // `rounded-xl` → `rounded-control`: los DOS valen 0.75rem, así que la migración es exacta.
        // Y es el radio que S-4 le corresponde por posición: una entrada va SIEMPRE adentro de una
        // superficie, nunca apoyada sobre el fondo de la pantalla.
        "h-12 w-full rounded-control border border-line bg-card px-3.5 text-body text-ink outline-none transition-colors placeholder:text-stone/60 focus:border-cochineal",
        className,
      )}
      {...props}
    />
  );
}

export function Row({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-1.5">
      <Muted as="span" escala="label">
        {label}
      </Muted>
      {/* ⚠️ `tabular-nums` Y NO LA CLASE `.tabular`. `.tabular` era CSS escrito a mano en
          `app/globals.css` que hacía exactamente lo que la utilidad de fábrica: no era un token, era
          una regla suelta que ningún tema conocía, así que `cn` no podía resolverla contra nada y
          `tailwind-merge` la dejaba pasar junto a cualquier cosa. Este es uno de sus 11 sitios. */}
      <span className={cn("tabular-nums text-body font-semibold", accent ? "text-verde" : "text-ink")}>
        {value}
      </span>
    </div>
  );
}

/**
 * ⚠️ `warn` SE LLAMA `prueba` DESDE LA OLA 2 (M-6), y el cambio de nombre es la mitad del arreglo.
 *
 * La app tiene DOS señales de "esto es un entorno de prueba" y decían lo suyo en dos idiomas
 * visuales distintos: esta píldora era `bg-sand text-ink`, o sea una superficie sólida sin borde, y
 * la caja del desembolso era un punteado sobre nada. Dos afirmaciones emparentadas peleando por
 * atención con dos gramáticas. Ahora las dos hablan el punteado sobre arena, que es el mismo que ya
 * declaraba `Aviso tono="prueba"` para la identidad sin verificar: el punteado dice "esto no es
 * real" sin escribir una palabra.
 *
 * ⛔ LO QUE NO SE HIZO ES FUSIONAR LOS TEXTOS: son dos afirmaciones distintas (una habla de los
 * PASOS del envío, la otra de que el depósito en cadena sí es real) y las dos tienen tests propios.
 * Se unifica la jerarquía, no el contenido.
 *
 * Que el renombre no arrastre nada es su propia medición: `warn` era el ÚNICO tono que
 * `statusDisplay` NO devuelve (su unión es `"ok" | "active" | "bad" | "neutral"`, declarada en
 * (`statusDisplay`, `flow-vm.ts:133`)), así que sus dos sitios de llamada son las dos píldoras de
 * modo demo y ninguno más. Si algún día `statusDisplay` devolviera `prueba`, esto deja de compilar.
 */
const PILL: Record<string, string> = {
  neutral: "bg-sand text-stone",
  active: "bg-cochineal/10 text-cochineal-ink",
  ok: "bg-verde-bg text-verde",
  bad: "bg-cochineal/10 text-cochineal-ink",
  prueba: "border border-dashed border-stone/40 bg-sand/60 text-stone",
};
export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "active" | "ok" | "bad" | "prueba";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        // `rounded-full` no entra en la escala de S-4: no es un valor, es una forma. Se queda.
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-label font-semibold",
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
 * 🔴 ERAN SEIS, NO CINCO, y la que faltaba la encontró la ola 2 al cablear: `tabular text-lg
 * font-extrabold text-verde` en la caja de "Vas a enviar" del paso `connect`. O sea siete sitios y
 * seis tamaños (18, 20, 24, 30, 36). El párrafo de arriba se lee como un conteo cerrado y no lo era;
 * se corrige acá en vez de reescribirlo, porque la medición de entonces también es un dato.
 * Ese séptimo sitio NO pasa por este componente y el motivo está escrito en su propio sitio.
 *
 * ⚠️ Y LA MONEDA EN PESO MENOR SOLO SE PUEDE EN UNO DE LOS SIETE. `Money.format()` devuelve símbolo y
 * dígitos PEGADOS ("S/1,500.00"), y dos asserts de `flow.test.tsx` exigen que ese string sea un nodo
 * de texto DIRECTO. Partirlo en dos `<span>` los rompe, y uno de los dos es el guard de que la
 * pantalla nunca muestre "S/0.00". Así que `moneda` sólo se usa donde el símbolo ya vive aparte: la
 * entrada de monto del paso `send`. En los otros seis la cifra entra entera por `children`.
 *
 * LA MONEDA VA EN PESO MENOR QUE LA CIFRA porque el dato es el número: "S/" no cambia entre
 * pantallas y el número sí. Al mismo peso, los dos compiten y ninguno gana.
 *
 * ⚠️ USA `tabular-nums` DE TAILWIND Y NO LA CLASE `.tabular`. `.tabular` era CSS escrito a mano en
 * `app/globals.css` (11 usos en 40f0b68) que hacía exactamente lo que la utilidad de fábrica: no era
 * un token, era una regla suelta que ningún tema conocía. ✅ La ola 2 movió los 11 sitios y BORRÓ la
 * regla de `globals.css`, así que hoy no queda ninguna forma de escribirlo a mano.
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
