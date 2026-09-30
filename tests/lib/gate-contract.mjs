// Shared by the actual runner and release checks; there is no direct-run fallback.
export const GATE_TARGETS = Object.freeze({ all: 'all:inner', 'test:all': 'test:all:inner', 'reserve:contained': 'reserve:contained:inner' });

export function resolveContainedGate(gate) {
  if (typeof gate !== 'string' || !Object.hasOwn(GATE_TARGETS, gate)) {
    throw new Error('Unknown contained gate');
  }
  return GATE_TARGETS[gate];
}

const PREFIX = Object.freeze(['test:reproducibility', 'test:inventory', 'pages:source']);
export function assertApplicationGate(scripts) {
  const fail = () => { throw new Error('APPLICATION_GATE_CHANGED'); };
  if (scripts?.all !== 'node run-contained.mjs all') fail();
  const inner = scripts?.[resolveContainedGate('all')];
  if (typeof inner !== 'string' || /[\r\n]/.test(inner)) fail();
  const commands = inner.split(' && ');
  if (commands.length < 4 || commands.some(command => !/^npm run [a-zA-Z0-9][a-zA-Z0-9:_-]*(?![\s\S])/.test(command))) fail();
  const names = commands.map(command => command.slice('npm run '.length));
  if (new Set(names).size !== names.length || PREFIX.some((name, index) => names[index] !== name)) fail();
  return true;
}
