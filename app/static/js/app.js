// Main app: wires everything together

(async () => {
  // ── View switching ──────────────────────────────────────────────────────────
  const views = document.querySelectorAll('.view');
  const navBtns = document.querySelectorAll('.nav-btn[data-view]');

  function showView(name) {
    views.forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    navBtns.forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'settings') SettingsManager.init();
  }

  navBtns.forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));

  // ── Map init ────────────────────────────────────────────────────────────────
  const leafletMap = MapManager.init();

  // ── Time window ─────────────────────────────────────────────────────────────
  const timeWindow = document.getElementById('timeWindow');
  let currentWindow = timeWindow.value;

  async function refreshStats() {
    const stats = await Data.getStats(currentWindow);
    MapManager.updatePins(stats);
    SidebarCameras.updateStats(stats);
  }

  timeWindow.addEventListener('change', () => {
    currentWindow = timeWindow.value;
    SidebarCameras.setTimeWindow(currentWindow);
    refreshStats();
  });

  // ── Layer radio buttons ─────────────────────────────────────────────────────
  document.querySelectorAll('.layer-item input[type=radio]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) MapManager.setCategory(radio.value);
    });
  });

  // Set initial category from whichever radio is checked
  const checkedRadio = document.querySelector('.layer-item input[type=radio]:checked');
  if (checkedRadio) MapManager.setCategory(checkedRadio.value);

  // ── Sidebar cameras ─────────────────────────────────────────────────────────
  SidebarCameras.init(cam => MapManager.highlightCamera(cam));
  Data.isStatic().then(s => SidebarCameras.setStaticMode(s));
  SidebarCameras.setTimeWindow(currentWindow);

  // ── Map pin click → expand that camera in sidebar ───────────────────────────
  MapManager.onCameraClick(cam => {
    // scroll sidebar camera list to that item and expand it
    const item = document.querySelector(`.scam-item[data-cam-id="${cam.id}"] .scam-header`);
    if (item) {
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      item.click();
    }
  });

  // ── Collapsible sidebar camera section ─────────────────────────────────────
  const scamToggle = document.getElementById('scamToggle');
  const scamBody   = document.getElementById('scamBody');
  scamToggle.addEventListener('click', () => {
    const isOpen = scamBody.style.display !== 'none';
    scamBody.style.display = isOpen ? 'none' : 'flex';
    scamToggle.textContent = isOpen ? '▼ Cameras' : '▲ Cameras';
  });
  // Start expanded
  scamBody.style.display = 'flex';
  scamToggle.textContent = '▲ Cameras';

  // ── Realtime ────────────────────────────────────────────────────────────────
  RealtimeManager.init(() => refreshStats());

  // ── CSV link ─────────────────────────────────────────────────────────────────
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
