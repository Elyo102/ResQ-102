import { parse } from 'acorn';

// Parse the original source: stripping strings/comments with regex can change
// its syntax. Include constructors to preserve the checker's existing coverage.
export function collectCallNames(source) {
  const names = new Set();
  const pending = [parse(source, { ecmaVersion: 'latest', sourceType: 'script' })];
  while (pending.length) {
    const node = pending.pop();
    if ((node.type === 'CallExpression' || node.type === 'NewExpression') &&
        node.callee.type === 'Identifier') names.add(node.callee.name);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === 'string') pending.push(child);
        }
      } else if (value && typeof value.type === 'string') pending.push(value);
    }
  }
  return names;
}
