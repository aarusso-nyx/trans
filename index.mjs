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
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import OpenAI from "openai";
import cliProgress from "cli-progress";
// import pLimit from "p-limit";
import crypto from "crypto";
import chalk from "chalk";
import { Command } from "commander";

const program = new Command();
program
  .name("i18n-translator")
  .description("Translate Angular i18n XLF files using OpenAI models")
  .argument("<file>", "Input XLF file path (e.g., messages.xlf)")
  .option(
    "-t, --target <langs>",
    "Target language(s) (comma-separated or alias: west/east). Default: en",
    "en",
  )
  .option("-m, --model <model>", "OpenAI model (default: gpt-4o)", "gpt-4o")
  .option("-b, --batch <size>", "Batch size (default: 50)", "50")
  // .option("-c, --concurrency <n>", "Concurrent requests (default: 3)", "3")
  .option("--cache <file>", "Cache file (default: .i18n-cache.json)", ".i18n-cache.json")
  .option("--clobber", "Re-translate and overwrite existing targets", false)
  .option("--verbose", "Verbose logging", false)
  .option(
    "--context <strategy>",
    "Context reuse: none | lang | run (alias: all). Default: none",
    "none",
  )
  .option("--clean-cache", "Delete cache file before running", false)
  .option("-s, --source <lang>", "Specify source language (skip detection)")
  .addHelpText(
    "after",
    `
Alias packs:
  west => pt,en,es,fr,de
  east => jp,ko,zh,ar
  all  => pt,en,es,fr,de,jp,ko,zh,ar

Examples:
  $ node index.mjs messages.xlf -t fr
  $ node index.mjs messages.xlf -t en,es,fr,de
  $ node index.mjs messages.xlf -t west --verbose
  $ node index.mjs messages.xlf -t es --clobber
  $ node index.mjs messages.xlf -t all

Context strategies:
  none  - stateless per batch (default)
  lang  - reuse chat context within a target language
  run   - reuse chat context across the entire run (alias: all)
`,
  )
  .parse(process.argv);

const opts = program.opts();
const INPUT_FILE = program.args[0];
const TARGET_SPEC = opts.target;
const MODEL = opts.model;
const BATCH_SIZE = parseInt(opts.batch, 10);
// const CONCURRENCY = parseInt(opts.concurrency, 10);
const CACHE_FILE = opts.cache;
const CLOBBER = Boolean(opts.clobber);
const VERBOSE = Boolean(opts.verbose); // default false, enable with --verbose
const CONTEXT_STRATEGY = String(opts.context || "none").toLowerCase();
const CLEAN_CACHE = Boolean(opts["cleanCache"]) || Boolean(opts["clean-cache"]);
const SOURCE_LANG_CLI = opts.source ? String(opts.source).trim() : null;

// Output files live alongside the input
const OUT_DIR = path.dirname(INPUT_FILE);

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CONTEXT_MAX_TURNS = 5; // cap retained context to last N user/assistant pairs
// const limit = pLimit(CONCURRENCY);

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

// legacy composite cache key removed; using nested cache structure

function getNested(cache, srcLang, tgtLang, model) {
  if (!cache || typeof cache !== "object") return null;
  const s = (srcLang || "auto").toLowerCase();
  const t = (tgtLang || "").toLowerCase();
  const m = (model || "").toLowerCase();
  cache.entries = cache.entries || {};
  cache.entries[s] = cache.entries[s] || {};
  cache.entries[s][t] = cache.entries[s][t] || {};
  cache.entries[s][t][m] = cache.entries[s][t][m] || {};
  return cache.entries[s][t][m];
}

function readFromCache(cache, srcLang, tgtLang, model, text) {
  const bucket = getNested(cache, srcLang, tgtLang, model);
  return bucket ? bucket[hashKey(text)] : undefined;
}

function writeToCache(cache, srcLang, tgtLang, model, text, translation) {
  const bucket = getNested(cache, srcLang, tgtLang, model);
  bucket[hashKey(text)] = translation;
}

function looksLikeFlatCache(obj) {
  if (!obj || typeof obj !== "object") return false;
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  // Heuristic: flat keys contain at least 3 pipes
  return keys.some((k) => typeof k === "string" && k.split("|").length >= 4);
}

function migrateCache(oldCache) {
  const cache = oldCache && typeof oldCache === "object" ? oldCache : {};
  if (cache.entries && typeof cache.entries === "object") return cache; // already nested
  const nested = { entries: {} };
  if (looksLikeFlatCache(cache)) {
    for (const [k, v] of Object.entries(cache)) {
      if (typeof k !== "string") continue;
      const parts = k.split("|");
      if (parts.length < 4) continue;
      const [s, t, m, h] = parts;
      const bucket = getNested(nested, s, t, m);
      bucket[h] = v; // carry over by hash (original text unknown)
    }
  }
  return nested;
}

// removed: detectLang (single-text). Use detectLangFromCorpus instead.

async function detectLangFromCorpus(allTexts) {
  const MAX_CHARS = 8000;
  const corpus = (allTexts || []).join("\n").slice(0, MAX_CHARS);
  const prompt = `Given the following application UI text corpus, return only the ISO 639-1 language code (e.g., en, pt, fr). If uncertain, return the most likely code.
Corpus:\n${corpus}`;
  const res = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });
  return res.choices[0].message.content.trim();
}

function normalizeLang(code) {
  if (!code) return null;
  const s = String(code).trim();
  // Accept en or en-US; prefer two-letter lower-case
  const m = s.match(/^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/);
  if (!m) return null;
  return s.split("-")[0].toLowerCase();
}

async function promptForLang(defaultLang) {
  const rl = readline.createInterface({ input, output });
  const ans = await rl.question(
    `Unable to detect source language. Please enter ISO 639-1 code (e.g., en, pt).${
      defaultLang ? ` [default: ${defaultLang}]` : ""
    }: `,
  );
  await rl.close();
  const provided = ans && ans.trim().length > 0 ? ans.trim() : defaultLang;
  return normalizeLang(provided);
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

function trimContext(ctx) {
  if (!Array.isArray(ctx)) return ctx;
  const maxMessages = CONTEXT_MAX_TURNS * 2; // user + assistant per turn
  if (ctx.length > maxMessages) {
    // remove oldest messages to keep the last maxMessages
    ctx.splice(0, ctx.length - maxMessages);
  }
  return ctx;
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

async function translateBatchWithContext(texts, srcLang, tgtLang, model, ctxMessages) {
  const prompt = `
Translate the following ${texts.length} software UI strings from ${srcLang} to ${tgtLang}.
Keep placeholders like <x id="INTERPOLATION_1"/> intact.
Use concise, neutral UX tone.
Preserve punctuation and capitalization.
Return only translations separated by newline (\\n), in the same order.

Texts:\n${texts.join("\n")}
`;
  const messages = [];
  if (Array.isArray(ctxMessages) && ctxMessages.length > 0)
    messages.push(...trimContext(ctxMessages));
  messages.push({ role: "user", content: prompt });
  const res = await client.chat.completions.create({ model, messages });
  const content = res.choices[0].message.content;
  const translations = content
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (Array.isArray(ctxMessages)) {
    ctxMessages.push({ role: "user", content: prompt }, { role: "assistant", content });
    trimContext(ctxMessages);
  }
  return translations;
}

// ---------- Main workflow ----------

function expandTargets(spec) {
  if (!spec) return ["en"];
  const s = String(spec).trim().toLowerCase();
  if (s === "west") return ["pt", "en", "es", "fr", "de"]; // language pack alias
  if (s === "east") return ["jp", "ko", "zh", "ar"]; // language pack alias
  if (s === "all") return ["pt", "en", "es", "fr", "de", "jp", "ko", "zh", "ar"]; // all packs
  return spec
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

async function translateForLanguage(destLang, sourceDoc, sourceUnits, srcLang, cache, runContext) {
  const OUTPUT_FILE = path.join(OUT_DIR, `messages.${destLang}.xlf`);
  console.log(chalk.cyan(`🌐 Translating: ${chalk.bold(INPUT_FILE)} → ${chalk.bold(OUTPUT_FILE)}`));

  // Read source file (messages.xlf)
  // sourceDoc is used to derive target documents; file/body resolved per operation
  // Extract and prepare unique source texts
  const allTexts = sourceUnits
    .map((u) =>
      typeof u?.source?.[0] === "string" ? u.source[0] : JSON.stringify(u?.source?.[0] ?? ""),
    )
    .filter((s) => typeof s === "string");
  const uniqueTexts = Array.from(new Set(allTexts.map((s) => s.trim())))
    .filter((s) => s.length > 0)
    .sort((a, b) => a.localeCompare(b));
  console.log(
    chalk.gray(
      `Found ${sourceUnits.length} source translation units; ${uniqueTexts.length} unique strings.`,
    ),
  );

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
  targetFile.$["target-language"] = destLang;

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

  // Cache is provided by caller and shared across all languages in this run

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

  // Prewarm cache from existing targets when not clobbering
  if (!CLOBBER) {
    for (const su of sourceUnits) {
      const id = idOf(su);
      if (!id) continue;
      const existing = existingTargetById.get(id);
      const raw =
        typeof su?.source?.[0] === "string" ? su.source[0] : JSON.stringify(su?.source?.[0] ?? "");
      const src = (raw || "").trim();
      if (existing && String(existing).trim().length > 0) {
        writeToCache(cache, srcLang, destLang, MODEL, src, existing);
      }
    }
  }

  // Determine which unique strings need translation
  const toTranslateUnique = uniqueTexts.filter(
    (t) => CLOBBER || !readFromCache(cache, srcLang, destLang, MODEL, t),
  );

  console.log(
    chalk.yellow(
      `Translating ${toTranslateUnique.length} of ${uniqueTexts.length} unique strings → ${destLang}...`,
    ),
  );

  const bar = new cliProgress.SingleBar(
    { format: chalk.blue("Progress") + " [{bar}] {percentage}% | {value}/{total}" },
    cliProgress.Presets.shades_classic,
  );
  bar.start(toTranslateUnique.length, 0);

  // Choose context handling
  let ctx = null;
  if (CONTEXT_STRATEGY === "run" || CONTEXT_STRATEGY === "all") ctx = runContext || [];
  if (CONTEXT_STRATEGY === "lang") ctx = [];

  // Process unique strings in batches
  for (let i = 0; i < toTranslateUnique.length; i += BATCH_SIZE) {
    const batch = toTranslateUnique.slice(i, i + BATCH_SIZE);
    if (batch.length > 0) {
      try {
        if (VERBOSE) {
          console.log(chalk.gray("→ Submitting for translation (unique strings):"));
          batch.forEach((t, idx2) => console.log(`  [${i + idx2 + 1}] ${t}`));
        }
        const translations = ctx
          ? await translateBatchWithContext(batch, srcLang, destLang, MODEL, ctx)
          : await translateBatch(batch, srcLang, destLang, MODEL);
        batch.forEach((text, idx2) => {
          const translated = translations[idx2];
          writeToCache(cache, srcLang, destLang, MODEL, text, translated);
          if (VERBOSE) console.log(chalk.gray(`← Received: ${translated}`));
          bar.increment();
        });
        await fs.writeJSON(CACHE_FILE, cache, { spaces: 2 });
      } catch (err) {
        console.error(chalk.red(`⚠️ Batch failed: ${err.message}`));
      }
    }
  }

  bar.stop();

  // Assign translations from cache to every trans-unit and ensure <target>
  for (const su of sourceUnits) {
    const id = idOf(su);
    if (!id) continue;
    const tu = targetById.get(id);
    if (!tu.target) tu.target = [""];
    const existing = existingTargetById.get(id);
    const raw =
      typeof su?.source?.[0] === "string" ? su.source[0] : JSON.stringify(su?.source?.[0] ?? "");
    const src = (raw || "").trim();
    if (!CLOBBER && existing && String(existing).trim().length > 0) {
      tu.target[0] = existing;
    } else {
      const translated = readFromCache(cache, srcLang, destLang, MODEL, src);
      if (translated != null) tu.target[0] = translated;
    }
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

async function main() {
  // Read source file (messages.xlf)
  const sourceXml = await fs.readFile(INPUT_FILE, "utf8");
  const sourceDoc = await parseStringPromise(sourceXml);
  const sourceUnits = extractUnits(sourceDoc?.xliff?.file?.[0]?.body?.[0]);

  // Clean cache if requested
  if (CLEAN_CACHE) {
    try {
      await fs.remove(CACHE_FILE);
      console.log(chalk.gray(`🧹 Cache cleared: ${CACHE_FILE}`));
    } catch {}
  }

  // Load or initialize cache (shared across all target langs)
  const loadedCache = (await fs.readJSON(CACHE_FILE).catch(() => ({}))) || {};
  const cache = migrateCache(loadedCache);

  // Detect source language once
  let srcLang = null;
  if (SOURCE_LANG_CLI) {
    srcLang = normalizeLang(SOURCE_LANG_CLI);
  }
  if (!srcLang) {
    const fileSrcAttr = sourceDoc?.xliff?.file?.[0]?.$?.["source-language"];
    srcLang = normalizeLang(fileSrcAttr);
  }
  if (!srcLang) {
    const allTexts = sourceUnits
      .map((u) =>
        typeof u?.source?.[0] === "string" ? u.source[0] : JSON.stringify(u?.source?.[0] ?? ""),
      )
      .filter(Boolean);
    const detected = await detectLangFromCorpus(allTexts);
    srcLang = normalizeLang(detected);
  }
  if (!srcLang) {
    srcLang = await promptForLang("en");
  }
  console.log(chalk.green(`Detected source language: ${srcLang}`));

  const targets = expandTargets(TARGET_SPEC);
  const runContext = CONTEXT_STRATEGY === "run" || CONTEXT_STRATEGY === "all" ? [] : null;
  for (const lang of targets) {
    await translateForLanguage(lang, sourceDoc, sourceUnits, srcLang, cache, runContext);
  }
}

// Run
main().catch((err) => {
  console.error(chalk.red("❌ Translation failed:"), err);
  process.exit(1);
});
