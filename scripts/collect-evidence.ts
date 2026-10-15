import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (name === "claude-config" || name === "sandbox" || name === "node_modules") continue;
    if (st.isDirectory()) walk(full, acc);
    else if (name !== "requests.jsonl") acc.push(full);
  }
  return acc;
}

function main(): void {
  const root = join(process.cwd(), "evidence");
  mkdirSync(root, { recursive: true });
  const files = walk(root).filter((f) => !f.endsWith("SHA256SUMS.txt"));
  const lines = files
    .map((file) => {
      const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
      return `${hash}  ${relative(root, file)}`;
    })
    .sort();
  writeFileSync(join(root, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
  console.log(`Wrote ${lines.length} hashes to evidence/SHA256SUMS.txt`);
}

main();
