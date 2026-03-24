import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface GeoSpaceTopic {
  id: string;
  name: string;
  slug: string;
  description: string;
  usage_count: number;
  project_count: number;
  people_count: number;
}

export interface GeoSpaceMaintainer {
  id: string;
  name: string;
  github_handle: string;
  avatar_url: string;
}

export interface GeoSpaceDependency {
  id: string;
  name: string;
}

export interface GeoSpaceProject {
  id: string;
  name: string;
  description: string;
  web_url: string;
  avatar_url: string;
  topics: string[];
  maintainers: GeoSpaceMaintainer[];
  dependencies: GeoSpaceDependency[];
  organization: {
    id: string;
    name: string;
    website: string;
  };
  stats: {
    stars: number;
    language: string;
    license: string;
    category: string;
    maintained: boolean;
    last_activity_days: number | null;
  };
  release: {
    first_release: string;
    latest_version: string;
    latest_release_date: string;
    repo_pushed_at: string;
  };
  blocks: Array<{ type: "markdown"; markdown_content: string }>;
  text_blocks: Array<{ type: "markdown"; markdown_content: string }>;
}

export interface GeoSpacePerson {
  id: string;
  name: string;
  description: string;
  web_url: string;
  x: string;
  avatar_url: string;
  topics: string[];
  works_at: string;
  role: string;
  papers: string[];
  links: {
    x: string;
    website: string;
    scholar: string;
    openalex: string;
    github: string;
  };
  metrics: {
    citation_count: number;
    h_index: number;
    influence_score: number;
    project_count: number;
  };
  source: string[];
}

export interface GeoSpacePaper {
  id: string;
  name: string;
  description: string;
  web_url: string;
  publish_date: string;
  author: string;
  published_in: string;
}

export interface GeoSpaceBundle {
  generated_at: string;
  meta: {
    db_path: string;
    person_csv_path: string;
    paper_csv_path: string;
    project_csv_path: string;
    limits: {
      max_projects: number;
      max_people: number;
    };
    counts: {
      projects: number;
      people: number;
      topics: number;
      papers: number;
    };
  };
  topics: GeoSpaceTopic[];
  people: GeoSpacePerson[];
  projects: GeoSpaceProject[];
  papers: GeoSpacePaper[];
}

export interface BuildGeoSpaceBundleOptions {
  dbPath?: string;
  maxProjects?: number;
  maxPeople?: number;
  personCsvPath?: string | null;
  paperCsvPath?: string | null;
  projectCsvPath?: string | null;
}

export interface WriteGeoSpaceBundleOptions {
  outDir?: string;
  writeSheetCsv?: boolean;
  writeDemoLayout?: boolean;
}

type DatabaseLike = {
  prepare: (sql: string) => {
    all: (...params: any[]) => any[];
    get: (...params: any[]) => any;
  };
};

type PersonAccumulator = {
  id: string;
  name: string;
  description: string;
  web_url: string;
  x: string;
  avatar_url: string;
  topics: string[];
  works_at: string;
  role: string;
  papers: string[];
  links: {
    x: string;
    website: string;
    scholar: string;
    openalex: string;
    github: string;
  };
  metrics: {
    citation_count: number;
    h_index: number;
    influence_score: number;
    project_count: number;
  };
  source: Set<string>;
};

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function cleanText(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function splitList(value: unknown) {
  return cleanText(value)
    .split(/[;\n]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((entry) => entry.trim()).filter(Boolean)));
}

function normalizeUrl(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return "";
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/i.test(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function extractXHandle(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return "";
  const reserved = ["home", "intent", "share", "i", "search"];

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (!/^(www\.)?(x|twitter)\.com$/i.test(parsed.hostname)) return "";
      const segment = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/")[0] || "";
      if (!segment) return "";
      if (reserved.includes(segment.toLowerCase())) return "";
      return segment.replace(/^@/, "");
    } catch {
      return "";
    }
  }

  const normalized = raw.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(normalized)) return "";
  if (reserved.includes(normalized.toLowerCase())) return "";
  return normalized;
}

function toXUrl(value: unknown) {
  const handle = extractXHandle(value);
  return handle ? `https://x.com/${handle}` : "";
}

function normalizeName(value: unknown) {
  const compact = cleanText(value)
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ");
  if (!compact) return "";
  const shouldTitleCase = /[_-]/.test(String(value || "")) || compact === compact.toLowerCase();
  if (!shouldTitleCase) return compact;
  return compact
    .split(" ")
    .map((token) => (token ? token[0].toUpperCase() + token.slice(1) : token))
    .join(" ");
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const TOPIC_ACRONYMS = new Set([
  "ai",
  "ml",
  "llm",
  "nlp",
  "cnn",
  "rnn",
  "rl",
  "cv",
  "api",
  "sdk",
  "gpu",
  "cpu",
  "ui",
  "ux",
]);

function formatTopicLabel(value: unknown) {
  const compact = cleanText(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!compact) return "";
  return compact
    .split(" ")
    .map((token) => {
      const lower = token.toLowerCase();
      if (TOPIC_ACRONYMS.has(lower)) return lower.toUpperCase();
      if (/^[a-z0-9]+$/i.test(token) && token === token.toLowerCase()) {
        return token.charAt(0).toUpperCase() + token.slice(1);
      }
      return token;
    })
    .join(" ");
}

function formatProjectLabel(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return "";
  if (raw.includes("_")) return formatTopicLabel(raw);
  return raw;
}

function normalizeNameKey(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toDaysAgo(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24)));
}

function parseCsvRows(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === '"') {
      if (inQuotes && input[i + 1] === '"') {
        cell += '"';
        i += 1;
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
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some((entry) => entry.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((entry) => entry.trim() !== "")) rows.push(row);
  }

  return rows;
}

function parseCsvObjects(input: string) {
  const rows = parseCsvRows(input);
  if (!rows.length) return [];

  const headers = rows[0].map((header) => cleanText(header));
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    for (let index = 0; index < headers.length; index += 1) {
      record[headers[index]] = cleanText(cells[index]);
    }
    return record;
  });
}

function csvEscapeCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r\t]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toDelimitedText(rows: Record<string, unknown>[], headers: string[], delimiter: "," | "\t" = ",") {
  if (!rows.length) return headers.join(delimiter);
  const lines = [headers.map((header) => csvEscapeCell(header)).join(delimiter)];

  for (const row of rows) {
    const values = headers.map((header) => {
      const cell = row[header];
      if (Array.isArray(cell)) return csvEscapeCell(cell.join("; "));
      if (cell && typeof cell === "object") return csvEscapeCell(JSON.stringify(cell));
      return csvEscapeCell(cell);
    });
    lines.push(values.join(delimiter));
  }

  return lines.join("\n");
}

function buildProjectMarkdown(project: GeoSpaceProject) {
  const lines: string[] = [];
  lines.push(`### ${project.name}`);
  if (project.description) lines.push(project.description);
  lines.push("");
  lines.push(`- GitHub: ${project.web_url || "N/A"}`);
  lines.push(`- Stars: ${project.stats.stars.toLocaleString("en-US")}`);
  lines.push(`- Language: ${project.stats.language || "Unknown"}`);
  lines.push(`- License: ${project.stats.license || "Unknown"}`);
  lines.push(`- Maintained: ${project.stats.maintained ? "Yes" : "No"}`);
  if (project.release.latest_version) lines.push(`- Latest Version: ${project.release.latest_version}`);
  if (project.release.repo_pushed_at) lines.push(`- Repository Updated: ${project.release.repo_pushed_at}`);
  if (project.organization.name) lines.push(`- Organization: ${project.organization.name}`);
  if (project.topics.length) lines.push(`- Topics: ${project.topics.join(", ")}`);
  return lines.join("\n");
}

function splitOwnerRepo(url: string) {
  const match = url.match(/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (!match) return { owner: "", repo: "" };
  return { owner: match[1], repo: match[2] };
}

function normalizeRepoKey(url: string) {
  const parts = splitOwnerRepo(url);
  if (!parts.owner || !parts.repo) return "";
  return `${parts.owner.toLowerCase()}/${parts.repo.toLowerCase()}`;
}

function normalizeProjectNameKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseBooleanFlag(value: unknown, fallback: boolean) {
  const text = cleanText(value).toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "y", "active", "maintained"].includes(text)) return true;
  if (["0", "false", "no", "n", "inactive", "stale"].includes(text)) return false;
  return fallback;
}

type ProjectCsvOverride = {
  id: string;
  name: string;
  description: string;
  web_url: string;
  avatar_url: string;
  topics: string[];
  org_id: string;
  org_name: string;
  org_website: string;
  license: string;
  language: string;
  category: string;
  maintained: string;
  first_release: string;
  latest_version: string;
  latest_release_date: string;
  repo_pushed_at: string;
};

function normalizeProjectCsvOverride(row: Record<string, string>): ProjectCsvOverride {
  return {
    id: cleanText(row.id || row.ID || row.ProjectId || row.project_id),
    name: cleanText(row.Name || row.name),
    description: cleanText(row.Description || row.description),
    web_url: normalizeUrl(row["Web URL"] || row.web_url || row.url),
    avatar_url: normalizeUrl(row.Avatar || row.avatar || row.avatar_url),
    topics: splitList(row.Topics || row.topics).map((topic) => formatTopicLabel(topic)).filter(Boolean),
    org_id: cleanText(row["Organization ID"] || row.org_id),
    org_name: cleanText(row.Organization || row["Organization Name"] || row.org_name),
    org_website: normalizeUrl(row["Organization Website"] || row.org_website),
    license: cleanText(row.License || row.license),
    language: cleanText(row.Language || row.language),
    category: cleanText(row.Category || row.category),
    maintained: cleanText(row.Maintained || row.is_maintained),
    first_release: cleanText(row["First Release"] || row.first_release),
    latest_version: cleanText(row["Latest Version"] || row.latest_version),
    latest_release_date: cleanText(row["Latest Release Date"] || row.latest_release_date),
    repo_pushed_at: cleanText(row["Repo Pushed At"] || row.repo_pushed_at),
  };
}

function addOrMergePerson(
  mapById: Map<string, PersonAccumulator>,
  idByName: Map<string, string>,
  incoming: Partial<PersonAccumulator> & { name: string; id?: string },
  source: string,
) {
  const normalizedName = normalizeName(incoming.name);
  if (!normalizedName) return;

  const candidateId = cleanText(incoming.id) || `person:${slugify(normalizedName) || "unknown"}`;
  const nameKey = normalizeNameKey(normalizedName);
  const existingId = idByName.get(nameKey) || candidateId;

  const existing = mapById.get(existingId) || {
    id: existingId,
    name: normalizedName,
    description: "",
    web_url: "",
    x: "",
    avatar_url: "",
    topics: [],
    works_at: "",
    role: "",
    papers: [],
    links: {
      x: "",
      website: "",
      scholar: "",
      openalex: "",
      github: "",
    },
    metrics: {
      citation_count: 0,
      h_index: 0,
      influence_score: 0,
      project_count: 0,
    },
    source: new Set<string>(),
  };

  existing.name = existing.name || normalizedName;
  existing.description = existing.description || cleanText(incoming.description);
  existing.web_url = existing.web_url || cleanText(incoming.web_url);
  existing.x = existing.x || cleanText(incoming.x);
  existing.avatar_url = existing.avatar_url || cleanText(incoming.avatar_url);
  existing.works_at = existing.works_at || cleanText(incoming.works_at);
  existing.role = existing.role || cleanText(incoming.role);

  if (incoming.topics?.length) {
    existing.topics = uniqueStrings([...existing.topics, ...incoming.topics]);
  }
  if (incoming.papers?.length) {
    existing.papers = uniqueStrings([...existing.papers, ...incoming.papers]);
  }

  existing.links = {
    x: existing.links.x || cleanText(incoming.links?.x),
    website: existing.links.website || cleanText(incoming.links?.website),
    scholar: existing.links.scholar || cleanText(incoming.links?.scholar),
    openalex: existing.links.openalex || cleanText(incoming.links?.openalex),
    github: existing.links.github || cleanText(incoming.links?.github),
  };

  const citationCount = Number(incoming.metrics?.citation_count || 0);
  const hIndex = Number(incoming.metrics?.h_index || 0);
  const influenceScore = Number(incoming.metrics?.influence_score || 0);
  const projectCount = Number(incoming.metrics?.project_count || 0);

  if (citationCount > existing.metrics.citation_count) existing.metrics.citation_count = citationCount;
  if (hIndex > existing.metrics.h_index) existing.metrics.h_index = hIndex;
  if (influenceScore > existing.metrics.influence_score) existing.metrics.influence_score = influenceScore;
  if (projectCount > existing.metrics.project_count) existing.metrics.project_count = projectCount;

  existing.source.add(source);

  if (!existing.description) {
    const role = existing.role || "AI Researcher";
    existing.description = existing.works_at ? `${role} at ${existing.works_at}` : role;
  }

  if (!existing.web_url) {
    existing.web_url = existing.x || existing.links.website || existing.links.scholar || existing.links.openalex || existing.links.github || "";
  }

  if (!existing.x && existing.links.x) {
    existing.x = existing.links.x;
  }

  mapById.set(existingId, existing);
  idByName.set(nameKey, existingId);
}

function resolveCsvPath(explicitPath: string | null | undefined, fallbackFile: string) {
  if (explicitPath) {
    const resolved = path.resolve(process.cwd(), explicitPath);
    if (fs.existsSync(resolved)) return resolved;
  }

  const localPath = path.resolve(process.cwd(), fallbackFile);
  if (fs.existsSync(localPath)) return localPath;

  return "";
}

export function buildGeoSpaceBundleFromDb(
  db: DatabaseLike,
  {
    dbPath = path.resolve(process.cwd(), "geo.db"),
    maxProjects = 1000,
    maxPeople = 2000,
    personCsvPath,
    paperCsvPath,
    projectCsvPath,
  }: BuildGeoSpaceBundleOptions = {},
): GeoSpaceBundle {
  const projectLimit = clampInt(maxProjects, 1, 10000, 1000);
  const peopleLimit = clampInt(maxPeople, 1, 10000, 2000);
  const resolvedPersonCsvPath = resolveCsvPath(personCsvPath, "Person.csv");
  const resolvedPaperCsvPath = resolveCsvPath(paperCsvPath, "Paper.csv");
  const resolvedProjectCsvPath = resolveCsvPath(projectCsvPath, "Projects.csv");

  const projectRows = db.prepare(`
    SELECT p.*, c.name AS org_name, c.website AS org_website
    FROM projects p
    LEFT JOIN companies c ON p.org_id = c.id
    ORDER BY p.stars DESC, p.name ASC
    LIMIT ?
  `).all(projectLimit) as any[];

  const selectedProjectIds = new Set(projectRows.map((row) => cleanText(row.id)).filter(Boolean));

  const allTopicRows = db.prepare(`
    SELECT project_id, topic
    FROM topics
    ORDER BY project_id ASC, topic ASC
  `).all() as any[];

  const allMaintainerRows = db.prepare(`
    SELECT m.project_id, p.id, p.name, p.github_handle, p.avatar_url
    FROM maintainers m
    JOIN people p ON p.id = m.person_id
    ORDER BY m.project_id ASC, p.name ASC
  `).all() as any[];

  const allDependencyRows = db.prepare(`
    SELECT d.from_project_id, d.to_project_id, p.name AS to_project_name
    FROM dependencies d
    LEFT JOIN projects p ON p.id = d.to_project_id
    ORDER BY d.from_project_id ASC, d.to_project_id ASC
  `).all() as any[];

  const researcherRows = db.prepare(`
    SELECT *
    FROM researchers
    ORDER BY influence_score DESC, citation_count DESC, name ASC
  `).all() as any[];

  const maintainerCountRows = db.prepare(`
    SELECT p.id, p.name, p.github_handle, p.avatar_url, COUNT(m.project_id) AS project_count
    FROM people p
    LEFT JOIN maintainers m ON m.person_id = p.id
    GROUP BY p.id
    ORDER BY project_count DESC, p.name ASC
  `).all() as any[];

  const topicsByProject = new Map<string, string[]>();
  for (const row of allTopicRows) {
    const projectId = cleanText(row.project_id);
    const topic = formatTopicLabel(row.topic);
    if (!projectId || !topic || !selectedProjectIds.has(projectId)) continue;
    const existing = topicsByProject.get(projectId) || [];
    if (!existing.includes(topic)) existing.push(topic);
    topicsByProject.set(projectId, existing);
  }

  const maintainersByProject = new Map<string, GeoSpaceMaintainer[]>();
  for (const row of allMaintainerRows) {
    const projectId = cleanText(row.project_id);
    if (!projectId || !selectedProjectIds.has(projectId)) continue;

    const maintainer: GeoSpaceMaintainer = {
      id: cleanText(row.id),
      name: normalizeName(row.name) || "Unknown",
      github_handle: cleanText(row.github_handle),
      avatar_url: normalizeUrl(row.avatar_url),
    };

    const existing = maintainersByProject.get(projectId) || [];
    if (!existing.some((entry) => entry.id === maintainer.id)) existing.push(maintainer);
    maintainersByProject.set(projectId, existing);
  }

  const dependenciesByProject = new Map<string, GeoSpaceDependency[]>();
  for (const row of allDependencyRows) {
    const fromProjectId = cleanText(row.from_project_id);
    const toProjectId = cleanText(row.to_project_id);
    if (!fromProjectId || !toProjectId || fromProjectId === toProjectId) continue;
    if (!selectedProjectIds.has(fromProjectId)) continue;

    const dependency: GeoSpaceDependency = {
      id: toProjectId,
      name: normalizeName(row.to_project_name) || toProjectId,
    };

    const existing = dependenciesByProject.get(fromProjectId) || [];
    if (!existing.some((entry) => entry.id === dependency.id)) existing.push(dependency);
    dependenciesByProject.set(fromProjectId, existing);
  }

  const projectOverridesById = new Map<string, ProjectCsvOverride>();
  const projectOverridesByRepo = new Map<string, ProjectCsvOverride>();
  const projectOverridesByName = new Map<string, ProjectCsvOverride>();

  if (resolvedProjectCsvPath) {
    try {
      const projectOverrideRows = parseCsvObjects(fs.readFileSync(resolvedProjectCsvPath, "utf-8"));
      for (const row of projectOverrideRows) {
        const normalized = normalizeProjectCsvOverride(row);
        if (!normalized.id && !normalized.web_url && !normalized.name) continue;

        if (normalized.id) {
          projectOverridesById.set(normalized.id, normalized);
        }
        if (normalized.web_url) {
          const repoKey = normalizeRepoKey(normalized.web_url);
          if (repoKey) projectOverridesByRepo.set(repoKey, normalized);
        }
        if (normalized.name) {
          projectOverridesByName.set(normalizeProjectNameKey(normalized.name), normalized);
        }
      }
    } catch {
      // Ignore malformed optional CSV.
    }
  }

  const peopleById = new Map<string, PersonAccumulator>();
  const personIdByName = new Map<string, string>();

  for (const row of researcherRows) {
    const name = normalizeName(row.name);
    if (!name) continue;

    const x = toXUrl(row.twitter_handle || row.x_url);
    const website = normalizeUrl(row.personal_website_url);
    const scholar = normalizeUrl(row.google_scholar_url);
    const openalex = normalizeUrl(row.openalex_url);

    addOrMergePerson(
      peopleById,
      personIdByName,
      {
        id: cleanText(row.id) || `person:${slugify(name)}`,
        name,
        description: cleanText(row.role_title) && cleanText(row.current_affiliation_name)
          ? `${cleanText(row.role_title)} at ${cleanText(row.current_affiliation_name)}`
          : cleanText(row.role_title) || "AI Researcher",
        web_url: x || website || scholar || openalex,
        x,
        avatar_url: normalizeUrl(row.avatar_url),
        topics: splitList(row.research_areas).map((topic) => formatTopicLabel(topic)).filter(Boolean),
        works_at: cleanText(row.current_affiliation_name),
        role: cleanText(row.role_title),
        papers: splitList(row.notable_papers_or_contributions),
        links: {
          x,
          website,
          scholar,
          openalex,
          github: "",
        },
        metrics: {
          citation_count: Number(row.citation_count) || 0,
          h_index: Number(row.h_index) || 0,
          influence_score: Number(row.influence_score) || 0,
          project_count: 0,
        },
      },
      "researchers",
    );
  }

  for (const row of maintainerCountRows) {
    const name = normalizeName(row.name);
    if (!name) continue;
    const githubHandle = cleanText(row.github_handle);
    const githubUrl = githubHandle ? `https://github.com/${githubHandle}` : "";

    addOrMergePerson(
      peopleById,
      personIdByName,
      {
        id: cleanText(row.id) || `person:${slugify(name)}`,
        name,
        description: "Open-source maintainer",
        web_url: githubUrl,
        x: "",
        avatar_url: normalizeUrl(row.avatar_url),
        topics: [],
        works_at: "",
        role: "Maintainer",
        papers: [],
        links: {
          x: "",
          website: "",
          scholar: "",
          openalex: "",
          github: githubUrl,
        },
        metrics: {
          citation_count: 0,
          h_index: 0,
          influence_score: 0,
          project_count: Number(row.project_count) || 0,
        },
      },
      "maintainers",
    );
  }

  if (resolvedPersonCsvPath) {
    try {
      const personCsvRows = parseCsvObjects(fs.readFileSync(resolvedPersonCsvPath, "utf-8"));
      for (const row of personCsvRows) {
        const name = normalizeName(row.Name || row.name);
        if (!name) continue;

        const x = toXUrl(row.X || row.x);
        addOrMergePerson(
          peopleById,
          personIdByName,
          {
            id: cleanText(row.id) || `person:${slugify(name)}`,
            name,
            description: cleanText(row.Description || row.description),
            web_url: x || normalizeUrl(row.Web || row.website),
            x,
            avatar_url: normalizeUrl(row.Avatar || row.avatar),
            topics: splitList(row.Topics || row.topics).map((topic) => formatTopicLabel(topic)).filter(Boolean),
            works_at: cleanText(row["Works at"] || row["Works At"] || row.works_at),
            role: cleanText(row.Role || row.role),
            papers: splitList(row.Papers || row.papers),
            links: {
              x,
              website: "",
              scholar: "",
              openalex: "",
              github: "",
            },
            metrics: {
              citation_count: 0,
              h_index: 0,
              influence_score: 0,
              project_count: 0,
            },
          },
          "person_csv",
        );
      }
    } catch {
      // Ignore malformed optional CSV.
    }
  }

  const people = Array.from(peopleById.values())
    .map<GeoSpacePerson>((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      web_url: entry.web_url,
      x: entry.x,
      avatar_url: entry.avatar_url,
      topics: uniqueStrings(entry.topics),
      works_at: entry.works_at,
      role: entry.role,
      papers: uniqueStrings(entry.papers),
      links: {
        x: entry.links.x,
        website: entry.links.website,
        scholar: entry.links.scholar,
        openalex: entry.links.openalex,
        github: entry.links.github,
      },
      metrics: {
        citation_count: entry.metrics.citation_count,
        h_index: entry.metrics.h_index,
        influence_score: entry.metrics.influence_score,
        project_count: entry.metrics.project_count,
      },
      source: Array.from(entry.source.values()).sort(),
    }))
    .sort((a, b) =>
      b.metrics.influence_score - a.metrics.influence_score ||
      b.metrics.citation_count - a.metrics.citation_count ||
      b.metrics.project_count - a.metrics.project_count ||
      a.name.localeCompare(b.name),
    )
    .slice(0, peopleLimit);

  const papers: GeoSpacePaper[] = [];
  const paperKeySet = new Set<string>();

  if (resolvedPaperCsvPath) {
    try {
      const paperRows = parseCsvObjects(fs.readFileSync(resolvedPaperCsvPath, "utf-8"));
      for (const row of paperRows) {
        const name = cleanText(row.Name || row.name);
        if (!name) continue;

        const author = cleanText(row.Author || row.author);
        const key = `${name.toLowerCase()}|${author.toLowerCase()}`;
        if (paperKeySet.has(key)) continue;
        paperKeySet.add(key);

        papers.push({
          id: `paper:${slugify(name)}${author ? `:${slugify(author)}` : ""}`,
          name,
          description: cleanText(row.Description || row.description) || `Research contribution by ${author || "unknown author"}`,
          web_url: normalizeUrl(row["Web URL"] || row.web_url || row.url),
          publish_date: cleanText(row["Publish date"] || row.publish_date || row.date) || "N/A",
          author,
          published_in: cleanText(row["Published in"] || row.published_in || row.venue),
        });
      }
    } catch {
      // Ignore malformed optional CSV.
    }
  }

  if (!papers.length) {
    for (const person of people) {
      for (const paperTitle of person.papers) {
        const key = `${paperTitle.toLowerCase()}|${person.name.toLowerCase()}`;
        if (paperKeySet.has(key)) continue;
        paperKeySet.add(key);
        papers.push({
          id: `paper:${slugify(paperTitle)}:${slugify(person.name)}`,
          name: paperTitle,
          description: `Research contribution by ${person.name}`,
          web_url: person.links.scholar || person.links.website || person.x || person.web_url,
          publish_date: "N/A",
          author: person.name,
          published_in: person.works_at,
        });
      }
    }
  }

  const projects = projectRows.map<GeoSpaceProject>((row) => {
    const projectId = cleanText(row.id);
    const baseGithubUrl = normalizeUrl(row.github_url);
    const baseProjectName = formatProjectLabel(row.name) || projectId;
    const baseProjectNameKey = normalizeProjectNameKey(baseProjectName);
    const repoKey = normalizeRepoKey(baseGithubUrl);

    const override =
      projectOverridesById.get(projectId) ||
      (repoKey ? projectOverridesByRepo.get(repoKey) : undefined) ||
      projectOverridesByName.get(baseProjectNameKey);

    const githubUrl = override?.web_url || baseGithubUrl;
    const projectName = formatProjectLabel(override?.name || row.name) || projectId;
    const projectTopics = uniqueStrings(
      (override?.topics?.length ? override.topics : topicsByProject.get(projectId) || [])
        .map((topic) => formatTopicLabel(topic))
        .filter(Boolean),
    );
    const maintainers = maintainersByProject.get(projectId) || [];
    const dependencies = dependenciesByProject.get(projectId) || [];
    const pushedAt = cleanText(override?.repo_pushed_at || row.repo_pushed_at);
    const activityDays = toDaysAgo(pushedAt);

    const orgName = normalizeName(override?.org_name || row.org_name);
    const orgWebsite = normalizeUrl(override?.org_website || row.org_website);
    const maintained = parseBooleanFlag(override?.maintained, Number(row.is_maintained) === 1);

    const project: GeoSpaceProject = {
      id: projectId,
      name: projectName,
      description: cleanText(override?.description || row.description),
      web_url: githubUrl,
      avatar_url: normalizeUrl(override?.avatar_url || row.project_logo_url),
      topics: projectTopics,
      maintainers,
      dependencies,
      organization: {
        id: cleanText(override?.org_id || row.org_id),
        name: orgName,
        website: orgWebsite,
      },
      stats: {
        stars: Number(row.stars) || 0,
        language: cleanText(override?.language || row.language) || "Unknown",
        license: cleanText(override?.license || row.license) || "Unknown",
        category: cleanText(override?.category || row.category) || "library",
        maintained,
        last_activity_days: activityDays,
      },
      release: {
        first_release: cleanText(override?.first_release || row.first_release),
        latest_version: cleanText(override?.latest_version || row.latest_version),
        latest_release_date: cleanText(override?.latest_release_date || row.latest_release_date),
        repo_pushed_at: pushedAt,
      },
      blocks: [],
      text_blocks: [],
    };

    const repo = splitOwnerRepo(project.web_url);
    const markdownBlock = buildProjectMarkdown(project);
    project.blocks = [{ type: "markdown", markdown_content: markdownBlock }];
    project.text_blocks = project.blocks;

    if (!project.organization.name && repo.owner) {
      project.organization.name = repo.owner;
    }

    return project;
  });

  const topicProjectCounter = new Map<string, number>();
  const topicPeopleCounter = new Map<string, number>();
  const topicLabelByKey = new Map<string, string>();

  for (const project of projects) {
    for (const topic of uniqueStrings(project.topics)) {
      const key = slugify(topic);
      if (!key) continue;
      topicProjectCounter.set(key, (topicProjectCounter.get(key) || 0) + 1);
      if (!topicLabelByKey.has(key)) topicLabelByKey.set(key, formatTopicLabel(topic));
    }
  }

  for (const person of people) {
    for (const topic of uniqueStrings(person.topics)) {
      const key = slugify(topic);
      if (!key) continue;
      topicPeopleCounter.set(key, (topicPeopleCounter.get(key) || 0) + 1);
      const existingLabel = topicLabelByKey.get(key) || "";
      const candidateLabel = formatTopicLabel(topic);
      if (!existingLabel || (existingLabel === existingLabel.toLowerCase() && candidateLabel !== candidateLabel.toLowerCase())) {
        topicLabelByKey.set(key, candidateLabel);
      }
    }
  }

  const topicKeys = new Set<string>([
    ...Array.from(topicProjectCounter.keys()),
    ...Array.from(topicPeopleCounter.keys()),
  ]);

  const topics = Array.from(topicKeys)
    .map<GeoSpaceTopic>((key) => {
      const projectCount = topicProjectCounter.get(key) || 0;
      const peopleCount = topicPeopleCounter.get(key) || 0;
      const usageCount = projectCount + peopleCount;
      const label = topicLabelByKey.get(key) || key;
      return {
        id: `topic:${key}`,
        name: label,
        slug: key,
        description: `Topic from Geo AI ecosystem: ${label}`,
        usage_count: usageCount,
        project_count: projectCount,
        people_count: peopleCount,
      };
    })
    .sort((a, b) => b.usage_count - a.usage_count || a.name.localeCompare(b.name));

  return {
    generated_at: new Date().toISOString(),
    meta: {
      db_path: dbPath,
      person_csv_path: resolvedPersonCsvPath,
      paper_csv_path: resolvedPaperCsvPath,
      project_csv_path: resolvedProjectCsvPath,
      limits: {
        max_projects: projectLimit,
        max_people: peopleLimit,
      },
      counts: {
        projects: projects.length,
        people: people.length,
        topics: topics.length,
        papers: papers.length,
      },
    },
    topics,
    people,
    projects,
    papers,
  };
}

export function buildGeoSpaceBundle(options: BuildGeoSpaceBundleOptions = {}) {
  const dbPath = path.resolve(process.cwd(), options.dbPath || "geo.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    return buildGeoSpaceBundleFromDb(db as unknown as DatabaseLike, {
      ...options,
      dbPath,
    });
  } finally {
    db.close();
  }
}

export function toPersonSheetRows(people: GeoSpacePerson[]) {
  return people.map((person) => ({
    Name: person.name,
    Description: person.description,
    X: person.x,
    Avatar: person.avatar_url,
    Topics: person.topics.join("; "),
    "Works at": person.works_at,
    Role: person.role,
    Papers: person.papers.join("; "),
  }));
}

export function toPaperSheetRows(papers: GeoSpacePaper[]) {
  return papers.map((paper) => ({
    Name: paper.name,
    Description: paper.description,
    "Web URL": paper.web_url,
    "Publish date": paper.publish_date,
    Author: paper.author,
    "Published in": paper.published_in,
  }));
}

export function toProjectSheetRows(projects: GeoSpaceProject[]) {
  return projects.map((project) => ({
    ID: project.id,
    Name: project.name,
    Description: project.description,
    "Web URL": project.web_url,
    Avatar: project.avatar_url,
    Topics: project.topics.join("; "),
    Organization: project.organization.name,
    "Organization ID": project.organization.id,
    "Organization Website": project.organization.website,
    License: project.stats.license,
    Language: project.stats.language,
    Category: project.stats.category,
    Maintained: project.stats.maintained ? "Yes" : "No",
    "First Release": project.release.first_release,
    "Latest Version": project.release.latest_version,
    "Latest Release Date": project.release.latest_release_date,
    "Repo Pushed At": project.release.repo_pushed_at,
  }));
}

export function writeGeoSpaceBundleFiles(
  bundle: GeoSpaceBundle,
  {
    outDir = path.resolve(process.cwd(), "geo_space_payload"),
    writeSheetCsv = true,
    writeDemoLayout = true,
  }: WriteGeoSpaceBundleOptions = {},
) {
  fs.mkdirSync(outDir, { recursive: true });

  const fileMap: Record<string, string> = {
    topics: path.join(outDir, "topics.json"),
    people: path.join(outDir, "people.json"),
    projects: path.join(outDir, "projects.json"),
    papers: path.join(outDir, "papers.json"),
    manifest: path.join(outDir, "manifest.json"),
  };

  fs.writeFileSync(fileMap.topics, JSON.stringify(bundle.topics, null, 2) + "\n", "utf-8");
  fs.writeFileSync(fileMap.people, JSON.stringify(bundle.people, null, 2) + "\n", "utf-8");
  fs.writeFileSync(fileMap.projects, JSON.stringify(bundle.projects, null, 2) + "\n", "utf-8");
  fs.writeFileSync(fileMap.papers, JSON.stringify(bundle.papers, null, 2) + "\n", "utf-8");
  fs.writeFileSync(fileMap.manifest, JSON.stringify(bundle, null, 2) + "\n", "utf-8");

  if (writeSheetCsv) {
    const personRows = toPersonSheetRows(bundle.people);
    const paperRows = toPaperSheetRows(bundle.papers);
    const projectRows = toProjectSheetRows(bundle.projects);

    const personCsvPath = path.join(outDir, "Person.csv");
    const paperCsvPath = path.join(outDir, "Paper.csv");
    const projectsCsvPath = path.join(outDir, "Projects.csv");

    fs.writeFileSync(
      personCsvPath,
      toDelimitedText(personRows, ["Name", "Description", "X", "Avatar", "Topics", "Works at", "Role", "Papers"], ",") + "\n",
      "utf-8",
    );

    fs.writeFileSync(
      paperCsvPath,
      toDelimitedText(paperRows, ["Name", "Description", "Web URL", "Publish date", "Author", "Published in"], ",") + "\n",
      "utf-8",
    );

    fs.writeFileSync(
      projectsCsvPath,
      toDelimitedText(
        projectRows,
        [
          "ID",
          "Name",
          "Description",
          "Web URL",
          "Avatar",
          "Topics",
          "Organization",
          "Organization ID",
          "Organization Website",
          "License",
          "Language",
          "Category",
          "Maintained",
          "First Release",
          "Latest Version",
          "Latest Release Date",
          "Repo Pushed At",
        ],
        ",",
      ) + "\n",
      "utf-8",
    );

    fileMap.person_csv = personCsvPath;
    fileMap.paper_csv = paperCsvPath;
    fileMap.projects_csv = projectsCsvPath;
  }

  if (writeDemoLayout) {
    const dataToPublishDir = path.join(outDir, "data_to_publish");
    const editableDir = path.join(outDir, "editable");
    fs.mkdirSync(dataToPublishDir, { recursive: true });
    fs.mkdirSync(editableDir, { recursive: true });

    const dataTopicsPath = path.join(dataToPublishDir, "topics.json");
    const dataPeoplePath = path.join(dataToPublishDir, "people.json");
    const dataProjectsPath = path.join(dataToPublishDir, "projects.json");
    const dataPapersPath = path.join(dataToPublishDir, "papers.json");

    fs.writeFileSync(dataTopicsPath, JSON.stringify(bundle.topics, null, 2) + "\n", "utf-8");
    fs.writeFileSync(dataPeoplePath, JSON.stringify(bundle.people, null, 2) + "\n", "utf-8");
    fs.writeFileSync(dataProjectsPath, JSON.stringify(bundle.projects, null, 2) + "\n", "utf-8");
    fs.writeFileSync(dataPapersPath, JSON.stringify(bundle.papers, null, 2) + "\n", "utf-8");

    fileMap.data_to_publish = dataToPublishDir;

    if (writeSheetCsv) {
      const editablePersonCsvPath = path.join(editableDir, "Person.csv");
      const editablePaperCsvPath = path.join(editableDir, "Paper.csv");
      const editableProjectsCsvPath = path.join(editableDir, "Projects.csv");

      if (fileMap.person_csv) fs.copyFileSync(fileMap.person_csv, editablePersonCsvPath);
      if (fileMap.paper_csv) fs.copyFileSync(fileMap.paper_csv, editablePaperCsvPath);
      if (fileMap.projects_csv) fs.copyFileSync(fileMap.projects_csv, editableProjectsCsvPath);

      fileMap.editable = editableDir;
      fileMap.editable_person_csv = editablePersonCsvPath;
      fileMap.editable_paper_csv = editablePaperCsvPath;
      fileMap.editable_projects_csv = editableProjectsCsvPath;
    }

    const checklistPath = path.join(outDir, "PUBLISH_CHECKLIST.md");
    const checklist = [
      "# GEO Space Draft Checklist",
      "",
      `Generated at: ${bundle.generated_at}`,
      "",
      "1. Edit CSV drafts in `editable/` (Person.csv, Paper.csv, Projects.csv) if needed.",
      "2. Rebuild payload after edits:",
      "   `npm run geo:payload -- --person-csv geo_space_payload/editable/Person.csv --paper-csv geo_space_payload/editable/Paper.csv --project-csv geo_space_payload/editable/Projects.csv`",
      "3. Publish from this repo (dry-run):",
      "   `npm run geo:publish -- --payload-dir geo_space_payload/data_to_publish`",
      "4. Publish on-chain (real tx):",
      "   `npm run geo:publish -- --payload-dir geo_space_payload/data_to_publish --publish 1`",
      "5. Or copy `data_to_publish/topics.json`, `people.json`, `projects.json` into geo_tech_demo and run their scripts.",
      "6. Verify entities in Geo Space before final publish action.",
      "",
    ].join("\n");
    fs.writeFileSync(checklistPath, checklist, "utf-8");
    fileMap.checklist = checklistPath;
  }

  return fileMap;
}
