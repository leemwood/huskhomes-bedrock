import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { homesRuntime, flush } from "./huskhomes-helpers.js";
import { HomesStore } from "../packs/HuskHomes_BP/scripts/storage.js";

let sequence = 0;
async function loadEntry(game) {
  const key = `__homesTest${++sequence}`; globalThis[key] = game;
  const modules = new Map([
    ["@minecraft/server", ["native", ["world", "system", "CustomCommandStatus", "CustomCommandParamType", "CommandPermissionLevel"]]],
    ["@minecraft/server-ui", ["ui", ["ActionFormData", "ModalFormData", "MessageFormData"]]],
  ]);
  const urls = new Map([...modules].map(([specifier, [group, names]]) => [specifier,
    `data:text/javascript,${encodeURIComponent(`const api = globalThis[${JSON.stringify(key)}].${group};\n`
      + names.map(name => `export const ${name} = api.${name};`).join("\n"))}`]));
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return urls.has(specifier) ? { url: urls.get(specifier), shortCircuit: true } : next(specifier, context);
  } });
  try { await import(`../packs/HuskHomes_BP/scripts/main.js?test=${sequence}`); }
  finally { hooks.deregister(); delete globalThis[key]; }
  game.start(); await game.step();
}

test("entry registers 24 cheat-free commands with restricted admin routes", async () => {
  const game = homesRuntime(); await loadEntry(game);
  assert.equal(game.registry.size, 24);
  for (const { definition } of game.registry.values()) assert.equal(definition.cheatsRequired, false);
  assert.equal(game.registry.get("hh:sethome").definition.permissionLevel, 0);
  assert.equal(game.registry.get("hh:setwarp").definition.permissionLevel, 1);
  assert.equal(game.registry.get("hh:setspawn").definition.permissionLevel, 1);
  const result = game.registry.get("hh:menu").callback({});
  assert.equal(result.status, 1); assert.match(result.message, /玩家/);
});

test("command callbacks defer mutations and open the real menu route", async () => {
  const game = homesRuntime(), player = game.player(); await loadEntry(game);
  game.registry.get("hh:sethome").callback({ sourceEntity: player }, "小屋");
  assert.equal(new HomesStore(game.world).profile(player).homes.length, 0);
  await game.step(5);
  assert.equal(new HomesStore(game.world).profile(player).homes[0].name, "小屋");
  game.registry.get("hh:menu").callback({ sourceEntity: player }); await game.step(5);
  assert.equal(game.formLog[0].form.titleText, "家与传送");
  game.registry.get("hh:setwarp").callback({ sourceEntity: player }, "forbidden"); await game.step(5);
  assert.equal(new HomesStore(game.world).global.warps.length, 0);
  assert.match(player.messages.at(-1), /管理员/);
});

test("native spawn, compass, death and leave events connect to persisted profiles and forms", async () => {
  const game = homesRuntime(), player = game.player(); await loadEntry(game);
  game.emit("playerSpawn", { player, initialSpawn: true });
  assert.match(player.messages.at(-1), /hh:menu/);
  game.emit("itemUse", { source: player, itemStack: { typeId: "minecraft:compass" } }); await flush();
  assert.equal(game.formLog.length, 0);
  player.isSneaking = true;
  let respond; game.responses.push(() => new Promise(resolve => { respond = resolve; }));
  game.emit("itemUse", { source: player, itemStack: { typeId: "minecraft:compass" } }); await flush();
  assert.equal(game.formLog.length, 1);
  game.emit("playerLeave", { playerId: player.id }); respond({ canceled: false, selection: 1 }); await flush();
  assert.equal(game.formLog.length, 1);
  player.location.x = 123.5; game.emit("entityDie", { deadEntity: player });
  assert.equal(new HomesStore(game.world).profile(player).death.x, 123.5);
});

test("native player damage prevents a new journey through command routing", async () => {
  const game = homesRuntime(), player = game.player(), attacker = game.player("Attacker"); await loadEntry(game);
  game.registry.get("hh:sethome").callback({ sourceEntity: player }, "home"); await game.step(5);
  game.emit("entityHurt", { hurtEntity: player, damageSource: { damagingEntity: attacker } });
  game.registry.get("hh:home").callback({ sourceEntity: player }, "home"); await game.step(5);
  assert.match(player.messages.at(-1), /伤害|战斗/); assert.equal(player.teleports.length, 0);
});

test("respawn native event clears fatal damage lock and ignores deferred commands from a past life", async () => {
  const game = homesRuntime(), player = game.player(); await loadEntry(game);
  game.registry.get("hh:sethome").callback({ sourceEntity: player }, "home"); await game.step(5);
  game.emit("entityHurt", { hurtEntity: player, damage: 2, damageSource: {} });
  game.registry.get("hh:sethome").callback({ sourceEntity: player }, "stale");
  player.health = 0; game.emit("entityDie", { deadEntity: player });
  player.health = 20; game.emit("playerSpawn", { player, initialSpawn: false });
  game.registry.get("hh:home").callback({ sourceEntity: player }, "home"); await game.step(5);
  assert.match(player.messages.at(-1), /3 秒后传送/);
  assert.equal(new HomesStore(game.world).profile(player).homes.length, 1);
});

test("death invalidates a native form response and zero-damage events do not lock teleport", async () => {
  const game = homesRuntime(), player = game.player(); await loadEntry(game);
  let respond; game.responses.push(() => new Promise(resolve => { respond = resolve; }));
  game.registry.get("hh:sethome").callback({ sourceEntity: player }); await game.step(5);
  game.emit("entityDie", { deadEntity: player }); game.emit("playerSpawn", { player, initialSpawn: false });
  respond({ canceled: false, formValues: ["stale", "", false] }); await flush();
  assert.equal(new HomesStore(game.world).profile(player).homes.length, 0);
  game.emit("entityHurt", { hurtEntity: player, damage: 0, damageSource: {} });
  game.registry.get("hh:spawn").callback({ sourceEntity: player }); await game.step(5);
  assert.match(player.messages.at(-1), /3 秒后传送/);
});
