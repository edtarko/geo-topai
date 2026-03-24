export interface Project {
  id: string;
  name: string;
  github_url: string;
  stars: number;
  license: string;
  language: string;
  category: 'framework' | 'library' | 'tool' | 'model' | 'dataset' | 'application';
  first_release: string;
  latest_version: string;
  latest_release_date: string;
  repo_pushed_at?: string;
  project_logo_url?: string;
  is_maintained: boolean;
  org_id: string;
  org_name?: string;
  org_website?: string;
  description: string;
  last_updated?: string;
  dependencies?: { id: string; name: string }[];
  maintainers?: Person[];
  topics?: string[];
}

export interface Person {
  id: string;
  name: string;
  github_handle: string;
  avatar_url: string;
}

export interface Company {
  id: string;
  name: string;
  website: string;
}

export interface GraphData {
  nodes: { id: string; name: string; category: string; stars: number }[];
  links: { source: string; target: string }[];
}
