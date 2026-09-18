/**
 * The checks that read what the ad actually shows a person.
 *
 * All three of these produce an ad that runs perfectly and looks wrong,
 * which is the failure mode nothing in Meta reports. A campaign with a
 * headline cropped off the top delivers exactly as well as one without,
 * right up until you look at the money.
 */

import { brandOf, type Config } from "../config.ts";
import type { Snapshot } from "../meta/snapshot.ts";
import type { Ad, AdSet } from "../meta/types.ts";
import type { Finding } from "./types.ts";

/** Every piece of text a creative will put in front of somebody. */
export function copyOf(ad: Ad): { where: string; text: string }[] {
  const creative = ad.creative;
  if (!creative) return [];
  const link = creative.object_story_spec?.link_data;
  const video = creative.object_story_spec?.video_data;

  const pieces = [
    { where: "title", text: creative.title },
    { where: "body", text: creative.body },
    { where: "message", text: link?.message ?? video?.message },
    { where: "headline", text: link?.name ?? video?.title },
    { where: "description", text: link?.description },
    ...(link?.child_attachments ?? []).map((card, index) => ({
      where: `card ${index + 1}`,
      text: card.name,
    })),
  ];

  return pieces.filter(
    (piece): piece is { where: string; text: string } =>
      typeof piece.text === "string" && piece.text.trim().length > 0,
  );
}

function brandForAd(ad: Ad, snapshot: Snapshot, config: Config) {
  const campaign = snapshot.campaigns.find((c) => c.id === ad.campaign_id);
  return campaign ? brandOf(campaign.name, config.brands) : null;
}

/**
 * Text that reached Meta as broken bytes.
 *
 * A replacement character in a stored creative means the accents never
 * arrived: the request body was not valid UTF-8, Meta substituted, and
 * it answered success. The original text is gone and cannot be recovered
 * by reading the API back, so this is not a warning, it is an ad running
 * with visible mojibake in front of customers.
 *
 * It takes days to notice because the preview in the panel shows the
 * same broken text, and broken text looks like somebody's typo.
 */
export function brokenCopy(snapshot: Snapshot, config: Config): Finding[] {
  const findings: Finding[] = [];

  for (const ad of snapshot.ads) {
    if (ad.effective_status !== "ACTIVE") continue;
    const damaged = copyOf(ad).filter((piece) => piece.text.includes("\uFFFD"));
    if (damaged.length === 0) continue;

    findings.push({
      id: "broken_copy",
      severity: "urgent",
      brandId: brandForAd(ad, snapshot, config)?.id ?? null,
      refType: "ad",
      refId: ad.id,
      refName: ad.name,
      title: `"${ad.name}" is showing broken characters`,
      groupTitle: "{n} ads are showing broken characters",
      observed:
        `The ${damaged.map((d) => d.where).join(", ")} of this ad contains ` +
        "replacement characters, which means the text was not valid UTF-8 when " +
        `it was sent. It currently reads: "${damaged[0]?.text.slice(0, 120)}".`,
      change:
        "Rewrite the text and send it again as UTF-8. The original wording " +
        "cannot be read back from the API, so it has to be retyped.",
      reversible: true,
      costIfWrong: "Nothing. The ad returns to review for a few hours.",
    });
  }

  return findings;
}

/**
 * Copy that relies on characters outside ASCII.
 *
 * This one is a house rule rather than a law of the API, and it exists
 * because the failure above is unrecoverable. Accents, the euro sign,
 * superscripts and emoji are exactly the characters that break when a
 * request body takes a wrong turn on its way to the Graph. Text that
 * never uses them cannot break that way.
 *
 * Only worth switching on for an account that has been burned, so it is
 * off unless `asciiOnlyCopy` says otherwise. Accented copy is correct
 * copy, and an agent that calls correct copy a defect every morning is
 * one nobody reads by the second week.
 */
export function nonAsciiCopy(snapshot: Snapshot, config: Config): Finding[] {
  if (!config.thresholds.asciiOnlyCopy) return [];
  const findings: Finding[] = [];

  for (const ad of snapshot.ads) {
    if (ad.effective_status !== "ACTIVE") continue;
    const risky = copyOf(ad).filter(
      (piece) => /[^\x00-\x7F]/.test(piece.text) && !piece.text.includes("\uFFFD"),
    );
    if (risky.length === 0) continue;

    const characters = [
      ...new Set(risky.flatMap((piece) => [...piece.text].filter((c) => c.charCodeAt(0) > 127))),
    ].slice(0, 12);

    findings.push({
      id: "non_ascii_copy",
      severity: "notice",
      brandId: brandForAd(ad, snapshot, config)?.id ?? null,
      refType: "ad",
      refId: ad.id,
      refName: ad.name,
      title: `"${ad.name}" uses characters that break in transit`,
      groupTitle: "{n} ads use characters that break in transit",
      observed: `Its copy contains ${characters.join(" ")}.`,
      change:
        "Rephrase so the copy is plain ASCII. These are the characters that " +
        "arrive as replacement marks when a request body is not sent as UTF-8, " +
        "and once that happens the original text cannot be recovered.",
      reversible: true,
    });
  }

  return findings;
}

/**
 * A vertical image being served into the feed.
 *
 * Anything designed for stories comes out 1080 by 1920. The feed will
 * not show that: it crops to 4:5 at the tallest, and it crops from the
 * centre. The headline is almost always in the top half, so it
 * disappears and the ad becomes a photograph with no message. No error,
 * no warning, and it only looks wrong in some placements.
 *
 * The fix is not to stop using vertical art. It is to tell Meta which
 * rectangle to use per ratio, with `image_crops` on a carousel card or
 * `asset_feed_spec` customisation rules elsewhere.
 */
export function uncroppedVertical(snapshot: Snapshot, config: Config): Finding[] {
  const adSets = new Map(snapshot.adSets.map((a) => [a.id, a]));
  const findings: Finding[] = [];

  for (const ad of snapshot.ads) {
    if (ad.effective_status !== "ACTIVE") continue;
    const adSet: AdSet | undefined = ad.adset_id ? adSets.get(ad.adset_id) : undefined;
    if (!adSet || !servesFeed(adSet)) continue;

    const creative = ad.creative;
    if (!creative) continue;

    // Either of these tells Meta what to do per placement, so an ad
    // carrying one has already answered the question.
    const cards = creative.object_story_spec?.link_data?.child_attachments ?? [];
    const hasCrops = cards.some((card) => card.image_crops && Object.keys(card.image_crops).length > 0);
    const hasRules = (creative.asset_feed_spec?.asset_customization_rules ?? []).length > 0;
    if (hasCrops || hasRules) continue;

    const vertical = verticalImages(ad, snapshot);
    if (vertical.length === 0) continue;

    findings.push({
      id: "uncropped_vertical",
      severity: "notice",
      brandId: brandForAd(ad, snapshot, config)?.id ?? null,
      refType: "ad",
      refId: ad.id,
      refName: ad.name,
      title: `"${ad.name}" loses its headline in the feed`,
      groupTitle: "{n} ads lose their headline in the feed",
      observed:
        `Its artwork is ${vertical[0]}, the ad set delivers into the feed, and ` +
        "the creative says nothing about how to crop. The feed will take the " +
        "middle 4:5 of it, which is where the headline is not.",
      change:
        "For a carousel, add image_crops with a 400x500 rectangle chosen from " +
        "the top of each card. Otherwise build the creative with " +
        "asset_feed_spec and customisation rules sending the vertical art to " +
        "stories and reels and a 1080x1350 crop everywhere else. Check the " +
        "result by opening the real preview, not by reading the JSON back.",
      reversible: true,
    });
  }

  return findings;
}

/** Whether an ad set puts anything into a feed style placement. */
function servesFeed(adSet: AdSet): boolean {
  const positions = adSet.targeting?.facebook_positions;
  const instagram = adSet.targeting?.instagram_positions;
  // No explicit positions means automatic placements, which include the
  // feed. That is the common case and the one that bites.
  if (!positions && !instagram) return true;
  return (positions ?? []).includes("feed") || (instagram ?? []).includes("stream");
}

/** The sizes of this ad's images, filtered to the ones taller than 4:5. */
function verticalImages(ad: Ad, snapshot: Snapshot): string[] {
  const sizes: string[] = [];
  const creative = ad.creative;
  if (!creative) return sizes;

  const hashes = [
    creative.image_hash,
    creative.object_story_spec?.link_data?.image_hash,
    ...(creative.object_story_spec?.link_data?.child_attachments ?? []).map((c) => c.image_hash),
    ...(creative.asset_feed_spec?.images ?? []).map((i) => i.hash),
  ].filter((hash): hash is string => typeof hash === "string");

  for (const hash of new Set(hashes)) {
    const image = snapshot.images[hash];
    if (!image?.width || !image.height) continue;
    // 4:5 is 0.8. Anything narrower than that gets cropped in the feed.
    if (image.width / image.height < 0.8) sizes.push(`${image.width}x${image.height}`);
  }

  return sizes;
}

export const creativeChecks = [brokenCopy, nonAsciiCopy, uncroppedVertical];
