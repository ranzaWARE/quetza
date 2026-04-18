"""
Quetza Whisper Service
Trascrizione audio con diarizzazione dei parlanti.
Esposto su :9876, usato internamente da Quetza Node.
"""

import os
import io
import json
import tempfile
import logging
from pathlib import Path
from flask import Flask, request, jsonify

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)

MODEL_DIR     = os.environ.get('MODEL_DIR', '/app/models')
WHISPER_MODEL = os.environ.get('WHISPER_MODEL', 'small')
HF_TOKEN      = os.environ.get('HF_TOKEN', '')
LANGUAGE      = os.environ.get('LANGUAGE', 'it')

# Lazy-load modelli al primo uso
_whisper = None
_diarize = None

def get_whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        log.info(f'Loading Whisper model: {WHISPER_MODEL}')
        device = 'cpu'
        compute = 'int8'
        _whisper = WhisperModel(
            WHISPER_MODEL,
            device=device,
            compute_type=compute,
            download_root=MODEL_DIR
        )
        log.info('Whisper model loaded')
    return _whisper

def get_diarizer():
    global _diarize
    if _diarize is None:
        if not HF_TOKEN:
            raise RuntimeError('HF_TOKEN non configurato — necessario per pyannote')
        from pyannote.audio import Pipeline
        import torch
        log.info('Loading pyannote diarization pipeline...')
        _diarize = Pipeline.from_pretrained(
            'pyannote/speaker-diarization-3.1',
            use_auth_token=HF_TOKEN,
            cache_dir=MODEL_DIR
        )
        _diarize.to(torch.device('cpu'))
        log.info('Pyannote pipeline loaded')
    return _diarize

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'ok': True,
        'whisper_model': WHISPER_MODEL,
        'diarization': bool(HF_TOKEN),
        'language': LANGUAGE
    })

@app.route('/transcribe', methods=['POST'])
def transcribe():
    """
    POST /transcribe
    Body: multipart/form-data con campo 'audio' (file audio qualsiasi formato)
    Opzionale: 'diarize=true' per attivare la diarizzazione
    """
    if 'audio' not in request.files:
        return jsonify({'error': 'Campo audio mancante'}), 400

    audio_file = request.files['audio']
    do_diarize = request.form.get('diarize', 'true').lower() == 'true' and bool(HF_TOKEN)

    # Salva su file temporaneo (ffmpeg richiede un file)
    suffix = Path(audio_file.filename or 'audio.wav').suffix or '.wav'
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        if do_diarize:
            result = transcribe_with_diarization(tmp_path)
        else:
            result = transcribe_only(tmp_path)
        return jsonify(result)
    except Exception as e:
        log.error(f'Transcription error: {e}', exc_info=True)
        return jsonify({'error': str(e)}), 500
    finally:
        try:
            os.unlink(tmp_path)
        except:
            pass

def transcribe_only(audio_path):
    """Trascrizione semplice senza diarizzazione."""
    model = get_whisper()
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

def transcribe_with_diarization(audio_path):
    """Trascrizione + diarizzazione: chi ha detto cosa."""
    import torch

    # 1. Diarizzazione: chi parla quando
    log.info('Running diarization...')
    diarizer = get_diarizer()
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
    model = get_whisper()
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
    app.run(host='0.0.0.0', port=port, threaded=False)