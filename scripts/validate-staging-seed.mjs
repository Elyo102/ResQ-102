import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = JSON.parse(fs.readFileSync(path.join(root, 'config/staging-seed.json'), 'utf8'));
if (seed.station?.id !== 'staging_station') throw new Error('Seed must target staging_station');
if (!Array.isArray(seed.users) || seed.users.length < 6) throw new Error('Seed needs six synthetic roles');
if (JSON.stringify(seed).includes('station-102')) throw new Error('Seed must never target production');
if (seed.users.some(user => !String(user.employeeId).startsWith('TEST-'))) throw new Error('Only synthetic TEST users are allowed');
const roles = new Set(['firefighter', 'deputy_team_leader', 'team_leader', 'deputy', 'commander', 'station_commander', 'hr_coordinator']);
if (seed.users.some(user => !roles.has(user.role))) throw new Error('Seed contains an invalid role');
if (seed.users.filter(user => user.super === true).length !== 1) throw new Error('Seed needs exactly one separate super claim');
console.log(`Validated ${seed.users.length} synthetic staging users; no cloud data was written.`);
