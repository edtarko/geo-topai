const STATIC_PREFIX = '/deploy-data';

function looksLikeHtml(contentType: string | null, text: string) {
  return (
    (contentType || '').includes('text/html') ||
    text.trim().startsWith('<!doctype html') ||
    text.trim().startsWith('<html')
  );
}

export function isHostedReadonlyMode() {
  if (typeof window === 'undefined') return false;
  return /\.vercel\.app$/i.test(window.location.hostname);
}

export async function fetchJsonWithFallback<T>(primaryUrl: string, fallbackUrl: string): Promise<T> {
  try {
    const response = await fetch(primaryUrl);
    const text = await response.text();
    if (response.ok && !looksLikeHtml(response.headers.get('content-type'), text)) {
      return JSON.parse(text) as T;
    }
  } catch {
    // Fall through to static snapshot.
  }

  const fallbackResponse = await fetch(fallbackUrl);
  if (!fallbackResponse.ok) {
    throw new Error(`Fallback request failed (${fallbackResponse.status})`);
  }
  return await fallbackResponse.json() as T;
}

export async function fetchJsonWithFallbackTransform<TPrimary, TFallback>(
  primaryUrl: string,
  fallbackUrl: string,
  transform: (value: TFallback) => TPrimary,
): Promise<TPrimary> {
  try {
    const response = await fetch(primaryUrl);
    const text = await response.text();
    if (response.ok && !looksLikeHtml(response.headers.get('content-type'), text)) {
      return JSON.parse(text) as TPrimary;
    }
  } catch {
    // Fall through to static snapshot.
  }

  const fallbackResponse = await fetch(fallbackUrl);
  if (!fallbackResponse.ok) {
    throw new Error(`Fallback request failed (${fallbackResponse.status})`);
  }
  return transform(await fallbackResponse.json() as TFallback);
}

export async function fetchTextWithFallback(primaryUrl: string, fallbackUrl: string): Promise<{ text: string; filename?: string }> {
  try {
    const response = await fetch(primaryUrl);
    const text = await response.text();
    if (response.ok && !looksLikeHtml(response.headers.get('content-type'), text)) {
      const contentDisposition = response.headers.get('content-disposition') || '';
      const fileNameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      return { text, filename: fileNameMatch?.[1] };
    }
  } catch {
    // Fall through to static snapshot.
  }

  const fallbackResponse = await fetch(fallbackUrl);
  if (!fallbackResponse.ok) {
    throw new Error(`Fallback request failed (${fallbackResponse.status})`);
  }
  return {
    text: await fallbackResponse.text(),
  };
}

export async function downloadTextWithFallback(primaryUrl: string, fallbackUrl: string, fallbackFileName: string, mimeType = 'text/plain;charset=utf-8') {
  const { text, filename } = await fetchTextWithFallback(primaryUrl, fallbackUrl);
  const blob = new Blob([text], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename || fallbackFileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

export function deployDataPath(fileName: string) {
  return `${STATIC_PREFIX}/${fileName}`;
}

export function staticExportPath(table: string, format: 'csv' | 'tsv' | 'json') {
  return deployDataPath(`${table}.${format}`);
}
