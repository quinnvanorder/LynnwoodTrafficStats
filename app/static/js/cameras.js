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

  // Fullscreen image overlay
  let _fsOverlay = null;
  let _fsMedia = null;

  // Zone editor state
  let _zones = [];         // [{cx,cy,w,h,angle}, ...] normalized 0–1
  let _zoneEditing = false;
  let _selectedIdx = -1;
  let _zoneDragMode = null;
  let _bgImage = null;
  let _zoneCW = 0, _zoneCH = 0;
  let _zoneCanvas = null;
  let _zoneOverlay = null;  // the fullscreen overlay DOM element
  let _zoneSaveBtn = null;  // ref to save button inside overlay

  const HANDLE_R = 6;
  const ROT_DIST = 30;

  let _listEl, _searchEl;

  // ── Init ─────────────────────────────────────────────────────────────────────

  function init(onSelectCallback) {
    _onSelect = onSelectCallback;
    _listEl   = document.getElementById('scamList');
    _searchEl = document.getElementById('scamSearch');
    _searchEl.addEventListener('input', _render);

    _listEl.addEventListener('click', e => {
      const header = e.target.closest('.scam-header');
      if (header) { _toggleExpand(Number(header.closest('.scam-item').dataset.camId)); return; }
      if (e.target.closest('.scam-play-btn'))   { _startPlay();           return; }
      if (e.target.closest('.scam-stop-btn'))   { _stopPlay();            return; }
      if (e.target.closest('.scam-image-wrap') && !_zoneEditing) { _openFullscreen(); return; }
      if (e.target.closest('.scam-zone-btn'))   { _openZoneFullscreen();  return; }
    });

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

    // Delete selected zone
    document.addEventListener('keydown', e => {
      if (!_zoneEditing || _selectedIdx < 0) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        _zones.splice(_selectedIdx, 1);
        _selectedIdx = _zones.length > 0 ? Math.min(_selectedIdx, _zones.length - 1) : -1;
        _drawZoneCanvas();
      }
    });
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
    } else {
      _stopPlay();
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
    <button class="btn-secondary btn-sm scam-zone-btn" title="Draw zones over areas to ignore during detection">🎯 Exclusion Zones</button>
  </div>
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
    if (_fsMedia && _fsMedia.tagName === 'VIDEO') {
      if (Math.abs(_fsMedia.currentTime - vid.currentTime) > 0.5)
        _fsMedia.currentTime = vid.currentTime;
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

  function _startPlay() { if (_isStaticMode) _startPlayStatic(); else _startPlayLAN(); }
  function _stopPlay()  { if (_isStaticMode) _stopPlayStatic();  else _stopPlayLAN();  }

  function _setPlayBtns(playing) {
    const p = _listEl.querySelector('.scam-play-btn');
    const s = _listEl.querySelector('.scam-stop-btn');
    if (p) p.style.display = playing ? 'none' : '';
    if (s) s.style.display = playing ? '' : 'none';
    if (_fsOverlay) {
      const fp = _fsOverlay.querySelector('.scam-fs-play');
      const fs = _fsOverlay.querySelector('.scam-fs-stop');
      if (fp) fp.style.display = playing ? 'none' : '';
      if (fs) fs.style.display = playing ? '' : 'none';
    }
  }

  // ── Fullscreen image overlay ─────────────────────────────────────────────────

  function _openFullscreen() {
    if (_fsOverlay) return;
    const overlay = document.createElement('div');
    overlay.className = 'scam-fs-overlay';

    if (_isStaticMode) {
      const vid = document.getElementById('scamDetailVideo');
      _fsMedia = document.createElement('video');
      _fsMedia.src = vid ? vid.src : '';
      _fsMedia.currentTime = vid ? vid.currentTime : 0;
      _fsMedia.playsinline = true;
      _fsMedia.muted = true;
      _fsMedia.className = 'scam-fs-media';
      if (vid && !vid.paused) _fsMedia.play().catch(() => {});
      if (vid) vid.ontimeupdate = _onVideoTimeUpdate;
    } else {
      const imgEl = document.getElementById('scamDetailImg');
      _fsMedia = document.createElement('img');
      _fsMedia.src = imgEl ? imgEl.src : '';
      _fsMedia.alt = '';
      _fsMedia.className = 'scam-fs-media';
    }

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
    const cam = _stats.find(c => c.id === _expandedId);
    if (cam) statsEl.innerHTML = _statsGridHtml(cam);

    const isPlaying = !!_playTimer || (!!document.getElementById('scamDetailVideo') && !document.getElementById('scamDetailVideo').paused);
    playBtn.style.display = isPlaying ? 'none' : '';
    stopBtn.style.display = isPlaying ? '' : 'none';

    controls.appendChild(playBtn);
    controls.appendChild(stopBtn);
    controls.appendChild(statsEl);

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

  // ── Zone geometry helpers ────────────────────────────────────────────────────

  function _zCorners(z) {
    const cx = z.cx * _zoneCW, cy = z.cy * _zoneCH;
    const hw = z.w * _zoneCW / 2, hh = z.h * _zoneCH / 2;
    const cos = Math.cos(z.angle), sin = Math.sin(z.angle);
    return [
      { x: cx - hw*cos + hh*sin, y: cy - hw*sin - hh*cos, name: 'nw' },
      { x: cx + hw*cos + hh*sin, y: cy + hw*sin - hh*cos, name: 'ne' },
      { x: cx + hw*cos - hh*sin, y: cy + hw*sin + hh*cos, name: 'se' },
      { x: cx - hw*cos - hh*sin, y: cy - hw*sin + hh*cos, name: 'sw' },
    ];
  }

  function _zEdges(z) {
    const cx = z.cx * _zoneCW, cy = z.cy * _zoneCH;
    const hw = z.w * _zoneCW / 2, hh = z.h * _zoneCH / 2;
    const cos = Math.cos(z.angle), sin = Math.sin(z.angle);
    return [
      { x: cx + hh*sin,  y: cy - hh*cos,  name: 'n' },
      { x: cx + hw*cos,  y: cy + hw*sin,  name: 'e' },
      { x: cx - hh*sin,  y: cy + hh*cos,  name: 's' },
      { x: cx - hw*cos,  y: cy - hw*sin,  name: 'w' },
    ];
  }

  function _zRotHandle(z) {
    const cx = z.cx * _zoneCW, cy = z.cy * _zoneCH;
    const hh = z.h * _zoneCH / 2;
    const dist = hh + ROT_DIST;
    const cos = Math.cos(z.angle), sin = Math.sin(z.angle);
    return { x: cx + dist * sin, y: cy - dist * cos };
  }

  function _zOpposite(z, name) {
    const opp = { nw:'se', ne:'sw', se:'nw', sw:'ne', n:'s', s:'n', e:'w', w:'e' };
    return [..._zCorners(z), ..._zEdges(z)].find(h => h.name === opp[name]);
  }

  function _ptInZone(px, py, z) {
    const cx = z.cx * _zoneCW, cy = z.cy * _zoneCH;
    const dx = px - cx, dy = py - cy;
    const cos = Math.cos(-z.angle), sin = Math.sin(-z.angle);
    const lx = dx*cos - dy*sin, ly = dx*sin + dy*cos;
    return Math.abs(lx) <= z.w * _zoneCW / 2 && Math.abs(ly) <= z.h * _zoneCH / 2;
  }

  function _zXY(e) {
    const r = _zoneCanvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function _zdist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

  // ── Zone canvas mouse handlers ───────────────────────────────────────────────

  function _onZDown(e) {
    if (!_zoneCanvas) return;
    const { x, y } = _zXY(e);

    if (_selectedIdx >= 0) {
      const z = _zones[_selectedIdx];
      const rh = _zRotHandle(z);
      if (_zdist(x, y, rh.x, rh.y) <= HANDLE_R + 4) {
        _zoneDragMode = { type: 'rotate', idx: _selectedIdx };
        return;
      }
      for (const h of [..._zCorners(z), ..._zEdges(z)]) {
        if (_zdist(x, y, h.x, h.y) <= HANDLE_R + 4) {
          const opp = _zOpposite(z, h.name);
          _zoneDragMode = { type: 'resize', idx: _selectedIdx, handle: h.name, fixedX: opp.x, fixedY: opp.y };
          return;
        }
      }
    }

    for (let i = _zones.length - 1; i >= 0; i--) {
      if (_ptInZone(x, y, _zones[i])) {
        _selectedIdx = i;
        _zoneDragMode = { type: 'move', idx: i, startX: x, startY: y, startCX: _zones[i].cx, startCY: _zones[i].cy };
        _drawZoneCanvas();
        return;
      }
    }

    _selectedIdx = -1;
    _zoneDragMode = { type: 'create', startX: x, startY: y };
    _drawZoneCanvas();
  }

  function _onZMove(e) {
    if (!_zoneCanvas) return;
    const { x, y } = _zXY(e);
    if (!_zoneDragMode) { _updateZCursor(x, y); return; }

    const dm = _zoneDragMode;
    if (dm.type === 'create') {
      _drawZoneCanvas({
        x1: Math.min(dm.startX, x), y1: Math.min(dm.startY, y),
        x2: Math.max(dm.startX, x), y2: Math.max(dm.startY, y),
      });
    } else if (dm.type === 'move') {
      _zones[dm.idx].cx = Math.max(0, Math.min(1, dm.startCX + (x - dm.startX) / _zoneCW));
      _zones[dm.idx].cy = Math.max(0, Math.min(1, dm.startCY + (y - dm.startY) / _zoneCH));
      _drawZoneCanvas();
    } else if (dm.type === 'rotate') {
      const z = _zones[dm.idx];
      const cx = z.cx * _zoneCW, cy = z.cy * _zoneCH;
      _zones[dm.idx].angle = Math.atan2(x - cx, -(y - cy));
      _drawZoneCanvas();
    } else if (dm.type === 'resize') {
      _applyResize(dm, x, y);
      _drawZoneCanvas();
    }
  }

  function _onZUp(e) {
    if (!_zoneDragMode) return;
    const { x, y } = _zXY(e);

    if (_zoneDragMode.type === 'create') {
      const x1 = Math.min(_zoneDragMode.startX, x) / _zoneCW;
      const y1 = Math.min(_zoneDragMode.startY, y) / _zoneCH;
      const x2 = Math.max(_zoneDragMode.startX, x) / _zoneCW;
      const y2 = Math.max(_zoneDragMode.startY, y) / _zoneCH;
      const w = x2 - x1, h = y2 - y1;
      if (w > 0.02 && h > 0.02) {
        _zones.push({ cx: x1 + w / 2, cy: y1 + h / 2, w, h, angle: 0 });
        _selectedIdx = _zones.length - 1;
      }
    }
    _zoneDragMode = null;
    _drawZoneCanvas();
  }

  function _onZLeave() {
    if (_zoneDragMode?.type === 'create') { _zoneDragMode = null; _drawZoneCanvas(); }
  }

  function _applyResize(dm, mx, my) {
    const z = _zones[dm.idx];
    const cos = Math.cos(z.angle), sin = Math.sin(z.angle);
    let cx = mx, cy = my;
    if (dm.handle === 'n' || dm.handle === 's') {
      const dot = (mx - dm.fixedX) * (-sin) + (my - dm.fixedY) * cos;
      cx = dm.fixedX + dot * (-sin);
      cy = dm.fixedY + dot * cos;
    } else if (dm.handle === 'e' || dm.handle === 'w') {
      const dot = (mx - dm.fixedX) * cos + (my - dm.fixedY) * sin;
      cx = dm.fixedX + dot * cos;
      cy = dm.fixedY + dot * sin;
    }
    const newCX = (cx + dm.fixedX) / 2, newCY = (cy + dm.fixedY) / 2;
    const halfX = cx - newCX, halfY = cy - newCY;
    _zones[dm.idx] = {
      ...z,
      cx: newCX / _zoneCW,
      cy: newCY / _zoneCH,
      w: Math.max(0.02, Math.abs(halfX * cos + halfY * sin) * 2 / _zoneCW),
      h: Math.max(0.02, Math.abs(-halfX * sin + halfY * cos) * 2 / _zoneCH),
    };
  }

  function _updateZCursor(x, y) {
    if (!_zoneCanvas) return;
    if (_selectedIdx >= 0) {
      const z = _zones[_selectedIdx];
      if (_zdist(x, y, _zRotHandle(z).x, _zRotHandle(z).y) <= HANDLE_R + 4) {
        _zoneCanvas.style.cursor = 'grab'; return;
      }
      for (const h of [..._zCorners(z), ..._zEdges(z)]) {
        if (_zdist(x, y, h.x, h.y) <= HANDLE_R + 4) {
          _zoneCanvas.style.cursor = 'pointer'; return;
        }
      }
    }
    for (let i = _zones.length - 1; i >= 0; i--) {
      if (_ptInZone(x, y, _zones[i])) { _zoneCanvas.style.cursor = 'move'; return; }
    }
    _zoneCanvas.style.cursor = 'crosshair';
  }

  // ── Zone canvas drawing ──────────────────────────────────────────────────────

  function _drawZoneCanvas(preview = null) {
    if (!_zoneCanvas) return;
    const ctx = _zoneCanvas.getContext('2d');
    ctx.clearRect(0, 0, _zoneCW, _zoneCH);

    if (_bgImage) {
      ctx.drawImage(_bgImage, 0, 0, _zoneCW, _zoneCH);
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.fillRect(0, 0, _zoneCW, _zoneCH);
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, _zoneCW, _zoneCH);
    }

    for (let i = 0; i < _zones.length; i++) _drawZone(ctx, _zones[i], i === _selectedIdx);

    if (preview) {
      ctx.fillStyle = 'rgba(239,68,68,0.28)';
      ctx.strokeStyle = '#fca5a5';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(preview.x1, preview.y1, preview.x2 - preview.x1, preview.y2 - preview.y1);
      ctx.strokeRect(preview.x1, preview.y1, preview.x2 - preview.x1, preview.y2 - preview.y1);
      ctx.setLineDash([]);
    }
  }

  function _drawZone(ctx, z, selected) {
    const corners = _zCorners(z);
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    corners.slice(1).forEach(c => ctx.lineTo(c.x, c.y));
    ctx.closePath();
    ctx.fillStyle   = selected ? 'rgba(239,68,68,0.45)' : 'rgba(239,68,68,0.32)';
    ctx.strokeStyle = selected ? '#ef4444' : '#f87171';
    ctx.lineWidth   = selected ? 2 : 1.5;
    ctx.fill(); ctx.stroke();

    if (!selected) return;

    const edges = _zEdges(z);
    const nEdge = edges.find(e => e.name === 'n');
    const rh = _zRotHandle(z);
    ctx.beginPath();
    ctx.moveTo(nEdge.x, nEdge.y);
    ctx.lineTo(rh.x, rh.y);
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1; ctx.stroke();

    for (const h of [...corners, ...edges]) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.5;
      ctx.fill(); ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(rh.x, rh.y, HANDLE_R, 0, Math.PI * 2);
    ctx.fillStyle = '#3b82f6'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.fill(); ctx.stroke();
  }

  // ── Zone fullscreen overlay ──────────────────────────────────────────────────

  function _openZoneFullscreen() {
    if (_zoneEditing || _zoneOverlay) return;
    _zoneEditing = true;
    _selectedIdx = -1;
    _zoneDragMode = null;
    _bgImage = null;

    // Compute canvas size: fit 16:9 into viewport minus toolbar space
    const pad = 40;
    const toolH = 60;
    const availW = window.innerWidth  - pad * 2;
    const availH = window.innerHeight - pad * 2 - toolH;
    let cw, ch;
    if (availW / availH > 16 / 9) {
      ch = availH; cw = Math.round(ch * 16 / 9);
    } else {
      cw = availW; ch = Math.round(cw * 9 / 16);
    }
    _zoneCW = cw; _zoneCH = ch;

    // Overlay backdrop
    const overlay = document.createElement('div');
    overlay.className = 'scam-fs-overlay';
    overlay.style.flexDirection = 'column';
    overlay.style.gap = '0';

    // Camera name header
    const cam = _stats.find(c => c.id === _expandedId);
    const header = document.createElement('div');
    header.style.cssText = 'font-size:13px;font-weight:600;color:#f1f5f9;margin-bottom:10px;';
    header.textContent = cam ? `Exclusion Zones — ${cam.address}` : 'Exclusion Zones';
    overlay.appendChild(header);

    // Canvas
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.style.cssText = `width:${cw}px;height:${ch}px;cursor:crosshair;border-radius:6px;display:block;`;
    overlay.appendChild(canvas);
    _zoneCanvas = canvas;

    // Toolbar below canvas
    const toolbar = document.createElement('div');
    toolbar.style.cssText = `
      display:flex;align-items:center;gap:10px;margin-top:12px;
      width:${cw}px;flex-wrap:wrap;
    `;

    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:11px;color:#94a3b8;flex:1;';
    hint.textContent = 'Drag to draw · click to select · handles to resize · blue ● to rotate · Delete to remove';
    toolbar.appendChild(hint);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn-secondary btn-sm';
    clearBtn.textContent = '✕ Clear All';
    clearBtn.addEventListener('click', e => { e.stopPropagation(); _clearZones(); });
    toolbar.appendChild(clearBtn);

    _zoneSaveBtn = document.createElement('button');
    _zoneSaveBtn.className = 'btn-primary btn-sm';
    _zoneSaveBtn.textContent = 'Save';
    _zoneSaveBtn.addEventListener('click', async e => { e.stopPropagation(); await _saveZones(); });
    toolbar.appendChild(_zoneSaveBtn);

    overlay.appendChild(toolbar);

    // Close button (top-right)
    const closeBtn = document.createElement('button');
    closeBtn.className = 'scam-fs-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', e => { e.stopPropagation(); _closeZoneFullscreen(); });
    overlay.appendChild(closeBtn);

    document.body.appendChild(overlay);
    _zoneOverlay = overlay;

    // Canvas event listeners
    canvas.addEventListener('mousedown',  _onZDown);
    canvas.addEventListener('mousemove',  _onZMove);
    canvas.addEventListener('mouseup',    _onZUp);
    canvas.addEventListener('mouseleave', _onZLeave);

    // Load background from sidebar image
    const imgEl = document.getElementById('scamDetailImg');
    if (imgEl && imgEl.src && !imgEl.src.endsWith('/')) {
      const bg = new Image();
      bg.onload  = () => { _bgImage = bg; _drawZoneCanvas(); };
      bg.onerror = () => _drawZoneCanvas();
      bg.src = imgEl.src;
    } else {
      _drawZoneCanvas();
    }

    document.addEventListener('keydown', _zoneOverlayEsc);
  }

  function _closeZoneFullscreen() {
    if (!_zoneOverlay) return;
    _zoneEditing = false;
    _selectedIdx = -1;
    _zoneCanvas  = null;
    _zoneSaveBtn = null;
    document.removeEventListener('keydown', _zoneOverlayEsc);
    document.body.removeChild(_zoneOverlay);
    _zoneOverlay = null;
  }

  function _zoneOverlayEsc(e) { if (e.key === 'Escape') _closeZoneFullscreen(); }

  // ── Zone data ────────────────────────────────────────────────────────────────

  async function _loadZones(cameraId) {
    try {
      const cams = await fetch('/api/cameras').then(r => r.json());
      const cam = cams.find(c => c.id === cameraId);
      const raw = (cam && cam.exclusion_zones) ? JSON.parse(cam.exclusion_zones) : [];
      _zones = raw.map(z => Array.isArray(z)
        ? { cx: (z[0]+z[2])/2, cy: (z[1]+z[3])/2, w: z[2]-z[0], h: z[3]-z[1], angle: 0 }
        : z
      );
    } catch { _zones = []; }
    _selectedIdx = -1;
    if (_zoneCanvas && _zoneEditing) _drawZoneCanvas();
  }

  function _clearZones() {
    _zones = [];
    _selectedIdx = -1;
    _drawZoneCanvas();
  }

  async function _saveZones() {
    if (_expandedId === null) return;
    const btn = _zoneSaveBtn;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await fetch(`/api/cameras/${_expandedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exclusion_zones: _zones }),
      });
      if (btn) { btn.disabled = false; btn.textContent = 'Saved ✓'; }
      setTimeout(() => { if (btn) btn.textContent = 'Save'; }, 2000);
    } catch {
      if (btn) { btn.disabled = false; btn.textContent = 'Error'; }
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
