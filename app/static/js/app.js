// Main app: wires everything together

(async () => {
  // ── View switching ──────────────────────────────────────────────────────────
  let currentView = 'map';
  const views = document.querySelectorAll('.view');
  const navBtns = document.querySelectorAll('.nav-btn');

  function showView(name) {
    currentView = name;
    views.forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    navBtns.forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'settings') SettingsManager.init();
  }

  navBtns.forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));

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
  }

  timeWindow.addEventListener('change', () => {
    currentWindow = timeWindow.value;
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
    // On new snapshot event, refresh stats if not animating
    if (!AnimationManager.isPlaying()) refreshStats();
  });

  // ── CSV link: hide in static build ─────────────────────────────────────────
  Data.isStatic().then(isStatic => {
    const csvLink = document.getElementById('csvLink');
    if (isStatic) {
      csvLink.href = '/data/snapshots_raw.csv';
      csvLink.download = 'lynnwood_traffic.csv';
    }
  });

  // ── Initial load ─────────────────────────────────────────────────────────────
  await refreshStats();
})();
