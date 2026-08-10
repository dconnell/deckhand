import { createObserverClient } from './shared-client.js';
import {
  buildTeleprompterFrame,
  buildTokenRenderParts,
  reconcileLineNodes,
} from './teleprompterView.js';

const LINE_HEIGHT_PX = 58;
const LINE_GAP_PX = 16;

function createInitialState() {
  return {
    connection: 'connecting',
    presenter: null,
    nodes: [],
    rafScheduled: false,
    hovered: false,
    lastTrackingStateChangeAtMs: 0,
  };
}

function renderTokens(line) {
  const fragment = document.createDocumentFragment();

  for (const token of buildTokenRenderParts(line.tokens)) {
    const span = document.createElement('span');
    span.className = token.className;
    span.textContent = token.text;
    fragment.append(span, ' ');
  }

  return fragment;
}

function ensureLineNodes(state, listEl, presenter) {
  state.nodes = reconcileLineNodes({
    nodes: state.nodes,
    lines: presenter.current.lines,
    createNode() {
      const item = document.createElement('li');
      item.className = 'teleprompter-line';
      return item;
    },
    appendNode(node) {
      listEl.append(node);
    },
    removeNode(node) {
      node.remove();
    },
    renderNode(node, line) {
      node.replaceChildren(renderTokens(line));
    },
  });
}

function render(state) {
  const connection = document.getElementById('teleprompter-connection');
  const status = document.getElementById('teleprompter-status');
  const listEl = document.getElementById('teleprompter-lines');
  const shell = document.getElementById('teleprompter-shell');
  const progress = document.getElementById('teleprompter-progress');

  connection.textContent = state.connection;

  const frame = buildTeleprompterFrame(state.presenter, {
    hovered: state.hovered,
    lastStateChangeAtMs: state.lastTrackingStateChangeAtMs,
    lineHeight: LINE_HEIGHT_PX,
    lineGap: LINE_GAP_PX,
    nowMs: Date.now(),
    viewportHeight: window.innerHeight,
  });

  if (frame.hidden) {
    status.textContent = frame.status.label;
    status.dataset.tone = frame.status.tone;
    status.hidden = frame.status.visible === false;
    shell.dataset.hidden = 'true';
    while (state.nodes.length > 0) {
      state.nodes.pop()?.remove();
    }
    listEl.style.transform = 'translateY(0px)';
    progress.style.transform = 'scaleX(0)';
    return;
  }

  shell.dataset.hidden = 'false';
  status.textContent = frame.status.label;
  status.dataset.tone = frame.status.tone;
  status.hidden = frame.status.visible === false;
  ensureLineNodes(state, listEl, state.presenter);

  listEl.style.transform = `translateY(${frame.offsetPx}px)`;
  progress.style.transform = `scaleX(${frame.progressPercent})`;

  state.nodes.forEach((node, index) => {
    node.dataset.tier = frame.tiers[index];
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
  const shell = document.getElementById('teleprompter-shell');

  shell.addEventListener('mouseenter', () => {
    state.hovered = true;
    scheduleRender(state);
  });
  shell.addEventListener('mouseleave', () => {
    state.hovered = false;
    scheduleRender(state);
  });
  window.addEventListener('resize', () => {
    scheduleRender(state);
  });

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
        if (state.presenter?.teleprompter?.trackingState !== payload.teleprompter.trackingState) {
          state.lastTrackingStateChangeAtMs = Date.now();
        }
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
