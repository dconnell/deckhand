// ==UserScript==
// @name         Deckhand Browser Target
// @namespace    https://example.com/deckhand
// @version      0.1.0
// @description  Register a browser tab with the local Deckhand hub and navigate on command.
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function bootstrapDeckhandBrowserTarget(globalScope) {
  const STORAGE_KEY = 'deckhand-target-identity';
  const HUB_URL_KEY = 'deckhand-target-hub-url';
  const DEFAULT_HUB_URL = 'ws://127.0.0.1:8765';
  const RECONNECT_DELAY_MS = 1000;
  const LOG_PREFIX = '[deckhand:browser]';

  let socket = null;
  let reconnectTimer = null;
  let collapsed = true;

  function cleanString(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  function parseParams() {
    const params = new URLSearchParams(globalScope.location.search);

    return {
      controllerId: cleanString(params.get('controllerId')),
      tabId: cleanString(params.get('tabId')),
      hubUrl: cleanString(params.get('hubUrl')),
    };
  }

  function readStoredIdentity() {
    const rawIdentity = globalScope.localStorage.getItem(STORAGE_KEY);

    if (rawIdentity === null) {
      return null;
    }

    try {
      return JSON.parse(rawIdentity);
    } catch {
      return null;
    }
  }

  function writeStoredIdentity(identity) {
    globalScope.localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  }

  function readStoredHubUrl() {
    return cleanString(globalScope.localStorage.getItem(HUB_URL_KEY)) || DEFAULT_HUB_URL;
  }

  function writeStoredHubUrl(hubUrl) {
    globalScope.localStorage.setItem(HUB_URL_KEY, hubUrl);
  }

  function resolveSettings() {
    const params = parseParams();
    const storedIdentity = readStoredIdentity();
    const identity = {
      controllerId: params.controllerId || cleanString(storedIdentity && storedIdentity.controllerId) || '',
      tabId: params.tabId || cleanString(storedIdentity && storedIdentity.tabId) || '',
    };
    const hubUrl = params.hubUrl || readStoredHubUrl();
    const shouldPersist = params.controllerId !== null || params.tabId !== null || params.hubUrl !== null;

    if (shouldPersist) {
      if (identity.controllerId) {
        writeStoredIdentity(identity);
      }

      writeStoredHubUrl(hubUrl);
    }

    return {
      hubUrl,
      identity,
      shouldPersist,
    };
  }

  function validateIdentity(identity) {
    if (!identity.controllerId) {
      return 'controllerId required';
    }

    if (identity.controllerId.indexOf(':') !== -1 || (identity.tabId && identity.tabId.indexOf(':') !== -1)) {
      return '":" not allowed';
    }

    return null;
  }

  function buildRegistrationMessage(identity) {
    const payload = {
      type: 'register',
      role: 'target',
      controllerId: identity.controllerId,
      capabilities: ['navigate'],
    };

    if (identity.tabId) {
      payload.tabId = identity.tabId;
    }

    return payload;
  }

  function shouldNavigate(nextUrl) {
    return String(globalScope.location.href) !== String(nextUrl);
  }

  function log(level, message, details) {
    const logger = console[level] || console.log;

    if (details === undefined) {
      logger.call(console, LOG_PREFIX + ' ' + message);
      return;
    }

    logger.call(console, LOG_PREFIX + ' ' + message, details);
  }

  function createOverlay() {
    const root = document.createElement('div');
    const badge = document.createElement('button');
    const details = document.createElement('div');
    const status = document.createElement('div');
    const error = document.createElement('div');
    const controllerInput = document.createElement('input');
    const tabInput = document.createElement('input');
    const hubUrlInput = document.createElement('input');
    const saveButton = document.createElement('button');
    const clearButton = document.createElement('button');
    const hideButton = document.createElement('button');

    root.style.position = 'fixed';
    root.style.bottom = '12px';
    root.style.right = '12px';
    root.style.zIndex = '2147483647';
    root.style.maxWidth = '280px';
    root.style.font = '12px/1.4 system-ui, sans-serif';
    root.style.color = '#111827';

    badge.type = 'button';
    badge.style.border = '1px solid #cbd5e1';
    badge.style.background = '#ffffff';
    badge.style.borderRadius = '999px';
    badge.style.padding = '6px 10px';
    badge.style.boxShadow = '0 6px 20px rgba(15, 23, 42, 0.14)';
    badge.style.cursor = 'pointer';

    details.style.marginTop = '8px';
    details.style.padding = '10px';
    details.style.border = '1px solid #cbd5e1';
    details.style.borderRadius = '12px';
    details.style.background = '#ffffff';
    details.style.boxShadow = '0 12px 28px rgba(15, 23, 42, 0.18)';

    [controllerInput, tabInput, hubUrlInput].forEach(function styleInput(input) {
      input.style.display = 'block';
      input.style.width = '100%';
      input.style.boxSizing = 'border-box';
      input.style.marginBottom = '8px';
      input.style.padding = '6px 8px';
      input.style.border = '1px solid #cbd5e1';
      input.style.borderRadius = '8px';
      input.style.background = '#f8fafc';
    });

    controllerInput.placeholder = 'controllerId';
    tabInput.placeholder = 'tabId (optional)';
    hubUrlInput.placeholder = 'hubUrl';

    saveButton.textContent = 'Save';
    clearButton.textContent = 'Clear';
    hideButton.textContent = 'Hide';

    [saveButton, clearButton, hideButton].forEach(function styleButton(button) {
      button.type = 'button';
      button.style.marginRight = '6px';
      button.style.padding = '6px 8px';
      button.style.border = '1px solid #cbd5e1';
      button.style.borderRadius = '8px';
      button.style.background = '#ffffff';
      button.style.cursor = 'pointer';
    });

    error.style.minHeight = '18px';
    error.style.color = '#b91c1c';
    error.style.marginBottom = '6px';

    badge.addEventListener('click', function toggleDetails() {
      collapsed = !collapsed;
      details.style.display = collapsed ? 'none' : 'block';
    });

    hideButton.addEventListener('click', function hideDetails() {
      collapsed = true;
      details.style.display = 'none';
    });

    details.appendChild(status);
    details.appendChild(error);
    details.appendChild(controllerInput);
    details.appendChild(tabInput);
    details.appendChild(hubUrlInput);
    details.appendChild(saveButton);
    details.appendChild(clearButton);
    details.appendChild(hideButton);
    root.appendChild(badge);
    root.appendChild(details);
    document.documentElement.appendChild(root);

    return {
      badge,
      clearButton,
      controllerInput,
      details,
      error,
      hideButton,
      hubUrlInput,
      saveButton,
      status,
      tabInput,
    };
  }

  const overlay = createOverlay();

  function disconnect() {
    if (socket !== null) {
      socket.close(1000, 'manual-reconnect');
      socket = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) {
      return;
    }

    reconnectTimer = globalScope.setTimeout(function reconnectLater() {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  function updateOverlay(connectionState, message) {
    const settings = resolveSettings();
    const selector = settings.identity.tabId ? settings.identity.controllerId + ':' + settings.identity.tabId : settings.identity.controllerId || 'unconfigured';

    overlay.badge.textContent = 'Deckhand: ' + connectionState + ' (' + selector + ')';
    overlay.status.textContent = 'State: ' + connectionState + ' | Hub: ' + settings.hubUrl;
    overlay.controllerInput.value = settings.identity.controllerId;
    overlay.tabInput.value = settings.identity.tabId;
    overlay.hubUrlInput.value = settings.hubUrl;
    overlay.error.textContent = message || '';

    if (!settings.identity.controllerId || settings.shouldPersist) {
      collapsed = false;
    }

    overlay.details.style.display = collapsed ? 'none' : 'block';
  }

  function handleCommand(payload) {
    if (!payload || payload.type !== 'command' || !payload.command) {
      return;
    }

    if (payload.command.type !== 'navigate' || typeof payload.command.url !== 'string') {
      return;
    }

    if (!shouldNavigate(payload.command.url)) {
      log('info', 'Skipped same-url navigation', { url: payload.command.url });
      return;
    }

    log('info', 'Navigating browser target', { url: payload.command.url });
    globalScope.location.assign(payload.command.url);
  }

  function connect() {
    const settings = resolveSettings();
    const identity = {
      controllerId: cleanString(settings.identity.controllerId) || '',
      tabId: cleanString(settings.identity.tabId) || '',
    };
    const validationError = validateIdentity(identity);

    if (validationError !== null) {
      updateOverlay('waiting', validationError);
      return;
    }

    updateOverlay('connecting');
    disconnect();
    socket = new globalScope.WebSocket(settings.hubUrl);

    socket.addEventListener('open', function onOpen() {
      log('info', 'Connected to local hub', { hubUrl: settings.hubUrl, identity: identity });
      updateOverlay('connected');
      socket.send(JSON.stringify(buildRegistrationMessage(identity)));
    });

    socket.addEventListener('message', function onMessage(event) {
      try {
        handleCommand(JSON.parse(event.data));
      } catch (error) {
        log('warn', 'Ignored malformed hub message', { error: error.message });
      }
    });

    socket.addEventListener('close', function onClose() {
      updateOverlay('disconnected');
      scheduleReconnect();
    });

    socket.addEventListener('error', function onError() {
      updateOverlay('error', 'WebSocket error');
    });
  }

  overlay.saveButton.addEventListener('click', function saveSettings() {
    const identity = {
      controllerId: cleanString(overlay.controllerInput.value) || '',
      tabId: cleanString(overlay.tabInput.value) || '',
    };
    const hubUrl = cleanString(overlay.hubUrlInput.value) || DEFAULT_HUB_URL;
    const validationError = validateIdentity(identity);

    if (validationError !== null) {
      updateOverlay('waiting', validationError);
      return;
    }

    writeStoredIdentity(identity);
    writeStoredHubUrl(hubUrl);
    collapsed = true;
    updateOverlay('saved');
    connect();
  });

  overlay.clearButton.addEventListener('click', function clearSettings() {
    globalScope.localStorage.removeItem(STORAGE_KEY);
    globalScope.localStorage.removeItem(HUB_URL_KEY);
    collapsed = false;
    disconnect();
    updateOverlay('waiting', 'Identity cleared');
  });

  updateOverlay('booting');
  connect();
})(window);
