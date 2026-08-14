export const EXTENSION_NAME = "wipstream";

export const CONFIG_VERSION = "1";

export const CONFIG_KEYS = {
  version: "wipstream.version",
  remote: "wipstream.remote",
  mainBranch: "wipstream.mainBranch",
  featureBranch: "wipstream.featureBranch",
  wipBranch: "wipstream.wipBranch",
  lastKnownRemoteWip: "wipstream.lastKnownRemoteWip",
} as const;
