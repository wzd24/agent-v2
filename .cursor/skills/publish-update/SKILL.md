---
name: publish-update
description: >-
  Publishes a Scorpio Agent Windows update to GitCode: bump the synced version
  files, build the NSIS installer, commit and tag, push the gitcode remote,
  upload the installer, and replace the public latest.json feed. Use when the
  user asks to 发布更新, publish a release, or ship a new Scorpio Agent version.
---

# 发布更新

只在用户明确要求发布时执行。主题修改、修 bug、问版本都不算发布。

产品名是 Scorpio Agent。不要改 `local-codex`、`com.wzd24.localcodex`、协议名 `local-codex`，也不要改 `%APPDATA%\local-codex`。

## 版本号

在当前版本上加一个补丁号，除非用户指定了别的版本。下面六处必须是同一个版本，不要改其它包的版本：

- `package.json` 的 `version`
- `package-lock.json` 顶部两处：锁文件自己的 `version`，以及 `packages[""].version`
- `src-tauri/Cargo.toml` 的 `version`
- `src-tauri/Cargo.lock` 里 `name = "local-codex"` 那一条的 `version`
- `src-tauri/tauri.conf.json` 的 `version`
- `src-tauri/src/engine.rs` 里 `initialize` 的 `"version"`

不要改 `ui/package-lock.json`。

## 构建、提交、推送

在仓库根目录构建：

```powershell
npm run tauri -- build
```

安装包在 `src-tauri/target/release/bundle/nsis/Scorpio Agent_<version>_x64-setup.exe`。构建失败就停，不要打标签，也不要上传。

构建成功后再提交。提交信息用仓库已有的样式，一句话说明为什么发这个版本：

```text
发布 0.1.15，……。
```

只提交这次发布要带上的改动。不要提交密钥、`.env` 或临时发布脚本。然后打标签 `v<version>`。标签已经存在就停下来问用户，不要移动标签。

只推 `gitcode`（`git@gitcode.com:wzd24/agent.git`）：

```powershell
git push gitcode HEAD:main
git push gitcode v<version>
```

不要推 `origin`。不要改 git config，不要 force-push。远端不存在时再添加 `gitcode`。SSH 主机密钥校验失败时停下来告诉用户，不要继续上传。

## 上传到 GitCode

客户端不读 GitCode API。它读这个公开清单：

`https://gitcode.com/wzd24/agent/releases/download/feed/latest.json`

清单是一个对象，字段用 `version`、`notes`、`url`。`url` 必须是 HTTPS，路径以 `.exe` 结尾，而且服务器要支持 HTTP 206。安装包公开地址用连字符文件名：

`https://gitcode.com/wzd24/agent/releases/download/v<version>/Scorpio-Agent_<version>_x64-setup.exe`

把更新说明写成 UTF-8 JSON，放到临时目录，不要放进仓库：

```json
{ "notes": "给用户看的一两句中文说明。" }
```

令牌从环境变量 `GITCODE_TOKEN` 读取。没有就向用户要一次。不要把令牌写进仓库、技能、命令回显或提交说明。用过就从环境里清掉。

然后执行本技能里的脚本：

```powershell
$env:GITCODE_TOKEN = "<token>"
powershell -NoProfile -File .cursor/skills/publish-update/scripts/publish-gitcode.ps1 -Version "<version>" -InstallerPath "<nsis exe>" -NotesFile "<notes json>"
Remove-Item Env:GITCODE_TOKEN
```

脚本会创建 `v<version>` Release（已存在则继续），上传连字符文件名的安装包，先删除 `feed` Release 上的旧 `latest.json` 再上传新的。同名覆盖会留下旧文件，不能跳过删除。

脚本结束后核对它打印的清单版本、说明和安装包 HTTP 状态。安装包用 GET，期望 302；不要用 HEAD，也不要打印带签名的 CDN 地址。控制台里的中文可能是乱码，以脚本读出的 UTF-8 说明为准。

回复用户时给出发布页 `https://gitcode.com/wzd24/agent/releases/tag/v<version>`，并说明没有推送 GitHub `origin`。
