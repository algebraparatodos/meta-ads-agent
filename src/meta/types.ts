/**
 * The shapes the Graph API actually returns.
 *
 * Two things surprise everyone here and both are encoded below.
 *
 * Every number arrives as a string. `spend` is `"44.12"`, not 44.12, and
 * adding two of them without parsing gives you `"44.1244.12"`.
 *
 * And a field you asked for can simply be absent. Meta omits rather than
 * nulls, so almost everything is optional and the code has to cope with
 * that rather than assume the fields it requested came back.
 */

export type Action = { action_type: string; value: string };

export type Insight = {
  date_start?: string;
  date_stop?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  objective?: string;
  impressions?: string;
  reach?: string;
  frequency?: string;
  spend?: string;
  cpm?: string;
  cpc?: string;
  ctr?: string;
  inline_link_clicks?: string;
  actions?: Action[];
  action_values?: Action[];
  cost_per_action_type?: Action[];
};

export type Campaign = {
  id: string;
  name: string;
  objective?: string;
  effective_status?: string;
  status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
  is_adset_budget_sharing_enabled?: boolean;
  start_time?: string;
  stop_time?: string;
};

/** What an ad set is told to buy. Null on the pixel side means the ad
 *  set is not bidding on a website event at all, which changes whether
 *  touching measurement is risky or free. */
export type PromotedObject = {
  pixel_id?: string;
  custom_event_type?: string;
  custom_conversion_id?: string;
  page_id?: string;
  application_id?: string;
};

export type AdSet = {
  id: string;
  name: string;
  campaign_id?: string;
  effective_status?: string;
  status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal?: string;
  billing_event?: string;
  bid_strategy?: string;
  destination_type?: string;
  start_time?: string;
  end_time?: string;
  promoted_object?: PromotedObject;
  attribution_spec?: { event_type: string; window_days: number }[];
  targeting?: Targeting;
};

export type Targeting = {
  age_min?: number;
  age_max?: number;
  genders?: number[];
  geo_locations?: {
    countries?: string[];
    cities?: { key: string; name: string; radius?: number; distance_unit?: string }[];
    regions?: { key: string; name: string }[];
  };
  flexible_spec?: { interests?: { id: string; name: string }[] }[];
  interests?: { id: string; name: string }[];
  custom_audiences?: { id: string; name: string }[];
  excluded_custom_audiences?: { id: string; name: string }[];
  publisher_platforms?: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
};

/** One entry says which pixel an ad's conversions are counted against.
 *  An ad created through the API does not inherit this from the ad set,
 *  and nothing warns you: the conversions just land somewhere else. */
export type TrackingSpec = Record<string, string[]>;

export type Creative = {
  id: string;
  name?: string;
  title?: string;
  body?: string;
  object_type?: string;
  image_hash?: string;
  url_tags?: string;
  object_story_spec?: {
    page_id?: string;
    instagram_user_id?: string;
    link_data?: {
      link?: string;
      message?: string;
      name?: string;
      description?: string;
      image_hash?: string;
      child_attachments?: {
        link?: string;
        name?: string;
        image_hash?: string;
        image_crops?: Record<string, number[][]>;
      }[];
    };
    video_data?: { title?: string; message?: string; image_url?: string };
  };
  asset_feed_spec?: {
    images?: { hash?: string; adlabels?: { name?: string }[] }[];
    asset_customization_rules?: unknown[];
  };
};

export type Ad = {
  id: string;
  name: string;
  adset_id?: string;
  campaign_id?: string;
  effective_status?: string;
  status?: string;
  updated_time?: string;
  /** What Meta uses to attribute conversions from iOS without tracking
   *  permission. Separate from the pixel, and it also goes missing in
   *  silence on ads created through the API. */
  conversion_domain?: string;
  tracking_specs?: TrackingSpec[];
  creative?: Creative;
};

export type CustomConversion = {
  id: string;
  name: string;
  is_archived?: boolean;
  rule?: string;
  custom_event_type?: string;
  /**
   * Which dataset the conversion is defined on.
   *
   * The field is `event_source_id` when creating one and that same name
   * fails with a 400 when reading. Worse, asking for it in the account
   * wide listing does not fail at all: it returns empty on every row, so
   * it looks like no conversion has a pixel. `data_sources` is what
   * actually answers, and it carries the pixel's name as well.
   */
  data_sources?: { id: string; source_type?: string; name?: string }[];
};

/** The pixel a custom conversion counts against, if it says. */
export function conversionPixel(conversion: CustomConversion): string | null {
  const pixel = (conversion.data_sources ?? []).find(
    (source) => source.source_type === "PIXEL" || !source.source_type,
  );
  return pixel?.id ?? null;
}

/**
 * A saved audience. The rule is only present on website audiences, and
 * it is the only thing that says who actually ends up inside one.
 */
export type CustomAudience = {
  id: string;
  name: string;
  subtype?: string;
  description?: string;
  time_created?: number;
  /**
   * When the contents last changed, as a unix timestamp.
   *
   * The field that matters most and the one nobody looks at. A list
   * uploaded from a file never refreshes itself: it is a photograph of
   * who had signed up on the day somebody exported it, and it keeps
   * being targeted long after everyone in it moved on.
   */
  time_content_updated?: number;
  approximate_count_lower_bound?: number;
  approximate_count_upper_bound?: number;
  /** JSON. Meta returns it as a string on some subtypes and an object on others. */
  rule?: unknown;
  rule_aggregation?: string;
  /**
   * Meta's own verdict on whether this audience can be served.
   *
   * Worth using instead of inventing a size threshold. Meta knows what
   * its own minimum is, it changes it without telling anybody, and it
   * accounts for things a headcount does not, like how much of the
   * audience it can actually reach.
   */
  delivery_status?: { code?: number; description?: string };
  operation_status?: { code?: number; description?: string };
};

/** Whether Meta says this audience is usable right now. */
export function isServable(audience: CustomAudience): boolean {
  const code = audience.delivery_status?.code;
  if (typeof code === "number") return code === 200;
  // No verdict means not enough is known to claim it is ready.
  return false;
}

/**
 * What an audience is for, read from its rule rather than its name.
 *
 * Names are a convention and conventions drift; the rule is what
 * actually decides who ends up inside. An audience built from purchases
 * with nothing excluded is a list of customers, which is something to
 * subtract from a campaign chasing new ones. One built from views or
 * checkouts with purchasers excluded is a list of people who looked and
 * did not buy, which is the thing worth chasing.
 */
export function audiencePurpose(
  audience: CustomAudience,
): "buyers" | "interested" | "unclear" {
  const rule = typeof audience.rule === "string" ? audience.rule : JSON.stringify(audience.rule ?? "");
  const includesPurchase = /"inclusions"[\s\S]*Purchase/.test(rule);
  const excludesPurchase = /"exclusions"[\s\S]*Purchase/.test(rule);
  const includesIntent = /"inclusions"[\s\S]*(ViewContent|InitiateCheckout|AddToCart|Lead)/.test(rule);

  if (includesPurchase && !excludesPurchase) return "buyers";
  if (includesIntent && excludesPurchase) return "interested";
  return "unclear";
}

export type AdImage = {
  hash: string;
  width?: number;
  height?: number;
  url?: string;
};

export type Pixel = {
  id: string;
  name?: string;
  is_unavailable?: boolean;
  enable_automatic_matching?: boolean;
  first_party_cookie_status?: string;
  data_use_setting?: string;
};

/** A row of `/{pixel}/stats`. The aggregation asked for decides what
 *  `value` means, so the two are always carried together. */
export type PixelStat = { value?: string; count?: number; [key: string]: unknown };

export type AccountStatus = {
  name?: string;
  /** 1 means active. Anything else means nothing is being delivered. */
  account_status?: number;
  disable_reason?: number;
  currency?: string;
  timezone_name?: string;
};

/** Parses one of Meta's string numbers. Anything unreadable is zero,
 *  because a missing figure and a zero figure lead to the same
 *  decision here and a NaN spreading through a comparison does not. */
export function n(value: string | number | undefined | null): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * How many results an insight row holds.
 *
 * Meta reports the same conversion under several names at once:
 * `purchase` and `offsite_conversion.fb_pixel_purchase` are one sale
 * counted twice. So this takes the largest matching count rather than
 * the sum. Summing them invents revenue.
 */
export function countResults(row: Insight, resultActions: string[]): number {
  let best = 0;
  for (const action of row.actions ?? []) {
    if (!resultActions.some((wanted) => action.action_type.includes(wanted))) continue;
    best = Math.max(best, n(action.value));
  }
  return best;
}
