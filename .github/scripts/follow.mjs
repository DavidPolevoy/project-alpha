// The product repo's follow workflow (code drives). Runs in the product repo with a GitHub App token
// that is the ONLY bypass actor on the protected-branch ruleset. It creates and archives coupled
// branches, opens follow PRs (auto-merge on), and sets their change-set-complete status.
import { gh, ghJson, git, mapToProduct, productRoles, repoRecords, trySh } from './lib.mjs';

const EVENT = process.env.EVENT;
const p = JSON.parse(process.env.PAYLOAD ?? '{}');
const OWNER = process.env.GITHUB_REPOSITORY.split('/')[0];
const PRODUCT = process.env.GITHUB_REPOSITORY;
git('fetch', '-q', 'origin', '--prune');
const records = repoRecords('origin/dev');             // repo identity + branch roles, committed
const roles = productRoles(records);
const coupled = records.filter((r) => r.class === 'code').map((r) => r.name);
const codeRoles = (repo) => records.find((r) => r.name === repo) ?? {};
const followable = (b) => /^feature\/[^/]+\/[^/]+$/.test(b) || /^(release|hotfix)\/[^/]+$/.test(b);
const tip = (branch) => trySh('git', ['rev-parse', '--verify', '-q', `origin/${branch}`]);
const slug = (s) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const MARK = /<!-- follow:(\{.*\}) -->/;

function create(branch, from) {
  if (tip(branch)) return;
  git('push', 'origin', `${tip(from)}:refs/heads/${branch}`);
  console.log(`created ${branch} from ${from}`);
}

if (EVENT === 'code-branch-created' && followable(p.branch)) {
  const pb = mapToProduct(records, p.repo, p.branch);
  const f = pb.match(/^feature\/([^/]+)\/(.+)$/);
  if (f && f[2] !== 'main') { create(`feature/${f[1]}/main`, roles.staging); git('fetch', '-q', 'origin'); create(pb, `feature/${f[1]}/main`); }
  else create(pb, pb.startsWith('hotfix/') ? roles.production : roles.staging);
}

if (EVENT === 'code-branch-deleted' && followable(p.branch)) {
  const pb = mapToProduct(records, p.repo, p.branch);
  const stillOpen = coupled.some((r) => r !== p.repo && trySh('gh', ['api', `repos/${OWNER}/${r}/branches/${encodeURIComponent(p.branch)}`]));
  const merged = ghJson('pr', 'list', '-R', `${OWNER}/${p.repo}`, '--state', 'merged', '--head', p.branch, '--json', 'number').length > 0;
  const t = tip(pb);
  if (t && !stillOpen && !merged) {
    git('push', 'origin', `${t}:refs/archive/${new Date().toISOString().slice(0, 10)}/${pb}`, `:refs/heads/${pb}`);
    console.log(`archived ${pb}`);
  }
}

if (EVENT === 'code-pr-merged') {
  const headP = mapToProduct(records, p.repo, p.head), baseP = mapToProduct(records, p.repo, p.base);
  const headSha = tip(headP);
  if (!headSha || !tip(baseP)) { console.log(`nothing to follow: product has no ${headSha ? baseP : headP}`); process.exit(0); }
  let pr = ghJson('pr', 'list', '--label', 'follow', '--base', baseP, '--state', 'open', '--json', 'number,headRefName,headRefOid,body')
    .find((x) => JSON.parse(x.body.match(MARK)?.[1] ?? '{}').head_branch === headP);
  if (!pr) {
    if (trySh('git', ['merge-base', '--is-ancestor', headSha, `origin/${baseP}`]) !== null) { console.log(`${headP} has nothing ${baseP} lacks (unspecced)`); process.exit(0); }
    const followBranch = `follow/${slug(headP)}-into-${slug(baseP)}-${headSha.slice(0, 7)}`;
    git('push', 'origin', `${headSha}:refs/heads/${followBranch}`);
    // Register the gate BEFORE the PR exists and before auto-merge is on: a partial merge can never fire.
    gh('api', `repos/${PRODUCT}/statuses/${headSha}`, '-f', 'state=pending', '-f', 'context=change-set-complete', '-f', 'description=waiting for every linked code repo');
    const meta = { head_branch: headP, base_branch: baseP, code: [{ repo: p.repo, number: Number(p.number), head: p.head, base: p.base }] };
    const url = gh('pr', 'create', '--base', baseP, '--head', followBranch, '--label', 'follow',
      '--title', `Follow ${p.repo}#${p.number}: ${headP} → ${baseP}`,
      '--body', `Opened because ${p.repo}#${p.number} merged ${p.head} into ${p.base}. Code drives: this merges itself once every linked code repo holding ${headP} has merged it.\n\n<!-- follow:${JSON.stringify(meta)} -->`);
    gh('pr', 'merge', url, '--auto', '--merge');
    pr = ghJson('pr', 'view', url, '--json', 'number,headRefName,headRefOid,body');
  }

  // change-set-complete: every coupled repo that holds the head branch must have merged it into base.
  const lines = [];
  let complete = true;
  for (const repo of coupled) {
    const r = codeRoles(repo);
    const codeHead = headP === roles.staging ? r.staging_branch : headP === roles.production ? r.production_branch : headP;
    const codeBase = baseP === roles.staging ? r.staging_branch : baseP === roles.production ? r.production_branch : baseP;
    const merged = ghJson('pr', 'list', '-R', `${OWNER}/${repo}`, '--state', 'merged', '--head', codeHead, '--base', codeBase, '--json', 'number').length > 0;
    const holds = merged || !!trySh('gh', ['api', `repos/${OWNER}/${repo}/branches/${encodeURIComponent(codeHead)}`]);
    if (!holds) continue;
    lines.push(`${repo} ${merged ? '✔' : '⏳'}`);
    complete &&= merged;
  }
  gh('api', `repos/${PRODUCT}/statuses/${pr.headRefOid}`, '-f', `state=${complete ? 'success' : 'pending'}`, '-f', 'context=change-set-complete', '-f', `description=${lines.join(' · ').slice(0, 140)}`);
  console.log(`follow PR #${pr.number}: change-set-complete ${complete ? 'success' : 'pending'} (${lines.join(', ')})`);
}
