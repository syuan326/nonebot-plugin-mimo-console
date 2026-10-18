from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PluginUpdateApiTests(unittest.TestCase):
    def test_update_installed_and_source_plugins_without_store_lookup(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mimo-plugin-update-") as temporary:
            env = os.environ.copy()
            env["PYTHONPATH"] = str(ROOT / "src")
            env["PYTHONUTF8"] = "1"
            env["PLUGIN_UPDATE_ROOT"] = temporary
            for kind in ["DATA", "CACHE", "CONFIG"]:
                env[f"LOCALSTORE_{kind}_DIR"] = str(Path(temporary) / kind.lower())
            result = subprocess.run(
                [sys.executable, str(ROOT / "tests" / "plugin_update_scenario.py")],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=90,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
