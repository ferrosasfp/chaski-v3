// Infrastructure — utilidades del sistema (la impureza vive acá, no en el dominio).
import type { Clock, IdGenerator } from "../application/ports";

export class SystemClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}

export class CryptoIds implements IdGenerator {
  newId(): string {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
