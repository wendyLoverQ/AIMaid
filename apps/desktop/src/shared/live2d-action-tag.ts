export type Live2DActionTagDefinition = {
  motionGroups: string[];
  expressions: string[];
  fallback?: string;
};

export type Live2DActionTagMap = Record<string, Live2DActionTagDefinition>;

export type ResolvedLive2DAction = {
  requestedTag: string;
  resolvedTag: string;
  motionGroup: string | null;
  expression: string | null;
};

const ACTION_TAG_MAP_URL = 'aimaid-asset://ui/config/live2d_action_tag_map.json';
let cachedActionTagMap: Promise<Live2DActionTagMap> | null = null;

export function loadLive2DActionTagMap(): Promise<Live2DActionTagMap> {
  cachedActionTagMap ??= fetchActionTagMap();
  return cachedActionTagMap;
}

export function resolveLive2DAction(
  map: Live2DActionTagMap,
  requestedTag: string,
  availableMotionGroups: Iterable<string>,
  availableExpressions: Iterable<string>,
  preferredMotionGroups: readonly string[] = []
): ResolvedLive2DAction | null {
  const motions = caseInsensitiveLookup(availableMotionGroups);
  const expressions = caseInsensitiveLookup(availableExpressions);
  const visited = new Set<string>();
  const normalizedRequestedTag = requestedTag.trim().toLowerCase();
  let tag = normalizedRequestedTag;

  while (tag !== '' && !visited.has(tag)) {
    visited.add(tag);
    const definition = map[tag];
    if (definition === undefined) throw new Error(`Unknown Live2D action tag: ${requestedTag}`);

    const motionCandidates = tag === normalizedRequestedTag
      ? [...preferredMotionGroups, ...definition.motionGroups]
      : definition.motionGroups;
    const motionGroup = firstAvailable(motionCandidates, motions);
    const expression = firstAvailable(definition.expressions, expressions);
    if (motionGroup !== null || expression !== null) {
      return { requestedTag, resolvedTag: tag, motionGroup, expression };
    }
    tag = definition.fallback?.trim().toLowerCase() ?? '';
  }

  return null;
}

async function fetchActionTagMap(): Promise<Live2DActionTagMap> {
  const response = await fetch(ACTION_TAG_MAP_URL);
  if (!response.ok) throw new Error(`Live2D action map request failed: HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error('Live2D action map must be a JSON object');

  const result: Live2DActionTagMap = {};
  for (const [tag, value] of Object.entries(payload)) {
    if (tag.startsWith('_')) continue;
    if (!isRecord(value)) throw new Error(`Live2D action tag ${tag} must be an object`);
    const motionGroups = readStringList(value.motionGroups, value.motionGroup);
    const expressions = readStringList(value.expressions, value.expression);
    const fallback = typeof value.fallback === 'string' && value.fallback.trim() !== ''
      ? value.fallback.trim().toLowerCase()
      : undefined;
    result[tag.toLowerCase()] = { motionGroups, expressions, ...(fallback === undefined ? {} : { fallback }) };
  }

  for (const required of ['idle', 'touch_head', 'touch_body']) {
    if (result[required] === undefined) throw new Error(`Live2D action map is missing required tag: ${required}`);
  }
  return result;
}

function readStringList(plural: unknown, singular: unknown): string[] {
  const values = Array.isArray(plural) ? plural : singular === undefined ? [] : [singular];
  if (!values.every((value) => typeof value === 'string' && value.trim() !== '')) {
    throw new Error('Live2D action candidates must be non-empty strings');
  }
  return values.map((value) => (value as string).trim());
}

function caseInsensitiveLookup(values: Iterable<string>): Map<string, string> {
  return new Map([...values].map((value) => [value.toLowerCase(), value]));
}

function firstAvailable(candidates: readonly string[], available: Map<string, string>): string | null {
  for (const candidate of candidates) {
    const match = available.get(candidate.toLowerCase());
    if (match !== undefined) return match;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
