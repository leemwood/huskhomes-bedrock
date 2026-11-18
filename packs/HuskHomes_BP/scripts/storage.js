/**
 * @typedef {{dimension: string, x: number, y: number, z: number, pitch: number, yaw: number}} Location
 * @typedef {{key: string, name: string, description: string, public: boolean, location: Location}} Home
 * @typedef {{v: number, id: string, name: string, homes: Home[], history: Location[],
 * back?: Location, death?: Location, requestsEnabled: boolean, lastTeleportAt: number}} Profile
 */
export const PLAYER_PREFIX = "hh:player/";
const GLOBAL_KEY = "hh:global";
const IDENTITY_KEY = "hh:identity";

export function validLocation(location) {
  return location && typeof location.dimension === "string" && location.dimension.length <= 128
    && [location.x, location.y, location.z, location.pitch, location.yaw].every(Number.isFinite)
    && Math.abs(location.x) < 29999984 && Math.abs(location.z) < 29999984
    && location.y >= -2048 && location.y < 2048
    && Math.abs(location.pitch) <= 90 && Math.abs(location.yaw) <= 360;
}

export function nameKey(value) { return value.normalize("NFKC").toLowerCase(); }

export function cleanName(value, config) {
  const name = String(value ?? "").normalize("NFKC").trim();
  if (!name || name.length > config.nameMaxLength || !/^[\p{L}\p{N}_ -]+$/u.test(name)) {
    throw new Error(`名称需为 1–${config.nameMaxLength} 个汉字、字母、数字、空格、下划线或短横线。`);
  }
  return name;
}

export function cleanDescription(value, config) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f§]/g, "").slice(0, config.descriptionMaxLength);
}

/** @param {import('@minecraft/server').Player} player @returns {Location} */
export function capture(player) {
  const rotation = player.getRotation();
  return { dimension: player.dimension.id, ...player.location, pitch: rotation.x, yaw: rotation.y };
}

function validHome(home) {
  return home && typeof home.key === "string" && typeof home.name === "string"
    && nameKey(home.name) === home.key && typeof home.description === "string"
    && typeof home.public === "boolean" && validLocation(home.location);
}

function validProfile(profile) {
  return profile && profile.v === 1 && typeof profile.id === "string" && typeof profile.name === "string"
    && Array.isArray(profile.homes) && profile.homes.length <= 100 && profile.homes.every(validHome)
    && new Set(profile.homes.map(home => home.key)).size === profile.homes.length
    && Array.isArray(profile.history) && profile.history.length <= 100 && profile.history.every(validLocation)
    && (!profile.back || validLocation(profile.back)) && (!profile.death || validLocation(profile.death))
    && typeof profile.requestsEnabled === "boolean" && Number.isFinite(profile.lastTeleportAt);
}

export class HomesStore {
  /** @param {import('@minecraft/server').World} world */
  constructor(world) {
    this.world = world;
    /** @type {Map<string, Profile>} */
    this.profiles = new Map();
    this.corrupt = new Set();
    this.globalCorrupt = false;
    /** @type {{v: number, warps: Home[], spawn?: Location}} */
    this.global = { v: 1, warps: [] };
    for (const key of world.getDynamicPropertyIds()) {
      if (!key.startsWith(PLAYER_PREFIX)) continue;
      try {
        const value = JSON.parse(String(world.getDynamicProperty(key)));
        if (!validProfile(value) || key !== PLAYER_PREFIX + value.id) throw new Error("invalid profile");
        this.profiles.set(value.id, value);
      } catch (error) {
        this.corrupt.add(key.slice(PLAYER_PREFIX.length));
        console.error(`[HuskHomes] 玩家数据损坏，保留原数据：${key}: ${error}`);
      }
    }
    const raw = world.getDynamicProperty(GLOBAL_KEY);
    if (raw !== undefined) {
      try {
        const value = JSON.parse(String(raw));
        if (value.v !== 1 || !Array.isArray(value.warps) || value.warps.length > 100
          || !value.warps.every(validHome) || (value.spawn && !validLocation(value.spawn))) throw new Error("invalid globals");
        this.global = value;
      } catch (error) {
        this.globalCorrupt = true;
        console.error(`[HuskHomes] 公共数据损坏，保留原数据：${error}`);
      }
    }
  }

  /** @param {import('@minecraft/server').Player} player */
  identity(player) {
    let id = player.getDynamicProperty(IDENTITY_KEY);
    if (typeof id !== "string") {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      player.setDynamicProperty(IDENTITY_KEY, id);
    }
    return id;
  }

  /** @param {import('@minecraft/server').Player} player @returns {Profile} */
  profile(player) {
    const id = this.identity(player);
    if (this.corrupt.has(id)) throw new Error("你的传送数据无法读取，请联系管理员恢复备份。");
    let profile = this.profiles.get(id);
    if (!profile) {
      profile = { v: 1, id, name: player.name, homes: [], history: [], requestsEnabled: true, lastTeleportAt: 0 };
      this.save(profile);
    } else if (profile.name !== player.name) {
      profile = { ...profile, name: player.name };
      this.save(profile);
    }
    return profile;
  }

  /** @param {Profile} profile */
  save(profile) {
    if (this.corrupt.has(profile.id) || !validProfile(profile)) throw new Error("传送数据无效，未覆盖存档。");
    const data = JSON.stringify(profile);
    if (data.length > 10000) throw new Error("传送数据达到容量上限，请删除部分记录。");
    // Worst-case UTF-8 is <= 30 KB; write before changing the in-memory cache.
    this.world.setDynamicProperty(PLAYER_PREFIX + profile.id, data);
    this.profiles.set(profile.id, JSON.parse(data));
  }

  saveGlobal(value) {
    if (this.globalCorrupt) throw new Error("公共数据损坏，请先恢复备份。");
    const data = JSON.stringify(value);
    if (data.length > 10000) throw new Error("公共传送点达到存储容量上限。");
    this.world.setDynamicProperty(GLOBAL_KEY, data);
    this.global = JSON.parse(data);
  }

  publicHomes() {
    const result = [];
    for (const profile of this.profiles.values()) {
      for (const home of profile.homes) if (home.public) result.push({ owner: profile.id, ownerName: profile.name, ...home });
    }
    return result.sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.name.localeCompare(b.name));
  }
}
