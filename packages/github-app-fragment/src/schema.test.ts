import { describe, expect, it, assert } from "vitest";

import { githubAppSchema } from "./schema";

describe("githubAppSchema", () => {
  it("uses the expected schema name", () => {
    assert(githubAppSchema.name === "github-app-fragment");
  });

  it("defines the expected tables", () => {
    expect(Object.keys(githubAppSchema.tables).sort()).toEqual(
      ["installation", "installation_repo", "oauth_state", "repo_link"].sort(),
    );
  });

  it("assigns external ids and indexes", () => {
    const { installation, installation_repo, oauth_state, repo_link } = githubAppSchema.tables;

    assert(installation.getIdColumn().name === "id");
    assert(oauth_state.getIdColumn().name === "id");
    assert(installation_repo.getIdColumn().name === "id");
    assert(repo_link.getIdColumn().name === "id");

    expect(Object.keys(installation.indexes)).toEqual(
      expect.arrayContaining([
        "idx_installation_account_login",
        "idx_installation_status",
        "uniq_installation_id",
      ]),
    );

    expect(Object.keys(oauth_state.indexes)).toEqual(
      expect.arrayContaining([
        "idx_oauth_state_subject",
        "idx_oauth_state_expires",
        "uniq_oauth_state",
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
