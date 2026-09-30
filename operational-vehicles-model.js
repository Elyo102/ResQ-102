// Pure view helpers for the operational-vehicle screen. The existing board
// fleet remains the authority for vehicle identity; this module never writes.
export const COMPARTMENTS = Object.freeze([
  { id: 'cabin', label: 'קבינה' },
  { id: 'crew', label: 'תא לוחמים' },
  ...Array.from({ length: 7 }, (_, index) => ({
    id: 'bay-' + (index + 1), label: 'תא ' + (index + 1)
  })),
  { id: 'roof', label: 'גג' }
]);

export function operationalFleet(boardVehicles) {
  const seen = new Set();
  return (Array.isArray(boardVehicles) ? boardVehicles : [])
    .filter(vehicle => {
      if (!vehicle || typeof vehicle.id !== 'string' || !vehicle.id.trim()
          || vehicle.active === false || seen.has(vehicle.id)) return false;
      seen.add(vehicle.id);
      return true;
    })
    .map(vehicle => ({ id: vehicle.id, name: String(vehicle.name || vehicle.id) }));
}

export function faultsForVehicle(faults, vehicleId) {
  return (Array.isArray(faults) ? faults : []).filter(fault =>
    fault && fault.vehicle_id === vehicleId);
}
