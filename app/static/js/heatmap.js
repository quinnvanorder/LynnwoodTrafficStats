// leaflet.heat layer management — one layer per category, each with its own color

const CATEGORY_COLORS = {
  car_count:        { r: 239, g: 68,  b: 68  },  // red
  truck_count:      { r: 249, g: 115, b: 22  },  // orange
  bus_count:        { r: 234, g: 179, b: 8   },  // yellow
  motorcycle_count: { r: 168, g: 85,  b: 247 },  // purple
  person_count:     { r: 34,  g: 197, b: 94  },  // green
  bicycle_count:    { r: 59,  g: 130, b: 246 },  // blue
};

const HeatmapManager = (() => {
  let layers = {};  // category → L.heatLayer
  let currentStats = [];
  let enabledCategories = new Set(['car_count', 'truck_count']);

  function _gradient(color) {
    // leaflet.heat uses a gradient object: { 0.0: transparent → 1.0: color }
    const { r, g, b } = color;
    return {
      0.0: `rgba(${r},${g},${b},0)`,
      0.4: `rgba(${r},${g},${b},0.3)`,
      0.7: `rgba(${r},${g},${b},0.6)`,
      1.0: `rgba(${r},${g},${b},1)`,
    };
  }

  function _maxForCategory(cat) {
    const vals = currentStats.map(c => c[cat] || 0);
    return Math.max(...vals, 1);
  }

  function _buildPoints(cat) {
    const max = _maxForCategory(cat);
    return currentStats
      .filter(c => c.lat && c.lon && c[cat] > 0)
      .map(c => [c.lat, c.lon, c[cat] / max]);
  }

  function init(map) {
    for (const [cat, color] of Object.entries(CATEGORY_COLORS)) {
      layers[cat] = L.heatLayer([], {
        radius: 40,
        blur: 30,
        maxZoom: 17,
        gradient: _gradient(color),
      });
      if (enabledCategories.has(cat)) layers[cat].addTo(map);
    }
  }

  function updateData(stats) {
    currentStats = stats;
    _refresh();
  }

  function _refresh() {
    for (const [cat, layer] of Object.entries(layers)) {
      if (enabledCategories.has(cat)) {
        layer.setLatLngs(_buildPoints(cat));
      } else {
        layer.setLatLngs([]);
      }
    }
  }

  function setEnabled(cat, enabled) {
    if (enabled) {
      enabledCategories.add(cat);
    } else {
      enabledCategories.delete(cat);
    }
    _refresh();
  }

  function setStatsForFrame(frameStats) {
    // Used during animation — same as updateData but without persisting
    const saved = currentStats;
    currentStats = frameStats;
    _refresh();
    currentStats = saved;
  }

  function restoreCurrentStats() {
    _refresh();
  }

  return { init, updateData, setEnabled, setStatsForFrame, restoreCurrentStats };
})();
