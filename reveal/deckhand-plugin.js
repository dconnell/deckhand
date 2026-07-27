(function bootstrapDeckhandRevealPlugin(globalScope) {
  const DEFAULT_HUB_URL = 'ws://127.0.0.1:8765';
  const RECONNECT_DELAY_MS = 1000;
  const LOG_PREFIX = '[deckhand:reveal]';

  function cleanString(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  function readDeckhandId(slide) {
    return cleanString(slide && slide.dataset ? slide.dataset.deckhandId : null);
  }

  function deriveSlideId(event) {
    const indexh = Number.isInteger(event.indexh) ? event.indexh : 0;
    const indexv = Number.isInteger(event.indexv) ? event.indexv : 0;
    const explicitId = readDeckhandId(event.currentSlide);

    if (explicitId !== null) {
      return {
        id: explicitId,
        idSource: 'data-deckhand-id',
        indexh,
        indexv,
      };
    }

    return {
      id: String(indexh) + '.' + String(indexv),
      idSource: 'index',
      indexh,
      indexv,
    };
  }

  function buildPositionMessage(event) {
    const normalized = deriveSlideId(event);

    return {
      type: 'positionChanged',
      position: {
        id: normalized.id,
        index: {
          h: normalized.indexh,
          v: normalized.indexv,
        },
        meta: {
          idSource: normalized.idSource,
          indexh: normalized.indexh,
          indexv: normalized.indexv,
        },
      },
    };
  }

  function findDuplicateDeckhandIds(slides) {
    const seen = Object.create(null);
    const duplicates = [];

    slides.forEach(function collectDuplicates(slide) {
      const deckhandId = readDeckhandId(slide);

      if (deckhandId === null) {
        return;
      }

      if (seen[deckhandId] === true) {
        if (!duplicates.includes(deckhandId)) {
          duplicates.push(deckhandId);
        }

        return;
      }

      seen[deckhandId] = true;
    });

    return duplicates;
  }

  function resolveGoTo(deck, id) {
    const fallbackMatch = /^(\d+)\.(\d+)$/.exec(String(id));

    if (fallbackMatch !== null) {
      return {
        indexh: Number(fallbackMatch[1]),
        indexv: Number(fallbackMatch[2]),
      };
    }

    const slides = Array.prototype.slice.call(document.querySelectorAll('.slides section'));
    const slide = slides.find(function findByDeckhandId(entry) {
      return readDeckhandId(entry) === id;
    });

    if (!slide || typeof deck.getIndices !== 'function') {
      return null;
    }

    const indices = deck.getIndices(slide);

    return {
      indexh: Number.isInteger(indices.h) ? indices.h : 0,
      indexv: Number.isInteger(indices.v) ? indices.v : 0,
    };
  }

  globalScope.DeckhandRevealPlugin = function createDeckhandRevealPlugin(userOptions) {
    const options = Object.assign(
      {
        hubUrl: DEFAULT_HUB_URL,
        reconnectDelayMs: RECONNECT_DELAY_MS,
      },
      userOptions || {},
    );

    return {
      id: 'deckhand',

      init: function initDeckhandPlugin(deck) {
        let socket = null;
        let reconnectTimer = null;
        let lastPositionEvent = null;
        let driverRegistered = false;

        function log(level, message, details) {
          const logger = console[level] || console.log;

          if (details === undefined) {
            logger.call(console, LOG_PREFIX + ' ' + message);
            return;
          }

          logger.call(console, LOG_PREFIX + ' ' + message, details);
        }

        function clearReconnectTimer() {
          if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
        }

        function send(payload) {
          if (socket !== null && socket.readyState === globalScope.WebSocket.OPEN) {
            socket.send(JSON.stringify(payload));
          }
        }

        function report(event) {
          lastPositionEvent = event;

          if (!driverRegistered) {
            return;
          }

          send(buildPositionMessage(event));
        }

        function buildCurrentPositionEvent() {
          var currentSlide = typeof deck.getCurrentSlide === 'function' ? deck.getCurrentSlide() : null;
          var indices = typeof deck.getIndices === 'function' ? deck.getIndices() : {};

          return {
            currentSlide: currentSlide,
            indexh: Number.isInteger(indices.h) ? indices.h : 0,
            indexv: Number.isInteger(indices.v) ? indices.v : 0,
          };
        }

        function reportCurrentPosition() {
          report(lastPositionEvent || buildCurrentPositionEvent());
        }

        function handleCommand(payload) {
          if (!payload || payload.type !== 'command' || !payload.command) {
            return;
          }

          const command = payload.command;

          if (command.type === 'next') {
            deck.next();
            return;
          }

          if (command.type === 'prev') {
            deck.prev();
            return;
          }

          if (command.type === 'goTo' && typeof command.id === 'string') {
            const destination = resolveGoTo(deck, command.id);

            if (destination === null) {
              log('warn', 'Unable to resolve goTo target', { id: command.id });
              return;
            }

            deck.slide(destination.indexh, destination.indexv);
          }
        }

        function scheduleReconnect() {
          if (reconnectTimer !== null) {
            return;
          }

          reconnectTimer = setTimeout(function reconnectLater() {
            reconnectTimer = null;
            connect();
          }, options.reconnectDelayMs);
        }

        function connect() {
          if (socket !== null && (socket.readyState === globalScope.WebSocket.OPEN || socket.readyState === globalScope.WebSocket.CONNECTING)) {
            return;
          }

          clearReconnectTimer();
          socket = new globalScope.WebSocket(options.hubUrl);

          socket.addEventListener('open', function onOpen() {
            driverRegistered = false;
            log('info', 'Connected to local hub', { hubUrl: options.hubUrl });
            send({
              type: 'register',
              role: 'driver',
              capabilities: ['next', 'prev', 'goTo'],
            });
          });

          socket.addEventListener('message', function onMessage(event) {
            try {
              var payload = JSON.parse(event.data);

              if (payload && payload.type === 'registered' && payload.role === 'driver') {
                driverRegistered = true;
                reportCurrentPosition();
                return;
              }

              handleCommand(payload);
            } catch (error) {
              log('warn', 'Ignored malformed hub message', { error: error.message });
            }
          });

          socket.addEventListener('close', function onClose() {
            driverRegistered = false;
            log('warn', 'Disconnected from local hub, retrying');
            scheduleReconnect();
          });

          socket.addEventListener('error', function onError() {
            log('warn', 'WebSocket error from local hub');
          });
        }

        deck.on('ready', function onReady(event) {
          const duplicates = findDuplicateDeckhandIds(Array.prototype.slice.call(document.querySelectorAll('.slides section')));

          if (duplicates.length > 0) {
            log('warn', 'Duplicate data-deckhand-id values detected', duplicates);
          }

          report(event);
        });

        deck.on('slidechanged', report);
        connect();
      },
    };
  };
})(window);
