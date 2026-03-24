const ACRONYMS = new Set([
  'ai',
  'ml',
  'llm',
  'nlp',
  'rnn',
  'cnn',
  'gpt',
  'api',
  'sdk',
  'ui',
  'ux',
  'sql',
  'db',
  'gpu',
  'cpu',
  'http',
  'https',
  'json',
  'yaml',
]);

function capitalizeToken(token: string) {
  if (!token) return token;
  if (ACRONYMS.has(token.toLowerCase())) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

export function formatProjectName(input?: string | null) {
  if (!input) return 'Unknown Project';
  const cleaned = input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/^@/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  if (!cleaned) return 'Unknown Project';
  return cleaned
    .split(' ')
    .map((part) => capitalizeToken(part))
    .join(' ');
}
