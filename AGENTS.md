# tabby-secure-mcp 仓库指引

## 预发布流程

本仓库的预发布包括版本准备、PR 合并、发布校验和按请求推送 Git 标签。将合并、标签推送和 npm 发布分别报告。用户只要求合并 `main` 时，完成合并和同步即可。用户要求推送标签时，推送指定标签。正式发布 npm 需要用户明确授权。

### 1. 提版本与验证

- 从最新的 `origin/main` 创建 `codex/` 分支，只提交本次发布的改动。兼容的缺陷修复递增补丁版本，例如 `0.1.0` → `0.1.1`。用户指定版本时以其要求为准。
- 同步根目录与三个 npm 工作区的 `package.json`、工作区之间的版本引用及 `package-lock.json`。同步 [MCP 服务版本](packages/companion/src/mcp/server.ts) 和 [打包校验的 `EXPECTED_VERSION`](scripts/pack-check-core.mjs)。本地安装器复用该常量，历史版本回归用例保留对应的旧版本。
- 按下面的顺序执行检查。干净检出或依赖尚未安装时，先执行 `npm ci`。涉及 Angular 模板时，加跑 `npm run test:templates --workspace=tabby-secure-mcp`。

```sh
npm run typecheck
npm test
npm run test:integration
npm run build
npm run pack:check
```

完整的本地打包和 npm dry run 可用 `bash scripts/release.sh --check`。该命令会重新安装依赖并执行检查，详细说明见 [npm 发布文档](docs/publishing.md)。

### 2. 合并到 main

- 提交分支并向 `main` 开 PR。检查 PR 范围和目标分支，等 GitHub 要求的 Linux、macOS、Windows、CodeQL 和依赖审查通过后合并。以 GitHub 当前分支保护规则为准。
- 合并后同步本地 `main`，核对远端已包含该 PR，记录合并提交 SHA。若合并后的文件内容与已验证的候选一致，可复用原检查结果。若合并解决了冲突或引入了相关改动，重跑受影响的检查。

### 3. 创建并校验标签

从干净的本地检出执行。先确认 `HEAD` 是本次 PR 的合并提交且已进入 `origin/main`。标签使用与插件版本匹配的稳定格式 `vX.Y.Z`。如果本地或远端已有同名标签，先核对它的目标提交，保留已推送的标签。

```sh
release_tag="v$(node -p 'require("./packages/tabby-plugin/package.json").version')"
release_commit="$(git rev-parse HEAD)"
git fetch origin &&
git merge-base --is-ancestor "$release_commit" origin/main &&
git tag -a "$release_tag" "$release_commit" -m "Release $release_tag"
```

创建标签后，在同一 shell 和同一检出中执行发布校验。若已有指向正确提交的本地标签，直接运行此检查。

```sh
GITHUB_REPOSITORY=woodynew/tabby-secure-mcp \
RELEASE_TAG="$release_tag" \
GITHUB_REF="refs/tags/$release_tag" \
GITHUB_SHA="$release_commit" \
node scripts/release-check.mjs
```

预期输出 `Release source, tag and package version verified`。若 Git 无法解析 `refs/tags/<tag>^{commit}`，先确认本地存在该标签。脚本还要求 `HEAD`、标签解析出的提交与 `GITHUB_SHA` 一致，且该提交包含在 `origin/main` 中。[发布校验脚本](scripts/release-check.mjs)

### 4. 推送并验证指定标签

本地校验通过且任务包含标签推送时，执行：

```sh
git push origin "refs/tags/$release_tag:refs/tags/$release_tag" &&
git ls-remote --exit-code origin "refs/tags/$release_tag" "refs/tags/$release_tag^{}"
```

核对远端注解标签的 `^{}` 行等于 `release_commit`，在交付时记录版本、PR、合并提交、标签状态、检查结果和仍待完成的桌面验收。标签推送完成后，npm 发布仍需手动触发。

## 正式发布到 npm

已获正式发布授权后，在对应的 Git 标签上手动触发 GitHub Actions。运行 ref 与输入 `tag` 必须一致。工作流通过 npm Trusted Publishing 只发布 `packages/tabby-plugin`。[发布工作流](.github/workflows/publish.yml)

```sh
gh workflow run publish.yml --repo woodynew/tabby-secure-mcp --ref "$release_tag" -f "tag=$release_tag"
```

等待工作流完成，再通过 npm 官方 registry 核对精确版本、`latest` 和 provenance。遇到失败或结果不明时，先查看工作流和 registry 状态再决定是否重试。Trusted Publisher 配置见 [npm 发布文档](docs/publishing.md)。
