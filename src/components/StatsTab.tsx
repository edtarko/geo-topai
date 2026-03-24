import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  Legend,
  LineChart,
  Line,
} from 'recharts';
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Compass,
  Copy,
  Clock3,
  Database,
  Download,
  Filter,
  FileDown,
  Gauge,
  Minus,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingUp,
  Wifi,
} from 'lucide-react';
import { Project } from '../types';
import { formatProjectName } from '../utils/projectDisplay';
import {
  deployDataPath,
  downloadTextWithFallback,
  fetchJsonWithFallback,
  isHostedReadonlyMode,
  staticExportPath,
} from '../utils/deployData';

const COLORS = ['#9c46fd', '#cb5ef2', '#fd77e7', '#7b5bf4', '#d98af8', '#6f8cff', '#f2a6ea', '#8c6bff'];
const UI_LOCALE = 'en-US';

type ExportFormat = 'csv' | 'tsv' | 'json';

interface SimpleStats {
  categories: { name: string; value: number }[];
  languages: { name: string; value: number }[];
  licenses: { name: string; value: number }[];
  organizations: { name: string; value: number }[];
  totalStars: number;
  avgStars: number;
  totalProjects: number;
  maintenanceRate: number;
}

interface InsightsStatus {
  generatedAt: string;
  projects: {
    total: number;
    maintained: number;
    recentlyActive30d: number;
    recentlyActive90d: number;
    staleOver365d: number;
    unknownActivity: number;
    lastSyncedAt: string | null;
    latestRepoActivityAt: string | null;
  };
  researchers: {
    total: number;
    lastVerifiedAt: string | null;
    lastEnrichedAt: string | null;
  };
  coverage: {
    metadataCoverageScore: number;
    missingMetaProjects: number;
    fields: Array<{
      key: string;
      label: string;
      filled: number;
      coveragePercent: number;
    }>;
  };
  tokenPool: {
    configured: number;
    sampled: number;
    rateLimits: Array<{
      id: string;
      mode: 'authenticated' | 'anonymous';
      tokenMasked: string;
      status: 'ok' | 'error';
      core: {
        limit: number;
        remaining: number;
        resetAt: string | null;
      };
      search: {
        limit: number;
        remaining: number;
        resetAt: string | null;
      };
      graphql: {
        limit: number;
        remaining: number;
        resetAt: string | null;
      };
      error?: string;
    }>;
  };
}

interface InsightsSnapshot {
  savedAt: string;
  scopedProjects: number;
  scopedStars: number;
  maintenanceRate: number;
  active90: number;
  coverageScore: number;
}

interface StatsTabProps {
  projects: Project[];
  statsData: SimpleStats;
  topStars: Project[];
  theme: 'light' | 'dark';
  onProjectSelect: (project: Project) => void;
  onDataRefresh?: () => Promise<void> | void;
  onToast?: (tone: 'success' | 'error' | 'info' | 'warning', title: string, description?: string) => void;
}

const ACTIVITY_WINDOWS = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
  { label: '1y', days: 365 },
  { label: '2y', days: 730 },
  { label: 'All', days: 0 },
];

function formatStars(stars: number) {
  if (stars >= 1000000) return `${(stars / 1000000).toFixed(1)}M`;
  if (stars >= 1000) return `${(stars / 1000).toFixed(1)}k`;
  return stars.toLocaleString(UI_LOCALE);
}

function parseValidDate(input?: string | null) {
  if (!input) return null;
  const time = Date.parse(input);
  if (Number.isNaN(time)) return null;
  return new Date(time);
}

function toDaysAgo(dateValue?: string | null) {
  const date = parseValidDate(dateValue);
  if (!date) return null;
  const diff = Date.now() - date.getTime();
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

function formatDateTime(value?: string | null) {
  if (!value) return 'N/A';
  const date = parseValidDate(value);
  if (!date) return 'N/A';
  return date.toLocaleString(UI_LOCALE, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toCounterBy<T extends string>(values: T[]) {
  return values.reduce((acc: Record<string, number>, item) => {
    acc[item] = (acc[item] || 0) + 1;
    return acc;
  }, {});
}

function buildStats(projects: Project[]): SimpleStats {
  const categories = toCounterBy(projects.map((project) => project.category || 'unknown'));
  const languages = toCounterBy(projects.map((project) => project.language || 'Unknown'));
  const licenses = toCounterBy(projects.map((project) => project.license || 'Unknown'));
  const organizations = toCounterBy(projects.map((project) => project.org_name || 'Community'));

  const totalStars = projects.reduce((sum, project) => sum + (project.stars || 0), 0);
  const maintainedCount = projects.filter((project) => project.is_maintained).length;

  const sortByCount = (counter: Record<string, number>) =>
    Object.entries(counter)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

  return {
    categories: sortByCount(categories),
    languages: sortByCount(languages),
    licenses: sortByCount(licenses),
    organizations: sortByCount(organizations),
    totalStars,
    avgStars: projects.length ? Math.round(totalStars / projects.length) : 0,
    totalProjects: projects.length,
    maintenanceRate: projects.length ? Math.round((maintainedCount / projects.length) * 100) : 0,
  };
}

function buildMonthlyActivitySeries(projects: Project[], monthCount = 12) {
  const now = new Date();
  const months: Array<{ key: string; label: string; pushes: number }> = [];

  for (let index = monthCount - 1; index >= 0; index--) {
    const slot = new Date(now.getFullYear(), now.getMonth() - index, 1);
    const key = `${slot.getFullYear()}-${String(slot.getMonth() + 1).padStart(2, '0')}`;
    const label = slot.toLocaleDateString(UI_LOCALE, { month: 'short' });
    months.push({ key, label, pushes: 0 });
  }

  const monthIndex = new Map(months.map((entry, index) => [entry.key, index]));
  for (const project of projects) {
    const date = parseValidDate(project.repo_pushed_at);
    if (!date) continue;
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const index = monthIndex.get(key);
    if (index !== undefined) {
      months[index].pushes += 1;
    }
  }

  return months;
}

function escapeCsvCell(value: string) {
  if (value.includes('"')) return `"${value.replace(/"/g, '""')}"`;
  if (value.includes(',') || value.includes('\n')) return `"${value}"`;
  return value;
}

function buildCsv(rows: string[][]) {
  return rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(',')).join('\n');
}

function downloadTextFile(fileName: string, content: string, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

export default function StatsTab({
  projects,
  statsData,
  topStars,
  theme,
  onProjectSelect,
  onDataRefresh,
  onToast,
}: StatsTabProps) {
  const hostedReadonlyMode = isHostedReadonlyMode();
  const isDark = theme === 'dark';
  const [windowDays, setWindowDays] = useState<number>(180);
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [maintainedOnly, setMaintainedOnly] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');
  const [isExporting, setIsExporting] = useState<string | null>(null);
  const [isGeoExporting, setIsGeoExporting] = useState(false);
  const [status, setStatus] = useState<InsightsStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [showAdvancedActions, setShowAdvancedActions] = useState(false);
  const [showAdvancedDiagnostics, setShowAdvancedDiagnostics] = useState(false);
  const [snapshot, setSnapshot] = useState<InsightsSnapshot | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem('geo_insights_snapshot');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        savedAt: String((parsed as any).savedAt || ''),
        scopedProjects: Number((parsed as any).scopedProjects || 0),
        scopedStars: Number((parsed as any).scopedStars || 0),
        maintenanceRate: Number((parsed as any).maintenanceRate || 0),
        active90: Number((parsed as any).active90 || 0),
        coverageScore: Number((parsed as any).coverageScore || 0),
      };
    } catch {
      return null;
    }
  });
  const [featuredProjectId, setFeaturedProjectId] = useState<string | null>(null);
  const [watchlistIds, setWatchlistIds] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem('geo_user_watchlist');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  });
  const [compareIds, setCompareIds] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem('geo_compare_projects');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 3) : [];
    } catch {
      return [];
    }
  });
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [discoverMinStars, setDiscoverMinStars] = useState(0);
  const [hideUnknownLanguage, setHideUnknownLanguage] = useState(false);
  const [pinnedLanguage, setPinnedLanguage] = useState<string>('All');
  const [recentViewedIds, setRecentViewedIds] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem('geo_recent_viewed');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
    } catch {
      return [];
    }
  });
  const [projectNotes, setProjectNotes] = useState<Record<string, string>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = localStorage.getItem('geo_project_notes');
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'),
      );
    } catch {
      return {};
    }
  });

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const payload = await fetchJsonWithFallback<InsightsStatus>(
        '/api/insights/status?sample=4',
        deployDataPath('insights-status.json'),
      );
      setStatus(payload);
      setStatusError(null);
    } catch (error) {
      setStatusError((error as Error).message);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus, projects.length]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('geo_user_watchlist', JSON.stringify(watchlistIds));
  }, [watchlistIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('geo_compare_projects', JSON.stringify(compareIds.slice(0, 3)));
  }, [compareIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('geo_recent_viewed', JSON.stringify(recentViewedIds.slice(0, 8)));
  }, [recentViewedIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('geo_project_notes', JSON.stringify(projectNotes));
  }, [projectNotes]);

  useEffect(() => {
    if (typeof window === 'undefined' || !snapshot) return;
    localStorage.setItem('geo_insights_snapshot', JSON.stringify(snapshot));
  }, [snapshot]);

  const categoryOptions = useMemo(() => {
    const counters = toCounterBy(projects.map((project) => project.category || 'unknown'));
    return [
      'All',
      ...Object.entries(counters)
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name),
    ];
  }, [projects]);

  const filteredProjects = useMemo(() => {
    return projects.filter((project) => {
      if (categoryFilter !== 'All' && project.category !== categoryFilter) return false;
      if (maintainedOnly && !project.is_maintained) return false;
      if (windowDays <= 0) return true;

      const daysAgo = toDaysAgo(project.repo_pushed_at);
      if (daysAgo === null) return false;
      return daysAgo <= windowDays;
    });
  }, [projects, categoryFilter, maintainedOnly, windowDays]);

  const discoverLanguageOptions = useMemo(() => {
    const values = Array.from(
      new Set(
        filteredProjects
          .map((project) => project.language || 'Unknown')
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort((a, b) => a.localeCompare(b));
    return ['All', ...values];
  }, [filteredProjects]);

  const maxScopedStars = useMemo(() => {
    const highest = filteredProjects.reduce((max, project) => Math.max(max, project.stars || 0), 0);
    if (highest <= 0) return 0;
    return Math.ceil(highest / 5000) * 5000;
  }, [filteredProjects]);

  const discoverScopedProjects = useMemo(() => {
    const query = discoverQuery.trim().toLowerCase();
    return filteredProjects.filter((project) => {
      if (project.stars < discoverMinStars) return false;
      const projectLanguage = project.language || 'Unknown';
      if (hideUnknownLanguage && projectLanguage === 'Unknown') return false;
      if (pinnedLanguage !== 'All' && projectLanguage !== pinnedLanguage) return false;
      if (!query) return true;

      const haystack = [
        formatProjectName(project.name),
        project.description || '',
        project.org_name || '',
        project.category || '',
        projectLanguage,
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [filteredProjects, discoverQuery, discoverMinStars, hideUnknownLanguage, pinnedLanguage]);

  useEffect(() => {
    if (discoverMinStars > maxScopedStars) {
      setDiscoverMinStars(maxScopedStars);
    }
  }, [discoverMinStars, maxScopedStars]);

  useEffect(() => {
    if (pinnedLanguage !== 'All' && !discoverLanguageOptions.includes(pinnedLanguage)) {
      setPinnedLanguage('All');
    }
  }, [discoverLanguageOptions, pinnedLanguage]);

  const scopedStats = useMemo(() => buildStats(filteredProjects), [filteredProjects]);

  const freshness = useMemo(() => {
    let recent90 = 0;
    let staleYear = 0;
    let unknown = 0;
    for (const project of filteredProjects) {
      const days = toDaysAgo(project.repo_pushed_at);
      if (days === null) {
        unknown += 1;
        continue;
      }
      if (days <= 90) recent90 += 1;
      if (days > 365) staleYear += 1;
    }
    return { recent90, staleYear, unknown };
  }, [filteredProjects]);

  const maintainedByCategory = useMemo(() => {
    const grouped = filteredProjects.reduce((acc: Record<string, { name: string; active: number; inactive: number; total: number }>, project) => {
      if (!acc[project.category]) {
        acc[project.category] = { name: project.category, active: 0, inactive: 0, total: 0 };
      }
      acc[project.category].total += 1;
      if (project.is_maintained) acc[project.category].active += 1;
      else acc[project.category].inactive += 1;
      return acc;
    }, {});

    return Object.values(grouped)
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
  }, [filteredProjects]);

  const releaseBuckets = useMemo(() => {
    const buckets = [
      { name: '0-30d', count: 0 },
      { name: '31-90d', count: 0 },
      { name: '91-180d', count: 0 },
      { name: '181-365d', count: 0 },
      { name: '365d+', count: 0 },
      { name: 'Unknown', count: 0 },
    ];

    for (const project of filteredProjects) {
      const days = toDaysAgo(project.repo_pushed_at);
      if (days === null) {
        buckets[5].count += 1;
      } else if (days <= 30) {
        buckets[0].count += 1;
      } else if (days <= 90) {
        buckets[1].count += 1;
      } else if (days <= 180) {
        buckets[2].count += 1;
      } else if (days <= 365) {
        buckets[3].count += 1;
      } else {
        buckets[4].count += 1;
      }
    }

    return buckets;
  }, [filteredProjects]);

  const monthlyTrend = useMemo(() => buildMonthlyActivitySeries(filteredProjects, 12), [filteredProjects]);

  const scopedTopStars = useMemo(
    () => [...filteredProjects].sort((a, b) => b.stars - a.stars).slice(0, 8),
    [filteredProjects],
  );

  const topProjectsForChart = (scopedTopStars.length ? scopedTopStars : topStars.slice(0, 8)).map((project) => ({
    ...project,
    displayName: formatProjectName(project.name),
  }));

  const coverageRows = useMemo(() => {
    if (status?.coverage?.fields?.length) {
      return status.coverage.fields;
    }

    const total = projects.length;
    const withFirstRelease = projects.filter((project) => Boolean(project.first_release)).length;
    const withLatestVersion = projects.filter((project) => Boolean(project.latest_version)).length;
    const withRepoActivity = projects.filter((project) => Boolean(project.repo_pushed_at)).length;
    const withOrg = projects.filter((project) => Boolean(project.org_name)).length;
    const withDescription = projects.filter((project) => Boolean(project.description)).length;

    const toCoverage = (filled: number) => (total ? Number(((filled / total) * 100).toFixed(1)) : 0);

    return [
      { key: 'first_release', label: 'First Release', filled: withFirstRelease, coveragePercent: toCoverage(withFirstRelease) },
      { key: 'latest_version', label: 'Latest Version', filled: withLatestVersion, coveragePercent: toCoverage(withLatestVersion) },
      { key: 'repo_activity', label: 'Repository Activity Date', filled: withRepoActivity, coveragePercent: toCoverage(withRepoActivity) },
      { key: 'organization', label: 'Organization', filled: withOrg, coveragePercent: toCoverage(withOrg) },
      { key: 'description', label: 'Description', filled: withDescription, coveragePercent: toCoverage(withDescription) },
    ];
  }, [status, projects]);

  const coverageScore = status?.coverage?.metadataCoverageScore ?? (coverageRows.length
    ? Number((coverageRows.reduce((sum, item) => sum + item.coveragePercent, 0) / coverageRows.length).toFixed(1))
    : 0);

  const globalTopLanguageShare = statsData.totalProjects
    ? Math.round(((statsData.languages[0]?.value || 0) / statsData.totalProjects) * 100)
    : 0;
  const scopedTopLanguageShare = scopedStats.totalProjects
    ? Math.round(((scopedStats.languages[0]?.value || 0) / scopedStats.totalProjects) * 100)
    : 0;

  const chartTooltipStyle = {
    borderRadius: '16px',
    border: isDark ? '1px solid rgba(255,255,255,0.14)' : 'none',
    boxShadow: isDark ? '0 10px 25px -8px rgb(0 0 0 / 0.65)' : '0 10px 15px -3px rgb(0 0 0 / 0.1)',
    backgroundColor: isDark ? '#111318' : '#ffffff',
    color: isDark ? '#e5e7eb' : '#111827',
  } as const;

  const currentSnapshot = useMemo<InsightsSnapshot>(
    () => ({
      savedAt: new Date().toISOString(),
      scopedProjects: scopedStats.totalProjects,
      scopedStars: scopedStats.totalStars,
      maintenanceRate: scopedStats.maintenanceRate,
      active90: freshness.recent90,
      coverageScore,
    }),
    [coverageScore, freshness.recent90, scopedStats.maintenanceRate, scopedStats.totalProjects, scopedStats.totalStars],
  );

  const snapshotDelta = useMemo(() => {
    if (!snapshot) return null;
    return {
      projects: currentSnapshot.scopedProjects - snapshot.scopedProjects,
      stars: currentSnapshot.scopedStars - snapshot.scopedStars,
      maintenanceRate: currentSnapshot.maintenanceRate - snapshot.maintenanceRate,
      active90: currentSnapshot.active90 - snapshot.active90,
      coverageScore: Number((currentSnapshot.coverageScore - snapshot.coverageScore).toFixed(1)),
    };
  }, [currentSnapshot, snapshot]);

  const lowRateLimitTokens = useMemo(() => {
    const items = status?.tokenPool?.rateLimits || [];
    return items.filter((item) => item.status === 'ok' && item.mode === 'authenticated' && item.core.remaining <= 200);
  }, [status]);

  const handleRefreshInsights = async () => {
    if (hostedReadonlyMode) {
      setRefreshMessage('Hosted site runs in read-only mode. Use the local app for refresh and sync.');
      return;
    }

    setIsRefreshing(true);
    setRefreshMessage('');
    try {
      const syncResponse = await fetch('/api/sync-github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full: false }),
      });
      const syncData = await syncResponse.json();

      if (!syncResponse.ok || !syncData?.success) {
        setRefreshMessage(syncData?.message || 'Refresh is unavailable in the deployed site.');
        return;
      }

      const researcherResponse = await fetch('/api/researchers/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full: false, limit: 120 }),
      });
      const researcherData = await researcherResponse.json();
      if (!researcherResponse.ok || !researcherData?.success) {
        setRefreshMessage(researcherData?.message || 'Researcher refresh is unavailable in the deployed site.');
        return;
      }

      await onDataRefresh?.();
      await loadStatus();
      setRefreshMessage(
        `Projects updated: ${syncData.updatedCount || 0}/${syncData.totalCount || 0} · Researchers processed: ${researcherData?.processed || 0}`,
      );
    } catch (error) {
      console.error(error);
      setRefreshMessage('Refresh failed. Please retry.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleExport = async ({
    format,
    table,
    label,
  }: {
    format: ExportFormat;
    table: string;
    label: string;
  }) => {
    const exportKey = `${table}:${format}`;
    setIsExporting(exportKey);
    try {
      await downloadTextWithFallback(
        `/api/export?table=${encodeURIComponent(table)}&format=${format}`,
        staticExportPath(table, format),
        `${table}.${format}`,
        format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8',
      );
      setRefreshMessage(`${label} exported as ${format.toUpperCase()}.`);
    } catch (error) {
      console.error(error);
      setRefreshMessage(`${label} export ${format.toUpperCase()} failed.`);
    } finally {
      setIsExporting(null);
    }
  };

  const handleGeoPayloadExport = async () => {
    if (hostedReadonlyMode) {
      setRefreshMessage('GEO payload export is available in the local app only.');
      return;
    }

    setIsGeoExporting(true);
    try {
      const response = await fetch('/api/geo-space/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxProjects: 1000,
          maxPeople: 2500,
          outDir: 'geo_space_payload',
          writeSheetCsv: true,
          writeDemoLayout: true,
          personCsvPath: 'geo_space_payload/editable/Person.csv',
          paperCsvPath: 'geo_space_payload/editable/Paper.csv',
          projectCsvPath: 'geo_space_payload/editable/Projects.csv',
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.success) {
        setRefreshMessage(payload?.message || `Geo export failed (${response.status})`);
        return;
      }
      setRefreshMessage(
        `GEO draft exported: ${payload?.counts?.projects || 0} projects · ${payload?.counts?.people || 0} people · ${payload?.counts?.topics || 0} topics`,
      );
    } catch (error) {
      console.error(error);
      setRefreshMessage('GEO payload export failed.');
    } finally {
      setIsGeoExporting(false);
    }
  };

  const saveCurrentSnapshot = useCallback(() => {
    setSnapshot(currentSnapshot);
    onToast?.('success', 'Snapshot saved', 'You can now track deltas after refresh.');
  }, [currentSnapshot, onToast]);

  const staleWatchlist = useMemo(
    () =>
      [...projects]
        .map((project) => ({ project, days: toDaysAgo(project.repo_pushed_at) }))
        .filter((item) => item.days !== null)
        .sort((a, b) => (b.days as number) - (a.days as number))
        .slice(0, 5),
    [projects],
  );

  const scopedProjectSignals = useMemo(
    () =>
      discoverScopedProjects.map((project) => ({
        project,
        daysAgo: toDaysAgo(project.repo_pushed_at),
      })),
    [discoverScopedProjects],
  );

  const popularPick = useMemo(() => {
    const localTop = [...discoverScopedProjects].sort((a, b) => b.stars - a.stars)[0];
    return localTop || scopedTopStars[0] || topStars[0] || null;
  }, [discoverScopedProjects, scopedTopStars, topStars]);

  const activePick = useMemo(() => {
    const candidate = [...scopedProjectSignals]
      .filter((item) => item.daysAgo !== null)
      .sort((a, b) => (a.daysAgo as number) - (b.daysAgo as number) || b.project.stars - a.project.stars)[0];
    return candidate?.project || null;
  }, [scopedProjectSignals]);

  const hiddenGemPick = useMemo(() => {
    const candidate = [...scopedProjectSignals]
      .filter((item) => {
        if (item.daysAgo === null) return false;
        return item.project.is_maintained && item.project.stars >= 1200 && item.project.stars <= 60000 && item.daysAgo <= 180;
      })
      .sort((a, b) => b.project.stars - a.project.stars || (a.daysAgo as number) - (b.daysAgo as number))[0];
    return candidate?.project || popularPick;
  }, [scopedProjectSignals, popularPick]);

  const discoveryPicks = useMemo(() => {
    const seen = new Set<string>();
    const raw = [
      { id: 'popular', title: 'Popular Right Now', hint: 'Highest stars in your current scope', icon: <Star size={13} />, project: popularPick },
      { id: 'active', title: 'Most Active', hint: 'Recent repository activity and momentum', icon: <Activity size={13} />, project: activePick },
      { id: 'gem', title: 'Hidden Gem', hint: 'Strong quality with room to discover', icon: <Sparkles size={13} />, project: hiddenGemPick },
    ];
    return raw.filter((item) => {
      if (!item.project) return false;
      if (seen.has(item.project.id)) return false;
      seen.add(item.project.id);
      return true;
    });
  }, [popularPick, activePick, hiddenGemPick]);

  useEffect(() => {
    const first = discoveryPicks[0]?.project?.id || discoverScopedProjects[0]?.id || null;
    if (!first) {
      setFeaturedProjectId(null);
      return;
    }
    if (!featuredProjectId || !discoverScopedProjects.some((project) => project.id === featuredProjectId)) {
      setFeaturedProjectId(first);
    }
  }, [discoveryPicks, discoverScopedProjects, featuredProjectId]);

  const featuredProject = useMemo(() => {
    if (featuredProjectId) {
      const exact = discoverScopedProjects.find((project) => project.id === featuredProjectId);
      if (exact) return exact;
    }
    return discoveryPicks[0]?.project || discoverScopedProjects[0] || null;
  }, [featuredProjectId, discoveryPicks, discoverScopedProjects]);

  const featuredDaysAgo = featuredProject ? toDaysAgo(featuredProject.repo_pushed_at) : null;

  const userFeatureList = useMemo(
    () => [
      'Daily AI pick based on today’s ecosystem data.',
      'Rising projects list with momentum scoring.',
      'Fresh this week list for latest activity.',
      'Quick focus by top programming languages.',
      'Quick focus by top organizations.',
      'One-tap surprise project discovery.',
      'Personal watchlist with saved projects.',
      'Compare board for up to 3 projects side-by-side.',
      'Share selected project with deep link copy.',
      'Copy ready project summary for notes or chats.',
      'Instant search across project names, orgs, and descriptions.',
      'Minimum stars slider to remove low-signal repos.',
      'Hide Unknown language projects in one tap.',
      'Pinned language mode for focused exploration.',
      'Previous/Next navigation between discovered projects.',
      'Recent viewed history for quick return to past picks.',
      'Related projects suggestions based on current selection.',
      'Personal notes saved per project in browser storage.',
      'Export watchlist to CSV for spreadsheet workflows.',
      'Export compare board to CSV for side-by-side analysis.',
    ],
    [],
  );

  const applyDiscoveryPreset = useCallback((preset: 'trending' | 'stable' | 'explore') => {
    setDiscoverQuery('');
    setDiscoverMinStars(0);
    setHideUnknownLanguage(false);
    setPinnedLanguage('All');
    if (preset === 'trending') {
      setWindowDays(30);
      setMaintainedOnly(true);
      setCategoryFilter('All');
      onToast?.('info', 'Preset applied', 'Trending: 30 days + maintained only');
      return;
    }
    if (preset === 'stable') {
      setWindowDays(365);
      setMaintainedOnly(true);
      setCategoryFilter(categoryOptions.includes('framework') ? 'framework' : 'All');
      onToast?.('info', 'Preset applied', 'Stable: frameworks + maintained');
      return;
    }
    const modelLike = categoryOptions.find((item) => item === 'model' || item === 'tool' || item === 'library') || 'All';
    setWindowDays(90);
    setMaintainedOnly(false);
    setCategoryFilter(modelLike);
    onToast?.('info', 'Preset applied', `Explore: ${modelLike} in last 90 days`);
  }, [categoryOptions, onToast]);

  const handleSurprisePick = useCallback(() => {
    const pool = discoverScopedProjects.length ? discoverScopedProjects : filteredProjects.length ? filteredProjects : projects;
    if (!pool.length) {
      onToast?.('warning', 'No projects available', 'Try another filter to discover projects.');
      return;
    }
    const random = pool[Math.floor(Math.random() * pool.length)];
    setFeaturedProjectId(random.id);
    onToast?.('success', 'Surprise pick ready', formatProjectName(random.name));
  }, [discoverScopedProjects, filteredProjects, projects, onToast]);

  const copyText = useCallback(async (value: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    if (typeof document !== 'undefined') {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      return;
    }
    throw new Error('Clipboard is not available');
  }, []);

  const copyInsightsBrief = useCallback(async () => {
    const lines = [
      'Geo AI Insights Brief',
      `Scope: ${scopedStats.totalProjects}/${statsData.totalProjects} projects`,
      `Scoped stars: ${formatStars(scopedStats.totalStars)}`,
      `Maintained: ${scopedStats.maintenanceRate}%`,
      `Active 90d: ${freshness.recent90}`,
      `Coverage score: ${coverageScore}%`,
      `Generated: ${new Date().toLocaleString(UI_LOCALE)}`,
    ];
    try {
      await copyText(lines.join('\n'));
      onToast?.('success', 'Copied to clipboard', 'Insights brief copied.');
    } catch (error) {
      console.error(error);
      onToast?.('error', 'Copy failed', 'Unable to copy insights brief.');
    }
  }, [coverageScore, freshness.recent90, onToast, scopedStats.maintenanceRate, scopedStats.totalProjects, scopedStats.totalStars, statsData.totalProjects, copyText]);

  const languageShortcuts = useMemo(
    () => scopedStats.languages.map((item) => item.name).filter((item) => item && item !== 'Unknown').slice(0, 6),
    [scopedStats.languages],
  );

  const organizationShortcuts = useMemo(
    () => scopedStats.organizations.map((item) => item.name).filter(Boolean).slice(0, 6),
    [scopedStats.organizations],
  );

  const dailyPick = useMemo(() => {
    const pool = discoverScopedProjects.length ? discoverScopedProjects : filteredProjects.length ? filteredProjects : projects;
    if (!pool.length) return null;
    const key = new Date().toISOString().slice(0, 10);
    let hash = 0;
    for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return pool[hash % pool.length];
  }, [discoverScopedProjects, filteredProjects, projects]);

  const risingProjects = useMemo(
    () =>
      [...scopedProjectSignals]
        .filter((item) => item.daysAgo !== null && item.daysAgo <= 45)
        .sort((a, b) => {
          const aScore = a.project.stars + (45 - (a.daysAgo as number)) * 80 + (a.project.is_maintained ? 1500 : 0);
          const bScore = b.project.stars + (45 - (b.daysAgo as number)) * 80 + (b.project.is_maintained ? 1500 : 0);
          return bScore - aScore;
        })
        .slice(0, 5)
        .map((item) => item.project),
    [scopedProjectSignals],
  );

  const freshProjects = useMemo(
    () =>
      [...scopedProjectSignals]
        .filter((item) => item.daysAgo !== null && item.daysAgo <= 7)
        .sort((a, b) => (a.daysAgo as number) - (b.daysAgo as number) || b.project.stars - a.project.stars)
        .slice(0, 5)
        .map((item) => item.project),
    [scopedProjectSignals],
  );

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const watchlistProjects = useMemo(
    () => watchlistIds.map((id) => projectById.get(id)).filter((item): item is Project => Boolean(item)),
    [watchlistIds, projectById],
  );

  const compareProjects = useMemo(
    () => compareIds.map((id) => projectById.get(id)).filter((item): item is Project => Boolean(item)).slice(0, 3),
    [compareIds, projectById],
  );

  useEffect(() => {
    const validProjectIds = new Set(projects.map((project) => project.id));
    setWatchlistIds((current) => current.filter((id) => validProjectIds.has(id)));
    setCompareIds((current) => current.filter((id) => validProjectIds.has(id)).slice(0, 3));
  }, [projects]);

  const focusByLanguage = useCallback((language: string) => {
    const candidate = filteredProjects
      .filter((project) => project.language === language)
      .sort((a, b) => b.stars - a.stars)[0];
    if (!candidate) {
      onToast?.('warning', 'No match found', `No projects for ${language} in current scope.`);
      return;
    }
    setFeaturedProjectId(candidate.id);
    onToast?.('success', 'Language focus applied', `${language}: ${formatProjectName(candidate.name)}`);
  }, [filteredProjects, onToast]);

  const focusByOrganization = useCallback((org: string) => {
    const candidate = filteredProjects
      .filter((project) => (project.org_name || 'Community') === org)
      .sort((a, b) => b.stars - a.stars)[0];
    if (!candidate) {
      onToast?.('warning', 'No match found', `No projects for ${org} in current scope.`);
      return;
    }
    setFeaturedProjectId(candidate.id);
    onToast?.('success', 'Organization focus applied', `${org}: ${formatProjectName(candidate.name)}`);
  }, [filteredProjects, onToast]);

  const toggleWatchlist = useCallback((project: Project) => {
    setWatchlistIds((current) => {
      if (current.includes(project.id)) {
        onToast?.('info', 'Removed from watchlist', formatProjectName(project.name));
        return current.filter((id) => id !== project.id);
      }
      onToast?.('success', 'Added to watchlist', formatProjectName(project.name));
      return [project.id, ...current.filter((id) => id !== project.id)].slice(0, 24);
    });
  }, [onToast]);

  const toggleCompare = useCallback((project: Project) => {
    setCompareIds((current) => {
      if (current.includes(project.id)) {
        onToast?.('info', 'Removed from compare', formatProjectName(project.name));
        return current.filter((id) => id !== project.id);
      }
      if (current.length >= 3) {
        onToast?.('warning', 'Compare limit reached', 'You can compare up to 3 projects.');
        return current;
      }
      onToast?.('success', 'Added to compare', formatProjectName(project.name));
      return [...current, project.id];
    });
  }, [onToast]);

  const copyFeaturedShareLink = useCallback(async () => {
    if (!featuredProject || typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('project', featuredProject.id);
      await copyText(url.toString());
      onToast?.('success', 'Copied to clipboard', 'Share link copied');
    } catch (error) {
      console.error(error);
      onToast?.('error', 'Copy failed', 'Unable to copy share link.');
    }
  }, [featuredProject, copyText, onToast]);

  const copyFeaturedSummary = useCallback(async () => {
    if (!featuredProject) return;
    const summary = [
      `Project: ${formatProjectName(featuredProject.name)}`,
      `Category: ${featuredProject.category}`,
      `Language: ${featuredProject.language || 'Unknown'}`,
      `Stars: ${formatStars(featuredProject.stars)}`,
      `Updated: ${featuredDaysAgo !== null ? `${featuredDaysAgo} days ago` : 'Unknown'}`,
      `URL: ${featuredProject.github_url}`,
    ].join('\n');
    try {
      await copyText(summary);
      onToast?.('success', 'Copied to clipboard', 'Project summary copied');
    } catch (error) {
      console.error(error);
      onToast?.('error', 'Copy failed', 'Unable to copy project summary.');
    }
  }, [featuredProject, featuredDaysAgo, copyText, onToast]);

  const featuredNote = featuredProject ? (projectNotes[featuredProject.id] || '') : '';

  const recentViewedProjects = useMemo(
    () =>
      recentViewedIds
        .map((id) => projectById.get(id))
        .filter((item): item is Project => Boolean(item))
        .filter((item) => item.id !== featuredProject?.id)
        .slice(0, 6),
    [recentViewedIds, projectById, featuredProject],
  );

  const relatedProjects = useMemo(() => {
    if (!featuredProject) return [];
    return discoverScopedProjects
      .filter((project) => project.id !== featuredProject.id)
      .map((project) => {
        let score = 0;
        if ((project.language || 'Unknown') === (featuredProject.language || 'Unknown')) score += 3;
        if (project.category === featuredProject.category) score += 2;
        if ((project.org_name || 'Community') === (featuredProject.org_name || 'Community')) score += 1;
        score += Math.max(0, 2 - Math.abs(project.stars - featuredProject.stars) / 50000);
        return { project, score };
      })
      .sort((a, b) => b.score - a.score || b.project.stars - a.project.stars)
      .slice(0, 4)
      .map((item) => item.project);
  }, [discoverScopedProjects, featuredProject]);

  const featuredPosition = useMemo(
    () => (featuredProject ? discoverScopedProjects.findIndex((project) => project.id === featuredProject.id) : -1),
    [discoverScopedProjects, featuredProject],
  );

  const moveFeatured = useCallback((direction: 'prev' | 'next') => {
    if (!discoverScopedProjects.length) return;
    const currentIndex = featuredProject
      ? discoverScopedProjects.findIndex((project) => project.id === featuredProject.id)
      : -1;
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const offset = direction === 'next' ? 1 : -1;
    const nextIndex = (safeIndex + offset + discoverScopedProjects.length) % discoverScopedProjects.length;
    const nextProject = discoverScopedProjects[nextIndex];
    setFeaturedProjectId(nextProject.id);
  }, [discoverScopedProjects, featuredProject]);

  const updateFeaturedNote = useCallback((value: string) => {
    if (!featuredProject) return;
    const normalized = value.slice(0, 360);
    setProjectNotes((current) => ({ ...current, [featuredProject.id]: normalized }));
  }, [featuredProject]);

  const exportProjectSet = useCallback((items: Project[], filePrefix: string) => {
    if (!items.length) {
      onToast?.('warning', 'Nothing to export', 'Add projects first.');
      return;
    }
    const rows = [
      ['Name', 'GitHub URL', 'Stars', 'Language', 'Category', 'Maintained', 'Organization', 'Updated Days Ago'],
      ...items.map((project) => [
        formatProjectName(project.name),
        project.github_url,
        String(project.stars || 0),
        project.language || 'Unknown',
        project.category || 'unknown',
        project.is_maintained ? 'Yes' : 'No',
        project.org_name || 'Community',
        toDaysAgo(project.repo_pushed_at) !== null ? String(toDaysAgo(project.repo_pushed_at)) : 'Unknown',
      ]),
    ];
    const csv = buildCsv(rows);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadTextFile(`${filePrefix}-${stamp}.csv`, csv, 'text/csv;charset=utf-8');
    onToast?.('success', 'Export completed', `${items.length} project(s) exported.`);
  }, [onToast]);

  const exportWatchlistCsv = useCallback(() => {
    exportProjectSet(watchlistProjects, 'watchlist');
  }, [exportProjectSet, watchlistProjects]);

  const exportCompareCsv = useCallback(() => {
    exportProjectSet(compareProjects, 'compare');
  }, [exportProjectSet, compareProjects]);

  useEffect(() => {
    const validProjectIds = new Set(projects.map((project) => project.id));
    setRecentViewedIds((current) => current.filter((id) => validProjectIds.has(id)).slice(0, 8));
    setProjectNotes((current) => {
      const entries = Object.entries(current).filter(([id]) => validProjectIds.has(id));
      if (entries.length === Object.keys(current).length) return current;
      return Object.fromEntries(entries);
    });
  }, [projects]);

  useEffect(() => {
    if (!featuredProject) return;
    setRecentViewedIds((current) => [featuredProject.id, ...current.filter((id) => id !== featuredProject.id)].slice(0, 8));
  }, [featuredProject]);

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-black/5 dark:border-white/10 bg-white dark:bg-zinc-900 p-6">
        <div className="flex flex-col 2xl:flex-row gap-4 2xl:items-center 2xl:justify-between">
          <div>
            <h3 className="text-xl font-black tracking-tight">Insights Pro</h3>
            <p className="text-sm text-black/55 dark:text-zinc-400 mt-1">
              Live ecosystem analytics, quick actions, and cleaner user-focused intelligence.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleRefreshInsights}
              disabled={isRefreshing || hostedReadonlyMode}
              className="h-10 px-4 rounded-2xl geo-primary-btn text-sm font-black inline-flex items-center gap-2 disabled:opacity-60 transition-all"
            >
              <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
              {isRefreshing ? 'Refreshing...' : hostedReadonlyMode ? 'Local Refresh Only' : 'Refresh Insights'}
            </button>
            <button
              onClick={() => handleExport({
                format: 'csv',
                table: 'projects_top200_structured',
                label: 'Top 200 structured projects',
              })}
              disabled={Boolean(isExporting)}
              className="h-10 px-4 rounded-2xl geo-secondary-btn text-[#7f3ee6] dark:text-[#dda8ff] text-sm font-black inline-flex items-center gap-2 disabled:opacity-60 transition-all"
            >
              <Download size={14} />
              {isExporting === 'projects_top200_structured:csv' ? 'Exporting...' : 'Top 200 CSV'}
            </button>
            <button
              onClick={copyInsightsBrief}
              className="h-10 px-4 rounded-2xl geo-secondary-btn text-[#9c46fd] dark:text-[#e4b4ff] text-sm font-black inline-flex items-center gap-2 disabled:opacity-60 transition-all"
            >
              <Copy size={14} />
              Copy Brief
            </button>
            <button
              onClick={saveCurrentSnapshot}
              className="h-10 px-4 rounded-2xl geo-secondary-btn text-[#b053f4] dark:text-[#f0bdff] text-sm font-black inline-flex items-center gap-2 transition-all"
            >
              <Gauge size={14} />
              Save Snapshot
            </button>
            <button
              onClick={() => setShowAdvancedActions((value) => !value)}
              className="h-10 px-3 rounded-2xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 text-[11px] font-black uppercase tracking-wider inline-flex items-center gap-1.5 hover:bg-black/10 dark:hover:bg-white/15 transition-all"
            >
              Advanced
              {showAdvancedActions ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </div>
        </div>

        {showAdvancedActions && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => handleExport({
                format: 'json',
                table: 'projects_top200_structured',
                label: 'Top 200 structured projects',
              })}
              disabled={Boolean(isExporting)}
              className="h-9 px-3 rounded-xl geo-secondary-btn text-[#9c46fd] dark:text-[#e4b4ff] text-xs font-black inline-flex items-center gap-2 disabled:opacity-60 transition-all"
            >
              <Database size={13} />
              {isExporting === 'projects_top200_structured:json' ? 'Exporting...' : 'Top 200 JSON'}
            </button>
            <button
              onClick={() => handleExport({
                format: 'csv',
                table: 'projects',
                label: 'All projects',
              })}
              disabled={Boolean(isExporting)}
              className="h-9 px-3 rounded-xl geo-secondary-btn text-[#9c46fd] dark:text-[#e4b4ff] text-xs font-black inline-flex items-center gap-2 disabled:opacity-60 transition-all"
            >
              <FileDown size={13} />
              {isExporting === 'projects:csv' ? 'Exporting...' : 'All Projects CSV'}
            </button>
            <button
              onClick={handleGeoPayloadExport}
              disabled={isGeoExporting || hostedReadonlyMode}
              className="h-9 px-3 rounded-xl geo-secondary-btn text-[#b053f4] dark:text-[#f0bdff] text-xs font-black inline-flex items-center gap-2 disabled:opacity-60 transition-all"
            >
              <Database size={13} />
              {isGeoExporting ? 'Building GEO...' : 'Export GEO Draft'}
            </button>
          </div>
        )}

        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] p-3 flex items-center gap-3">
            <Filter size={14} className="text-black/45 dark:text-zinc-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-black/45 dark:text-zinc-400">Activity Window</span>
            <select
              value={windowDays}
              onChange={(event) => setWindowDays(Number(event.target.value))}
              className="ml-auto h-9 rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-900 px-3 text-xs font-black"
            >
              {ACTIVITY_WINDOWS.map((window) => (
                <option key={window.label} value={window.days}>{window.label}</option>
              ))}
            </select>
          </div>

          <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] p-3 flex items-center gap-3">
            <Filter size={14} className="text-black/45 dark:text-zinc-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-black/45 dark:text-zinc-400">Category</span>
            <select
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              className="ml-auto h-9 rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-900 px-3 text-xs font-black max-w-[180px]"
            >
              {categoryOptions.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </div>

          <button
            onClick={() => setMaintainedOnly((prev) => !prev)}
            className={`rounded-2xl border p-3 flex items-center justify-between gap-3 transition-all ${
              maintainedOnly
                ? 'geo-pill-soft border-[var(--geo-border)] text-[#7e3ce6] dark:text-[#e0aeff]'
                : 'border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03]'
            }`}
          >
            <span className="text-xs font-black uppercase tracking-wider">Maintained Only</span>
            <ShieldCheck size={14} />
          </button>
        </div>

        <div className="mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-[11px] font-bold text-black/45 dark:text-zinc-400">
          <span>
            Scope: {scopedStats.totalProjects} of {statsData.totalProjects} projects{windowDays ? ` in last ${windowDays} days` : ''}
          </span>
          <span className={refreshMessage.toLowerCase().includes('failed') ? 'text-red-600 dark:text-red-300' : 'geo-link'}>
            {refreshMessage}
          </span>
        </div>
      </section>

      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-4">
        <MetricCard label="Scoped Projects" value={scopedStats.totalProjects.toString()} icon={<Activity size={14} />} />
        <MetricCard label="Scoped Stars" value={formatStars(scopedStats.totalStars)} icon={<Star size={14} />} />
        <MetricCard label="Global Stars" value={formatStars(statsData.totalStars)} icon={<TrendingUp size={14} />} />
        <MetricCard label="Maintained" value={`${scopedStats.maintenanceRate}%`} icon={<ShieldCheck size={14} />} />
        <MetricCard label="Active 90d" value={freshness.recent90.toString()} icon={<CalendarDays size={14} />} />
        <MetricCard label="Stale 1y+" value={freshness.staleYear.toString()} icon={<Clock3 size={14} />} />
        <MetricCard label="Coverage" value={`${coverageScore}%`} icon={<Gauge size={14} />} />
        <MetricCard label="API Tokens" value={`${status?.tokenPool?.configured ?? 0}`} icon={<Wifi size={14} />} />
      </div>

      {snapshotDelta && (
        <section className="rounded-3xl border border-black/5 dark:border-white/10 bg-white dark:bg-zinc-900 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h4 className="text-sm font-black uppercase tracking-wider text-black/50 dark:text-zinc-400">
              Delta vs Snapshot ({snapshot ? formatDateTime(snapshot.savedAt) : 'N/A'})
            </h4>
            <button
              onClick={saveCurrentSnapshot}
              className="h-8 px-3 rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 text-[10px] font-black uppercase tracking-wider hover:bg-black/10 dark:hover:bg-white/15 transition-all"
            >
              Update Snapshot
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <DeltaItem label="Projects" value={snapshotDelta.projects} />
            <DeltaItem label="Stars" value={snapshotDelta.stars} compact />
            <DeltaItem label="Maintained %" value={snapshotDelta.maintenanceRate} />
            <DeltaItem label="Active 90d" value={snapshotDelta.active90} />
            <DeltaItem label="Coverage %" value={snapshotDelta.coverageScore} />
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-zinc-900 p-6 border border-black/5 dark:border-white/10 rounded-3xl shadow-sm xl:col-span-1">
          <h3 className="text-lg font-bold mb-4">Category Distribution (Scoped)</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={scopedStats.categories.slice(0, 8)}
                  cx="50%"
                  cy="50%"
                  innerRadius={58}
                  outerRadius={90}
                  paddingAngle={6}
                  dataKey="value"
                  stroke="none"
                >
                  {scopedStats.categories.slice(0, 8).map((_entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <RechartsTooltip contentStyle={chartTooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            {scopedStats.categories.slice(0, 8).map((item, i) => (
              <div key={item.name} className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                <span className="text-[10px] font-black uppercase text-black/50 dark:text-zinc-400 truncate">{item.name}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-900 p-6 border border-black/5 dark:border-white/10 rounded-3xl shadow-sm xl:col-span-2">
          <h3 className="text-lg font-bold mb-4">Top Projects by Stars</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topProjectsForChart} layout="vertical" margin={{ left: 20, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={isDark ? '#ffffff24' : '#00000008'} />
                <XAxis type="number" hide />
                <YAxis
                  dataKey="displayName"
                  type="category"
                  width={120}
                  tick={{ fontSize: 11, fontWeight: 700, fill: isDark ? '#e5e7eb' : '#1f2937' }}
                  axisLine={false}
                  tickLine={false}
                />
                <RechartsTooltip cursor={{ fill: isDark ? '#ffffff14' : '#00000005' }} contentStyle={chartTooltipStyle} />
                <Bar dataKey="stars" fill="#9c46fd" radius={[0, 10, 10, 0]} barSize={20} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-4">
            {topProjectsForChart.slice(0, 6).map((project) => (
              <button
                key={project.id}
                onClick={() => onProjectSelect(project)}
                className="text-left p-3 rounded-2xl bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 transition-all"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold truncate">{project.displayName}</span>
                  <span className="text-xs font-black text-amber-500">{formatStars(project.stars)}</span>
                </div>
                <div className="text-[10px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-400 mt-1">{project.category}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-zinc-900 p-6 border border-black/5 dark:border-white/10 rounded-3xl shadow-sm xl:col-span-2">
          <h3 className="text-lg font-bold mb-4">Maintenance by Category</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={maintainedByCategory} layout="vertical" margin={{ left: 20, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={isDark ? '#ffffff24' : '#00000008'} />
                <XAxis type="number" hide />
                <YAxis
                  dataKey="name"
                  type="category"
                  width={110}
                  tick={{ fontSize: 11, fontWeight: 700, fill: isDark ? '#e5e7eb' : '#1f2937' }}
                  axisLine={false}
                  tickLine={false}
                />
                <RechartsTooltip contentStyle={chartTooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="active" stackId="a" fill="#cb5ef2" radius={[0, 0, 0, 0]} />
                <Bar dataKey="inactive" stackId="a" fill="#ef4444" radius={[0, 10, 10, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-900 p-6 border border-black/5 dark:border-white/10 rounded-3xl shadow-sm">
          <h3 className="text-lg font-bold mb-4">Release Freshness</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={releaseBuckets} margin={{ left: 0, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#ffffff24' : '#00000008'} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: isDark ? '#e5e7eb' : '#374151' }} />
                <YAxis tick={{ fontSize: 11, fill: isDark ? '#e5e7eb' : '#374151' }} />
                <RechartsTooltip contentStyle={chartTooltipStyle} />
                <Area type="monotone" dataKey="count" stroke="#cb5ef2" fill="#cb5ef2" fillOpacity={0.25} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-zinc-900 p-6 border border-black/5 dark:border-white/10 rounded-3xl shadow-sm xl:col-span-2">
          <h3 className="text-lg font-bold mb-4">Monthly Activity Trend</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={monthlyTrend} margin={{ left: 8, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#ffffff24' : '#00000008'} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: isDark ? '#e5e7eb' : '#374151' }} />
                <YAxis tick={{ fontSize: 11, fill: isDark ? '#e5e7eb' : '#374151' }} />
                <RechartsTooltip contentStyle={chartTooltipStyle} />
                <Line type="monotone" dataKey="pushes" stroke="#9c46fd" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-900 p-6 border border-black/5 dark:border-white/10 rounded-3xl shadow-sm">
          <h3 className="text-lg font-bold mb-4">Metadata Completeness</h3>
          <div className="space-y-3">
            {coverageRows.map((row, index) => (
              <div key={row.key} className="rounded-2xl bg-black/5 dark:bg-white/10 p-3">
                <div className="flex items-center justify-between text-xs font-black uppercase tracking-wider mb-2">
                  <span className="text-black/60 dark:text-zinc-300">{row.label}</span>
                  <span>{row.coveragePercent.toFixed(1)}%</span>
                </div>
                <div className="h-2 rounded-full bg-black/10 dark:bg-white/15 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(2, row.coveragePercent)}%`, backgroundColor: COLORS[index % COLORS.length] }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-zinc-900 p-6 border border-black/5 dark:border-white/10 rounded-3xl shadow-sm">
          <h3 className="text-lg font-bold mb-4">Top Organizations</h3>
          <div className="space-y-3">
            {scopedStats.organizations.slice(0, 8).map((org) => (
              <div key={org.name} className="flex items-center justify-between p-3 rounded-2xl bg-black/5 dark:bg-white/10">
                <span className="text-sm font-bold truncate max-w-[190px]">{org.name}</span>
                <span className="text-[10px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-400">{org.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-900 p-6 border border-black/5 dark:border-white/10 rounded-3xl shadow-sm xl:col-span-2">
          <h3 className="text-lg font-bold mb-4">Actionable Insights</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <InsightCard
              title="Language Concentration"
              value={`${scopedTopLanguageShare}%`}
              subtitle={`Scoped top language: ${scopedStats.languages[0]?.name || 'N/A'} · Global: ${globalTopLanguageShare}%`}
            />
            <InsightCard
              title="Coverage Score"
              value={`${coverageScore}%`}
              subtitle={`${status?.coverage?.missingMetaProjects ?? 0} projects still missing core metadata`}
            />
            <InsightCard
              title="API Capacity"
              value={`${status?.tokenPool?.configured ?? 0} tokens`}
              subtitle={`Sampled: ${status?.tokenPool?.sampled ?? 0} · Accounts rotate automatically`}
            />
            <InsightCard
              title="Researchers Verified"
              value={`${status?.researchers?.total ?? 0}`}
              subtitle={`Last verified: ${formatDateTime(status?.researchers?.lastVerifiedAt || null)}`}
            />
          </div>

          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 rounded-2xl geo-pill-soft border border-[var(--geo-border)]">
              <div className="text-[10px] font-black uppercase tracking-widest text-[#7f3ee6] dark:text-[#e0aeff] mb-2">Ecosystem Strength</div>
              <p className="text-sm text-black/70 dark:text-zinc-300">
                {scopedStats.maintenanceRate >= 70
                  ? 'Most scoped projects are actively maintained. This is a strong adoption signal.'
                  : 'Maintenance coverage is mixed in the current scope. Validate roadmap and release cadence before relying on critical repos.'}
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-amber-500/10 dark:bg-amber-500/20">
              <div className="text-[10px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300 mb-2">Risk Hint</div>
              <p className="text-sm text-black/70 dark:text-zinc-300">
                {freshness.staleYear > freshness.recent90
                  ? 'Stale project volume is currently higher than fresh activity. Add governance checks before production adoption.'
                  : 'Fresh activity outpaces stale repos. Good indicator for patch velocity and innovation momentum.'}
              </p>
            </div>
          </div>
        </div>
      </div>

      <section className="relative overflow-hidden bg-white dark:bg-zinc-900 p-6 border border-black/5 dark:border-white/10 rounded-3xl shadow-sm">
        <div className="pointer-events-none absolute -top-14 -right-14 w-72 h-72 rounded-full geo-brand-gradient opacity-15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-10 w-64 h-64 rounded-full bg-[#9c46fd]/16 blur-3xl" />

        <div className="relative grid grid-cols-1 xl:grid-cols-3 gap-5">
          <div className="xl:col-span-2 space-y-4">
            <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-white/75 dark:bg-zinc-900/75 backdrop-blur-xl p-4">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black tracking-tight">Discover Mode</h3>
                  <p className="text-sm text-black/55 dark:text-zinc-400 mt-1">
                    Curated picks and quick exploration presets for regular users.
                  </p>
                </div>
                <div className="geo-pill-soft px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wider text-[#8b47ee] dark:text-[#deacff] inline-flex items-center gap-1.5">
                  <Compass size={12} />
                  User Focus
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => applyDiscoveryPreset('trending')}
                  className="h-10 px-3 rounded-xl geo-secondary-btn text-[#8b47ee] dark:text-[#deacff] text-xs font-black uppercase tracking-wider inline-flex items-center gap-1.5"
                >
                  <TrendingUp size={13} />
                  Trending 30d
                </button>
                <button
                  onClick={() => applyDiscoveryPreset('stable')}
                  className="h-10 px-3 rounded-xl geo-secondary-btn text-[#8b47ee] dark:text-[#deacff] text-xs font-black uppercase tracking-wider inline-flex items-center gap-1.5"
                >
                  <ShieldCheck size={13} />
                  Stable Stack
                </button>
                <button
                  onClick={() => applyDiscoveryPreset('explore')}
                  className="h-10 px-3 rounded-xl geo-secondary-btn text-[#8b47ee] dark:text-[#deacff] text-xs font-black uppercase tracking-wider inline-flex items-center gap-1.5"
                >
                  <Sparkles size={13} />
                  Explore New
                </button>
                <button
                  onClick={handleSurprisePick}
                  className="h-10 px-3 rounded-xl geo-primary-btn text-xs font-black uppercase tracking-wider inline-flex items-center gap-1.5"
                >
                  <Star size={13} />
                  Surprise Me
                </button>
                {dailyPick && (
                  <button
                    onClick={() => {
                      setFeaturedProjectId(dailyPick.id);
                      onToast?.('success', 'Daily pick selected', formatProjectName(dailyPick.name));
                    }}
                    className="h-10 px-3 rounded-xl geo-secondary-btn text-[#8b47ee] dark:text-[#deacff] text-xs font-black uppercase tracking-wider inline-flex items-center gap-1.5"
                  >
                    <Compass size={13} />
                    Daily Pick
                  </button>
                )}
              </div>

              <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-2.5">
                <label className="rounded-xl border border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2 flex items-center gap-2">
                  <Search size={13} className="text-black/45 dark:text-zinc-400" />
                  <input
                    value={discoverQuery}
                    onChange={(event) => setDiscoverQuery(event.target.value)}
                    placeholder="Search projects, orgs, descriptions..."
                    className="w-full bg-transparent text-xs font-bold outline-none placeholder:text-black/35 dark:placeholder:text-zinc-500"
                  />
                </label>
                <div className="rounded-xl border border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2">
                  <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-black/45 dark:text-zinc-400 mb-1">
                    <span>Min Stars</span>
                    <span>{discoverMinStars > 0 ? formatStars(discoverMinStars) : 'Any'}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={maxScopedStars}
                    step={maxScopedStars > 50000 ? 1000 : 250}
                    value={Math.min(discoverMinStars, maxScopedStars)}
                    onChange={(event) => setDiscoverMinStars(Number(event.target.value))}
                    className="w-full accent-[#9c46fd]"
                    disabled={maxScopedStars <= 0}
                  />
                </div>
                <div className="rounded-xl border border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2 flex items-center gap-2">
                  <span className="text-[10px] font-black uppercase tracking-wider text-black/45 dark:text-zinc-400">Language Pin</span>
                  <select
                    value={pinnedLanguage}
                    onChange={(event) => setPinnedLanguage(event.target.value)}
                    className="ml-auto h-8 rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-900 px-2 text-[11px] font-black max-w-[160px]"
                  >
                    {discoverLanguageOptions.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={() => setHideUnknownLanguage((prev) => !prev)}
                  className={`rounded-xl border px-3 py-2 flex items-center justify-between text-[10px] font-black uppercase tracking-wider transition-colors ${
                    hideUnknownLanguage
                      ? 'geo-pill-soft border-[var(--geo-border)] text-[#8b47ee] dark:text-[#deacff]'
                      : 'border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03]'
                  }`}
                >
                  Hide Unknown Language
                  <span>{hideUnknownLanguage ? 'On' : 'Off'}</span>
                </button>
              </div>
              <div className="mt-2 text-[11px] font-bold text-black/45 dark:text-zinc-400">
                Discover scope: {discoverScopedProjects.length} matched project(s)
              </div>

              <div className="mt-3 pt-3 border-t border-black/5 dark:border-white/10 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-black uppercase tracking-wider text-black/45 dark:text-zinc-400">Top Languages:</span>
                  {languageShortcuts.map((language) => (
                    <button
                      key={language}
                      onClick={() => focusByLanguage(language)}
                      className="px-2.5 py-1 rounded-full bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 text-[10px] font-black uppercase tracking-wider transition-colors"
                    >
                      {language}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-black uppercase tracking-wider text-black/45 dark:text-zinc-400">Top Orgs:</span>
                  {organizationShortcuts.map((org) => (
                    <button
                      key={org}
                      onClick={() => focusByOrganization(org)}
                      className="px-2.5 py-1 rounded-full bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 text-[10px] font-black uppercase tracking-wider transition-colors"
                    >
                      {org}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-white/70 dark:bg-zinc-900/70 backdrop-blur-xl p-4">
              <h4 className="text-sm font-black uppercase tracking-wider text-black/50 dark:text-zinc-400 mb-3">Curated Picks</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {discoveryPicks.map((item) => {
                  const project = item.project;
                  if (!project) return null;
                  const days = toDaysAgo(project.repo_pushed_at);
                  return (
                    <button
                      key={item.id}
                      onClick={() => setFeaturedProjectId(project.id)}
                      className={`rounded-2xl border p-3 text-left transition-all ${
                        featuredProject?.id === project.id
                          ? 'geo-pill-soft border-[var(--geo-border)]'
                          : 'border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] hover:bg-black/5 dark:hover:bg-white/10'
                      }`}
                    >
                      <div className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-[#8b47ee] dark:text-[#deacff] mb-1.5">
                        {item.icon}
                        {item.title}
                      </div>
                      <div className="text-sm font-black truncate">{formatProjectName(project.name)}</div>
                      <div className="text-[11px] font-bold text-black/50 dark:text-zinc-400 mt-1">{item.hint}</div>
                      <div className="mt-2 flex items-center justify-between text-[10px] font-black uppercase tracking-wider">
                        <span className="text-amber-500">{formatStars(project.stars)}</span>
                        <span className="text-black/45 dark:text-zinc-400">{days !== null ? `${days}d ago` : 'Unknown'}</span>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-xl bg-black/5 dark:bg-white/10 p-3 border border-black/5 dark:border-white/10">
                  <div className="text-[10px] font-black uppercase tracking-wider text-[#8b47ee] dark:text-[#deacff] mb-2 inline-flex items-center gap-1.5">
                    <TrendingUp size={12} />
                    Rising Projects
                  </div>
                  <div className="space-y-1.5">
                    {risingProjects.slice(0, 3).map((project) => (
                      <button
                        key={project.id}
                        onClick={() => setFeaturedProjectId(project.id)}
                        className="w-full text-left rounded-lg px-2.5 py-2 bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 transition-colors"
                      >
                        <div className="text-xs font-black truncate">{formatProjectName(project.name)}</div>
                        <div className="text-[10px] font-bold text-black/45 dark:text-zinc-400">{formatStars(project.stars)} stars</div>
                      </button>
                    ))}
                    {!risingProjects.length && <div className="text-[11px] font-bold text-black/45 dark:text-zinc-400">No rising projects in this scope.</div>}
                  </div>
                </div>

                <div className="rounded-xl bg-black/5 dark:bg-white/10 p-3 border border-black/5 dark:border-white/10">
                  <div className="text-[10px] font-black uppercase tracking-wider text-[#8b47ee] dark:text-[#deacff] mb-2 inline-flex items-center gap-1.5">
                    <CalendarDays size={12} />
                    Fresh This Week
                  </div>
                  <div className="space-y-1.5">
                    {freshProjects.slice(0, 3).map((project) => (
                      <button
                        key={project.id}
                        onClick={() => setFeaturedProjectId(project.id)}
                        className="w-full text-left rounded-lg px-2.5 py-2 bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 transition-colors"
                      >
                        <div className="text-xs font-black truncate">{formatProjectName(project.name)}</div>
                        <div className="text-[10px] font-bold text-black/45 dark:text-zinc-400">
                          {toDaysAgo(project.repo_pushed_at) !== null ? `${toDaysAgo(project.repo_pushed_at)}d ago` : 'Unknown'}
                        </div>
                      </button>
                    ))}
                    {!freshProjects.length && <div className="text-[11px] font-bold text-black/45 dark:text-zinc-400">No fresh updates in last 7 days.</div>}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-white/70 dark:bg-zinc-900/70 backdrop-blur-xl p-4">
              <h4 className="text-sm font-black uppercase tracking-wider text-black/50 dark:text-zinc-400 mb-3">Top 20 User Benefits</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {userFeatureList.map((feature, index) => (
                  <div key={feature} className="rounded-xl bg-black/5 dark:bg-white/10 px-3 py-2.5 flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full geo-pill-soft text-[10px] font-black text-[#8b47ee] dark:text-[#deacff] inline-flex items-center justify-center shrink-0">
                      {index + 1}
                    </span>
                    <span className="text-xs font-bold text-black/70 dark:text-zinc-300">{feature}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-white/75 dark:bg-zinc-900/75 backdrop-blur-xl p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h4 className="text-sm font-black uppercase tracking-wider text-black/50 dark:text-zinc-400">Selected Project</h4>
                {discoverScopedProjects.length > 1 && (
                  <div className="inline-flex items-center gap-1">
                    <button
                      onClick={() => moveFeatured('prev')}
                      className="h-8 w-8 rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 inline-flex items-center justify-center"
                      aria-label="Previous project"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <button
                      onClick={() => moveFeatured('next')}
                      className="h-8 w-8 rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 inline-flex items-center justify-center"
                      aria-label="Next project"
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </div>
              {featuredProject ? (
                <>
                  {featuredPosition >= 0 && (
                    <div className="text-[10px] font-black uppercase tracking-wider text-black/45 dark:text-zinc-400 mb-2">
                      Project {featuredPosition + 1} of {discoverScopedProjects.length}
                    </div>
                  )}
                  <div className="text-xl font-black leading-tight">{formatProjectName(featuredProject.name)}</div>
                  <p className="mt-2 text-sm text-black/65 dark:text-zinc-300 line-clamp-4">
                    {featuredProject.description || 'No description available.'}
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-xl bg-black/5 dark:bg-white/10 px-3 py-2">
                      <div className="text-[9px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-500">Stars</div>
                      <div className="text-sm font-black mt-1">{formatStars(featuredProject.stars)}</div>
                    </div>
                    <div className="rounded-xl bg-black/5 dark:bg-white/10 px-3 py-2">
                      <div className="text-[9px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-500">Updated</div>
                      <div className="text-sm font-black mt-1">{featuredDaysAgo !== null ? `${featuredDaysAgo}d ago` : 'Unknown'}</div>
                    </div>
                    <div className="rounded-xl bg-black/5 dark:bg-white/10 px-3 py-2">
                      <div className="text-[9px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-500">Category</div>
                      <div className="text-sm font-black mt-1 capitalize">{featuredProject.category}</div>
                    </div>
                    <div className="rounded-xl bg-black/5 dark:bg-white/10 px-3 py-2">
                      <div className="text-[9px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-500">Health</div>
                      <div className={`text-sm font-black mt-1 ${featuredProject.is_maintained ? 'text-[#8b47ee] dark:text-[#deacff]' : 'text-red-500'}`}>
                        {featuredProject.is_maintained ? 'Active' : 'Watch'}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      onClick={() => onProjectSelect(featuredProject)}
                      className="h-10 px-3 rounded-xl geo-primary-btn text-xs font-black uppercase tracking-wider"
                    >
                      Open Details
                    </button>
                    <a
                      href={featuredProject.github_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="h-10 px-3 rounded-xl geo-secondary-btn text-[#8b47ee] dark:text-[#deacff] text-xs font-black uppercase tracking-wider inline-flex items-center justify-center"
                    >
                      Open GitHub
                    </a>
                    <button
                      onClick={() => toggleWatchlist(featuredProject)}
                      className="h-10 px-3 rounded-xl geo-secondary-btn text-[#8b47ee] dark:text-[#deacff] text-xs font-black uppercase tracking-wider"
                    >
                      {watchlistIds.includes(featuredProject.id) ? 'Remove Watchlist' : 'Add Watchlist'}
                    </button>
                    <button
                      onClick={() => toggleCompare(featuredProject)}
                      className="h-10 px-3 rounded-xl geo-secondary-btn text-[#8b47ee] dark:text-[#deacff] text-xs font-black uppercase tracking-wider"
                    >
                      {compareIds.includes(featuredProject.id) ? 'Remove Compare' : 'Add Compare'}
                    </button>
                    <button
                      onClick={copyFeaturedShareLink}
                      className="h-10 px-3 rounded-xl geo-secondary-btn text-[#8b47ee] dark:text-[#deacff] text-xs font-black uppercase tracking-wider"
                    >
                      Share Link
                    </button>
                    <button
                      onClick={copyFeaturedSummary}
                      className="h-10 px-3 rounded-xl geo-secondary-btn text-[#8b47ee] dark:text-[#deacff] text-xs font-black uppercase tracking-wider"
                    >
                      Copy Summary
                    </button>
                  </div>
                  <div className="mt-3 rounded-xl bg-black/5 dark:bg-white/10 border border-black/5 dark:border-white/10 p-3">
                    <div className="text-[10px] font-black uppercase tracking-wider text-black/45 dark:text-zinc-400 mb-1.5">
                      Personal Notes
                    </div>
                    <textarea
                      value={featuredNote}
                      onChange={(event) => updateFeaturedNote(event.target.value)}
                      placeholder="Add your quick notes about this project..."
                      className="w-full min-h-[76px] resize-y rounded-lg bg-white/80 dark:bg-zinc-950/70 border border-black/10 dark:border-white/10 px-2.5 py-2 text-xs font-medium outline-none"
                    />
                    <div className="text-[10px] font-bold text-black/40 dark:text-zinc-500 mt-1">{featuredNote.length}/360</div>
                  </div>
                </>
              ) : (
                <div className="text-sm font-bold text-black/50 dark:text-zinc-400">No project selected for this filter set.</div>
              )}
            </div>

            <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-white/75 dark:bg-zinc-900/75 backdrop-blur-xl p-4">
              <h4 className="text-sm font-black uppercase tracking-wider text-black/50 dark:text-zinc-400 mb-3">Related For You</h4>
              <div className="space-y-2.5">
                {relatedProjects.map((project) => (
                  <button
                    key={project.id}
                    onClick={() => setFeaturedProjectId(project.id)}
                    className="w-full rounded-xl bg-black/5 dark:bg-white/10 px-3 py-2 text-left hover:bg-black/10 dark:hover:bg-white/15 transition-colors border border-black/5 dark:border-white/10"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-black truncate">{formatProjectName(project.name)}</span>
                      <span className="text-[10px] font-black uppercase tracking-wider text-amber-500">{formatStars(project.stars)}</span>
                    </div>
                    <div className="mt-0.5 text-[10px] font-bold text-black/45 dark:text-zinc-400 truncate">
                      {project.category} · {project.language || 'Unknown'}
                    </div>
                  </button>
                ))}
                {!relatedProjects.length && (
                  <div className="text-xs font-bold text-black/45 dark:text-zinc-400">Pick a project to get similar recommendations.</div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-white/75 dark:bg-zinc-900/75 backdrop-blur-xl p-4">
              <h4 className="text-sm font-black uppercase tracking-wider text-black/50 dark:text-zinc-400 mb-3">Recently Viewed</h4>
              <div className="space-y-2.5">
                {recentViewedProjects.map((project) => (
                  <button
                    key={project.id}
                    onClick={() => setFeaturedProjectId(project.id)}
                    className="w-full rounded-xl bg-black/5 dark:bg-white/10 px-3 py-2 text-left hover:bg-black/10 dark:hover:bg-white/15 transition-colors border border-black/5 dark:border-white/10"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-black truncate">{formatProjectName(project.name)}</span>
                      <span className="text-[10px] font-black uppercase tracking-wider text-black/45 dark:text-zinc-400">
                        {toDaysAgo(project.repo_pushed_at) !== null ? `${toDaysAgo(project.repo_pushed_at)}d` : 'Unknown'}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10px] font-bold text-black/45 dark:text-zinc-400 truncate">
                      {project.category} · {project.language || 'Unknown'}
                    </div>
                  </button>
                ))}
                {!recentViewedProjects.length && (
                  <div className="text-xs font-bold text-black/45 dark:text-zinc-400">Viewed projects will appear here automatically.</div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-white/75 dark:bg-zinc-900/75 backdrop-blur-xl p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h4 className="text-sm font-black uppercase tracking-wider text-black/50 dark:text-zinc-400">My Watchlist</h4>
                {watchlistProjects.length > 0 && (
                  <button
                    onClick={exportWatchlistCsv}
                    className="text-[10px] font-black uppercase tracking-wider text-[#8b47ee] dark:text-[#deacff] inline-flex items-center gap-1"
                  >
                    <FileDown size={12} />
                    CSV
                  </button>
                )}
              </div>
              <div className="space-y-2.5">
                {watchlistProjects.slice(0, 6).map((project) => (
                  <button
                    key={project.id}
                    onClick={() => setFeaturedProjectId(project.id)}
                    className="w-full rounded-xl bg-black/5 dark:bg-white/10 px-3 py-2 text-left hover:bg-black/10 dark:hover:bg-white/15 transition-colors border border-black/5 dark:border-white/10"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-black truncate">{formatProjectName(project.name)}</span>
                      <span className="text-[10px] font-black uppercase tracking-wider text-amber-500">{formatStars(project.stars)}</span>
                    </div>
                    <div className="mt-0.5 text-[10px] font-bold text-black/45 dark:text-zinc-400 truncate">
                      {project.category} · {project.language || 'Unknown'}
                    </div>
                  </button>
                ))}
                {!watchlistProjects.length && (
                  <div className="text-xs font-bold text-black/45 dark:text-zinc-400">Save projects to build your personal watchlist.</div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-white/75 dark:bg-zinc-900/75 backdrop-blur-xl p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h4 className="text-sm font-black uppercase tracking-wider text-black/50 dark:text-zinc-400">Compare Board</h4>
                <div className="inline-flex items-center gap-2">
                  {compareProjects.length > 0 && (
                    <button
                      onClick={exportCompareCsv}
                      className="text-[10px] font-black uppercase tracking-wider text-[#8b47ee] dark:text-[#deacff] inline-flex items-center gap-1"
                    >
                      <FileDown size={12} />
                      CSV
                    </button>
                  )}
                  {compareIds.length > 0 && (
                    <button
                      onClick={() => setCompareIds([])}
                      className="text-[10px] font-black uppercase tracking-wider text-[#8b47ee] dark:text-[#deacff]"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              {compareProjects.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-[10px] font-black uppercase tracking-wider text-black/45 dark:text-zinc-400">
                        <th className="pb-2 pr-3">Project</th>
                        <th className="pb-2 pr-3">Stars</th>
                        <th className="pb-2 pr-3">Updated</th>
                        <th className="pb-2">Health</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compareProjects.map((project) => (
                        <tr key={project.id} className="border-t border-black/5 dark:border-white/10">
                          <td className="py-2 pr-3 font-black">{formatProjectName(project.name)}</td>
                          <td className="py-2 pr-3 font-bold">{formatStars(project.stars)}</td>
                          <td className="py-2 pr-3 font-bold">
                            {toDaysAgo(project.repo_pushed_at) !== null ? `${toDaysAgo(project.repo_pushed_at)}d` : 'Unknown'}
                          </td>
                          <td className={`py-2 font-black ${project.is_maintained ? 'text-[#8b47ee] dark:text-[#deacff]' : 'text-red-500'}`}>
                            {project.is_maintained ? 'Active' : 'Watch'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-xs font-bold text-black/45 dark:text-zinc-400">Add up to 3 projects to compare side-by-side.</div>
              )}
            </div>

            <div className="rounded-2xl border border-black/5 dark:border-white/10 bg-white/75 dark:bg-zinc-900/75 backdrop-blur-xl p-4">
              <h4 className="text-sm font-black uppercase tracking-wider text-black/50 dark:text-zinc-400 mb-3">Needs Attention</h4>
              <div className="space-y-2.5">
                {staleWatchlist.map(({ project, days }) => (
                  <button
                    key={project.id}
                    onClick={() => onProjectSelect(project)}
                    className="w-full rounded-xl bg-black/5 dark:bg-white/10 px-3 py-2 text-left hover:bg-black/10 dark:hover:bg-white/15 transition-colors border border-black/5 dark:border-white/10"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-black truncate">{formatProjectName(project.name)}</span>
                      <span className="text-[10px] font-black uppercase tracking-wider text-amber-600 dark:text-amber-300">
                        {(days as number).toLocaleString(UI_LOCALE)}d
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10px] font-bold text-black/45 dark:text-zinc-400 truncate">
                      {project.category} · {project.language || 'Unknown'}
                    </div>
                  </button>
                ))}
                {staleWatchlist.length === 0 && (
                  <div className="text-xs font-bold text-black/45 dark:text-zinc-400">No stale repositories detected in current data.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-zinc-900 p-6 border border-black/5 dark:border-white/10 rounded-3xl shadow-sm">
          <h3 className="text-lg font-bold mb-4">Language Leaders</h3>
          <div className="space-y-3">
            {scopedStats.languages.slice(0, 8).map((item, index) => {
              const share = scopedStats.totalProjects ? Math.round((item.value / scopedStats.totalProjects) * 100) : 0;
              return (
                <div key={item.name} className="rounded-2xl bg-black/5 dark:bg-white/10 p-3">
                  <div className="flex items-center justify-between text-sm font-bold">
                    <span>{index + 1}. {item.name}</span>
                    <span>{item.value} projects</span>
                  </div>
                  <div className="mt-2 h-2 rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
                    <div className="h-full rounded-full geo-brand-gradient" style={{ width: `${share}%` }} />
                  </div>
                  <div className="text-[10px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-500 mt-1">
                    {share}% share
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-900 p-6 border border-black/5 dark:border-white/10 rounded-3xl shadow-sm">
          <div className="flex items-center justify-between gap-2 mb-4">
            <h3 className="text-lg font-bold">Sync Status</h3>
            <button
              onClick={() => setShowAdvancedDiagnostics((value) => !value)}
              className="h-8 px-3 rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 text-[10px] font-black uppercase tracking-wider inline-flex items-center gap-1.5 hover:bg-black/10 dark:hover:bg-white/15 transition-all"
            >
              Diagnostics
              {showAdvancedDiagnostics ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </div>
          <div className="space-y-3">
            <div className="rounded-2xl bg-black/5 dark:bg-white/10 p-3 flex items-center justify-between">
              <span className="text-xs font-black uppercase tracking-wider text-black/45 dark:text-zinc-400">Last Insights Check</span>
              <span className="text-sm font-bold">{formatDateTime(status?.generatedAt || null)}</span>
            </div>
            <div className="rounded-2xl bg-black/5 dark:bg-white/10 p-3 flex items-center justify-between">
              <span className="text-xs font-black uppercase tracking-wider text-black/45 dark:text-zinc-400">Last Project Sync</span>
              <span className="text-sm font-bold">{formatDateTime(status?.projects?.lastSyncedAt || null)}</span>
            </div>
            <div className="rounded-2xl bg-black/5 dark:bg-white/10 p-3 flex items-center justify-between">
              <span className="text-xs font-black uppercase tracking-wider text-black/45 dark:text-zinc-400">Latest Repo Activity</span>
              <span className="text-sm font-bold">{formatDateTime(status?.projects?.latestRepoActivityAt || null)}</span>
            </div>

            {showAdvancedDiagnostics && (
              <div className="space-y-2">
                {(status?.tokenPool?.rateLimits || []).map((item) => (
                  <div key={item.id} className="rounded-2xl bg-black/5 dark:bg-white/10 p-3">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="text-xs font-black uppercase tracking-wider text-black/45 dark:text-zinc-400">
                        {item.mode === 'anonymous' ? 'Anonymous Pool' : item.tokenMasked}
                      </span>
                      <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full ${item.status === 'ok' ? 'geo-pill-soft text-[#7f3ee6] dark:text-[#e0aeff]' : 'bg-red-500/15 text-red-700 dark:text-red-300'}`}>
                        {item.status}
                      </span>
                    </div>
                    <div className="text-xs font-bold text-black/65 dark:text-zinc-300">
                      Core: {item.core.remaining}/{item.core.limit} · Search: {item.search.remaining}/{item.search.limit} · GraphQL: {item.graphql.remaining}/{item.graphql.limit}
                    </div>
                    <div className="text-[10px] font-bold text-black/45 dark:text-zinc-400 mt-1">
                      Reset: {formatDateTime(item.core.resetAt)}
                    </div>
                  </div>
                ))}
                {lowRateLimitTokens.length > 0 && (
                  <div className="text-xs font-bold text-amber-600 dark:text-amber-300 inline-flex items-center gap-2">
                    <AlertTriangle size={12} />
                    {lowRateLimitTokens.length} authenticated token(s) are close to rate-limit.
                  </div>
                )}
              </div>
            )}

            {statusLoading && (
              <div className="text-xs font-bold text-black/45 dark:text-zinc-400 inline-flex items-center gap-2">
                <RefreshCw size={12} className="animate-spin" />
                Loading status...
              </div>
            )}
            {statusError && (
              <div className="text-xs font-bold text-red-600 dark:text-red-300 inline-flex items-center gap-2">
                <AlertTriangle size={12} />
                {statusError}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-900 p-4 border border-black/5 dark:border-white/10 rounded-2xl shadow-sm">
      <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-black/40 dark:text-zinc-400 mb-1">
        {icon}
        {label}
      </div>
      <div className="text-xl font-black">{value}</div>
    </div>
  );
}

function InsightCard({ title, value, subtitle }: { title: string; value: string; subtitle: string }) {
  return (
    <div className="p-4 rounded-2xl bg-black/5 dark:bg-white/10 border border-black/5 dark:border-white/10">
      <div className="text-[10px] font-black uppercase tracking-widest text-black/40 dark:text-zinc-400 mb-2">{title}</div>
      <div className="text-2xl font-black mb-1">{value}</div>
      <div className="text-xs font-medium text-black/60 dark:text-zinc-300">{subtitle}</div>
    </div>
  );
}

function DeltaItem({ label, value, compact = false }: { label: string; value: number; compact?: boolean }) {
  const toneClass = value > 0 ? 'text-emerald-600 dark:text-emerald-300' : value < 0 ? 'text-red-600 dark:text-red-300' : 'text-black/50 dark:text-zinc-400';
  const Icon = value > 0 ? Plus : value < 0 ? Minus : null;
  const formatted = compact
    ? Math.abs(value).toLocaleString(UI_LOCALE)
    : Math.abs(value) % 1 === 0
      ? Math.abs(value).toString()
      : Math.abs(value).toFixed(1);

  return (
    <div className="rounded-xl bg-black/5 dark:bg-white/10 border border-black/5 dark:border-white/10 px-3 py-2">
      <div className="text-[10px] font-black uppercase tracking-wider text-black/45 dark:text-zinc-400">{label}</div>
      <div className={`mt-1 text-sm font-black inline-flex items-center gap-1 ${toneClass}`}>
        {Icon ? <Icon size={12} /> : null}
        {value > 0 ? '+' : value < 0 ? '-' : ''}{formatted}
      </div>
    </div>
  );
}
