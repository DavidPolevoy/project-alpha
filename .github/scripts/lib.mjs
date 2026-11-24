// Shared helpers for the production workflows (.github/scripts/ in each repo). Same rules as the demo
// engine (github-sim/engine.ts) and lib/records.ts, which is where they are exercised end to end.
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

export const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
export const trySh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
export const git = (...args) => sh('git', args);
export const gh = (...args) => sh('gh', args);
export const ghJson = (...args) => JSON.parse(gh(...args) || 'null');
export const show = (rev, path) => trySh('git', ['show', `${rev}:${path}`]);

export const governance = (rev) => yaml.load(show(rev, 'governance.yaml') ?? 'null');

const globRe = (g) => new RegExp('^' + g.split('**').map((p) => p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
const branchRe = (p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$');
export const isProtected = (gov, branch) => (gov?.protected ?? []).some((p) => branchRe(p).test(branch));

export function policyFor(gov, files) {
  if (!gov || !files.length) return 'review';
  for (const f of files) {
    const rule = gov.policies.find((p) => p.paths.some((g) => globRe(g).test(f))) ?? gov.default;
    if (rule.merge === 'review') return 'review';
  }
  return 'auto';
}

/** Committed `data/repos/*.repo.yaml` records at a revision: repo identity and branch roles. */
export function repoRecords(rev) {
  const files = (trySh('git', ['ls-tree', '-r', '--name-only', rev, '--', 'data/repos']) ?? '').split('\n').filter(Boolean);
  return files.map((f) => parseRecord(show(rev, f) ?? '', f).fields);
}
export const productRoles = (records) => {
  const p = records.find((r) => r.class === 'product');
  return { staging: p?.staging_branch ?? 'dev', production: p?.production_branch ?? 'main' };
};
export function mapToProduct(records, codeRepo, branch) {
  const code = records.find((r) => r.name === codeRepo && r.class === 'code');
  const roles = productRoles(records);
  if (code && branch === code.staging_branch) return roles.staging;
  if (code && branch === code.production_branch) return roles.production;
  return branch;
}

const BODY = 'body';
export function parseRecord(text, path) {
  if (/\.ya?ml$/.test(path)) return { fields: yaml.load(text, { schema: yaml.JSON_SCHEMA }) ?? {}, format: 'yaml' };
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fields: { [BODY]: text }, format: 'md' };
  const front = yaml.load(m[1], { schema: yaml.JSON_SCHEMA }) ?? {};
  const body = m[2].replace(/^\n/, '');
  return { fields: body.trim() ? { ...front, [BODY]: body } : front, format: 'md' };
}
function rawEntries(text) {
  const out = new Map(); let key = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):(\s|$)/);
    if (m) { key = m[1]; out.set(key, line); } else if (key && line.length) out.set(key, `${out.get(key)}\n${line}`);
  }
  return out;
}
// Fields whose value the original file already holds keep their original line verbatim.
export function serializeRecord({ fields, format }, original) {
  const dump = (o) => yaml.dump(o, { lineWidth: -1, noRefs: true });
  if (format === 'yaml') return dump(fields);
  const { [BODY]: body, ...front } = fields;
  const om = original?.match(/^---\n([\s\S]*?)\n---\n?/);
  const of = om ? yaml.load(om[1], { schema: yaml.JSON_SCHEMA }) ?? {} : {};
  const ol = om ? rawEntries(om[1]) : new Map();
  const lines = Object.entries(front).map(([k, v]) => (ol.has(k) && same(of[k], v) ? ol.get(k) : dump({ [k]: v }).replace(/\n$/, '')));
  return `---\n${lines.length ? `${lines.join('\n')}\n` : ''}---\n${body ?? ''}`;
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function merge3(ancestor, target, incoming) {
  const keys = [...new Set([...Object.keys(target ?? {}), ...Object.keys(incoming ?? {}), ...Object.keys(ancestor ?? {})])];
  const fields = {}; const conflicts = [];
  for (const k of keys) {
    const a = ancestor?.[k], t = target?.[k], i = incoming?.[k];
    let v;
    if (same(t, i)) v = t; else if (same(t, a)) v = i; else if (same(i, a)) v = t; else { conflicts.push(k); v = t; }
    if (v !== undefined && v !== null) fields[k] = v;
  }
  return { fields, conflicts };
}
