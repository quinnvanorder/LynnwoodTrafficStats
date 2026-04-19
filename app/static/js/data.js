// Abstraction layer: LAN uses live API; static build uses bundled JSON files.

const IS_STATIC = document.cookie.includes('static') || (() => {
  try {
    return window.__STATIC_BUILD__ === true;
  } catch { return false; }
})();

async function _checkStatic() {
  try {
    const r = await fetch('/static-build.json', { method: 'HEAD' });
    return r.ok;
  } catch { return false; }
}

const Data = (() => {
  let _static = null;

  async function isStatic() {
    if (_static === null) _static = await _checkStatic();
    return _static;
  }

  async function getCameras() {
    if (await isStatic()) {
      const r = await fetch('/data/cameras.json');
      return r.json();
    }
    const r = await fetch('/api/cameras');
    return r.json();
  }

  async function getStats(window = '1d') {
    if (await isStatic()) {
      // For static build, aggregate from bundled hourly data
      const [cams, hourly] = await Promise.all([
        fetch('/data/cameras.json').then(r => r.json()),
        fetch('/data/snapshots_aggregated.json').then(r => r.json()),
      ]);
      // Simple aggregation: sum all hours (no time filtering in static build)
      const byCamera = {};
      for (const row of hourly) {
        if (!byCamera[row.camera_id]) {
          const cam = cams.find(c => c.id === row.camera_id) || {};
          byCamera[row.camera_id] = {
            id: row.camera_id, address: cam.address, lat: cam.lat, lon: cam.lon, url: cam.url,
            person_count: 0, bicycle_count: 0, motorcycle_count: 0,
            car_count: 0, bus_count: 0, truck_count: 0, total_count: 0, snapshot_count: 0,
          };
        }
        const b = byCamera[row.camera_id];
        b.person_count += row.person_count;
        b.bicycle_count += row.bicycle_count;
        b.motorcycle_count += row.motorcycle_count;
        b.car_count += row.car_count;
        b.bus_count += row.bus_count;
        b.truck_count += row.truck_count;
        b.total_count += row.total_count;
        b.snapshot_count++;
      }
      return Object.values(byCamera);
    }
    const r = await fetch(`/api/stats?window=${window}`);
    return r.json();
  }

  async function getAnimationFrames(window = '1d', nFrames = 720) {
    if (await isStatic()) {
      const [cams, hourly] = await Promise.all([
        fetch('/data/cameras.json').then(r => r.json()),
        fetch('/data/snapshots_aggregated.json').then(r => r.json()),
      ]);
      // Group by hour, return as frames
      const hours = [...new Set(hourly.map(r => r.hour))].sort();
      const total = hours.length;
      if (total === 0) return [];

      // Sample nFrames hours evenly
      const sampled = total <= nFrames
        ? hours
        : Array.from({ length: nFrames }, (_, i) => hours[Math.floor(i * total / nFrames)]);

      return sampled.map(hour => {
        const rows = hourly.filter(r => r.hour === hour);
        return { hour, cameras: rows };
      });
    }
    const r = await fetch(`/api/snapshots/animation?window=${window}&n_frames=${nFrames}`);
    const snaps = await r.json();
    // Group by captured_at bucket
    return snaps;
  }

  async function saveSettings(data) {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json();
  }

  async function loadSettings() {
    const r = await fetch('/api/settings');
    return r.json();
  }

  async function generateDeployKey() {
    const r = await fetch('/api/settings/generate-key', { method: 'POST' });
    return r.json();
  }

  async function triggerDiscovery() {
    return fetch('/api/cameras/discover', { method: 'POST' });
  }

  async function triggerExport() {
    return fetch('/api/export/static', { method: 'POST' });
  }

  async function addCamera(data) {
    const r = await fetch('/api/cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json();
  }

  async function deleteCamera(id) {
    return fetch(`/api/cameras/${id}`, { method: 'DELETE' });
  }

  return {
    isStatic, getCameras, getStats, getAnimationFrames,
    saveSettings, loadSettings, generateDeployKey,
    triggerDiscovery, triggerExport, addCamera, deleteCamera,
  };
})();
