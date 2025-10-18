#!/usr/bin/env node
/**
 * Angular i18n XLF Translator — Universal CLI
 * --------------------------------------------
 * ✨ Features
 * - Auto-detect source language
 * - Takes target lang, model, and batch size as args
 * - Caches translations across runs (hash-based)
 * - Skips already translated entries
 * - Handles <group>, <note>, and plural ICU forms
 * - Batching, progress bar, concurrency control
 * - Pretty console logging with chalk
 * - Fully preserves XML structure and metadata
 *
 * Example:
 *   node i18n-translator.js messages.pt-BR.xlf en gpt-4o-mini 100
 */

import fs from "fs-extra";
import path from "path";
import { parseStringPromise, Builder } from "xml2js";
import OpenAI from "openai";
import cliProgress from "cli-progress";
import pLimit from "p-limit";
import crypto from "crypto";
import chalk from "chalk";
import { Command } from "commander";

const program = new Command();
program
  .name("i18n-translator")
  .description("Translate Angular i18n XLF files using OpenAI models")
  .argument("<file>", "Input XLF file path (e.g., messages.xlf)")
  .option("-t, --target <lang>", "Target language (default: en)", "en")
  .option("-m, --model <model>", "OpenAI model (default: gpt-4o)", "gpt-4o")
  .option("-b, --batch <size>", "Batch size (default: 25)", "25")
  .option("-c, --concurrency <n>", "Concurrent requests (default: 3)", "3")
  .option("--cache <file>", "Cache file (default: .i18n-cache.json)", ".i18n-cache.json")
  .option("--clobber", "Re-translate and overwrite existing targets", false)
  .option("--overwrite", "DEPRECATED: same as --clobber", false)
  .option("--verbose", "Verbose logging (use --no-verbose to silence)", true)
  .parse(process.argv);

const opts = program.opts();
const INPUT_FILE = program.args[0];
const DEST_LANG = opts.target;
const MODEL = opts.model;
const BATCH_SIZE = parseInt(opts.batch, 10);
const CONCURRENCY = parseInt(opts.concurrency, 10);
const CACHE_FILE = opts.cache;
const CLOBBER = Boolean(opts.clobber || opts.overwrite);
const VERBOSE = opts.verbose !== false; // default true, allow --no-verbose

// Output is messages.<lang>.xlf in the same directory as the input
const OUT_DIR = path.dirname(INPUT_FILE);
const OUTPUT_FILE = path.join(OUT_DIR, `messages.${DEST_LANG}.xlf`);

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const limit = pLimit(CONCURRENCY);

// ---------- Helper functions ----------

function hashKey(text) {
  // Normalize any input into a safe string for hashing
  if (text == null) text = "";
  if (typeof text !== "string") {
    if (Array.isArray(text)) text = text.join(" ");
    else if (typeof text === "object") text = JSON.stringify(text);
    else text = String(text);
  }
  return crypto.createHash("sha256").update(text.trim()).digest("hex");
}

async function detectLang(text) {
  const prompt = `Detect the ISO 639-1 code of this text: "${text}". Only return the code.`;
  const res = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });
  return res.choices[0].message.content.trim();
}

function extractUnits(body) {
  // Recursively gather all <trans-unit> within <body> and <group> nodes
  const result = [];
  (function recurse(node) {
    if (!node) return;
    if (Array.isArray(node["trans-unit"])) result.push(...node["trans-unit"]);
    if (Array.isArray(node.group)) node.group.forEach(recurse);
  })(body);
  return result;
}

async function translateBatch(texts, srcLang, tgtLang, model) {
  const prompt = `
Translate the following ${texts.length} software UI strings from ${srcLang} to ${tgtLang}.
Keep placeholders like <x id="INTERPOLATION_1"/> intact.
Use concise, neutral UX tone.
Preserve punctuation and capitalization.
Return only translations separated by newline (\\n), in the same order.

Texts:
${texts.join("\n")}
`;
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
  });

  return res.choices[0].message.content
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------- Main workflow ----------

async function main() {
  console.log(chalk.cyan(`🌐 Translating: ${chalk.bold(INPUT_FILE)} → ${chalk.bold(OUTPUT_FILE)}`));

  // Read source file (messages.xlf)
  const sourceXml = await fs.readFile(INPUT_FILE, "utf8");
  const sourceDoc = await parseStringPromise(sourceXml);
  const sourceFile = sourceDoc?.xliff?.file?.[0];
  const sourceBody = sourceFile?.body?.[0];
  const sourceUnits = extractUnits(sourceBody);
  console.log(chalk.gray(`Found ${sourceUnits.length} source translation units.`));

  // Prepare target document: load existing if present, otherwise clone from source
  const outputExists = await fs.pathExists(OUTPUT_FILE);
  let targetDoc = null;
  if (outputExists) {
    const targetXml = await fs.readFile(OUTPUT_FILE, "utf8");
    targetDoc = await parseStringPromise(targetXml);
  } else {
    // Clone source as base for target
    targetDoc = JSON.parse(JSON.stringify(sourceDoc));
  }

  // Set target-language on <file>
  const targetFile = targetDoc.xliff.file[0];
  targetFile.$ = targetFile.$ || {};
  targetFile.$["target-language"] = DEST_LANG;

  const targetBody = targetFile.body?.[0] || ((targetFile.body = [{}]), targetFile.body[0]);
  const targetUnits = extractUnits(targetBody);

  // Map existing targets from target file by id
  const idOf = (u) => u?.$?.id || u?.$?.resname || u?.$?.["xml:id"] || null;
  const existingTargetById = new Map();
  for (const tu of targetUnits) {
    const id = idOf(tu);
    if (!id) continue;
    const t = tu.target?.[0];
    if (t != null) existingTargetById.set(id, t);
  }

  // Load cache
  const cache = (await fs.readJSON(CACHE_FILE).catch(() => ({}))) || {};

  // Detect source language once
  const firstText = sourceUnits.find((u) => u.source?.[0])?.source[0] || "Olá mundo";
  const srcLang = await detectLang(firstText);
  console.log(chalk.green(`Detected source: ${srcLang} → Target: ${DEST_LANG}`));

  // Build a map of targetDoc units by id for quick access; create any missing ids from source
  const targetById = new Map();
  for (const tu of targetUnits) {
    const id = idOf(tu);
    if (id) targetById.set(id, tu);
  }

  // Ensure every source unit exists in the target document
  for (const su of sourceUnits) {
    const id = idOf(su);
    if (!id) continue;
    if (!targetById.has(id)) {
      // Deep clone source unit into target doc
      const cloned = JSON.parse(JSON.stringify(su));
      // Ensure target field exists
      if (!cloned.target) cloned.target = [""];
      // Append to top-level body
      if (!Array.isArray(targetBody["trans-unit"])) targetBody["trans-unit"] = [];
      targetBody["trans-unit"].push(cloned);
      // Keep local lists/maps in sync
      targetUnits.push(cloned);
      targetById.set(id, cloned);
    } else {
      // Keep <source> in target doc synchronized with latest extraction
      const tu = targetById.get(id);
      tu.source = JSON.parse(JSON.stringify(su.source));
    }
  }

  // Determine which units need translation
  const toTranslate = [];
  for (const su of sourceUnits) {
    const id = idOf(su);
    if (!id) continue;
    const tu = targetById.get(id);
    // Pull any existing target from prior output if not clobbering
    let existing = existingTargetById.get(id);
    const src = su?.source?.[0] || "";
    if (!tu.target) tu.target = [""];
    const currentTarget = tu.target?.[0];
    if (!CLOBBER && existing && String(existing).trim().length > 0) {
      tu.target[0] = existing; // preserve existing translation
      continue;
    }
    const needs =
      CLOBBER ||
      !currentTarget ||
      String(currentTarget).trim().length === 0 ||
      String(currentTarget) === String(src);
    if (needs) {
      toTranslate.push({ id, su, tu, src });
    }
  }

  console.log(
    chalk.yellow(`Translating ${toTranslate.length} of ${sourceUnits.length} entries...`),
  );

  const bar = new cliProgress.SingleBar(
    { format: chalk.blue("Progress") + " [{bar}] {percentage}% | {value}/{total}" },
    cliProgress.Presets.shades_classic,
  );
  bar.start(toTranslate.length, 0);

  // Process in batches
  for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
    const batch = toTranslate.slice(i, i + BATCH_SIZE);
    const texts = batch.map(({ src }) => (typeof src === "string" ? src : JSON.stringify(src)));

    // Resolve cache hits
    const isCached = texts.map((t) => Boolean(cache[hashKey(t)]));
    const uncached = texts.filter((t, idx) => !isCached[idx]);

    if (uncached.length > 0) {
      try {
        if (VERBOSE) {
          console.log(chalk.gray("→ Submitting for translation:"));
          uncached.forEach((t, idx2) => console.log(`  [${i + idx2 + 1}] ${t}`));
        }
        const translations = await translateBatch(uncached, srcLang, DEST_LANG, MODEL);
        uncached.forEach((text, idx2) => {
          const translated = translations[idx2];
          cache[hashKey(text)] = translated;
          if (VERBOSE) console.log(chalk.gray(`← Received: ${translated}`));
        });
        await fs.writeJSON(CACHE_FILE, cache, { spaces: 2 });
      } catch (err) {
        console.error(chalk.red(`⚠️ Batch failed: ${err.message}`));
      }
    }

    // Write results back to targetDoc
    batch.forEach((item, idx2) => {
      const src = item.src || "";
      const translated = cache[hashKey(src)];
      if (!item.tu.target) item.tu.target = [""];
      if (translated != null) item.tu.target[0] = translated;
      bar.increment();
    });
  }

  bar.stop();

  // Ensure every trans-unit now has a <target>
  for (const tu of targetUnits) {
    if (!tu.target) tu.target = [""];
    if (tu.target.length === 0) tu.target.push("");
  }

  // Rebuild XML
  const builder = new Builder({
    headless: false,
    xmldec: { encoding: "UTF-8" },
    renderOpts: { pretty: true, indent: "  ", newline: "\n" },
  });

  const translatedXml = builder.buildObject(targetDoc);
  await fs.writeFile(OUTPUT_FILE, translatedXml, "utf8");
  await fs.writeJSON(CACHE_FILE, cache, { spaces: 2 });

  console.log(chalk.green(`✅ Saved translated file: ${OUTPUT_FILE}`));
  console.log(chalk.gray(`💾 Cache updated (${Object.keys(cache).length} entries)`));
}

// Run
main().catch((err) => {
  console.error(chalk.red("❌ Translation failed:"), err);
  process.exit(1);
});
