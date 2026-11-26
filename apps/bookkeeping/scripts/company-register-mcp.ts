/**
 * A made-up company register served as an MCP server on loopback, to try filling in a supplier's
 * company details from a person's own connections locally (README, "Company details"). Its
 * companies are fictional; their IBANs only pass the check digits.
 *
 *   pnpm company-register:serve [--port 5899] [--token <bearer token>]
 */
import { parseArgs } from "node:util";

import type { TestMcpTool } from "@fragno-dev/mcp-fragment/testing";
import { startStreamableHttpTestMcpServer } from "@fragno-dev/mcp-fragment/testing/http";

const COMPANIES = [
  {
    name: "Babbage Works B.V.",
    registrationNumber: "81234567",
    vatNumber: "NL862345671B01",
    iban: "NL02ABNA0123456789",
    address: "Keizersgracht 123, 1015 CJ Amsterdam",
  },
  {
    name: "Acme Supplies B.V.",
    registrationNumber: "30123456",
    vatNumber: "NL815432109B01",
    iban: "NL72INGB0004815162",
    address: "Oudegracht 45, 3511 AB Utrecht",
  },
  {
    name: "Jacquard Looms B.V.",
    registrationNumber: "17654321",
    vatNumber: "NL820987654B01",
    iban: "NL39RABO0310249876",
    address: "Spoorlaan 300, 5038 CC Tilburg",
  },
  {
    name: "Difference Engine Parts B.V.",
    registrationNumber: "24681357",
    vatNumber: "NL853197531B01",
    iban: "NL12TRIO0198765432",
    address: "Weena 70, 3012 CM Rotterdam",
  },
  {
    name: "Lovelace Consultancy",
    registrationNumber: "69012345",
    vatNumber: "NL001234567B88",
    iban: "NL31BUNQ2061337001",
    address: "Stratumseind 10, 5611 ET Eindhoven",
  },
  {
    name: "Noordzee Kantoorartikelen B.V.",
    registrationNumber: "27111222",
    vatNumber: "NL809876543B01",
    iban: "NL73ABNA0555123456",
    address: "Lange Voorhout 8, 2514 ED Den Haag",
  },
];

function answer(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Lowercase words, so "Babbage Works" finds "Babbage Works B.V." and "babbage" alone does too. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Words of a legal form, which a search need not name. */
const LEGAL_FORMS = new Set(["bv", "b", "v", "ltd"]);

const TOOLS: TestMcpTool[] = [
  {
    name: "search_companies",
    title: "Search companies",
    description:
      "Search the company register by name. Returns the matching companies' names, registration (KvK) numbers, and cities; read one's details with get_company.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The company's name, or part of it" } },
      required: ["name"],
      additionalProperties: false,
    },
    call: ({ name }) => {
      const wanted = words(String(name)).filter((word) => !LEGAL_FORMS.has(word));
      const matches = COMPANIES.filter((company) => {
        const known = new Set(words(company.name));
        return wanted.length > 0 && wanted.every((word) => known.has(word));
      });
      return answer(
        matches.map(({ name, registrationNumber, address }) => ({
          name,
          registrationNumber,
          city: address.split(/\d{4} [A-Z]{2} /u)[1],
        })),
      );
    },
  },
  {
    name: "get_company",
    title: "Get a company",
    description:
      "Read a company's details from the register by its registration (KvK) number: name, VAT number, IBAN, and address.",
    inputSchema: {
      type: "object",
      properties: { registrationNumber: { type: "string", description: "The 8-digit KvK number" } },
      required: ["registrationNumber"],
      additionalProperties: false,
    },
    call: ({ registrationNumber }) => {
      const company = COMPANIES.find((row) => row.registrationNumber === registrationNumber);
      return company
        ? answer(company)
        : {
            isError: true,
            content: [
              { type: "text", text: `No company is registered as ${String(registrationNumber)}.` },
            ],
          };
    },
  },
];

const { values } = parseArgs({
  options: { port: { type: "string", default: "5899" }, token: { type: "string" } },
});

const register = await startStreamableHttpTestMcpServer(
  {
    protocolVersion: "2025-11-25",
    enableJsonResponse: true,
    ...(values.token === undefined ? {} : { requiredBearerToken: values.token }),
    tools: TOOLS.map((tool) => ({
      ...tool,
      call: (args) => {
        console.log(`${new Date().toISOString()} ${tool.name} ${JSON.stringify(args)}`);
        return tool.call(args);
      },
    })),
  },
  Number(values.port),
);
console.log(`Company register MCP server at ${register.endpointUrl}`);
console.log(
  values.token === undefined
    ? "No authentication: connect it with no credentials."
    : "Bearer token required: the one --token gave.",
);
