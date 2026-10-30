(function () {
  const messages = {
    en: {
      "hero.title": "LVGL, running where the browser can see it.",
      "hero.lede": "A versioned LVGL WebAssembly runtime with a browser studio and host SDKs for TypeScript, Rust, C, and C++.",
      "hero.open": "Open LVGL Studio",
      "hero.source": "View source",
      "hero.core": "CORE",
      "hero.default": "DEFAULT",
      "hero.license": "LICENSE",
      "hero.wasi": "WASI reactor",
      "preview.label": "STUDIO / PREVIEW",
      "preview.ready": "READY",
      "preview.title": "Ready to render.",
      "preview.body": "Load a library or start with the sample app.",
      "preview.run": "RUN SAMPLE",
      "workspace.eyebrow": "THE WORKSPACE",
      "workspace.title": "One core, several ways to use it.",
      "workspace.browser.title": "Browser studio",
      "workspace.browser.body": "Load the default core or a compatible local Wasm artifact, run an application, and inspect rendered frames in a contained workspace.",
      "workspace.browser.link": "Launch Studio",
      "workspace.sdk.title": "Generated SDKs",
      "workspace.sdk.body": "TypeScript and Rust bindings are generated from the selected core's API, layout, constants, and signature proof.",
      "workspace.sdk.link": "Browse bindings",
      "workspace.host.title": "Host applications",
      "workspace.host.body": "Versioned application ABIs keep C, C++, Rust, and JavaScript samples on the same runtime boundary.",
      "workspace.host.link": "See toolchains",
      "start.eyebrow": "START HERE",
      "start.title": "Open the studio or build the core locally.",
      "start.body": "The browser demo starts with a working LVGL core and sample application. Local builds expose the same module to native and browser hosts.",
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
      "page.description": "liblvgl-wasm runs LVGL as a WASI WebAssembly module with browser, TypeScript, Rust, C, and C++ host support.",
      "locale.english": "English",
      "locale.chinese": "中文",
      "theme.light": "Light",
      "theme.dark": "Dark"
    },
    "zh-CN": {
      "hero.title": "LVGL，编译成 WASM 想跑哪里跑哪里。",
      "hero.lede": "提供版本化的 LVGL Wasm 运行时、浏览器 Studio，以及 TypeScript、Rust、C 和 C++ 宿主 SDK。",
      "hero.open": "打开 LVGL Studio",
      "hero.source": "查看源码",
      "hero.core": "核心",
      "hero.default": "默认版本",
      "hero.license": "许可证",
      "hero.wasi": "WASI reactor",
      "preview.label": "STUDIO / 预览",
      "preview.ready": "就绪",
      "preview.title": "可以开始渲染。",
      "preview.body": "加载一个 Wasm 库，或者打开一个示例。",
      "preview.run": "运行示例",
      "workspace.eyebrow": "工作区",
      "workspace.title": "同一个核心，浏览器和原生主机都能用。",
      "workspace.browser.title": "浏览器 Studio",
      "workspace.browser.body": "加载一个默认核心，或者一个兼容的本地 Wasm 文件，在隔离的工作区里运行应用、查看渲染帧。",
      "workspace.browser.link": "启动 Studio",
      "workspace.sdk.title": "一套自动生成的 SDK",
      "workspace.sdk.body": "根据选定核心的 API、布局、常量和签名校验结果生成 TypeScript 与 Rust 绑定。",
      "workspace.sdk.link": "浏览绑定",
      "workspace.host.title": "宿主应用",
      "workspace.host.body": "C、C++、Rust 和 JavaScript 示例使用一套版本化的应用 ABI，连接到同一个运行时边界。",
      "workspace.host.link": "查看工具链",
      "start.eyebrow": "从这里开始",
      "start.title": "打开 Studio，或者在本地构建核心。",
      "start.body": "浏览器示例会启动一个可运行的 LVGL 核心和一个示例应用。本地构建后，同一个模块既能给浏览器用，也能给原生主机用。",
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
      "page.description": "liblvgl-wasm 把 LVGL 编译成 WASM，提供浏览器、TypeScript、Rust、C 和 C++ 宿主支持。",
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
