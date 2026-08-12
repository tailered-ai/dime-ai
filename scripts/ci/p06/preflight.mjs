#!/usr/bin/env node
/**
 * p06/preflight.mjs — host-environment preflight (DEF-049 anchor).
 *
 * DEF-049: eight orphaned `while :; do :; done` busy-loops from a dead
 * session held load at 36-58 on 8 cores for almost three days and made
 * every wall-clock-sensitive gate lie. They were found by hand. This module
 * is the codified detector: interpreter processes that have reparented to
 * PID 1, are saturating a core, and have been running long enough to not be
 * a transient spike are exactly that failure class — and a campaign started
 * on such a host produces flake, not verdicts.
 *
 * Refusal here is an INFRA condition (exit-10 class), never a candidate
 * verdict — the boundary law as everywhere else in this program.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";

/** Interpreters a synthetic load generator plausibly runs under. */
const GENERATOR_COMMS = /(^|\/)(sh|bash|zsh|dash|node|python[\d.]*|perl)$/;

/** Parse `ps -Axo pid=,ppid=,pcpu=,etime=,comm=` output. Pure — testable. */
export function parseOrphanLoad(psText, options = {}) {
  const cpuThreshold = options.cpuThreshold ?? 80;
  const minEtimeMinutes = options.minEtimeMinutes ?? 5;
  const orphans = [];
  for (const line of psText.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, pid, ppid, pcpu, etime, comm] = m;
    if (Number(ppid) !== 1) continue;
    if (Number(pcpu) < cpuThreshold) continue;
    if (etimeToMinutes(etime) < minEtimeMinutes) continue;
    if (!GENERATOR_COMMS.test(comm.trim())) continue;
    orphans.push({
      pid: Number(pid),
      pcpu: Number(pcpu),
      etime,
      comm: comm.trim(),
    });
  }
  return orphans;
}

/** `[[dd-]hh:]mm:ss` → minutes. */
export function etimeToMinutes(etime) {
  const dayed = etime.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
  if (dayed) {
    return Number(dayed[1]) * 1440 + Number(dayed[2]) * 60 + Number(dayed[3]);
  }
  const parts = etime.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 60 + parts[1];
  if (parts.length === 2) return parts[0];
  return 0;
}

/**
 * Measure the host. `refuse` is true only on detected orphan generators —
 * plain high load is RECORDED (other legitimate sessions may be working)
 * but does not block; the DEF-062 worker profile absorbs it.
 */
export function hostLoadPreflight() {
  const psText = execFileSync("ps", ["-Axo", "pid=,ppid=,pcpu=,etime=,comm="], {
    encoding: "utf8",
    timeout: 15_000,
  });
  const orphans = parseOrphanLoad(psText);
  const [load1, load5, load15] = os.loadavg();
  return {
    measured_at: new Date().toISOString(),
    loadavg: { "1m": load1, "5m": load5, "15m": load15 },
    cores: os.cpus().length,
    orphans,
    refuse: orphans.length > 0,
  };
}
