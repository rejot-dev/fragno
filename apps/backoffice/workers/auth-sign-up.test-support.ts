import type { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";

type InMemoryBackofficeRuntime = Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>;

/** Issues the real OTP credentials required by an in-memory Better Auth sign-up request. */
export async function issueTestSignUpInvitation(
  runtime: InMemoryBackofficeRuntime,
  email: string,
): Promise<{ invitationId: string; invitationCode: string }> {
  const invitation = await runtime.objects.otp.singleton().commands.issueSignUpInvitation({
    email,
    publicBaseUrl: "https://backoffice.example",
  });
  const invitationCode = new URL(invitation.url).searchParams.get("code");
  if (!invitationCode) {
    throw new Error("Test sign-up invitation URL is missing its code.");
  }

  return { invitationId: invitation.invitationId, invitationCode };
}
