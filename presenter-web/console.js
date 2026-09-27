import { createObserverClient, formatDuration } from './shared-client.js';
import { buildProgramPreviewUrl } from './teleprompterView.js';

function createInitialState() {
  return {
    connection: 'connecting',
    presenter: null,
  };
}

function renderPreviewImage(image, preview) {
  if (!preview?.available) {
    // The image endpoint returns 503 while preview is unavailable, so the
    // element must carry no src at all — otherwise the browser retries the
    // broken URL on every render.
    image.removeAttribute('src');
    image.hidden = true;
    return;
  }

  image.hidden = false;
  image.src = buildProgramPreviewUrl(preview.path, preview.revision);
}

function render(state) {
  document.getElementById('connection-status').textContent = state.connection;

  if (state.presenter === null) {
    document.getElementById('current-slide').textContent = 'Waiting for presenter state';
    document.getElementById('next-slide').textContent = 'No next slide';
    document.getElementById('focus-value').textContent = '-';
    document.getElementById('follow-value').textContent = '-';
    document.getElementById('tracking-value').textContent = '-';
    document.getElementById('timer-elapsed').textContent = '00:00';
    document.getElementById('timer-remaining').textContent = '--:--';
    document.getElementById('stream-warning').textContent = 'No stream data';
    document.getElementById('preview-state').textContent = 'Preview unavailable';
    renderPreviewImage(document.getElementById('program-preview'), null);
    return;
  }

  const presenter = state.presenter;
  const current = presenter.current;
  const next = presenter.next;

  document.getElementById('current-slide').textContent = current.slideId ?? 'No active slide';
  document.getElementById('next-slide').textContent = next === null
    ? 'No next slide'
    : next.title ?? next.heading ?? next.slideId;
  document.getElementById('focus-value').textContent = current.focus ?? '-';
  document.getElementById('follow-value').textContent = presenter.teleprompter.followEnabled ? 'On' : 'Off';
  document.getElementById('tracking-value').textContent = presenter.teleprompter.trackingState;
  document.getElementById('timer-elapsed').textContent = formatDuration(presenter.timer.elapsedMs);
  document.getElementById('timer-remaining').textContent = presenter.timer.remainingMs === null
    ? '--:--'
    : formatDuration(presenter.timer.remainingMs);
  document.getElementById('stream-warning').textContent = presenter.stream.warning ?? 'Healthy';
  document.getElementById('preview-state').textContent = presenter.obs.preview?.available
    ? `Preview rev ${presenter.obs.preview.revision}`
    : 'Preview unavailable';
  renderPreviewImage(document.getElementById('program-preview'), presenter.obs.preview ?? null);
}

async function main() {
  const bootstrap = await fetch('/presenter/bootstrap.json').then((response) => response.json());
  const state = createInitialState();
  let client = null;

  function sync() {
    render(state);
  }

  function sendCommand(command) {
    client?.send({ type: 'presenterCommand', ...command });
  }

  document.getElementById('timer-start').addEventListener('click', () => {
    sendCommand({ op: 'timerStart', source: 'console' });
  });
  document.getElementById('timer-pause').addEventListener('click', () => {
    sendCommand({ op: 'timerPause', source: 'console' });
  });
  document.getElementById('timer-reset').addEventListener('click', () => {
    sendCommand({ op: 'timerReset', source: 'console' });
  });
  document.getElementById('focus-teleprompter').addEventListener('click', () => {
    sendCommand({ op: 'focusTeleprompter', source: 'console' });
  });
  document.getElementById('reopen-teleprompter').addEventListener('click', () => {
    sendCommand({ op: 'reopenTeleprompter', source: 'console' });
  });

  async function loadRelaunchControls() {
    const container = document.getElementById('relaunch-controls');
    if (container === null) {
      return;
    }

    let catalog;
    try {
      const status = await fetch('/status.json').then((response) => response.json());
      catalog = Array.isArray(status.sourceCatalog) ? status.sourceCatalog : [];
    } catch {
      container.textContent = 'Source list unavailable';
      return;
    }

    container.innerHTML = '';
    if (catalog.length === 0) {
      container.textContent = 'No managed sources';
      return;
    }

    for (const entry of catalog) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.sourceId = entry.id;
      button.textContent = `${entry.id} (${entry.kind})`;
      button.addEventListener('click', () => {
        button.disabled = true;
        sendCommand({ op: 'relaunchSource', source: 'console', sourceId: entry.id });
        window.setTimeout(() => {
          button.disabled = false;
        }, 2000);
      });
      container.appendChild(button);
    }
  }

  void loadRelaunchControls();

  client = createObserverClient({
    hubUrl: bootstrap.hubUrl,
    subscriptions: ['presenterState'],
    onConnection(_connectionId, phase) {
      state.connection = phase;
      if (phase !== 'live') {
        state.presenter = null;
      }
      sync();
    },
    onMessage(payload) {
      if (payload.type === 'presenterState') {
        state.presenter = payload;
        sync();
      }
    },
  });

  sync();
}

main().catch((error) => {
  console.error('[deckhand:presenter-console] Failed to start presenter console', error);
});
