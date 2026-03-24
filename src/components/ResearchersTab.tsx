import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Award,
  BookOpenText,
  Building2,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Globe2,
  GraduationCap,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

type SortMode = 'influence' | 'citations' | 'h_index' | 'name';
type LinkHealthStatus = 'verified' | 'broken' | 'restricted' | 'unknown' | 'missing';

interface Researcher {
  id: string;
  name: string;
  avatarUrl: string;
  currentAffiliation: string;
  roleTitle: string;
  researchAreas: string[];
  scholarUrl: string;
  websiteUrl: string;
  twitterHandle: string;
  twitterUrl: string;
  notableContributions: string[];
  hIndex: number;
  citationCount: number;
  influenceScore: number;
  education: string[];
  openAlexUrl: string;
  lastVerifiedAt: string;
  lastEnrichedAt: string;
  sourceUpdatedAt: string;
  linkHealth: {
    scholar: LinkHealthStatus;
    website: LinkHealthStatus;
    x: LinkHealthStatus;
  };
}

interface ResearchersTabProps {
  theme: 'light' | 'dark';
}

interface QualityField {
  key: string;
  label: string;
  filled: number;
  missing: number;
  coveragePercent: number;
}

interface QualityPayload {
  totalResearchers: number;
  totalFields: number;
  overallCoveragePercent: number;
  updatedAt: string;
  fields: QualityField[];
  highlight?: {
    nameCoveragePercent?: number;
    avatarCoveragePercent?: number;
    cleanNamePercent?: number;
    validAvatarLinkPercent?: number;
  };
}

interface ExportTableOption {
  key: string;
  label: string;
  description: string;
}

interface ExportOptionsPayload {
  formats: string[];
  tables: ExportTableOption[];
}

type ExportFormat = 'csv' | 'tsv' | 'json';

const PAGE_SIZE = 24;
const UI_LOCALE = 'en-US';

function parseCsvRows(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === '"') {
      if (inQuotes && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== '')) rows.push(row);
  }

  return rows;
}

function normalizeList(value: string) {
  return value
    .split(/[;\n]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDisplayName(value: string) {
  const compact = value
    .trim()
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!compact) return '';
  const shouldTitleCase = /[_-]/.test(value) || compact === compact.toLowerCase();
  if (!shouldTitleCase) return compact;
  return compact
    .split(' ')
    .map((token) => (token ? token[0].toUpperCase() + token.slice(1) : token))
    .join(' ');
}

function toNumber(value: string) {
  const normalized = value.replace(/[^0-9.]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeExternalUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.toString();
  } catch {
    return '';
  }
}

function toTwitterHandle(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const path = new URL(trimmed).pathname.replace(/^\/+|\/+$/g, '');
      return path.split('/')[0] || '';
    } catch {
      return '';
    }
  }
  return trimmed.replace(/^@/, '');
}

function toTwitterUrl(rawHandle: string) {
  const handle = toTwitterHandle(rawHandle);
  if (!handle) return '';
  return `https://x.com/${handle}`;
}

function formatCompactNumber(value: number) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString(UI_LOCALE);
}

function formatDateTime(value?: string | null) {
  if (!value) return 'N/A';
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return 'N/A';
  return new Date(ts).toLocaleString(UI_LOCALE, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fallbackAvatarUrl(name: string) {
  const seed = encodeURIComponent(normalizeDisplayName(name) || 'Researcher');
  return `https://api.dicebear.com/9.x/initials/svg?seed=${seed}&fontWeight=700&radius=16`;
}

function statusLabel(status: LinkHealthStatus) {
  if (status === 'verified') return 'Verified';
  if (status === 'restricted') return 'Restricted';
  if (status === 'broken') return 'Broken';
  if (status === 'missing') return 'Missing';
  return 'Unknown';
}

function statusClasses(status: LinkHealthStatus) {
  if (status === 'verified') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (status === 'restricted') return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  if (status === 'broken') return 'bg-red-500/15 text-red-700 dark:text-red-300';
  if (status === 'missing') return 'bg-black/5 dark:bg-white/10 text-black/45 dark:text-zinc-500';
  return 'geo-pill-soft text-[#7f3ee6] dark:text-[#e0aeff]';
}

function mapCsvFallback(csvText: string): Researcher[] {
  const rows = parseCsvRows(csvText);
  if (!rows.length) return [];
  const header = rows[0].map((column) => column.trim());
  const indexBy = (column: string) => header.indexOf(column);

  const payload = rows.slice(1).map((values) => {
    const get = (column: string) => values[indexBy(column)]?.trim() || '';
    const twitterHandle = toTwitterHandle(get('twitter_handle'));
    const twitterUrl = toTwitterUrl(twitterHandle);

    const parsed: Researcher = {
      id: get('id') || `person:${get('name').toLowerCase().replace(/[^\w]+/g, '-')}`,
      name: normalizeDisplayName(get('name')),
      avatarUrl: normalizeExternalUrl(get('avatar_url')) || fallbackAvatarUrl(get('name')),
      currentAffiliation: get('current_affiliation_name'),
      roleTitle: get('role_title'),
      researchAreas: normalizeList(get('research_areas')),
      scholarUrl: get('google_scholar_url'),
      websiteUrl: get('personal_website_url'),
      twitterHandle,
      twitterUrl,
      notableContributions: normalizeList(get('notable_papers_or_contributions')),
      hIndex: toNumber(get('h_index')),
      citationCount: toNumber(get('citation_count')),
      influenceScore: Number(get('influence_score')) || 0,
      education: normalizeList(get('education')),
      openAlexUrl: '',
      lastVerifiedAt: '',
      lastEnrichedAt: '',
      sourceUpdatedAt: '',
      linkHealth: {
        scholar: get('google_scholar_url') ? 'unknown' : 'missing',
        website: get('personal_website_url') ? 'unknown' : 'missing',
        x: twitterUrl ? 'unknown' : 'missing',
      },
    };
    return parsed;
  });

  return payload
    .filter((item) => item.name)
    .sort((a, b) => b.influenceScore - a.influenceScore || b.citationCount - a.citationCount);
}

export default function ResearchersTab({ theme }: ResearchersTabProps) {
  const [researchers, setResearchers] = useState<Researcher[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityPayload | null>(null);
  const [exportOptions, setExportOptions] = useState<ExportOptionsPayload | null>(null);
  const [exportTable, setExportTable] = useState('researchers');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');
  const [isExporting, setIsExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [search, setSearch] = useState('');
  const [areaFilter, setAreaFilter] = useState('All');
  const [sortBy, setSortBy] = useState<SortMode>('influence');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');

  const loadQualityAndOptions = useCallback(async () => {
    try {
      const [qualityRes, optionsRes] = await Promise.all([
        fetch('/api/researchers/quality'),
        fetch('/api/export/options'),
      ]);

      if (qualityRes.ok) {
        const qualityPayload = (await qualityRes.json()) as QualityPayload;
        setQuality(qualityPayload);
      }

      if (optionsRes.ok) {
        const optionsPayload = (await optionsRes.json()) as ExportOptionsPayload;
        setExportOptions(optionsPayload);
        setExportTable((current) => {
          if (!optionsPayload.tables.length) return current;
          return optionsPayload.tables.some((table) => table.key === current)
            ? current
            : optionsPayload.tables[0].key;
        });
      }
    } catch (optionsError) {
      console.warn('Unable to load quality/export options:', optionsError);
    }
  }, []);

  const loadResearchers = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/researchers');
      if (!response.ok) throw new Error(`Researchers API failed (${response.status})`);
      const payload = await response.json();
      const cleaned = (payload as Researcher[])
        .filter((item) => item?.name)
        .sort((a, b) => b.influenceScore - a.influenceScore || b.citationCount - a.citationCount);
      setResearchers(cleaned);
      setError(null);
    } catch (apiError) {
      console.warn('Researchers API unavailable, falling back to CSV:', apiError);

      try {
        const csvResponse = await fetch('/researchers_top200.csv');
        if (!csvResponse.ok) throw new Error(`CSV load failed (${csvResponse.status})`);
        const csvText = await csvResponse.text();
        const cleaned = mapCsvFallback(csvText);
        setResearchers(cleaned);
        setError(null);
      } catch (csvError) {
        setError((csvError as Error).message);
        setResearchers([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadResearchers();
    loadQualityAndOptions();
  }, [loadResearchers, loadQualityAndOptions]);

  const handleRefreshResearchers = async () => {
    setIsRefreshing(true);
    setRefreshMessage('');
    try {
      const response = await fetch('/api/researchers/refresh?full=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full: true }),
      });
      const data = await response.json();
      if (!response.ok || !data?.success) {
        setRefreshMessage(data?.message || 'Researchers refresh is unavailable in the deployed site.');
      } else {
        const xDiscoverySuffix =
          data.discoveredX || data.overrideX
            ? ` · X discovered ${data.discoveredX || 0} · X overrides ${data.overrideX || 0}`
            : '';
        const avatarSuffix = data.avatarBackfilled ? ` · Avatars backfilled ${data.avatarBackfilled}` : '';
        setRefreshMessage(
          `Updated ${data.processed} researchers · Enriched ${data.enrichedCount} · Verified links: Scholar ${data.verifiedScholar}, Websites ${data.verifiedWebsites}, X ${data.verifiedX}${avatarSuffix}${xDiscoverySuffix}`,
        );
      }
      await loadResearchers();
      await loadQualityAndOptions();
    } catch (err) {
      console.error(err);
      setRefreshMessage('Researchers refresh failed.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleExport = async () => {
    setIsExporting(true);
    setExportMessage('');
    try {
      const response = await fetch(`/api/export?table=${encodeURIComponent(exportTable)}&format=${encodeURIComponent(exportFormat)}`);
      if (!response.ok) throw new Error(`Export failed (${response.status})`);

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') || '';
      const fileNameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      const fallbackName = `${exportTable}.${exportFormat}`;
      const filename = fileNameMatch?.[1] || fallbackName;

      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setExportMessage(`Exported ${exportTable} as ${exportFormat.toUpperCase()}.`);
    } catch (exportError) {
      console.error(exportError);
      setExportMessage('Export failed. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const areaOptions = useMemo(() => {
    const areaCounter = researchers.reduce((acc: Record<string, number>, researcher) => {
      for (const area of researcher.researchAreas) {
        acc[area] = (acc[area] || 0) + 1;
      }
      return acc;
    }, {});

    return [
      'All',
      ...Object.entries(areaCounter)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name]) => name),
    ];
  }, [researchers]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const sorted = researchers.filter((item) => {
      const matchesArea = areaFilter === 'All' || item.researchAreas.includes(areaFilter);
      const searchableText = [
        item.name,
        item.currentAffiliation,
        item.roleTitle,
        item.researchAreas.join(' '),
        item.notableContributions.join(' '),
      ]
        .join(' ')
        .toLowerCase();
      const matchesQuery = !query || searchableText.includes(query);
      return matchesArea && matchesQuery;
    });

    if (sortBy === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === 'citations') {
      sorted.sort((a, b) => b.citationCount - a.citationCount || b.influenceScore - a.influenceScore);
    } else if (sortBy === 'h_index') {
      sorted.sort((a, b) => b.hIndex - a.hIndex || b.citationCount - a.citationCount);
    } else {
      sorted.sort((a, b) => b.influenceScore - a.influenceScore || b.citationCount - a.citationCount);
    }
    return sorted;
  }, [researchers, search, areaFilter, sortBy]);

  const visibleResearchers = filtered.slice(0, visibleCount);
  const avgInfluence = researchers.length
    ? (researchers.reduce((sum, item) => sum + item.influenceScore, 0) / researchers.length).toFixed(3)
    : '0.000';

  const topAffiliation = useMemo(() => {
    const counter = researchers.reduce((acc: Record<string, number>, researcher) => {
      const key = researcher.currentAffiliation || 'Independent';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const [name, count] = Object.entries(counter).sort((a, b) => b[1] - a[1])[0] || ['N/A', 0];
    return { name, count };
  }, [researchers]);

  const verifiedProfiles = useMemo(() => {
    return researchers.filter((researcher) =>
      [researcher.linkHealth.scholar, researcher.linkHealth.website, researcher.linkHealth.x].includes('verified'),
    ).length;
  }, [researchers]);

  const latestVerifiedLabel = useMemo(() => {
    const timestamps = researchers
      .map((researcher) => Date.parse(researcher.lastVerifiedAt || ''))
      .filter((value) => Number.isFinite(value)) as number[];
    if (!timestamps.length) return 'N/A';
    return formatDateTime(new Date(Math.max(...timestamps)).toISOString());
  }, [researchers]);

  const weakestQualityFields = useMemo(() => {
    if (!quality?.fields?.length) return [];
    return [...quality.fields]
      .sort((a, b) => a.coveragePercent - b.coveragePercent)
      .slice(0, 3);
  }, [quality]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, areaFilter, sortBy]);

  if (loading) {
    return (
      <div className="h-[60vh] rounded-3xl bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 flex items-center justify-center">
        <div className="text-sm font-bold text-black/45 dark:text-zinc-400">Loading researcher dataset...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-[60vh] rounded-3xl bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 flex flex-col items-center justify-center p-8 text-center">
        <h3 className="text-2xl font-black mb-2">Researchers unavailable</h3>
        <p className="text-black/55 dark:text-zinc-400 max-w-lg">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <section className="rounded-3xl border border-black/5 dark:border-white/10 bg-white dark:bg-zinc-900 p-6 md:p-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Metric label="Researchers" value={researchers.length.toString()} icon={<GraduationCap size={14} />} />
          <Metric label="Avg Influence" value={avgInfluence} icon={<Sparkles size={14} />} />
          <Metric label="Top Affiliation" value={`${topAffiliation.name} (${topAffiliation.count})`} icon={<Building2 size={14} />} compact />
          <Metric label="Verified Profiles" value={`${verifiedProfiles}`} icon={<ShieldCheck size={14} />} />
        </div>

        <div className="mt-6 grid grid-cols-1 xl:grid-cols-5 gap-4">
          <div className="xl:col-span-2 rounded-2xl border border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] p-4">
            <div className="text-[10px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-500 mb-3 inline-flex items-center gap-1.5">
              <Award size={13} />
              Data Quality (19 Criteria)
            </div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <ScoreBadge label="Overall" value={`${quality?.overallCoveragePercent?.toFixed?.(1) || '0.0'}%`} />
              <ScoreBadge label="Last Check" value={quality?.updatedAt ? formatDateTime(quality.updatedAt) : 'N/A'} />
              <ScoreBadge label="Column 2 Name" value={`${quality?.highlight?.nameCoveragePercent?.toFixed?.(1) || '0.0'}%`} />
              <ScoreBadge label="Column 3 Avatar" value={`${quality?.highlight?.avatarCoveragePercent?.toFixed?.(1) || '0.0'}%`} />
            </div>
            <div className="space-y-1.5">
              {weakestQualityFields.map((field) => (
                <div key={field.key} className="flex items-center justify-between text-[11px] font-bold">
                  <span className="text-black/55 dark:text-zinc-300 truncate pr-2">{field.label}</span>
                  <span className="text-black/45 dark:text-zinc-400">{field.coveragePercent.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>

          <div className="xl:col-span-3 rounded-2xl border border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] p-4">
            <div className="text-[10px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-500 mb-3 inline-flex items-center gap-1.5">
              <FileSpreadsheet size={13} />
              Export Settings
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <select
                value={exportTable}
                onChange={(event) => setExportTable(event.target.value)}
                className="h-11 rounded-2xl border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-900 px-3 text-sm font-bold"
              >
                {(exportOptions?.tables || []).map((table) => (
                  <option key={table.key} value={table.key}>
                    {table.label}
                  </option>
                ))}
                {!exportOptions?.tables?.length && <option value="researchers">AI Researchers</option>}
              </select>

              <select
                value={exportFormat}
                onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
                className="h-11 rounded-2xl border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-900 px-3 text-sm font-bold"
              >
                <option value="csv">CSV (.csv)</option>
                <option value="tsv">TSV (.tsv)</option>
                <option value="json">JSON (.json)</option>
              </select>

              <button
                onClick={handleExport}
                disabled={isExporting}
                className="h-11 px-4 rounded-2xl geo-primary-btn text-sm font-black inline-flex items-center justify-center gap-2 disabled:opacity-60 transition-all"
              >
                <Download size={14} />
                {isExporting ? 'Exporting...' : 'Export Data'}
              </button>
            </div>
            <div className="mt-3 text-[11px] text-black/45 dark:text-zinc-400 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <span>CSV/TSV works best for Excel, Google Sheets, and Numbers. JSON is best for automation pipelines.</span>
              {exportMessage && (
                <span className={`font-bold ${exportMessage.toLowerCase().includes('failed') ? 'text-red-600 dark:text-red-300' : 'geo-link'}`}>
                  {exportMessage}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-col lg:flex-row gap-4 lg:items-center lg:justify-between">
          <div className="relative w-full lg:max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-black/35 dark:text-zinc-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, affiliation, contribution..."
              className="w-full h-11 pl-10 pr-4 rounded-2xl border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-900 focus:outline-none geo-focus-ring"
            />
          </div>

          <div className="flex flex-wrap gap-3">
            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as SortMode)}
              className="h-11 rounded-2xl border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-900 px-3 text-sm font-bold"
            >
              <option value="influence">Sort: Influence</option>
              <option value="citations">Sort: Citations</option>
              <option value="h_index">Sort: H-Index</option>
              <option value="name">Sort: Name A-Z</option>
            </select>

            <select
              value={areaFilter}
              onChange={(event) => setAreaFilter(event.target.value)}
              className="h-11 rounded-2xl border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-900 px-3 text-sm font-bold max-w-[230px]"
            >
              {areaOptions.map((area) => (
                <option key={area} value={area}>
                  {area === 'All' ? 'All Research Areas' : area}
                </option>
              ))}
            </select>

            <button
              onClick={handleRefreshResearchers}
              disabled={isRefreshing}
              className="h-11 px-4 rounded-2xl geo-secondary-btn text-[#7f3ee6] dark:text-[#e0aeff] text-sm font-black inline-flex items-center gap-2 disabled:opacity-60 transition-all"
              title="Refresh and verify researcher links and metadata"
            >
              <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
              {isRefreshing ? 'Refreshing...' : 'Refresh Researchers'}
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs font-bold text-black/45 dark:text-zinc-400">
          <span>Last verification pass: {latestVerifiedLabel}</span>
          {refreshMessage && (
            <span className={refreshMessage.toLowerCase().includes('failed') ? 'text-red-600 dark:text-red-300' : 'geo-link'}>
              {refreshMessage}
            </span>
          )}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-black tracking-tight">AI Researchers Index</h3>
          <div className="text-xs font-black uppercase tracking-wider text-black/40 dark:text-zinc-500">
            {visibleResearchers.length} / {filtered.length} shown
          </div>
        </div>

        {visibleResearchers.length === 0 ? (
          <div className="p-10 rounded-3xl border border-black/5 dark:border-white/10 bg-white dark:bg-zinc-900 text-center">
            <h4 className="text-2xl font-black mb-2">No researchers found</h4>
            <p className="text-black/55 dark:text-zinc-400">Adjust search query or research-area filter.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {visibleResearchers.map((researcher, index) => (
              <motion.article
                key={researcher.id || `${researcher.name}-${index}`}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, delay: Math.min(index * 0.015, 0.16) }}
                className="rounded-3xl border border-black/5 dark:border-white/10 bg-white dark:bg-zinc-900 p-5 hover:shadow-xl transition-all"
              >
                <div className="flex items-start gap-3 mb-4">
                  <ResearcherAvatar
                    src={researcher.avatarUrl}
                    name={researcher.name}
                    className="w-14 h-14 rounded-2xl object-cover bg-black/5 dark:bg-white/10"
                  />
                  <div className="min-w-0">
                    <h4 className="font-black text-lg leading-tight truncate">{researcher.name}</h4>
                    <p className="text-xs font-bold uppercase tracking-wider text-black/40 dark:text-zinc-500 truncate">
                      {researcher.roleTitle || 'Researcher'}
                    </p>
                    <p className="text-xs text-black/55 dark:text-zinc-400 mt-1 truncate">
                      {researcher.currentAffiliation || 'Independent'}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 mb-4">
                  <ScoreBadge label="Influence" value={researcher.influenceScore.toFixed(3)} />
                  <ScoreBadge label="H-Index" value={researcher.hIndex.toString()} />
                  <ScoreBadge label="Citations" value={formatCompactNumber(researcher.citationCount)} />
                </div>

                <div className="flex flex-wrap gap-2 mb-4 min-h-12">
                  {researcher.researchAreas.slice(0, 3).map((area) => (
                    <span key={area} className="px-2.5 py-1 rounded-full bg-black/5 dark:bg-white/10 text-[10px] font-black uppercase tracking-wider text-black/55 dark:text-zinc-300">
                      {area}
                    </span>
                  ))}
                </div>

                <p className="text-sm text-black/65 dark:text-zinc-300 line-clamp-3 min-h-[60px]">
                  {researcher.notableContributions[0] || 'No notable contribution text in source dataset.'}
                </p>

                <div className="mt-4 pt-4 border-t border-black/5 dark:border-white/10 flex flex-wrap gap-2">
                  <ResearchLink
                    icon={<BookOpenText size={12} />}
                    label="Scholar"
                    href={researcher.scholarUrl}
                    status={researcher.linkHealth.scholar}
                    tone="blue"
                  />
                  <ResearchLink
                    icon={<Globe2 size={12} />}
                    label="Website"
                    href={researcher.websiteUrl}
                    status={researcher.linkHealth.website}
                    tone="emerald"
                  />
                  <ResearchLink
                    icon={<ExternalLink size={12} />}
                    label="X"
                    href={researcher.twitterUrl}
                    status={researcher.linkHealth.x}
                    tone="neutral"
                  />
                  {researcher.openAlexUrl && (
                    <a
                      href={researcher.openAlexUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl geo-secondary-btn text-[#9c46fd] dark:text-[#e4b4ff] text-xs font-black"
                    >
                      OpenAlex
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <span className="text-[10px] font-black uppercase tracking-wider text-black/35 dark:text-zinc-500">
                    Source Updated: {formatDateTime(researcher.sourceUpdatedAt)}
                  </span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${statusClasses(researcher.linkHealth.website)}`}>
                    {statusLabel(researcher.linkHealth.website)}
                  </span>
                </div>
              </motion.article>
            ))}
          </div>
        )}

        {visibleCount < filtered.length && (
          <div className="mt-8 flex justify-center">
            <button
              onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
              className="px-5 py-3 rounded-2xl geo-primary-btn font-bold text-sm transition-all"
            >
              Load More Researchers ({filtered.length - visibleCount} left)
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ResearcherAvatar({
  src,
  name,
  className,
}: {
  src?: string;
  name: string;
  className?: string;
}) {
  const fallback = useMemo(() => fallbackAvatarUrl(name), [name]);
  const [avatarSrc, setAvatarSrc] = useState(src || fallback);

  useEffect(() => {
    setAvatarSrc(src || fallback);
  }, [src, fallback]);

  return (
    <img
      src={avatarSrc}
      alt={name}
      className={className}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        if (avatarSrc !== fallback) {
          setAvatarSrc(fallback);
        }
      }}
    />
  );
}

function Metric({
  label,
  value,
  icon,
  compact,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="p-4 rounded-2xl border border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03]">
      <div className="text-[10px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-500 mb-1 inline-flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      <div className={compact ? 'text-sm font-black truncate' : 'text-xl font-black truncate'}>{value}</div>
    </div>
  );
}

function ScoreBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-black/5 dark:bg-white/10 px-2.5 py-2 text-center">
      <div className="text-[9px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-500">{label}</div>
      <div className="text-xs font-black mt-1">{value}</div>
    </div>
  );
}

function ResearchLink({
  icon,
  label,
  href,
  status,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  href?: string;
  status: LinkHealthStatus;
  tone: 'blue' | 'emerald' | 'neutral';
}) {
  if (!href) return null;

  const toneClasses =
    tone === 'blue'
      ? 'geo-pill-soft text-[#7f3ee6] dark:text-[#e0aeff]'
      : tone === 'emerald'
        ? 'geo-pill-soft text-[#b548eb] dark:text-[#f0b7ff]'
        : 'bg-black/5 dark:bg-white/10 text-black/70 dark:text-zinc-200';

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black ${toneClasses}`}
      title={`${label}: ${statusLabel(status)}`}
    >
      {icon}
      {label}
      <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider ${statusClasses(status)}`}>
        {statusLabel(status)}
      </span>
    </a>
  );
}
