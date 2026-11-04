import type { LegacyInventorySource } from '../../ports/control-store';
import type { WorkspaceLimits } from '../../domain';
/** Inventory is an explicit read-only operation; it grants no storage publication authority. */
export const inventoryLegacy = (source: LegacyInventorySource, limits: Partial<WorkspaceLimits> = {}) => source.inspect(limits);
