/* AUROR — audio bar behaviour (drag + width resize).
   Attach with AurorAudioBar.init(barEl) or leave it to the auto-init below,
   which claims every .aurorAudioBar that has a [data-ab-auto] attribute.
   The bar is positioned absolutely inside its offsetParent; movement and
   width are clamped to that parent so it can never be dragged out of reach. */
(function (global) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function init(bar) {
    if (!bar || bar.__aurorAudioBar) return;
    bar.__aurorAudioBar = true;

    var stage = bar.offsetParent || bar.parentElement;
    var grip = bar.querySelector('.abGrip');
    var handle = bar.querySelector('.abResize');

    function bounds() {
      return { w: stage.clientWidth, h: stage.clientHeight };
    }

    function park() {
      var b = bounds();
      var w = bar.offsetWidth, h = bar.offsetHeight;
      bar.style.left = clamp(bar.offsetLeft, 0, Math.max(0, b.w - w)) + 'px';
      bar.style.top = clamp(bar.offsetTop, 0, Math.max(0, b.h - h)) + 'px';
      if (bar.__aurorPlaceConfirm) bar.__aurorPlaceConfirm();
    }

    if (grip) {
      grip.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        var b = bounds();
        var startX = e.clientX, startY = e.clientY;
        var originX = bar.offsetLeft, originY = bar.offsetTop;
        var maxX = Math.max(0, b.w - bar.offsetWidth);
        var maxY = Math.max(0, b.h - bar.offsetHeight);
        bar.setAttribute('data-dragging', '');
        bar.removeAttribute('data-confirm');
        grip.setPointerCapture(e.pointerId);

        function move(ev) {
          bar.style.left = clamp(originX + ev.clientX - startX, 0, maxX) + 'px';
          bar.style.top = clamp(originY + ev.clientY - startY, 0, maxY) + 'px';
        }
        function up() {
          bar.removeAttribute('data-dragging');
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          grip.removeEventListener('pointercancel', up);
        }
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
      });
    }

    if (handle) {
      handle.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        var b = bounds();
        var startX = e.clientX;
        var startW = bar.offsetWidth;
        var minW = parseFloat(getComputedStyle(bar).minWidth) || 132;
        var maxW = Math.max(minW, b.w - bar.offsetLeft);
        handle.setPointerCapture(e.pointerId);

        function move(ev) {
          bar.style.width = clamp(startW + ev.clientX - startX, minW, maxW) + 'px';
          if (bar.__aurorPlaceConfirm) bar.__aurorPlaceConfirm();
        }
        function up() {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
        }
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    }

    // Keep the bar inside the stage when the stage itself changes size.
    if (global.ResizeObserver) new ResizeObserver(park).observe(stage);

    // Discard asks first. Confirming fires auror-audio-discard on the bar;
    // the host decides what "delete the take" actually means.
    var discard = bar.querySelector('[data-ab-discard]');
    var cancel = bar.querySelector('[data-ab-cancel]');
    var confirm = bar.querySelector('[data-ab-confirm]');
    var popover = bar.querySelector('.abConfirm');

    // Place the popover in stage coordinates, then convert back to the bar's
    // own box. Above the bar when there is room, below when there is not,
    // clamped sideways — the stage clips overflow, so an unplaced popover
    // would simply vanish.
    function placeConfirm() {
      if (!popover || !bar.hasAttribute('data-confirm')) return;
      popover.style.left = popover.style.top = '';
      popover.style.right = popover.style.bottom = '';
      var sr = stage.getBoundingClientRect();
      // The bar is the containing block, so a narrow bar would squeeze the
      // popover to its own width. max-content lifts that cap; max-width then
      // holds it inside the stage.
      popover.style.width = 'max-content';
      popover.style.maxWidth = Math.max(150, sr.width - 16) + 'px';
      var pr = popover.getBoundingClientRect();
      var br = bar.getBoundingClientRect();
      var gap = 8;
      var above = br.top - gap - pr.height;
      var top = above >= sr.top ? above : br.bottom + gap;
      top = clamp(top, sr.top, Math.max(sr.top, sr.bottom - pr.height));
      var left = clamp(br.right - pr.width, sr.left, Math.max(sr.left, sr.right - pr.width));
      popover.style.right = 'auto';
      popover.style.bottom = 'auto';
      popover.style.left = (left - br.left - bar.clientLeft) + 'px';
      popover.style.top = (top - br.top - bar.clientTop) + 'px';
    }

    function closeConfirm() { bar.removeAttribute('data-confirm'); }

    if (discard) {
      discard.addEventListener('click', function (e) {
        e.stopPropagation();
        if (bar.hasAttribute('data-confirm')) closeConfirm();
        else { bar.setAttribute('data-confirm', ''); placeConfirm(); }
      });
    }
    if (cancel) cancel.addEventListener('click', closeConfirm);
    if (confirm) {
      confirm.addEventListener('click', function () {
        closeConfirm();
        bar.dispatchEvent(new CustomEvent('auror-audio-discard', { bubbles: true }));
      });
    }
    document.addEventListener('click', function (e) {
      if (bar.hasAttribute('data-confirm') && !bar.contains(e.target)) closeConfirm();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeConfirm();
    });
    global.addEventListener('resize', placeConfirm);
    bar.__aurorPlaceConfirm = placeConfirm;
  }

  function autoInit(root) {
    (root || document).querySelectorAll('.aurorAudioBar[data-ab-auto]').forEach(init);
  }

  global.AurorAudioBar = { init: init, autoInit: autoInit };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { autoInit(); });
  } else {
    autoInit();
  }
})(window);
