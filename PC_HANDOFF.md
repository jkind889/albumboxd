# Rescened: Mac to PC handoff

This file is the durable handoff for continuing Rescened on a Windows PC. Keep it updated when the active branch, project status, setup, or next milestone changes.

## Current snapshot

Last verified: **August 18, 2026**

- App name: **Rescened**
- GitHub repository: `https://github.com/jkind889/albumboxd.git`
- Active branch: `community-driven`
- Verified commit: `556aee1` — `implementing top 500 albums fetch from musicbrainz`
- At the time of this snapshot, `community-driven` was clean and synchronized with `origin/community-driven`.
- The repository and remote are still named `albumboxd`; the package and product are named `rescened`. Clone the `albumboxd` URL above.
- Backend: Express, Mongoose, MongoDB, and Clerk in the repository root.
- Frontend: React, Vite, and Clerk in `frontend/`.
- Package manager: npm. The backend and frontend are separate npm packages and each has its own lockfile.
- Mac environment used for the latest verification: Node `22.21.0` and npm `10.9.4`.

Refresh the snapshot before switching machines:

```sh
git fetch origin
git status --short --branch
git log -1 --oneline
```

## Project status and next work

Recent work completed on `community-driven`:

1. Removed Spotify as the catalog provider outside profile-link behavior.
2. Implemented contributor album submissions.
3. Implemented moderation commands and transactional approval.
4. Added the ListenBrainz/MusicBrainz catalog fetch, validation, and import pipeline.
5. Checked in a validated 500-album seed at `data/catalog-import/seeds/listenbrainz-2026-08-14.json`.

The likely next milestone is **Phase 3 community-submission UI**:

- Contributor submission screens.
- Moderator queue and moderation screens.
- Optional public feed for approved submissions.

Before starting that milestone, finish the catalog rollout described in `docs/CATALOG_IMPORT.md`: dry-run the checked-in seed against development/staging, apply it, and smoke-test listing, search, album detail, reviews, likes, and board saves. The README notes that the database was intentionally emptied during the generation-2 cutover, so a fresh database will not show useful catalog content until it is seeded or imported.

Source-of-truth project docs:

- `README.md`
- `docs/CATALOG_IMPORT.md`
- `docs/PHASE_2_SUBMISSIONS.md`

## Recommended PC setup: WSL2

WSL2 is the least-friction option because the existing integration and live-test npm scripts use POSIX-style environment-variable assignment. It also keeps the development shell close to the Mac/Linux environment in which the project has been tested.

From an elevated PowerShell window:

```powershell
wsl --install
```

Restart if Windows asks, open Ubuntu/WSL, and install Git plus **Node 22 LTS**. The effective minimum for the locked dependencies is Node `20.19.0`; Node `22.12.0` or newer is recommended.

Keep the repository in the WSL Linux filesystem for better performance:

```sh
mkdir -p ~/code
cd ~/code
git clone https://github.com/jkind889/albumboxd.git
cd albumboxd
git switch community-driven
git pull --ff-only
npm ci
cd frontend
npm ci
cd ..
```

Do not copy either Mac `node_modules` directory to the PC. `npm ci` installs the correct platform-specific packages from the two lockfiles.

### Native PowerShell alternative

The normal development, unit-test, build, and lint commands work natively in PowerShell. Install Git, Node, the ChatGPT desktop app, and optionally GitHub CLI:

```powershell
winget install --id Git.Git
winget install --id OpenJS.NodeJS.LTS
winget install --id 9PLM9XGG6VKS -s msstore
winget install --id GitHub.cli
```

Then clone and install both packages:

```powershell
New-Item -ItemType Directory -Force $HOME\code | Out-Null
Set-Location $HOME\code
git -c core.autocrlf=false clone https://github.com/jkind889/albumboxd.git
Set-Location albumboxd
git switch community-driven
git config core.autocrlf false
npm ci
Set-Location frontend
npm ci
Set-Location ..
```

`core.autocrlf false` keeps the checked-in JSON seed byte-for-byte consistent with its SHA-256 checksum. If the PC is Windows on ARM, prefer WSL2 or x64 Node emulation for the MongoDB in-memory integration tests.

## Recreate local environment files securely

The Mac has ignored `.env` files that are **not in Git**. Retrieve the values from the Clerk and MongoDB dashboards or a password manager. Do not commit the files, paste their values into this handoff, or copy Codex authentication files between computers.

Create `.env` in the repository root:

```dotenv
MONGO_URI=<development MongoDB connection string>
CLERK_SECRET_KEY=<Clerk secret key>
CLERK_PUBLISHABLE_KEY=<Clerk publishable key>

# Optional local feature flags
COMMUNITY_SUBMISSIONS_ENABLED=true
COMMUNITY_MODERATION_ENABLED=true
MODERATOR_USER_IDS=<comma-separated Clerk user IDs>

# Optional server settings
CORS_ALLOWED_ORIGINS=http://localhost:5173
TRUST_PROXY_HOPS=0
PORT=3000
```

Create `frontend/.env` separately; Vite does not read the root `.env`:

```dotenv
VITE_CLERK_PUBLISHABLE_KEY=<same Clerk publishable key>
VITE_API_URL=http://localhost:3000
```

Use a transaction-capable MongoDB replica set or sharded deployment for moderation approval and catalog `--apply`. MongoDB Atlas is the simplest external option. A standalone MongoDB server is sufficient for many reads but not those transactional writes.

## Run locally

Open two WSL shells or PowerShell windows.

Backend, from the repository root:

```sh
npm run devStart
```

Frontend, from `frontend/`:

```sh
npm run dev
```

Expected local addresses:

- Frontend: `http://localhost:5173`
- API: `http://localhost:3000`
- Health check: `http://localhost:3000/health`

The API may start even when MongoDB cannot connect. Confirm that the health response reports `status: "ok"`, not `degraded`.

## Verify the checkout

From the repository root in WSL or Git Bash:

```sh
npm test
npm run test:integration
npm run check:catalog-contract
npm --prefix frontend run lint
npm --prefix frontend run build
```

Latest Mac results:

- Unit suite: 83 passed; 10 network/integration cases intentionally skipped by the default run.
- Replica-set integration suite: all 9 passed.
- Catalog contract: passed.
- Frontend lint and production build: passed.

`mongodb-memory-server` may download a MongoDB binary during `npm ci` or the first integration run, so that step needs network access and can be affected by a proxy or antivirus.

### PowerShell-only test equivalents

Two package scripts use syntax that PowerShell does not understand. Run their underlying commands this way:

```powershell
$env:RUN_MONGO_INTEGRATION = "true"
node --test tests/moderation.integration.test.js tests/catalogImport.integration.test.js
Remove-Item Env:RUN_MONGO_INTEGRATION

$env:RUN_LIVE_CATALOG_FETCH = "true"
node --test tests/listenBrainzCatalog.live.test.js
Remove-Item Env:RUN_LIVE_CATALOG_FETCH
```

The live provider test is optional and makes network requests. Normal tests use checked-in fixtures.

## Catalog bootstrap on the PC

The checked-in dataset can be validated and imported without fetching a new one:

```sh
npm run catalog:validate -- --input data/catalog-import/seeds/listenbrainz-2026-08-14.json
npm run catalog:import -- --input data/catalog-import/seeds/listenbrainz-2026-08-14.json --dry-run
npm run catalog:import -- --input data/catalog-import/seeds/listenbrainz-2026-08-14.json --apply
```

`--apply` writes to the database selected by `MONGO_URI`; inspect the dry-run output first. For quick disposable UI data, `npm run seed:social` adds a small demo dataset instead.

In native PowerShell, an inline environment value must be set separately:

```powershell
$env:MONGO_URI = "<connection string>"
npm run catalog:import -- --input data/catalog-import/seeds/listenbrainz-2026-08-14.json --dry-run
Remove-Item Env:MONGO_URI
```

## Keep Mac and PC context together

Use two layers:

1. **GitHub is the durable source of truth** for code, branch history, this handoff, and project documentation.
2. **Codex chat handoff** can move the current chat and its Git state between connected Mac and Windows hosts.

For Codex chat handoff:

1. Install the latest ChatGPT desktop app on both machines and sign in to the same account and workspace.
2. Clone this repository on the PC and save the matching repository folder as a local project in the desktop app.
3. On each host, open **Settings > Connections**. Enable **Control this Mac or PC**, then pair the other desktop under **Control other devices**. Availability can vary by rollout.
4. Open the Codex chat to move. In the chat footer, select its current run location, select the destination PC, review the destination and branch, and choose **Hand off**.
5. The source host must be awake, online, and running the desktop app while the handoff is prepared.

Official references:

- [Hand off a chat between hosts](https://learn.chatgpt.com/docs/remote-connections#hand-off-a-chat-between-hosts)
- [ChatGPT desktop app for Windows](https://learn.chatgpt.com/docs/windows/windows-app)
- [Codex with WSL2](https://learn.chatgpt.com/docs/windows/wsl)

Do not assume every local task or uncommitted file automatically appears on the other computer. Use explicit chat handoff for an active Codex task, or push the branch and begin a new task on the other machine using this file.

If chat handoff is unavailable, start a Codex task from the PC repository and use:

> Read `PC_HANDOFF.md`, `README.md`, `docs/CATALOG_IMPORT.md`, and `docs/PHASE_2_SUBMISSIONS.md`. Confirm the current branch and Git status, run the relevant verification commands, then help me continue the Phase 3 Rescened work without changing unrelated files.

## Safe routine when switching machines

Before leaving either machine:

```sh
git status
git add <intentional files>
git commit -m "<clear summary>"
git push origin community-driven
```

On the other machine:

```sh
git switch community-driven
git pull --ff-only
git status
```

Avoid making independent unpushed changes to the same branch on both computers. If both machines need active work at the same time, create a separate feature branch on one of them and merge through GitHub.

## Deployment reminder

`vercel.json` builds and serves only the Vite frontend. The Express API, MongoDB, and Clerk server settings must be hosted/configured separately. `VITE_API_URL` is the frontend's API target; no production API URL is committed to this repository.
