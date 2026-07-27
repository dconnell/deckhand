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
      options: cliOptions,
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
      return 1;
    }

    if (canvasPolicy.action === 'set') {
      await obs.call('SetVideoSettings', {
        baseWidth: canvasPolicy.usesCanvas.width,
        baseHeight: canvasPolicy.usesCanvas.height,
      });
      logger.info('Updated OBS canvas to match presenter stage', { canvas: canvasPolicy.usesCanvas });
    }

    if (cliOptions.check) {
      logger.info('OBS check completed without applying changes', { canvas: canvasPolicy.usesCanvas });
      return canvasPolicy.action === 'ok' ? 0 : 1;
    }

    const sceneDefinitions = buildObsSceneDefinitions(config, canvasPolicy.usesCanvas);
    const sceneList = await obs.call('GetSceneList');
    const existingScenes = new Set(sceneList.scenes.map((scene) => scene.sceneName));
    const inputList = await obs.call('GetInputList');
    const existingInputs = new Set(inputList.inputs.map((entry) => entry.inputName));

    for (const scene of sceneDefinitions.scenes) {
      if (!existingScenes.has(scene.sceneName)) {
        await obs.call('CreateScene', { sceneName: scene.sceneName });
        existingScenes.add(scene.sceneName);
        logger.info('Created OBS scene', { scene: scene.sceneName });
      }

      const sceneRefs = await createSceneReferences(obs, scene, existingInputs);

      for (const item of scene.items) {
        let sceneItemId;

        if (!sceneRefs.existingInputs.has(item.sourceName)) {
          const created = await obs.call('CreateInput', {
            sceneItemEnabled: true,
            sceneName: scene.sceneName,
            inputKind: kind,
            inputName: item.sourceName,
            inputSettings: {},
          });
          sceneItemId = created.sceneItemId;
          sceneRefs.existingInputs.add(item.sourceName);
          logger.info('Created OBS input', { kind, source: item.sourceName });
        } else {
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

    logger.info('OBS setup complete', {
      canvas: canvasPolicy.usesCanvas,
      scenes: sceneDefinitions.scenes.map((scene) => scene.sceneName),
      sources: sceneDefinitions.sources,
    });
    return 0;
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
