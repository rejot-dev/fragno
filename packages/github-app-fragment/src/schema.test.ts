import { describe, expect, it } from "vitest";

import { githubAppSchema } from "./schema";

describe("githubAppSchema", () => {
  it("uses the expected schema name", () => {
    expect(githubAppSchema.name).toBe("github-app-fragment");
  });

  it("defines the expected tables", () => {
    expect(Object.keys(githubAppSchema.tables).sort()).toEqual(
      ["installation", "installation_repo", "repo_link"].sort(),
    );
  });

  it("assigns external ids and indexes", () => {
    const { installation, installation_repo, repo_link } = githubAppSchema.tables;

    expect(installation.getIdColumn().name).toBe("id");
    expect(installation_repo.getIdColumn().name).toBe("id");
    expect(repo_link.getIdColumn().name).toBe("id");

    expect(Object.keys(installation.indexes)).toEqual(
      expect.arrayContaining([
        "idx_installation_account_login",
        "idx_installation_status",
        "uniq_installation_id",
      ]),
    );

    expect(Object.keys(installation_repo.indexes)).toEqual(
      expect.arrayContaining([
        "idx_installation_repo_installation",
        "idx_installation_repo_full_name",
      ]),
    );

    expect(Object.keys(repo_link.indexes)).toEqual(
      expect.arrayContaining(["uniq_repo_link_repo_id_link_key"]),
    );
  });
});
