import { assert, describe, expect, test } from "vitest";

import {
  BACKOFFICE_ORGANIZATION_NOT_FOUND_CODE,
  getBackofficeOrganizationNotFound,
  getRouteErrorMessage,
  throwBackofficeOrganizationNotFound,
} from "./route-errors";

function captureThrownResponse(operation: () => never): Response {
  try {
    operation();
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected operation to throw a Response.");
}

describe("Backoffice route errors", () => {
  test("preserves the missing organization slug in structured 404 data", async () => {
    const response = captureThrownResponse(() =>
      throwBackofficeOrganizationNotFound("missing-organization"),
    );
    const data = await response.json();
    const routeError = {
      status: response.status,
      statusText: response.statusText,
      internal: false,
      data,
    };

    assert(response.status === 404);
    expect(data).toEqual({
      code: BACKOFFICE_ORGANIZATION_NOT_FOUND_CODE,
      resource: "organization",
      organizationSlug: "missing-organization",
      message: "Organization 'missing-organization' could not be found.",
    });
    expect(getBackofficeOrganizationNotFound(routeError)).toEqual({
      organizationSlug: "missing-organization",
    });
    assert(
      getRouteErrorMessage(routeError) ===
        "Organization 'missing-organization' could not be found.",
    );
  });

  test("does not classify unrelated 404 responses as missing organizations", () => {
    assert(
      getBackofficeOrganizationNotFound({
        status: 404,
        statusText: "Not Found",
        internal: false,
        data: { code: "PAGE_NOT_FOUND" },
      }) === null,
    );
  });
});
