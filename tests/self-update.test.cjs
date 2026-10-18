const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname,
  "../src/nonebot_plugin_mimo_console/static/assets/app.js"), "utf8").replace(/bootstrap\(\);\s*$/, "");

function setup() {
  const overview = { textContent: "检测更新", disabled: false };
  const card = { textContent: "更新控制台", disabled: false };
  const detail = { textContent: "更新控制台", disabled: false };
  const calls = [];
  const notices = [];
  const confirmations = [];
  let polls = 0;
  const context = vm.createContext({
    location: { pathname: "/mimo-console/", reload() {} },
    localStorage: { getItem() { return null; } },
    document: {
      querySelector(selector) { return selector === "#check-update-btn" ? overview : null; },
      querySelectorAll(selector) { return selector === "[data-console-self-update]" ? [card, detail] : []; },
    },
    window: { confirm(message) { confirmations.push(message); return true; } },
  });
  vm.runInContext(script, context);
  context.renderVersion = () => {};
  context.toast = (...args) => notices.push(args);
  context.pollRestart = async () => { polls += 1; };
  context.api = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint.startsWith("/system/version")) return { has_update: true, current: "1", latest: "2" };
    if (endpoint === "/system/update") return { ok: true, restart_required: true };
    if (endpoint === "/system/restart") return { ok: true };
    throw new Error("unexpected endpoint: " + endpoint);
  };
  return { context, overview, card, detail, calls, notices, confirmations, polls: () => polls,
    state: vm.runInContext("state", context) };
}

test("Mimo Console card offers its dedicated update entry", () => {
  const ui = setup();
  const html = ui.context.loadedPluginHtml({ name: "nonebot_plugin_mimo_console",
    module: "nonebot_plugin_mimo_console", title: "Mimo Console", update_supported: false }, 0);
  assert.match(html, /data-console-self-update/);
  assert.match(html, /更新控制台/);
  assert.doesNotMatch(html, /data-loaded-plugin-update=/);
});

test("self update from the detail button uses dedicated API and actually requests restart", async () => {
  const ui = setup();
  ui.state.plugins = [{ module: "nonebot_plugin_mimo_console", update_supported: false }];
  await ui.context.checkUpdate(ui.detail);
  assert.deepEqual(ui.calls, ["/system/version?force=true", "/system/update", "/system/restart"]);
  assert.equal(ui.polls(), 1);
  assert.match(ui.confirmations[0], /本地源码/);
  assert.equal(ui.detail.textContent, "更新控制台");
  assert.ok([ui.overview, ui.card, ui.detail].every((button) => !button.disabled));
});

test("declining self update never writes or restarts", async () => {
  const ui = setup();
  ui.context.window.confirm = () => false;
  await ui.context.checkUpdate(ui.card);
  assert.deepEqual(ui.calls, ["/system/version?force=true"]);
  assert.equal(ui.polls(), 0);
});

test("failed update never restarts the running bot", async () => {
  const ui = setup();
  const api = ui.context.api;
  ui.context.api = async (endpoint) => endpoint === "/system/update"
    ? { status: "failed", error: "failed fixture" } : api(endpoint);
  await ui.context.checkUpdate(ui.card);
  assert.equal(ui.polls(), 0);
  assert.ok(!ui.calls.includes("/system/restart"));
  assert.ok(ui.notices.some(([message]) => message === "failed fixture"));
});

test("concurrent update entries share a lock and restore all controls", async () => {
  const ui = setup();
  let finish;
  ui.context.api = async (endpoint) => {
    ui.calls.push(endpoint);
    return new Promise((resolve) => { finish = resolve; });
  };
  const pending = ui.context.checkUpdate(ui.card);
  await ui.context.checkUpdate(ui.detail);
  assert.equal(ui.calls.length, 1);
  assert.ok([ui.overview, ui.card, ui.detail].every((button) => button.disabled));
  finish({ has_update: false, current: "2", latest: "2" });
  await pending;
  assert.ok([ui.overview, ui.card, ui.detail].every((button) => !button.disabled));
});

test("disabled package management only allows checking the version", async () => {
  const ui = setup();
  ui.state.packageManagement = false;
  await ui.context.checkUpdate(ui.overview);
  assert.deepEqual(ui.calls, ["/system/version?force=true"]);
  assert.equal(ui.confirmations.length, 0);
});
