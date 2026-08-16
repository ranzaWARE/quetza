"""
Quetza Whisper Service
Trascrizione audio con diarizzazione dei parlanti.
Esposto su :9876, usato internamente da Quetza Node.
"""

import os
import io
import json
import shutil
import subprocess
import tempfile
import threading
import logging
from pathlib import Path
from flask import Flask, request, jsonify

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

# pyannote.audio 3.3.2 chiama internamente hf_hub_download(use_auth_token=...),
# ma le versioni recenti di huggingface_hub hanno rimosso quel parametro
# (rinominato in `token`), causando "unexpected keyword argument". Pinnare
# huggingface_hub a una versione vecchia è fragile (dipende da quale versione
# esatta lo aveva ancora, e da lì in poi rompe altro). Questo shim intercetta
# la vecchia keyword e la traduce, indipendentemente dalla versione installata.
# Va fatto PRIMA che pyannote importi hf_hub_download (import lazy in
# get_diarizer), così il suo `from huggingface_hub import hf_hub_download`
# vede già la versione patchata.
import huggingface_hub as _hf_hub
_orig_hf_hub_download = _hf_hub.hf_hub_download
def _hf_hub_download_compat(*args, **kwargs):
    if 'use_auth_token' in kwargs and 'token' not in kwargs:
        kwargs['token'] = kwargs.pop('use_auth_token')
    return _orig_hf_hub_download(*args, **kwargs)
_hf_hub.hf_hub_download = _hf_hub_download_compat

app = Flask(__name__)

MODEL_DIR     = os.environ.get('MODEL_DIR', '/app/models')
WHISPER_MODEL = os.environ.get('WHISPER_MODEL', 'small')
HF_TOKEN      = os.environ.get('HF_TOKEN', '')
LANGUAGE      = os.environ.get('LANGUAGE', 'it')

# Cache dei modelli caricati, per nome/token: il modello può essere cambiato
# dal pannello admin di Quetza e arriva come campo della richiesta, quindi
# non è più un singolo modello fissato all'avvio del container.
_whisper_cache = {}
_diarize_cache = {}
_model_lock = threading.Lock()

# Una sola trascrizione alla volta: il server è threaded (per non bloccare
# /health durante un job lungo) ma i modelli sono pesanti in RAM e CPU.
_work_lock = threading.Lock()

def get_whisper(model_name=None):
    name = model_name or WHISPER_MODEL
    with _model_lock:
        if name not in _whisper_cache:
            from faster_whisper import WhisperModel
            log.info(f'Loading Whisper model: {name}')
            _whisper_cache[name] = WhisperModel(
                name,
                device='cpu',
                compute_type='int8',
                download_root=MODEL_DIR
            )
            log.info(f'Whisper model loaded: {name}')
        return _whisper_cache[name]

def get_diarizer(hf_token=None):
    token = hf_token or HF_TOKEN
    if not token:
        raise RuntimeError('HF_TOKEN non configurato — necessario per pyannote')
    with _model_lock:
        if token not in _diarize_cache:
            from pyannote.audio import Pipeline
            import torch
            log.info('Loading pyannote diarization pipeline...')
            pipeline = Pipeline.from_pretrained(
                'pyannote/speaker-diarization-3.1',
                use_auth_token=token,
                cache_dir=MODEL_DIR
            )
            pipeline.to(torch.device('cpu'))
            _diarize_cache[token] = pipeline
            log.info('Pyannote pipeline loaded')
        return _diarize_cache[token]

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'ok': True,
        'whisper_model': WHISPER_MODEL,
        'loaded_models': sorted(_whisper_cache.keys()),
        'diarization': bool(HF_TOKEN),
        'busy': _work_lock.locked(),
        'language': LANGUAGE
    })

def merge_audio(paths, workdir):
    """
    Unisce più sessioni di registrazione in un unico file WAV mono 16 kHz.

    I blob WebM di sessioni diverse non si possono concatenare a livello di byte:
    ognuno ha il proprio header di container e ffmpeg decodificherebbe solo il
    primo. Il filtro concat di ffmpeg lavora sui flussi decodificati, quindi
    regge anche sessioni con formati diversi (webm/mp4).
    """
    out = os.path.join(workdir, 'merged.wav')

    if len(paths) == 1:
        cmd = ['ffmpeg', '-nostdin', '-y', '-i', paths[0],
               '-ac', '1', '-ar', '16000', '-vn', out]
    else:
        cmd = ['ffmpeg', '-nostdin', '-y']
        for p in paths:
            cmd += ['-i', p]
        streams = ''.join(f'[{i}:a]' for i in range(len(paths)))
        cmd += ['-filter_complex', f'{streams}concat=n={len(paths)}:v=0:a=1[out]',
                '-map', '[out]', '-ac', '1', '-ar', '16000', out]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(out):
        tail = (proc.stderr or '').strip().splitlines()[-4:]
        raise RuntimeError('ffmpeg: ' + ' | '.join(tail))
    return out

@app.route('/transcribe', methods=['POST'])
def transcribe():
    """
    POST /transcribe
    Body: multipart/form-data con uno o più campi 'audio' (una per sessione
    di registrazione, in ordine cronologico).
    Opzionali: 'diarize=true', 'model' (modello Whisper), 'hf_token'.
    """
    audio_files = request.files.getlist('audio')
    if not audio_files:
        return jsonify({'error': 'Campo audio mancante'}), 400

    model_name = (request.form.get('model') or '').strip() or None
    hf_token   = (request.form.get('hf_token') or '').strip() or HF_TOKEN
    do_diarize = request.form.get('diarize', 'true').lower() == 'true' and bool(hf_token)

    workdir = tempfile.mkdtemp(prefix='quetza_')
    try:
        paths = []
        for i, f in enumerate(audio_files):
            suffix = Path(f.filename or 'audio.wav').suffix or '.wav'
            p = os.path.join(workdir, f'session_{i}{suffix}')
            f.save(p)
            paths.append(p)

        log.info(f'Transcribe: {len(paths)} sessione/i, model={model_name or WHISPER_MODEL}, diarize={do_diarize}')

        with _work_lock:
            audio_path = merge_audio(paths, workdir)
            if do_diarize:
                result = transcribe_with_diarization(audio_path, model_name, hf_token)
            else:
                result = transcribe_only(audio_path, model_name)

        result['sessions'] = len(paths)
        return jsonify(result)
    except Exception as e:
        log.error(f'Transcription error: {e}', exc_info=True)
        return jsonify({'error': str(e)}), 500
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

def transcribe_only(audio_path, model_name=None):
    """Trascrizione semplice senza diarizzazione."""
    model = get_whisper(model_name)
    segments, info = model.transcribe(
        audio_path,
        language=LANGUAGE,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500)
    )
    text_parts = []
    segments_out = []
    for seg in segments:
        text_parts.append(seg.text.strip())
        segments_out.append({
            'start': round(seg.start, 2),
            'end':   round(seg.end, 2),
            'text':  seg.text.strip()
        })

    return {
        'text':     ' '.join(text_parts),
        'segments': segments_out,
        'diarized': False,
        'language': info.language
    }

def transcribe_with_diarization(audio_path, model_name=None, hf_token=None):
    """Trascrizione + diarizzazione: chi ha detto cosa."""
    # 1. Diarizzazione: chi parla quando
    log.info('Running diarization...')
    diarizer = get_diarizer(hf_token)
    diarization = diarizer(audio_path)

    # Raccogli i turni dei parlanti
    turns = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        turns.append({
            'start':   round(turn.start, 2),
            'end':     round(turn.end, 2),
            'speaker': speaker
        })

    # 2. Trascrizione Whisper su tutto l'audio
    log.info('Running Whisper transcription...')
    model = get_whisper(model_name)
    segments, info = model.transcribe(
        audio_path,
        language=LANGUAGE,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=300),
        word_timestamps=True
    )
    whisper_segments = list(segments)

    # 3. Associa ogni segmento Whisper al parlante (overlap maggiore vince)
    def find_speaker(start, end):
        best = None
        best_overlap = 0
        for t in turns:
            overlap = min(end, t['end']) - max(start, t['start'])
            if overlap > best_overlap:
                best_overlap = overlap
                best = t['speaker']
        return best or 'Sconosciuto'

    # 4. Raggruppa segmenti consecutivi dello stesso parlante
    grouped = []
    current_speaker = None
    current_texts = []
    current_start = 0
    current_end = 0

    for seg in whisper_segments:
        speaker = find_speaker(seg.start, seg.end)
        if speaker != current_speaker:
            if current_speaker is not None and current_texts:
                grouped.append({
                    'speaker': current_speaker,
                    'start':   round(current_start, 2),
                    'end':     round(current_end, 2),
                    'text':    ' '.join(current_texts).strip()
                })
            current_speaker = speaker
            current_texts = [seg.text.strip()]
            current_start = seg.start
            current_end = seg.end
        else:
            current_texts.append(seg.text.strip())
            current_end = seg.end

    if current_speaker and current_texts:
        grouped.append({
            'speaker': current_speaker,
            'start':   round(current_start, 2),
            'end':     round(current_end, 2),
            'text':    ' '.join(current_texts).strip()
        })

    # Normalizza nomi parlanti (SPEAKER_00 → Persona 1)
    speaker_map = {}
    counter = 1
    for g in grouped:
        if g['speaker'] not in speaker_map:
            speaker_map[g['speaker']] = f'Persona {counter}'
            counter += 1
        g['speaker_label'] = speaker_map[g['speaker']]

    # Testo piatto per la ricerca
    full_text = '\n\n'.join(
        f"[{fmt_time(g['start'])}] {g['speaker_label']}\n{g['text']}"
        for g in grouped
    )

    return {
        'text':       full_text,
        'segments':   grouped,
        'diarized':   True,
        'speakers':   len(speaker_map),
        'language':   info.language
    }

def fmt_time(seconds):
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f'{m:02d}:{s:02d}'

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 9876))
    log.info(f'Quetza Whisper Service starting on :{port}')
    log.info(f'Model: {WHISPER_MODEL} | Language: {LANGUAGE} | Diarization: {bool(HF_TOKEN)}')
    # threaded=True: con il server single-thread una trascrizione da 5 minuti
    # bloccava anche /health, facendo fallire l'healthcheck di Docker e quindi
    # marcando il container come unhealthy durante il lavoro. Il carico resta
    # comunque serializzato da _work_lock.
    app.run(host='0.0.0.0', port=port, threaded=True)