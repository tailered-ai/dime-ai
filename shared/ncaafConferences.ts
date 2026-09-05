/**
 * 2026 FBS affiliations from scripts/data/cfb-2026/teams.json (ESPN team
 * identities; source manifest dated 2026-07-25). Keep the browser lookup small;
 * ncaafConferences.test.ts checks every entry against that source snapshot.
 * Teams absent from the source, including FCS opponents, remain unknown.
 */
export const NCAAF_CONFERENCE_TEAMS = {
  "American Conference":
    "ARMY CLT ECU FAU MEM NAVY UNT RICE USF TEM TULN TLSA UAB UTSA",
  "Atlantic Coast Conference":
    "BC CAL CLEM DUKE FSU GT LOU MIA NCSU UNC PITT SMU STAN SYR UVA VT WAKE",
  "Big 12 Conference":
    "ASU ARIZ BYU BAY CIN COLO HOU ISU KU KSU OKST TCU TTU UCF UTAH WVU",
  "Big Ten Conference":
    "ILL IU IOWA MD MSU MICH MINN NEB NU OSU ORE PSU PUR RUTG UCLA USC WASH WIS",
  "Conference USA": "DEL FIU JVST KENN LIB MTSU MOST NMSU SHSU WKU",
  "FBS Independents": "ND CONN",
  "Mid-American Conference":
    "AKR BALL BGSU BUFF CMU EMU KENT MASS M-OH OHIO SAC TOL WMU",
  "Mountain West Conference": "AFA HAW NEV UNM NDSU NIU SJSU UNLV UTEP WYO",
  "Pac-12 Conference": "BOIS CSU FRES ORST SDSU TXST USU WSU",
  "Southeastern Conference":
    "ALA ARK AUB FLA UGA UK LSU MSST MIZ OU MISS SC TENN TA&M TEX VAN",
  "Sun Belt Conference":
    "APP CCU GASO GAST JMU MRSH ODU ARST UL LT USA USM TROY ULM",
} as const;

const conferenceByCode = new Map(
  Object.entries(NCAAF_CONFERENCE_TEAMS).flatMap(([conference, codes]) =>
    codes.split(" ").map(code => [code, conference] as const)
  )
);

export function ncaafConference(code: string): string | null {
  return conferenceByCode.get(code.trim().toUpperCase()) ?? null;
}
