# Git 提交与推送指南

本文说明如何将本项目的修改安全地提交并推送到 GitHub。

## 首次配置

确认远程仓库使用 SSH：

```bash
git remote -v
git remote set-url origin git@github.com:kdykdy7991/Debussy.git
```

如果本机还没有 SSH 密钥，可创建一个：

```bash
ssh-keygen -t ed25519 -C "your-email@example.com"
```

将公钥内容添加到 [GitHub SSH Keys](https://github.com/settings/keys)：

```bash
sed -n "1p" ~/.ssh/id_ed25519.pub
```

然后验证连接：

```bash
ssh -T git@github.com
```

不要提交私钥、访问令牌、`.env` 文件或其他凭据。

## 日常提交

先确认当前分支和修改范围：

```bash
git branch --show-current
git status --short
git diff
```

只暂存本次修改的明确路径，不要使用 `git add .` 或 `git add -A`：

```bash
git add path/to/file1 path/to/file2
git diff --cached
```

代码修改在提交前必须运行检查：

```bash
npm run check
```

如果修改或新增了测试文件，还要运行对应测试。提交信息格式为：

```text
{feat,fix,docs}[(ai,tui,agent,coding-agent)]: 简洁说明
```

示例：

```bash
git commit -m "docs: add Git contribution guide"
git commit -m "fix(coding-agent): handle interrupted tool calls"
```

提交后检查结果：

```bash
git status --short
git log -1 --oneline
```

## 推送到 GitHub

首次推送当前分支时设置上游分支：

```bash
git push -u origin main
```

后续推送可直接运行：

```bash
git push
```

推送前如果远程已有其他人的更新，先获取并检查差异，避免直接覆盖：

```bash
git fetch origin
git log --oneline --left-right HEAD...origin/main
```

不要强制推送。需要整合远程提交或发生冲突时，先确认其他人的修改，再决定合并或变基。

## 本项目注意事项

- 不要提交 `node_modules/`、临时调试脚本、备份目录或凭据。
- 不要使用 `git reset --hard`、`git clean -fd`、`git stash` 等可能破坏其他并行工作的命令。
- 只提交自己本次修改的文件；提交前使用 `git diff --cached` 复核。
- 不要直接修改 `packages/ai/src/models.generated.ts`；应修改生成脚本后重新生成。
- 依赖和锁文件变更需要按 `AGENTS.md` 中的安全规则处理。
- 未经明确要求，不要创建提交；由操作者确认后再执行 `git commit`。

更完整的开发和协作规则见 [AGENTS.md](../AGENTS.md) 与 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 常见问题

### `Permission denied (publickey)`

确认远程地址为 SSH、密钥已添加到 GitHub，并重新运行 `ssh -T git@github.com`。

### HTTPS 要求用户名或令牌

将远程地址切换为 SSH：

```bash
git remote set-url origin git@github.com:kdykdy7991/Debussy.git
```

### 推送被拒绝

通常表示远程分支包含本地没有的提交。运行 `git fetch origin` 并检查差异，不要使用 `--force` 绕过。
