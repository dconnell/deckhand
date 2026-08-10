import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';

import {
  createCommandMessage,
  createErrorMessage,
  createPresentationStateMessage,
  createPresenterStateMessage,
  createRegisteredMessage,
  createTranscriptMessage,
  validateClientMessage,
} from './protocol.js';

function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

function createAsyncEmitter() {
  const listeners = new Map();

  return {
    on(eventName, handler) {
      const handlers = listeners.get(eventName) ?? new Set();
      handlers.add(handler);
      listeners.set(eventName, handlers);
    },

    async emit(eventName, payload) {
      const handlers = listeners.get(eventName);

      if (handlers === undefined) {
        return;
      }

      for (const handler of handlers) {
        await handler(payload);
      }
    },
  };
}

function isSocketOpen(socket) {
  return socket.readyState === WebSocket.OPEN;
}

function serializeClient(client) {
  const payload = {
    capabilities: [...client.capabilities],
    role: client.role,
    sessionId: client.sessionId,
  };

  if (client.role === 'driver' && client.clientId !== undefined) {
    payload.clientId = client.clientId;
  }

  if (client.role === 'observer') {
    payload.subscriptions = [...client.subscriptions];
  }

  return payload;
}

function createProtocolMessage(channel, payload) {
  if (channel === 'presentationState') {
    return createPresentationStateMessage(payload);
  }

  if (channel === 'presenterState') {
    return createPresenterStateMessage(payload);
  }

  return createTranscriptMessage(payload);
}

function sendMessage(socket, payload) {
  return new Promise((resolve, reject) => {
    if (!isSocketOpen(socket)) {
      reject(new Error('Socket is not open'));
      return;
    }

    socket.send(JSON.stringify(payload), (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

/**
 * Create the local WebSocket hub used by drivers and presenter observers.
 *
 * @param {{ host: string, port: number, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void } }} options Hub options.
 * @returns {{ on(eventName: string, handler: (payload: unknown) => Promise<void> | void): void, start(): Promise<void>, stop(): Promise<void>, sendCommand(target: { role: 'driver' }, command: Record<string, unknown>): Promise<Array<Record<string, unknown>>>, publishSticky(channel: 'presentationState', payload: Record<string, unknown>): Promise<Array<Record<string, unknown>>>, publish(channel: 'presentationState' | 'transcript', payload: Record<string, unknown>, options?: { excludeSessionId?: string }): Promise<Array<Record<string, unknown>>>, getSnapshot(): { activeDriver: Record<string, unknown> | null, observers: Array<Record<string, unknown>>, sticky: Record<string, unknown> }, getAddress(): { host: string, port: number } }}
 */
export function createHub(options) {
  const logger = options.logger ?? createNoopLogger();
  const events = createAsyncEmitter();
  const clientsBySocket = new Map();
  const observersBySessionId = new Map();
  const stickyMessages = new Map();
  let activeDriver = null;
  let server = null;
  let address = { host: options.host, port: options.port };

  async function closeClientSocket(socket, code, reason) {
    if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      return;
    }

    socket.close(code, reason);
  }

  function removeClientRecord(client) {
    if (client.role === 'driver') {
      if (activeDriver?.sessionId === client.sessionId) {
        activeDriver = null;
      }

      return;
    }

    if (client.role === 'observer') {
      observersBySessionId.delete(client.sessionId);
    }
  }

  async function handleDisconnect(socket) {
    const client = clientsBySocket.get(socket);

    if (client === undefined) {
      return;
    }

    clientsBySocket.delete(socket);
    removeClientRecord(client);
    await events.emit('clientDisconnected', serializeClient(client));
  }

  async function registerDriver(socket, message) {
    if (activeDriver !== null && activeDriver.socket !== socket) {
      const previousDriver = activeDriver;
      logger.warn('Replacing active driver client', { previousSessionId: previousDriver.sessionId });
      clientsBySocket.delete(previousDriver.socket);
      removeClientRecord(previousDriver);
      await closeClientSocket(previousDriver.socket, 4000, 'replaced-by-new-driver');
    }

    const client = {
      socket,
      sessionId: randomUUID(),
      role: 'driver',
      clientId: message.clientId,
      capabilities: new Set(message.capabilities ?? []),
    };

    clientsBySocket.set(socket, client);
    activeDriver = client;

    await sendMessage(socket, createRegisteredMessage({ role: 'driver', sessionId: client.sessionId }));
    await events.emit('driverRegistered', serializeClient(client));
  }

  async function registerObserver(socket, message) {
    const client = {
      socket,
      sessionId: randomUUID(),
      role: 'observer',
      capabilities: new Set(message.capabilities ?? []),
      subscriptions: new Set(message.subscriptions ?? []),
    };

    clientsBySocket.set(socket, client);
    observersBySessionId.set(client.sessionId, client);

    await sendMessage(socket, createRegisteredMessage({
      role: 'observer',
      sessionId: client.sessionId,
      subscriptions: [...client.subscriptions],
    }));

    for (const subscription of client.subscriptions) {
      const sticky = stickyMessages.get(subscription);

      if (sticky !== undefined) {
        await sendMessage(socket, sticky);
      }
    }

    await events.emit('observerRegistered', serializeClient(client));
  }

  async function registerClient(socket, message) {
    if (message.role === 'driver') {
      await registerDriver(socket, message);
      return;
    }

    if (message.role === 'observer') {
      await registerObserver(socket, message);
      return;
    }

    await sendProtocolError(socket, 'invalid_message', 'role must be either "driver" or "observer"');
  }

  async function sendProtocolError(socket, code, message) {
    try {
      await sendMessage(socket, createErrorMessage(code, message));
    } catch (error) {
      logger.error('Failed to send protocol error', {
        code,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function publishToObservers(channel, payload, publishOptions = {}) {
    const protocolMessage = payload?.type === channel
      ? payload
      : createProtocolMessage(channel, payload);

    const delivered = [];
    let firstError = null;

    for (const observer of observersBySessionId.values()) {
      if (!observer.subscriptions.has(channel)) {
        continue;
      }

      if (publishOptions.excludeSessionId !== undefined && observer.sessionId === publishOptions.excludeSessionId) {
        continue;
      }

      try {
        await sendMessage(observer.socket, protocolMessage);
        delivered.push(serializeClient(observer));
      } catch (error) {
        firstError ??= error;
        logger.error('Failed to publish observer message', {
          channel,
          error: error instanceof Error ? error.message : String(error),
          sessionId: observer.sessionId,
        });
      }
    }

    if (firstError !== null) {
      throw firstError;
    }

    return delivered;
  }

  async function handleMessage(socket, rawData) {
    let parsed;

    try {
      parsed = JSON.parse(String(rawData));
    } catch {
      await sendProtocolError(socket, 'invalid_json', 'Malformed JSON message');
      return;
    }

    let message;

    try {
      message = validateClientMessage(parsed);
    } catch (error) {
      await sendProtocolError(socket, 'invalid_message', error instanceof Error ? error.message : 'Invalid client message');
      return;
    }

    if (message.type === 'register') {
      await registerClient(socket, message);
      return;
    }

    const client = clientsBySocket.get(socket);

    if (client === undefined) {
      await sendProtocolError(socket, 'invalid_registration', 'Client must register before sending other messages');
      return;
    }

    if (message.type === 'positionChanged') {
      if (client.role !== 'driver') {
        await sendProtocolError(socket, 'invalid_message', 'Only driver clients can send positionChanged messages');
        return;
      }

      await events.emit('driverPositionChanged', message.position);
      return;
    }

    if (message.type === 'positionSettled') {
      if (client.role !== 'driver') {
        await sendProtocolError(socket, 'invalid_message', 'Only driver clients can send positionSettled messages');
        return;
      }

      await events.emit('driverPositionSettled', {
        eventId: message.eventId,
        sender: serializeClient(client),
      });
      return;
    }

    if (message.type === 'slideManifest') {
      if (client.role !== 'driver') {
        await sendProtocolError(socket, 'invalid_message', 'Only driver clients can send slideManifest messages');
        return;
      }

      await events.emit('driverSlideManifest', {
        manifest: message,
        sender: serializeClient(client),
      });
      return;
    }

    if (message.type === 'transcript') {
      if (client.role !== 'observer') {
        await sendProtocolError(socket, 'invalid_message', 'Only observer clients can send transcript messages');
        return;
      }

      await publishToObservers('transcript', message, { excludeSessionId: client.sessionId });
      await events.emit('observerTranscript', {
        transcript: message,
        sender: serializeClient(client),
      });
      return;
    }

    if (message.type === 'presenterCommand') {
      if (client.role !== 'observer') {
        await sendProtocolError(socket, 'invalid_message', 'Only observer clients can send presenterCommand messages');
        return;
      }

      await events.emit('observerPresenterCommand', {
        command: message,
        sender: serializeClient(client),
      });
      return;
    }

      if (message.type === 'driverCommand') {
        if (client.role !== 'observer') {
          await sendProtocolError(socket, 'invalid_message', 'Only observer clients can send driverCommand messages');
          return;
        }

        await events.emit('observerDriverCommand', {
          command: message.command,
          sender: serializeClient(client),
        });
        return;
      }

      if (message.type === 'windowBindings') {
        if (client.role !== 'observer') {
          await sendProtocolError(socket, 'invalid_message', 'Only observer clients can send windowBindings messages');
          return;
        }

        await events.emit('observerWindowBindings', {
          bindings: message.bindings,
          cleared: message.cleared,
          sender: serializeClient(client),
        });
        return;
      }

      if (message.type === 'windowSettled') {
        if (client.role !== 'observer') {
          await sendProtocolError(socket, 'invalid_message', 'Only observer clients can send windowSettled messages');
          return;
        }

        await events.emit('observerWindowSettled', {
          seq: message.seq,
          sender: serializeClient(client),
        });
        return;
      }

      await sendProtocolError(socket, 'unsupported_type', `Unsupported message type: ${message.type}`);
    }

  return {
    on(eventName, handler) {
      events.on(eventName, handler);
    },

    async start() {
      if (server !== null) {
        return;
      }

      server = new WebSocketServer({ host: options.host, port: options.port });

      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });

      const serverAddress = server.address();

      if (serverAddress !== null && typeof serverAddress !== 'string') {
        address = {
          host: serverAddress.address,
          port: serverAddress.port,
        };
      }

      server.on('connection', (socket) => {
        socket.on('message', (data) => {
          handleMessage(socket, data).catch((error) => {
            logger.error('Hub message handling failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        });

        socket.on('close', () => {
          handleDisconnect(socket).catch((error) => {
            logger.error('Hub disconnect handling failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        });

        socket.on('error', (error) => {
          logger.error('Hub client socket error', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      logger.info('Hub listening', address);
    },

    async stop() {
      if (server === null) {
        return;
      }

      const sockets = [...clientsBySocket.keys()];

      for (const socket of sockets) {
        await closeClientSocket(socket, 1001, 'server-shutdown');
      }

      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      clientsBySocket.clear();
      observersBySessionId.clear();
      stickyMessages.clear();
      activeDriver = null;
      server = null;
      logger.info('Hub stopped');
    },

    async sendCommand(target, command) {
      if (target.role !== 'driver') {
        throw new Error('sendCommand only supports the driver boundary');
      }

      if (activeDriver === null) {
        logger.warn('No active driver connected for command', { command });
        return [];
      }

      await sendMessage(activeDriver.socket, createCommandMessage(command));
      return [serializeClient(activeDriver)];
    },

    async publish(channel, payload, publishOptions = {}) {
      return publishToObservers(channel, payload, publishOptions);
    },

    async publishSticky(channel, payload) {
      const protocolMessage = createProtocolMessage(channel, payload);
      stickyMessages.set(channel, protocolMessage);
      return publishToObservers(channel, protocolMessage);
    },

    getSnapshot() {
      return {
        activeDriver: activeDriver === null ? null : serializeClient(activeDriver),
        observers: [...observersBySessionId.values()].map((client) => serializeClient(client)),
        sticky: Object.fromEntries(stickyMessages.entries()),
      };
    },

    getAddress() {
      return address;
    },
  };
}
