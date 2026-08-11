import { createObserverClient } from './shared-client.js';
import {
  buildTeleprompterFrame,
  buildTokenRenderParts,
  reconcileLineNodes,
  shouldRenderImmediately,
} from './teleprompterView.js';

const FALLBACK_LINE_HEIGHT_PX = 36;
const FALLBACK_LINE_GAP_PX = 8;

function createInitialState() {
  return {
    connection: 'connecting',
    lastRenderedSeq: null,
    lastRenderedVisible: false,
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

function measureLineMetrics(listEl, nodes) {
  const listRect = listEl.getBoundingClientRect();

  return nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    const top = rect.top - listRect.top;

    return {
      top,
      height: rect.height,
      bottom: top + rect.height,
    };
  });
}

function render(state) {
  const connection = document.getElementById('teleprompter-connection');
  const status = document.getElementById('teleprompter-status');
  const listEl = document.getElementById('teleprompter-lines');
  const shell = document.getElementById('teleprompter-shell');
  const progress = document.getElementById('teleprompter-progress');
  const viewport = document.querySelector('.teleprompter-viewport');

  connection.textContent = state.connection;

  let lineMetrics;

  if (state.presenter !== null && state.presenter.current.hidden !== true) {
    ensureLineNodes(state, listEl, state.presenter);
    lineMetrics = measureLineMetrics(listEl, state.nodes);
  }

  const frame = buildTeleprompterFrame(state.presenter, {
    hovered: state.hovered,
    lastStateChangeAtMs: state.lastTrackingStateChangeAtMs,
    lineHeight: FALLBACK_LINE_HEIGHT_PX,
    lineGap: FALLBACK_LINE_GAP_PX,
    lineMetrics,
    nowMs: Date.now(),
    viewportHeight: viewport?.clientHeight ?? window.innerHeight,
  });

  const nextSeq = state.presenter?.presentationSeq ?? null;
  const nextVisible = !frame.hidden;
  const immediate = shouldRenderImmediately({
    prevSeq: state.lastRenderedSeq,
    nextSeq,
    prevVisible: state.lastRenderedVisible,
    nextVisible,
  });
  state.lastRenderedSeq = nextSeq;
  state.lastRenderedVisible = nextVisible;

  if (frame.hidden) {
    status.textContent = frame.status.label;
    status.dataset.tone = frame.status.tone;
    status.hidden = frame.status.visible === false;
    shell.dataset.hidden = 'true';
    while (state.nodes.length > 0) {
      state.nodes.pop()?.remove();
    }
    listEl.style.transform = 'translateY(0px)';
    listEl.style.transition = 'none';
    progress.style.transform = 'scaleX(0)';
    return;
  }

  shell.dataset.hidden = 'false';
  status.textContent = frame.status.label;
  status.dataset.tone = frame.status.tone;
  status.hidden = frame.status.visible === false;

  listEl.style.transition = immediate ? 'none' : '';
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
