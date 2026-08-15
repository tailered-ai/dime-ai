// Regenerates the r2 adversarial fixtures, their expected finding
// multisets, and the manifest's r2_fixtures register. Deterministic and
// idempotent: run from the repository root with
//   node docs/verification/prx/tools/gen-r2-fixtures.mjs
// Fixtures carrying control characters, zero-width code points, or
// megabyte-scale multi-byte payloads are generated here rather than
// hand-edited so their exact bytes are reproducible and reviewable.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AF = join(dirname(fileURLToPath(import.meta.url)), "..", "adversarial-fixtures");

// id -> { file, content, mechanism, options, expected }
// expected entries are "level:RULE" strings, one per expected finding
// (exact multiset; the harness sorts both sides).
const FIXTURES = {
  R2C01: {
    file: "r2/commit/R2C01.txt",
    content:
      "feat(x): adjust the parser\n\nWhy this exists.\n\n" +
      "co-authored-by: garbage not an email\n",
    mechanism:
      "BYP-C-01: lowercase Co-Authored-By key must hit the value grammar " +
      "via canonicalTrailerKey (exactly one finding)",
    options: {},
    expected: ["error:PRX-C-TRAILER"],
  },
  R2C02: {
    file: "r2/commit/R2C02.txt",
    content:
      "feat(x): adjust the parser\n\nWhy this exists.\n\n" +
      "Run-Id: ONE-20260814-AAAA\nrun-id: ONE-20260814-BBBB\n" +
      "Evidence: UNKNOWN\nCo-Authored-By: A B <a@b.co>\n",
    mechanism:
      "BYP-C-01: case-variant duplicate pair (Run-Id + run-id) trips " +
      "duplicate detection and the governed count",
    options: {},
    expected: ["error:PRX-C-TRAILER", "error:PRX-C-GOV"],
  },
  R2C03: {
    file: "r2/commit/R2C03.txt",
    content:
      "feat(x): adjust the parser\n\nWhy this exists.\n\n" +
      "Ｒｕｎ-Ｉｄ: ONE-20260814-AAAA\n",
    mechanism:
      "BYP-C-01: a fullwidth lookalike key must not satisfy " +
      "governed-trailer presence and must not be recognized as a governed " +
      "key (with --governed, all three requirements report missing)",
    options: { governed: true },
    expected: ["error:PRX-C-GOV", "error:PRX-C-GOV", "error:PRX-C-GOV"],
  },
  R2C04: {
    file: "r2/commit/R2C04.txt",
    content:
      "feat(x): adjust the parser\n\nWhy this exists.\n\n" +
      "Co-Authored-By: garbage\nfollowing prose line here\n",
    mechanism:
      "BYP-C-02: malformed Co-Authored-By followed by a prose line fails " +
      "(placement + value grammar) even though the formal block degrades",
    options: {},
    expected: ["error:PRX-C-TRAILER", "error:PRX-C-TRAILER"],
  },
  R2C05: {
    file: "r2/commit/R2C05.txt",
    content:
      "feat(x): adjust the parser\n\n" +
      "Co-Authored-By: garbage mid-block\n\nMore prose after.\n",
    mechanism:
      "BYP-C-02: malformed Co-Authored-By in a non-final block fails " +
      "(placement + value grammar)",
    options: {},
    expected: ["error:PRX-C-TRAILER", "error:PRX-C-TRAILER"],
  },
  R2C06: {
    file: "r2/commit/R2C06.txt",
    content:
      "feat(x): ends with a period.\n\n" +
      "```\nCo-Authored-By: garbage quoted in a fence\n```\n",
    mechanism:
      "BYP-C-02 exclusion: a malformed trailer inside a fenced code block " +
      "must NOT fire (the subject-period control finding proves the " +
      "fixture does not pass silently)",
    options: {},
    expected: ["error:PRX-C-SUBJECT"],
  },
  R2C07: {
    file: "r2/commit/R2C07.txt",
    content:
      "feat(x): ends with a period.\n\nIntro paragraph.\n\n" +
      "    Co-Authored-By: garbage quoted as indented code\n",
    mechanism:
      "BYP-C-02 exclusion: a malformed trailer inside a valid indented " +
      "code block must NOT fire (subject-period positive control)",
    options: {},
    expected: ["error:PRX-C-SUBJECT"],
  },
  R2C08: {
    file: "r2/commit/R2C08.txt",
    content:
      "feat(x): adjust the parser\n\nWhy this exists.\n\n" +
      "Co-Authored-By: garbage\n",
    mechanism:
      "BYP-C-02: a single malformed final-block trailer produces exactly " +
      "one finding (in-block grammar), never a duplicate whole-message " +
      "finding",
    options: {},
    expected: ["error:PRX-C-TRAILER"],
  },
  R2C09: {
    file: "r2/commit/R2C09.txt",
    content:
      'Revert "feat(x): thing"\n\nThis reverts commit ' +
      "1".repeat(40) +
      ".\n",
    mechanism:
      "BYP-C-04: a forged revert line in CLI mode produces the ordinary " +
      "prefix result plus the advisory, never silence",
    options: {},
    expected: ["error:PRX-C-PREFIX", "advisory:PRX-C-CONTEXT-UNVERIFIED"],
  },
  R2C10: {
    file: "r2/commit/R2C10.txt",
    content: "Bump lodash from 1 to 2\n\nRoutine dependency bump body.\n",
    mechanism:
      "BYP-C-05: a claimed bot identity (claimedBot signal, as range mode " +
      "now passes it) produces the ordinary prefix result plus the " +
      "advisory, never suppression",
    options: { claimedBot: true },
    expected: ["error:PRX-C-PREFIX", "advisory:PRX-C-CONTEXT-UNVERIFIED"],
  },
  R2C11: {
    file: "r2/commit/R2C11.txt",
    content:
      "feat(x): adjust the parser\n\n" +
      "é".repeat(560000) +
      "\n",
    mechanism:
      "BYP-C-06: 560,015 UTF-16 units but 1,120,030 UTF-8 bytes — under " +
      "the v1.1 UTF-16 cap, over the r2 byte cap; the byte accounting " +
      "must reject it",
    options: {},
    expected: ["error:PRX-C-SIZE"],
  },
  R2C12: {
    file: "r2/commit/R2C12.txt",
    content:
      "feat(x): has\ttab inside\n\n" +
      "body line with a U+2028\u2028line separator\n",
    mechanism:
      "BYP-C-07: TAB in the subject and U+2028 in body text are rejected " +
      "by the context-sensitive control policy",
    options: {},
    expected: ["error:PRX-C-SUBJECT", "error:PRX-C-CONTROL"],
  },
  R2C13: {
    file: "r2/commit/R2C13.txt",
    content:
      "feat(x): adjust the parser\n\n" +
      "prose line with an \u001B[31mescape\u001B[0m sequence\n\n" +
      "```\ncode line with an \u001B[31mescape\u001B[0m sequence\n```\n",
    mechanism:
      "BYP-C-08: the body control scan runs in file mode and is " +
      "context-sensitive — the ESC in prose fires once, the same ESC in " +
      "fenced code content does not",
    options: {},
    expected: ["error:PRX-C-CONTROL"],
  },
  R2C14: {
    file: "r2/commit/R2C14.txt",
    content:
      "feat(x): adjust the parser\n\n" +
      "`````\ncontent line\n```\n",
    mechanism:
      "BYP-C-09: a three-backtick marker cannot close a five-backtick " +
      "fence (CommonMark closing length rule); the fence is unclosed",
    options: {},
    expected: ["error:PRX-C-FENCE"],
  },
  R2C15: {
    file: "r2/commit/R2C15.txt",
    content: "\u200B\u200D\u2060\n\nbody text here.\n",
    mechanism:
      "same-class find during r2 wiring: a subject of only zero-width " +
      "code points renders as empty and must report as empty (plus the " +
      "ordinary prefix result)",
    options: {},
    expected: ["error:PRX-C-SUBJECT", "error:PRX-C-PREFIX"],
  },
};

const sha256 = buf => createHash("sha256").update(buf).digest("hex");

mkdirSync(join(AF, "r2", "commit"), { recursive: true });
mkdirSync(join(AF, "r2", "body"), { recursive: true });
mkdirSync(join(AF, "r2", "expected"), { recursive: true });

const register = {};
for (const [id, spec] of Object.entries(FIXTURES)) {
  const abs = join(AF, spec.file);
  writeFileSync(abs, spec.content);
  register[id] = {
    fixture: spec.file,
    sha256: sha256(readFileSync(abs)),
    mechanism: spec.mechanism,
  };
  writeFileSync(
    join(AF, "r2", "expected", `${id}.json`),
    `${JSON.stringify(
      {
        fixture: spec.file,
        mechanism: spec.mechanism,
        options: spec.options,
        expected_findings: spec.expected,
      },
      null,
      2
    )}\n`
  );
}

const manifestPath = join(AF, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.r2_note =
  "r2 correction-pass fixtures (BYP-C-01..09, BYP-B-01..04, and " +
  "same-class finds), regenerated by tools/gen-r2-fixtures.mjs. " +
  "Mechanism notes name the finding register entry; expected finding " +
  "multisets live in r2/expected/*.json. No fixture passes silently.";
manifest.r2_fixtures = register;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(
  `wrote ${Object.keys(register).length} r2 fixtures + expected sets\n`
);
