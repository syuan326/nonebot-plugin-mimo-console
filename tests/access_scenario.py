"""Isolated process: exercises real ORM, authenticated API and Matcher guard."""

import os
import sys
from pathlib import Path

import nonebot
from fastapi.testclient import TestClient

root = Path(os.environ["ACCESS_TEST_ROOT"])
nonebot.init(
    driver="~fastapi",
    log_level="WARNING",
    sqlalchemy_database_url=f"sqlite+aiosqlite:///{root.as_posix()}/permissions.db",
    alembic_startup_check=False,
    access_control_auto_patch_enabled=sys.argv[1] == "auto-patch",
)
assert nonebot.load_plugin("nonebot_plugin_mimo_console") is not None
assert nonebot.load_builtin_plugin("echo") is not None

from nonebot.adapters.onebot.v11 import Adapter, Bot, GroupMessageEvent, Message
from nonebot.message import handle_event
from nonebot_plugin_access_control_api.subject import extract_subjects

from nonebot_plugin_mimo_console import _response_allowed, console_state
from nonebot_plugin_mimo_console.access import AccessRule, event_subjects, subject

driver = nonebot.get_driver()
adapter = Adapter(driver)
bot_a = Bot(adapter, "111")
bot_b = Bot(adapter, "222")
matcher_type = next(iter(nonebot.get_plugin("echo").matcher))
base = {
    "plugin": "echo",
    "adapter": "OneBot V11",
    "bot_id": "111",
    "target": "all",
    "user_id": "",
    "group_id": "",
    "allow": False,
}


def event(user=123, group=987):
    return GroupMessageEvent(
        time=123,
        self_id=111,
        post_type="message",
        sub_type="normal",
        message_type="group",
        message_id=1,
        user_id=user,
        group_id=group,
        message=Message("/echo ping"),
        raw_message="/echo ping",
        font=0,
        sender={"user_id": user, "role": "member"},
        to_me=True,
    )


with TestClient(nonebot.get_app()) as client:
    prefix = "/mimo-console/api/access"
    assert client.get(prefix).status_code == 401
    assert client.put(prefix + "/rule", json=base).status_code == 401
    assert client.patch(prefix + "/rule", json={"original": base, "rule": base}).status_code == 401
    if sys.argv[1] == "write":
        token = console_state.auth.setup(
            console_state.setup_token, "accessadmin", "Access-Test-123!"
        )
    else:
        token = console_state.auth.login("accessadmin", "Access-Test-123!")
    headers = {"Authorization": "Bearer " + token}

    def put(**changes):
        rule = {**base, **changes}
        response = client.put(prefix + "/rule", json=rule, headers=headers)
        assert response.status_code == 200, response.text
        return rule

    def preview(bot="111", user="123", group="987", adapter="OneBot V11"):
        response = client.post(
            prefix + "/preview",
            headers=headers,
            json={
                "plugin": "echo",
                "adapter": adapter,
                "bot_id": bot,
                "user_id": user,
                "group_id": group,
            },
        )
        assert response.status_code == 200, response.text
        return response.json()

    if sys.argv[1] != "write":
        rules = client.get(prefix, headers=headers).json()["rules"]
        assert any(rule == base for rule in rules), rules
        assert preview()["allow"] is False
        assert preview(bot="222")["allow"] is True
    else:
        put()

        # Editing changes the existing identity rather than adding a rule.
        before = client.get(prefix, headers=headers).json()["rules"]
        moved = {**base, "target": "user", "user_id": "456", "bot_id": "222"}
        response = client.patch(
            prefix + "/rule", headers=headers, json={"original": base, "rule": moved}
        )
        assert response.status_code == 200, response.text
        after = client.get(prefix, headers=headers).json()["rules"]
        assert len(after) == len(before) and base not in after and moved in after, after
        assert preview()["allow"] is True
        assert preview(bot="222", user="456")["allow"] is False
        assert preview(bot="222", user="123")["allow"] is True
        # The editor must also retain the new identity for subsequent edits.
        moved_again = {
            **moved,
            "plugin": "nonebot",
            "adapter": "QQ",
            "target": "group",
            "user_id": "",
            "group_id": "987",
        }
        response = client.patch(
            prefix + "/rule", headers=headers, json={"original": moved, "rule": moved_again}
        )
        assert response.status_code == 200, response.text
        after = client.get(prefix, headers=headers).json()["rules"]
        assert len(after) == len(before) and moved not in after and moved_again in after, after
        # Moving onto an existing object must not overwrite either rule.
        put()
        collision_before = client.get(prefix, headers=headers).json()["rules"]
        response = client.patch(
            prefix + "/rule",
            headers=headers,
            json={"original": moved_again, "rule": {**base, "allow": True}},
        )
        assert response.status_code == 409, response.text
        assert client.get(prefix, headers=headers).json()["rules"] == collision_before
        # A stale editor cannot resurrect or move a rule that no longer exists.
        response = client.patch(
            prefix + "/rule",
            headers=headers,
            json={"original": moved, "rule": {**base, "bot_id": "333"}},
        )
        assert response.status_code == 409, response.text
        assert client.get(prefix, headers=headers).json()["rules"] == collision_before
        assert (
            client.post(prefix + "/rule/delete", headers=headers, json=moved_again).status_code
            == 200
        )
        assert preview()["allow"] is False
        assert preview(bot="222")["allow"] is True
        assert preview(adapter="QQ")["allow"] is True
        # User exception to a bot-specific whitelist.
        user_rule = put(target="user", user_id="123", allow=True)
        assert preview()["allow"] is True
        assert preview(user="456")["allow"] is False
        assert preview(group="")["allow"] is True
        # More specific group-user deny wins over user allow.
        member_rule = put(target="group_user", user_id="123", group_id="987")
        assert preview()["allow"] is False
        assert preview(group="654")["allow"] is True
        for rule in [member_rule, user_rule]:
            assert (
                client.post(prefix + "/rule/delete", headers=headers, json=rule).status_code == 200
            )
        assert preview()["allow"] is False
        # All-bot rules cannot override a bot-specific rule.
        all_bots = put(bot_id="", target="user", user_id="123", allow=True)
        assert preview()["allow"] is False
        assert preview(bot="222")["allow"] is True
        assert (
            client.post(prefix + "/rule/delete", headers=headers, json=all_bots).status_code == 200
        )
        # A plugin exception to a global default deny.
        global_rule = put(plugin="nonebot", bot_id="")
        assert preview(bot="222")["allow"] is False
        exception = put(bot_id="222", allow=True)
        assert preview(bot="222")["allow"] is True
        for rule in [global_rule, exception]:
            assert (
                client.post(prefix + "/rule/delete", headers=headers, json=rule).status_code == 200
            )
        # Invalid scopes, protected plugins and unknown plugins are rejected.
        for changes, expected in [
            ({"target": "user"}, 422),
            ({"target": "group"}, 422),
            ({"user_id": "123"}, 422),
            ({"plugin": "nonebot_plugin_mimo_console"}, 422),
            ({"plugin": "does_not_exist"}, 404),
        ]:
            response = client.put(prefix + "/rule", headers=headers, json={**base, **changes})
            assert response.status_code == expected, response.text
        # Whole-plugin disable always wins over allow.
        put(allow=True)
        response = client.put(
            "/mimo-console/api/plugins/disabled",
            headers=headers,
            json={"plugin": "echo", "disabled": True},
        )
        assert response.status_code == 200, response.text
        assert preview()["allow"] is False
        client.put(
            "/mimo-console/api/plugins/disabled",
            headers=headers,
            json={"plugin": "echo", "disabled": False},
        )
        put()

    async def check_runtime():
        identities = event_subjects(bot_a, event())
        assert subject("OneBot V11", "111", "group_user", "123", "987") in identities
        assert base["bot_id"] in "".join(identities)
        assert any(value.startswith("mimo:v1:") for value in extract_subjects(bot_a, event()))
        assert not await _response_allowed("echo", bot_a, event())
        assert await _response_allowed("echo", bot_b, event())
        # Run the real event dispatcher: the blocked account never sends,
        # while the second account executes echo normally.
        sent = []

        async def send(self, *args, **kwargs):
            sent.append(self.self_id)
            return {}

        original = Bot.send
        Bot.send = send
        try:
            await handle_event(bot_a, event())
            assert not sent, sent
            await handle_event(bot_b, event())
            assert sent == ["222"], sent
        finally:
            Bot.send = original

        # A live group-member exception must affect the same real guard.
        member_allow = AccessRule(
            **{**base, "target": "group_user", "user_id": "123", "group_id": "987", "allow": True}
        )
        await console_state.access.put(member_allow)
        assert await _response_allowed("echo", bot_a, event())
        assert not await _response_allowed("echo", bot_a, event(group=654))
        # Existing native /ac deny still outranks panel allow when using the
        # upstream extractor (e.g. manually adapted or auto-patched plugins).
        service = console_state.access.service("echo")
        await service.set_permission("all", False)
        try:
            assert not await service.check_permission(*extract_subjects(bot_a, event()))
        finally:
            await service.remove_permission("all")
            await console_state.access.remove(member_allow)

    client.portal.call(check_runtime)
