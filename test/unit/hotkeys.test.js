import assert from 'node:assert/strict';
import test from 'node:test';

import { createHotkeyAdapter, parseHotkeySpec, resolveHotkeyCode } from '../../src/hotkeys.js';

function createHook() {
  const handlers = new Map();

  return {
    handlers,
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    off(eventName, handler) {
      const current = handlers.get(eventName);
      if (current === handler) {
        handlers.delete(eventName);
      }
    },
    emit(eventName, payload) {
      handlers.get(eventName)?.(payload);
    },
    startCalled: 0,
    stopCalled: 0,
    start() {
      this.startCalled += 1;
    },
    stop() {
      this.stopCalled += 1;
    },
  };
}

test('resolveHotkeyCode maps configured key names', () => {
  const keyMap = { F13: 91, F14: 92 };

  assert.equal(resolveHotkeyCode('F13', keyMap), 91);
  assert.equal(resolveHotkeyCode('F14', keyMap), 92);
});

test('resolveHotkeyCode rejects unknown keys', () => {
  assert.throws(() => resolveHotkeyCode('NotAKey', { F13: 91 }), /Unknown hotkey/i);
});

test('hotkey adapter emits actions for configured keys', async () => {
  const hook = createHook();
  const actions = [];
  const hotkeys = createHotkeyAdapter({
    next: 'F13',
    prev: 'F14',
    hook,
    keyMap: { F13: 91, F14: 92 },
    logger: { info() {}, warn() {}, error() {} },
  });

  hotkeys.on('action', (action) => actions.push(action));
  await hotkeys.start();
  hook.emit('keydown', { keycode: 91 });
  hook.emit('keydown', { keycode: 92 });

  assert.deepEqual(actions, [{ type: 'next' }, { type: 'prev' }]);
});

test('hotkey adapter starts and stops the native listener cleanly', async () => {
  const hook = createHook();
  const hotkeys = createHotkeyAdapter({
    next: 'F13',
    prev: 'F14',
    hook,
    keyMap: { F13: 91, F14: 92 },
    logger: { info() {}, warn() {}, error() {} },
  });

  await hotkeys.start();
  await hotkeys.stop();

  assert.equal(hook.startCalled, 1);
  assert.equal(hook.stopCalled, 1);
  assert.equal(hook.handlers.size, 0);
});

test('hotkey adapter degrades to a no-op when the native backend is unavailable', async () => {
  const warns = [];
  const hotkeys = createHotkeyAdapter({
    next: 'F13',
    prev: 'F14',
    nativeBindings: null,
    logger: {
      info() {},
      warn(message) {
        warns.push(message);
      },
      error() {},
    },
  });

  const actions = [];
  hotkeys.on('action', (action) => actions.push(action));

  await hotkeys.start();
  await hotkeys.stop();

  assert.deepEqual(actions, []);
  assert.match(warns[0], /Native hotkey backend unavailable/i);
});

test('parseHotkeySpec parses a single key with no modifiers', () => {
  assert.deepEqual(parseHotkeySpec('F13'), {
    modifiers: [],
    key: 'F13',
  });
});

test('parseHotkeySpec parses a Shift+key combination', () => {
  assert.deepEqual(parseHotkeySpec('Shift+ArrowRight'), {
    modifiers: ['Shift'],
    key: 'ArrowRight',
  });
});

test('parseHotkeySpec parses a multi-modifier combination', () => {
  assert.deepEqual(parseHotkeySpec('Ctrl+Shift+N'), {
    modifiers: ['Ctrl', 'Shift'],
    key: 'N',
  });
});

test('parseHotkeySpec normalizes Cmd as an alias for Meta', () => {
  assert.deepEqual(parseHotkeySpec('Cmd+ArrowLeft'), {
    modifiers: ['Meta'],
    key: 'ArrowLeft',
  });
});

test('parseHotkeySpec rejects empty specs', () => {
  assert.throws(() => parseHotkeySpec(''), /non-empty/i);
  assert.throws(() => parseHotkeySpec('  '), /non-empty/i);
});

test('hotkey adapter emits actions for combo keys with matching modifiers', async () => {
  const hook = createHook();
  const actions = [];
  const hotkeys = createHotkeyAdapter({
    next: 'Shift+ArrowRight',
    prev: 'Shift+ArrowLeft',
    hook,
    keyMap: {
      ArrowRight: 57421,
      ArrowLeft: 57419,
      Shift: 42,
      ShiftRight: 54,
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  hotkeys.on('action', (action) => actions.push(action));
  await hotkeys.start();

  hook.emit('keydown', { keycode: 57421, shiftKey: true });
  hook.emit('keydown', { keycode: 57421, shiftKey: false });
  hook.emit('keydown', { keycode: 57419, shiftKey: true });

  assert.deepEqual(actions, [{ type: 'next' }, { type: 'prev' }]);
});

test('hotkey adapter ignores combo keys when modifiers do not match', async () => {
  const hook = createHook();
  const actions = [];
  const hotkeys = createHotkeyAdapter({
    next: 'Shift+ArrowRight',
    prev: 'Shift+ArrowLeft',
    hook,
    keyMap: {
      ArrowRight: 57421,
      ArrowLeft: 57419,
      Shift: 42,
      ShiftRight: 54,
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  hotkeys.on('action', (action) => actions.push(action));
  await hotkeys.start();

  hook.emit('keydown', { keycode: 57421, shiftKey: false, ctrlKey: true });

  assert.deepEqual(actions, []);
});

test('hotkey adapter matches combo keys when modifier state was seen on a prior keydown', async () => {
  const hook = createHook();
  const actions = [];
  const hotkeys = createHotkeyAdapter({
    next: 'Shift+ArrowRight',
    prev: 'Shift+ArrowLeft',
    hook,
    keyMap: {
      ArrowRight: 57421,
      ArrowLeft: 57419,
      Shift: 42,
      ShiftRight: 54,
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  hotkeys.on('action', (action) => actions.push(action));
  await hotkeys.start();

  hook.emit('keydown', { keycode: 42, shiftKey: true });
  hook.emit('keydown', { keycode: 57421, shiftKey: false });
  hook.emit('keyup', { keycode: 42, shiftKey: false });

  assert.deepEqual(actions, [{ type: 'next' }]);
});
