/** Identifies one disposable local Graft cache and the durable fleet control log it clones. */
export type GraftNodeRuntimeStorage = {
  configPath: string;
  controlRemoteLogId: string;
};
