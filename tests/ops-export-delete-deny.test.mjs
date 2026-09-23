#!/usr/bin/env node
import assert from 'node:assert/strict';
import { parseArgs, performDeletion, refuseDeleteProject } from '../ops-export.mjs';

const sid = 'eilat_102';
const deletionId = 'f_' + 'a'.repeat(40);
const base = ['--project', 'station-102', '--station', sid, '--by', 'operator',
  '--delete-feedback', deletionId, '--confirm-delete', deletionId];

assert.throws(() => parseArgs(base), /station-102|ייצור|מחיקה|delete|סורב|סירוב|denied/i);
assert.throws(() => refuseDeleteProject('station-102'), /station-102/);

// Demo project still parses.
const demo = parseArgs(['--project', 'demo-resq', '--station', sid, '--by', 'operator',
  '--delete-feedback', deletionId, '--confirm-delete', deletionId]);
assert.equal(demo.project, 'demo-resq');
assert.equal(demo.deleteFeedback, deletionId);

// performDeletion also refuses even if args were forged.
await assert.rejects(
  performDeletion({ ...demo, project: 'station-102' }, {
    feedback: { remove: async () => ({ deleted: true, id: deletionId }) },
    incidents: { removeResolved: async () => ({ deleted: true, fingerprint: 'x' }) }
  }),
  /station-102|ייצור|מחיקה|delete|סורב|סירוב|denied/i
);

console.log('PASS ops-export-delete-deny');
