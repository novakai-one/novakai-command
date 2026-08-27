# Desktop app (Mac)

A thin Electron shell (`desktop/main.cjs`) that gives Novakai Command a standalone
Dock app. It is a **window onto the live server on :5180 — nothing more**. It never
starts, restarts, or stops a server.

## Who runs the server

- Only `nvk deploy` puts a server on :5180: it builds, snapshots the checkout into
  `~/.novakai-releases/<ts>-<commit>-<rand>/`, stamps it (`release.json`, served at
  `/version`), and swaps the launchd job `com.novakai.prod` onto the new release.
  A candidate that fails during stop, launch, or health is rolled back to the
  last good release. On the first migration, the pre-deploy launchd job is
  preserved and restored instead.
- The server on :5180 is always a frozen release — `nvk-server` refuses :5180 from
  an unstamped checkout. Dev/scratch boots use `--port 0`.
- `nvk deploy status` — what is running vs what the checkout has, launchd state,
  ghosts. `nvk deploy --scratch --hold` — boot the exact artifact on a throwaway
  port + data root for inspection; the live server is untouched.

## What the window does

- On launch it probes `http://127.0.0.1:5180/version` and requires a **stamped
  release**. If one answers, it attaches.
- Nothing on the port → splash saying to run `nvk deploy`, then it keeps watching
  and attaches the moment a stamped release serves 5180.
- An **unstamped** nvk-server on the port (dev boot, pre-deploy serve) → splash
  naming it, and the window waits for a real deploy to replace it.
- A **foreign** listener (not nvk-server) → fail-loud splash; the conflicting
  process is recorded in `~/Library/Logs/NovakaiCommand.log`.
- During a deploy the page's WebSocket drops; the shell then polls
  `/bootstrap.json` and reloads itself when the new release answers — an open
  window recovers on its own.
- Quitting the app tears down nothing: it owns no server process.

## Commands

- `npm run app` — run the shell directly (dev/testing the shell itself).
- `npm run app:build` — package `release/mac-arm64/Novakai Command.app` (unsigned,
  local use). Copy it to `/Applications`. Rebuild only when `desktop/` changes.
