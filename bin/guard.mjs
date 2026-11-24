#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash). Exit 2 blocks the call and shows stderr to Claude.
// Advisory skills say what to do; this enforces it locally. The server-side ruleset
// (pre-receive in the demo) is the last wall for everyone.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
if (input.tool_name !== 'Bash') process.exit(0);
const command = String(input.tool_input?.command ?? '');
let cwd = input.cwd ?? process.cwd();

const block = (why) => {
  console.error(`BLOCKED by shared-repo guard: ${why}\nFollow the shared-repo-pr-workflow skill: work on agent/<you>/<topic>, open a PR, and let GitHub merge it.`);
  process.exit(2);
};

const git = (args, at) => { try { return execFileSync('git', args, { cwd: at, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

function protectedPatterns(at) {
  const top = git(['rev-parse', '--show-toplevel'], at);
  if (!top) return [];
  const common = resolve(top, git(['rev-parse', '--git-common-dir'], at));
  const primary = resolve(common, '..');
  for (const dir of [top, primary]) {
    const gov = join(dir, 'governance.yaml');
    if (existsSync(gov)) {
      const m = readFileSync(gov, 'utf8').match(/^protected:\s*\[(.*)\]/m);
      if (m) return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    const link = join(dir, '.product-link.json');
    if (existsSync(link)) return JSON.parse(readFileSync(link, 'utf8')).protected ?? [];
  }
  return [];
}
const toRegex = (p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$');
const isProtected = (branch, pats) => pats.some((p) => toRegex(p).test(branch));

if (/\bgh\s+pr\s+merge\b/.test(command) || /sandbox(\.mjs)?\s+pr\s+merge\b/.test(command)) block('pull requests are merged in GitHub, never from a terminal or by Claude.');
if (/\bgh\s+api\b[^|;&]*\/merges?\b/.test(command)) block('merging through the GitHub API is a merge from the terminal.');
if (/--admin\b/.test(command)) block('admin bypass of branch protection.');

// Each segment of a && / ; / || chain, tracking `cd`.
for (const raw of command.split(/&&|\|\||;/)) {
  const seg = raw.trim();
  const cd = seg.match(/^cd\s+("([^"]+)"|'([^']+)'|(\S+))/);
  if (cd) { const p = cd[2] ?? cd[3] ?? cd[4]; cwd = isAbsolute(p) ? p : resolve(cwd, p); continue; }
  let at = cwd;
  const dashC = seg.match(/\bgit\s+-C\s+("([^"]+)"|(\S+))/);
  if (dashC) { const p = dashC[2] ?? dashC[3]; at = isAbsolute(p) ? p : resolve(cwd, p); }
  const pats = protectedPatterns(at);
  if (!pats.length) continue;
  const branch = git(['branch', '--show-current'], at);
  const onProtected = branch && isProtected(branch, pats);
  const gitVerb = seg.match(/\bgit\s+(?:-C\s+\S+\s+)?([a-z-]+)(.*)$/);

  if (gitVerb) {
    const [, verb, argStr] = gitVerb;
    const args = argStr.trim().split(/\s+/).filter(Boolean);
    if (['commit', 'merge', 'cherry-pick', 'revert', 'am', 'pull'].includes(verb) && onProtected) block(`\`git ${verb}\` on protected branch ${branch}.`);
    if (verb === 'push') {
      if (args.some((a) => a === '--force' || a === '-f' || /^\+/.test(a))) block('force push (only --force-with-lease on your own agent/* branch is allowed).');
      const refspecs = args.filter((a) => !a.startsWith('-')).slice(1);
      if (!refspecs.length && onProtected) block(`push of protected branch ${branch}.`);
      for (const spec of refspecs) {
        const dst = (spec.includes(':') ? spec.split(':')[1] : spec).replace(/^refs\/heads\//, '');
        const src = spec.includes(':') ? spec.split(':')[0] : spec;
        const target = dst === 'HEAD' || src === 'HEAD' && !spec.includes(':') ? branch : dst;
        if (target && isProtected(target, pats)) block(`push to protected branch ${target}.`);
      }
    }
    if (['checkout', 'switch', 'branch'].includes(verb)) {
      const created = argStr.match(/(?:-b|-c|-B|-C)\s+(\S+)/)?.[1] ?? (verb === 'branch' ? args.find((a) => !a.startsWith('-')) : undefined);
      if (created && /^feature\/[^/]+$/.test(created)) block(`\`${created}\` — a feature umbrella is feature/<f>/main, sub-branches feature/<f>/<part>.`);
    }
  }
  if (/\b(dreamteamer(\.js)?|dt)\s+(add|set|rm|rename|commit)\b/.test(seg) && onProtected) block(`record write on protected branch ${branch} — run \`sandbox start <topic> --base ${branch}\` and write in that worktree.`);
}
process.exit(0);
