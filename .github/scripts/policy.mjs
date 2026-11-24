// usage: node policy.mjs <base-rev> <head-sha>  → prints `merge=auto|review` for $GITHUB_OUTPUT
import { git, governance, policyFor } from './lib.mjs';

const [base, head] = process.argv.slice(2);
const files = git('diff', '--name-only', `${base}...${head}`).split('\n').filter(Boolean);
console.log(`merge=${policyFor(governance(base), files)}`);
