const dimensionName = id => ({ "minecraft:overworld": "主世界", "minecraft:nether": "下界", "minecraft:the_end": "末地" })[id] ?? id;
export function locationText(at) {
  return `${dimensionName(at.dimension)} · ${Math.floor(at.x)}, ${Math.floor(at.y)}, ${Math.floor(at.z)}`;
}

export class HomesForms {
  /** @param {import('./service.js').HomesService} service @param {import('@minecraft/server').System} system */
  constructor(service, system, config, builders) {
    this.service = service;
    this.system = system;
    this.config = config;
    this.sessions = new Map();
    // Injectable builders keep tests independent of native UI.
    this.action = builders.action;
    this.modal = builders.modal;
    this.message = builders.message;
  }

  wait(ticks) { return new Promise(resolve => this.system.runTimeout(() => resolve(undefined), ticks)); }

  async show(player, form) {
    const session = this.sessions.get(player.id);
    for (let retry = 0; retry <= this.config.formBusyRetries; retry++) {
      if (!player.isValid || this.sessions.get(player.id) !== session) return undefined;
      const response = await form.show(player);
      if (!player.isValid || this.sessions.get(player.id) !== session) return undefined;
      if (response.canceled && response.cancelationReason === "UserBusy") {
        if (retry < this.config.formBusyRetries) { await this.wait(10); continue; }
        this.service.tell(player, "请先关闭聊天框或其他界面，再使用 /hh:menu。");
        return undefined;
      }
      return response.canceled ? undefined : response;
    }
    return undefined;
  }

  /** @param {import('@minecraft/server').Player} player */
  open(player, route = { page: "main" }) {
    if (this.sessions.has(player.id)) {
      this.service.tell(player, "传送菜单已经打开，请先关闭当前表单。");
      return;
    }
    const session = {};
    this.sessions.set(player.id, session);
    void this.run(player, route, session).finally(() => {
      if (this.sessions.get(player.id) === session) this.sessions.delete(player.id);
    });
  }

  async run(player, route, session) {
    while (route && player.isValid && this.sessions.get(player.id) === session) {
      try {
        const next = await this.page(player, route);
        if (!player.isValid || this.sessions.get(player.id) !== session) return;
        route = next;
      } catch (error) {
        this.service.tell(player, error instanceof Error ? error.message : String(error));
        return;
      }
    }
  }

  async buttons(player, title, body, entries) {
    const form = this.action().title(title).body(body);
    for (const entry of entries) form.button(entry.text);
    const response = await this.show(player, form);
    if (!response || !player.isValid) return undefined;
    const entry = entries[response.selection];
    return entry ? entry.run() : undefined;
  }

  async confirm(player, title, body) {
    const response = await this.show(player, this.message().title(title).body(body).button1("取消").button2("确认"));
    return !!response && response.selection === 1 && player.isValid;
  }

  async list(player, title, items, page, build, baseRoute) {
    const maxPage = Math.max(0, Math.ceil(items.length / this.config.formPageSize) - 1);
    page = Math.max(0, Math.min(maxPage, page ?? 0));
    const entries = items.slice(page * this.config.formPageSize, (page + 1) * this.config.formPageSize)
      .map((item, index) => build(item, page * this.config.formPageSize + index));
    if (page > 0) entries.push({ text: "上一页", run: () => ({ ...baseRoute, index: page - 1 }) });
    if (page < maxPage) entries.push({ text: "下一页", run: () => ({ ...baseRoute, index: page + 1 }) });
    entries.push({ text: "返回主菜单", run: () => ({ page: "main" }) });
    return this.buttons(player, title, `共 ${items.length} 项 · 第 ${page + 1}/${maxPage + 1} 页`, entries);
  }

  async page(player, route) {
    const service = this.service;
    const profile = service.store.profile(player);
    const nav = page => ({ page });
    switch (route.page) {
      case "main": {
        const entries = [
          { text: `我的家 (${profile.homes.length})`, run: () => nav("homes") },
          { text: "在当前位置创建家", run: () => nav("newhome") },
          { text: "公开的家", run: () => nav("public") },
          { text: "公共传送点", run: () => nav("warps") },
          { text: "传送到其他玩家", run: () => ({ page: "players", here: false }) },
          { text: "邀请玩家传送到我这里", run: () => ({ page: "players", here: true }) },
          { text: `收到的传送请求 (${service.incoming(player).length})`, run: () => nav("requests") },
          { text: "返回上一地点", run: () => { service.back(player); } },
          { text: "返回死亡地点", run: () => { service.back(player, true); } },
          { text: "主城 / 世界出生点", run: () => { service.spawn(player); } },
          { text: "主世界随机传送", run: () => { service.random(player); } },
          { text: "最近的传送出发地点", run: () => nav("history") },
          { text: `传送请求：${profile.requestsEnabled ? "已开启" : "已关闭"}`, run: () => { service.toggle(player); return nav("main"); } },
          { text: "取消当前传送 / 撤回请求", run: () => { service.cancel(player); } },
        ];
        if (service.admin(player)) entries.push({ text: "管理员设置", run: () => nav("admin") });
        return this.buttons(player, "家与传送", `你好，${player.name}\n传送读条 ${this.config.warmupSeconds} 秒 · 冷却 ${this.config.cooldownSeconds} 秒\n移动或受伤会取消传送`, entries);
      }
      case "homes":
        return this.list(player, "我的家", profile.homes, route.index, home => ({
          text: `${home.name}${home.public ? " · 公开" : ""}\n${locationText(home.location)}`,
          run: () => ({ page: "home", key: home.key }),
        }), nav("homes"));
      case "home": {
        const home = profile.homes.find(home => home.key === route.key);
        if (!home) throw new Error("这个家已被删除。");
        return this.buttons(player, home.name, `${home.description || "没有描述"}\n${locationText(home.location)}\n${home.public ? "其他玩家可以通过公开家列表到访。" : "仅自己可见。"}`, [
          { text: "传送到这个家", run: () => { service.home(player, home.name); } },
          { text: "编辑名称、描述、公开状态", run: () => ({ page: "edithome", key: home.key }) },
          { text: "更新为我的当前位置", run: () => ({ page: "relocate", key: home.key }) },
          { text: "删除这个家", run: () => ({ page: "delhome", key: home.key }) },
          { text: "返回我的家", run: () => nav("homes") },
        ]);
      }
      case "newhome":
      case "edithome": {
        const old = route.page === "edithome" ? profile.homes.find(home => home.key === route.key) : undefined;
        if (route.page === "edithome" && !old) throw new Error("这个家已被删除。");
        const form = this.modal().title(old ? "编辑家" : "创建家")
          .textField("名称", "例如：山顶小屋", { defaultValue: old?.name ?? "home" })
          .textField("描述", "可留空", { defaultValue: old?.description ?? "" })
          .toggle("公开：允许其他玩家到访", { defaultValue: old?.public ?? false }).submitButton("保存");
        const response = await this.show(player, form);
        if (!response || !player.isValid) return undefined;
        const values = response.formValues;
        if (!values || typeof values[0] !== "string" || typeof values[1] !== "string" || typeof values[2] !== "boolean") return undefined;
        if (old) service.editHome(player, old.key, values[0], values[1], values[2]);
        else service.setHome(player, values[0], values[1], values[2]);
        return nav("homes");
      }
      case "delhome":
      case "relocate": {
        const current = profile.homes.find(home => home.key === route.key);
        if (!current) throw new Error("这个家已被删除。");
        if (await this.confirm(player, route.page === "delhome" ? "删除家" : "更新家的位置", `确认${route.page === "delhome" ? "删除" : "更新位置"}「${current.name}」？`)) {
          if (route.page === "delhome") service.deleteHome(player, current.name);
          else service.editHome(player, current.key, current.name, current.description, current.public, true);
        }
        return nav("homes");
      }
      case "public":
        return this.list(player, "公开的家", service.store.publicHomes(), route.index, home => ({
          text: `${home.name} · ${home.ownerName}\n${home.description || dimensionName(home.location.dimension)}`,
          run: () => { service.publicHome(player, home.owner, home.key); },
        }), nav("public"));
      case "warps":
        return this.list(player, "公共传送点", service.store.global.warps, route.index, warp => ({
          text: `${warp.name}\n${locationText(warp.location)}`, run: () => { service.warp(player, warp.name); },
        }), nav("warps"));
      case "players": {
        const players = service.world.getAllPlayers().filter(other => other.id !== player.id);
        return this.list(player, route.here ? "邀请玩家到我这里" : "请求传送到玩家", players, route.index, target => ({
          text: target.name, run: () => { service.request(player, target, !!route.here); },
        }), { page: "players", here: route.here });
      }
      case "requests":
        return this.list(player, "收到的请求", service.incoming(player), route.index, request => ({
          text: `${service.online(request.from)?.name ?? "已离线"}\n${request.here ? "邀请你过去" : "希望传送到你这里"}`,
          run: () => ({ page: "request", request: request.id }),
        }), nav("requests"));
      case "request": {
        const request = service.requests.get(route.request);
        if (!request || request.to !== player.id || request.expires <= service.now()) throw new Error("这个请求已失效。");
        return this.buttons(player, "传送请求", `${service.online(request.from)?.name ?? "已离线"}\n${request.here ? "邀请你传送到 TA 身边。" : "请求传送到你身边。"}\n剩余 ${Math.max(0, Math.ceil((request.expires - service.now()) / 1000))} 秒`, [
          { text: "接受", run: () => { service.accept(player, request.id); } },
          { text: "拒绝", run: () => { service.deny(player, request.id); return nav("requests"); } },
          { text: "稍后处理", run: () => nav("main") },
        ]);
      }
      case "history":
        return this.list(player, "最近的出发地点", profile.history, route.index, (at, index) => ({
          text: `${index + 1}. ${locationText(at)}`, run: () => { service.begin(player, () => at, "历史地点"); },
        }), nav("history"));
      case "admin":
        service.requireAdmin(player);
        return this.buttons(player, "管理员设置", "以当前位置创建公共传送点或主城。", [
          { text: "创建公共传送点", run: () => nav("newwarp") },
          { text: "删除公共传送点", run: () => nav("delwarps") },
          { text: "设置主城为当前位置", run: () => nav("setspawn") },
          { text: "返回主菜单", run: () => nav("main") },
        ]);
      case "newwarp": {
        service.requireAdmin(player);
        const response = await this.show(player, this.modal().title("创建公共传送点").textField("名称", "例如：交易大厅").submitButton("创建"));
        if (response && player.isValid && typeof response.formValues?.[0] === "string") service.setWarp(player, response.formValues[0]);
        return nav("admin");
      }
      case "delwarps":
        service.requireAdmin(player);
        return this.list(player, "删除公共传送点", service.store.global.warps, route.index, warp => ({
          text: warp.name, run: () => ({ page: "delwarp", key: warp.key }),
        }), nav("delwarps"));
      case "delwarp":
        service.requireAdmin(player);
        if (await this.confirm(player, "删除公共传送点", `确认删除「${route.key}」？`)) service.deleteWarp(player, route.key);
        return nav("admin");
      case "setspawn":
        service.requireAdmin(player);
        if (await this.confirm(player, "设置主城", "将本插件的主城设为当前位置？")) service.setSpawn(player);
        return nav("admin");
      default: return undefined;
    }
  }
}
