const test = require("node:test");
const assert = require("node:assert/strict");
const ui = require("../src/nonebot_plugin_mimo_console/static/assets/config-fields.js");

test("ID editor preserves long identifiers as strings and removes duplicate lines", () => {
  const item = { key: "CHAT_ONEBOT_USERS", value: '["12345678901234567890"]' };
  assert.equal(ui.toEditor(item), "12345678901234567890");
  const saved = ui.fromEditor(item, "12345678901234567890\n987654321\n987654321");
  assert.deepEqual(JSON.parse(saved), ["12345678901234567890", "987654321"]);
  assert.equal(ui.validate(item, saved), "");
});

test("quoted dotenv JSON is displayed without losing its meaning", () => {
  const item = { key: "SUPERUSERS", value: '\'["123","456"]\'' };
  assert.equal(ui.toEditor(item), "123\n456");
  assert.ok(ui.equivalent(item, '[ "123", "456" ]', item.value));
});

test("invalid existing ID lists remain editable as raw JSON and fail validation", () => {
  for (const value of ['[123]', '{"admin":"123"}', 'not-json']) {
    const item = { key: "SUPERUSERS", value };
    assert.equal(ui.describe(item).kind, "json");
    assert.ok(ui.validate(item, value));
  }
});

test("invalid JSON and invalid websocket URL shapes cannot be saved", () => {
  const item = { key: "ONEBOT_V11_WS_URLS", value: "[]" };
  for (const value of ['["ws://localhost:6700",]', '{}', '["https://example.com"]', '[1]']) {
    assert.ok(ui.validate(item, ui.fromEditor(item, value)));
  }
  const value = ui.fromEditor(item, '[\n "ws://localhost:6700",\n "wss://example.com/ws"\n]');
  assert.equal(ui.validate(item, value), "");
  assert.ok(!value.includes("\n"));
});

test("secret masks stay untouched even when their names or values look typed", () => {
  for (const item of [
    { key: "QQ_BOTS", value: "••••••••", secret: true },
    { key: "CUSTOM_TOKEN", value: "false", secret: true },
    { key: "ONEBOT_V11_ACCESS_TOKEN", value: "••••••••" },
  ]) {
    assert.equal(ui.describe(item).kind, "secret");
    assert.equal(ui.toEditor(item), item.value);
    assert.ok(ui.equivalent(item, item.value, item.value));
    assert.equal(ui.validate(item, item.value), "");
  }
});

test("ports reject out-of-range, fractional and empty values", () => {
  const item = { key: "PORT", value: "8080" };
  for (const value of ["", "0", "65536", "1.2", "abc"]) assert.ok(ui.validate(item, value));
  for (const value of ["1", "8080", "65535"]) assert.equal(ui.validate(item, value), "");
});

test("boolean controls preserve dotenv spelling until the user changes it", () => {
  const item = { key: "FEATURE_ENABLED", value: "True" };
  assert.equal(ui.describe(item).kind, "boolean");
  assert.equal(ui.toEditor(item), "true");
  assert.ok(ui.equivalent(item, "true", "True"));
  assert.ok(!ui.equivalent(item, "false", "True"));
});

test("plain fields reject dotenv line injection", () => {
  const item = { key: "HOST", value: "127.0.0.1" };
  assert.ok(ui.validate(item, "127.0.0.1\nOTHER_SETTING=true"));
  assert.ok(ui.validate(item, "bad\0value"));
});
