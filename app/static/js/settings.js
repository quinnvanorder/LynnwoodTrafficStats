// Settings page logic

const SettingsManager = (() => {
  let _initialized = false;
  let _pollIntervalId = null;

  // Fields that live in the settings form (detection_model is handled by the dropdown separately)
  const FORM_FIELDS = [
    'snapshot_interval_seconds', 'image_retention_count',
    'static_export_interval_seconds', 'git_repo_url', 'git_remote_branch',
    'detection_confidence_threshold', 'detection_imgsz',
  ];

  async function load() {
    const cfg = await Data.loadSettings();
    const form = document.getElementById('settingsForm');
    for (const key of FORM_FIELDS) {
      const el = form.elements[key];
      if (el) el.value = cfg[key] ?? '';
    }
    // Sync model dropdown to current model in settings
    const modelSelect = document.getElementById('modelSelect');
    if (modelSelect && cfg.detection_model) {
      // Try to match exact value; if not found leave as-is
      if ([...modelSelect.options].some(o => o.value === cfg.detection_model)) {
        modelSelect.value = cfg.detection_model;
      }
    }
    // Resume backfill display if a job is in progress or recently finished
    _checkBackfillStatus();
  }

  async function _checkBackfillStatus() {
    try {
      const s = await fetch('/api/settings/backfill-status').then(r => r.json());
      const statusEl = document.getElementById('backfillStatus');
      if (!statusEl) return;
      if (s.running) {
        statusEl.style.display = '';
        statusEl.textContent = `Backfill: ${s.done} / ${s.total} snapshots reprocessed`;
        if (!_pollIntervalId) _startPoll(statusEl);
      } else if (s.total > 0) {
        statusEl.style.display = '';
        statusEl.textContent = `Last backfill: ${s.total} snapshots reprocessed`;
      }
    } catch { /* server may not have run a backfill yet */ }
  }

  function _startPoll(statusEl) {
    if (_pollIntervalId) clearInterval(_pollIntervalId);
    _pollIntervalId = setInterval(async () => {
      try {
        const s = await fetch('/api/settings/backfill-status').then(r => r.json());
        if (s.total > 0) {
          statusEl.textContent = `Backfill: ${s.done} / ${s.total} snapshots reprocessed`;
        }
        if (!s.running) {
          clearInterval(_pollIntervalId);
          _pollIntervalId = null;
          statusEl.textContent = `Backfill complete — ${s.total} snapshots reprocessed`;
          setTimeout(() => { if (statusEl.textContent.startsWith('Backfill complete')) statusEl.style.display = 'none'; }, 8000);
        }
      } catch {
        clearInterval(_pollIntervalId);
        _pollIntervalId = null;
      }
    }, 3000);
  }

  function init() {
    if (!_initialized) {
      _initialized = true;
      _attachListeners();
    }
    load();
  }

  function _attachListeners() {
    document.getElementById('settingsForm').addEventListener('submit', async e => {
      e.preventDefault();
      const form = e.target;
      const data = {};
      for (const key of FORM_FIELDS) {
        const el = form.elements[key];
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
        const display = document.getElementById('publicKeyDisplay');
        display.textContent = res.public_key;
        display.style.display = 'block';
        _toast('Key generated — copy the public key above');
      } catch (err) {
        _toast('Key generation failed: ' + err.message, true);
      } finally {
        btn.disabled = false; btn.textContent = 'Generate Deploy Key';
      }
    });

    document.getElementById('btnSwitchModel').addEventListener('click', async () => {
      const select = document.getElementById('modelSelect');
      const model = select.value;
      const statusEl = document.getElementById('backfillStatus');
      if (!confirm(`Switch to ${model}?\n\nThis will delete all annotated images and reprocess every snapshot with the new model. Counts in the DB will be updated. This runs in the background.`)) return;

      statusEl.textContent = 'Switching model and starting backfill…';
      statusEl.style.display = '';
      if (_pollIntervalId) { clearInterval(_pollIntervalId); _pollIntervalId = null; }

      try {
        await fetch('/api/settings/switch-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        _toast(`Switched to ${model} — backfill queued`);
        _startPoll(statusEl);
      } catch {
        _toast('Model switch failed', true);
        statusEl.style.display = 'none';
      }
    });

    document.getElementById('btnDiscoverNow').addEventListener('click', async () => {
      await Data.triggerDiscovery();
      _toast('Discovery triggered');
    });

    document.getElementById('btnExportNow').addEventListener('click', async () => {
      await Data.triggerExport();
      _toast('Export triggered');
    });

    document.getElementById('addCameraForm').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await Data.addCamera({
        url: fd.get('url'),
        address: fd.get('address'),
        lat: parseFloat(fd.get('lat')),
        lon: parseFloat(fd.get('lon')),
      });
      e.target.reset();
      _toast('Camera added');
      await renderCameraList();
    });

    load();
    renderCameraList();
  }

  async function renderCameraList() {
    const cameras = await Data.getCameras();
    const container = document.getElementById('cameraList');
    container.innerHTML = cameras.map(c => `
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
  }

  async function removeCamera(id) {
    await Data.deleteCamera(id);
    await renderCameraList();
  }

  async function toggleCamera(id, active) {
    await fetch(`/api/cameras/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
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
