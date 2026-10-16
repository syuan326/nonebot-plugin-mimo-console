/* Field descriptions and lossless conversions for the configuration editor. */
(function (root) {
  "use strict";

  const fields = {
    LOG_LEVEL: { label: "日志级别", group: "运行设置", kind: "select", options: ["TRACE", "DEBUG", "INFO", "SUCCESS", "WARNING", "ERROR", "CRITICAL"], hint: "日常运行可用 INFO；排查问题时切换 DEBUG。", initial: "INFO" },
    HOST: { label: "监听地址", group: "运行设置", hint: "127.0.0.1 仅本机可访问；0.0.0.0 监听所有网卡。", initial: "127.0.0.1" },
    PORT: { label: "服务端口", group: "运行设置", kind: "port", hint: "NoneBot 的 HTTP 与反向 WebSocket 共用此端口。", initial: "8080" },
    DRIVER: { label: "运行驱动", group: "运行设置", hint: "反向 WebSocket 需要 FastAPI 等服务端驱动。", initial: "~fastapi+~websockets+~aiohttp" },
    ENVIRONMENT: { label: "运行环境", group: "运行设置", hint: "环境选择通常在公共 .env 中设置；这里显示当前编辑文件里的值。", initial: "dev" },
    COMMAND_START: { label: "命令前缀", group: "运行设置", kind: "json", hint: 'JSON 数组，例如 ["/", "!"]。', initial: '["/"]' },
    COMMAND_SEP: { label: "命令分隔符", group: "运行设置", kind: "json", hint: 'JSON 数组，例如 ["."]。', initial: '["."]' },
    ONEBOT_V11_ACCESS_TOKEN: { label: "连接令牌", group: "OneBot 连接", hint: "每个 OneBot 客户端填写相同 Token；多个机器人共用这一项。", secret: true, initial: "" },
    ONEBOT_V11_SECRET: { label: "HTTP 上报签名密钥", group: "OneBot 连接", hint: "用于 HTTP 事件上报校验；反向 WebSocket 不需要此项。", secret: true, initial: "" },
    ONEBOT_V11_WS_URLS: { label: "正向 WebSocket 地址", group: "OneBot 连接", kind: "json", hint: '仅用于正向 WS。反向 WS 无需填写。多个地址使用 JSON 数组。', initial: "[]" },
    ONEBOT_V11_API_ROOTS: { label: "HTTP API 地址", group: "OneBot 连接", kind: "json", hint: '仅用于 HTTP 接入，格式为 {"机器人QQ号":"http://地址:端口/"}。', initial: "{}" },
    QQ_BOTS: { label: "官方 QQ 机器人", group: "官方 QQ 接口", hint: "官方 QQ 适配器的账号 JSON；与 OneBot 客户端登录的 QQ 账号分别配置。", secret: true, initial: "[]" },
    SUPERUSERS: { label: "超级管理员", group: "消息与权限", kind: "ids", hint: "每行一个管理员 ID；QQ 私聊还需要通过下面的白名单。", initial: "[]" },
    CHAT_ONEBOT_USERS: { label: "OneBot 私聊白名单", group: "消息与权限", kind: "ids", hint: "填写可以发消息的用户 QQ 号，每行一个。这里填写用户，而非机器人账号。空列表将忽略全部私聊。", initial: "[]" },
    CHAT_QQ_USERS: { label: "官方 QQ 私聊白名单", group: "消息与权限", kind: "ids", hint: "每行一个 C2C user_openid 或频道私信用户 ID。空列表将忽略全部私聊。", initial: "[]" },
  };

  function unwrap(value) {
    const text = String(value ?? "").trim();
    if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
    if (text.startsWith('"') && text.endsWith('"')) {
      try { const parsed = JSON.parse(text); if (typeof parsed === "string") return parsed; } catch (_) { /* raw dotenv text */ }
    }
    return text;
  }

  function parse(value) {
    try { return JSON.parse(unwrap(value)); } catch (_) { return undefined; }
  }

  function describe(item) {
    const spec = fields[item.key] || {};
    const secret = Boolean(item.secret || spec.secret);
    const raw = unwrap(item.value);
    let kind = secret ? "secret" : spec.kind || (/^(true|false)$/i.test(raw) ? "boolean" : /^[\[{]/.test(raw) ? "json" : "text");
    // Unsupported or invalid existing lists remain raw JSON, so rendering never
    // silently discards values or changes the meaning of the source file.
    if (kind === "ids") {
      const value = parse(item.value);
      if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) kind = "json";
    }
    return {
      label: spec.label || item.key,
      hint: spec.hint || (secret ? "敏感字段已脱敏；保持原值即可保留，留空后保存将清除。" : "自定义配置，请按照对应组件的文档填写。"),
      group: spec.group || (item.key.startsWith("MIMO_CONSOLE_") ? "控制台设置" : "其他配置"),
      ...spec, secret, kind,
    };
  }

  function toEditor(item) {
    const spec = describe(item);
    if (spec.kind === "ids") return parse(item.value).join("\n");
    if (spec.kind === "json") {
      const parsed = parse(item.value);
      return parsed === undefined ? String(item.value) : JSON.stringify(parsed, null, 2);
    }
    if (spec.kind === "boolean") return unwrap(item.value).toLowerCase();
    return String(item.value ?? "");
  }

  function fromEditor(item, value) {
    if (describe(item).kind === "ids") {
      return JSON.stringify([...new Set(String(value).split(/[\n,，]+/).map((id) => id.trim()).filter(Boolean))]);
    }
    if (describe(item).kind === "json") {
      try { return JSON.stringify(JSON.parse(value)); } catch (_) { return value; }
    }
    return String(value);
  }

  function validate(item, value) {
    const spec = describe(item);
    const kind = fields[item.key]?.kind || spec.kind;
    if (/[\r\n\0]/.test(value)) return "配置值不能包含实际换行或空字符；JSON 请检查格式。";
    if (kind === "port" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) return "端口需要是 1–65535 之间的整数。";
    if (["ids", "json"].includes(kind)) {
      const parsed = parse(value);
      if (parsed === undefined) return "JSON 格式不正确，请检查引号、逗号和括号。";
      if (kind === "ids" && (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string" || !id || /\s/.test(id) || id.length > 128))) return "每行填写一个有效 ID，不能包含空白字符或超过 128 个字符。";
      if (item.key === "ONEBOT_V11_WS_URLS" && (!Array.isArray(parsed) || parsed.some((url) => typeof url !== "string" || !/^wss?:\/\/[^\s]+$/.test(url)))) return "请输入 ws:// 或 wss:// 地址组成的 JSON 数组。";
      if (item.key === "ONEBOT_V11_API_ROOTS" && (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some((url) => typeof url !== "string" || !/^https?:\/\/[^\s]+$/.test(url)))) return "请输入机器人 QQ 号到 http:// 或 https:// 地址的 JSON 对象。";
      if (["COMMAND_START", "COMMAND_SEP"].includes(item.key) && (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string"))) return "请输入字符串组成的 JSON 数组。";
    }
    return "";
  }

  function equivalent(item, left, right) {
    if (String(left) === String(right)) return true;
    const kind = describe(item).kind;
    if (["ids", "json"].includes(kind)) {
      const a = parse(left), b = parse(right);
      return a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
    }
    return kind === "boolean" && unwrap(left).toLowerCase() === unwrap(right).toLowerCase();
  }

  const api = { fields, describe, parse, toEditor, fromEditor, validate, equivalent };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MimoConfigUI = api;
})(globalThis);
