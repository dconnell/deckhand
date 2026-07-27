function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readDeckhandId(slide) {
  const value = slide?.dataset?.deckhandId;

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Built-in metadata for the `reveal.js` driver boundary.
 *
 * @type {{ name: string, kind: 'driver', capabilities: string[] }}
 */
export const revealjsDriver = Object.freeze({
  name: 'revealjs',
  kind: 'driver',
  capabilities: ['next', 'prev', 'goTo'],
});

/**
 * Normalize a reveal.js position payload into the shared slide identifier shape.
 *
 * @param {{ currentSlide?: { dataset?: Record<string, string> }, indexh?: number, indexv?: number }} position The reveal.js event payload.
 * @returns {{ id: string, idSource: 'data-deckhand-id' | 'index', indexh: number, indexv: number }}
 */
export function deriveRevealSlideId(position) {
  const indexh = Number.isInteger(position?.indexh) ? position.indexh : 0;
  const indexv = Number.isInteger(position?.indexv) ? position.indexv : 0;
  const explicitId = readDeckhandId(position?.currentSlide);

  if (explicitId !== null) {
    return {
      id: explicitId,
      idSource: 'data-deckhand-id',
      indexh,
      indexv,
    };
  }

  return {
    id: `${indexh}.${indexv}`,
    idSource: 'index',
    indexh,
    indexv,
  };
}

/**
 * Build the normalized driver position message sent to the coordinator hub.
 *
 * @param {{ currentSlide?: { dataset?: Record<string, string> }, indexh?: number, indexv?: number }} position The reveal.js event payload.
 * @returns {{ type: 'positionChanged', position: { id: string, index: { h: number, v: number }, meta: { idSource: string, indexh: number, indexv: number } } }}
 */
export function buildRevealPositionChangedMessage(position) {
  const normalized = deriveRevealSlideId(position);

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

/**
 * Find duplicate explicit deckhand identifiers in a reveal.js deck.
 *
 * @param {Array<{ dataset?: Record<string, string> }>} slides Slides to inspect.
 * @returns {string[]} Duplicate identifiers.
 */
export function findDuplicateDeckhandIds(slides) {
  const seen = new Set();
  const duplicates = new Set();

  for (const slide of slides) {
    const deckhandId = readDeckhandId(slide);

    if (deckhandId === null) {
      continue;
    }

    if (seen.has(deckhandId)) {
      duplicates.add(deckhandId);
      continue;
    }

    seen.add(deckhandId);
  }

  return [...duplicates];
}

/**
 * Resolve a `goTo(id)` request into reveal.js slide indices.
 *
 * @param {string} id The configured slide identifier.
 * @param {Array<{ dataset?: Record<string, string>, indexh?: number, indexv?: number }>} slides Indexed slide metadata.
 * @returns {{ indexh: number, indexv: number } | null}
 */
export function resolveRevealGoTo(id, slides) {
  const targetId = String(id);

  for (const slide of slides) {
    if (readDeckhandId(slide) === targetId) {
      return {
        indexh: Number.isInteger(slide.indexh) ? slide.indexh : 0,
        indexv: Number.isInteger(slide.indexv) ? slide.indexv : 0,
      };
    }
  }

  const fallbackMatch = /^(\d+)\.(\d+)$/.exec(targetId);

  if (fallbackMatch === null) {
    return null;
  }

  return {
    indexh: Number(fallbackMatch[1]),
    indexv: Number(fallbackMatch[2]),
  };
}

/**
 * Validate an inbound reveal.js driver command.
 *
 * @param {unknown} command The command payload received from the coordinator.
 * @returns {{ type: 'next' } | { type: 'prev' } | { type: 'goTo', id: string }}
 */
export function validateRevealCommand(command) {
  if (!isPlainObject(command)) {
    throw new TypeError('Reveal command must be an object');
  }

  if (command.type === 'next' || command.type === 'prev') {
    return { type: command.type };
  }

  if (command.type === 'goTo') {
    if (typeof command.id !== 'string' || command.id.trim() === '') {
      throw new TypeError('Reveal goTo command must include an id');
    }

    return {
      type: 'goTo',
      id: command.id.trim(),
    };
  }

  throw new TypeError(`Unsupported reveal command type: ${String(command.type)}`);
}
