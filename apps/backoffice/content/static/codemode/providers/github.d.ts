// github tools
type GithubCodemodeProvider = {
  /** List GitHub repositories connected to the current organization and their ids. */
  listRepositories(input: GithubListRepositoriesInput): Promise<GithubListRepositoriesOutput>;
  /** Create a repository-scoped, read-only GitHub App installation token for cloning a linked repository. The token expires after one hour. */
  createRepositoryAccessToken(
    input: GithubCreateRepositoryAccessTokenInput,
  ): Promise<GithubCreateRepositoryAccessTokenOutput>;
};
declare const github: GithubCodemodeProvider;

type GithubListRepositoriesInput = {
  linkKey?: string;
};
type GithubListRepositoriesOutput = {
  id: string;
  installationId: string;
  ownerLogin: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string | null;
  linkKeys: string[];
}[];
type GithubCreateRepositoryAccessTokenInput = {
  repoId: string;
  linkKey?: string;
};
type GithubCreateRepositoryAccessTokenOutput = {
  token: string;
  expiresAt: string;
  repository: {
    id: string;
    fullName: string;
  };
};
