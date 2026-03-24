import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

type ProjectRow = {
  id: string;
  name: string;
  github_url: string;
  stars: number;
  license: string | null;
  language: string | null;
  category: string | null;
  first_release: string | null;
  latest_version: string | null;
  latest_release_date: string | null;
  repo_pushed_at: string | null;
  project_logo_url: string | null;
  is_maintained: number;
  org_id: string | null;
  org_name?: string | null;
  org_website?: string | null;
  description: string | null;
  last_updated?: string | null;
};

type PersonRow = {
  id: string;
  name: string;
  github_handle: string | null;
  avatar_url: string | null;
};

type ResearcherRow = Record<string, any>;

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "geo.db");
const OUT_DIR = path.join(ROOT, "public", "deploy-data");
const UI_LOCALE = "en-US";

const db = new Database(DB_PATH, { readonly: true });

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(name: string, value: unknown) {
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(value, null, 2));
}

function writeText(name: string, value: string) {
  fs.writeFileSync(path.join(OUT_DIR, name), value);
}

function writeDataset(name: string, rows: Record<string, any>[]) {
  writeJson(`${name}.json`, rows);
  writeText(`${name}.csv`, toDelimitedText(rows, ","));
  writeText(`${name}.tsv`, toDelimitedText(rows, "\t"));
}

function splitListString(value?: string | null) {
  if (!value) return [];
  return value
    .split(/[|;\n]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeExternalUrl(url?: string | null) {
  const trimmed = (url || "").trim();
  if (!trimmed) return "";
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).toString();
  } catch {
    return "";
  }
}

function fallbackAvatarUrl(name: string) {
  const seed = encodeURIComponent(name || "Researcher");
  return `https://api.dicebear.com/9.x/initials/svg?seed=${seed}&fontWeight=700&radius=16`;
}

function extractTwitterHandle(value?: string | null) {
  const raw = (value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).pathname.replace(/^\/+|\/+$/g, "").split("/")[0] || "";
    } catch {
      return "";
    }
  }
  return raw.replace(/^@/, "");
}

function toTwitterUrl(handle?: string | null) {
  const clean = extractTwitterHandle(handle);
  return clean ? `https://x.com/${clean}` : "";
}

function toDelimitedText(rows: Record<string, any>[], delimiter: "," | "\t" = ",") {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const raw = value === null || value === undefined ? "" : String(value);
    if (raw.includes('"')) return `"${raw.replace(/"/g, '""')}"`;
    if (raw.includes(delimiter) || raw.includes("\n")) return `"${raw}"`;
    return raw;
  };
  return [
    headers.join(delimiter),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(delimiter)),
  ].join("\n");
}

function buildProjectCoverageFields(projects: ProjectRow[]) {
  const fields = [
    { key: "description", label: "Description", test: (project: ProjectRow) => Boolean(project.description?.trim()) },
    { key: "language", label: "Language", test: (project: ProjectRow) => Boolean(project.language?.trim()) && project.language !== "Unknown" },
    { key: "license", label: "License", test: (project: ProjectRow) => Boolean(project.license?.trim()) },
    { key: "org_name", label: "Organization", test: (project: ProjectRow) => Boolean(project.org_name?.trim()) },
    { key: "first_release", label: "First Release", test: (project: ProjectRow) => Boolean(project.first_release?.trim()) },
    { key: "latest_version", label: "Latest Version", test: (project: ProjectRow) => Boolean(project.latest_version?.trim()) },
    { key: "latest_release_date", label: "Latest Release Date", test: (project: ProjectRow) => Boolean(project.latest_release_date?.trim()) },
    { key: "repo_pushed_at", label: "Repo Activity", test: (project: ProjectRow) => Boolean(project.repo_pushed_at?.trim()) },
  ];

  return fields.map((field) => {
    const filled = projects.filter(field.test).length;
    const coveragePercent = projects.length ? (filled / projects.length) * 100 : 0;
    return {
      key: field.key,
      label: field.label,
      filled,
      coveragePercent: Number(coveragePercent.toFixed(1)),
    };
  });
}

function buildInsightsStatus(projects: ProjectRow[], researchers: ResearcherRow[]) {
  const now = Date.now();
  const ageInDays = (value?: string | null) => {
    if (!value) return null;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return null;
    return Math.max(0, Math.floor((now - parsed) / (1000 * 60 * 60 * 24)));
  };

  const maintained = projects.filter((project) => project.is_maintained).length;
  const activityDays = projects.map((project) => ageInDays(project.repo_pushed_at));
  const recentlyActive30d = activityDays.filter((days) => days !== null && days <= 30).length;
  const recentlyActive90d = activityDays.filter((days) => days !== null && days <= 90).length;
  const staleOver365d = activityDays.filter((days) => days !== null && days > 365).length;
  const unknownActivity = activityDays.filter((days) => days === null).length;
  const latestRepoActivityAt = [...projects]
    .map((project) => project.repo_pushed_at)
    .filter(Boolean)
    .sort()
    .reverse()[0] || null;
  const lastSyncedAt = [...projects]
    .map((project) => project.last_updated)
    .filter(Boolean)
    .sort()
    .reverse()[0] || null;
  const coverageFields = buildProjectCoverageFields(projects);
  const missingMetaProjects = projects.filter((project) => (
    !project.first_release ||
    !project.repo_pushed_at ||
    !project.org_name ||
    project.org_name === "Community"
  )).length;
  const metadataCoverageScore = coverageFields.length
    ? coverageFields.reduce((sum, field) => sum + field.coveragePercent, 0) / coverageFields.length
    : 0;

  const lastVerifiedAt = [...researchers]
    .map((row) => row.last_verified_at)
    .filter(Boolean)
    .sort()
    .reverse()[0] || null;
  const lastEnrichedAt = [...researchers]
    .map((row) => row.last_enriched_at)
    .filter(Boolean)
    .sort()
    .reverse()[0] || null;

  return {
    generatedAt: new Date().toISOString(),
    projects: {
      total: projects.length,
      maintained,
      recentlyActive30d,
      recentlyActive90d,
      staleOver365d,
      unknownActivity,
      lastSyncedAt,
      latestRepoActivityAt,
    },
    researchers: {
      total: researchers.length,
      lastVerifiedAt,
      lastEnrichedAt,
    },
    coverage: {
      metadataCoverageScore: Number(metadataCoverageScore.toFixed(1)),
      missingMetaProjects,
      fields: coverageFields,
    },
    tokenPool: {
      configured: 0,
      sampled: 0,
      rateLimits: [],
    },
  };
}

function buildResearcherQualityStats(rows: ResearcherRow[]) {
  const fields = [
    { key: "name", label: "Name", get: (row: ResearcherRow) => row.name },
    { key: "avatar_url", label: "Avatar", get: (row: ResearcherRow) => row.avatar_url },
    { key: "current_affiliation_name", label: "Current Affiliation", get: (row: ResearcherRow) => row.current_affiliation_name },
    { key: "role_title", label: "Role Title", get: (row: ResearcherRow) => row.role_title },
    { key: "research_areas", label: "Research Areas", get: (row: ResearcherRow) => row.research_areas },
    { key: "google_scholar_url", label: "Scholar URL", get: (row: ResearcherRow) => row.google_scholar_url },
    { key: "personal_website_url", label: "Website URL", get: (row: ResearcherRow) => row.personal_website_url },
    { key: "twitter_handle", label: "X Handle", get: (row: ResearcherRow) => row.twitter_handle || row.x_url },
    { key: "notable_papers_or_contributions", label: "Contributions", get: (row: ResearcherRow) => row.notable_papers_or_contributions },
    { key: "h_index", label: "H-Index", get: (row: ResearcherRow) => row.h_index },
    { key: "citation_count", label: "Citation Count", get: (row: ResearcherRow) => row.citation_count },
    { key: "openalex_id", label: "OpenAlex", get: (row: ResearcherRow) => row.openalex_id },
  ];

  const qualityFields = fields.map((field) => {
    const filled = rows.filter((row) => {
      const value = field.get(row);
      if (typeof value === "number") return value > 0;
      return Boolean(String(value || "").trim());
    }).length;
    const missing = rows.length - filled;
    const coveragePercent = rows.length ? (filled / rows.length) * 100 : 0;
    return {
      key: field.key,
      label: field.label,
      filled,
      missing,
      coveragePercent: Number(coveragePercent.toFixed(1)),
    };
  });

  const overallCoveragePercent = qualityFields.length
    ? qualityFields.reduce((sum, field) => sum + field.coveragePercent, 0) / qualityFields.length
    : 0;

  const nameCoveragePercent = qualityFields.find((field) => field.key === "name")?.coveragePercent || 0;
  const avatarCoveragePercent = qualityFields.find((field) => field.key === "avatar_url")?.coveragePercent || 0;

  return {
    totalResearchers: rows.length,
    totalFields: qualityFields.length,
    overallCoveragePercent: Number(overallCoveragePercent.toFixed(1)),
    updatedAt: new Date().toISOString(),
    fields: qualityFields,
    highlight: {
      nameCoveragePercent,
      avatarCoveragePercent,
      cleanNamePercent: nameCoveragePercent,
      validAvatarLinkPercent: avatarCoveragePercent,
    },
  };
}

function mapResearcherRow(row: ResearcherRow) {
  const twitterHandle = extractTwitterHandle(row.twitter_handle || row.x_url);
  const twitterUrl = toTwitterUrl(twitterHandle);
  const sourceAvatarUrl = normalizeExternalUrl(row.avatar_url);
  const avatarUrl = sourceAvatarUrl || fallbackAvatarUrl(row.name || row.id);
  const scholarUrl = normalizeExternalUrl(row.google_scholar_url);
  const websiteUrl = normalizeExternalUrl(row.personal_website_url);
  const openAlexUrl = normalizeExternalUrl(row.openalex_url);

  return {
    id: row.id,
    name: row.name || row.id,
    avatarUrl,
    currentAffiliation: row.current_affiliation_name || "",
    roleTitle: row.role_title || "",
    researchAreas: splitListString(row.research_areas),
    scholarUrl,
    websiteUrl,
    twitterHandle: twitterHandle || "",
    twitterUrl: twitterUrl || "",
    notableContributions: splitListString(row.notable_papers_or_contributions),
    hIndex: Number(row.h_index) || 0,
    citationCount: Number(row.citation_count) || 0,
    influenceScore: Number(row.influence_score) || 0,
    education: splitListString(row.education),
    openAlexUrl,
    lastVerifiedAt: row.last_verified_at || "",
    lastEnrichedAt: row.last_enriched_at || "",
    sourceUpdatedAt: row.source_updated_at || "",
    linkHealth: {
      scholar: row.scholar_status || (scholarUrl ? "unknown" : "missing"),
      website: row.website_status || (websiteUrl ? "unknown" : "missing"),
      x: row.x_status || (twitterUrl ? "unknown" : "missing"),
    },
  };
}

function run() {
  ensureDir(OUT_DIR);

  const projects = db.prepare(`
    SELECT p.*, c.name AS org_name, c.website AS org_website
    FROM projects p
    LEFT JOIN companies c ON p.org_id = c.id
    ORDER BY p.stars DESC, p.name ASC
  `).all() as ProjectRow[];

  const dependencies = db.prepare(`
    SELECT d.from_project_id, p.id, p.name
    FROM dependencies d
    JOIN projects p ON p.id = d.to_project_id
  `).all() as Array<{ from_project_id: string; id: string; name: string }>;

  const maintainers = db.prepare(`
    SELECT m.project_id, pe.id, pe.name, pe.github_handle, pe.avatar_url
    FROM maintainers m
    JOIN people pe ON pe.id = m.person_id
  `).all() as Array<{ project_id: string } & PersonRow>;

  const topics = db.prepare(`
    SELECT project_id, topic
    FROM topics
    ORDER BY topic ASC
  `).all() as Array<{ project_id: string; topic: string }>;

  const dependencyMap = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of dependencies) {
    const list = dependencyMap.get(row.from_project_id) || [];
    list.push({ id: row.id, name: row.name });
    dependencyMap.set(row.from_project_id, list);
  }

  const maintainerMap = new Map<string, PersonRow[]>();
  for (const row of maintainers) {
    const list = maintainerMap.get(row.project_id) || [];
    list.push({
      id: row.id,
      name: row.name,
      github_handle: row.github_handle,
      avatar_url: row.avatar_url,
    });
    maintainerMap.set(row.project_id, list);
  }

  const topicMap = new Map<string, string[]>();
  for (const row of topics) {
    const list = topicMap.get(row.project_id) || [];
    list.push(row.topic);
    topicMap.set(row.project_id, list);
  }

  const enrichedProjects = projects.map((project) => ({
    ...project,
    is_maintained: Boolean(project.is_maintained),
    dependencies: dependencyMap.get(project.id) || [],
    maintainers: maintainerMap.get(project.id) || [],
    topics: topicMap.get(project.id) || [],
  }));

  const graph = {
    nodes: projects.map((project) => ({
      id: project.id,
      name: project.name,
      category: project.category || "unknown",
      stars: project.stars || 0,
    })),
    links: db.prepare(`
      SELECT from_project_id AS source, to_project_id AS target
      FROM dependencies
    `).all(),
  };

  const researcherRows = db.prepare(`
    SELECT *
    FROM researchers
    ORDER BY influence_score DESC, citation_count DESC, name ASC
  `).all() as ResearcherRow[];

  const researchers = researcherRows.map(mapResearcherRow);
  const researchersQuality = buildResearcherQualityStats(researcherRows);
  const insightsStatus = buildInsightsStatus(projects, researcherRows);
  const companies = db.prepare(`
    SELECT *
    FROM companies
    ORDER BY name ASC
  `).all() as Record<string, any>[];
  const people = db.prepare(`
    SELECT *
    FROM people
    ORDER BY name ASC
  `).all() as Record<string, any>[];
  const maintainersMapRows = db.prepare(`
    SELECT *
    FROM maintainers
    ORDER BY project_id ASC, person_id ASC
  `).all() as Record<string, any>[];
  const dependencyRows = db.prepare(`
    SELECT *
    FROM dependencies
    ORDER BY from_project_id ASC, to_project_id ASC
  `).all() as Record<string, any>[];
  const topicRows = db.prepare(`
    SELECT *
    FROM topics
    ORDER BY project_id ASC, topic ASC
  `).all() as Record<string, any>[];

  const exportOptions = {
    formats: ["csv", "tsv", "json"],
    tables: [
      { key: "researchers", label: "AI Researchers", description: "Researcher profiles, affiliations, metrics, and links" },
      { key: "projects", label: "Projects", description: "All ecosystem projects with metadata" },
      { key: "projects_top200_structured", label: "Top 200 Structured Projects", description: "Top 200 AI projects with maintainers, organization links, dependencies, and topics" },
      { key: "companies", label: "Organizations", description: "Organizations and websites" },
      { key: "people", label: "People", description: "Maintainers/person records" },
      { key: "dependencies", label: "Dependencies", description: "Project dependency graph edges" },
      { key: "maintainers", label: "Maintainers Map", description: "Project-to-maintainer mappings" },
      { key: "topics", label: "Topics", description: "Project topic mappings" },
    ],
    recommended: {
      forSpreadsheets: ["csv", "tsv"],
      forPipelines: ["json", "csv"],
    },
  };

  const top200Structured = db.prepare(`
    WITH top_projects AS (
      SELECT
        p.id,
        p.name,
        p.github_url,
        p.stars,
        p.license,
        p.language,
        p.category,
        p.first_release,
        p.latest_version,
        p.latest_release_date,
        p.repo_pushed_at,
        p.is_maintained,
        p.org_id,
        c.name AS org_name,
        c.website AS org_website
      FROM projects p
      LEFT JOIN companies c ON p.org_id = c.id
      ORDER BY p.stars DESC, p.name ASC
      LIMIT 200
    )
    SELECT
      ROW_NUMBER() OVER (ORDER BY tp.stars DESC, tp.name ASC) AS rank,
      tp.id AS project_id,
      tp.name AS project_name,
      tp.github_url,
      tp.stars AS github_star_count,
      COALESCE(tp.license, '') AS license_type,
      COALESCE(tp.language, '') AS primary_language,
      COALESCE(tp.category, '') AS category,
      COALESCE(tp.first_release, '') AS first_release_date,
      COALESCE(tp.latest_version, '') AS latest_release_version,
      COALESCE(tp.latest_release_date, '') AS latest_release_date,
      COALESCE(tp.repo_pushed_at, '') AS repo_last_pushed_at,
      CASE WHEN tp.is_maintained = 1 THEN 'true' ELSE 'false' END AS actively_maintained,
      COALESCE(tp.org_id, '') AS backing_organization_id,
      COALESCE(tp.org_name, '') AS backing_organization_name,
      COALESCE(tp.org_website, '') AS backing_organization_website,
      COALESCE((
        SELECT group_concat(person_id, ' | ')
        FROM (
          SELECT DISTINCT pe.id AS person_id, pe.name AS person_name
          FROM maintainers m
          JOIN people pe ON pe.id = m.person_id
          WHERE m.project_id = tp.id
          ORDER BY person_name ASC
        )
      ), '') AS key_maintainer_ids,
      COALESCE((
        SELECT group_concat(person_name, ' | ')
        FROM (
          SELECT DISTINCT pe.name AS person_name
          FROM maintainers m
          JOIN people pe ON pe.id = m.person_id
          WHERE m.project_id = tp.id
          ORDER BY person_name ASC
        )
      ), '') AS key_maintainer_names,
      COALESCE((
        SELECT group_concat(dependency_project_id, ' | ')
        FROM (
          SELECT DISTINCT p2.id AS dependency_project_id, p2.stars AS dependency_stars, p2.name AS dependency_project_name
          FROM dependencies d
          JOIN projects p2 ON p2.id = d.to_project_id
          WHERE d.from_project_id = tp.id
          ORDER BY dependency_stars DESC, dependency_project_name ASC
        )
      ), '') AS dependency_project_ids,
      COALESCE((
        SELECT group_concat(dependency_project_name, ' | ')
        FROM (
          SELECT DISTINCT p2.name AS dependency_project_name, p2.stars AS dependency_stars
          FROM dependencies d
          JOIN projects p2 ON p2.id = d.to_project_id
          WHERE d.from_project_id = tp.id
          ORDER BY dependency_stars DESC, dependency_project_name ASC
        )
      ), '') AS dependency_project_names,
      COALESCE((
        SELECT group_concat(topic, ' | ')
        FROM (
          SELECT DISTINCT t.topic AS topic
          FROM topics t
          WHERE t.project_id = tp.id
          ORDER BY topic ASC
        )
      ), '') AS topics,
      (
        SELECT COUNT(DISTINCT m.person_id)
        FROM maintainers m
        WHERE m.project_id = tp.id
      ) AS maintainer_count,
      (
        SELECT COUNT(DISTINCT d.to_project_id)
        FROM dependencies d
        WHERE d.from_project_id = tp.id
      ) AS dependency_count,
      (
        SELECT COUNT(DISTINCT t.topic)
        FROM topics t
        WHERE t.project_id = tp.id
      ) AS topic_count
    FROM top_projects tp
    ORDER BY rank ASC
  `).all() as Record<string, any>[];

  const allProjectsExport = projects.map((project) => ({
    ...project,
    is_maintained: project.is_maintained ? 1 : 0,
  }));

  writeJson("projects.json", enrichedProjects);
  writeJson("graph.json", graph);
  writeJson("researchers.json", researchers);
  writeJson("researchers-quality.json", researchersQuality);
  writeJson("export-options.json", exportOptions);
  writeJson("insights-status.json", insightsStatus);
  writeDataset("projects_top200_structured", top200Structured);
  writeText("projects.csv", toDelimitedText(allProjectsExport as Record<string, any>[], ","));
  writeText("projects.tsv", toDelimitedText(allProjectsExport as Record<string, any>[], "\t"));
  writeText("researchers.csv", toDelimitedText(researchers as Record<string, any>[], ","));
  writeText("researchers.tsv", toDelimitedText(researchers as Record<string, any>[], "\t"));
  writeDataset("companies", companies);
  writeDataset("people", people);
  writeDataset("maintainers", maintainersMapRows);
  writeDataset("dependencies", dependencyRows);
  writeDataset("topics", topicRows);

  console.log(`Deploy data written to ${path.relative(ROOT, OUT_DIR)}`);
  console.log(`Projects: ${projects.length.toLocaleString(UI_LOCALE)} · Researchers: ${researchers.length.toLocaleString(UI_LOCALE)}`);
}

run();
