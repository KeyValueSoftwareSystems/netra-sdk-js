/**
 * Shared span-name pattern matching utilities for span blocking.
 *
 * Three pattern forms, determined by the position of a single `*`:
 *   - Exact:  "openai.chat"   → name === "openai.chat"
 *   - Prefix: "openai.*"      → name.startsWith("openai.")
 *   - Suffix: "*.chat"        → name.endsWith(".chat")
 *
 */

export interface CompiledPatterns {
  exact: Set<string>;   // Kept as Set for O(1) lookup time
  prefixes: string[];   // Stored without the trailing `*`
  suffixes: string[];   // Stored without the leading `*`
}

/**
 * Compile a list of raw pattern strings into a CompiledPatterns object.
 * Empty strings are skipped.
 */
export function compilePatterns(patterns: string[]): CompiledPatterns {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  const suffixes: string[] = [];

  for (const p of patterns) {
    if (!p) continue;
    if (p.endsWith("*") && !p.startsWith("*")) {
      prefixes.push(p.slice(0, -1));
    } else if (p.startsWith("*") && !p.endsWith("*")) {
      suffixes.push(p.slice(1));
    } else {
      exact.add(p);
    }
  }

  return { exact, prefixes, suffixes };
}

/**
 * Test whether `name` matches any pattern in a compiled set.
 * Returns `false` immediately if all pattern lists are empty.
 */
export function matchesPatterns(
  name: string,
  compiled: CompiledPatterns,
): boolean {
  if (compiled.exact.has(name)) return true;

  for (const pref of compiled.prefixes) {
    if (name.startsWith(pref)) return true;
  }

  for (const suf of compiled.suffixes) {
    if (name.endsWith(suf)) return true;
  }

  return false;
}
