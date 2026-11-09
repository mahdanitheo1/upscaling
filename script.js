(function () {
  var $ = function (id) { return document.getElementById(id); };
  var PRESETS = [
    { key: 'asli', label: 'Asli', edge: 0 },
    { key: 'hd', label: 'HD', edge: 1280 },
    { key: 'fhd', label: 'FHD', edge: 1920 },
    { key: '2k', label: '2K', edge: 2560 },
    { key: '4k', label: '4K', edge: 3840 }
  ];
  var MAX_MP = 25;
  var st = {
    name: 'foto', url: null, w0: 0, h0: 0, data: null,
    preset: 'fhd', amount: 55, fmt: 'jpg', zoom: 'fit',
    job: 0, worker: null, timer: null, ready: false, dl: undefined
  };

  var workerCode = `
    function lanczos(x) {
      if (x === 0) return 1;
      if (x <= -3 || x >= 3) return 0;
      var px = Math.PI * x;
      return 3 * Math.sin(px) * Math.sin(px / 3) / (px * px);
    }
    function weights(sn, dn) {
      var idx = new Int32Array(dn * 6), wt = new Float32Array(dn * 6), s = sn / dn;
      for (var i = 0; i < dn; i++) {
        var c = (i + 0.5) * s - 0.5, f = Math.floor(c), sum = 0, k;
        for (k = 0; k < 6; k++) {
          var j = f - 2 + k, wv = lanczos(c - j);
          wt[i * 6 + k] = wv; sum += wv;
          idx[i * 6 + k] = Math.min(sn - 1, Math.max(0, j));
        }
        for (k = 0; k < 6; k++) wt[i * 6 + k] /= sum;
      }
      return { idx: idx, wt: wt };
    }
    function resize(src, sw, sh, dw, dh) {
      var hx = weights(sw, dw), vy = weights(sh, dh);
      var tmp = new Uint8ClampedArray(dw * sh * 4);
      var x, y, k, i;
      for (y = 0; y < sh; y++) {
        var row = y * sw * 4, orow = y * dw * 4;
        for (x = 0; x < dw; x++) {
          var b = x * 6, r = 0, g = 0, bl = 0, a = 0;
          for (k = 0; k < 6; k++) {
            var p = row + hx.idx[b + k] * 4, wv = hx.wt[b + k];
            r += src[p] * wv; g += src[p + 1] * wv; bl += src[p + 2] * wv; a += src[p + 3] * wv;
          }
          var o = orow + x * 4;
          tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = bl; tmp[o + 3] = a;
        }
      }
      var out = new Uint8ClampedArray(dw * dh * 4), rl = dw * 4, rb = new Float32Array(rl);
      for (y = 0; y < dh; y++) {
        rb.fill(0);
        var b2 = y * 6;
        for (k = 0; k < 6; k++) {
          var w2 = vy.wt[b2 + k], so = vy.idx[b2 + k] * rl;
          for (i = 0; i < rl; i++) rb[i] += tmp[so + i] * w2;
        }
        var oo = y * rl;
        for (i = 0; i < rl; i++) out[oo + i] = rb[i];
      }
      return out;
    }
    function blur1d(src, dst, n, lines, step, lineStride, r) {
      var iarr = 1 / (2 * r + 1);
      for (var l = 0; l < lines; l++) {
        var base = l * lineStride, ti = base, li = base, ri = base + r * step;
        var fv = src[base], lv = src[base + (n - 1) * step], val = (r + 1) * fv, j;
        for (j = 0; j < r; j++) val += src[base + j * step];
        for (j = 0; j <= r; j++) { val += src[ri] - fv; ri += step; dst[ti] = val * iarr; ti += step; }
        for (j = r + 1; j < n - r; j++) { val += src[ri] - src[li]; ri += step; li += step; dst[ti] = val * iarr; ti += step; }
        for (j = n - r; j < n; j++) { val += lv - src[li]; li += step; dst[ti] = val * iarr; ti += step; }
      }
    }
    function sharpen(d, w, h, amount, r) {
      var n = w * h, Y = new Float32Array(n), i;
      for (i = 0; i < n; i++) { var p = i * 4; Y[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; }
      r = Math.min(Math.max(1, r), Math.max(0, (Math.min(w, h) - 1) >> 1));
      var A = new Float32Array(n), B = new Float32Array(n), src = Y;
      for (var it = 0; it < 3; it++) {
        blur1d(src, A, w, h, 1, w, r);
        blur1d(A, B, h, w, w, 1, r);
        src = B;
      }
      var thr = 3;
      for (i = 0; i < n; i++) {
        var diff = Y[i] - B[i], ad = Math.abs(diff);
        var k = ad < thr ? ad / thr : 1;
        var delta = diff * amount * k;
        if (delta > 40) delta = 40; else if (delta < -40) delta = -40;
        var q = i * 4;
        d[q] += delta; d[q + 1] += delta; d[q + 2] += delta;
      }
    }
    self.onmessage = function (e) {
      var m = e.data, src = new Uint8ClampedArray(m.buf), out = src, w = m.sw, h = m.sh;
      if (m.dw !== m.sw || m.dh !== m.sh) {
        self.postMessage({ stage: 'resize' });
        out = resize(src, m.sw, m.sh, m.dw, m.dh); w = m.dw; h = m.dh;
      }
      if (m.amount > 0) { self.postMessage({ stage: 'sharpen' }); sharpen(out, w, h, m.amount, m.radius); }
      self.postMessage({ done: true, buf: out.buffer, w: w, h: h }, [out.buffer]);
    };
  `;
  var workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));

  function fmtInt(n) { return n.toLocaleString('id-ID'); }
  function fmtDec(n, d) { return n.toFixed(d).replace('.', ','); }
  function setStatus(t) { $('status').textContent = t; }
  function showBusy(t) { $('busy').hidden = false; $('busyText').textContent = t; }
  function hideBusy() { $('busy').hidden = true; }

  function dimsFor(p) {
    var long = Math.max(st.w0, st.h0);
    if (!p.edge) return { w: st.w0, h: st.h0, s: 1, ok: true };
    var s = p.edge / long;
    if (s <= 1.0001) return { w: st.w0, h: st.h0, s: 1, ok: false };
    return { w: Math.round(st.w0 * s), h: Math.round(st.h0 * s), s: s, ok: true };
  }
  function curPreset() { return PRESETS.filter(function (p) { return p.key === st.preset; })[0]; }

  function setFrame(w, h) {
    var f = $('frame');
    f.style.setProperty('--ar', (w / h).toString());
    f.style.setProperty('--rw', String(w));
  }
  function applyPos(v) { $('frame').style.setProperty('--pos', v + '%'); }

  function renderPresets() {
    var box = $('presets');
    box.innerHTML = '';
    PRESETS.forEach(function (p) {
      var has = !!st.data;
      var d = has ? dimsFor(p) : { ok: false };
      var on = has && st.preset === p.key;
      var lab = document.createElement('label');
      lab.className = 'preset' + (d.ok ? '' : ' off') + (on ? ' on' : '');
      var inp = document.createElement('input');
      inp.type = 'radio'; inp.name = 'preset'; inp.value = p.key;
      inp.disabled = !d.ok; inp.checked = on;
      var a = document.createElement('span'); a.className = 'p-name'; a.textContent = p.label;
      var b = document.createElement('span'); b.className = 'p-dim';
      b.textContent = !has ? (p.edge ? fmtInt(p.edge) + ' px sisi terpanjang' : 'Ukuran asli foto') : d.ok ? fmtInt(d.w) + ' × ' + fmtInt(d.h) : 'Foto sudah lebih besar';
      var c = document.createElement('span'); c.className = 'p-x';
      c.textContent = p.edge && d.ok ? '×' + fmtDec(d.s, 1) : '';
      lab.appendChild(inp); lab.appendChild(a); lab.appendChild(b); lab.appendChild(c);
      box.appendChild(lab);
    });
  }

  function pickDefault() {
    var order = ['fhd', '2k', '4k', 'hd'];
    for (var i = 0; i < order.length; i++) {
      var p = PRESETS.filter(function (x) { return x.key === order[i]; })[0];
      if (dimsFor(p).ok) return p.key;
    }
    return 'asli';
  }

  function decode(blob) {
    return createImageBitmap(blob).catch(function () {
      return new Promise(function (res) {
        var u = URL.createObjectURL(blob), im = new Image();
        im.onload = function () { res(im); };
        im.onerror = function () { res(null); };
        im.src = u;
      });
    });
  }

  function loadBlob(blob, name) {
    setStatus('Membaca foto…');
    return decode(blob).then(function (bmp) {
      if (!bmp) { setStatus('Foto tidak bisa dibaca. Coba JPG, PNG, atau WebP.'); return; }
      var w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
      if (w * h > MAX_MP * 1e6) {
        setStatus('Foto terlalu besar (' + fmtDec(w * h / 1e6, 1) + ' MP). Batasnya ' + MAX_MP + ' MP.');
        return;
      }
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      var x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(bmp, 0, 0);
      st.data = x.getImageData(0, 0, w, h).data;
      st.w0 = w; st.h0 = h; st.name = name;
      $('empty').hidden = true; $('frame').hidden = false;
      if (st.url) URL.revokeObjectURL(st.url);
      st.url = URL.createObjectURL(blob);
      $('before').src = st.url;
      st.preset = pickDefault();
      renderPresets();
      var info = name + ' · ' + fmtInt(w) + ' × ' + fmtInt(h) + ' · ' + fmtDec(w * h / 1e6, 2) + ' MP';
      $('fileinfo').textContent = info;
      var d = dimsFor(curPreset());
      setFrame(d.w, d.h);
      $('tagL').textContent = 'Asli ' + w + '×' + h;
      st.ready = false;
      run();
    });
  }

  function schedule(ms) { clearTimeout(st.timer); st.timer = setTimeout(run, ms); }

  function run() {
    if (!st.data) return;
    clearTimeout(st.timer);
    var p = curPreset(), d = dimsFor(p);
    setFrame(d.w, d.h);
    st.job++;
    var job = st.job;
    if (st.worker) { st.worker.terminate(); st.worker = null; }
    showBusy('Menyiapkan…');
    $('dlbtn').disabled = true;
    var t0 = performance.now(), w;
    try { w = new Worker(workerUrl); } catch (e) { hideBusy(); setStatus('Pemrosesan tidak bisa dijalankan di tampilan ini.'); return; }
    st.worker = w;
    w.onmessage = function (ev) {
      var m = ev.data;
      if (job !== st.job) return;
      if (m.stage) { showBusy(m.stage === 'resize' ? 'Memperbesar (Lanczos)…' : 'Menajamkan…'); return; }
      var c = $('after');
      c.width = m.w; c.height = m.h;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.buf), m.w, m.h), 0, 0);
      w.terminate(); st.worker = null; st.ready = true;
      hideBusy();
      $('tagR').textContent = p.label + ' ' + m.w + '×' + m.h;
      $('dlbtn').disabled = false;
      setStatus('Selesai · ' + fmtInt(m.w) + ' × ' + fmtInt(m.h) + ' (' + fmtDec(m.w * m.h / 1e6, 1) + ' MP) · ' + fmtDec((performance.now() - t0) / 1000, 1) + ' dtk');
    };
    w.onerror = function () {
      if (job !== st.job) return;
      hideBusy(); setStatus('Pemrosesan gagal. Coba resolusi yang lebih kecil.');
    };
    var copy = st.data.slice();
    var radius = Math.min(4, Math.max(1, Math.round(0.5 * d.s + 0.5)));
    w.postMessage({ buf: copy.buffer, sw: st.w0, sh: st.h0, dw: d.w, dh: d.h, amount: st.amount / 100 * 1.5, radius: radius }, [copy.buffer]);
  }

  /* presets */
  $('presets').addEventListener('change', function (e) {
    if (e.target.name !== 'preset') return;
    st.preset = e.target.value;
    renderPresets();
    run();
  });

  /* sharpness */
  $('sharp').addEventListener('input', function (e) {
    st.amount = +e.target.value;
    $('sharpOut').textContent = e.target.value;
    schedule(350);
  });

  /* compare slider */
  $('cmp').addEventListener('input', function (e) { applyPos(+e.target.value); });
  var dragging = false;
  function posFromEvent(e) {
    var r = $('frame').getBoundingClientRect();
    var v = Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100));
    $('cmp').value = v; applyPos(v);
  }
  $('frame').addEventListener('pointerdown', function (e) {
    if (st.zoom !== 'fit') return;
    dragging = true;
    try { $('frame').setPointerCapture(e.pointerId); } catch (x) {}
    posFromEvent(e);
  });
  $('frame').addEventListener('pointermove', function (e) { if (dragging) posFromEvent(e); });
  ['pointerup', 'pointercancel'].forEach(function (n) { $('frame').addEventListener(n, function () { dragging = false; }); });

  /* zoom */
  function setZoom(z) {
    st.zoom = z;
    $('stage').classList.toggle('actual', z === 'actual');
    $('zFit').setAttribute('aria-pressed', z === 'fit');
    $('zActual').setAttribute('aria-pressed', z === 'actual');
    var s = $('stage');
    if (z === 'actual') { s.scrollLeft = (s.scrollWidth - s.clientWidth) / 2; s.scrollTop = (s.scrollHeight - s.clientHeight) / 2; }
    else { s.scrollLeft = 0; s.scrollTop = 0; }
  }
  $('zFit').addEventListener('click', function () { setZoom('fit'); });
  $('zActual').addEventListener('click', function () { setZoom('actual'); });

  /* file input, drop, paste */
  function handleFile(f) {
    if (!f) return;
    if (!/^image\//.test(f.type)) { setStatus('Berkas itu bukan gambar.'); return; }
    loadBlob(f, f.name);
  }
  $('pick').addEventListener('click', function () { $('file').click(); });
  $('pickEmpty').addEventListener('click', function () { $('file').click(); });
  $('file').addEventListener('change', function (e) { handleFile(e.target.files[0]); e.target.value = ''; });
  var stage = $('stage');
  stage.addEventListener('dragover', function (e) { e.preventDefault(); stage.classList.add('drag'); });
  stage.addEventListener('dragleave', function () { stage.classList.remove('drag'); });
  stage.addEventListener('drop', function (e) {
    e.preventDefault(); stage.classList.remove('drag');
    handleFile(e.dataTransfer.files[0]);
  });
  document.addEventListener('paste', function (e) {
    var files = e.clipboardData ? Array.prototype.slice.call(e.clipboardData.files) : [];
    var f = files.filter(function (x) { return /^image\//.test(x.type); })[0];
    if (f) handleFile(f);
  });

  /* download */
  $('fmt').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-f]');
    if (!b) return;
    st.fmt = b.getAttribute('data-f');
    Array.prototype.forEach.call($('fmt').querySelectorAll('button'), function (x) {
      x.setAttribute('aria-pressed', x === b);
    });
    $('dlbtn').textContent = 'Unduh hasil (' + b.textContent + ')';
  });

  function toBlob(canvas, type, q) {
    return new Promise(function (res) { canvas.toBlob(res, type, q); });
  }
  function getDl() {
    if (st.dl !== undefined) return Promise.resolve(st.dl);
    return Promise.resolve(window.claude && window.claude.use ? window.claude.use('downloads') : null)
      .catch(function () { return null; })
      .then(function (d) { st.dl = d || null; return st.dl; });
  }
  function anchorSave(blob, fname) {
    var u = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = u; a.download = fname; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
  }
  $('dlbtn').addEventListener('click', function () {
    if (!st.ready) return;
    var src = $('after'), cv = src, type = 'image/png', ext = 'png';
    if (st.fmt === 'jpg') {
      cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
      var cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(src, 0, 0);
      type = 'image/jpeg'; ext = 'jpg';
    } else if (st.fmt === 'webp') { type = 'image/webp'; ext = 'webp'; }
    setStatus('Menyiapkan file…');
    toBlob(cv, type, 0.95).then(function (blob) {
      if (!blob) { setStatus('Gagal membuat file. Coba format lain.'); return; }
      if (blob.type === 'image/png') ext = 'png';
      var base = st.name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '') || 'foto';
      var fname = base + '-' + st.preset + '.' + ext;
      var size = fmtDec(blob.size / 1048576, 1) + ' MB';
      return getDl().then(function (dl) {
        if (!dl) { anchorSave(blob, fname); setStatus('Unduhan dimulai: ' + fname + ' · ' + size); return; }
        return dl.save({ filename: fname, data: blob }).then(function () {
          setStatus('Tersimpan: ' + fname + ' · ' + size);
        }).catch(function (err) {
          var c = err && err.code;
          if (c === 'declined') { setStatus('Penyimpanan dibatalkan.'); return; }
          if (c === 'rate_limited') { setStatus('Tunggu sebentar, lalu coba lagi.'); return; }
          anchorSave(blob, fname);
          setStatus('Unduhan dimulai: ' + fname + ' · ' + size);
        });
      });
    });
  });
  getDl().then(function (dl) { if (!dl) $('dlnote').hidden = false; });

  renderPresets();
  $('fileinfo').textContent = 'Belum ada foto.';
  setStatus('Pilih foto untuk mulai.');
})();