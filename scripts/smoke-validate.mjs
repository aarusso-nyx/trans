#!/usr/bin/env node
import fs from "fs-extra";
import path from "path";
import { parseStringPromise } from "xml2js";

function parseArgs(argv) {
  const args = { file: null, lang: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--file" || a === "-f") && argv[i + 1]) {
      args.file = argv[++i];
      continue;
    }
    if ((a === "--lang" || a === "-l") && argv[i + 1]) {
      args.lang = argv[++i];
      continue;
    }
  }
  return args;
}

async function findTargetFile() {
  const files = await fs.readdir(process.cwd());
  const candidates = files.filter((f) => /^messages\.[^.]+\.xlf$/.test(f) && f !== "messages.xlf");
  return candidates[0] || null;
}

async function main() {
  const opts = parseArgs(process.argv);
  const filePath = opts.file || (await findTargetFile());
  if (!filePath) {
    console.log(
      "Smoke: no messages.<lang>.xlf found. Run `npm run translate -- -t <lang>` first. Skipping.",
    );
    return; // exit 0
  }

  const expectedLang =
    opts.lang ||
    path
      .basename(filePath)
      .replace(/^messages\./, "")
      .replace(/\.xlf$/, "");
  const xml = await fs.readFile(filePath, "utf8");
  const doc = await parseStringPromise(xml);

  const fileNode = doc?.xliff?.file?.[0];
  if (!fileNode) {
    console.error("Invalid XLF: missing <file>");
    process.exit(1);
  }
  const actualLang = fileNode.$?.["target-language"];
  if (!actualLang) {
    console.error("Invalid XLF: missing target-language attribute on <file>");
    process.exit(1);
  }
  if (actualLang !== expectedLang) {
    console.error(`Invalid target-language: expected ${expectedLang}, got ${actualLang}`);
    process.exit(1);
  }

  const body = fileNode.body?.[0];
  const units = [];
  (function recurse(node) {
    if (!node) return;
    if (Array.isArray(node["trans-unit"])) units.push(...node["trans-unit"]);
    if (Array.isArray(node.group)) node.group.forEach(recurse);
  })(body);

  if (!units.length) {
    console.error("Invalid XLF: no <trans-unit> elements found");
    process.exit(1);
  }

  const missingTargets = units.filter((u) => !u.target);
  if (missingTargets.length) {
    console.error(`Invalid XLF: ${missingTargets.length} trans-unit(s) missing <target>`);
    process.exit(1);
  }

  console.log(`Smoke OK: ${filePath} target-language=${actualLang}, units=${units.length}`);
}

main().catch((e) => {
  console.error("Smoke failed:", e);
  process.exit(1);
});
