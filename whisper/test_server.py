"""Test del servizio Whisper: multi-sessione, modello e token per richiesta.
Usa un ffmpeg finto (registra gli argomenti) e modelli stub."""
import io, os, sys, json, stat, tempfile, textwrap

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

# ── ffmpeg finto: registra argv e crea il file di output ──────────────
fake_bin = tempfile.mkdtemp(prefix='fakebin_')
ARGS_LOG = os.path.join(fake_bin, 'args.log')
ffmpeg = os.path.join(fake_bin, 'ffmpeg')
with open(ffmpeg, 'w') as f:
    f.write(textwrap.dedent(f'''\
        #!/usr/bin/env python3
        import sys, wave, struct
        with open({ARGS_LOG!r}, 'a') as log:
            log.write('\\x00'.join(sys.argv[1:]) + '\\n')
        out = sys.argv[-1]
        w = wave.open(out, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(struct.pack('<h', 0) * 1600); w.close()
    '''))
os.chmod(ffmpeg, os.stat(ffmpeg).st_mode | stat.S_IEXEC)
os.environ['PATH'] = fake_bin + os.pathsep + os.environ['PATH']
os.environ['HF_TOKEN'] = ''          # diarizzazione off salvo token esplicito

import server as svc

# ── Stub dei modelli pesanti ─────────────────────────────────────────
class FakeSeg:
    def __init__(self, s, e, t): self.start, self.end, self.text = s, e, t
class FakeInfo:
    language = 'it'
class FakeModel:
    def __init__(self, name): self.name = name
    def transcribe(self, path, **kw):
        return iter([FakeSeg(0.0, 1.5, 'ciao'), FakeSeg(1.5, 3.0, 'mondo')]), FakeInfo()

used = {}
def fake_get_whisper(model_name=None):
    used['model'] = model_name or svc.WHISPER_MODEL
    return FakeModel(used['model'])
svc.get_whisper = fake_get_whisper

class FakeAnn:
    def itertracks(self, yield_label=True):
        class T:
            def __init__(s, a, b): s.start, s.end = a, b
        return [(T(0.0, 1.5), None, 'SPEAKER_00'), (T(1.5, 3.0), None, 'SPEAKER_01')]
def fake_get_diarizer(hf_token=None):
    used['token'] = hf_token
    return lambda path: FakeAnn()
svc.get_diarizer = fake_get_diarizer

client = svc.app.test_client()
fails = 0
def check(name, cond, extra=''):
    global fails
    print(f"{'  ok  ' if cond else ' FAIL '} {name}{' → ' + str(extra) if extra else ''}")
    if not cond: fails += 1

def last_args():
    with open(ARGS_LOG) as f:
        return f.read().strip().split('\n')[-1].split('\x00')

def audio(n):
    return (io.BytesIO(b'\x1aE\xdf\xa3fakewebm' + bytes([n])), f'session_{n}.webm')

print('\n── Sessione singola ──────────────────────')
r = client.post('/transcribe', data={'audio': audio(0), 'diarize': 'false'},
                content_type='multipart/form-data')
check('HTTP 200', r.status_code == 200, r.status_code)
d = r.get_json()
check('testo trascritto', d['text'] == 'ciao mondo', d.get('text'))
check('conta 1 sessione', d['sessions'] == 1, d.get('sessions'))
a = last_args()
check('ffmpeg senza filtro concat per 1 file', '-filter_complex' not in a)
check('output mono 16 kHz', '-ac' in a and a[a.index('-ac')+1] == '1' and a[a.index('-ar')+1] == '16000')

print('\n── Sessioni multiple (il bug principale) ─')
r = client.post('/transcribe',
                data={'audio': [audio(0), audio(1), audio(2)], 'diarize': 'false'},
                content_type='multipart/form-data')
check('HTTP 200', r.status_code == 200, r.status_code)
d = r.get_json()
check('conta 3 sessioni', d['sessions'] == 3, d.get('sessions'))
a = last_args()
check('ffmpeg riceve 3 input', a.count('-i') == 3, f"{a.count('-i')} input")
check('usa il filtro concat', '-filter_complex' in a)
filt = a[a.index('-filter_complex') + 1] if '-filter_complex' in a else ''
check('concat su 3 flussi audio', filt == '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]', filt)

print('\n── Modello e token dal pannello admin ────')
r = client.post('/transcribe', data={'audio': audio(0), 'model': 'medium', 'diarize': 'false'},
                content_type='multipart/form-data')
check('usa il modello richiesto', used.get('model') == 'medium', used.get('model'))
r = client.post('/transcribe', data={'audio': audio(0), 'model': 'large-v3',
                                     'hf_token': 'hf_test123', 'diarize': 'true'},
                content_type='multipart/form-data')
d = r.get_json()
check('usa il token richiesto', used.get('token') == 'hf_test123', used.get('token'))
check('diarizzazione attiva col token', d.get('diarized') is True, d.get('diarized'))
check('due parlanti riconosciuti', d.get('speakers') == 2, d.get('speakers'))
check('etichette normalizzate', d['segments'][0]['speaker_label'] == 'Persona 1',
      d['segments'][0].get('speaker_label'))

print('\n── Diarizzazione senza token ─────────────')
r = client.post('/transcribe', data={'audio': audio(0), 'diarize': 'true'},
                content_type='multipart/form-data')
check('ricade su trascrizione semplice', r.get_json().get('diarized') is False)

print('\n── Errori ────────────────────────────────')
r = client.post('/transcribe', data={}, content_type='multipart/form-data')
check('senza audio → 400', r.status_code == 400, r.status_code)

print('\n── Health ────────────────────────────────')
h = client.get('/health').get_json()
check('health risponde ok', h['ok'] is True)
check('health espone busy', 'busy' in h)

print(f"\n{'✓ tutti i test passati' if fails == 0 else '✗ ' + str(fails) + ' test falliti'}\n")
sys.exit(0 if fails == 0 else 1)
