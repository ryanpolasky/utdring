#!/usr/bin/env node
// Checks that every site in webringData is up and that its webring widget is
// present and pointing at the right entry. Advisory only — see README.
// Exit codes: 0 = fine (warnings allowed), 1 = real problems, 2 = check broke.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_HTML = path.join(ROOT, "index.html");
const RING_HOME = "https://ecs.utdring.com";
const RING_DOMAIN = "utdring.com";
const TIMEOUT_MS = 30_000;
const CONCURRENCY = 3;
// generous, and deliberately slow: a rate-limited or cold-starting host should
// get another chance rather than be reported as broken. Override for tests.
const retryDelays = () => (process.env.WEBRING_RETRY_MS ?? "3000,8000,15000").split(",").map(Number);
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36 utdring-health-check/1.0 " +
  "(+https://github.com/ryanpolasky/utdring)";

// statuses that mean "we couldn't see the page", not "the site is broken"
const UNVERIFIABLE = {
  401: "needs authentication",
  403: "blocked our request",
  429: "rate-limited us",
  503: "temporarily unavailable",
};

// keep in sync with javascript/helpers.js — the checker has to match the real
// navigation logic or it will disagree with the live site
const formatUrl = (url) =>
  url
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/$/, "")
    .replace(/^www\./, "");

const fuzzyMatch = (searchTerm, target) => {
  const searchTermFormatted = formatUrl(searchTerm);
  const targetFormatted = formatUrl(target);
  return (
    searchTermFormatted.includes(targetFormatted) ||
    targetFormatted.includes(searchTermFormatted)
  );
};

// --- parsing webringData out of index.html ---

// strip line and block comments, leaving string literals and newlines intact
function stripJsComments(src) {
  let out = "";
  let quote = null;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        out += c + (src[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// index of the `}` closing the object that opens at `start`
function findObjectEnd(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && src[i + 1] === "/") while (i < src.length && src[i] !== "\n") i++;
    else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseWebringData(html) {
  const declIdx = html.indexOf("const webringData");
  if (declIdx === -1) throw new Error("could not find `const webringData` in index.html");

  const openIdx = html.indexOf("{", declIdx);
  const closeIdx = openIdx === -1 ? -1 : findObjectEnd(html, openIdx);
  if (closeIdx === -1) throw new Error("could not find the end of the webringData object literal");

  const objectText = stripJsComments(html.slice(openIdx, closeIdx + 1))
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3') // quote bare keys
    .replace(/,(\s*[}\]])/g, "$1"); // drop trailing commas

  let data;
  try {
    data = JSON.parse(objectText);
  } catch (err) {
    throw new Error(
      `webringData is not parseable as JSON (${err.message}). ` +
        `Entries must use double-quoted keys and strings, per the README template.`
    );
  }
  if (!Array.isArray(data?.sites)) throw new Error("webringData.sites is not an array");

  return data.sites.map((site) => ({ ...site, line: lineOf(html, site.website) }));
}

function lineOf(html, needle) {
  if (typeof needle !== "string") return null;
  const idx = html.indexOf(needle);
  return idx === -1 ? null : html.slice(0, idx).split("\n").length;
}

// entries a PR added relative to `ref`, matched by URL
function sitesAddedSince(ref, sites) {
  let baseHtml;
  try {
    baseHtml = execFileSync("git", ["show", `${ref}:index.html`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    console.warn(`! could not read index.html at ${ref} (${err.message}) — checking every site`);
    return sites;
  }
  const before = new Set(parseWebringData(baseHtml).map((s) => formatUrl(String(s.website ?? ""))));
  return sites.filter((s) => !before.has(formatUrl(String(s.website ?? ""))));
}

// --- offline checks on webringData itself ---

function checkRingData(sites) {
  const problems = [];
  const add = (level, message, line = null) => problems.push({ level, message, line });

  sites.forEach((site, i) => {
    const where = site.line ? `line ${site.line}` : `entry ${i + 1}`;
    if (!site.name || typeof site.name !== "string") add("error", `${where}: missing "name"`, site.line);
    if (!site.website || typeof site.website !== "string") {
      add("error", `${where}: missing "website"`, site.line);
      return;
    }
    if (!/^https:\/\//i.test(site.website)) {
      add("error", `${site.name || where}: website must be an absolute https:// URL (got \`${site.website}\`)`, site.line);
    }
    const year = Number(site.year);
    if (!Number.isInteger(year) || year < 1969 || year > 2100) {
      add("warn", `${site.name || where}: "year" looks wrong (\`${site.year}\`)`, site.line);
    }
  });

  // navigateWebring() throws when a fragment matches more than one member, so
  // two entries that fuzzy-match each other break nav for both of them
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i];
      const b = sites[j];
      if (!a.website || !b.website || !fuzzyMatch(a.website, b.website)) continue;
      const same = formatUrl(a.website) === formatUrl(b.website);
      add(
        "error",
        same
          ? `duplicate entry: ${a.name} and ${b.name} both list \`${formatUrl(a.website)}\``
          : `ambiguous URLs: \`${formatUrl(a.website)}\` (${a.name}) and ` +
              `\`${formatUrl(b.website)}\` (${b.name}) fuzzy-match each other, ` +
              `so prev/next navigation throws for both`,
        a.line
      );
    }
  }

  return problems;
}

// --- fetching ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url) {
  const delays = retryDelays();
  let last = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      });
      last = {
        ok: res.ok,
        status: res.status,
        finalUrl: res.url || url,
        html: await res.text(),
        ms: Date.now() - startedAt,
        attempts: attempt + 1,
      };
      // a 404 won't fix itself; rate limits and 5xx might
      if (res.ok || (res.status < 500 && res.status !== 429)) return last;
    } catch (err) {
      last = {
        ok: false,
        status: null,
        finalUrl: url,
        html: "",
        ms: Date.now() - startedAt,
        attempts: attempt + 1,
        error: err.name === "AbortError" ? `no response within ${TIMEOUT_MS / 1000}s` : err.message,
      };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < delays.length) await sleep(delays[attempt]);
  }
  return last;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    })
  );
  return results;
}

// --- widget inspection ---

// pages that render client-side serve a shell we can't inspect for the widget
function looksClientRendered(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hasMountPoint = /<(?:div|main)[^>]+id=["'](?:root|app|__next|__nuxt|svelte)["']/i.test(html);
  return /<script/i.test(html) && text.length < 400 && (hasMountPoint || text.length < 120);
}

// ring URLs sitting in real markup attributes
function ringUrlsIn(html) {
  const attrRe = /(?:href|src|srcset|content|data-[\w-]+)\s*=\s*["']([^"']*utdring\.com[^"']*)["']/gi;
  return [...html.matchAll(attrRe)].map((m) => m[1]);
}

// ring URLs sitting in any quoted string — inline hydration payloads, JS bundles
function ringUrlsInText(text) {
  const strRe = /["'`]([^"'`\s\\]*utdring\.com[^"'`\s\\]*)["'`]/gi;
  return [...new Set([...text.matchAll(strRe)].map((m) => m[1]))];
}

// <a> tags pointing at the ring, so we can look at target=
function ringAnchorsIn(html) {
  const anchors = [];
  for (const m of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = m[1];
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (!href || !/utdring\.com/i.test(href)) continue;
    const target = /target\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/i.exec(attrs);
    anchors.push({ href, target: (target?.[1] ?? target?.[2] ?? "").trim() });
  }
  return anchors;
}

const MAX_BUNDLES = 8;
const MAX_BUNDLE_BYTES = 5_000_000;

// A React/Vue/Svelte app renders the widget at runtime, so it isn't in the HTML —
// but the JSX compiles down to string literals we can find in the JS bundle.
async function searchBundles(html, pageUrl) {
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return { urls: [], scanned: 0, from: null };
  }

  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => {
      try {
        return new URL(m[1], pageUrl).href;
      } catch {
        return null;
      }
    })
    .filter((u) => u && u.startsWith(origin) && /\.[mc]?js(\?|$)/i.test(u))
    .slice(0, MAX_BUNDLES);

  let budget = MAX_BUNDLE_BYTES;
  let scanned = 0;
  for (const src of srcs) {
    if (budget <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(src, { signal: controller.signal, headers: { "user-agent": UA } });
      if (!res.ok) continue;
      const text = await res.text();
      scanned++;
      budget -= text.length;
      if (!/utdring\.com/i.test(text)) continue;
      return { urls: ringUrlsInText(text), scanned, from: src, text };
    } catch {
      // best effort: a bundle we can't read just means we can't confirm from it
    } finally {
      clearTimeout(timer);
    }
  }
  return { urls: [], scanned, from: null };
}

// `ctx` is where the widget was found: page markup, or a JS bundle
function inspectWidget(site, sites, ctx) {
  const { urls, anchors = [], searchText, origin, from } = ctx;
  const problems = [];
  const add = (level, message) => problems.push({ level, message });

  if (origin === "bundle") {
    add(
      "info",
      `widget found in the JS bundle rather than the served HTML (\`${from}\`) — links checked, ` +
        `but new-tab behaviour can't be seen without a browser`
    );
  }

  const navTargets = { prev: null, next: null };
  let sawFragment = false;

  // the same mistake is usually copy-pasted across prev/icon/next, so findings
  // are grouped and reported once
  const perLink = new Map();
  const addLink = (level, kind, label, render) => {
    const existing = perLink.get(kind);
    if (existing) existing.labels.push(label);
    else perLink.set(kind, { level, labels: [label], render });
  };

  for (const raw of urls) {
    const url = raw.replace(/&amp;/gi, "&").trim();
    const hashIdx = url.indexOf("#");
    if (hashIdx === -1) continue; // bare homepage link or the hosted icon — fine

    sawFragment = true;
    const fragment = url.slice(hashIdx + 1);
    const [rawTarget, query] = fragment.split("?");
    const nav = navOf(url);

    let target;
    try {
      target = decodeURIComponent(rawTarget || "");
    } catch {
      target = rawTarget || "";
    }

    if (nav === "prev" || nav === "next") navTargets[nav] = url;
    const label = nav ? nav : "middle";

    if (!target) {
      addLink("error", `empty:${fragment}`, label, (links, many) =>
        `${links} ${many ? "have" : "has"} no site in the \`#\` fragment, ` +
          `so navigation matches every member and throws`
      );
      continue;
    }
    if (/your-site-here/i.test(target)) {
      addLink("error", `placeholder:${target}`, label, (links) =>
        `the \`your-site-here\` placeholder is still in ${links} — replace it with \`${formatUrl(site.website)}\``
      );
      continue;
    }

    const matches = sites.filter((s) => s.website && fuzzyMatch(target, s.website));
    if (matches.length === 0) {
      addLink("error", `nomatch:${target}`, label, (links, many) =>
        `${links} point${many ? "" : "s"} at \`#${target}\`, which matches no ring member, ` +
          `so prev/next silently does nothing (it should be \`${formatUrl(site.website)}\`)`
      );
    } else if (matches.length > 1) {
      addLink("error", `ambiguous:${target}`, label, (links, many) =>
        `${links} point${many ? "" : "s"} at \`#${target}\`, which matches ${matches.length} members ` +
          `(${matches.map((s) => formatUrl(s.website)).join(", ")}) — navigation throws on ambiguous fragments`
      );
    } else if (formatUrl(matches[0].website) !== formatUrl(site.website)) {
      addLink("warn", `wrongsite:${target}`, label, (links, many) =>
        `${links} point${many ? "" : "s"} at \`#${target}\`, which is ${matches[0].name}'s entry ` +
          `rather than this site's — prev/next will navigate from the wrong position in the ring`
      );
    }
  }

  // A ring is meant to be travelled in one tab: opening prev/next in a new one
  // strands the visitor on the old site. The middle link is the member's call.
  const newTab = anchors.filter((a) => opensNewTab(a.target));
  const navNewTab = newTab.filter((a) => ["prev", "next"].includes(navOf(a.href)));
  const otherNewTab = newTab.filter((a) => !["prev", "next"].includes(navOf(a.href)));
  if (navNewTab.length) {
    const which = [...new Set(navNewTab.map((a) => navOf(a.href)))];
    const attr = navNewTab[0].target;
    add(
      "error",
      `the ${which.join(" and ")} link${which.length > 1 ? "s" : ""} open in a new tab ` +
        `(\`target="${attr}"\`) — drop the target so visitors travel the ring in one tab`
    );
  }
  if (otherNewTab.length) {
    add("warn", `the webring icon link opens in a new tab (\`target="${otherNewTab[0].target}"\`) — your call, but same-tab is the norm`);
  }

  for (const { level, labels, render } of perLink.values()) {
    const unique = [...new Set(labels)];
    const list =
      unique.length === 1
        ? `the ${unique[0]} link`
        : `the ${unique.slice(0, -1).join(", ")} and ${unique.at(-1)} links`;
    add(level, render(list, unique.length > 1));
  }

  if (!sawFragment) {
    add("warn", `links to ${RING_DOMAIN} but none carry a \`#site\` fragment, so prev/next navigation can't work`);
  } else {
    if (!navTargets.prev) add("warn", "no `?nav=prev` link found (previous-site arrow missing)");
    if (!navTargets.next) add("warn", "no `?nav=next` link found (next-site arrow missing)");
  }

  if (!/icon\.(black|white|red)\.svg/i.test(searchText)) {
    add("warn", "webring icon not detected — fine if you self-host or restyled it");
  }

  return { problems, urls, present: true };
}

// nav value of a ring URL: "prev", "next" or "" for the middle/icon link
function navOf(url) {
  const hashIdx = url.indexOf("#");
  if (hashIdx === -1) return "";
  const query = url.slice(hashIdx + 1).split("?")[1];
  return (new URLSearchParams(query || "").get("nav") || "").replace(/\/+$/, "").trim();
}

// anything but an empty/same-document target lands the visitor in another tab
const opensNewTab = (t) => Boolean(t) && !/^_(self|parent|top)$/i.test(t);

// --- per-site check ---

async function checkSite(site, sites) {
  const result = { site, problems: [], status: null, ms: null, finalUrl: null };
  const add = (level, message) => result.problems.push({ level, message });

  if (!site.website || !/^https?:\/\//i.test(site.website)) {
    add("error", "no usable URL to check");
    return result;
  }

  const res = await fetchPage(site.website);
  result.status = res.status;
  result.ms = res.ms;
  result.finalUrl = res.finalUrl;
  result.attempts = res.attempts;

  if (res.error) {
    add("error", `unreachable after ${res.attempts} attempts: ${res.error}`);
    return result;
  }
  if (!res.ok) {
    if (UNVERIFIABLE[res.status]) {
      add("warn", `returned ${res.status} — ${UNVERIFIABLE[res.status]}, so we couldn't check the widget from CI`);
    } else {
      add("error", `returned HTTP ${res.status}`);
    }
    return result;
  }

  if (formatUrl(site.website) !== formatUrl(res.finalUrl)) {
    add("warn", `redirects to \`${formatUrl(res.finalUrl)}\` — the entry could be updated to match`);
  }
  if (res.ms > 10_000) add("warn", `slow response (${(res.ms / 1000).toFixed(1)}s)`);

  const html = res.html;
  const anchors = ringAnchorsIn(html);
  let urls = ringUrlsIn(html);
  let origin = "page";
  let searchText = html;
  let from = null;

  // fall back to hydration payloads, then to the JS bundles themselves
  if (urls.length === 0) urls = ringUrlsInText(html);
  if (urls.length === 0) {
    const bundle = await searchBundles(html, res.finalUrl);
    if (bundle.urls.length) {
      ({ urls, from } = bundle);
      origin = "bundle";
      searchText = bundle.text;
    } else {
      if (/utdring\.com/i.test(html)) {
        add("warn", `page mentions ${RING_DOMAIN} but we couldn't find a usable webring link — worth an eyeball`);
      } else if (looksClientRendered(html) || bundle.scanned > 0) {
        add(
          "warn",
          "couldn't find the webring widget in the served HTML" +
            (bundle.scanned ? ` or in ${bundle.scanned} JS bundle${bundle.scanned > 1 ? "s" : ""}` : "") +
            " — expected if the widget is added at runtime (React and friends), so this is flagged for a human " +
            "rather than failed. Disregard if it renders fine on the live site."
        );
      } else {
        add("error", "webring widget not found in the page (no reference to utdring.com)");
      }
      result.widgetPresent = false;
      return result;
    }
  }

  const widget = inspectWidget(site, sites, { urls, anchors, searchText, origin, from });
  result.problems.push(...widget.problems);
  result.widgetPresent = true;

  return result;
}

// --- reporting ---

// GitHub workflow annotations, so findings show up inline on the PR diff at the
// contributor's own line in index.html
function annotate(level, message, line) {
  const kind = level === "error" ? "error" : level === "info" ? "notice" : "warning";
  const esc = (t) => String(t).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const where = line ? `file=index.html,line=${line},` : "file=index.html,";
  console.log(`::${kind} ${where}title=Webring health check::${esc(message)}`);
}

const worst = (problems) =>
  problems.some((p) => p.level === "error") ? "error" : problems.some((p) => p.level === "warn") ? "warn" : "ok";

const ICON = { ok: "✅", info: "ℹ️", warn: "⚠️", error: "❌" };

function buildReport({ results, dataProblems, ringHome, scope }) {
  const lines = [];
  const errored = results.filter((r) => worst(r.problems) === "error");
  const warned = results.filter((r) => worst(r.problems) === "warn");
  const healthy = results.length - errored.length - warned.length;

  lines.push("## Webring health check", "");
  lines.push(
    `${results.length} site${results.length === 1 ? "" : "s"} checked${scope}: ` +
      `**${healthy} healthy**, **${warned.length} with warnings**, **${errored.length} failing**.`,
    ""
  );

  if (ringHome && worst(ringHome.problems) !== "ok") {
    lines.push(
      `> ${ICON[worst(ringHome.problems)]} The webring itself (${RING_HOME}): ` +
        ringHome.problems.map((p) => p.message).join("; "),
      ""
    );
  }

  if (dataProblems.length) {
    lines.push("### `webringData` in index.html", "");
    for (const p of dataProblems) lines.push(`- ${ICON[p.level]} ${p.message}`);
    lines.push("");
  }

  lines.push("### Sites", "");
  lines.push("| | Site | URL | HTTP | Time |", "| :-: | --- | --- | :-: | --: |");
  for (const r of results) {
    const level = worst(r.problems);
    const ms = r.ms == null || r.status == null ? "—" : `${(r.ms / 1000).toFixed(1)}s`;
    lines.push(
      `| ${ICON[level]} | ${r.site.name ?? "?"} | ` +
        `[${formatUrl(r.site.website ?? "")}](${r.site.website ?? ""}) | ${r.status ?? "—"} | ${ms} |`
    );
  }
  lines.push("");

  const noted = results.filter(
    (r) => worst(r.problems) === "ok" && r.problems.some((p) => p.level === "info")
  );
  const detailed = [...errored, ...warned, ...noted];
  if (detailed.length) {
    lines.push("### Details", "");
    for (const r of detailed) {
      lines.push(`**${ICON[worst(r.problems)]} ${r.site.name ?? "?"} — ${r.site.website}**`);
      for (const p of r.problems) lines.push(`- ${ICON[p.level]} ${p.message}`);
      lines.push("");
    }
    lines.push(
      "ℹ️ and ⚠️ are informational and never fail the check. ❌ means the site didn't respond or its webring links " +
        "don't work. Widget template: [README](https://github.com/ryanpolasky/utdring#widget-template).",
      "",
      "<sub>Sites that render entirely client-side, rate-limit us, or block CI can't be inspected from here, " +
        "so those are warnings rather than failures. Every request is retried a few times before it counts.</sub>"
    );
  }

  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const argOf = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const baseRef = argOf("--base-ref");
  const reportPath = argOf("--report");
  const annotating = argv.includes("--annotate");

  const html = readFileSync(INDEX_HTML, "utf8");
  const allSites = parseWebringData(html);
  console.log(`Parsed ${allSites.length} site${allSites.length === 1 ? "" : "s"} from index.html`);

  const dataProblems = checkRingData(allSites);
  for (const p of dataProblems) console.log(`${ICON[p.level]} webringData: ${p.message}`);

  let sites = allSites;
  let scope = "";
  if (baseRef) {
    sites = sitesAddedSince(baseRef, allSites);
    scope = ` (new since \`${baseRef}\`)`;
    if (sites.length === 0) console.log(`No sites added since ${baseRef} — nothing to check.`);
    else console.log(`Checking ${sites.length} newly added site(s): ${sites.map((s) => s.name).join(", ")}`);
  }

  const [ringHome, results] = await Promise.all([
    (async () => {
      const res = await fetchPage(RING_HOME);
      const problems = [];
      if (res.error) problems.push({ level: "error", message: `unreachable: ${res.error}` });
      else if (!res.ok && !UNVERIFIABLE[res.status]) {
        problems.push({ level: "error", message: `returned HTTP ${res.status}` });
      }
      return { problems, status: res.status };
    })(),
    mapWithConcurrency(sites, CONCURRENCY, async (site) => {
      const r = await checkSite(site, allSites);
      const level = worst(r.problems);
      console.log(
        `${ICON[level]} ${site.name} — ${site.website}` +
          (r.status ? ` (HTTP ${r.status}, ${(r.ms / 1000).toFixed(1)}s)` : "")
      );
      for (const p of r.problems) console.log(`     ${ICON[p.level]} ${p.message}`);
      return r;
    }),
  ]);

  if (annotating) {
    for (const p of dataProblems) annotate(p.level, p.message, p.line);
    for (const r of results) {
      for (const p of r.problems) annotate(p.level, `${r.site.name}: ${p.message}`, r.site.line);
    }
  }

  const report = buildReport({ results, dataProblems, ringHome, scope });
  if (reportPath) writeFileSync(reportPath, report + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");

  const failing = results.filter((r) => worst(r.problems) === "error").length;
  const failures =
    failing +
    dataProblems.filter((p) => p.level === "error").length +
    ringHome.problems.filter((p) => p.level === "error").length;

  console.log(
    `\n${failures ? "❌" : "✅"} ${results.length} site(s) checked — ${failing} failing, ` +
      `${results.filter((r) => worst(r.problems) === "warn").length} with warnings.`
  );

  process.exitCode = failures ? 1 : 0;
}

// only run when invoked directly, so the tests can import the helpers above
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`💥 health check itself failed: ${err.message}`);
    if (process.env.RUNNER_DEBUG) console.error(err.stack);
    process.exitCode = 2;
  });
}

export { formatUrl, fuzzyMatch, parseWebringData, checkRingData, inspectWidget, checkSite, looksClientRendered };
