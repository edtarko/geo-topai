# GEO Space Draft Checklist

Generated at: 2026-03-03T08:36:29.852Z

1. Edit CSV drafts in `editable/` (Person.csv, Paper.csv, Projects.csv) if needed.
2. Rebuild payload after edits:
   `npm run geo:payload -- --person-csv geo_space_payload/editable/Person.csv --paper-csv geo_space_payload/editable/Paper.csv --project-csv geo_space_payload/editable/Projects.csv`
3. Publish from this repo (dry-run):
   `npm run geo:publish -- --payload-dir geo_space_payload/data_to_publish`
4. Publish on-chain (real tx):
   `npm run geo:publish -- --payload-dir geo_space_payload/data_to_publish --publish 1`
5. Or copy `data_to_publish/topics.json`, `people.json`, `projects.json` into geo_tech_demo and run their scripts.
6. Verify entities in Geo Space before final publish action.
