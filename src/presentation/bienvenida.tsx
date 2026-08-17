"use client";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { Aviso, Button, Card, Muted } from "./ui";

/**
 * WKH-063 / AC-1 · LA PRIMERA PANTALLA, que hasta esta HU no existía.
 *
 * 🔴 QUÉ DEFECTO CIERRA. La app abría DIRECTO en el formulario: lo primero que la persona veía era
 * "Paso 1 de 4" y una entrada de monto, sin una línea sobre qué es esto ni por qué darle una wallet.
 * En una app de remesas el primer trabajo de la primera pantalla no es cotizar: es contestar "¿por qué
 * te confío mi plata?" en cinco segundos.
 *
 * ⛔ Y LO QUE ESTA PANTALLA NO PUEDE HACER ES PEDIR QUE LE CREAN. Las tres frases están elegidas para
 * que ninguna sea una promesa sobre plata ajena:
 *   · "Tu plata no pasa por Chaski" — es DÓNDE quedan los USDC, que es un hecho verificable, y no
 *     "Chaski nunca toca tu plata", que es un absoluto falsable: el escrow tiene una
 *     release-authority operada por el equipo. Es la misma frase que el paso `connect` ya sostenía
 *     (y sigue sosteniendo: acá no se movió de allá, se dice también acá).
 *   · "Chaski nunca los tiene en una cuenta propia" — el límite concreto: los USDC quedan en una
 *     cuenta del contrato, nunca en una billetera de Chaski.
 *   · "no hace falta creernos" — lo más fuerte de la pantalla, y lo es porque NO afirma que seamos
 *     confiables: señala dónde ir a comprobarlo. ⛔ No se reemplaza por una frase que afirme
 *     confianza; eso convertiría la única línea honesta en marketing.
 *
 * ⛔ NO HAY MONTO NI TASA ACÁ (AC-1), y no es por prolijidad: una cifra en esta pantalla sería una
 * cotización que nadie pidió y que caduca. La cifra aparece cuando la persona pone su monto.
 *
 * ⛔ Y NO HAY NADA SOBRE RECUPERAR LOS FONDOS. Es cierto que se pueden recuperar, pero recién pasadas
 * las horas de la ventana de custodia, y esa condición no cabe en una tarjeta de bienvenida sin
 * volverse una promesa a medias. Vive en el flujo y en el destino "Recuperar", donde está escrita con
 * su condición al lado.
 *
 * AC-8 · UNA sola acción resolutiva, y va `primary`: es la que saca a la persona de esta pantalla.
 * La barra de destinos que se pinta debajo NO compite (son `<button>` planos, no `<Button>`).
 */
export function Bienvenida({ onEmpezar, disabled }: { onEmpezar: () => void; disabled?: boolean }) {
  return (
    <div className="space-y-holgado">
      <Card className="space-y-holgado text-center">
        {/* `h-14 w-14` no es un tamaño de ícono y por eso no está en la escala de S-4: es el círculo
            que lo CONTIENE. Es la MISMA receta que el paso `connect` ya pinta, y se reusa tal cual
            para que las dos pantallas de "acá se habla de tu plata" abran igual. */}
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-sand">
          <ShieldCheck className="size-icono-md text-cochineal" />
        </div>
        <div>
          <h2 className="text-title font-bold">Tu plata no pasa por Chaski</h2>
          <Muted className="mx-auto mt-ajustado max-w-xs">
            Cuando enviás, tus USDC quedan en un contrato en Solana. Chaski nunca los tiene en una
            cuenta propia.
          </Muted>
        </div>
        {/* `neutro` y no `bueno`: el verde de la app es el del dinero que llega, y acá no llegó nada
            todavía. Pintar de verde una afirmación sobre custodia la vestiría de buena noticia. */}
        <Aviso className="text-left">
          <Muted escala="label">
            Y no hace falta creernos: cada envío deja una transacción que podés abrir en el explorador
            de Solana.
          </Muted>
        </Aviso>
      </Card>
      <Button disabled={disabled} onClick={onEmpezar}>
        Empezar un envío <ArrowRight className="size-icono-sm" />
      </Button>
    </div>
  );
}
