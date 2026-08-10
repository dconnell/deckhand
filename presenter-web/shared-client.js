export function createObserverClient({ hubUrl, subscriptions, onConnection, onMessage }) {
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
        subscriptions,
      }));
    });

    socket.addEventListener('message', (event) => {
      try {
        onMessage(JSON.parse(event.data), connectionId);
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

  function send(message) {
    if (socket !== null && socket.readyState === window.WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  connect();

  return {
    send,
  };
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function tokenText(tokens) {
  return tokens.map((token) => token.text ?? '').join(' ');
}
