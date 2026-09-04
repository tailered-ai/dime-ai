/**
 * shared/teamColors.ts
 * Client-side team color registry — eliminates trpc.teamColors.getForGame round-trips.
 * Maps dbSlug → { primaryColor, secondaryColor, tertiaryColor, abbrev }
 *
 * Data sourced from DB (nhlTeams, nbaTeams, mlbTeams tables) and MLB shared registry.
 * Zero network requests needed — all lookups are O(1) Map operations.
 */

export interface TeamColorEntry {
  primaryColor: string | null;
  secondaryColor: string | null;
  tertiaryColor: string | null;
  abbrev?: string;
}

// ── NHL ──────────────────────────────────────────────────────────────────────
const NHL_COLORS: Record<string, TeamColorEntry> = {
  buffalo_sabres: {
    primaryColor: "#003087",
    secondaryColor: "#FFB81C",
    tertiaryColor: "#FFFFFF",
    abbrev: "BUF",
  },
  tampa_bay_lightning: {
    primaryColor: "#002868",
    secondaryColor: "#FFFFFF",
    tertiaryColor: "#000000",
    abbrev: "TBL",
  },
  montreal_canadiens: {
    primaryColor: "#AF1E2D",
    secondaryColor: "#001E62",
    tertiaryColor: "#FFFFFF",
    abbrev: "MTL",
  },
  detroit_red_wings: {
    primaryColor: "#CE1126",
    secondaryColor: "#FFFFFF",
    tertiaryColor: "#000000",
    abbrev: "DET",
  },
  boston_bruins: {
    primaryColor: "#FFB81C",
    secondaryColor: "#000000",
    tertiaryColor: "#FFFFFF",
    abbrev: "BOS",
  },
  ottawa_senators: {
    primaryColor: "#C52032",
    secondaryColor: "#000000",
    tertiaryColor: "#C2912C",
    abbrev: "OTT",
  },
  florida_panthers: {
    primaryColor: "#C8102E",
    secondaryColor: "#041E42",
    tertiaryColor: "#B9975B",
    abbrev: "FLA",
  },
  toronto_maple_leafs: {
    primaryColor: "#00205B",
    secondaryColor: "#FFFFFF",
    tertiaryColor: "#A2AAAD",
    abbrev: "TOR",
  },
  carolina_hurricanes: {
    primaryColor: "#CC0000",
    secondaryColor: "#000000",
    tertiaryColor: "#A2AAAD",
    abbrev: "CAR",
  },
  pittsburgh_penguins: {
    primaryColor: "#FCB514",
    secondaryColor: "#000000",
    tertiaryColor: "#FFFFFF",
    abbrev: "PIT",
  },
  new_york_islanders: {
    primaryColor: "#003087",
    secondaryColor: "#F47D30",
    tertiaryColor: "#FFFFFF",
    abbrev: "NYI",
  },
  columbus_blue_jackets: {
    primaryColor: "#002654",
    secondaryColor: "#CE1126",
    tertiaryColor: "#A2AAAD",
    abbrev: "CBJ",
  },
  philadelphia_flyers: {
    primaryColor: "#F74902",
    secondaryColor: "#000000",
    tertiaryColor: "#FFFFFF",
    abbrev: "PHI",
  },
  washington_capitals: {
    primaryColor: "#041E42",
    secondaryColor: "#C8102E",
    tertiaryColor: "#FFFFFF",
    abbrev: "WSH",
  },
  new_jersey_devils: {
    primaryColor: "#CE1126",
    secondaryColor: "#000000",
    tertiaryColor: "#FFFFFF",
    abbrev: "NJD",
  },
  new_york_rangers: {
    primaryColor: "#0038A8",
    secondaryColor: "#CE1126",
    tertiaryColor: "#FFFFFF",
    abbrev: "NYR",
  },
  colorado_avalanche: {
    primaryColor: "#6F263D",
    secondaryColor: "#236192",
    tertiaryColor: "#A2AAAD",
    abbrev: "COL",
  },
  dallas_stars: {
    primaryColor: "#006847",
    secondaryColor: "#000000",
    tertiaryColor: "#8F8F8C",
    abbrev: "DAL",
  },
  minnesota_wild: {
    primaryColor: "#154734",
    secondaryColor: "#A6192E",
    tertiaryColor: "#EAAA00",
    abbrev: "MIN",
  },
  utah_mammoth: {
    primaryColor: "#0B162A",
    secondaryColor: "#6F263D",
    tertiaryColor: "#A2AAAD",
    abbrev: "UTA",
  },
  nashville_predators: {
    primaryColor: "#FFB81C",
    secondaryColor: "#041E42",
    tertiaryColor: "#FFFFFF",
    abbrev: "NSH",
  },
  winnipeg_jets: {
    primaryColor: "#041E42",
    secondaryColor: "#004C97",
    tertiaryColor: "#A2AAAD",
    abbrev: "WPG",
  },
  st_louis_blues: {
    primaryColor: "#002F87",
    secondaryColor: "#FFB81C",
    tertiaryColor: "#FFFFFF",
    abbrev: "STL",
  },
  chicago_blackhawks: {
    primaryColor: "#CF0A2C",
    secondaryColor: "#000000",
    tertiaryColor: "#FF671B",
    abbrev: "CHI",
  },
  anaheim_ducks: {
    primaryColor: "#FC4C02",
    secondaryColor: "#000000",
    tertiaryColor: "#B9975B",
    abbrev: "ANA",
  },
  edmonton_oilers: {
    primaryColor: "#041E42",
    secondaryColor: "#FF4C00",
    tertiaryColor: "#A2AAAD",
    abbrev: "EDM",
  },
  vegas_golden_knights: {
    primaryColor: "#B4975A",
    secondaryColor: "#333F42",
    tertiaryColor: "#C8102E",
    abbrev: "VGK",
  },
  seattle_kraken: {
    primaryColor: "#001628",
    secondaryColor: "#99D9D9",
    tertiaryColor: "#E9072B",
    abbrev: "SEA",
  },
  los_angeles_kings: {
    primaryColor: "#111111",
    secondaryColor: "#A2AAAD",
    tertiaryColor: "#FFFFFF",
    abbrev: "LAK",
  },
  san_jose_sharks: {
    primaryColor: "#006D75",
    secondaryColor: "#000000",
    tertiaryColor: "#E57200",
    abbrev: "SJS",
  },
  calgary_flames: {
    primaryColor: "#C8102E",
    secondaryColor: "#F1BE48",
    tertiaryColor: "#FFFFFF",
    abbrev: "CGY",
  },
  vancouver_canucks: {
    primaryColor: "#00205B",
    secondaryColor: "#00843D",
    tertiaryColor: "#FFFFFF",
    abbrev: "VAN",
  },
};

// ── NBA ──────────────────────────────────────────────────────────────────────
const NBA_COLORS: Record<string, TeamColorEntry> = {
  boston_celtics: {
    primaryColor: "#007A33",
    secondaryColor: "#BA9653",
    tertiaryColor: "#FFFFFF",
  },
  brooklyn_nets: {
    primaryColor: "#000000",
    secondaryColor: "#FFFFFF",
    tertiaryColor: "#A1A1A4",
  },
  new_york_knicks: {
    primaryColor: "#006BB6",
    secondaryColor: "#F58426",
    tertiaryColor: "#BEC0C2",
  },
  philadelphia_76ers: {
    primaryColor: "#006BB6",
    secondaryColor: "#ED174C",
    tertiaryColor: "#002B5C",
  },
  toronto_raptors: {
    primaryColor: "#CE1141",
    secondaryColor: "#000000",
    tertiaryColor: "#A1A1A4",
  },
  chicago_bulls: {
    primaryColor: "#CE1141",
    secondaryColor: "#000000",
    tertiaryColor: "#C4CED4",
  },
  cleveland_cavaliers: {
    primaryColor: "#6F263D",
    secondaryColor: "#FFB81C",
    tertiaryColor: "#041E42",
  },
  detroit_pistons: {
    primaryColor: "#C8102E",
    secondaryColor: "#1D42BA",
    tertiaryColor: "#BEC0C2",
  },
  indiana_pacers: {
    primaryColor: "#002D62",
    secondaryColor: "#FDBB30",
    tertiaryColor: "#BEC0C2",
  },
  milwaukee_bucks: {
    primaryColor: "#00471B",
    secondaryColor: "#EEE1C6",
    tertiaryColor: "#0077C0",
  },
  atlanta_hawks: {
    primaryColor: "#E03A3E",
    secondaryColor: "#C1D32F",
    tertiaryColor: "#26282A",
  },
  charlotte_hornets: {
    primaryColor: "#1D1160",
    secondaryColor: "#00788C",
    tertiaryColor: "#A1A1A4",
  },
  miami_heat: {
    primaryColor: "#98002E",
    secondaryColor: "#F9A01B",
    tertiaryColor: "#000000",
  },
  orlando_magic: {
    primaryColor: "#0077C0",
    secondaryColor: "#C4CED4",
    tertiaryColor: "#000000",
  },
  washington_wizards: {
    primaryColor: "#002B5C",
    secondaryColor: "#E31837",
    tertiaryColor: "#C4CED4",
  },
  denver_nuggets: {
    primaryColor: "#0E2240",
    secondaryColor: "#FEC524",
    tertiaryColor: "#8B2131",
  },
  minnesota_timberwolves: {
    primaryColor: "#0C2340",
    secondaryColor: "#236192",
    tertiaryColor: "#9EA2A2",
  },
  oklahoma_city_thunder: {
    primaryColor: "#007AC1",
    secondaryColor: "#EF3B24",
    tertiaryColor: "#FDBB30",
  },
  portland_trail_blazers: {
    primaryColor: "#E03A3E",
    secondaryColor: "#000000",
    tertiaryColor: "#B0B7BC",
  },
  utah_jazz: {
    primaryColor: "#002B5C",
    secondaryColor: "#F9A01B",
    tertiaryColor: "#00471B",
  },
  golden_state_warriors: {
    primaryColor: "#1D428A",
    secondaryColor: "#FFC72C",
    tertiaryColor: "#26282A",
  },
  los_angeles_clippers: {
    primaryColor: "#C8102E",
    secondaryColor: "#1D428A",
    tertiaryColor: "#BEC0C2",
  },
  los_angeles_lakers: {
    primaryColor: "#552583",
    secondaryColor: "#FDB927",
    tertiaryColor: "#000000",
  },
  phoenix_suns: {
    primaryColor: "#1D1160",
    secondaryColor: "#E56020",
    tertiaryColor: "#63727A",
  },
  sacramento_kings: {
    primaryColor: "#5A2D81",
    secondaryColor: "#63727A",
    tertiaryColor: "#000000",
  },
  dallas_mavericks: {
    primaryColor: "#00538C",
    secondaryColor: "#002B5E",
    tertiaryColor: "#B8C4CA",
  },
  houston_rockets: {
    primaryColor: "#CE1141",
    secondaryColor: "#000000",
    tertiaryColor: "#C4CED4",
  },
  memphis_grizzlies: {
    primaryColor: "#5D76A9",
    secondaryColor: "#12173F",
    tertiaryColor: "#F5B112",
  },
  new_orleans_pelicans: {
    primaryColor: "#0C2340",
    secondaryColor: "#C8102E",
    tertiaryColor: "#85714D",
  },
  san_antonio_spurs: {
    primaryColor: "#C4CED4",
    secondaryColor: "#000000",
    tertiaryColor: "#FFFFFF",
  },
};

// ── MLB (from shared/mlbTeams.ts registry — primaryColor + secondaryColor already present) ──
// Inline here to avoid a circular import; kept in sync with mlbTeams.ts
const MLB_COLORS: Record<string, TeamColorEntry> = {
  arizona_diamondbacks: {
    primaryColor: "#A71930",
    secondaryColor: "#E3D4AD",
    tertiaryColor: "#000000",
  },
  atlanta_braves: {
    primaryColor: "#CE1141",
    secondaryColor: "#13274F",
    tertiaryColor: "#FFFFFF",
  },
  baltimore_orioles: {
    primaryColor: "#DF4601",
    secondaryColor: "#000000",
    tertiaryColor: "#FFFFFF",
  },
  boston_red_sox: {
    primaryColor: "#BD3039",
    secondaryColor: "#0C2340",
    tertiaryColor: "#FFFFFF",
  },
  chicago_cubs: {
    primaryColor: "#0E3386",
    secondaryColor: "#CC3433",
    tertiaryColor: "#FFFFFF",
  },
  chicago_white_sox: {
    primaryColor: "#27251F",
    secondaryColor: "#C4CED4",
    tertiaryColor: "#FFFFFF",
  },
  cincinnati_reds: {
    primaryColor: "#C6011F",
    secondaryColor: "#000000",
    tertiaryColor: "#FFFFFF",
  },
  cleveland_guardians: {
    primaryColor: "#00385D",
    secondaryColor: "#E31937",
    tertiaryColor: "#FFFFFF",
  },
  colorado_rockies: {
    primaryColor: "#33006F",
    secondaryColor: "#C4CED4",
    tertiaryColor: "#000000",
  },
  detroit_tigers: {
    primaryColor: "#0C2340",
    secondaryColor: "#FA4616",
    tertiaryColor: "#FFFFFF",
  },
  houston_astros: {
    primaryColor: "#002D62",
    secondaryColor: "#EB6E1F",
    tertiaryColor: "#FFFFFF",
  },
  kansas_city_royals: {
    primaryColor: "#004687",
    secondaryColor: "#C09A5B",
    tertiaryColor: "#FFFFFF",
  },
  los_angeles_angels: {
    primaryColor: "#BA0021",
    secondaryColor: "#003263",
    tertiaryColor: "#FFFFFF",
  },
  los_angeles_dodgers: {
    primaryColor: "#005A9C",
    secondaryColor: "#EF3E42",
    tertiaryColor: "#FFFFFF",
  },
  miami_marlins: {
    primaryColor: "#00A3E0",
    secondaryColor: "#EF3340",
    tertiaryColor: "#000000",
  },
  milwaukee_brewers: {
    primaryColor: "#FFC52F",
    secondaryColor: "#12284B",
    tertiaryColor: "#FFFFFF",
  },
  minnesota_twins: {
    primaryColor: "#002B5C",
    secondaryColor: "#D31145",
    tertiaryColor: "#FFFFFF",
  },
  new_york_mets: {
    primaryColor: "#002D72",
    secondaryColor: "#FF5910",
    tertiaryColor: "#FFFFFF",
  },
  new_york_yankees: {
    primaryColor: "#003087",
    secondaryColor: "#C4CED4",
    tertiaryColor: "#FFFFFF",
  },
  oakland_athletics: {
    primaryColor: "#003831",
    secondaryColor: "#EFB21E",
    tertiaryColor: "#FFFFFF",
  },
  philadelphia_phillies: {
    primaryColor: "#E81828",
    secondaryColor: "#002D72",
    tertiaryColor: "#FFFFFF",
  },
  pittsburgh_pirates: {
    primaryColor: "#27251F",
    secondaryColor: "#FDB827",
    tertiaryColor: "#FFFFFF",
  },
  san_diego_padres: {
    primaryColor: "#2F241D",
    secondaryColor: "#FFC425",
    tertiaryColor: "#FFFFFF",
  },
  san_francisco_giants: {
    primaryColor: "#FD5A1E",
    secondaryColor: "#27251F",
    tertiaryColor: "#FFFFFF",
  },
  seattle_mariners: {
    primaryColor: "#0C2C56",
    secondaryColor: "#005C5C",
    tertiaryColor: "#C4CED4",
  },
  st_louis_cardinals: {
    primaryColor: "#C41E3A",
    secondaryColor: "#0C2340",
    tertiaryColor: "#FFFFFF",
  },
  tampa_bay_rays: {
    primaryColor: "#092C5C",
    secondaryColor: "#8FBCE6",
    tertiaryColor: "#F5D130",
  },
  texas_rangers: {
    primaryColor: "#003278",
    secondaryColor: "#C0111F",
    tertiaryColor: "#FFFFFF",
  },
  toronto_blue_jays: {
    primaryColor: "#134A8E",
    secondaryColor: "#1D2D5C",
    tertiaryColor: "#E8291C",
  },
  washington_nationals: {
    primaryColor: "#AB0003",
    secondaryColor: "#14225A",
    tertiaryColor: "#FFFFFF",
  },
  // Athletics (relocated)
  athletics: {
    primaryColor: "#003831",
    secondaryColor: "#EFB21E",
    tertiaryColor: "#FFFFFF",
  },
};

// ── MLB short-slug aliases (vsinSlug / dbSlug format, e.g. "mets", "dodgers") ──
// These are the values stored in game.awayTeam / game.homeTeam in the DB
const MLB_SHORT_SLUG_ALIASES: Record<string, TeamColorEntry> = {
  diamondbacks: MLB_COLORS.arizona_diamondbacks,
  braves: MLB_COLORS.atlanta_braves,
  orioles: MLB_COLORS.baltimore_orioles,
  "red-sox": MLB_COLORS.boston_red_sox,
  red_sox: MLB_COLORS.boston_red_sox,
  redsox: MLB_COLORS.boston_red_sox,
  cubs: MLB_COLORS.chicago_cubs,
  "white-sox": MLB_COLORS.chicago_white_sox,
  white_sox: MLB_COLORS.chicago_white_sox,
  whitesox: MLB_COLORS.chicago_white_sox,
  reds: MLB_COLORS.cincinnati_reds,
  guardians: MLB_COLORS.cleveland_guardians,
  rockies: MLB_COLORS.colorado_rockies,
  tigers: MLB_COLORS.detroit_tigers,
  astros: MLB_COLORS.houston_astros,
  royals: MLB_COLORS.kansas_city_royals,
  angels: MLB_COLORS.los_angeles_angels,
  dodgers: MLB_COLORS.los_angeles_dodgers,
  marlins: MLB_COLORS.miami_marlins,
  brewers: MLB_COLORS.milwaukee_brewers,
  twins: MLB_COLORS.minnesota_twins,
  mets: MLB_COLORS.new_york_mets,
  yankees: MLB_COLORS.new_york_yankees,
  "a's": MLB_COLORS.oakland_athletics,
  athletics: MLB_COLORS.athletics,
  phillies: MLB_COLORS.philadelphia_phillies,
  pirates: MLB_COLORS.pittsburgh_pirates,
  padres: MLB_COLORS.san_diego_padres,
  giants: MLB_COLORS.san_francisco_giants,
  mariners: MLB_COLORS.seattle_mariners,
  cardinals: MLB_COLORS.st_louis_cardinals,
  rays: MLB_COLORS.tampa_bay_rays,
  rangers: MLB_COLORS.texas_rangers,
  "blue-jays": MLB_COLORS.toronto_blue_jays,
  blue_jays: MLB_COLORS.toronto_blue_jays,
  bluejays: MLB_COLORS.toronto_blue_jays,
  nationals: MLB_COLORS.washington_nationals,
};

// ── MLB abbreviation aliases (e.g. "NYM", "LAD", "TB") ──
// These are the values stored in game.awayTeam / game.homeTeam in the DB
const MLB_ABBREV_ALIASES: Record<string, TeamColorEntry> = {
  ARI: MLB_COLORS.arizona_diamondbacks,
  ATL: MLB_COLORS.atlanta_braves,
  BAL: MLB_COLORS.baltimore_orioles,
  BOS: MLB_COLORS.boston_red_sox,
  CHC: MLB_COLORS.chicago_cubs,
  CWS: MLB_COLORS.chicago_white_sox,
  CIN: MLB_COLORS.cincinnati_reds,
  CLE: MLB_COLORS.cleveland_guardians,
  COL: MLB_COLORS.colorado_rockies,
  DET: MLB_COLORS.detroit_tigers,
  HOU: MLB_COLORS.houston_astros,
  KC: MLB_COLORS.kansas_city_royals,
  LAA: MLB_COLORS.los_angeles_angels,
  LAD: MLB_COLORS.los_angeles_dodgers,
  MIA: MLB_COLORS.miami_marlins,
  MIL: MLB_COLORS.milwaukee_brewers,
  MIN: MLB_COLORS.minnesota_twins,
  NYM: MLB_COLORS.new_york_mets,
  NYY: MLB_COLORS.new_york_yankees,
  ATH: MLB_COLORS.athletics,
  OAK: MLB_COLORS.oakland_athletics,
  PHI: MLB_COLORS.philadelphia_phillies,
  PIT: MLB_COLORS.pittsburgh_pirates,
  SD: MLB_COLORS.san_diego_padres,
  SF: MLB_COLORS.san_francisco_giants,
  SEA: MLB_COLORS.seattle_mariners,
  STL: MLB_COLORS.st_louis_cardinals,
  TB: MLB_COLORS.tampa_bay_rays,
  TEX: MLB_COLORS.texas_rangers,
  TOR: MLB_COLORS.toronto_blue_jays,
  WSH: MLB_COLORS.washington_nationals,
};

// ── Unified lookup map ────────────────────────────────────────────────────────
const ALL_COLORS = new Map<string, TeamColorEntry>([
  ...Object.entries(NHL_COLORS),
  ...Object.entries(NBA_COLORS),
  ...Object.entries(MLB_COLORS),
  ...Object.entries(MLB_SHORT_SLUG_ALIASES),
  ...Object.entries(MLB_ABBREV_ALIASES),
]);

/**
 * Look up team colors by DB slug, short slug, or abbreviation.
 * Supports all three formats used across the codebase:
 *   - Full slug:  "new_york_mets" (MLB_COLORS key format)
 *   - Short slug: "mets" (vsinSlug / dbSlug stored in mlb_teams.dbSlug)
 *   - Abbreviation: "NYM" (stored in games.awayTeam / games.homeTeam)
 * Returns null if the team is not found.
 */
export function getTeamColors(
  dbSlug: string,
  sport?: string
): TeamColorEntry | null {
  if (sport === "NCAAF") return null; // College aliases must not inherit pro-team colors.
  return ALL_COLORS.get(dbSlug) ?? null;
}

/**
 * Get colors for both teams in a game — replaces trpc.teamColors.getForGame.
 * Zero network round-trips.
 */
export function getGameTeamColorsClient(
  awayDbSlug: string,
  homeDbSlug: string,
  sport?: string
): { away: TeamColorEntry | null; home: TeamColorEntry | null } {
  return {
    away: getTeamColors(awayDbSlug, sport),
    home: getTeamColors(homeDbSlug, sport),
  };
}
