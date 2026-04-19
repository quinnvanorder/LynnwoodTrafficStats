// Camera panel: list + detail view with image playback (LAN) or video scrubbing (static)

const CameraPanel = (() => {
  const STAT_LABELS = {
    car_count: 'Cars', truck_count: 'Trucks', bus_count: 'Buses',
    motorcycle_count: 'Motorcycles', person_count: 'Pedestrians', bicycle_count: 'Cyclists',
  };
  const WINDOW_HOURS = {
    '5m': 5/60, '10m': 10/60, '30m': 0.5,
    '1h': 1, '1d': 24, '1w': 168, '1m': 720, '6m': 4380, '1y': 8760, '5y': 43800,
  };

  let _stats = [];
  let _selectedId = null;
  let _timeWindow = '5m';
  let _isStaticMode = false;

  // LAN playback state
  let _playFrames = [];
  let _playIndex = 0;
  let _playTimer = null;

  // Static video state
  let _videoIndex = [];
  let _scrubbing = false;

  let _onSelect = null;

  // DOM refs
  let panel, listView, detailView, listEl, searchEl;
  let detailName, detailTimestamp, detailStatsEl, statsHeading;
  let imageWrap, detailImage;
  let videoWrap, detailVideo, scrubRow, scrubBar;
  let playBtn, stopBtn, playFill;

  function _el(id) { return document.getElementById(id); }

  function init(onSelectCallback) {
    _onSelect = onSelectCallback;
    panel        = _el('camera-panel');
    listView     = _el('cpListView');
    detailView   = _el('cpDetailView');
    listEl       = _el('cpCameraList');
    searchEl     = _el('cpSearch');
    detailName   = _el('cpDetailName');
    detailTimestamp  = _el('cpDetailTimestamp');
    detailStatsEl    = _el('cpDetailStats');
    statsHeading     = _el('cpStatsHeading');
    imageWrap    = _el('cpImageWrap');
    detailImage  = _el('cpDetailImage');
    videoWrap    = _el('cpVideoWrap');
    detailVideo  = _el('cpDetailVideo');
    scrubRow     = _el('cpScrubRow');
    scrubBar     = _el('cpScrubBar');
    playBtn      = _el('cpPlayBtn');
    stopBtn      = _el('cpStopBtn');
    playFill     = _el('cpPlayFill');

    searchEl.addEventListener('input', _renderList);
    _el('cpBackBtn').addEventListener('click', _back);
    _el('cpClose').addEventListener('click', hide);
    playBtn.addEventListener('click', _startPlay);
    stopBtn.addEventListener('click', _stopPlay);

    imageWrap.addEventListener('click', _openFullscreen);
    videoWrap.addEventListener('click', _openFullscreen);

    scrubBar.addEventListener('mousedown', () => { _scrubbing = true; });
    scrubBar.addEventListener('touchstart', () => { _scrubbing = true; });
    scrubBar.addEventListener('input', () => {
      detailVideo.currentTime = Number(scrubBar.value);
    });
    scrubBar.addEventListener('mouseup',   () => { _scrubbing = false; });
    scrubBar.addEventListener('touchend',  () => { _scrubbing = false; });

    detailVideo.addEventListener('timeupdate', _onVideoTimeUpdate);
    detailVideo.addEventListener('ended', () => {
      playBtn.style.display = '';
      stopBtn.style.display = 'none';
    });

    listEl.addEventListener('click', e => {
      const item = e.target.closest('[data-cam-id]');
      if (item) _selectFromList(Number(item.dataset.camId));
    });
  }

  function setStaticMode(isStatic) {
    _isStaticMode = isStatic;
  }

  function show() { panel.style.display = 'flex'; }
  function hide() { panel.style.display = 'none'; }
  function toggle() {
    const open = panel.style.display === 'none' || panel.style.display === '';
    open ? show() : hide();
    return open;
  }

  function setTimeWindow(win) { _timeWindow = win; }

  function updateStats(stats) {
    _stats = stats;
    _renderList();
    if (_selectedId !== null) {
      const cam = _stats.find(c => c.id === _selectedId);
      if (cam) _updateDetailStats(cam);
    }
  }

  function _renderList() {
    const q = (searchEl.value || '').toLowerCase();
    const filtered = _stats.filter(c => c.address.toLowerCase().includes(q));
    listEl.innerHTML = filtered.map(cam => `
      <div class="cp-camera-item${cam.id === _selectedId ? ' selected' : ''}" data-cam-id="${cam.id}">
        <div class="cp-camera-name">${cam.address}</div>
        <div class="cp-camera-meta">${(cam.snapshot_count || 0).toLocaleString()} snapshots · ${(cam.total_count || 0).toLocaleString()} detections</div>
      </div>
    `).join('');
  }

  function _selectFromList(id) {
    const cam = _stats.find(c => c.id === id);
    if (!cam) return;
    _selectedId = id;
    _renderList();
    _showDetail(cam);
    if (_onSelect) _onSelect(cam);
  }

  function selectCamera(cam) {
    _selectedId = cam.id;
    show();
    _renderList();
    _showDetail(cam);
  }

  async function _showDetail(cam) {
    _stopPlay();
    panel.classList.add('wide');
    listView.style.display = 'none';
    detailView.style.display = 'flex';
    detailName.textContent = cam.address;
    detailTimestamp.textContent = '';
    playFill.style.width = '0%';
    _updateDetailStats(cam);

    if (_isStaticMode) {
      await _showDetailStatic(cam);
    } else {
      await _showDetailLAN(cam);
    }
  }

  // ── LAN detail ────────────────────────────────────────────────────────────────

  async function _showDetailLAN(cam) {
    imageWrap.style.display = '';
    videoWrap.style.display = 'none';
    scrubRow.style.display = 'none';
    statsHeading.textContent = 'Counts · selected window';
    detailImage.src = '';

    const snaps = await fetch(`/api/snapshots?camera_id=${cam.id}&limit=1`).then(r => r.json());
    if (snaps.length && snaps[0].image_path) {
      const snap = snaps[0];
      detailImage.src = '/data/' + (snap.annotated_path || snap.image_path);
      detailTimestamp.textContent = _fmtTs(snap.captured_at);
    }

    _loadFrames(cam.id);
  }

  async function _loadFrames(cameraId) {
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
    playBtn.style.display = 'none';
    stopBtn.style.display = '';
    _playIndex = 0;
    _playTimer = setInterval(() => {
      if (_playIndex >= _playFrames.length) { _stopPlay(); return; }
      const f = _playFrames[_playIndex++];
      detailImage.src = '/data/' + (f.annotated_path || f.image_path);
      detailTimestamp.textContent = _fmtTs(f.captured_at);
      playFill.style.width = ((_playIndex / _playFrames.length) * 100) + '%';
      statsHeading.textContent = 'Counts · this frame';
      _updateDetailStats(f);
    }, 250);
  }

  function _stopPlayLAN() {
    if (_playTimer) { clearInterval(_playTimer); _playTimer = null; }
    playBtn.style.display = '';
    stopBtn.style.display = 'none';
    statsHeading.textContent = 'Counts · selected window';
    const cam = _stats.find(c => c.id === _selectedId);
    if (cam) _updateDetailStats(cam);
  }

  // ── Static detail ─────────────────────────────────────────────────────────────

  async function _showDetailStatic(cam) {
    imageWrap.style.display = 'none';
    videoWrap.style.display = '';
    scrubRow.style.display = '';
    statsHeading.textContent = 'Counts · full period';

    const base = `data/cameras/${cam.id}`;
    detailVideo.src = `${base}/video.webm`;
    scrubBar.value = 0;
    playFill.style.width = '0%';

    detailVideo.onloadedmetadata = () => {
      scrubBar.max = detailVideo.duration;
    };

    try {
      _videoIndex = await fetch(`${base}/index.json`).then(r => r.json());
      if (_videoIndex.length) {
        _updateDetailStats(_videoIndex[0]);
        detailTimestamp.textContent = _fmtTs(_videoIndex[0].ts);
      }
    } catch {
      _videoIndex = [];
    }
  }

  function _onVideoTimeUpdate() {
    if (!_videoIndex.length) return;
    const frame = _findVideoFrame(detailVideo.currentTime);
    if (frame) {
      statsHeading.textContent = 'Counts · this frame';
      _updateDetailStats(frame);
      detailTimestamp.textContent = _fmtTs(frame.ts);
    }
    const pct = detailVideo.duration
      ? (detailVideo.currentTime / detailVideo.duration) * 100
      : 0;
    playFill.style.width = pct + '%';
    if (!_scrubbing) scrubBar.value = detailVideo.currentTime;
  }

  function _findVideoFrame(t) {
    // Binary search for the last frame with .t <= t
    let lo = 0, hi = _videoIndex.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (_videoIndex[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return _videoIndex[lo] || null;
  }

  function _startPlayStatic() {
    detailVideo.play().catch(() => {});
    playBtn.style.display = 'none';
    stopBtn.style.display = '';
  }

  function _stopPlayStatic() {
    detailVideo.pause();
    playBtn.style.display = '';
    stopBtn.style.display = 'none';
  }

  // ── Shared play/stop ─────────────────────────────────────────────────────────

  function _startPlay() {
    if (_isStaticMode) _startPlayStatic();
    else _startPlayLAN();
  }

  function _stopPlay() {
    if (_isStaticMode) _stopPlayStatic();
    else _stopPlayLAN();
  }

  function _back() {
    _closeFullscreen();
    _stopPlay();
    if (_isStaticMode) {
      detailVideo.pause();
      detailVideo.src = '';
    }
    _selectedId = null;
    panel.classList.remove('wide');
    detailView.style.display = 'none';
    listView.style.display = '';
    _renderList();
  }

  // ── Fullscreen ────────────────────────────────────────────────────────────────

  let _fsOverlay = null;

  function _openFullscreen() {
    if (_fsOverlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'cp-fullscreen-overlay';

    let media;
    if (_isStaticMode) {
      media = document.createElement('video');
      media.src = detailVideo.src;
      media.currentTime = detailVideo.currentTime;
      media.playsinline = true;
      media.muted = true;
      media.style.maxWidth = '100%';
      media.style.maxHeight = '100%';
      if (!detailVideo.paused) media.play().catch(() => {});
      // Keep the two videos in sync
      detailVideo.ontimeupdate = () => {
        _onVideoTimeUpdate();
        if (Math.abs(media.currentTime - detailVideo.currentTime) > 0.5) {
          media.currentTime = detailVideo.currentTime;
        }
      };
    } else {
      media = document.createElement('img');
      media.src = detailImage.src;
      media.alt = '';
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cp-fullscreen-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', e => { e.stopPropagation(); _closeFullscreen(); });

    overlay.appendChild(media);
    overlay.appendChild(closeBtn);
    document.body.appendChild(overlay);
    _fsOverlay = overlay;

    overlay.addEventListener('click', _closeFullscreen);
    document.addEventListener('keydown', _fsEscHandler);
  }

  function _closeFullscreen() {
    if (!_fsOverlay) return;
    document.body.removeChild(_fsOverlay);
    _fsOverlay = null;
    document.removeEventListener('keydown', _fsEscHandler);
    // Restore video timeupdate handler
    if (_isStaticMode) {
      detailVideo.ontimeupdate = _onVideoTimeUpdate;
    }
  }

  function _fsEscHandler(e) {
    if (e.key === 'Escape') _closeFullscreen();
  }

  function _updateDetailStats(obj) {
    detailStatsEl.innerHTML = Object.entries(STAT_LABELS)
      .map(([k, l]) => `<span class="ds-label">${l}</span><span class="ds-val">${(obj[k] || 0).toLocaleString()}</span>`)
      .join('');
  }

  function _fmtTs(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return ts; }
  }

  return { init, show, hide, toggle, setStaticMode, setTimeWindow, updateStats, selectCamera };
})();
