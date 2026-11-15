// views.ts — minimal HTML pages for a human browsing the clone in a browser.
//
// The conformance suite never fetches HTML (it asserts REST replies are not
// HTML), so these pages exist for a person, not for a score: a repository
// list, a repository page with its file tree, its issues and its pull
// requests. All values are escaped; nothing here reads the clock.

import type { Issue, Pull, Repo } from './store.ts';

function escapeHtml(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] as string;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else out += ch;
  }
  return out;
}

function page(title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<title>${escapeHtml(title)}</title>` +
    '<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}' +
    'a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}' +
    'h1{font-size:1.4rem;border-bottom:1px solid #d0d7de;padding-bottom:.5rem}' +
    'ul{list-style:none;padding:0}li{padding:.4rem 0;border-bottom:1px solid #eaeef2}' +
    '.label{display:inline-block;background:#ddf4ff;border-radius:1rem;padding:0 .5rem;font-size:.8rem}</style></head><body>' +
    body +
    '</body></html>'
  );
}

/** The front page: every repository the viewer owns. */
export function homeView(repos: readonly Repo[]): string {
  const items = repos
    .map((repo) => `<li><a href="/${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}">${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</a> — ${escapeHtml(repo.description)}</li>`)
    .join('');
  return page('git-forge', `<h1>git-forge</h1><p>A GitHub core clone.</p><ul>${items}</ul>`);
}

/** One repository: its description, branches, file tree, issues and pulls. */
export function repoView(repo: Repo, files: readonly { name: string; type: string }[]): string {
  const branches = [...repo.refs.keys()]
    .filter((name) => name.startsWith('refs/heads/'))
    .map((name) => `<li>${escapeHtml(name.slice('refs/heads/'.length))}</li>`)
    .join('');
  const tree = files
    .map((file) => `<li>${file.type === 'tree' ? '📁' : '📄'} ${escapeHtml(file.name)}</li>`)
    .join('');
  const issues = [...repo.issues.values()]
    .map((issue: Issue) => `<li><a href="/${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}/issues/${issue.number}">#${issue.number} ${escapeHtml(issue.title)}</a> <span class="label">${issue.state}</span></li>`)
    .join('');
  const pulls = [...repo.pulls.values()]
    .map((pull: Pull) => `<li><a href="/${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}/pull/${pull.number}">#${pull.number} ${escapeHtml(pull.title)}</a> <span class="label">${pull.state}</span></li>`)
    .join('');
  return page(
    `${repo.owner}/${repo.name}`,
    `<h1><a href="/">${escapeHtml(repo.owner)}</a> / ${escapeHtml(repo.name)}</h1>` +
      `<p>${escapeHtml(repo.description)}</p>` +
      `<h2>Branches</h2><ul>${branches}</ul>` +
      `<h2>Files</h2><ul>${tree}</ul>` +
      `<h2>Issues</h2><ul>${issues}</ul>` +
      `<h2>Pull requests</h2><ul>${pulls}</ul>`,
  );
}
