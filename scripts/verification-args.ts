import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function verificationArgs(argv: string[]): { help: boolean; summary?: string } {
  const result: { help: boolean; summary?: string } = { help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") { result.help = true; continue; }
    if (argument !== "--summary" || result.summary) throw new Error("Use --help or --summary <new.json>.");
    const path = argv[++index];
    if (!path || path.startsWith("--")) throw new Error("--summary requires a new JSON file path.");
    result.summary = resolve(path);
    if (existsSync(result.summary)) throw new Error("Summary already exists; earlier verification evidence will not be overwritten.");
  }
  return result;
}

export function saveVerificationSummary(path: string | undefined, report: Record<string, unknown>): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
