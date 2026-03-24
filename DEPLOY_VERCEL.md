# Vercel Deploy Guide

This project is prepared for a clean Vercel deploy as:

- Project name: `geo-topai`
- Framework: `Vite`
- Build command: `npm run build`
- Output directory: `dist`

## What works on Vercel

- Main SPA frontend
- Read-only API routes such as:
  - `/api/projects`
  - `/api/projects/:id`
  - `/api/graph`
  - `/api/researchers`
  - `/api/researchers/quality`
  - `/api/export`
  - `/api/geo-space/payload`

## What is intentionally read-only on Vercel

These routes are disabled in the deployed site because the Vercel deployment uses a bundled SQLite file and does not persist writes between requests:

- `/api/sync-github`
- `/api/researchers/refresh`
- `/api/projects/:id/sync`
- `/api/discover`
- `/api/seed`
- `/api/geo-space/export`

Use the local app for sync, refresh, discovery, and file-writing exports.

## Before you deploy

1. Make sure these files exist at the project root:
   - `vercel.json`
   - `package.json`
   - `api/[...path].ts`
   - `geo.db`
2. Confirm local checks pass:
   - `npm run lint`
   - `npm run build`

## Deploy from the Vercel dashboard

1. Create a new project in Vercel.
2. Import this repository or upload this project folder.
3. Set the project name to `geo-topai`.
4. Set Framework Preset to `Vite`.
5. Set Root Directory to this project root.
6. Confirm Build Command is `npm run build`.
7. Confirm Output Directory is `dist`.
8. Deploy.

## If `geo-topai` is unavailable

Use one of these:

- `geo-top-ai`
- `geo-topai-app`
- `geo-ai-top`

## Recommended environment variables

Add these in Vercel only if you want external API-backed features available where possible:

- `GEMINI_API_KEY`
- `GITHUB_TOKEN`
- `OPENALEX_MAILTO`

## Post-deploy checks

After deployment, verify:

1. Home page opens.
2. `/api/projects` returns JSON.
3. `/api/export?table=projects_top200_structured&format=csv` downloads the top-200 export.
4. The Stats tab can export `Top 200 CSV`.

## Important note

If Vercel auto-detects the project as `Express`, change it back to `Vite` before deploying.
