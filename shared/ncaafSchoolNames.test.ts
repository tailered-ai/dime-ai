import { describe, expect, it } from "vitest";
import teams from "./ncaafFeedTeams.json" with { type: "json" };
import registry from "../scripts/data/cfb-2026/teams.json" with { type: "json" };
import { ncaafSchoolName } from "./ncaafSchoolNames";

const earlierSlates = [
  "MASS",
  "RUTG",
  "AKR",
  "WAKE",
  "COLO",
  "GT",
  "UAB",
  "ILL",
  "SJSU",
  "EMU",
  "TOL",
  "MSU",
  "FRES",
  "USC",
  "UTEP",
  "OU",
  "MIA",
  "STAN",
];

describe("NCAAF school display names", () => {
  it("covers every accepted 2026 registry and feed code with a distinct full school name", () => {
    const codes = new Set([
      ...registry.map(team => team.espnAbbreviation),
      ...Object.keys(teams),
      ...earlierSlates,
    ]);
    expect(codes.size).toBe(176);
    const names = Array.from(codes, code => {
      const name = ncaafSchoolName(code);
      expect(name, code).not.toBe("Unknown school");
      expect(name, code).not.toBe(code);
      return name;
    });
    expect(new Set(names).size).toBe(176);
  });

  it("covers every school in the September 3, 4 and 5 slates without falling back to codes", () => {
    const codes = new Set([...Object.keys(teams), ...earlierSlates]);
    expect(codes.size).toBe(154);
    const names = Array.from(codes, code => {
      const name = ncaafSchoolName(code);
      expect(name, code).not.toBe("Unknown school");
      expect(name, code).not.toBe(code);
      return name;
    });
    expect(new Set(names).size).toBe(154);
  });

  it("expands school abbreviations and distinguishes similarly named schools", () => {
    const expected = {
      "M-OH": "Miami (Ohio)",
      MIA: "Miami (Florida)",
      PITT: "Pittsburgh",
      SJSU: "San Jose State",
      EMU: "Eastern Michigan",
      CONN: "Connecticut",
      USC: "Southern California",
      UTEP: "University of Texas at El Paso",
      UTSA: "University of Texas at San Antonio",
      RGV: "University of Texas Rio Grande Valley",
      UCLA: "University of California, Los Angeles",
      UAB: "University of Alabama at Birmingham",
      UNLV: "University of Nevada, Las Vegas",
      LSU: "Louisiana State",
      BYU: "Brigham Young",
      VMI: "Virginia Military Institute",
      APP: "Appalachian State",
      SELA: "Southeastern Louisiana",
      USM: "Southern Mississippi",
      PSU: "Pennsylvania State",
      NIU: "Northern Illinois",
      NICH: "Nicholls State",
      OKST: "Oklahoma State",
      OSU: "Ohio State",
      ORST: "Oregon State",
      NCSU: "North Carolina State",
      SMU: "Southern Methodist",
      TCU: "Texas Christian",
      UCF: "University of Central Florida",
      MISS: "Mississippi",
      ND: "Notre Dame",
    };
    for (const [code, name] of Object.entries(expected))
      expect(ncaafSchoolName(code)).toBe(name);
  });

  it("uses school names rather than mascot names or lossy mascot stripping", () => {
    expect(ncaafSchoolName("SYR")).toBe("Syracuse");
    expect(ncaafSchoolName("UNT")).toBe("North Texas");
    expect(ncaafSchoolName("MRSH")).toBe("Marshall");
    expect(ncaafSchoolName("ARMY")).toBe("Army");
    expect(ncaafSchoolName("CIT")).toBe("The Citadel");
    expect(ncaafSchoolName("TA&M")).toBe("Texas A&M University");
    expect(ncaafSchoolName("UL")).toBe("University of Louisiana at Lafayette");
    expect(ncaafSchoolName("ULM")).toBe("University of Louisiana at Monroe");
  });

  it("normalizes code input and never invents a school for an unknown code", () => {
    expect(ncaafSchoolName(" m-oh ")).toBe("Miami (Ohio)");
    expect(ncaafSchoolName(" utep ")).toBe("University of Texas at El Paso");
    expect(ncaafSchoolName("UNKNOWN")).toBe("UNKNOWN");
    expect(ncaafSchoolName(" future-code ")).toBe("FUTURE-CODE");
    expect(ncaafSchoolName("")).toBe("Unknown school");
    expect(ncaafSchoolName("   ")).toBe("Unknown school");
  });
});
