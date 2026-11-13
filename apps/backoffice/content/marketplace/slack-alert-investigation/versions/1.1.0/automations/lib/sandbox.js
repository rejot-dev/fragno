/// <reference path="/static/codemode/workflow-authoring.d.ts" />

export const SANDBOX_ID = "alert-investigation";

/** @param {string} value */
export function quote(value) {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** @param {string} command */
export async function run(command) {
  const result = await sandbox.executeCommand({
    sandboxId: SANDBOX_ID,
    command,
    timeoutMs: 120000,
  });
  if (!result.ok) {
    throw new Error("Investigation sandbox: " + result.reason + ": " + result.message);
  }
  return result.stdout;
}

/**
 * Clones the repository's main branch once per sandbox and checks out its current commit in a
 * folder of its own, so concurrent investigations never see each other's revision.
 * @param {{ repository: string, githubConnectionId: string }} settings
 */
export async function prepareRepository({ repository, githubConnectionId }) {
  const credential = /** @type {{ token: string }} */ (
    await integrations.execute({
      connectionId: githubConnectionId,
      actionId: "repository.access-token.create",
      input: {},
    })
  );
  if (!credential.token) {
    throw new Error("Repository clone credential unavailable");
  }
  const remote = "https://github.com/" + repository + ".git";
  const repoPath = "/workspace/repos/" + repository;
  const header = "AUTHORIZATION: basic " + btoa("x-access-token:" + credential.token);
  // The credential lives only in the command's environment, never in the remote URL, git config or
  // filesystem.
  const command =
    "set -eu; set +x; mkdir -p " +
    quote(repoPath) +
    "; exec 9>" +
    quote(repoPath + ".lock") +
    "; flock -w 110 9; " +
    "export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader GIT_CONFIG_VALUE_0=" +
    quote(header) +
    "; " +
    "if [ ! -d " +
    quote(repoPath + "/.git") +
    " ]; then git clone --depth 1 --no-checkout --single-branch --branch main " +
    quote(remote) +
    " " +
    quote(repoPath) +
    ' >/dev/null 2>&1 || { echo "Clone failed" >&2; exit 1; }; fi; ' +
    "cd " +
    quote(repoPath) +
    '; test "$(git remote get-url origin)" = ' +
    quote(remote) +
    "; " +
    'git fetch --depth 1 --no-tags origin +refs/heads/main:refs/remotes/origin/main >/dev/null 2>&1 || { echo "Fetch main failed" >&2; exit 1; }; ' +
    "unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0; " +
    "git update-ref refs/heads/main refs/remotes/origin/main; sha=$(git rev-parse refs/heads/main); " +
    "target=/workspace/investigation-checkouts/$sha; mkdir -p /workspace/investigation-checkouts; " +
    'if [ ! -d "$target" ]; then git -c core.hooksPath=/dev/null worktree add --detach "$target" "$sha" >/dev/null 2>&1; fi; ' +
    'printf "%s\\n" "$sha"';
  const result = await sandbox.executeCommand({
    sandboxId: SANDBOX_ID,
    command,
    timeoutMs: 120000,
  });
  // Never pass on raw stderr from a command that carries the credential.
  if (!result.ok) {
    throw new Error(
      "Repository synchronization failed: " +
        result.reason +
        " (credential-bearing output withheld)",
    );
  }
  const commit = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Invalid synchronized main revision");
  }
  return {
    sandboxId: SANDBOX_ID,
    repository,
    repoPath,
    checkoutPath: "/workspace/investigation-checkouts/" + commit,
    commit,
    branch: "main",
    deploymentVerified: false,
  };
}
