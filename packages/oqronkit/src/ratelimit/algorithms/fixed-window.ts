import type { IStorageEngine } from "../../engine/types/engine.js";
import type { AlgorithmResult, IRateLimitAlgorithm } from "../types.js";

/**
 * Fixed Window Rate Limit Algorithm
 *
 * Stores a single counter per window ID (integer derived from
 * `Math.floor(now / windowMs)`). When the window ID changes,
 * the counter resets to 0.
 *
 * This is the lowest-memory algorithm — one integer per key.
 * However, it is vulnerable to boundary bursts (requests clustered
 * at the end of one window and beginning of the next).
 */

interface FixedWindowState {
	windowId: number;
	count: number;
}

const NAMESPACE = "ratelimit:fixed";

export class FixedWindowAlgorithm implements IRateLimitAlgorithm {
	async consume(
		storage: IStorageEngine,
		storageKey: string,
		max: number,
		windowMs: number,
		cost: number,
	): Promise<AlgorithmResult> {
		const now = Date.now();
		const currentWindowId = Math.floor(now / windowMs);

		// Load or initialize
		let state = await storage.get<FixedWindowState>(NAMESPACE, storageKey);
		if (!state || state.windowId !== currentWindowId) {
			state = { windowId: currentWindowId, count: 0 };
		}

		// Calculate reset time (end of current window)
		const resetMs = (currentWindowId + 1) * windowMs - now;

		// Check capacity
		if (state.count + cost > max) {
			return {
				allowed: false,
				current: state.count,
				resetMs,
			};
		}

		// Consume
		state.count += cost;
		await storage.save(NAMESPACE, storageKey, {
			...state,
			createdAt: now + resetMs,
		});

		return {
			allowed: true,
			current: state.count,
			resetMs,
		};
	}

	async peek(
		storage: IStorageEngine,
		storageKey: string,
		_max: number,
		windowMs: number,
	): Promise<{ current: number; resetMs: number }> {
		const now = Date.now();
		const currentWindowId = Math.floor(now / windowMs);

		const state = await storage.get<FixedWindowState>(
			NAMESPACE,
			storageKey,
		);
		if (!state || state.windowId !== currentWindowId) {
			// No data for this window = 0 usage
			const resetMs = (currentWindowId + 1) * windowMs - now;
			return { current: 0, resetMs };
		}

		const resetMs = (currentWindowId + 1) * windowMs - now;
		return { current: state.count, resetMs };
	}
}
