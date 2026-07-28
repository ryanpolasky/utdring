// Fixture tests for check-webring.mjs — `npm test`. fetch() is stubbed, so this
// runs offline. Each route below is a mistake the check should catch (or
// deliberately not flag), paired with its expected severity. VERBOSE=1 for detail.
process.env.WEBRING_RETRY_MS = "0,0,0";

import { checkSite, checkRingData, parseWebringData, looksClientRendered } from "./check-webring.mjs";
import { readFileSync } from "node:fs";

const BASE = "https://member.test";
const frag = (route) => `member.test${route}`;

const tgt = (t) => (t === null ? "" : ` target="${t}"`);
const widget = (target, { prev = true, next = true, icon = true, navTarget = null, midTarget = null } = {}) => `
<div style="display:flex;align-items:center;gap:8px">
  ${prev ? `<a href="https://ecs.utdring.com/#${target}?nav=prev"${tgt(navTarget)}>&larr;</a>` : ""}
  <a href="https://ecs.utdring.com/#${target}"${tgt(midTarget)}>
    ${icon ? `<img src="https://ecs.utdring.com/icon.black.svg" alt="ECS Webring"/>` : "webring"}
  </a>
  ${next ? `<a href="https://ecs.utdring.com/#${target}?nav=next"${tgt(navTarget)}>&rarr;</a>` : ""}
</div>`;

// what a bundler emits for the JSX version of the widget
const bundled = (target) =>
  `(()=>{var e="https://ecs.utdring.com/#${target}?nav=prev",t="https://ecs.utdring.com/#${target}",` +
  `n="https://ecs.utdring.com/#${target}?nav=next",r="https://ecs.utdring.com/icon.black.svg";})();`;

const SHELL_WITH = (src) =>
  `<!doctype html><html><head><script src="${src}"></script></head><body><div id="root"></div></body></html>`;

const page = (body) =>
  `<!doctype html><html><head><title>t</title></head><body><h1>My portfolio</h1>
   <p>${"Lots of real server-rendered prose here. ".repeat(20)}</p>${body}</body></html>`;

const SPA_SHELL = `<!doctype html><html><head><script src="/b.js"></script></head><body><div id="root"></div></body></html>`;

// route -> {status, body, finalUrl, throws}
const ROUTES = {
  "/good": { status: 200, body: page(widget(frag("/good"))) },
  "/missing": { status: 200, body: page("<footer>no webring here</footer>") },
  "/spa": { status: 200, body: SPA_SHELL },
  "/placeholder": { status: 200, body: page(widget("your-site-here")) },
  "/wrongfrag": { status: 200, body: page(widget("totally-unrelated.example")) },
  "/emptyfrag": { status: 200, body: page(widget("")) },
  "/nonav": { status: 200, body: page(widget(frag("/nonav"), { prev: false, next: false })) },
  "/noicon": { status: 200, body: page(widget(frag("/noicon"), { icon: false })) },
  "/otherfrag": { status: 200, body: page(widget(frag("/good"))) },
  "/jsx-nav-slash": { status: 200, body: page(page(widget(frag("/jsx-nav-slash")).replace(/nav=next/, "nav=next/"))) },
  "/mentions-only": { status: 200, body: page("<p>I am in the ecs.utdring.com webring</p>") },
  "/homelink-only": { status: 200, body: page(`<a href="https://ecs.utdring.com/">webring</a>`) },
  "/gone": { status: 404, body: "<h1>Not Found</h1>" },
  "/boom": { status: 500, body: "server error" },
  "/redirected": { status: 200, body: page(widget(frag("/good"))), finalUrl: "https://elsewhere.test/" },
  "/dead": { throws: new TypeError("fetch failed") },
  "/timeout": { throws: Object.assign(new Error("aborted"), { name: "AbortError" }) },
  // target= handling: the ring should be travelled in one tab
  "/newtab-nav": { status: 200, body: page(widget(frag("/newtab-nav"), { navTarget: "_blank" })) },
  "/newtab-icon": { status: 200, body: page(widget(frag("/newtab-icon"), { midTarget: "_blank" })) },
  "/newtab-named": { status: 200, body: page(widget(frag("/newtab-named"), { navTarget: "ring" })) },
  "/target-empty": { status: 200, body: page(widget(frag("/target-empty"), { midTarget: "" })) }, // README template
  "/target-self": { status: 200, body: page(widget(frag("/target-self"), { navTarget: "_self" })) },
  // client-rendered apps: widget lives in the bundle, not the HTML
  "/react-good": { status: 200, body: SHELL_WITH("/assets/good.js") },
  "/assets/good.js": { status: 200, body: bundled("member.test/react-good") },
  "/react-broken": { status: 200, body: SHELL_WITH("/assets/broken.js") },
  "/assets/broken.js": { status: 200, body: bundled("your-site-here") },
  "/react-nowidget": { status: 200, body: SHELL_WITH("/assets/none.js") },
  "/assets/none.js": { status: 200, body: "(()=>{console.log('no ring here')})();" },
  "/react-crossorigin": { status: 200, body: SHELL_WITH("https://cdn.example.com/app.js") },
  "/forbidden": { status: 403, body: "Forbidden" },
  "/ratelimited": { status: 429, body: "Too Many Requests" },
  "/unavailable": { status: 503, body: "Service Unavailable" },
};

let fetchCount = 0;
globalThis.fetch = async (url) => {
  fetchCount++;
  const route = new URL(url).pathname;
  const r = ROUTES[route] ?? { status: 404, body: "nope" };
  if (r.throws) throw r.throws;
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    url: r.finalUrl ?? url,
    text: async () => r.body,
  };
};

const sites = Object.keys(ROUTES)
  .filter((route) => !route.startsWith("/assets/"))
  .map((route) => ({ name: route.slice(1), year: 2027, website: `${BASE}${route}` }));

const level = (problems) =>
  problems.some((p) => p.level === "error") ? "error" : problems.some((p) => p.level === "warn") ? "warn" : "ok";

let failures = 0;
const expect = (name, actual, wanted, problems = []) => {
  const pass = actual === wanted;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  if (!pass || process.env.VERBOSE) for (const p of problems) console.log(`       [${p.level}] ${p.message}`);
};

const EXPECTED = {
  "/good": "ok",
  "/missing": "error",
  "/spa": "warn",
  "/placeholder": "error",
  "/wrongfrag": "error",
  "/emptyfrag": "error",
  "/nonav": "warn",
  "/noicon": "warn",
  "/otherfrag": "warn",
  "/jsx-nav-slash": "ok",
  "/mentions-only": "warn",
  "/homelink-only": "warn",
  "/gone": "error",
  "/boom": "error",
  "/redirected": "warn",
  "/dead": "error",
  "/timeout": "error",
  "/newtab-nav": "error",
  "/newtab-icon": "warn",
  "/newtab-named": "error",
  "/target-empty": "ok",
  "/target-self": "ok",
  "/react-good": "ok",
  "/react-broken": "error",
  "/react-nowidget": "warn",
  "/react-crossorigin": "warn",
  "/forbidden": "warn",
  "/ratelimited": "warn",
  "/unavailable": "warn",
};

for (const site of sites) {
  const route = new URL(site.website).pathname;
  const r = await checkSite(site, sites);
  expect(`site ${route}`, level(r.problems), EXPECTED[route], r.problems);
}

// the specifics behind those severities
const msgs = async (route) => (await checkSite(sites.find((s) => s.website.endsWith(route)), sites)).problems;
const has = (problems, re) => problems.some((p) => re.test(p.message));

expect("new tab: names prev and next", has(await msgs("/newtab-nav"), /prev and next links open in a new tab/), true);
expect("new tab: quotes a named target", has(await msgs("/newtab-named"), /target="ring"/), true);
expect("new tab: icon link is only a warning",
  (await msgs("/newtab-icon")).find((p) => /new tab/.test(p.message))?.level, "warn");
expect("react: found in bundle is a notice, not a warning",
  (await msgs("/react-good")).every((p) => p.level === "info"), true);
expect("react: says where it looked", has(await msgs("/react-good"), /JS bundle rather than the served HTML/), true);
expect("react: broken links in a bundle still fail", has(await msgs("/react-broken"), /your-site-here/), true);
expect("react: unverifiable says disregard-if-fine",
  has(await msgs("/react-nowidget"), /React and friends.*Disregard/s), true);
expect("react: reports how many bundles it read", has(await msgs("/react-nowidget"), /1 JS bundle/), true);
expect("react: cross-origin bundles aren't fetched", has(await msgs("/react-crossorigin"), /couldn't find the webring widget/), true);

// retry behaviour: transient 500 and network errors should be retried, 404 should not
fetchCount = 0;
await checkSite({ name: "gone", year: 2027, website: `${BASE}/gone` }, sites);
expect("no retry on 404", fetchCount, 1);
fetchCount = 0;
await checkSite({ name: "boom", year: 2027, website: `${BASE}/boom` }, sites);
expect("retries on 500", fetchCount, 4);

// --- offline data checks -----------------------------------------------------
const dataCases = [
  ["ambiguous fuzzy match", [{ name: "A", year: 2027, website: "https://example.com" }, { name: "B", year: 2027, website: "https://sub.example.com" }], "error"],
  ["duplicate url", [{ name: "A", year: 2027, website: "https://example.com" }, { name: "B", year: 2027, website: "https://www.example.com/" }], "error"],
  ["http not https", [{ name: "A", year: 2027, website: "http://example.com" }], "error"],
  ["missing website", [{ name: "A", year: 2027 }], "error"],
  ["missing name", [{ year: 2027, website: "https://example.com" }], "error"],
  ["bad year", [{ name: "A", year: "senior", website: "https://example.com" }], "warn"],
  ["clean", [{ name: "A", year: 2027, website: "https://example.com" }, { name: "B", year: 2028, website: "https://other.org" }], "ok"],
];
for (const [name, input, wanted] of dataCases) {
  const problems = checkRingData(input);
  expect(`data: ${name}`, level(problems), wanted, problems);
}

// --- parser ------------------------------------------------------------------
const parsed = parseWebringData(`
  <script src="//unpkg.com/alpinejs" defer></script>
  <script>
    const webringData = {
      "sites": [
        { "name": "A", "year": 2026, "website": "https://a.com" },
        // { "name": "Commented", "year": 2027, "website": "https://nope.com"},
        { "name": "B", "year": 2027, "website":"https://b.com"},
        { name: "C", year: 2028, website: "https://c.com" },
        /* block comment { "name": "D" } */
        // ↑ ADD YOUR SITE ABOVE ↑
      ]
    };
  </script>`);
expect("parser: entry count", parsed.length, 3);
expect("parser: skips commented", parsed.some((s) => s.name === "Commented"), false);
expect("parser: bare keys", parsed[2]?.name, "C");
expect("parser: no-space value", parsed[1]?.website, "https://b.com");
expect("parser: keeps // in urls", parsed[0]?.website, "https://a.com");

// The real index.html: assertions stay generic so adding a member never breaks them.
const realHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const realLines = realHtml.split("\n");
const realParsed = parseWebringData(realHtml);
expect("real index.html: found sites", realParsed.length > 5, true);
expect("real index.html: every entry is complete",
  realParsed.every((s) => s.name && s.website && s.year && typeof s.line === "number"), true);
expect("real index.html: no commented-out entry was parsed",
  realParsed.every((s) => !realLines[s.line - 1].trim().startsWith("//")), true);
expect("real index.html: webringData passes the offline checks",
  level(checkRingData(realParsed)), "ok", checkRingData(realParsed));

for (const [name, src] of [["no webringData", "<html></html>"], ["truncated", 'const webringData = { "sites": ['], ["single quotes", "const webringData = { 'sites': [{ name: 'A' }] };"]]) {
  let threw = false;
  try { parseWebringData(src); } catch { threw = true; }
  expect(`parser: throws on ${name}`, threw, true);
}

expect("spa detector: server-rendered", looksClientRendered(page(widget("x"))), false);
expect("spa detector: shell", looksClientRendered(SPA_SHELL), true);

console.log(`\n${failures === 0 ? "✅ all fixture checks passed" : `❌ ${failures} fixture check(s) failed`}`);
process.exitCode = failures ? 1 : 0;
