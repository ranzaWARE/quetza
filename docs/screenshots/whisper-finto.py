"""Servizio Whisper finto per le schermate: risponde sempre la stessa trascrizione."""
import http.server, json
SEG=[{"speaker":"SPEAKER_00","speaker_label":"Persona 1","start":0.0,"end":6.2,"text":"Allora, partiamo dal prototipo: la consegna resta fissata al 15 novembre."},
     {"speaker":"SPEAKER_01","speaker_label":"Persona 2","start":6.2,"end":11.8,"text":"Per me va bene. Il budget è stato approvato ieri dalla direzione."},
     {"speaker":"SPEAKER_00","speaker_label":"Persona 1","start":11.8,"end":17.5,"text":"Perfetto. Luca, ci mandi i preventivi dei fornitori entro venerdì?"},
     {"speaker":"SPEAKER_02","speaker_label":"Persona 3","start":17.5,"end":21.0,"text":"Sì, li raccolgo e li carico nella cartella condivisa."}]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _j(self,o):
        b=json.dumps(o).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self): self._j({"ok":True,"whisper_model":"small","loaded_models":["small"],"diarization":True,"busy":False,"language":"it"})
    def do_POST(self):
        n=int(self.headers.get('Content-Length',0)); self.rfile.read(n)
        self._j({"text":" ".join(s["text"] for s in SEG),"segments":SEG,"diarized":True,"speakers":3,"language":"it","sessions":1})
http.server.ThreadingHTTPServer(("127.0.0.1",9876),H).serve_forever()
