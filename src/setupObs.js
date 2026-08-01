import { OBSWebSocket } from 'obs-websocket-js/json';

import { ConfigError, loadConfig } from './config.js';
import {
  buildObsSceneDefinitions,
  evaluateCanvasPolicy,
  getExpectedPresenterCanvas,
  parseSetupObsOptions,
} from './obsSetupPlan.js';
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

function buildPresenterWindowSettings(config, sourceName, windowBindings = {}) {
  const binding = config.presenter?.windows?.[sourceName];
  const runtimeBinding = windowBindings[sourceName];

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

async function ensureManagedInput(obs, scene, item, existingInputs, kind, inputKindByName, inputSettings, logger) {
  const existingKind = inputKindByName.get(item.sourceName) ?? null;

  if (!existingInputs.has(item.sourceName)) {
    const created = await obs.call('CreateInput', {
      sceneItemEnabled: true,
      sceneName: scene.sceneName,
      inputKind: kind,
      inputName: item.sourceName,
      inputSettings,
    });
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

    const recreated = await obs.call('CreateInput', {
      sceneItemEnabled: true,
      sceneName: scene.sceneName,
      inputKind: kind,
      inputName: item.sourceName,
      inputSettings,
    });
    inputKindByName.set(item.sourceName, kind);
    logger.info('Recreated OBS input', { kind, source: item.sourceName });
    return recreated.sceneItemId;
  }

  await obs.call('SetInputSettings', {
    inputName: item.sourceName,
    inputSettings,
    overlay: true,
  });

  return null;
}

export async function reconcileObsPresentation({ config, logger, obs, canvasOptions = { check: false, setCanvas: false }, windowBindings = {} }) {
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

  for (const scene of sceneDefinitions.scenes) {
    if (!existingScenes.has(scene.sceneName)) {
      await obs.call('CreateScene', { sceneName: scene.sceneName });
      existingScenes.add(scene.sceneName);
      logger.info('Created OBS scene', { scene: scene.sceneName });
    }

    await pruneSceneItems(obs, scene, logger);
    const sceneRefs = await createSceneReferences(obs, scene, existingInputs);

    for (const item of scene.items) {
      const inputSettings = buildPresenterWindowSettings(config, item.sourceName, windowBindings);
      let sceneItemId = await ensureManagedInput(obs, scene, item, sceneRefs.existingInputs, kind, inputKindByName, inputSettings, logger);

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
    if (existingInputs.has(sourceId)) {
      await obs.call('SetInputSettings', {
        inputName: sourceId,
        inputSettings,
        overlay: true,
      });
    }
  }

  logger.info('OBS setup complete', {
    canvas: canvasPolicy.usesCanvas,
    scenes: sceneDefinitions.scenes.map((scene) => scene.sceneName),
    sources: sceneDefinitions.sources,
  });

  return { canvasPolicy };
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
