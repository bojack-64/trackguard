// utils.ts — Reference ID generation, URL validation, and shared helpers

/**
 * Generate a unique public reference ID like "TG-2026-0042".
 * Uses the current year and a random 4-digit number.
 */
export function generateReferenceId(): string {
  const year = new Date().getFullYear();
  const num = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `TG-${year}-${num}`;
}

/**
 * Validate and normalise a URL.
 * Returns the normalised URL string, or null if invalid.
 * Adds https:// if no protocol is specified.
 */
export function validateUrl(input: string): string | null {
  let urlStr = input.trim();

  // Add https:// if no protocol given
  if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
    urlStr = 'https://' + urlStr;
  }

  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    // Must have a valid-looking hostname (at least one dot, or localhost)
    if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Validate an email address (basic check).
 */
export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
