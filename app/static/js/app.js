// Main app: wires everything together

(async () => {
  // ── View switching ──────────────────────────────────────────────────────────
  const views = document.querySelectorAll('.view');
  const navBtns = document.querySelectorAll('.nav-btn[data-view]');

  function showView(name) {
    views.forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    navBtns.forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'settings') SettingsManager.init();
    if (name !== 'map') CameraPanel.hide();
  }

  navBtns.forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));

  // ── Cameras panel toggle ────────────────────────────────────────────────────
  const btnCameras = document.getElementById('btnCameras');
  btnCameras.addEventListener('click', () => {
    showView('map');
    const open = CameraPanel.toggle();
    btnCameras.classList.toggle('active', open);
    MapManager.getMap().invalidateSize();
  });

  // ── Camera panel init ───────────────────────────────────────────────────────
  CameraPanel.init(cam => {
    MapManager.highlightCamera(cam);
  });
  Data.isStatic().then(s => CameraPanel.setStaticMode(s));

  // ── Map click → open camera panel detail ────────────────────────────────────
  MapManager.onCameraClick(cam => {
    CameraPanel.selectCamera(cam);
    btnCameras.classList.add('active');
    MapManager.getMap().invalidateSize();
  });

  // ── Map init ────────────────────────────────────────────────────────────────
  const leafletMap = MapManager.init();
  HeatmapManager.init(leafletMap);

  // ── Time window ─────────────────────────────────────────────────────────────
  const timeWindow = document.getElementById('timeWindow');
  let currentWindow = timeWindow.value;

  async function refreshStats() {
    const stats = await Data.getStats(currentWindow);
    MapManager.updatePins(stats);
    HeatmapManager.updateData(stats);
    CameraPanel.updateStats(stats);
  }

  timeWindow.addEventListener('change', () => {
    currentWindow = timeWindow.value;
    CameraPanel.setTimeWindow(currentWindow);
    refreshStats();
  });

  // ── Layer checkboxes ────────────────────────────────────────────────────────
  document.querySelectorAll('.layer-item').forEach(item => {
    const cb = item.querySelector('input[type=checkbox]');
    const cat = item.dataset.category;
    cb.addEventListener('change', () => HeatmapManager.setEnabled(cat, cb.checked));
  });

  // ── Animation ───────────────────────────────────────────────────────────────
  const btnPlay = document.getElementById('btnPlay');
  const btnStop = document.getElementById('btnStop');
  const animDuration = document.getElementById('animDuration');
  const animDurationLabel = document.getElementById('animDurationLabel');
  const animProgress = document.getElementById('animProgress');
  const progressFill = document.getElementById('progressFill');
  const animTimestamp = document.getElementById('animTimestamp');

  animDuration.addEventListener('input', () => {
    animDurationLabel.textContent = animDuration.value + 's';
  });

  btnPlay.addEventListener('click', async () => {
    const dur = parseInt(animDuration.value, 10);
    const count = await AnimationManager.load(currentWindow, dur);
    if (count === 0) { alert('No data for selected time window'); return; }
    btnPlay.style.display = 'none';
    btnStop.style.display = '';
    animProgress.style.display = 'flex';
    const allCameras = MapManager.getStats();
    AnimationManager.play(
      allCameras,
      ({ stats, progress, timestamp }) => {
        HeatmapManager.setStatsForFrame(stats);
        progressFill.style.width = (progress * 100) + '%';
        animTimestamp.textContent = timestamp;
      },
      () => {
        HeatmapManager.restoreCurrentStats();
        btnPlay.style.display = '';
        btnStop.style.display = 'none';
        animProgress.style.display = 'none';
        progressFill.style.width = '0%';
      }
    );
  });

  btnStop.addEventListener('click', () => {
    AnimationManager.stop();
    HeatmapManager.restoreCurrentStats();
    btnPlay.style.display = '';
    btnStop.style.display = 'none';
    animProgress.style.display = 'none';
    progressFill.style.width = '0%';
  });

  // ── Realtime ────────────────────────────────────────────────────────────────
  RealtimeManager.init(() => {
    if (!AnimationManager.isPlaying()) refreshStats();
  });

  // ── CSV link ─────────────────────────────────────────────────────────────────
  Data.isStatic().then(isStatic => {
    const csvLink = document.getElementById('csvLink');
    if (isStatic) {
      csvLink.href = '/data/snapshots_raw.csv';
      csvLink.download = 'lynnwood_traffic.csv';
    }
  });

  // ── Initial load ─────────────────────────────────────────────────────────────
  CameraPanel.setTimeWindow(currentWindow);
  await refreshStats();
})();
