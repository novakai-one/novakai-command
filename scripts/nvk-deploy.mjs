#!/usr/bin/env node
// scripts/nvk-deploy.mjs — compatibility shim. The deploy pipeline lives in
// scripts/deploy/ (contract/ core/ cli/ per SOP-Repo-Folder-Structure); this
// path stays because `nvk deploy` and operator muscle memory invoke it.
import './deploy/cli/nvk-deploy.mjs';
