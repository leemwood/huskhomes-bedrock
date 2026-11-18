/** @param {import('./service.js').HomesService} service @param {import('./forms.js').HomesForms} forms */
export function execute(service, forms, player, command, argument) {
  switch (command) {
    case "menu": forms.open(player); break;
    case "homes": forms.open(player, { page: "homes" }); break;
    case "home": if (argument) service.home(player, argument); else forms.open(player, { page: "homes" }); break;
    case "sethome": if (argument) service.setHome(player, argument); else forms.open(player, { page: "newhome" }); break;
    case "edithome": {
      const home = service.store.profile(player).homes.find(home => home.key === String(argument ?? "").normalize("NFKC").toLowerCase());
      if (home) forms.open(player, { page: "edithome", key: home.key });
      else forms.open(player, { page: "homes" });
      break;
    }
    case "delhome": {
      const home = service.store.profile(player).homes.find(home => home.key === String(argument ?? "").normalize("NFKC").toLowerCase());
      if (!home) throw new Error("请输入有效的家名称，或在 /hh:homes 表单中删除。");
      forms.open(player, { page: "delhome", key: home.key }); break;
    }
    case "publichomes": forms.open(player, { page: "public" }); break;
    case "warps": forms.open(player, { page: "warps" }); break;
    case "warp": if (argument) service.warp(player, argument); else forms.open(player, { page: "warps" }); break;
    case "setwarp": if (argument) service.setWarp(player, argument); else { service.requireAdmin(player); forms.open(player, { page: "newwarp" }); } break;
    case "delwarp": service.requireAdmin(player); if (argument) forms.open(player, { page: "delwarp", key: argument }); else forms.open(player, { page: "delwarps" }); break;
    case "spawn": service.spawn(player); break;
    case "setspawn": service.requireAdmin(player); forms.open(player, { page: "setspawn" }); break;
    case "back": service.back(player); break;
    case "death": service.back(player, true); break;
    case "rtp": service.random(player); break;
    case "history": forms.open(player, { page: "history" }); break;
    case "tpa":
    case "tpahere":
      if (argument) service.request(player, service.findPlayer(argument), command === "tpahere");
      else forms.open(player, { page: "players", here: command === "tpahere" });
      break;
    case "requests": forms.open(player, { page: "requests" }); break;
    case "tpaccept": service.accept(player); break;
    case "tpdeny": service.deny(player); break;
    case "tpcancel": service.cancel(player); break;
    case "tptoggle": service.toggle(player); break;
    default: throw new Error("未知命令，请使用 /hh:menu。");
  }
}

export const COMMANDS = [
  ["menu", "打开家与传送菜单", false, false],
  ["homes", "查看我的家", false, false],
  ["home", "传送到家", true, false],
  ["sethome", "创建家", true, false],
  ["edithome", "编辑家", true, false],
  ["delhome", "删除家（需表单确认）", true, false],
  ["publichomes", "查看公开的家", false, false],
  ["warps", "查看公共传送点", false, false],
  ["warp", "前往公共传送点", true, false],
  ["setwarp", "创建公共传送点", true, true],
  ["delwarp", "删除公共传送点", true, true],
  ["spawn", "返回主城", false, false],
  ["setspawn", "设置主城", false, true],
  ["back", "返回上一地点", false, false],
  ["death", "前往死亡地点", false, false],
  ["rtp", "主世界随机传送", false, false],
  ["history", "查看最近的出发地点", false, false],
  ["tpa", "请求传送到玩家", true, false],
  ["tpahere", "邀请玩家传送到我这里", true, false],
  ["requests", "处理收到的请求", false, false],
  ["tpaccept", "接受最新请求", false, false],
  ["tpdeny", "拒绝最新请求", false, false],
  ["tpcancel", "取消传送或撤回请求", false, false],
  ["tptoggle", "开关传送请求", false, false],
];
