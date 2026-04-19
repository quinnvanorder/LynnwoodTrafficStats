// Circle-based heatmap — one L.circle per camera per enabled category.
// Concentric radii distinguish categories; fillOpacity scales with count/max.

const CATEGORY_CONFIG = {
  car_count:        { color: '#ef4444', radius: 340 },
  truck_count:      { color: '#f97316', radius: 290 },
  bus_count:        { color: '#eab308', radius: 240 },
  motorcycle_count: { color: '#a855f7', radius: 190 },
  person_count:     { color: '#22c55e', radius: 140 },
  bicycle_count:    { color: '#3b82f6', radius: 90  },
};

const HeatmapManager = (() => {
  let _map = null;
  // circles[cat][cameraId] = L.circle
  const circles = Object.fromEntries(Object.keys(CATEGORY_CONFIG).map(k => [k, {}]));
  let currentStats = [];
  let enabledCategories = new Set(['car_count', 'truck_count']);

  function init(map) {
    _map = map;
  }

  function _maxFor(stats, cat) {
    return Math.max(...stats.map(c => c[cat] || 0), 1);
  }

  function _refresh(stats) {
    const incomingIds = new Set(stats.map(c => String(c.id)));

    for (const [cat, cfg] of Object.entries(CATEGORY_CONFIG)) {
      const enabled = enabledCategories.has(cat);
      const max = _maxFor(stats, cat);

      // Remove circles for cameras no longer in stats
      for (const id of Object.keys(circles[cat])) {
        if (!incomingIds.has(id)) { circles[cat][id].remove(); delete circles[cat][id]; }
      }

      for (const cam of stats) {
        if (!cam.lat || !cam.lon) continue;
        const id = String(cam.id);
        const count = cam[cat] || 0;

        if (!enabled || count === 0) {
          if (circles[cat][id]) { circles[cat][id].remove(); delete circles[cat][id]; }
          continue;
        }

        const fillOpacity = 0.15 + 0.5 * (count / max);

        if (circles[cat][id]) {
          circles[cat][id].setStyle({ fillOpacity });
        } else {
          circles[cat][id] = L.circle([cam.lat, cam.lon], {
            radius: cfg.radius,
            fillColor: cfg.color,
            fillOpacity,
            stroke: false,
            interactive: false,
          }).addTo(_map);
        }
      }
    }
  }

  function updateData(stats) {
    currentStats = stats;
    _refresh(stats);
  }

  function setEnabled(cat, enabled) {
    if (enabled) enabledCategories.add(cat);
    else enabledCategories.delete(cat);
    _refresh(currentStats);
  }

  function setStatsForFrame(frameStats) {
    _refresh(frameStats);
  }

  function restoreCurrentStats() {
    _refresh(currentStats);
  }

  return { init, updateData, setEnabled, setStatsForFrame, restoreCurrentStats };
})();
