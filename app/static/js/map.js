// Leaflet map initialization and camera pin management

const LYNNWOOD_CENTER = [47.8209, -122.3151];

const MapManager = (() => {
  let map, statsData = [], markers = {};
  let _onCameraClick = null;

  function init() {
    map = L.map('map', { center: LYNNWOOD_CENTER, zoom: 13, zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    return map;
  }

  function onCameraClick(cb) { _onCameraClick = cb; }

  function getMap() { return map; }

  function _popupHtml(cam) {
    const LABELS = {
      car_count: 'Cars', truck_count: 'Trucks', bus_count: 'Buses',
      motorcycle_count: 'Motorcycles', person_count: 'Pedestrians', bicycle_count: 'Cyclists',
    };
    const rows = Object.entries(LABELS)
      .map(([k, label]) => `
        <span class="popup-stat-label">${label}</span>
        <span class="popup-stat-value">${(cam[k] ?? 0).toLocaleString()}</span>
      `).join('');
    return `<div class="camera-popup">
      <h4>${cam.address}</h4>
      <div class="popup-stats">${rows}</div>
      <div class="popup-snapshot-count">${(cam.snapshot_count ?? 0).toLocaleString()} snapshots</div>
    </div>`;
  }

  function updatePins(stats) {
    statsData = stats;
    const incoming = new Set(stats.map(c => c.id));
    for (const [id, m] of Object.entries(markers)) {
      if (!incoming.has(Number(id))) { m.remove(); delete markers[id]; }
    }
    for (const cam of stats) {
      if (!cam.lat || !cam.lon) continue;
      if (markers[cam.id]) {
        markers[cam.id].setPopupContent(_popupHtml(cam));
        markers[cam.id]._camData = cam;
      } else {
        const icon = L.divIcon({
          className: '',
          html: `<div style="width:12px;height:12px;border-radius:50%;background:#3b82f6;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.5)"></div>`,
          iconSize: [12, 12], iconAnchor: [6, 6],
        });
        const m = L.marker([cam.lat, cam.lon], { icon })
          .bindPopup(_popupHtml(cam), { maxWidth: 260 })
          .addTo(map);
        m._camData = cam;
        m.on('click', () => { if (_onCameraClick) _onCameraClick(m._camData); });
        markers[cam.id] = m;
      }
    }
  }

  function highlightCamera(cam) {
    const m = markers[cam.id];
    if (!m) return;
    map.setView([cam.lat, cam.lon], Math.max(map.getZoom(), 15), { animate: true });
    m.openPopup();
  }

  function getStats() { return statsData; }

  return { init, getMap, onCameraClick, updatePins, highlightCamera, getStats };
})();
