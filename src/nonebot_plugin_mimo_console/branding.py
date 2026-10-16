from __future__ import annotations

import base64
import binascii
import json
import re
import secrets
from contextlib import suppress
from pathlib import Path
from threading import RLock
from typing import Any, Literal

DEFAULT_TITLE = "Mimo Console"
MAX_ICON_BYTES = 2 * 1024 * 1024
MAX_ICON_DATA_URL = ((MAX_ICON_BYTES + 2) // 3) * 4 + 128
ICON_FILENAME_RE = re.compile(r"^[0-9a-f]{32}\.(?:png|jpg|gif|webp|ico)$")
ICON_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}
IconAction = Literal["keep", "replace", "remove"]


class BrandingError(ValueError):
    pass


def normalize_title(value: str) -> str:
    title = value.strip()
    if not title or len(title) > 80:
        raise BrandingError("站点标题需要 1–80 个字符")
    if any(ord(char) < 32 or ord(char) == 127 for char in title):
        raise BrandingError("站点标题不能包含换行或控制字符")
    return title


def decode_icon(data_url: str) -> tuple[str, bytes]:
    if len(data_url) > MAX_ICON_DATA_URL:
        raise BrandingError("图标大小不能超过 2MB")
    header, separator, payload = data_url.partition(",")
    if not separator or not re.fullmatch(
        r"data:image/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64", header
    ):
        raise BrandingError("请选择 PNG、JPG、WebP、GIF 或 ICO 图标")
    try:
        data = base64.b64decode(payload, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise BrandingError("图标数据格式不正确") from exc
    if not data or len(data) > MAX_ICON_BYTES:
        raise BrandingError("图标不能为空，大小不能超过 2MB")
    # Infer the response type from bytes rather than the supplied filename or MIME.
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        extension = ".png"
    elif data.startswith(b"\xff\xd8\xff") and len(data) >= 4:
        extension = ".jpg"
    elif data[:6] in {b"GIF87a", b"GIF89a"} and len(data) >= 10:
        extension = ".gif"
    elif data.startswith(b"RIFF") and data[8:12] == b"WEBP" and len(data) >= 16:
        extension = ".webp"
    elif data.startswith(b"\x00\x00\x01\x00") and len(data) >= 22:
        extension = ".ico"
    else:
        raise BrandingError("无法识别图标图片，请选择 PNG、JPG、WebP、GIF 或 ICO 文件")
    return extension, data


class BrandingStore:
    """Shared login, sidebar and favicon identity, persisted independently of dotenv."""

    def __init__(self, data_file: Path, image_dir: Path) -> None:
        self.data_file = data_file
        self.image_dir = image_dir
        self._lock = RLock()
        self._data = self._read()

    def _read(self) -> dict[str, Any]:
        try:
            data = json.loads(self.data_file.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, json.JSONDecodeError):
            pass
        return {}

    def _write(self, data: dict[str, str]) -> None:
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.data_file.with_suffix(self.data_file.suffix + ".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8")
        temporary.replace(self.data_file)

    def snapshot(self) -> dict[str, str]:
        with self._lock:
            try:
                title = normalize_title(str(self._data.get("title") or DEFAULT_TITLE))
            except BrandingError:
                title = DEFAULT_TITLE
            filename = str(self._data.get("icon_filename") or "")
            try:
                self.resolve_file(filename)
            except BrandingError:
                filename = ""
            return {"title": title, "icon_filename": filename}

    def update(
        self, title: str, icon_action: IconAction = "keep", icon_data_url: str = ""
    ) -> dict[str, str]:
        title = normalize_title(title)
        if icon_action not in {"keep", "replace", "remove"}:
            raise BrandingError("图标操作不正确")
        if icon_action != "replace" and icon_data_url:
            raise BrandingError("仅在替换图标时传入图片数据")
        decoded = decode_icon(icon_data_url) if icon_action == "replace" else None
        with self._lock:
            old_filename = self.snapshot()["icon_filename"]
            filename = old_filename if icon_action == "keep" else ""
            created: Path | None = None
            try:
                if decoded:
                    extension, data = decoded
                    filename = f"{secrets.token_hex(16)}{extension}"
                    self.image_dir.mkdir(parents=True, exist_ok=True)
                    created = self.image_dir / filename
                    with created.open("xb") as image:
                        image.write(data)
                new_data = {"title": title, "icon_filename": filename}
                self._write(new_data)
            except OSError:
                if created:
                    with suppress(OSError):
                        created.unlink(missing_ok=True)
                raise
            self._data = new_data
            if old_filename and old_filename != filename:
                with suppress(OSError):
                    (self.image_dir / old_filename).unlink(missing_ok=True)
            return self.snapshot()

    def resolve_file(self, filename: str) -> Path:
        if not ICON_FILENAME_RE.fullmatch(filename):
            raise BrandingError("图标不存在")
        base = self.image_dir.resolve()
        target = (base / filename).resolve()
        if target.parent != base or not target.is_file():
            raise BrandingError("图标不存在")
        return target
