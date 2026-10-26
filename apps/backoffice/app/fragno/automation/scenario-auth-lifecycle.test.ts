import { describe, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";

import { ApiObject } from "../../../workers/api.do";
import { AuthObject } from "../../../workers/auth.do";
import { AutomationsObject } from "../../../workers/automations.do";
import { FormsObject } from "../../../workers/forms.do";
import { OtpObject } from "../../../workers/otp.do";
import { UploadObject } from "../../../workers/upload.do";
import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  FORMS: (input) => new FormsObject(input),
  OTP: (input) => new OtpObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

describe("Better Auth lifecycle scenarios", () => {
  test("manages sessions, organizations, invitations, and sign-out", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Better Auth session and organization lifecycle",
        vars: () => ({
          ownerCookie: "",
          memberCookie: "",
          sharedOrganizationId: "",
          invitationId: "",
        }),
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "owner@example.com",
            captureSessionCookieAs: "ownerCookie",
          }),
          when.auth.signUp({
            email: "member@example.com",
            captureSessionCookieAs: "memberCookie",
          }),
          then.auth.sessionWithoutOrganization({ cookie: ({ vars }) => vars.ownerCookie }),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.ownerCookie,
            name: "Shared Workspace",
            slug: "shared-workspace",
            captureOrganizationIdAs: "sharedOrganizationId",
          }),
          when.auth.inviteMember({
            cookie: ({ vars }) => vars.ownerCookie,
            organizationId: ({ vars }) => vars.sharedOrganizationId,
            email: "member@example.com",
            captureInvitationIdAs: "invitationId",
          }),
          when.auth.acceptInvitation({
            cookie: ({ vars }) => vars.memberCookie,
            invitationId: ({ vars }) => vars.invitationId,
          }),
          then.auth.sessionHasOrganization({
            cookie: ({ vars }) => vars.memberCookie,
            organizationId: ({ vars }) => vars.sharedOrganizationId,
          }),
          when.auth.signOut({ cookie: ({ vars }) => vars.memberCookie }),
          then.auth.signedOut({ cookie: ({ vars }) => vars.memberCookie }),
        ],
      }),
    );
  });
});
