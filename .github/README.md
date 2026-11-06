# 公开 README 同步

`sync-public-readme.yml` 在私有仓库 `main` 每次 push 后执行，也可手动触发。目标是公开的 `Alexx-Powered/alex-bot-public`，只发布根 README 的公开部分、固定清单中的展示图、logo 和素材来源说明。

正文只有一个来源：根 `README.md`。`public-readme:private:start/end` 标记内部段落。导出器拒绝未闭合标记、未导出文件的相对链接、明显凭据或内部运行路径；不会复制 Git 历史、源码、运行数据或交接文档。新增展示图时更新 `scripts/export_public_readme.py` 的 `ASSETS`，并检查公开效果。

本地验证：

```powershell
python -m unittest discover -s scripts/tests -p test_public_readme.py
python scripts/export_public_readme.py --output codex-qq-plugin/test-output/public-readme-preview
```

输出目录须为空。同步后的 `.public-readme-sync.json` 记录导出文件的 SHA256，可用于远端回读。无内容变化时不创建空提交。

认证使用仅登记在目标仓库上的可写 deploy key；私钥保存在源仓库 Actions secret `ALEX_BOT_PUBLIC_DEPLOY_KEY`。主工作流的 `GITHUB_TOKEN` 只有源仓库读取权限，checkout 禁止持久保存凭据。SSH 主机公钥来自 GitHub `/meta`，固定在 `github-known-hosts`。部署密钥的权限依据见 [GitHub 官方说明](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)。

发布后核对工作流成功、目标仓库仍为 public，以及 README 和图片哈希；不能仅凭源仓库 push 成功就认定已同步。需要手动重试时：

```powershell
gh workflow run sync-public-readme.yml --repo Alexx-Powered/alex-bot --ref main
```

原始开发工作区的其他未提交改动不属于此同步流程；本流程不重启 ECS 服务。
