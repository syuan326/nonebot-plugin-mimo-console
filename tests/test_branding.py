from __future__ import annotations

import base64
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "src" / "nonebot_plugin_mimo_console" / "branding.py"
spec = importlib.util.spec_from_file_location("mimo_console_branding_test", MODULE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError("cannot load branding module")
branding = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = branding
spec.loader.exec_module(branding)

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
)
PNG_URL = "data:image/png;base64," + base64.b64encode(PNG).decode("ascii")


class BrandingStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = branding.BrandingStore(self.root / "branding.json", self.root / "icons")

    def test_defaults_and_title_persist_across_reloads(self) -> None:
        self.assertEqual(self.store.snapshot(), {"title": "Mimo Console", "icon_filename": ""})
        self.store.update("  帕朵的控制台  ")
        reloaded = branding.BrandingStore(self.root / "branding.json", self.root / "icons")
        self.assertEqual(reloaded.snapshot()["title"], "帕朵的控制台")

    def test_rejects_invalid_titles_without_changing_state(self) -> None:
        self.store.update("原来的标题")
        for title in ["", "   ", "x" * 81, "a\nb", "a\0b"]:
            with self.subTest(title=title), self.assertRaises(branding.BrandingError):
                self.store.update(title)
        self.assertEqual(self.store.snapshot()["title"], "原来的标题")

    def test_icon_persists_and_title_only_updates_keep_the_icon(self) -> None:
        snap = self.store.update("自定义", "replace", PNG_URL)
        filename = snap["icon_filename"]
        self.assertRegex(filename, r"^[0-9a-f]{32}\.png$")
        self.assertEqual(self.store.resolve_file(filename).read_bytes(), PNG)
        reloaded = branding.BrandingStore(self.root / "branding.json", self.root / "icons")
        self.assertEqual(reloaded.snapshot(), snap)
        self.assertEqual(reloaded.update("新标题")["icon_filename"], filename)

    def test_replacing_and_removing_icons_cleans_up_old_files(self) -> None:
        first = self.store.update("A", "replace", PNG_URL)["icon_filename"]
        second = self.store.update("B", "replace", PNG_URL)["icon_filename"]
        self.assertNotEqual(first, second)
        self.assertFalse((self.root / "icons" / first).exists())
        self.assertEqual(self.store.update("Mimo Console", "remove")["icon_filename"], "")
        self.assertFalse((self.root / "icons" / second).exists())

    def test_invalid_or_oversized_image_does_not_change_existing_identity(self) -> None:
        old = self.store.update("保留", "replace", PNG_URL)
        for value in [
            "data:image/svg+xml;base64," + base64.b64encode(b"<svg/>").decode(),
            "data:image/png;base64,not-valid!",
            "data:image/png;base64," + base64.b64encode(b"<html>fake</html>").decode(),
            "data:image/png;base64,"
            + base64.b64encode(b"a" * (branding.MAX_ICON_BYTES + 1)).decode(),
        ]:
            with self.subTest(value=value[:60]), self.assertRaises(branding.BrandingError):
                self.store.update("不应生效", "replace", value)
        self.assertEqual(self.store.snapshot(), old)

    def test_write_failure_preserves_old_metadata_and_icon(self) -> None:
        old = self.store.update("原始", "replace", PNG_URL)
        with (
            patch.object(self.store, "_write", side_effect=OSError("disk unavailable")),
            self.assertRaises(OSError),
        ):
            self.store.update("新标题", "replace", PNG_URL)
        self.assertEqual(self.store.snapshot(), old)
        self.assertEqual(len(list((self.root / "icons").iterdir())), 1)

    def test_file_lookup_rejects_traversal_and_missing_files(self) -> None:
        for name in ["../branding.json", "x.svg", "a" * 32 + ".png"]:
            with self.subTest(name=name), self.assertRaises(branding.BrandingError):
                self.store.resolve_file(name)

    def test_corrupt_settings_fall_back_to_defaults(self) -> None:
        self.store.data_file.write_text("bad json", encoding="utf-8")
        reloaded = branding.BrandingStore(self.store.data_file, self.store.image_dir)
        self.assertEqual(reloaded.snapshot()["title"], "Mimo Console")
        self.store.data_file.write_text(
            json.dumps({"title": "", "icon_filename": "../private.png"}), encoding="utf-8"
        )
        reloaded = branding.BrandingStore(self.store.data_file, self.store.image_dir)
        self.assertEqual(reloaded.snapshot(), {"title": "Mimo Console", "icon_filename": ""})


class BrandingApiTests(unittest.TestCase):
    def test_public_display_authenticated_writes_and_escaped_html(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            env = os.environ.copy()
            env["PYTHONPATH"] = str(ROOT / "src")
            for kind in ["DATA", "CACHE", "CONFIG"]:
                env[f"LOCALSTORE_{kind}_DIR"] = str(Path(temporary) / kind.lower())
            env["BRANDING_TEST_ICON"] = PNG_URL
            script = textwrap.dedent(
                """
                import os
                import nonebot
                from fastapi.testclient import TestClient

                nonebot.init(driver="~fastapi")
                plugin = nonebot.load_plugin("nonebot_plugin_mimo_console")
                assert plugin is not None
                console = plugin.module.console_state
                with TestClient(nonebot.get_app()) as client:
                    original = client.get("/mimo-console/api/branding").json()
                    assert original == {"title": "Mimo Console", "icon_url": ""}
                    response = client.put("/mimo-console/api/branding", json={"title":"bad"})
                    assert response.status_code == 401
                    raw = console.auth.setup(console.setup_token, "testadmin", "Brand-Test-123!")
                    headers = {"Authorization": "Bearer " + raw}
                    title = "<script>alert('title')</script>"
                    response = client.put("/mimo-console/api/branding", headers=headers, json={
                        "title": title, "icon_action": "replace",
                        "icon_data_url": os.environ['BRANDING_TEST_ICON'],
                    })
                    assert response.status_code == 200, response.text
                    saved = response.json()
                    icon = client.get(saved['icon_url'])
                    assert icon.status_code == 200
                    assert icon.headers['content-type'] == "image/png"
                    assert icon.headers['x-content-type-options'] == "nosniff"
                    html = client.get("/mimo-console/").text
                    assert "<title>&lt;script&gt;" in html
                    assert '<title><script>' not in html
                    assert saved['icon_url'] in html
                    response = client.put(
                        "/mimo-console/api/branding", headers=headers, json={"title":" "},
                    )
                    assert response.status_code == 400
                    assert client.get("/mimo-console/api/branding").json() == saved
                    response = client.put("/mimo-console/api/branding", headers=headers, json={
                        "title": "Mimo Console", "icon_action": "remove",
                    })
                    assert response.status_code == 200
                    assert response.json() == original
                    assert client.get(saved['icon_url']).status_code == 404
                    assert client.get("/mimo-console/assets/favicon.svg").status_code == 200
                """
            )
            result = subprocess.run(
                [sys.executable, "-c", script],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
