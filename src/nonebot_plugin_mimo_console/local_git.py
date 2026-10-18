"""Discover and fast-forward a loaded plugin's own nested Git checkout."""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from .backends.base import PackageOperation
from .backends.local import clean_output


class GitUpdateError(ValueError):
    pass


def git_environment() -> dict[str, str]:
    env = os.environ.copy()
    # Repository selection must come from the server-selected cwd, not the
    # environment of a shell that happened to start NoneBot.
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
        env.pop(name, None)
    env.update({"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never"})
    return env


def find_plugin_repository(path: str, project_root: Path) -> Path | None:
    if not path:
        return None
    root = project_root.resolve()
    candidate = Path(path).resolve()
    if not candidate.is_relative_to(root):
        return None
    if candidate.is_file():
        candidate = candidate.parent
    # Exclude the host project's own checkout: updating one plugin must not
    # pull the whole bot project. Resolve symlinks before checking containment.
    while candidate != root and candidate.is_relative_to(root):
        marker = candidate / ".git"
        if marker.is_file() or marker.is_dir():
            return candidate
        candidate = candidate.parent
    return None


def _read(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        env=git_environment(),
        timeout=10,
        check=False,
        **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
    )
    if result.returncode:
        raise GitUpdateError(clean_output(result.stderr) or "无法读取 Git 工作树信息")
    return result.stdout.decode("utf-8", errors="replace").strip()


def inspect_repository(repo: Path) -> dict[str, Any]:
    info: dict[str, Any] = {
        "local_git_path": str(repo),
        "git_branch": "",
        "git_commit": "",
        "update_supported": False,
        "update_reason": "",
    }
    if not shutil.which("git"):
        info["update_reason"] = "未找到 git，请先在运行环境安装 Git"
        return info
    try:
        if Path(_read(repo, "rev-parse", "--show-toplevel")).resolve() != repo.resolve():
            raise GitUpdateError("插件目录不是独立 Git 工作树")
        info["git_commit"] = _read(repo, "rev-parse", "HEAD")
        info["git_branch"] = _read(repo, "branch", "--show-current")
        if not info["git_branch"]:
            raise GitUpdateError("当前处于 detached HEAD，请先切换到跟踪上游的分支")
        if _read(repo, "status", "--porcelain", "--untracked-files=normal"):
            raise GitUpdateError("插件有未提交或未跟踪的文件，请先处理后再更新")
        try:
            upstream = _read(
                repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"
            )
        except GitUpdateError as exc:
            raise GitUpdateError("当前分支没有配置上游，请先设置跟踪分支") from exc
        info["git_upstream"] = upstream
        info["update_supported"] = True
    except (OSError, subprocess.TimeoutExpired, GitUpdateError) as exc:
        info["update_reason"] = str(exc)
    return info


def annotate_git_plugins(items: list[dict], project_root: Path, mode: str) -> list[dict]:
    for item in items:
        repo = find_plugin_repository(str(item.get("path") or ""), project_root)
        if repo is None:
            continue
        item.update(inspect_repository(repo))
        if mode == "docker-agent":
            item["update_supported"] = False
            item["update_reason"] = "本地 Git 工作树请在宿主机更新后重新构建容器"
    return items


class LocalGitUpdater:
    def __init__(self) -> None:
        self.operations: dict[str, PackageOperation] = {}

    async def _git(self, repo: Path, *args: str) -> str:
        process = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            str(repo),
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=git_environment(),
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
        )
        try:
            raw, _ = await process.communicate()
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        output = clean_output(raw)
        if process.returncode:
            raise GitUpdateError(output or "Git 更新失败")
        return output

    async def _update(self, repo: Path, operation: PackageOperation) -> None:
        info = await asyncio.to_thread(inspect_repository, repo)
        if not info["update_supported"]:
            raise GitUpdateError(info["update_reason"])
        branch = info["git_branch"]
        tracking = await self._git(
            repo,
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:remoteref)",
            f"refs/heads/{branch}",
        )
        remote, ref = tracking.split("\x00", 1)
        if not remote or not ref.startswith("refs/heads/"):
            raise GitUpdateError("上游分支信息不完整，请检查 Git 配置")
        operation.output = await self._git(
            repo,
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--",
            remote,
            ref,
        )
        current = await asyncio.to_thread(inspect_repository, repo)
        if not current["update_supported"]:
            raise GitUpdateError(current["update_reason"])
        if (current["git_branch"], current["git_commit"]) != (branch, info["git_commit"]):
            raise GitUpdateError("获取更新期间本地分支发生变化，请重新检查后再更新")
        target = await self._git(repo, "rev-parse", "FETCH_HEAD")
        try:
            await self._git(repo, "merge-base", "--is-ancestor", info["git_commit"], target)
        except GitUpdateError as exc:
            raise GitUpdateError(
                "本地分支包含额外提交或已分叉，无法快进更新；请先手动处理"
            ) from exc
        output = await self._git(
            repo,
            "-c",
            "submodule.recurse=false",
            "merge",
            "--ff-only",
            "--no-edit",
            "--no-autostash",
            target,
        )
        operation.output = "\n".join([operation.output, output]).strip()
        operation.restart_required = target != info["git_commit"]

    async def update(
        self,
        repo: Path,
        project_root: Path,
        module: str,
        timeout: int,
    ) -> PackageOperation:
        # Revalidate immediately before every mutation; clients never supply cwd.
        if find_plugin_repository(str(repo), project_root) != repo.resolve():
            raise GitUpdateError("插件 Git 工作树必须独立位于当前项目目录内")
        now = time.time()
        operation = PackageOperation(
            f"local-{uuid.uuid4().hex}",
            "update",
            module,
            repo.name,
            "preparing",
            created_at=now,
            updated_at=now,
        )
        self.operations[operation.operation_id] = operation
        try:
            await asyncio.wait_for(self._update(repo, operation), timeout)
            operation.status = "succeeded"
        except (OSError, ValueError, asyncio.TimeoutError) as exc:
            operation.status = "failed"
            operation.error = str(exc) or f"Git 更新超过 {timeout} 秒，已终止"
        operation.updated_at = time.time()
        return operation
