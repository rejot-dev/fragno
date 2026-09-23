import { expect, test } from "vitest";

import { readFile } from "node:fs/promises";

import { generateCandidates } from "./generate-summary-candidates.js";

const SAMPLE_ARTICLE_FILES = {
  digitalFolklifeCollections: "loc-digital-folklife-collections.txt",
  farmToSchoolCensus: "usda-farm-to-school-census.txt",
  klamathRiverRestoration: "nps-klamath-river-restoration.txt",
  solarFuturesStudy: "doe-solar-futures-study.txt",
  webbExoplanetAtmosphere: "nasa-webb-exoplanet-atmosphere.txt",
} as const;

function readSampleArticle(fileName: string): Promise<string> {
  return readFile(new URL(`../samples/${fileName}`, import.meta.url), "utf8");
}

const candidateOptions = {
  maxInputSentences: 100,
  candidates: 12,
  summarySentences: [2, 3, 4],
} as const;

test("generates deterministic candidates with source sentences restored to document order", async () => {
  const article = await readSampleArticle("nasa-webb-exoplanet-atmosphere.txt");
  const firstRun = generateCandidates(article, candidateOptions);
  const secondRun = generateCandidates(article, candidateOptions);

  expect(secondRun).toEqual(firstRun);
  expect(firstRun.map((candidate) => candidate.text)).toMatchInlineSnapshot(`
    [
      "Astronomers using NASA's James Webb Space Telescope examined the atmosphere of
    WASP-39 b, a hot gas giant that circles a star about 700 light-years from Earth. The sulfur dioxide finding was especially notable because
    scientists concluded that it is produced by photochemistry rather than simply
    rising unchanged from deeper layers.",
      "Astronomers using NASA's James Webb Space Telescope examined the atmosphere of
    WASP-39 b, a hot gas giant that circles a star about 700 light-years from Earth. That tight orbit heats the atmosphere to
    about 1,600 degrees Fahrenheit and makes the planet a useful target for
    transmission spectroscopy. The sulfur dioxide finding was especially notable because
    scientists concluded that it is produced by photochemistry rather than simply
    rising unchanged from deeper layers.",
      "Astronomers using NASA's James Webb Space Telescope examined the atmosphere of
    WASP-39 b, a hot gas giant that circles a star about 700 light-years from Earth. That tight orbit heats the atmosphere to
    about 1,600 degrees Fahrenheit and makes the planet a useful target for
    transmission spectroscopy.",
      "Astronomers using NASA's James Webb Space Telescope examined the atmosphere of
    WASP-39 b, a hot gas giant that circles a star about 700 light-years from Earth. The planet is roughly as massive as Saturn but follows an orbit much closer to
    its star than Mercury does to the Sun. The sulfur dioxide finding was especially notable because
    scientists concluded that it is produced by photochemistry rather than simply
    rising unchanged from deeper layers.",
      "That tight orbit heats the atmosphere to
    about 1,600 degrees Fahrenheit and makes the planet a useful target for
    transmission spectroscopy. The carbon dioxide detection built on an earlier Webb result and
    showed how clearly the telescope could identify a molecule important to
    planetary climate.",
      "Astronomers using NASA's James Webb Space Telescope examined the atmosphere of
    WASP-39 b, a hot gas giant that circles a star about 700 light-years from Earth. That tight orbit heats the atmosphere to
    about 1,600 degrees Fahrenheit and makes the planet a useful target for
    transmission spectroscopy. The resulting spectra provided a detailed chemical inventory. The sulfur dioxide finding was especially notable because
    scientists concluded that it is produced by photochemistry rather than simply
    rising unchanged from deeper layers.",
      "Astronomers using NASA's James Webb Space Telescope examined the atmosphere of
    WASP-39 b, a hot gas giant that circles a star about 700 light-years from Earth. That tight orbit heats the atmosphere to
    about 1,600 degrees Fahrenheit and makes the planet a useful target for
    transmission spectroscopy. The carbon dioxide detection built on an earlier Webb result and
    showed how clearly the telescope could identify a molecule important to
    planetary climate. The sulfur dioxide finding was especially notable because
    scientists concluded that it is produced by photochemistry rather than simply
    rising unchanged from deeper layers.",
      "Astronomers using NASA's James Webb Space Telescope examined the atmosphere of
    WASP-39 b, a hot gas giant that circles a star about 700 light-years from Earth. The planet is roughly as massive as Saturn but follows an orbit much closer to
    its star than Mercury does to the Sun.",
      "Astronomers using NASA's James Webb Space Telescope examined the atmosphere of
    WASP-39 b, a hot gas giant that circles a star about 700 light-years from Earth. That tight orbit heats the atmosphere to
    about 1,600 degrees Fahrenheit and makes the planet a useful target for
    transmission spectroscopy. The carbon dioxide detection built on an earlier Webb result and
    showed how clearly the telescope could identify a molecule important to
    planetary climate.",
      "Astronomers using NASA's James Webb Space Telescope examined the atmosphere of
    WASP-39 b, a hot gas giant that circles a star about 700 light-years from Earth. That tight orbit heats the atmosphere to
    about 1,600 degrees Fahrenheit and makes the planet a useful target for
    transmission spectroscopy. The carbon dioxide detection built on an earlier Webb result and
    showed how clearly the telescope could identify a molecule important to
    planetary climate. Instead, it served as a demanding test of methods that can later be
    applied to smaller and cooler worlds.",
      "That tight orbit heats the atmosphere to
    about 1,600 degrees Fahrenheit and makes the planet a useful target for
    transmission spectroscopy. The carbon dioxide detection built on an earlier Webb result and
    showed how clearly the telescope could identify a molecule important to
    planetary climate. Instead, it served as a demanding test of methods that can later be
    applied to smaller and cooler worlds.",
      "Astronomers using NASA's James Webb Space Telescope examined the atmosphere of
    WASP-39 b, a hot gas giant that circles a star about 700 light-years from Earth. The carbon dioxide detection built on an earlier Webb result and
    showed how clearly the telescope could identify a molecule important to
    planetary climate.",
    ]
  `);
});

test("shows the best summary for varied articles", async () => {
  const bestSummaries = Object.fromEntries(
    await Promise.all(
      Object.entries(SAMPLE_ARTICLE_FILES).map(async ([articleName, fileName]) => {
        const article = await readSampleArticle(fileName);
        return [
          articleName,
          generateCandidates(article, {
            maxInputSentences: 100,
            candidates: 30,
            summarySentences: [3],
          })[0]!.text,
        ];
      }),
    ),
  );

  expect(bestSummaries).toMatchInlineSnapshot(`
    {
      "digitalFolklifeCollections": "The American Folklife Center at the Library of Congress preserves recordings,
    photographs, manuscripts, and other materials documenting cultural traditions. Its holdings include songs, stories, interviews, occupational knowledge,
    community celebrations, and accounts of everyday life. Creating an online collection involves more than scanning a page or copying an
    audio file.",
      "farmToSchoolCensus": "The census covers activities such as
    buying food from nearby producers, serving regional products, operating school
    gardens, arranging farm visits, and teaching students where food comes from. Results help agencies, schools, farmers, and community organizations identify
    both progress and remaining barriers. Seasonal availability influences
    menus, and districts often combine fresh products with frozen or processed items
    that can be stored longer.",
      "klamathRiverRestoration": "The removal of four hydroelectric dams on the Klamath River reopened hundreds of
    miles of habitat along the California-Oregon border. Contractors
    breached the structures, moved concrete and earth, managed sediment, and
    reshaped channels through the former reservoir sites. Helicopters, machinery, and field crews spread seed and installed plants over
    large areas that would otherwise have been vulnerable to erosion and invasive
    species.",
      "solarFuturesStudy": "Reaching those levels would require rapid
    construction, major changes to the power grid, and continued investment in
    manufacturing and workers. Existing technologies were
    sufficient for much of the modeled growth, although further innovation could
    lower costs and simplify deployment. The country would add large
    utility-scale solar projects as well as systems on homes, businesses, parking
    structures, and other developed land.",
      "webbExoplanetAtmosphere": "Astronomers using NASA's James Webb Space Telescope examined the atmosphere of
    WASP-39 b, a hot gas giant that circles a star about 700 light-years from Earth. That tight orbit heats the atmosphere to
    about 1,600 degrees Fahrenheit and makes the planet a useful target for
    transmission spectroscopy. The sulfur dioxide finding was especially notable because
    scientists concluded that it is produced by photochemistry rather than simply
    rising unchanged from deeper layers.",
    }
  `);
});

test("uses MMR to avoid repeated equivalent sentences in the highest-ranked candidates", () => {
  const candidates = generateCandidates(
    [
      "The launch window opens before sunrise.",
      "The launch window opens before sunrise.",
      "Engineers completed the final safety review.",
      "Weather conditions remain favorable for flight.",
    ].join(" "),
    {
      maxInputSentences: 100,
      candidates: 6,
      summarySentences: [2],
    },
  );

  expect(candidates.map((candidate) => candidate.text)).toMatchInlineSnapshot(`
    [
      "The launch window opens before sunrise. Engineers completed the final safety review.",
      "The launch window opens before sunrise. Weather conditions remain favorable for flight.",
      "The launch window opens before sunrise. Engineers completed the final safety review.",
      "The launch window opens before sunrise. Weather conditions remain favorable for flight.",
      "The launch window opens before sunrise. The launch window opens before sunrise.",
    ]
  `);
});

test("prefilters long documents before generating candidates", () => {
  const uniqueSentences = Array.from(
    { length: 100 },
    (_, index) => `Archive entry ${index} records topic${index} for routine review.`,
  );
  const repeatedTopicSentences = Array.from(
    { length: 8 },
    (_, index) =>
      `Fusion battery research report ${index} covers plasma storage materials and reactor energy.`,
  );

  expect(
    generateCandidates([...uniqueSentences, ...repeatedTopicSentences].join(" "), {
      maxInputSentences: 10,
      candidates: 8,
      summarySentences: [3],
    }).map((candidate) => candidate.text),
  ).toMatchInlineSnapshot(`
    [
      "Archive entry 0 records topic0 for routine review. Archive entry 1 records topic1 for routine review. Fusion battery research report 2 covers plasma storage materials and reactor energy.",
      "Archive entry 0 records topic0 for routine review. Archive entry 1 records topic1 for routine review. Fusion battery research report 3 covers plasma storage materials and reactor energy.",
      "Archive entry 0 records topic0 for routine review. Archive entry 1 records topic1 for routine review. Fusion battery research report 4 covers plasma storage materials and reactor energy.",
      "Archive entry 0 records topic0 for routine review. Archive entry 1 records topic1 for routine review. Fusion battery research report 5 covers plasma storage materials and reactor energy.",
      "Archive entry 0 records topic0 for routine review. Archive entry 1 records topic1 for routine review. Fusion battery research report 6 covers plasma storage materials and reactor energy.",
      "Archive entry 0 records topic0 for routine review. Archive entry 1 records topic1 for routine review. Fusion battery research report 7 covers plasma storage materials and reactor energy.",
      "Archive entry 0 records topic0 for routine review. Archive entry 1 records topic1 for routine review. Fusion battery research report 0 covers plasma storage materials and reactor energy.",
      "Archive entry 0 records topic0 for routine review. Archive entry 1 records topic1 for routine review. Fusion battery research report 1 covers plasma storage materials and reactor energy.",
    ]
  `);
});

test("returns no candidates for text without sentences", () => {
  expect(generateCandidates("   \n", candidateOptions)).toMatchInlineSnapshot(`[]`);
});

test("rejects options that exceed the classifier-sized sentence pool", () => {
  expect(() =>
    generateCandidates("One sentence.", {
      maxInputSentences: 101,
      candidates: 1,
      summarySentences: [1],
    }),
  ).toThrowErrorMatchingInlineSnapshot(
    `[RangeError: Summary candidate generation: maxInputSentences must not exceed 100]`,
  );

  expect(() =>
    generateCandidates("One sentence.", {
      maxInputSentences: 100,
      candidates: 1,
      summarySentences: [],
    }),
  ).toThrowErrorMatchingInlineSnapshot(
    `[RangeError: Summary candidate generation: summarySentences must contain at least one sentence count]`,
  );
});
