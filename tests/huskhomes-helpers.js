import { HomesStore } from "../packs/HuskHomes_BP/scripts/storage.js";
import { HomesService } from "../packs/HuskHomes_BP/scripts/service.js";
import { SafeDestinations } from "../packs/HuskHomes_BP/scripts/safety.js";
import { HomesForms } from "../packs/HuskHomes_BP/scripts/forms.js";
import { CONFIG } from "../packs/HuskHomes_BP/scripts/config.js";

export const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

export function homesRuntime(overrides = {}) {
  const config = { ...CONFIG, ...overrides };
  const properties = new Map(), dimensions = new Map(), events = new Map(), timers = new Map();
  const players = [], registry = new Map(), formLog = [], responses = [];
  const areas = new Map();
  let now = 1000000, tick = 0, sequence = 0, timerSequence = 0, failWrites = 0;
  let loadPromise;
  const signal = name => ({ subscribe(callback) {
    if (!events.has(name)) events.set(name, []);
    events.get(name).push(callback);
  } });
  const emit = (name, event) => { for (const callback of events.get(name) ?? []) callback(event); };
  const chunkKey = point => `${Math.floor(point.x / 16)},${Math.floor(point.z / 16)}`;
  class Dimension {
    constructor(id) {
      this.id = id; this.heightRange = { min: -64, max: 320 };
      this.overrides = new Map(); this.unloaded = new Set(); this.reads = 0;
      this.states = new Map(); this.waterlogged = new Set();
    }
    isChunkLoaded(point) { return !this.unloaded.has(chunkKey(point)); }
    getBlock(point) {
      this.reads++;
      if (!this.isChunkLoaded(point)) throw new Error("unloaded");
      const x = Math.floor(point.x), y = Math.floor(point.y), z = Math.floor(point.z);
      const typeId = this.overrides.get(`${x},${y},${z}`) ?? (y <= 63 ? "minecraft:stone" : "minecraft:air");
      const states = this.states.get(`${x},${y},${z}`) ?? {};
      return { typeId, x, y, z, location: { x,y,z }, isAir: typeId === "minecraft:air", isLiquid: /water|lava/.test(typeId),
        isWaterlogged: this.waterlogged.has(`${x},${y},${z}`), permutation: { getState: name => states[name] } };
    }
    getBlockFromRay(point, direction, options = {}) {
      for (let y = Math.floor(point.y); y >= Math.floor(point.y - (options.maxDistance ?? 10)); y--) {
        const block = this.getBlock({ x: point.x, y, z: point.z });
        if (block.isAir || block.isLiquid || block.typeId.includes("light_block")) continue;
        if (options.includeTypes && !options.includeTypes.includes(block.typeId)) continue;
        const passable = /carpet|snow_layer|flower|short_grass|tall_grass|torch/.test(block.typeId);
        if (passable && !options.includePassableBlocks) continue;
        let height = 1;
        if (block.typeId.includes("slab")) height = block.permutation.getState("top_slot_bit") ? 1 : 0.5;
        if (block.typeId.includes("stairs")) height = point.x - Math.floor(point.x) < 0.5 ? 0.5 : 1;
        if (/farmland|grass_path/.test(block.typeId)) height = 15 / 16;
        if (block.typeId.endsWith("_carpet")) height = 1 / 16;
        if (block.typeId.includes("snow_layer")) height = ((block.permutation.getState("height") ?? 0) + 1) / 8;
        const top = y + height;
        if (top > point.y || point.y - top > (options.maxDistance ?? 10)) continue;
        // Match the actual Preview native API: integer top faces wrap to 0.
        return { block, face: "Up", faceLocation: { x: 0.5, y: height === 1 ? 0 : height, z: 0.5 } };
      }
      return undefined;
    }
    getTopmostBlock(point) {
      for (let y = 80; y >= 63; y--) {
        const block = this.getBlock({ x: point.x, y, z: point.z });
        if (!block.isAir) return block;
      }
    }
  }
  for (const id of ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"]) dimensions.set(id, new Dimension(id));
  const tickingAreaManager = {
    getAllTickingAreas() { return [...areas.values()]; },
    async createTickingArea(identifier, options) {
      if (loadPromise) await loadPromise;
      const { from, to, dimension } = options;
      for (let x = Math.floor(from.x / 16); x <= Math.floor(to.x / 16); x++) {
        for (let z = Math.floor(from.z / 16); z <= Math.floor(to.z / 16); z++) dimension.unloaded.delete(`${x},${z}`);
      }
      areas.set(identifier, { identifier, ...options });
    },
    removeTickingArea(area) { areas.delete(typeof area === "string" ? area : area.identifier); },
  };
  const world = {
    tickingAreaManager,
    afterEvents: Object.fromEntries(["playerSpawn", "itemUse", "entityHurt", "entityDie", "playerLeave"].map(name => [name, signal(name)])),
    getAllPlayers() { return players.filter(player => player.isValid); },
    getDynamicPropertyIds() { return [...properties.keys()]; },
    getDynamicProperty(key) { return properties.get(key); },
    setDynamicProperty(key, value) {
      if (failWrites-- > 0) throw new Error("persistence failure");
      if (value === undefined) properties.delete(key); else properties.set(key, value);
    },
    getDimension(id) { if (!dimensions.has(id)) throw new Error("invalid dimension"); return dimensions.get(id); },
    getDefaultSpawnLocation() { return { x: 0, y: 32767, z: 0 }; },
  };
  const system = {
    currentTick: 0,
    beforeEvents: { startup: signal("startup") },
    run(callback) { return this.runTimeout(callback, 1); },
    runTimeout(callback, delay = 1) { const id = ++timerSequence; timers.set(id, { callback, at: tick + delay }); return id; },
    runInterval(callback, interval) { const id = ++timerSequence; timers.set(id, { callback, at: tick + interval, interval }); return id; },
    clearRun(id) { timers.delete(id); },
  };
  class Form {
    constructor() { this.fields = []; this.buttons = []; }
    title(text) { this.titleText = text; return this; }
    body(text) { this.bodyText = text; return this; }
    button(text) { this.buttons.push(text); return this; }
    button1(text) { this.buttons[0] = text; return this; }
    button2(text) { this.buttons[1] = text; return this; }
    textField(...args) { this.fields.push(["text", ...args]); return this; }
    toggle(...args) { this.fields.push(["toggle", ...args]); return this; }
    submitButton(text) { this.submitText = text; return this; }
    async show(player) {
      formLog.push({ form: this, player });
      const next = responses.shift() ?? { canceled: true, cancelationReason: "UserClosed" };
      return typeof next === "function" ? next(this, player) : next;
    }
  }
  const builders = { action: () => new Form(), modal: () => new Form(), message: () => new Form() };
  const store = new HomesStore(world);
  const safety = new SafeDestinations(world, system, config);
  const service = new HomesService(world, store, safety, config, () => now);
  const forms = new HomesForms(service, system, config, builders);
  const native = {
    world, system,
    CustomCommandStatus: { Success: 0, Failure: 1 }, CustomCommandParamType: { String: "String" },
    CommandPermissionLevel: { Any: 0, GameDirectors: 1 },
  };
  const ui = { ActionFormData: Form, ModalFormData: Form, MessageFormData: Form };
  return {
    world, system, config, store, safety, service, forms, properties, players, dimensions, registry,
    areas, formLog, responses, builders, emit, native, ui,
    failWrites(count = 1) { failWrites = count; },
    delayLoads(promise) { loadPromise = promise; },
    advance(milliseconds) { now += milliseconds; },
    async step(count = 1) {
      for (let i = 0; i < count; i++) {
        now += 50; tick++; system.currentTick = tick;
        for (const [id, timer] of [...timers]) if (timer.at <= tick) {
          if (timer.interval) timer.at += timer.interval; else timers.delete(id);
          timer.callback();
        }
        service.tick(); await flush();
      }
    },
    start() { emit("startup", { customCommandRegistry: { registerCommand(definition, callback) {
      registry.set(definition.name, { definition, callback });
    } } }); },
    player(name = "玩家", admin = false, at = { x: 0.5, y: 64, z: 0.5 }) {
      const dynamic = new Map();
      const player = {
        name, id: `player-${++sequence}`, typeId: "minecraft:player", isValid: true, health: 20,
        location: { ...at }, dimension: dimensions.get("minecraft:overworld"), rotation: { x: 0, y: 0 },
        messages: [], actionBars: [], teleports: [], teleportResult: true, isSneaking: false,
        playerPermissionLevel: admin ? 2 : 1, commandPermissionLevel: admin ? 1 : 0,
        getComponent(id) { return id === "minecraft:health" ? { currentValue: this.health } : undefined; },
        getGameMode() { return "Survival"; },
        getRotation() { return { ...this.rotation }; },
        getDynamicProperty(key) { return dynamic.get(key); },
        setDynamicProperty(key, value) { dynamic.set(key, value); },
        sendMessage(message) { this.messages.push(message); },
        onScreenDisplay: { setActionBar(text) { player.actionBars.push(text); } },
        tryTeleport(at, options) {
          if (!this.teleportResult) return false;
          this.teleports.push({ at, options });
          this.location = { ...at }; this.dimension = options.dimension; this.rotation = options.rotation;
          return true;
        },
      };
      players.push(player); return player;
    },
  };
}
