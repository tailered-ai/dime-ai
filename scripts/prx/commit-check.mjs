// PRX v1.1 commit-message checker — pure library, no CLI side effects.
// Replaces the rejected v1.0 first-word / whole-line-exemption heuristics
// (SOL-PRX-006, SOL-PRX-007) with a structural parser: subject, separator,
// body paragraphs, fences, URLs, and a formal trailer block are distinct
// structures, and exemption spans are narrow (the URL token itself, the
// parsed trailer block itself).
import {
  GOVERNED_TRAILER_KEYS,
  makeFinding,
  REF_MAX_LENGTH,
  REF_RE,
  RUN_ID_RE,
} from "./rules.mjs";

const SIZE_LIMIT = 1024 * 1024;
const CONVENTIONAL_TYPES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "refactor",
  "test",
  "perf",
  "ci",
  "build",
  "style",
  "revert",
];
const CONVENTIONAL_RE = new RegExp(
  `^(${CONVENTIONAL_TYPES.join("|")})(\\([A-Za-z0-9][A-Za-z0-9._/-]*\\))?!?: \\S`
);
// Strip variant for the mood heuristic: identical prefix shape but it must
// NOT consume the first description character (review finding: a copula as
// the first description word was silently missed).
const PREFIX_STRIP_RE = new RegExp(
  `^(${CONVENTIONAL_TYPES.join("|")})(\\([A-Za-z0-9][A-Za-z0-9._/-]*\\))?!?: `
);
// A trailer line is "Key:" followed by an optional value. The empty-value
// form MUST parse as a trailer line so that "Run-Id:" is judged as an empty
// governed value instead of silently degrading the whole block to prose
// (v1.0 accepted exactly that bypass, Sol case C02).
const TRAILER_LINE_RE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/;
const TRAILER_CONTINUATION_RE = /^[ \t]+\S/;
const URL_RE = /https?:\/\/[^\s<>]+/g;
const FENCE_RE = /^(`{3,}|~{3,})/;
// Evidence grammar (REF_RE) and its length cap are shared with the body
// checker via rules.mjs so the two surfaces cannot drift (Sol case C09).
const CO_AUTHOR_RE = /^[^<>]+ <[^<>@\s]+@[^<>@\s]+\.[A-Za-z]{2,}>$/;
const COPULA_RE = /(^|\s)(is|are|was|were)(\s|$)/;

export function parseCommitMessage(raw) {
  const text = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const lines = text.split("\n");
  const subject = lines[0] ?? "";

  let bodyStart = 1;
  let separatorBlanks = 0;
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") {
    separatorBlanks += 1;
    bodyStart += 1;
  }
  const bodyLines = lines
    .slice(bodyStart)
    .map((textLine, i) => ({ text: textLine, line: bodyStart + i + 1 }));

  // Fence tracking over the body.
  let inFence = false;
  let fenceMarker = "";
  for (const l of bodyLines) {
    const m = l.text.match(FENCE_RE);
    if (!m) {
      l.inFence = inFence;
      continue;
    }
    if (!inFence) {
      inFence = true;
      fenceMarker = m[1][0];
      l.inFence = true;
    } else if (m[1][0] === fenceMarker) {
      inFence = false;
      l.inFence = true;
    } else {
      l.inFence = true;
    }
  }
  const unclosedFence = inFence;

  // Formal trailer block: the final non-blank run of body lines, outside any
  // fence, in which every line is trailer-shaped or a continuation. This is
  // a documented strict adaptation of git interpret-trailers.
  let trailers = null;
  if (!unclosedFence && bodyLines.length > 0) {
    let end = bodyLines.length - 1;
    while (end >= 0 && bodyLines[end].text.trim() === "") end -= 1;
    let start = end;
    while (start >= 0 && bodyLines[start].text.trim() !== "") start -= 1;
    start += 1;
    if (end >= start && start >= 0) {
      const block = bodyLines.slice(start, end + 1);
      const allShaped =
        block.every(
          l =>
            TRAILER_LINE_RE.test(l.text) || TRAILER_CONTINUATION_RE.test(l.text)
        ) &&
        !block[0].inFence &&
        TRAILER_LINE_RE.test(block[0].text);
      if (allShaped) {
        const parsed = [];
        for (const l of block) {
          const m = l.text.match(TRAILER_LINE_RE);
          if (m) {
            parsed.push({ key: m[1], value: m[2].trim(), line: l.line });
          } else if (parsed.length > 0) {
            parsed[parsed.length - 1].value += ` ${l.text.trim()}`;
          }
        }
        trailers = {
          entries: parsed,
          startLine: block[0].line,
          blockLines: block.map(l => l.line),
        };
      }
    }
  }

  return { subject, separatorBlanks, bodyLines, trailers, unclosedFence };
}

function trailerLines(parsed) {
  // The whole parsed trailer block is the exemption span, continuation
  // lines included (the standard's wording is the contract here).
  return new Set(parsed.trailers?.blockLines ?? []);
}

export function checkCommit(raw, opts = {}) {
  const findings = [];
  if (typeof raw !== "string" || raw.length > SIZE_LIMIT) {
    findings.push(
      makeFinding("PRX-C-SIZE", "commit message exceeds the 1 MiB bound")
    );
    return findings;
  }
  const parsed = parseCommitMessage(raw);
  const { subject, separatorBlanks, bodyLines, trailers, unclosedFence } =
    parsed;
  const hasBody = bodyLines.some(l => l.text.trim() !== "");

  // PRX-C-SUBJECT
  if (subject.trim() === "") {
    findings.push(makeFinding("PRX-C-SUBJECT", "subject line is empty", 1));
  } else {
    if (subject !== subject.trim()) {
      findings.push(
        makeFinding(
          "PRX-C-SUBJECT",
          "subject has leading or trailing whitespace",
          1
        )
      );
    }
    if (/\.\s*$/.test(subject)) {
      findings.push(
        makeFinding("PRX-C-SUBJECT", "subject ends with a period", 1)
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(subject)) {
      findings.push(
        makeFinding("PRX-C-SUBJECT", "subject contains control characters", 1)
      );
    }
  }

  // Exemptions come from commit topology or authenticated metadata supplied
  // by the caller — never from the subject text (Sol case C03).
  const exemptFromPrefix =
    opts.isMerge === true ||
    opts.authorIsBot === true ||
    isGeneratedRevert(subject, bodyLines);

  // PRX-C-FIXUP
  if (/^(fixup!|squash!)/.test(subject)) {
    findings.push(
      makeFinding(
        "PRX-C-FIXUP",
        "fixup!/squash! commit must be autosquashed before it reaches a " +
          "mainline range",
        1
      )
    );
  } else if (!exemptFromPrefix && !CONVENTIONAL_RE.test(subject)) {
    findings.push(
      makeFinding(
        "PRX-C-PREFIX",
        "subject does not match the repository convention " +
          '"type(scope): summary"; merge/bot/revert exemptions require ' +
          "topology or authenticated metadata",
        1
      )
    );
  }

  // PRX-C-SEPARATOR
  if (hasBody && separatorBlanks !== 1) {
    findings.push(
      makeFinding(
        "PRX-C-SEPARATOR",
        `exactly one blank line must separate subject and body ` +
          `(found ${separatorBlanks})`,
        2
      )
    );
  }

  // PRX-C-LENGTH (advisory)
  if (subject.length > 72) {
    findings.push(
      makeFinding(
        "PRX-C-LENGTH",
        `subject is ${subject.length} characters (advisory threshold 72)`,
        1
      )
    );
  }

  // PRX-C-FENCE
  if (unclosedFence) {
    findings.push(
      makeFinding("PRX-C-FENCE", "unclosed code fence in commit body")
    );
  }

  // PRX-C-WRAP (advisory) — narrow exemption spans only.
  const exemptLines = trailerLines(parsed);
  for (const l of bodyLines) {
    if (l.inFence || exemptLines.has(l.line)) continue;
    if (/^\s*\|/.test(l.text)) continue;
    const withoutUrls = l.text.replace(URL_RE, "");
    if (withoutUrls.length > 72) {
      findings.push(
        makeFinding(
          "PRX-C-WRAP",
          `body line is ${l.text.length} columns ` +
            `(${withoutUrls.length} excluding URL tokens; advisory limit 72)`,
          l.line
        )
      );
    }
  }

  // PRX-C-TRAILER — formal grammar for any parsed trailer block.
  const governedPresent =
    trailers !== null &&
    trailers.entries.some(e => e.key === "Run-Id" || e.key === "Evidence");
  if (trailers) {
    const counts = new Map();
    for (const e of trailers.entries) {
      counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
      if (e.value === "") {
        findings.push(
          makeFinding(
            "PRX-C-TRAILER",
            `trailer "${e.key}" has an empty value`,
            e.line
          )
        );
      }
    }
    for (const key of GOVERNED_TRAILER_KEYS) {
      if (key !== "Co-Authored-By" && (counts.get(key) ?? 0) > 1) {
        findings.push(
          makeFinding(
            "PRX-C-TRAILER",
            `governed trailer "${key}" appears ${counts.get(key)} times ` +
              "(exactly once required)"
          )
        );
      }
    }
  }

  // PRX-C-GOV — the governed-scope predicate: explicit opt-in from the
  // caller, or the commit declares itself governed by carrying a governed
  // identity trailer. Whether a commit OUGHT to be governed is a reviewer
  // rule; this library enforces the schema once the scope applies.
  const governed = opts.governed === true || governedPresent;
  if (governed) {
    const byKey = key => (trailers?.entries ?? []).filter(e => e.key === key);
    const runIds = byKey("Run-Id");
    if (runIds.length !== 1) {
      findings.push(
        makeFinding(
          "PRX-C-GOV",
          `governed commit must carry Run-Id exactly once (found ${runIds.length})`
        )
      );
    } else if (!RUN_ID_RE.test(runIds[0].value)) {
      findings.push(
        makeFinding(
          "PRX-C-GOV",
          `Run-Id "${truncate(runIds[0].value)}" does not match ` +
            "ONE-YYYYMMDD-TOKEN",
          runIds[0].line
        )
      );
    }
    const evidences = byKey("Evidence");
    if (evidences.length !== 1) {
      findings.push(
        makeFinding(
          "PRX-C-GOV",
          `governed commit must carry Evidence exactly once (found ${evidences.length})`
        )
      );
    } else {
      const v = evidences[0].value;
      if (v.length > REF_MAX_LENGTH || !REF_RE.test(v)) {
        findings.push(
          makeFinding(
            "PRX-C-GOV",
            `Evidence "${truncate(v)}" is not a bounded run/ or docs/ ` +
              "reference (or UNKNOWN)",
            evidences[0].line
          )
        );
      }
    }
    const coAuthors = byKey("Co-Authored-By");
    if (coAuthors.length === 0) {
      findings.push(
        makeFinding(
          "PRX-C-GOV",
          "governed commit must carry at least one Co-Authored-By trailer"
        )
      );
    }
    for (const c of coAuthors) {
      if (!CO_AUTHOR_RE.test(c.value)) {
        findings.push(
          makeFinding(
            "PRX-C-GOV",
            `Co-Authored-By "${truncate(c.value)}" is not "Name <email>"`,
            c.line
          )
        );
      }
    }
  }

  // PRX-C-MOOD (heuristic, declared) — a copula in the subject description
  // suggests indicative narration. This is the ONLY machine mood check;
  // imperative mood in general is a reviewer rule (SOL-PRX-007 honesty).
  const description = subject.replace(PREFIX_STRIP_RE, "").trim() || subject;
  if (COPULA_RE.test(description)) {
    findings.push(
      makeFinding(
        "PRX-C-MOOD",
        "subject reads as indicative (copula heuristic); write the summary " +
          "as an instruction",
        1
      )
    );
  }

  return findings;
}

// A git-generated revert is recognized by BOTH the generated subject shape
// and the generated body marker, never the subject alone.
function isGeneratedRevert(subject, bodyLines) {
  return (
    /^Revert "/.test(subject) &&
    bodyLines.some(l => /^This reverts commit [0-9a-f]{7,40}\b/.test(l.text))
  );
}

function truncate(s) {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
