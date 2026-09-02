#!/usr/bin/env python3
"""Clasificador prosa/codigo de CD-49 (HU 071). Solo biblioteca estandar.

Las cinco reglas de CD-49, en ESTE orden, sobre la forma strip()-eada de la linea:
  1. si venimos dentro de un bloque abierto  -> prosa, y si contiene el cierre el bloque cierra
  2. si esta vacia                           -> vacia
  3. si empieza con el abre-bloque de JSX/C  -> prosa, y ABRE bloque salvo que traiga su cierre
  4. si empieza con //, /// o *              -> prosa
  5. el resto                                -> codigo
Un comentario al FINAL de una linea con codigo cuenta como CODIGO.

Invariantes propios (lo que lo vuelve un control y no un impresor):
  I-1  codigo + prosa + vacias == wc -l del archivo.
  I-2  imprime la ruta ABSOLUTA que resolvio para cada fila (los 11 archivos viven en TRES repos).
  I-3  una fila cuyo archivo no existe se reporta [NO MEDIDO] y NO cuenta como fallo.
       "No pude leerlo" NO es "no reproduce".

CD-W0-5: la lista de rutas de --selftest es LITERAL, nunca un glob, y este script NO esta en ella.
"""

import argparse
import os
import sys

# CD-49: el abre-bloque incluye la forma JSX. M-C49 borra la segunda alternativa de esta linea.
ABRE_BLOQUE = ("/*", "{/*")
CIERRA_BLOQUE = "*/"
PROSA_LINEA = ("//", "*")

CHASKI, FACILITATOR, PROGRAMS = "chaski", "facilitator", "programs"

# Los 11 archivos destino, con su valor ESPERADO (codigo, prosa, vacias). Lista LITERAL.
ESPERADO = [
    (CHASKI, "src/infrastructure/escrow-index-limits.ts", 1, 47, 0),
    (CHASKI, "src/application/solana-escrow-rent.ts", 34, 307, 20),
    (FACILITATOR, "src/methods/solana-sponsor/deposit-shape.ts", 43, 167, 17),
    (CHASKI, "src/presentation/flow-vm.ts", 465, 1218, 68),
    (CHASKI, "contracts/vendored/solana-sponsor-limits.fixture.ts", 17, 35, 5),
    (CHASKI, "src/infrastructure/solana-wallet.ts", 1047, 1337, 114),
    (FACILITATOR, "src/methods/solana-sponsor/cr1.ts", 329, 369, 23),
    (PROGRAMS, "programs/escrow/src/lib.rs", 400, 391, 69),
    (FACILITATOR, "src/routes/solana-sponsor.ts", 316, 302, 24),
    (CHASKI, "src/presentation/flow.tsx", 2269, 2070, 114),
    (FACILITATOR, "src/core/solana-sponsor-cap.ts", 97, 53, 8),
]


def clasificar(lineas):
    """Aplica las 5 reglas de CD-49 y devuelve (codigo, prosa, vacias)."""
    codigo = prosa = vacias = 0
    en_bloque = False
    for cruda in lineas:
        s = cruda.strip()
        if en_bloque:  # regla 1
            prosa += 1
            if CIERRA_BLOQUE in s:
                en_bloque = False
            continue
        if s == "":  # regla 2
            vacias += 1
            continue
        if s.startswith(ABRE_BLOQUE):  # regla 3
            prosa += 1
            if CIERRA_BLOQUE not in s:
                en_bloque = True
            continue
        if s.startswith(PROSA_LINEA):  # regla 4
            prosa += 1
            continue
        codigo += 1  # regla 5
    return codigo, prosa, vacias


def medir(ruta_abs):
    """Devuelve (codigo, prosa, vacias, wc_l) o None si el archivo no existe (I-3)."""
    if not os.path.isfile(ruta_abs):
        return None
    with open(ruta_abs, "r", encoding="utf-8", errors="surrogateescape") as fh:
        texto = fh.read()
    wc_l = texto.count("\n")  # exactamente lo que cuenta /usr/bin/wc -l
    lineas = texto.split("\n")
    if lineas and lineas[-1] == "":
        lineas.pop()  # el elemento vacio del split final NO es una linea (I-1)
    codigo, prosa, vacias = clasificar(lineas)
    return codigo, prosa, vacias, wc_l


def razon(codigo, prosa):
    if codigo == 0:
        return "s/d"
    return "%.2f" % (prosa / codigo)


def raices(args):
    aqui = os.path.dirname(os.path.abspath(__file__))
    chaski = os.path.abspath(args.chaski) if args.chaski else os.path.dirname(aqui)
    padre = os.path.dirname(chaski)
    fac = os.path.abspath(args.facilitator or os.path.join(padre, "wasiai-facilitator"))
    prog = os.path.abspath(args.programs or os.path.join(padre, "solana-programs"))
    return {CHASKI: chaski, FACILITATOR: fac, PROGRAMS: prog}


def selftest(args):
    r = raices(args)
    print("raices resueltas (I-2):")
    for k in (CHASKI, FACILITATOR, PROGRAMS):
        print("  %-12s %s" % (k, r[k]))
    print("")
    fallos, no_medidos, ok = [], [], 0
    for i, (repo, rel, e_cod, e_pro, e_vac) in enumerate(ESPERADO, start=1):
        ruta = os.path.join(r[repo], rel)
        m = medir(ruta)
        if m is None:  # I-3
            no_medidos.append(i)
            print("[%2d] [NO MEDIDO] %s :: %s" % (i, repo, rel))
            print("     ruta: %s (no existe)" % ruta)
            continue
        cod, pro, vac, wc_l = m
        e_raz, raz = razon(e_cod, e_pro), razon(cod, pro)
        malas = []
        if cod != e_cod:
            malas.append("codigo %d != esperado %d" % (cod, e_cod))
        if pro != e_pro:
            malas.append("prosa %d != esperado %d" % (pro, e_pro))
        if vac != e_vac:
            malas.append("vacias %d != esperado %d" % (vac, e_vac))
        if raz != e_raz:
            malas.append("razon %s != esperado %s" % (raz, e_raz))
        if cod + pro + vac != wc_l:  # I-1
            malas.append("I-1 ROTO: %d+%d+%d=%d != wc-l %d" % (cod, pro, vac, cod + pro + vac, wc_l))
        estado = "OK  " if not malas else "FALLA"
        print("[%2d] %s %s :: %s" % (i, estado, repo, rel))
        print("     ruta: %s" % ruta)
        print("     codigo=%d prosa=%d vacias=%d razon=%s total=%d wc-l=%d"
              % (cod, pro, vac, raz, cod + pro + vac, wc_l))
        if malas:
            for m2 in malas:
                print("     x %s" % m2)
            fallos.append(i)
        else:
            ok += 1
    print("")
    print("SELFTEST: %d/%d reproducen (fallan: %s | no medidas: %s)"
          % (ok, len(ESPERADO), fallos or "ninguna", no_medidos or "ninguna"))
    return 1 if fallos else 0


def sueltos(rutas):
    for ruta in rutas:
        abs_r = os.path.abspath(ruta)
        m = medir(abs_r)
        if m is None:
            print("[NO MEDIDO] %s" % abs_r)
            continue
        cod, pro, vac, wc_l = m
        print("%s" % abs_r)
        print("  codigo=%d prosa=%d vacias=%d razon=%s total=%d wc-l=%d i1=%s"
              % (cod, pro, vac, razon(cod, pro), cod + pro + vac, wc_l,
                 "OK" if cod + pro + vac == wc_l else "ROTO"))
    return 0


def main():
    p = argparse.ArgumentParser(description="Clasificador prosa/codigo de CD-49 (HU 071).")
    p.add_argument("--selftest", action="store_true", help="corre las 11 filas de referencia")
    p.add_argument("--chaski", default=None, help="raiz de chaski-v3 (default: la raiz de este repo)")
    p.add_argument("--facilitator", default=None, help="raiz de wasiai-facilitator (default: ../)")
    p.add_argument("--programs", default=None, help="raiz de solana-programs (default: ../)")
    p.add_argument("archivos", nargs="*", help="archivos sueltos a clasificar")
    args = p.parse_args()
    if args.selftest:
        return selftest(args)
    if args.archivos:
        return sueltos(args.archivos)
    p.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
