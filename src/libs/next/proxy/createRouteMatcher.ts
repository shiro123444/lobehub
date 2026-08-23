import { type NextRequest } from 'next/server';

/**
 * Creates a route matcher function that checks if a request path matches any of the given patterns
 * @param patterns Array of route patterns - supports `(.*)` as wildcard
 * @returns Function that returns true if the request matches any pattern
 */
export function createRouteMatcher(patterns: string[]) {
  const regexPatterns = patterns.map((pattern) => {
    // Escape all special regex chars (including parentheses), then restore (.*) to wildcard
    const regexStr = pattern
      .replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&')
      .replaceAll('\\(\\.\\*\\)', '.*');
    return new RegExp(`^${regexStr}$`);
  });

  return (req: NextRequest) => {
    let pathname = req.nextUrl.pathname;

    // Clean variants and spa prefix
    // e.g., /spa/zh-CN/signin -> /signin
    // e.g., /zh-CN/signin -> /signin
    // e.g., /mobile_zh-CN/signin -> /signin
    pathname = pathname
      .replace(/^\/spa\/[^/]+/, '')
      .replace(/^\/[^/]+/, (match) => {
        const segment = match.slice(1);
        if (segment.includes('_') || segment.includes('-') || segment.length === 2 || segment === 'en') {
          return '';
        }
        return match;
      });

    if (pathname === '') pathname = '/';

    return regexPatterns.some((regex) => regex.test(pathname));
  };
}
