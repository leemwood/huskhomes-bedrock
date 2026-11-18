import test from "node:test";
import assert from "node:assert/strict";
import { homesRuntime, flush } from "./huskhomes-helpers.js";
import { HomesStore, capture, PLAYER_PREFIX, cleanName } from "../packs/HuskHomes_BP/scripts/storage.js";
import { SafeDestinations } from "../packs/HuskHomes_BP/scripts/safety.js";

test("homes persist across reload and player rename without mixing different users", () => {
  const game = homesRuntime(); const alice = game.player("Alice"), bob = game.player("Bob");
  game.service.setHome(alice, "山顶 小屋", "欢迎", true);
  game.service.setHome(bob, "山顶 小屋");
  alice.name = "AliceRenamed";
  const reloaded = new HomesStore(game.world);
  assert.equal(reloaded.profile(alice).homes[0].description, "欢迎");
  assert.equal(reloaded.profile(bob).homes[0].public, false);
  assert.equal(reloaded.publicHomes().length, 1);
  assert.equal(reloaded.publicHomes()[0].ownerName, "AliceRenamed");
});

test("home limits, normalized duplicates and unsafe names are rejected", () => {
  const game = homesRuntime({ maxHomes: 2 }); const player = game.player();
  game.service.setHome(player, "HOME");
  assert.throws(() => game.service.setHome(player, "ｈｏｍｅ"), /同名/);
  game.service.setHome(player, "第二个");
  assert.throws(() => game.service.setHome(player, "第三个"), /最多/);
  for (const name of ["", "a/b", "§c红色", "a\nb", "x".repeat(25)]) assert.throws(() => cleanName(name, game.config));
});

test("edit, relocation and deletion apply to the caller's own home only", () => {
  const game = homesRuntime(); const a = game.player("A"), b = game.player("B");
  game.service.setHome(a, "home"); game.service.setHome(b, "home");
  a.location.x = 20.5;
  game.service.editHome(a, "home", "家", "§a介绍\n", true, true);
  assert.equal(game.store.profile(a).homes[0].location.x, 20.5);
  assert.equal(game.store.profile(a).homes[0].description, "a介绍");
  assert.equal(game.store.profile(b).homes[0].name, "home");
  game.service.deleteHome(a, "家");
  assert.equal(game.store.publicHomes().length, 0);
  assert.equal(game.store.profile(b).homes.length, 1);
});

test("persistence failure leaves cached and saved home data unchanged", () => {
  const game = homesRuntime(); const player = game.player(); game.store.profile(player);
  game.failWrites();
  assert.throws(() => game.service.setHome(player, "home"), /persistence/);
  assert.equal(game.store.profile(player).homes.length, 0);
  assert.equal(new HomesStore(game.world).profile(player).homes.length, 0);
});

test("corrupted player and global records are preserved instead of silently overwritten", () => {
  const game = homesRuntime(); const player = game.player(); const id = game.store.identity(player);
  game.properties.set(PLAYER_PREFIX + id, "broken"); game.properties.set("hh:global", "broken");
  const store = new HomesStore(game.world);
  assert.throws(() => store.profile(player), /无法读取/);
  assert.throws(() => store.saveGlobal({ v: 1, warps: [] }), /损坏/);
  assert.equal(game.properties.get(PLAYER_PREFIX + id), "broken");
  assert.equal(game.properties.get("hh:global"), "broken");
});

test("home teleport warms up, records origin, enforces cooldown and back swaps locations", async () => {
  const game = homesRuntime(); const player = game.player(); game.service.setHome(player, "home");
  player.location.x = 40.5; game.service.home(player); await game.step(59);
  assert.equal(player.teleports.length, 0); await game.step();
  assert.equal(player.location.x, 0.5);
  assert.equal(game.store.profile(player).back.x, 40.5);
  assert.equal(player.teleports[0].options.checkForBlocks, true);
  assert.throws(() => game.service.back(player), /冷却/);
  game.advance(10001); game.service.back(player); await game.step(60);
  assert.equal(player.location.x, 40.5); assert.equal(game.store.profile(player).back.x, 0.5);
});

test("movement in any axis or dimension cancels the pending teleport", async () => {
  for (const axis of ["x", "y", "z", "dimension"]) {
    const game = homesRuntime(); const player = game.player(); game.service.setHome(player, "home");
    game.service.home(player);
    if (axis === "dimension") player.dimension = game.dimensions.get("minecraft:nether"); else player.location[axis] += 0.6;
    await game.step(65); assert.equal(player.teleports.length, 0, axis);
    assert.equal(game.service.journeys.size, 0);
  }
});

test("damage and combat cancel warmup and prevent immediate retry", async () => {
  const game = homesRuntime(); const player = game.player(); game.service.setHome(player, "home");
  game.service.home(player); game.service.hurt(player); await game.step(60);
  assert.equal(player.teleports.length, 0);
  assert.throws(() => game.service.home(player), /伤害|战斗/);
  game.advance(10001); game.service.home(player); await game.step(60); assert.equal(player.teleports.length, 1);
});

test("canceling while destination is loading prevents a late teleport", async () => {
  const game = homesRuntime({ warmupSeconds: 0 }); const player = game.player();
  let release;
  const resolveDestination = game.safety.resolve.bind(game.safety);
  game.safety.resolve = (destination, arrive) => new Promise(resolve => {
    release = () => { resolve(resolveDestination(destination, arrive)); };
  });
  game.service.begin(player, () => capture(player), "测试"); await game.step();
  game.service.cancel(player); release(); await flush();
  assert.equal(player.teleports.length, 0); assert.equal(game.store.profile(player).history.length, 0);
});

test("failed native teleport rolls back back/history/cooldown", async () => {
  const game = homesRuntime({ warmupSeconds: 0 }); const player = game.player();
  game.service.setHome(player, "home"); player.teleportResult = false; game.service.home(player); await game.step();
  assert.equal(game.store.profile(player).lastTeleportAt, 0);
  assert.equal(game.store.profile(player).history.length, 0);
  assert.equal(game.store.profile(player).back, undefined);
});

test("TPA needs explicit recipient consent and moves only the requester", async () => {
  const game = homesRuntime({ warmupSeconds: 0 }); const a = game.player("Alice"), b = game.player("Bob", false, { x: 100.5, y: 64, z: 0.5 });
  const request = game.service.request(a, b); await game.step();
  assert.equal(a.teleports.length, 0); assert.equal(b.teleports.length, 0);
  assert.throws(() => game.service.accept(a, request.id), /失效/);
  game.service.accept(b, request.id); await game.step();
  assert.equal(a.location.x, 100.5); assert.equal(b.teleports.length, 0);
  assert.throws(() => game.service.accept(b, request.id), /失效/);
});

test("TPAHere moves the recipient only after consent", async () => {
  const game = homesRuntime({ warmupSeconds: 0 }); const a = game.player("Alice"), b = game.player("Bob", false, { x: 50.5, y: 64, z: 0.5 });
  const request = game.service.request(a, b, true); game.service.accept(b, request.id); await game.step();
  assert.equal(b.location.x, 0.5); assert.equal(a.teleports.length, 0);
});

test("request deny, cancel, expiry, self-request, toggle and rate limits", () => {
  const game = homesRuntime(); const a = game.player("Alice"), b = game.player("Bob");
  assert.throws(() => game.service.request(a, a), /自己/);
  let request = game.service.request(a, b); game.service.deny(b, request.id);
  assert.equal(game.service.requests.size, 0);
  assert.throws(() => game.service.request(a, b), /频繁/);
  game.advance(5001); request = game.service.request(a, b); game.service.cancel(a);
  assert.equal(game.service.requests.size, 0);
  game.advance(5001); request = game.service.request(a, b); game.advance(60001);
  assert.throws(() => game.service.accept(b, request.id), /失效/);
  game.service.expireRequests(); assert.equal(game.service.requests.size, 0);
  game.service.toggle(b); assert.throws(() => game.service.request(a, b), /关闭/);
});

test("disconnect or anchor death invalidates an accepted request before completion", async () => {
  for (const death of [false, true]) {
    const game = homesRuntime(); const a = game.player("Alice"), b = game.player("Bob");
    const request = game.service.request(a, b); game.service.accept(b, request.id);
    if (death) b.health = 0; else { b.isValid = false; game.service.leave(b.id); }
    await game.step(60); assert.equal(a.teleports.length, 0);
  }
});

test("public homes work for offline owners but revoking publicity cancels queued arrival", async () => {
  const game = homesRuntime({ warmupSeconds: 0 }); const owner = game.player("Owner"), guest = game.player("Guest");
  game.service.setHome(owner, "home", "", true); const id = game.store.identity(owner); owner.isValid = false;
  game.service.publicHome(guest, id, "home"); await game.step(); assert.equal(guest.teleports.length, 1);
  game.advance(10001); game.service.publicHome(guest, id, "home");
  owner.isValid = true; game.service.editHome(owner, "home", "home", "", false);
  await game.step(); assert.equal(guest.teleports.length, 1);
});

test("ordinary members cannot create/delete warps or set spawn even through service calls", () => {
  const game = homesRuntime(); const member = game.player(), admin = game.player("Admin", true);
  for (const operation of [() => game.service.setWarp(member, "shop"), () => game.service.deleteWarp(member, "shop"), () => game.service.setSpawn(member)]) {
    assert.throws(operation, /管理员/);
  }
  game.service.setWarp(admin, "商店"); game.service.setSpawn(admin);
  assert.equal(new HomesStore(game.world).global.warps[0].name, "商店");
  assert.equal(new HomesStore(game.world).global.spawn.x, 0.5);
  game.service.deleteWarp(admin, "商店"); assert.equal(game.store.global.warps.length, 0);
});

test("death records are persisted and history is bounded", async () => {
  const game = homesRuntime({ warmupSeconds: 0, cooldownSeconds: 0, maxHistory: 2 }); const player = game.player();
  player.location.x = 80.5; game.service.died(player);
  assert.equal(new HomesStore(game.world).profile(player).death.x, 80.5);
  player.location.x = 0.5;
  game.service.back(player, true); await game.step(); assert.equal(player.location.x, 80.5);
  for (let i = 0; i < 4; i++) { game.service.back(player); await game.step(); }
  assert.equal(game.store.profile(player).history.length, 2);
});

test("cross-dimension homes preserve dimension and viewing direction", async () => {
  const game = homesRuntime({ warmupSeconds: 0 }); const player = game.player();
  player.dimension = game.dimensions.get("minecraft:nether"); player.rotation = { x: 15, y: 90 };
  game.service.setHome(player, "nether"); player.dimension = game.dimensions.get("minecraft:overworld");
  game.service.home(player, "nether"); await game.step();
  assert.equal(player.dimension.id, "minecraft:nether"); assert.deepEqual(player.rotation, { x: 15, y: 90 });
});

test("safe destination checks reject hazardous floors, obstruction and unsupported ground", async () => {
  const game = homesRuntime({ safeSearchRadius: 0, safeSearchHeight: 0 }); const player = game.player();
  player.dimension.overrides.set("0,62,0", "minecraft:air");
  for (const floor of ["minecraft:lava", "minecraft:magma", "minecraft:cactus", "minecraft:air", "minecraft:torch"]) {
    player.dimension.overrides.set("0,63,0", floor);
    assert.equal((await game.safety.resolve(capture(player))).location, undefined);
  }
  player.dimension.overrides.clear(); player.dimension.overrides.set("0,65,0", "minecraft:stone");
  assert.equal((await game.safety.resolve(capture(player))).location, undefined);
  player.dimension.overrides.clear(); player.dimension.overrides.set("1,64,0", "minecraft:lava");
  assert.equal((await game.safety.resolve(capture(player))).location, undefined);
  player.dimension.overrides.clear(); assert.equal((await game.safety.resolve(capture(player))).location.y, 64);
});

test("temporary chunk loading preloads neighbors, retains the landing area, then releases it", async () => {
  const game = homesRuntime(); const player = game.player(); const at = { ...capture(player), x: 1000.5 };
  player.dimension.unloaded.add("62,0");
  const pending = game.safety.resolve(at); await game.step(3); const result = await pending;
  assert.equal(result.location.x, 1000.5); assert.equal(game.areas.size, 1); assert.equal(game.safety.loads, 0);
  const area = [...game.areas.values()][0];
  assert.equal((area.to.x - area.from.x + 1) / 16, 3);
  assert.equal((area.to.z - area.from.z + 1) / 16, 3);
  await game.step(game.config.arrivalHoldTicks); assert.equal(game.areas.size, 0);
});

test("chunk-load timeout rejects without teleport and late completion cleans its area", async () => {
  const game = homesRuntime({ chunkLoadTimeoutTicks: 2 }); const player = game.player();
  let release; game.delayLoads(new Promise(resolve => { release = resolve; }));
  const at = { ...capture(player), x: 1000.5 }; player.dimension.unloaded.add("62,0");
  const loading = game.safety.resolve(at); await game.step(2); assert.match((await loading).error, /超时/);
  assert.equal(game.safety.loads, 1);
  release(); await flush(); assert.equal(game.areas.size, 0); assert.equal(game.safety.loads, 0);
});

test("concurrent destination loads are capped", async () => {
  const game = homesRuntime({ maxConcurrentChunkLoads: 1 }); const player = game.player();
  let release; game.delayLoads(new Promise(resolve => { release = resolve; }));
  const at = { ...capture(player), x: 1000.5 }; player.dimension.unloaded.add("62,0");
  const first = game.safety.resolve(at);
  assert.match((await game.safety.resolve(at)).error, /正在加载/); release(); await flush(); await game.step(3); await first;
  assert.equal(game.safety.loads, 0); await game.step(game.config.arrivalHoldTicks); assert.equal(game.areas.size, 0);
});

test("random teleport uses a bounded number of attempts and only the overworld", async () => {
  const game = homesRuntime({ warmupSeconds: 0, randomAttempts: 3 }); const player = game.player();
  let calls = 0;
  game.safety.surface = async (dimension, x, z) => {
    calls++; assert.equal(dimension, "minecraft:overworld");
    const radius = Math.hypot(x, z); assert.ok(radius > 254 && radius < 2002);
    return {};
  };
  game.service.random(player); await game.step(25);
  assert.equal(calls, 3); assert.equal(player.teleports.length, 0);
  assert.equal(game.service.journeys.size, 0);
});

test("native wrapped top faces, slabs, stairs, carpet, farmland and plants produce real landing heights", async () => {
  const cases = [
    ["minecraft:stone", 64], ["minecraft:smooth_stone_slab", 63.5], ["minecraft:oak_stairs", 64],
    ["minecraft:farmland", 63.9375], ["minecraft:grass_path", 63.9375],
  ];
  for (const [type, height] of cases) {
    const game = homesRuntime({ safeSearchRadius: 0, safeSearchHeight: 0 }), player = game.player();
    player.dimension.overrides.set("0,63,0", type);
    const result = await game.safety.resolve({ ...capture(player), y: height });
    assert.equal(result.location?.y, height, type);
  }
  for (const [type, height] of [["minecraft:white_carpet", 64.0625], ["minecraft:snow_layer", 64.125], ["minecraft:short_grass", 64]]) {
    const game = homesRuntime({ safeSearchRadius: 0, safeSearchHeight: 0 }), player = game.player();
    player.dimension.overrides.set("0,64,0", type);
    assert.equal((await game.safety.resolve({ ...capture(player), y: height })).location?.y, height, type);
  }
});

test("partial surfaces reject low ceilings, waterlogged lights and dangerous diagonals", async () => {
  const game = homesRuntime({ safeSearchRadius: 0, safeSearchHeight: 0 }), player = game.player();
  player.dimension.overrides.set("0,63,0", "minecraft:smooth_stone_slab");
  player.dimension.overrides.set("0,65,0", "minecraft:stone");
  assert.equal((await game.safety.resolve({ ...capture(player), y: 63.5 })).location, undefined);
  player.dimension.overrides.clear(); player.dimension.overrides.set("0,64,0", "minecraft:light_block_14");
  player.dimension.waterlogged.add("0,64,0");
  assert.equal((await game.safety.resolve(capture(player))).location, undefined);
  player.dimension.waterlogged.clear(); player.dimension.overrides.set("1,64,1", "minecraft:lava");
  assert.equal((await game.safety.resolve(capture(player))).location, undefined);
});

test("chunk lease remains alive until native teleport and loads neighbor chunks at boundaries", async () => {
  const game = homesRuntime({ warmupSeconds: 0 }), player = game.player();
  player.location.x = 1007.5; game.service.setHome(player, "far"); player.location.x = 0.5;
  // Destination chunk is loaded, but its safety-search neighbor is not.
  player.dimension.unloaded.add("63,0");
  const nativeTeleport = player.tryTeleport;
  player.tryTeleport = function (...args) {
    assert.equal(game.areas.size, 1); return nativeTeleport.apply(this, args);
  };
  game.service.home(player, "far"); await game.step(4);
  assert.equal(player.teleports.length, 1); assert.equal(game.areas.size, 1);
  await game.step(game.config.arrivalHoldTicks); assert.equal(game.areas.size, 0);
});

test("unsafe destinations return a handled result and keep history/cooldown unchanged", async () => {
  const game = homesRuntime({ warmupSeconds: 0, safeSearchRadius: 0, safeSearchHeight: 0 }), player = game.player();
  player.dimension.overrides.set("0,65,0", "minecraft:stone");
  game.service.setHome(player, "blocked"); game.service.home(player, "blocked"); await game.step();
  assert.equal(player.teleports.length, 0); assert.match(player.messages.at(-1), /安全落脚点/);
  assert.equal(game.store.profile(player).lastTeleportAt, 0); assert.equal(game.store.profile(player).history.length, 0);
});

test("death and respawn clear combat, cooldown and requests without losing homes or death location", async () => {
  const game = homesRuntime({ warmupSeconds: 0 }), player = game.player(), other = game.player("Other");
  game.service.setHome(player, "home"); game.service.home(player); await game.step();
  game.service.hurt(player); game.service.request(player, other); game.service.request(other, player);
  player.location.x = 22.5; player.health = 0; game.service.died(player);
  game.service.hurt(player); // Late fatal damage event must not restore the lock.
  assert.equal(game.service.combat.has(player.id), false); assert.equal(game.service.requests.size, 0);
  player.health = 20; game.service.respawned(player); game.service.home(player); await game.step();
  assert.equal(player.teleports.length, 2); assert.equal(game.store.profile(player).death.x, 22.5);
  assert.equal(game.store.profile(player).homes.length, 1);
});

test("anchor death followed by immediate respawn cannot revive accepted TPA journeys", async () => {
  const game = homesRuntime(), a = game.player("Alice"), b = game.player("Bob");
  const request = game.service.request(a, b); game.service.accept(b, request.id);
  game.service.died(b); game.service.respawned(b); await game.step(65);
  assert.equal(game.service.journeys.size, 0); assert.equal(a.teleports.length, 0);
  assert.equal(a.actionBars.at(-1), "");
});

test("RTP serializes players, spaces retries, and keeps cooldown after cancellation", async () => {
  const game = homesRuntime({ warmupSeconds: 0 }), a = game.player("Alice"), b = game.player("Bob");
  let calls = 0; game.safety.surface = async () => { calls++; return {}; };
  game.service.random(a); assert.throws(() => game.service.random(b), /正在准备/);
  await game.step(); assert.equal(calls, 1);
  await game.step(4); assert.equal(calls, 1);
  game.service.cancel(a); await game.step(20); assert.equal(calls, 1);
  assert.equal(game.service.randomJob, undefined);
  assert.throws(() => game.service.random(a), /随机传送冷却/);
  assert.throws(() => game.service.random(b), /随机传送冷却/);
  game.advance(16000); game.service.random(b); await game.step(45);
  assert.equal(calls, 1 + game.config.randomAttempts);
});

test("RTP cancellation during native loading waits for completion and does not teleport or retry", async () => {
  const game = homesRuntime({ warmupSeconds: 0 }), a = game.player("Alice"), b = game.player("Bob");
  let release; game.delayLoads(new Promise(resolve => { release = resolve; }));
  const surface = game.safety.surface.bind(game.safety); let calls = 0;
  game.safety.surface = (...args) => {
    calls++; const [dimension, x, z] = args;
    game.world.getDimension(dimension).unloaded.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
    return surface(...args);
  };
  game.service.random(a); await game.step(); game.service.cancel(a);
  assert.throws(() => game.service.random(b), /正在准备/);
  release(); await flush(); await game.step(4);
  assert.equal(a.teleports.length, 0); assert.equal(calls, 1); assert.equal(game.areas.size, 0);
  assert.equal(game.service.randomJob, undefined);
});

test("RTP total preparation deadline stops further attempts", async () => {
  const game = homesRuntime({ warmupSeconds: 0, randomTimeoutSeconds: 1 }), player = game.player();
  let calls = 0;
  game.safety.surface = async () => { calls++; game.advance(1001); return {}; };
  game.service.random(player); await game.step();
  assert.equal(calls, 1); assert.equal(player.teleports.length, 0);
  assert.match(player.messages.at(-1), /超时/); assert.equal(game.service.randomJob, undefined);
});

test("retained loading areas and spacing bound new generation requests", async () => {
  const game = homesRuntime({ maxRetainedChunkAreas: 1 }), player = game.player();
  const firstAt = { ...capture(player), x: 1000.5 };
  const secondAt = { ...capture(player), x: 2000.5 };
  player.dimension.unloaded.add("62,0"); player.dimension.unloaded.add("125,0");
  const first = game.safety.resolve(firstAt); await game.step(3); await first;
  assert.equal(game.safety.retained.size, 1);
  assert.match((await game.safety.resolve(secondAt)).error, /正在加载/);
  await game.step(game.config.arrivalHoldTicks);
  const next = game.safety.resolve(secondAt); await game.step(3); assert.ok((await next).location);
});

test("surface search reuses nearby columns before generating another remote region", async () => {
  const game = homesRuntime(), player = game.player();
  player.dimension.overrides.set("0,64,0", "minecraft:water");
  player.dimension.overrides.set("4,63,0", "minecraft:stone");
  const surface = await game.safety.surface(player.dimension.id, 0, 0);
  assert.equal(surface.location.x, 4.5); assert.equal(game.areas.size, 0);
});

test("startup recovery only removes ticking areas owned by its loading routine", () => {
  const game = homesRuntime();
  game.areas.set("hh_load_old", { identifier: "hh_load_old" }); game.areas.set("other", { identifier: "other" });
  new SafeDestinations(game.world, game.system, game.config);
  assert.equal(game.areas.size, 1); assert.ok(game.areas.has("other"));
});
