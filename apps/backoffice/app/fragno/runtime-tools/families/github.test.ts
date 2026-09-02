import { assert, describe, expect, test, vi } from "vitest";

import { parseCliTokens } from "../bash-cli";
import { createTrustedSystemBackofficeToolContext } from "../runtime-tools";
import { githubRuntimeTools } from "./github";

const repositories = [
  {
    id: "123456",
    installationId: "789",
    ownerLogin: "fragno-dev",
    name: "fragno",
    fullName: "fragno-dev/fragno",
    isPrivate: true,
    defaultBranch: "main",
    linkKeys: ["default"],
  },
];

describe("GitHub runtime tools", () => {
  test("lists connected repositories and their ids", async () => {
    const listRepositories = vi.fn().mockResolvedValue(repositories);
    const tool = githubRuntimeTools[0];
    assert(tool.id === "github.repositories.list");

    const input = tool.inputSchema.parse(tool.adapters!.bash!.parse(["--link-key", "default"]));
    const result = await tool.execute(
      input,
      createTrustedSystemBackofficeToolContext({
        runtimes: {
          github: {
            listRepositories,
            createRepositoryAccessToken: vi.fn(),
          },
        },
      }),
    );

    expect(listRepositories).toHaveBeenCalledWith({ linkKey: "default" });
    expect(result).toEqual(repositories);
  });

  test("honors token print selectors and explicit output formats", () => {
    const tool = githubRuntimeTools[1];
    assert(tool.id === "github.repositories.create-access-token");
    const bash = tool.adapters!.bash!;
    const tokenResult = {
      token: "ghs_secret",
      expiresAt: "2026-09-02T11:00:00Z",
      repository: { id: "123456", fullName: "fragno-dev/fragno" },
    };

    const printArgs = parseCliTokens(["--print", "token"]);
    const printOptions = bash.outputOptions!(["--print", "token"], printArgs);
    expect(printOptions).toEqual({ format: "text", print: "token" });
    expect(bash.format!(tokenResult, printOptions)).toEqual({ data: tokenResult });

    const textArgs = parseCliTokens(["--format", "text"]);
    expect(bash.format!(tokenResult, bash.outputOptions!(["--format", "text"], textArgs))).toEqual({
      stdout:
        "token: ghs_secret\n" +
        "expires at: 2026-09-02T11:00:00Z\n" +
        "repository: fragno-dev/fragno (123456)\n",
    });

    const defaultArgs = parseCliTokens([]);
    expect(bash.outputOptions!([], defaultArgs)).toEqual({ format: "json" });
  });

  test("formats repository listings as readable text by default and JSON on request", () => {
    const tool = githubRuntimeTools[0];
    assert(tool.id === "github.repositories.list");
    const bash = tool.adapters!.bash!;

    const textArgs = parseCliTokens([]);
    const text = bash.format!(repositories, bash.outputOptions!([], textArgs));
    expect(text).toEqual({
      stdout:
        "ID      REPOSITORY         VISIBILITY  DEFAULT BRANCH  LINK KEYS\n" +
        "123456  fragno-dev/fragno  private     main            default\n",
    });

    const jsonArgs = parseCliTokens(["--format", "json"]);
    const json = bash.format!(repositories, bash.outputOptions!(["--format", "json"], jsonArgs));
    expect(json).toEqual({ data: repositories });
  });
});
