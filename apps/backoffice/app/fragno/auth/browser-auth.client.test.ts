import { afterEach, beforeEach, describe, expect, test, vi, assert } from "vitest";

import {
  backofficeTokenRefreshDelay,
  backofficeFetch,
  recordIssuedBackofficeToken,
  scheduleBackofficeTokenRefresh,
} from "./browser-auth.client";
import { BACKOFFICE_AUTH_ERROR_HEADER, BACKOFFICE_TOKEN_EXPIRED_CODE } from "./contracts";

describe("Backoffice browser authentication", () => {
  beforeEach(() => {
    recordIssuedBackofficeToken({
      expiresAt: "2099-01-01T00:00:00.000Z",
      organization: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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
        Response.json({
          expiresAt: "2026-08-11T12:15:00.000Z",
          organization: null,
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const response = await backofficeFetch(
      "/api/backoffice/me",
      { credentials: "same-origin" },
      fetchImplementation,
    );

    assert(response.status === 200);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    // The session keeps the organization, so the refresh does not name one.
    expect(fetchImplementation).toHaveBeenNthCalledWith(2, "/api/auth/backoffice-token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: "preferred" }),
    });
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
    completeRefresh(
      Response.json({
        expiresAt: "2027-08-11T12:15:00.000Z",
        organization: null,
      }),
    );

    await expect(Promise.all([firstRequest, secondRequest])).resolves.toHaveLength(2);
    expect(
      fetchImplementation.mock.calls.filter(([input]) => input === "/api/auth/backoffice-token"),
    ).toHaveLength(1);
  });

  test("holds concurrent application requests behind one refresh after an idle expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-08-11T12:16:00.000Z"));
    recordIssuedBackofficeToken({
      expiresAt: "2027-08-11T12:15:00.000Z",
      organization: null,
    });

    let completeRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      completeRefresh = resolve;
    });
    const applicationRequests: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === "/api/auth/backoffice-token") {
        return await refreshResponse;
      }
      applicationRequests.push(String(input));
      return Response.json({ ok: true });
    });

    const firstRequest = backofficeFetch("/api/backoffice/first", undefined, fetchImplementation);
    const secondRequest = backofficeFetch("/api/backoffice/second", undefined, fetchImplementation);

    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1));
    expect(applicationRequests).toEqual([]);

    completeRefresh(
      Response.json({
        expiresAt: "2027-08-11T12:31:00.000Z",
        organization: null,
      }),
    );

    await expect(Promise.all([firstRequest, secondRequest])).resolves.toHaveLength(2);
    expect(applicationRequests).toEqual(["/api/backoffice/first", "/api/backoffice/second"]);
    expect(
      fetchImplementation.mock.calls.filter(([input]) => input === "/api/auth/backoffice-token"),
    ).toHaveLength(1);
  });

  test("aborted requests stop waiting without cancelling the shared refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-08-11T12:16:00.000Z"));
    recordIssuedBackofficeToken({
      expiresAt: "2027-08-11T12:15:00.000Z",
      organization: null,
    });

    let completeRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      completeRefresh = resolve;
    });
    const applicationRequests: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === "/api/auth/backoffice-token") {
        return await refreshResponse;
      }
      applicationRequests.push(String(input));
      return Response.json({ ok: true });
    });
    const abortController = new AbortController();

    const abortedRequest = backofficeFetch(
      "/api/backoffice/aborted",
      { signal: abortController.signal },
      fetchImplementation,
    );
    const continuingRequest = backofficeFetch(
      "/api/backoffice/continuing",
      undefined,
      fetchImplementation,
    );
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1));

    abortController.abort();
    await expect(abortedRequest).rejects.toMatchObject({ name: "AbortError" });
    expect(applicationRequests).toEqual([]);

    completeRefresh(
      Response.json({
        expiresAt: "2027-08-11T12:31:00.000Z",
        organization: null,
      }),
    );

    await expect(continuingRequest).resolves.toMatchObject({ status: 200 });
    expect(applicationRequests).toEqual(["/api/backoffice/continuing"]);
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
      Object.assign(new EventTarget(), { visibilityState: "visible" as const }),
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
