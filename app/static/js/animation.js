// Animation playback engine

const AnimationManager = (() => {
  let frames = [];
  let playing = false;
  let rafId = null;
  let frameIndex = 0;
  let startTime = null;
  let durationMs = 30000;

  // Group flat snapshot array into per-timestamp buckets keyed by camera_id
  function _groupFrames(snapshots) {
    if (!snapshots.length) return [];

    // If data is already in {hour, cameras} format (static build), pass through
    if (snapshots[0] && snapshots[0].cameras !== undefined) {
      return snapshots.map(f => ({
        timestamp: f.hour,
        byCamera: Object.fromEntries(f.cameras.map(c => [c.camera_id, c])),
      }));
    }

    // LAN API: flat snapshot list sorted ascending by captured_at
    return snapshots.map(snap => ({
      timestamp: snap.captured_at,
      byCamera: { [snap.camera_id]: snap },
    }));
  }

  // Build per-camera stats from a frame's byCamera map, merged with all cameras
  function _frameStats(frame, allCameras) {
    return allCameras.map(cam => ({
      ...cam,
      person_count:     (frame.byCamera[cam.id]?.person_count ?? 0),
      bicycle_count:    (frame.byCamera[cam.id]?.bicycle_count ?? 0),
      motorcycle_count: (frame.byCamera[cam.id]?.motorcycle_count ?? 0),
      car_count:        (frame.byCamera[cam.id]?.car_count ?? 0),
      bus_count:        (frame.byCamera[cam.id]?.bus_count ?? 0),
      truck_count:      (frame.byCamera[cam.id]?.truck_count ?? 0),
      total_count:      (frame.byCamera[cam.id]?.total_count ?? 0),
    }));
  }

  function _formatTimestamp(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return ts; }
  }

  async function load(window, durationSec) {
    durationMs = durationSec * 1000;
    const fps = 24;
    const nFrames = Math.round(fps * durationSec);
    const raw = await Data.getAnimationFrames(window, nFrames);
    frames = _groupFrames(raw);
    return frames.length;
  }

  function play(allCameras, onFrame, onDone) {
    if (!frames.length) { onDone(); return; }
    playing = true;
    frameIndex = 0;
    startTime = null;

    function tick(now) {
      if (!playing) return;
      if (!startTime) startTime = now;

      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      frameIndex = Math.floor(progress * (frames.length - 1));

      const frame = frames[frameIndex];
      const stats = _frameStats(frame, allCameras);

      onFrame({
        stats,
        progress,
        timestamp: _formatTimestamp(frame.timestamp),
      });

      if (progress >= 1) {
        playing = false;
        onDone();
        return;
      }
      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    playing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function isPlaying() { return playing; }

  return { load, play, stop, isPlaying };
})();
