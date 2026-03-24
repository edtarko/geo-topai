import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import * as d3 from 'd3';
import {
  Activity,
  CalendarClock,
  Gauge,
  Filter,
  Link2,
  Network,
  PackageOpen,
  Search,
  Sparkles,
  Star,
} from 'lucide-react';
import { GraphData, Project } from '../types';
import { formatProjectName } from '../utils/projectDisplay';

type GraphNode = GraphData['nodes'][number];
type NormalizedLink = { source: string; target: string };
type ReleaseFilter = 'all' | 'with-release' | 'missing-release';
type SortMode = 'stars' | 'updated' | 'name' | 'release';

interface GraphTabProps {
  theme: 'light' | 'dark';
  onNodeClick: (node: GraphNode) => void;
}

const UI_LOCALE = 'en-US';

function formatStars(stars: number) {
  if (stars >= 1000000) return `${(stars / 1000000).toFixed(1)}M`;
  if (stars >= 1000) return `${(stars / 1000).toFixed(1)}k`;
  return stars.toLocaleString(UI_LOCALE);
}

function formatDateLabel(value?: string | null) {
  if (!value) return 'N/A';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return 'N/A';
  return new Date(timestamp).toLocaleDateString(UI_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function getDaysAgo(value?: string | null) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24)));
}

function getReleaseFreshnessLabel(value?: string | null) {
  const days = getDaysAgo(value);
  if (days === null) return { label: 'Unknown', tone: 'text-zinc-400' };
  if (days <= 30) return { label: 'Very Fresh', tone: 'text-emerald-500' };
  if (days <= 90) return { label: 'Fresh', tone: 'text-blue-500' };
  if (days <= 180) return { label: 'Moderate', tone: 'text-amber-500' };
  if (days <= 365) return { label: 'Aging', tone: 'text-orange-500' };
  return { label: 'Stale', tone: 'text-red-500' };
}

function extractGithubOwner(githubUrl?: string | null) {
  if (!githubUrl) return null;
  const value = githubUrl.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!url.hostname.toLowerCase().includes('github.com')) return null;
    const [owner] = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    return owner || null;
  } catch {
    const cleaned = value.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    if (!cleaned.toLowerCase().startsWith('github.com/')) return null;
    const [owner] = cleaned.replace(/^github\.com\//i, '').replace(/^\/+|\/+$/g, '').split('/');
    return owner || null;
  }
}

function fallbackLogoFromName(name?: string | null) {
  const seed = encodeURIComponent(formatProjectName(name || 'Project'));
  return `https://api.dicebear.com/9.x/initials/svg?seed=${seed}&fontWeight=700&radius=20`;
}

function getProjectLogoUrl(project?: Partial<Project> | null) {
  if (project?.project_logo_url) return project.project_logo_url;
  const owner = extractGithubOwner(project?.github_url);
  if (owner) return `https://github.com/${owner}.png?size=160`;
  return fallbackLogoFromName(project?.name);
}

function normalizeLinks(data: GraphData): NormalizedLink[] {
  const validNodeIds = new Set(data.nodes.map((node) => node.id));
  return data.links
    .map((link: any) => {
      const source = typeof link.source === 'string' ? link.source : link.source?.id;
      const target = typeof link.target === 'string' ? link.target : link.target?.id;
      if (!source || !target) return null;
      if (!validNodeIds.has(source) || !validNodeIds.has(target)) return null;
      return { source, target };
    })
    .filter((link): link is NormalizedLink => Boolean(link));
}

function categoryColor(category: string) {
  if (category === 'framework') return '#10b981';
  if (category === 'library') return '#3b82f6';
  if (category === 'model') return '#8b5cf6';
  if (category === 'dataset') return '#06b6d4';
  if (category === 'tool') return '#f97316';
  return '#f59e0b';
}

export default function GraphTab({ theme, onNodeClick }: GraphTabProps) {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [releaseFilter, setReleaseFilter] = useState<ReleaseFilter>('all');
  const [sortBy, setSortBy] = useState<SortMode>('stars');
  const [showLabels, setShowLabels] = useState(false);
  const [maintainedOnly, setMaintainedOnly] = useState(false);
  const [performanceMode, setPerformanceMode] = useState(true);
  const [maxGraphNodes, setMaxGraphNodes] = useState(180);
  const [visibleListCount, setVisibleListCount] = useState(120);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    let cancelled = false;
    const loadData = async () => {
      setLoading(true);
      try {
        const [graphRes, projectsRes] = await Promise.all([fetch('/api/graph'), fetch('/api/projects')]);
        if (!graphRes.ok) throw new Error(`Graph API error (${graphRes.status})`);
        if (!projectsRes.ok) throw new Error(`Projects API error (${projectsRes.status})`);

        const [graphPayload, projectsPayload] = await Promise.all([graphRes.json(), projectsRes.json()]);
        if (cancelled) return;
        setGraphData(graphPayload);
        setProjects(projectsPayload);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadData();
    return () => {
      cancelled = true;
    };
  }, []);

  const uniqueProjects = useMemo(() => {
    const seen = new Set<string>();
    return projects.filter((project) => {
      const key = (project.github_url || '').toLowerCase().trim().replace(/\/$/, '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [projects]);

  const projectLookup = useMemo(() => {
    const lookup: Record<string, Project> = {};
    for (const project of uniqueProjects) lookup[project.id] = project;
    return lookup;
  }, [uniqueProjects]);

  const categories = useMemo(() => {
    const counts = uniqueProjects.reduce((acc: Record<string, number>, project) => {
      acc[project.category] = (acc[project.category] || 0) + 1;
      return acc;
    }, {});
    return ['All', ...Object.keys(counts).sort((a, b) => counts[b] - counts[a])];
  }, [uniqueProjects]);

  useEffect(() => {
    if (category !== 'All' && !categories.includes(category)) {
      setCategory('All');
    }
  }, [categories, category]);

  const filteredProjects = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    const filtered = uniqueProjects.filter((project) => {
      const displayName = formatProjectName(project.name).toLowerCase();
      const hasRelease = Boolean(project.latest_version && project.latest_version !== 'N/A');
      const textMatch =
        !normalizedQuery ||
        displayName.includes(normalizedQuery) ||
        project.description?.toLowerCase().includes(normalizedQuery) ||
        project.category.toLowerCase().includes(normalizedQuery) ||
        project.language?.toLowerCase().includes(normalizedQuery);
      const categoryMatch = category === 'All' || project.category === category;
      const maintainedMatch = !maintainedOnly || project.is_maintained;
      const releaseMatch =
        releaseFilter === 'all' ||
        (releaseFilter === 'with-release' && hasRelease) ||
        (releaseFilter === 'missing-release' && !hasRelease);
      return textMatch && categoryMatch && maintainedMatch && releaseMatch;
    });

    const sorted = [...filtered];
    if (sortBy === 'name') {
      sorted.sort((a, b) => formatProjectName(a.name).localeCompare(formatProjectName(b.name)));
    } else if (sortBy === 'updated') {
      sorted.sort((a, b) => {
        const aTs = Date.parse(a.repo_pushed_at || '') || 0;
        const bTs = Date.parse(b.repo_pushed_at || '') || 0;
        return bTs - aTs;
      });
    } else if (sortBy === 'release') {
      sorted.sort((a, b) => {
        const aHas = a.latest_version && a.latest_version !== 'N/A' ? 1 : 0;
        const bHas = b.latest_version && b.latest_version !== 'N/A' ? 1 : 0;
        return bHas - aHas;
      });
    } else {
      sorted.sort((a, b) => b.stars - a.stars);
    }
    return sorted;
  }, [uniqueProjects, deferredQuery, category, maintainedOnly, releaseFilter, sortBy]);

  const baseLinks = useMemo(() => (graphData ? normalizeLinks(graphData) : []), [graphData]);

  const graphProjects = useMemo(() => {
    const softLimit = performanceMode ? Math.min(maxGraphNodes, 180) : maxGraphNodes;
    return filteredProjects.slice(0, Math.max(20, softLimit));
  }, [filteredProjects, performanceMode, maxGraphNodes]);

  const filteredGraph = useMemo(() => {
    if (!graphData) return { nodes: [] as GraphNode[], links: [] as NormalizedLink[] };
    const allowed = new Set(graphProjects.map((project) => project.id));
    const nodes = graphData.nodes.filter((node) => allowed.has(node.id));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const links = baseLinks.filter((link) => nodeIds.has(link.source) && nodeIds.has(link.target));
    return { nodes, links };
  }, [graphData, baseLinks, graphProjects]);

  const degreeMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const node of filteredGraph.nodes) map[node.id] = 0;
    for (const link of filteredGraph.links) {
      map[link.source] = (map[link.source] || 0) + 1;
      map[link.target] = (map[link.target] || 0) + 1;
    }
    return map;
  }, [filteredGraph]);

  const insights = useMemo(() => {
    const nodeCount = filteredGraph.nodes.length;
    const edgeCount = filteredGraph.links.length;
    const density = nodeCount > 1 ? (2 * edgeCount) / (nodeCount * (nodeCount - 1)) : 0;
    const avgDegree = nodeCount ? (2 * edgeCount) / nodeCount : 0;
    const withRelease = filteredProjects.filter((project) => project.latest_version && project.latest_version !== 'N/A').length;
    const recentRelease90 = filteredProjects.filter((project) => {
      const days = getDaysAgo(project.repo_pushed_at);
      return days !== null && days <= 90;
    }).length;

    return { nodeCount, edgeCount, density, avgDegree, withRelease, recentRelease90, totalFiltered: filteredProjects.length };
  }, [filteredGraph, filteredProjects]);

  const topConnected = useMemo(() => {
    return filteredGraph.nodes
      .map((node) => ({ ...node, degree: degreeMap[node.id] || 0 }))
      .sort((a, b) => {
        if (b.degree === a.degree) return b.stars - a.stars;
        return b.degree - a.degree;
      })
      .slice(0, 6);
  }, [filteredGraph, degreeMap]);

  useEffect(() => {
    setVisibleListCount(120);
  }, [deferredQuery, category, maintainedOnly, releaseFilter, sortBy]);

  const visibleProjects = useMemo(
    () => filteredProjects.slice(0, visibleListCount),
    [filteredProjects, visibleListCount],
  );

  const applyPreset = useCallback((preset: 'trending' | 'stable' | 'release-ready') => {
    if (preset === 'trending') {
      setReleaseFilter('all');
      setSortBy('updated');
      setMaintainedOnly(true);
      setPerformanceMode(true);
      setShowLabels(false);
      setMaxGraphNodes(160);
      return;
    }
    if (preset === 'stable') {
      setReleaseFilter('with-release');
      setSortBy('stars');
      setMaintainedOnly(true);
      setPerformanceMode(true);
      setShowLabels(false);
      setMaxGraphNodes(180);
      return;
    }
    setReleaseFilter('with-release');
    setSortBy('release');
    setMaintainedOnly(false);
    setPerformanceMode(false);
    setShowLabels(true);
    setMaxGraphNodes(260);
  }, []);

  if (loading) {
    return (
      <div className="h-[78vh] rounded-3xl bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 flex items-center justify-center">
        <div className="flex items-center gap-3 text-black/40 dark:text-zinc-400 font-medium">
          <Activity size={16} className="animate-pulse" />
          Loading ecosystem workspace...
        </div>
      </div>
    );
  }

  if (!graphData || error) {
    return (
      <div className="h-[78vh] rounded-3xl bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 flex flex-col items-center justify-center text-center p-8">
        <h3 className="text-2xl font-black mb-2">Ecosystem unavailable</h3>
        <p className="text-black/50 dark:text-zinc-400 max-w-md">
          {error || 'Unable to load ecosystem data right now. Please refresh and retry.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 rounded-3xl p-4 sm:p-6">
        <div className="grid grid-cols-2 xl:grid-cols-7 gap-3">
          <MetricBox label="Shown Nodes" value={insights.nodeCount.toString()} icon={<Network size={14} />} />
          <MetricBox label="Connections" value={insights.edgeCount.toString()} icon={<Link2 size={14} />} />
          <MetricBox label="Filtered" value={insights.totalFiltered.toString()} icon={<Filter size={14} />} />
          <MetricBox label="Avg Degree" value={insights.avgDegree.toFixed(1)} icon={<Activity size={14} />} />
          <MetricBox label="Density" value={`${(insights.density * 100).toFixed(1)}%`} icon={<Sparkles size={14} />} />
          <MetricBox label="With Release" value={insights.withRelease.toString()} icon={<PackageOpen size={14} />} />
          <MetricBox label="Active 90d" value={insights.recentRelease90.toString()} icon={<CalendarClock size={14} />} />
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-6 h-auto xl:h-[78vh]">
        <div className="bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 rounded-3xl overflow-hidden flex flex-col">
          <div className="p-4 sm:p-5 border-b border-black/5 dark:border-white/10 space-y-3">
            <div className="flex flex-col lg:flex-row lg:items-center gap-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-black/30 dark:text-zinc-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search projects, language, description..."
                  className="w-full h-11 rounded-2xl pl-10 pr-3 bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:outline-none focus:ring-4 focus:ring-black/5 dark:focus:ring-white/10"
                />
              </div>
              <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-black/40 dark:text-zinc-500">
                <Filter size={12} />
                {filteredGraph.nodes.length} shown · {filteredProjects.length} filtered
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => applyPreset('trending')}
                className="h-9 px-3 rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 text-[10px] font-black uppercase tracking-wider hover:bg-black/10 dark:hover:bg-white/15 transition-all"
              >
                Trending
              </button>
              <button
                onClick={() => applyPreset('stable')}
                className="h-9 px-3 rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 text-[10px] font-black uppercase tracking-wider hover:bg-black/10 dark:hover:bg-white/15 transition-all"
              >
                Stable
              </button>
              <button
                onClick={() => applyPreset('release-ready')}
                className="h-9 px-3 rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 text-[10px] font-black uppercase tracking-wider hover:bg-black/10 dark:hover:bg-white/15 transition-all"
              >
                Release Ready
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="h-10 rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 px-3 text-xs font-black uppercase tracking-wider"
              >
                {categories.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>

              <select
                value={releaseFilter}
                onChange={(event) => setReleaseFilter(event.target.value as ReleaseFilter)}
                className="h-10 rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 px-3 text-xs font-black uppercase tracking-wider"
              >
                <option value="all">All Release States</option>
                <option value="with-release">With Release</option>
                <option value="missing-release">Missing Release</option>
              </select>

              <select
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value as SortMode)}
                className="h-10 rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 px-3 text-xs font-black uppercase tracking-wider"
              >
                <option value="stars">Sort: Stars</option>
                <option value="updated">Sort: Activity</option>
                <option value="name">Sort: Name</option>
                <option value="release">Sort: Release</option>
              </select>

              <button
                onClick={() => setShowLabels((value) => !value)}
                className="h-10 rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 px-3 text-xs font-black uppercase tracking-wider hover:bg-black/10 dark:hover:bg-white/15 transition-all"
                disabled={performanceMode}
              >
                Labels: {performanceMode ? 'Auto Off' : showLabels ? 'On' : 'Off'}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <button
                onClick={() => setMaintainedOnly((value) => !value)}
                className={`h-10 rounded-xl border px-3 text-xs font-black uppercase tracking-wider transition-all ${
                  maintainedOnly
                    ? 'bg-emerald-500 text-white border-emerald-500'
                    : 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/10 hover:bg-black/10 dark:hover:bg-white/15'
                }`}
              >
                Maintained: {maintainedOnly ? 'On' : 'Off'}
              </button>
              <button
                onClick={() => setPerformanceMode((value) => !value)}
                className={`h-10 rounded-xl border px-3 text-xs font-black uppercase tracking-wider transition-all inline-flex items-center justify-center gap-2 ${
                  performanceMode
                    ? 'bg-[#9c46fd] text-white border-[#9c46fd]'
                    : 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/10 hover:bg-black/10 dark:hover:bg-white/15'
                }`}
              >
                <Gauge size={13} />
                Performance: {performanceMode ? 'On' : 'Off'}
              </button>
              <div className="h-10 rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 px-3 flex items-center gap-3">
                <span className="text-[10px] font-black uppercase tracking-wider text-black/45 dark:text-zinc-400">Nodes</span>
                <input
                  type="range"
                  min={60}
                  max={300}
                  step={10}
                  value={maxGraphNodes}
                  onChange={(event) => setMaxGraphNodes(Number(event.target.value))}
                  className="flex-1 accent-[#9c46fd]"
                />
                <span className="text-[10px] font-black text-black/55 dark:text-zinc-300 w-8 text-right">
                  {performanceMode ? Math.min(maxGraphNodes, 180) : maxGraphNodes}
                </span>
              </div>
            </div>
          </div>

          <div className="h-[56vh] sm:h-[64vh] xl:h-full relative">
            {filteredGraph.nodes.length > 0 ? (
              <>
                <GraphCanvas
                  data={{ nodes: filteredGraph.nodes, links: filteredGraph.links }}
                  links={filteredGraph.links}
                  theme={theme}
                  showLabels={showLabels}
                  performanceMode={performanceMode}
                  projectLookup={projectLookup}
                  onNodeClick={(node) => onNodeClick((projectLookup[node.id] || node) as GraphNode)}
                />
                <div className="absolute top-3 left-3 z-20 px-3 py-1.5 rounded-full bg-white/85 dark:bg-zinc-950/80 border border-black/10 dark:border-white/10 text-[10px] font-black uppercase tracking-widest">
                  Scroll to zoom · Drag to navigate
                </div>
              </>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center px-6">
                  <h4 className="text-xl font-black mb-2">No graph nodes for this filter</h4>
                  <p className="text-black/50 dark:text-zinc-400">Try changing category, release filter, or search query.</p>
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 rounded-3xl p-4 sm:p-5 overflow-hidden flex flex-col">
          <div className="mb-4">
            <h3 className="text-lg font-black">All Projects & Releases</h3>
            <p className="text-xs text-black/45 dark:text-zinc-400 mt-1">
              Every filtered project with version, last release date, and freshness status.
            </p>
          </div>

          <div className="space-y-2 overflow-y-auto pr-1">
            {visibleProjects.map((project) => {
              const releaseDate = project.latest_release_date;
              const activityDate = project.repo_pushed_at;
              const freshness = getReleaseFreshnessLabel(releaseDate);
              const activity = getReleaseFreshnessLabel(activityDate);
              const version = project.latest_version || 'N/A';
              const degree = degreeMap[project.id] || 0;

              return (
                <button
                  key={project.id}
                  onClick={() => onNodeClick(project as unknown as GraphNode)}
                  className="group w-full text-left p-3 rounded-2xl bg-gradient-to-br from-black/[0.045] to-black/[0.02] dark:from-white/[0.10] dark:to-white/[0.04] border border-black/5 dark:border-white/10 hover:from-black/[0.09] hover:to-black/[0.04] dark:hover:from-white/[0.16] dark:hover:to-white/[0.06] transition-all"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex items-start gap-3">
                      <ProjectLogo project={project} size={38} />
                      <div className="min-w-0">
                        <div className="font-bold text-sm truncate">{formatProjectName(project.name)}</div>
                        <div className="text-[10px] font-black uppercase tracking-wider text-black/35 dark:text-zinc-500 mt-0.5">
                          {project.category} · {project.language || 'Unknown'}
                        </div>
                      </div>
                    </div>
                    <div className="text-[10px] font-black text-amber-500 inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 bg-amber-500/10 dark:bg-amber-400/10">
                      <Star size={10} fill="currentColor" />
                      {formatStars(project.stars)}
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-black uppercase tracking-wider">
                    <div className="px-2 py-1 rounded-lg bg-black/5 dark:bg-white/10 truncate">Version: {version}</div>
                    <div className="px-2 py-1 rounded-lg bg-black/5 dark:bg-white/10 truncate">Release: {formatDateLabel(releaseDate)}</div>
                  </div>

                  <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] font-black uppercase tracking-wider">
                    <span className={`truncate ${freshness.tone}`}>Release {freshness.label}</span>
                    <span className={`truncate text-center ${activity.tone}`}>Activity {activity.label}</span>
                    <span className="text-black/40 dark:text-zinc-500 text-right truncate">{degree} links</span>
                  </div>
                </button>
              );
            })}
          </div>

          {visibleListCount < filteredProjects.length && (
            <button
              onClick={() => setVisibleListCount((count) => Math.min(count + 120, filteredProjects.length))}
              className="mt-3 h-9 rounded-xl bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 text-[11px] font-black uppercase tracking-wider hover:bg-black/10 dark:hover:bg-white/15 transition-all"
            >
              Load More ({filteredProjects.length - visibleListCount})
            </button>
          )}

          {!filteredProjects.length && (
            <div className="mt-10 text-center text-sm text-black/50 dark:text-zinc-400">
              No projects match current filters.
            </div>
          )}
        </aside>
      </section>

      {topConnected.length > 0 && (
        <section className="bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/10 rounded-3xl p-4 sm:p-6">
          <h3 className="text-lg font-black mb-3">Most Connected Nodes</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {topConnected.map((node) => {
              const project = projectLookup[node.id] || ({ id: node.id, name: node.name } as Partial<Project>);
              return (
                <button
                  key={node.id}
                  onClick={() => onNodeClick((projectLookup[node.id] || node) as GraphNode)}
                  className="text-left p-3 rounded-2xl bg-gradient-to-br from-black/[0.045] to-black/[0.02] dark:from-white/[0.10] dark:to-white/[0.04] hover:from-black/[0.09] hover:to-black/[0.04] dark:hover:from-white/[0.16] dark:hover:to-white/[0.06] transition-all"
                >
                  <div className="flex items-center gap-3">
                    <ProjectLogo project={project} size={34} />
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-sm truncate">{formatProjectName(node.name)}</div>
                      <div className="mt-1 text-[10px] font-black uppercase tracking-wider text-black/40 dark:text-zinc-500">
                        {node.category} · {node.degree} links
                      </div>
                    </div>
                    <span className="text-[10px] font-black text-amber-500 inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 bg-amber-500/10 dark:bg-amber-400/10">
                      <Star size={10} fill="currentColor" />
                      {formatStars(node.stars)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function MetricBox({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="p-3 rounded-2xl bg-black/5 dark:bg-white/10 border border-black/5 dark:border-white/10">
      <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wide text-black/40 dark:text-zinc-400 mb-1">
        {icon}
        {label}
      </div>
      <div className="text-lg font-black">{value}</div>
    </div>
  );
}

function ProjectLogo({
  project,
  size = 40,
}: {
  project?: Partial<Project> | null;
  size?: number;
}) {
  const logoSource = getProjectLogoUrl(project);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [logoSource]);

  const imageSource = hasError ? fallbackLogoFromName(project?.name) : logoSource;

  return (
    <div
      className="shrink-0 rounded-xl overflow-hidden border border-black/10 dark:border-white/15 bg-white/90 dark:bg-zinc-800/80 shadow-[0_8px_22px_-18px_rgba(0,0,0,0.75)]"
      style={{ width: size, height: size }}
    >
      <img
        src={imageSource}
        alt={`${formatProjectName(project?.name)} logo`}
        loading="lazy"
        width={size}
        height={size}
        className="w-full h-full object-cover"
        referrerPolicy="no-referrer"
        onError={() => setHasError(true)}
      />
    </div>
  );
}

function GraphCanvas({
  data,
  links,
  theme,
  showLabels,
  performanceMode,
  projectLookup,
  onNodeClick,
}: {
  data: GraphData;
  links: NormalizedLink[];
  theme: 'light' | 'dark';
  showLabels: boolean;
  performanceMode: boolean;
  projectLookup: Record<string, Project>;
  onNodeClick: (node: GraphNode) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const rootRef = useRef<d3.Selection<SVGSVGElement, unknown, null, undefined> | null>(null);
  const containerRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);

  const fitToContent = () => {
    const svg = rootRef.current;
    const container = containerRef.current;
    const zoom = zoomRef.current;
    if (!svg || !container || !zoom || !svgRef.current) return;

    const bounds = (container.node() as SVGGElement).getBBox();
    if (!bounds.width || !bounds.height) return;
    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;
    const scale = Math.max(0.18, Math.min(1.4, 0.85 / Math.max(bounds.width / width, bounds.height / height)));
    const translateX = width / 2 - scale * (bounds.x + bounds.width / 2);
    const translateY = height / 2 - scale * (bounds.y + bounds.height / 2);
    svg
      .transition()
      .duration(450)
      .call(zoom.transform as any, d3.zoomIdentity.translate(translateX, translateY).scale(scale));
  };

  const labelsEnabled = showLabels && !performanceMode && data.nodes.length <= 180;

  useEffect(() => {
    if (!svgRef.current) return;
    const isDark = theme === 'dark';

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    rootRef.current = svg;

    const container = svg.append('g');
    containerRef.current = container;

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.12, 4.2])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
      });
    zoomRef.current = zoom;
    svg.call(zoom as any);

    const simulation = d3
      .forceSimulation(data.nodes as any)
      .force('link', d3.forceLink(links).id((d: any) => d.id).distance(performanceMode ? 82 : data.nodes.length > 120 ? 95 : 130))
      .force('charge', d3.forceManyBody().strength(performanceMode ? -180 : data.nodes.length > 120 ? -220 : -380))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius((d: any) => Math.sqrt(d.stars / 1000) * 2 + (labelsEnabled ? 26 : 13)));

    if (performanceMode) {
      simulation.alphaDecay(0.08);
      simulation.velocityDecay(0.35);
    }

    const markerId = `arrowhead-graph-${Math.random().toString(36).slice(2)}`;
    container
      .append('defs')
      .append('marker')
      .attr('id', markerId)
      .attr('viewBox', '-0 -5 10 10')
      .attr('refX', 24)
      .attr('refY', 0)
      .attr('orient', 'auto')
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .append('path')
      .attr('d', 'M 0,-5 L 10,0 L 0,5')
      .attr('fill', isDark ? '#ffffff40' : '#00000020');

    const link = container
      .append('g')
      .attr('stroke', isDark ? '#ffffff2b' : '#00000012')
      .attr('stroke-width', 1.35)
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('marker-end', `url(#${markerId})`);

    const node = container
      .append('g')
      .selectAll('g')
      .data(data.nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .on('click', (_event, datum) => onNodeClick(datum))
      .on('mouseenter', (_event, datum) => setHoveredNode(datum))
      .on('mouseleave', () => setHoveredNode(null))
      .call(
        d3
          .drag<any, any>()
          .on('start', (event) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            event.subject.fx = event.subject.x;
            event.subject.fy = event.subject.y;
          })
          .on('drag', (event) => {
            event.subject.fx = event.x;
            event.subject.fy = event.y;
          })
          .on('end', (event) => {
            if (!event.active) simulation.alphaTarget(0);
            event.subject.fx = null;
            event.subject.fy = null;
          }),
      );

    const nodeRadius = (datum: any) => Math.sqrt(datum.stars / 1000) * 2 + 5;

    node
      .append('circle')
      .attr('r', (datum: any) => Math.sqrt(datum.stars / 1000) * 2 + 8)
      .attr('fill', isDark ? '#ffffff10' : '#00000005');

    node
      .append('circle')
      .attr('r', nodeRadius)
      .attr('fill', (datum: any) => categoryColor(datum.category))
      .attr('opacity', 0.28);

    node
      .append('image')
      .attr('href', (datum: any) =>
        getProjectLogoUrl(projectLookup[datum.id] || ({ id: datum.id, name: datum.name } as Partial<Project>)),
      )
      .attr('xlink:href', (datum: any) =>
        getProjectLogoUrl(projectLookup[datum.id] || ({ id: datum.id, name: datum.name } as Partial<Project>)),
      )
      .attr('x', (datum: any) => -nodeRadius(datum))
      .attr('y', (datum: any) => -nodeRadius(datum))
      .attr('width', (datum: any) => nodeRadius(datum) * 2)
      .attr('height', (datum: any) => nodeRadius(datum) * 2)
      .attr('preserveAspectRatio', 'xMidYMid slice')
      .style('clip-path', 'circle(50%)')
      .style('opacity', 0.96);

    node
      .append('circle')
      .attr('r', nodeRadius)
      .attr('fill', 'none')
      .attr('stroke', isDark ? '#0f172a' : '#ffffff')
      .attr('stroke-width', 3);

    if (labelsEnabled) {
      node
        .append('text')
        .text((datum: any) => formatProjectName(datum.name))
        .attr('x', 0)
        .attr('y', (datum: any) => Math.sqrt(datum.stars / 1000) * 2 + 18)
        .attr('text-anchor', 'middle')
        .attr('font-size', '10.5px')
        .attr('font-weight', '800')
        .attr('fill', isDark ? '#e4e4e7' : '#1f2937');
    }

    simulation.on('tick', () => {
      link
        .attr('x1', (datum: any) => datum.source.x)
        .attr('y1', (datum: any) => datum.source.y)
        .attr('x2', (datum: any) => datum.target.x)
        .attr('y2', (datum: any) => datum.target.y);
      node.attr('transform', (datum: any) => `translate(${datum.x},${datum.y})`);
    });

    const fitTimer = window.setTimeout(() => {
      fitToContent();
    }, 420);

    return () => {
      window.clearTimeout(fitTimer);
      simulation.stop();
    };
  }, [data, labelsEnabled, links, onNodeClick, performanceMode, projectLookup, theme]);

  const hoveredProject = hoveredNode ? projectLookup[hoveredNode.id] : null;
  const hoveredRelease = hoveredProject?.latest_release_date;
  const hoveredActivity = hoveredProject?.repo_pushed_at;
  const releaseFreshness = getReleaseFreshnessLabel(hoveredRelease);
  const activityFreshness = getReleaseFreshnessLabel(hoveredActivity);

  return (
    <div className="w-full h-full relative">
      <svg ref={svgRef} className="w-full h-full" />

      <button
        onClick={fitToContent}
        className="absolute top-3 right-3 z-20 h-8 px-3 rounded-full bg-white/90 dark:bg-zinc-950/90 border border-black/10 dark:border-white/10 text-[10px] font-black uppercase tracking-widest hover:bg-white dark:hover:bg-zinc-900 transition-all"
      >
        Reset View
      </button>

      <AnimatePresence>
        {hoveredNode && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            className="absolute top-14 sm:top-4 right-3 sm:right-4 p-4 bg-black text-white dark:bg-zinc-100 dark:text-zinc-950 rounded-2xl shadow-2xl pointer-events-none z-10 border border-white/10 dark:border-zinc-300 max-w-[290px]"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-0.5 bg-white/10 dark:bg-zinc-200 rounded-full text-[9px] font-black uppercase tracking-widest text-white/65 dark:text-zinc-600">
                {hoveredNode.category}
              </span>
              <span className="ml-auto text-[10px] font-black text-amber-400 inline-flex items-center gap-1">
                <Star size={10} fill="currentColor" />
                {formatStars(hoveredNode.stars)}
              </span>
            </div>
            <div className="flex items-center gap-2 mb-2">
              <ProjectLogo
                project={hoveredProject || ({ id: hoveredNode.id, name: hoveredNode.name } as Partial<Project>)}
                size={34}
              />
              <h3 className="text-base font-black leading-tight">{formatProjectName(hoveredNode.name)}</h3>
            </div>
            <div className="space-y-1 text-[10px] font-black uppercase tracking-wider">
              <div className="text-white/65 dark:text-zinc-600">Version: {hoveredProject?.latest_version || 'N/A'}</div>
              <div className="text-white/65 dark:text-zinc-600">Release: {formatDateLabel(hoveredRelease)}</div>
              <div className={theme === 'dark' ? releaseFreshness.tone.replace('500', '300') : releaseFreshness.tone}>
                Release {releaseFreshness.label}
              </div>
              <div className={theme === 'dark' ? activityFreshness.tone.replace('500', '300') : activityFreshness.tone}>
                Activity {activityFreshness.label}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
