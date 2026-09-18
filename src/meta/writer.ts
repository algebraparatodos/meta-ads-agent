/**
 * The only code in this project that writes to Meta.
 *
 * Everything else holds a token scoped to `ads_read` and physically
 * cannot spend money. This file runs inside the executor Worker, which
 * holds the wide token and has no `fetch` handler, so nothing can reach
 * it from the internet: it wakes on a timer, reads approvals already
 * written to the database, and goes back to sleep.
 *
 * Three rules, and the second is the one that matters most.
 *
 * 1. **A closed list of actions.** There is no generic "do this". Each
 *    action is a function that knows how to make the change and how to
 *    read it back. The executor is never in the position of interpreting
 *    an instruction, because it holds the token that can spend.
 *
 * 2. **Read it back, every time.** Meta answers `{"success": true}` to
 *    edits it silently ignores. An ad cloned through the API is born
 *    without the pixel and without the conversion domain even though the
 *    original had both. Nothing raises an error; the change simply did
 *    not happen. So an action is not done until the object has been read
 *    again and the new value is actually in it.
 *
 * 3. **Record how to undo it.** Before changing anything, the previous
 *    value is stored. Without that, reversing a change means somebody
 *    remembering what it used to be.
 */

import type { Action } from "../checks/types.ts";

const GRAPH = "https://graph.facebook.com/v21.0";

export type WriteResult = {
  ok: boolean;
  /** What was sent. */
  request: unknown;
  /** What Meta answered. */
  response: unknown;
  /** The object as it actually looks now. */
  readback: unknown;
  /**
   * How to put it back.
   *
   * Kept as the previous value and a sentence, not as an action to
   * replay. Most of these changes have no inverse in the action list:
   * the opposite of adding an audience is removing one, and there is no
   * "remove audience" action because nothing ever proposes it. Storing a
   * fake inverse would be worse than storing none, because somebody
   * would eventually run it.
   */
  undo: { what: string; previous: unknown } | null;
  error: string | null;
};

async function call(
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; data: unknown; error: string | null }> {
  const url = `${GRAPH}/${path}`;
  const init: RequestInit = { method: body ? "POST" : "GET" };

  if (body) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    form.set("access_token", token);
    init.body = form;
    init.headers = { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" };
  }

  const response = await fetch(body ? url : `${url}${url.includes("?") ? "&" : "?"}access_token=${token}`, init);
  const text = await response.text();

  let data: unknown = null;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    data,
    error: response.ok ? null : `http ${response.status}: ${text.slice(0, 300)}`,
  };
}

type Targeting = {
  custom_audiences?: { id: string; name?: string }[];
  excluded_custom_audiences?: { id: string; name?: string }[];
};

/**
 * Adds or removes an audience from an ad set's targeting.
 *
 * The whole `targeting` object has to be sent back, not just the part
 * being changed: Meta replaces the field rather than merging into it, so
 * sending only the audiences would wipe the geography, the ages and the
 * interests. That is the single most destructive mistake available here,
 * and it would look like success.
 */
async function changeAudience(
  action: Extract<Action, { type: "include_audience" | "exclude_audience" }>,
  token: string,
): Promise<WriteResult> {
  const field = action.type === "include_audience" ? "custom_audiences" : "excluded_custom_audiences";

  const before = await call(`${action.adSetId}?fields=targeting`, token);
  if (!before.ok) {
    return { ok: false, request: action, response: before.data, readback: null, undo: null, error: before.error };
  }

  const targeting = ((before.data as { targeting?: Targeting })?.targeting ?? {}) as Targeting;
  const current = targeting[field] ?? [];
  if (current.some((a) => a.id === action.audienceId)) {
    return { ok: true, request: action, response: "already there", readback: targeting, undo: null, error: null };
  }

  const next: Targeting = {
    ...targeting,
    [field]: [...current, { id: action.audienceId, name: action.audienceName }],
  };

  const written = await call(action.adSetId, token, { targeting: next });
  if (!written.ok) {
    return { ok: false, request: next, response: written.data, readback: null, undo: null, error: written.error };
  }

  // The part that is not optional. Meta accepts targeting edits it does
  // not apply, and the answer looks identical either way.
  const after = await call(`${action.adSetId}?fields=targeting`, token);
  const nowHas = (((after.data as { targeting?: Targeting })?.targeting?.[field]) ?? []).some(
    (a) => a.id === action.audienceId,
  );

  return {
    ok: nowHas,
    request: next,
    response: written.data,
    readback: (after.data as { targeting?: Targeting })?.targeting ?? null,
    undo: nowHas
      ? {
          what: `remove "${action.audienceName}" from the ad set's ${field}`,
          previous: targeting,
        }
      : null,
    error: nowHas ? null : "Meta accepted the change and the ad set does not show it",
  };
}

/** Pausing, which is the one change that can never cost money. */
async function pause(id: string, token: string, kind: "ad" | "adset"): Promise<WriteResult> {
  const before = await call(`${id}?fields=status`, token);
  const wasActive = (before.data as { status?: string })?.status === "ACTIVE";

  const written = await call(id, token, { status: "PAUSED" });
  if (!written.ok) {
    return { ok: false, request: { id, status: "PAUSED" }, response: written.data, readback: null, undo: null, error: written.error };
  }

  const after = await call(`${id}?fields=status,effective_status`, token);
  const paused = (after.data as { status?: string })?.status === "PAUSED";

  return {
    ok: paused,
    request: { id, status: "PAUSED" },
    response: written.data,
    readback: after.data,
    // Only offered when it really was running: turning something back on
    // that somebody had already turned off is not an undo.
    undo: paused && wasActive ? { what: `set this ${kind} back to ACTIVE`, previous: "ACTIVE" } : null,
    error: paused ? null : "Meta accepted the pause and the object is still active",
  };
}

/** Sets a field on an ad and confirms it stuck. */
async function setField(
  id: string,
  field: string,
  value: unknown,
  token: string,
): Promise<WriteResult> {
  const before = await call(`${id}?fields=${field}`, token);
  const previous = (before.data as Record<string, unknown>)?.[field];

  const written = await call(id, token, { [field]: value });
  if (!written.ok) {
    return { ok: false, request: { id, [field]: value }, response: written.data, readback: null, undo: null, error: written.error };
  }

  const after = await call(`${id}?fields=${field}`, token);
  const now = (after.data as Record<string, unknown>)?.[field];
  const applied = JSON.stringify(now) === JSON.stringify(value);

  return {
    ok: applied,
    request: { id, [field]: value },
    response: written.data,
    readback: after.data,
    undo: applied ? { what: `set ${field} back`, previous } : null,
    error: applied
      ? null
      : `Meta accepted ${field} and the object still reads ${JSON.stringify(previous)}`,
  };
}

/**
 * Carries out one approved action.
 *
 * Anything not recognised is refused rather than attempted. A token that
 * can spend money must never try to interpret something it has not been
 * taught, however reasonable it looks.
 */
export async function apply(action: Action, token: string): Promise<WriteResult> {
  switch (action.type) {
    // One function for both: which list the audience joins is decided
    // by the action type, and adding to either is the same operation.
    case "include_audience":
    case "exclude_audience":
      return changeAudience(action, token);
    case "pause_ad":
      return pause(action.adId, token, "ad");
    case "pause_adset":
      return pause(action.adSetId, token, "adset");
    case "set_conversion_domain":
      return setField(action.adId, "conversion_domain", action.domain, token);
    case "set_adset_budget":
      return setField(action.adSetId, "daily_budget", action.dailyBudgetMinor, token);
    case "set_adset_end":
      return setField(action.adSetId, "end_time", action.endTime, token);
    case "set_tracking_pixel":
      return setTrackingPixel(action.adId, action.pixelId, token);
    default:
      return {
        ok: false,
        request: action,
        response: null,
        readback: null,
        undo: null,
        error: "this executor has not been taught that action",
      };
  }
}

/**
 * Adds the pixel to an ad's tracking specs, keeping what was there.
 *
 * `tracking_specs` is a list and Meta replaces it wholesale, so the
 * existing entries have to be sent back alongside the new one. Dropping
 * them would break whatever else the ad was already reporting, silently.
 */
async function setTrackingPixel(adId: string, pixelId: string, token: string): Promise<WriteResult> {
  const before = await call(`${adId}?fields=tracking_specs`, token);
  const specs = ((before.data as { tracking_specs?: Record<string, string[]>[] })?.tracking_specs ?? []);

  const already = specs.some((spec) => (spec["fb_pixel"] ?? []).includes(pixelId));
  if (already) {
    return { ok: true, request: { adId, pixelId }, response: "already there", readback: specs, undo: null, error: null };
  }

  const next = [...specs, { "action.type": ["offsite_conversion"], fb_pixel: [pixelId] }];
  const written = await call(adId, token, { tracking_specs: next });
  if (!written.ok) {
    return { ok: false, request: next, response: written.data, readback: null, undo: null, error: written.error };
  }

  const after = await call(`${adId}?fields=tracking_specs`, token);
  const nowSpecs = ((after.data as { tracking_specs?: Record<string, string[]>[] })?.tracking_specs ?? []);
  const applied = nowSpecs.some((spec) => (spec["fb_pixel"] ?? []).includes(pixelId));

  return {
    ok: applied,
    request: next,
    response: written.data,
    readback: nowSpecs,
    undo: applied ? { what: "restore the previous tracking_specs", previous: specs } : null,
    error: applied ? null : "Meta accepted the tracking spec and the ad does not show it",
  };
}
