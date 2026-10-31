/**
 * Models by analogy.
 *
 * The Models page can already add a model row, but only a row of the installed
 * catalog: an id the catalog does not describe therefore needs every field
 * spelled out by hand. This plugin turns that chore into one choice — pick an
 * installed model as the analogy, name the new one — and then writes the row
 * into `llm-pi-ai`'s own configuration through the settings seam.
 *
 * Why a separate route instead of the shipped `openrouter` route: a configured
 * `models` list *replaces* a catalog route's installed catalog wholesale
 * (`resolveRouteModels`, `entries = configured.length > 0 ? configured : defaults`).
 * Appending one model to `openrouter` would therefore mean materializing all
 * ~400 of its siblings into the profile. A hand-declared route with its own
 * `api`/`baseURL` costs a handful of lines and leaves the catalog alone.
 *
 * What is copied from the analogy, and what cannot be:
 *
 * - `contextWindow`, `maxTokens`, `input` and the offered reasoning levels come
 *   from `ctx.llm.resolveModel`, which is the seam's public view of an installed
 *   model;
 * - the *wire spelling* of each level and the `compat` switches do not ride on
 *   that view, so they come from this row's configuration (`thinkingFormat`,
 *   `offWire`, `supportsDeveloperRole`, `supportsStrictMode`) and default to what
 *   the installed catalog declares for OpenRouter models.
 *
 * The write goes through `ctx.settings.update`, so it persists into the
 * profile's `cordis.patch.yml` under the `llm-pi-ai` row, is validated against
 * that row's schema, and is applied live — no restart, no hand-edited YAML.
 */
import z from '@deepseek-ai/schemastery';

export const name = 'model-analogs';

/** Services this row answers; `webServer` carries the card's HTTP channel. */
export const inject = ['settings', 'llm', 'webServer'];

/** The reasoning levels pi-ai knows, in the order a profile should declare them. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Input modalities a model row may declare. */
const MODALITIES = ['text', 'image'];

/** Refuse a body larger than this; the card only ever sends a few fields. */
const MAX_BODY_BYTES = 1024 * 1024;

export const Config = z.object({
  /** Profile entry whose configuration receives the roster. */
  settingsNs: z.string().default('llm-pi-ai'),
  /** Route analogies are resolved from — a route the installed catalog serves. */
  catalogRoute: z.string().default('openrouter'),
  /** The hand-declared route this plugin owns. */
  route: z.string().default('openrouter-analog'),
  /** Provider name the Models page shows for that route. */
  routeName: z.string().default('OpenRouter (analogs)'),
  /** Credential reference the route authenticates with. */
  apiKeyEnv: z.string().default('OPENROUTER_API_KEY'),
  baseURL: z.string().default('https://openrouter.ai/api/v1'),
  api: z.string().default('openai-completions'),
  /** Wire dialect reasoning levels ride on. */
  thinkingFormat: z.string().default('openrouter'),
  /** Wire value that disables reasoning on this route. */
  supportsDeveloperRole: z.boolean().default(false),
  supportsStrictMode: z.boolean().default(true),
  offWire: z.string().default('none'),
  /**
   * The route's default output cap. An analog inherits it unless the card sets
   * one explicitly: the seam publishes `defaultMaxTokens` only for models whose
   * profile pinned a cap, so an installed model's own value is not discoverable.
   */
  defaultMaxTokens: z.number().step(1).min(1).default(32768),
  /** The card's HTTP channel. The client speaks the same path. */
  path: z.string().default('/model-analogs/api')
});

/**
 * Mount the card's HTTP channel.
 *
 * The channel is a plain prefix route on the Web server rather than
 * `connection.rpc.handle`: that seam registers through the context that read the
 * connection, which a plugin row cannot satisfy, while `webServer.register` on
 * this row's own context works and needs no protocol package.
 * @param ctx - the plugin context.
 * @param config - this row's configuration.
 */
export function apply(ctx, config) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: config.path,
    handler: (request, response) => serve(ctx, config, request, response)
  }));
}

/**
 * Answer one HTTP request from the card.
 *
 * Refusals travel as `{ error }` with status 200, so the card can show the
 * reason instead of a network failure.
 * @param ctx - the plugin context.
 * @param config - this row's configuration.
 * @param request - the node request.
 * @param response - the node response.
 */
async function serve(ctx, config, request, response) {
  try {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'POST only' });
      return;
    }
    const parsed = JSON.parse((await readBody(request)) || '{}');
    const method = typeof parsed?.method === 'string' ? parsed.method : '';
    const payload = isObject(parsed?.payload) ? parsed.payload : {};
    sendJson(response, 200, await dispatch(ctx, config, method, payload));
  } catch (error) {
    sendJson(response, 200, { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Route one method of the card's protocol.
 * @param ctx - the plugin context.
 * @param config - this row's configuration.
 * @param method - the request method name.
 * @param payload - its arguments.
 * @returns the answer, serialized as JSON.
 */
async function dispatch(ctx, config, method, payload) {
  if (method === 'state') return stateFor(ctx, config);
  if (method === 'catalog') return { catalog: await catalog(ctx, config) };
  if (method === 'analogy') return { analogy: await analogyOf(ctx, config, payload.like) };
  if (method === 'add') return addModel(ctx, config, payload);
  if (method === 'remove') return removeModel(ctx, config, payload);
  if (method === 'verify') return verifyModel(ctx, config, payload);
  throw new Error(`Unknown method "${method}"`);
}

/**
 * The card's whole view: the route's roster, the analogy catalog, and whether
 * this profile accepts writes at all.
 * @param ctx - the plugin context.
 * @param config - this row's configuration.
 * @returns the state the card renders.
 */
async function stateFor(ctx, config) {
  const section = readSection(ctx, config);
  const roster = Array.isArray(section.route?.models) ? section.route.models : [];
  return {
    route: config.route,
    routeName: config.routeName,
    catalogRoute: config.catalogRoute,
    configured: section.route !== undefined,
    writable: section.writable,
    defaultMaxTokens: config.defaultMaxTokens,
    models: roster.filter(isObject).map(viewOfEntry),
    catalog: await catalog(ctx, config)
  };
}

/**
 * The installed catalog a reader can pick an analogy from.
 * @param ctx - the plugin context.
 * @param config - this row's configuration.
 * @returns id/name pairs, alphabetical, empty when the route is unknown.
 */
async function catalog(ctx, config) {
  let infos;
  try {
    infos = await ctx.llm.listModels(config.catalogRoute);
  } catch {
    // A profile without that route has no analogies to offer; the card says so
    // instead of failing to load.
    return [];
  }
  return infos
    .filter((info) => typeof info?.id === 'string')
    .map((info) => ({ id: info.id, name: typeof info.name === 'string' ? info.name : info.id }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Resolve one installed model into the facts an analog inherits.
 * @param ctx - the plugin context.
 * @param config - this row's configuration.
 * @param like - the catalog model id serving as the analogy.
 * @returns the inherited fields plus the offered levels.
 */
async function analogyOf(ctx, config, like) {
  if (typeof like !== 'string' || like.trim().length === 0) throw new Error('Choose the model to copy');
  const info = await ctx.llm.resolveModelInfo(config.catalogRoute, like.trim());
  const levels = (info.reasoning?.efforts ?? [])
    .map((effort) => effort?.id)
    .filter((level) => THINKING_LEVELS.includes(level));
  return {
    like: like.trim(),
    name: typeof info.name === 'string' ? info.name : like.trim(),
    contextWindow: Number.isInteger(info.context?.contextWindow) ? info.context.contextWindow : undefined,
    maxTokens: Number.isInteger(info.defaultMaxTokens) ? info.defaultMaxTokens : undefined,
    input: (info.inputModalities ?? []).filter((modality) => MODALITIES.includes(modality)),
    levels
  };
}

/**
 * Upsert one analog onto the route and persist it.
 * @param ctx - the plugin context.
 * @param config - this row's configuration.
 * @param payload - `{ like, id, name?, copyReasoning? }`.
 * @returns the refreshed state.
 */
async function addModel(ctx, config, payload) {
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (id.length === 0) throw new Error('The new model needs an id');
  const analogy = await analogyOf(ctx, config, payload.like);
  const maxTokens = Number.isInteger(payload.maxTokens) && payload.maxTokens > 0 ? payload.maxTokens : undefined;
  const entry = {
    id,
    name: typeof payload.name === 'string' && payload.name.trim().length > 0 ? payload.name.trim() : analogy.name,
    ...analogy.contextWindow === undefined ? {} : { contextWindow: analogy.contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    input: analogy.input.length > 0 ? analogy.input : ['text'],
    // `false` says "this model does not reason"; an empty declaration is refused
    // by the schema, so a non-reasoning analogy must say so explicitly.
    reasoningEfforts: payload.copyReasoning === false ? false : effortsOf(analogy.levels, config)
  };
  const section = readSection(ctx, config);
  const current = Array.isArray(section.route?.models) ? section.route.models.filter(isObject) : [];
  await writeRoster(ctx, config, [...current.filter((row) => row.id !== id), entry]);
  return stateFor(ctx, config);
}

/**
 * Drop one analog from the route; the last removal releases the route itself,
 * because a declared route must list at least one model.
 * @param ctx - the plugin context.
 * @param config - this row's configuration.
 * @param payload - `{ id }`.
 * @returns the refreshed state.
 */
async function removeModel(ctx, config, payload) {
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (id.length === 0) throw new Error('Name the model to remove');
  const section = readSection(ctx, config);
  const current = Array.isArray(section.route?.models) ? section.route.models.filter(isObject) : [];
  const next = current.filter((row) => row.id !== id);
  if (next.length === 0) {
    await ctx.settings.mutate(config.settingsNs, [{ op: 'unset', path: ['providers', config.route] }]);
  } else {
    await writeRoster(ctx, config, next);
  }
  return stateFor(ctx, config);
}

/**
 * Resolve one analog through the live seam. This proves the route the plugin
 * just wrote is *serviceable* — models registered, protocol and credential
 * resolved — rather than merely stored in configuration.
 * @param ctx - the plugin context.
 * @param config - this row's configuration.
 * @param payload - `{ id }`.
 * @returns the capabilities the picker will see.
 */
async function verifyModel(ctx, config, payload) {
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (id.length === 0) throw new Error('Name the model to verify');
  const info = await ctx.llm.resolveModelInfo(config.route, id);
  return {
    provider: info.provider,
    id: info.id,
    name: info.name,
    contextWindow: info.context?.contextWindow,
    maxTokens: info.defaultMaxTokens,
    input: info.inputModalities ?? [],
    levels: (info.reasoning?.efforts ?? []).map((effort) => effort.id)
  };
}

/**
 * Persist one route's roster through the settings seam.
 *
 * `update` deep-merges into the row's configuration and replaces the `models`
 * array wholesale, which is exactly the shape of this write: every other
 * provider in the same row survives untouched.
 * @param ctx - the plugin context.
 * @param config - this row's configuration.
 * @param models - the complete roster to store.
 */
async function writeRoster(ctx, config, models) {
  await ctx.settings.update(config.settingsNs, {
    providers: {
      [config.route]: {
        displayName: config.routeName,
        apiKeyEnv: config.apiKeyEnv,
        api: config.api,
        baseURL: config.baseURL,
        defaultMaxTokens: config.defaultMaxTokens,
        compat: {
          thinkingFormat: config.thinkingFormat,
          supportsDeveloperRole: config.supportsDeveloperRole,
          supportsStrictMode: config.supportsStrictMode
        },
        models
      }
    }
  });
}

/**
 * Read the target row's live configuration.
 * @param ctx - the plugin context.
 * @param config - this row's configuration.
 * @returns the descriptor, its providers dict, this plugin's route, and whether writes are accepted.
 */
function readSection(ctx, config) {
  const descriptor = ctx.settings.describe().find((candidate) => candidate.ns === config.settingsNs);
  if (descriptor === undefined) throw new Error(`No configurable plugin entry "${config.settingsNs}"`);
  const value = isObject(descriptor.value) ? descriptor.value : {};
  const providers = isObject(value.providers) ? value.providers : {};
  const route = isObject(providers[config.route]) ? providers[config.route] : undefined;
  return { descriptor, providers, route, writable: ctx.settings.writable };
}

/**
 * Translate inherited levels into the declared dict.
 *
 * Only `off` may carry the "send nothing" wire value; every other declared level
 * sends its own name. A model that offers nothing beyond `off` is not a
 * reasoning model at all, and the schema wants `false` for it rather than a
 * declaration with no thinking level.
 * @param levels - the analogy's offered levels.
 * @param config - this row's configuration.
 * @returns the declaration, or `false`.
 */
function effortsOf(levels, config) {
  const thinking = levels.filter((level) => level !== 'off');
  if (thinking.length === 0) return false;
  const efforts = {};
  for (const level of levels) efforts[level] = level === 'off' ? config.offWire : level;
  return efforts;
}

/**
 * Project one configured entry for the card.
 * @param entry - the stored model entry.
 * @returns its identity and the fields worth showing.
 */
function viewOfEntry(entry) {
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    input: entry.input ?? [],
    reasoningEfforts: entry.reasoningEfforts ?? undefined
  };
}

/**
 * Read a request body, refusing anything over the cap.
 * @param request - the node request.
 * @returns the body as text.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body larger than ${String(MAX_BODY_BYTES)} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Answer with JSON.
 * @param response - the node response.
 * @param status - the HTTP status.
 * @param body - the body, serialized as-is.
 */
function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

/**
 * Check for a plain object.
 * @param value - the candidate.
 * @returns whether it is a non-array object.
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
