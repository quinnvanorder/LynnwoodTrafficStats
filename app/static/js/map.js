// Leaflet map — camera markers show count bubbles for the selected category

const LYNNWOOD_CENTER = [47.8209, -122.3151];

const MapManager = (() => {
  let map, statsData = [], markers = {};
  let _selectedCat = 'car_count';
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
  function getStats() { return statsData; }

  function setCategory(cat) {
    _selectedCat = cat;
    for (const [id, m] of Object.entries(markers)) {
      const cam = statsData.find(c => String(c.id) === id);
      if (cam) m.setIcon(_bubbleIcon(cam[_selectedCat] || 0));
    }
  }

  function _fmt(n) {
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    if (n >= 1000)  return (n / 1000).toFixed(1).replace('.0', '') + 'k';
    return String(n);
  }

  function _bubbleIcon(count) {
    return L.divIcon({
      className: '',
      html: `<div class="cam-count-bubble">${_fmt(count)}</div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    });
  }

  function updatePins(stats) {
    statsData = stats;
    const incoming = new Set(stats.map(c => c.id));

    for (const [id, m] of Object.entries(markers)) {
      if (!incoming.has(Number(id))) { m.remove(); delete markers[id]; }
    }

    for (const cam of stats) {
      if (!cam.lat || !cam.lon) continue;
      const count = cam[_selectedCat] || 0;
      if (markers[cam.id]) {
        markers[cam.id].setIcon(_bubbleIcon(count));
        markers[cam.id]._camData = cam;
      } else {
        const m = L.marker([cam.lat, cam.lon], { icon: _bubbleIcon(count) }).addTo(map);
        m._camData = cam;
        m.on('click', () => { if (_onCameraClick) _onCameraClick(m._camData); });
        markers[cam.id] = m;
      }
    }
  }

  function highlightCamera(cam) {
    if (!cam.lat || !cam.lon) return;
    map.setView([cam.lat, cam.lon], Math.max(map.getZoom(), 15), { animate: true });
  }

  return { init, getMap, getStats, onCameraClick, updatePins, setCategory, highlightCamera };
})();
