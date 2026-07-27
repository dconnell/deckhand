import { createPresenterStore } from './lib/store.js';

function createObserverClient({ hubUrl, onConnection, onPresentationState, onTranscript }) {
  let socket = null;
  let reconnectTimer = null;
  let connectionId = 0;

  function scheduleReconnect() {
    if (reconnectTimer !== null) {
      return;
    }

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1000);
  }

  function connect() {
    connectionId += 1;
    onConnection(connectionId, 'connecting');
    socket = new window.WebSocket(hubUrl);

    socket.addEventListener('open', () => {
      onConnection(connectionId, 'live');
      socket.send(JSON.stringify({
        type: 'register',
        role: 'observer',
        subscriptions: ['presentationState', 'transcript'],
      }));
    });

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data);

        if (payload.type === 'presentationState') {
          onPresentationState(payload, connectionId);
        }

        if (payload.type === 'transcript') {
          onTranscript(payload, connectionId);
        }
      } catch (error) {
        console.warn('[deckhand:presenter] Ignored malformed message', error);
      }
    });

    socket.addEventListener('close', () => {
      onConnection(connectionId, 'reconnecting');
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      onConnection(connectionId, 'error');
    });
  }

  connect();
}

function render(state) {
  const title = document.getElementById('slide-title');
  const connection = document.getElementById('connection-status');
  const follow = document.getElementById('follow-status');
  const slideMeta = document.getElementById('slide-meta');
  const focusMeta = document.getElementById('focus-meta');
  const linesEl = document.getElementById('script-lines');
  const emptyState = document.getElementById('empty-state');
  const transcriptEl = document.getElementById('transcript-items');

  connection.textContent = state.connection.phase;
  follow.textContent = state.follow.enabled ? 'Follow On' : 'Follow Off';

  if (state.presentation === null) {
    title.textContent = 'Waiting for slide state';
    slideMeta.textContent = 'No active slide';
    focusMeta.textContent = '-';
    linesEl.replaceChildren();
    transcriptEl.replaceChildren();
    emptyState.hidden = false;
    return;
  }

  title.textContent = state.presentation.slideId;
  slideMeta.textContent = `${state.presentation.layoutId} (#${state.presentation.seq})`;
  focusMeta.textContent = state.presentation.focus ?? '-';
  emptyState.hidden = state.presentation.lines.length > 0;

  linesEl.replaceChildren(...state.presentation.lines.map((line, index) => {
    const item = document.createElement('li');
    item.textContent = line;
    if (index === state.follow.activeLineIndex) {
      item.className = 'active';
    }
    return item;
  }));

  transcriptEl.replaceChildren(...state.transcript.items.map((item) => {
    const row = document.createElement('li');
    row.textContent = item.text;
    return row;
  }));
}

async function main() {
  const bootstrap = await fetch('/presenter/bootstrap.json').then((response) => response.json());
  const store = createPresenterStore({
    followEnabledByDefault: bootstrap.followEnabledByDefault,
  });

  function sync() {
    render(store.getState());
  }

  document.getElementById('prev-line').addEventListener('click', () => {
    store.moveLine(-1);
    sync();
  });
  document.getElementById('next-line').addEventListener('click', () => {
    store.moveLine(1);
    sync();
  });
  document.getElementById('reset-lines').addEventListener('click', () => {
    store.resetLine();
    sync();
  });
  document.getElementById('toggle-follow').addEventListener('click', () => {
    store.toggleFollow();
    sync();
  });

  createObserverClient({
    hubUrl: bootstrap.hubUrl,
    onConnection(connectionId, phase) {
      if (phase === 'live') {
        store.beginConnection(connectionId);
      } else {
        store.getState().connection.phase = phase;
      }
      sync();
    },
    onPresentationState(payload, connectionId) {
      store.applyPresentationState(payload, connectionId);
      sync();
    },
    onTranscript(payload, connectionId) {
      store.applyTranscript(payload, connectionId);
      sync();
    },
  });

  sync();
}

main().catch((error) => {
  console.error('[deckhand:presenter] Failed to start presenter app', error);
});
