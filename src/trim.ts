/**
 * Linear-time trims of a run of given characters at either end of a string.
 *
 * They replace anchored regexes such as `/[.,;:!?]+$/` and `/\/+$/`, which are
 * quadratic on a long run that is NOT at the end: the engine retries the run
 * from every start position before failing at the character after it (CodeQL
 * js/polynomial-redos). 50,000 `/` followed by `x` took about two seconds
 * through `/\/+$/`; these walk the string once from the end being trimmed.
 *
 * `chars` is a set of single UTF-16 code units, matched exactly as a regex
 * character class of the same characters matches them.
 *
 * Dependency-free: this engine takes relative imports only.
 */
export function trimTrailing(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

export function trimLeading(s: string, chars: string): string {
  let start = 0;
  while (start < s.length && chars.includes(s[start])) start++;
  return s.slice(start);
}

/**
 * Each run of spaces and tabs directly before a newline removed, the newline
 * kept: the output of `s.replace(/[ \t]+\n/g, "\n")`, in one pass per line
 * instead of a rescan of the run from each of its positions.
 */
export function trimLineEnds(s: string): string {
  const lines = s.split("\n");
  for (let i = 0; i < lines.length - 1; i++) lines[i] = trimTrailing(lines[i], " \t");
  return lines.join("\n");
}
