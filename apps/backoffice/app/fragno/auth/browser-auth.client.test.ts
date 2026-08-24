import { afterEach, beforeEach, describe, expect, test, vi, assert } from "vitest";

import {
  backofficeTokenRefreshDelay,
  backofficeFetch,
  refreshBackofficeAccessToken,
  scheduleBackofficeTokenRefresh,
} from "./browser-auth.client";
import { BACKOFFICE_AUTH_ERROR_HEADER, BACKOFFICE_TOKEN_EXPIRED_CODE } from "./contracts";

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
};

describe("Backoffice browser authentication", () => {
  const localStorage = storage();

  beforeEach(() => {
    localStorage.values.clear();
    vi.stubGlobal("window", { localStorage, dispatchEvent: vi.fn() });
    vi.stubGlobal(
      "Event",
      class Event {
        constructor(readonly type: string) {}
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("refresh preserves the validated preferred organization", async () => {
    localStorage.setItem("fragno-backoffice-default-organization", "org-1");
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ expiresAt: "2026-08-11T12:15:00.000Z", organizationId: "org-1" }),
      );

    await refreshBackofficeAccessToken(fetchImplementation);

    expect(fetchImplementation).toHaveBeenCalledWith("/api/auth/backoffice-token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: "preferred", organizationId: "org-1" }),
    });
    assert(localStorage.getItem("fragno-backoffice-default-organization") === "org-1");
  });

  test("stores the server fallback for a stale preferred organization", async () => {
    localStorage.setItem("fragno-backoffice-default-organization", "org-stale");
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ expiresAt: "2026-08-11T12:15:00.000Z", organizationId: "org-current" }),
      );

    await refreshBackofficeAccessToken(fetchImplementation);

    expect(fetchImplementation).toHaveBeenCalledWith("/api/auth/backoffice-token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: "preferred", organizationId: "org-stale" }),
    });
    assert(localStorage.getItem("fragno-backoffice-default-organization") === "org-current");
  });

  test("retries an expired application request exactly once after refresh", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("Authentication expired", {
          status: 401,
          headers: { [BACKOFFICE_AUTH_ERROR_HEADER]: BACKOFFICE_TOKEN_EXPIRED_CODE },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ expiresAt: "2026-08-11T12:15:00.000Z", organizationId: null }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const response = await backofficeFetch(
      "/api/backoffice/me",
      { credentials: "same-origin" },
      fetchImplementation,
    );

    assert(response.status === 200);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  test("shares one refresh across concurrent expired requests", async () => {
    let completeRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      completeRefresh = resolve;
    });
    const expiredResponse = () =>
      new Response("Authentication expired", {
        status: 401,
        headers: { [BACKOFFICE_AUTH_ERROR_HEADER]: BACKOFFICE_TOKEN_EXPIRED_CODE },
      });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(expiredResponse())
      .mockResolvedValueOnce(expiredResponse())
      .mockImplementationOnce(() => refreshResponse)
      .mockResolvedValueOnce(Response.json({ request: 1 }))
      .mockResolvedValueOnce(Response.json({ request: 2 }));

    const firstRequest = backofficeFetch("/api/backoffice/first", undefined, fetchImplementation);
    const secondRequest = backofficeFetch("/api/backoffice/second", undefined, fetchImplementation);
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(3));
    completeRefresh(Response.json({ expiresAt: "2027-08-11T12:15:00.000Z", organizationId: null }));

    await expect(Promise.all([firstRequest, secondRequest])).resolves.toHaveLength(2);
    expect(
      fetchImplementation.mock.calls.filter(([input]) => input === "/api/auth/backoffice-token"),
    ).toHaveLength(1);
  });

  test("schedules refresh from the issued expiry", () => {
    vi.useFakeTimers();
    const setTimeoutImplementation = vi.fn(
      (_callback: () => void, _delayMilliseconds: number) => 42 as never,
    );
    const clearTimeoutImplementation = vi.fn((_timeout: ReturnType<typeof setTimeout>) => {});
    vi.setSystemTime(new Date("2027-08-11T12:00:00.000Z"));

    const stop = scheduleBackofficeTokenRefresh(
      "2027-08-11T12:15:00.000Z",
      vi.fn(),
      setTimeoutImplementation,
      clearTimeoutImplementation,
    );

    expect(backofficeTokenRefreshDelay("2027-08-11T12:15:00.000Z")).toBe(14 * 60 * 1_000);
    expect(setTimeoutImplementation).toHaveBeenCalledWith(expect.any(Function), 14 * 60 * 1_000);
    stop();
    expect(clearTimeoutImplementation).toHaveBeenCalledWith(42);
  });

  test("does not retry unrelated unauthorized responses", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Invalid credential", { status: 401 }));

    const response = await backofficeFetch("/api/backoffice/me", undefined, fetchImplementation);

    assert(response.status === 401);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});
