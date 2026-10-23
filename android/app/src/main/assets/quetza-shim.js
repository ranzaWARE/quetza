/* Quetza per Android — script iniettato all'avvio dell'interfaccia (inclusa
   nell'app, https://appassets.androidplatform.net). Prima di questo file
   l'app imposta window.__quetzaClient, che fa tenere le note sul
   dispositivo (js/local-api.js). Colma quello che la WebView non fa da sola
   rispetto a Chrome:
   - i download di blob (PDF, export .zip) vengono passati all'app, che li
     salva in Download/Quetza;
   - l'app sa quando il microfono è acceso, per tenere lo schermo attivo e
     la registrazione viva anche fuori dall'app;
   - sugli schermi e-ink attiva il tema e-ink e toglie animazioni e
     transizioni, che lasciano scie e fanno lampeggiare il pannello.
   window.__quetzaEink viene impostato dall'app prima di questo file. */
(function () {
  if (window.__quetzaAndroid) return;
  window.__quetzaAndroid = true;

  function bridge() { return window.QuetzaAndroid; }
  function post(msg) { var b = bridge(); if (b) b.postMessage(JSON.stringify(msg)); }

  // ── E-ink ──────────────────────────────────────────────────────
  if (window.__quetzaEink) {
    // Solo come scelta iniziale: se l'utente cambia tema dall'app, vince lui.
    try { if (!localStorage.getItem('auror-theme')) localStorage.setItem('auror-theme', 'eink'); } catch (e) {}
    var css = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;' +
      'transition:none!important;scroll-behavior:auto!important}' +
      'html{-webkit-tap-highlight-color:transparent}';
    var addStyle = function () {
      var st = document.createElement('style');
      st.id = 'quetza-eink';
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    };
    if (document.documentElement) addStyle();
    else document.addEventListener('readystatechange', function once() {
      document.removeEventListener('readystatechange', once);
      addStyle();
    });
  }

  // ── Download ───────────────────────────────────────────────────
  // I blob URL vengono spesso revocati subito dopo a.click(): teniamo il
  // riferimento al Blob finché serve.
  var blobs = new Map();
  var createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL;
  URL.createObjectURL = function (obj) {
    var u = createURL.call(URL, obj);
    if (obj instanceof Blob) blobs.set(u, obj);
    return u;
  };
  URL.revokeObjectURL = function (u) {
    blobs.delete(u);
    return revokeURL.call(URL, u);
  };

  var CHUNK = 384 * 1024; // 384 KB → 512 KB di base64 per messaggio

  function toBase64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function send(blob, name) {
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    var mime = blob.type || '';
    post({ t: 'dl-begin', id: id, name: name, mime: mime });
    var off = 0;
    function next() {
      if (off >= blob.size) { post({ t: 'dl-end', id: id, mime: mime }); return; }
      var part = blob.slice(off, off + CHUNK);
      off += CHUNK;
      return part.arrayBuffer().then(function (buf) {
        post({ t: 'dl-chunk', id: id, data: toBase64(buf) });
        return next();
      });
    }
    return Promise.resolve().then(next).catch(function () { post({ t: 'dl-fail', id: id }); });
  }

  function nameFrom(a) {
    var n = a.getAttribute('download');
    if (n) return n;
    try { return decodeURIComponent(new URL(a.href).pathname.split('/').pop()) || 'quetza'; }
    catch (e) { return 'quetza'; }
  }

  // Restituisce true se il download è stato preso in carico dall'app.
  function handle(a) {
    if (!bridge() || !a || !a.hasAttribute('download') || !a.href) return false;
    var href = a.href, name = nameFrom(a);
    var blob = blobs.get(href);
    var proto = href.slice(0, href.indexOf(':'));
    var sameOrigin = false;
    try { sameOrigin = new URL(href).origin === location.origin; } catch (e) {}
    if (!blob && proto !== 'blob' && proto !== 'data' && !sameOrigin) return false;
    (blob ? Promise.resolve(blob)
      : fetch(href, { credentials: 'include' }).then(function (r) {
          if (!r.ok) throw new Error(r.status);
          return r.blob();
        })
    ).then(function (b) { return send(b, name); })
     .catch(function () { post({ t: 'dl-error' }); });
    return true;
  }

  // Ancore nel documento: il click arriva qui.
  window.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (a && handle(a)) e.preventDefault();
  }, true);

  // Ancore create al volo e mai inserite nel documento (a.click() o
  // dispatchEvent): il click non risale fino a window, va intercettato qui.
  var aClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.isConnected && handle(this)) return;
    return aClick.call(this);
  };
  var aDispatch = HTMLAnchorElement.prototype.dispatchEvent;
  HTMLAnchorElement.prototype.dispatchEvent = function (ev) {
    if (ev && ev.type === 'click' && !this.isConnected && handle(this)) return false;
    return aDispatch.call(this, ev);
  };

  // ── Microfono ──────────────────────────────────────────────────
  var md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    var live = new Set();
    var sync = function () { post({ t: 'rec', on: live.size > 0 }); };
    var gum = md.getUserMedia.bind(md);
    md.getUserMedia = function (c) {
      return gum(c).then(function (stream) {
        stream.getAudioTracks().forEach(function (t) {
          live.add(t);
          t.addEventListener('ended', function () { live.delete(t); sync(); });
        });
        sync();
        return stream;
      });
    };
    var stop = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      stop.call(this);
      if (live.delete(this)) sync();
    };
    window.addEventListener('pagehide', function () { live.clear(); sync(); });
  }
})();
