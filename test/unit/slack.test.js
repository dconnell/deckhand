import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSlackUri,
  buildSlackWebUrl,
  parseSlackUri,
  resolveSlackConfig,
  slackAdapter,
} from '../../src/apps/slack.js';

test('buildSlackUri composes a channel URL from structured config', () => {
  assert.equal(
    buildSlackUri({ target: 'channel', team: 'T14AN', id: 'C07HV' }),
    'slack://channel?team=T14AN&id=C07HV',
  );
});

test('buildSlackUri composes a user URL for direct messages', () => {
  assert.equal(
    buildSlackUri({ target: 'user', team: 'T14AN', id: 'U1234' }),
    'slack://user?team=T14AN&id=U1234',
  );
});

test('buildSlackUri defaults target to channel when omitted', () => {
  assert.equal(
    buildSlackUri({ team: 'T14AN', id: 'C07HV' }),
    'slack://channel?team=T14AN&id=C07HV',
  );
});

test('buildSlackUri rejects an unknown target', () => {
  assert.throws(
    () => buildSlackUri({ target: 'workspace', team: 'T14AN', id: 'C07HV' }),
    /unknown slack target/i,
  );
});

test('buildSlackUri rejects a missing team or id', () => {
  assert.throws(() => buildSlackUri({ id: 'C07HV' }), /team/i);
  assert.throws(() => buildSlackUri({ team: 'T14AN' }), /id/i);
});

test('parseSlackUri extracts target/team/id from a channel URI', () => {
  assert.deepEqual(
    parseSlackUri('slack://channel?team=T14AN&id=C07HV'),
    { target: 'channel', team: 'T14AN', id: 'C07HV' },
  );
});

test('parseSlackUri extracts target/team/id from a user URI', () => {
  assert.deepEqual(
    parseSlackUri('slack://user?team=T14AN&id=U1234'),
    { target: 'user', team: 'T14AN', id: 'U1234' },
  );
});

test('parseSlackUri rejects a non-slack scheme', () => {
  assert.throws(() => parseSlackUri('https://slack.com/channel'), /slack:/i);
  assert.throws(() => parseSlackUri('slack://'), /target/i);
});

test('parseSlackUri rejects a URI missing team or id', () => {
  assert.throws(() => parseSlackUri('slack://channel?id=C07HV'), /team/i);
  assert.throws(() => parseSlackUri('slack://channel?team=T14AN'), /id/i);
});

test('buildSlackWebUrl produces the https web client URL from team/id', () => {
  assert.equal(
    buildSlackWebUrl({ team: 'T14AN', id: 'C07HV' }),
    'https://app.slack.com/client/T14AN/C07HV',
  );
});

test('resolveSlackConfig normalizes a structured slack field', () => {
  assert.deepEqual(
    resolveSlackConfig({ slack: { target: 'user', team: 'T1', id: 'U1', newWindow: true } }),
    { target: 'user', team: 'T1', id: 'U1', newWindow: true },
  );
});

test('resolveSlackConfig defaults target to channel and newWindow to false for structured config', () => {
  assert.deepEqual(
    resolveSlackConfig({ slack: { team: 'T1', id: 'C1' } }),
    { target: 'channel', team: 'T1', id: 'C1', newWindow: false },
  );
});

test('resolveSlackConfig parses a raw slack:// uri and honors a sibling newWindow flag', () => {
  assert.deepEqual(
    resolveSlackConfig({ uri: 'slack://channel?team=T1&id=C1', newWindow: true }),
    { target: 'channel', team: 'T1', id: 'C1', newWindow: true },
  );
});

test('resolveSlackConfig returns null when neither slack nor uri is configured', () => {
  assert.equal(resolveSlackConfig({}), null);
  assert.equal(resolveSlackConfig({ app: 'Slack' }), null);
});

test('slackAdapter matches Slack only when channel config is present', () => {
  assert.equal(slackAdapter.matches({ app: 'Slack', slack: { team: 'T1', id: 'C1' } }), true);
  assert.equal(slackAdapter.matches({ app: 'Slack', uri: 'slack://channel?team=T1&id=C1' }), true);
  assert.equal(slackAdapter.matches({ app: 'Slack' }), false);
  assert.equal(slackAdapter.matches({ app: 'Slack', slack: {} }), false);
  assert.equal(slackAdapter.matches({ app: 'iTerm2', slack: { team: 'T1', id: 'C1' } }), false);
});

test('slackAdapter reports Google Chrome as the CGWindow owner in browser mode and Slack in navigation mode', () => {
  assert.equal(
    slackAdapter.cgWindowOwnerName({ app: 'Slack', slack: { team: 'T1', id: 'C1', newWindow: true } }),
    'Google Chrome',
  );
  assert.equal(
    slackAdapter.cgWindowOwnerName({ app: 'Slack', slack: { team: 'T1', id: 'C1' } }),
    'Slack',
  );
});

test('slackAdapter ownsWindow returns true only for browser mode', () => {
  assert.equal(
    slackAdapter.ownsWindow({ app: 'Slack', slack: { team: 'T1', id: 'C1', newWindow: true } }),
    true,
  );
  assert.equal(
    slackAdapter.ownsWindow({ app: 'Slack', slack: { team: 'T1', id: 'C1' } }),
    false,
  );
  assert.equal(
    slackAdapter.ownsWindow({ app: 'Slack', uri: 'slack://channel?team=T1&id=C1' }),
    false,
  );
});

test('slackAdapter buildBootstrapBinding uses Chrome with a Slack titleIncludes hint in browser mode', () => {
  assert.deepEqual(
    slackAdapter.buildBootstrapBinding(
      { app: 'Slack', slack: { team: 'T1', id: 'C1', newWindow: true } },
      {},
    ),
    { app: 'Google Chrome', titleIncludes: 'Slack' },
  );
});

test('slackAdapter buildBootstrapBinding preserves a configured titleIncludes in browser mode', () => {
  assert.deepEqual(
    slackAdapter.buildBootstrapBinding(
      { app: 'Slack', slack: { team: 'T1', id: 'C1', newWindow: true } },
      { titleIncludes: 'Q-A channel' },
    ),
    { app: 'Google Chrome', titleIncludes: 'Q-A channel' },
  );
});

test('slackAdapter buildBootstrapBinding uses Slack in navigation mode', () => {
  assert.deepEqual(
    slackAdapter.buildBootstrapBinding(
      { app: 'Slack', slack: { team: 'T1', id: 'C1' } },
      {},
    ),
    { app: 'Slack' },
  );
});

test('slackAdapter launch in browser mode routes through the Chrome window launcher', async () => {
  const calls = [];
  await slackAdapter.launch(
    { app: 'Slack', slack: { team: 'T1', id: 'C1', newWindow: true } },
    {
      launchChromeWindowWithUrl: (url) => {
        calls.push({ type: 'chrome', url });
        return Promise.resolve({ pid: 4242 });
      },
      launchAppWindow: (options) => {
        calls.push({ type: 'open', options });
        return Promise.resolve({});
      },
    },
  );

  assert.deepEqual(calls, [{ type: 'chrome', url: 'https://app.slack.com/client/T1/C1' }]);
});

test('slackAdapter launch in navigation mode opens the slack:// URL via the generic launcher', async () => {
  const calls = [];
  await slackAdapter.launch(
    { app: 'Slack', slack: { team: 'T1', id: 'C1' } },
    {
      launchChromeWindowWithUrl: () => {
        throw new Error('should not be called in navigation mode');
      },
      launchAppWindow: (options) => {
        calls.push(options);
        return Promise.resolve({});
      },
    },
  );

  assert.deepEqual(calls, [
    { app: 'Slack', openArgs: ['slack://channel?team=T1&id=C1'] },
  ]);
});

test('slackAdapter launch in navigation mode honors a raw uri field over the structured slack field', async () => {
  const calls = [];
  await slackAdapter.launch(
    { app: 'Slack', uri: 'slack://user?team=T9&id=U9' },
    {
      launchChromeWindowWithUrl: () => { throw new Error('should not be called'); },
      launchAppWindow: (options) => { calls.push(options); return Promise.resolve({}); },
    },
  );

  assert.deepEqual(calls, [
    { app: 'Slack', openArgs: ['slack://user?team=T9&id=U9'] },
  ]);
});

test('slackAdapter launch throws when neither slack nor uri config is present', async () => {
  await assert.rejects(
    slackAdapter.launch({ app: 'Slack' }, {}),
    /requires either/i,
  );
});
