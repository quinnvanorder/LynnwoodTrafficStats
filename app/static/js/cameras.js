// Sidebar camera list: collapsible per-camera rows with image/play/counts + fullscreen + zone editor

const SidebarCameras = (() => {
  const STAT_LABELS = {
    car_count: 'Cars', truck_count: 'Trucks', bus_count: 'Buses',
    motorcycle_count: 'Motorcycles', person_count: 'Pedestrians', bicycle_count: 'Cyclists',
  };
  const WINDOW_HOURS = {
    '5m': 5/60, '10m': 10/60, '30m': 0.5,
    '1h': 1, '1d': 24, '1w': 168, '1m': 720, '6m': 4380, '1y': 8760, '5y': 43800,
  };

  let _stats = [];
  let _expandedId = null;
  let _timeWindow = '5m';
  let _isStaticMode = false;
  let _onSelect = null;

  // LAN playback state
  let _playFrames = [];
  let _playIndex = 0;
  let _playTimer = null;

  // Static video state
  let _videoIndex = [];
  let _scrubbing = false;

  // Fullscreen overlay refs
  let _fsOverlay = null;
  let _fsMedia = null;  // img or video in overlay

  // Zone editor state
  let _zones = [];            // [[x1,y1,x2,y2], ...] as 0.0–1.0 fractions
  let _zoneEditing = false;
  let _zoneDrag = null;       // {startX, startY, rect: <canvas rect>}

  let _listEl, _searchEl;

  function init(onSelectCallback) {
    _onSelect = onSelectCallback;
    _listEl   = document.getElementById('scamList');
    _searchEl = document.getElementById('scamSearch');
    _searchEl.addEventListener('input', _render);

    _listEl.addEventListener('click', e => {
      const header = e.target.closest('.scam-header');
      if (header) { _toggleExpand(Number(header.closest('.scam-item').dataset.camId)); return; }
      if (e.target.closest('.scam-play-btn'))     { _startPlay(); return; }
      if (e.target.closest('.scam-stop-btn'))     { _stopPlay();  return; }
      if (e.target.closest('.scam-image-wrap') && !_zoneEditing) { _openFullscreen(); return; }
      if (e.target.closest('.scam-zone-btn'))     { _toggleZoneEditor(); return; }
      if (e.target.closest('.scam-zone-clear'))   { _clearZones(); return; }
      if (e.target.closest('.scam-zone-save'))    { _saveZones(); return; }
    });

    // Range scrub (delegated — range inputs don't bubble click)
    document.addEventListener('input', e => {
      if (e.target && e.target.id === 'scamScrubBar') {
        const vid = document.getElementById('scamDetailVideo');
        if (vid) vid.currentTime = Number(e.target.value);
      }
    });
    document.addEventListener('mousedown', e => { if (e.target?.id === 'scamScrubBar') _scrubbing = true; });
    document.addEventListener('mouseup',   () => _scrubbing = false);
    document.addEventListener('touchstart', e => { if (e.target?.id === 'scamScrubBar') _scrubbing = true; });
    document.addEventListener('touchend',  () => _scrubbing = false);
  }

  function setStaticMode(s) { _isStaticMode = s; }
  function setTimeWindow(w) { _timeWindow = w; }

  function updateStats(stats) {
    _stats = stats;
    _render();
    if (_expandedId !== null) {
      const cam = _stats.find(c => c.id === _expandedId);
      if (cam) _refreshDetailStats(cam);
    }
  }

  // ── Expand/collapse ──────────────────────────────────────────────────────────

  function _toggleExpand(id) {
    if (_expandedId === id) {
      _stopPlay();
      _expandedId = null;
      _zoneEditing = false;
    } else {
      _stopPlay();
      _zoneEditing = false;
      _expandedId = id;
      const cam = _stats.find(c => c.id === id);
      if (cam && _onSelect) _onSelect(cam);
    }
    _render();
    if (_expandedId !== null) {
      const cam = _stats.find(c => c.id === _expandedId);
      if (cam) _loadDetail(cam);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  function _render() {
    const q = (_searchEl.value || '').toLowerCase();
    const filtered = _stats.filter(c => c.address.toLowerCase().includes(q));
    _listEl.innerHTML = filtered.map(_itemHtml).join('');
    if (_expandedId !== null) {
      const cam = _stats.find(c => c.id === _expandedId);
      if (cam) _loadDetail(cam);
    }
  }

  function _itemHtml(cam) {
    const expanded = cam.id === _expandedId;
    return `
<div class="scam-item${expanded ? ' expanded' : ''}" data-cam-id="${cam.id}">
  <div class="scam-header">
    <span class="scam-name">${cam.address}</span>
    <span class="scam-chevron">${expanded ? '▲' : '▼'}</span>
  </div>
  ${expanded ? _detailHtml(cam) : ''}
</div>`;
  }

  function _statsGridHtml(obj) {
    return Object.entries(STAT_LABELS)
      .map(([k, l]) => `<span class="ds-label">${l}</span><span class="ds-val">${(obj[k] || 0).toLocaleString()}</span>`)
      .join('');
  }

  function _detailHtml(cam) {
    const mediaHtml = _isStaticMode
      ? `<video id="scamDetailVideo" class="scam-detail-img" playsinline muted></video>`
      : `<img id="scamDetailImg" class="scam-detail-img" alt="" />`;

    const scrubHtml = _isStaticMode
      ? `<div class="scam-scrub-row"><input type="range" id="scamScrubBar" class="cp-scrub-bar" min="0" max="100" step="0.01" value="0" /></div>`
      : '';

    return `
<div class="scam-detail">
  <div class="scam-image-wrap" id="scamImageWrap" title="Click to enlarge">${mediaHtml}</div>
  <div id="scamDetailTs" class="scam-detail-ts"></div>
  <div class="scam-playback-row">
    <button class="btn-primary btn-sm scam-play-btn">▶ Play</button>
    <button class="btn-secondary btn-sm scam-stop-btn" style="display:none">⏹ Stop</button>
    <div class="cp-play-bar"><div class="progress-bar"><div id="scamPlayFill" class="progress-fill"></div></div></div>
  </div>
  ${scrubHtml}
  <div class="scam-zone-toolbar">
    <button class="btn-secondary btn-sm scam-zone-btn" title="Draw rectangles over areas to ignore during detection">🎯 Exclusion Zones</button>
    <button class="btn-secondary btn-sm scam-zone-clear" style="display:none">✕ Clear All</button>
    <button class="btn-primary btn-sm scam-zone-save" style="display:none">Save</button>
  </div>
  <div id="scamZoneCanvas" class="scam-zone-canvas" style="display:none"></div>
  <div class="scam-stats-heading" id="scamStatsHeading">${_isStaticMode ? 'Counts · full period' : 'Counts · selected window'}</div>
  <div class="cp-stats-grid" id="scamDetailStats">${_statsGridHtml(cam)}</div>
</div>`;
  }

  function _refreshDetailStats(obj) {
    const el = document.getElementById('scamDetailStats');
    if (el) el.innerHTML = _statsGridHtml(obj);
  }

  // ── Load detail ──────────────────────────────────────────────────────────────

  async function _loadDetail(cam) {
    if (_isStaticMode) await _loadDetailStatic(cam);
    else await _loadDetailLAN(cam);
    _loadZones(cam.id);
  }

  // ── LAN ─────────────────────────────────────────────────────────────────────

  async function _loadDetailLAN(cam) {
    _playFrames = []; _playIndex = 0;
    const snaps = await fetch(`/api/snapshots?camera_id=${cam.id}&limit=1`).then(r => r.json());
    const imgEl = document.getElementById('scamDetailImg');
    const tsEl  = document.getElementById('scamDetailTs');
    if (imgEl && snaps.length && snaps[0].image_path) {
      const snap = snaps[0];
      imgEl.src = '/data/' + (snap.annotated_path || snap.image_path);
      if (tsEl) tsEl.textContent = _fmtTs(snap.captured_at);
    }
    _loadFramesLAN(cam.id);
  }

  async function _loadFramesLAN(cameraId) {
    const hours = WINDOW_HOURS[_timeWindow];
    let url = `/api/snapshots?camera_id=${cameraId}&limit=500`;
    if (hours) {
      const start = new Date(Date.now() - hours * 3600000).toISOString().slice(0, 19) + 'Z';
      url += `&start=${encodeURIComponent(start)}`;
    }
    const snaps = await fetch(url).then(r => r.json());
    _playFrames = snaps.filter(s => s.image_path).reverse();
    _playIndex = _playFrames.length - 1;
  }

  function _startPlayLAN() {
    if (_playTimer || !_playFrames.length) return;
    _setPlayBtns(true);
    _playIndex = 0;
    _playTimer = setInterval(() => {
      if (_playIndex >= _playFrames.length) { _stopPlayLAN(); return; }
      const f = _playFrames[_playIndex++];
      const src = '/data/' + (f.annotated_path || f.image_path);
      const imgEl  = document.getElementById('scamDetailImg');
      const tsEl   = document.getElementById('scamDetailTs');
      const fillEl = document.getElementById('scamPlayFill');
      const hdgEl  = document.getElementById('scamStatsHeading');
      if (imgEl)  imgEl.src = src;
      if (_fsMedia && _fsMedia.tagName === 'IMG') _fsMedia.src = src;
      if (tsEl)   tsEl.textContent  = _fmtTs(f.captured_at);
      if (fillEl) fillEl.style.width = ((_playIndex / _playFrames.length) * 100) + '%';
      if (hdgEl)  hdgEl.textContent  = 'Counts · this frame';
      _refreshDetailStats(f);
      _updateFsStats(f);
    }, 250);
  }

  function _stopPlayLAN() {
    if (_playTimer) { clearInterval(_playTimer); _playTimer = null; }
    _setPlayBtns(false);
    const hdgEl = document.getElementById('scamStatsHeading');
    if (hdgEl) hdgEl.textContent = 'Counts · selected window';
    const cam = _stats.find(c => c.id === _expandedId);
    if (cam) { _refreshDetailStats(cam); _updateFsStats(cam); }
  }

  // ── Static ───────────────────────────────────────────────────────────────────

  async function _loadDetailStatic(cam) {
    _videoIndex = [];
    const base = `data/cameras/${cam.id}`;
    const vid = document.getElementById('scamDetailVideo');
    const scrub = document.getElementById('scamScrubBar');
    if (!vid) return;
    vid.src = `${base}/video.webm`;
    if (scrub) scrub.value = 0;
    const fillEl = document.getElementById('scamPlayFill');
    if (fillEl) fillEl.style.width = '0%';

    vid.onloadedmetadata = () => { if (scrub) scrub.max = vid.duration; };
    vid.ontimeupdate = _onVideoTimeUpdate;
    vid.addEventListener('ended', () => _setPlayBtns(false));

    try {
      _videoIndex = await fetch(`${base}/index.json`).then(r => r.json());
      if (_videoIndex.length) {
        _refreshDetailStats(_videoIndex[0]);
        const tsEl = document.getElementById('scamDetailTs');
        if (tsEl) tsEl.textContent = _fmtTs(_videoIndex[0].ts);
      }
    } catch { _videoIndex = []; }
  }

  function _onVideoTimeUpdate() {
    const vid = document.getElementById('scamDetailVideo');
    if (!vid || !_videoIndex.length) return;
    const frame = _findVideoFrame(vid.currentTime);
    if (frame) {
      const hdgEl = document.getElementById('scamStatsHeading');
      const tsEl  = document.getElementById('scamDetailTs');
      if (hdgEl) hdgEl.textContent = 'Counts · this frame';
      if (tsEl)  tsEl.textContent  = _fmtTs(frame.ts);
      _refreshDetailStats(frame);
      _updateFsStats(frame);
    }
    const pct = vid.duration ? (vid.currentTime / vid.duration) * 100 : 0;
    const fillEl = document.getElementById('scamPlayFill');
    if (fillEl) fillEl.style.width = pct + '%';
    const scrub = document.getElementById('scamScrubBar');
    if (scrub && !_scrubbing) scrub.value = vid.currentTime;
    // Keep fullscreen video in sync
    if (_fsMedia && _fsMedia.tagName === 'VIDEO') {
      if (Math.abs(_fsMedia.currentTime - vid.currentTime) > 0.5) {
        _fsMedia.currentTime = vid.currentTime;
      }
    }
  }

  function _findVideoFrame(t) {
    let lo = 0, hi = _videoIndex.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (_videoIndex[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return _videoIndex[lo] || null;
  }

  function _startPlayStatic() {
    const vid = document.getElementById('scamDetailVideo');
    if (vid) vid.play().catch(() => {});
    if (_fsMedia && _fsMedia.tagName === 'VIDEO') _fsMedia.play().catch(() => {});
    _setPlayBtns(true);
  }

  function _stopPlayStatic() {
    const vid = document.getElementById('scamDetailVideo');
    if (vid) vid.pause();
    if (_fsMedia && _fsMedia.tagName === 'VIDEO') _fsMedia.pause();
    _setPlayBtns(false);
  }

  // ── Shared play helpers ──────────────────────────────────────────────────────

  function _startPlay() { if (_isStaticMode) _startPlayStatic(); else _startPlayLAN(); }
  function _stopPlay()  { if (_isStaticMode) _stopPlayStatic();  else _stopPlayLAN();  }

  function _setPlayBtns(playing) {
    const p = document.getElementById('scamPlayBtn') || _listEl.querySelector('.scam-play-btn');
    const s = document.getElementById('scamStopBtn') || _listEl.querySelector('.scam-stop-btn');
    if (p) p.style.display = playing ? 'none' : '';
    if (s) s.style.display = playing ? '' : 'none';
    // Also sync fullscreen buttons
    if (_fsOverlay) {
      const fp = _fsOverlay.querySelector('.scam-fs-play');
      const fs = _fsOverlay.querySelector('.scam-fs-stop');
      if (fp) fp.style.display = playing ? 'none' : '';
      if (fs) fs.style.display = playing ? '' : 'none';
    }
  }

  // ── Fullscreen overlay ───────────────────────────────────────────────────────

  function _openFullscreen() {
    if (_fsOverlay) return;
    const overlay = document.createElement('div');
    overlay.className = 'scam-fs-overlay';

    // Media
    if (_isStaticMode) {
      const vid = document.getElementById('scamDetailVideo');
      _fsMedia = document.createElement('video');
      _fsMedia.src = vid ? vid.src : '';
      _fsMedia.currentTime = vid ? vid.currentTime : 0;
      _fsMedia.playsinline = true;
      _fsMedia.muted = true;
      _fsMedia.className = 'scam-fs-media';
      if (vid && !vid.paused) _fsMedia.play().catch(() => {});
      // Restore ontimeupdate on sidebar video to also keep overlay in sync
      if (vid) vid.ontimeupdate = _onVideoTimeUpdate;
    } else {
      const imgEl = document.getElementById('scamDetailImg');
      _fsMedia = document.createElement('img');
      _fsMedia.src = imgEl ? imgEl.src : '';
      _fsMedia.alt = '';
      _fsMedia.className = 'scam-fs-media';
    }

    // Controls bar
    const controls = document.createElement('div');
    controls.className = 'scam-fs-controls';

    const playBtn = document.createElement('button');
    playBtn.className = 'btn-primary btn-sm scam-fs-play';
    playBtn.textContent = '▶ Play';
    playBtn.addEventListener('click', e => { e.stopPropagation(); _startPlay(); });

    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn-secondary btn-sm scam-fs-stop';
    stopBtn.textContent = '⏹ Stop';
    stopBtn.style.display = 'none';
    stopBtn.addEventListener('click', e => { e.stopPropagation(); _stopPlay(); });

    const statsEl = document.createElement('div');
    statsEl.className = 'scam-fs-stats cp-stats-grid';
    statsEl.id = 'scamFsStats';
    // Populate with current counts
    const cam = _stats.find(c => c.id === _expandedId);
    if (cam) statsEl.innerHTML = _statsGridHtml(cam);

    controls.appendChild(playBtn);
    controls.appendChild(stopBtn);
    controls.appendChild(statsEl);

    // Sync initial button state
    const isPlaying = !!_playTimer || (!!document.getElementById('scamDetailVideo') && !document.getElementById('scamDetailVideo').paused);
    playBtn.style.display = isPlaying ? 'none' : '';
    stopBtn.style.display = isPlaying ? '' : 'none';

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'scam-fs-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', e => { e.stopPropagation(); _closeFullscreen(); });

    overlay.appendChild(_fsMedia);
    overlay.appendChild(controls);
    overlay.appendChild(closeBtn);
    document.body.appendChild(overlay);
    _fsOverlay = overlay;

    overlay.addEventListener('click', e => { if (e.target === overlay) _closeFullscreen(); });
    document.addEventListener('keydown', _fsEsc);
  }

  function _closeFullscreen() {
    if (!_fsOverlay) return;
    document.body.removeChild(_fsOverlay);
    _fsOverlay = null;
    _fsMedia = null;
    document.removeEventListener('keydown', _fsEsc);
    // Restore video timeupdate on sidebar
    if (_isStaticMode) {
      const vid = document.getElementById('scamDetailVideo');
      if (vid) vid.ontimeupdate = _onVideoTimeUpdate;
    }
  }

  function _fsEsc(e) { if (e.key === 'Escape') _closeFullscreen(); }

  function _updateFsStats(obj) {
    const el = document.getElementById('scamFsStats');
    if (el) el.innerHTML = _statsGridHtml(obj);
  }

  // ── Zone editor ──────────────────────────────────────────────────────────────

  async function _loadZones(cameraId) {
    try {
      const cams = await fetch('/api/cameras').then(r => r.json());
      const cam = cams.find(c => c.id === cameraId);
      _zones = (cam && cam.exclusion_zones) ? JSON.parse(cam.exclusion_zones) : [];
    } catch { _zones = []; }
    _renderZoneCanvas();
  }

  function _toggleZoneEditor() {
    _zoneEditing = !_zoneEditing;
    const canvas = document.getElementById('scamZoneCanvas');
    const clearBtn = _listEl.querySelector('.scam-zone-clear');
    const saveBtn  = _listEl.querySelector('.scam-zone-save');
    const zoneBtn  = _listEl.querySelector('.scam-zone-btn');
    if (!canvas) return;

    if (_zoneEditing) {
      canvas.style.display = '';
      if (clearBtn) clearBtn.style.display = '';
      if (saveBtn)  saveBtn.style.display  = '';
      if (zoneBtn)  zoneBtn.textContent = '✏️ Done Editing';
      _buildZoneCanvas(canvas);
    } else {
      canvas.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'none';
      if (saveBtn)  saveBtn.style.display  = 'none';
      if (zoneBtn)  zoneBtn.textContent = '🎯 Exclusion Zones';
    }
  }

  function _buildZoneCanvas(container) {
    container.innerHTML = '';
    const wrap = document.getElementById('scamImageWrap');
    if (!wrap) return;
    const w = wrap.clientWidth || 260;
    const h = Math.round(w * 9 / 16);

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    canvas.style.cursor = 'crosshair';
    container.appendChild(canvas);

    const hint = document.createElement('p');
    hint.className = 'scam-zone-hint';
    hint.textContent = 'Click and drag to draw exclusion zones. Detected objects inside blacked-out areas will be ignored.';
    container.appendChild(hint);

    _drawZones(canvas);

    let startX, startY;
    canvas.addEventListener('mousedown', e => {
      const r = canvas.getBoundingClientRect();
      startX = (e.clientX - r.left) / w;
      startY = (e.clientY - r.top) / h;
    });
    canvas.addEventListener('mousemove', e => {
      if (startX === undefined) return;
      const r = canvas.getBoundingClientRect();
      const cx = (e.clientX - r.left) / w;
      const cy = (e.clientY - r.top) / h;
      _drawZones(canvas, [Math.min(startX,cx), Math.min(startY,cy), Math.max(startX,cx), Math.max(startY,cy)]);
    });
    canvas.addEventListener('mouseup', e => {
      if (startX === undefined) return;
      const r = canvas.getBoundingClientRect();
      const cx = (e.clientX - r.left) / w;
      const cy = (e.clientY - r.top) / h;
      const x1 = Math.min(startX, cx), y1 = Math.min(startY, cy);
      const x2 = Math.max(startX, cx), y2 = Math.max(startY, cy);
      if (x2 - x1 > 0.02 && y2 - y1 > 0.02) {
        _zones.push([x1, y1, x2, y2]);
      }
      startX = undefined;
      _drawZones(canvas);
    });
  }

  function _drawZones(canvas, preview = null) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Background hint
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Saved zones
    ctx.fillStyle = 'rgba(239, 68, 68, 0.45)';
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    for (const [x1, y1, x2, y2] of _zones) {
      const px = x1 * canvas.width, py = y1 * canvas.height;
      const pw = (x2 - x1) * canvas.width, ph = (y2 - y1) * canvas.height;
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeRect(px, py, pw, ph);
    }
    // Preview rect
    if (preview) {
      const [x1, y1, x2, y2] = preview;
      ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
      ctx.strokeStyle = '#fca5a5';
      ctx.fillRect(x1*canvas.width, y1*canvas.height, (x2-x1)*canvas.width, (y2-y1)*canvas.height);
      ctx.strokeRect(x1*canvas.width, y1*canvas.height, (x2-x1)*canvas.width, (y2-y1)*canvas.height);
    }
  }

  function _renderZoneCanvas() {
    const canvas = document.getElementById('scamZoneCanvas');
    if (canvas && _zoneEditing) {
      const cvs = canvas.querySelector('canvas');
      if (cvs) _drawZones(cvs);
    }
  }

  function _clearZones() {
    _zones = [];
    const cvs = document.querySelector('#scamZoneCanvas canvas');
    if (cvs) _drawZones(cvs);
  }

  async function _saveZones() {
    if (_expandedId === null) return;
    const saveBtn = _listEl.querySelector('.scam-zone-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
      await fetch(`/api/cameras/${_expandedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exclusion_zones: _zones }),
      });
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Saved ✓'; }
      setTimeout(() => { if (saveBtn) saveBtn.textContent = 'Save'; }, 2000);
    } catch (err) {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Error'; }
    }
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  function _fmtTs(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return ts; }
  }

  return { init, setStaticMode, setTimeWindow, updateStats };
})();
