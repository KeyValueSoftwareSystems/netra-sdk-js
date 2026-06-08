/**
 * Shared span-name pattern matching utilities for span blocking.
 *
 * Pattern forms, determined by the position of `*`:
 *   - Exact:    "openai.chat"   → name === "openai.chat"
 *   - Prefix:   "openai.*"      → name.startsWith("openai.")
 *   - Suffix:   "*.chat"        → name.endsWith(".chat")
 *   - Contains: "*openai*"      → name.includes("openai")
 *   - Wildcard: "*"             → matches everything
 */

export interface CompiledPatterns {
  matchAll: boolean;
  exact: Set<string>;
  prefixes: string[];
  suffixes: string[];
  contains: string[];
  isEmpty: boolean;
}

/**
 * Compile a list of raw pattern strings into a CompiledPatterns object.
 * Empty strings are skipped.
 */
export function compilePatterns(patterns: string[]): CompiledPatterns {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  const suffixes: string[] = [];
  const contains: string[] = [];
  let matchAll = false;

  for (const p of patterns) {
    if (!p) continue;

    if (p === "*") {
      matchAll = true;
    } else if (p.startsWith("*") && p.endsWith("*")) {
      const inner = p.slice(1, -1);
      if (inner) contains.push(inner);
    } else if (p.endsWith("*")) {
      prefixes.push(p.slice(0, -1));
    } else if (p.startsWith("*")) {
      suffixes.push(p.slice(1));
    } else {
      exact.add(p);
    }
  }

  const isEmpty = !matchAll && exact.size === 0 && prefixes.length === 0 &&
    suffixes.length === 0 && contains.length === 0;

  return { matchAll, exact, prefixes, suffixes, contains, isEmpty };
}

/**
 * Test whether `name` matches any pattern in a compiled set.
 */
export function matchesAnyPattern(
  name: string,
  compiled: CompiledPatterns,
): boolean {
  if (compiled.matchAll) return true;
  if (compiled.exact.has(name)) return true;

  for (const pref of compiled.prefixes) {
    if (name.startsWith(pref)) return true;
  }

  for (const suf of compiled.suffixes) {
    if (name.endsWith(suf)) return true;
  }

  for (const sub of compiled.contains) {
    if (name.includes(sub)) return true;
  }

  return false;
}
