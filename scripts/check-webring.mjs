#!/usr/bin/env node
// Walks the webring: fetches every site in webringData and checks that it's up
// and still carries a working webring widget. Exit 1 if any site fails.
//
//   node scripts/check-webring.mjs [--report out.md]

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
const MAX_BUNDLES = 6;
const retryDelays = () => (process.env.WEBRING_RETRY_MS ?? "5000,15000").split(",").map(Number).filter(Boolean);
const UA = "Mozilla/5.0 (X11; Linux x86_64) utdring-health-check (+https://github.com/ryanpolasky/utdring)";

// hosts that reject GitHub's runner IPs but are fine from a browser
const CI_BLOCKED_HOSTS = ["personal.utdallas.edu"];

// keep in sync with javascript/helpers.js
const formatUrl = (url) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").replace(/^www\./, "");
const fuzzyMatch = (a, b) => {
  const x = formatUrl(a);
  const y = formatUrl(b);
  return x.includes(y) || y.includes(x);
};

// --- webringData out of index.html ---

function parseWebringData(html) {
  const start = html.indexOf("const webringData");
  if (start === -1) throw new Error("could not find `const webringData` in index.html");
  const open = html.indexOf("{", start);
  let depth = 0;
  let close = -1;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{" || html[i] === "[") depth++;
    else if (html[i] === "}" || html[i] === "]") depth--;
    if (depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) throw new Error("could not find the end of webringData");
  const json = html
    .slice(open, close + 1)
    .replace(/(^|[^:"'])\/\/[^\n]*/gm, "$1")
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
    .replace(/,(\s*[}\]])/g, "$1");
  const data = JSON.parse(json);
  if (!Array.isArray(data.sites)) throw new Error("webringData.sites is not an array");
  return data.sites;
}

// --- fetching ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": UA, accept: "text/html,*/*;q=0.8" },
    });
    return { status: res.status, ok: res.ok, finalUrl: res.url || url, text: await res.text() };
  } catch (err) {
    return { status: 0, ok: false, finalUrl: url, text: "", error: err.name === "AbortError" ? "timed out" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function getWithRetry(url) {
  let res;
  const delays = retryDelays();
  for (let i = 0; ; i++) {
    res = await get(url);
    const retryable = res.error || res.status === 429 || res.status >= 500;
    if (!retryable || i >= delays.length) return res;
    await sleep(delays[i]);
  }
}

async function mapConcurrent(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i; (i = next++) < items.length; ) out[i] = await fn(items[i]);
    })
  );
  return out;
}

// --- widget detection ---

const ringUrls = (text) => [...text.matchAll(/["'`=(]\s*([^"'`\s()]*utdring\.com[^"'`\s()]*)/gi)].map((m) => m[1]);

// client-rendered sites (React etc.) only have the widget in their JS bundles
async function textMentioningRing(html, pageUrl) {
  if (/utdring\.com/i.test(html)) return html;
  const origin = new URL(pageUrl).origin;
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => new URL(m[1], pageUrl).href)
    .filter((u) => u.startsWith(origin) && /\.[mc]?js(\?|$)/i.test(u))
    .slice(0, MAX_BUNDLES);
  for (const src of srcs) {
    const res = await get(src);
    if (res.ok && /utdring\.com/i.test(res.text)) return res.text;
  }
  return null;
}

// Returns { level: "ok" | "warn" | "fail", note }
async function checkSite(site, sites) {
  if (!/^https?:\/\//i.test(site.website ?? "")) return { level: "fail", note: "no usable URL" };

  const res = await getWithRetry(site.website);
  const host = new URL(site.website).hostname;

  if (res.error) {
    if (CI_BLOCKED_HOSTS.includes(host)) return { level: "warn", note: `unreachable from CI (${res.error}) — known to block runner IPs` };
    return { level: "fail", note: `unreachable: ${res.error}` };
  }
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    return { level: "warn", note: `HTTP ${res.status} — couldn't inspect from CI`, status: res.status };
  }
  if (!res.ok) return { level: "fail", note: `HTTP ${res.status}`, status: res.status };

  const text = await textMentioningRing(res.text, res.finalUrl);
  if (!text) return { level: "fail", note: "no webring widget found (page never references utdring.com)", status: res.status };

  const fragments = ringUrls(text)
    .map((u) => u.split("#")[1])
    .filter((f) => f != null)
    .map((f) => decodeURIComponent(f.split("?")[0]).trim());

  if (fragments.length === 0) return { level: "warn", note: "links to the ring but without a `#site` fragment, so prev/next can't work", status: res.status };
  if (fragments.some((f) => /[${]/.test(f) || f === "")) {
    // built at runtime — can't verify statically, but the widget is there
    return { level: "ok", note: "widget built at runtime; fragment not verified", status: res.status };
  }
  if (fragments.some((f) => /your-site-here/i.test(f))) {
    return { level: "fail", note: "widget still has the `your-site-here` placeholder", status: res.status };
  }
  if (fragments.some((f) => fuzzyMatch(f, site.website))) return { level: "ok", status: res.status };

  const other = sites.find((s) => s.website && fragments.some((f) => fuzzyMatch(f, s.website)));
  if (other) return { level: "warn", note: `widget points at ${other.name}'s entry (\`#${fragments[0]}\`), not this site's`, status: res.status };
  return { level: "fail", note: `widget points at \`#${fragments[0]}\`, which matches no ring member`, status: res.status };
}

// --- report ---

const ICON = { ok: "✅", warn: "⚠️", fail: "❌" };

function buildReport(results) {
  const count = (lvl) => results.filter((r) => r.level === lvl).length;
  const lines = [
    "## Webring health",
    "",
    `${results.length} sites walked: **${count("ok")} healthy**, **${count("warn")} warnings**, **${count("fail")} failing**.`,
    "",
    "| | Site | URL | HTTP | Note |",
    "| :-: | --- | --- | :-: | --- |",
  ];
  for (const r of results) {
    lines.push(
      `| ${ICON[r.level]} | ${r.site.name ?? "?"} | [${formatUrl(r.site.website ?? "")}](${r.site.website ?? ""}) | ${r.status ?? "—"} | ${r.note ?? ""} |`
    );
  }
  lines.push("", "❌ fails the check; ⚠️ is informational. Widget template: [README](https://github.com/ryanpolasky/utdring#widget-template).");
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const reportPath = argv.includes("--report") ? argv[argv.indexOf("--report") + 1] : null;

  const sites = parseWebringData(readFileSync(path.join(ROOT, "index.html"), "utf8"));
  console.log(`Walking ${sites.length} sites…`);

  const results = await mapConcurrent(sites, CONCURRENCY, async (site) => {
    const r = { site, ...(await checkSite(site, sites)) };
    console.log(`${ICON[r.level]} ${site.name} — ${site.website}${r.status ? ` (HTTP ${r.status})` : ""}${r.note ? `: ${r.note}` : ""}`);
    return r;
  });

  const report = buildReport(results);
  if (reportPath) writeFileSync(reportPath, report + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");

  const failing = results.filter((r) => r.level === "fail").length;
  console.log(`\n${failing ? "❌" : "✅"} ${failing} of ${results.length} sites failing.`);
  process.exitCode = failing ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`💥 check itself broke: ${err.message}`);
    process.exitCode = 2;
  });
}

export { parseWebringData, checkSite, formatUrl, fuzzyMatch };
