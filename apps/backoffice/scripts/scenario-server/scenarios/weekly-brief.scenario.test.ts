import { expect, test } from "vitest";

import { runBackofficeScenario } from "../../../app/fragno/automation/scenario";
import { createScenarioExplanations } from "../scenario-explanations";
import type { ScenarioViewSteps } from "../scenario-view";
import weeklyBrief from "./weekly-brief";

// The tour's page steps do nothing without a view; its operations run as the tour runs them.
const noView: ScenarioViewSteps = {
  navigate: (path, label = `open ${path}`) => ({
    type: "view.navigate",
    label,
    run: async () => {},
  }),
  highlight: (_target, caption) => ({
    type: "view.highlight",
    label: caption,
    run: async () => {},
  }),
  click: (_target, label = "click") => ({ type: "view.click", label, run: async () => {} }),
};

const HEADER = "job,title,due,status,why,change,line\n";

test("the Friday run compares each export with the brief before it, however often it runs", async () => {
  const tour = weeklyBrief({
    origin: "http://localhost",
    view: noView,
    later: createScenarioExplanations().later,
  });

  await runBackofficeScenario({
    ...tour,
    steps: (builders) => {
      const { when, then } = builders;
      const thisFridaysBrief = (label: string) =>
        then.assert(label, async (ctx) => {
          const files = ctx.files.forOrg(ctx.vars.orgId);
          expect(await files.readFile("/workspace/briefs/needs-decision.csv", "utf-8")).toBe(
            `${HEADER}J-1057,Boiler service,2026-11-17,Scheduled,10 days overdue,Now more than 7 days overdue,3\n`,
          );
          expect(await files.readFile("/workspace/briefs/dropped-off.csv", "utf-8")).toBe(
            `${HEADER}J-1042,Roof install,2026-11-10,Complete,Marked complete,Dropped off,2\n`,
          );
        });
      return [
        ...tour.steps(builders),
        thisFridaysBrief("this Friday's brief follows from last Friday's"),
        {
          type: "codemode.run",
          label: "run the brief again on the same export",
          run: async (ctx) => {
            await when.codemode
              .run({
                scope: { kind: "org", orgId: String(ctx.vars.orgId), jurisdiction: null },
                code: `async () => await router.triggerNow({ id: "friday-overdue-jobs-brief" })`,
              })
              .run(ctx);
          },
        },
        thisFridaysBrief("the rerun writes the same brief"),
      ];
    },
  });
});
