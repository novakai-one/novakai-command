# The EXE Template — Desktop Shell & Packaging

How Novakai apps ship as desktop executables. Two implementations exist:
the original in **Novakai Command** (`desktop/`) and the reuse in
**Novakai HQ** (`novakai-docs`, `electron/`).

Sources: `.novakai/work/exe-survey-core.md` (survey A) and
`.novakai/work/exe-survey-hq.md` (survey B), 2026-07-20. Those files hold the
fine detail; this doc is the stable reference.

## The pattern

**Electron is a thin shell.** The window loads the app over HTTP from
`localhost`; product logic never runs inside Electron's main process.

- The window points at a URL served by a real Node server (system Node or
  in-process, depending on implementation).
- External links are intercepted and routed to the OS browser.
- Packaging is `electron-builder` with output to `release/`.

## Novakai Command (`desktop/`)

**Runtime** (`desktop/main.cjs`, CommonJS):

1. `probe()` GET `127.0.0.1:3030` — if something answers (manual dev server or
   launchd-started prod), the shell **attaches** to it. Dev wins.
2. Otherwise it spawns `npm run prod` (= `node tools/deploy.mjs serve`) via a
   login shell, detached, logging to `~/Library/Logs/NovakaiCommand.log`.
3. Polls up to 90 s with a `data:` splash, then loads the URL.

Recovery: `did-fail-load` / `render-process-gone` / server exit all trigger
re-recovery; quit tree-kills the spawned server.

**Build/package:**

- `npm run app` — run the shell against local dev.
- `npm run app:build` — `electron-builder --mac --config electron-builder.yml`.
  `appId com.novakai.command`, packages only `desktop/`, target `dir`
  (unpacked `.app`, no dmg), **unsigned** (`identity: null`).

**Deploy supervisor** (`tools/deploy.mjs`): `snapshot` (git archive → build
inside snapshot → atomic `current.json` flip, keep 5), `serve` (fail-loud on
port conflicts, crash-respawn backoff, SIGHUP = live snapshot swap),
`redeploy`. Dep-skew guard: refuses to boot if snapshot lockfile hash ≠
workspace lockfile hash.

**launchd** (`scripts/com.novakai.prod.plist`, `RunAtLoad` + `KeepAlive`):
`com.novakai.prod` keeps the pinned-snapshot backend alive. (Agent-liveness
monitoring moved in-app: `src/backend/terminal/seatWatch`, D-N5-6 — the old
`com.novakai.watchdog` plist was deleted in N5.)

## Novakai HQ (`novakai-docs`, `electron/`)

Reuse is architectural, not a line copy. Key differences:

| Area | Command template | HQ |
|---|---|---|
| Main process | `desktop/main.cjs` (CommonJS) | `electron/main.ts` → esbuild → `dist-electron/main.cjs` |
| Web runtime | Attaches to / spawns external server on port 3030 | In-process HTTP server on ephemeral port, serves `dist/` + API middleware |
| Needs the repo? | Yes — hardcoded path, override `NOVAKAI_REPO` | No — UI + middleware inside `app.asar` |
| Packaging | Unpacked `dir` | `dmg` + `zip` (134 MB each in `release/`) |
| Window | 1512×945 | Persisted bounds, single-instance lock, `contextIsolation`/`sandbox` on |

Commands: `npm run desktop` (build + run), `desktop:dev` (HMR),
`dist:mac` (package), `build:electron` (bundle main only).

## Known gaps (both implementations)

**Command template:**
- Hardcoded absolute repo path baked into the packaged shell and both plists
  — not portable without `NOVAKAI_REPO`.
- Two uncoordinated ways prod comes up (launchd vs shell-spawned); collision
  caught only reactively by `serve`'s port check.
- `npm start` (`node dist/index.js`) appears vestigial — nothing builds that.
- Unsigned, `dir`-only target; distribution needs signing/notarization.

**HQ:**
- **Packaged app reads its data from `~/Library/Application Support/Novakai HQ/data/`
  but the package neither contains nor seeds `data/`** — a clean install gets
  empty stores, and the API treats a missing store as a valid empty one, so
  the Board renders nothing without an error. This is the root cause of
  "tasks don't show in the desktop app" (see `task_hq-desktop-tasks-not-showing`).
- `saveHQStore()` doesn't `mkdir` the parent — first writes on a fresh
  install fail with ENOENT, collapsed to HTTP 400.
- The local machine masks both gaps via a symlink in Application Support that
  isn't in the package.
- The packaged-data fix is uncommitted; the shipped DMG/ZIP contain behavior
  not reproducible from committed HEAD.
- Default Electron icon, no signing/notarization config.

## Template guidance for the next app

1. Copy the **pattern**, not the files: thin shell, HTTP-loaded UI,
   electron-builder to `release/`.
2. Prefer HQ's in-process server (no external repo dependency) for anything
   meant to leave this machine.
3. Seed or migrate data stores on first run — a packaged app must not depend
   on the development checkout's files.
4. Decide signing/distribution up front if the artifact leaves the building.
