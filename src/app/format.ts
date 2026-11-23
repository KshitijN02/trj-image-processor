export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function percentSaved(before: number, after: number): string {
  if (before <= 0) return '–';
  const p = (1 - after / before) * 100;
  return `${p >= 0 ? '−' : '+'}${Math.abs(p).toFixed(0)}%`;
}
