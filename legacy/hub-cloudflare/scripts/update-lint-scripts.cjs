const fs = require('fs');
const path = require('path');

const pkgs = [
  'packages/contracts',
  'packages/database',
  'packages/sms-parser',
  'packages/domain',
  'packages/seed',
  'apps/dashboard-worker',
  'apps/ingest-worker',
  'apps/dashboard-web',
];

for (const rel of pkgs) {
  const p = path.join(process.cwd(), rel, 'package.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.scripts = j.scripts || {};
  // Build the lint script: prefer src+types+test if those exist, else src.
  // Easiest: just run eslint with the glob the config supports; missing dirs
  // are ignored by ESLint itself.
  j.scripts.lint = 'eslint --max-warnings 0 .';
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  console.log('updated', rel);
}
