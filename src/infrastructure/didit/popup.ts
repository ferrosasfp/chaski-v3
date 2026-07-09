// Los navegadores bloquean window.open() si NO ocurre sincrónico al gesto del usuario.
// Como la URL de Didit recién se conoce tras crear la sesión (un await después del click),
// abrimos la ventana en blanco AL click y luego la navegamos. Así el popup no se bloquea.
let pending: Window | null = null;

/** Llamar SINCRÓNICO en el handler del click (antes de cualquier await). */
export function openKycWindow(): void {
  if (typeof window === "undefined") return;
  pending = window.open("about:blank", "didit-kyc", "width=460,height=760");
}

/** Navega la ventana pre-abierta a la URL real de Didit. Fallback: intenta abrir (puede bloquearse). */
export function navigateKycWindow(url: string): Window | null {
  if (pending && !pending.closed) {
    pending.location.href = url;
    const w = pending;
    pending = null;
    return w;
  }
  return typeof window !== "undefined" ? window.open(url, "didit-kyc", "width=460,height=760") : null;
}

/** Cierra la ventana pre-abierta (p.ej. cuando el server NO tiene Didit configurado → simulación). */
export function closeKycWindow(): void {
  if (pending && !pending.closed) pending.close();
  pending = null;
}
