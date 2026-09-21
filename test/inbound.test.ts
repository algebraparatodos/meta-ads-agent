/**
 * Replies, and the three ways reading one can go wrong quietly.
 *
 * Every assertion here is a change to somebody's advertising that would
 * otherwise be made by the wrong person, about the wrong proposal, or on
 * the strength of a word that was not an answer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { addressOf, codeFrom, ownWords, readAnswer, signatureIsValid } from "../src/mail/inbound.ts";

const SECRET = "whsec_4fVMoGOk0z5c80Lnbx3i//bklYn+yDbZ";

function signed(body: string, at: number, secret = SECRET): Headers {
  const id = "msg_2abc";
  const timestamp = String(Math.floor(at / 1000));
  const mac = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return new Headers({
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${mac}`,
  });
}

const now = Date.parse("2026-09-21T12:00:00Z");
const body = '{"type":"email.received","data":{"email_id":"1"}}';

test("a signed payload verifies, and nothing else does", async () => {
  assert.equal(await signatureIsValid(SECRET, signed(body, now), body, now), true);

  assert.equal(
    await signatureIsValid(SECRET, signed(body, now), `${body} `, now),
    false,
    "one byte of difference is a different message",
  );
  assert.equal(
    await signatureIsValid(SECRET, signed(body, now, "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), body, now),
    false,
    "somebody else's secret is not this one",
  );
  assert.equal(
    await signatureIsValid(undefined, signed(body, now), body, now),
    false,
    "an unset secret must never match an absent header",
  );
});

test("a captured request cannot be replayed tomorrow", async () => {
  const headers = signed(body, now);
  assert.equal(await signatureIsValid(SECRET, headers, body, now + 6 * 60_000), false);
  assert.equal(await signatureIsValid(SECRET, headers, body, now + 4 * 60_000), true);
});

test("the proposal is read from the address, whatever the subject says", () => {
  assert.equal(codeFrom(["ads+ads-0113@ads.j-dev.es"]), "ADS-0113");
  assert.equal(codeFrom(["juani+ads0113@j-dev.es"]), "ADS-0113");
  assert.equal(codeFrom([undefined, "someone@else.com", "ads+ADS-7@ads.j-dev.es"]), "ADS-0007");
  assert.equal(codeFrom(["ads@ads.j-dev.es"]), null, "no code is not a code");
  assert.equal(codeFrom([]), null);
});

test("who wrote it survives a display name", () => {
  assert.equal(addressOf("Juan Ignacio Silva <juani@j-dev.es>"), "juani@j-dev.es");
  assert.equal(addressOf("juani@j-dev.es"), "juani@j-dev.es");
  assert.equal(addressOf("  JUANI@J-DEV.ES "), "juani@j-dev.es");
  assert.equal(addressOf(undefined), "");
});

test("the quoted email underneath is not part of the answer", () => {
  // The original message says "yes" in it, as every one of them does.
  const reply = [
    "no",
    "",
    "El 21 sept 2026, a las 9:50, Publi <recordatorios@j-dev.es> escribió:",
    "",
    "> Saying yes applies this automatically, within the hour.",
    "> Approve and apply: https://ads.j-dev.es/d/abc",
  ].join("\n");

  assert.equal(ownWords(reply), "no");
  assert.deepEqual(readAnswer(reply), { kind: "reject" });
});

test("a bare yes is a yes, in either language", () => {
  for (const said of ["si", "Sí", "yes", "OK", "dale", "adelante", "aprobado"]) {
    assert.deepEqual(readAnswer(said), { kind: "approve" }, said);
  }
  for (const said of ["no", "No.", "nope", "descartar"]) {
    assert.deepEqual(readAnswer(said), { kind: "reject" }, said);
  }
});

test("a yes with a condition on it is not a yes", () => {
  const said = "Sí, pero bajá el presupuesto a la mitad primero";
  const answer = readAnswer(said);
  assert.equal(answer.kind, "unclear", "approving this would spend money nobody agreed to");
  assert.equal(answer.kind === "unclear" && answer.said, said);
});

test("a signature on its own line does not become the answer", () => {
  const reply = ["si", "", "--", "Juani", "j-dev.es"].join("\n");
  assert.deepEqual(readAnswer(reply), { kind: "approve" });
});
