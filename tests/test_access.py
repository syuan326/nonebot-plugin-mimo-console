from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class AccessIntegrationTests(unittest.TestCase):
    def test_rules_runtime_and_restart(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mimo-access-") as temporary:
            env = os.environ.copy()
            env["PYTHONPATH"] = str(ROOT / "src")
            env["ACCESS_TEST_ROOT"] = temporary
            for kind in ["DATA", "CACHE", "CONFIG"]:
                env[f"LOCALSTORE_{kind}_DIR"] = str(Path(temporary) / kind.lower())
            env["PYTHONUTF8"] = "1"
            for phase in ["write", "reload", "auto-patch"]:
                result = subprocess.run(
                    [sys.executable, str(ROOT / "tests" / "access_scenario.py"), phase],
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
