/** Shared truncation limit (100KB). Import this constant instead of hardcoding. */
export const TRUNCATE_LIMIT = 100 * 1024;

export function truncateBody(body: string | undefined | null): { text: string | null; originalLength: number } {
  if (!body) return { text: null, originalLength: 0 };

  const originalLength = body.length;
  if (originalLength <= TRUNCATE_LIMIT) {
    return { text: body, originalLength };
  }

  return {
    text: body.substring(0, TRUNCATE_LIMIT) + `\n... [truncated, total ${originalLength} chars]`,
    originalLength,
  };
}
