import { backofficeUiBuildersSource } from "../../builder";
import { parsePageDefinition, type PageParseResult } from "../definition";

/**
 * Builds a page source in the browser with the builders the codemode sandbox gives it, then
 * validates the result as a build's is, apart from the host's check of its SQL. Stories have no module loader, so the source's default
 * export is returned instead; a source that imports saved modules does not build here.
 */
export function buildPageSource(source: string): PageParseResult {
  try {
    // oxlint-disable-next-line typescript/no-implied-eval -- the builders are source text, as the sandbox runs them.
    const builders = new Function(`return ${backofficeUiBuildersSource}`)() as {
      ui: unknown;
      page: unknown;
    };
    // oxlint-disable-next-line typescript/no-implied-eval -- evaluates the page source as its build would.
    const build = new Function("ui", "page", source.replace(/^export default /mu, "return "));
    // A build's result crosses the sandbox as JSON.
    const definition: unknown = JSON.parse(JSON.stringify(build(builders.ui, builders.page)));
    return parsePageDefinition(definition);
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
}
