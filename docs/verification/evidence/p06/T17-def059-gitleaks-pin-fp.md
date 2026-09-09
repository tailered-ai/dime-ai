# T17 — DEF-059: gitleaks false positive on the embedded submodule pin

Base: `43a33c84` · candidate head `7e86ad23` (the DEF-058 remediation commit) ·
serial rebind roster, gate `.github/workflows/gitleaks.yml#gitleaks`.

## Finding

```
Finding:  "EXPECTED_CLOUDFLARE_OS_PIN": "REDACTED"
RuleID:   cloudflare-api-key
File:     scripts/ci/contract.frozen.json  (line 5382)
```

Reproduced byte-for-byte with the governed gitleaks 8.24.3 over the gate's own
range (`--no-merges --first-parent f9a35aa2^..7e86ad23`): 1 leak.

## Why it is a false positive

The matched value is `b2a51b5426398c8353d9d4dd984bd525121ab5f2` — the
cloudflare-os **git commit SHA** pinned as the submodule gitlink. It is public
and immutable: it appears in plaintext in the root `.gitmodules`, in
`.github/workflows/tailered-os.yml` line 28, and in the upstream
`cloudflare/cloudflare-os` repository. A 40-hex commit SHA is not a credential.

The rule fires only on the **JSON** form (`"…CLOUDFLARE…": "<40-hex>"` —
quoted value adjacent to the keyword); the YAML form in the workflow is
unquoted and never matched, which is why main is green with the identical
value. The juxtaposition was introduced by DEF-058's remediation: the frozen
contract now embeds workflow-level env values, as fidelity requires.

## Remediation

`.gitleaks.toml` already carries the exact convention for this class — under
`regexTarget = "secret"`, fully-anchored literals for public git commit SHAs
(the Hugging Face model revisions: "These are Git commit SHAs, not
credentials"). The pin is added as one more fully-anchored literal:

```
'''^b2a51b5426398c8353d9d4dd984bd525121ab5f2$'''
```

Anchored to the exact 40 characters, it suppresses precisely one known public
SHA and structurally cannot mask a real credential. No rule is disabled, no
path is excluded, and detection is unchanged everywhere else.

## Negative proof obligations

1. Local re-scan of the same range with the amended config → 0 leaks.
2. The `p06-gitleaks-canary` ASSURANCE cycle (plant a real-shaped secret →
   gate FAILs → restore → gate green) must return to PROVEN, demonstrating the
   gate still rejects actual secrets after the change.

Maintenance note: when the submodule pin advances per
`platform/tailered-os/docs/UPSTREAM.md`, the reviewed bump commit should
replace this literal with the new SHA (same one-commit discipline as the
workflow's `EXPECTED_CLOUDFLARE_OS_PIN`).
