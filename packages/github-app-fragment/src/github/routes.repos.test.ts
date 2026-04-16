import { describe, expect, it } from "vitest";

import type { FragnoDatabase } from "@fragno-dev/db";

import { githubAppSchema } from "../schema";
import { buildHarness, runGithubUowCreate } from "./test-utils";
import { normalizeJoinedInstallation, normalizeJoinedLinks } from "./utils";

const createConfig = () => ({
  appId: "42",
  appSlug: "test-app",
  privateKeyPem: "test-key",
  webhookSecret: "secret",
  defaultLinkKey: "default",
});

type LinkResponse =
  | {
      type: "json";
      data: {
        link: { id: string; repoId: string; linkKey: string; linkedAt: Date };
        repo: { id: string; fullName: string; installationId: string };
      };
    }
  | { type: "error"; error: { code: string; message?: string } };

type LinkedReposResponse =
  | {
      type: "json";
      data: Array<{
        id: string;
        fullName: string;
        linkKeys: string[];
        installationId?: string;
      }>;
    }
  | { type: "error"; error: { code: string; message?: string } };

type InstallReposResponse =
  | {
      type: "json";
      data: Array<{ id: string; fullName: string; linkKeys: string[] }>;
    }
  | { type: "error"; error: { code: string; message?: string } };

type ErrorResponse = { type: "error"; error: { code: string; message?: string } };
type GitHubAppDb = FragnoDatabase<typeof githubAppSchema>;

describe("github-app repo linking routes", () => {
  it("links and unlinks repositories with the default link key", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "1",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "10",
        installationId: "1",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const linkResponse = (await fragments.githubApp.callRoute("POST", "/repositories/link", {
        body: { installationId: "1", repoId: "10" },
      })) as LinkResponse;

      expect(linkResponse.type).toBe("json");
      if (linkResponse.type !== "json") {
        throw new Error(`Expected json response, got ${linkResponse.type}`);
      }

      expect(linkResponse.data.link.linkKey).toBe("default");
      expect(linkResponse.data.repo.fullName).toBe("octo/repo");

      const linkedRepos = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/linked",
      )) as LinkedReposResponse;

      expect(linkedRepos.type).toBe("json");
      if (linkedRepos.type !== "json") {
        throw new Error(`Expected json response, got ${linkedRepos.type}`);
      }

      expect(linkedRepos.data).toHaveLength(1);
      expect(linkedRepos.data[0]?.linkKeys).toEqual(["default"]);

      const unlinkResponse = await fragments.githubApp.callRoute("POST", "/repositories/unlink", {
        body: { repoId: "10" },
      });

      expect(unlinkResponse).toMatchObject({ type: "json", data: { ok: true } });

      const linkedAfter = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/linked",
      )) as LinkedReposResponse;

      expect(linkedAfter.type).toBe("json");
      if (linkedAfter.type !== "json") {
        throw new Error(`Expected json response, got ${linkedAfter.type}`);
      }
      expect(linkedAfter.data).toHaveLength(0);
    } finally {
      await test.cleanup();
    }
  });

  it("uses the configured default link key when blank", async () => {
    const { fragments, test } = await buildHarness({
      ...createConfig(),
      defaultLinkKey: "alpha",
    });

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "1",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "10",
        installationId: "1",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const response = (await fragments.githubApp.callRoute("POST", "/repositories/link", {
        body: { installationId: "1", repoId: "10", linkKey: "  " },
      })) as LinkResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data.link.linkKey).toBe("alpha");
    } finally {
      await test.cleanup();
    }
  });

  it("trims link keys", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "1",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "10",
        installationId: "1",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const response = (await fragments.githubApp.callRoute("POST", "/repositories/link", {
        body: { installationId: "1", repoId: "10", linkKey: "  custom  " },
      })) as LinkResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data.link.linkKey).toBe("custom");
    } finally {
      await test.cleanup();
    }
  });

  it("returns installation ids from joined installations", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "9",
        accountId: "9",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "90",
        installationId: "9",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "repo_link", {
        repoId: "90",
        linkKey: "default",
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/linked",
      )) as LinkedReposResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data).toHaveLength(1);
      expect(response.data[0]?.installationId).toBe("9");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects installation repo queries when installation is missing", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/installations/:installationId/repos",
        { pathParams: { installationId: "missing" } },
      )) as InstallReposResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INSTALLATION_NOT_FOUND");
    } finally {
      await test.cleanup();
    }
  });

  it("includes unlinked repos when linkedOnly is false", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "5",
        accountId: "5",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "50",
        installationId: "5",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/installations/:installationId/repos",
        { pathParams: { installationId: "5" }, query: { linkedOnly: "false" } },
      )) as InstallReposResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data).toHaveLength(1);
      expect(response.data[0]?.linkKeys).toEqual([]);
    } finally {
      await test.cleanup();
    }
  });

  it("excludes removed repos from installation listings", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "6",
        accountId: "6",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "60",
        installationId: "6",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: new Date(),
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/installations/:installationId/repos",
        { pathParams: { installationId: "6" } },
      )) as InstallReposResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data).toHaveLength(0);
    } finally {
      await test.cleanup();
    }
  });

  it("does not include repos without links", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "3",
        accountId: "3",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "30",
        installationId: "3",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/linked",
      )) as LinkedReposResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data).toHaveLength(0);
    } finally {
      await test.cleanup();
    }
  });

  it("excludes removed repos from linked repository listings", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "7",
        accountId: "7",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "70",
        installationId: "7",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: new Date(),
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "repo_link", {
        repoId: "70",
        linkKey: "default",
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/linked",
      )) as LinkedReposResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data).toHaveLength(0);
    } finally {
      await test.cleanup();
    }
  });

  it("rejects unlink when installation join is missing", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "40",
        installationId: 999n,
        ownerLogin: "octo",
        name: "orphan",
        fullName: "octo/orphan",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "repo_link", {
        repoId: "40",
        linkKey: "default",
      });

      const response = (await fragments.githubApp.callRoute("POST", "/repositories/unlink", {
        body: { repoId: "40" },
      })) as { type: "error"; error: { code: string } };

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INSTALLATION_NOT_FOUND");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects link when installation is missing", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      const response = (await fragments.githubApp.callRoute("POST", "/repositories/link", {
        body: { installationId: "missing", repoId: "1" },
      })) as LinkResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INSTALLATION_NOT_FOUND");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects link when installation is inactive", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "8",
        accountId: "8",
        accountLogin: "octo",
        accountType: "User",
        status: "suspended",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "80",
        installationId: "8",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const response = (await fragments.githubApp.callRoute("POST", "/repositories/link", {
        body: { installationId: "8", repoId: "80" },
      })) as LinkResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INSTALLATION_INACTIVE");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects link when repository is missing", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "9",
        accountId: "9",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      const response = (await fragments.githubApp.callRoute("POST", "/repositories/link", {
        body: { installationId: "9", repoId: "missing" },
      })) as LinkResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("REPO_NOT_FOUND");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects link when repository is removed", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "10",
        accountId: "10",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "100",
        installationId: "10",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: new Date(),
      });

      const response = (await fragments.githubApp.callRoute("POST", "/repositories/link", {
        body: { installationId: "10", repoId: "100" },
      })) as LinkResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("REPO_REMOVED");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects unlink when repository is missing", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      const response = (await fragments.githubApp.callRoute("POST", "/repositories/unlink", {
        body: { repoId: "missing" },
      })) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("REPO_NOT_FOUND");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects unlink when installation is inactive", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "11",
        accountId: "11",
        accountLogin: "octo",
        accountType: "User",
        status: "suspended",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "110",
        installationId: "11",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "repo_link", {
        repoId: "110",
        linkKey: "default",
      });

      const response = (await fragments.githubApp.callRoute("POST", "/repositories/unlink", {
        body: { repoId: "110" },
      })) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INSTALLATION_INACTIVE");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects unlink when link does not exist", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "12",
        accountId: "12",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "120",
        installationId: "12",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const response = (await fragments.githubApp.callRoute("POST", "/repositories/unlink", {
        body: { repoId: "120" },
      })) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("LINK_NOT_FOUND");
    } finally {
      await test.cleanup();
    }
  });

  it("filters installation repos by link key", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "2",
        accountId: "2",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "20",
        installationId: "2",
        ownerLogin: "octo",
        name: "repo-alpha",
        fullName: "octo/repo-alpha",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "21",
        installationId: "2",
        ownerLogin: "octo",
        name: "repo-beta",
        fullName: "octo/repo-beta",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "repo_link", {
        repoId: "20",
        linkKey: "alpha",
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "repo_link", {
        repoId: "21",
        linkKey: "beta",
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/installations/:installationId/repos",
        {
          pathParams: { installationId: "2" },
          query: { linkedOnly: "true", linkKey: "alpha" },
        },
      )) as InstallReposResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data).toHaveLength(1);
      expect(response.data[0]?.fullName).toBe("octo/repo-alpha");
      expect(response.data[0]?.linkKeys).toEqual(["alpha"]);
    } finally {
      await test.cleanup();
    }
  });

  it("returns empty link arrays when no links exist", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "11",
        accountId: "11",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "110",
        installationId: "11",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const db = fragments.githubApp.db as GitHubAppDb;
      const repos = (
        await db
          .createUnitOfWork("read")
          .find("installation_repo", (b) =>
            b
              .whereIndex("idx_installation_repo_installation", (eb) =>
                eb("installationId", "=", "11"),
              )
              .join((jb) => jb.links()),
          )
          .executeRetrieve()
      )[0];

      expect(repos).toHaveLength(1);
      const [repo] = repos;
      if (!repo) {
        throw new Error("Expected repo result");
      }

      expect(normalizeJoinedLinks(repo.links)).toEqual([]);
    } finally {
      await test.cleanup();
    }
  });

  it("returns null installations when joins are missing", async () => {
    const { fragments, test } = await buildHarness(createConfig());

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
        id: "120",
        installationId: 999n,
        ownerLogin: "octo",
        name: "orphan",
        fullName: "octo/orphan",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const db = fragments.githubApp.db as GitHubAppDb;
      const repos = (
        await db
          .createUnitOfWork("read")
          .find("installation_repo", (b) =>
            b
              .whereIndex("idx_installation_repo_installation", (eb) =>
                eb("installationId", "=", 999n),
              )
              .join((jb) => jb.installation()),
          )
          .executeRetrieve()
      )[0];

      expect(repos).toHaveLength(1);
      const [repo] = repos;
      if (!repo) {
        throw new Error("Expected repo result");
      }

      expect(Boolean(repo.installation)).toBe(false);
      expect(normalizeJoinedInstallation(repo.installation)).toBeNull();
    } finally {
      await test.cleanup();
    }
  });
});
