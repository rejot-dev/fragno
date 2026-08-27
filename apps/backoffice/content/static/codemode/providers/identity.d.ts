// identity tools
type IdentityCodemodeProvider = {
  /** Resolve an active external identity binding so the workflow can choose its internal user. */
  resolveExternal(input: IdentityResolveExternalInput): Promise<IdentityResolveExternalOutput>;
};
declare const identity: IdentityCodemodeProvider;

type IdentityResolveExternalInput = {
  source: string;
  type: string;
  id: string;
};
type IdentityResolveExternalOutput = {
  userId: string;
} | null;
