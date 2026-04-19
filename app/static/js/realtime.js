// SSE realtime updates (LAN only — disabled in static build)

const RealtimeManager = (() => {
  let es = null;
  const dot = document.getElementById('statusDot');

  function init(onSnapshot) {
    Data.isStatic().then(isStatic => {
      if (isStatic) {
        dot.title = 'Static build — no realtime';
        return;
      }
      _connect(onSnapshot);
    });
  }

  function _connect(onSnapshot) {
    es = new EventSource('/api/events');

    es.onopen = () => {
      dot.classList.add('connected');
      dot.title = 'Connected';
    };

    es.onerror = () => {
      dot.classList.remove('connected');
      dot.title = 'Reconnecting…';
      es.close();
      setTimeout(() => _connect(onSnapshot), 5000);
    };

    es.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'snapshot') onSnapshot(msg.data);
      } catch {}
    };
  }

  return { init };
})();
