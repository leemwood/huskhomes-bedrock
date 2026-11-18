import { validLocation } from "./storage.js";

const DANGERS = new Set([
  "minecraft:lava", "minecraft:flowing_lava", "minecraft:fire", "minecraft:soul_fire",
  "minecraft:magma", "minecraft:cactus", "minecraft:campfire", "minecraft:soul_campfire",
  "minecraft:sweet_berry_bush", "minecraft:powder_snow", "minecraft:portal",
  "minecraft:end_portal", "minecraft:end_gateway", "minecraft:wither_rose",
]);

const PASSABLE = new Set([
  "short_grass", "tall_grass", "fern", "large_fern", "deadbush", "vine", "glow_lichen",
  "dandelion", "poppy", "blue_orchid", "allium", "azure_bluet", "oxeye_daisy", "cornflower",
  "lily_of_the_valley", "sunflower", "lilac", "rose_bush", "peony", "double_plant",
  "torchflower", "pink_petals", "wildflowers", "leaf_litter", "firefly_bush",
  "brown_mushroom", "red_mushroom", "crimson_roots", "warped_roots", "nether_sprouts",
  "crimson_fungus", "warped_fungus", "torch", "wall_torch", "soul_torch", "soul_wall_torch",
  "redstone_torch", "unlit_redstone_torch", "copper_torch", "redstone_wire", "tripwire",
].map(id => `minecraft:${id}`));
const isOverlay = block => block.typeId === "minecraft:snow_layer" || block.typeId.endsWith("_carpet");
const empty = block => block && !block.isLiquid && !block.isWaterlogged && !DANGERS.has(block.typeId)
  && (block.isAir || block.typeId.startsWith("minecraft:light_block_") || PASSABLE.has(block.typeId)
    || /^minecraft:.*_(sapling|tulip)$/.test(block.typeId));

// Preview 26.70.26 wraps a full block's top face to 0, while partial surfaces retain their fraction.
function topHeight(hit) {
  if (!hit || hit.face !== "Up") return undefined;
  const fraction = hit.faceLocation.y;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return undefined;
  return hit.block.y + (fraction < 0.0001 ? 1 : fraction);
}

/** @typedef {{location?: import('./storage.js').Location, error?: string}} SearchResult */

export class SafeDestinations {
  /** @param {import('@minecraft/server').World} world @param {import('@minecraft/server').System} system */
  constructor(world, system, config) {
    this.world = world;
    this.system = system;
    this.config = config;
    this.loads = 0;
    this.sequence = 0;
    this.nextLoadTick = 0;
    this.retained = new Map();
    // Script ticking areas belong to this pack only; recover leftovers from interrupted loads.
    for (const area of world.tickingAreaManager.getAllTickingAreas()) {
      if (area.identifier.startsWith("hh_load_")) world.tickingAreaManager.removeTickingArea(area);
    }
  }

  wait(ticks) { return new Promise(resolve => this.system.runTimeout(() => resolve(undefined), ticks)); }

  retain(id) {
    const timer = this.system.runTimeout(() => {
      this.retained.delete(id);
      try { this.world.tickingAreaManager.removeTickingArea(id); } catch { /* already removed */ }
    }, this.config.arrivalHoldTicks);
    this.retained.set(id, timer);
  }

  /** @param {string} dimensionId @param {{x: number,y: number,z: number}} at
   * @param {(dimension: import('@minecraft/server').Dimension) => import('./storage.js').Location | undefined} operation
   * @returns {Promise<SearchResult>} */
  async withLoaded(dimensionId, at, operation, valid = () => true) {
    let id;
    let expired = false;
    let settled = false;
    let released = false;
    const release = () => { if (!released) { released = true; this.loads--; } };
    let timeout;
    let retained = false;
    try {
      if (!valid()) return {};
      const dimension = this.world.getDimension(dimensionId);
      const margin = Math.max(this.config.safeSearchRadius + 1, this.config.arrivalPreloadRadiusChunks * 16);
      const from = { x: Math.floor(at.x / 16) * 16 - margin, y: dimension.heightRange.min, z: Math.floor(at.z / 16) * 16 - margin };
      const to = { x: Math.floor(at.x / 16) * 16 + 15 + margin, y: dimension.heightRange.min, z: Math.floor(at.z / 16) * 16 + 15 + margin };
      let loaded = true;
      for (let cx = Math.floor(from.x / 16); cx <= Math.floor(to.x / 16); cx++) {
        for (let cz = Math.floor(from.z / 16); cz <= Math.floor(to.z / 16); cz++) {
          if (!dimension.isChunkLoaded({ x: cx * 16, y: from.y, z: cz * 16 })) loaded = false;
        }
      }
      if (loaded) return { location: operation(dimension) };
      if (this.loads >= this.config.maxConcurrentChunkLoads || this.retained.size >= this.config.maxRetainedChunkAreas) {
        return { error: "传送区块正在加载，请稍后重试。" };
      }
      this.loads++;
      id = `hh_load_${++this.sequence}`;
      const delay = this.nextLoadTick - this.system.currentTick;
      if (delay > 0) await this.wait(delay);
      if (!valid()) return {};
      this.nextLoadTick = this.system.currentTick + this.config.chunkLoadSpacingTicks;
      const loading = this.world.tickingAreaManager.createTickingArea(id, {
        dimension, from, to,
      });
      // Handle native rejection immediately; expected failures are values, not rejected promises.
      const finish = () => {
        settled = true;
        if (expired) {
          release();
          try { if (id) this.world.tickingAreaManager.removeTickingArea(id); } catch { /* already removed */ }
        }
      };
      const ready = loading.then(() => { finish(); return { ready: true }; }, error => {
        finish(); return { error: `目标区块加载失败：${error instanceof Error ? error.message : String(error)}` };
      });
      const result = await Promise.race([ready, new Promise(resolve => {
        timeout = this.system.runTimeout(() => {
          expired = true;
          resolve({ error: "目标区块加载超时，请稍后再试。" });
        }, this.config.chunkLoadTimeoutTicks);
      })]);
      if (!result.ready) return { error: result.error };
      // Let chunk activation finish before reading terrain or moving an entity into the new area.
      await this.wait(this.config.chunkSettleTicks);
      if (!valid()) return {};
      const location = operation(dimension);
      if (location) { this.retain(id); retained = true; }
      return { location };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timeout !== undefined) this.system.clearRun(timeout);
      // A timed-out native load still occupies a slot until its promise settles.
      if (id) {
        if (!expired || settled) release();
        if (!retained) try { this.world.tickingAreaManager.removeTickingArea(id); } catch { /* already removed */ }
      }
    }
  }

  /** @param {import('@minecraft/server').Dimension} dimension */
  landing(dimension, x, y, z) {
    try {
      if (y < dimension.heightRange.min + 1 || y + 1 >= dimension.heightRange.max) return undefined;
      const supports = new Set();
      let top = -Infinity;
      // The four corners prevent stairs and narrow shapes clipping the player's 0.6-block footprint.
      for (const [ox, oz] of [[0.5, 0.5], [0.2, 0.2], [0.2, 0.8], [0.8, 0.2], [0.8, 0.8]]) {
        const ray = dimension.getBlockFromRay({ x: x + ox, y: y + 0.01, z: z + oz }, { x: 0, y: -1, z: 0 }, {
          maxDistance: 2.1, includeLiquidBlocks: false, includePassableBlocks: false,
        });
        const height = topHeight(ray);
        if (height === undefined || height > y + 0.001 || height < y - 1.001
          || !ray || ray.block.isLiquid || DANGERS.has(ray.block.typeId)) return undefined;
        supports.add(ray.block.y);
        top = Math.max(top, height);
      }
      // Native collision-only rays omit carpets/snow. Query their measured outline separately.
      const overlay = dimension.getBlock({ x, y: Math.floor(top + 0.001), z });
      if (overlay && isOverlay(overlay)) {
        const hit = dimension.getBlockFromRay({ x: x + 0.5, y: overlay.y + 1.01, z: z + 0.5 }, { x: 0, y: -1, z: 0 }, {
          maxDistance: 1.1, includeLiquidBlocks: false, includePassableBlocks: true, includeTypes: [overlay.typeId],
        });
        const height = topHeight(hit);
        if (height === undefined || hit?.block.y !== overlay.y) return undefined;
        top = Math.max(top, height); supports.add(overlay.y);
      }
      if (top + 1.8 >= dimension.heightRange.max) return undefined;
      for (let by = Math.floor(top + 0.001); by <= Math.floor(top + 1.8 - 0.001); by++) {
        const block = dimension.getBlock({ x, y: by, z });
        if (!block || block.isLiquid || block.isWaterlogged || DANGERS.has(block.typeId)) return undefined;
        if (supports.has(by) && by < top - 0.001) continue;
        if (!empty(block)) return undefined;
      }
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        for (let by = Math.floor(top); by <= Math.floor(top + 1.8 - 0.001); by++) {
          const block = dimension.getBlock({ x: x + dx, y: by, z: z + dz });
          if (!block || DANGERS.has(block.typeId)) return undefined;
        }
      }
      return top;
    } catch { return undefined; }
  }

  /** @returns {Promise<SearchResult>} */
  resolve(destination, arrive = location => {}) {
    if (!validLocation(destination)) return Promise.resolve({ error: "目标坐标无效。" });
    return this.withLoaded(destination.dimension, destination, dimension => {
      const x = Math.floor(destination.x), y = Math.ceil(destination.y), z = Math.floor(destination.z);
      const candidates = [];
      for (let dx = -this.config.safeSearchRadius; dx <= this.config.safeSearchRadius; dx++) {
        for (let dz = -this.config.safeSearchRadius; dz <= this.config.safeSearchRadius; dz++) {
          for (let dy = -this.config.safeSearchHeight; dy <= this.config.safeSearchHeight; dy++) candidates.push({ dx, dy, dz });
        }
      }
      candidates.sort((a, b) => a.dx ** 2 + a.dy ** 2 + a.dz ** 2 - b.dx ** 2 - b.dy ** 2 - b.dz ** 2);
      for (const { dx, dy, dz } of candidates) {
        const top = this.landing(dimension, x + dx, y + dy, z + dz);
        if (top === undefined) continue;
        const location = { ...destination, x: x + dx + 0.5, y: top, z: z + dz + 0.5 };
        arrive(location);
        return location;
      }
      return undefined;
    });
  }

  surface(dimensionId, x, z, valid = () => true) {
    return this.withLoaded(dimensionId, { x, y: 64, z }, dimension => {
      // Reuse the same loaded region before asking the engine to generate another distant one.
      for (const [dx, dz] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4], [8, 8], [-8, 8], [8, -8], [-8, -8]]) {
        const bx = Math.floor(x) + dx, bz = Math.floor(z) + dz;
        const block = dimension.getTopmostBlock({ x: bx, z: bz });
        if (!block) continue;
        const top = this.landing(dimension, bx, block.y + 1, bz);
        if (top !== undefined) return { dimension: dimensionId, x: bx + 0.5, y: top, z: bz + 0.5, pitch: 0, yaw: 0 };
      }
      return undefined;
    }, valid);
  }
}
