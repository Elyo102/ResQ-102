import assert from 'node:assert/strict';
import { COMPARTMENTS, operationalFleet, faultsForVehicle }
  from '../operational-vehicles-model.js';

assert.deepEqual(COMPARTMENTS.map(item => item.label), [
  'קבינה', 'תא לוחמים', 'תא 1', 'תא 2', 'תא 3', 'תא 4',
  'תא 5', 'תא 6', 'תא 7', 'גג'
]);
assert.deepEqual(operationalFleet([
  { id:'407', name:'רכב 407' }, { id:'408', active:false },
  { id:'407', name:'duplicate' }, { id:'409' }, { name:'missing id' }
]), [
  { id:'407', name:'רכב 407' }, { id:'409', name:'409' }
]);
assert.deepEqual(faultsForVehicle([
  { vehicle_id:'407', kind:'vehicle' },
  { vehicle_id:'407', kind:'gear' },
  { vehicle_id:'408', kind:'gear' }
], '407').map(item => item.kind), ['vehicle', 'gear']);
console.log('3 operational vehicle model checks passed');
