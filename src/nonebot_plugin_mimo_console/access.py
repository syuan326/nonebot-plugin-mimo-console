"""Console rules stored and evaluated by nonebot-plugin-access-control."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from typing import Literal

from nonebot.internal.adapter import Bot, Event
from nonebot.rule import Rule
from nonebot.typing import T_DependencyCache, T_State
from pydantic import BaseModel, ConfigDict, Field, model_validator

PREFIX = "mimo:v1:"
PROTECTED = {
    "nonebot_plugin_mimo_console",
    "nonebot_plugin_access_control",
    "nonebot_plugin_access_control_api",
}
Target = Literal["all", "private", "group", "user", "group_user"]


class ResponseAccessRule(Rule):
    """Run after the original Rule, before upstream run preprocessors.

    Keeping the original dependency stack/cache preserves generator-based
    dependencies. Returning False avoids cancelling concurrent DB queries in
    access-control's run preprocessor when both integrations are enabled.
    """

    def __init__(
        self,
        original: Rule,
        plugin: str,
        check: Callable[[str, Bot, Event], Awaitable[bool]],
    ) -> None:
        super().__init__()
        self.checkers = original.checkers
        self.original = original
        self.plugin = plugin
        self.check = check

    async def __call__(
        self,
        bot: Bot,
        event: Event,
        state: T_State,
        stack: AsyncExitStack | None = None,
        dependency_cache: T_DependencyCache | None = None,
    ) -> bool:
        if not await self.original(bot, event, state, stack, dependency_cache):
            return False
        return await self.check(self.plugin, bot, event)


class AccessRule(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    plugin: str = Field(min_length=1, max_length=128)
    adapter: str = Field(default="OneBot V11", min_length=1, max_length=64)
    bot_id: str = Field(default="", max_length=128)
    target: Target = "all"
    user_id: str = Field(default="", max_length=128)
    group_id: str = Field(default="", max_length=128)
    allow: bool = True

    @model_validator(mode="after")
    def validate_scope(self) -> AccessRule:
        if self.plugin in PROTECTED:
            raise ValueError("控制台和权限管理插件受保护")
        if self.target in {"user", "group_user"} and not self.user_id:
            raise ValueError("请填写用户 ID")
        if self.target in {"group", "group_user"} and not self.group_id:
            raise ValueError("请填写群 ID")
        if self.target not in {"user", "group_user"} and self.user_id:
            raise ValueError("该范围不接受用户 ID")
        if self.target not in {"group", "group_user"} and self.group_id:
            raise ValueError("该范围不接受群 ID")
        return self

    def subject(self) -> str:
        return subject(self.adapter, self.bot_id, self.target, self.user_id, self.group_id)


class AccessProbe(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    plugin: str = Field(min_length=1, max_length=128)
    adapter: str = Field(default="OneBot V11", min_length=1, max_length=64)
    bot_id: str = Field(min_length=1, max_length=128)
    user_id: str = Field(min_length=1, max_length=128)
    group_id: str = Field(default="", max_length=128)


class AccessRuleEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    original: AccessRule
    rule: AccessRule


class AccessRuleConflict(ValueError):
    pass


def subject(adapter: str, bot_id: str, target: str, user_id: str, group_id: str) -> str:
    # JSON preserves opaque IDs and prevents delimiter collisions.
    return PREFIX + json.dumps(
        [adapter, bot_id, target, user_id, group_id], ensure_ascii=False, separators=(",", ":")
    )


def subjects(adapter: str, bot_id: str, user_id: str, group_id: str, private: bool) -> list[str]:
    result = []
    # An account-specific rule overrides an all-accounts rule. Within each
    # account: group member > user > group/private > everyone.
    for account in (bot_id, "") if bot_id else ("",):
        if group_id and user_id:
            result.append(subject(adapter, account, "group_user", user_id, group_id))
        if user_id:
            result.append(subject(adapter, account, "user", user_id, ""))
        if group_id:
            result.append(subject(adapter, account, "group", "", group_id))
        if private:
            result.append(subject(adapter, account, "private", "", ""))
        result.append(subject(adapter, account, "all", "", ""))
    return result


def event_subjects(bot, event) -> list[str]:
    from nonebot_plugin_session import SessionLevel, extract_session

    session = extract_session(bot, event)
    return subjects(
        bot.type,
        bot.self_id,
        session.id1 or "",
        (session.id2 or "") if session.level == SessionLevel.GROUP else "",
        session.level == SessionLevel.PRIVATE,
    )


def install_subject_extractor() -> None:
    from nonebot_plugin_access_control_api.subject import add_subject_extractor
    from nonebot_plugin_access_control_api.subject.model import SubjectModel

    @add_subject_extractor
    def extract_console_subjects(bot, event, manager):
        items = [
            SubjectModel(value, "mimo_console", "mimo") for value in event_subjects(bot, event)
        ]
        # Preserve existing /ac subjects first. The separate console guard
        # always enforces panel denies without weakening native /ac denies.
        manager.append(*items)


class AccessControl:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()

    def service(self, plugin: str):
        from nonebot import get_plugin
        from nonebot_plugin_access_control_api.service import get_nonebot_service

        root = get_nonebot_service()
        if plugin == "nonebot":
            return root
        existing = root.get_plugin_service(plugin)
        if existing is not None:
            return existing
        if get_plugin(plugin) is not None:
            return root.get_or_create_plugin_service(plugin)
        return root.create_plugin_service(plugin)

    async def rules(self) -> list[dict]:
        from nonebot import get_loaded_plugins
        from nonebot_plugin_access_control_api.service import Service

        # The upstream repository only returns permissions for registered
        # services. Re-register loaded plugins before listing after a restart.
        for plugin in get_loaded_plugins():
            if plugin.id_ not in PROTECTED:
                self.service(plugin.id_)
        items = []
        async for permission in Service.get_all_permissions():
            if not permission.subject.startswith(PREFIX):
                continue
            try:
                adapter, bot_id, target, user_id, group_id = json.loads(
                    permission.subject[len(PREFIX) :]
                )
                rule = AccessRule(
                    plugin=permission.service.qualified_name,
                    adapter=adapter,
                    bot_id=bot_id,
                    target=target,
                    user_id=user_id,
                    group_id=group_id,
                    allow=permission.allow,
                )
            except (ValueError, TypeError):
                continue
            items.append(rule.model_dump())
        return sorted(
            items,
            key=lambda item: (
                item["plugin"],
                item["adapter"],
                item["bot_id"],
                item["target"],
                item["group_id"],
                item["user_id"],
            ),
        )

    async def put(self, rule: AccessRule) -> None:
        async with self.lock:
            await self.service(rule.plugin).set_permission(rule.subject(), rule.allow)

    async def remove(self, rule: AccessRule) -> None:
        async with self.lock:
            await self.service(rule.plugin).remove_permission(rule.subject())

    async def replace(self, original: AccessRule, rule: AccessRule) -> None:
        """Move the existing permission in one transaction; never merge two rules."""
        from nonebot_plugin_access_control.repository.orm.permission import PermissionOrm
        from nonebot_plugin_orm import get_session
        from sqlalchemy import select, update
        from sqlalchemy.exc import IntegrityError

        old_service = self.service(original.plugin)
        new_service = self.service(rule.plugin)
        old_key = (old_service.qualified_name, original.subject())
        new_key = (new_service.qualified_name, rule.subject())
        async with self.lock:
            try:
                async with get_session() as db, db.begin():
                    if old_key != new_key:
                        collision = await db.scalar(
                            select(PermissionOrm).where(
                                PermissionOrm.service == new_key[0],
                                PermissionOrm.subject == new_key[1],
                            )
                        )
                        if collision is not None:
                            raise AccessRuleConflict("新对象已有规则，请选择其他对象或先调整该规则")
                    result = await db.execute(
                        update(PermissionOrm)
                        .where(
                            PermissionOrm.service == old_key[0],
                            PermissionOrm.subject == old_key[1],
                            PermissionOrm.allow == original.allow,
                        )
                        .values(service=new_key[0], subject=new_key[1], allow=rule.allow)
                    )
                    if result.rowcount != 1:
                        raise AccessRuleConflict("原规则已被修改或删除，请刷新后重新调整")
            except IntegrityError as exc:
                raise AccessRuleConflict("对象规则发生冲突，请刷新后重新调整") from exc

            # The upstream setters commit separately, so the move above uses
            # their ORM model directly. Preserve their public event semantics.
            from nonebot_plugin_access_control_api.event_bus import EventType, fire_event
            from nonebot_plugin_access_control_api.models.permission import Permission

            if old_key != new_key:
                await fire_event(
                    EventType.service_remove_permission,
                    {"service": old_service, "subject": old_key[1]},
                )
                await self._notify_change(old_service, old_key[1])
            await fire_event(
                EventType.service_set_permission,
                {
                    "service": new_service,
                    "permission": Permission(new_service, new_key[1], rule.allow),
                },
            )
            await self._notify_change(new_service, new_key[1])

    async def _notify_change(self, service, identity: str) -> None:
        from nonebot_plugin_access_control.config import conf
        from nonebot_plugin_access_control_api.event_bus import EventType, fire_event
        from nonebot_plugin_access_control_api.models.permission import Permission

        for node in service.travel():
            if node != service and await node.get_permission_by_subject(identity, trace=False):
                continue
            permission = await node.get_permission_by_subject(identity)
            allow = (
                permission.allow
                if permission
                else conf().access_control_default_permission == "allow"
            )
            await fire_event(
                EventType.service_change_permission,
                {"service": node, "permission": Permission(node, identity, allow)},
            )

    async def decide(self, plugin: str, identities: list[str]) -> dict:
        if plugin in PROTECTED:
            return {"allow": True, "reason": "受保护的管理插件", "matched": None}
        permission = await self.service(plugin).get_permission_by_subject(*identities)
        return {
            "allow": permission.allow if permission is not None else True,
            "reason": "命中面板规则" if permission is not None else "未设置面板规则，默认允许",
            "matched": {
                "plugin": permission.service.qualified_name,
                "subject": permission.subject,
            }
            if permission is not None
            else None,
        }
