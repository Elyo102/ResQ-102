import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const { parse } = createRequire(import.meta.url)('acorn');
const fail = code => { throw Error('INVALID_MUTANT_' + code); };
export function normalizeAst(value) {
  if (Array.isArray(value)) return value.map(normalizeAst);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).filter(key => !['start', 'end', 'loc', 'raw'].includes(key)).sort()
    .map(key => [key, normalizeAst(value[key])]));
}
const same = (a, b) => JSON.stringify(normalizeAst(a)) === JSON.stringify(normalizeAst(b));
export const astDigest = node => crypto.createHash('sha256').update(JSON.stringify(normalizeAst(node))).digest('hex');
const tree = source => parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

export function semanticNodes(ast) {
  const rows = [];
  function visit(node, ancestors = [], route = []) {
    if (!node || typeof node !== 'object') return;
    if (node.type) {
      const context = ancestors.flatMap(({ node: parent, edge }) => {
        if (/Function/.test(parent.type)) return [{ kind: parent.type, name: parent.id?.name || null, params: astDigest(parent.params) }];
        if (parent.type === 'Property' || parent.type === 'MethodDefinition') return [{ kind: parent.type, key: normalizeAst(parent.key) }];
        if (parent.type === 'VariableDeclarator') return [{ kind: parent.type, id: normalizeAst(parent.id) }];
        if (parent.type === 'IfStatement' || parent.type === 'ConditionalExpression') return [{ kind: parent.type, test: astDigest(parent.test), edge }];
        return [];
      });
      rows.push({ node, route, context });
    }
    for (const [key, value] of Object.entries(node)) {
      if (['start', 'end', 'loc', 'raw'].includes(key)) continue;
      const next = [...ancestors, { node, edge: key }];
      if (Array.isArray(value)) value.forEach((child, index) => visit(child, next, [...route, key, index]));
      else if (value && typeof value === 'object') visit(value, next, [...route, key]);
    }
  }
  visit(ast); return rows;
}

export function astChanges(before, after, route = []) {
  if (same(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length === after.length) return before.flatMap((item, index) => astChanges(item, after[index], [...route, index]));
    if (before.length === after.length + 1) {
      const candidates = before.map((_, index) => index).filter(index => same(before.filter((_, at) => at !== index), after));
      if (candidates.length === 1) return [{ before: before[candidates[0]], after: null, route: [...route, candidates[0]] }];
    }
    fail('ARRAY_CHANGE');
  }
  if (!before?.type || !after?.type) fail('STRUCTURAL_CHANGE');
  if (before.type !== after.type) return [{ before, after, route }];
  const keys = new Set([...Object.keys(normalizeAst(before)), ...Object.keys(normalizeAst(after))]);
  const changed = [...keys].filter(key => !same(before[key], after[key]));
  if (changed.some(key => !before[key] || !after[key] || typeof before[key] !== 'object' || typeof after[key] !== 'object'))
    return [{ before, after, route }];
  return changed.flatMap(key => astChanges(before[key], after[key], [...route, key]));
}

// Authoring helper only: stored descriptors, not text needles, drive execution.
export function describeMutation(original, modified) {
  const before = tree(original), after = tree(modified), changes = astChanges(before, after);
  if (changes.length !== 1) fail('CHANGE_COUNT');
  const change = changes[0];
  const row = semanticNodes(before).find(item => JSON.stringify(item.route) === JSON.stringify(change.route));
  if (!row) fail('NODE');
  const descriptor = {
    operation: change.after === null ? 'remove' : 'replace',
    selector: { type: row.node.type, digest: astDigest(row.node), context: row.context },
    originalHash: astDigest(row.node), replacementHash: astDigest(change.after),
    replacementText: change.after ? modified.slice(change.after.start, change.after.end) : '',
  };
  applyAstMutation(original, descriptor);
  return descriptor;
}

export function applyAstMutation(source, descriptor) {
  const before = tree(source);
  const matches = semanticNodes(before).filter(row => row.node.type === descriptor.selector?.type
    && astDigest(row.node) === descriptor.selector.digest && same(row.context, descriptor.selector.context));
  if (matches.length !== 1) fail('SELECTOR_CARDINALITY');
  const selected = matches[0];
  if (['Program', 'FunctionDeclaration', 'FunctionExpression', 'BlockStatement'].includes(selected.node.type)) fail('BROAD_SELECTOR');
  if (astDigest(selected.node) !== descriptor.originalHash || typeof descriptor.replacementText !== 'string') fail('ORIGINAL');
  const replacement = source.includes('\r\n') ? descriptor.replacementText.replace(/\r?\n/g, '\r\n') : descriptor.replacementText;
  if (!['replace', 'remove', 'insert-before'].includes(descriptor.operation)) fail('OPERATION');
  const result = source.slice(0, selected.node.start) + replacement
    + source.slice(descriptor.operation === 'insert-before' ? selected.node.start : selected.node.end);
  const after = tree(result), expected = normalizeAst(before);
  let parent = expected;
  for (const key of selected.route.slice(0, -1)) parent = parent[key];
  const key = selected.route.at(-1);
  let replacementNode = after;
  for (const key of selected.route) replacementNode = replacementNode?.[key];
  if (descriptor.operation === 'remove') {
    if (!Array.isArray(parent) || replacement !== '') fail('REMOVE');
    parent.splice(key, 1); replacementNode = null;
  } else if (descriptor.operation === 'insert-before') {
    if (!Array.isArray(parent) || !replacementNode?.type?.endsWith('Statement')) fail('INSERT');
    parent.splice(key, 0, normalizeAst(replacementNode));
  } else parent[key] = normalizeAst(replacementNode);
  if (astDigest(replacementNode) !== descriptor.replacementHash || !same(expected, after)) fail('EXPECTED_AST_CHANGE');
  return result;
}

export function describeSelectedMutation(source, selectedNode, replacementText, operation = 'replace') {
  const before = tree(source);
  const row = semanticNodes(before).find(item => item.node.start === selectedNode.start && item.node.end === selectedNode.end);
  if (!row || ['Program', 'FunctionDeclaration', 'FunctionExpression', 'BlockStatement'].includes(row.node.type)) fail('BROAD_SELECTOR');
  const modified = source.slice(0, row.node.start) + replacementText + source.slice(operation === 'insert-before' ? row.node.start : row.node.end);
  let replacementNode = tree(modified);
  for (const key of row.route) replacementNode = replacementNode?.[key];
  const descriptor = { operation, selector: { type: row.node.type, digest: astDigest(row.node), context: row.context },
    originalHash: astDigest(row.node), replacementHash: astDigest(replacementNode), replacementText };
  applyAstMutation(source, descriptor); return descriptor;
}
