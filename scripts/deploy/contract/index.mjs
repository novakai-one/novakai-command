// deploy/contract/index.mjs — controlled exports. This file is the ONLY legal
// import surface for anything outside scripts/deploy/; reaching into core/ is
// a violation (SOP-Repo-Folder-Structure).
export { deploy, dryRun, scratch, status } from './api.mjs';
export { DeployError } from './types.mjs';
