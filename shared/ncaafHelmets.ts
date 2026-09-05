import feedTeams from "./ncaafFeedTeams.json";

/** Public helmet assets, shared by the model and betting-splits feeds. */
const NCAAF_HELMETS: Readonly<Record<string, string>> = {
  SC: "/brand/ncaaf-helmets/sept5-sc.png",
  KENT: "/brand/ncaaf-helmets/sept5-kent.png",
  PITT: "/brand/ncaaf-helmets/sept5-pitt.png",
  "M-OH": "/brand/ncaaf-helmets/sept5-m-oh.png",
  OSU: "/brand/ncaaf-helmets/sept5-osu.png",
  BALL: "/brand/ncaaf-helmets/sept5-ball.png",
  WVU: "/brand/ncaaf-helmets/sept5-wvu.png",
  CCU: "/brand/ncaaf-helmets/sept5-ccu.png",
  UGA: "/brand/ncaaf-helmets/sept5-uga.png",
  TNST: "/brand/ncaaf-helmets/sept5-tnst.png",
  TEM: "/brand/ncaaf-helmets/sept5-tem.png",
  URI: "/brand/ncaaf-helmets/sept5-uri.png",
  UK: "/brand/ncaaf-helmets/sept5-uk.png",
  YSU: "/brand/ncaaf-helmets/sept5-ysu.png",
  ISU: "/brand/ncaaf-helmets/sept5-isu.png",
  SEMO: "/brand/ncaaf-helmets/sept5-semo.png",
  AFA: "/brand/ncaaf-helmets/sept5-afa.png",
  DUQ: "/brand/ncaaf-helmets/sept5-duq.png",
  NDSU: "/brand/ncaaf-helmets/sept5-ndsu.png",
  MEM: "/brand/ncaaf-helmets/sept5-mem.png",
  JVST: "/brand/ncaaf-helmets/sept5-jvst.png",
  NMSU: "/brand/ncaaf-helmets/sept5-nmsu.png",
  SAC: "/brand/ncaaf-helmets/sept5-sac.png",
  UNLV: "/brand/ncaaf-helmets/sept5-unlv.png",
  HAW: "/brand/ncaaf-helmets/sept5-haw.png",

  MASS: "/brand/ncaaf-helmets/mass-clean.png",
  RUTG: "/brand/ncaaf-helmets/rutgers-clean.png",
  AKR: "/brand/ncaaf-helmets/akron-clean.png",
  WAKE: "/brand/ncaaf-helmets/wake-forest-clean.png",
  COLO: "/brand/ncaaf-helmets/colorado-clean.png",
  GT: "/brand/ncaaf-helmets/georgia-tech-clean.png",
  UAB: "/brand/ncaaf-helmets/uab-clean.png",
  ILL: "/brand/ncaaf-helmets/illinois-clean.png",
  SJSU: "/brand/ncaaf-helmets/san-jose-state-clean.png",
  EMU: "/brand/ncaaf-helmets/eastern-michigan-clean.png",
  TOL: "/brand/ncaaf-helmets/toledo-clean.png",
  MSU: "/brand/ncaaf-helmets/michigan-state-clean.png",
  FRES: "/brand/ncaaf-helmets/fresno-state-clean.png",
  USC: "/brand/ncaaf-helmets/usc-clean.png",
  UTEP: "/brand/ncaaf-helmets/utep-clean.png",
  OU: "/brand/ncaaf-helmets/oklahoma-clean.png",
  MIA: "/brand/ncaaf-helmets/miami-clean.png",
  STAN: "/brand/ncaaf-helmets/stanford-clean.png",
};

export const ncaafHelmet = (abbr: string): string | null =>
  NCAAF_HELMETS[abbr] ??
  (feedTeams as Record<string, { logo: string }>)[abbr]?.logo ??
  null;
