import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let bad = 0;
const check = (value, message) => {
  if (value) console.log('✓ ' + message);
  else { bad++; console.error('✗ ' + message); }
};

const pages = fs.readdirSync(root).filter(file => file.endsWith('.html'));
for (const file of pages) {
  const html = read(file);
  check(/name=["']viewport["']/.test(html), file + ' has a viewport');
  check(/<html[^>]+(?:dir=["']rtl["'][^>]+lang=["']he["']|lang=["']he["'][^>]+dir=["']rtl["'])/.test(html), file + ' declares Hebrew RTL');
}

const theme = read('theme.css');
for (const token of ['--touch-min:44px', '.ui-card', '.ui-btn', '.ui-control', '.ui-message', '.ui-skeleton']) {
  check(theme.includes(token), 'shared UI contains ' + token);
}
const nav = read('nav.js');
for (const token of ["aria-label', 'ניווט ראשי", "aria-current', 'page", "event.key !== 'Escape'", 'min-height:44px']) {
  check(nav.includes(token), 'navigation contains ' + token);
}

if (bad) process.exit(1);
console.log('Shared UX foundation is consistent across ' + pages.length + ' HTML screens.');
