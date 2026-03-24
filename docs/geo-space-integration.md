# Geo Space Integration Guide

This project now supports direct payload generation for GEO publishing workflows.

## 1) Refresh your local data first

```bash
npm run start
# then call sync endpoints from UI or API
```

Recommended refresh before export:
- `POST /api/sync-github`
- `POST /api/researchers/refresh?full=1`

## 2) Generate GEO payload files

### Option A: CLI (recommended)

```bash
npm run geo:payload -- --max-projects 1000 --max-people 2000
```

### Option B: API endpoint

```bash
curl -X POST http://localhost:3000/api/geo-space/export \
  -H "Content-Type: application/json" \
  -d '{"maxProjects":1000,"maxPeople":2000,"outDir":"geo_space_payload","writeDemoLayout":true}'
```

## 3) Output files

Generated in `geo_space_payload/`:
- `topics.json`
- `people.json`
- `projects.json`
- `papers.json`
- `manifest.json`
- `Person.csv`
- `Paper.csv`
- `Projects.csv`
- `data_to_publish/` (ready JSON payload for geo_tech_demo)
- `editable/` (`Person.csv`, `Paper.csv`, `Projects.csv` for draft edits)
- `PUBLISH_CHECKLIST.md`

## 4) Edit draft before publish

1. Edit files in `geo_space_payload/editable/`.
2. Regenerate JSON payload from edited CSV:

```bash
npm run geo:payload -- \
  --person-csv geo_space_payload/editable/Person.csv \
  --paper-csv geo_space_payload/editable/Paper.csv \
  --project-csv geo_space_payload/editable/Projects.csv \
  --out geo_space_payload
```

## 5) Publish to GEO Space

Use these files with the GEO tech demo publishing flow (the scripts typically read from `data_to_publish/`):
- `create_topics.js`
- `create_people.js`
- `create_projects.js`

Typical flow:
1. Copy `geo_space_payload/data_to_publish/topics.json`, `people.json`, `projects.json` into the demo `data_to_publish/` folder.
2. Configure your demo `.env` (`PRIVATE_KEY`, `DEMO_SPACE_ID`, and network/graph settings as required by that repo).
3. Run topic -> people -> projects scripts in that order.

Alternative: publish directly from this repo with SDK flow (aligned with [Geo_Protocol_SDK_Guide](https://github.com/GunahkarCasper/Geo_Protocol_SDK_Guide)):

```bash
npm install @geoprotocol/geo-sdk viem ox
npm run geo:publish -- --payload-dir geo_space_payload/data_to_publish
```

Broadcast transactions:

```bash
npm run geo:publish -- --payload-dir geo_space_payload/data_to_publish --publish 1
```

## 6) Data mapping

- `topics.json`: topic entities from both project tags and researcher topic areas.
- `people.json`: merged researcher + maintainer profiles, including X/website/scholar/openalex links and metrics.
- `projects.json`: ecosystem repositories with organization, maintainers, dependencies, release/freshness metadata, and markdown blocks.
- `papers.json`: publications from `Paper.csv` (or auto-derived from researcher notable contributions when CSV is missing).
