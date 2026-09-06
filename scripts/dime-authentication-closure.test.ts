import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";

import { buildAuthenticationClosureCandidate } from "./build-dime-authentication-closure.mjs";
import {
  buildAuthenticationClosureManifest,
  createAuthenticationClosureEnvelopeForTest,
  verifyAuthenticationClosure,
} from "./lib/dime-authentication-closure.mjs";

const execFileAsync = promisify(execFile);

async function makeWritable(path: string) {
  const state = await lstat(path).catch(() => null);
  if (!state) return;
  if (state.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) {
      await makeWritable(resolve(path, name));
    }
  } else if (!state.isSymbolicLink()) {
    await chmod(path, 0o600);
  }
}

async function hardenApplication(path: string) {
  const state = await lstat(path);
  if (state.isDirectory()) {
    for (const name of await readdir(path)) {
      await hardenApplication(resolve(path, name));
    }
    await chmod(path, 0o555);
  } else {
    await chmod(path, 0o444);
  }
}

async function closureFixture() {
  const unresolvedRoot = await mkdtemp(resolve(tmpdir(), "dime-auth-closure-"));
  const root = await realpath(unresolvedRoot);
  const application = resolve(root, "application");
  const trust = resolve(root, "trust");
  const entrypoint = resolve(
    application,
    "scripts/dime-production-auth.bundle.mjs"
  );
  const importedLocalModule = resolve(
    application,
    "scripts/imported-local-module.mjs"
  );
  const accessConfig = resolve(application, "config/dime-agent-access.v1.json");
  const platformConfig = resolve(
    application,
    "ml/dime-1.0/configs/platform_contract.json"
  );
  const playwrightFile = resolve(
    application,
    "node_modules/playwright/index.js"
  );
  const playwrightCoreFile = resolve(
    application,
    "node_modules/playwright-core/index.js"
  );
  const node = resolve(root, "node");
  const browser = resolve(root, "browser");
  const manifestPath = resolve(trust, "closure-v2.json");
  const publicKeyPath = resolve(trust, "closure-ed25519-public.pem");
  await Promise.all([
    mkdir(resolve(application, "scripts"), { recursive: true }),
    mkdir(resolve(application, "config"), { recursive: true }),
    mkdir(resolve(application, "ml/dime-1.0/configs"), { recursive: true }),
    mkdir(resolve(application, "node_modules/playwright"), {
      recursive: true,
    }),
    mkdir(resolve(application, "node_modules/playwright-core"), {
      recursive: true,
    }),
    mkdir(trust, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(entrypoint, "/* deterministic bundled auth */\n"),
    writeFile(importedLocalModule, "export const closed = true;\n"),
    writeFile(accessConfig, '{"origin":"https://example.invalid"}\n'),
    writeFile(platformConfig, '{"model":"dime"}\n'),
    writeFile(playwrightFile, "export const packageName = 'playwright';\n"),
    writeFile(
      playwrightCoreFile,
      "export const packageName = 'playwright-core';\n"
    ),
    writeFile(node, "#!/bin/sh\nexit 0\n"),
    writeFile(browser, "#!/bin/sh\nexit 0\n"),
  ]);
  await Promise.all([chmod(node, 0o555), chmod(browser, 0o555)]);
  await hardenApplication(application);
  await chmod(trust, 0o755);
  const manifest = await buildAuthenticationClosureManifest({
    applicationDirectory: application,
    entrypointPath: entrypoint,
    nodePath: node,
    browserPath: browser,
    configurationPaths: [accessConfig, platformConfig],
    expectedUid: process.getuid(),
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const envelope = createAuthenticationClosureEnvelopeForTest(
    manifest,
    privateKey,
    publicKey,
    {
      expectedApplicationDirectory: application,
      expectedEntrypoint: entrypoint,
    }
  );
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(envelope)}\n`, { mode: 0o444 }),
    writeFile(
      publicKeyPath,
      publicKey.export({ type: "spki", format: "pem" }),
      { mode: 0o444 }
    ),
  ]);
  await Promise.all([chmod(manifestPath, 0o444), chmod(publicKeyPath, 0o444)]);
  const verify = () =>
    verifyAuthenticationClosure({
      trustDirectoryPath: trust,
      manifestPath,
      publicKeyPath,
      expectedUid: process.getuid(),
      expectedApplicationDirectory: application,
      expectedEntrypoint: entrypoint,
      environment: {},
    });
  const cleanup = async () => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  };
  return {
    root,
    application,
    trust,
    entrypoint,
    importedLocalModule,
    playwrightFile,
    browser,
    manifestPath,
    publicKeyPath,
    verify,
    cleanup,
  };
}

test("the complete signed authentication closure is accepted", async () => {
  const fixture = await closureFixture();
  try {
    const result = await fixture.verify();
    assert.equal(result.status, "PASS");
    assert.equal(result.credentialBytesRead, 0);
    assert.equal(result.authorization, "NONE");
  } finally {
    await fixture.cleanup();
  }
});

for (const scenario of [
  {
    name: "top-level bundle unchanged but imported local module modified",
    target: (fixture: Awaited<ReturnType<typeof closureFixture>>) =>
      fixture.importedLocalModule,
  },
  {
    name: "bundled authentication artifact modified",
    target: (fixture: Awaited<ReturnType<typeof closureFixture>>) =>
      fixture.entrypoint,
  },
  {
    name: "Playwright package file modified",
    target: (fixture: Awaited<ReturnType<typeof closureFixture>>) =>
      fixture.playwrightFile,
  },
] as const) {
  test(`${scenario.name} is rejected`, async () => {
    const fixture = await closureFixture();
    try {
      const path = scenario.target(fixture);
      await chmod(path, 0o600);
      await writeFile(path, "tampered\n");
      await chmod(path, 0o444);
      await assert.rejects(fixture.verify(), /inventory|package tree|bundle/);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("modified browser executable is rejected", async () => {
  const fixture = await closureFixture();
  try {
    await chmod(fixture.browser, 0o700);
    await writeFile(fixture.browser, "#!/bin/sh\nexit 7\n");
    await chmod(fixture.browser, 0o555);
    await assert.rejects(fixture.verify(), /browser executable does not match/);
  } finally {
    await fixture.cleanup();
  }
});

test("modified closure manifest is rejected", async () => {
  const fixture = await closureFixture();
  try {
    await chmod(fixture.manifestPath, 0o600);
    const envelope = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    envelope.manifest.credentialTransport = "ARGV";
    await writeFile(fixture.manifestPath, JSON.stringify(envelope));
    await chmod(fixture.manifestPath, 0o444);
    await assert.rejects(fixture.verify(), /signature is invalid/);
  } finally {
    await fixture.cleanup();
  }
});

test("invalid closure manifest signature is rejected", async () => {
  const fixture = await closureFixture();
  try {
    await chmod(fixture.manifestPath, 0o600);
    const envelope = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    envelope.signature = Buffer.alloc(64, 7).toString("base64");
    await writeFile(fixture.manifestPath, JSON.stringify(envelope));
    await chmod(fixture.manifestPath, 0o444);
    await assert.rejects(fixture.verify(), /signature is invalid/);
  } finally {
    await fixture.cleanup();
  }
});

test("extra executable file in the closed inventory is rejected", async () => {
  const fixture = await closureFixture();
  const extra = resolve(fixture.application, "scripts/extra-executable");
  try {
    await chmod(resolve(fixture.application, "scripts"), 0o755);
    await writeFile(extra, "#!/bin/sh\nexit 0\n", { mode: 0o555 });
    await chmod(resolve(fixture.application, "scripts"), 0o555);
    await assert.rejects(fixture.verify(), /inventory|file mode/);
  } finally {
    await fixture.cleanup();
  }
});

test("symlinked dependency is rejected", async () => {
  const fixture = await closureFixture();
  const linked = resolve(fixture.application, "scripts/linked-module.mjs");
  try {
    await chmod(resolve(fixture.application, "scripts"), 0o755);
    await symlink(fixture.importedLocalModule, linked);
    await chmod(resolve(fixture.application, "scripts"), 0o555);
    await assert.rejects(fixture.verify(), /symlink/);
  } finally {
    await fixture.cleanup();
  }
});

test("writable dependency is rejected", async () => {
  const fixture = await closureFixture();
  try {
    await chmod(fixture.playwrightFile, 0o644);
    await assert.rejects(fixture.verify(), /file mode/);
  } finally {
    await fixture.cleanup();
  }
});

test("NODE_PATH and NODE_OPTIONS injection cannot enter credential execution", async () => {
  const fixture = await closureFixture();
  try {
    for (const environment of [
      { NODE_PATH: "/attacker/modules" },
      { NODE_OPTIONS: "--require=/attacker/hook.cjs" },
    ]) {
      await assert.rejects(
        verifyAuthenticationClosure({
          trustDirectoryPath: fixture.trust,
          manifestPath: fixture.manifestPath,
          publicKeyPath: fixture.publicKeyPath,
          expectedUid: process.getuid(),
          expectedApplicationDirectory: fixture.application,
          expectedEntrypoint: fixture.entrypoint,
          environment,
        }),
        /Node injection variables were not cleared/
      );
    }
    await assert.rejects(
      verifyAuthenticationClosure({
        trustDirectoryPath: fixture.trust,
        manifestPath: fixture.manifestPath,
        publicKeyPath: fixture.publicKeyPath,
        expectedUid: process.getuid(),
        expectedApplicationDirectory: fixture.application,
        expectedEntrypoint: fixture.entrypoint,
        environment: { DYLD_INSERT_LIBRARIES: "/attacker/inject.dylib" },
      }),
      /outside the fixed allowlist/
    );
    const brokerSource = await readFile(
      resolve(process.cwd(), "scripts/dime-railway-keychain.c"),
      "utf8"
    );
    assert.equal(
      /append_environment\([^;]+,\s*"NODE_(?:PATH|OPTIONS)"/s.test(
        brokerSource
      ),
      false
    );
  } finally {
    await fixture.cleanup();
  }
});

test("native broker verifies closure before any credential retrieval", async () => {
  const brokerSource = await readFile(
    resolve(process.cwd(), "scripts/dime-railway-keychain.c"),
    "utf8"
  );
  const functionStart = brokerSource.indexOf(
    "static int execute_platform_auth"
  );
  const closureVerification = brokerSource.indexOf(
    "verify_authentication_closure_before_credentials();",
    functionStart
  );
  const retrieval = brokerSource.indexOf(
    "capture_railway_variable_map",
    closureVerification
  );
  assert.ok(functionStart >= 0);
  assert.ok(closureVerification > functionStart);
  assert.ok(retrieval > closureVerification);
  assert.equal(
    brokerSource.slice(functionStart, retrieval).includes("load_credential("),
    false
  );
});

test("authentication bundle generation is deterministic and closes local imports", async () => {
  const unresolvedRoot = await mkdtemp(
    resolve(tmpdir(), "dime-auth-candidate-")
  );
  const root = await realpath(unresolvedRoot);
  const browser = resolve(root, "reviewed-browser");
  const node = resolve(root, "reviewed-node");
  await writeFile(browser, "#!/bin/sh\nexit 0\n", { mode: 0o555 });
  await copyFile(process.execPath, node);
  await chmod(browser, 0o555);
  await chmod(node, 0o555);
  try {
    const candidates = [];
    for (const name of ["first", "second"]) {
      candidates.push(
        await buildAuthenticationClosureCandidate({
          candidateDirectory: resolve(root, `${name}.candidate`),
          descriptorPath: resolve(root, `${name}.descriptor.json`),
          browserCandidatePaths: [browser],
          browserAllowedRoots: [root],
          nodeExecutablePath: node,
          nodeAllowedRoots: [root],
        })
      );
    }
    assert.equal(
      candidates[0].deterministicBundle.sha256,
      candidates[1].deterministicBundle.sha256
    );
    assert.equal(
      candidates[0].application.candidateInventory.treeSha256,
      candidates[1].application.candidateInventory.treeSha256
    );
    assert.deepEqual(candidates[0].deterministicBundle.externalImports, [
      "playwright",
    ]);
    assert.equal(candidates[0].deterministicBundle.localModulesBundled, true);
    assert.deepEqual(candidates[0].packageTrees, [
      "playwright",
      "playwright-core",
    ]);
    assert.equal(
      candidates[0].credentialExecution,
      "BLOCKED_PENDING_INDEPENDENT_ADMIN_PROVENANCE"
    );
    const buildModuleUrl = pathToFileURL(
      resolve(process.cwd(), "scripts/build-dime-authentication-closure.mjs")
    ).href;
    const subprocessCandidate = resolve(root, "subprocess.candidate");
    const subprocessDescriptor = resolve(root, "subprocess.descriptor.json");
    const subprocessSource = [
      `import { buildAuthenticationClosureCandidate } from ${JSON.stringify(buildModuleUrl)};`,
      "await buildAuthenticationClosureCandidate({",
      `candidateDirectory: ${JSON.stringify(subprocessCandidate)},`,
      `descriptorPath: ${JSON.stringify(subprocessDescriptor)},`,
      `browserCandidatePaths: [${JSON.stringify(browser)}],`,
      `browserAllowedRoots: [${JSON.stringify(root)}],`,
      `nodeExecutablePath: ${JSON.stringify(node)},`,
      `nodeAllowedRoots: [${JSON.stringify(root)}],`,
      "});",
    ].join("\n");
    await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", subprocessSource],
      {
        cwd: process.cwd(),
        env: { NODE_ENV: "test" },
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      }
    );
    assert.equal((await lstat(subprocessCandidate)).isDirectory(), true);
    assert.equal((await lstat(subprocessDescriptor)).isFile(), true);
    assert.equal(
      (
        await lstat(
          resolve(
            subprocessCandidate,
            "node_modules/playwright-core/package.json"
          )
        )
      ).isFile(),
      true
    );
    const bundledEntrypoint = resolve(
      root,
      "first.candidate/scripts/dime-production-auth.bundle.mjs"
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [bundledEntrypoint, "closure-preflight", "--broker-active"],
        {
          cwd: resolve(root, "first.candidate"),
          env: {
            DIME_AUTH_CLOSURE_PREFLIGHT: "1",
            DIME_BUNDLED_PRODUCTION_AUTH: "1",
            PATH: "/usr/bin:/bin",
          },
        }
      ),
      error => {
        const stderr = String(
          (error as Error & { stderr?: string }).stderr ?? ""
        );
        assert.match(stderr, /Dime production auth failed/);
        assert.doesNotMatch(stderr, /Dime agent access failed/);
        assert.doesNotMatch(stderr, /Dime control-plane connection failed/);
        return true;
      }
    );
  } finally {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
  // 120s: this test copies process.execPath and runs bundle-generation
  // subprocesses whose own execFile budget is 30s — the 15s default bound
  // cannot contain the work it already declares, and under full-suite
  // parallelism it timed out while passing isolated in 2.3s (DEF-061).
}, 120_000);

test("authentication candidate can be rebuilt at the same hardened path", async () => {
  const unresolvedRoot = await mkdtemp(
    resolve(tmpdir(), "dime-auth-candidate-rebuild-")
  );
  const root = await realpath(unresolvedRoot);
  const browser = resolve(root, "reviewed-browser");
  const node = resolve(root, "reviewed-node");
  const candidateDirectory = resolve(root, "reused.candidate");
  const descriptorPath = resolve(root, "reused.descriptor.json");
  const staleTemporaryDirectory = `${candidateDirectory}.${process.pid}.tmp`;
  const stalePlaywrightDirectory = resolve(
    staleTemporaryDirectory,
    "node_modules/playwright"
  );
  await writeFile(browser, "#!/bin/sh\nexit 0\n", { mode: 0o555 });
  await copyFile(process.execPath, node);
  await chmod(browser, 0o555);
  await chmod(node, 0o555);
  await mkdir(stalePlaywrightDirectory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(stalePlaywrightDirectory, "stale"), "stale\n", {
    mode: 0o400,
  });
  await chmod(stalePlaywrightDirectory, 0o500);
  await chmod(resolve(staleTemporaryDirectory, "node_modules"), 0o500);
  await chmod(staleTemporaryDirectory, 0o700);
  await writeFile(`${descriptorPath}.${process.pid}.tmp`, "stale\n", {
    mode: 0o400,
  });
  try {
    const first = await buildAuthenticationClosureCandidate({
      candidateDirectory,
      descriptorPath,
      browserCandidatePaths: [browser],
      browserAllowedRoots: [root],
      nodeExecutablePath: node,
      nodeAllowedRoots: [root],
    });
    const second = await buildAuthenticationClosureCandidate({
      candidateDirectory,
      descriptorPath,
      browserCandidatePaths: [browser],
      browserAllowedRoots: [root],
      nodeExecutablePath: node,
      nodeAllowedRoots: [root],
    });
    assert.equal(
      second.deterministicBundle.sha256,
      first.deterministicBundle.sha256
    );
    assert.equal(
      second.application.candidateInventory.treeSha256,
      first.application.candidateInventory.treeSha256
    );
    assert.equal((await lstat(candidateDirectory)).isDirectory(), true);
    assert.equal((await lstat(descriptorPath)).mode & 0o777, 0o400);
    assert.equal(
      await lstat(`${candidateDirectory}.${process.pid}.tmp`).catch(() => null),
      null
    );
    assert.equal(
      await lstat(`${descriptorPath}.${process.pid}.tmp`).catch(() => null),
      null
    );
  } finally {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000); // same heavy profile as the closure test above (DEF-061)
