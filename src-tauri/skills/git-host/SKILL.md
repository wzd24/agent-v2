---
name: git-host
description: 用 Local Codex 的 git-host MCP 查询或创建 GitLab 合并请求、GitHub Pull Request 和评论。用户提到合并请求、MR、PR、流水线、评论、仓库图时使用；不要用 git/gh/glab 代替。
---

# GitLab / GitHub 集成

当前工作区若已启用 GitLab 或 GitHub，必须用 `git-host` MCP 工具或资源，不要用 `git log`、`git show`、`gh`、`glab`、curl 或 GitHub/GitLab REST。

`list_mcp_resources` 只列资源，不能用来判断工具在不在。直接调用 `git_status` / `git_merge_requests`，或读取 `git-host://status`、`git-host://merge-requests`。

## 查询顺序

1. `git_status`：确认当前是 GitLab 还是 GitHub，以及项目路径。
2. 列表：`git_merge_requests`。
3. 详情：`git_merge_request`（编号用 `iid`）。默认会带讨论、提交、流水线；要文件变更时加上 `include: ["diffs"]`。
4. 仓库图：`git_graph`。提交 diff：`git_commit_diff`。
5. 创建：`git_create_merge_request`。对话评论：`git_create_note`。行级审查：`git_create_review_comment`（需要 `path` 和 `newLine`/`oldLine`，以及 head/base SHA）。

本地改文件、提交、推送仍用普通 git。
