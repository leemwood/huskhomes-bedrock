import {
  world, system, CustomCommandStatus, CustomCommandParamType, CommandPermissionLevel,
} from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { CONFIG } from "./config.js";
import { HomesStore } from "./storage.js";
import { SafeDestinations } from "./safety.js";
import { HomesService } from "./service.js";
import { HomesForms } from "./forms.js";
import { execute, COMMANDS } from "./commands.js";

/** @type {HomesService | undefined} */
let service;
/** @type {HomesForms | undefined} */
let forms;
function runSafely(player, callback) {
  try { callback(); }
  catch (error) { service?.tell(player, error instanceof Error ? error.message : String(error)); }
}

system.beforeEvents.startup.subscribe(event => {
  for (const [command, description, argument, admin] of COMMANDS) {
    event.customCommandRegistry.registerCommand({
      name: `hh:${command}`,
      description: String(description),
      permissionLevel: admin ? CommandPermissionLevel.GameDirectors : CommandPermissionLevel.Any,
      cheatsRequired: false,
      optionalParameters: argument ? [{ name: "名称", type: CustomCommandParamType.String }] : [],
    }, (origin, argument) => {
      const entity = origin.sourceEntity;
      if (entity?.typeId !== "minecraft:player") {
        return { status: CustomCommandStatus.Failure, message: "请在游戏中由玩家执行此命令。" };
      }
      if (!service || !forms) return { status: CustomCommandStatus.Failure, message: "传送插件尚未就绪。" };
      const player = /** @type {import('@minecraft/server').Player} */ (entity);
      const epoch = service.epoch(player.id);
      // Native command callbacks are restricted. Defer all data mutations and UI calls.
      system.runTimeout(() => {
        const activeService = service, activeForms = forms;
        if (player.isValid && activeService && activeForms && activeService.epoch(player.id) === epoch) {
          runSafely(player, () => execute(activeService, activeForms, player, command, argument));
        }
      }, 5);
      return { status: CustomCommandStatus.Success };
    });
  }
});

system.run(() => {
  try {
    const store = new HomesStore(world);
    const safety = new SafeDestinations(world, system, CONFIG);
    service = new HomesService(world, store, safety, CONFIG);
    forms = new HomesForms(service, system, CONFIG, {
      action: () => new ActionFormData(), modal: () => new ModalFormData(), message: () => new MessageFormData(),
    });
    service.onRequest = (player, request) => {
      if (!forms?.sessions.has(player.id)) forms?.open(player, { page: "request", request: request.id });
    };
    for (const player of world.getAllPlayers()) runSafely(player, () => store.profile(player));
    system.runInterval(() => service?.tick(), CONFIG.tickInterval);
    console.info("[HuskHomes] 1.0.2 已加载。/hh:menu 或潜行使用指南针打开表单。");
  } catch (error) { console.error(`[HuskHomes] 初始化失败：${error}`); }
});

world.afterEvents.playerSpawn.subscribe(event => {
  if (!service) return;
  forms?.sessions.delete(event.player.id);
  runSafely(event.player, () => {
    if (!event.initialSpawn) { service?.respawned(event.player); return; }
    service?.store.profile(event.player);
    service?.tell(event.player, "使用 /hh:menu 或潜行使用指南针，打开家与传送菜单。");
  });
});
world.afterEvents.itemUse.subscribe(event => {
  if (event.itemStack.typeId === CONFIG.menuItem && (!CONFIG.requireSneakForMenuItem || event.source.isSneaking)) {
    forms?.open(event.source);
  }
});
world.afterEvents.entityHurt.subscribe(event => {
  if (event.damage === 0) return;
  if (event.hurtEntity.typeId === "minecraft:player") runSafely(event.hurtEntity, () => service?.hurt(/** @type {import('@minecraft/server').Player} */ (event.hurtEntity)));
  const attacker = event.damageSource.damagingEntity;
  if (attacker?.typeId === "minecraft:player") runSafely(attacker, () => service?.hurt(/** @type {import('@minecraft/server').Player} */ (attacker)));
});
world.afterEvents.entityDie.subscribe(event => {
  if (event.deadEntity.typeId !== "minecraft:player" || !service) return;
  const player = /** @type {import('@minecraft/server').Player} */ (event.deadEntity);
  forms?.sessions.delete(player.id);
  runSafely(player, () => service?.died(player));
});
world.afterEvents.playerLeave.subscribe(event => {
  service?.leave(event.playerId);
  forms?.sessions.delete(event.playerId);
});
