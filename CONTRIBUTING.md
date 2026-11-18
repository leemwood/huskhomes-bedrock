# 参与贡献

请先阅读 README 的适配版本和已知限制。使用 Node.js 24、Python 3.10+，运行：

```sh
npm ci
npm run check
npm test
npm run build
```

提交问题时提供游戏／BDS 版本、复现步骤、预期与实际行为，以及删去私人信息后的相关日志。不要提交世界存档、令牌、玩家身份数据或 node_modules。

修改后补充能够验证行为的测试，并在对应预览版中验证涉及的原生接口。发布新行为包版本时同时更新 package.json、package-lock.json、manifest header 和所有 module 的版本；保留 UUID 以兼容已有世界数据。提交到本仓库的贡献采用 MIT 许可证。
