// Settings page logic

const SettingsManager = (() => {
  let _initialized = false;

  async function load() {
    const cfg = await Data.loadSettings();
    const form = document.getElementById('settingsForm');
    for (const [key, val] of Object.entries(cfg)) {
      const el = form.elements[key];
      if (el) el.value = val;
    }
  }

  function init() {
    if (_initialized) { load(); return; }
    _initialized = true;

    document.getElementById('settingsForm').addEventListener('submit', async e => {
      e.preventDefault();
      const form = e.target;
      const data = {};
      for (const el of form.elements) {
        if (el.name) {
          data[el.name] = el.type === 'number' ? Number(el.value) : el.value;
        }
      }
      await Data.saveSettings(data);
      _toast('Settings saved');
    });

    document.getElementById('btnGenerateKey').addEventListener('click', async () => {
      const btn = document.getElementById('btnGenerateKey');
      btn.disabled = true;
      btn.textContent = 'Generating…';
      try {
        const res = await Data.generateDeployKey();
        const display = document.getElementById('publicKeyDisplay');
        display.textContent = res.public_key;
        display.style.display = 'block';
        _toast('Key generated — copy the public key above');
      } catch (err) {
        _toast('Key generation failed: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Deploy Key';
      }
    });

    // Model switch
    document.getElementById('btnSwitchModel').addEventListener('click', async () => {
      const select = document.getElementById('modelSelect');
      const model = select.value;
      const status = document.getElementById('backfillStatus');
      if (!confirm(`Switch to ${model}? This will delete all annotated images and reprocess every snapshot — may take a while.`)) return;
      status.textContent = 'Switching model and queuing backfill…';
      status.style.display = '';
      try {
        await fetch('/api/settings/switch-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        _toast(`Switched to ${model} — backfill running in background`);
        _pollBackfill(status);
      } catch (e) {
        _toast('Model switch failed', true);
        status.style.display = 'none';
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

  function _pollBackfill(statusEl) {
    const interval = setInterval(async () => {
      try {
        const s = await fetch('/api/settings/backfill-status').then(r => r.json());
        if (s.total > 0) {
          statusEl.textContent = `Backfill: ${s.done} / ${s.total} snapshots reprocessed`;
        }
        if (!s.running) {
          clearInterval(interval);
          statusEl.textContent = `Backfill complete — ${s.total} snapshots reprocessed`;
          setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
        }
      } catch { clearInterval(interval); }
    }, 3000);
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
