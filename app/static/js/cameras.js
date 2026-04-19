// Sidebar camera list: collapsible per-camera rows with image/play/counts

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

  // Per-camera LAN playback state
  let _playFrames = [];
  let _playIndex = 0;
  let _playTimer = null;

  // Per-camera static video state
  let _videoIndex = [];
  let _scrubbing = false;

  let _listEl, _searchEl;

  function init(onSelectCallback) {
    _onSelect = onSelectCallback;
    _listEl  = document.getElementById('scamList');
    _searchEl = document.getElementById('scamSearch');
    _searchEl.addEventListener('input', _render);

    // Delegated events on the list
    _listEl.addEventListener('click', e => {
      const header = e.target.closest('.scam-header');
      if (header) {
        const id = Number(header.closest('.scam-item').dataset.camId);
        _toggleExpand(id);
        return;
      }
      const playBtn = e.target.closest('.scam-play-btn');
      if (playBtn) { _startPlay(); return; }
      const stopBtn = e.target.closest('.scam-stop-btn');
      if (stopBtn) { _stopPlay(); return; }
    });

    // scrub bar via change (range input doesn't bubble reliably via click delegation)
    document.addEventListener('input', e => {
      if (e.target && e.target.id === 'scamScrubBar') {
        const vid = document.getElementById('scamDetailVideo');
        if (vid) vid.currentTime = Number(e.target.value);
      }
    });
    document.addEventListener('mousedown', e => { if (e.target && e.target.id === 'scamScrubBar') _scrubbing = true; });
    document.addEventListener('mouseup',   () => { _scrubbing = false; });
    document.addEventListener('touchstart', e => { if (e.target && e.target.id === 'scamScrubBar') _scrubbing = true; });
    document.addEventListener('touchend',  () => { _scrubbing = false; });
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

  function _render() {
    const q = (_searchEl.value || '').toLowerCase();
    const filtered = _stats.filter(c => c.address.toLowerCase().includes(q));
    _listEl.innerHTML = filtered.map(cam => _itemHtml(cam)).join('');
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
    if (_isStaticMode) {
      return `
<div class="scam-detail">
  <div class="scam-image-wrap" id="scamImageWrap">
    <video id="scamDetailVideo" class="scam-detail-img" playsinline muted></video>
  </div>
  <div id="scamDetailTs" class="scam-detail-ts"></div>
  <div class="scam-playback-row">
    <button class="btn-primary btn-sm scam-play-btn" id="scamPlayBtn">▶ Play</button>
    <button class="btn-secondary btn-sm scam-stop-btn" id="scamStopBtn" style="display:none">⏹ Stop</button>
    <div class="cp-play-bar"><div class="progress-bar"><div id="scamPlayFill" class="progress-fill"></div></div></div>
  </div>
  <div class="scam-scrub-row">
    <input type="range" id="scamScrubBar" class="cp-scrub-bar" min="0" max="100" step="0.01" value="0" />
  </div>
  <div class="scam-stats-heading" id="scamStatsHeading">Counts · full period</div>
  <div class="cp-stats-grid" id="scamDetailStats">${_statsGridHtml(cam)}</div>
</div>`;
    }
    return `
<div class="scam-detail">
  <div class="scam-image-wrap" id="scamImageWrap">
    <img id="scamDetailImg" class="scam-detail-img" alt="" />
  </div>
  <div id="scamDetailTs" class="scam-detail-ts"></div>
  <div class="scam-playback-row">
    <button class="btn-primary btn-sm scam-play-btn" id="scamPlayBtn">▶ Play</button>
    <button class="btn-secondary btn-sm scam-stop-btn" id="scamStopBtn" style="display:none">⏹ Stop</button>
    <div class="cp-play-bar"><div class="progress-bar"><div id="scamPlayFill" class="progress-fill"></div></div></div>
  </div>
  <div class="scam-stats-heading" id="scamStatsHeading">Counts · selected window</div>
  <div class="cp-stats-grid" id="scamDetailStats">${_statsGridHtml(cam)}</div>
</div>`;
  }

  function _refreshDetailStats(obj) {
    const el = document.getElementById('scamDetailStats');
    if (el) el.innerHTML = _statsGridHtml(obj);
  }

  async function _loadDetail(cam) {
    if (_isStaticMode) {
      await _loadDetailStatic(cam);
    } else {
      await _loadDetailLAN(cam);
    }
  }

  // ── LAN detail ──────────────────────────────────────────────────────────────

  async function _loadDetailLAN(cam) {
    _playFrames = [];
    _playIndex = 0;

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
    const playBtn = document.getElementById('scamPlayBtn');
    const stopBtn = document.getElementById('scamStopBtn');
    if (playBtn) playBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';
    _playIndex = 0;
    _playTimer = setInterval(() => {
      if (_playIndex >= _playFrames.length) { _stopPlayLAN(); return; }
      const f = _playFrames[_playIndex++];
      const imgEl  = document.getElementById('scamDetailImg');
      const tsEl   = document.getElementById('scamDetailTs');
      const fillEl = document.getElementById('scamPlayFill');
      const hdgEl  = document.getElementById('scamStatsHeading');
      if (imgEl) imgEl.src = '/data/' + (f.annotated_path || f.image_path);
      if (tsEl)  tsEl.textContent = _fmtTs(f.captured_at);
      if (fillEl) fillEl.style.width = ((_playIndex / _playFrames.length) * 100) + '%';
      if (hdgEl)  hdgEl.textContent = 'Counts · this frame';
      _refreshDetailStats(f);
    }, 250);
  }

  function _stopPlayLAN() {
    if (_playTimer) { clearInterval(_playTimer); _playTimer = null; }
    const playBtn = document.getElementById('scamPlayBtn');
    const stopBtn = document.getElementById('scamStopBtn');
    const hdgEl  = document.getElementById('scamStatsHeading');
    if (playBtn) playBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
    if (hdgEl)  hdgEl.textContent = 'Counts · selected window';
    const cam = _stats.find(c => c.id === _expandedId);
    if (cam) _refreshDetailStats(cam);
  }

  // ── Static detail ───────────────────────────────────────────────────────────

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
    vid.addEventListener('ended', () => {
      const playBtn = document.getElementById('scamPlayBtn');
      const stopBtn = document.getElementById('scamStopBtn');
      if (playBtn) playBtn.style.display = '';
      if (stopBtn) stopBtn.style.display = 'none';
    });

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
    }
    const pct = vid.duration ? (vid.currentTime / vid.duration) * 100 : 0;
    const fillEl = document.getElementById('scamPlayFill');
    if (fillEl) fillEl.style.width = pct + '%';
    const scrub = document.getElementById('scamScrubBar');
    if (scrub && !_scrubbing) scrub.value = vid.currentTime;
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
    const playBtn = document.getElementById('scamPlayBtn');
    const stopBtn = document.getElementById('scamStopBtn');
    if (playBtn) playBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';
  }

  function _stopPlayStatic() {
    const vid = document.getElementById('scamDetailVideo');
    if (vid) vid.pause();
    const playBtn = document.getElementById('scamPlayBtn');
    const stopBtn = document.getElementById('scamStopBtn');
    if (playBtn) playBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
  }

  // ── Shared ──────────────────────────────────────────────────────────────────

  function _startPlay() { if (_isStaticMode) _startPlayStatic(); else _startPlayLAN(); }
  function _stopPlay()  {
    if (_isStaticMode) _stopPlayStatic(); else _stopPlayLAN();
    if (_isStaticMode) {
      const vid = document.getElementById('scamDetailVideo');
      if (vid) { vid.pause(); }
    }
  }

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
