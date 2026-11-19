import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Issue, Report } from "../types.js";
import { aggregateIssues, issueCounts } from "../issues.js";
import { cellName } from "../findings.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const issuesOf = (r: Report): Issue[] => r.issues ?? aggregateIssues(r.findings);
const isActive = (i: { status?: string }) => i.status !== "accepted" && i.status !== "suppressed";

function headline(r: Report, issues: Issue[]): string {
  const s = r.summary;
  const c = s.issues !== undefined ? { issues: s.issues, issuesBySeverity: s.issuesBySeverity! } : issueCounts(issues);
  const sev = c.issuesBySeverity;
  const parts = [
    `**${c.issues} issues** to look at (${s.total} findings)`,
    `high ${sev.high}`,
    `medium ${sev.medium}`,
    `low ${sev.low}`,
    `new ${s.new}`,
    `fixed ${s.fixed}`,
  ];
  if (s.accepted) parts.push(`accepted ${s.accepted}`);
  if (s.suppressed) parts.push(`suppressed ${s.suppressed}`);
  return parts.join(" · ");
}

export function renderMarkdown(r: Report): string {
  const issues = issuesOf(r);
  const lines = [
    `# Design drift report · ${r.meta.repo.split("/").pop()}`,
    "",
    `Run ${r.meta.id} at ${r.meta.at}${r.meta.commit ? ` on commit ${r.meta.commit.slice(0, 9)}` : ""}. Checks: ${r.meta.checks.join(", ")}.`,
    "",
    headline(r, issues),
    "",
  ];
  if (r.notes.length) lines.push("## Notes", "", ...r.notes.map((n) => `- ${n}`), "");
  const byIssue = new Map(issues.map((i) => [i.id, i]));
  const byId = new Map(r.findings.map((f) => [f.id, f]));
  lines.push("## Groups", "", "| Severity | Group | Issues |", "| --- | --- | --- |");
  for (const g of r.groups) {
    const sev = (g.issueIds?.length ? byIssue.get(g.issueIds[0]!)?.severity : undefined) ?? byId.get(g.findingIds[0]!)?.severity ?? "";
    lines.push(`| ${sev} | ${g.title.replace(/\|/g, "\\|")} | ${g.issueIds?.length ?? g.findingIds.length} |`);
  }
  const owners = r.meta.owners ?? { A: "Design system team", B: "Product team" };
  const gapTitle = { A: `For ${owners.A} · gap A: Figma ↔ design-system code`, B: `For ${owners.B} · gap B: design system ↔ product` } as const;
  const ordered = [...issues.filter((x) => x.gap === "A"), ...issues.filter((x) => x.gap !== "A")];
  let currentGap: string | undefined;
  lines.push("");
  for (const i of ordered.filter((x) => x.severity !== "low" && isActive(x))) {
    const g = i.gap === "A" ? "A" : "B";
    if (g !== currentGap) {
      currentGap = g;
      lines.push(`## ${gapTitle[g]}`, "");
    }
    lines.push(`### ${i.severity.toUpperCase()} · ${i.title}`, "");
    if (i.seenText) lines.push(`- Seen: ${i.seenText}${i.findingIds.length > 1 ? ` (${i.findingIds.length} findings)` : ""}`);
    if (i.expected) lines.push(`- Expected: \`${i.expected.value}\` (${i.expected.source}${i.expected.token ? `, ${i.expected.token}` : ""})`);
    if (i.actual) lines.push(`- Actual: \`${i.actual.value}\` (${i.actual.source})`);
    if (i.related?.length) lines.push(`- Already patched by: ${i.related.join(", ")}`);
    if (i.links.figma) lines.push(`- Figma: ${i.links.figma}`);
    if (i.links.source) lines.push(`- Source: ${i.links.source}`);
    if (i.links.commit) lines.push(`- Commit: ${i.links.commit}`);
    if (i.evidence?.crop) lines.push(`- Crop: ${i.evidence.crop}`);
    lines.push(`- Status: ${i.status} · ${i.check} · gap ${i.gap} · ${i.id}`, "");
  }
  const low = issues.filter((x) => x.severity === "low" && isActive(x)).length;
  if (low) lines.push(`${low} low-severity issues are listed in report.html and findings.json.`, "");
  const quiet = issues.filter((x) => !isActive(x));
  if (quiet.length) {
    const reasons = new Map<string, number>();
    for (const i of quiet) {
      const k = i.status === "suppressed" ? `suppressed: ${i.suppressed?.reason ?? "?"}` : `accepted${i.accepted?.reason ? `: ${i.accepted.reason}` : ""}`;
      reasons.set(k, (reasons.get(k) ?? 0) + 1);
    }
    lines.push("## Accepted and suppressed", "", ...[...reasons.entries()].map(([k, n]) => `- ${n} × ${k}`), "");
  }
  if (r.fixed.length) lines.push("## Fixed since the previous run", "", ...r.fixed.map((f) => `- ${f.title}`), "");
  return lines.join("\n");
}

function swatch(color: string) {
  return `<span class="sw" style="background:${esc(color)}" title="${esc(color)}"></span><code>${esc(color)}</code>`;
}

function swatchIfColor(v: string) {
  return /^#[0-9a-f]{3,8}$/i.test(v) ? swatch(v) : `<code>${esc(v)}</code>`;
}

function occurrence(f: Finding): string {
  const where = f.cell ? cellName(f.cell) : (f.links.source ?? f.context ?? "");
  const shot = f.evidence?.screenshot ? ` · <a href="${esc(f.evidence.screenshot)}">screenshot</a>` : "";
  const diff = f.evidence?.diff ? ` · <a href="${esc(f.evidence.diff)}">pixel diff</a>` : "";
  return `<li><code>${esc(where)}</code> ${esc(f.title)}${f.status ? ` <span class="src">(${esc(f.status)})</span>` : ""}${shot}${diff}</li>`;
}

function issueRow(i: Issue, members: Finding[]): string {
  const exp = i.expected ? `${swatchIfColor(i.expected.value)}<div class="src">${esc(i.expected.source)}${i.expected.token ? ` · ${esc(i.expected.token)}` : ""}</div>` : "";
  const act = i.actual ? `${swatchIfColor(i.actual.value)}<div class="src">${esc(i.actual.source)}</div>` : "";
  const links = [
    i.links.figma ? `<a href="${esc(i.links.figma)}">Figma</a>` : "",
    i.links.source ? `<code>${esc(i.links.source)}</code>` : "",
    i.links.commit ? `<code>${esc(i.links.commit.slice(0, 9))}</code>` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const imgs = [
    i.evidence?.crop ? `<figure><a href="${esc(i.evidence.crop)}"><img src="${esc(i.evidence.crop)}" alt="product" loading="lazy"></a><figcaption>product</figcaption></figure>` : "",
    i.evidence?.figmaImage ? `<figure><a href="${esc(i.evidence.figmaImage)}"><img src="${esc(i.evidence.figmaImage)}" alt="Figma" loading="lazy"></a><figcaption>Figma</figcaption></figure>` : "",
  ].join("");
  const why =
    i.status === "suppressed"
      ? `<div class="src">Suppressed (${esc(i.suppressed?.source)}): ${esc(i.suppressed?.reason)}${i.suppressed?.until ? ` until ${esc(i.suppressed.until)}` : ""}</div>`
      : i.status === "accepted"
        ? `<div class="src">Accepted ${esc(i.accepted?.at?.slice(0, 10))}${i.accepted?.reason ? `: ${esc(i.accepted.reason)}` : ""}</div>`
        : "";
  const related = i.related?.length ? `<div class="src">Related: ${i.related.map(esc).join(", ")}</div>` : "";
  const occ =
    members.length > 1 || members[0]?.cell
      ? `<details><summary>${esc(i.seenText || `${members.length} occurrences`)}${members.length > 1 ? ` · ${members.length} findings` : ""}</summary><ul>${members.map(occurrence).join("")}</ul></details>`
      : "";
  return `<tr data-check="${i.check}" data-sev="${i.severity}" data-status="${i.status}" data-gap="${i.gap === "A" ? "A" : "B"}"><td><span class="sev ${i.severity}">${i.severity}</span><div class="src">${i.check} · gap ${i.gap}</div><span class="st ${i.status}">${i.status}</span></td><td>${esc(i.title)}${related}${why}${occ}<div class="src">${links}</div></td><td>${exp}</td><td>${act}</td><td class="ev">${imgs}</td></tr>`;
}

export function renderHtml(r: Report): string {
  const s = r.summary;
  const issues = issuesOf(r);
  const counts = s.issues !== undefined ? { issues: s.issues, issuesBySeverity: s.issuesBySeverity! } : issueCounts(issues);
  const byId = new Map(r.findings.map((f) => [f.id, f]));
  const rows = issues.map((i) => issueRow(i, i.findingIds.map((id) => byId.get(id)).filter((f): f is Finding => Boolean(f)))).join("\n");
  const checks = [...new Set(issues.map((i) => i.check))].sort();
  const quiet = issues.filter((i) => !isActive(i)).length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Design drift report</title>
<style>
:root{--bg:#f1f2f3;--surface:#fff;--fg:#171a1c;--muted:#5f676f;--line:#dadee2;--accent:#1877d7;--high:#b8302e;--medium:#9a5c00;--low:#1d7f46}
@media (prefers-color-scheme:dark){:root{--bg:#000;--surface:#171a1c;--fg:#dee0e3;--muted:#8b949d;--line:#2e3337;--accent:#599de2;--high:#f07470;--medium:#e2a640;--low:#4cc27f;color-scheme:dark}}
body{margin:0;padding:32px max(16px,env(safe-area-inset-left));background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:26px;margin:0 0 6px}.meta,.src{color:var(--muted);font-size:12.5px}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.stats span{background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:3px 12px}
.filters{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:0 0 16px}.filters label{font-size:12.5px;color:var(--muted);display:flex;gap:6px;align-items:center}
select,input{font:inherit;background:var(--surface);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 8px}
.wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:980px}th,td{text-align:left;vertical-align:top;padding:9px 12px;border-bottom:1px solid var(--line)}
th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
code{font:12px ui-monospace,Menlo,monospace}.sw{display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid var(--line);vertical-align:-2px;margin-right:6px}
.sev,.st{font:11px ui-monospace,Menlo,monospace;border:1px solid currentColor;border-radius:999px;padding:0 7px}.sev.high{color:var(--high)}.sev.medium{color:var(--medium)}.sev.low{color:var(--low)}
.st{display:inline-block;margin-top:4px;color:var(--muted)}.st.new{color:var(--accent)}
.ev{display:flex;gap:8px;flex-wrap:wrap}.ev figure{margin:0}.ev img{display:block;max-width:220px;max-height:160px;border:1px solid var(--line);border-radius:4px;background:var(--bg)}.ev figcaption{font-size:11px;color:var(--muted)}
details summary{cursor:pointer;color:var(--muted);font-size:12.5px;margin-top:4px}details ul{margin:4px 0;font-size:12.5px}
a{color:var(--accent)}ul{padding-left:18px}tr[hidden]{display:none}
</style></head><body>
<h1>Design drift report</h1>
<div class="meta">${esc(r.meta.repo)} · ${esc(r.meta.commit?.slice(0, 9) ?? "no commit")} · ${esc(r.meta.at)} · checks ${esc(r.meta.checks.join(", "))}${r.meta.browser ? ` · ${esc(r.meta.browser)}` : ""}</div>
<div class="stats"><span><b>${counts.issues} issues</b> from ${s.total} findings</span><span>high ${counts.issuesBySeverity.high}</span><span>medium ${counts.issuesBySeverity.medium}</span><span>low ${counts.issuesBySeverity.low}</span><span>new ${s.new}</span><span>fixed ${s.fixed}</span>${s.accepted ? `<span>accepted ${s.accepted}</span>` : ""}${s.suppressed ? `<span>suppressed ${s.suppressed}</span>` : ""}</div>
${r.notes.length ? `<details class="meta"><summary>${r.notes.length} notes</summary><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}
<div class="filters">
<label>For <select id="f-gap"><option value="">everyone</option><option value="A">${esc(r.meta.owners?.A ?? "Design system team")} (gap A)</option><option value="B">${esc(r.meta.owners?.B ?? "Product team")} (gap B)</option></select></label>
<label>Check <select id="f-check"><option value="">all</option>${checks.map((c) => `<option>${c}</option>`).join("")}</select></label>
<label>Severity <select id="f-sev"><option value="">all</option><option>high</option><option>medium</option><option>low</option></select></label>
<label>Status <select id="f-status"><option value="active">to look at (new + open)</option><option value="new">new</option><option value="open">open</option><option value="accepted">accepted</option><option value="suppressed">suppressed</option><option value="">all</option></select></label>
<label>Search <input id="f-text" type="search" placeholder="title, token, file"></label>
<span class="src" id="f-count"></span>${quiet ? `<span class="src">${quiet} accepted or suppressed issues are hidden by default.</span>` : ""}
</div>
<div class="wrap"><table><thead><tr><th>Severity</th><th>Issue</th><th>Expected</th><th>Actual</th><th>Evidence</th></tr></thead><tbody id="rows">
${rows}
</tbody></table></div>
${r.fixed.length ? `<h2>Fixed since the previous run</h2><ul>${r.fixed.map((f) => `<li>${esc(f.title)}</li>`).join("")}</ul>` : ""}
<script>
(function(){
  var q=function(id){return document.getElementById(id)};
  var rows=[].slice.call(document.querySelectorAll("#rows tr"));
  function apply(){
    var c=q("f-check").value,s=q("f-sev").value,st=q("f-status").value,t=q("f-text").value.toLowerCase(),g=q("f-gap").value,n=0;
    rows.forEach(function(r){
      var d=r.dataset,ok=(!g||d.gap===g)&&(!c||d.check===c)&&(!s||d.sev===s)&&(!st||(st==="active"?(d.status==="new"||d.status==="open"):d.status===st))&&(!t||r.textContent.toLowerCase().indexOf(t)>=0);
      r.hidden=!ok;if(ok)n++;
    });
    q("f-count").textContent=n+" of "+rows.length+" issues shown";
  }
  ["f-gap","f-check","f-sev","f-status","f-text"].forEach(function(id){q(id).addEventListener("input",apply)});
  apply();
})();
</script>
</body></html>`;
}

/** Writes findings.json, report.md and report.html into <dir>/<run id>/ and mirrors them to <dir>/latest/. */
export function writeReport(r: Report, dir: string, runDir: string): { runDir: string; latest: string } {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "findings.json"), JSON.stringify(r, null, 2));
  writeFileSync(join(runDir, "report.md"), renderMarkdown(r));
  writeFileSync(join(runDir, "report.html"), renderHtml(r));
  const latest = join(dir, "latest");
  rmSync(latest, { recursive: true, force: true });
  mkdirSync(latest, { recursive: true });
  for (const f of ["findings.json", "report.md", "report.html", "snapshot.json"])
    if (existsSync(join(runDir, f))) copyFileSync(join(runDir, f), join(latest, f));
  for (const sub of ["shots", "diffs", "crops", "figma"])
    if (existsSync(join(runDir, sub))) cpSync(join(runDir, sub), join(latest, sub), { recursive: true });
  return { runDir, latest };
}
