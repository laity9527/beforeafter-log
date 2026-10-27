# 前后志 / beforeafter-log

不囤想法，直接上线。每个作品都留下**做之前的判断**和**做之后的实现**，两条时间戳和段落指纹钉在 Git 里，任何人可以自己核对。

线上：<https://build.laity.work>（同一份构建也服务 <https://beforeafter-log.pages.dev>）

- 首页 `← 返回 Laity` 指向主站 <https://laity.work>
- 方法论：<https://build.laity.work/about/>
- 发布后台：`/admin/`（`robots.txt` 已 Disallow，页面本身 noindex）

## 一句话主张

大多数「开发日志」只写结果。这里把判断和结果分成两段同时公开，并且给判断段上了哈希锚：**写完 BEFORE、封存、再动手**。这样事后改写正文会被构建直接拦下。

## 内容模型

一条日志 = `src/content/logs/<slug>.md`，schema 在 `src/content.config.ts`：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 标题 |
| `work_slug` | ✅ | 约定等于文件名，定了不要改 |
| `tags` | ✅ | 字符串数组，目前只做展示 |
| `before_written_at` | ✅ | 写下判断的日期 |
| `after_written_at` | ⬜ | 兑现/验证的日期；缺时时详情页 AFTER 段显示「未到验证期」灰虚线框 |
| `lesson_learned` | ⬜ | 一句话结论，也被用作列表摘要和 og:description |

正文必须有 `## BEFORE`；`## AFTER` 由接口写入。`deferRender: false` 是承重墙——详情页和这一段读的都是 `entry.rendered.html`。

## 存证协议

`src/utils/seal.ts` + `scripts/seal.mjs` + `src/pages/log/[slug].astro` 三处构成闭环：

1. **双层 SHA-256**
   - 整文件指纹：只做 CRLF→LF 归一化，所以它**等于** `raw.githubusercontent.com` 上那份字节的 `sha256sum`，读者一条命令可复算。
   - 段落指纹：从 `## BEFORE` 标题行起，到下一个 `## ` 或文件末尾，含标题行，额外裁尾部空白（多留几个空行不算造假）。
2. **commit 锚定**：封存对象取自 `git show <commit>:<path>`，绝不取工作区；工作区脏就拒绝封存。记录里的 `commit` 是最后一次改动该 `.md` 的提交。
3. **sidecar 账本**：`<slug>.seal.json` 与被哈希的文件分开存，写进 `.md` 就是自指。**只追加**，一条记录 = `{stage, section_sha256, file_sha256, commit, sealed_at}`。
4. **构建门禁**：详情页渲染前跑 `verifyLedger`，正文与账本对不上就抛错，构建红，绝不静默渲染被改过的内容。
5. **账本自身的门禁**：`npm run verify:seals` 不信任工作区那份账本，而是把每条记录拿锚定提交的原文重算一遍，并从 git 历史里核对账本有没有被删或被回滚。少了这一步，删掉 `.seal.json` 就等于没有门禁。这一条已经接进 `npm run build`，也是 `.github/workflows/ci.yml` 的第一步（CI 用 `fetch-depth: 0` 拿完整历史；没有 git 或浅克隆时脚本会明确 warn「这三项未执行」而不是假装通过）。
6. **网页校验器 `/verify/`**：读者不用命令行也能复算。浏览器侧是 `src/utils/seal-web.ts` 这套独立实现（`seal.ts` 依赖 `node:crypto`，是为协议口径服务的，没为展示页改动它）；两边逐字节等价由 `npm run verify:web` 用真实日志与 15 组边界输入对拍保证，其中包括「与线上账本公布的指纹相符」和「远端 raw 字节复算相符」两条。

### 读者怎么自己核对

整份文件（详情页底部直接给了这条命令）：

```sh
curl -sL https://raw.githubusercontent.com/laity9527/beforeafter-log/main/src/content/logs/why-this-site.md | sha256sum
```

输出的十六进制应当等于页面上的「整份文件 SHA-256（按 LF 换行）」（`why-this-site` 目前是 `664b1cc4e604…`）。

段落指纹不能直接 `sha256sum` 整份文件，得先按协议把那一段切出来：从 `## BEFORE` 标题行起，到下一个 `## ` 之前，含标题行，裁掉尾部空白且**不带结尾换行**。下面这条管道在 Linux / Git Bash 上实测与账本里的 `e5e3a2699d51…` 逐字节相符：

```sh
curl -sL https://raw.githubusercontent.com/laity9527/beforeafter-log/main/src/content/logs/why-this-site.md \
  | awk '/^##[[:space:]]+BEFORE/{f=1;s=""} f&&/^##[[:space:]]/&&!/^##[[:space:]]+BEFORE/{exit} f{s = s (s=="" ? "" : "\n") $0} END{gsub(/[[:space:]]+$/,"",s); printf "%s",s}' \
  | sha256sum
```

换成 AFTER 段就把两处 `BEFORE` 一起改掉。注意这条管道区分大小写，而 `src/utils/seal.ts` 的段落判定不区分（`## before` 也算）；真要严格复算，以 `node` 直接调用仓库里那个函数为准，或者直接打开 <https://build.laity.work/verify/> 粘贴原文：

```sh
node --input-type=module -e "
import {readFileSync} from 'node:fs';
import {extractSection, hashSection} from './src/utils/seal.ts';
const t = readFileSync('src/content/logs/why-this-site.md','utf8');
console.log(hashSection(extractSection(t,'before')));
"
```

锚定提交本身可以在 `commits/main/src/content/logs/<slug>.md` 里逐条看 diff。

### 它防什么，不防什么

- **防**：正文封存之后再被改动（整文件漂移）、某一段被单独改写（段落锚）、账本被删或被回滚（`verify:seals`）。
- **不防**：「在动手之前其实没写，事后补一篇再封存」。时间戳由作者自己填，构建只认内容不认日历。要堵这一条得引入外部时间锚（OpenTimestamps / RFC3161 TSA），本项目暂未接，属于已知且接受的残余风险。

## 命令

```sh
npm run dev              # astro dev（支持 --background / dev status / dev logs）
npm run build            # 先跑 verify:seals 再 astro build；门禁红则不产出
npm run preview          # 本地起构建产物
npm run seal -- <slug> before|after   # 封存一段，内容必须已提交且工作区干净
npm run verify           # 接口响应判定（readApiResponse / isSuccessfulResponse）
npm run verify:functions # 配额时区与 Origin 校验
npm run verify:seals     # 从 git 重算全部封存记录（需要完整历史，浅克隆会降级并给出 warn）
npm run verify:web         # /verify 页面的浏览器实现与协议实现对拍
npm run verify:after       # 补 AFTER 接口：假 GitHub 走一遍全部分支（含不强推、不留半提交）
```

## 发布后台与接口

Cloudflare Pages Functions，代码在仓库根的 `functions/`：

- `POST /api/publish` — 校验密码与字段，拼出符合 schema 的 Markdown，用 GitHub Contents API 建**新**文件，提交信息 `log: add new log [title]`。同名文件直接 409，不覆盖已封存的日志（覆盖会打红构建门禁）。
- `POST /api/after` — 给**已发布**的日志在线补 AFTER。只改 frontmatter 的 `after_written_at` 和 `## AFTER` 段，改完立刻比对 `## BEFORE` 的字节，动了一点就中止；封存记录追加不进 `.md`，仍写进 `.seal.json`。正文与账本分两次提交，但 `refs/heads/main` 只在最后 `PATCH` 一次（`force: false`），所以不会出现「main 上已经有新正文、账本还是旧的」这种门禁红着的中间态；期间分支被他人推进则回 409，绝不强推。
- 两个「新建」路径的口径没变：`/api/publish` 遇到同名文件仍然 409 拒绝覆盖，补内容一律走 `/api/after`。
- `POST /api/analyze` — 收 `commit_hash`，读那个 commit 的 diff，让模型产出草稿。**AI 只写 AFTER**：模型自己编的 `## BEFORE` 会被后端整段丢弃、换成占位句，前端也拦住占位句不许提交。这条约束的理由是接口跑在 commit 之后，反推的「当初判断」是回溯性虚构，一旦进 `logs/` 再封存就会被洗成不可篡改的历史证据。

三个接口都做了：常量时间比对密码、仓库白名单锁死 `laity9527/beforeafter-log`、控制字符与二级标题拒收、跨站 `Origin` 拒绝（无 Origin 的 curl 排障照旧放行）。配额（KV，按东八区自然日先扣后干活）只有 `/api/analyze` 需要，因为它是唯一花钱的那个。

### 环境变量（都在 Pages 面板里配，仓库里没有）

必需：`ADMIN_PASSWORD`、`GITHUB_TOKEN`、`OPENAI_API_KEY`，以及一个**必须叫 `ANALYZE_LIMITS` 的 KV namespace 绑定**（写成变量或 Secret 会在运行时抛错）。
可选：`LLM_BASE_URL`（默认 `https://api.openai.com/v1`）、`LLM_MODEL`（默认 `gpt-4o-mini`）、`ANALYZE_DAILY_LIMIT`（默认 20）。
缺任一项接口直接 500 fail-closed，`detail` 只列变量名不列值。

`GITHUB_TOKEN` 要能写内容：`/api/publish` 走 Contents API，`/api/after` 走 Git Data API（`/git/blobs`、`/git/trees`、`/git/commits`、`PATCH /git/refs/heads/main`），两者同属 `contents` 权限；fine-grained token 要把仓库范围设为可读写内容。

### 排障开关 `dry_run`

`/api/analyze` 请求体带 `"dry_run": true` 时，只走到「拼好 prompt」为止就返回：commit 摘要、纳入了几个文件、是否截断、prompt 字符数与开头 400 字、当日配额。用来区分被平台杀掉的是前半段（GitHub + 摘要）还是模型子请求——502 复现不了的时候先打这个。

## 部署

Cloudflare Pages，构建命令走 `npm run build`，Functions 由 `functions/` 目录自动挂载，无需 adapter。自定义域 `build.laity.work` 必须**加进 Pages 项目的 Custom domains**（只在 DNS 挂一条 proxied CNAME 不够，那样 `/api/*` 不会进 Functions）。

`astro.config.mjs` 里的 `site` 决定 canonical / og:url / sitemap 的 host，改它会让所有已分享链接的规范化地址换 host。

若在 CI 里跑 `npm run verify:seals`，检出必须是完整历史（`fetch-depth: 0`）；浅克隆下它会明确 warn 并只做工作区比对。

## 技术栈

Astro 7 + 一个 `@astrojs/sitemap`，运行依赖就这两个。纯静态输出，没有框架组件、没有数据库、没有用户系统——这是第 1 篇日志里写明「明确不做」的东西，别自己推翻自己。
