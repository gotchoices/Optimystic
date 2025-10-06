import type { IRawStorage } from './i-raw-storage.js';

export interface StorageCapacity {
	total: number;
	used: number;
	available: number;
}

export interface StorageMonitorConfig {
	totalBytes?: number;
	usedBytes?: number;
	availableBytes?: number;
}

/**
 * Monitors storage capacity for ring selection.
 * Provides estimates based on storage backend or supplied overrides.
 */
export class StorageMonitor {
	constructor(
		private readonly storage: IRawStorage,
		private readonly config: StorageMonitorConfig = {}
	) {}

	async getCapacity(): Promise<StorageCapacity> {
		const defaultTotal = 10 * 1024 * 1024 * 1024; // 10GB default
		const total = this.config.totalBytes ?? defaultTotal;
		const usedOverride = this.config.usedBytes;
		const availableOverride = this.config.availableBytes;

		if (
			usedOverride !== undefined ||
			availableOverride !== undefined ||
			this.config.totalBytes !== undefined
		) {
			const used = usedOverride ?? Math.max(0, total - (availableOverride ?? total));
			const available = availableOverride ?? Math.max(0, total - used);
			return {
				total,
				used: Math.min(total, Math.max(0, used)),
				available: Math.max(0, Math.min(total, available))
			};
		}

		const used = await this.estimateUsedSpace();
		const available = Math.max(0, total - used);

		return {
			total,
			used,
			available
		};
	}

	private async estimateUsedSpace(): Promise<number> {
		return 0; // TODO: Implement actual space calculation
	}
}

