import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import nonebot
from fastapi.testclient import TestClient

root = Path(os.environ["PLUGIN_UPDATE_ROOT"])
(root / "pyproject.toml").write_text(
    '[project]\nname="testbot"\n[tool.mimo_console.source_plugins.demo_source]\n'
    'project="demo-source"\nrepository="https://github.com/example/demo-source.git"\n',
    encoding="utf-8",
)
nonebot.init(
    driver="~fastapi",
    alembic_startup_check=False,
    mimo_console_project_root=root,
    log_level="WARNING",
)
assert nonebot.load_plugin("nonebot_plugin_mimo_console")
from nonebot_plugin_mimo_console import console_state
from nonebot_plugin_mimo_console.backends.base import PackageOperation
from nonebot_plugin_mimo_console.runtime import plugin_package_info

requests = []


class Backend:
    async def manage(self, request, timeout):
        requests.append(request)
        return PackageOperation(
            "update-test",
            request.action,
            request.module_name,
            request.project_name,
            "succeeded",
            restart_required=True,
        )


console_state.store.backend = Backend()

info = {"name": "demo", "module": "demo", "distribution": "demo-pypi", "update_supported": True}
records = {
    "demo": info,
    "local": {
        "name": "local",
        "module": "local",
        "distribution": "local",
        "update_supported": False,
        "update_reason": "local source",
    },
    "git_local": {
        "name": "git_local",
        "module": "git_local",
        "local_git_path": str(root / "plugins" / "git_local"),
        "update_supported": True,
    },
    "echo": {
        "name": "echo",
        "module": "nonebot.plugins.echo",
        "distribution": "nonebot2",
        "update_supported": False,
        "update_reason": "builtin",
    },
    "nonebot_plugin_mimo_console": {
        "name": "nonebot_plugin_mimo_console",
        "module": "nonebot_plugin_mimo_console",
    },
}
with (
    TestClient(nonebot.get_app()) as client,
    patch("nonebot_plugin_mimo_console.api.plugin_snapshot", return_value=list(records.values())),
    patch.object(console_state.store, "catalog", side_effect=AssertionError("store lookup")),
):
    path = "/mimo-console/api/plugins/"
    assert client.post(path + "demo/action", json={"action": "update"}).status_code == 401
    token = console_state.auth.setup(console_state.setup_token, "updateadmin", "Update-Test-123!")
    headers = {"Authorization": "Bearer " + token}
    response = client.post(path + "demo/action", json={"action": "update"}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["restart_required"]
    assert requests[-1].module_name == "demo"
    assert requests[-1].project_name == "demo-pypi"
    assert requests[-1].repository_url == ""
    response = client.post(path + "demo_source/action", json={"action": "update"}, headers=headers)
    assert response.status_code == 200, response.text
    assert requests[-1].repository_url == "https://github.com/example/demo-source.git"
    with patch.object(
        console_state.store, "update_local_git_plugin", new_callable=AsyncMock
    ) as update:
        update.return_value = {"ok": True, "restart_required": True}
        response = client.post(
            path + "git_local/action", json={"action": "update"}, headers=headers
        )
        assert response.status_code == 200, response.text
        update.assert_awaited_once_with(
            root,
            "git_local",
            root / "plugins" / "git_local",
            console_state.config.mimo_console_package_timeout,
        )
        response = client.post(
            path + "git_local/action", json={"action": "uninstall"}, headers=headers
        )
        assert response.status_code == 400
    count = len(requests)
    for name, status in [
        ("local", 400),
        ("echo", 400),
        ("unknown", 404),
        ("nonebot_plugin_mimo_console", 400),
    ]:
        response = client.post(path + name + "/action", json={"action": "update"}, headers=headers)
        assert response.status_code == status, response.text
    assert len(requests) == count
    console_state.config.mimo_console_allow_package_management = False
    assert client.post("/mimo-console/api/system/update", headers=headers).status_code == 403
    assert (
        client.post(path + "demo/action", json={"action": "update"}, headers=headers).status_code
        == 403
    )
    console_state.config.mimo_console_allow_package_management = True
    with patch.object(
        console_state.store.backend, "manage", side_effect=RuntimeError("update failed")
    ):
        response = client.post(path + "demo/action", json={"action": "update"}, headers=headers)
        assert response.status_code == 400 and "update failed" in response.text

# A path/editable package must not be replaced by a registry package.
for source, supported in [
    (None, True),
    ({"dir_info": {"editable": True}}, False),
    ({"vcs_info": {"vcs": "git"}}, False),
]:
    distribution = SimpleNamespace(
        version="1.2.3", read_text=lambda _, source=source: json.dumps(source) if source else None
    )
    with patch("importlib.metadata.distribution", return_value=distribution):
        assert plugin_package_info("demo")["update_supported"] is supported
assert not plugin_package_info("nonebot2")["update_supported"]
