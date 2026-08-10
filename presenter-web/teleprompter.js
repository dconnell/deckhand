import { createObserverClient } from './shared-client.js';

const LINE_HEIGHT_PX = 58;
const LINE_GAP_PX = 16;

function assignLineTiers(lines, activeLineIndex) {
  return lines.map((_, index) => {
    if (index < activeLineIndex) {
      return 'past';
    }

    if (index === activeLineIndex) {
      return 'current';
    }

    if (index <= activeLineIndex + 1) {
      return 'near';
    }

    return 'future';
  });
}

function computeTeleprompterOffset({ activeLineTop, activeLineHeight, viewportHeight, anchorRatio }) {
  const activeCenter = activeLineTop + (activeLineHeight / 2);
  const anchorCenter = viewportHeight * anchorRatio;
  return Math.round(anchorCenter - activeCenter);
}

function createInitialState() {
  return {
    connection: 'connecting',
    presenter: null,
    nodes: [],
    rafScheduled: false,
  };
}

function renderTokens(line) {
  const fragment = document.createDocumentFragment();

  for (const token of line.tokens) {
    const span = document.createElement('span');
    span.className = `token token-${token.kind}`;
    span.textContent = token.text ?? (token.kind === 'pause' ? '...' : '');
    fragment.append(span, ' ');
  }

  return fragment;
}

function ensureLineNodes(state, listEl, presenter) {
  const lines = presenter.current.lines;

  while (state.nodes.length > lines.length) {
    state.nodes.pop()?.remove();
  }

  for (let index = state.nodes.length; index < lines.length; index += 1) {
    const item = document.createElement('li');
    item.className = 'teleprompter-line';
    listEl.append(item);
    state.nodes.push(item);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const item = state.nodes[index];
    item.replaceChildren(renderTokens(lines[index]));
  }
}

function render(state) {
  const connection = document.getElementById('teleprompter-connection');
  const status = document.getElementById('teleprompter-status');
  const listEl = document.getElementById('teleprompter-lines');
  const shell = document.getElementById('teleprompter-shell');

  connection.textContent = state.connection;

  if (state.presenter === null || state.presenter.current.hidden) {
    status.textContent = state.presenter?.current.hidden ? 'Hidden' : 'Waiting';
    shell.dataset.hidden = state.presenter?.current.hidden ? 'true' : 'false';
    while (state.nodes.length > 0) {
      state.nodes.pop()?.remove();
    }
    listEl.style.transform = 'translateY(0px)';
    return;
  }

  shell.dataset.hidden = 'false';
  status.textContent = state.presenter.teleprompter.trackingState;
  ensureLineNodes(state, listEl, state.presenter);

  const tiers = assignLineTiers(state.presenter.current.lines, state.presenter.teleprompter.activeLineIndex);
  const activeLineTop = state.presenter.teleprompter.activeLineIndex * (LINE_HEIGHT_PX + LINE_GAP_PX);
  const offset = computeTeleprompterOffset({
    activeLineTop,
    activeLineHeight: LINE_HEIGHT_PX,
    viewportHeight: window.innerHeight,
    anchorRatio: 0.3,
  });

  listEl.style.transform = `translateY(${offset}px)`;

  state.nodes.forEach((node, index) => {
    node.dataset.tier = tiers[index];
  });
}

function scheduleRender(state) {
  if (state.rafScheduled) {
    return;
  }

  state.rafScheduled = true;
  window.requestAnimationFrame(() => {
    state.rafScheduled = false;
    render(state);
  });
}

async function main() {
  const bootstrap = await fetch('/presenter/bootstrap.json').then((response) => response.json());
  const state = createInitialState();
  let client = null;

  function sendCommand(command) {
    client?.send({ type: 'presenterCommand', ...command });
  }

  window.addEventListener('keydown', (event) => {
    if (state.presenter === null) {
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      sendCommand({ op: 'nudge', source: 'teleprompter', delta: -1 });
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      sendCommand({ op: 'nudge', source: 'teleprompter', delta: 1 });
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      sendCommand({ op: 'jumpParagraph', source: 'teleprompter', delta: -1 });
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      sendCommand({ op: 'jumpParagraph', source: 'teleprompter', delta: 1 });
    } else if (event.key === 'Home') {
      event.preventDefault();
      sendCommand({ op: 'reset', source: 'teleprompter' });
    } else if (event.key === ' ') {
      event.preventDefault();
      sendCommand({ op: 'toggleFollow', source: 'teleprompter' });
    } else if (event.key === 'Escape') {
      window.blur();
    }
  });

  client = createObserverClient({
    hubUrl: bootstrap.hubUrl,
    subscriptions: ['presenterState'],
    onConnection(_connectionId, phase) {
      state.connection = phase;
      if (phase !== 'live') {
        state.presenter = null;
      }
      scheduleRender(state);
    },
    onMessage(payload) {
      if (payload.type === 'presenterState') {
        state.presenter = payload;
        scheduleRender(state);
      }
    },
  });

  scheduleRender(state);
}

main().catch((error) => {
  console.error('[deckhand:teleprompter] Failed to start teleprompter', error);
});
