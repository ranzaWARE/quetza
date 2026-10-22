"""Ritaglia e comprime le schermate in docs/img/*.webp. Uso: python3 ritaglia.py WORK_DIR"""
from PIL import Image
import os, sys
WORK=sys.argv[1]
OUT=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),'img')
C={
 'login':(390,180,890,615),
 'cambio-password':(450,235,830,565),
 'libreria':(0,0,1280,450),
 'libreria-scuro':(0,0,1280,450),
 'ricerca':(0,0,700,330),
 'registrazione':None,'riascolto':None,'trascrizione':None,'editor-scuro':None,
 'condividi':(470,245,810,555),
 'forme':(400,85,880,520),
 'admin':(150,245,1130,470),
 'admin-sso':(150,245,1130,735),
 'admin-ldap':(150,245,1130,800),
 'admin-backup':(150,245,1130,640),
 'admin-whisper':(150,245,1130,730),
}
tot=0
for n,box in C.items():
    im=Image.open(os.path.join(WORK,'out',f'{n}.png')).convert('RGB')
    if box: im=im.crop(tuple(v*2 for v in box))
    maxw=1600 if box is None or (box[2]-box[0])>900 else (box[2]-box[0])*2
    if im.width>maxw: im=im.resize((maxw,round(im.height*maxw/im.width)),Image.LANCZOS)
    p=f'{OUT}/{n}.webp'; im.save(p,'WEBP',quality=78,method=6)
    s=os.path.getsize(p); tot+=s; print(n,im.size,s//1024,'KB')
print('totale',tot//1024,'KB')
