(function () {
  const messages = {
    en: {
      "hero.title": "Run LVGL in your browser.",
      "hero.lede": "Click a widget in Studio, then run the same interface from a TypeScript or Rust test.",
      "hero.open": "Open LVGL Studio",
      "hero.source": "View source",
      "hero.core": "CORE",
      "hero.default": "DEFAULT",
      "hero.hosts": "HOSTS",
      "hero.wasi": "WASI reactor",
      "preview.label": "STUDIO / PREVIEW",
      "preview.ready": "READY",
      "preview.title": "Ready to render.",
      "preview.body": "Load a library or start with the sample app.",
      "preview.run": "RUN SAMPLE",
      "workspace.eyebrow": "THE WORKSPACE",
      "workspace.title": "Work with an LVGL app",
      "workspace.browser.title": "Browser studio",
      "workspace.browser.body": "Open the C demo or load your own Wasm app and its libraries. Send input and see the result on the canvas.",
      "workspace.browser.link": "Launch Studio",
      "workspace.sdk.title": "TypeScript and Rust hosts",
      "workspace.sdk.body": "Create a display, send a pointer event, and read the rendered frame in a test.",
      "workspace.sdk.link": "Use a host SDK",
      "workspace.host.title": "Application examples",
      "workspace.host.body": "Start with a C, C++, Rust, JavaScript, or TypeScript app and run it in Studio.",
      "workspace.host.link": "Build an app",
      "start.eyebrow": "START HERE",
      "start.title": "Build Studio locally",
      "start.body": "From the repository root, prepare the Wasm tools. The build guide lists the prerequisites and the command to start Studio.",
      "start.terminal": "TERMINAL",
      "start.copy": "Copy",
      "start.copied": "Copied",
      "start.manual": "Select manually",
      "start.guide": "Read the build guide",
      "footer.stack": "LVGL · WASI · WebAssembly",
      "nav.open": "Open Studio",
      "nav.language": "Language",
      "nav.github": "GitHub",
      "page.title": "liblvgl-wasm — LVGL WebAssembly runtime",
      "page.description": "Run LVGL apps in a browser or test them with TypeScript and Rust. Studio accepts compiled applications, firmware, and multi-module projects.",
      "locale.english": "English",
      "locale.chinese": "中文",
      "theme.light": "Light",
      "theme.dark": "Dark"
    },
    "zh-CN": {
      "hero.title": "在浏览器里运行 LVGL",
      "hero.lede": "在 Studio 里点击控件，也可以在 TypeScript 或 Rust 测试里给同一个界面发送输入、读取画面。",
      "hero.open": "打开 LVGL Studio",
      "hero.source": "查看源码",
      "hero.core": "核心",
      "hero.default": "默认版本",
      "hero.hosts": "宿主",
      "hero.wasi": "WASI reactor",
      "preview.label": "STUDIO / 预览",
      "preview.ready": "就绪",
      "preview.title": "可以开始渲染。",
      "preview.body": "加载一个 Wasm 库，或者打开一个示例。",
      "preview.run": "运行示例",
      "workspace.eyebrow": "工作区",
      "workspace.title": "运行和测试 LVGL 应用",
      "workspace.browser.title": "浏览器 Studio",
      "workspace.browser.body": "打开 C 示例，或加载自己的 Wasm 应用和依赖库，发送输入并查看画面。",
      "workspace.browser.link": "启动 Studio",
      "workspace.sdk.title": "TypeScript 和 Rust 宿主",
      "workspace.sdk.body": "创建显示器，发送指针事件，在测试里读取渲染结果。",
      "workspace.sdk.link": "接入宿主 SDK",
      "workspace.host.title": "应用示例",
      "workspace.host.body": "从 C、C++、Rust、JavaScript 或 TypeScript 示例开始，在 Studio 里运行自己的应用。",
      "workspace.host.link": "构建应用",
      "start.eyebrow": "从这里开始",
      "start.title": "在本地构建 Studio",
      "start.body": "先在仓库根目录准备 Wasm 工具。构建指南列出了所需依赖和启动 Studio 的命令。",
      "start.terminal": "终端",
      "start.copy": "复制",
      "start.copied": "已复制",
      "start.manual": "请手动选择",
      "start.guide": "查看构建说明",
      "footer.stack": "LVGL · WASI · WebAssembly",
      "nav.open": "打开 Studio",
      "nav.language": "语言",
      "nav.github": "GitHub",
      "page.title": "liblvgl-wasm — LVGL Wasm 运行时",
      "page.description": "在浏览器里运行 LVGL 应用，用 TypeScript 或 Rust 测试同一个界面。Studio 可以加载编译好的应用、固件和多模块工程。",
      "locale.english": "English",
      "locale.chinese": "中文",
      "theme.light": "浅色",
      "theme.dark": "深色"
    }
  };
  const storageKey = "lvgl-studio-locale";
  let saved = null;
  try { saved = localStorage.getItem(storageKey); } catch {}
  let locale = saved === "zh-CN" || saved === "en" ? saved : (navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
  function text(key) { return messages[locale][key] || messages.en[key] || key; }
  function apply() {
    document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
    document.title = text("page.title");
    document.querySelector('meta[name="description"]').setAttribute("content", text("page.description"));
    document.querySelectorAll("[data-i18n]").forEach((element) => { element.textContent = text(element.dataset.i18n); });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => element.setAttribute("aria-label", text(element.dataset.i18nAriaLabel)));
    document.querySelectorAll("[data-locale-choice]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.localeChoice === locale)));
    document.querySelector('meta[name="theme-color"]').setAttribute("content", locale === "zh-CN" ? "#efeeeb" : document.documentElement.dataset.theme === "dark" ? "#20201e" : "#efeeeb");
  }
  document.querySelectorAll("[data-locale-choice]").forEach((button) => button.addEventListener("click", () => {
    locale = button.dataset.localeChoice;
    try { localStorage.setItem(storageKey, locale); } catch {}
    apply();
  }));
  document.querySelectorAll("[data-theme-choice]").forEach((button) => button.addEventListener("click", () => {
    const theme = button.dataset.themeChoice;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').setAttribute("content", theme === "dark" ? "#20201e" : "#efeeeb");
    document.querySelectorAll("[data-theme-choice]").forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.themeChoice === theme)));
    try { localStorage.setItem("lvgl-studio-theme", theme); } catch {}
  }));
  const theme = localStorage.getItem("lvgl-studio-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  apply();
  document.querySelector("[data-copy]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = text("start.copied"); setTimeout(() => { button.textContent = text("start.copy"); }, 1200); }
    catch { button.textContent = text("start.manual"); }
  });
})();
