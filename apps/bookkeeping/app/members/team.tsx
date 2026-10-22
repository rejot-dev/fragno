import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { Select } from "@fragno-private/design-system/select";
import { Form, useNavigation } from "react-router";

import { ROLE_LABELS } from "../organizations/roles";
import type { InviteResult, Team } from "./members.server";

/** An organization's people, its pending invitations, and inviting, for those who may. */
export function TeamSection({ team, result }: { team: Team; result: InviteResult | undefined }) {
  const navigation = useNavigation();
  return (
    <div className="max-w-2xl space-y-6">
      <FormContainer title="People">
        <ul className="divide-y divide-[var(--bo-border)]">
          {team.members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between gap-3 py-3">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {member.name}
                  {member.you ? " (you)" : ""}
                </span>
                <span className="block truncate text-xs text-[var(--bo-muted)]">
                  {member.email}
                </span>
              </span>
              <span className="text-xs text-[var(--bo-muted)]">{ROLE_LABELS[member.role]}</span>
            </li>
          ))}
        </ul>
      </FormContainer>
      {team.inviteRoles.length > 0 && (
        <FormContainer
          title="Invite someone"
          description="We email them an invitation. They sign in with the invited email to join."
        >
          <Form method="post" className="space-y-4">
            <Field label="Email">
              <Input className="w-full" name="email" type="email" autoComplete="off" required />
            </Field>
            <Field label="Role">
              <Select
                name="role"
                options={team.inviteRoles.map((role) => ({
                  label: ROLE_LABELS[role],
                  value: role,
                }))}
                defaultValue="member"
                required
              />
            </Field>
            {result?.status === "failed" && (
              <p role="alert" className="text-sm text-[var(--bo-failed)]">
                {result.error}
              </p>
            )}
            {result?.status === "invited" && (
              <div role="status" className="space-y-1 text-sm">
                <p>
                  {result.emailed
                    ? `We emailed ${result.email} an invitation. You can also send them this link:`
                    : `We couldn't email ${result.email}. Send them this link:`}
                </p>
                <Input
                  className="w-full"
                  readOnly
                  value={result.link}
                  aria-label="Invitation link"
                />
              </div>
            )}
            <Button type="submit" variant="accent" disabled={navigation.state !== "idle"}>
              Create invitation
            </Button>
          </Form>
        </FormContainer>
      )}
      {team.invitations.length > 0 && (
        <FormContainer title="Waiting to join">
          <ul className="divide-y divide-[var(--bo-border)]">
            {team.invitations.map((invitation) => (
              <li key={invitation.id} className="space-y-1 py-3">
                <span className="block text-sm font-medium">
                  {invitation.email} · {ROLE_LABELS[invitation.role]}
                </span>
                {(invitation.invitedBy !== null || invitation.link !== null) && (
                  <span className="block truncate text-xs text-[var(--bo-muted)]">
                    {[
                      invitation.invitedBy === null ? null : `Invited by ${invitation.invitedBy}`,
                      invitation.link,
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </FormContainer>
      )}
    </div>
  );
}
