import test from "node:test";
import assert from "node:assert/strict";
import { homesRuntime, flush } from "./huskhomes-helpers.js";

const answer = selection => ({ canceled: false, selection });
const modal = (...formValues) => ({ canceled: false, formValues });

test("main menu creates a Chinese public home through native modal values", async () => {
  const game = homesRuntime(), player = game.player();
  game.responses.push(answer(1), modal("山顶小屋", "欢迎来访", true));
  game.forms.open(player); await flush();
  const home = game.store.profile(player).homes[0];
  assert.equal(home.name, "山顶小屋"); assert.equal(home.public, true);
  assert.equal(home.description, "欢迎来访");
  assert.equal(game.formLog[1].form.fields.length, 3);
  assert.equal(game.forms.sessions.size, 0);
});

test("invalid modal input cannot create a home or store malformed values", async () => {
  for (const values of [["bad/name", "", false], ["home", "", "true"]]) {
    const game = homesRuntime(), player = game.player();
    game.responses.push(modal(...values)); game.forms.open(player, { page: "newhome" }); await flush();
    assert.equal(game.store.profile(player).homes.length, 0);
  }
});

test("home deletion requires the explicit confirm button", async () => {
  for (const selection of [0, 1]) {
    const game = homesRuntime(), player = game.player(); game.service.setHome(player, "home");
    game.responses.push(answer(selection));
    game.forms.open(player, { page: "delhome", key: "home" }); await flush();
    assert.equal(game.store.profile(player).homes.length, selection === 1 ? 0 : 1);
    assert.deepEqual(game.formLog[0].form.buttons, ["取消", "确认"]);
  }
});

test("busy retries are bounded and a duplicate menu does not start another session", async () => {
  const game = homesRuntime({ formBusyRetries: 2 }), player = game.player();
  game.responses.push(...Array.from({ length: 3 }, () => ({ canceled: true, cancelationReason: "UserBusy" })));
  game.forms.open(player); game.forms.open(player); await flush();
  assert.equal(game.formLog.length, 1);
  assert.match(player.messages.at(-1), /已经打开/);
  await game.step(20); await flush();
  assert.equal(game.formLog.length, 3); assert.equal(game.forms.sessions.size, 0);
  assert.match(player.messages.at(-1), /关闭聊天框/);
});

test("home lists paginate without exposing unrelated entries", async () => {
  const game = homesRuntime({ formPageSize: 2 }), player = game.player();
  for (let i = 0; i < 5; i++) game.service.setHome(player, `home${i}`);
  game.responses.push(answer(2)); game.forms.open(player, { page: "homes" }); await flush();
  assert.match(game.formLog[0].form.bodyText, /第 1\/3 页/);
  assert.match(game.formLog[1].form.bodyText, /第 2\/3 页/);
  assert.match(game.formLog[1].form.buttons[0], /home2/);
  assert.match(game.formLog[1].form.buttons[1], /home3/);
  assert.equal(game.formLog[1].form.buttons.includes("上一页"), true);
});

test("an expired request form cannot accept a newer unrelated request", async () => {
  const game = homesRuntime(), a = game.player("Alice"), b = game.player("Bob"), c = game.player("Carol");
  const original = game.service.request(a, b);
  let respond; game.responses.push(() => new Promise(resolve => { respond = resolve; }));
  game.forms.open(b, { page: "request", request: original.id }); await flush();
  game.advance(60001); game.service.expireRequests(); const next = game.service.request(c, b);
  respond(answer(0)); await flush();
  assert.equal(game.service.journeys.size, 0); assert.equal(game.service.requests.has(next.id), true);
  assert.match(b.messages.at(-1), /失效/);
});

test("a disconnected form session ignores its late response", async () => {
  const game = homesRuntime(), player = game.player();
  let respond; game.responses.push(() => new Promise(resolve => { respond = resolve; }));
  game.forms.open(player, { page: "newhome" }); await flush();
  game.forms.sessions.delete(player.id);
  respond(modal("late", "", false)); await flush();
  assert.equal(game.store.profile(player).homes.length, 0);
});

test("admin permissions are checked again after a form response", async () => {
  const game = homesRuntime(), player = game.player("Admin", true);
  let respond; game.responses.push(() => new Promise(resolve => { respond = resolve; }));
  game.forms.open(player, { page: "newwarp" }); await flush();
  player.playerPermissionLevel = 1; player.commandPermissionLevel = 0;
  respond(modal("unauthorized")); await flush();
  assert.equal(game.store.global.warps.length, 0); assert.match(player.messages.at(-1), /管理员/);
});
