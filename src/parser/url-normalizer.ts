const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURE_NUMERIC_REGEX = /^\d+$/;
const LONG_RANDOM_REGEX = /^[a-zA-Z0-9]{16,}$/;

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const normalized = segments.map((seg) => {
      if (!seg) return seg;
      if (PURE_NUMERIC_REGEX.test(seg)) return '{id}';
      if (UUID_REGEX.test(seg)) return '{id}';
      if (LONG_RANDOM_REGEX.test(seg) && !/^v\d+$/.test(seg)) return '{id}';
      return seg;
    });
    parsed.pathname = normalized.join('/');
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}
