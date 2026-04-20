// Settings page logic

const SettingsManager = (() => {
  let _initialized = false;
  let _pollIntervalId = null;
  let _modelPollId = null;

  const FORM_FIELDS = [
    'snapshot_interval_seconds', 'image_retention_count',
    'static_export_interval_seconds', 'git_repo_url', 'git_remote_branch',
    'detection_confidence_threshold', 'detection_imgsz',
  ];

  // ── Model metadata ──────────────────────────────────────────────────────────

  const MODEL_META = {
    'yolov8n.pt':  { label: 'YOLOv8 Nano',     type: 'YOLOv8'  },
    'yolov8s.pt':  { label: 'YOLOv8 Small',    type: 'YOLOv8'  },
    'yolov8m.pt':  { label: 'YOLOv8 Medium',   type: 'YOLOv8'  },
    'yolov8l.pt':  { label: 'YOLOv8 Large',    type: 'YOLOv8'  },
    'yolo11n.pt':  { label: 'YOLO11 Nano',     type: 'YOLO11'  },
    'yolo11s.pt':  { label: 'YOLO11 Small',    type: 'YOLO11'  },
    'yolo11m.pt':  { label: 'YOLO11 Medium',   type: 'YOLO11'  },
    'yolo11l.pt':  { label: 'YOLO11 Large',    type: 'YOLO11'  },
    'rtdetr-l.pt': { label: 'RT-DETR Large',   type: 'RT-DETR' },
    'rtdetr-x.pt': { label: 'RT-DETR X-Large', type: 'RT-DETR' },
  };

  // ── Settings form ───────────────────────────────────────────────────────────

  async function _loadForm() {
    try {
      const cfg = await Data.loadSettings();
      const form = document.getElementById('settingsForm');
      for (const key of FORM_FIELDS) {
        const el = form.elements[key];
        if (el) el.value = cfg[key] ?? '';
      }
    } catch (e) {
      console.error('Settings: failed to load form values', e);
    }
  }

  // ── Model table ─────────────────────────────────────────────────────────────

  function _renderModelPlaceholder() {
    const tbody = document.getElementById('modelTableBody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="6" class="model-loading-cell">Loading models…</td></tr>`;
  }

  async function _refreshModelTable() {
    const wrap = document.getElementById('modelTableWrap');
    try {
      const r = await fetch('/api/settings/model-configs');
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status} — ${text.slice(0, 300)}`);
      }
      const configs = await r.json();
      if (!Array.isArray(configs)) {
        throw new Error('Server returned unexpected data: ' + JSON.stringify(configs).slice(0, 200));
      }
      _renderModelTable(configs);

      const anyDownloading = configs.some(c => c.downloading);
      if (anyDownloading && !_modelPollId) {
        _modelPollId = setInterval(async () => {
          try {
            const r2 = await fetch('/api/settings/model-configs');
            const c2 = await r2.json();
            if (Array.isArray(c2)) _renderModelTable(c2);
            if (!Array.isArray(c2) || !c2.some(c => c.downloading)) {
              clearInterval(_modelPollId); _modelPollId = null;
            }
          } catch { clearInterval(_modelPollId); _modelPollId = null; }
        }, 2000);
      }
    } catch (err) {
      console.error('Settings: failed to load model configs:', err);
      if (wrap) {
        wrap.innerHTML = `<p class="hint" style="color:#f87171;padding:8px 0">
          ⚠ Could not load model list: ${err.message}<br>
          Check the browser console (F12) and server logs for details.
        </p>`;
      }
    }
  }

  function _renderModelTable(configs) {
    const tbody = document.getElementById('modelTableBody');
    if (!tbody) {
      console.error('Settings: #modelTableBody not found in DOM');
      return;
    }

    tbody.innerHTML = configs.map(c => {
      const meta = MODEL_META[c.model_name] || { label: c.model_name, type: '?' };
      const isDefault  = !!c.is_default;
      const isActive   = !!c.is_active;
      const available  = !!c.available;
      const downloading = !!c.downloading;

      const statusClass = downloading ? 'downloading' : available ? 'ok' : '';
      const statusText  = downloading ? '⟳ downloading…'
                        : available   ? '✓ ready'
                        : c.error     ? '✗ ' + c.error
                        : '— not downloaded';
      const avgText = c.avg_processing_ms != null
        ? c.avg_processing_ms >= 1000
          ? (c.avg_processing_ms / 1000).toFixed(1) + ' s'
          : c.avg_processing_ms + ' ms'
        : '—';

      return `<tr data-model="${c.model_name}">
        <td><input type="checkbox" class="model-active-cb" data-model="${c.model_name}"
          ${isActive ? 'checked' : ''}
          ${isDefault ? 'disabled title="Default model is always active"' : ''}
          ${!available && !isActive ? 'disabled title="Download this model first"' : ''}
        /></td>
        <td><input type="radio" name="modelDefault" class="model-default-rb"
          data-model="${c.model_name}"
          ${isDefault ? 'checked' : ''}
          ${!available ? 'disabled title="Download this model first"' : ''}
        /></td>
        <td class="model-name-cell">${meta.label}</td>
        <td><span class="model-type-badge">${meta.type}</span></td>
        <td class="model-status-cell ${statusClass}">${statusText}</td>
        <td class="model-status-cell">${avgText}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.model-active-cb').forEach(cb =>
      cb.addEventListener('change', _onActiveChange));
    tbody.querySelectorAll('.model-default-rb').forEach(rb =>
      rb.addEventListener('change', _onDefaultChange));
  }

  async function _onActiveChange(e) {
    const model = e.target.dataset.model;
    const active = e.target.checked;
    try {
      const res = await fetch(`/api/settings/model-configs/${model}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: active }),
      });
      if (!res.ok) {
        const err = await res.json();
        _toast(`Error: ${err.detail || 'Unknown error'}`, true);
        e.target.checked = !active;
        return;
      }
      _toast(active ? `${model} activated — backfilling…` : `${model} deactivated`);
      if (active) _startBackfillPoll(document.getElementById('backfillStatus'));
    } catch {
      _toast('Request failed', true);
      e.target.checked = !active;
    }
  }

  async function _onDefaultChange(e) {
    const model = e.target.dataset.model;
    try {
      const res = await fetch(`/api/settings/model-configs/${model}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_default: true }),
      });
      if (!res.ok) {
        const err = await res.json();
        _toast(`Error: ${err.detail || 'Unknown error'}`, true);
        _refreshModelTable();
        return;
      }
      _toast(`Default model set to ${model}`);
      _refreshModelTable();
      _startBackfillPoll(document.getElementById('backfillStatus'));
    } catch {
      _toast('Request failed', true);
      _refreshModelTable();
    }
  }

  // ── Backfill status ─────────────────────────────────────────────────────────

  async function _checkBackfillStatus() {
    try {
      const s = await fetch('/api/settings/backfill-status').then(r => r.json());
      const statusEl = document.getElementById('backfillStatus');
      if (!statusEl) return;
      if (s.error) {
        statusEl.style.display = '';
        statusEl.textContent = `Backfill error: ${s.error}`;
      } else if (s.running) {
        statusEl.style.display = '';
        statusEl.textContent = _backfillText(s);
        if (!_pollIntervalId) _startBackfillPoll(statusEl);
      } else if (s.total > 0) {
        statusEl.style.display = '';
        statusEl.textContent = `Last backfill: ${s.total} snapshots reprocessed`;
      }
    } catch { /* ok */ }
  }

  function _backfillText(s) {
    const parts = Object.entries(s.per_model || {})
      .filter(([, v]) => v.running)
      .map(([m, v]) => `${m}: ${v.done}/${v.total}`);
    return parts.length
      ? `Backfill: ${parts.join(' · ')}`
      : `Backfill: ${s.done} / ${s.total} snapshots`;
  }

  function _startBackfillPoll(statusEl) {
    if (_pollIntervalId) clearInterval(_pollIntervalId);
    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Backfill queued…'; }
    _pollIntervalId = setInterval(async () => {
      try {
        const s = await fetch('/api/settings/backfill-status').then(r => r.json());
        if (s.error) {
          if (statusEl) statusEl.textContent = `Backfill error: ${s.error}`;
          clearInterval(_pollIntervalId); _pollIntervalId = null;
        } else if (s.total > 0 && statusEl) {
          statusEl.textContent = _backfillText(s);
        }
        if (!s.running) {
          clearInterval(_pollIntervalId); _pollIntervalId = null;
          if (!s.error && statusEl) {
            statusEl.textContent = `Backfill complete — ${s.total} snapshots reprocessed`;
            setTimeout(() => { statusEl.style.display = 'none'; }, 8000);
          }
        }
      } catch { clearInterval(_pollIntervalId); _pollIntervalId = null; }
    }, 3000);
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  function init() {
    // Show placeholder rows immediately so the table is never blank
    _renderModelPlaceholder();
    // Kick off model fetch right away — don't wait for the settings form fetch
    _refreshModelTable();
    _checkBackfillStatus();
    // Attach listeners and load form values (only once)
    if (!_initialized) {
      _initialized = true;
      _attachListeners();
    }
    _loadForm();
    renderCameraList();
  }

  function _attachListeners() {
    document.getElementById('settingsForm').addEventListener('submit', async e => {
      e.preventDefault();
      const data = {};
      for (const key of FORM_FIELDS) {
        const el = e.target.elements[key];
        if (el) data[key] = el.type === 'number' ? Number(el.value) : el.value;
      }
      await Data.saveSettings(data);
      _toast('Settings saved');
    });

    document.getElementById('btnGenerateKey').addEventListener('click', async () => {
      const btn = document.getElementById('btnGenerateKey');
      btn.disabled = true; btn.textContent = 'Generating…';
      try {
        const res = await Data.generateDeployKey();
        document.getElementById('publicKeyDisplay').textContent = res.public_key;
        document.getElementById('publicKeyDisplay').style.display = 'block';
        _toast('Key generated — copy the public key above');
      } catch (err) {
        _toast('Key generation failed: ' + err.message, true);
      } finally {
        btn.disabled = false; btn.textContent = 'Generate Deploy Key';
      }
    });

    document.getElementById('btnDiscoverNow').addEventListener('click', async () => {
      await Data.triggerDiscovery(); _toast('Discovery triggered');
    });

    document.getElementById('btnExportNow').addEventListener('click', async () => {
      await Data.triggerExport(); _toast('Export triggered');
    });

    document.getElementById('addCameraForm').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await Data.addCamera({
        url: fd.get('url'), address: fd.get('address'),
        lat: parseFloat(fd.get('lat')), lon: parseFloat(fd.get('lon')),
      });
      e.target.reset();
      _toast('Camera added');
      await renderCameraList();
    });
  }

  async function renderCameraList() {
    try {
      const cameras = await Data.getCameras();
      document.getElementById('cameraList').innerHTML = cameras.map(c => `
        <div class="camera-item">
          <div class="camera-item-info">
            <div class="camera-item-name">${c.address}</div>
            <div class="camera-item-url">${c.url}</div>
          </div>
          <span class="camera-item-badge ${c.is_custom ? 'custom' : ''}">${c.is_custom ? 'Custom' : 'Auto'}</span>
          ${c.is_custom
            ? `<button class="btn-secondary" onclick="SettingsManager.removeCamera(${c.id})">Remove</button>`
            : `<button class="btn-secondary" onclick="SettingsManager.toggleCamera(${c.id}, ${c.active ? 0 : 1})">${c.active ? 'Disable' : 'Enable'}</button>`
          }
        </div>
      `).join('');
    } catch (e) {
      console.error('Settings: failed to load camera list', e);
    }
  }

  async function removeCamera(id) { await Data.deleteCamera(id); await renderCameraList(); }
  async function toggleCamera(id, active) {
    await fetch(`/api/cameras/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !!active }),
    });
    await renderCameraList();
  }

  function _toast(msg, isError = false) {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed', bottom: '24px', right: '24px',
      background: isError ? '#7f1d1d' : '#14532d',
      color: '#fff', padding: '10px 18px', borderRadius: '8px',
      fontSize: '13px', zIndex: 9999, boxShadow: '0 4px 12px rgba(0,0,0,.4)',
      transition: 'opacity .3s',
    });
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
  }

  return { init, renderCameraList, removeCamera, toggleCamera };
})();
