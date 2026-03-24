import React, { useState, useEffect, Suspense, lazy, useRef, useCallback, useMemo } from 'react';
import { 
  Search, 
  Github, 
  Users, 
  Building2, 
  GitBranch, 
  Star, 
  ExternalLink, 
  Info, 
  Layers,
  ChevronRight,
  Database,
  RefreshCw,
  Network,
  Moon,
  Sun,
  Sparkles,
  Shuffle,
  Globe2,
  Copy,
  Check,
  ArrowUpRight,
  Link2,
  X,
  ArrowLeft,
  GraduationCap,
  Activity,
  Heart,
  Download,
  Keyboard
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Project } from './types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatProjectName } from './utils/projectDisplay';
import { deployDataPath, fetchJsonWithFallback, fetchJsonWithFallbackTransform, isHostedReadonlyMode } from './utils/deployData';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const GraphTab = lazy(() => import('./components/GraphTab'));
const StatsTab = lazy(() => import('./components/StatsTab'));
const ResearchersTab = lazy(() => import('./components/ResearchersTab'));
const UI_LOCALE = 'en-US';
const AUTO_SYNC_INTERVAL_MS = 1000 * 60 * 30;
const MAX_RECENT_PROJECTS = 10;

type ToastTone = 'success' | 'error' | 'info' | 'warning';
type AppView = 'list' | 'graph' | 'stats' | 'researchers';
type CardDensity = 'comfortable' | 'compact';

interface ToastMessage {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

const formatStars = (stars: number) => {
  if (stars >= 1000000) {
    return `${(stars / 1000000).toFixed(1)}M`;
  }
  if (stars >= 1000) {
    return `${(stars / 1000).toFixed(1)}k`;
  }
  return stars.toLocaleString();
};

const PAGE_SIZE = 18;

const exportProjectsAsCsv = (projects: Project[]) => {
  const headers = [
    'id',
    'name',
    'category',
    'stars',
    'language',
    'license',
    'is_maintained',
    'organization',
    'github_url',
    'latest_version',
    'latest_release_date',
    'repo_pushed_at',
    'description',
  ];

  const escapeCell = (value: string | number | boolean | null | undefined) => {
    const raw = value === null || value === undefined ? '' : String(value);
    if (/[",\n]/.test(raw)) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  };

  const rows = projects.map((project) =>
    [
      project.id,
      formatProjectName(project.name),
      project.category,
      project.stars,
      project.language || 'Unknown',
      project.license || 'Unknown',
      project.is_maintained,
      project.org_name || 'Community',
      toSafeExternalUrl(project.github_url) || '',
      project.latest_version || '',
      project.latest_release_date || '',
      project.repo_pushed_at || '',
      project.description || '',
    ]
      .map((item) => escapeCell(item))
      .join(','),
  );

  return [headers.join(','), ...rows].join('\n');
};

const triggerFileDownload = (filename: string, content: string, type = 'text/plain;charset=utf-8') => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const safeReadArray = (key: string): string[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

const toSafeExternalUrl = (url?: string | null) => {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const getDomain = (url?: string | null) => {
  const safe = toSafeExternalUrl(url);
  if (!safe) return 'N/A';
  try {
    return new URL(safe).hostname.replace(/^www\./, '');
  } catch {
    return 'N/A';
  }
};

const getRepoOwner = (url?: string | null) => {
  const safe = toSafeExternalUrl(url);
  if (!safe) return null;
  try {
    const path = new URL(safe).pathname.replace(/^\/+/, '');
    const owner = path.split('/')[0];
    return owner || null;
  } catch {
    return null;
  }
};

const getDaysAgo = (dateString?: string | null) => {
  if (!dateString) return null;
  const ts = Date.parse(dateString);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24)));
};

const getRelativeAgeLabel = (dateString?: string | null) => {
  if (!dateString) return null;
  const ts = Date.parse(dateString);
  if (Number.isNaN(ts)) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - ts) / (1000 * 60)));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

const formatDateLabel = (value?: string | null) => {
  if (!value) return 'N/A';
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleDateString(UI_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const formatTimeLabel = (value?: string | Date | null) => {
  if (!value) return 'N/A';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleTimeString(UI_LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatDateTimeLabel = (value?: string | Date | null) => {
  if (!value) return 'N/A';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString(UI_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const hasIncompleteMeta = (project?: Partial<Project> | null) => {
  if (!project) return true;
  return (
    !project.first_release ||
    !project.repo_pushed_at ||
    !project.org_name ||
    project.org_name === 'Community'
  );
};

export default function App() {
  const hostedReadonlyMode = isHostedReadonlyMode();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(() => localStorage.getItem('geo_active_category') || 'All');
  const [sortBy, setSortBy] = useState<'stars' | 'updated' | 'name' | 'repo'>(() => {
    const saved = localStorage.getItem('geo_sort_by');
    if (saved === 'updated' || saved === 'name' || saved === 'repo') return saved;
    return 'stars';
  });
  const [maintainedOnly, setMaintainedOnly] = useState(() => localStorage.getItem('geo_maintained_only') === '1');
  const [favoritesOnly, setFavoritesOnly] = useState(() => localStorage.getItem('geo_favorites_only') === '1');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) {
      return 'dark';
    }
    return 'light';
  });
  const [view, setView] = useState<AppView>(() => {
    const saved = localStorage.getItem('geo_view');
    if (saved === 'graph' || saved === 'stats' || saved === 'researchers') return saved;
    return 'list';
  });
  const [cardDensity, setCardDensity] = useState<CardDensity>(() => (localStorage.getItem('geo_card_density') === 'compact' ? 'compact' : 'comfortable'));
  const [favoriteProjectIds, setFavoriteProjectIds] = useState<string[]>(() => safeReadArray('geo_favorite_projects'));
  const [recentProjectIds, setRecentProjectIds] = useState<string[]>(() => safeReadArray('geo_recent_projects'));
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(() => localStorage.getItem('geo_last_sync_at'));
  const [isSeeding, setIsSeeding] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const didHydrateProjectFromUrl = useRef(false);
  const didTriggerAutoSync = useRef(false);
  const favoriteSet = useMemo(() => new Set(favoriteProjectIds), [favoriteProjectIds]);

  const dismissToast = useCallback((toastId: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== toastId));
  }, []);

  const pushToast = useCallback((tone: ToastTone, title: string, description?: string) => {
    const toastId = Number(`${Date.now()}${Math.floor(Math.random() * 1000)}`);
    setToasts((current) => [...current.slice(-3), { id: toastId, tone, title, description }]);
    window.setTimeout(() => {
      dismissToast(toastId);
    }, 4600);
  }, [dismissToast]);

  useEffect(() => {
    // Load from local cache first for instant UI
    const cached = localStorage.getItem('geo_projects_cache');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          setProjects(parsed);
          setLoading(false);
        }
      } catch {
        localStorage.removeItem('geo_projects_cache');
      }
    }
    fetchProjects();
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem('geo_theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('geo_view', view);
  }, [view]);

  useEffect(() => {
    localStorage.setItem('geo_card_density', cardDensity);
  }, [cardDensity]);

  useEffect(() => {
    localStorage.setItem('geo_sort_by', sortBy);
    localStorage.setItem('geo_maintained_only', maintainedOnly ? '1' : '0');
    localStorage.setItem('geo_favorites_only', favoritesOnly ? '1' : '0');
    localStorage.setItem('geo_active_category', activeCategory);
  }, [sortBy, maintainedOnly, favoritesOnly, activeCategory]);

  useEffect(() => {
    localStorage.setItem('geo_favorite_projects', JSON.stringify(favoriteProjectIds));
  }, [favoriteProjectIds]);

  useEffect(() => {
    localStorage.setItem('geo_recent_projects', JSON.stringify(recentProjectIds));
  }, [recentProjectIds]);

  const fetchProjects = async () => {
    try {
      const data = await fetchJsonWithFallback<Project[]>('/api/projects', deployDataPath('projects.json'));
      setProjects(data);
      localStorage.setItem('geo_projects_cache', JSON.stringify(data));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async ({ full = false, silent = false }: { full?: boolean; silent?: boolean } = {}) => {
    if (hostedReadonlyMode) {
      const message = 'Hosted site runs in read-only mode. Use local app for sync and refresh.';
      if (!silent) {
        pushToast('warning', 'Sync unavailable', message);
      }
      return { success: false, error: 'read-only-deployment', message };
    }

    setIsSyncing(true);
    try {
      const endpoint = full ? '/api/sync-github?full=1' : '/api/sync-github';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchProjects();
        const syncAt = new Date().toISOString();
        setLastSyncAt(syncAt);
        localStorage.setItem('geo_last_sync_at', syncAt);

        if (data.rateLimitHit) {
          const resetDate = new Date(data.resetTime);
          const timeStr = formatTimeLabel(resetDate);
          console.warn(`GitHub rate limit reached. Updated ${data.updatedCount}/${data.totalCount}. Resets at ${timeStr}.`);
          if (!silent) {
            pushToast(
              'warning',
              'Partial sync completed',
              `Updated ${data.updatedCount}/${data.totalCount}. Rate limit resets at ${timeStr}.`,
            );
          }
        } else if (data.updatedCount > 0) {
          console.log(`Updated ${data.updatedCount}/${data.totalCount} projects${full ? ' (full sync)' : ''}.`);
          if (!silent) {
            pushToast('success', 'Ecosystem synchronized', `Updated ${data.updatedCount} repositories.`);
          }
        } else if (data.message) {
          console.log(data.message);
          if (!silent) {
            pushToast('info', 'Sync completed', data.message);
          }
        }
      } else if (!silent) {
        pushToast('warning', 'Sync unavailable', data?.message || 'This action is unavailable in the deployed site.');
      }
      return data;
    } catch (err) {
      console.error("Sync error:", err);
      if (!silent) {
        pushToast('error', 'Sync failed', 'Unable to synchronize with GitHub API.');
      }
      return null;
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSeed = async () => {
    if (hostedReadonlyMode) {
      pushToast('warning', 'Discovery unavailable', 'Hosted site runs in read-only mode. Use local app for discovery and refresh.');
      return;
    }

    setIsSeeding(true);
    try {
      // Fetch up to 1000 real projects via discovery
      let res = await fetch('/api/discover', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: "topic:machine-learning stars:>1000", limit: 1000 })
      });
      let data = await res.json();
      
      // Fallback if the first query fails or returns too few results
      if ((!data.success && data.error === 'invalid-query') || (data.success && data.count < 50)) {
        console.warn("Primary discovery query yielded insufficient results, trying fallback...");
        res = await fetch('/api/discover', { 
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: "ai stars:>500", limit: 1000 })
        });
        data = await res.json();
      }
      
      if (data.success) {
        pushToast('info', 'Discovery completed', `Discovered or updated ${data.count} repositories. Starting full metadata sync...`);
        await fetchProjects();
        const syncResult = await handleSync({ full: true, silent: true });
        let researcherSyncMessage = '';
        try {
          const researcherRes = await fetch('/api/researchers/refresh?full=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ full: true }),
          });
          const researcherData = await researcherRes.json();
          if (researcherData?.success) {
            const avatarTail = researcherData.avatarBackfilled
              ? ` Avatars backfilled: ${researcherData.avatarBackfilled}.`
              : '';
            researcherSyncMessage = `Researchers verified: ${researcherData.processed} profiles.${avatarTail}`;
          }
        } catch (researcherError) {
          console.warn('Researchers refresh after ecosystem sync failed:', researcherError);
        }

        if (syncResult?.success) {
          if (syncResult.rateLimitHit) {
            const resetDate = new Date(syncResult.resetTime);
            pushToast(
              'warning',
              'Refresh completed with limits',
              `Synced ${syncResult.updatedCount}/${syncResult.totalCount}. Retry after ${formatTimeLabel(resetDate)}. ${researcherSyncMessage}`.trim(),
            );
          } else {
            pushToast(
              'success',
              'Ecosystem fully refreshed',
              `${syncResult.updatedCount}/${syncResult.totalCount} projects updated. ${researcherSyncMessage}`.trim(),
            );
          }
        }
      } else {
        pushToast(
          data?.error === 'read-only-deployment' ? 'warning' : 'error',
          data?.error === 'read-only-deployment' ? 'Discovery unavailable' : 'Refresh failed',
          data?.message || 'GitHub API might be rate-limited or the query is invalid.',
        );
      }
    } catch (err) {
      console.error(err);
      pushToast('error', 'Refresh failed', 'Unexpected error during ecosystem refresh.');
    } finally {
      setIsSeeding(false);
    }
  };

  const uniqueProjects = useMemo(() => {
    const seen = new Set();
    return projects.filter(p => {
      const url = p.github_url?.toLowerCase().trim().replace(/\/$/, "");
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  }, [projects]);

  const missingMetaCount = useMemo(
    () => uniqueProjects.filter((project) => hasIncompleteMeta(project)).length,
    [uniqueProjects],
  );

  const recentProjects = useMemo(
    () =>
      recentProjectIds
        .map((projectId) => uniqueProjects.find((project) => project.id === projectId))
        .filter((project): project is Project => Boolean(project)),
    [recentProjectIds, uniqueProjects],
  );

  useEffect(() => {
    if (hostedReadonlyMode) return;
    if (loading || isSyncing || isSeeding || didTriggerAutoSync.current) return;
    if (!uniqueProjects.length) return;

    if (!missingMetaCount) return;

    const lastAutoSyncAt = Number(localStorage.getItem('geo_last_auto_sync_at') || '0');
    const now = Date.now();
    if (now - lastAutoSyncAt < AUTO_SYNC_INTERVAL_MS) return;

    didTriggerAutoSync.current = true;
    localStorage.setItem('geo_last_auto_sync_at', String(now));
    void handleSync({ silent: true });
  }, [hostedReadonlyMode, loading, isSyncing, isSeeding, uniqueProjects, missingMetaCount]);

  const categoryFilters = useMemo(() => {
    const counts = uniqueProjects.reduce((acc: Record<string, number>, p) => {
      acc[p.category] = (acc[p.category] || 0) + 1;
      return acc;
    }, {});

    return [
      'All',
      ...Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 7)
        .map(([name]) => name),
    ];
  }, [uniqueProjects]);

  useEffect(() => {
    if (activeCategory !== 'All' && !categoryFilters.includes(activeCategory)) {
      setActiveCategory('All');
    }
  }, [activeCategory, categoryFilters]);

  const filteredProjects = useMemo(() => {
    const filtered = uniqueProjects.filter((p) => {
      const displayName = formatProjectName(p.name).toLowerCase();
      const matchesText =
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        displayName.includes(searchQuery.toLowerCase()) ||
        p.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.category.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesCategory = activeCategory === 'All' || p.category === activeCategory;
      const matchesMaintenance = !maintainedOnly || p.is_maintained;
      const matchesFavorites = !favoritesOnly || favoriteSet.has(p.id);
      return matchesText && matchesCategory && matchesMaintenance && matchesFavorites;
    });

    const sorted = [...filtered];
    if (sortBy === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === 'repo') {
      sorted.sort((a, b) => getDomain(a.github_url).localeCompare(getDomain(b.github_url)));
    } else if (sortBy === 'updated') {
      sorted.sort((a, b) => {
        const aTs = Date.parse(a.repo_pushed_at || '') || 0;
        const bTs = Date.parse(b.repo_pushed_at || '') || 0;
        return bTs - aTs;
      });
    } else {
      sorted.sort((a, b) => b.stars - a.stars);
    }
    return sorted;
  }, [uniqueProjects, searchQuery, activeCategory, maintainedOnly, favoritesOnly, favoriteSet, sortBy]);

  const statsData = useMemo(() => {
    const categories = projects.reduce((acc: Record<string, number>, p) => {
      acc[p.category] = (acc[p.category] || 0) + 1;
      return acc;
    }, {});
    
    const languages = projects.reduce((acc: Record<string, number>, p) => {
      if (p.language) acc[p.language] = (acc[p.language] || 0) + 1;
      return acc;
    }, {});

    const licenses = projects.reduce((acc: Record<string, number>, p) => {
      if (p.license) acc[p.license] = (acc[p.license] || 0) + 1;
      return acc;
    }, {});

    const organizations = projects.reduce((acc: Record<string, number>, p) => {
      const org = p.org_name || 'Community';
      acc[org] = (acc[org] || 0) + 1;
      return acc;
    }, {});

    const totalStars = projects.reduce((sum, p) => sum + p.stars, 0);
    const avgStars = projects.length ? Math.round(totalStars / projects.length) : 0;
    const maintainedCount = projects.filter(p => p.is_maintained).length;
    
    return {
      categories: Object.entries(categories).map(([name, value]) => ({ name, value })),
      languages: Object.entries(languages).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 5),
      licenses: Object.entries(licenses).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 5),
      organizations: Object.entries(organizations).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 5),
      totalStars,
      avgStars,
      totalProjects: projects.length,
      maintenanceRate: projects.length ? Math.round((maintainedCount / projects.length) * 100) : 0
    };
  }, [projects]);

  const topStars = [...projects].sort((a, b) => b.stars - a.stars).slice(0, 8);
  const isDark = theme === 'dark';
  const visibleProjects = filteredProjects.slice(0, visibleCount);
  const lastSyncLabel = lastSyncAt ? formatDateTimeLabel(lastSyncAt) : 'Not synced yet';

  const toggleFavorite = useCallback((projectId: string) => {
    const isFavoriteNow = favoriteSet.has(projectId);
    const willBeEmptyAfterRemove = isFavoriteNow && favoriteProjectIds.length === 1;

    setFavoriteProjectIds((current) => {
      if (isFavoriteNow) {
        return current.filter((id) => id !== projectId);
      }
      return [projectId, ...current.filter((id) => id !== projectId)].slice(0, 200);
    });

    if (isFavoriteNow) {
      if (favoritesOnly && willBeEmptyAfterRemove) {
        setFavoritesOnly(false);
        pushToast('info', 'Removed from favorites', 'Favorites filter was turned off because no favorite projects are left.');
      } else {
        pushToast('info', 'Removed from favorites');
      }
    } else {
      pushToast('success', 'Added to favorites');
    }
  }, [favoriteSet, favoriteProjectIds.length, favoritesOnly, pushToast]);

  useEffect(() => {
    if (favoritesOnly && favoriteProjectIds.length === 0) {
      setFavoritesOnly(false);
    }
  }, [favoritesOnly, favoriteProjectIds.length]);

  const exportFilteredProjects = useCallback((format: 'csv' | 'json') => {
    if (!filteredProjects.length) {
      pushToast('warning', 'No projects to export', 'Adjust filters and try again.');
      return;
    }

    const dateTag = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      triggerFileDownload(
        `geo-projects-filtered-${dateTag}.json`,
        JSON.stringify(filteredProjects, null, 2),
        'application/json;charset=utf-8',
      );
    } else {
      triggerFileDownload(
        `geo-projects-filtered-${dateTag}.csv`,
        exportProjectsAsCsv(filteredProjects),
        'text/csv;charset=utf-8',
      );
    }

    pushToast('success', `Exported ${filteredProjects.length} projects`, `Format: ${format.toUpperCase()}`);
  }, [filteredProjects, pushToast]);

  const clearAllFilters = useCallback(() => {
    setSearchQuery('');
    setActiveCategory('All');
    setMaintainedOnly(false);
    setFavoritesOnly(false);
    setSortBy('stars');
    pushToast('info', 'Filters reset');
  }, [pushToast]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [searchQuery, activeCategory, maintainedOnly, favoritesOnly, sortBy]);

  useEffect(() => {
    if (didHydrateProjectFromUrl.current) return;
    if (!uniqueProjects.length) return;
    didHydrateProjectFromUrl.current = true;

    const projectId = new URLSearchParams(window.location.search).get('project');
    if (!projectId) return;
    const project = uniqueProjects.find((item) => item.id === projectId);
    if (project) setSelectedProject(project);
  }, [uniqueProjects]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedProject) {
      url.searchParams.set('project', selectedProject.id);
    } else {
      url.searchParams.delete('project');
    }
    window.history.replaceState({}, '', url.toString());
  }, [selectedProject]);

  useEffect(() => {
    if (!selectedProject?.id) return;
    setRecentProjectIds((current) => {
      const next = [selectedProject.id, ...current.filter((id) => id !== selectedProject.id)].slice(0, MAX_RECENT_PROJECTS);
      return next;
    });
  }, [selectedProject?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));

      if (event.key === '?') {
        event.preventDefault();
        setShowShortcuts((value) => !value);
        return;
      }

      if (isTyping) return;
      const key = event.key.toLowerCase();

      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (key === 't') {
        event.preventDefault();
        setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
        return;
      }

      if (key === 'r') {
        event.preventDefault();
        if (!hostedReadonlyMode && !isSeeding && !isSyncing) {
          void handleSeed();
        }
        return;
      }

      if (key === 'f' && view === 'list') {
        event.preventDefault();
        setFavoritesOnly((value) => !value);
        return;
      }

      if (key === '1') setView('list');
      if (key === '2') setView('graph');
      if (key === '3') setView('stats');
      if (key === '4') setView('researchers');
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hostedReadonlyMode, view, isSeeding, isSyncing, handleSeed]);

  const handleSurpriseMe = () => {
    if (!filteredProjects.length) {
      pushToast('warning', 'Nothing to pick', 'No projects match current filters.');
      return;
    }
    const randomProject = filteredProjects[Math.floor(Math.random() * filteredProjects.length)];
    setSelectedProject(randomProject);
  };

  return (
    <div
      className="min-h-screen font-sans neo-blur flex flex-col transition-colors duration-300"
      style={{ backgroundColor: 'var(--geo-bg)', color: 'var(--geo-text)' }}
    >
      {/* Sidebar / Navigation */}
      <header className="border-b border-black/5 dark:border-white/10 bg-white/60 dark:bg-zinc-950/70 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img 
              src="/logo.png" 
              alt="Geo Logo" 
              className="w-9 h-9 rounded-xl object-cover shadow-sm border border-black/5 dark:border-white/10" 
              onError={(e) => {
                if (e.currentTarget.src.includes('/logo.png')) {
                  e.currentTarget.src = "/logo.svg";
                  return;
                }
                e.currentTarget.src = "https://api.dicebear.com/7.x/shapes/svg?seed=Geo";
              }}
            />
            <h1 className="text-xl font-black tracking-tight">Geo</h1>
          </div>

          <nav className="hidden md:flex items-center gap-1 bg-black/5 dark:bg-white/10 p-1 rounded-full">
            <NavButton active={view === 'list'} onClick={() => setView('list')} icon={<Layers size={16} />} label="Projects" />
            <NavButton active={view === 'graph'} onClick={() => setView('graph')} icon={<Network size={16} />} label="Ecosystem" />
            <NavButton active={view === 'stats'} onClick={() => setView('stats')} icon={<Database size={16} />} label="Insights Pro" />
            <NavButton active={view === 'researchers'} onClick={() => setView('researchers')} icon={<GraduationCap size={16} />} label="Researchers" />
          </nav>

          <div className="flex items-center gap-2 md:gap-3">
            <button
              onClick={() => setShowShortcuts(true)}
              className="w-10 h-10 rounded-full bg-black/5 dark:bg-white/10 flex items-center justify-center text-black/70 dark:text-zinc-200 hover:bg-black/10 dark:hover:bg-white/20 transition-all"
              title="Keyboard shortcuts (?)"
              aria-label="Open keyboard shortcuts"
            >
              <Keyboard size={16} />
            </button>
            <button
              onClick={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
              className="w-10 h-10 rounded-full bg-black/5 dark:bg-white/10 flex items-center justify-center text-black/70 dark:text-zinc-200 hover:bg-black/10 dark:hover:bg-white/20 transition-all"
              title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {isDark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button 
              onClick={handleSeed}
              disabled={hostedReadonlyMode || isSeeding || isSyncing}
              className="geo-primary-btn flex items-center gap-2 px-3 md:px-4 py-2 rounded-full text-sm font-medium transition-all disabled:opacity-50"
              title={hostedReadonlyMode ? 'Hosted site is read-only' : 'Discover repositories and run full metadata sync'}
            >
              {isSeeding ? <RefreshCw size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              <span className="hidden sm:inline">{hostedReadonlyMode ? 'Local Refresh Only' : 'Refresh Ecosystem'}</span>
              <span className="sm:hidden">{hostedReadonlyMode ? 'Local Only' : 'Refresh'}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="border-b border-black/5 dark:border-white/10 bg-white/70 dark:bg-zinc-950/65 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs font-bold">
          <div className="inline-flex items-center gap-2 text-black/55 dark:text-zinc-300">
            <span className="geo-pill-soft px-2 py-1 rounded-full text-[#8f49ee] dark:text-[#dca3ff] uppercase tracking-wider">Sync Status</span>
            <span>Last sync: {lastSyncLabel}</span>
            <span className="hidden sm:inline">•</span>
            <span>{missingMetaCount} projects still need metadata enrichment</span>
          </div>
          <div className="inline-flex items-center gap-2">
            <button
              onClick={() => exportFilteredProjects('csv')}
              className="px-3 py-1.5 rounded-xl bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 transition-all inline-flex items-center gap-1.5"
            >
              <Download size={12} />
              Export Filtered CSV
            </button>
            <button
              onClick={() => exportFilteredProjects('json')}
              className="px-3 py-1.5 rounded-xl bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 transition-all inline-flex items-center gap-1.5"
            >
              <Database size={12} />
              Export JSON
            </button>
          </div>
        </div>
      </div>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-28 md:pb-8 flex-1 w-full">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
            <RefreshCw size={32} className="animate-spin text-black/20 dark:text-zinc-500" />
            <p className="text-sm text-black/40 dark:text-zinc-400 font-medium">Loading ecosystem data...</p>
          </div>
        ) : (
          <AnimatePresence mode="wait">
            {view === 'list' && (
              <motion.div 
                key="list"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-12"
              >
                {/* Hero Section */}
                <section className="py-12 md:py-20 border-b border-black/5 dark:border-white/10">
                  <div className="max-w-3xl">
                    <motion.div
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.1 }}
                      className="geo-pill-soft inline-flex items-center gap-2 px-3 py-1 text-[#8f49ee] dark:text-[#dca3ff] rounded-full text-[10px] font-black uppercase tracking-widest mb-6"
                    >
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#cb5ef2] opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-[#9c46fd]"></span>
                      </span>
                      Live Ecosystem Data
                    </motion.div>
                    <h2 className="text-4xl sm:text-5xl md:text-7xl font-black tracking-tight leading-[0.9] mb-8">
                      Mapping the <span className="geo-brand-text">AI Stack</span>.
                    </h2>
                    <p className="text-xl text-black/50 dark:text-zinc-300/80 leading-relaxed max-w-2xl mb-10">
                      Discover, analyze, and explore the most critical open-source projects shaping the future of artificial intelligence.
                    </p>
                    <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-4">
                      <div className="relative group w-full lg:w-auto">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-black/30 dark:text-zinc-500 group-focus-within:text-black dark:group-focus-within:text-zinc-100 transition-colors" size={18} />
                        <input 
                          ref={searchInputRef}
                          type="text" 
                          placeholder="Search projects, categories... (Press /)"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                        className="geo-focus-ring pl-12 pr-6 py-4 bg-white dark:bg-zinc-900 border border-black/10 dark:border-white/15 rounded-2xl w-full lg:w-80 focus:outline-none transition-all shadow-xl shadow-black/5 dark:shadow-black/40"
                        />
                      </div>
                      <div className="flex items-center gap-3 text-sm font-bold text-black/40 dark:text-zinc-400">
                        <span className="w-12 h-[1px] bg-black/10 dark:bg-white/15"></span>
                        {filteredProjects.length} / {uniqueProjects.length} Projects
                      </div>
                      <button
                        onClick={handleSurpriseMe}
                        disabled={!filteredProjects.length}
                        className="geo-secondary-btn inline-flex items-center justify-center gap-2 px-4 py-4 lg:py-3 rounded-2xl font-bold text-sm transition-all disabled:opacity-50"
                      >
                        <Shuffle size={16} />
                        Surprise Me
                      </button>
                    </div>
                    <div className="mt-8 flex flex-wrap gap-2">
                      {categoryFilters.map((category) => (
                        <button
                          key={category}
                          onClick={() => setActiveCategory(category)}
                          className={cn(
                            "px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-wider transition-all",
                            activeCategory === category
                              ? "geo-primary-btn text-white"
                              : "bg-black/5 dark:bg-white/10 text-black/50 dark:text-zinc-300 hover:bg-black/10 dark:hover:bg-white/20"
                          )}
                        >
                          {category}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
                      <div className="p-4 rounded-2xl bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10">
                        <div className="text-[10px] font-black uppercase tracking-widest text-black/30 dark:text-zinc-500 mb-1">Maintained</div>
                        <div className="text-xl font-black text-[#8f49ee] dark:text-[#dca3ff]">{statsData.maintenanceRate}%</div>
                      </div>
                      <div className="p-4 rounded-2xl bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10">
                        <div className="text-[10px] font-black uppercase tracking-widest text-black/30 dark:text-zinc-500 mb-1">Total Stars</div>
                        <div className="text-xl font-black">{formatStars(statsData.totalStars)}</div>
                      </div>
                      <div className="p-4 rounded-2xl bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10">
                        <div className="text-[10px] font-black uppercase tracking-widest text-black/30 dark:text-zinc-500 mb-1">Top Category</div>
                        <div className="text-xl font-black flex items-center gap-2">
                          <Sparkles size={16} className="text-amber-500" />
                          {statsData.categories[0]?.name || 'N/A'}
                        </div>
                      </div>
                      <div className="p-4 rounded-2xl bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10">
                        <div className="text-[10px] font-black uppercase tracking-widest text-black/30 dark:text-zinc-500 mb-1">Favorites</div>
                        <div className="text-xl font-black flex items-center gap-2 text-rose-600 dark:text-rose-300">
                          <Heart size={15} className="fill-current" />
                          <span className="inline-block min-w-[1ch] transition-all duration-150">
                            {favoriteProjectIds.length}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                {recentProjects.length > 0 && (
                  <section className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-black uppercase tracking-widest text-black/40 dark:text-zinc-500">Recently Opened</h3>
                      <button
                        onClick={() => setRecentProjectIds([])}
                        className="text-[10px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-400 hover:text-black dark:hover:text-zinc-200 transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {recentProjects.slice(0, 8).map((recentProject) => (
                        <button
                          key={recentProject.id}
                          onClick={() => setSelectedProject(recentProject)}
                          className="px-3 py-2 rounded-xl bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 hover:border-black/15 dark:hover:border-white/25 text-xs font-bold transition-all"
                        >
                          {formatProjectName(recentProject.name)}
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {filteredProjects.length ? (
                  <>
                    <div className="flex flex-wrap items-center gap-3 mb-2">
                      <div className="inline-flex items-center gap-2 px-3 py-2 rounded-2xl bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 text-xs font-bold">
                        <span className="text-black/50 dark:text-zinc-400 uppercase tracking-wider">Sort</span>
                        <select
                          value={sortBy}
                          onChange={(e) => setSortBy(e.target.value as 'stars' | 'updated' | 'name' | 'repo')}
                          className="bg-transparent focus:outline-none"
                        >
                          <option value="stars">Top Stars</option>
                          <option value="updated">Recent Activity</option>
                          <option value="name">Name A-Z</option>
                          <option value="repo">Repository Domain</option>
                        </select>
                      </div>
                      <button
                        onClick={() => setMaintainedOnly((prev) => !prev)}
                        className={cn(
                          "px-3 py-2 rounded-2xl text-xs font-black uppercase tracking-wider transition-all border",
                          maintainedOnly
                            ? "bg-[#9c46fd] text-white border-[#9c46fd]"
                            : "bg-white dark:bg-zinc-900 border-black/5 dark:border-white/10 text-black/50 dark:text-zinc-300"
                          )}
                        >
                          Maintained Only
                        </button>
                      <button
                        onClick={() => setFavoritesOnly((prev) => !prev)}
                        className={cn(
                          "px-3 py-2 rounded-2xl text-xs font-black uppercase tracking-wider transition-all border inline-flex items-center gap-1.5 active:scale-[0.98]",
                          favoritesOnly
                            ? "bg-rose-500 text-white border-rose-500"
                            : "bg-white dark:bg-zinc-900 border-black/5 dark:border-white/10 text-black/50 dark:text-zinc-300"
                        )}
                      >
                        <Heart size={12} className={cn("transition-transform duration-150", favoritesOnly && "fill-current")} />
                        Favorites
                      </button>
                      <button
                        onClick={() => setCardDensity((current) => (current === 'compact' ? 'comfortable' : 'compact'))}
                        className="px-3 py-2 rounded-2xl text-xs font-black uppercase tracking-wider bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/10 transition-all"
                      >
                        Density: {cardDensity === 'compact' ? 'Compact' : 'Comfort'}
                      </button>
                      <button
                        onClick={clearAllFilters}
                        className="px-3 py-2 rounded-2xl text-xs font-black uppercase tracking-wider bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 transition-all"
                      >
                        Reset Filters
                      </button>
                    </div>

                    <div className={cn(
                      "grid gap-5 md:gap-8",
                      cardDensity === 'compact'
                        ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-4"
                        : "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
                    )}>
                      {visibleProjects.map((project) => (
                        <ProjectCard 
                          key={project.id} 
                          project={project} 
                          onClick={() => setSelectedProject(project)}
                          isFavorite={favoriteSet.has(project.id)}
                          onToggleFavorite={() => toggleFavorite(project.id)}
                          density={cardDensity}
                        />
                      ))}
                    </div>
                    {visibleCount < filteredProjects.length && (
                      <div className="flex justify-center mt-8">
                        <button
                          onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
                          className="px-5 py-3 rounded-2xl bg-black text-white dark:bg-zinc-100 dark:text-zinc-950 font-bold text-sm hover:bg-black/90 dark:hover:bg-zinc-200 transition-all"
                        >
                          Load More ({filteredProjects.length - visibleCount} left)
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="p-10 rounded-3xl bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 text-center">
                    <h3 className="text-2xl font-black mb-2">No projects found</h3>
                    <p className="text-black/50 dark:text-zinc-400">
                      {favoritesOnly
                        ? 'No projects in favorites for the current filters. Try turning off Favorites mode.'
                        : 'Try another search query or reset category filters.'}
                    </p>
                  </div>
                )}
              </motion.div>
            )}

            {view === 'graph' && (
              <motion.div 
                key="graph"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-6"
              >
                <Suspense fallback={<TabLoading label="Loading ecosystem graph..." />}>
                  <GraphTab
                    theme={theme}
                    onNodeClick={(node) => setSelectedProject(node as Project)}
                  />
                </Suspense>
              </motion.div>
            )}

            {view === 'stats' && (
              <motion.div 
                key="stats"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-8"
              >
                <Suspense fallback={<TabLoading label="Loading analytics..." />}>
                  <StatsTab
                    projects={projects}
                    statsData={statsData}
                    topStars={topStars}
                    theme={theme}
                    onProjectSelect={setSelectedProject}
                    onDataRefresh={fetchProjects}
                    onToast={pushToast}
                  />
                </Suspense>
              </motion.div>
            )}

            {view === 'researchers' && (
              <motion.div
                key="researchers"
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -18 }}
                className="space-y-8"
              >
                <Suspense fallback={<TabLoading label="Loading researchers..." />}>
                  <ResearchersTab theme={theme} />
                </Suspense>
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </main>

      <div className="fixed md:hidden bottom-4 left-4 right-4 z-40 pointer-events-none">
        <nav className="pointer-events-auto bg-white/90 dark:bg-zinc-950/90 border border-black/5 dark:border-white/10 backdrop-blur-xl rounded-2xl p-2 grid grid-cols-4 gap-2 shadow-2xl shadow-black/10">
          <MobileNavButton active={view === 'list'} onClick={() => setView('list')} icon={<Layers size={16} />} label="Projects" />
          <MobileNavButton active={view === 'graph'} onClick={() => setView('graph')} icon={<Network size={16} />} label="Ecosystem" />
          <MobileNavButton active={view === 'stats'} onClick={() => setView('stats')} icon={<Database size={16} />} label="Insights+" />
          <MobileNavButton active={view === 'researchers'} onClick={() => setView('researchers')} icon={<GraduationCap size={16} />} label="People" />
        </nav>
      </div>

      <footer className="border-t border-black/5 dark:border-white/10 py-12 bg-white dark:bg-zinc-950 mt-20">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <img 
              src="/logo.png" 
              alt="Geo Logo" 
              className="w-6 h-6 rounded-md object-cover border border-black/5 dark:border-white/10" 
              onError={(e) => {
                if (e.currentTarget.src.includes('/logo.png')) {
                  e.currentTarget.src = "/logo.svg";
                  return;
                }
                e.currentTarget.src = "https://api.dicebear.com/7.x/shapes/svg?seed=Geo";
              }}
            />
            <span className="text-sm font-bold tracking-tight">Geo AI Ecosystem</span>
          </div>
          
          <div className="text-sm font-medium text-black/40 dark:text-zinc-400">
            Created by <span className="text-black dark:text-zinc-100 font-bold">arko</span> • Follow me on <a href="https://x.com/edt_arko" target="_blank" rel="noopener noreferrer" className="text-black dark:text-zinc-200 hover:text-[#9c46fd] dark:hover:text-[#dca3ff] transition-colors font-bold underline underline-offset-4">x.com/edt_arko</a>
          </div>

          <div className="flex items-center gap-6 text-[10px] font-bold uppercase tracking-widest text-black/20 dark:text-zinc-500">
            <span>© 2026</span>
            <span>Open Source Intelligence</span>
          </div>
        </div>
      </footer>

      {/* Project Detail Modal */}
      <AnimatePresence>
        {selectedProject && (
          <ProjectDetailModal 
            project={selectedProject} 
            onClose={() => setSelectedProject(null)} 
            onUpdate={fetchProjects}
            isProjectFavorite={(projectId) => favoriteSet.has(projectId)}
            onToggleFavorite={toggleFavorite}
            onToast={pushToast}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showShortcuts && (
          <ShortcutsModal onClose={() => setShowShortcuts(false)} />
        )}
      </AnimatePresence>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function NavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all",
        active
          ? "bg-white dark:bg-zinc-100 text-black dark:text-zinc-950 shadow-sm"
          : "text-black/40 dark:text-zinc-400 hover:text-black/60 dark:hover:text-zinc-200"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function MobileNavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center justify-center gap-1 rounded-xl py-2.5 transition-all",
        active
          ? "bg-black text-white dark:bg-zinc-100 dark:text-zinc-950 shadow-sm"
          : "text-black/50 dark:text-zinc-400 hover:bg-black/5 dark:hover:bg-white/10"
      )}
    >
      {icon}
      <span className="text-[10px] font-black uppercase tracking-widest">{label}</span>
    </button>
  );
}

function TabLoading({ label }: { label: string }) {
  return (
    <div className="h-[60vh] rounded-3xl bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 flex items-center justify-center">
      <div className="flex items-center gap-3 text-black/40 dark:text-zinc-400 font-medium">
        <RefreshCw size={16} className="animate-spin" />
        {label}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  onClick,
  isFavorite,
  onToggleFavorite,
  density,
}: {
  project: Project;
  onClick: () => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  density: CardDensity;
}) {
  const repoUrl = toSafeExternalUrl(project.github_url);
  const activityAge = getRelativeAgeLabel(project.repo_pushed_at);
  const displayName = formatProjectName(project.name);

  return (
    <motion.div 
      layout
      whileHover={{ y: -4 }}
      onClick={onClick}
      className={cn(
        "relative bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 rounded-2xl md:rounded-3xl cursor-pointer hover:shadow-xl hover:border-black/10 dark:hover:border-white/20 transition-all group",
        density === 'compact' ? "p-4 md:p-5" : "p-4 sm:p-5 md:p-6",
      )}
    >
      <div className="flex items-start justify-between mb-3 md:mb-4">
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase tracking-widest text-black/30 dark:text-zinc-500 mb-1">{project.category}</span>
          <h3 className="text-lg md:text-xl font-bold group-hover:text-[#9c46fd] dark:group-hover:text-[#dca3ff] transition-colors">{displayName}</h3>
          <div className="mt-1 flex items-center gap-2">
            <span className={cn(
              "text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full",
              project.is_maintained
                ? "bg-[#cb5ef2]/15 text-[#8f49ee] dark:text-[#dca3ff]"
                : "bg-red-500/15 text-red-700 dark:text-red-300"
            )}>
              {project.is_maintained ? 'Active' : 'Inactive'}
            </span>
            {activityAge !== null && (
              <span className="text-[10px] font-black uppercase tracking-wider text-black/30 dark:text-zinc-500">
                Activity {activityAge} ago
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite();
            }}
            className={cn(
              "w-7 h-7 rounded-full flex items-center justify-center transition-all duration-150 border active:scale-[0.92]",
              isFavorite
                ? "bg-rose-500 text-white border-rose-500"
                : "bg-white/80 dark:bg-zinc-800/90 text-black/35 dark:text-zinc-500 border-black/10 dark:border-white/10 hover:text-rose-500 hover:border-rose-300"
            )}
            title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <Heart size={12} className={cn("transition-transform duration-150", isFavorite && 'fill-current')} />
          </button>
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-black/5 dark:bg-white/10 rounded-full text-xs font-bold">
            <Star size={12} className="text-amber-500 fill-amber-500" />
            {formatStars(project.stars)}
          </div>
        </div>
      </div>
      
      <p className={cn(
        "text-sm text-black/60 dark:text-zinc-300 leading-relaxed",
        density === 'compact' ? "line-clamp-2 mb-4" : "line-clamp-2 mb-5 md:mb-6",
      )}>
        {project.description}
      </p>

      <div className="flex items-center justify-between mb-4">
        <div className="inline-flex items-center gap-1.5 text-[11px] font-bold text-black/40 dark:text-zinc-400">
          <Link2 size={12} />
          {getDomain(project.github_url)}
        </div>
        {project.org_name && (
          <span className="text-[11px] font-bold uppercase tracking-wide text-black/40 dark:text-zinc-400 truncate max-w-[140px]">
            {project.org_name}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-black/5 dark:border-white/10">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-black/5 dark:bg-white/10 rounded-full flex items-center justify-center">
            <Github size={12} className="text-black/40 dark:text-zinc-400" />
          </div>
          <span className="text-xs font-medium text-black/40 dark:text-zinc-400">{project.language}</span>
        </div>
        <div className="flex items-center gap-2">
          {repoUrl && (
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs font-bold text-[#8f49ee] dark:text-[#dca3ff] hover:underline inline-flex items-center gap-1"
            >
              GitHub <ArrowUpRight size={12} />
            </a>
          )}
          <div className="text-xs font-bold text-black/20 dark:text-zinc-500 group-hover:text-black dark:group-hover:text-zinc-100 transition-colors flex items-center gap-1">
            Details <ChevronRight size={14} />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function ProjectDetailModal({
  project: initialProject,
  onClose,
  onUpdate,
  isProjectFavorite,
  onToggleFavorite,
  onToast,
}: {
  project: Project;
  onClose: () => void;
  onUpdate?: () => void;
  isProjectFavorite: (projectId: string) => boolean;
  onToggleFavorite: (projectId: string) => void;
  onToast: (tone: ToastTone, title: string, description?: string) => void;
}) {
  const hostedReadonlyMode = isHostedReadonlyMode();
  const [project, setProject] = useState<Project | null>(null);
  const [activeProjectId, setActiveProjectId] = useState(initialProject.id);
  const [navigationTrail, setNavigationTrail] = useState<string[]>([initialProject.id]);
  const [copiedRepo, setCopiedRepo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isAutoEnriching, setIsAutoEnriching] = useState(false);
  const autoEnrichedIds = useRef<Set<string>>(new Set());
  const isMountedRef = useRef(true);
  const syncControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      syncControllerRef.current?.abort();
    };
  }, []);

  const fetchFullProject = async (projectId: string, signal?: AbortSignal) => {
    setProject(null);
    setLoading(true);
    try {
      const data = await fetchJsonWithFallbackTransform<Project, Project[]>(
        `/api/projects/${projectId}`,
        deployDataPath('projects.json'),
        (projects) => {
          const match = projects.find((entry) => entry.id === projectId);
          if (!match) {
            throw new Error(`Project ${projectId} was not found in deploy snapshot.`);
          }
          return match;
        },
      );
      if (signal?.aborted || !isMountedRef.current) return;
      setProject(data);
    } catch (err) {
      if ((err as any)?.name !== 'AbortError') {
        console.error(err);
      }
    } finally {
      if (!signal?.aborted && isMountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    setActiveProjectId(initialProject.id);
    setNavigationTrail([initialProject.id]);
  }, [initialProject.id]);

  useEffect(() => {
    const controller = new AbortController();
    fetchFullProject(activeProjectId, controller.signal);
    return () => controller.abort();
  }, [activeProjectId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarCompensation = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbarCompensation > 0) {
      document.body.style.paddingRight = `${scrollbarCompensation}px`;
    }
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
    };
  }, []);

  const syncProjectMetadata = async (silent = false) => {
    if (!project) return false;
    if (hostedReadonlyMode) {
      if (!silent && isMountedRef.current) {
        onToast('warning', 'Sync unavailable', 'Hosted site runs in read-only mode. Use the local app to refresh project metadata.');
      }
      return false;
    }
    setIsSyncing(true);
    if (silent && isMountedRef.current) setIsAutoEnriching(true);
    syncControllerRef.current?.abort();
    const controller = new AbortController();
    syncControllerRef.current = controller;
    try {
      const res = await fetch(`/api/projects/${project.id}/sync`, { method: 'POST', signal: controller.signal });
      const data = await res.json();
      if (!isMountedRef.current) return false;
      if (data.success) {
        setProject(data.project);
        if (onUpdate) onUpdate();
        if (!silent) onToast('success', 'Project metadata updated');
        return true;
      } else {
        if (!silent && data.error === 'rate-limit') {
          const resetDate = new Date(data.resetTime);
          onToast('warning', 'GitHub rate limit exceeded', `Resets at ${formatTimeLabel(resetDate)}.`);
        } else if (!silent) {
          onToast('error', 'Sync failed', String(data.message || data.error || 'Unknown error'));
        }
      }
    } catch (err) {
      if ((err as any)?.name !== 'AbortError') {
        console.error(err);
        if (!silent && isMountedRef.current) onToast('error', 'Sync failed', 'Unable to sync with GitHub.');
      }
    } finally {
      if (isMountedRef.current) {
        setIsSyncing(false);
        if (silent) setIsAutoEnriching(false);
      }
      if (syncControllerRef.current === controller) {
        syncControllerRef.current = null;
      }
    }
    return false;
  };

  const handleManualSync = async () => {
    await syncProjectMetadata(false);
  };

  useEffect(() => {
    if (hostedReadonlyMode || !project || loading || isSyncing) return;
    if (!hasIncompleteMeta(project)) return;
    if (autoEnrichedIds.current.has(project.id)) return;
    autoEnrichedIds.current.add(project.id);
    syncProjectMetadata(true);
  }, [hostedReadonlyMode, project, loading, isSyncing]);

  const handleCopyRepo = async () => {
    const repoUrl = toSafeExternalUrl(project?.github_url);
    if (!repoUrl) return;
    try {
      await navigator.clipboard.writeText(repoUrl);
      setCopiedRepo(true);
      window.setTimeout(() => setCopiedRepo(false), 1400);
      onToast('success', 'Repository link copied');
    } catch (err) {
      console.error('Copy failed', err);
      onToast('error', 'Copy failed', 'Unable to copy repository link.');
    }
  };

  const handleCopyShareLink = async () => {
    if (!project) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('project', project.id);
      await navigator.clipboard.writeText(url.toString());
      onToast('success', 'Share link copied');
    } catch (error) {
      console.error(error);
      onToast('error', 'Share link failed', 'Unable to copy share URL.');
    }
  };

  const handleDependencyClick = (depId: string) => {
    if (!depId || depId === activeProjectId) return;
    setNavigationTrail((prev) => [...prev, depId]);
    setActiveProjectId(depId);
  };

  const handleBackDependency = () => {
    setNavigationTrail((prev) => {
      if (prev.length <= 1) return prev;
      const nextTrail = prev.slice(0, -1);
      setActiveProjectId(nextTrail[nextTrail.length - 1]);
      return nextTrail;
    });
  };

  const repoUrl = toSafeExternalUrl(project?.github_url);
  const orgUrl = toSafeExternalUrl(project?.org_website);
  const repoDomain = getDomain(project?.github_url);
  const isActiveFavorite = isProjectFavorite(activeProjectId);
  const inferredOrgName = getRepoOwner(project?.github_url);
  const organizationLabel = project?.org_name || inferredOrgName || 'Community';
  const displayName = formatProjectName(project?.name);
  const firstReleaseLabel = formatDateLabel(project?.first_release);
  const latestVersionLabel = project?.latest_version || 'N/A';
  const activityLabel = formatDateTimeLabel(project?.repo_pushed_at);
  const activityRelativeLabel = getRelativeAgeLabel(project?.repo_pushed_at);
  const activityDisplayLabel =
    activityLabel !== 'N/A' && activityRelativeLabel
      ? `${activityLabel} (${activityRelativeLabel} ago)`
      : activityLabel;
  const daysSinceUpdate = getDaysAgo(project?.repo_pushed_at);
  const popularityLabel =
    (project?.stars || 0) >= 100000 ? 'Elite' :
    (project?.stars || 0) >= 10000 ? 'Very High' :
    (project?.stars || 0) >= 2000 ? 'High' :
    (project?.stars || 0) >= 500 ? 'Growing' : 'Early';
  const freshnessLabel =
    daysSinceUpdate === null ? 'Unknown' :
    daysSinceUpdate <= 30 ? 'Very Fresh' :
    daysSinceUpdate <= 90 ? 'Fresh' :
    daysSinceUpdate <= 180 ? 'Moderate' :
    daysSinceUpdate <= 365 ? 'Aging' : 'Stale';
  const healthScore = Math.min(
    100,
    (project?.is_maintained ? 45 : 18) +
      (daysSinceUpdate === null
        ? 12
        : daysSinceUpdate <= 30
          ? 45
          : daysSinceUpdate <= 90
            ? 35
            : daysSinceUpdate <= 180
              ? 25
              : daysSinceUpdate <= 365
                ? 16
                : 8) +
      ((project?.stars || 0) >= 100000 ? 10 : (project?.stars || 0) >= 10000 ? 8 : (project?.stars || 0) >= 1000 ? 6 : 4)
  );
  const healthLabel = healthScore >= 85 ? 'Excellent' : healthScore >= 70 ? 'Strong' : healthScore >= 50 ? 'Moderate' : 'At Risk';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-6">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/52 backdrop-blur-lg"
      />
      <motion.div 
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${displayName} project details`}
        className="ios-sheet ios-sheet-bg relative w-full max-w-5xl rounded-[28px] sm:rounded-[36px] overflow-hidden max-h-[92vh] flex flex-col border border-white/55 dark:border-white/12"
      >
        <div className="ios-modal-handle absolute left-1/2 -translate-x-1/2 top-2.5 z-30" />
        {loading && (
          <button
            onClick={onClose}
            className="absolute top-3 right-3 z-30 ios-close-ghost w-9 h-9 rounded-full flex items-center justify-center transition-all"
            aria-label="Close project modal"
            title="Close"
          >
            <X size={18} />
          </button>
        )}
        {loading ? (
          <div className="p-16 flex flex-col items-center justify-center gap-4">
            <RefreshCw size={32} className="animate-spin text-black/10 dark:text-zinc-500" />
            <p className="text-sm text-black/40 dark:text-zinc-400 font-bold">Loading project details...</p>
          </div>
        ) : project && (
          <>
            <div className="ios-scroll p-5 sm:p-8 md:p-10 overflow-y-auto overscroll-contain">
              <div className="ios-frost ios-header-rim sticky top-0 z-20 -mx-5 sm:-mx-8 md:-mx-10 px-5 sm:px-8 md:px-10 pb-4 border-b border-black/5 dark:border-white/10 mb-8 pt-4 sm:pt-5">
                <div className="flex items-center justify-between gap-3 pt-3">
                  <button
                    onClick={handleBackDependency}
                    disabled={navigationTrail.length <= 1}
                    className="ios-nav-pill inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-black uppercase tracking-wider text-black/65 dark:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    <ArrowLeft size={14} />
                    Back
                  </button>
                  <span className="text-[10px] font-black uppercase tracking-widest text-black/35 dark:text-zinc-400">
                    {isAutoEnriching
                      ? 'Updating metadata...'
                      : navigationTrail.length > 1
                        ? `${navigationTrail.length - 1} dependency hops`
                        : 'Esc to close'}
                  </span>
                  <button
                    onClick={onClose}
                    className="ios-close-ghost w-9 h-9 rounded-full flex items-center justify-center transition-all"
                    aria-label="Close project modal"
                    title="Close"
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => onToggleFavorite(activeProjectId)}
                    className={cn(
                      "ios-nav-pill inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all duration-150 active:scale-[0.98]",
                      isActiveFavorite ? "text-rose-600 dark:text-rose-300" : "text-black/55 dark:text-zinc-300",
                    )}
                  >
                    <Heart size={13} className={cn("transition-transform duration-150", isActiveFavorite && "fill-current")} />
                    {isActiveFavorite ? 'Favorited' : 'Favorite'}
                  </button>
                  <button
                    onClick={handleCopyShareLink}
                    className="ios-nav-pill inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-black uppercase tracking-wider text-black/55 dark:text-zinc-300 transition-all"
                  >
                    <Link2 size={13} />
                    Copy Share Link
                  </button>
                </div>
              </div>

              <div className="flex flex-col md:flex-row md:items-start justify-between gap-8 mb-12">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-4">
                    <span className="px-3 py-1 bg-[#f8ebff] dark:bg-[#cb5ef2]/20 text-[#8f49ee] dark:text-[#dca3ff] rounded-full text-[10px] font-bold uppercase tracking-wider">
                      {project.category}
                    </span>
                    <span className="px-3 py-1 bg-black/5 dark:bg-white/10 text-black/60 dark:text-zinc-300 rounded-full text-[10px] font-bold uppercase tracking-wider">
                      {project.license}
                    </span>
                  </div>
                  <h2 className="ios-project-title text-3xl md:text-5xl font-bold tracking-tight mb-4">{displayName}</h2>
                  <p className="ios-project-description text-xl leading-relaxed max-w-2xl">
                    {project.description || 'No repository description available.'}
                  </p>
                  <div className="ios-pill ios-repo-pill mt-5 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-wider text-black/60 dark:text-zinc-200">
                    <Link2 size={12} />
                    {repoDomain === 'N/A' ? 'Repository Link' : `Repository · ${repoDomain}`}
                  </div>
                </div>
                
                <div className="ios-action-stack flex flex-col gap-3 min-w-[200px]">
                  <div className="grid grid-cols-1 gap-2">
                    {repoUrl && (
                      <a
                        href={repoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ios-pill ios-action-btn ios-action-btn-primary flex items-center justify-center gap-2 w-full py-3 rounded-2xl font-bold transition-all"
                      >
                        <Github size={16} />
                        View Repository
                        <ArrowUpRight size={14} />
                      </a>
                    )}
                    <button
                      onClick={handleCopyRepo}
                      disabled={!repoUrl}
                      className="ios-pill ios-action-btn ios-action-btn-secondary flex items-center justify-center gap-2 w-full py-3 rounded-2xl font-bold transition-all disabled:opacity-50"
                    >
                      {copiedRepo ? <Check size={16} /> : <Copy size={16} />}
                      {copiedRepo ? 'Copied' : 'Copy Repo Link'}
                    </button>
                    {orgUrl && (
                      <a
                        href={orgUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ios-pill ios-action-btn ios-action-btn-success flex items-center justify-center gap-2 w-full py-3 rounded-2xl font-bold transition-all"
                      >
                        <Globe2 size={16} />
                        Organization Site
                        <ArrowUpRight size={14} />
                      </a>
                    )}
                  </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="ios-soft-card ios-metric-tile p-4 rounded-2xl text-center relative group/stars">
                        <div className="text-[10px] font-bold text-black/30 dark:text-zinc-500 uppercase mb-1">Stars</div>
                      <div className="text-lg font-bold">{formatStars(project.stars)}</div>
                      <button 
                        onClick={handleManualSync}
                        disabled={isSyncing || hostedReadonlyMode}
                        className="absolute -top-2 -right-2 w-6 h-6 bg-[#9c46fd] text-white rounded-full flex items-center justify-center shadow-lg opacity-0 group-hover/stars:opacity-100 disabled:opacity-50 transition-all hover:scale-110"
                        title={hostedReadonlyMode ? 'Refresh is available in the local app.' : 'Refresh from GitHub'}
                      >
                          <RefreshCw size={10} className={cn(isSyncing && "animate-spin")} />
                        </button>
                      </div>
                      <div className="ios-soft-card ios-metric-tile p-4 rounded-2xl text-center">
                        <div className="text-[10px] font-bold text-black/30 dark:text-zinc-500 uppercase mb-1">Language</div>
                      <div className="text-lg font-bold">{project.language}</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
                <div className="md:col-span-2 space-y-12">
                  <section>
                    <div className="flex items-center justify-between mb-6">
                      <h4 className="ios-section-title text-sm font-bold uppercase tracking-widest flex items-center gap-2">
                        <GitBranch size={16} /> Dependencies
                      </h4>
                      <span className="text-[10px] font-black text-black/20 dark:text-zinc-500">{project.dependencies?.length || 0} Total</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {project.dependencies?.length ? project.dependencies.map(dep => (
                        <button
                          key={dep.id}
                          onClick={() => handleDependencyClick(dep.id)}
                          className="ios-soft-card ios-raise text-left flex items-center justify-between px-4 py-3 rounded-2xl text-sm font-bold transition-all group/dep"
                        >
                          <span className="truncate">{formatProjectName(dep.name)}</span>
                          <ChevronRight size={14} className="text-black/0 dark:text-zinc-700/0 group-hover:text-black/20 dark:group-hover:text-zinc-400 transition-all" />
                        </button>
                      )) : (
                        <p className="text-sm text-black/30 dark:text-zinc-500 italic">No major dependencies listed.</p>
                      )}
                    </div>
                  </section>

                  <section>
                    <h4 className="ios-section-title text-sm font-bold uppercase tracking-widest mb-6 flex items-center gap-2">
                      <Users size={16} /> Key Maintainers
                    </h4>
                    {project.maintainers?.length ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                        {project.maintainers.map(person => (
                          <div key={person.id} className="ios-soft-card ios-raise flex items-center gap-4 p-5 rounded-[24px] transition-all group/person">
                            <img src={person.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${person.name}`} alt={person.name} className="w-12 h-12 rounded-full bg-white dark:bg-zinc-800 shadow-sm" />
                            <div>
                              <div className="text-sm font-black">{person.name}</div>
                              <div className="text-xs text-black/40 dark:text-zinc-400 font-bold">@{person.github_handle}</div>
                            </div>
                            <a href={`https://github.com/${person.github_handle}`} target="_blank" rel="noopener noreferrer" className="ml-auto opacity-100 sm:opacity-0 sm:group-hover/person:opacity-100 transition-all">
                              <ExternalLink size={14} className="text-black/40 dark:text-zinc-400 hover:text-black dark:hover:text-zinc-100" />
                            </a>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-black/35 dark:text-zinc-500 italic">No maintainer profile data is available yet.</p>
                    )}
                  </section>
                </div>

                <div className="space-y-10">
                  <section className="ios-soft-card ios-health-card p-6 rounded-[32px]">
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-[#8f49ee]/70 dark:text-[#dca3ff]/80 mb-4">Project Health</h4>
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-black/40 dark:text-zinc-400">Maintenance</span>
                        <span className={cn("text-xs font-black px-2 py-0.5 rounded", project.is_maintained ? "bg-[#9c46fd] text-white" : "bg-red-500 text-white")}>
                          {project.is_maintained ? "Active" : "Inactive"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-black/40 dark:text-zinc-400">Popularity</span>
                        <span className="text-xs font-black text-amber-600">{popularityLabel}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-black/40 dark:text-zinc-400">Freshness</span>
                        <span className="text-xs font-black text-[#8f49ee] dark:text-[#dca3ff]">{freshnessLabel}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-black/40 dark:text-zinc-400">Health Score</span>
                        <span className="text-xs font-black text-black dark:text-zinc-100">{healthLabel} ({healthScore})</span>
                      </div>
                      <div className="ios-health-track w-full h-1.5 rounded-full overflow-hidden mt-2">
                        <div className="ios-health-fill h-full rounded-full transition-all" style={{ width: `${healthScore}%` }} />
                      </div>
                    </div>
                  </section>

                  <section>
                    <h4 className="ios-section-title text-sm font-bold uppercase tracking-widest mb-4">Meta</h4>
                    <div className="space-y-5">
                      <MetaItem icon={<Building2 size={14} />} label="Organization" value={organizationLabel} />
                      <MetaItem icon={<Info size={14} />} label="First Release" value={firstReleaseLabel} />
                      <MetaItem icon={<Layers size={14} />} label="Latest Version" value={latestVersionLabel} />
                      <MetaItem icon={<Activity size={14} />} label="Repository Activity" value={activityDisplayLabel} />
                    </div>
                  </section>

                  <section>
                    <h4 className="ios-section-title text-sm font-bold uppercase tracking-widest mb-4">Topics</h4>
                    {project.topics?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {project.topics.map(topic => (
                          <span key={topic} className="ios-pill px-3 py-1.5 rounded-xl text-[10px] font-black text-black/55 dark:text-zinc-300 transition-all cursor-default">
                            #{topic}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-black/35 dark:text-zinc-500 italic">No topics were mapped for this repository.</p>
                    )}
                  </section>
                </div>
              </div>
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}

function MetaItem({ icon, label, value }: { icon: React.ReactNode, label: string, value: string }) {
  return (
    <div className="ios-soft-card ios-meta-item flex items-center justify-between rounded-2xl px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs text-black/40 dark:text-zinc-400">
        {icon}
        {label}
      </div>
      <div className="text-xs font-bold">{value}</div>
    </div>
  );
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (toastId: number) => void;
}) {
  return (
    <div className="fixed bottom-24 md:bottom-4 right-4 z-[140] flex flex-col gap-2 w-[min(92vw,360px)] pointer-events-none">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97 }}
            className={cn(
              "pointer-events-auto rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-xl",
              toast.tone === 'success' && "border-emerald-500/35 bg-emerald-500/10",
              toast.tone === 'error' && "border-red-500/35 bg-red-500/10",
              toast.tone === 'warning' && "border-amber-500/35 bg-amber-500/10",
              toast.tone === 'info' && "border-blue-500/35 bg-blue-500/10",
            )}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0">
                <div className="text-sm font-black">{toast.title}</div>
                {toast.description && (
                  <div className="text-xs font-medium text-black/65 dark:text-zinc-300 mt-0.5">{toast.description}</div>
                )}
              </div>
              <button
                onClick={() => onDismiss(toast.id)}
                className="ml-auto w-6 h-6 rounded-full bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20 inline-flex items-center justify-center"
                aria-label="Dismiss notification"
              >
                <X size={12} />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const shortcuts = [
    { key: '/', action: 'Focus search' },
    { key: 'T', action: 'Toggle theme' },
    { key: 'R', action: 'Refresh ecosystem' },
    { key: 'F', action: 'Toggle favorites-only (Projects tab)' },
    { key: '1 / 2 / 3 / 4', action: 'Switch tabs' },
    { key: '?', action: 'Open / close this help' },
    { key: 'Esc', action: 'Close project modal or help' },
  ];

  return (
    <div className="fixed inset-0 z-[135] p-4 sm:p-8 flex items-center justify-center">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/45 backdrop-blur-sm"
      />
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.97 }}
        onClick={(event) => event.stopPropagation()}
        className="relative w-full max-w-xl rounded-3xl border border-black/10 dark:border-white/10 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl p-6 sm:p-8 shadow-2xl"
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-xl font-black tracking-tight">Keyboard Shortcuts</h3>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 inline-flex items-center justify-center"
            aria-label="Close shortcuts"
          >
            <X size={16} />
          </button>
        </div>
        <div className="space-y-2.5">
          {shortcuts.map((shortcut) => (
            <div key={shortcut.key} className="flex items-center justify-between rounded-2xl bg-black/5 dark:bg-white/10 px-3 py-2.5">
              <span className="text-sm font-medium text-black/70 dark:text-zinc-300">{shortcut.action}</span>
              <kbd className="px-2.5 py-1 rounded-lg border border-black/10 dark:border-white/15 bg-white dark:bg-zinc-950 text-xs font-black">
                {shortcut.key}
              </kbd>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
