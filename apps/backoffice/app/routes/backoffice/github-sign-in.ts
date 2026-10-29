import { betterAuthClient } from "@/fragno/auth/better-auth.client";

/**
 * Sends the browser to GitHub. With an OAuth request, Better Auth resumes it after GitHub returns,
 * so the session lands back in the app that asked; without one, it lands on `returnTo`. An access
 * code travels through GitHub in the OAuth state, for a person GitHub signs up.
 */
export async function startGitHubSignIn(input: {
  returnTo: string;
  oauthQuery: string | null;
  accessCode: string | null;
}): Promise<void> {
  const result = await betterAuthClient.signIn.social({
    provider: "github",
    callbackURL: new URL(input.returnTo, window.location.origin).toString(),
    disableRedirect: true,
    ...(input.oauthQuery === null ? {} : { oauth_query: input.oauthQuery }),
    ...(input.accessCode === null ? {} : { additionalData: { accessCode: input.accessCode } }),
  });
  if (result.error) {
    throw new Error(result.error.message || "Unable to start GitHub sign-in.");
  }
  if (!result.data?.url) {
    throw new Error("GitHub authorization URL is missing.");
  }
  window.location.assign(result.data.url);
}
