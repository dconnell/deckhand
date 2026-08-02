import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DECKHAND_PREFIX,
  deckhandInputName,
  deckhandSceneName,
  isDeckhandManagedName,
  computeDesiredManagedNames,
  computeManagedPruneSet,
} from '../../src/obsNames.js';

test('deckhandInputName and deckhandSceneName apply the Deckhand_ prefix', () => {
  assert.equal(DECKHAND_PREFIX, 'Deckhand_');
  assert.equal(deckhandInputName('BrowserA'), 'Deckhand_BrowserA');
  assert.equal(deckhandSceneName('Full Browser'), 'Deckhand_Full Browser');
});

test('isDeckhandManagedName matches only the Deckhand_ prefix', () => {
  assert.equal(isDeckhandManagedName('Deckhand_BrowserA'), true);
  assert.equal(isDeckhandManagedName('Deckhand_Full Browser'), true);
  assert.equal(isDeckhandManagedName('BrowserA'), false);
  assert.equal(isDeckhandManagedName('Deckhand Freeze'), false);
  assert.equal(isDeckhandManagedName(''), false);
  assert.equal(isDeckhandManagedName(undefined), false);
});

function createConfig({ sources = ['Slide', 'BrowserA'], scenes = ['Full Slide', 'Dual Browser'], transitions = null, freezeScene = 'Deckhand_Freeze', freezeImage = 'Deckhand_Freeze Frame' } = {}) {
  return {
    layouts: scenes.map((audienceScene, index) => ({
      audienceScene,
      slots: [{ source: sources[index] ?? sources[0], position: 'full' }],
    })),
    obs: { transitions: transitions === null ? null : { freezeScene, freezeImage, ...(transitions ?? {}) } },
  };
}

test('computeDesiredManagedNames prefixes layout sources and audience scenes', () => {
  const desired = computeDesiredManagedNames(createConfig());

  assert.deepEqual([...desired.inputs].sort(), ['Deckhand_BrowserA', 'Deckhand_Slide']);
  assert.deepEqual([...desired.scenes].sort(), ['Deckhand_Dual Browser', 'Deckhand_Full Slide']);
});

test('computeDesiredManagedNames includes freeze assets when transitions are configured', () => {
  const desired = computeDesiredManagedNames(createConfig({
    transitions: { forward: 'Slide Right', backward: 'Slide Left' },
    freezeScene: 'Deckhand_Freeze',
    freezeImage: 'Deckhand_Freeze Frame',
  }));

  assert.ok(desired.inputs.has('Deckhand_Freeze Frame'));
  assert.ok(desired.scenes.has('Deckhand_Freeze'));
});

test('computeDesiredManagedNames omits freeze assets when transitions are absent', () => {
  const desired = computeDesiredManagedNames(createConfig({ transitions: null }));

  assert.equal(desired.inputs.has('Deckhand_Freeze Frame'), false);
  assert.equal(desired.scenes.has('Deckhand_Freeze'), false);
});

test('computeManagedPruneSet removes only Deckhand_ entities absent from the desired set', () => {
  const desired = computeDesiredManagedNames(createConfig({
    sources: ['RandomAppA'],
    scenes: ['Full RandomAppA'],
    transitions: { forward: 'Slide Right', backward: 'Slide Left' },
  }));

  const result = computeManagedPruneSet({
    existingInputs: ['Deckhand_RandomAppA', 'Deckhand_RandomAppB', 'Deckhand_RandomAppC', 'MyPersonalInput', 'Deckhand_Freeze Frame'],
    existingScenes: ['Deckhand_Full RandomAppA', 'Deckhand_Full RandomAppB', 'MyIntroScene', 'Deckhand_Freeze'],
    desired,
  });

  assert.deepEqual(result.inputs.sort(), ['Deckhand_RandomAppB', 'Deckhand_RandomAppC']);
  assert.deepEqual(result.scenes.sort(), ['Deckhand_Full RandomAppB']);
});

test('computeManagedPruneSet keeps freeze assets when transitions are configured', () => {
  const desired = computeDesiredManagedNames(createConfig({
    sources: ['RandomAppA'],
    scenes: ['Full RandomAppA'],
    transitions: { forward: 'Slide Right', backward: 'Slide Left' },
  }));

  const result = computeManagedPruneSet({
    existingInputs: ['Deckhand_RandomAppA', 'Deckhand_Freeze Frame'],
    existingScenes: ['Deckhand_Full RandomAppA', 'Deckhand_Freeze'],
    desired,
  });

  assert.deepEqual(result.inputs, []);
  assert.deepEqual(result.scenes, []);
});

test('computeManagedPruneSet never returns non-Deckhand entities', () => {
  const desired = computeDesiredManagedNames(createConfig({ sources: [], scenes: [] }));

  const result = computeManagedPruneSet({
    existingInputs: ['BrowserA', 'MyInput', 'Deckhand_Old'],
    existingScenes: ['Full Browser', 'MyScene', 'Deckhand_Old Scene'],
    desired,
  });

  assert.deepEqual(result.inputs, ['Deckhand_Old']);
  assert.deepEqual(result.scenes, ['Deckhand_Old Scene']);
});
