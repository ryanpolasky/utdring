// Offline tests for check-webring.mjs (`npm test`). fetch() is stubbed; each
// route is a member site in some state, paired with the level we expect.
process.env.WEBRING_RETRY_MS = "0";

import { checkSite, parseWebringData } from "./check-webring.mjs";
import { readFileSync } from "node:fs";

const widget = (frag) => `
<div><a href="https://ecs.utdring.com/#${frag}?nav=prev">←</a>
<a href="https://ecs.utdring.com/#${frag}"><img src="https://ecs.utdring.com/icon.black.svg"/></a>
<a href="https://ecs.utdring.com/#${frag}?nav=next">→</a></div>`;
const page = (body) => `<!doctype html><html><body><h1>hi</h1>${body}</body></html>`;
const spa = (src) => `<!doctype html><html><head><script src="${src}"></script></head><body><div id="root"></div></body></html>`;

const ROUTES = {
  "/good": { status: 200, body: page(widget("member.test/good")) },
  "/redirected": { status: 200, body: page(widget("member.test/redirected")), finalUrl: "https://www.member.test/redirected/" },
  "/missing": { status: 200, body: page("<footer>nothing here</footer>") },
  "/placeholder": { status: 200, body: page(widget("your-site-here")) },
  "/wrongfrag": { status: 200, body: page(widget("nobody.example")) },
  "/otherfrag": { status: 200, body: page(widget("member.test/good")) },
  "/nofrag": { status: 200, body: page(`<a href="https://ecs.utdring.com/">ring</a>`) },
  "/gone": { status: 404, body: "nope" },
  "/boom": { status: 500, body: "nope" },
  "/blocked": { status: 403, body: "nope" },
  "/dead": { throws: new TypeError("fetch failed") },
  "/timeout": { throws: Object.assign(new Error("aborted"), { name: "AbortError" }) },
  "/spa": { status: 200, body: spa("/spa.js") },
  "/spa.js": { status: 200, body: `var e="https://ecs.utdring.com/#member.test/spa?nav=prev";` },
  "/spa-dynamic": { status: 200, body: spa("/spa-dynamic.js") },
  "/spa-dynamic.js": { status: 200, body: "(0,P.jsx)(`a`,{href:`https://cs.utdring.com/#${e}?nav=prev`})" },
  "/spa-none": { status: 200, body: spa("/spa-none.js") },
  "/spa-none.js": { status: 200, body: "console.log(1)" },
};

globalThis.fetch = async (url) => {
  const route = ROUTES[new URL(url).pathname];
  if (!route) return { ok: false, status: 404, url, text: async () => "" };
  if (route.throws) throw route.throws;
  return { ok: route.status < 400, status: route.status, url: route.finalUrl ?? url, text: async () => route.body };
};

const EXPECT = {
  "/good": "ok",
  "/redirected": "ok",
  "/spa": "ok",
  "/spa-dynamic": "ok",
  "/blocked": "warn",
  "/nofrag": "warn",
  "/otherfrag": "warn",
  "/missing": "fail",
  "/placeholder": "fail",
  "/wrongfrag": "fail",
  "/gone": "fail",
  "/boom": "fail",
  "/dead": "fail",
  "/timeout": "fail",
  "/spa-none": "fail",
};

const sites = Object.keys(EXPECT).map((route) => ({ name: route, website: `https://member.test${route}`, year: "2024" }));
let failed = 0;
const check = (name, expected, actual) => {
  const ok = expected === actual;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: expected ${expected}, got ${actual}`);
};

for (const site of sites) {
  const r = await checkSite(site, sites);
  check(`site ${site.name}`, EXPECT[site.name], r.level);
}

const real = parseWebringData(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
check("parse index.html", true, real.length > 0 && real.every((s) => s.name && s.website));

if (failed) {
  console.error(`\n❌ ${failed} check(s) failed`);
  process.exit(1);
}
console.log("\n✅ all checks passed");
