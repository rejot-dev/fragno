import { readFileSync } from "node:fs";

type AutomationFixture = [path: string, source: string];

const STARTER_AUTOMATIONS_FILE =
  "../../../../apps/backoffice/app/files/content/starter-automations.ts";
const STATIC_AUTOMATIONS_FILE =
  "../../../../apps/backoffice/app/files/content/static-automations.ts";
const SYSTEM_AUTOMATIONS_FILE =
  "../../../../apps/backoffice/app/files/content/system-automations.ts";

export function loadBackofficeAutomationFixtures(): AutomationFixture[] {
  return [
    ...extractInlineAutomationSources(readFixtureFile(STARTER_AUTOMATIONS_FILE)),
    [
      "automations/telegram-test-command.workflow.js",
      extractExportedTemplateLiteral(
        readFixtureFile("../../../../apps/backoffice/app/files/content/telegram-test-command.ts"),
        "TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE",
      ),
    ],
    ...extractInlineAutomationSources(readFixtureFile(STATIC_AUTOMATIONS_FILE)),
    ...extractInlineAutomationSources(readFixtureFile(SYSTEM_AUTOMATIONS_FILE)),
  ];
}

function readFixtureFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function extractInlineAutomationSources(sourceFile: string): AutomationFixture[] {
  return [...sourceFile.matchAll(/"([^"]+\.workflow\.js)": `([\s\S]*?)`,\n/g)].map((match) => [
    match[1] ?? "",
    match[2] ?? "",
  ]);
}

function extractExportedTemplateLiteral(sourceFile: string, exportName: string): string {
  const declaration = `export const ${exportName} = \``;
  const sourceStart = sourceFile.indexOf(declaration);
  if (sourceStart === -1) {
    throw new Error(`Missing exported workflow source '${exportName}'.`);
  }

  const valueStart = sourceStart + declaration.length;
  const valueEnd = sourceFile.indexOf("`;", valueStart);
  if (valueEnd === -1) {
    throw new Error(`Exported workflow source '${exportName}' is not a template literal.`);
  }

  return sourceFile.slice(valueStart, valueEnd);
}
