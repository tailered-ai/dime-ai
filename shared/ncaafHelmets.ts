/** Public helmet assets, shared by the model and betting-splits feeds. */
const NCAAF_HELMETS: Readonly<Record<string, string>> = {
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
  NCAAF_HELMETS[abbr] ?? null;
