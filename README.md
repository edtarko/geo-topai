<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/3c2bee4f-2835-4d8c-929c-13798005cc7e

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Configure environment variables in `.env` (see `.env.example`):
   - `GEMINI_API_KEY`
   - `GITHUB_TOKEN` (+ optional token pool: `GITHUB_TOKEN_2`, `GITHUB_TOKEN_3`, `GITHUB_TOKENS`)
   - `OPENALEX_MAILTO` (recommended)
3. Run the app:
   `npm run dev`

## Integrated APIs

- GitHub REST API (repo metadata, releases, tags, rate limits)
- GitHub GraphQL API (topics, maintainers, richer repo fields)
- OpenAlex API (researcher enrichment: citation/h-index/affiliations)
- PyPI API (Python dependency hints)
- npm Registry API (JavaScript dependency hints)
- Hugging Face API (model likes/downloads)

## Insights API Endpoints

- `GET /api/insights/status`:
  - ecosystem health snapshot
  - metadata coverage score
  - project/researcher recency signals
  - API token pool status (anonymous + sampled authenticated tokens)
- `GET /api/export/options`:
  - available tables/formats
- `GET /api/export?table=...&format=csv|tsv|json`:
  - export-ready datasets for spreadsheets and pipelines
- `GET /api/geo-space/payload?maxProjects=1000&maxPeople=2000&projectCsvPath=...`:
  - builds GEO-ready payload from live SQLite + optional Person/Paper/Projects CSV
- `POST /api/geo-space/export`:
  - writes `topics.json`, `people.json`, `projects.json`, `papers.json`, `manifest.json`
  - writes editable sheets (`Person.csv`, `Paper.csv`, `Projects.csv`)
  - writes `data_to_publish/` + `editable/` draft layout for pre-publish review

## Multi-Token Strategy

For high-volume sync, configure several GitHub tokens. The backend automatically deduplicates and rotates tokens across requests to reduce rate-limit pressure.

## X Profile Resolution

Researcher X handles are resolved in multiple stages:
- existing dataset values (`twitter_handle` / `x_url`)
- OpenAlex enrichment
- website/scholar page discovery
- GitHub profile candidate matching

For exact manual control, use:
- `public/researcher_x_overrides.csv`
- columns: `id,name,twitter_handle,x_url`

## GEO Space Export

Generate a GEO Space payload locally:

```bash
npm run geo:payload -- --max-projects 1000 --max-people 2000
```

Rebuild from edited draft sheets:

```bash
npm run geo:payload -- \
  --person-csv geo_space_payload/editable/Person.csv \
  --paper-csv geo_space_payload/editable/Paper.csv \
  --project-csv geo_space_payload/editable/Projects.csv
```

Default output folder:
- `geo_space_payload/topics.json`
- `geo_space_payload/people.json`
- `geo_space_payload/projects.json`
- `geo_space_payload/papers.json`
- `geo_space_payload/manifest.json`
- `geo_space_payload/Person.csv`
- `geo_space_payload/Paper.csv`
- `geo_space_payload/Projects.csv`
- `geo_space_payload/data_to_publish/` (ready for geo_tech_demo scripts)
- `geo_space_payload/editable/` (draft CSVs for manual edits)
- `geo_space_payload/PUBLISH_CHECKLIST.md`

This format is designed to plug into the `data_to_publish` flow used by the Geo tech demo scripts (`create_topics.js`, `create_people.js`, `create_projects.js`).

## GEO Space Publish (SDK Guide Aligned)

The project now includes a publish runner aligned with this guide:
- [Geo Protocol SDK Guide](https://github.com/GunahkarCasper/Geo_Protocol_SDK_Guide)

Install required SDK deps (once):

```bash
npm install @geoprotocol/geo-sdk viem ox
```

Dry-run publish from your edited draft payload:

```bash
npm run geo:publish -- --payload-dir geo_space_payload/data_to_publish
```

One-command test (preconfigured dry-run):

```bash
npm run geo:test
```

Network dry-run (IPFS + SDK flow, no on-chain tx):

```bash
npm run geo:test:net
```

If RPC endpoint is unstable, run IPFS dry-run without RPC checks:

```bash
npm run geo:test:ipfs
```

Real publish (broadcast tx):

```bash
npm run geo:publish -- --payload-dir geo_space_payload/data_to_publish --publish 1
```

Notes:
- Default mode is dry-run (safe preview).
- If your Personal Space is not registered yet, run once with `--publish 1`.
- You can override space manually with `--space-id <id>`.
