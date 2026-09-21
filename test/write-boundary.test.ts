/**
 * The boundary, checked rather than asserted.
 *
 * The whole security argument of this project is one sentence: the half
 * with an address on the internet cannot spend money, because it holds
 * a token scoped to `ads_read` and because nothing in it writes to
 * Meta. The first half of that is enforced by Meta. The second half was
 * enforced, until this file, by a comment claiming a lint rule that did
 * not exist.
 *
 * A claim about security that nobody checks is worse than no claim: it
 * is believed. So this walks `src/` and fails if anything outside the
 * executor's own writer can issue a POST to the Graph API, or if the
 * agent Worker ever imports that writer.
 *
 * It is a blunt instrument on purpose. It cannot be fooled by a clever
 * indirection, but it does not need to be clever itself: it needs to
 * fail loudly the day somebody adds `method: "POST"` to the wrong file,
 * which is exactly how this kind of boundary is lost.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The one file allowed to write to Meta. It runs in the executor. */
const WRITER = join("src", "meta", "writer.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

test("only the executor's writer can POST to the Graph API", () => {
  for (const file of sourceFiles("src")) {
    if (file === WRITER) continue;
    const source = readFileSync(file, "utf8");

    // Resend is a POST and it is not Meta. Narrow to calls that reach
    // graph.facebook.com, which is the only address that can spend.
    const mentionsGraph = source.includes("graph.facebook.com");
    const posts = /method:\s*["'`]POST["'`]/.test(source);

    assert.ok(
      !(mentionsGraph && posts),
      `${file} both names the Graph API and issues a POST. Writing to Meta ` +
        `belongs in ${WRITER}, which runs in the executor Worker: the half ` +
        `with no fetch handler and no address on the internet.`,
    );
  }
});

test("the internet-facing Worker never reaches the writer", () => {
  // Following imports from src/index.ts, which is the only entry point
  // with a fetch handler. Reaching the writer from there would put the
  // ability to spend money behind a URL, whatever guarded it.
  const seen = new Set<string>();
  const queue = [join("src", "index.ts")];

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);

    assert.notEqual(
      file,
      WRITER,
      "src/index.ts reaches src/meta/writer.ts. The Worker that answers " +
        "requests must not be able to write to Meta, even indirectly.",
    );

    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const relative = match[1];
      if (!relative) continue;
      const parts = file.replaceAll("\\", "/").split("/").slice(0, -1);
      for (const step of relative.split("/")) {
        if (step === ".") continue;
        if (step === "..") parts.pop();
        else parts.push(step);
      }
      queue.push(join(...parts));
    }
  }

  // A guard against the guard: if the walk found almost nothing, the
  // import resolution broke and this test would pass by not looking.
  assert.ok(seen.size > 8, `only followed ${seen.size} files, the import walk is broken`);
});

test("the executor Worker exports no fetch handler", () => {
  const source = readFileSync(join("src", "executor.ts"), "utf8");
  assert.ok(
    !/^\s*async fetch\(/m.test(source),
    "src/executor.ts has a fetch handler. It holds the token that can " +
      "spend money and it must have no address on the internet.",
  );
});
