// Settings page logic

const SettingsManager = (() => {
  async function load() {
    const cfg = await Data.loadSettings();
    const form = document.getElementById('settingsForm');
    for (const [key, val] of Object.entries(cfg)) {
      const el = form.elements[key];
      if (el) el.value = val;
    }
  }

  function init() {
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
