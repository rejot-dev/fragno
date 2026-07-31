import { readFileSync } from "node:fs";

type AutomationFixture = [path: string, source: string];

const STARTER_AUTOMATIONS_FILE =
  "../../../../apps/backoffice/app/files/content/starter-automations.ts";
const STATIC_AUTOMATIONS_FILE =
  "../../../../apps/backoffice/app/files/content/static-automations.ts";
const SYSTEM_AUTOMATIONS_FILE =
  "../../../../apps/backoffice/app/files/content/system-automations.ts";
const TELEGRAM_TEST_COMMAND_FILE =
  "../../../../apps/backoffice/app/files/content/telegram-test-command.ts";

export async function loadBackofficeAutomationFixtures(): Promise<AutomationFixture[]> {
  const telegramTestCommandSource = await loadTelegramTestCommandWorkflowSource();
  return [
    ...extractInlineAutomationSources(readFixtureFile(STARTER_AUTOMATIONS_FILE)),
    ["automations/telegram-test-command.workflow.js", telegramTestCommandSource],
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

async function loadTelegramTestCommandWorkflowSource(): Promise<string> {
  const telegramTestCommandModule = (await import(
    new URL(TELEGRAM_TEST_COMMAND_FILE, import.meta.url).href
  )) as { TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE: string };
  return telegramTestCommandModule.TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE;
}
