import { describe, expect, it } from "vitest";
import type { OAuth2Tokens } from "../../types";
import type { GithubOAuthClient } from "./client";
import type { GithubEmail, GithubProfile } from "./github";
import { github } from "./github";

const createGithubProfile = (overrides: Partial<GithubProfile> = {}): GithubProfile => {
  return {
    login: "mock-user",
    id: "12345",
    node_id: "node-12345",
    avatar_url: "https://avatars.githubusercontent.com/u/12345?v=4",
    gravatar_id: "",
    url: "https://api.github.com/users/mock-user",
    html_url: "https://github.com/mock-user",
    followers_url: "https://api.github.com/users/mock-user/followers",
    following_url: "https://api.github.com/users/mock-user/following{/other_user}",
    gists_url: "https://api.github.com/users/mock-user/gists{/gist_id}",
    starred_url: "https://api.github.com/users/mock-user/starred{/owner}{/repo}",
    subscriptions_url: "https://api.github.com/users/mock-user/subscriptions",
    organizations_url: "https://api.github.com/users/mock-user/orgs",
    repos_url: "https://api.github.com/users/mock-user/repos",
    events_url: "https://api.github.com/users/mock-user/events{/privacy}",
    received_events_url: "https://api.github.com/users/mock-user/received_events",
    type: "User",
    site_admin: false,
    name: "Mock User",
    company: "",
    blog: "",
    location: "",
    email: "mock-user@test.com",
    hireable: false,
    bio: "",
    twitter_username: "",
    public_repos: "0",
    public_gists: "0",
    followers: "0",
    following: "0",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    private_gists: "0",
    total_private_repos: "0",
    owned_private_repos: "0",
    disk_usage: "0",
    collaborators: "0",
    two_factor_authentication: false,
    plan: {
      name: "",
      space: "0",
      private_repos: "0",
      collaborators: "0",
    },
    ...overrides,
  };
};

const createMockGithubClient = (
  options: {
    tokens?: OAuth2Tokens | null;
    profile?: GithubProfile | null;
    emails?: GithubEmail[];
  } = {},
): GithubOAuthClient => {
  const tokens = options.tokens ?? {
    accessToken: "mock-access-token",
    tokenType: "bearer",
  };
  const profile = options.profile ?? createGithubProfile();
  const emails = options.emails ?? [
    {
      email: "mock-user@test.com",
      primary: true,
      verified: true,
      visibility: "private",
    },
  ];

  return {
    exchangeCode: async () => tokens,
    fetchProfile: async () => profile,
    fetchEmails: async () => emails,
  };
};

const emptyEmailProfile = createGithubProfile({ email: "" });

describe("github provider", () => {
  it("maps email from the emails endpoint when profile email is missing", async () => {
    const client = createMockGithubClient({
      profile: emptyEmailProfile,
      emails: [
        {
          email: "primary@test.com",
          primary: true,
          verified: true,
          visibility: "private",
        },
      ],
    });

    const provider = github({
      clientId: "client-id",
      clientSecret: "client-secret",
      client,
    });

    const result = await provider.getUserInfo({ accessToken: "token" });
    expect(result?.user.email).toBe("primary@test.com");
    expect(result?.user.emailVerified).toBe(true);
  });
});
