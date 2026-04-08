const MAX_BODY_SIZE = 100 * 1024; // 100KB

export function truncateBody(body: string | undefined | null): { text: string | null; originalLength: number } {
  if (!body) return { text: null, originalLength: 0 };

  const originalLength = body.length;
  if (originalLength <= MAX_BODY_SIZE) {
    return { text: body, originalLength };
  }

  return {
    text: body.substring(0, MAX_BODY_SIZE) + `\n... [truncated, total ${originalLength} chars]`,
    originalLength,
  };
}
