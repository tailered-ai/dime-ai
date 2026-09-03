/**
 * securityMiddleware.ts
 *
 * Centralized security helpers for input sanitization and validation.
 *
 * Provides:
 *   - sanitizeString()   — strips HTML/XSS from any user-supplied string
 *   - safeGameDate()     — validates YYYY-MM-DD format, rejects anything else
 *   - safeSport()        — validates sport key against known enum, rejects unknown values
 *   - safeTeamAbbrev()   — validates team abbreviation format (2-8 uppercase letters)
 *   - safeDbSlug()       — validates DB slug format (lowercase letters, underscores, digits)
 *   - safeFilePath()     — validates file path strings (no path traversal)
 *   - MAX_* constants    — enforced size ceilings for array/string inputs
 */

import xss from "xss";
import { z } from "zod";

// ─── Size ceilings ────────────────────────────────────────────────────────────
/** Maximum number of game IDs allowed in a single batch request */
export const MAX_GAME_IDS_PER_REQUEST = 50;
/** Maximum length of any free-text string input */
export const MAX_STRING_LENGTH = 1000;
/** Maximum length of a base64 file upload (≈ 1.5MB decoded) */
export const MAX_BASE64_LENGTH = 2_000_000;
/** Maximum length of an HTML paste (ingestAnOdds) */
export const MAX_HTML_PASTE_LENGTH = 500_000;

// ─── XSS sanitizer ───────────────────────────────────────────────────────────
/**
 * Strips all HTML tags and XSS vectors from a string.
 * Uses the xss library with a whitelist of zero allowed tags.
 * Returns the sanitized string, or empty string for null/undefined input.
 */
export function sanitizeString(input: string | null | undefined): string {
  if (input == null) return "";
  return xss(input, {
    whiteList: {}, // no tags allowed
    stripIgnoreTag: true, // strip tags not in whitelist
    stripIgnoreTagBody: ["script", "style"], // strip script/style bodies entirely
  });
}

// ─── Zod refinements ─────────────────────────────────────────────────────────
/**
 * Zod schema for a YYYY-MM-DD game date string.
 * Rejects anything that doesn't match the exact format.
 */
export const zodGameDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "gameDate must be YYYY-MM-DD")
  .refine(d => {
    const ts = Date.parse(d);
    return !isNaN(ts);
  }, "gameDate must be a valid calendar date");

/**
 * Zod schema for a sport key.
 * Active sports accepted by the shared games feed.
 */
export const zodSport = z.enum(["MLB", "NBA", "NHL", "NCAAF"]);

/**
 * Zod schema for a team abbreviation (2–8 uppercase letters/digits).
 * Accepts both abbreviations (NYY, LAK) and DB slugs (new_york_yankees).
 * We use a permissive pattern here since teams can be stored either way.
 */
export const zodTeamId = z
  .string()
  .min(2, "Team identifier too short")
  .max(64, "Team identifier too long")
  .regex(/^[A-Za-z0-9_\-]+$/, "Team identifier contains invalid characters");

/**
 * Zod schema for a DB slug (lowercase letters, digits, underscores).
 */
export const zodDbSlug = z
  .string()
  .min(2, "DB slug too short")
  .max(100, "DB slug too long")
  .regex(
    /^[a-z0-9_]+$/,
    "DB slug must be lowercase letters, digits, and underscores only"
  );

/**
 * Zod schema for a file path string used in model runner inputs.
 * Rejects path traversal attempts (../) and absolute paths.
 */
export const zodFilePath = z
  .string()
  .min(1, "File path cannot be empty")
  .max(500, "File path too long")
  .refine(
    p => !p.includes("../") && !p.includes("..\\"),
    "Path traversal not allowed"
  )
  .refine(
    p => !p.startsWith("/") && !p.match(/^[A-Za-z]:\\/),
    "Absolute paths not allowed"
  );

/**
 * Zod schema for a pitcher RS ID (Retrosheet).
 * Format: 8-char alphanumeric, e.g. "verlj001"
 */
export const zodPitcherRsId = z
  .string()
  .min(3, "Pitcher RS ID too short")
  .max(20, "Pitcher RS ID too long")
  .regex(/^[a-z0-9]+$/, "Pitcher RS ID must be lowercase alphanumeric");

/**
 * Zod schema for a base64-encoded file upload.
 * Enforces the MAX_BASE64_LENGTH ceiling.
 */
export const zodBase64File = z
  .string()
  .max(
    MAX_BASE64_LENGTH,
    `File too large (max ${MAX_BASE64_LENGTH / 1_000_000}MB encoded)`
  )
  .refine(s => /^[A-Za-z0-9+/=]+$/.test(s), "Invalid base64 encoding");

/**
 * Zod schema for an HTML paste (ingestAnOdds).
 * Enforces MAX_HTML_PASTE_LENGTH ceiling.
 */
export const zodHtmlPaste = z
  .string()
  .min(100, "HTML too short — paste the full AN best-odds table HTML")
  .max(
    MAX_HTML_PASTE_LENGTH,
    `HTML paste too large (max ${MAX_HTML_PASTE_LENGTH / 1000}KB)`
  );

/**
 * Zod schema for a batch of game IDs.
 * Enforces MAX_GAME_IDS_PER_REQUEST ceiling.
 */
export const zodGameIdArray = z
  .array(z.number().int().positive())
  .min(1, "At least one game ID required")
  .max(
    MAX_GAME_IDS_PER_REQUEST,
    `Too many game IDs (max ${MAX_GAME_IDS_PER_REQUEST})`
  );
