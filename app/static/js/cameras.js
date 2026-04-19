// Camera panel: list + detail view with image playback

const CameraPanel = (() => {
  const STAT_LABELS = {
    car_count: 'Cars', truck_count: 'Trucks', bus_count: 'Buses',
    motorcycle_count: 'Motorcycles', person_count: 'Pedestrians', bicycle_count: 'Cyclists',
  };
  const WINDOW_HOURS = { '1h': 1, '1d': 24, '1w': 168, '1m': 720, '6m': 4380, '1y': 8760, '5y': 43800 };

  let _stats = [];
  let _selectedId = null;
  let _timeWindow = '1d';
  let _playFrames = [];
  let _playIndex = 0;
  let _playTimer = null;
  let _onSelect = null;   // called when user picks camera from list → pan map

  // DOM refs (set in init)
  let panel, listView, detailView, listEl, searchEl;
  let detailName, detailImage, detailTimestamp, detailStatsEl;
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
    detailImage  = _el('cpDetailImage');
    detailTimestamp = _el('cpDetailTimestamp');
    detailStatsEl   = _el('cpDetailStats');
    playBtn      = _el('cpPlayBtn');
    stopBtn      = _el('cpStopBtn');
    playFill     = _el('cpPlayFill');

    searchEl.addEventListener('input', _renderList);
    _el('cpBackBtn').addEventListener('click', _back);
    _el('cpClose').addEventListener('click', hide);
    playBtn.addEventListener('click', _startPlay);
    stopBtn.addEventListener('click', _stopPlay);

    listEl.addEventListener('click', e => {
      const item = e.target.closest('[data-cam-id]');
      if (item) _selectFromList(Number(item.dataset.camId));
    });
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
    listView.style.display = 'none';
    detailView.style.display = 'flex';
    detailName.textContent = cam.address;
    detailImage.src = '';
    detailTimestamp.textContent = '';
    playFill.style.width = '0%';

    _updateDetailStats(cam);

    // Load latest image
    const snaps = await fetch(`/api/snapshots?camera_id=${cam.id}&limit=1`).then(r => r.json());
    if (snaps.length && snaps[0].image_path) {
      detailImage.src = '/data/' + snaps[0].image_path;
      detailTimestamp.textContent = _fmtTs(snaps[0].captured_at);
    }

    // Pre-load playback frames for this window
    _loadFrames(cam.id);
  }

  function _updateDetailStats(cam) {
    detailStatsEl.innerHTML = Object.entries(STAT_LABELS)
      .map(([k, l]) => `<span class="ds-label">${l}</span><span class="ds-val">${(cam[k] || 0).toLocaleString()}</span>`)
      .join('');
  }

  async function _loadFrames(cameraId) {
    const hours = WINDOW_HOURS[_timeWindow];
    let url = `/api/snapshots?camera_id=${cameraId}&limit=500`;
    if (hours) {
      const start = new Date(Date.now() - hours * 3600000).toISOString().slice(0, 19) + 'Z';
      url += `&start=${encodeURIComponent(start)}`;
    }
    const snaps = await fetch(url).then(r => r.json());
    _playFrames = snaps.filter(s => s.image_path).reverse(); // chronological
    _playIndex = _playFrames.length - 1;
  }

  function _startPlay() {
    if (_playTimer || !_playFrames.length) return;
    playBtn.style.display = 'none';
    stopBtn.style.display = '';
    _playIndex = 0;
    _playTimer = setInterval(() => {
      if (_playIndex >= _playFrames.length) { _stopPlay(); return; }
      const f = _playFrames[_playIndex++];
      detailImage.src = '/data/' + f.image_path;
      detailTimestamp.textContent = _fmtTs(f.captured_at);
      playFill.style.width = ((_playIndex / _playFrames.length) * 100) + '%';
    }, 250);
  }

  function _stopPlay() {
    if (_playTimer) { clearInterval(_playTimer); _playTimer = null; }
    playBtn.style.display = '';
    stopBtn.style.display = 'none';
  }

  function _back() {
    _stopPlay();
    _selectedId = null;
    detailView.style.display = 'none';
    listView.style.display = 'flex';
    _renderList();
  }

  function _fmtTs(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return ts; }
  }

  return { init, show, hide, toggle, setTimeWindow, updateStats, selectCamera };
})();
