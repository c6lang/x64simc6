---
name: release
description: 发布 x64simc6 新版本：从提交文本自动生成发布说明、打包 src/dist/firmware 三件产物、打 tag 并触发 GitHub Release。用户说“发布版本 / 发版 / 出个 release / cut a release”时使用。
version: 1.0.0
---

# 发布 x64simc6

仓库根目录下的发布流程。发布说明**自动从提交文本生成**（`tools/release.py`），
人只需要维护 `docs/RELEASE.md` 的概述和版本号。

## 前置条件

- `git status` 干净；C6 工具链可用（`~/c6/c6c/build/c6c`、`~/c6/tcc/c6`，
  也可用 `C6C` / `TCC` 环境变量指定）。
- 固件需要 `build/alpine/`（内核 + 带 slip/slhc 的模块树 + minirootfs）；
  新机器先跑：
  ```sh
  python3 tools/fetch_alpine.py --dest build/alpine
  ```
- CI 需要一个带 C6 工具链的自托管 runner（workflow 默认
  `runs-on: [self-hosted, linux]`），仓库变量 `C6C` / `TCC` 可覆盖路径。

## 发布步骤

1. **确认版本与说明**。更新：
   - `README.md` 标题 `# x64simc6 vX.Y` 与「当前状态」段；
   - `docs/RELEASE.md` 顶部加 `## vX.Y 变更（相对 v<prev>）`（这个小节会被
     自动放进 Release 正文的「发布说明」部分；提交分组由脚本生成）；
   - `TODO.md` 勾选发布项。
2. **提交**：`git commit -m "docs(release): vX.Y —— …"`。
3. **预览自动生成的说明**（可选）：
   ```sh
   python3 tools/release.py --tag vX.Y --notes-only
   ```
4. **打 tag**：
   ```sh
   git tag -a vX.Y -m "vX.Y: <一句话>"
   ```
5. **本地一键发布**（默认先跑 `./build.sh test`，再打三件产物）：
   ```sh
   python3 tools/release.py --tag vX.Y
   ```
   产物在 `build/release/vX.Y/`：`RELEASE_NOTES.md`、`x64simc6-X.Y-src.tar.gz`、
   `x64simc6-X.Y-dist.tar.gz`、`x64simc6-X.Y-firmware.tar.gz`、`SHA256SUMS`、
   `RELEASE.md`。
6. **推 tag 让 CI 发布**：
   ```sh
   git push origin vX.Y
   ```
   `.github/workflows/release.yml` 在 tag 推送或手动 dispatch 时，用同一个
   `tools/release.py` 生成说明和产物，并创建 GitHub Release、上传
   `*.tar.gz` + `SHA256SUMS`。

## 参数速查

| 参数 | 说明 |
| --- | --- |
| `--tag vX.Y` | 要发布的 tag（默认取 HEAD 上的 tag） |
| `--out DIR` | 产物目录（默认 `build/release/<tag>`） |
| `--notes-only` | 只生成并打印 `RELEASE_NOTES.md` |
| `--no-test` | 跳过 `./build.sh test`（不建议） |
| `--with-firmware auto\|yes\|no` | 固件策略；`auto` 看 `build/alpine` 是否存在（默认） |
| `--repo URL` | 生成 compare 链接（默认读 `$RELEASE_REPO_URL`） |
| `--allow-dirty` | 允许未提交改动（默认拒绝） |

## 验收闸门（发布前必须全绿）

```sh
./build.sh test                                     # native/单元/CPL3/pcache/wasm
./tests/smoke.sh                                    # 上面 + headless Chromium e2e
SIM=build/sim python3 tools/difftest/difftest.py    # 1252/1252
python3 tools/boot_login.py                         # PASS: … 'uname -m'
```

guest 网络（native 固件里，到 `login:` 后）：

```sh
ping -c1 10.0.2.2
ping -c1 10.0.2.3
wget -O /dev/null http://example.com/
wget -O /dev/null https://qq.com/     # 证书校验依赖 RTC，应通过
```

源码包独立构建（发布后抽查）：

```sh
tar xzf build/release/vX.Y/x64simc6-X.Y-src.tar.gz -C /tmp
( cd /tmp/x64simc6-X.Y && ./build.sh test )
```

## 常见问题

- **`sl0` 不存在**：固件没带 SLIP 模块。看 `mkfw` 有没有打印
  「注入 SLIP 模块」；guest 里 `cat /init`、`ls /lib/modules/$(uname -r)/kernel/drivers/net/slip/`。
- **HTTPS 证书校验失败**：guest 时钟不对（RTC 未实现/未生效），`date -u`
  应是宿主时间；见 `docs/DESIGN.md` §96。
- **CI 报 `build/alpine` 缺失**：脚本会尝试 `tools/fetch_alpine.py`；离线
  runner 需要预置 `build/alpine`。
- **tag 打错**：`git tag -d vX.Y && git push origin :refs/tags/vX.Y`，
  产物目录 `build/release/vX.Y/` 删掉重跑即可。
