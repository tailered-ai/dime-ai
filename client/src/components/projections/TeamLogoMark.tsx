import type { ProjectionTeam } from "./types";
import { CountryFlag } from "./CountryFlag";

/**
 * Official MLB SVGs use tightly cropped, non-square viewBoxes. Preserve those
 * real ratios so every mark fills the same-height optical lane without the
 * empty letterboxing created by a square <img>. The fallback keeps a square
 * ratio for non-MLB assets whose intrinsic dimensions are not known here.
 */
const MLB_LOGO_DIMENSIONS: Readonly<Record<string, readonly [number, number]>> =
  {
    LAA: [112, 150],
    ARI: [190, 150],
    BAL: [159, 150],
    BOS: [108, 150],
    CHC: [150, 150],
    CIN: [213, 150],
    CLE: [98, 150],
    COL: [139, 150],
    DET: [103, 150],
    HOU: [150, 150],
    KC: [160, 150],
    LAD: [115, 150],
    WSH: [150, 150],
    NYM: [119, 150],
    ATH: [181, 150],
    PIT: [107, 150],
    SD: [120, 150],
    SEA: [94, 150],
    SF: [108, 150],
    STL: [120, 150],
    TB: [170, 150],
    TEX: [132, 150],
    TOR: [174, 150],
    MIN: [153, 150],
    PHI: [117, 150],
    ATL: [160, 150],
    CWS: [107, 150],
    MIA: [159, 150],
    NYY: [144, 150],
    MIL: [137, 150],
  };

/** Marks whose darkest artwork disappears into the grey System and black Dark
 * surfaces. The white alpha outline is deliberately opt-in; bright/colorful
 * logos keep their original artwork untouched. */
const DARK_SURFACE_OUTLINE_TEAMS = new Set([
  "ATH",
  "COL",
  "DET",
  "KC",
  "LAD",
  "MIN",
  "NYY",
  "SD",
  "TB",
  "WSH",
]);

/**
 * TeamLogoMark — renders the ORIGINAL transparent logo asset directly, with no
 * interface-generated circle, frame, mask, or background (Law v3 §logos).
 * Every mark gets the same visible height while its real, tightly cropped SVG
 * ratio owns the width, eliminating square-frame whitespace without distortion.
 * Countries render a bare flag emoji (no frame) instead of a logo. When no team
 * logo asset exists, falls back to a monogram disc using the team's own color
 * (the Three-Color Law's team-logo exception), which is the ONLY place a
 * non-palette color renders. Explicit dimensions prevent layout shift
 * (no next/image in this Vite app).
 */
export function TeamLogoMark({ team }: { team: ProjectionTeam }) {
  if (team.kind === "country" && team.flag) {
    return <CountryFlag flag={team.flag} countryName={team.name} />;
  }
  if (team.logo) {
    const isHelmet = team.logo.startsWith("/brand/ncaaf-helmets/sept5-");
    const [width, height] = isHelmet
      ? [512, 384]
      : (MLB_LOGO_DIMENSIONS[team.abbr] ?? [150, 150]);
    const needsDarkOutline =
      !isHelmet && DARK_SURFACE_OUTLINE_TEAMS.has(team.abbr);
    return (
      <span
        className={`team-logo-box${isHelmet ? " team-logo-box--helmet" : ""}${needsDarkOutline ? " team-logo-box--dark-outline" : ""}`}
      >
        <img
          className="team-logo"
          src={team.logo}
          alt=""
          width={width}
          height={height}
          loading="lazy"
          decoding="async"
        />
      </span>
    );
  }
  return (
    <span className="team-logo-box team-logo-box--mono" aria-hidden="true">
      <span
        className="team-logo team-logo--mono"
        style={{ background: team.color || "#333" }}
      >
        {team.abbr.slice(0, 2)}
      </span>
    </span>
  );
}
