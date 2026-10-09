# MPI Paper Inventory

Paper roll inventory for MPI Print & Packaging: receive, label, allocate, use and return rolls, with stock totals, usage, plant dockets and a handheld scanner view.

No outside packages. Runs on Node 22 using its built-in SQLite. The database is a single file in `DATA_DIR`.

## Deploy on Render (about 15 minutes)

1. Put this folder in a GitHub repository (for example `mpi-inventory`), the same way as the scheduler.
2. In Render, choose **New → Blueprint**, pick the repository. Render reads `render.yaml` and creates:
   - a **web service** `mpi-inventory` (Starter plan),
   - a **1 GB disk** mounted at `/var/data` (keeps the data through restarts and redeploys).
3. When asked, type the **APP_PASSWORD**: the one company password staff will use to sign in.
   (`SESSION_SECRET` is generated automatically.)
4. After the first deploy, the app is at `https://mpi-inventory.onrender.com` (or the name you chose).

Doing it by hand instead of the Blueprint: New → Web Service → Node, start command `node server.js`,
environment `NODE_VERSION=22`, `DATA_DIR=/var/data`, `APP_PASSWORD=…`, `SESSION_SECRET=<long random text>`,
then add a Disk at `/var/data`. A disk needs a paid instance; on the free plan the data is lost on every restart.

## First use

1. Open the link, type your name and the company password.
2. Optional: **Paper types → Backup & data import → Load backup file** and choose
   `mpi-inventory-backup.json` to bring across the data from the Claude version (it includes some test rolls).
3. Scanners and phones: open `https://<your-app>.onrender.com/#scanner`, sign in once, Add to Home Screen.

## Day to day

- **Change the company password:** Render → Environment → `APP_PASSWORD` → Save. Everyone signs in again.
- **Backups:** Paper types → **Download backup** (weekly). Render disks also have daily snapshots.
- **Update the app:** replace `public/index.html` (or any file) in GitHub; Render redeploys automatically. Data is kept.

## API (for reference)

All under `/api`, signed-in cookie required: `GET /api/{papers|rolls|dockets}`, `GET|PUT|PATCH|DELETE /api/{col}/{id}`,
`GET /api/events` (live updates), `GET /api/backup`, `POST /api/import`. `POST /api/login {password}`, `POST /api/logout`.
