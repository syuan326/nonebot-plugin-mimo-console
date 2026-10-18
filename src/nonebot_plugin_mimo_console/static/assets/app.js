"use strict";

const rootPath = location.pathname.replace(/\/$/, "");
const storageKey = "mimo-console-token";
const BRANDING_DEFAULT_TITLE = "Mimo Console";
const state = {
  token: localStorage.getItem(storageKey) || "",
  username: "",
  configured: true,
  page: "dashboard",
  dashboard: null,
  plugins: [],
  accessRules: [],
  accessEditing: null,
  accessBots: [],
  selfUpdateBusy: false,
  pluginTab: "installed",
  storePlugins: [],
  storePage: 1,
  storePages: 1,
  storeTotal: 0,
  packageManagement: true,
  deployment: { mode: "python", rollback: false, github_install: false },
  storeSearchTimer: null,
  dependencies: [],
  dependencyMeta: { total: 0, direct: 0, path: "" },
  configItems: [],
  configOriginal: new Map(),
  configChanges: new Map(),
  configAdded: new Set(),
  configCategory: "全部设置",
  logs: [],
  logAfter: 0,
  logFollow: true,
  logLevel: "ALL",
  timers: [],
  detailPlugin: null,
  detailSource: null,
  background: { source: "none", url: "" },
  theme: null,
  branding: { title: BRANDING_DEFAULT_TITLE, icon_url: "" },
  brandingDraft: null,
  brandingLoaded: false,
  brandingBusy: false,
  brandingReading: false,
  brandingReadId: 0,
  brandingError: "",
  version: null,
  proxy: { proxy: "", presets: [], tests: {}, testing: false, testRunId: 0 },
};

const $ = (selector, context = document) => context.querySelector(selector);
const $$ = (selector, context = document) => [...context.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function normalizeWebUrl(value, baseUrl = "") {
  try {
    const url = baseUrl
      ? new URL(String(value || ""), baseUrl)
      : new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch (_) {
    return "";
  }
}

function safeUrl(value) {
  const url = normalizeWebUrl(value);
  return url ? escapeHtml(url) : "";
}

function safeImageUrl(value) {
  const text = String(value || "").trim();
  if (/^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(text)) {
    return escapeHtml(text);
  }
  return safeUrl(text);
}

function pluginAvatarHtml(item, large = false) {
  const label = item.title || item.name || item.module_name || "P";
  const letter = String(label).slice(0, 1).toUpperCase();
  const icon = safeImageUrl(item.icon);
  return `<div class="plugin-avatar${large ? " lg" : ""}">
    <span aria-hidden="true">${escapeHtml(letter)}</span>
    ${icon ? `<img class="plugin-avatar-image" src="${icon}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
  </div>`;
}

function bindAvatarFallbacks(context = document) {
  $$(".plugin-avatar-image:not([data-avatar-bound])", context).forEach((image) => {
    image.dataset.avatarBound = "true";
    image.addEventListener("error", () => image.remove(), { once: true });
  });
}

function setDetailAvatar(item) {
  const avatar = $("#detail-avatar");
  const label = item.title || item.name || item.module_name || "P";
  const letter = String(label).slice(0, 1).toUpperCase();
  const icon = safeImageUrl(item.icon);
  avatar.innerHTML = `<span aria-hidden="true">${escapeHtml(letter)}</span>${icon
    ? `<img class="plugin-avatar-image" src="${icon}" alt="" referrerpolicy="no-referrer">`
    : ""}`;
  bindAvatarFallbacks(avatar);
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  $("#toast-stack").append(item);
  setTimeout(() => item.remove(), 3800);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(`${rootPath}/api${path}`, { ...options, headers });
  let data = {};
  try { data = await response.json(); } catch (_) { data = {}; }
  if (response.status === 401 && !path.startsWith("/auth/login")) {
    signOut(false);
    throw new Error(data.detail || "登录已失效");
  }
  if (!response.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map((item) => item.msg).join("；") : data.detail;
    throw new Error(detail || `请求失败（${response.status}）`);
  }
  return data;
}

function setAuthMode(configured) {
  state.configured = configured;
  $("#setup-token-field").classList.toggle("hidden", configured);
  $("#password-hint").classList.toggle("hidden", configured);
  $("#auth-step-label").textContent = configured ? "登录" : "首次设置";
  $("#auth-title").textContent = configured ? "欢迎回来" : "创建管理员";
  $("#auth-description").textContent = configured
    ? "使用管理员账号继续"
    : "输入启动日志中的初始化令牌";
  $("#auth-submit span").textContent = configured ? "进入控制台" : "完成初始化";
  $("#password").autocomplete = configured ? "current-password" : "new-password";
}

async function bootstrap() {
  bindEvents();
  updateClock();
  setInterval(updateClock, 1000);
  applyTheme(loadThemeLocal());
  applyVisualSettings(loadVisualSettings());
  loadBackground();
  await loadBranding();
  try {
    const authStatus = await api("/auth/status");
    setAuthMode(authStatus.configured);
    if (state.token && authStatus.configured) {
      try {
        const me = await api("/auth/me");
        enterApp(me.username);
        return;
      } catch (_) { /* stay on auth */ }
    }
  } catch (error) {
    $("#auth-error").textContent = `无法连接控制台：${error.message}`;
  }
  $("#auth-screen").classList.remove("hidden");
}

function bindEvents() {
  $("#access-form").addEventListener("submit", saveAccessRule);
  $("#access-target").addEventListener("change", updateAccessTarget);
  $("#access-reset").addEventListener("click", resetAccessForm);
  $("#access-search").addEventListener("input", renderAccessRules);
  $("#access-preview-form").addEventListener("submit", previewAccess);
  for (const prefix of ["access", "access-preview"]) {
    $("#" + prefix + "-bot").addEventListener("change", (event) => {
      const matches = state.accessBots.filter((bot) => bot.bot_id === event.target.value.trim());
      if (matches.length === 1) $("#" + prefix + "-adapter").value = matches[0].adapter;
    });
  }
  window.addEventListener("beforeunload", (event) => {
    if (state.configChanges.size || brandingHasChanges()) { event.preventDefault(); event.returnValue = ""; }
  });
  $("#auth-form").addEventListener("submit", handleAuth);
  $("#toggle-password").addEventListener("click", () => {
    const input = $("#password");
    input.type = input.type === "password" ? "text" : "password";
  });
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.page)));
  $$("[data-goto]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.goto)));
  $("#logout-button").addEventListener("click", () => signOut(true));
  $("#refresh-button").addEventListener("click", refreshCurrent);
  $("#menu-button").addEventListener("click", () => toggleSidebar(true));
  $("#sidebar-close").addEventListener("click", () => toggleSidebar(false));
  $("#sidebar-backdrop").addEventListener("click", () => toggleSidebar(false));
  $("#plugin-search").addEventListener("input", onPluginSearch);
  $$(".tab[data-plugin-tab]").forEach((button) => button.addEventListener("click", () => switchPluginTab(button.dataset.pluginTab)));
  $("#official-only").addEventListener("change", () => { state.storePage = 1; loadStorePlugins(); });
  $("#store-prev").addEventListener("click", () => changeStorePage(-1));
  $("#store-next").addEventListener("click", () => changeStorePage(1));
  $("#dependency-search").addEventListener("input", renderDependencies);
  $("#dependency-filter").addEventListener("change", renderDependencies);
  $("#dependency-install-form").addEventListener("submit", installDependency);
  $("#config-search").addEventListener("input", renderConfig);
  $("#log-search").addEventListener("input", renderLogs);
  bindLogLevelSelect();
  $("#log-follow").addEventListener("click", () => {
    state.logFollow = !state.logFollow;
    $("#log-follow").classList.toggle("active", state.logFollow);
  });
  $("#clear-logs").addEventListener("click", clearLogs);
  $$("input[name='bg-mode']").forEach((radio) =>
    radio.addEventListener("change", () => {
      if (radio.checked) selectBackgroundMode(radio.value);
    }),
  );
  $("#bg-url-input").addEventListener("input", (event) => queueBgUrlSave(event.target));
  $("#bg-url-input").addEventListener("change", (event) => queueBgUrlSave(event.target, true));
  $("#bg-url-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    queueBgUrlSave(event.target, true);
  });
  $("#bg-file-input").addEventListener("change", (event) => uploadBgFile(event.target));
  $("#bg-file-label").addEventListener("click", () => $("#bg-file-input").click());
  $("#bg-blur-input").addEventListener("input", updateVisualSettings);
  $("#card-opacity-input").addEventListener("input", updateVisualSettings);
  $$("input[name='theme-mode']").forEach((radio) =>
    radio.addEventListener("change", () => changeTheme({ mode: radio.value })),
  );
  $$(".swatch[data-accent]").forEach((swatch) =>
    swatch.addEventListener("click", () => changeTheme({ accent: swatch.dataset.accent })),
  );
  $("#accent-custom-input").addEventListener("input", (event) => changeTheme({ accent: event.target.value }));
  $("#theme-reset").addEventListener("click", resetTheme);
  $("#branding-title").addEventListener("input", (event) => {
    if (!state.brandingDraft) return;
    state.brandingDraft.title = event.target.value;
    state.brandingError = "";
    renderBrandingEditor();
  });
  $("#branding-upload").addEventListener("click", () => $("#branding-icon-file").click());
  $("#branding-icon-file").addEventListener("change", (event) => selectBrandingIcon(event.target));
  $("#branding-remove").addEventListener("click", () => {
    state.brandingReadId += 1;
    state.brandingReading = false;
    if (!state.brandingDraft) return;
    state.brandingDraft.icon_action = state.branding.icon_url ? "remove" : "keep";
    state.brandingDraft.icon_data_url = "";
    state.brandingDraft.icon_name = "";
    state.brandingError = "";
    renderBrandingEditor();
  });
  $("#branding-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state.brandingDraft || state.brandingBusy || state.brandingReading) return;
    const { title, icon_action, icon_data_url } = state.brandingDraft;
    persistBranding({ title: title.trim(), icon_action, icon_data_url });
  });
  $("#branding-reset").addEventListener("click", () => {
    if (state.brandingBusy || !state.brandingLoaded) return;
    state.brandingReadId += 1;
    state.brandingReading = false;
    persistBranding({ title: BRANDING_DEFAULT_TITLE, icon_action: "remove", icon_data_url: "" });
  });
  $("#restart-button").addEventListener("click", restartNonebot);
  $("#deployment-refresh").addEventListener("click", loadDeploymentOperations);
  $("#github-install-button").addEventListener("click", () => showGithubModal(true));
  $("#github-modal-close").addEventListener("click", () => showGithubModal(false));
  $("#github-modal-cancel").addEventListener("click", () => showGithubModal(false));
  $("#github-modal").addEventListener("click", (event) => {
    if (event.target.id === "github-modal") showGithubModal(false);
  });
  $("#github-install-form").addEventListener("submit", installGithubPlugin);
  $("#github-repository-url").addEventListener("input", updateGithubInstallPreview);
  $("#github-project-name").addEventListener("input", updateGithubInstallPreview);
  $("#github-module-name").addEventListener("input", updateGithubInstallPreview);
  $("#check-update-btn").addEventListener("click", () => checkUpdate($("#check-update-btn")));
  $("#proxy-save").addEventListener("click", saveProxySettings);
  $("#proxy-test-btn").addEventListener("click", testProxySettings);
  $$(".view-toggle button").forEach((button) => button.addEventListener("click", () => {
    $$(".view-toggle button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    $("#plugin-grid").classList.toggle("list", button.dataset.view === "list");
  }));
  $("#save-config").addEventListener("click", saveConfig);
  $("#restore-config").addEventListener("click", restoreConfigBackup);
  $("#config-backup-select").addEventListener("change", (event) => {
    $("#restore-config").disabled = !event.target.value;
  });
  $("#discard-config").addEventListener("click", discardConfig);
  $("#add-config").addEventListener("click", () => showModal(true));
  $("#modal-close").addEventListener("click", () => showModal(false));
  $("#modal-cancel").addEventListener("click", () => showModal(false));
  $("#modal-confirm").addEventListener("click", addConfig);
  $("#modal").addEventListener("click", (event) => { if (event.target.id === "modal") showModal(false); });
  $("#detail-close").addEventListener("click", closeDetail);
  $("#detail-backdrop").addEventListener("click", closeDetail);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("#detail-drawer").classList.contains("hidden")) closeDetail();
      else if (!$("#github-modal").classList.contains("hidden")) showGithubModal(false);
      else if (!$("#modal").classList.contains("hidden")) showModal(false);
    }
  });
}

async function handleAuth(event) {
  event.preventDefault();
  const submit = $("#auth-submit");
  const error = $("#auth-error");
  submit.disabled = true;
  error.textContent = "";
  try {
    const body = {
      username: $("#username").value.trim(),
      password: $("#password").value,
    };
    const endpoint = state.configured ? "/auth/login" : "/auth/setup";
    if (!state.configured) body.setup_token = $("#setup-token").value.trim();
    const result = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
    state.token = result.token;
    localStorage.setItem(storageKey, state.token);
    enterApp(result.username);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

function enterApp(username) {
  state.username = username;
  $("#auth-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#profile-name").textContent = username;
  $("#welcome-name").textContent = username;
  $("#avatar").textContent = username.slice(0, 1).toUpperCase();
  clearTimers();
  state.timers.push(setInterval(() => loadDashboard(false), 5000));
  state.timers.push(setInterval(loadLogs, 2000));
  Promise.allSettled([
    loadDashboard(),
    loadPlugins(),
    loadLogs(),
    loadBackground(),
    loadVersion(),
    loadProxySettings(),
    loadDeployment(),
  ]);
}

async function signOut(requestLogout) {
  if (requestLogout && state.token) {
    try { await api("/auth/logout", { method: "POST" }); } catch (_) { /* local logout */ }
  }
  clearTimers();
  closeDetail();
  state.token = "";
  localStorage.removeItem(storageKey);
  loadBackground();
  $("#app").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
  $("#password").value = "";
  setAuthMode(true);
}

function clearTimers() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

const pages = {
  dashboard: "概览",
  plugins: "插件",
  access: "响应权限",
  dependencies: "依赖管理",
  config: "核心配置",
  logs: "日志",
  appearance: "外观",
};
async function navigate(page) {
  if (!pages[page]) return;
  state.page = page;
  $$(".page").forEach((item) => item.classList.toggle("active", item.id === `page-${page}`));
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  $("#page-crumb").textContent = pages[page];
  toggleSidebar(false);
  if (page === "plugins") await refreshPluginsPage();
  if (page === "access") await loadAccess();
  if (page === "dependencies") await loadDependencies();
  if (page === "config") await loadConfig();
  if (page === "logs") { await loadLogs(); scrollLogs(); }
  if (page === "appearance") refreshAppearance();
}

function toggleSidebar(show) {
  $("#sidebar").classList.toggle("open", show);
  $("#sidebar-backdrop").classList.toggle("show", show);
}

function updateClock() {
  const now = new Date();
  $("#clock").textContent = now.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const welcomeDate = $("#welcome-date");
  if (welcomeDate) {
    welcomeDate.textContent = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  }
  const hour = now.getHours();
  $("#greeting").textContent = hour < 6 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
}

async function refreshCurrent() {
  const button = $("#refresh-button");
  button.classList.add("loading");
  try {
    if (state.page === "dashboard") await loadDashboard();
    if (state.page === "plugins") await refreshPluginsPage();
    if (state.page === "access") await loadAccess();
    if (state.page === "dependencies") await loadDependencies();
    if (state.page === "config") await loadConfig();
    if (state.page === "logs") await loadLogs();
    if (state.page === "appearance") {
      if (!brandingHasChanges() && !state.brandingReading && !state.brandingBusy) await loadBranding();
      await loadBackground();
      refreshAppearance();
    }
    toast("已刷新");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setTimeout(() => button.classList.remove("loading"), 350);
  }
}

function formatBytes(value) {
  const number = Number(value || 0);
  if (!number) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(number) / Math.log(1024)), units.length - 1);
  return `${(number / 1024 ** index).toFixed(index > 2 ? 1 : 2)} ${units[index]}`;
}

function formatUptime(seconds) {
  const value = Number(seconds || 0);
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function setRing(id, value) {
  const safe = Math.max(0, Math.min(100, Number(value || 0)));
  $(id).style.setProperty("--value", safe.toFixed(1));
}

async function loadDashboard(showErrors = true) {
  try {
    const data = await api("/dashboard");
    state.dashboard = data;
    const system = data.system;
    const cpu = Number(system.cpu_percent || 0).toFixed(1);
    const memory = Number(system.memory_percent || 0).toFixed(1);
    const disk = Number(system.disk_percent || 0).toFixed(1);
    $("#cpu-ring-value").textContent = `${cpu}%`;
    $("#memory-ring-value").textContent = `${memory}%`;
    $("#disk-ring-value").textContent = `${disk}%`;
    setRing("#cpu-ring", cpu);
    setRing("#memory-ring", memory);
    setRing("#disk-ring", disk);
    $("#cpu-ring-sub").textContent = `${system.cpu_count} 核心`;
    $("#process-memory").textContent = `进程 ${formatBytes(system.process_memory)}`;
    $("#disk-free").textContent = `剩余 ${formatBytes(system.disk_total - system.disk_used)}`;
    $("#network-sent").textContent = formatBytes(system.network_sent);
    $("#network-recv").textContent = formatBytes(system.network_recv);
    $("#hostname").textContent = system.hostname;
    $("#nonebot-version").textContent = `v${system.nonebot}`;
    $("#python-version").textContent = `v${system.python}`;
    $("#platform-value").textContent = system.platform;
    $("#plugin-count").textContent = data.counts.plugins;
    $("#matcher-count").textContent = data.counts.matchers;
    $("#sidebar-uptime").textContent = `已运行 ${formatUptime(system.uptime)}`;
    $("#bot-list").innerHTML = data.bots.length
      ? data.bots.map((bot) => `<div class="bot-chip"><strong>${escapeHtml(bot.id)}</strong><span>${escapeHtml(bot.adapter)}</span></div>`).join("")
      : '<div class="empty-text">暂无机器人连接</div>';
  } catch (error) {
    if (showErrors) toast(error.message, "error");
  }
}

async function loadPlugins() {
  try {
    const data = await api("/plugins");
    state.plugins = data.items || [];
    state.packageManagement = data.package_management !== false;
    $("#plugin-total").textContent = state.plugins.length;
    $("#nav-plugin-count").textContent = state.plugins.length;
    $("#loaded-tab-count").textContent = state.plugins.length;
    if (state.pluginTab === "installed") renderPlugins();
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderPlugins() {
  const query = $("#plugin-search").value.trim().toLowerCase();
  const items = state.plugins.filter((item) =>
    [item.title, item.name, item.module, item.description].join(" ").toLowerCase().includes(query),
  );
  $("#plugin-result-meta").textContent = query
    ? `找到 ${items.length} 个已安装插件`
    : `当前项目已安装 ${items.length} 个插件 · 点击卡片查看详情`;
  $("#plugin-grid").innerHTML = items.length
    ? items.map((item, index) => loadedPluginHtml(item, index)).join("")
    : '<div class="empty-state">没有找到匹配的插件</div>';
  bindAvatarFallbacks($("#plugin-grid"));
  bindPluginCardEvents();
}

function loadedPluginHtml(item, index) {
  const isSelf = item.module === "nonebot_plugin_mimo_console";
  const isUnloaded = item.loaded === false;
  const statusButton = `<button
    class="plugin-state-button ${isUnloaded ? "unloaded" : item.disabled ? "disabled" : "enabled"}"
    type="button"
    data-plugin-toggle="${escapeHtml(item.name)}"
    aria-pressed="${String(!item.disabled && !isUnloaded)}"
    aria-label="${isUnloaded ? "未加载" : item.disabled ? "启用" : "禁用"} ${escapeHtml(item.title || item.name)}"
    ${isSelf || isUnloaded ? `disabled title="${isSelf ? "控制台自身不能禁用" : "插件当前未加载，请先检查启动日志"}"` : ""}
  >${isUnloaded ? "未加载" : item.disabled ? "已禁用" : "运行中"}</button>`;
  return `<article class="plugin-card" data-detail-source="loaded" data-detail-index="${index}" data-plugin-name="${escapeHtml(item.name)}" tabindex="0" role="button">
    <div class="plugin-card-head">
      ${pluginAvatarHtml(item)}
      <div class="plugin-title">
        <h3 title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
        <div class="module" title="${escapeHtml(item.module)}">${escapeHtml(item.module)}</div>
      </div>
      ${statusButton}
    </div>
    <p class="desc">${escapeHtml(item.description)}</p>
    <div class="plugin-meta">
      <span>${escapeHtml(item.type)}</span>
      <span>${isUnloaded ? "等待修复加载错误" : `${escapeHtml(item.matchers ?? 0)} 个响应器`}</span>
      ${item.version ? `<span class="plugin-version">v${escapeHtml(String(item.version).replace(/^v/, ""))}</span>` : ""}
    </div>
    <div class="plugin-card-actions">
      ${state.packageManagement && isSelf ? '<button class="btn btn-ghost btn-sm" type="button" data-console-self-update>更新控制台</button>' : ""}
      ${state.packageManagement && !isSelf && (item.local_git_path || item.source_repository || item.update_supported)
        ? `<button class="btn btn-ghost btn-sm" type="button" data-loaded-plugin-update="${escapeHtml(item.name)}" ${item.local_git_path && !item.update_supported ? `disabled title="${escapeHtml(item.update_reason)}"` : ""}>${item.local_git_path ? "更新 Git 插件" : "更新插件"}</button>` : ""}
      <span class="detail-hint">详情 →</span>
    </div>
  </article>`;
}

function onPluginSearch() {
  if (state.pluginTab === "installed") {
    renderPlugins();
    return;
  }
  clearTimeout(state.storeSearchTimer);
  state.storeSearchTimer = setTimeout(() => {
    state.storePage = 1;
    loadStorePlugins();
  }, 320);
}

async function switchPluginTab(tabName) {
  if (!["installed", "store"].includes(tabName) || state.pluginTab === tabName) return;
  state.pluginTab = tabName;
  $$(".tab[data-plugin-tab]").forEach((button) => {
    const active = button.dataset.pluginTab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#plugin-search").value = "";
  $("#plugin-search").placeholder = tabName === "store" ? "搜索插件、作者、标签或包名" : "搜索已安装插件";
  $("#official-filter").classList.toggle("hidden", tabName !== "store");
  $("#store-pagination").classList.toggle("hidden", tabName !== "store");
  if (tabName === "store") await loadStorePlugins();
  else renderPlugins();
}

async function refreshPluginsPage() {
  await loadPlugins();
  if (state.pluginTab === "store") await loadStorePlugins();
}

async function loadStorePlugins() {
  const grid = $("#plugin-grid");
  grid.innerHTML = '<div class="store-loading"><i></i><span>正在加载插件商店…</span></div>';
  $("#plugin-result-meta").textContent = "";
  const params = new URLSearchParams({
    query: $("#plugin-search").value.trim(),
    page: String(state.storePage),
    page_size: "18",
    official_only: String($("#official-only").checked),
  });
  try {
    const data = await api(`/store/plugins?${params}`);
    state.storePlugins = data.items || [];
    state.storePage = data.page || 1;
    state.storePages = data.pages || 1;
    state.storeTotal = data.total || 0;
    state.packageManagement = data.package_management !== false;
    $("#store-tab-count").textContent = state.storeTotal;
    renderStorePlugins();
  } catch (error) {
    grid.innerHTML = `<div class="empty-state store-error"><strong>商店连接失败</strong><span>${escapeHtml(error.message)}</span><br><a href="https://nonebot.dev/store/plugins" target="_blank" rel="noreferrer">打开官方商店 ↗</a></div>`;
    toast(error.message, "error");
  }
}

function renderStorePlugins() {
  const query = $("#plugin-search").value.trim();
  $("#plugin-result-meta").textContent = query
    ? `在官方商店找到 ${state.storeTotal} 个结果 · 点击卡片查看详情`
    : `NoneBot 官方商店 · ${state.storeTotal} 个可用插件 · 点击卡片查看详情`;
  $("#store-page-label").textContent = `第 ${state.storePage} / ${state.storePages} 页`;
  $("#store-prev").disabled = state.storePage <= 1;
  $("#store-next").disabled = state.storePage >= state.storePages;
  $("#store-pagination").classList.toggle("hidden", state.storePages <= 1);
  $("#plugin-grid").innerHTML = state.storePlugins.length
    ? state.storePlugins.map((item, index) => storePluginHtml(item, index)).join("")
    : '<div class="empty-state">没有找到符合条件的插件</div>';
  bindAvatarFallbacks($("#plugin-grid"));
  bindPluginCardEvents();
}

function tagLabels(item) {
  if (Array.isArray(item.tags) && item.tags.length) {
    if (typeof item.tags[0] === "string") return item.tags;
    return item.tags.map((tag) => tag.label || tag).filter(Boolean);
  }
  return item.tag_labels || [];
}

function storePluginHtml(item, index) {
  const tags = tagLabels(item).slice(0, 4);
  const tagHtml = tags.length
    ? tags.map((tag) => `<span class="store-tag">${escapeHtml(tag)}</span>`).join("")
    : '<span class="store-tag muted">暂无标签</span>';
  const official = item.official ? '<span class="badge official">官方</span>' : "";
  const installed = item.installed ? '<span class="badge installed">已安装</span>' : "";
  const version = item.installed
    ? `已安装 ${escapeHtml(item.installed_version || "")}`
    : `最新 ${escapeHtml(item.version || "未知")}`;
  return `<article class="plugin-card store-card" data-detail-source="store" data-detail-index="${index}" tabindex="0" role="button">
    <div class="plugin-card-head">
      ${pluginAvatarHtml(item)}
      <div class="plugin-title">
        <h3>${escapeHtml(item.name)}</h3>
        <div class="module">${escapeHtml(item.project_link)}</div>
      </div>
      ${official}${installed}
    </div>
    <p class="desc">${escapeHtml(item.description)}</p>
    <div class="store-tags">${tagHtml}</div>
    <div class="store-card-footer">
      <div>
        <strong>${escapeHtml(item.author)}</strong>
        <span>${version}</span>
      </div>
      <span class="detail-hint">详情 →</span>
    </div>
  </article>`;
}

function bindPluginCardEvents() {
  bindConsoleUpdateButtons();
  $$(".plugin-card[data-detail-source]").forEach((card) => {
    const open = () => {
      const source = card.dataset.detailSource;
      const index = Number(card.dataset.detailIndex);
      if (source === "loaded") {
        openLoadedDetail(state.plugins.find((item) => item.name === card.dataset.pluginName));
      }
      else openStoreDetail(state.storePlugins[index]);
    };
    card.addEventListener("click", (event) => {
      if (event.target.closest("button, a")) return;
      open();
    });
    card.addEventListener("keydown", (event) => {
      if (event.target.closest("button, a")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
  $$("[data-plugin-toggle]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const item = state.plugins.find((plugin) => plugin.name === button.dataset.pluginToggle);
      if (item) await togglePluginDisabled(item, button);
    });
  });
  $$("[data-loaded-plugin-update]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const item = state.plugins.find((plugin) => plugin.name === button.dataset.loadedPluginUpdate);
      if (!item) return;
      if (item.local_git_path || item.source_repository) {
        button.dataset.sourcePluginAction = "update";
        await manageLoadedSourcePlugin(item, button);
      } else {
        button.dataset.loadedPluginAction = "update";
        button.dataset.pluginDistribution = item.distribution;
        await manageLoadedDependencyPlugin(item, button);
      }
    });
  });
}

function bindConsoleUpdateButtons(context = document) {
  $$("[data-console-self-update]", context).forEach((button) => {
    button.disabled = state.selfUpdateBusy;
    if (button.dataset.consoleUpdateBound) return;
    button.dataset.consoleUpdateBound = "true";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      checkUpdate(button);
    });
  });
}

async function openLoadedDetail(item) {
  if (!item) return;
  state.detailSource = "loaded";
  state.detailPlugin = item;
  setDetailAvatar(item);
  $("#detail-title").textContent = item.title || item.name;
  $("#detail-module").textContent = item.module || "";
  $("#detail-badges").innerHTML = item.loaded === false
    ? '<span class="badge disabled">未加载</span>'
    : item.disabled
      ? '<span class="badge disabled">已禁用</span>'
      : '<span class="badge loaded">运行中</span>';
  const homepage = safeUrl(item.homepage);
  $("#detail-body").innerHTML = `
    <div class="detail-section">
      <h3>简介</h3>
      <p class="detail-desc">${escapeHtml(item.description || "暂无插件介绍")}</p>
    </div>
    ${item.usage ? `<div class="detail-section"><h3>用法</h3><p class="detail-desc mono">${escapeHtml(item.usage)}</p></div>` : ""}
    <div class="detail-section">
      <h3>基本信息</h3>
      <div class="detail-grid">
        <div class="detail-cell"><span>模块名</span><strong class="mono">${escapeHtml(item.module)}</strong></div>
        <div class="detail-cell"><span>类型</span><strong>${escapeHtml(item.type || "plugin")}</strong></div>
        <div class="detail-cell"><span>响应器</span><strong>${escapeHtml(item.matchers ?? 0)}</strong></div>
        <div class="detail-cell"><span>插件名</span><strong>${escapeHtml(item.name)}</strong></div>
        ${item.version ? `<div class="detail-cell"><span>已安装版本</span><strong>${escapeHtml(item.version)}</strong></div>` : ""}
        ${item.local_git_path ? `<div class="detail-cell"><span>Git 分支</span><strong>${escapeHtml(item.git_branch || "未选择分支")}</strong></div><div class="detail-cell"><span>Git 提交</span><strong class="mono">${escapeHtml((item.git_commit || "").slice(0, 12))}</strong></div>` : ""}
      </div>
    </div>
    ${item.path ? `<details class="detail-section detail-disclosure"><summary>本地路径</summary><p class="detail-desc mono">${escapeHtml(item.path)}</p></details>` : ""}
    ${homepage ? `<div class="detail-section"><h3>链接</h3><div class="detail-links"><a href="${homepage}" target="_blank" rel="noreferrer"><span>主页 / 文档</span><span>↗</span></a></div></div>` : ""}
    <details class="detail-section detail-disclosure">
      <summary><h3>README</h3><span>查看插件文档</span></summary>
      <div id="detail-readme"><div class="empty-text">正在加载 README…</div></div>
    </details>
    <div class="detail-section plugin-config-section" id="detail-plugin-config">
      <h3>插件配置</h3>
      <div class="empty-state compact">${item.loaded === false ? "插件未加载，暂无运行时配置可编辑" : "正在读取配置…"}</div>
    </div>
  `;
  const isSelf = item.module === "nonebot_plugin_mimo_console";
  const loadedActions = [];
  if (state.packageManagement && isSelf) {
    loadedActions.push('<button class="btn btn-primary" type="button" data-console-self-update>更新控制台</button>');
    loadedActions.push('<span class="empty-text">检查官方上游版本，确认更新后自动重启 NoneBot。</span>');
  }
  if (state.packageManagement && !isSelf) {
    if (item.local_git_path) {
      loadedActions.push(`<button class="btn btn-primary" type="button" data-source-plugin-action="update" ${item.update_supported ? "" : "disabled"}>更新 Git 插件</button>`);
      if (!item.update_supported) loadedActions.push(`<span class="empty-text">${escapeHtml(item.update_reason)}</span>`);
    } else if (item.source_repository) {
      loadedActions.push(
        `<button class="btn btn-primary" type="button" data-source-plugin-action="update">更新源码插件</button>
         <button class="btn btn-danger" type="button" data-source-plugin-action="uninstall">卸载源码插件</button>`,
      );
    } else if (item.distribution) {
      loadedActions.push(
        item.update_supported
          ? `<button class="btn btn-primary" type="button" data-loaded-plugin-action="update" data-plugin-distribution="${escapeHtml(item.distribution)}">更新插件</button>`
          : `<span class="empty-text">${escapeHtml(item.update_reason || "该插件不支持在线更新")}</span>`,
        `<button class="btn btn-danger" type="button" data-loaded-plugin-action="uninstall" data-plugin-distribution="${escapeHtml(item.distribution)}">卸载</button>`,
      );
    }
  }
  if (homepage) {
    loadedActions.push(`<a class="btn btn-ghost" href="${homepage}" target="_blank" rel="noreferrer">打开主页</a>`);
  }
  $("#detail-actions").innerHTML = loadedActions.join("");
  bindConsoleUpdateButtons($("#detail-actions"));
  $$("[data-source-plugin-action]", $("#detail-actions")).forEach((button) => {
    button.addEventListener("click", () => manageLoadedSourcePlugin(item, button));
  });
  $$("[data-loaded-plugin-action]", $("#detail-actions")).forEach((button) => {
    button.addEventListener("click", () => manageLoadedDependencyPlugin(item, button));
  });
  showDetail(true);
  loadPluginReadme(item.name || item.module, "loaded");
  if (item.loaded !== false) {
    try {
      await fetchConfigData({ preserveChanges: true });
      if (state.detailPlugin === item) renderDetailPluginConfig(item);
    } catch (error) {
      const target = $("#detail-plugin-config");
      if (target) target.innerHTML = `<h3>插件配置</h3><div class="empty-state compact">${escapeHtml(error.message)}</div>`;
    }
  }
}

async function manageLoadedSourcePlugin(item, button) {
  const action = button.dataset.sourcePluginAction;
  const label = action === "update" ? "更新" : "卸载";
  const explanation = item.local_git_path
    ? `将从 ${item.git_upstream || "当前上游分支"} 快进更新；本地修改或分支分叉时会停止。完成后需要重启 NoneBot 生效。`
    : "完成后需要重启 NoneBot 生效。";
  if (!window.confirm(`确定${label}「${item.title || item.name}」吗？${explanation}`)) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = `${label}中…`;
  try {
    let result = await api(`/plugins/${encodeURIComponent(item.module)}/action`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    if (result.status && !["succeeded", "failed", "rolled_back"].includes(result.status)) {
      result = await waitPackageOperation(result, button, label);
    }
    if (result.status === "failed" || result.status === "rolled_back") {
      throw new Error(result.error || `${label}失败`);
    }
    toast(result.detail || `${item.title || item.name} 已${label}${result.restart_required ? "，重启 NoneBot 后生效" : ""}`, result.restart_required ? "warning" : "success");
    closeDetail();
    await loadPlugins();
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.textContent = original;
  }
}

async function manageLoadedDependencyPlugin(item, button) {
  const action = button.dataset.loadedPluginAction;
  const distribution = button.dataset.pluginDistribution;
  const label = action === "update" ? "更新" : "卸载";
  if (!distribution) return;
  if (!window.confirm(`确定${label}「${item.title || item.name}」吗？完成后需要重启 NoneBot 生效。`)) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = `${label}中…`;
  try {
    const endpoint = action === "update"
      ? `/plugins/${encodeURIComponent(item.module)}/action`
      : `/dependencies/${encodeURIComponent(distribution)}/action`;
    let result = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    if (result.status && !["succeeded", "failed", "rolled_back"].includes(result.status)) {
      result = await waitPackageOperation(result, button, label);
    }
    if (result.status === "failed" || result.status === "rolled_back") {
      throw new Error(result.error || `${label}失败`);
    }
    toast(`${item.title || item.name} 已${label}，重启 NoneBot 后生效`, "success");
    closeDetail();
    await loadPlugins();
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.textContent = original;
  }
}

async function togglePluginDisabled(item, button = null) {
  if (item.loaded === false) return;
  const next = !item.disabled;
  if (button) button.disabled = true;
  try {
    await api("/plugins/disabled", {
      method: "PUT",
      body: JSON.stringify({ plugin: item.name, disabled: next }),
    });
    item.disabled = next;
    renderPlugins();
    if (state.detailPlugin === item && state.detailSource === "loaded") {
      $("#detail-badges").innerHTML = item.disabled
        ? '<span class="badge disabled">已禁用</span>'
        : '<span class="badge loaded">运行中</span>';
    }
  } catch (error) {
    toast(error.message, "error");
    if (button) button.disabled = false;
  }
}

async function openStoreDetail(item) {
  if (!item) return;
  state.detailSource = "store";
  state.detailPlugin = item;
  setDetailAvatar(item);
  $("#detail-title").textContent = item.name || item.module_name;
  $("#detail-module").textContent = item.module_name || item.project_link || "";
  $("#detail-badges").innerHTML = [
    item.official ? '<span class="badge official">官方</span>' : "",
    item.installed ? '<span class="badge installed">已安装</span>' : "",
  ].join("");
  $("#detail-body").innerHTML = '<div class="empty-state compact">正在加载详情…</div>';
  $("#detail-actions").innerHTML = "";
  showDetail(true);

  let detail = item;
  try {
    const data = await api(`/store/plugins/${encodeURIComponent(item.module_name)}`);
    detail = data.item || item;
    if (data.package_management !== undefined) state.packageManagement = data.package_management;
  } catch (_) {
    /* use list data */
  }
  state.detailPlugin = detail;
  renderStoreDetail(detail);
}

function renderStoreDetail(item) {
  const homepage = safeUrl(item.homepage);
  const storeUrl = safeUrl(item.store_url) || safeUrl(`https://nonebot.dev/store/plugins?q=${item.project_link || ""}`);
  const tags = tagLabels(item);
  const adapters = item.supported_adapters || [];
  const tagHtml = tags.length
    ? tags.map((tag, i) => {
        const raw = Array.isArray(item.tags) && item.tags[i] && item.tags[i].color
          ? item.tags[i].color
          : "";
        // Only accept a strict #hex color; escapeHtml does not neutralize `;`, `:`
        // or `(`, so an unvalidated store-supplied value could inject extra CSS
        // declarations (e.g. background-image:url(...) beacons).
        const color = /^#[0-9a-fA-F]{3,8}$/.test(raw) ? raw : "";
        const style = color ? `style="--tag-c:${color};background:color-mix(in srgb, ${color} 18%, transparent);color:${color}"` : "";
        return `<span class="detail-tag" ${style}>${escapeHtml(tag)}</span>`;
      }).join("")
    : '<span class="store-tag muted">暂无标签</span>';
  const adapterHtml = adapters.length
    ? adapters.map((a) => `<span>${escapeHtml(a)}</span>`).join("")
    : "<span>全部适配器 / 未声明</span>";

  setDetailAvatar(item);
  $("#detail-title").textContent = item.name || item.module_name;
  $("#detail-module").textContent = item.module_name || "";
  $("#detail-badges").innerHTML = [
    item.official ? '<span class="badge official">官方</span>' : "",
    item.installed ? '<span class="badge installed">已安装</span>' : "",
    item.valid === false ? '<span class="badge" style="color:var(--color-yellow);background:rgba(245,158,11,.12)">未通过检查</span>' : "",
  ].join("");

  $("#detail-body").innerHTML = `
    <div class="detail-section">
      <h3>简介</h3>
      <p class="detail-desc">${escapeHtml(item.description || "暂无插件介绍")}</p>
    </div>
    <div class="detail-section">
      <h3>基本信息</h3>
      <div class="detail-grid">
        <div class="detail-cell"><span>作者</span><strong>${escapeHtml(item.author || "unknown")}</strong></div>
        <div class="detail-cell"><span>类型</span><strong>${escapeHtml(item.type || "application")}</strong></div>
        <div class="detail-cell"><span>最新版本</span><strong>${escapeHtml(item.version || "未知")}</strong></div>
        <div class="detail-cell"><span>已装版本</span><strong>${escapeHtml(item.installed_version || "未安装")}</strong></div>
        <div class="detail-cell"><span>包名</span><strong class="mono">${escapeHtml(item.project_link || "")}</strong></div>
        <div class="detail-cell"><span>更新时间</span><strong>${escapeHtml(formatDate(item.updated_at))}</strong></div>
      </div>
    </div>
    <div class="detail-section">
      <h3>标签</h3>
      <div class="detail-tags">${tagHtml}</div>
    </div>
    <div class="detail-section">
      <h3>支持适配器</h3>
      <div class="detail-adapters">${adapterHtml}</div>
    </div>
    <div class="detail-section">
      <h3>链接</h3>
      <div class="detail-links">
        ${homepage ? `<a href="${homepage}" target="_blank" rel="noreferrer"><span>项目主页</span><span>↗</span></a>` : ""}
        ${storeUrl ? `<a href="${storeUrl}" target="_blank" rel="noreferrer"><span>NoneBot 商店</span><span>↗</span></a>` : ""}
        <a href="https://pypi.org/project/${encodeURIComponent(item.project_link || "")}/" target="_blank" rel="noreferrer"><span>PyPI</span><span>↗</span></a>
      </div>
    </div>
    <div class="detail-section">
      <h3>文档</h3>
      <div id="detail-readme"><div class="empty-text">正在加载 README…</div></div>
    </div>
  `;

  const moduleName = item.module_name;
  const name = item.name || moduleName;
  let actions = "";
  if (!state.packageManagement) {
    actions = '<button class="btn btn-ghost" type="button" disabled>安装已关闭</button>';
  } else if (item.installed) {
    actions = `
      <button class="btn btn-primary" type="button" data-plugin-action="update" data-plugin-module="${escapeHtml(moduleName)}" data-plugin-name="${escapeHtml(name)}">更新</button>
      <button class="btn btn-danger" type="button" data-plugin-action="uninstall" data-plugin-module="${escapeHtml(moduleName)}" data-plugin-name="${escapeHtml(name)}">卸载</button>
    `;
  } else {
    actions = `<button class="btn btn-primary" type="button" data-plugin-action="install" data-plugin-module="${escapeHtml(moduleName)}" data-plugin-name="${escapeHtml(name)}">安装插件</button>`;
  }
  if (homepage) {
    actions += `<a class="btn btn-ghost" href="${homepage}" target="_blank" rel="noreferrer">主页</a>`;
  }
  $("#detail-actions").innerHTML = actions;
  $$("[data-plugin-action]", $("#detail-actions")).forEach((button) => {
    button.addEventListener("click", () => manageStorePlugin(button));
  });
  loadPluginReadme(moduleName);
}

function showDetail(show) {
  $("#detail-drawer").classList.toggle("hidden", !show);
  document.body.style.overflow = show ? "hidden" : "";
}

function closeDetail() {
  showDetail(false);
  state.detailPlugin = null;
  state.detailSource = null;
}

async function manageStorePlugin(button) {
  const action = button.dataset.pluginAction;
  const moduleName = button.dataset.pluginModule;
  const pluginName = button.dataset.pluginName;
  const labels = { install: "安装", update: "更新", uninstall: "卸载" };
  const dockerMode = state.deployment.mode === "docker-agent";
  const containerLocal = state.deployment.mode === "docker-local";
  const effect = dockerMode
    ? "系统会构建新镜像、验证并自动替换当前容器；失败时自动回滚。"
    : containerLocal
      ? "操作会立即修改当前容器；容器重建后可能丢失，建议连接 Mimo Agent 后再做长期变更。"
      : "完成后需要重启 NoneBot。";
  if (!window.confirm(`确定${labels[action]}「${pluginName}」吗？${effect}`)) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = `${labels[action]}中…`;
  const drawer = $("#detail-drawer");
  drawer.classList.add("busy");
  try {
    let result = await api(`/store/plugins/${encodeURIComponent(moduleName)}/action`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    if (result.status && !["succeeded", "failed", "rolled_back"].includes(result.status)) {
      result = await waitPackageOperation(result, button, labels[action]);
    }
    if (result.status === "rolled_back" || result.status === "failed") {
      throw new Error(result.error || `${labels[action]}失败，原容器已恢复`);
    }
    const message = result.restart_required
      ? `${pluginName} 已${labels[action]}，重启 NoneBot 后生效`
      : `${pluginName} 已${labels[action]}并完成容器切换`;
    toast(message, result.restart_required ? "warning" : "success");
    await loadStorePlugins();
    if (state.detailSource === "store" && state.detailPlugin?.module_name === moduleName) {
      const next = state.storePlugins.find((item) => item.module_name === moduleName);
      if (next) await openStoreDetail(next);
      else closeDetail();
    }
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.textContent = original;
  } finally {
    drawer.classList.remove("busy");
  }
}

async function loadDeployment() {
  try {
    state.deployment = await api("/store/deployment");
    state.packageManagement = Boolean(state.deployment.package_management);
    const dockerMode = state.deployment.mode === "docker-agent";
    const containerLocal = state.deployment.mode === "docker-local";
    const githubButton = $("#github-install-button");
    githubButton.classList.toggle("hidden", !state.packageManagement);
    githubButton.disabled = !state.deployment.github_install;
    githubButton.title = state.deployment.github_install
      ? dockerMode
        ? "从公开 GitHub 仓库安装插件并自动构建镜像"
        : "从公开 GitHub 仓库安装插件"
      : "当前运行环境缺少 Git，无法从 GitHub 安装";
    $("#restart-button").title = dockerMode
      ? "由 Mimo Agent 重建并检查当前 NoneBot 容器"
      : containerLocal
        ? "重启当前容器内的 NoneBot 进程"
        : "重启 NoneBot 进程";
    $("#deployment-panel").classList.toggle("hidden", !dockerMode);
    if (dockerMode) {
      $("#deployment-summary").textContent = state.deployment.available
        ? `实例 ${state.deployment.instance_id} · 宿主机 Agent 已连接 · 支持自动回滚`
        : `实例 ${state.deployment.instance_id} · 宿主机 Agent 未连接 · ${state.deployment.error || "请检查 Agent 服务与 Socket 挂载"}`;
      if (state.deployment.available) {
        await loadDeploymentOperations();
        state.timers.push(setInterval(loadDeploymentOperations, 5000));
      } else {
        $("#deployment-operations").innerHTML = '<div class="empty-state">Agent 恢复连接后将在这里显示部署记录</div>';
      }
    }
  } catch (_) {
    state.deployment = { mode: "python", rollback: false, github_install: false };
    $("#github-install-button").classList.add("hidden");
    $("#deployment-panel").classList.add("hidden");
  }
}

function showGithubModal(show) {
  $("#github-modal").classList.toggle("hidden", !show);
  $("#github-modal-error").textContent = "";
  if (show) {
    updateGithubInstallPreview();
    setTimeout(() => $("#github-repository-url").focus(), 0);
  } else {
    $("#github-install-form").reset();
    $("#github-install-hint").textContent = "";
  }
}

function updateGithubInstallPreview() {
  const value = $("#github-repository-url").value.trim();
  let repository = "";
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.protocol === "https:" && ["github.com", "www.github.com"].includes(url.hostname) && parts.length === 2) {
      repository = parts[1].replace(/\.git$/i, "");
    }
  } catch (_) { /* wait for a complete URL */ }
  if (!repository) {
    $("#github-install-hint").textContent = "";
    return;
  }
  const projectName = $("#github-project-name").value.trim() || repository;
  const moduleName = $("#github-module-name").value.trim() || repository.replace(/[-.]+/g, "_");
  $("#github-install-hint").textContent = `包名 ${projectName} · 导入名 ${moduleName}`;
}

async function installGithubPlugin(event) {
  event.preventDefault();
  const button = $("#github-modal-confirm");
  const errorBox = $("#github-modal-error");
  const repositoryUrl = $("#github-repository-url").value.trim();
  const body = {
    repository_url: repositoryUrl,
    project_name: $("#github-project-name").value.trim(),
    module_name: $("#github-module-name").value.trim(),
  };
  errorBox.textContent = "";
  button.disabled = true;
  button.textContent = "提交中…";
  try {
    let result = await api("/store/github/install", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (result.status && !["succeeded", "failed", "rolled_back"].includes(result.status)) {
      result = await waitPackageOperation(result, button, "安装");
    }
    if (result.status === "rolled_back" || result.status === "failed") {
      throw new Error(result.error || "安装失败，原容器已恢复");
    }
    showGithubModal(false);
    const message = result.restart_required
      ? `${result.project_link} 已从 GitHub 安装，重启 NoneBot 后生效`
      : `${result.project_link} 已从 GitHub 安装并完成容器切换`;
    toast(message, result.restart_required ? "warning" : "success");
    await Promise.all([loadPlugins(), loadDeploymentOperations()]);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "安装并部署";
  }
}

async function loadDeploymentOperations() {
  if (state.deployment.mode !== "docker-agent") return;
  const container = $("#deployment-operations");
  try {
    const data = await api("/store/operations");
    const items = (data.items || []).slice(0, 8);
    container.innerHTML = items.length
      ? items.map((operation) => {
        const title = operation.action === "restart"
          ? "重启 NoneBot"
          : `${({ install: "安装", update: "更新", uninstall: "卸载" })[operation.action] || operation.action} ${operation.project_name}`;
        const canRollback = state.deployment.rollback
          && operation.rollback_available === true;
        return `<div class="deployment-operation">
          <div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(operation.operation_id)}</small></div>
          <span class="operation-status ${escapeHtml(operation.status)}">${escapeHtml(operationLabels[operation.status] || operation.status)}</span>
          ${canRollback ? `<button class="btn btn-ghost btn-sm" type="button" data-rollback-operation="${escapeHtml(operation.operation_id)}">回滚</button>` : ""}
        </div>`;
      }).join("")
      : '<div class="empty-state compact">还没有 Docker 部署记录</div>';
    $$("[data-rollback-operation]", container).forEach((button) => {
      button.addEventListener("click", () => rollbackDeployment(button));
    });
  } catch (error) {
    container.innerHTML = `<div class="empty-state compact">${escapeHtml(error.message)}</div>`;
  }
}

async function rollbackDeployment(button) {
  if (!window.confirm("确定回滚到这次操作之前的项目清单和容器镜像吗？")) return;
  button.disabled = true;
  try {
    let operation = await api(
      `/store/operations/${encodeURIComponent(button.dataset.rollbackOperation)}/rollback`,
      { method: "POST" },
    );
    operation = await waitPackageOperation(operation, button, "回滚");
    if (operation.status !== "rolled_back") {
      throw new Error(operation.error || "回滚失败");
    }
    toast("已恢复旧项目清单和容器镜像");
    await loadDeploymentOperations();
    await loadStorePlugins();
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  }
}

const operationLabels = {
  queued: "排队",
  preparing: "准备项目",
  locking: "解析依赖",
  building: "构建镜像",
  verifying: "验证镜像",
  deploying: "切换容器",
  health_checking: "健康检查",
  rolling_back: "正在回滚",
  succeeded: "成功",
  rolled_back: "已回滚",
  failed: "失败",
};

async function waitPackageOperation(initial, button = null, actionLabel = "操作") {
  let operation = initial;
  // The Agent applies its timeout independently to dependency resolution, lock
  // verification and image build, so the complete transaction has no safe fixed
  // browser-side ceiling. Poll until the persisted operation reaches a terminal
  // state. A continuous one-hour outage is longer than the maximum deploy plus
  // health-check window and indicates that the Agent/WebUI really is unavailable.
  const POLL_INTERVAL_MS = 2000;
  const MAX_CONSECUTIVE_FAILURES = 1800; // ~1h of unreachable Agent/WebUI
  let consecutiveFailures = 0;
  while (true) {
    if (["succeeded", "failed", "rolled_back"].includes(operation.status)) return operation;
    if (button) button.textContent = operationLabels[operation.status] || `${actionLabel}中…`;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      operation = await api(`/store/operations/${encodeURIComponent(operation.operation_id)}`);
      consecutiveFailures = 0;
    } catch (_) {
      // 部署阶段容器会短暂离线；保留操作 ID，待 WebUI 恢复后继续查询。
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error("无法连接 Mimo Agent，请检查 Agent 服务与网络后重试");
      }
    }
  }
}

function changeStorePage(offset) {
  const next = Math.min(state.storePages, Math.max(1, state.storePage + offset));
  if (next === state.storePage) return;
  state.storePage = next;
  loadStorePlugins();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadDependencies() {
  const list = $("#dependency-list");
  list.innerHTML = '<div class="store-loading"><i></i><span>正在读取依赖…</span></div>';
  try {
    const data = await api("/dependencies");
    state.dependencies = data.items || [];
    state.dependencyMeta = {
      total: Number(data.total || 0),
      direct: Number(data.direct || 0),
      path: data.path || "",
    };
    if (data.deployment) state.deployment = { ...state.deployment, ...data.deployment };
    state.packageManagement = data.package_management !== false;
    renderDependencyModeNotice();
    $("#dependency-direct-count").textContent = state.dependencyMeta.direct;
    $("#dependency-name").disabled = !state.packageManagement;
    $("#dependency-install-button").disabled = !state.packageManagement;
    renderDependencies();
  } catch (error) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    toast(error.message, "error");
  }
}

function renderDependencyModeNotice() {
  const mode = state.deployment.mode;
  const automatic = state.deployment.auto_detected !== false;
  const prefix = automatic ? "已自动识别" : "已按配置使用";
  const messages = {
    "docker-agent": `${prefix}：官方 Docker + Mimo Agent。变更会写入项目、重建镜像并执行健康检查。`,
    "docker-local": `${prefix}：Docker 容器（未连接 Agent）。操作仅修改当前容器，重建后可能丢失。`,
    python: `${prefix}：普通 Python/虚拟环境部署。变更会写入当前项目，重启 NoneBot 后生效。`,
  };
  $("#dependency-mode-notice").textContent = `${messages[mode] || messages.python} 间接依赖仅供查看。`;
}

function dependencyKindLabel(item) {
  if (item.kind === "plugin") return "NoneBot 插件";
  if (item.kind === "core") return "核心组件";
  return item.direct ? "项目依赖" : "间接依赖";
}

function renderDependencies() {
  const query = $("#dependency-search").value.trim().toLowerCase();
  const filter = $("#dependency-filter").value;
  const items = state.dependencies.filter((item) => {
    if (filter === "direct" && !item.direct) return false;
    if (filter === "transitive" && item.direct) return false;
    return [item.name, item.version, item.requirement].join(" ").toLowerCase().includes(query);
  });
  $("#dependency-result-meta").textContent = `${items.length} 个结果 · 共安装 ${state.dependencyMeta.total} 个 Python 包`;
  $("#dependency-list").innerHTML = items.length
    ? items.map(dependencyItemHtml).join("")
    : '<div class="empty-state">没有找到匹配的依赖</div>';
  $$("[data-dependency-action]").forEach((button) => {
    button.addEventListener("click", () => manageDependency(
      button.dataset.dependencyAction,
      button.dataset.dependencyName,
      button,
    ));
  });
}

function dependencyItemHtml(item) {
  let actions = '<span class="dependency-readonly">由其他依赖自动管理</span>';
  if (item.kind === "plugin") {
    actions = '<span class="dependency-readonly">请在插件中心管理</span>';
  } else if (item.kind === "core") {
    actions = '<span class="dependency-readonly">运行所必需</span>';
  } else if (item.manageable && state.packageManagement) {
    actions = `
      <button class="btn btn-secondary btn-sm" type="button" data-dependency-action="update" data-dependency-name="${escapeHtml(item.name)}">更新</button>
      <button class="btn btn-danger btn-sm" type="button" data-dependency-action="uninstall" data-dependency-name="${escapeHtml(item.name)}">卸载</button>
    `;
  } else if (item.direct) {
    actions = '<span class="dependency-readonly">依赖管理已关闭</span>';
  }
  return `<article class="card dependency-item">
    <div class="dependency-main">
      <div class="dependency-icon">${escapeHtml(item.name.slice(0, 1).toUpperCase())}</div>
      <div class="min-w-0">
        <h3>${escapeHtml(item.name)}</h3>
        <p class="mono">${escapeHtml(item.requirement || "由项目依赖解析安装")}</p>
      </div>
    </div>
    <div class="dependency-version"><span>已安装</span><strong>${escapeHtml(item.version || "未安装")}</strong></div>
    <span class="badge">${dependencyKindLabel(item)}</span>
    <div class="dependency-actions">${actions}</div>
  </article>`;
}

async function installDependency(event) {
  event.preventDefault();
  const name = $("#dependency-name").value.trim();
  if (!name) return;
  await manageDependency("install", name, $("#dependency-install-button"));
  $("#dependency-name").value = "";
}

async function manageDependency(action, name, button) {
  const mode = state.deployment.mode;
  const effect = mode === "docker-agent"
    ? "系统会重建镜像并自动切换容器。"
    : mode === "docker-local"
      ? "该变更仅作用于当前容器，容器重建后可能丢失。"
      : "完成后需要重启 NoneBot。";
  if (
    action === "uninstall"
    && !window.confirm(`确定卸载项目依赖「${name}」？${effect}`)
  ) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = action === "install" ? "安装中…" : action === "update" ? "更新中…" : "卸载中…";
  try {
    let result = await api(`/dependencies/${encodeURIComponent(name)}/action`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    if (result.status && !["succeeded", "failed", "rolled_back"].includes(result.status)) {
      result = await waitPackageOperation(result, button, "依赖操作");
    }
    if (result.status && result.status !== "succeeded") {
      throw new Error(result.error || "依赖操作失败，原容器已恢复");
    }
    toast(`${name} ${action === "install" ? "已安装" : action === "update" ? "已更新" : "已卸载"}`);
    await loadDependencies();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function configGroup(key) {
  return MimoConfigUI.describe({ key, value: "" }).group;
}

async function fetchConfigData({ preserveChanges = false } = {}) {
  const pendingChanges = preserveChanges ? new Map(state.configChanges) : null;
  const data = await api("/config");
  state.configItems = data.items || [];
  state.configOriginal = new Map(state.configItems.map((item) => [item.key, item.value]));
  state.configChanges = pendingChanges || new Map();
  if (!preserveChanges) state.configAdded.clear();
  $("#config-path").textContent = String(data.path || "").split(/[\\/]/).pop() || "配置文件";
  $("#config-path").title = data.path || "";
  updateSaveBar();
  return data;
}

async function loadConfig() {
  // Keep drafts intact when revisiting this page or pressing Refresh.
  if (state.configChanges.size) { renderConfig(); updateSaveBar(); return; }
  try {
    await fetchConfigData();
    renderConfig();
    await loadConfigBackups();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadConfigBackups() {
  const select = $("#config-backup-select");
  const button = $("#restore-config");
  try {
    const data = await api("/config/backups");
    const items = data.items || [];
    select.innerHTML = items.length
      ? `<option value="">选择配置备份…</option>${items.map((item) => {
        const label = `${new Date(item.created_at).toLocaleString("zh-CN")} · ${formatBytes(item.size)}`;
        return `<option value="${escapeHtml(item.backup_id)}">${escapeHtml(label)}</option>`;
      }).join("")}`
      : '<option value="">没有可用备份</option>';
    button.disabled = true;
  } catch (error) {
    select.innerHTML = '<option value="">备份列表不可用</option>';
    button.disabled = true;
  }
}

async function restoreConfigBackup() {
  const select = $("#config-backup-select");
  const backupId = select.value;
  if (!backupId || !window.confirm("还原该配置备份？当前配置会先自动备份，之后需要重启 NoneBot。")) return;
  const button = $("#restore-config");
  button.disabled = true;
  try {
    await api("/config/restore", {
      method: "POST",
      body: JSON.stringify({ backup_id: backupId }),
    });
    toast("配置已还原，请重启 NoneBot 使其生效", "warning");
    state.configChanges.clear();
    state.configAdded.clear();
    await loadConfig();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function renderConfig() {
  const query = $("#config-search").value.trim().toLowerCase();
  const descriptions = {
    "运行设置": ["01", "调整服务运行与日志输出"],
    "OneBot 连接": ["02", "连接 OneBot 客户端，多个机器人账号共用一份适配器"],
    "消息与权限": ["03", "决定哪些用户可以与机器人交互"],
    "官方 QQ 接口": ["04", "配置官方 QQ 机器人开放平台账号"],
    "控制台设置": ["05", "管理面板的访问与功能设置"],
    "其他配置": ["06", "当前文件中的其他环境变量"],
  };
  const coreItems = state.configItems.filter((item) => !state.plugins.some((plugin) => pluginConfigKeys(plugin).has(item.key)));
  const counts = new Map();
  coreItems.forEach((item) => counts.set(configGroup(item.key), (counts.get(configGroup(item.key)) || 0) + 1));
  const categories = ["全部设置", ...Object.keys(descriptions).filter((name) => counts.has(name))];
  if (!categories.includes(state.configCategory)) state.configCategory = "全部设置";
  $("#config-summary").textContent = `${coreItems.length} 项配置 · ${counts.size} 个分组`;
  $("#config-categories").innerHTML = categories.map((name) => `<button type="button" class="config-category${state.configCategory === name ? " active" : ""}" data-category="${escapeHtml(name)}" aria-pressed="${state.configCategory === name}">${escapeHtml(name)}<span>${name === "全部设置" ? coreItems.length : counts.get(name)}</span></button>`).join("");
  $$(".config-category").forEach((button) => button.addEventListener("click", () => {
    state.configCategory = button.dataset.category;
    renderConfig();
    $$(".config-category").find((item) => item.dataset.category === state.configCategory)?.focus();
  }));
  const endpoint = new URL("/onebot/v11/ws", location.origin);
  endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  $("#config-ws-endpoint").textContent = endpoint.href;
  $("#copy-ws-endpoint").onclick = async () => {
    try { await navigator.clipboard.writeText(endpoint.href); toast("连接地址已复制"); }
    catch (_) { toast("未能访问剪贴板，请选中地址后复制。", "warning"); }
  };
  $("#config-connect-guide").classList.toggle("hidden", !["全部设置", "OneBot 连接"].includes(state.configCategory) || Boolean(query));
  const groups = new Map();
  coreItems
    .filter((item) => {
      const spec = MimoConfigUI.describe(item);
      return [item.key, spec.label, spec.hint, spec.group].join(" ").toLowerCase().includes(query)
        && (state.configCategory === "全部设置" || state.configCategory === spec.group);
    })
    .forEach((item) => {
      const name = configGroup(item.key);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(item);
    });
  $("#config-groups").innerHTML = groups.size
    ? [...groups].sort(([a], [b]) => Object.keys(descriptions).indexOf(a) - Object.keys(descriptions).indexOf(b)).map(([name, items]) =>
      `<section class="config-group"><header class="config-group-head"><div class="config-group-title"><span class="config-group-number" aria-hidden="true">${descriptions[name]?.[0] || "·"}</span><div><h2>${escapeHtml(name)}</h2><p>${escapeHtml(descriptions[name]?.[1] || "")}</p></div></div><span>${items.length} 项</span></header>${items.map(configItemHtml).join("")}</section>`,
    ).join("")
    : '<div class="empty-state config-empty"><strong>没有找到匹配的配置</strong><p>试试搜索中文名称或字段名，或切换到「全部设置」。</p></div>';
  const configGroups = $("#config-groups");
  $$(".config-input", configGroups).forEach((input) => input.addEventListener("input", () => {
    const item = state.configItems.find((entry) => entry.key === input.dataset.key);
    const value = MimoConfigUI.fromEditor(item, input.type === "checkbox" ? String(input.checked) : input.value);
    changeConfig(item.key, value);
    const error = MimoConfigUI.validate(item, value);
    input.setAttribute("aria-invalid", String(Boolean(error)));
    const row = input.closest(".config-item");
    row.classList.toggle("config-item-changed", state.configChanges.has(item.key));
    row.querySelector(".config-field-error").textContent = error;
    row.querySelector(".config-field-error").hidden = !error;
    const toggleLabel = row.querySelector(".config-switch-state");
    if (toggleLabel) toggleLabel.textContent = input.checked ? "已开启" : "已关闭";
  }));
  $$(".secret-toggle", configGroups).forEach((button) => button.addEventListener("click", () => {
    const input = $(`.config-input[data-key="${CSS.escape(button.dataset.key)}"]`, configGroups);
    input.type = input.type === "password" ? "text" : "password";
    button.textContent = input.type === "password" ? "显示" : "隐藏";
  }));
}

function configItemHtml(item) {
  const value = state.configChanges.has(item.key) ? state.configChanges.get(item.key) : item.value;
  const spec = MimoConfigUI.describe(item);
  const editorValue = MimoConfigUI.toEditor({ ...item, value });
  const key = escapeHtml(item.key);
  const id = `config-field-${key}`;
  const attributes = `id="${id}" class="config-input" data-key="${key}" aria-describedby="${id}-hint ${id}-error" autocomplete="off" aria-invalid="${Boolean(state.configChanges.has(item.key) && MimoConfigUI.validate(item, value))}"`;
  let control;
  if (spec.kind === "select") {
    const options = [...new Set([...spec.options, editorValue])];
    control = `<select ${attributes}>${options.map((option) => `<option value="${escapeHtml(option)}"${option === editorValue ? " selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select>`;
  } else if (["ids", "json"].includes(spec.kind)) {
    control = `<textarea ${attributes} rows="${spec.kind === "ids" ? 3 : 4}" spellcheck="false" placeholder="${spec.kind === "ids" ? "每行填写一个用户 ID" : "填写 JSON 格式的配置"}">${escapeHtml(editorValue)}</textarea>`;
  } else if (spec.kind === "boolean") {
    control = `<label class="config-boolean"><input ${attributes} type="checkbox" role="switch" ${editorValue === "true" ? "checked" : ""}><span class="config-switch-track" aria-hidden="true"></span><span class="config-switch-state">${editorValue === "true" ? "已开启" : "已关闭"}</span></label>`;
  } else {
    control = `<input ${attributes} type="${spec.secret ? "password" : spec.kind === "port" ? "number" : "text"}" ${spec.kind === "port" ? 'min="1" max="65535" step="1"' : ""} value="${escapeHtml(editorValue)}">${spec.secret ? `<button class="secret-toggle" data-key="${key}" type="button" aria-label="显示 ${escapeHtml(spec.label)}">显示</button>` : ""}`;
  }
  const error = state.configChanges.has(item.key) ? MimoConfigUI.validate(item, value) : "";
  return `<div class="config-item${state.configChanges.has(item.key) ? " config-item-changed" : ""}"><div class="config-key"><label for="${id}">${escapeHtml(spec.label)}${spec.secret ? '<span class="config-sensitive">敏感</span>' : ""}</label><code>${key}</code><p id="${id}-hint">${escapeHtml(spec.hint)}</p></div><div class="config-control"><div class="config-input-wrap">${control}</div>${spec.kind === "ids" ? '<span class="config-control-note">逐行填写，保存时自动转换为 JSON 数组</span>' : spec.secret ? '<span class="config-control-note">保留遮罩以保持原值；留空后保存将清除</span>' : ""}<p id="${id}-error" class="config-field-error" ${error ? "" : "hidden"}>${escapeHtml(error)}</p></div></div>`;
}

function changeConfig(key, value) {
  const item = state.configItems.find((entry) => entry.key === key) || { key, value: "" };
  if (!state.configAdded.has(key) && MimoConfigUI.equivalent(item, value, state.configOriginal.get(key))) state.configChanges.delete(key);
  else state.configChanges.set(key, value);
  updateSaveBar();
}

function updateSaveBar() {
  $("#save-bar").classList.toggle("show", state.configChanges.size > 0);
  const errors = [...state.configChanges].filter(([key, value]) => {
    const item = state.configItems.find((entry) => entry.key === key) || { key, value: "" };
    return Boolean(MimoConfigUI.validate(item, value));
  });
  $("#config-save-status").textContent = errors.length
    ? `${errors.length} 项需要修正 · 修改尚未保存`
    : `${state.configChanges.size} 项待保存 · 重启后生效`;
  $("#save-config").disabled = errors.length > 0;
}

async function saveConfig() {
  if (!state.configChanges.size) return;
  for (const [key, value] of state.configChanges) {
    const item = state.configItems.find((entry) => entry.key === key) || { key, value: "" };
    const error = MimoConfigUI.validate(item, value);
    if (error) { toast(`${key}：${error}`, "error"); return; }
  }
  const button = $("#save-config");
  button.disabled = true;
  try {
    await api("/config", { method: "PUT", body: JSON.stringify({ values: Object.fromEntries(state.configChanges) }) });
    toast("配置已保存，重启 NoneBot 后生效", "warning");
    state.configChanges.clear();
    state.configAdded.clear();
    await loadConfig();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function discardConfig() {
  state.configItems = state.configItems.filter((item) => !state.configAdded.has(item.key));
  state.configAdded.forEach((key) => state.configOriginal.delete(key));
  state.configAdded.clear();
  state.configChanges.clear();
  renderConfig();
  updateSaveBar();
}

function showModal(show) {
  $("#modal").classList.toggle("hidden", !show);
  $("#modal-error").textContent = "";
  if (show) {
    $("#config-preset").innerHTML = '<option value="">自定义配置</option>' + Object.entries(MimoConfigUI.fields)
      .filter(([key]) => !state.configItems.some((item) => item.key === key))
      .map(([key, spec]) => `<option value="${escapeHtml(key)}">${escapeHtml(spec.label)} · ${escapeHtml(key)}</option>`).join("");
    $("#config-preset").onchange = () => {
      const key = $("#config-preset").value;
      const spec = MimoConfigUI.fields[key];
      $("#new-config-key").value = key;
      $("#new-config-value").value = spec?.initial || "";
      $("#config-preset-hint").textContent = spec?.hint || "仅添加组件实际支持的配置字段；添加后仍需保存才会写入文件。";
      $("#modal-error").textContent = "";
    };
    $("#config-preset-hint").textContent = "仅添加组件实际支持的配置字段；添加后仍需保存才会写入文件。";
    $("#new-config-key").value = "";
    $("#new-config-value").value = "";
    $("#new-config-key").focus();
  }
}

function addConfig() {
  const key = $("#new-config-key").value.trim().toUpperCase();
  const value = $("#new-config-value").value;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    $("#modal-error").textContent = "配置键只能使用大写字母、数字和下划线";
    return;
  }
  if (state.configItems.some((item) => item.key === key)) {
    $("#modal-error").textContent = "这个配置已经存在";
    return;
  }
  const spec = MimoConfigUI.fields[key];
  const newItem = { key, value, secret: Boolean(spec?.secret || /TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|API_KEY|ACCESS_KEY|CREDENTIAL|AUTHORIZATION|_BOTS$/.test(key)) };
  const error = MimoConfigUI.validate(newItem, value);
  if (error) { $("#modal-error").textContent = error; return; }
  state.configItems.push({
    key,
    value,
    secret: newItem.secret,
  });
  state.configOriginal.set(key, "");
  state.configChanges.set(key, value);
  state.configAdded.add(key);
  state.configCategory = "全部设置";
  $("#config-search").value = "";
  showModal(false);
  renderConfig();
  updateSaveBar();
}

async function loadLogs() {
  if (!state.token) return;
  try {
    const data = await api(`/logs?after=${state.logAfter}&limit=500`);
    if (data.items?.length) {
      state.logs.push(...data.items);
      if (state.logs.length > 1000) state.logs.splice(0, state.logs.length - 1000);
      state.logAfter = Math.max(state.logAfter, ...data.items.map((item) => item.id));
      renderRecentLogs();
      if (state.page === "logs") renderLogs();
    }
  } catch (_) { /* quiet poll errors */ }
}

function renderRecentLogs() {
  const items = state.logs.slice(-5).reverse();
  $("#recent-logs").innerHTML = items.length
    ? items.map((item) =>
      `<div class="recent-line"><time>${new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}</time><span class="level ${escapeHtml(item.level)}">${escapeHtml(item.level)}</span><p>${escapeHtml(item.message)}</p></div>`,
    ).join("")
    : '<div class="empty-text">正在等待日志…</div>';
}

function setLogLevelSelectOpen(open, focusOption = false) {
  const root = $("#log-level-select");
  const trigger = $("#log-level-trigger");
  const menu = $("#log-level-menu");
  root.classList.toggle("open", open);
  menu.classList.toggle("hidden", !open);
  trigger.setAttribute("aria-expanded", String(open));
  if (open && focusOption) {
    const selected = $('.custom-select-option[aria-selected="true"]', menu);
    (selected || $(".custom-select-option", menu))?.focus();
  }
}

function selectLogLevel(value, { focusTrigger = true } = {}) {
  const option = $(`.custom-select-option[data-value="${CSS.escape(value)}"]`, $("#log-level-menu"));
  if (!option) return;
  state.logLevel = value;
  $("#log-level-label").textContent = option.textContent.trim();
  $$(".custom-select-option", $("#log-level-menu")).forEach((item) => {
    const active = item === option;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
  setLogLevelSelectOpen(false);
  if (focusTrigger) $("#log-level-trigger").focus();
  renderLogs();
}

function bindLogLevelSelect() {
  const root = $("#log-level-select");
  const trigger = $("#log-level-trigger");
  const menu = $("#log-level-menu");
  const options = $$(".custom-select-option", menu);

  trigger.addEventListener("click", () => {
    setLogLevelSelectOpen(!root.classList.contains("open"), true);
  });
  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    setLogLevelSelectOpen(true, true);
  });
  options.forEach((option) => {
    option.addEventListener("click", () => selectLogLevel(option.dataset.value));
    option.addEventListener("keydown", (event) => {
      const index = options.indexOf(option);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const offset = event.key === "ArrowDown" ? 1 : -1;
        options[(index + offset + options.length) % options.length].focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        options[event.key === "Home" ? 0 : options.length - 1].focus();
      } else if (event.key === "Escape" || event.key === "Tab") {
        setLogLevelSelectOpen(false);
        if (event.key === "Escape") {
          event.preventDefault();
          trigger.focus();
        }
      }
    });
  });
  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) setLogLevelSelectOpen(false);
  });
}

function renderLogs() {
  const query = $("#log-search").value.trim().toLowerCase();
  const level = state.logLevel;
  const items = state.logs.filter((item) =>
    (level === "ALL" || item.level === level)
    && [item.message, item.module].join(" ").toLowerCase().includes(query),
  );
  $("#log-count").textContent = `${items.length} 条`;
  $("#log-lines").innerHTML = items.length
    ? items.map((item) =>
      `<div class="log-line ${escapeHtml(item.level)}"><time>${new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}</time><span class="level ${escapeHtml(item.level)}">${escapeHtml(item.level)}</span><span class="module">${escapeHtml(item.module || "nonebot")}</span><p>${escapeHtml(item.message)}</p></div>`,
    ).join("")
    : '<div class="empty-state">暂时没有日志</div>';
  if (state.logFollow) requestAnimationFrame(scrollLogs);
}

function scrollLogs() {
  const box = $("#log-lines");
  box.scrollTop = box.scrollHeight;
}

async function clearLogs() {
  try {
    await api("/logs", { method: "DELETE" });
    state.logs = [];
    state.logAfter = 0;
    renderLogs();
    renderRecentLogs();
    toast("日志视图已清空");
  } catch (error) {
    toast(error.message, "error");
  }
}

const VISUAL_STORAGE_KEY = "mimo-console-visual";
const VISUAL_DEFAULTS = { blur: 0, opacity: 92 };
const BG_URL_AUTO_SAVE_DELAY = 900;
let bgUrlSaveTimer = null;
let bgUrlRevision = 0;
// Serialize background mutations so a DELETE can never land on the server before
// an in-flight PUT it was meant to supersede (strict last-write-wins on the wire).
let bgMutationChain = Promise.resolve();

function queueBgMutation(task) {
  const run = bgMutationChain.then(task, task);
  // Keep the chain alive even if a task rejects.
  bgMutationChain = run.catch(() => {});
  return run;
}

function resolveBgUrl(data) {
  const source = (data && data.source) || "none";
  const url = (data && data.url) || "";
  return (source === "url" || source === "upload") && url ? url : "";
}

function loadVisualSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(VISUAL_STORAGE_KEY) || "{}");
    return {
      blur: Math.min(24, Math.max(0, Number(raw.blur) || 0)),
      opacity: Math.min(100, Math.max(50, Number(raw.opacity) || VISUAL_DEFAULTS.opacity)),
    };
  } catch (_) {
    return { ...VISUAL_DEFAULTS };
  }
}

function applyVisualSettings(settings, save = false) {
  const root = document.documentElement;
  const blur = Math.min(24, Math.max(0, Number(settings.blur) || 0));
  const opacity = Math.min(100, Math.max(50, Number(settings.opacity) || VISUAL_DEFAULTS.opacity));
  const controlOpacity = Math.max(28, opacity - 22);
  const insetOpacity = Math.max(18, opacity - 36);
  root.style.setProperty("--blur-intensity", `${blur}px`);
  root.style.setProperty("--card-opacity", `${opacity}%`);
  root.style.setProperty("--control-opacity", `${controlOpacity}%`);
  root.style.setProperty("--inset-opacity", `${insetOpacity}%`);
  const blurInput = $("#bg-blur-input");
  const opacityInput = $("#card-opacity-input");
  if (blurInput) blurInput.value = String(blur);
  if (opacityInput) opacityInput.value = String(opacity);
  const blurValue = $("#bg-blur-value");
  const opacityValue = $("#card-opacity-value");
  if (blurValue) blurValue.textContent = `${blur} px`;
  if (opacityValue) opacityValue.textContent = `${opacity}%`;
  if (save) {
    try { localStorage.setItem(VISUAL_STORAGE_KEY, JSON.stringify({ blur, opacity })); } catch (_) { /* ignore */ }
  }
}

function updateVisualSettings() {
  applyVisualSettings({
    blur: $("#bg-blur-input").value,
    opacity: $("#card-opacity-input").value,
  }, true);
}

const THEME_STORAGE_KEY = "mimo-console-theme";
const THEME_DEFAULTS = { mode: "light", accent: "" };
let systemThemeMedia = null;

function loadThemeLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) || "{}");
    return {
      mode: ["light", "dark", "system"].includes(raw.mode) ? raw.mode : THEME_DEFAULTS.mode,
      accent: /^#[0-9a-fA-F]{6}$/.test(raw.accent || "") ? raw.accent.toLowerCase() : "",
    };
  } catch (_) {
    return { ...THEME_DEFAULTS };
  }
}

function saveThemeLocal(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch (_) { /* 存储不可用时仅本次会话生效 */ }
}

function systemDarkMedia() {
  if (!systemThemeMedia) systemThemeMedia = matchMedia("(prefers-color-scheme: dark)");
  return systemThemeMedia;
}

function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function applyTheme(theme) {
  state.theme = theme;
  const root = document.documentElement;
  const dark = theme.mode === "dark" || (theme.mode === "system" && systemDarkMedia().matches);
  if (dark) root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  if (theme.accent) {
    root.style.setProperty("--accent", theme.accent);
    const hsl = hexToHsl(theme.accent);
    const hoverL = Math.max(0, hsl.l - 8);
    root.style.setProperty("--accent-hover", `hsl(${hsl.h}, ${hsl.s}%, ${hoverL}%)`);
    root.style.setProperty("--accent-soft", `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${dark ? 0.12 : 0.08})`);
    root.style.setProperty("--accent-line", `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${dark ? 0.28 : 0.22})`);
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-hover");
    root.style.removeProperty("--accent-soft");
    root.style.removeProperty("--accent-line");
  }
  if (theme.mode === "system" && !systemDarkMedia()._mimoBound) {
    systemDarkMedia()._mimoBound = true;
    systemDarkMedia().addEventListener("change", () => applyTheme(state.theme || loadThemeLocal()));
  }
  if (state.page === "appearance") updateThemeUi(theme);
}

function changeTheme(patch) {
  const next = { ...(state.theme || loadThemeLocal()), ...patch };
  applyTheme(next);
  saveThemeLocal(next);
}

function resetTheme() {
  applyTheme({ ...THEME_DEFAULTS });
  saveThemeLocal(state.theme);
  toast("已恢复默认主题");
}

function updateThemeUi(theme) {
  const radio = $(`#theme-mode-${theme.mode}`);
  if (radio) radio.checked = true;
  $$(".swatch[data-accent]").forEach((swatch) => {
    swatch.classList.toggle("active", swatch.dataset.accent === theme.accent);
  });
  const custom = $(".swatch.custom");
  const isCustom = !!theme.accent && !$$(".swatch[data-accent]").some((swatch) => swatch.dataset.accent === theme.accent);
  if (custom) {
    custom.classList.toggle("active", isCustom);
    custom.style.background = isCustom ? theme.accent : "";
  }
  const colorInput = $("#accent-custom-input");
  if (colorInput && theme.accent) colorInput.value = theme.accent;
}

function applyBackground(payload) {
  const data = payload && ["none", "url", "upload"].includes(payload.source)
    ? payload
    : { source: "none", url: "" };
  const bgUrl = resolveBgUrl(data);
  state.background = data;
  document.documentElement.classList.toggle("has-custom-bg", Boolean(bgUrl));
  const layer = $("#bg-layer");
  if (layer) layer.style.backgroundImage = bgUrl ? `url("${bgUrl}")` : "none";
  if (state.page === "appearance") updateAppearanceUi(data);
}

async function loadBackground() {
  try {
    applyBackground(await api("/background"));
  } catch (_) {
    applyBackground({ source: "none", url: "" });
  }
}

function refreshAppearance() {
  renderBrandingEditor();
  updateAppearanceUi(state.background);
  updateThemeUi(state.theme || loadThemeLocal());
  applyVisualSettings(loadVisualSettings());
}

function brandingHasChanges() {
  const draft = state.brandingDraft;
  return Boolean(draft && (draft.title.trim() !== state.branding.title || draft.icon_action !== "keep"));
}

function brandingIconUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value), location.origin);
    const prefix = `${rootPath}/api/branding/icon/`;
    return url.origin === location.origin && url.pathname.startsWith(prefix)
      && /^[0-9a-f]{32}\.(png|jpg|gif|webp|ico)$/.test(url.pathname.slice(prefix.length))
      ? url.pathname : "";
  } catch (_) { return ""; }
}

function renderBrandImage(image, initial, url, letter) {
  initial.textContent = letter;
  initial.hidden = Boolean(url);
  image.hidden = !url;
  image.onerror = () => { image.hidden = true; initial.hidden = false; };
  if (url) {
    if (image.getAttribute("src") !== url) image.src = url;
  } else image.removeAttribute("src");
}

function applyBranding(payload) {
  const title = String(payload.title || BRANDING_DEFAULT_TITLE);
  const icon = brandingIconUrl(payload.icon_url);
  const letter = Array.from(title.trim())[0]?.toUpperCase() || "M";
  state.branding = { title, icon_url: icon };
  document.title = title;
  $("#auth-brand-title").textContent = title;
  $("#sidebar-brand-title").textContent = title === BRANDING_DEFAULT_TITLE ? "Mimo" : title;
  $("#sidebar-brand-title").title = title;
  $("#sidebar-brand-caption").textContent = title === BRANDING_DEFAULT_TITLE ? "Console" : "NoneBot 管理面板";
  $$("[data-brand-icon]").forEach((image) => renderBrandImage(
    image, image.parentElement.querySelector("[data-brand-initial]"), icon, letter,
  ));
  $("#console-favicon").href = icon || `${rootPath}/assets/favicon.svg`;
}

async function loadBranding() {
  try {
    const payload = await api("/branding");
    applyBranding(payload);
    state.brandingLoaded = true;
    state.brandingDraft = { title: state.branding.title, icon_action: "keep", icon_data_url: "", icon_name: "" };
    state.brandingError = "";
  } catch (_) {
    state.brandingError = "无法读取站点标识，请刷新页面后重试。";
  }
  renderBrandingEditor();
}

function renderBrandingEditor() {
  const draft = state.brandingDraft || { title: state.branding.title, icon_action: "keep", icon_data_url: "" };
  const title = draft.title.trim() || BRANDING_DEFAULT_TITLE;
  const letter = Array.from(title)[0]?.toUpperCase() || "M";
  const icon = draft.icon_action === "replace" ? draft.icon_data_url : draft.icon_action === "remove" ? "" : state.branding.icon_url;
  $("#branding-preview-title").textContent = title;
  $("#branding-tab-title").textContent = title;
  renderBrandImage($("#branding-preview-icon"), $("#branding-preview-initial"), icon, letter);
  renderBrandImage($("#branding-tab-icon"), $("#branding-tab-initial"), icon, letter);
  const input = $("#branding-title");
  if (document.activeElement !== input) input.value = draft.title;
  $("#branding-title-count").textContent = `${Array.from(draft.title).length} / 80`;
  const invalid = !draft.title.trim() || /[\u0000-\u001f\u007f]/.test(draft.title);
  input.setAttribute("aria-invalid", String(invalid));
  input.disabled = !state.brandingLoaded || state.brandingBusy;
  $("#branding-icon-status").textContent = state.brandingReading ? "正在读取图片…" : draft.icon_name || (icon ? "已设置自定义图标" : "使用默认图标");
  $("#branding-remove").disabled = !icon || state.brandingBusy;
  $("#branding-upload").disabled = !state.brandingLoaded || state.brandingBusy;
  $("#branding-reset").disabled = !state.brandingLoaded || state.brandingBusy;
  $("#branding-save").disabled = !state.brandingLoaded || state.brandingBusy || state.brandingReading || invalid || !brandingHasChanges();
  $("#branding-save").textContent = state.brandingBusy ? "正在保存…" : "保存站点标识";
  $("#branding-form").setAttribute("aria-busy", String(state.brandingBusy || state.brandingReading));
  $("#branding-save-status").textContent = !state.brandingLoaded ? "尚未读取设置" : state.brandingReading ? "正在读取图标" : brandingHasChanges() ? "预览尚未保存" : "已与服务器同步";
  const titleError = invalid ? "请填写有效的站点标题，不能包含换行或控制字符。" : "";
  $("#branding-error").textContent = state.brandingError || titleError;
  $("#branding-error").hidden = !(state.brandingError || titleError);
}

async function selectBrandingIcon(input) {
  const file = input.files?.[0];
  if (!file || !state.brandingDraft || state.brandingBusy) return;
  const revision = ++state.brandingReadId;
  state.brandingError = "";
  state.brandingReading = true;
  renderBrandingEditor();
  try {
    const types = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", ico: "image/x-icon" };
    const mime = types[file.name.split(".").pop().toLowerCase()];
    if (!mime) throw new Error("请选择 PNG、JPG、WebP、GIF 或 ICO 图片。");
    if (!file.size || file.size > 2 * 1024 * 1024) throw new Error("图标不能为空，大小不能超过 2MB。");
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("无法读取图片，请重新选择。"));
      reader.readAsDataURL(file);
    });
    const url = `data:${mime};base64,${String(data).split(",")[1]}`;
    const image = new Image();
    image.src = url;
    try { await image.decode(); } catch (_) { throw new Error("无法打开这张图片，请换一张有效图标。"); }
    if (revision !== state.brandingReadId) return;
    Object.assign(state.brandingDraft, { icon_action: "replace", icon_data_url: url, icon_name: file.name });
  } catch (error) {
    if (revision === state.brandingReadId) state.brandingError = error.message;
  } finally {
    input.value = "";
    if (revision === state.brandingReadId) { state.brandingReading = false; renderBrandingEditor(); }
  }
}

async function persistBranding(payload) {
  state.brandingBusy = true;
  state.brandingError = "";
  renderBrandingEditor();
  try {
    applyBranding(await api("/branding", { method: "PUT", body: JSON.stringify(payload) }));
    state.brandingDraft = { title: state.branding.title, icon_action: "keep", icon_data_url: "", icon_name: "" };
    toast("站点标识已保存，无需重启");
  } catch (error) {
    state.brandingError = error.message;
  } finally {
    state.brandingBusy = false;
    renderBrandingEditor();
  }
}

function updateAppearanceUi(data) {
  const source = data.source || "none";
  const radio = $(`#bg-mode-${source}`);
  if (radio) radio.checked = true;
  switchBgMode(source);
  const urlInput = $("#bg-url-input");
  if (urlInput && source === "url" && data.url) {
    urlInput.value = data.remote_url || data.url;
  }
  const urlStatus = $("#bg-url-status");
  if (urlStatus && source === "url" && data.url) {
    urlStatus.textContent = "当前图片已自动下载并应用";
    urlStatus.dataset.tone = "success";
  }
}

function switchBgMode(mode) {
  $("#bg-url-field").classList.toggle("hidden", mode !== "url");
  $("#bg-upload-field").classList.toggle("hidden", mode !== "upload");
}

async function selectBackgroundMode(mode) {
  switchBgMode(mode);
  // Invalidate any pending URL download so a queued/in-flight PUT cannot write a
  // background back after the user switches away. saveBgUrl checks bgUrlRevision.
  clearTimeout(bgUrlSaveTimer);
  bgUrlRevision += 1;
  if (mode !== "none") return;
  const radios = $$("input[name='bg-mode']");
  radios.forEach((radio) => { radio.disabled = true; });
  try {
    applyBackground(await queueBgMutation(() => api("/background", { method: "DELETE" })));
    $("#bg-url-input").value = "";
    toast("背景已清除");
  } catch (error) {
    updateAppearanceUi(state.background);
    toast(error.message, "error");
  } finally {
    radios.forEach((radio) => { radio.disabled = false; });
  }
}

function setBgUrlStatus(message, tone = "") {
  const status = $("#bg-url-status");
  if (!status) return;
  status.textContent = message;
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
}

function normalizeAutoBackgroundUrl(value) {
  try {
    const parsed = new URL((value || "").trim());
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname
      ? parsed.toString()
      : "";
  } catch (_) {
    return "";
  }
}

function queueBgUrlSave(input, immediate = false) {
  bgUrlRevision += 1;
  const revision = bgUrlRevision;
  clearTimeout(bgUrlSaveTimer);
  const raw = (input.value || "").trim();
  if (!raw) {
    setBgUrlStatus("输入完成后将自动下载并应用图片");
    return;
  }
  const url = normalizeAutoBackgroundUrl(raw);
  if (!url) {
    setBgUrlStatus("请输入完整的 http/https 图片地址");
    return;
  }
  setBgUrlStatus(immediate ? "正在下载图片…" : "等待输入完成…");
  bgUrlSaveTimer = setTimeout(
    () => saveBgUrl(url, revision),
    immediate ? 0 : BG_URL_AUTO_SAVE_DELAY,
  );
}

async function saveBgUrl(url, revision) {
  const input = $("#bg-url-input");
  input.setAttribute("aria-busy", "true");
  setBgUrlStatus("正在下载图片…");
  try {
    const payload = await queueBgMutation(() =>
      api("/background", {
        method: "PUT",
        body: JSON.stringify({ url }),
      }),
    );
    if (revision !== bgUrlRevision) return;
    applyBackground(payload);
    setBgUrlStatus("图片已自动下载并应用", "success");
  } catch (error) {
    if (revision !== bgUrlRevision) return;
    setBgUrlStatus(error.message, "error");
  } finally {
    if (revision === bgUrlRevision) input.removeAttribute("aria-busy");
  }
}

async function uploadBgFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    toast("图片不能超过 5MB", "error");
    input.value = "";
    return;
  }
  const label = $("#bg-file-label");
  const strong = label.querySelector("strong");
  const original = strong.textContent;
  strong.textContent = "上传中…";
  label.disabled = true;
  // Cancel any pending URL download so it cannot overwrite the upload afterwards.
  clearTimeout(bgUrlSaveTimer);
  bgUrlRevision += 1;
  try {
    const form = new FormData();
    form.append("file", file);
    applyBackground(
      await queueBgMutation(() => api("/background/upload", { method: "POST", body: form })),
    );
    toast("背景已更新");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    strong.textContent = original;
    label.disabled = false;
    input.value = "";
  }
}

async function loadVersion() {
  try {
    state.version = await api("/system/version");
    renderVersion(state.version);
  } catch (_) { /* 版本检测失败不影响使用 */ }
}

function renderVersion(data) {
  $("#version-current").textContent = data.current ? `v${data.current}` : "--";
}

function pluginConfigKeys(item) {
  const declared = new Set((item.config_keys || []).map((key) => String(key).toUpperCase()));
  if (declared.size) return declared;
  const module = String(item.module || item.name || "").replace(/^nonebot_plugin_/, "");
  const prefix = `${module.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_`;
  state.configItems.forEach((config) => {
    if (config.key.startsWith(prefix)) declared.add(config.key);
  });
  return declared;
}

function detailConfigItemHtml(item) {
  return `<div class="detail-config-item">
    <div class="config-key">
      <strong>${escapeHtml(item.key)}</strong>
      <span>${item.secret ? "敏感配置 · 留空可清除" : "环境变量"}</span>
    </div>
    <div class="config-input-wrap">
      <input class="config-input detail-config-input" data-key="${escapeHtml(item.key)}" type="${item.secret ? "password" : "text"}" value="${escapeHtml(item.value)}">
      ${item.secret ? `<button class="secret-toggle detail-secret-toggle" data-key="${escapeHtml(item.key)}" type="button">显示</button>` : ""}
    </div>
  </div>`;
}

function renderDetailPluginConfig(plugin) {
  const target = $("#detail-plugin-config");
  if (!target) return;
  const keys = pluginConfigKeys(plugin);
  const existing = new Map(state.configItems.map((item) => [item.key, item]));
  const items = [...keys]
    .sort()
    .map((key) => existing.get(key) || {
      key,
      value: "",
      secret: /(TOKEN|SECRET|PASSWORD|COOKIE|API_KEY|ACCESS_KEY)/u.test(key),
    });
  const prefix = String(plugin.module || plugin.name || "")
    .replace(/^nonebot_plugin_/, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
  target.innerHTML = `
    <div class="detail-section-head">
      <div><h3>插件配置</h3><p>保存后需要重启 NoneBot 才会生效</p></div>
      <span class="badge">${items.length} 项</span>
    </div>
    ${items.length
      ? `<div class="detail-config-list">${items.map(detailConfigItemHtml).join("")}</div>
         <div class="detail-config-actions">
           <span id="detail-config-status" class="text-muted">配置前缀：${escapeHtml(prefix)}_</span>
           <button id="detail-config-save" class="btn btn-primary btn-sm" type="button" disabled>保存插件配置</button>
         </div>`
      : `<div class="empty-state compact">暂未发现该插件声明的环境变量配置</div>`}
  `;
  const changed = new Map();
  $$(".detail-config-input", target).forEach((input) => {
    input.addEventListener("input", () => {
      const original = state.configOriginal.get(input.dataset.key);
      if (input.value === original) changed.delete(input.dataset.key);
      else changed.set(input.dataset.key, input.value);
      $("#detail-config-save").disabled = changed.size === 0;
    });
  });
  $$(".detail-secret-toggle", target).forEach((button) => {
    button.addEventListener("click", () => {
      const input = $(`.detail-config-input[data-key="${CSS.escape(button.dataset.key)}"]`, target);
      input.type = input.type === "password" ? "text" : "password";
      button.textContent = input.type === "password" ? "显示" : "隐藏";
    });
  });
  const save = $("#detail-config-save");
  if (save) save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api("/config", {
        method: "PUT",
        body: JSON.stringify({ values: Object.fromEntries(changed) }),
      });
      toast("插件配置已保存，重启 NoneBot 后生效", "warning");
      await fetchConfigData({ preserveChanges: true });
      if (state.detailPlugin === plugin) renderDetailPluginConfig(plugin);
    } catch (error) {
      toast(error.message, "error");
      save.disabled = false;
    }
  });
}

const PROXY_CUSTOM_VALUE = "__custom__";
const PROXY_DIRECT_KEY = "__direct__";
const PROXY_TEST_CONCURRENCY = 2;

function presetLabel(url) {
  return url.includes("cnb.cool") ? "CNB 镜像仓库" : "GitHub 加速代理";
}

async function loadProxySettings() {
  try {
    const data = await api("/system/github-proxy");
    state.proxy = {
      ...state.proxy,
      ...data,
      tests: state.proxy.tests || {},
      testing: false,
    };
    renderProxySettings();
  } catch (_) { /* 读取失败不影响使用 */ }
}

function proxyTestKey(value) {
  return value || PROXY_DIRECT_KEY;
}

function proxyTestView(value) {
  const result = state.proxy.tests?.[proxyTestKey(value)];
  if (!result) return { status: "untested", label: "—", detail: "尚未测试" };
  if (result.status === "waiting") return { ...result, label: "等待中" };
  if (result.status === "testing") return { ...result, label: "测试中…" };
  if (result.status === "success") {
    return { ...result, label: `${result.latency_ms} ms` };
  }
  if (result.status === "timeout") return { ...result, label: "超时" };
  return { ...result, label: "失败" };
}

function proxyLatencyHtml(value) {
  const view = proxyTestView(value);
  return `<span class="proxy-latency" data-status="${escapeHtml(view.status)}" title="${escapeHtml(view.detail || view.label)}">${escapeHtml(view.label)}</span>`;
}

function updateProxyLatency(value) {
  const key = proxyTestKey(value);
  const element = $(`.proxy-latency[data-proxy-key="${CSS.escape(key)}"]`);
  if (!element) return;
  const view = proxyTestView(value);
  element.dataset.status = view.status;
  element.textContent = view.label;
  element.title = view.detail || view.label;
}

function renderProxySettings() {
  const container = $("#proxy-modes");
  if (!container) return;
  const presets = state.proxy.presets || [];
  const current = state.proxy.proxy || "";
  const mode = current === "" ? "" : presets.includes(current) ? current : PROXY_CUSTOM_VALUE;
  const options = [
    { value: "", title: "不使用 GitHub 加速", desc: "直连 GitHub" },
    ...presets.map((url) => ({ value: url, title: url, desc: presetLabel(url) })),
    { value: PROXY_CUSTOM_VALUE, title: "自定义", desc: "填入自定义加速前缀或镜像仓库地址" },
  ];
  container.innerHTML = options
    .map(
      (opt) => {
        const testValue = opt.value === PROXY_CUSTOM_VALUE
          ? (mode === PROXY_CUSTOM_VALUE ? current : "")
          : opt.value;
        const testKey = opt.value === PROXY_CUSTOM_VALUE && !testValue
          ? PROXY_CUSTOM_VALUE
          : proxyTestKey(testValue);
        const latency = opt.value === PROXY_CUSTOM_VALUE && !testValue
          ? '<span class="proxy-latency" data-status="untested" title="填写地址后参与测试">—</span>'
          : proxyLatencyHtml(testValue);
        return `<label class="radio-option proxy-option">
        <input type="radio" name="gh-proxy" value="${escapeHtml(opt.value)}"${opt.value === "" ? " data-proxy-off" : ""}>
        <div><strong>${escapeHtml(opt.title)}</strong><small>${escapeHtml(opt.desc)}</small></div>
        ${latency.replace('class="proxy-latency"', `class="proxy-latency" data-proxy-key="${escapeHtml(testKey)}"`)}
      </label>`;
      },
    )
    .join("");
  $$('input[name="gh-proxy"]', container).forEach((input) => {
    input.checked = input.value === mode;
  });
  $("#proxy-custom-field").classList.toggle("hidden", mode !== PROXY_CUSTOM_VALUE);
  if (mode === PROXY_CUSTOM_VALUE) $("#proxy-custom-input").value = current;
  container.onchange = () => {
    const checked = $('input[name="gh-proxy"]:checked', container);
    $("#proxy-custom-field").classList.toggle(
      "hidden",
      !checked || checked.value !== PROXY_CUSTOM_VALUE,
    );
  };
  const customInput = $("#proxy-custom-input");
  customInput.dataset.testKey = mode === PROXY_CUSTOM_VALUE && current
    ? proxyTestKey(current)
    : "";
  customInput.oninput = () => {
    const previousKey = customInput.dataset.testKey;
    if (previousKey) delete state.proxy.tests[previousKey];
    const value = customInput.value.trim();
    const nextKey = value ? proxyTestKey(value) : PROXY_CUSTOM_VALUE;
    customInput.dataset.testKey = value ? nextKey : "";
    const customOption = $('input[name="gh-proxy"][value="__custom__"]', container)?.closest(".proxy-option");
    const customLatency = $(".proxy-latency", customOption);
    if (customLatency) {
      customLatency.dataset.proxyKey = nextKey;
      customLatency.dataset.status = "untested";
      customLatency.textContent = "—";
      customLatency.title = value ? "尚未测试" : "填写地址后参与测试";
    }
  };
}

function selectedProxyValue() {
  const checked = $('input[name="gh-proxy"]:checked');
  if (!checked) return "";
  if (checked.value === PROXY_CUSTOM_VALUE) return ($("#proxy-custom-input").value || "").trim();
  return checked.value;
}

async function saveProxySettings() {
  const button = $("#proxy-save");
  button.disabled = true;
  try {
    const data = await api("/system/github-proxy", {
      method: "PUT",
      body: JSON.stringify({ proxy: selectedProxyValue() }),
    });
    state.proxy.proxy = data.proxy || "";
    renderProxySettings();
    toast("GitHub 加速设置已保存，立即生效");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function testProxySettings() {
  const button = $("#proxy-test-btn");
  const original = button.textContent;
  const custom = ($("#proxy-custom-input").value || "").trim();
  const values = ["", ...(state.proxy.presets || []), ...(custom ? [custom] : [])];
  const targets = [...new Set(values)];
  const runId = (state.proxy.testRunId || 0) + 1;
  state.proxy.testRunId = runId;
  state.proxy.testing = true;
  state.proxy.tests = Object.fromEntries(targets.map((value) => [
    proxyTestKey(value),
    { status: "waiting", latency_ms: null, detail: "等待测试" },
  ]));
  const customOption = $('input[name="gh-proxy"][value="__custom__"]')?.closest(".proxy-option");
  const customLatency = $(".proxy-latency", customOption);
  if (custom && customLatency) customLatency.dataset.proxyKey = proxyTestKey(custom);
  targets.forEach(updateProxyLatency);
  button.disabled = true;
  button.textContent = `测试中 0/${targets.length}`;
  let completed = 0;
  let cursor = 0;
  try {
    async function worker() {
      while (cursor < targets.length) {
        const index = cursor;
        cursor += 1;
        const value = targets[index];
        const key = proxyTestKey(value);
        if (state.proxy.testRunId !== runId) return;
        state.proxy.tests[key] = { status: "testing", latency_ms: null, detail: "正在测试" };
        updateProxyLatency(value);
        try {
          const data = await api("/system/github-proxy/test", {
            method: "POST",
            body: JSON.stringify({ proxy: value }),
          });
          if (state.proxy.testRunId !== runId) return;
          state.proxy.tests[key] = {
            status: data.status || (data.ok ? "success" : "failed"),
            latency_ms: data.latency_ms,
            detail: data.detail || (data.ok ? "连接正常" : "连接失败"),
          };
        } catch (error) {
          if (state.proxy.testRunId !== runId) return;
          state.proxy.tests[key] = {
            status: "failed",
            latency_ms: null,
            detail: error.message || "连接失败",
          };
        }
        updateProxyLatency(value);
        completed += 1;
        button.textContent = `测试中 ${completed}/${targets.length}`;
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(PROXY_TEST_CONCURRENCY, targets.length) }, () => worker()),
    );
    if (state.proxy.testRunId !== runId) return;
    const results = Object.values(state.proxy.tests);
    const success = results.filter((result) => result.status === "success").length;
    const timeout = results.filter((result) => result.status === "timeout").length;
    const failed = results.length - success - timeout;
    const summary = [`${success} 个可用`];
    if (timeout) summary.push(`${timeout} 个超时`);
    if (failed) summary.push(`${failed} 个失败`);
    toast(`连通性测试完成：${summary.join("，")}`, failed || timeout ? "warning" : "success");
  } finally {
    if (state.proxy.testRunId === runId) {
      state.proxy.testing = false;
      button.disabled = false;
      button.textContent = original;
    }
  }
}

async function checkUpdate(button = $("#check-update-btn")) {
  if (state.selfUpdateBusy) return;
  state.selfUpdateBusy = true;
  const original = button.textContent;
  const buttons = [$("#check-update-btn"), ...$$("[data-console-self-update]")].filter(Boolean);
  buttons.forEach((item) => { item.disabled = true; });
  button.textContent = "检测中…";
  try {
    const data = await api("/system/version?force=true");
    state.version = data;
    renderVersion(data);
    if (data.has_update && data.latest) {
      if (!state.packageManagement) {
        toast(`检测到 v${data.latest}，当前配置已关闭包管理功能`, "warning");
        return;
      }
      const self = state.plugins.find((item) => item.module === "nonebot_plugin_mimo_console");
      const localNotice = self && (self.local_git_path || (!self.update_supported && !self.source_repository))
        ? "\n当前使用本地源码，更新会切换到官方上游安装；请先保存本地定制。" : "";
      const ok = window.confirm(
        `检测到新版本 v${data.latest}（当前 v${data.current || "?"}），是否立即更新？\n将通过当前项目包管理器拉取 GitHub 最新版，完成后自动重启 NoneBot。${localNotice}`,
      );
      if (ok) await runUpdate(button);
    } else if (data.latest) {
      toast(`已是最新版本 v${data.current}`);
    } else {
      toast("GitHub 暂无发布版本，无法检测更新", "error");
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.selfUpdateBusy = false;
    buttons.forEach((item) => { item.disabled = false; });
    $$("[data-console-self-update]").forEach((item) => { item.disabled = false; });
    button.textContent = original;
  }
}

async function runUpdate(button = $("#check-update-btn")) {
  try {
    let result = await api("/system/update", { method: "POST" });
    if (result.status && !["succeeded", "failed", "rolled_back"].includes(result.status)) {
      result = await waitPackageOperation(result, button, "更新");
    }
    if (result.ok === false || ["failed", "rolled_back"].includes(result.status)) {
      throw new Error(result.error || "更新失败");
    }
    if (result.operation_id && !result.restart_required) {
      toast("Mimo Console 已更新并完成容器切换");
      location.reload();
      return;
    }
    if (result.restart_required) {
      const restart = await api("/system/restart", { method: "POST" });
      if (restart.operation_id) {
        const completed = await waitPackageOperation(restart, button, "重启");
        if (completed.status !== "succeeded") throw new Error(completed.error || "重启失败");
        location.reload();
        return;
      }
      toast("已更新，正在重启…", "warning");
      await pollRestart();
    } else {
      toast("Mimo Console 已更新");
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function restartNonebot() {
  const dockerMode = state.deployment.mode === "docker-agent";
  const detail = dockerMode
    ? "Mimo Agent 将重建当前服务并执行健康检查。"
    : "进程将退出，并由外部进程管理器重新拉起。未保存的操作会丢失。";
  if (!window.confirm(`确定重启 NoneBot？${detail}`)) return;
  const button = $("#restart-button");
  const original = button.innerHTML;
  button.disabled = true;
  try {
    const result = await api("/system/restart", { method: "POST" });
    if (result.operation_id) {
      const completed = await waitPackageOperation(result, null, "重启");
      if (completed.status !== "succeeded") {
        throw new Error(completed.error || "容器重启失败，已尝试恢复");
      }
      toast("NoneBot 容器已重启");
      location.reload();
      return;
    }
    toast("已发送重启信号，正在退出…", "warning");
    pollRestart();
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.innerHTML = original;
  }
}

async function pollRestart() {
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const response = await fetch(`${rootPath}/api/health`, {
        headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
      });
      if (response.ok) {
        toast("NoneBot 已重新上线");
        location.reload();
        return;
      }
    } catch (_) { /* 进程尚未拉起，继续等待 */ }
  }
  toast("重启后长时间未恢复，请手动检查进程与外部管理器", "error");
}

/* ===== Sanitized README HTML rendered by markdown-it-py ===== */
const README_ALLOWED_TAGS = new Set([
  "a", "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "code", "kbd",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td",
  "strong", "b", "em", "i", "s", "del",
  "img", "details", "summary", "sup", "sub", "div", "span",
]);

function readmeIntegerAttribute(value, minimum, maximum) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : 0;
}

function sanitizeReadmeHtml(markup, baseUrl = "") {
  const template = document.createElement("template");
  template.innerHTML = String(markup || "");
  template.content
    .querySelectorAll("script,style,iframe,object,embed,form,input,button,textarea,select,meta,link")
    .forEach((element) => element.remove());

  [...template.content.querySelectorAll("*")].forEach((element) => {
    const tag = element.tagName.toLowerCase();
    if (!README_ALLOWED_TAGS.has(tag)) {
      element.replaceWith(...element.childNodes);
      return;
    }

    const attributes = Object.fromEntries(
      [...element.attributes].map((attribute) => [attribute.name.toLowerCase(), attribute.value]),
    );
    [...element.attributes].forEach((attribute) => element.removeAttribute(attribute.name));

    const alignment = (
      attributes.align
      || attributes.style?.match(/text-align\s*:\s*(left|center|right)/i)?.[1]
      || ""
    ).toLowerCase();
    if (["left", "center", "right"].includes(alignment)) {
      element.classList.add(`readme-align-${alignment}`);
    }

    if (tag === "a") {
      const href = normalizeWebUrl(attributes.href, baseUrl);
      if (href) {
        element.setAttribute("href", href);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
      if (attributes.title) element.setAttribute("title", attributes.title.slice(0, 300));
    } else if (tag === "img") {
      const source = normalizeWebUrl(attributes.src, baseUrl);
      if (!source) {
        element.remove();
        return;
      }
      element.setAttribute("src", source);
      element.setAttribute("alt", (attributes.alt || "").slice(0, 300));
      element.setAttribute("loading", "lazy");
      element.setAttribute("referrerpolicy", "no-referrer");
      const width = readmeIntegerAttribute(attributes.width, 16, 1200);
      const height = readmeIntegerAttribute(attributes.height, 16, 1200);
      if (width) element.setAttribute("width", String(width));
      if (height) element.setAttribute("height", String(height));
      if (attributes.title) element.setAttribute("title", attributes.title.slice(0, 300));
    } else if (tag === "th" || tag === "td") {
      const colspan = readmeIntegerAttribute(attributes.colspan, 1, 20);
      const rowspan = readmeIntegerAttribute(attributes.rowspan, 1, 100);
      if (colspan) element.setAttribute("colspan", String(colspan));
      if (rowspan) element.setAttribute("rowspan", String(rowspan));
    } else if (tag === "ol") {
      const start = readmeIntegerAttribute(attributes.start, 1, 100000);
      if (start) element.setAttribute("start", String(start));
    } else if (tag === "li") {
      const value = readmeIntegerAttribute(attributes.value, 1, 100000);
      if (value) element.setAttribute("value", String(value));
    } else if (tag === "details" && Object.hasOwn(attributes, "open")) {
      element.setAttribute("open", "");
    } else if (tag === "code" && /^language-[a-z0-9_+-]+$/i.test(attributes.class || "")) {
      element.setAttribute("class", attributes.class);
    }
  });

  const commentWalker = document.createTreeWalker(template.content, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (commentWalker.nextNode()) comments.push(commentWalker.currentNode);
  comments.forEach((comment) => comment.remove());
  return template.innerHTML;
}

async function loadPluginReadme(moduleName, source = "store") {
  const readmeContainer = document.getElementById("detail-readme");
  if (!readmeContainer) return;
  readmeContainer.innerHTML = '<div class="empty-text">正在加载 README…</div>';
  try {
    const prefix = source === "loaded" ? "/plugins" : "/store/plugins";
    const data = await api(`${prefix}/${encodeURIComponent(moduleName)}/readme`);
    if (data.ok && data.content_html) {
      const html = sanitizeReadmeHtml(data.content_html, data.base_url || "");
      readmeContainer.innerHTML = `<div class="markdown-body">${html}</div>`;
    } else {
      readmeContainer.innerHTML = `<div class="empty-text">${escapeHtml(data.detail || "暂无 README")}</div>`;
    }
  } catch (_) {
    readmeContainer.innerHTML = '<div class="empty-text">README 加载失败</div>';
  }
}

async function loadAccess() {
  try {
    const data = await api("/access");
    state.accessRules = data.rules;
    state.accessBots = data.bots;
    const options = data.plugins.map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.title)} · ${escapeHtml(item.name)}</option>`).join("");
    const editor = $("#access-plugin");
    const preview = $("#access-preview-plugin");
    const oldPlugin = editor.value;
    const oldPreview = preview.value;
    editor.innerHTML = '<option value="nonebot">全部插件</option>' + options;
    preview.innerHTML = options;
    if ([...editor.options].some((option) => option.value === oldPlugin)) editor.value = oldPlugin;
    if ([...preview.options].some((option) => option.value === oldPreview)) preview.value = oldPreview;
    $("#access-bots").innerHTML = data.bots.map((bot) => `<option value="${escapeHtml(bot.bot_id)}">${escapeHtml(bot.adapter)}</option>`).join("");
    const adapters = [...new Set(["OneBot V11", "OneBot V12", "QQ", ...data.bots.map((bot) => bot.adapter), ...data.rules.map((rule) => rule.adapter)])];
    $("#access-adapters").innerHTML = adapters.map((adapter) => `<option value="${escapeHtml(adapter)}"></option>`).join("");
    renderAccessRules();
  } catch (error) {
    $("#access-status").textContent = `读取失败：${error.message}`;
    toast(error.message, "error");
  }
}

function updateAccessTarget() {
  const target = $("#access-target").value;
  const user = ["user", "group_user"].includes(target);
  const group = ["group", "group_user"].includes(target);
  $("#access-user-field").hidden = !user;
  $("#access-group-field").hidden = !group;
  $("#access-user").required = user;
  $("#access-group").required = group;
}

function resetAccessForm() {
  state.accessEditing = null;
  $("#access-form").reset();
  updateAccessTarget();
  $("#access-editor-title").textContent = "添加规则";
  $("#access-save").textContent = "保存规则";
}

function accessRuleFromForm() {
  const target = $("#access-target").value;
  return {
    plugin: $("#access-plugin").value,
    adapter: $("#access-adapter").value.trim(),
    bot_id: $("#access-bot").value.trim(),
    target,
    user_id: ["user", "group_user"].includes(target) ? $("#access-user").value.trim() : "",
    group_id: ["group", "group_user"].includes(target) ? $("#access-group").value.trim() : "",
    allow: $("#access-allow").value === "true",
  };
}

async function saveAccessRule(event) {
  event.preventDefault();
  const button = $("#access-save");
  button.disabled = true;
  try {
    const rule = accessRuleFromForm();
    const editing = state.accessEditing !== null;
    await api("/access/rule", {
      method: editing ? "PATCH" : "PUT",
      body: JSON.stringify(editing ? { original: state.accessEditing, rule } : rule),
    });
    if (editing) state.accessEditing = { ...rule };
    $("#access-status").textContent = "已保存，立即生效";
    $("#access-preview-result").textContent = "";
    await loadAccess();
    toast(editing ? "原规则已修改" : "响应权限已保存");
  } catch (error) {
    $("#access-status").textContent = `保存失败：${error.message}`;
    toast(error.message, "error");
  } finally { button.disabled = false; }
}

const accessTargetNames = { all: "所有人", private: "所有私聊", user: "用户", group: "群", group_user: "群内用户" };

function renderAccessRules() {
  const query = $("#access-search").value.trim().toLowerCase();
  const rows = state.accessRules.map((rule, index) => ({ rule, index })).filter(({ rule }) => JSON.stringify(rule).toLowerCase().includes(query));
  $("#access-count").textContent = state.accessRules.length;
  $("#access-rules").innerHTML = rows.length ? rows.map(({ rule, index }) => `<div class="access-rule">
    <div><strong>${escapeHtml(rule.plugin === "nonebot" ? "全部插件" : rule.plugin)}</strong><p>${escapeHtml(rule.adapter)} · ${escapeHtml(rule.bot_id || "全部机器人")} · ${escapeHtml(accessTargetNames[rule.target])}${rule.group_id ? ` · 群 ${escapeHtml(rule.group_id)}` : ""}${rule.user_id ? ` · 用户 ${escapeHtml(rule.user_id)}` : ""}</p></div>
    <span class="badge ${rule.allow ? "enabled" : "disabled"}">${rule.allow ? "允许" : "禁止"}</span>
    <button type="button" class="btn btn-ghost btn-sm" data-access-edit="${index}">调整</button>
    <button type="button" class="btn btn-ghost btn-sm" data-access-delete="${index}">删除</button>
  </div>`).join("") : '<div class="empty-state">没有匹配的规则；未设置规则时默认允许。</div>';
  $$("[data-access-edit]").forEach((button) => button.addEventListener("click", () => {
    const rule = state.accessRules[Number(button.dataset.accessEdit)];
    state.accessEditing = { ...rule };
    for (const [id, value] of Object.entries({ plugin: rule.plugin, adapter: rule.adapter, bot: rule.bot_id, target: rule.target, user: rule.user_id, group: rule.group_id, allow: String(rule.allow) })) $("#access-" + id).value = value;
    updateAccessTarget();
    $("#access-editor-title").textContent = "调整规则（保存将修改原规则）";
    $("#access-save").textContent = "保存修改";
    $("#access-form").scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  $$("[data-access-delete]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const rule = state.accessRules[Number(button.dataset.accessDelete)];
      await api("/access/rule/delete", { method: "POST", body: JSON.stringify(rule) });
      if (JSON.stringify(state.accessEditing) === JSON.stringify(rule)) resetAccessForm();
      $("#access-preview-result").textContent = "";
      await loadAccess();
      toast("规则已删除，恢复继承其他规则");
    } catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; }
  }));
}

async function previewAccess(event) {
  event.preventDefault();
  const button = $("button", event.target);
  button.disabled = true;
  try {
    const result = await api("/access/preview", { method: "POST", body: JSON.stringify({
      plugin: $("#access-preview-plugin").value,
      adapter: $("#access-preview-adapter").value.trim(),
      bot_id: $("#access-preview-bot").value.trim(),
      user_id: $("#access-preview-user").value.trim(),
      group_id: $("#access-preview-group").value.trim(),
    }) });
    $("#access-preview-result").textContent = `${result.allow ? "允许通过面板检查" : "禁止响应"}：${result.reason}${result.matched ? `（${result.matched.plugin === "nonebot" ? "全部插件" : result.matched.plugin}）` : ""}`;
  } catch (error) { $("#access-preview-result").textContent = `检查失败：${error.message}`; }
  finally { button.disabled = false; }
}

bootstrap();
