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
};
export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "active" | "ok" | "bad";
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

/** Stepper de progreso del flujo. */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`Paso ${current + 1} de ${steps.length}`}>
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
