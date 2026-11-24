// usage: node auto-resolve.mjs <base-branch>
// For each open PR into <base> that GitHub marks CONFLICTING: if every conflict is a false one (each side
// changed different fields of a record), merge the base into the PR branch field by field and push.
// Protected heads are never written. True conflicts are labelled and left for a person.
import { writeFileSync } from 'node:fs';
import { gh, ghJson, git, governance, isProtected, merge3, parseRecord, serializeRecord, show, trySh } from './lib.mjs';

const base = process.argv[2];
git('config', 'user.name', 'github-actions[bot]');
git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
const gov = governance(`origin/${base}`);

for (const pr of ghJson('pr', 'list', '--base', base, '--state', 'open', '--json', 'number,headRefName,mergeable,labels')) {
  if (pr.mergeable !== 'CONFLICTING' || isProtected(gov, pr.headRefName)) continue;
  git('fetch', '-q', 'origin', pr.headRefName);
  git('checkout', '-q', '-B', `resolve-${pr.number}`, `origin/${pr.headRefName}`);
  if (trySh('git', ['merge', '--no-ff', '--no-commit', `origin/${base}`]) !== null) { git('merge', '--abort'); continue; }
  const files = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  const mb = git('merge-base', 'HEAD', `origin/${base}`);
  let truly = [];
  for (const file of files) {
    if (!file.startsWith('data/')) { truly.push(file); continue; }
    const read = (rev) => { const t = show(rev, file); return t === null ? null : parseRecord(t, file); };
    const target = read(`origin/${base}`);
    const m = merge3(read(mb)?.fields, target?.fields, read('HEAD')?.fields);
    if (m.conflicts.length) { truly.push(`${file} (${m.conflicts.join(', ')})`); continue; }
    writeFileSync(file, serializeRecord({ fields: m.fields, format: target?.format ?? 'md' }, show(`origin/${base}`, file)));
    git('add', file);
  }
  if (truly.length) {
    git('merge', '--abort');
    const label = pr.headRefName.startsWith('follow/') ? 'drift' : 'conflict';
    gh('pr', 'edit', String(pr.number), '--add-label', label);
    gh('pr', 'comment', String(pr.number), '--body', `True conflict with \`${base}\`: ${truly.join('; ')}. Both sides changed the same field — a person decides. Resolve in the dashboard (web/* branches) or rebuild the change on a fresh branch.`);
    continue;
  }
  git('commit', '-q', '-m', `Merge ${base} into ${pr.headRefName}\n\nField-level auto-resolve: each side changed different fields.`);
  git('push', 'origin', `HEAD:refs/heads/${pr.headRefName}`);
}
