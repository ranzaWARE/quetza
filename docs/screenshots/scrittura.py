"""Testo -> tratti a mano libera per le schermate della guida.
Disegna il testo con un font corsivo sottile, lo assottiglia a 1 pixel
(Zhang-Suen) e ne ricava le polilinee che lo script Playwright ripassa con
il mouse sul foglio. Uso: python3 scrittura.py OUT_DIR"""
import json, sys, random
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/opentype/inter/Inter-ThinItalic.otf"

def thin(img):
    a = (img > 0).astype(np.uint8)
    changed = True
    while changed:
        changed = False
        for step in (0, 1):
            P = np.pad(a, 1)
            p2,p3,p4,p5,p6,p7,p8,p9 = (P[:-2,1:-1],P[:-2,2:],P[1:-1,2:],P[2:,2:],P[2:,1:-1],P[2:,:-2],P[1:-1,:-2],P[:-2,:-2])
            B = p2+p3+p4+p5+p6+p7+p8+p9
            seq = [p2,p3,p4,p5,p6,p7,p8,p9,p2]
            A = sum(((seq[i]==0)&(seq[i+1]==1)).astype(np.uint8) for i in range(8))
            if step == 0: c = (p2*p4*p6==0)&(p4*p6*p8==0)
            else:         c = (p2*p4*p8==0)&(p2*p6*p8==0)
            m = (a==1)&(B>=2)&(B<=6)&(A==1)&c
            if m.any(): a[m]=0; changed=True
    return a

def trace(sk):
    H,W = sk.shape
    pts = set(zip(*np.nonzero(sk)))
    def nb(p):
        y,x=p
        return [(y+dy,x+dx) for dy in (-1,0,1) for dx in (-1,0,1) if (dy or dx) and (y+dy,x+dx) in pts]
    strokes=[]
    seen=set()
    # parti dagli estremi (1 vicino), poi il resto
    order = sorted(pts, key=lambda p:(len(nb(p))!=1, p[1], p[0]))
    for s in order:
        if s in seen: continue
        path=[s]; seen.add(s); cur=s
        while True:
            n=[q for q in nb(cur) if q not in seen]
            if not n: break
            # preferisci i vicini ortogonali
            n.sort(key=lambda q: abs(q[0]-cur[0])+abs(q[1]-cur[1]))
            cur=n[0]; seen.add(cur); path.append(cur)
        if len(path)==1: path=[path[0],(path[0][0]+1,path[0][1])]
        strokes.append(path)
    return strokes

def rdp(pts, eps):
    if len(pts)<3: return pts
    a,b=np.array(pts[0],float),np.array(pts[-1],float)
    d=b-a; L=np.hypot(*d) or 1
    dists=[abs(d[0]*(p[1]-a[1])-d[1]*(p[0]-a[0]))/L for p in pts[1:-1]]
    i=int(np.argmax(dists))+1
    if dists[i-1]>eps: return rdp(pts[:i+1],eps)[:-1]+rdp(pts[i:],eps)
    return [pts[0],pts[-1]]

def text_strokes(lines, size, x0, y0, lh, scale=1.0):
    font = ImageFont.truetype(FONT, size)
    out=[]
    for li,(txt,indent) in enumerate(lines):
        w = int(font.getlength(txt))+20
        im = Image.new('L',(w,int(size*1.5)),0)
        ImageDraw.Draw(im).text((5,5),txt,font=font,fill=255)
        sk = thin(np.array(im)>100)
        st = trace(sk)
        st.sort(key=lambda s: min(p[1] for p in s))
        rnd = random.Random(li)
        for s in st:
            s = rdp(s, 0.6)
            out.append([{"x": round(x0+indent+(p[1])*scale+rnd.uniform(-.3,.3),1),
                         "y": round(y0+li*lh+(p[0])*scale+rnd.uniform(-.3,.3),1)} for p in s])
    return out

SPECS = {
 "riunione": [{"size":64,"x":70,"y":40,"lh":80,"lines":[["Riunione progetto",0]]},
              {"size":44,"x":70,"y":150,"lh":66,"lines":[["- consegna prototipo 15/11",0],["- budget approvato",0],["- Luca: preventivi fornitori",0],["  entro venerdì",0]]}],
 "collaudo": [{"size":60,"x":70,"y":40,"lh":80,"lines":[["Collaudo linea 3",0]]},
              {"size":44,"x":130,"y":150,"lh":70,"lines":[["sensori di sicurezza",0],["pressione circuito",0],["test arresto emergenza",0],["verbale firmato",0]]}],
 "stand": [{"size":60,"x":70,"y":40,"lh":80,"lines":[["Stand fiera",0]]},
           {"size":36,"x":0,"y":0,"lh":50,"lines":[["ingresso",0]]},
           {"size":36,"x":0,"y":0,"lh":50,"lines":[["macchina demo",0]]},
           {"size":36,"x":0,"y":0,"lh":50,"lines":[["desk",0]]}],
}

if __name__=="__main__":
    import os
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    for name, spec in SPECS.items():
        res = [text_strokes([(l[0], l[1]) for l in b["lines"]], b["size"], b["x"], b["y"], b["lh"], b.get("scale", 1)) for b in spec]
        json.dump(res, open(os.path.join(out, f"strokes-{name}.json"), "w"))
