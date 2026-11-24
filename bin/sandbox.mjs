#!/usr/bin/env node
// Local stand-in for `gh` against the GitHub simulator. Dependency-free on purpose: it ships in code
// repos too, which have no node_modules.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const API = process.env.SANDBOX_GITHUB ?? 'http://localhost:5174';

const git = (args, cwd = process.cwd()) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const tryGit = (args, cwd) => { try { return git(args, cwd); } catch { return ''; } };

function fail(msg) { console.error(`✖ ${msg}`); process.exit(1); }

function parse(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true; else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { flags, pos };
}

function repoRoot() { return tryGit(['rev-parse', '--show-toplevel']) || fail('not inside a git repository'); }
function primaryRoot() {
  const common = resolve(repoRoot(), git(['rev-parse', '--git-common-dir']));
  return dirname(common);
}
function repoName() {
  const url = tryGit(['remote', 'get-url', 'origin']);
  if (!url) fail('this repo has no origin — personal repos commit to main directly');
  return basename(url).replace(/\.git$/, '');
}
/** Flat `key: value` lines of a committed repos record (the CLI must run without node_modules). */
function parseRecordText(text) {
  const out = {};
  for (const line of (text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? text).split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
function readRepoRecords(cwd, rev) {
  const files = tryGit(['ls-tree', '-r', '--name-only', rev, '--', 'data/repos'], cwd).split('\n').filter(Boolean);
  return files.map((f) => parseRecordText(tryGit(['show', `${rev}:${f}`], cwd)));
}
function envOf(root) {
  const env = { ...process.env };
  const file = join(root, '.env');
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !(m[1] in process.env)) env[m[1]] = m[2]; }
  return env;
}
/** Render a record's `${workspaceFolder}` / `${env:NAME}` against THIS clone — never a committed absolute path. */
function renderPath(value, root) {
  const env = envOf(root);
  return resolve(String(value ?? '').replace(/\$\{workspaceFolder\}/g, root).replace(/\$\{env:([A-Z0-9_]+)\}/g, (_, k) => env[k] ?? ''));
}

function currentBranch() { return git(['branch', '--show-current']); }
function me() { return (tryGit(['config', 'user.name']) || fail('git config user.name is not set')).toLowerCase(); }

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    fail(`cannot reach the GitHub stand-in at ${API} — is \`npm run demo\` running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error ?? `${method} ${path} → HTTP ${res.status}`);
  return data;
}

function printPr(pr) {
  const fields = (pr.records ?? []).map((r) => `${r.ref} [${r.fields.join(', ')}]`).join('; ');
  console.log(`#${pr.number}  ${pr.state.padEnd(8)} ${pr.head} → ${pr.base}  by ${pr.author}  ci:${pr.checks?.['dreamteamer-check'] ?? '-'}  ${pr.mergeable === false ? 'CONFLICT' : ''}`);
  console.log(`     ${pr.title}`);
  if (fields) console.log(`     touches ${fields}`);
  console.log(`     ${pr.url}`);
}

const [cmd, sub, ...rest] = process.argv.slice(2);

async function main() {
  if (cmd === 'pr' && sub === 'list') {
    const { flags } = parse(rest);
    const q = new URLSearchParams({ state: flags.state ?? 'open' });
    if (flags.base) q.set('base', flags.base);
    if (flags.record) q.set('record', flags.record);
    const prs = await api('GET', `/api/repos/${repoName()}/pulls?${q}`);
    if (!prs.length) console.log('no matching pull requests');
    prs.forEach(printPr);
    return;
  }
  if (cmd === 'pr' && sub === 'view') {
    const n = rest[0] ?? fail('usage: sandbox pr view <number>');
    printPr(await api('GET', `/api/repos/${repoName()}/pulls/${n}`));
    return;
  }
  if (cmd === 'pr' && sub === 'create') {
    const { flags } = parse(rest);
    const head = currentBranch();
    const base = flags.base ?? tryGit(['config', `branch.${head}.sandboxBase`]);
    if (!base) fail('no base branch: pass --base, or start the branch with `sandbox start`');
    if (!flags.title) fail('pass --title "<summary>"');
    const pushed = tryGit(['rev-parse', `origin/${head}`]);
    if (!pushed || pushed !== git(['rev-parse', 'HEAD'])) fail(`push first: git push -u origin HEAD`);
    const pr = await api('POST', `/api/repos/${repoName()}/pulls`, { head, base, title: flags.title, body: flags.body ?? '', author: me() });
    console.log(`✔ opened pull request — GitHub merges it (reviewer or auto-merge), never this CLI`);
    printPr(pr);
    return;
  }
  if (cmd === 'pr' && sub === 'merge') {
    fail('merging happens in GitHub (the Merge button or auto-merge). This CLI has no merge command.');
  }
  if (cmd === 'start') {
    const topic = sub ?? fail('usage: sandbox start <topic> --base <branch>');
    const { flags } = parse(rest);
    const base = flags.base ?? fail('pass --base <branch> (the branch the PR will target)');
    const root = primaryRoot();
    git(['fetch', 'origin', '--prune'], root);
    if (!tryGit(['rev-parse', '--verify', `origin/${base}`], root)) fail(`origin has no branch ${base}`);
    const branch = `agent/${me()}/${topic}`;
    const dir = join(root, '.worktrees', topic);
    if (existsSync(dir)) fail(`${dir} already exists`);
    git(['worktree', 'add', '-b', branch, dir, `origin/${base}`], root);
    git(['config', `branch.${branch}.sandboxBase`, base], root);
    git(['branch', '--unset-upstream', branch], root);
    if (existsSync(join(root, 'node_modules'))) {
      symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
      execFileSync(process.execPath, ['node_modules/dreamteamer/bin/dreamteamer.js', 'compile'], { cwd: dir, stdio: 'ignore' });
    }
    console.log(`✔ worktree ${dir}`);
    console.log(`  branch ${branch} from origin/${base} — PR target ${base}`);
    console.log(dir);
    return;
  }
  if (cmd === 'link' && sub === 'resolve') {
    const root = repoRoot();
    const linkFile = join(primaryRoot(), '.product-link.json');
    if (!existsSync(linkFile)) fail('this repo has no .product-link.json — it is not linked to a product repo');
    const link = JSON.parse(readFileSync(linkFile, 'utf8'));
    const branch = currentBranch();
    const clone = resolve(dirname(primaryRoot()), link.product);   // this user's clone of the product repo, beside this one
    if (!existsSync(clone)) fail(`no clone of ${link.product} beside this repo (looked for ${clone})`);
    tryGit(['fetch', '-q', 'origin'], clone);
    const records = readRepoRecords(clone, 'origin/dev');
    const self = records.find((r) => r.name === repoName() && r.class === 'code');
    const product = records.find((r) => r.class === 'product');
    if (!self || !product) fail(`${link.product} has no repos record for ${repoName()} — role mapping lives in data/repos/*.repo.yaml`);
    const productBranch = branch === self.staging_branch ? product.staging_branch : branch === self.production_branch ? product.production_branch : branch;
    const branches = await api('GET', `/api/repos/${link.product}/branches`);
    const exists = branches.some((b) => b.name === productBranch);
    console.log(JSON.stringify({ code_repo: repoName(), code_branch: branch, roles: { staging: self.staging_branch, production: self.production_branch }, product_repo: link.product, product_branch: productBranch, product_branch_exists: exists, product_clone: clone, worktree: root }, null, 2));
    return;
  }
  if (cmd === 'repos') {
    const root = primaryRoot();
    const rows = readRepoRecords(root, 'HEAD').map((r) => {
      const path = r.path ? renderPath(r.path, root) : null;
      return { name: r.name, class: r.class, staging: r.staging_branch ?? null, production: r.production_branch, path, cloned: !!path && existsSync(path), url: renderPath(r.url, root) };
    });
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (cmd === 'branch' && sub === 'start') {
    const feature = rest[0] ?? fail('usage: sandbox branch start <feature>   (creates feature/<feature>/main, spec-first)');
    const out = await api('POST', `/api/repos/${repoName()}/spec-first`, { feature, author: me() });
    console.log(`✔ ${out.branch} created from dev — shows as spec-only until a code repo pushes the same branch`);
    return;
  }
  console.log(`usage:
  sandbox pr list [--record <collection>/<id>] [--base <branch>] [--state open|merged|closed|all]
  sandbox pr view <number>
  sandbox pr create --title "<summary>" [--base <branch>] [--body "<text>"]
  sandbox start <topic> --base <branch>         worktree + agent/<you>/<topic> branch
  sandbox link resolve                          (code repo) which product branch matches this branch
  sandbox repos                                 linked repos, roles and paths resolved for THIS clone
  sandbox branch start <feature>                (product repo) spec-first feature/<feature>/main`);
  if (cmd) process.exit(1);
}

main();
