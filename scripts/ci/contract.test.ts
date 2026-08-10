/**
 * P02 validation suite — contract extraction, freeze, conformance.
 *
 *   P02.TEST01  byte-stable regeneration across repeats and wall-clock times
 *   P02.TEST02  every required + graduating context maps to exactly one check
 *   P02.NEG01   unsupported construct -> CONTRACT_GENERATION_FAILED, prior kept
 *   P02.NEG02   workflow changed without regeneration -> CONTRACT_DRIFT
 *   P02.NEG03   hand-edited frozen contract -> pin mismatch
 *   P02.NEG04   required context without a mapped check -> named failure
 *   P02.REG01   pinned-parser regression over every observed construct class
 *   P02.CONF01  contract <-> workflow tree conformance
 *   P02.CONF02  CONTRACT.md <-> machine contract conformance
 *
 * Every fixture lives in an OS temp directory. No poison workflow is ever
 * written under the repository's scanned `.github/workflows/` path.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import {
  CONSTRUCT_ALLOWLIST,
  ContractStop,
  buildContract,
  canonicalize,
  canonicalJson,
  censusCorpus,
  classifyStep,
  emitContract,
  normalizeScalar,
  parserVersion,
  sha256,
} from "./contract-extract.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  GRADUATING_CONTEXTS,
  REQUIRED_CONTEXTS,
  auditYamlIsolation,
  loadContract,
  renderDoc,
  verifyConformance,
} from "./contract-conformance.mjs";
import { parse } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const temps: string[] = [];

afterAll(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

/** Isolated copy of the real workflow corpus. Never the repository itself. */
function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "p02-"));
  temps.push(root);
  mkdirSync(path.join(root, ".github"), { recursive: true });
  cpSync(
    path.join(REPO, ".github/workflows"),
    path.join(root, ".github/workflows"),
    { recursive: true }
  );
  return root;
}

function emitInto(root: string) {
  const contractPath = path.join(root, "contract.frozen.json");
  const shaPath = path.join(root, "contract.sha256");
  const result = emitContract(root, {
    contractPath,
    shaPath,
    toolchainRoot: REPO,
  });
  return { contractPath, shaPath, ...result };
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe("P02.TEST01 — byte-stable regeneration", () => {
  it("produces identical bytes, sha, identities and rendering across repeats and wall-clock times", () => {
    const root = fixtureRoot();
    const runs: Array<{
      bytes: string;
      sha: string;
      doc: string;
      second: number;
    }> = [];
    const once = () => {
      const r = emitInto(root);
      runs.push({
        bytes: readFileSync(r.contractPath, "utf8"),
        sha: readFileSync(r.shaPath, "utf8").trim().split(/\s+/)[0],
        doc: renderDoc(JSON.parse(readFileSync(r.contractPath, "utf8"))),
        second: Math.floor(Date.now() / 1000),
      });
    };
    once();
    once();
    once();
    sleepSync(1100); // cross a wall-clock second boundary
    once();
    once();

    expect(runs).toHaveLength(5);
    expect(new Set(runs.map(r => r.bytes)).size).toBe(1);
    expect(new Set(runs.map(r => r.sha)).size).toBe(1);
    expect(new Set(runs.map(r => r.doc)).size).toBe(1);
    expect(new Set(runs.map(r => r.second)).size).toBeGreaterThanOrEqual(2);

    // The pin is computed over the exact emitted bytes.
    expect(sha256(Buffer.from(runs[0].bytes, "utf8"))).toBe(runs[0].sha);
  });

  it("carries no timestamp, run id, absolute path, username or hostname", () => {
    const root = fixtureRoot();
    const bytes = readFileSync(emitInto(root).contractPath, "utf8");
    expect(bytes).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // ISO timestamp
    expect(bytes).not.toContain(root); // fixture temp path
    expect(bytes).not.toContain(REPO); // repository absolute path
    expect(bytes).not.toMatch(/\/Users\/|\/home\/|\\Users\\/);
    expect(bytes).not.toMatch(/"run_id"|generated_at|"hostname"/);
  });
});

describe("P02.TEST02 — required and graduating context mapping", () => {
  it("maps every currently required context to exactly one check", () => {
    const contract = loadContract();
    const byContext = new Map<string, string[]>();
    for (const check of contract.checks) {
      if (!check.status_context) continue;
      const list = byContext.get(check.status_context) ?? [];
      list.push(check.check_id);
      byContext.set(check.status_context, list);
    }
    expect(REQUIRED_CONTEXTS).toHaveLength(9);
    for (const context of REQUIRED_CONTEXTS) {
      expect(
        byContext.get(context),
        `required context "${context}"`
      ).toHaveLength(1);
    }
  });

  it("represents the five graduating contexts WITHOUT marking them required", () => {
    const contract = loadContract();
    const contexts = new Set(
      contract.checks
        .filter((c: any) => c.status_context)
        .map((c: any) => c.status_context)
    );
    expect(GRADUATING_CONTEXTS).toHaveLength(5);
    for (const context of GRADUATING_CONTEXTS) {
      expect(contexts.has(context), `graduating context "${context}"`).toBe(
        true
      );
      // Ruleset state and workflow existence are different facts.
      expect(REQUIRED_CONTEXTS).not.toContain(context);
    }
  });

  it("gives every CI-ONLY check an explicit reason and omits no step", () => {
    const contract = loadContract();
    const stepsRepresented = contract.checks.reduce(
      (acc: number, c: any) => acc + c.step_count,
      0
    );
    expect(stepsRepresented).toBe(contract.generated_from.step_count);
    for (const check of contract.checks) {
      if (check.runnability === "CI-ONLY") {
        expect(check.ci_only_reasons?.length, check.check_id).toBeGreaterThan(
          0
        );
      }
    }
  });
});

describe("P02.NEG01 — unsupported construct fails closed", () => {
  it("aborts with CONTRACT_GENERATION_FAILED and preserves the prior valid artifact", () => {
    const root = fixtureRoot();
    const good = emitInto(root);
    const goodBytes = readFileSync(good.contractPath, "utf8");
    const goodSha = readFileSync(good.shaPath, "utf8");

    // A syntactically valid but NON-allowlisted construct: job-level `container`.
    writeFileSync(
      path.join(root, ".github/workflows/zz-poison.yml"),
      [
        "name: poison",
        "on:",
        "  pull_request:",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  poisoned:",
        "    runs-on: ubuntu-latest",
        "    container: node:22",
        "    steps:",
        "      - run: echo hi",
        "",
      ].join("\n")
    );

    let stop: any = null;
    try {
      emitContract(root, {
        contractPath: good.contractPath,
        shaPath: good.shaPath,
        toolchainRoot: REPO,
      });
    } catch (error) {
      stop = error;
    }
    expect(stop).toBeInstanceOf(ContractStop);
    expect(stop.reason).toBe("CONTRACT_GENERATION_FAILED");
    expect(stop.unclassified_constructs.join(" ")).toMatch(
      /job_keys\.container/
    );

    // The previous known-good artifact is untouched — no partial replacement.
    expect(readFileSync(good.contractPath, "utf8")).toBe(goodBytes);
    expect(readFileSync(good.shaPath, "utf8")).toBe(goodSha);

    // Control: removing the poison restores a clean generation.
    rmSync(path.join(root, ".github/workflows/zz-poison.yml"));
    expect(() => emitInto(root)).not.toThrow();
  });

  it("has no implicit ignored class — every observed construct is classified", () => {
    const census = censusCorpus(REPO, { toolchainRoot: REPO });
    for (const [category, observed] of Object.entries({
      workflow_keys: census.workflow_keys,
      triggers: census.triggers,
      job_keys: census.job_keys,
      step_keys: census.step_keys,
      expression_roots: census.expression_roots,
    })) {
      for (const key of Object.keys(observed as object)) {
        const entry = (CONSTRUCT_ALLOWLIST as any)[category]?.[key];
        expect(entry, `${category}.${key}`).toBeDefined();
        expect(entry[0]).toMatch(
          /^(SUPPORTED|SUPPORTED_WITH_EXPLICIT_NORMALIZATION|CI_ONLY_BUT_REPRESENTED)$/
        );
        expect(entry[1].length).toBeGreaterThan(5);
      }
    }
  });
});

describe("P02.NEG02 — workflow changed without regeneration", () => {
  it("fails CONTRACT_DRIFT naming the affected workflow", () => {
    const root = fixtureRoot();
    const emitted = emitInto(root);
    const target = ".github/workflows/ci.yml";
    const file = path.join(root, target);
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}\n# drift introduced by P02.NEG02\n`
    );

    const result = verifyConformance({
      root,
      contractPath: emitted.contractPath,
      shaPath: emitted.shaPath,
      toolchainRoot: REPO,
    });
    expect(result.ok).toBe(false);
    const drift = result.problems.filter((p: string) =>
      p.includes("CONTRACT_DRIFT")
    );
    expect(drift.length).toBeGreaterThan(0);
    expect(drift.join(" ")).toContain(target);

    // Control: regenerating restores conformance.
    emitInto(root);
    expect(
      verifyConformance({
        root,
        contractPath: emitted.contractPath,
        shaPath: emitted.shaPath,
        toolchainRoot: REPO,
      }).ok
    ).toBe(true);
  });

  it("detects a workflow that exists but is not represented", () => {
    const root = fixtureRoot();
    const emitted = emitInto(root);
    writeFileSync(
      path.join(root, ".github/workflows/zz-new.yml"),
      "name: new\non:\n  push:\npermissions:\n  contents: read\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n"
    );
    const result = verifyConformance({
      root,
      contractPath: emitted.contractPath,
      shaPath: emitted.shaPath,
      toolchainRoot: REPO,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("not represented");
  });
});

describe("P02.NEG03 — hand-edited frozen contract", () => {
  it("fails the integrity pin for its own declared reason", () => {
    const root = fixtureRoot();
    const emitted = emitInto(root);
    const before = readFileSync(emitted.contractPath, "utf8");
    const contract = JSON.parse(before);
    // The edit must actually change BYTES and must trip ONLY the pin detector,
    // so a red result cannot be attributed to the wrong check (P01 DEF-008).
    // Setting an already-equal field would be a no-op and prove nothing — the
    // first version of this test did exactly that and failed for the right
    // reason: the detector was correct, the fixture was not.
    contract.checks[0].hand_edited_marker = true;
    const after = `${JSON.stringify(contract, null, 2)}\n`;
    expect(after).not.toBe(before);
    writeFileSync(emitted.contractPath, after);

    const result = verifyConformance({
      root,
      contractPath: emitted.contractPath,
      shaPath: emitted.shaPath,
      toolchainRoot: REPO,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(
      /CONTRACT_DRIFT: contract\.sha256 pin/
    );
  });
});

describe("P02.NEG04 — required context without a mapped check", () => {
  it("fails naming the exact context, with the pin kept valid to isolate the detector", () => {
    const root = fixtureRoot();
    const emitted = emitInto(root);
    const contract = JSON.parse(readFileSync(emitted.contractPath, "utf8"));
    const victim = "TypeScript Check";
    for (const check of contract.checks) {
      if (check.status_context === victim) check.status_context = null;
    }
    const bytes = `${JSON.stringify(contract, null, 2)}\n`;
    writeFileSync(emitted.contractPath, bytes);
    // Re-pin deliberately: this isolates the MAPPING detector from the hash
    // detector, so a pass cannot be attributed to the wrong check (P01 DEF-008).
    writeFileSync(
      emitted.shaPath,
      `${sha256(Buffer.from(bytes, "utf8"))}  contract.frozen.json\n`
    );

    const result = verifyConformance({
      root,
      contractPath: emitted.contractPath,
      shaPath: emitted.shaPath,
      toolchainRoot: REPO,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain(
      `REQUIRED_CONTEXT_UNMAPPED: "${victim}"`
    );
    expect(result.problems.join(" ")).not.toMatch(/contract\.sha256 pin/);
  });
});

describe("P02.REG01 — pinned-parser regression over observed construct classes", () => {
  it("pins yaml@2.9.0 exactly and resolves that exact version", () => {
    expect(parserVersion(REPO)).toBe("yaml@2.9.0");
  });

  it("applies YAML 1.2 core semantics, not YAML 1.1", () => {
    // `on:` must be the STRING key. YAML 1.1 would produce boolean true and
    // every workflow trigger would silently vanish.
    const doc = parse("name: x\non:\n  push:\njobs: {}\n");
    expect(Object.keys(doc)).toContain("on");
    expect(Object.hasOwn(doc, "true")).toBe(false);
    // 1.1 boolean words stay strings.
    for (const word of ["yes", "no", "on", "off", "y", "n"]) {
      expect(parse(`k: ${word}`).k, word).toBe(word);
    }
    expect(parse("k: true").k).toBe(true);
    expect(parse("k: null").k).toBeNull();
    expect(parse("k: ~").k).toBeNull();
  });

  it("handles strategy/matrix as observed in the corpus", () => {
    const doc = parse(
      "jobs:\n  j:\n    strategy:\n      fail-fast: false\n      matrix:\n        browser: [chromium, firefox]\n"
    );
    expect(doc.jobs.j.strategy.matrix.browser).toEqual(["chromium", "firefox"]);
    expect(doc.jobs.j.strategy["fail-fast"]).toBe(false);
  });

  it("handles service containers as observed in ci.yml", () => {
    const doc = parse(
      [
        "jobs:",
        "  j:",
        "    services:",
        "      mysql:",
        "        image: mysql:8",
        "        env:",
        '          MYSQL_ALLOW_EMPTY_PASSWORD: "1"',
        "        ports:",
        "          - 3306:3306",
        "        options: >-",
        '          --health-cmd="mysqladmin ping" --health-retries=20',
        "",
      ].join("\n")
    );
    const svc = doc.jobs.j.services.mysql;
    expect(svc.image).toBe("mysql:8");
    expect(svc.env.MYSQL_ALLOW_EMPTY_PASSWORD).toBe("1"); // quoted -> string
    expect(svc.ports).toEqual(["3306:3306"]); // colon form stays a string
    expect(svc.options).toContain("--health-cmd");
  });

  it("preserves expressions verbatim inside values", () => {
    const doc = parse(
      "jobs:\n  j:\n    name: \"Trigger ${{ inputs.job }}\"\n    if: ${{ github.event_name == 'push' }}\n"
    );
    expect(doc.jobs.j.name).toBe("Trigger ${{ inputs.job }}");
    expect(doc.jobs.j.if).toBe("${{ github.event_name == 'push' }}");
  });

  it("preserves multiline run bodies including heredocs", () => {
    const run = parse(
      [
        "steps:",
        "  - run: |",
        "      set -e",
        "      node - <<'EOF'",
        "      console.log(1)",
        "      EOF",
        "",
      ].join("\n")
    ).steps[0].run;
    expect(run).toBe("set -e\nnode - <<'EOF'\nconsole.log(1)\nEOF\n");
    expect(run.split("\n")).toHaveLength(5);
  });

  it("keeps SHA-pinned uses refs intact and detects permission blocks", () => {
    const doc = parse(
      "permissions:\n  contents: read\n  security-events: write\njobs:\n  j:\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n"
    );
    expect(doc.permissions).toEqual({
      contents: "read",
      "security-events": "write",
    });
    expect(doc.jobs.j.steps[0].uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it("classifies tool requirements from RAW text, not escaped renderings (DEF-018)", () => {
    const step = { run: 'pipx install "zizmor==1.2.3"' };
    expect(classifyStep(step).required_tools).toEqual(["zizmor"]);
    expect(
      classifyStep({ run: 'pipx install "semgrep==1.0"' }).required_tools
    ).toEqual(["semgrep"]);
  });

  it("treats artifact and SARIF upload as non-gating side effects (DEF-017)", () => {
    expect(classifyStep({ uses: "actions/upload-artifact@abc" }).gating).toBe(
      false
    );
    expect(
      classifyStep({ uses: "github/codeql-action/upload-sarif@abc" }).gating
    ).toBe(false);
    expect(
      classifyStep({ uses: "github/codeql-action/analyze@abc" }).gating
    ).toBe(true);
  });
});

describe("P02.T02 — canonicalization rules", () => {
  it("sorts mapping keys but never reorders sequences", () => {
    const canon = canonicalize({ b: 1, a: 2, list: ["z", "a", "m"] });
    expect(Object.keys(canon)).toEqual(["a", "b", "list"]);
    expect(canon.list).toEqual(["z", "a", "m"]);
  });

  it("keeps null / boolean / number / string distinct", () => {
    const canon = canonicalize({ n: null, b: true, i: 7, s: "true" });
    expect(canon.n).toBeNull();
    expect(canon.b).toBe(true);
    expect(canon.i).toBe(7);
    expect(canon.s).toBe("true");
  });

  it("normalizes CRLF to LF without touching internal content", () => {
    expect(normalizeScalar("a\r\nb\r\n")).toBe("a\nb\n");
    expect(normalizeScalar("echo ${{ github.sha }}")).toBe(
      "echo ${{ github.sha }}"
    );
  });

  it("never collapses semantically different workflows to the same canonical form", () => {
    const a = canonicalJson(
      canonicalize(parse("jobs:\n  j:\n    steps:\n      - run: a\n"))
    );
    const b = canonicalJson(
      canonicalize(parse("jobs:\n  j:\n    steps:\n      - run: b\n"))
    );
    expect(a).not.toBe(b);
  });

  it("canonicalizes equal-but-differently-ordered mappings identically", () => {
    const a = canonicalJson(canonicalize(parse("on:\n  push:\nname: x\n")));
    const b = canonicalJson(canonicalize(parse("name: x\non:\n  push:\n")));
    expect(a).toBe(b);
  });
});

describe("P02.CONF01 / P02.CONF02 — conformance", () => {
  it("the checked-in contract conforms to the current workflow tree", () => {
    const result = verifyConformance();
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("CONTRACT.md is byte-identical to a fresh render of the machine contract", () => {
    const contract = loadContract();
    const onDisk = readFileSync(
      path.join(REPO, "docs/verification/CONTRACT.md"),
      "utf8"
    );
    expect(renderDoc(contract)).toBe(onDisk);
  });

  it("per-workflow identities are content-based, never path or host based", () => {
    const contract = loadContract();
    for (const wf of contract.generated_from.workflows) {
      expect(wf.raw_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(wf.canonical_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256(readFileSync(path.join(REPO, wf.path)))).toBe(
        wf.raw_sha256
      );
    }
  });
});

describe("P02.AUD01 — runtime YAML isolation", () => {
  it("no runtime module parses workflow YAML", () => {
    const result = auditYamlIsolation();
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("every YAML allowlist entry is explicit and reasoned", () => {
    const result = auditYamlIsolation();
    expect(result.allowlist.length).toBeGreaterThan(0);
    for (const entry of result.allowlist) {
      expect(entry.file).toMatch(/^scripts\/ci\//);
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });

  it("detects a runtime module that imports a YAML parser", () => {
    const root = mkdtempSync(path.join(tmpdir(), "p02-aud-"));
    temps.push(root);
    const scan = path.join(root, "scripts", "ci");
    mkdirSync(scan, { recursive: true });
    writeFileSync(
      path.join(scan, "clean.mjs"),
      'import { loadContract } from "./contract-conformance.mjs";\nexport const x = loadContract;\n'
    );
    expect(auditYamlIsolation({ root, scanDir: "scripts/ci" }).ok).toBe(true);

    writeFileSync(
      path.join(scan, "bypass.mjs"),
      'import { parse } from "yaml";\nexport const p = s => parse(s);\n'
    );
    const bad = auditYamlIsolation({ root, scanDir: "scripts/ci" });
    expect(bad.ok).toBe(false);
    expect(bad.violations.map((v: any) => v.file)).toContain(
      "scripts/ci/bypass.mjs"
    );

    rmSync(path.join(scan, "bypass.mjs"));
    expect(auditYamlIsolation({ root, scanDir: "scripts/ci" }).ok).toBe(true);
  });
});
