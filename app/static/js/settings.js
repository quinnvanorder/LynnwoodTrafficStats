// Settings page logic

const SettingsManager = (() => {
  let _initialized = false;
  let _pollIntervalId = null;
  let _modelStatusPollId = null;

  // Fields managed by the settings form (detection_model is owned by the model switcher)
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
    // Sync model dropdown to current configured model
    const modelSelect = document.getElementById('modelSelect');
    if (modelSelect && cfg.detection_model) {
      if ([...modelSelect.options].some(o => o.value === cfg.detection_model)) {
        modelSelect.value = cfg.detection_model;
      }
    }
    _refreshModelStatus();
    _checkBackfillStatus();
  }

  // ── Model status ────────────────────────────────────────────────────────────

  async function _refreshModelStatus() {
    try {
      const status = await fetch('/api/settings/model-status').then(r => r.json());
      _applyModelStatus(status);
    } catch { /* server may be starting up */ }
  }

  function _applyModelStatus(status) {
    const modelSelect = document.getElementById('modelSelect');
    const dlBtn   = document.getElementById('btnDownloadModel');
    const swBtn   = document.getElementById('btnSwitchModel');
    const dlStatus = document.getElementById('modelDownloadStatus');
    if (!modelSelect) return;

    // Update option text to show availability
    for (const opt of modelSelect.options) {
      const s = status[opt.value];
      if (!s) continue;
      const base = opt.dataset.label || (opt.dataset.label = opt.text.replace(/ [✓⬇⟳].*$/, '').trim());
      if (s.downloading) {
        opt.text = `${base} ⟳ downloading…`;
      } else if (s.available) {
        opt.text = `${base} ✓`;
      } else {
        opt.text = `${base} (not downloaded)`;
      }
    }

    // Update buttons based on currently selected model
    _updateModelButtons(status);

    // If any model is downloading, keep polling
    const anyDownloading = Object.values(status).some(s => s.downloading);
    if (anyDownloading && !_modelStatusPollId) {
      _modelStatusPollId = setInterval(async () => {
        try {
          const s = await fetch('/api/settings/model-status').then(r => r.json());
          _applyModelStatus(s);
          if (!Object.values(s).some(x => x.downloading)) {
            clearInterval(_modelStatusPollId);
            _modelStatusPollId = null;
          }
        } catch { clearInterval(_modelStatusPollId); _modelStatusPollId = null; }
      }, 2000);
    }
  }

  function _updateModelButtons(status) {
    const modelSelect  = document.getElementById('modelSelect');
    const dlBtn        = document.getElementById('btnDownloadModel');
    const swBtn        = document.getElementById('btnSwitchModel');
    const dlStatus     = document.getElementById('modelDownloadStatus');
    if (!modelSelect || !dlBtn || !swBtn) return;

    const selected = modelSelect.value;
    const s = status ? status[selected] : null;
    const available    = s?.available   ?? false;
    const downloading  = s?.downloading ?? false;
    const error        = s?.error;

    dlBtn.style.display = available ? 'none' : '';
    swBtn.disabled = !available;
    swBtn.title = available ? '' : 'Download the model first';

    if (downloading) {
      dlBtn.disabled = true;
      dlBtn.textContent = '⟳ Downloading…';
    } else {
      dlBtn.disabled = false;
      dlBtn.textContent = '⬇ Download';
    }

    if (dlStatus) {
      if (error) {
        dlStatus.textContent = `Download failed: ${error}`;
        dlStatus.style.display = '';
      } else if (!available && !downloading) {
        dlStatus.textContent = 'This model is not downloaded yet.';
        dlStatus.style.display = '';
      } else {
        dlStatus.style.display = 'none';
      }
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
        statusEl.textContent = `Backfill: ${s.done} / ${s.total} snapshots reprocessed`;
        if (!_pollIntervalId) _startBackfillPoll(statusEl);
      } else if (s.total > 0) {
        statusEl.style.display = '';
        statusEl.textContent = `Last backfill: ${s.total} snapshots reprocessed`;
      }
    } catch { /* ok */ }
  }

  function _startBackfillPoll(statusEl) {
    if (_pollIntervalId) clearInterval(_pollIntervalId);
    _pollIntervalId = setInterval(async () => {
      try {
        const s = await fetch('/api/settings/backfill-status').then(r => r.json());
        if (s.error) {
          statusEl.textContent = `Backfill error: ${s.error}`;
          clearInterval(_pollIntervalId); _pollIntervalId = null;
        } else if (s.total > 0) {
          statusEl.textContent = `Backfill: ${s.done} / ${s.total} snapshots reprocessed`;
        }
        if (!s.running) {
          clearInterval(_pollIntervalId); _pollIntervalId = null;
          if (!s.error) {
            statusEl.textContent = `Backfill complete — ${s.total} snapshots reprocessed`;
            setTimeout(() => { statusEl.style.display = 'none'; }, 8000);
          }
        }
      } catch { clearInterval(_pollIntervalId); _pollIntervalId = null; }
    }, 3000);
  }

  // ── Init / listeners ────────────────────────────────────────────────────────

  function init() {
    if (!_initialized) { _initialized = true; _attachListeners(); }
    load();
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

    // Model selection changed — refresh button states
    document.getElementById('modelSelect').addEventListener('change', async () => {
      try {
        const status = await fetch('/api/settings/model-status').then(r => r.json());
        _updateModelButtons(status);
      } catch { _updateModelButtons(null); }
    });

    // Download selected model
    document.getElementById('btnDownloadModel').addEventListener('click', async () => {
      const model = document.getElementById('modelSelect').value;
      const dlBtn = document.getElementById('btnDownloadModel');
      dlBtn.disabled = true; dlBtn.textContent = '⟳ Starting…';
      try {
        await fetch('/api/settings/download-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        _toast(`Download started for ${model}`);
        // Start polling model status
        if (!_modelStatusPollId) {
          _modelStatusPollId = setInterval(async () => {
            try {
              const s = await fetch('/api/settings/model-status').then(r => r.json());
              _applyModelStatus(s);
              if (!Object.values(s).some(x => x.downloading)) {
                clearInterval(_modelStatusPollId); _modelStatusPollId = null;
              }
            } catch { clearInterval(_modelStatusPollId); _modelStatusPollId = null; }
          }, 2000);
        }
      } catch {
        _toast('Download request failed', true);
        dlBtn.disabled = false; dlBtn.textContent = '⬇ Download';
      }
    });

    // Switch model (only enabled when model is available)
    document.getElementById('btnSwitchModel').addEventListener('click', async () => {
      const model = document.getElementById('modelSelect').value;
      const statusEl = document.getElementById('backfillStatus');
      if (!confirm(`Switch to ${model}?\n\nThis deletes all annotated images and reprocesses every snapshot in the background.`)) return;

      statusEl.textContent = 'Switching model and starting backfill…';
      statusEl.style.display = '';
      if (_pollIntervalId) { clearInterval(_pollIntervalId); _pollIntervalId = null; }

      try {
        const res = await fetch('/api/settings/switch-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || 'Unknown error');
        }
        _toast(`Switched to ${model} — backfill queued`);
        _startBackfillPoll(statusEl);
      } catch (e) {
        _toast(`Model switch failed: ${e.message}`, true);
        statusEl.style.display = 'none';
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

    load();
    renderCameraList();
  }

  async function renderCameraList() {
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
