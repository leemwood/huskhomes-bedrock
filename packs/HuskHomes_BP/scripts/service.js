import { capture, cleanName, cleanDescription, nameKey } from "./storage.js";

/** @typedef {import('@minecraft/server').Player} Player */
/** @typedef {import('./storage.js').Location} Location */
/** @typedef {{id: string, from: string, to: string, here: boolean, expires: number}} Request */
/** @typedef {{player: Player, origin: Location, due: number, label: string,
 * destination: () => Promise<Location | undefined> | Location | undefined, valid: () => boolean, participants: string[],
 * canceled: boolean, loading: boolean, lastSeconds: number}} Journey */

export class HomesService {
  /** @param {import('@minecraft/server').World} world
   * @param {import('./storage.js').HomesStore} store
   * @param {import('./safety.js').SafeDestinations} safety */
  constructor(world, store, safety, config, now = () => Date.now()) {
    this.world = world;
    this.store = store;
    this.safety = safety;
    this.config = config;
    this.now = now;
    /** @type {Map<string, Journey>} */
    this.journeys = new Map();
    /** @type {Map<string, Request>} */
    this.requests = new Map();
    this.combat = new Map();
    this.requestCooldowns = new Map();
    this.requestSequence = 0;
    this.lifeEpochs = new Map();
    /** @type {Journey | undefined} */
    this.randomJob = undefined;
    this.randomCooldowns = new Map();
    this.nextRandomAt = 0;
    /** @type {(player: Player, request: Request) => void} */
    this.onRequest = () => {};
  }

  tell(player, text) {
    try { if (player?.isValid) player.sendMessage(`§6[家与传送]§r ${text}`); } catch { /* disconnected */ }
  }

  admin(player) {
    return player.playerPermissionLevel === 2 || player.commandPermissionLevel >= 1;
  }

  requireAdmin(player) {
    if (!this.admin(player)) throw new Error("只有管理员可以管理公共传送点。");
  }

  online(id) {
    return this.world.getAllPlayers().find(player => player.id === id);
  }

  findPlayer(name) {
    const player = this.world.getAllPlayers().find(player => nameKey(player.name) === nameKey(String(name)));
    if (!player) throw new Error("找不到这名在线玩家，请使用完整玩家名。");
    return player;
  }

  usable(player) {
    if (!player.isValid || (player.getComponent("minecraft:health")?.currentValue ?? 0) <= 0
      || player.getGameMode() === "Spectator") throw new Error("当前状态无法传送。");
  }

  setHome(player, input = "home", description = "", publicly = false) {
    this.usable(player);
    const profile = this.store.profile(player);
    const name = cleanName(input, this.config);
    const key = nameKey(name);
    if (profile.homes.some(home => home.key === key)) throw new Error("已有同名的家，请在表单里编辑或更新位置。");
    const limit = this.admin(player) ? this.config.maxAdminHomes : this.config.maxHomes;
    if (profile.homes.length >= limit) throw new Error(`最多可保存 ${limit} 个家。`);
    const home = { key, name, description: cleanDescription(description, this.config), public: !!publicly, location: capture(player) };
    this.store.save({ ...profile, homes: [...profile.homes, home] });
    this.tell(player, `已保存家「${name}」。`);
  }

  editHome(player, key, input, description, publicly, relocate = false) {
    this.usable(player);
    const profile = this.store.profile(player);
    const home = profile.homes.find(home => home.key === key);
    if (!home) throw new Error("这个家已不存在。");
    const name = cleanName(input, this.config);
    const nextKey = nameKey(name);
    if (profile.homes.some(other => other.key === nextKey && other.key !== key)) throw new Error("已有同名的家。");
    const next = {
      ...home, key: nextKey, name, description: cleanDescription(description, this.config), public: !!publicly,
      location: relocate ? capture(player) : home.location,
    };
    this.store.save({ ...profile, homes: profile.homes.map(other => other.key === key ? next : other) });
    this.tell(player, `已更新家「${name}」。`);
  }

  deleteHome(player, name) {
    const profile = this.store.profile(player), key = nameKey(name);
    if (!profile.homes.some(home => home.key === key)) throw new Error("找不到这个家。");
    this.store.save({ ...profile, homes: profile.homes.filter(home => home.key !== key) });
    this.tell(player, "已删除这个家。");
  }

  home(player, name = "home") {
    const home = this.store.profile(player).homes.find(home => home.key === nameKey(name));
    if (!home) throw new Error("找不到这个家，可使用 /hh:homes 查看。");
    this.begin(player, () => {
      const current = this.store.profile(player).homes.find(other => other.key === home.key);
      if (!current) throw new Error("这个家已被删除。");
      return current.location;
    }, `家：${home.name}`);
  }

  publicHome(player, owner, key) {
    const available = () => this.store.profiles.get(owner)?.homes.find(home => home.key === key && home.public);
    const home = available();
    if (!home) throw new Error("这个家已取消公开或被删除。");
    this.begin(player, () => {
      const current = available();
      if (!current) throw new Error("这个家已取消公开或被删除。");
      return current.location;
    }, `公开家：${home.name}`, () => !!available());
  }

  setWarp(player, input) {
    this.requireAdmin(player); this.usable(player);
    const name = cleanName(input, this.config), key = nameKey(name);
    if (this.store.global.warps.some(warp => warp.key === key)) throw new Error("已有同名传送点，请先删除再设置。");
    if (this.store.global.warps.length >= this.config.maxWarps) throw new Error("公共传送点已达到数量上限。");
    const warp = { key, name, description: "", public: true, location: capture(player) };
    this.store.saveGlobal({ ...this.store.global, warps: [...this.store.global.warps, warp] });
    this.tell(player, `已创建公共传送点「${name}」。`);
  }

  deleteWarp(player, name) {
    this.requireAdmin(player); const key = nameKey(name);
    if (!this.store.global.warps.some(warp => warp.key === key)) throw new Error("找不到这个传送点。");
    this.store.saveGlobal({ ...this.store.global, warps: this.store.global.warps.filter(warp => warp.key !== key) });
    this.tell(player, "已删除公共传送点。");
  }

  warp(player, name) {
    const key = nameKey(name);
    this.begin(player, () => {
      const warp = this.store.global.warps.find(warp => warp.key === key);
      if (!warp) throw new Error("找不到这个公共传送点。");
      return warp.location;
    }, `公共传送点：${name}`);
  }

  setSpawn(player) {
    this.requireAdmin(player); this.usable(player);
    this.store.saveGlobal({ ...this.store.global, spawn: capture(player) });
    this.tell(player, "已设置本插件的主城传送点。");
  }

  spawn(player) {
    this.begin(player, async () => {
      if (this.store.global.spawn) return this.store.global.spawn;
      const original = this.world.getDefaultSpawnLocation();
      const result = await this.safety.surface("minecraft:overworld", original.x, original.z);
      if (!result.location) this.tell(player, result.error ?? "世界出生点附近没有安全表面，请管理员使用 /hh:setspawn。");
      return result.location;
    }, "主城");
  }

  back(player, death = false) {
    const destination = death ? this.store.profile(player).death : this.store.profile(player).back;
    if (!destination) throw new Error(death ? "还没有记录死亡地点。" : "还没有可返回的地点。");
    this.begin(player, () => destination, death ? "死亡地点" : "上一地点");
  }

  random(player) {
    this.usable(player);
    if (this.randomJob) throw new Error("已有随机传送正在准备区块，请稍后再试。");
    const remaining = Math.max(this.nextRandomAt, this.randomCooldowns.get(player.id) ?? 0) - this.now();
    if (remaining > 0) throw new Error(`随机传送冷却还剩 ${Math.ceil(remaining / 1000)} 秒。`);
    const center = this.world.getDefaultSpawnLocation();
    this.begin(player, async () => {
      const active = this.journeys.get(player.id);
      const started = this.now();
      this.tell(player, "正在分批预加载随机落点，请稍候。可用 /hh:tpcancel 取消。");
      console.info(`[HuskHomes:RTP] 开始为 ${player.name} 准备随机落点。`);
      for (let attempt = 0; attempt < this.config.randomAttempts; attempt++) {
        if (this.journeys.get(player.id) !== active) return undefined;
        if (this.now() - started >= this.config.randomTimeoutSeconds * 1000) {
          this.tell(player, "随机落点准备超时，已停止继续生成区块。"); return undefined;
        }
        const radius = Math.sqrt(this.config.randomMinRadius ** 2
          + Math.random() * (this.config.randomMaxRadius ** 2 - this.config.randomMinRadius ** 2));
        const angle = Math.random() * Math.PI * 2;
        const result = await this.safety.surface("minecraft:overworld",
          Math.floor(center.x + Math.cos(angle) * radius), Math.floor(center.z + Math.sin(angle) * radius),
          () => this.journeys.get(player.id) === active);
        if (this.journeys.get(player.id) !== active) return undefined;
        if (this.now() - started >= this.config.randomTimeoutSeconds * 1000) {
          this.tell(player, "随机落点准备超时，已停止继续生成区块。"); return undefined;
        }
        console.info(`[HuskHomes:RTP] ${player.name} 第 ${attempt + 1} 次检查，用时 ${this.now() - started} ms，${result.location ? "找到落点" : result.error ?? "无安全地表"}。`);
        if (result.location) return result.location;
        if (result.error) { this.tell(player, result.error); return undefined; }
        if (attempt + 1 < this.config.randomAttempts) await this.safety.wait(this.config.randomAttemptDelayTicks);
      }
      this.tell(player, "本次未找到安全的随机地点，请重试。");
      return undefined;
    }, "主世界随机地点");
    this.randomJob = this.journeys.get(player.id);
    this.randomCooldowns.set(player.id, this.now() + this.config.randomCooldownSeconds * 1000);
    this.nextRandomAt = this.now() + this.config.randomGlobalCooldownSeconds * 1000;
  }

  toggle(player) {
    const profile = this.store.profile(player);
    const enabled = !profile.requestsEnabled;
    this.store.save({ ...profile, requestsEnabled: enabled });
    if (!enabled) {
      for (const [id, request] of this.requests) if (request.to === player.id) {
        this.requests.delete(id);
        this.tell(this.online(request.from), `${player.name} 已关闭传送请求。`);
      }
    }
    this.tell(player, enabled ? "已开启传送请求。" : "已关闭传送请求。");
  }

  incoming(player) {
    return [...this.requests.values()].filter(request => request.to === player.id && request.expires > this.now());
  }

  request(from, to, here = false) {
    this.usable(from); this.usable(to);
    if (from.id === to.id) throw new Error("不能向自己发送传送请求。");
    if (!this.store.profile(to).requestsEnabled) throw new Error("对方已关闭传送请求。");
    if ((this.requestCooldowns.get(from.id) ?? 0) > this.now()) throw new Error("发送过于频繁，请稍后再试。");
    this.expireRequests();
    if (this.incoming(to).length >= this.config.maxIncomingRequests) throw new Error("对方待处理请求过多。");
    for (const request of this.requests.values()) if (request.from === from.id && request.to === to.id) {
      throw new Error("你已经向对方发送了请求。");
    }
    // One outgoing request at a time prevents unrelated acceptance races.
    for (const [id, request] of this.requests) if (request.from === from.id) {
      this.requests.delete(id); this.tell(this.online(request.to), `${from.name} 已撤回之前的请求。`);
    }
    const request = {
      id: `request_${++this.requestSequence}`, from: from.id, to: to.id, here,
      expires: this.now() + this.config.requestLifetimeSeconds * 1000,
    };
    this.requests.set(request.id, request);
    this.requestCooldowns.set(from.id, this.now() + this.config.requestCooldownSeconds * 1000);
    this.tell(from, `已请求${here ? "让对方传送到你这里" : "传送到对方"}，${this.config.requestLifetimeSeconds} 秒内有效。`);
    this.tell(to, `${from.name} ${here ? "邀请你传送到 TA 身边" : "请求传送到你身边"}。打开 /hh:requests 处理。`);
    this.onRequest(to, request);
    return request;
  }

  accept(player, requestId) {
    const incoming = this.incoming(player);
    const request = requestId ? this.requests.get(requestId) : incoming[incoming.length - 1];
    if (!request || request.to !== player.id || request.expires <= this.now()) throw new Error("请求已失效。");
    if (!this.store.profile(player).requestsEnabled) throw new Error("你已关闭传送请求。");
    const from = this.online(request.from);
    if (!from) { this.requests.delete(request.id); throw new Error("对方已离线。"); }
    const traveler = request.here ? player : from;
    const anchor = request.here ? from : player;
    this.usable(anchor);
    this.begin(traveler, () => capture(anchor), `玩家：${anchor.name}`,
      () => !!this.online(from.id) && !!this.online(player.id)
        && (anchor.getComponent("minecraft:health")?.currentValue ?? 0) > 0
        && anchor.getGameMode() !== "Spectator" && this.store.profile(player).requestsEnabled, [from.id, player.id]);
    this.requests.delete(request.id);
    this.tell(player, "已接受传送请求。");
    this.tell(from, `${player.name} 已接受请求。`);
  }

  deny(player, requestId) {
    const incoming = this.incoming(player);
    const request = requestId ? this.requests.get(requestId) : incoming[incoming.length - 1];
    if (!request || request.to !== player.id) throw new Error("没有这个传送请求。");
    this.requests.delete(request.id);
    this.tell(this.online(request.from), `${player.name} 拒绝了传送请求。`);
    this.tell(player, "已拒绝传送请求。");
  }

  cancel(player) {
    let found = this.cancelJourney(player.id, "你取消了传送。");
    for (const [id, request] of this.requests) if (request.from === player.id) {
      this.requests.delete(id); found = true;
      this.tell(this.online(request.to), `${player.name} 已撤回传送请求。`);
    }
    this.tell(player, found ? "已取消。" : "当前没有待取消的传送或请求。");
  }

  expireRequests() {
    for (const [id, request] of this.requests) if (request.expires <= this.now()) {
      this.requests.delete(id);
      this.tell(this.online(request.from), "传送请求已过期。");
    }
    for (const [id, expires] of this.requestCooldowns) if (expires <= this.now()) this.requestCooldowns.delete(id);
    for (const [id, expires] of this.combat) if (expires <= this.now()) this.combat.delete(id);
    for (const [id, expires] of this.randomCooldowns) if (expires <= this.now()) this.randomCooldowns.delete(id);
  }

  /** @param {Player} player @param {() => Promise<Location | undefined> | Location | undefined} destination */
  begin(player, destination, label, valid = () => true, participants = [player.id]) {
    this.usable(player);
    if (this.journeys.has(player.id)) throw new Error("已有传送正在进行，可用 /hh:tpcancel 取消。");
    if ((this.combat.get(player.id) ?? 0) > this.now()) throw new Error("刚刚受到伤害或参与战斗，请稍后传送。");
    const profile = this.store.profile(player);
    const cooldown = profile.lastTeleportAt + this.config.cooldownSeconds * 1000 - this.now();
    if (cooldown > 0) throw new Error(`传送冷却还剩 ${Math.ceil(cooldown / 1000)} 秒。`);
    this.journeys.set(player.id, {
      player, destination, label, valid, participants, origin: capture(player),
      due: this.now() + this.config.warmupSeconds * 1000,
      canceled: false, loading: false, lastSeconds: -1,
    });
    this.tell(player, `${this.config.warmupSeconds} 秒后传送至「${label}」，请勿移动或受伤。`);
  }

  cancelJourney(id, reason) {
    const journey = this.journeys.get(id);
    if (!journey) return false;
    journey.canceled = true;
    this.journeys.delete(id);
    try { journey.player.onScreenDisplay.setActionBar(""); } catch { /* disconnected */ }
    this.tell(journey.player, reason);
    return true;
  }

  checkJourney(journey) {
    const player = journey.player;
    this.usable(player);
    if (journey.canceled || this.journeys.get(player.id) !== journey) throw new Error("传送已取消。");
    if (!journey.valid()) throw new Error("目标已不可用，传送已取消。");
    const position = player.location, origin = journey.origin;
    if (player.dimension.id !== origin.dimension
      || (position.x - origin.x) ** 2 + (position.y - origin.y) ** 2 + (position.z - origin.z) ** 2
        > this.config.cancelMovementDistance ** 2) throw new Error("移动导致传送取消。");
    if ((this.combat.get(player.id) ?? 0) > this.now()) throw new Error("受到伤害或进入战斗，传送取消。");
  }

  async complete(journey) {
    const player = journey.player;
    try {
      this.checkJourney(journey);
      const destination = await journey.destination();
      this.checkJourney(journey);
      if (!destination) return;
      const result = await this.safety.resolve(destination, safe => {
        this.checkJourney(journey);
        const original = this.store.profile(player);
        this.store.save({
          ...original, back: journey.origin,
          history: [journey.origin, ...original.history].slice(0, this.config.maxHistory),
          lastTeleportAt: this.now(),
        });
        try {
          if (!player.tryTeleport({ x: safe.x, y: safe.y, z: safe.z }, {
            dimension: this.world.getDimension(safe.dimension), checkForBlocks: true,
            rotation: { x: safe.pitch, y: safe.yaw }, keepVelocity: false,
            forceProvidedPositionOnDimensionChange: true,
          })) throw new Error("传送未成功，目标可能已被阻挡。");
          // Finish in the same native turn so the next tick cannot cancel our own teleport movement.
          if (this.journeys.get(player.id) === journey) {
            this.journeys.delete(player.id);
            try { player.onScreenDisplay.setActionBar(""); } catch { /* disconnected */ }
          }
        } catch (error) {
          this.store.save(original);
          throw error;
        }
      });
      if (!result.location) {
        if (!journey.canceled) this.tell(player, result.error ?? "目标附近没有安全落脚点，已取消传送。");
        return;
      }
      this.tell(player, `已到达「${journey.label}」。使用 /hh:back 返回。`);
    } catch (error) {
      if (!journey.canceled) this.tell(player, error instanceof Error ? error.message : String(error));
    } finally {
      if (this.randomJob === journey) this.randomJob = undefined;
      if (this.journeys.get(player.id) === journey) {
        this.journeys.delete(player.id);
        try { player.onScreenDisplay.setActionBar(""); } catch { /* disconnected */ }
      }
    }
  }

  tick() {
    this.expireRequests();
    for (const [id, journey] of this.journeys) {
      try {
        this.checkJourney(journey);
        if (!journey.loading && this.now() >= journey.due) {
          journey.loading = true;
          void this.complete(journey);
        } else if (!journey.loading) {
          const seconds = Math.ceil((journey.due - this.now()) / 1000);
          if (seconds !== journey.lastSeconds) {
            journey.lastSeconds = seconds;
            journey.player.onScreenDisplay.setActionBar(`传送倒计时 ${seconds} 秒 · 请勿移动`);
          }
        }
      } catch (error) { this.cancelJourney(id, error instanceof Error ? error.message : String(error)); }
    }
    if (this.randomJob?.canceled && !this.randomJob.loading) this.randomJob = undefined;
  }

  hurt(player) {
    if (!player.isValid || (player.getComponent("minecraft:health")?.currentValue ?? 0) <= 0) return;
    this.combat.set(player.id, this.now() + this.config.combatSeconds * 1000);
    this.cancelJourney(player.id, "受到伤害或进入战斗，传送取消。");
  }

  died(player) {
    this.resetLife(player.id, "玩家死亡，相关传送已取消。");
    const profile = this.store.profile(player);
    const death = capture(player);
    this.store.save({ ...profile, back: death, death, lastTeleportAt: 0 });
  }

  epoch(id) { return this.lifeEpochs.get(id) ?? 0; }

  resetLife(id, reason) {
    this.lifeEpochs.set(id, this.epoch(id) + 1);
    for (const [traveler, journey] of this.journeys) {
      if (journey.participants.includes(id)) this.cancelJourney(traveler, reason);
    }
    this.combat.delete(id); this.requestCooldowns.delete(id);
    for (const [key, request] of this.requests) if (request.from === id || request.to === id) {
      this.requests.delete(key);
      this.tell(this.online(request.from === id ? request.to : request.from), reason);
    }
  }

  respawned(player) {
    this.resetLife(player.id, "玩家已重生，旧的传送请求已取消。");
    const profile = this.store.profile(player);
    if (profile.lastTeleportAt !== 0) this.store.save({ ...profile, lastTeleportAt: 0 });
  }

  leave(id) {
    this.resetLife(id, "对方离线，传送请求已取消。");
  }
}
