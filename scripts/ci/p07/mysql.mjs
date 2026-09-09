#!/usr/bin/env node
/**
 * p07/mysql.mjs — verifier-owned MySQL service lifecycle (DEF-034 closure).
 *
 * Faithful reproduction of ci.yml#db-tests' service container:
 *
 *   image:   mysql:8            (tag from the contract; resolved to an
 *                                immutable digest at execution and BOUND in
 *                                evidence — the tag alone is never trusted)
 *   env:     MYSQL_ALLOW_EMPTY_PASSWORD=1, MYSQL_DATABASE=dime_test
 *   ports:   3306:3306          (contract-hardcoded in DATABASE_URL; bound
 *                                to 127.0.0.1 locally — strictly narrower
 *                                than CI's runner-local mapping)
 *   health:  mysqladmin ping -h 127.0.0.1 --silent
 *            interval 5s / timeout 5s / retries 20   (contract options)
 *
 * Ownership law: the container carries a unique verifier name and a label;
 * only that exact container id is ever stopped/removed; port 3306 occupied
 * by ANYTHING else refuses with INFRA — a developer MySQL is never touched,
 * reused, or killed. No pruning, ever.
 */
import { execFileSync } from "node:child_process";
import net from "node:net";

const CONTRACT_SERVICE = {
  image_tag: "mysql:8",
  env: { MYSQL_ALLOW_EMPTY_PASSWORD: "1", MYSQL_DATABASE: "dime_test" },
  port: 3306,
  health_cmd: ["mysqladmin", "ping", "-h", "127.0.0.1", "--silent"],
  health_interval_ms: 5_000,
  health_retries: 20,
};

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: options.timeout_ms ?? 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function daemonInfo() {
  try {
    const raw = docker(["info", "--format", "{{json .}}"]);
    const info = JSON.parse(raw);
    return {
      reachable: true,
      server_version: info.ServerVersion,
      operating_system: info.OperatingSystem,
      architecture: info.Architecture,
      containers: info.Containers,
      images: info.Images,
    };
  } catch (error) {
    return { reachable: false, error: String(error.message).slice(0, 200) };
  }
}

export function portFree(port) {
  return new Promise(resolve => {
    const sock = net.connect({ host: "127.0.0.1", port, timeout: 1_500 });
    sock.on("connect", () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("error", () => resolve(true));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(true);
    });
  });
}

/** Pre-existing docker inventory — proves P07 mutates nothing unrelated. */
export function inventory() {
  return {
    containers: docker([
      "ps",
      "-a",
      "--format",
      "{{.ID}} {{.Names}} {{.Image}}",
    ])
      .split("\n")
      .filter(Boolean),
    images: docker(["images", "--format", "{{.ID}} {{.Repository}}:{{.Tag}}"])
      .split("\n")
      .filter(Boolean),
    volumes: docker(["volume", "ls", "--format", "{{.Name}}"])
      .split("\n")
      .filter(Boolean),
  };
}

/** Resolve mysql:8 to an immutable digest (pulls if absent). */
export function resolveImage() {
  docker(["pull", CONTRACT_SERVICE.image_tag], { timeout_ms: 600_000 });
  const inspect = JSON.parse(
    docker(["image", "inspect", CONTRACT_SERVICE.image_tag])
  )[0];
  const digest = (inspect.RepoDigests ?? [])[0] ?? null;
  if (!digest) throw new Error("MYSQL_DIGEST_UNRESOLVED");
  return {
    tag: CONTRACT_SERVICE.image_tag,
    digest,
    image_id: inspect.Id,
    architecture: inspect.Architecture,
    os: inspect.Os,
    created: inspect.Created,
  };
}

/**
 * Start the owned service container. Returns a handle with guaranteed-
 * cleanup destroy(). Throws {code} on every refusal path — the caller maps
 * these to INFRA_FAIL/BLOCKED, never to a test verdict.
 */
export async function startOwnedMysql(runMarker) {
  const info = daemonInfo();
  if (!info.reachable) {
    const err = new Error("DOCKER_DAEMON_UNREACHABLE");
    err.code = "RUNTIME_UNAVAILABLE";
    throw err;
  }
  if (!(await portFree(CONTRACT_SERVICE.port))) {
    const err = new Error(
      `PORT_${CONTRACT_SERVICE.port}_OCCUPIED: refusing — a developer database is never substituted`
    );
    err.code = "PORT_OCCUPIED";
    throw err;
  }
  const image = resolveImage();
  const name = `cv-mysql-${runMarker}`;
  const existing = docker(["ps", "-aq", "--filter", `name=^${name}$`]);
  if (existing) {
    const err = new Error(`CONTAINER_NAME_COLLISION: ${name}`);
    err.code = "NAME_COLLISION";
    throw err;
  }
  const id = docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `ci-verify-owner=${runMarker}`,
    "-e",
    `MYSQL_ALLOW_EMPTY_PASSWORD=${CONTRACT_SERVICE.env.MYSQL_ALLOW_EMPTY_PASSWORD}`,
    "-e",
    `MYSQL_DATABASE=${CONTRACT_SERVICE.env.MYSQL_DATABASE}`,
    "-p",
    `127.0.0.1:${CONTRACT_SERVICE.port}:3306`,
    // digest-pinned reference: the tag is advisory, the digest is binding
    image.digest,
  ]);

  const destroy = () => {
    try {
      const owner = docker([
        "inspect",
        "--format",
        '{{ index .Config.Labels "ci-verify-owner" }}',
        id,
      ]);
      if (owner !== runMarker) {
        throw new Error(`OWNERSHIP_MISMATCH: refusing to remove ${id}`);
      }
      // -v removes the container's OWN anonymous volumes (mysql:8 declares
      // /var/lib/mysql as a VOLUME, so `docker rm -f` alone strands one per
      // run). Scoped to this container id only — named/developer volumes are
      // never touched, and nothing is ever pruned.
      docker(["rm", "-fv", id]);
      return { removed: id };
    } catch (error) {
      if (/No such (object|container)/i.test(String(error.message ?? error))) {
        return { removed: null, note: "already gone" };
      }
      throw error;
    }
  };

  // Readiness: the contract's own health command, its interval and retries.
  const started = Date.now();
  let ready = false;
  let lastError = null;
  for (
    let attempt = 1;
    attempt <= CONTRACT_SERVICE.health_retries;
    attempt += 1
  ) {
    try {
      docker(["exec", id, ...CONTRACT_SERVICE.health_cmd], {
        timeout_ms: CONTRACT_SERVICE.health_interval_ms,
      });
      ready = true;
      break;
    } catch (error) {
      lastError = String(error.message).slice(0, 120);
      await new Promise(r =>
        setTimeout(r, CONTRACT_SERVICE.health_interval_ms)
      );
    }
  }
  if (!ready) {
    destroy();
    const err = new Error(
      `MYSQL_READINESS_TIMEOUT after ${CONTRACT_SERVICE.health_retries} retries: ${lastError}`
    );
    err.code = "READINESS_TIMEOUT";
    throw err;
  }
  const serverVersion = docker([
    "exec",
    id,
    "mysql",
    "--user=root",
    "--silent",
    "--skip-column-names",
    "-e",
    "SELECT VERSION()",
  ]);
  return {
    container_id: id,
    name,
    image,
    server_version: serverVersion,
    ready_after_ms: Date.now() - started,
    database_url: `mysql://root@127.0.0.1:${CONTRACT_SERVICE.port}/${CONTRACT_SERVICE.env.MYSQL_DATABASE}`,
    contract: CONTRACT_SERVICE,
    destroy,
  };
}
