/**
 * Live progress for people watching a run (a terminal, a demo, a CI log). Silent unless the CLI sets a sink,
 * so library use and tests print nothing. Lines go to stderr; stdout keeps the summary.
 */
let sink: ((line: string) => void) | null = null;
let started = Date.now();

export function setProgress(fn: ((line: string) => void) | null): void {
  sink = fn;
  started = Date.now();
}

export function progress(line: string): void {
  if (!sink) return;
  const s = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
  sink(`[${s}s] ${line}`);
}

export const progressEnabled = () => sink !== null;
