import { OBSWebSocket } from 'obs-websocket-js/json';

import { ConfigError, loadConfig } from './config.js';
import {
  buildObsSceneDefinitions,
  evaluateCanvasPolicy,
  getExpectedPresenterCanvas,
  parseSetupObsOptions,
} from './obsSetupPlan.js';
import {
  computeDesiredManagedNames,
  computeManagedPruneSet,
  deckhandInputName,
  isDeckhandManagedName,
} from './obsNames.js';
import { resolvePresentationPaths } from './presentations.js';
import { loadPresentationConfig } from './presentations.js';

function createNoopLogger() {
  return {
    error() {},
    info() {},
    warn() {},
  };
}

function createConsoleLogger(consoleLike) {
  return {
    error(message, context) {
      consoleLike.error(context === undefined ? message : `${message} ${JSON.stringify(context)}`);
    },
    info(message, context) {
      consoleLike.log(context === undefined ? message : `${message} ${JSON.stringify(context)}`);
    },
    warn(message, context) {
      consoleLike.warn(context === undefined ? message : `${message} ${JSON.stringify(context)}`);
    },
  };
}

export function buildMacWindowCaptureSettings(binding) {
  const settings = {
    owner_name: binding.app,
    window: 0,
  };

  if (binding.titleIncludes !== undefined) {
    settings.window_name = binding.titleIncludes;
  }

  if (binding.pid !== undefined) {
    settings.owner_pid = binding.pid;
  }

  if (binding.macWindowId !== undefined) {
    settings.window = binding.macWindowId;
  }

  return settings;
}

function buildPresenterWindowSettings(config, sourceId, windowBindings = {}) {
  const binding = config.presenter?.windows?.[sourceId];
  const runtimeBinding = windowBindings[sourceId];

  if (binding === undefined && runtimeBinding === undefined) {
    return {};
  }

  return buildMacWindowCaptureSettings({
    ...(binding ?? {}),
    ...(runtimeBinding ?? {}),
  });
}

function buildAllBrowserSourceSettings(config, windowBindings = {}) {
  const result = {};

  if (config.presenter === null || config.sources === undefined) {
    return result;
  }

  for (const [sourceId, source] of Object.entries(config.sources)) {
    if (source?.kind !== 'browser') {
      continue;
    }

    result[sourceId] = buildPresenterWindowSettings(config, sourceId, windowBindings);
  }

  return result;
}

/**
 * Pick the OBS input kind for a logical source on the host platform.
 *
 * macOS uses `window_capture` for presenter windows. On other platforms the
 * operator may need to adjust the source type after creation.
 *
 * @param {string} platform OBS platform string.
 * @returns {string}
 */
export function kindForPlatform(platform) {
  const normalized = String(platform ?? '').toLowerCase();

  if (normalized.includes('linux')) {
    return 'xcomposite_input';
  }

  return 'window_capture';
}

function isInputNameConflictError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists by that input name/i.test(message);
}

function isSceneItemCreateFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (typeof error === 'object' && error !== null && 'code' in error)
    ? error.code
    : null;
  return code === 700 || /failed to create the scene item/i.test(message);
}

async function createInputWithRetry(obs, payload, logger, { retries = 5, retryDelayMs = 100 } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await obs.call('CreateInput', payload);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isInputNameConflictError(error) || attempt >= retries) {
        throw lastError;
      }

      logger.warn('OBS input name still reserved after removal; retrying CreateInput', {
        attempt,
        input: payload.inputName,
        retries,
      });

      await new Promise((resolve) => {
        setTimeout(resolve, retryDelayMs);
      });
    }
  }

  throw lastError ?? new Error('CreateInput failed after retries');
}

async function resetManagedObsState(obs, logger) {
  const sceneList = await obs.call('GetSceneList');
  const managedScenes = sceneList.scenes
    .map((scene) => scene.sceneName)
    .filter((sceneName) => isDeckhandManagedName(sceneName));

  for (const sceneName of managedScenes) {
    try {
      await obs.call('RemoveScene', { sceneName });
      logger.warn('Removed Deckhand OBS scene during recovery reset', { scene: sceneName });
    } catch (error) {
      logger.warn('Failed to remove Deckhand OBS scene during recovery reset', {
        error: error instanceof Error ? error.message : String(error),
        scene: sceneName,
      });
    }
  }

  async function removeManagedInput(entry) {
    const removePayload = entry.inputUuid === undefined
      ? { inputName: entry.inputName }
      : { inputUuid: entry.inputUuid };

    try {
      await obs.call('RemoveInput', removePayload);
    } catch (error) {
      logger.warn('Failed to remove Deckhand OBS input during recovery reset', {
        error: error instanceof Error ? error.message : String(error),
        input: entry.inputName,
      });
    }
  }

  let inputList = await obs.call('GetInputList');
  let managedInputs = inputList.inputs.filter((entry) => isDeckhandManagedName(entry.inputName));

  for (const entry of managedInputs) {
    await removeManagedInput(entry);
  }

  const maxRemovalPollAttempts = 20;
  const pollDelayMs = 250;
  for (let attempt = 1; attempt <= maxRemovalPollAttempts; attempt += 1) {
    inputList = await obs.call('GetInputList');
    managedInputs = inputList.inputs.filter((entry) => isDeckhandManagedName(entry.inputName));

    if (managedInputs.length === 0) {
      return;
    }

    if (attempt < maxRemovalPollAttempts) {
      for (const entry of managedInputs) {
        await removeManagedInput(entry);
      }

      await new Promise((resolve) => {
        setTimeout(resolve, pollDelayMs);
      });
    }
  }

  logger.warn('Deckhand OBS inputs remained after reset; renaming stale inputs to unblock reconcile', {
    inputs: managedInputs.map((entry) => entry.inputName),
  });

  const suffix = Date.now();
  for (const [index, entry] of managedInputs.entries()) {
    const renamePayload = entry.inputUuid === undefined
      ? { inputName: entry.inputName }
      : { inputUuid: entry.inputUuid };

    try {
      await obs.call('SetInputName', {
        ...renamePayload,
        newInputName: `${entry.inputName}__orphan_${suffix}_${index}`,
      });
    } catch (error) {
      logger.warn('Failed to rename stale Deckhand OBS input during recovery reset', {
        error: error instanceof Error ? error.message : String(error),
        input: entry.inputName,
      });
    }
  }
}

async function createSceneReferences(obs, scene, existingInputs) {
  const sceneItemList = await obs.call('GetSceneItemList', { sceneName: scene.sceneName });
  const itemsBySource = new Map();

  for (const item of sceneItemList.sceneItems) {
    const queue = itemsBySource.get(item.sourceName) ?? [];
    queue.push(item.sceneItemId);
    itemsBySource.set(item.sourceName, queue);
  }

  return {
    itemsBySource,
    sceneItems: sceneItemList.sceneItems,
    existingInputs,
  };
}

async function pruneSceneItems(obs, scene, logger) {
  const sceneItemList = await obs.call('GetSceneItemList', { sceneName: scene.sceneName });
  const desiredCounts = new Map();

  for (const item of scene.items) {
    desiredCounts.set(item.sourceName, (desiredCounts.get(item.sourceName) ?? 0) + 1);
  }

  for (const item of sceneItemList.sceneItems) {
    const remaining = desiredCounts.get(item.sourceName) ?? 0;

    if (remaining > 0) {
      desiredCounts.set(item.sourceName, remaining - 1);
      continue;
    }

    await obs.call('RemoveSceneItem', {
      sceneItemId: item.sceneItemId,
      sceneName: scene.sceneName,
    });
    logger.info('Removed stale OBS scene item', {
      scene: scene.sceneName,
      source: item.sourceName,
    });
  }
}

async function ensureManagedInput(
  obs,
  scene,
  item,
  existingInputs,
  kind,
  inputKindByName,
  inputSettings,
  logger,
  { strictWindowBinding = false } = {},
) {
  const existingKind = inputKindByName.get(item.sourceName) ?? null;

  if (!existingInputs.has(item.sourceName)) {
    const created = await createInputWithRetry(obs, {
      sceneItemEnabled: true,
      sceneName: scene.sceneName,
      inputKind: kind,
      inputName: item.sourceName,
      inputSettings,
    }, logger);
    existingInputs.add(item.sourceName);
    inputKindByName.set(item.sourceName, kind);
    logger.info('Created OBS input', { kind, source: item.sourceName });
    return created.sceneItemId;
  }

  if (existingKind !== null && existingKind !== kind) {
    await obs.call('RemoveInput', { inputName: item.sourceName });
    logger.info('Removed OBS input with unexpected kind', {
      expectedKind: kind,
      inputKind: existingKind,
      source: item.sourceName,
    });

    const recreated = await createInputWithRetry(obs, {
      sceneItemEnabled: true,
      sceneName: scene.sceneName,
      inputKind: kind,
      inputName: item.sourceName,
      inputSettings,
    }, logger);
    inputKindByName.set(item.sourceName, kind);
    logger.info('Recreated OBS input', { kind, source: item.sourceName });
    return recreated.sceneItemId;
  }

  if (strictWindowBinding && typeof inputSettings.window === 'number' && inputSettings.window > 0) {
    await obs.call('SetInputSettings', {
      inputName: item.sourceName,
      inputSettings: {
        ...inputSettings,
        window: 0,
      },
      overlay: false,
    });
  }

  await obs.call('SetInputSettings', {
    inputName: item.sourceName,
    inputSettings,
    overlay: false,
  });

  return null;
}

export async function reconcileObsPresentation({
  config,
  logger,
  obs,
  canvasOptions = { check: false, setCanvas: false },
  windowBindings = {},
  _recovery = { resetAttempted: false },
}) {
  const version = await obs.call('GetVersion');
  const kind = kindForPlatform(version.platform);
  const video = await obs.call('GetVideoSettings');
  const actualCanvas = {
    width: Number(video.baseWidth),
    height: Number(video.baseHeight),
  };
  const expectedCanvas = getExpectedPresenterCanvas(config);
  const canvasPolicy = evaluateCanvasPolicy({
    actual: actualCanvas,
    expected: expectedCanvas,
    options: canvasOptions,
  });

  if (canvasPolicy.action === 'warn') {
    logger.warn(canvasPolicy.warning, {
      actualCanvas,
      expectedCanvas,
    });
  }

  if (canvasPolicy.action === 'fail') {
    logger.error(canvasPolicy.error, {
      actualCanvas,
      expectedCanvas,
    });
    return { canvasPolicy, failed: true };
  }

  if (canvasPolicy.action === 'set') {
    await obs.call('SetVideoSettings', {
      baseWidth: canvasPolicy.usesCanvas.width,
      baseHeight: canvasPolicy.usesCanvas.height,
    });
    logger.info('Updated OBS canvas to match presenter stage', { canvas: canvasPolicy.usesCanvas });
  }

  if (canvasOptions.check) {
    logger.info('OBS check completed without applying changes', { canvas: canvasPolicy.usesCanvas });
    return { canvasPolicy, failed: false };
  }

  const sceneDefinitions = buildObsSceneDefinitions(config, canvasPolicy.usesCanvas);
  const sceneList = await obs.call('GetSceneList');
  const existingScenes = new Set(sceneList.scenes.map((scene) => scene.sceneName));
  const inputList = await obs.call('GetInputList');
  const existingInputs = new Set(inputList.inputs.map((entry) => entry.inputName));
  const inputKindByName = new Map(inputList.inputs.map((entry) => [entry.inputName, entry.inputKind]));

  try {
    if (config.obs?.prune !== false) {
      const desired = computeDesiredManagedNames(config);
      const prune = computeManagedPruneSet({
        existingInputs: [...existingInputs],
        existingScenes: [...existingScenes],
        desired,
      });

      for (const sceneName of prune.scenes) {
        try {
          await obs.call('RemoveScene', { sceneName });
          existingScenes.delete(sceneName);
          logger.info('Pruned stale Deckhand OBS scene', { scene: sceneName });
        } catch (error) {
          logger.warn('Failed to prune stale Deckhand OBS scene', {
            error: error instanceof Error ? error.message : String(error),
            scene: sceneName,
          });
        }
      }

      for (const inputName of prune.inputs) {
        try {
          await obs.call('RemoveInput', { inputName });
          existingInputs.delete(inputName);
          inputKindByName.delete(inputName);
          logger.info('Pruned stale Deckhand OBS input', { input: inputName });
        } catch (error) {
          logger.warn('Failed to prune stale Deckhand OBS input', {
            error: error instanceof Error ? error.message : String(error),
            input: inputName,
          });
        }
      }
    }

    for (const scene of sceneDefinitions.scenes) {
      if (!existingScenes.has(scene.sceneName)) {
        await obs.call('CreateScene', { sceneName: scene.sceneName });
        existingScenes.add(scene.sceneName);
        logger.info('Created OBS scene', { scene: scene.sceneName });
      }

      await pruneSceneItems(obs, scene, logger);
      const sceneRefs = await createSceneReferences(obs, scene, existingInputs);

      for (const item of scene.items) {
        const inputSettings = buildPresenterWindowSettings(config, item.source, windowBindings);
        const strictWindowBinding = windowBindings[item.source]?.strict === true
          && windowBindings[item.source]?.macWindowId !== undefined;
        let sceneItemId = await ensureManagedInput(
          obs,
          scene,
          item,
          sceneRefs.existingInputs,
          kind,
          inputKindByName,
          inputSettings,
          logger,
          { strictWindowBinding },
        );

        if (sceneItemId === null) {
          const queue = sceneRefs.itemsBySource.get(item.sourceName);

          if (queue && queue.length > 0) {
            sceneItemId = queue.shift();
          } else {
            const referenced = await obs.call('CreateSceneItem', {
              sceneItemEnabled: true,
              sceneName: scene.sceneName,
              sourceName: item.sourceName,
            });
            sceneItemId = referenced.sceneItemId;
          }
        }

        await obs.call('SetSceneItemTransform', {
          sceneItemId,
          sceneName: scene.sceneName,
          sceneItemTransform: item.transform,
        });
      }
    }

    const allBrowserSettings = buildAllBrowserSourceSettings(config, windowBindings);
    for (const [sourceId, inputSettings] of Object.entries(allBrowserSettings)) {
      const inputName = deckhandInputName(sourceId);
      if (existingInputs.has(inputName)) {
        await obs.call('SetInputSettings', {
          inputName,
          inputSettings,
          overlay: false,
        });
      }
    }

    logger.info('OBS setup complete', {
      canvas: canvasPolicy.usesCanvas,
      scenes: sceneDefinitions.scenes.map((scene) => scene.sceneName),
      sources: sceneDefinitions.sources,
    });

    return { canvasPolicy };
  } catch (error) {
    if (!_recovery.resetAttempted && isSceneItemCreateFailure(error)) {
      logger.warn('OBS rejected scene item creation; resetting Deckhand OBS state and retrying once', {
        error: error instanceof Error ? error.message : String(error),
      });

      await resetManagedObsState(obs, logger);
      return reconcileObsPresentation({
        config,
        logger,
        obs,
        canvasOptions,
        windowBindings,
        _recovery: { resetAttempted: true },
      });
    }

    throw error;
  }
}

/**
 * Apply or validate OBS setup from normalized layouts.
 *
 * @param {{ config?: Awaited<ReturnType<typeof loadConfig>>, configPath?: string, cwd?: string, logger?: { info(message: string, context?: Record<string, unknown>): void, warn(message: string, context?: Record<string, unknown>): void, error(message: string, context?: Record<string, unknown>): void }, OBSWebSocketClass?: new () => { connect(url: string, password?: string): Promise<unknown>, disconnect(): Promise<unknown>, call(method: string, payload?: Record<string, unknown>): Promise<unknown> }, options?: { check?: boolean, presentationName?: string, setCanvas?: boolean } }} [input] Setup options.
 * @returns {Promise<number>}
 */
export async function setupObs(input = {}) {
  const logger = input.logger ?? createNoopLogger();
  const OBSWebSocketClass = input.OBSWebSocketClass ?? OBSWebSocket;
  const cwd = input.cwd ?? process.cwd();
  let cliOptions;

  if (input.options !== undefined) {
    cliOptions = input.options;
  } else if (input.config !== undefined || input.configPath !== undefined) {
    cliOptions = {
      check: false,
      presentationName: input.presentationName ?? 'example',
      setCanvas: false,
    };
  } else {
    try {
      cliOptions = parseSetupObsOptions(process.argv.slice(2));
    } catch (error) {
      logger.error('Invalid setup:obs options', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 1;
    }
  }

  const presentationName = input.presentationName ?? input.options?.presentationName ?? cliOptions.presentationName ?? 'example';
  const resolvedConfigPath = input.configPath
    ?? process.env.DECKHAND_CONFIG
    ?? resolvePresentationPaths({ cwd, presentationName }).configPath;
  let config = input.config;

  if (config === undefined) {
    try {
      if (input.configPath === undefined) {
        config = (await loadPresentationConfig({ cwd, presentationName })).config;
      } else {
        config = await loadConfig({ filePath: resolvedConfigPath });
      }
    } catch (error) {
      if (error instanceof ConfigError) {
        logger.error(`Invalid configuration at ${error.path}: ${error.message}`);
        return 1;
      }

      logger.error('Failed to load OBS setup config', {
        error: error instanceof Error ? error.message : String(error),
        filePath: resolvedConfigPath,
      });
      return 1;
    }
  }

  const obs = new OBSWebSocketClass();

  try {
    await obs.connect(config.obs.url, config.obs.password);
    logger.info('Connected to OBS', { url: config.obs.url });

    const result = await reconcileObsPresentation({
      config,
      logger,
      obs,
      canvasOptions: cliOptions,
    });
    return result.failed ? 1 : 0;
  } catch (error) {
    logger.error('OBS setup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  } finally {
    try {
      await obs.disconnect();
    } catch {
      // ignore disconnect cleanup failures
    }
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const exitCode = await setupObs({ logger: createConsoleLogger(console) });
  process.exitCode = exitCode;
}
