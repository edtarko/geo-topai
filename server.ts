import express from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "node:fs";
import dotenv from "dotenv";
import { buildGeoSpaceBundleFromDb, writeGeoSpaceBundleFiles } from "./geo-space.ts";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPathCandidates = [
  path.resolve(process.cwd(), "geo.db"),
  path.join(__dirname, "geo.db"),
];
const resolvedDbPath = dbPathCandidates.find((candidate) => fs.existsSync(candidate)) || dbPathCandidates[0];
const db = new Database(resolvedDbPath);
const isVercelRuntime = process.env.VERCEL === "1";

function readOnlyDeploymentMessage(feature: string) {
  return `${feature} is disabled on the Vercel deployment because this app uses a bundled SQLite dataset there. Use the local app for sync, refresh, discovery, or file-writing exports.`;
}

// Initialize Database
db.exec("PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    website TEXT
  );

  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    github_handle TEXT,
    avatar_url TEXT
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    github_url TEXT UNIQUE,
    stars INTEGER,
    license TEXT,
    language TEXT,
    category TEXT,
    first_release TEXT,
    latest_version TEXT,
    latest_release_date TEXT,
    repo_pushed_at TEXT,
    project_logo_url TEXT,
    is_maintained INTEGER,
    org_id TEXT,
    description TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (org_id) REFERENCES companies(id) ON DELETE SET NULL ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS dependencies (
    from_project_id TEXT,
    to_project_id TEXT,
    PRIMARY KEY (from_project_id, to_project_id),
    FOREIGN KEY (from_project_id) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (to_project_id) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS maintainers (
    project_id TEXT,
    person_id TEXT,
    PRIMARY KEY (project_id, person_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS topics (
    project_id TEXT,
    topic TEXT,
    PRIMARY KEY (project_id, topic),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS researchers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar_url TEXT,
    current_affiliation_id TEXT,
    current_affiliation_name TEXT,
    role_title TEXT,
    research_area_ids TEXT,
    research_areas TEXT,
    google_scholar_url TEXT,
    personal_website_url TEXT,
    twitter_handle TEXT,
    x_url TEXT,
    notable_papers_or_contributions TEXT,
    h_index INTEGER DEFAULT 0,
    citation_count INTEGER DEFAULT 0,
    influence_score REAL DEFAULT 0,
    previous_affiliation_ids TEXT,
    previous_affiliations TEXT,
    education_ids TEXT,
    education TEXT,
    openalex_id TEXT,
    openalex_url TEXT,
    scholar_status TEXT,
    website_status TEXT,
    x_status TEXT,
    last_verified_at TEXT,
    last_enriched_at TEXT,
    source_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Cleanup duplicates if any exist from previous versions
try {
  db.exec(`
    DELETE FROM projects WHERE id NOT IN (
      SELECT MIN(id) FROM projects GROUP BY github_url
    );
  `);
} catch (e) {
  console.log("Cleanup skipped or already unique");
}

// Lightweight schema migrations for existing databases
try {
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as any[];
  const hasRepoPushedAt = projectColumns.some((column) => column.name === "repo_pushed_at");
  const hasProjectLogoUrl = projectColumns.some((column) => column.name === "project_logo_url");
  if (!hasRepoPushedAt) {
    db.exec("ALTER TABLE projects ADD COLUMN repo_pushed_at TEXT;");
  }
  if (!hasProjectLogoUrl) {
    db.exec("ALTER TABLE projects ADD COLUMN project_logo_url TEXT;");
  }
} catch (e) {
  console.warn("Project schema migration warning:", e);
}

try {
  const researcherColumns = db.prepare("PRAGMA table_info(researchers)").all() as any[];
  const requiredColumns = [
    { name: "x_url", sql: "ALTER TABLE researchers ADD COLUMN x_url TEXT;" },
    { name: "openalex_id", sql: "ALTER TABLE researchers ADD COLUMN openalex_id TEXT;" },
    { name: "openalex_url", sql: "ALTER TABLE researchers ADD COLUMN openalex_url TEXT;" },
    { name: "scholar_status", sql: "ALTER TABLE researchers ADD COLUMN scholar_status TEXT;" },
    { name: "website_status", sql: "ALTER TABLE researchers ADD COLUMN website_status TEXT;" },
    { name: "x_status", sql: "ALTER TABLE researchers ADD COLUMN x_status TEXT;" },
    { name: "last_verified_at", sql: "ALTER TABLE researchers ADD COLUMN last_verified_at TEXT;" },
    { name: "last_enriched_at", sql: "ALTER TABLE researchers ADD COLUMN last_enriched_at TEXT;" },
    { name: "source_updated_at", sql: "ALTER TABLE researchers ADD COLUMN source_updated_at DATETIME;" },
    { name: "updated_at", sql: "ALTER TABLE researchers ADD COLUMN updated_at DATETIME;" },
  ];
  for (const column of requiredColumns) {
    if (!researcherColumns.some((entry) => entry.name === column.name)) {
      db.exec(column.sql);
    }
  }
} catch (e) {
  console.warn("Researcher schema migration warning:", e);
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let isBatchSyncInProgress = false;

function isConfiguredGitHubToken(token?: string | null) {
  if (!token) return false;
  const clean = token.trim();
  if (!clean) return false;
  const lower = clean.toLowerCase();
  return !lower.includes("your_github_token");
}

function getGitHubTokenCandidates() {
  const envTokenEntries = Object.entries(process.env)
    .filter(([key]) => /^GITHUB_TOKEN($|_)/i.test(key))
    .map(([, value]) => value);

  const inlineTokens = (process.env.GITHUB_TOKENS || "")
    .split(/[\s,;\n]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const tokens = [
    process.env.GITHUB_TOKEN,
    process.env.GITHUB_TOKEN_BACKUP,
    ...envTokenEntries,
    ...inlineTokens,
  ]
    .map((token) => (token || "").trim())
    .filter((token) => isConfiguredGitHubToken(token));
  return [...new Set(tokens)];
}

function maskToken(token: string) {
  const clean = token.trim();
  if (clean.length <= 10) return `${clean.slice(0, 2)}***${clean.slice(-2)}`;
  return `${clean.slice(0, 4)}...${clean.slice(-4)}`;
}

type GitHubRateLimitSnapshot = {
  id: string;
  mode: "authenticated" | "anonymous";
  tokenMasked: string;
  status: "ok" | "error";
  core: { limit: number; remaining: number; resetAt: string | null };
  search: { limit: number; remaining: number; resetAt: string | null };
  graphql: { limit: number; remaining: number; resetAt: string | null };
  error?: string;
};

async function fetchGitHubRateLimitSnapshot(token: string | null, id: string): Promise<GitHubRateLimitSnapshot> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Geo-AI-App",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const emptyBucket = { limit: 0, remaining: 0, resetAt: null as string | null };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch("https://api.github.com/rate_limit", {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return {
        id,
        mode: token ? "authenticated" : "anonymous",
        tokenMasked: token ? maskToken(token) : "anonymous",
        status: "error",
        core: emptyBucket,
        search: emptyBucket,
        graphql: emptyBucket,
        error: `http-${response.status}`,
      };
    }

    const payload = await response.json();
    const core = payload?.resources?.core || {};
    const search = payload?.resources?.search || {};
    const graphql = payload?.resources?.graphql || payload?.resources?.graphql_api || {};
    const toReset = (epoch?: number) =>
      Number.isFinite(epoch) && epoch ? new Date(epoch * 1000).toISOString() : null;

    return {
      id,
      mode: token ? "authenticated" : "anonymous",
      tokenMasked: token ? maskToken(token) : "anonymous",
      status: "ok",
      core: {
        limit: Number(core.limit) || 0,
        remaining: Number(core.remaining) || 0,
        resetAt: toReset(Number(core.reset)),
      },
      search: {
        limit: Number(search.limit) || 0,
        remaining: Number(search.remaining) || 0,
        resetAt: toReset(Number(search.reset)),
      },
      graphql: {
        limit: Number(graphql.limit) || 0,
        remaining: Number(graphql.remaining) || 0,
        resetAt: toReset(Number(graphql.reset)),
      },
    };
  } catch (error) {
    return {
      id,
      mode: token ? "authenticated" : "anonymous",
      tokenMasked: token ? maskToken(token) : "anonymous",
      status: "error",
      core: emptyBucket,
      search: emptyBucket,
      graphql: emptyBucket,
      error: (error as Error)?.name === "AbortError" ? "timeout" : "network-error",
    };
  }
}

function toCoveragePercent(filled: number, total: number) {
  if (!total) return 0;
  return Number(((filled / total) * 100).toFixed(1));
}

async function buildInsightsStatus({
  includeRateLimits = true,
  tokenSampleSize = 3,
}: {
  includeRateLimits?: boolean;
  tokenSampleSize?: number;
} = {}) {
  const projectSummary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN is_maintained = 1 THEN 1 ELSE 0 END) AS maintained,
      SUM(CASE WHEN first_release IS NOT NULL AND first_release <> '' THEN 1 ELSE 0 END) AS with_first_release,
      SUM(CASE WHEN latest_version IS NOT NULL AND latest_version <> '' THEN 1 ELSE 0 END) AS with_latest_version,
      SUM(CASE WHEN repo_pushed_at IS NOT NULL AND repo_pushed_at <> '' THEN 1 ELSE 0 END) AS with_repo_activity,
      SUM(CASE WHEN org_id IS NOT NULL AND org_id <> '' THEN 1 ELSE 0 END) AS with_org,
      SUM(CASE WHEN description IS NOT NULL AND description <> '' THEN 1 ELSE 0 END) AS with_description
    FROM projects
  `).get() as any;

  const activityBuckets = db.prepare(`
    SELECT
      SUM(CASE WHEN repo_pushed_at IS NULL OR repo_pushed_at = '' THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN repo_pushed_at <> '' AND (julianday('now') - julianday(repo_pushed_at)) <= 30 THEN 1 ELSE 0 END) AS d30,
      SUM(CASE WHEN repo_pushed_at <> '' AND (julianday('now') - julianday(repo_pushed_at)) > 30 AND (julianday('now') - julianday(repo_pushed_at)) <= 90 THEN 1 ELSE 0 END) AS d90,
      SUM(CASE WHEN repo_pushed_at <> '' AND (julianday('now') - julianday(repo_pushed_at)) > 365 THEN 1 ELSE 0 END) AS stale365
    FROM projects
  `).get() as any;

  const missingMeta = db.prepare(`
    SELECT COUNT(*) AS total
    FROM projects
    WHERE
      first_release IS NULL OR first_release = '' OR
      latest_version IS NULL OR latest_version = '' OR
      repo_pushed_at IS NULL OR repo_pushed_at = '' OR
      org_id IS NULL OR org_id = ''
  `).get() as any;

  const lastProjectSync = db.prepare(`
    SELECT MAX(last_updated) AS value
    FROM projects
  `).get() as any;

  const latestRepoActivity = db.prepare(`
    SELECT MAX(repo_pushed_at) AS value
    FROM projects
  `).get() as any;

  const researcherSummary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      MAX(last_verified_at) AS last_verified_at,
      MAX(last_enriched_at) AS last_enriched_at
    FROM researchers
  `).get() as any;

  const totalProjects = Number(projectSummary?.total) || 0;
  const withFirstRelease = Number(projectSummary?.with_first_release) || 0;
  const withLatestVersion = Number(projectSummary?.with_latest_version) || 0;
  const withRepoActivity = Number(projectSummary?.with_repo_activity) || 0;
  const withOrg = Number(projectSummary?.with_org) || 0;
  const withDescription = Number(projectSummary?.with_description) || 0;

  const coverageFields = [
    { key: "first_release", label: "First Release", filled: withFirstRelease },
    { key: "latest_version", label: "Latest Version", filled: withLatestVersion },
    { key: "repo_activity", label: "Repository Activity Date", filled: withRepoActivity },
    { key: "organization", label: "Organization", filled: withOrg },
    { key: "description", label: "Description", filled: withDescription },
  ].map((field) => ({
    ...field,
    coveragePercent: toCoveragePercent(field.filled, totalProjects),
  }));

  const metadataCoverageScore = coverageFields.length
    ? Number(
        (
          coverageFields.reduce((sum, field) => sum + field.coveragePercent, 0) /
          coverageFields.length
        ).toFixed(1),
      )
    : 0;

  const tokens = getGitHubTokenCandidates();
  const sampleSize = Math.max(0, Math.min(tokenSampleSize, tokens.length));
  const sampledTokens = tokens.slice(0, sampleSize);

  let rateLimits: GitHubRateLimitSnapshot[] = [];
  if (includeRateLimits) {
    const snapshots = await Promise.all([
      fetchGitHubRateLimitSnapshot(null, "anon"),
      ...sampledTokens.map((token, index) => fetchGitHubRateLimitSnapshot(token, `token-${index + 1}`)),
    ]);
    rateLimits = snapshots;
  }

  return {
    generatedAt: new Date().toISOString(),
    projects: {
      total: totalProjects,
      maintained: Number(projectSummary?.maintained) || 0,
      recentlyActive30d: Number(activityBuckets?.d30) || 0,
      recentlyActive90d: (Number(activityBuckets?.d30) || 0) + (Number(activityBuckets?.d90) || 0),
      staleOver365d: Number(activityBuckets?.stale365) || 0,
      unknownActivity: Number(activityBuckets?.unknown) || 0,
      lastSyncedAt: lastProjectSync?.value || null,
      latestRepoActivityAt: latestRepoActivity?.value || null,
    },
    researchers: {
      total: Number(researcherSummary?.total) || 0,
      lastVerifiedAt: researcherSummary?.last_verified_at || null,
      lastEnrichedAt: researcherSummary?.last_enriched_at || null,
    },
    coverage: {
      metadataCoverageScore,
      missingMetaProjects: Number(missingMeta?.total) || 0,
      fields: coverageFields,
    },
    tokenPool: {
      configured: tokens.length,
      sampled: sampledTokens.length,
      rateLimits,
    },
  };
}

function mergeDefined<T extends Record<string, any>>(base: T, incoming?: Partial<T> | null) {
  const merged = { ...base };
  if (!incoming) return merged;
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined && value !== "") {
      (merged as any)[key] = value;
    }
  }
  return merged;
}

function companyIdFromName(name: string) {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `org_${slug || "community"}`;
}

function upsertCompany(org?: { name: string; website?: string | null } | null) {
  if (!org?.name) return null;
  const companyId = companyIdFromName(org.name);
  db.prepare(`
    INSERT INTO companies (id, name, website)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      website = COALESCE(excluded.website, companies.website)
  `).run(companyId, org.name, org.website || null);
  return companyId;
}

type LinkHealthStatus = "verified" | "broken" | "restricted" | "unknown" | "missing";

const RESEARCHER_VERIFY_STALE_MS = 1000 * 60 * 60 * 24 * 7;
const RESEARCHER_ENRICH_STALE_MS = 1000 * 60 * 60 * 24 * 14;
let isResearcherRefreshInProgress = false;

function parseCsvRows(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === "\"") {
      if (inQuotes && input[i + 1] === "\"") {
        cell += "\"";
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }

  return rows;
}

function parseCsvObjects(input: string) {
  const rows = parseCsvRows(input);
  if (!rows.length) return [];
  const headers = rows[0].map((entry) => entry.trim());
  return rows.slice(1).map((values) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, index) => {
      obj[header] = values[index]?.trim() || "";
    });
    return obj;
  });
}

function normalizeListString(value?: string | null) {
  if (!value) return "";
  return value
    .split(/[;\n]/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .join("; ");
}

function splitListString(value?: string | null) {
  if (!value) return [];
  return value
    .split(/[;\n]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseNumber(value?: string | null) {
  if (!value) return 0;
  const normalized = value.replace(/[^0-9.]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeExternalUrl(url?: string | null) {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractTwitterHandle(input?: string | null) {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (!/^(www\.)?(x|twitter)\.com$/i.test(parsed.hostname)) return null;
      const handle = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
      if (!handle || ["home", "intent", "share", "i"].includes(handle.toLowerCase())) return null;
      return handle.replace(/^@/, "");
    } catch {
      return null;
    }
  }

  const normalized = trimmed.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(normalized)) return null;
  return normalized;
}

function toTwitterUrl(handle?: string | null) {
  if (!handle) return null;
  return `https://x.com/${handle}`;
}

function normalizePersonName(value?: string | null) {
  if (!value) return "";
  const compact = value
    .trim()
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ");
  if (!compact) return "";

  const shouldTitleCase = /[_-]/.test(value) || compact === compact.toLowerCase();
  if (!shouldTitleCase) return compact;

  return compact
    .split(" ")
    .map((token) => {
      if (!token) return token;
      return token[0].toUpperCase() + token.slice(1);
    })
    .join(" ");
}

function fallbackPersonNameFromId(id?: string | null) {
  if (!id) return "Unknown Researcher";
  const raw = id.replace(/^person:/i, "").replace(/[_-]+/g, " ");
  const normalized = normalizePersonName(raw);
  return normalized || "Unknown Researcher";
}

function fallbackAvatarUrl(name?: string | null) {
  const seed = encodeURIComponent(normalizePersonName(name) || "Researcher");
  return `https://api.dicebear.com/9.x/initials/svg?seed=${seed}&fontWeight=700&radius=16`;
}

function splitGithubOwnerRepo(url?: string | null) {
  if (!url) return null;
  const normalized = url.trim();
  if (!normalized) return null;
  const match = normalized.match(/github\.com\/([^/]+)\/([^/ \n?#]+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\/+$/, "") };
}

function normalizeComparableText(value?: string | null) {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitComparableTokens(value?: string | null) {
  return normalizeComparableText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function parseUrlDomain(url?: string | null) {
  const normalized = normalizeExternalUrl(url);
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function extractTwitterHandlesFromText(input?: string | null) {
  if (!input) return [];
  const normalized = input.replace(/\\\//g, "/");
  const regex = /(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gi;
  const unique = new Set<string>();
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(normalized)) !== null) {
    const handle = extractTwitterHandle(match[1]);
    if (handle) unique.add(handle);
  }
  return Array.from(unique);
}

type ResearcherXOverride = {
  twitterHandle: string;
  xUrl: string;
};

function getResearcherXOverridesPath() {
  const candidates = [
    process.env.RESEARCHER_X_OVERRIDES_PATH,
    path.join(process.cwd(), "public", "researcher_x_overrides.csv"),
    path.join(__dirname, "public", "researcher_x_overrides.csv"),
    path.join(process.cwd(), "dist", "researcher_x_overrides.csv"),
    path.join(__dirname, "dist", "researcher_x_overrides.csv"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function loadResearcherXOverrides() {
  const byId = new Map<string, ResearcherXOverride>();
  const byName = new Map<string, ResearcherXOverride>();
  const csvPath = getResearcherXOverridesPath();
  if (!csvPath) return { path: null as string | null, byId, byName };

  try {
    const csvText = fs.readFileSync(csvPath, "utf-8");
    const rows = parseCsvObjects(csvText);
    for (const row of rows) {
      const handle = extractTwitterHandle(row.twitter_handle || row.x_url || row.x || row.handle || "");
      const xUrl = toTwitterUrl(handle) || normalizeExternalUrl(row.x_url || row.x || "") || null;
      if (!handle || !xUrl) continue;

      const normalizedId = (row.id || "").trim();
      const normalizedName = normalizeComparableText(row.name || "");
      const payload: ResearcherXOverride = { twitterHandle: handle, xUrl };
      if (normalizedId) byId.set(normalizedId, payload);
      if (normalizedName) byName.set(normalizedName, payload);
    }
  } catch (error) {
    console.warn("Failed to load researcher X overrides:", error);
  }

  return { path: csvPath, byId, byName };
}

async function fetchHtmlSnippet(url?: string | null) {
  const target = normalizeExternalUrl(url);
  if (!target) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5500);
  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Geo-AI-App" },
    });
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) return null;
    const text = await response.text();
    return text.slice(0, 280000);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverTwitterFromHtmlUrl(url?: string | null) {
  const html = await fetchHtmlSnippet(url);
  if (!html) return null;
  const handles = extractTwitterHandlesFromText(html);
  return handles[0] || null;
}

function scoreNameSimilarity(targetName: string, candidateName: string) {
  const target = normalizeComparableText(targetName);
  const candidate = normalizeComparableText(candidateName);
  if (!target || !candidate) return 0;
  if (target === candidate) return 100;

  const targetTokens = splitComparableTokens(targetName);
  const candidateTokens = splitComparableTokens(candidateName);
  if (!targetTokens.length || !candidateTokens.length) return 0;

  const shared = targetTokens.filter((token) => candidateTokens.includes(token)).length;
  const union = new Set([...targetTokens, ...candidateTokens]).size;
  if (!union) return 0;
  return Math.round((shared / union) * 100);
}

async function discoverTwitterFromGitHubProfile({
  name,
  affiliation,
  websiteUrl,
}: {
  name: string;
  affiliation?: string | null;
  websiteUrl?: string | null;
}) {
  const cleanName = normalizePersonName(name);
  if (!cleanName) return null;

  const targetAffiliation = normalizeComparableText(affiliation);
  const targetWebsiteDomain = parseUrlDomain(websiteUrl);
  const tokenPool = [...getGitHubTokenCandidates(), null] as Array<string | null>;
  const query = `${cleanName} in:fullname type:user`;

  for (const token of tokenPool) {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Geo-AI-App",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const searchParams = new URLSearchParams({
        q: query,
        per_page: "6",
      });
      const searchResponse = await fetch(`https://api.github.com/search/users?${searchParams.toString()}`, { headers });
      if (searchResponse.status === 401 || searchResponse.status === 403) continue;
      if (!searchResponse.ok) continue;

      const searchPayload = await searchResponse.json();
      const items = Array.isArray(searchPayload?.items) ? searchPayload.items.slice(0, 6) : [];
      if (!items.length) continue;

      let best: { handle: string; score: number } | null = null;
      for (const item of items) {
        const login = typeof item?.login === "string" ? item.login : "";
        if (!login) continue;

        const userResponse = await fetch(`https://api.github.com/users/${login}`, { headers });
        if (!userResponse.ok) continue;
        const user = await userResponse.json();

        const handleFromTwitter = extractTwitterHandle(user?.twitter_username || "");
        const handleFromBlog = extractTwitterHandle(user?.blog || "");
        const handleFromBio = extractTwitterHandlesFromText(`${user?.bio || ""} ${user?.blog || ""}`)[0] || null;
        const candidateHandle = handleFromTwitter || handleFromBlog || handleFromBio;
        if (!candidateHandle) continue;

        const candidateName = user?.name || user?.login || "";
        const nameScore = scoreNameSimilarity(cleanName, candidateName);
        if (nameScore < 55) continue;

        let score = nameScore;
        if (handleFromTwitter) score += 16;

        const companyText = normalizeComparableText(`${user?.company || ""} ${user?.bio || ""}`);
        if (targetAffiliation && companyText && (companyText.includes(targetAffiliation) || targetAffiliation.includes(companyText))) {
          score += 20;
        }

        const candidateWebsiteDomain = parseUrlDomain(user?.blog || "");
        if (targetWebsiteDomain && candidateWebsiteDomain && targetWebsiteDomain === candidateWebsiteDomain) {
          score += 18;
        }

        score += Math.min(8, Math.floor((Number(user?.followers) || 0) / 3000));
        if (!best || score > best.score) {
          best = { handle: candidateHandle, score };
        }

        await delay(token ? 25 : 85);
      }

      if (best && best.score >= 76) {
        return best.handle;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function discoverTwitterHandleForResearcher({
  name,
  affiliation,
  websiteUrl,
  scholarUrl,
}: {
  name: string;
  affiliation?: string | null;
  websiteUrl?: string | null;
  scholarUrl?: string | null;
}) {
  const fromWebsite = await discoverTwitterFromHtmlUrl(websiteUrl);
  if (fromWebsite) return { handle: fromWebsite, source: "website" as const };

  const fromScholar = await discoverTwitterFromHtmlUrl(scholarUrl);
  if (fromScholar) return { handle: fromScholar, source: "scholar" as const };

  const fromGitHub = await discoverTwitterFromGitHubProfile({ name, affiliation, websiteUrl });
  if (fromGitHub) return { handle: fromGitHub, source: "github" as const };

  return null;
}

function csvEscapeCell(value: any) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r\t]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toDelimitedText(rows: Record<string, any>[], delimiter: "," | "\t" = ",") {
  if (!rows.length) return "";
  const headerSet = new Set<string>();
  for (const row of rows) {
    Object.keys(row || {}).forEach((key) => headerSet.add(key));
  }
  const headers = Array.from(headerSet);

  const lines = [headers.map((header) => csvEscapeCell(header)).join(delimiter)];
  for (const row of rows) {
    const line = headers
      .map((header) => {
        const value = (row as any)?.[header];
        if (Array.isArray(value)) return csvEscapeCell(value.join("; "));
        if (value && typeof value === "object") return csvEscapeCell(JSON.stringify(value));
        return csvEscapeCell(value);
      })
      .join(delimiter);
    lines.push(line);
  }
  return lines.join("\n");
}

function hasMeaningfulValue(value: unknown) {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((entry) => hasMeaningfulValue(entry));
  return true;
}

const RESEARCHER_SCHEMA_FIELDS = [
  { key: "id", label: "ID" },
  { key: "name", label: "Name" },
  { key: "avatar_url", label: "Avatar URL" },
  { key: "current_affiliation_id", label: "Current Affiliation ID" },
  { key: "current_affiliation_name", label: "Current Affiliation Name" },
  { key: "role_title", label: "Role Title" },
  { key: "research_area_ids", label: "Research Area IDs" },
  { key: "research_areas", label: "Research Areas" },
  { key: "google_scholar_url", label: "Google Scholar URL" },
  { key: "personal_website_url", label: "Personal Website URL" },
  { key: "twitter_handle", label: "Twitter/X Handle" },
  { key: "notable_papers_or_contributions", label: "Notable Contributions" },
  { key: "h_index", label: "H-Index" },
  { key: "citation_count", label: "Citation Count" },
  { key: "influence_score", label: "Influence Score" },
  { key: "previous_affiliation_ids", label: "Previous Affiliation IDs" },
  { key: "previous_affiliations", label: "Previous Affiliations" },
  { key: "education_ids", label: "Education IDs" },
  { key: "education", label: "Education" },
] as const;

function getResearcherQualityStats() {
  const researchers = db.prepare(`
    SELECT *
    FROM researchers
  `).all() as any[];
  const total = researchers.length;

  if (!total) {
    return {
      totalResearchers: 0,
      totalFields: RESEARCHER_SCHEMA_FIELDS.length,
      overallCoveragePercent: 0,
      updatedAt: new Date().toISOString(),
      fields: RESEARCHER_SCHEMA_FIELDS.map((field) => ({
        key: field.key,
        label: field.label,
        filled: 0,
        missing: 0,
        coveragePercent: 0,
      })),
      highlight: {
        nameCoveragePercent: 0,
        avatarCoveragePercent: 0,
      },
    };
  }

  const fields = RESEARCHER_SCHEMA_FIELDS.map((field) => {
    const filled = researchers.reduce((count, row) => {
      return hasMeaningfulValue(row[field.key]) ? count + 1 : count;
    }, 0);
    const missing = total - filled;
    const coveragePercent = Number(((filled / total) * 100).toFixed(1));
    return {
      key: field.key,
      label: field.label,
      filled,
      missing,
      coveragePercent,
    };
  });

  const overallCoveragePercent = Number(
    (
      fields.reduce((acc, field) => acc + field.coveragePercent, 0) /
      fields.length
    ).toFixed(1),
  );

  const nameCoveragePercent = fields.find((field) => field.key === "name")?.coveragePercent || 0;
  const avatarCoveragePercent = fields.find((field) => field.key === "avatar_url")?.coveragePercent || 0;

  const cleanNames = researchers.filter((row) => {
    const source = typeof row.name === "string" ? row.name : "";
    const normalized = normalizePersonName(source);
    return source.trim().length > 0 && normalized === source.trim();
  }).length;

  const validAvatarLinks = researchers.filter((row) => {
    const normalized = normalizeExternalUrl(row.avatar_url);
    return Boolean(normalized);
  }).length;

  return {
    totalResearchers: total,
    totalFields: RESEARCHER_SCHEMA_FIELDS.length,
    overallCoveragePercent,
    updatedAt: new Date().toISOString(),
    fields,
    highlight: {
      nameCoveragePercent,
      avatarCoveragePercent,
      cleanNamePercent: Number(((cleanNames / total) * 100).toFixed(1)),
      validAvatarLinkPercent: Number(((validAvatarLinks / total) * 100).toFixed(1)),
    },
  };
}

const EXPORT_TABLES: Record<
  string,
  {
    label: string;
    description: string;
    sql: string;
  }
> = {
  researchers: {
    label: "AI Researchers",
    description: "Researcher profiles, affiliations, metrics, and links",
    sql: `
      SELECT *
      FROM researchers
      ORDER BY influence_score DESC, citation_count DESC, name ASC
    `,
  },
  projects: {
    label: "Projects",
    description: "All ecosystem projects with metadata",
    sql: `
      SELECT p.*, c.name AS org_name, c.website AS org_website
      FROM projects p
      LEFT JOIN companies c ON p.org_id = c.id
      ORDER BY p.stars DESC, p.name ASC
    `,
  },
  projects_top200_structured: {
    label: "Top 200 Structured Projects",
    description: "Top 200 AI projects with maintainers, organization links, dependencies, and topics",
    sql: `
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
    `,
  },
  projects_top200_maintainers: {
    label: "Top 200 Project Maintainers",
    description: "Project-to-person links for maintainers of the top 200 AI projects",
    sql: `
      WITH top_projects AS (
        SELECT id, name, stars
        FROM projects
        ORDER BY stars DESC, name ASC
        LIMIT 200
      )
      SELECT
        tp.id AS project_id,
        tp.name AS project_name,
        pe.id AS person_id,
        pe.name AS person_name,
        COALESCE(pe.github_handle, '') AS person_github_handle,
        COALESCE(pe.avatar_url, '') AS person_avatar_url
      FROM top_projects tp
      JOIN maintainers m ON m.project_id = tp.id
      JOIN people pe ON pe.id = m.person_id
      ORDER BY tp.stars DESC, tp.name ASC, pe.name ASC
    `,
  },
  projects_top200_dependencies: {
    label: "Top 200 Project Dependencies",
    description: "Project-to-project dependency edges for the top 200 AI projects",
    sql: `
      WITH top_projects AS (
        SELECT id, name, stars
        FROM projects
        ORDER BY stars DESC, name ASC
        LIMIT 200
      )
      SELECT
        tp.id AS source_project_id,
        tp.name AS source_project_name,
        p2.id AS dependency_project_id,
        p2.name AS dependency_project_name,
        COALESCE(p2.github_url, '') AS dependency_github_url,
        COALESCE(p2.stars, 0) AS dependency_github_star_count
      FROM top_projects tp
      JOIN dependencies d ON d.from_project_id = tp.id
      JOIN projects p2 ON p2.id = d.to_project_id
      ORDER BY tp.stars DESC, tp.name ASC, p2.stars DESC, p2.name ASC
    `,
  },
  projects_top200_topics: {
    label: "Top 200 Project Topics",
    description: "Project-to-topic tags for the top 200 AI projects",
    sql: `
      WITH top_projects AS (
        SELECT id, name, stars
        FROM projects
        ORDER BY stars DESC, name ASC
        LIMIT 200
      )
      SELECT
        tp.id AS project_id,
        tp.name AS project_name,
        t.topic
      FROM top_projects tp
      JOIN topics t ON t.project_id = tp.id
      ORDER BY tp.stars DESC, tp.name ASC, t.topic ASC
    `,
  },
  people_top200_project_maintainers: {
    label: "People Linked To Top 200 Projects",
    description: "Distinct person entities connected to the top 200 AI projects",
    sql: `
      WITH top_projects AS (
        SELECT id
        FROM projects
        ORDER BY stars DESC, name ASC
        LIMIT 200
      )
      SELECT DISTINCT
        pe.id AS person_id,
        pe.name AS person_name,
        COALESCE(pe.github_handle, '') AS github_handle,
        COALESCE(pe.avatar_url, '') AS avatar_url
      FROM top_projects tp
      JOIN maintainers m ON m.project_id = tp.id
      JOIN people pe ON pe.id = m.person_id
      ORDER BY person_name ASC
    `,
  },
  companies: {
    label: "Organizations",
    description: "Organizations and websites",
    sql: `
      SELECT *
      FROM companies
      ORDER BY name ASC
    `,
  },
  people: {
    label: "People",
    description: "Maintainers/person records",
    sql: `
      SELECT *
      FROM people
      ORDER BY name ASC
    `,
  },
  dependencies: {
    label: "Dependencies",
    description: "Project dependency graph edges",
    sql: `
      SELECT *
      FROM dependencies
      ORDER BY from_project_id ASC, to_project_id ASC
    `,
  },
  maintainers: {
    label: "Maintainers Map",
    description: "Project-to-maintainer mappings",
    sql: `
      SELECT *
      FROM maintainers
      ORDER BY project_id ASC, person_id ASC
    `,
  },
  topics: {
    label: "Topics",
    description: "Project topic mappings",
    sql: `
      SELECT *
      FROM topics
      ORDER BY project_id ASC, topic ASC
    `,
  },
};

function getResearchersCsvPath() {
  const candidates = [
    process.env.RESEARCHERS_CSV_PATH,
    path.join(process.cwd(), "public", "researchers_top200.csv"),
    path.join(__dirname, "public", "researchers_top200.csv"),
    path.join(process.cwd(), "dist", "researchers_top200.csv"),
    path.join(__dirname, "dist", "researchers_top200.csv"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function mapResearcherRow(row: any) {
  const displayName = normalizePersonName(row.name) || fallbackPersonNameFromId(row.id);
  const twitterHandle = extractTwitterHandle(row.twitter_handle || row.x_url);
  const twitterUrl = toTwitterUrl(twitterHandle) || normalizeExternalUrl(row.x_url);
  const sourceAvatarUrl = normalizeExternalUrl(row.avatar_url);
  const avatarUrl = sourceAvatarUrl || fallbackAvatarUrl(displayName);
  const scholarUrl = normalizeExternalUrl(row.google_scholar_url) || "";
  const websiteUrl = normalizeExternalUrl(row.personal_website_url) || "";
  const openAlexUrl = normalizeExternalUrl(row.openalex_url) || "";

  return {
    id: row.id,
    name: displayName,
    avatarUrl,
    avatarSource: sourceAvatarUrl ? "source" : "generated",
    currentAffiliationId: row.current_affiliation_id || "",
    currentAffiliation: row.current_affiliation_name || "",
    roleTitle: row.role_title || "",
    researchAreaIds: splitListString(row.research_area_ids),
    researchAreas: splitListString(row.research_areas),
    scholarUrl,
    websiteUrl,
    twitterHandle: twitterHandle || "",
    twitterUrl: twitterUrl || "",
    notableContributions: splitListString(row.notable_papers_or_contributions),
    hIndex: Number(row.h_index) || 0,
    citationCount: Number(row.citation_count) || 0,
    influenceScore: Number(row.influence_score) || 0,
    previousAffiliationIds: splitListString(row.previous_affiliation_ids),
    previousAffiliations: splitListString(row.previous_affiliations),
    educationIds: splitListString(row.education_ids),
    education: splitListString(row.education),
    openAlexId: row.openalex_id || "",
    openAlexUrl,
    lastVerifiedAt: row.last_verified_at || "",
    lastEnrichedAt: row.last_enriched_at || "",
    sourceUpdatedAt: row.source_updated_at || "",
    linkHealth: {
      scholar: (row.scholar_status as LinkHealthStatus) || (scholarUrl ? "unknown" : "missing"),
      website: (row.website_status as LinkHealthStatus) || (websiteUrl ? "unknown" : "missing"),
      x: (row.x_status as LinkHealthStatus) || (twitterUrl ? "unknown" : "missing"),
    },
  };
}

function seedResearchersFromCsv() {
  const csvPath = getResearchersCsvPath();
  if (!csvPath) {
    console.warn("Researchers CSV not found. Expected researchers_top200.csv in public/ or dist/.");
    return { loaded: 0, path: null };
  }

  try {
    const csvText = fs.readFileSync(csvPath, "utf-8");
    const rows = parseCsvObjects(csvText);
    if (!rows.length) {
      console.warn("Researchers CSV is empty:", csvPath);
      return { loaded: 0, path: csvPath };
    }

    const upsert = db.prepare(`
      INSERT INTO researchers (
        id, name, avatar_url, current_affiliation_id, current_affiliation_name, role_title,
        research_area_ids, research_areas, google_scholar_url, personal_website_url,
        twitter_handle, x_url, notable_papers_or_contributions, h_index, citation_count, influence_score,
        previous_affiliation_ids, previous_affiliations, education_ids, education, source_updated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        avatar_url = CASE
          WHEN researchers.avatar_url IS NULL OR TRIM(researchers.avatar_url) = ''
          THEN excluded.avatar_url
          ELSE researchers.avatar_url
        END,
        current_affiliation_id = COALESCE(NULLIF(excluded.current_affiliation_id, ''), researchers.current_affiliation_id),
        current_affiliation_name = COALESCE(NULLIF(excluded.current_affiliation_name, ''), researchers.current_affiliation_name),
        role_title = COALESCE(NULLIF(excluded.role_title, ''), researchers.role_title),
        research_area_ids = COALESCE(NULLIF(excluded.research_area_ids, ''), researchers.research_area_ids),
        research_areas = COALESCE(NULLIF(excluded.research_areas, ''), researchers.research_areas),
        google_scholar_url = COALESCE(NULLIF(excluded.google_scholar_url, ''), researchers.google_scholar_url),
        personal_website_url = COALESCE(NULLIF(excluded.personal_website_url, ''), researchers.personal_website_url),
        twitter_handle = COALESCE(NULLIF(excluded.twitter_handle, ''), researchers.twitter_handle),
        x_url = COALESCE(NULLIF(excluded.x_url, ''), researchers.x_url),
        notable_papers_or_contributions = COALESCE(NULLIF(excluded.notable_papers_or_contributions, ''), researchers.notable_papers_or_contributions),
        h_index = MAX(researchers.h_index, excluded.h_index),
        citation_count = MAX(researchers.citation_count, excluded.citation_count),
        influence_score = MAX(researchers.influence_score, excluded.influence_score),
        previous_affiliation_ids = COALESCE(NULLIF(excluded.previous_affiliation_ids, ''), researchers.previous_affiliation_ids),
        previous_affiliations = COALESCE(NULLIF(excluded.previous_affiliations, ''), researchers.previous_affiliations),
        education_ids = COALESCE(NULLIF(excluded.education_ids, ''), researchers.education_ids),
        education = COALESCE(NULLIF(excluded.education, ''), researchers.education),
        source_updated_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `);

    const transaction = db.transaction((items: Record<string, string>[]) => {
      for (const row of items) {
        const name = row.name?.trim();
        if (!name) continue;
        const id = row.id?.trim() || `person:${name.toLowerCase().replace(/[^\w]+/g, "-")}`;
        const twitterHandle = extractTwitterHandle(row.twitter_handle);
        const avatarUrl = normalizeExternalUrl(row.avatar_url) || fallbackAvatarUrl(name);
        upsert.run(
          id,
          name,
          avatarUrl,
          row.current_affiliation_id?.trim() || null,
          row.current_affiliation_name?.trim() || null,
          row.role_title?.trim() || null,
          normalizeListString(row.research_area_ids) || null,
          normalizeListString(row.research_areas) || null,
          normalizeExternalUrl(row.google_scholar_url),
          normalizeExternalUrl(row.personal_website_url),
          twitterHandle || null,
          toTwitterUrl(twitterHandle),
          normalizeListString(row.notable_papers_or_contributions) || null,
          Math.floor(parseNumber(row.h_index)),
          Math.floor(parseNumber(row.citation_count)),
          parseNumber(row.influence_score),
          normalizeListString(row.previous_affiliation_ids) || null,
          normalizeListString(row.previous_affiliations) || null,
          normalizeListString(row.education_ids) || null,
          normalizeListString(row.education) || null,
        );
      }
    });

    transaction(rows);
    return { loaded: rows.length, path: csvPath };
  } catch (error) {
    console.error("Failed to seed researchers from CSV:", error);
    return { loaded: 0, path: csvPath, error: "seed-error" };
  }
}

async function probeUrlHealth(url?: string | null): Promise<{ status: LinkHealthStatus; finalUrl?: string; code?: number }> {
  if (!url) return { status: "missing" };
  const target = normalizeExternalUrl(url);
  if (!target) return { status: "broken" };

  const attempt = async (method: "HEAD" | "GET") => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(target, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "Geo-AI-App" },
      });
      return response;
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    const head = await attempt("HEAD");
    if (head.ok) return { status: "verified", finalUrl: head.url, code: head.status };
    if (head.status === 401 || head.status === 403) return { status: "restricted", finalUrl: head.url, code: head.status };
    if (head.status === 405 || head.status === 400) {
      const get = await attempt("GET");
      if (get.ok) return { status: "verified", finalUrl: get.url, code: get.status };
      if (get.status === 401 || get.status === 403) return { status: "restricted", finalUrl: get.url, code: get.status };
      return { status: "broken", finalUrl: get.url, code: get.status };
    }
    return { status: "broken", finalUrl: head.url, code: head.status };
  } catch {
    return { status: "unknown" };
  }
}

function isStaleDate(value?: string | null, staleMs: number = RESEARCHER_VERIFY_STALE_MS) {
  if (!value) return true;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return true;
  return Date.now() - ts > staleMs;
}

async function fetchOpenAlexAuthorProfile(name: string, affiliation?: string | null) {
  const cleanName = name?.trim();
  if (!cleanName) return null;

  const params = new URLSearchParams({
    search: cleanName,
    "per-page": "8",
  });
  if (process.env.OPENALEX_MAILTO) {
    params.set("mailto", process.env.OPENALEX_MAILTO);
  }

  try {
    const response = await fetch(`https://api.openalex.org/authors?${params.toString()}`, {
      headers: { "User-Agent": "Geo-AI-App" },
    });
    if (!response.ok) return null;

    const payload = await response.json();
    const results = Array.isArray(payload?.results) ? payload.results : [];
    if (!results.length) return null;

    const normalize = (value?: string | null) => (value || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim();
    const normalizedName = normalize(cleanName);
    const normalizedAffiliation = normalize(affiliation);

    const scored = results.map((entry: any) => {
      const candidateName = normalize(entry?.display_name);
      const institutions = Array.isArray(entry?.last_known_institutions)
        ? entry.last_known_institutions.map((inst: any) => normalize(inst?.display_name))
        : [];
      let score = 0;
      if (candidateName === normalizedName) score += 120;
      else if (candidateName.startsWith(normalizedName) || normalizedName.startsWith(candidateName)) score += 70;
      else if (candidateName.includes(normalizedName) || normalizedName.includes(candidateName)) score += 40;
      if (normalizedAffiliation && institutions.some((inst: string) => inst && (inst.includes(normalizedAffiliation) || normalizedAffiliation.includes(inst)))) {
        score += 35;
      }
      score += Math.min(20, Math.floor((Number(entry?.works_count) || 0) / 200));

      return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score || (Number(b.entry?.cited_by_count) || 0) - (Number(a.entry?.cited_by_count) || 0));
    const best = scored[0];
    if (!best || best.score < 40) return null;

    const candidate = best.entry;
    const openalexId = typeof candidate?.id === "string" ? candidate.id : null;
    const affiliationName = Array.isArray(candidate?.last_known_institutions)
      ? candidate.last_known_institutions[0]?.display_name || null
      : null;

    return {
      openalexId,
      openalexUrl: openalexId || null,
      citationCount: Number(candidate?.cited_by_count) || 0,
      hIndex: Number(candidate?.summary_stats?.h_index) || 0,
      affiliationName,
      twitterHandle: extractTwitterHandle(candidate?.ids?.twitter || ""),
    };
  } catch {
    return null;
  }
}

async function refreshResearchersDataset(
  { full = false, limit }: { full?: boolean; limit?: number } = {},
) {
  const parsedLimit = Number.isFinite(limit) && Number(limit) > 0
    ? Math.min(600, Math.floor(Number(limit)))
    : null;

  const sql = full
    ? `
        SELECT *
        FROM researchers
        ORDER BY influence_score DESC, citation_count DESC, name ASC
        ${parsedLimit ? `LIMIT ${parsedLimit}` : ""}
      `
    : `
        SELECT *
        FROM researchers
        WHERE last_verified_at IS NULL OR datetime(last_verified_at) < datetime('now', '-7 days')
        ORDER BY influence_score DESC, citation_count DESC, name ASC
        LIMIT ${parsedLimit || 120}
      `;

  const rows = db.prepare(sql).all() as any[];

  const update = db.prepare(`
    UPDATE researchers SET
      avatar_url = ?,
      google_scholar_url = COALESCE(?, google_scholar_url),
      personal_website_url = COALESCE(?, personal_website_url),
      twitter_handle = COALESCE(?, twitter_handle),
      x_url = COALESCE(?, x_url),
      current_affiliation_name = COALESCE(?, current_affiliation_name),
      citation_count = MAX(citation_count, ?),
      h_index = MAX(h_index, ?),
      openalex_id = COALESCE(?, openalex_id),
      openalex_url = COALESCE(?, openalex_url),
      scholar_status = ?,
      website_status = ?,
      x_status = ?,
      last_verified_at = ?,
      last_enriched_at = CASE WHEN ? = 1 THEN ? ELSE last_enriched_at END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  let verifiedScholar = 0;
  let verifiedWebsites = 0;
  let verifiedX = 0;
  let enrichedCount = 0;
  let avatarBackfilled = 0;
  let discoveredX = 0;
  let overrideX = 0;
  const overrides = loadResearcherXOverrides();
  const discoveryCache = new Map<string, string | null>();
  let discoveryBudget = full ? 220 : 80;

  for (const row of rows) {
    const scholarUrl = normalizeExternalUrl(row.google_scholar_url);
    const websiteUrl = normalizeExternalUrl(row.personal_website_url);
    let twitterHandle = extractTwitterHandle(row.twitter_handle || row.x_url);
    let xUrl = toTwitterUrl(twitterHandle) || normalizeExternalUrl(row.x_url);

    if (!twitterHandle) {
      const nameKey = normalizeComparableText(row.name);
      const override = overrides.byId.get(row.id) || (nameKey ? overrides.byName.get(nameKey) : undefined);
      if (override) {
        twitterHandle = override.twitterHandle;
        xUrl = override.xUrl;
        overrideX += 1;
      }
    }

    const needsEnrich =
      full ||
      isStaleDate(row.last_enriched_at, RESEARCHER_ENRICH_STALE_MS) ||
      !row.openalex_id ||
      !row.current_affiliation_name;

    let openAlex: Awaited<ReturnType<typeof fetchOpenAlexAuthorProfile>> | null = null;
    if (needsEnrich) {
      openAlex = await fetchOpenAlexAuthorProfile(row.name, row.current_affiliation_name);
      if (openAlex) {
        enrichedCount += 1;
        if (!twitterHandle && openAlex.twitterHandle) {
          twitterHandle = openAlex.twitterHandle;
          xUrl = toTwitterUrl(twitterHandle);
        }
      }
    }

    if (!twitterHandle && needsEnrich && discoveryBudget > 0) {
      const discoverKey = `${normalizeComparableText(row.name)}|${normalizeComparableText(row.current_affiliation_name)}`;
      let discoveredHandle = discoveryCache.get(discoverKey);
      if (discoveredHandle === undefined) {
        const discovered = await discoverTwitterHandleForResearcher({
          name: row.name,
          affiliation: row.current_affiliation_name || openAlex?.affiliationName || "",
          websiteUrl,
          scholarUrl,
        });
        discoveredHandle = discovered?.handle || null;
        discoveryCache.set(discoverKey, discoveredHandle);
        discoveryBudget -= 1;
      }
      if (discoveredHandle) {
        twitterHandle = discoveredHandle;
        xUrl = toTwitterUrl(twitterHandle);
        discoveredX += 1;
      }
    }

    const [scholarProbe, websiteProbe, xProbe] = await Promise.all([
      probeUrlHealth(scholarUrl),
      probeUrlHealth(websiteUrl),
      probeUrlHealth(xUrl),
    ]);

    if (scholarProbe.status === "verified") verifiedScholar += 1;
    if (websiteProbe.status === "verified") verifiedWebsites += 1;
    if (xProbe.status === "verified") verifiedX += 1;

    const sourceAvatarUrl = normalizeExternalUrl(row.avatar_url);
    const avatarUrl = sourceAvatarUrl || fallbackAvatarUrl(row.name || row.id);
    if (!sourceAvatarUrl) {
      avatarBackfilled += 1;
    }
    const nowIso = new Date().toISOString();
    update.run(
      avatarUrl,
      scholarUrl,
      websiteUrl,
      twitterHandle,
      xUrl,
      row.current_affiliation_name || openAlex?.affiliationName || null,
      Math.max(Number(row.citation_count) || 0, openAlex?.citationCount || 0),
      Math.max(Number(row.h_index) || 0, openAlex?.hIndex || 0),
      openAlex?.openalexId || null,
      openAlex?.openalexUrl || null,
      scholarProbe.status,
      websiteProbe.status,
      xProbe.status,
      nowIso,
      needsEnrich ? 1 : 0,
      nowIso,
      row.id,
    );

    await delay(openAlex ? 180 : 60);
  }

  return {
    processed: rows.length,
    enrichedCount,
    discoveredX,
    overrideX,
    overridesPath: overrides.path,
    verifiedScholar,
    verifiedWebsites,
    verifiedX,
    avatarBackfilled,
    limit: parsedLimit,
    full,
  };
}

async function fetchGitHubSearch(query: string, limit: number = 20) {
  const tokens = getGitHubTokenCandidates();
  let tokenIndex = 0;
  const headers: any = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "Geo-AI-App"
  };
  if (tokens[tokenIndex]) {
    headers["Authorization"] = `Bearer ${tokens[tokenIndex]}`;
  }

  let allItems: any[] = [];
  let page = 1;
  const perPage = 100; // Always request max per page

  try {
    console.log(`Starting GitHub search for: "${query}" (limit: ${limit})`);
    while (allItems.length < limit) {
      // Ensure query is properly formatted for GitHub Search API
      // Replace spaces with + for the URL but encode the rest
      const formattedQuery = query.trim().replace(/\s+/g, '+');
      const url = `https://api.github.com/search/repositories?q=${formattedQuery}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;
      const response = await fetch(url, { headers });
      
      if (response.status === 401 && headers["Authorization"]) {
        if (tokenIndex + 1 < tokens.length) {
          tokenIndex += 1;
          headers["Authorization"] = `Bearer ${tokens[tokenIndex]}`;
          console.warn("GitHub Search 401 Unauthorized. Retrying with backup token...");
        } else {
          console.warn("GitHub Search 401 Unauthorized. Retrying without token...");
          delete headers["Authorization"];
        }
        continue; 
      }

      if (!response.ok) {
        if (response.status === 403) {
          const isRateLimit = response.headers.get("x-ratelimit-remaining") === "0";
          if (isRateLimit) {
            if (headers["Authorization"] && tokenIndex + 1 < tokens.length) {
              tokenIndex += 1;
              headers["Authorization"] = `Bearer ${tokens[tokenIndex]}`;
              console.warn("GitHub Search token rate-limited. Switching to backup token...");
              continue;
            }
            console.error(`GitHub Search Rate Limit Hit at page ${page}. Collected ${allItems.length} items so far.`);
            break;
          }
        }
        if (response.status === 422) {
          try {
            const errorBody = await response.json();
            console.error(`GitHub Search API 422 Unprocessable Entity for query "${query}":`, errorBody);
          } catch (e) {
            console.error(`GitHub Search API 422 Unprocessable Entity for query "${query}" (could not parse error body)`);
          }
          // If page 1 fails with 422, the query is likely invalid.
          if (page === 1) return { error: 'invalid-query', status: 422 };
          break;
        }
        console.error(`GitHub Search API Error: ${response.status} ${response.statusText}`);
        break;
      }
      
      const data = await response.json();
      if (!data.items || data.items.length === 0) {
        console.log(`No more items found at page ${page}.`);
        break;
      }
      
      allItems = [...allItems, ...data.items];
      console.log(`Page ${page}: Added ${data.items.length} items. Total: ${allItems.length}`);
      
      if (data.items.length < perPage) break;
      page++;
      
      if (page > 10) break; 
      await delay(headers["Authorization"] ? 200 : 2000); // Be very polite if no token
    }
    return { data: allItems.slice(0, limit) };
  } catch (e) {
    console.error("GitHub Search Fetch Error:", e);
    return { error: 'fetch-error' };
  }
}

const MAX_DISCOVER_LIMIT = 1000;

async function fetchGitHubGraphQL(owner: string, repo: string) {
  const tokens = getGitHubTokenCandidates();
  if (tokens.length === 0) {
    return { error: 'no-token' };
  }

  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        stargazerCount
        description
        createdAt
        updatedAt
        pushedAt
        defaultBranchRef { name }
        primaryLanguage { name }
        licenseInfo { spdxId }
        repositoryTopics(first: 10) { nodes { topic { name } } }
        releases(last: 1) {
          nodes {
            tagName
            publishedAt
          }
        }
        mentionableUsers(first: 10) {
          nodes {
            login
            name
            avatarUrl
          }
        }
        owner {
          __typename
          login
          avatarUrl
          ... on Organization {
            name
            websiteUrl
          }
          ... on User {
            name
            websiteUrl
          }
        }
      }
    }
  `;

  let lastError: any = { error: 'auth-error' };
  for (const token of tokens) {
    try {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Geo-AI-App"
        },
        body: JSON.stringify({ query, variables: { owner, name: repo } })
      });

      if (!response.ok) {
        const isRateLimit = response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
        if (response.status === 401 || isRateLimit) {
          lastError = { error: isRateLimit ? 'rate-limit' : 'auth-error' };
          continue;
        }
        return { error: 'api-error', status: response.status };
      }

      const result = await response.json();
      if (result.errors) {
        console.error("GraphQL Errors:", result.errors);
        return { error: 'graphql-error', details: result.errors };
      }

      const repoData = result.data.repository;
      if (!repoData) return { error: 'not-found' };

      return {
        data: {
        stars: repoData.stargazerCount,
        description: repoData.description,
        first_release: repoData.createdAt,
        language: repoData.primaryLanguage?.name || "Unknown",
        license: repoData.licenseInfo?.spdxId || "Custom",
        topics: repoData.repositoryTopics.nodes.map((n: any) => n.topic.name),
        latest_version: repoData.releases.nodes[0]?.tagName || null,
        latest_release_date: repoData.releases.nodes[0]?.publishedAt || null,
        repo_pushed_at: repoData.pushedAt || repoData.updatedAt || null,
        project_logo_url: repoData.owner?.avatarUrl || null,
        maintainers: repoData.mentionableUsers.nodes.map((u: any) => ({
          github_handle: u.login,
          name: u.name || u.login,
            avatar_url: u.avatarUrl
          })),
          org: repoData.owner?.login
            ? {
                name: repoData.owner.name || repoData.owner.login,
                website: repoData.owner.websiteUrl || null
              }
            : null
        }
      };
    } catch (err) {
      console.error("GraphQL fetch error:", err);
      lastError = { error: 'fetch-error' };
    }
  }
  return lastError;
}

async function fetchPyPIDependencies(packageName: string) {
  try {
    const response = await fetch(`https://pypi.org/pypi/${packageName}/json`);
    if (!response.ok) return [];
    const data = await response.json();
    const requires = data.info.requires_dist || [];
    // Extract package names from requirements strings like "torch (>=2.0)"
    return requires.map((r: string) => r.split(/[^\w-]/)[0].toLowerCase());
  } catch (e) {
    return [];
  }
}

async function fetchNpmDependencies(packageName: string) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
    if (!response.ok) return [];
    const data = await response.json();
    return Object.keys(data.dependencies || {});
  } catch (e) {
    return [];
  }
}

async function fetchHuggingFaceData(owner: string, repo: string) {
  try {
    const response = await fetch(`https://huggingface.co/api/models/${owner}/${repo}`);
    if (!response.ok) return null;
    const data = await response.json();
    return {
      stars: data.likes,
      downloads: data.downloads,
      tags: data.tags,
      lastModified: data.lastModified
    };
  } catch (e) {
    return null;
  }
}

async function fetchGitHubData(githubUrl: string) {
  try {
    const match = githubUrl.match(/github\.com\/([^/]+)\/([^/ \n?#]+)/);
    if (!match) {
      console.warn(`Invalid GitHub URL: ${githubUrl}`);
      return { error: 'invalid-url' };
    }
    let [_, owner, repo] = match;
    if (repo.endsWith('/')) repo = repo.slice(0, -1);
    
    const headers: any = {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "Geo-AI-App"
    };
    
    const tokens = getGitHubTokenCandidates();
    let tokenIndex = 0;
    if (tokens[tokenIndex]) {
      headers["Authorization"] = `Bearer ${tokens[tokenIndex]}`;
    }

    let response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });

    if (response.status === 401 && headers["Authorization"]) {
      if (tokenIndex + 1 < tokens.length) {
        tokenIndex += 1;
        headers["Authorization"] = `Bearer ${tokens[tokenIndex]}`;
        console.warn(`GitHub API 401 Unauthorized for ${owner}/${repo}. Retrying with backup token...`);
      } else {
        console.warn(`GitHub API 401 Unauthorized for ${owner}/${repo}. Retrying without token...`);
        delete headers["Authorization"];
      }
      response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    }
    
    if (!response.ok) {
      const errorBody = await response.text();
      const isRateLimit = response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
      const resetTime = isRateLimit ? new Date(Number(response.headers.get("x-ratelimit-reset")) * 1000) : null;

      if (isRateLimit && headers["Authorization"] && tokenIndex + 1 < tokens.length) {
        tokenIndex += 1;
        headers["Authorization"] = `Bearer ${tokens[tokenIndex]}`;
        response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
        if (response.ok) {
          const data = await response.json();
          return {
            data: {
              stars: data.stargazers_count,
              description: data.description,
              first_release: data.created_at,
              language: data.language,
              latest_version: null,
              latest_release_date: null,
              repo_pushed_at: data.pushed_at || data.updated_at || null,
              project_logo_url: data.owner?.avatar_url || null,
              license: data.license?.spdx_id || "Custom",
              org: data.owner?.login
                ? {
                    name: data.owner.login,
                    website: null
                  }
                : null
            }
          };
        }
      }

      if (isRateLimit) {
        const retryAfter = response.headers.get("retry-after");
        const resetTime = retryAfter 
          ? new Date(Date.now() + Number(retryAfter) * 1000)
          : new Date(Number(response.headers.get("x-ratelimit-reset")) * 1000);
          
        console.error(`GitHub Rate Limit Exceeded for ${owner}/${repo}. Resets at: ${resetTime?.toISOString()}`);
        return { error: 'rate-limit', resetTime };
      }

      if (response.status === 401) {
        console.error(`GitHub API Error for ${owner}/${repo}: 401 Unauthorized. Your GITHUB_TOKEN is likely invalid or expired.`);
        return { error: 'auth-error' };
      }

      console.error(`GitHub API Error for ${owner}/${repo}: ${response.status} ${response.statusText}`, errorBody);
      return { error: 'api-error', status: response.status };
    }
    
    const data = await response.json();
    
    // Fetch latest release/tag only if we have a token or plenty of requests left
    let latestRelease = null;
    let latestTagName: string | null = null;
    const remaining = Number(response.headers.get("x-ratelimit-remaining") || "60");
    
    if (remaining > 10) {
      let releaseResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, { headers });
      
      if (releaseResponse.status === 401 && headers["Authorization"]) {
        if (tokenIndex + 1 < tokens.length) {
          tokenIndex += 1;
          headers["Authorization"] = `Bearer ${tokens[tokenIndex]}`;
        } else {
          delete headers["Authorization"];
        }
        releaseResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, { headers });
      }

      if (releaseResponse.ok) {
        latestRelease = await releaseResponse.json();
      } else {
        let tagsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=1`, { headers });
        if (tagsResponse.status === 401 && headers["Authorization"]) {
          if (tokenIndex + 1 < tokens.length) {
            tokenIndex += 1;
            headers["Authorization"] = `Bearer ${tokens[tokenIndex]}`;
          } else {
            delete headers["Authorization"];
          }
          tagsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=1`, { headers });
        }
        if (tagsResponse.ok) {
          const tagsData = await tagsResponse.json();
          latestTagName = Array.isArray(tagsData) && tagsData[0]?.name ? tagsData[0].name : null;
        }
      }
    }

    return {
      data: {
        stars: data.stargazers_count,
        description: data.description,
        first_release: data.created_at,
        language: data.language,
        latest_version: latestRelease?.tag_name || latestTagName,
        latest_release_date: latestRelease?.published_at || null,
        repo_pushed_at: data.pushed_at || data.updated_at || null,
        project_logo_url: data.owner?.avatar_url || null,
        license: data.license?.spdx_id || "Custom",
        org: data.owner?.login
          ? {
              name: data.owner.login,
              website: null
            }
          : null
      }
    };
  } catch (err) {
    console.error("GitHub fetch error:", err);
    return { error: 'fetch-error' };
  }
}

export function createApiApp() {
  const app = express();

  app.use(express.json());

  const seededResearchers = seedResearchersFromCsv();
  if (seededResearchers.loaded > 0) {
    console.log(`Researchers dataset seeded (${seededResearchers.loaded}) from ${seededResearchers.path}`);
  }

  // API Routes
  app.get("/api/researchers", (req, res) => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(5000, Math.floor(rawLimit)) : null;
    const sql = `
      SELECT *
      FROM researchers
      ORDER BY influence_score DESC, citation_count DESC, name ASC
      ${limit ? "LIMIT ?" : ""}
    `;
    const statement = db.prepare(sql);
    const researchers = limit ? statement.all(limit) : statement.all();
    res.json(researchers.map(mapResearcherRow));
  });

  app.post("/api/researchers/refresh", async (req, res) => {
    if (isVercelRuntime) {
      return res.status(503).json({
        success: false,
        error: "read-only-deployment",
        message: readOnlyDeploymentMessage("Researcher refresh"),
      });
    }

    if (isResearcherRefreshInProgress) {
      return res.json({
        success: true,
        message: "Researcher refresh already in progress.",
        processed: 0,
      });
    }

    const full = req.query.full === "1" || req.body?.full === true;
    const rawLimit = Number(req.query.limit ?? req.body?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;
    isResearcherRefreshInProgress = true;
    try {
      const result = await refreshResearchersDataset({ full, limit });
      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      console.error("Researcher refresh failed:", error);
      res.status(500).json({ success: false, error: "researcher-refresh-failed" });
    } finally {
      isResearcherRefreshInProgress = false;
    }
  });

  app.get("/api/researchers/quality", (_req, res) => {
    const quality = getResearcherQualityStats();
    res.json(quality);
  });

  app.get("/api/export/options", (_req, res) => {
    const tables = Object.entries(EXPORT_TABLES).map(([key, value]) => ({
      key,
      label: value.label,
      description: value.description,
    }));
    res.json({
      formats: ["csv", "tsv", "json"],
      tables,
      recommended: {
        forSpreadsheets: ["csv", "tsv"],
        forPipelines: ["json", "csv"],
      },
    });
  });

  app.get("/api/export", (req, res) => {
    const table = String(req.query.table || "researchers").trim().toLowerCase();
    const format = String(req.query.format || "csv").trim().toLowerCase();

    const config = EXPORT_TABLES[table];
    if (!config) {
      return res.status(400).json({
        error: "invalid-table",
        message: `Unsupported table: ${table}`,
        availableTables: Object.keys(EXPORT_TABLES),
      });
    }

    if (!["csv", "tsv", "json"].includes(format)) {
      return res.status(400).json({
        error: "invalid-format",
        message: `Unsupported format: ${format}`,
        availableFormats: ["csv", "tsv", "json"],
      });
    }

    const rows = db.prepare(config.sql).all() as Record<string, any>[];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeTable = table.replace(/[^\w-]+/g, "_");

    if (format === "json") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeTable}-${stamp}.json"`);
      return res.send(JSON.stringify(rows, null, 2));
    }

    const delimiter = format === "tsv" ? "\t" : ",";
    const text = toDelimitedText(rows, delimiter);
    const contentType = format === "tsv" ? "text/tab-separated-values" : "text/csv";
    res.setHeader("Content-Type", `${contentType}; charset=utf-8`);
    res.setHeader("Content-Disposition", `attachment; filename="${safeTable}-${stamp}.${format}"`);
    return res.send(text);
  });

  app.get("/api/geo-space/payload", (req, res) => {
    const asInt = (value: unknown, fallback: number, max: number) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.max(1, Math.min(max, Math.floor(parsed)));
    };

    try {
      const maxProjects = asInt(req.query.maxProjects, 1000, 10000);
      const maxPeople = asInt(req.query.maxPeople, 2000, 10000);
      const personCsvPath = String(req.query.personCsvPath || "Person.csv");
      const paperCsvPath = String(req.query.paperCsvPath || "Paper.csv");
      const projectCsvPath = String(req.query.projectCsvPath || "Projects.csv");

      const payload = buildGeoSpaceBundleFromDb(db as any, {
        dbPath: path.resolve(process.cwd(), "geo.db"),
        maxProjects,
        maxPeople,
        personCsvPath,
        paperCsvPath,
        projectCsvPath,
      });

      res.json(payload);
    } catch (error) {
      console.error("Geo Space payload build failed:", error);
      res.status(500).json({ error: "geo-space-payload-failed" });
    }
  });

  app.post("/api/geo-space/export", (req, res) => {
    if (isVercelRuntime) {
      return res.status(503).json({
        success: false,
        error: "read-only-deployment",
        message: readOnlyDeploymentMessage("GEO draft export"),
      });
    }

    const asInt = (value: unknown, fallback: number, max: number) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.max(1, Math.min(max, Math.floor(parsed)));
    };

    try {
      const maxProjects = asInt(req.query.maxProjects ?? req.body?.maxProjects, 1000, 10000);
      const maxPeople = asInt(req.query.maxPeople ?? req.body?.maxPeople, 2000, 10000);
      const outDirRaw = String(req.query.outDir ?? req.body?.outDir ?? "geo_space_payload").trim() || "geo_space_payload";
      const writeSheetCsv = (req.query.writeSheetCsv ?? req.body?.writeSheetCsv ?? "1") !== "0";
      const writeDemoLayout = (req.query.writeDemoLayout ?? req.body?.writeDemoLayout ?? "1") !== "0";
      const personCsvPath = String(req.query.personCsvPath ?? req.body?.personCsvPath ?? "Person.csv");
      const paperCsvPath = String(req.query.paperCsvPath ?? req.body?.paperCsvPath ?? "Paper.csv");
      const projectCsvPath = String(req.query.projectCsvPath ?? req.body?.projectCsvPath ?? "Projects.csv");

      const payload = buildGeoSpaceBundleFromDb(db as any, {
        dbPath: path.resolve(process.cwd(), "geo.db"),
        maxProjects,
        maxPeople,
        personCsvPath,
        paperCsvPath,
        projectCsvPath,
      });

      const outDir = path.resolve(process.cwd(), outDirRaw);
      const files = writeGeoSpaceBundleFiles(payload, { outDir, writeSheetCsv, writeDemoLayout });

      res.json({
        success: true,
        generatedAt: payload.generated_at,
        counts: payload.meta.counts,
        outDir,
        files,
      });
    } catch (error) {
      console.error("Geo Space export failed:", error);
      res.status(500).json({ error: "geo-space-export-failed" });
    }
  });

  app.get("/api/insights/status", async (req, res) => {
    const includeRateLimits = req.query.rateLimits !== "0";
    const rawSample = Number(req.query.sample || 3);
    const tokenSampleSize = Number.isFinite(rawSample) && rawSample > 0
      ? Math.min(10, Math.floor(rawSample))
      : 3;

    try {
      const status = await buildInsightsStatus({ includeRateLimits, tokenSampleSize });
      res.json(status);
    } catch (error) {
      console.error("Insights status failed:", error);
      res.status(500).json({ error: "insights-status-failed" });
    }
  });

  app.get("/api/projects", (req, res) => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(5000, Math.floor(rawLimit)) : null;
    const rawCategory = String(req.query.category || "").trim().toLowerCase();
    const category = rawCategory && rawCategory !== "all" ? rawCategory : "";
    const maintained = req.query.maintained === "1" || req.query.maintained === "true";

    const whereParts: string[] = [];
    const params: Array<string | number> = [];
    if (category) {
      whereParts.push("LOWER(p.category) = ?");
      params.push(category);
    }
    if (maintained) {
      whereParts.push("p.is_maintained = 1");
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    const limitClause = limit ? "LIMIT ?" : "";
    if (limit) params.push(limit);

    const projects = db.prepare(`
      SELECT p.*, c.name as org_name, c.website as org_website
      FROM projects p 
      LEFT JOIN companies c ON p.org_id = c.id
      ${whereClause}
      ORDER BY p.stars DESC
      ${limitClause}
    `).all(...params);
    res.json(projects);
  });

  app.post("/api/sync-github", async (req, res) => {
    if (isVercelRuntime) {
      return res.status(503).json({
        success: false,
        error: "read-only-deployment",
        message: readOnlyDeploymentMessage("GitHub sync"),
      });
    }

    if (isBatchSyncInProgress) {
      return res.json({
        success: true,
        updatedCount: 0,
        totalCount: 0,
        message: "Sync already in progress."
      });
    }

    isBatchSyncInProgress = true;
    try {
      const forceFull = req.query.full === "1" || req.body?.full === true;
      const projects = forceFull
        ? db.prepare(`
            SELECT id, github_url, language, category
            FROM projects
            ORDER BY
              CASE
                WHEN first_release IS NULL OR first_release = '' THEN 0
                WHEN latest_version IS NULL OR latest_version = '' THEN 1
                WHEN latest_release_date IS NULL OR latest_release_date = '' THEN 2
                WHEN org_id IS NULL THEN 3
                ELSE 4
              END ASC,
              stars DESC
          `).all()
        : db.prepare(`
            SELECT id, github_url, language, category
            FROM projects 
            WHERE
              first_release IS NULL OR first_release = '' OR
              latest_version IS NULL OR latest_version = '' OR
              latest_release_date IS NULL OR latest_release_date = '' OR
              org_id IS NULL OR
              last_updated IS NULL OR last_updated < datetime('now', '-6 hours')
            ORDER BY
              CASE
                WHEN first_release IS NULL OR first_release = '' THEN 0
                WHEN latest_version IS NULL OR latest_version = '' THEN 1
                WHEN latest_release_date IS NULL OR latest_release_date = '' THEN 2
                WHEN org_id IS NULL THEN 3
                ELSE 4
              END ASC,
              last_updated ASC
            LIMIT 60
          `).all();
      
      if (projects.length === 0) {
        return res.json({
          success: true,
          updatedCount: 0,
          totalCount: 0,
          message: forceFull ? "No projects found." : "All projects are up to date."
        });
      }

      let updatedCount = 0;
      let authError = false;
      let rateLimitHit = false;
      let resetTime: any = null;
      let skipGraphQL = getGitHubTokenCandidates().length === 0;

      const initialCheck = await fetch("https://api.github.com/rate_limit", {
        headers: { "User-Agent": "Geo-AI-App" }
      });
      if (initialCheck.ok) {
        const rlData = await initialCheck.json();
        if (rlData.resources.core.remaining === 0) {
          console.warn("GitHub Sync: Already at rate limit. Skipping batch.");
          return res.json({ 
            success: true, 
            updatedCount: 0, 
            totalCount: projects.length, 
            rateLimitHit: true, 
            resetTime: new Date(rlData.resources.core.reset * 1000).toISOString() 
          });
        }
      }

      const hasAnyToken = getGitHubTokenCandidates().length > 0;

      for (const project of projects as any) {
        if (rateLimitHit) break;

        console.log(`Syncing ${project.id} from ${project.github_url}...`);
        
        const match = project.github_url.match(/github\.com\/([^/]+)\/([^/ \n?#]+)/);
        let result: any = { error: 'invalid-url' };
        
        if (match) {
          let [_, owner, repo] = match;
          if (repo.endsWith('/')) repo = repo.slice(0, -1);
          
          if (!skipGraphQL) {
            const gqlResult = await fetchGitHubGraphQL(owner, repo);
            if (gqlResult.data) {
              result = gqlResult;
              // Fill gaps in GraphQL payload with REST data when needed
              const needsRestFill =
                !gqlResult.data.latest_version ||
                !gqlResult.data.repo_pushed_at ||
                !gqlResult.data.first_release;
              if (needsRestFill) {
                const restResult = await fetchGitHubData(project.github_url);
                if (restResult.data) {
                  result = { data: mergeDefined(restResult.data as any, gqlResult.data as any) };
                }
              }
            } else if (gqlResult.error === 'auth-error') {
              console.warn("GraphQL 401 Unauthorized. Skipping GraphQL for the rest of this sync.");
              skipGraphQL = true;
              authError = true;
              result = await fetchGitHubData(project.github_url);
            } else {
              result = await fetchGitHubData(project.github_url);
            }
          } else {
            result = await fetchGitHubData(project.github_url);
          }

          const projectName = repo.toLowerCase();
          let deps: string[] = [];
          try {
            if (project.language?.toLowerCase() === 'python') {
              deps = await fetchPyPIDependencies(projectName);
            } else if (['javascript', 'typescript'].includes(project.language?.toLowerCase())) {
              deps = await fetchNpmDependencies(projectName);
            }
          } catch (e) {
            console.warn(`Failed to fetch dependencies for ${projectName}`);
          }

          if (deps.length > 0) {
            for (const depName of deps) {
              const depProject = db.prepare("SELECT id FROM projects WHERE LOWER(name) = ? OR github_url LIKE ?").get(depName, `%/${depName}%`);
              if (depProject) {
                db.prepare("INSERT OR IGNORE INTO dependencies (from_project_id, to_project_id) VALUES (?, ?)").run(project.id, (depProject as any).id);
              }
            }
          }

          if (project.category === 'model' || project.category === 'dataset') {
            const hfData = await fetchHuggingFaceData(owner, repo);
            if (hfData) {
              db.prepare(`
                UPDATE projects SET 
                  stars = MAX(stars, ?),
                  description = description || ' (HF Downloads: ' || ? || ')'
                WHERE id = ?
              `).run(hfData.stars, hfData.downloads, project.id);
            }
          }
        }
        
        if (result.data) {
          const ghData = result.data;
          const orgId = upsertCompany(ghData.org);
          db.prepare(`
            UPDATE projects SET 
              stars = ?, 
              description = ?, 
              language = ?, 
              latest_version = COALESCE(?, latest_version), 
              latest_release_date = COALESCE(?, latest_release_date),
              repo_pushed_at = COALESCE(?, repo_pushed_at),
              project_logo_url = COALESCE(?, project_logo_url),
              license = ?,
              first_release = COALESCE(NULLIF(first_release, ''), ?),
              org_id = COALESCE(?, org_id),
              last_updated = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            ghData.stars, 
            ghData.description, 
            ghData.language, 
            ghData.latest_version || null, 
            ghData.latest_release_date || null,
            ghData.repo_pushed_at || null,
            ghData.project_logo_url || null,
            ghData.license,
            ghData.first_release || null,
            orgId,
            project.id
          );
          updatedCount++;
        } else {
          console.warn(`Failed to fetch data for ${project.id} from ${project.github_url}: ${result.error}`);
          if (result.error === 'rate-limit') {
            rateLimitHit = true;
            resetTime = result.resetTime;
            break;
          }
          if (result.error === 'auth-error') {
            authError = true;
          }
        }
        
        const waitTime = (!hasAnyToken || authError) ? 2500 : 300;
        await delay(waitTime);
      }

      return res.json({ 
        success: true, 
        updatedCount, 
        totalCount: projects.length, 
        forceFull,
        authError, 
        rateLimitHit,
        resetTime: resetTime instanceof Date ? resetTime.toISOString() : resetTime
      });
    } finally {
      isBatchSyncInProgress = false;
    }
  });

  app.post("/api/projects/:id/sync", async (req, res) => {
    if (isVercelRuntime) {
      return res.status(503).json({
        success: false,
        error: "read-only-deployment",
        message: readOnlyDeploymentMessage("Project sync"),
      });
    }

    const project = db.prepare("SELECT id, github_url FROM projects WHERE id = ?").get(req.params.id) as any;
    if (!project) return res.status(404).json({ error: "Project not found" });

    console.log(`Manually syncing ${project.id} from ${project.github_url}...`);
    const result = await fetchGitHubData(project.github_url);
    let mergedData = result.data ? { ...result.data } : null;
    
    const match = project.github_url.match(/github\.com\/([^/]+)\/([^/ \n?#]+)/);
    if (match) {
      let [_, owner, repo] = match;
      if (repo.endsWith('/')) repo = repo.slice(0, -1);
      
      const gqlResult = await fetchGitHubGraphQL(owner, repo);
      if (gqlResult.data) {
        mergedData = mergeDefined((mergedData || {}) as any, gqlResult.data as any);
        // Merge maintainers and topics if found via GraphQL
        if (gqlResult.data.maintainers) {
          for (const m of gqlResult.data.maintainers) {
            const personId = `person_${m.github_handle}`;
            db.prepare(`
              INSERT INTO people (id, name, github_handle, avatar_url) VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name=excluded.name, avatar_url=excluded.avatar_url
            `).run(personId, m.name, m.github_handle, m.avatar_url);
            db.prepare("INSERT OR IGNORE INTO maintainers (project_id, person_id) VALUES (?, ?)").run(project.id, personId);
          }
        }
        if (gqlResult.data.topics) {
          for (const t of gqlResult.data.topics) {
            db.prepare("INSERT OR IGNORE INTO topics (project_id, topic) VALUES (?, ?)").run(project.id, t);
          }
        }
      }
    }

    if (mergedData) {
      const ghData = mergedData as any;
      const orgId = upsertCompany(ghData.org);
      db.prepare(`
        UPDATE projects SET 
          stars = ?, 
          description = ?, 
          language = ?, 
          latest_version = COALESCE(?, latest_version), 
          latest_release_date = COALESCE(?, latest_release_date),
          repo_pushed_at = COALESCE(?, repo_pushed_at),
          project_logo_url = COALESCE(?, project_logo_url),
          license = ?,
          first_release = COALESCE(NULLIF(first_release, ''), ?),
          org_id = COALESCE(?, org_id),
          last_updated = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        ghData.stars, 
        ghData.description, 
        ghData.language, 
        ghData.latest_version, 
        ghData.latest_release_date,
        ghData.repo_pushed_at || null,
        ghData.project_logo_url || null,
        ghData.license,
        ghData.first_release || null,
        orgId,
        project.id
      );
      
      const updatedProject = db.prepare(`
        SELECT p.*, c.name as org_name, c.website as org_website
        FROM projects p 
        LEFT JOIN companies c ON p.org_id = c.id
        WHERE p.id = ?
      `).get(project.id);

      res.json({ success: true, project: updatedProject });
    } else {
      res.status(result.status || 500).json({ 
        error: result.error, 
        resetTime: result.resetTime?.toISOString() 
      });
    }
  });

  app.get("/api/projects/:id", (req, res) => {
    const project = db.prepare(`
      SELECT p.*, c.name as org_name, c.website as org_website
      FROM projects p 
      LEFT JOIN companies c ON p.org_id = c.id
      WHERE p.id = ?
    `).get(req.params.id);

    if (!project) return res.status(404).json({ error: "Project not found" });

    const deps = db.prepare(`
      SELECT p.id, p.name 
      FROM dependencies d
      JOIN projects p ON d.to_project_id = p.id
      WHERE d.from_project_id = ?
    `).all(req.params.id);

    const maintainers = db.prepare(`
      SELECT p.* 
      FROM maintainers m
      JOIN people p ON m.person_id = p.id
      WHERE m.project_id = ?
    `).all(req.params.id);

    const topics = db.prepare(`
      SELECT topic FROM topics WHERE project_id = ?
    `).all(req.params.id).map((t: any) => t.topic);

    res.json({ ...project, dependencies: deps, maintainers, topics });
  });

  app.get("/api/graph", (req, res) => {
    const nodes = db.prepare("SELECT id, name, category, stars FROM projects").all();
    const links = db.prepare("SELECT from_project_id as source, to_project_id as target FROM dependencies").all();
    res.json({ nodes, links });
  });

  app.post("/api/discover", async (req, res) => {
    if (isVercelRuntime) {
      return res.status(503).json({
        success: false,
        error: "read-only-deployment",
        message: readOnlyDeploymentMessage("Project discovery"),
      });
    }

    const query = typeof req.body?.query === "string" && req.body.query.trim()
      ? req.body.query.trim()
      : "topic:machine-learning stars:>1000";
    const requestedLimit = Number(req.body?.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(MAX_DISCOVER_LIMIT, Math.floor(requestedLimit)))
      : MAX_DISCOVER_LIMIT;
    console.log(`Discovering up to ${limit} projects with query: ${query}`);
    const result = await fetchGitHubSearch(query, limit);
    
    if (result.data) {
      const projects = result.data.map((repo: any) => {
        // Use owner/repo for ID to ensure uniqueness across different owners with same repo name
        const ownerRepo = repo.full_name.toLowerCase().replace(/[^\w]/g, '_');
        const org = repo.owner?.login
          ? {
              name: repo.owner.login,
              website: null
            }
          : null;
        return {
          id: `proj_${ownerRepo}`,
          name: repo.name,
          github_url: repo.html_url,
          stars: repo.stargazers_count,
          license: repo.license?.spdx_id || "Custom",
          language: repo.language || "Unknown",
          category: repo.topics?.includes('dataset') ? 'dataset' : (repo.topics?.includes('model') ? 'model' : 'library'),
          first_release: repo.created_at || null,
          latest_version: null,
          latest_release_date: null,
          repo_pushed_at: repo.pushed_at || repo.updated_at || null,
          project_logo_url: repo.owner?.avatar_url || null,
          org_id: upsertCompany(org),
          description: repo.description,
          is_maintained: !repo.archived
        };
      });

      let addedCount = 0;
      const transaction = db.transaction(() => {
        const insertProject = db.prepare(`
          INSERT INTO projects 
          (id, name, github_url, stars, license, language, category, first_release, latest_version, latest_release_date, repo_pushed_at, project_logo_url, org_id, description, is_maintained) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(github_url) DO UPDATE SET 
            stars=excluded.stars,
            description=excluded.description,
            language=COALESCE(excluded.language, projects.language),
            first_release=COALESCE(projects.first_release, excluded.first_release),
            latest_version=COALESCE(excluded.latest_version, projects.latest_version),
            latest_release_date=COALESCE(excluded.latest_release_date, projects.latest_release_date),
            repo_pushed_at=COALESCE(excluded.repo_pushed_at, projects.repo_pushed_at),
            project_logo_url=COALESCE(excluded.project_logo_url, projects.project_logo_url),
            org_id=COALESCE(excluded.org_id, projects.org_id),
            is_maintained=excluded.is_maintained
          ON CONFLICT(id) DO UPDATE SET
            stars=excluded.stars,
            description=excluded.description,
            language=COALESCE(excluded.language, projects.language),
            first_release=COALESCE(projects.first_release, excluded.first_release),
            latest_version=COALESCE(excluded.latest_version, projects.latest_version),
            latest_release_date=COALESCE(excluded.latest_release_date, projects.latest_release_date),
            repo_pushed_at=COALESCE(excluded.repo_pushed_at, projects.repo_pushed_at),
            project_logo_url=COALESCE(excluded.project_logo_url, projects.project_logo_url),
            org_id=COALESCE(excluded.org_id, projects.org_id),
            is_maintained=excluded.is_maintained
        `);
        
        projects.forEach((p: any) => {
          try {
            insertProject.run(
              p.id, p.name, p.github_url, p.stars, p.license, p.language, p.category,
              p.first_release, p.latest_version, p.latest_release_date, p.repo_pushed_at, p.project_logo_url, p.org_id,
              p.description, p.is_maintained ? 1 : 0
            );
            addedCount++;
          } catch (e) {
            console.error(`Failed to insert project ${p.id}:`, e);
          }
        });
      });
      
      try {
        transaction();
        res.json({ success: true, count: addedCount });
      } catch (e) {
        console.error("Transaction failed:", e);
        res.status(500).json({ error: "database-error" });
      }
    } else {
      const status = (result as any).status || 500;
      res.status(status).json({ error: result.error });
    }
  });

  app.post("/api/seed", async (req, res) => {
    if (isVercelRuntime) {
      return res.status(503).json({
        success: false,
        error: "read-only-deployment",
        message: readOnlyDeploymentMessage("Dataset seeding"),
      });
    }

    const { projects, companies, people, dependencies, maintainers, topics } = req.body;
    
    db.exec("PRAGMA foreign_keys = OFF;");

    try {
      const transaction = db.transaction(() => {
        if (companies) {
          const insertCompany = db.prepare(`
            INSERT INTO companies (id, name, website) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, website=excluded.website
          `);
          companies.forEach((c: any) => insertCompany.run(c.id, c.name, c.website));
        }
        if (people) {
          const insertPerson = db.prepare(`
            INSERT INTO people (id, name, github_handle, avatar_url) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, github_handle=excluded.github_handle, avatar_url=excluded.avatar_url
          `);
          people.forEach((p: any) => insertPerson.run(p.id, p.name, p.github_handle, p.avatar_url));
        }
        if (projects) {
          const insertProject = db.prepare(`
            INSERT INTO projects 
            (id, name, github_url, stars, license, language, category, first_release, latest_version, latest_release_date, repo_pushed_at, project_logo_url, is_maintained, org_id, description) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(github_url) DO UPDATE SET 
              id=excluded.id, name=excluded.name, stars=excluded.stars, 
              license=excluded.license, language=excluded.language, category=excluded.category, 
              first_release=excluded.first_release, latest_version=excluded.latest_version, 
              latest_release_date=excluded.latest_release_date, repo_pushed_at=excluded.repo_pushed_at,
              project_logo_url=COALESCE(excluded.project_logo_url, projects.project_logo_url),
              is_maintained=excluded.is_maintained, 
              org_id=excluded.org_id, description=excluded.description
          `);
          projects.forEach((p: any) => insertProject.run(
            p.id, p.name, p.github_url, p.stars, p.license, p.language, p.category, 
            p.first_release, p.latest_version, p.latest_release_date,
            p.repo_pushed_at || null, p.project_logo_url || null,
            p.is_maintained ? 1 : 0, p.org_id, p.description
          ));
        }
        if (dependencies) {
          const insertDep = db.prepare("INSERT OR IGNORE INTO dependencies (from_project_id, to_project_id) VALUES (?, ?)");
          dependencies.forEach((d: any) => insertDep.run(d.from, d.to));
        }
        if (maintainers) {
          const insertMaint = db.prepare("INSERT OR IGNORE INTO maintainers (project_id, person_id) VALUES (?, ?)");
          maintainers.forEach((m: any) => insertMaint.run(m.project_id, m.person_id));
        }
        if (topics) {
          const insertTopic = db.prepare("INSERT OR IGNORE INTO topics (project_id, topic) VALUES (?, ?)");
          topics.forEach((t: any) => insertTopic.run(t.project_id, t.topic));
        }
      });

      transaction();
      res.json({ success: true });
    } catch (error: any) {
      console.error("Seed error:", error);
      res.status(500).json({ error: error.message });
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  });

  return app;
}

async function startServer() {
  const app = createApiApp();
  const PORT = 3000;
  const HOST = process.env.HOST || "0.0.0.0";

  const sandboxNetworkDisabled = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
  if (sandboxNetworkDisabled) {
    console.warn("Network bind is disabled in this sandbox. Skipping HTTP server startup.");
    return;
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`Server running on http://localhost:${PORT}`);

    // Background metadata enrichment so the UI keeps filling in Meta fields over time.
    const triggerBackgroundSync = async (reason: string) => {
      if (isBatchSyncInProgress) return;
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/sync-github`, { method: "POST" });
        if (!response.ok) {
          console.warn(`Background sync (${reason}) failed with status ${response.status}`);
          return;
        }
        const payload = await response.json();
        if (payload.updatedCount > 0) {
          console.log(`Background sync (${reason}) updated ${payload.updatedCount} projects.`);
        }
      } catch (error) {
        console.warn(`Background sync (${reason}) failed:`, error);
      }
    };

    const triggerResearcherRefresh = async (reason: string, full = false) => {
      if (isResearcherRefreshInProgress) return;
      try {
        const endpoint = full
          ? `http://127.0.0.1:${PORT}/api/researchers/refresh?full=1`
          : `http://127.0.0.1:${PORT}/api/researchers/refresh`;
        const response = await fetch(endpoint, { method: "POST" });
        if (!response.ok) {
          console.warn(`Researchers refresh (${reason}) failed with status ${response.status}`);
          return;
        }
        const payload = await response.json();
        if (payload.processed > 0) {
          console.log(`Researchers refresh (${reason}) processed ${payload.processed} profiles.`);
        }
      } catch (error) {
        console.warn(`Researchers refresh (${reason}) failed:`, error);
      }
    };

    setTimeout(() => triggerBackgroundSync("startup"), 12000);
    setInterval(() => triggerBackgroundSync("interval"), 30 * 60 * 1000);
    setTimeout(() => triggerResearcherRefresh("startup"), 8000);
    setInterval(() => triggerResearcherRefresh("interval"), 6 * 60 * 60 * 1000);
  });

  server.on("error", (error: any) => {
    if (error?.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Set a different PORT and retry.`);
      process.exitCode = 1;
      return;
    }

    if (error?.code === "EPERM" || error?.code === "EACCES") {
      console.error(`Cannot bind ${HOST}:${PORT}. Check permissions or sandbox/network restrictions.`);
      process.exitCode = 1;
      return;
    }

    throw error;
  });
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  startServer();
}
