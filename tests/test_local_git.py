from __future__ import annotations

import importlib
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
package = sys.modules.setdefault(
    "nonebot_plugin_mimo_console", types.ModuleType("nonebot_plugin_mimo_console")
)
package.__path__ = [str(ROOT / "src" / "nonebot_plugin_mimo_console")]
local_git = importlib.import_module("nonebot_plugin_mimo_console.local_git")


class LocalGitUpdateTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mimo-git-update-")
        self.addCleanup(self.temporary.cleanup)
        self.env = patch.dict(
            os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        self.root = Path(self.temporary.name)
        self.remote = self.root / "remote.git"
        self.seed = self.root / "seed"
        self.project = self.root / "bot"
        self.repo = self.project / "plugins" / "demo"
        self.repo.parent.mkdir(parents=True)
        self.git(self.root, "init", "--bare", "--initial-branch=main", str(self.remote))
        self.git(self.root, "clone", str(self.remote), str(self.seed))
        (self.seed / "src" / "demo").mkdir(parents=True)
        (self.seed / "src" / "demo" / "__init__.py").write_text("VERSION = 1\n", encoding="utf-8")
        self.commit(self.seed, "initial")
        self.git(self.seed, "push", "origin", "main")
        self.git(self.root, "clone", str(self.remote), str(self.repo))
        self.before = self.git(self.repo, "rev-parse", "HEAD")
        self.updater = local_git.LocalGitUpdater()

    def git(self, cwd, *args):
        result = subprocess.run(
            [
                "git",
                "-C",
                str(cwd),
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                *args,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout.strip()

    def commit(self, repo, message):
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", message)

    def advance(self):
        (self.seed / "src" / "demo" / "__init__.py").write_text("VERSION = 2\n", encoding="utf-8")
        self.commit(self.seed, "upstream update")
        self.git(self.seed, "push", "origin", "main")
        return self.git(self.seed, "rev-parse", "HEAD")

    async def test_fast_forward_and_already_current(self):
        expected = self.advance()
        path = self.repo / "src" / "demo"
        self.assertEqual(local_git.find_plugin_repository(str(path), self.project), self.repo)
        items = local_git.annotate_git_plugins([{"path": str(path)}], self.project, "local")
        self.assertTrue(items[0]["update_supported"])
        self.assertEqual(items[0]["git_branch"], "main")
        result = await self.updater.update(self.repo, self.project, "demo", 30)
        self.assertEqual(result.status, "succeeded", result.error)
        self.assertTrue(result.restart_required)
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), expected)
        self.assertEqual((path / "__init__.py").read_text(), "VERSION = 2\n")
        self.assertEqual(self.git(self.repo, "status", "--porcelain"), "")
        result = await self.updater.update(self.repo, self.project, "demo", 30)
        self.assertEqual(result.status, "succeeded", result.error)
        self.assertFalse(result.restart_required)

    async def test_tracked_changes_and_untracked_files_are_preserved(self):
        self.advance()
        tracked = self.repo / "src" / "demo" / "__init__.py"
        tracked.write_text("LOCAL = True\n")
        result = await self.updater.update(self.repo, self.project, "demo", 30)
        self.assertEqual(result.status, "failed")
        self.assertIn("未提交", result.error)
        self.assertEqual(tracked.read_text(), "LOCAL = True\n")
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.before)
        tracked.write_text("VERSION = 1\n")
        extra = self.repo / "local-config.txt"
        extra.write_text("keep me")
        result = await self.updater.update(self.repo, self.project, "demo", 30)
        self.assertEqual(result.status, "failed")
        self.assertEqual(extra.read_text(), "keep me")
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.before)

    async def test_diverged_history_never_resets_local_commits(self):
        (self.repo / "local.py").write_text("keep = True\n")
        self.commit(self.repo, "local commit")
        before = self.git(self.repo, "rev-parse", "HEAD")
        self.advance()
        result = await self.updater.update(self.repo, self.project, "demo", 30)
        self.assertEqual(result.status, "failed")
        self.assertIn("分叉", result.error)
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), before)
        self.assertTrue((self.repo / "local.py").exists())

    async def test_untracked_upstream_and_detached_head_are_rejected(self):
        self.git(self.repo, "branch", "--unset-upstream")
        result = await self.updater.update(self.repo, self.project, "demo", 30)
        self.assertEqual(result.status, "failed")
        self.assertIn("上游", result.error)
        self.git(self.repo, "checkout", "--detach", "HEAD")
        result = await self.updater.update(self.repo, self.project, "demo", 30)
        self.assertEqual(result.status, "failed")
        self.assertIn("detached", result.error)

    async def test_new_local_edits_during_fetch_stop_the_merge(self):
        self.advance()
        run = self.updater._git

        async def git_with_edit(repo, *args):
            output = await run(repo, *args)
            if args[0] == "fetch":
                (repo / "created-during-fetch.txt").write_text("preserved")
            return output

        with patch.object(self.updater, "_git", side_effect=git_with_edit):
            result = await self.updater.update(self.repo, self.project, "demo", 30)
        self.assertEqual(result.status, "failed")
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.before)
        self.assertEqual((self.repo / "created-during-fetch.txt").read_text(), "preserved")

    async def test_failed_fetch_preserves_head(self):
        self.git(self.repo, "remote", "set-url", "origin", str(self.root / "missing.git"))
        result = await self.updater.update(self.repo, self.project, "demo", 30)
        self.assertEqual(result.status, "failed")
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.before)

    async def test_host_repository_and_external_checkout_are_excluded(self):
        self.git(self.project, "init", "--initial-branch=main")
        plugin = self.project / "plain_plugin"
        plugin.mkdir()
        self.assertIsNone(local_git.find_plugin_repository(str(plugin), self.project))
        self.assertIsNone(local_git.find_plugin_repository(str(self.seed), self.project))
        with self.assertRaises(local_git.GitUpdateError):
            await self.updater.update(self.project, self.project, "host", 30)
        with self.assertRaises(local_git.GitUpdateError):
            await self.updater.update(self.seed, self.project, "outside", 30)
