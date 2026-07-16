const embedUrl = new URL(import.meta.url);
const serverOrigin = embedUrl.origin;
const bridgeKey = embedUrl.searchParams.get("bridge") || "";

if (!window.__demo2codexEmbed) {
  window.__demo2codexEmbed = true;
  initialiseDemo2CodexEmbed();
}

function initialiseDemo2CodexEmbed() {
  const state = {
    session: null,
    picking: false,
    hoveredElement: null,
    focusedElement: null,
    focus: null,
    recorderWindow: null,
    minimized: false,
  };

  const host = document.createElement("div");
  host.id = "demo2codex-root";
  host.setAttribute("data-demo2codex-ui", "true");
  host.style.cssText =
    "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:layout style;";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .m2p-toolbar {
      position: fixed; right: 18px; bottom: 18px; display: flex; align-items: center;
      gap: 8px; max-width: min(520px, calc(100vw - 36px)); min-height: 48px;
      padding: 7px; border: 1px solid rgba(31,33,29,.14); border-radius: 15px;
      color: #20221e; background: rgba(255,255,255,.97);
      box-shadow: 0 16px 42px rgba(21,24,20,.2); pointer-events: auto;
      font: 600 12px/1.2 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased; backdrop-filter: blur(12px);
    }
    .m2p-toolbar[data-minimized="true"] { padding: 5px; border-radius: 999px; }
    .m2p-brand { display: flex; align-items: center; gap: 9px; padding: 0 7px 0 4px; min-width: 0; }
    .m2p-logo { display: grid; width: 30px; height: 30px; flex: 0 0 auto; place-items: center;
      border-radius: 9px; color: #fff; background: #20221e; font-size: 9px; font-weight: 850; letter-spacing: .04em; }
    .m2p-copy { display: grid; gap: 2px; min-width: 0; }
    .m2p-title { overflow: hidden; max-width: 150px; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .m2p-status { display: flex; align-items: center; gap: 5px; color: #74776e; font-size: 9px; font-weight: 600; }
    .m2p-status::before { width: 6px; height: 6px; border-radius: 50%; background: #3c8a67; content: ""; }
    .m2p-status[data-offline="true"]::before { background: #b7594e; }
    .m2p-divider { width: 1px; height: 26px; background: #e2e3dd; }
    .m2p-button { display: inline-flex; min-height: 34px; align-items: center; justify-content: center; gap: 6px;
      padding: 0 11px; border: 1px solid #dcded5; border-radius: 9px; color: #20221e; background: #fff;
      cursor: pointer; font: 750 11px/1 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .m2p-button:hover { background: #f5f6f2; }
    .m2p-button:focus-visible { outline: 3px solid rgba(49,113,81,.23); outline-offset: 2px; }
    .m2p-button-primary { border-color: #295c48; color: #fff; background: #295c48; }
    .m2p-button-primary:hover { background: #174433; }
    .m2p-button-focus { border-color: #91b7a3; color: #174433; background: #e2f0e8; }
    .m2p-button-danger { border-color: #e8c4bf; color: #9f3f35; background: #faeae7; }
    .m2p-icon-button { width: 32px; padding: 0; color: #777a72; }
    .m2p-mini-button { display: grid; width: 38px; height: 38px; place-items: center; border: 0; border-radius: 50%;
      color: #fff; background: #20221e; cursor: pointer; font: 850 9px/1 Inter, sans-serif; letter-spacing: .04em; }
    .m2p-highlight { position: fixed; display: none; border: 2px solid #2e8b63; border-radius: 5px;
      background: rgba(46,139,99,.10); box-shadow: 0 0 0 1px rgba(255,255,255,.8) inset; pointer-events: none; }
    .m2p-highlight[data-visible="true"] { display: block; }
    .m2p-highlight[data-focused="true"] { border-width: 3px; border-color: #cf5a47; background: rgba(207,90,71,.08); }
    .m2p-highlight-label { position: absolute; left: -2px; bottom: calc(100% + 5px); max-width: min(360px, 80vw);
      overflow: hidden; padding: 5px 8px; border-radius: 6px; color: #fff; background: #205f46;
      text-overflow: ellipsis; white-space: nowrap; font: 750 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .m2p-highlight[data-focused="true"] .m2p-highlight-label { background: #a34135; }
    .m2p-picker-help { position: fixed; top: 16px; left: 50%; display: none; max-width: calc(100vw - 32px);
      padding: 10px 14px; border-radius: 999px; color: #fff; background: rgba(24,28,23,.92);
      box-shadow: 0 10px 30px rgba(0,0,0,.18); transform: translateX(-50%); pointer-events: none;
      font: 650 11px/1.3 Inter, ui-sans-serif, sans-serif; }
    .m2p-picker-help[data-visible="true"] { display: block; }
    .m2p-toast { position: fixed; right: 18px; bottom: 82px; max-width: min(360px, calc(100vw - 36px));
      padding: 10px 13px; border-radius: 9px; color: #fff; background: #2b2e29; opacity: 0;
      box-shadow: 0 10px 28px rgba(0,0,0,.2); transform: translateY(6px); transition: opacity .15s, transform .15s;
      pointer-events: none; font: 600 11px/1.45 Inter, ui-sans-serif, sans-serif; }
    .m2p-toast[data-visible="true"] { opacity: 1; transform: translateY(0); }
    @media (max-width: 620px) {
      .m2p-toolbar { right: 10px; bottom: 10px; left: 10px; max-width: none; }
      .m2p-copy, .m2p-divider { display: none; }
      .m2p-brand { padding-right: 0; }
      .m2p-button { flex: 1; }
      .m2p-icon-button { flex: 0 0 32px; }
    }
    @media (prefers-reduced-motion: reduce) { .m2p-toast { transition: none; } }
  `;

  const toolbar = document.createElement("aside");
  toolbar.className = "m2p-toolbar";
  toolbar.setAttribute("aria-label", "Demo2Codex 评审工具");
  toolbar.innerHTML = `
    <button class="m2p-mini-button" type="button" aria-label="展开 Demo2Codex" hidden>D2C</button>
    <div class="m2p-brand">
      <span class="m2p-logo" aria-hidden="true">D2C</span>
      <span class="m2p-copy">
        <span class="m2p-title">Demo2Codex</span>
        <span class="m2p-status">正在连接本地会话</span>
      </span>
    </div>
    <span class="m2p-divider" aria-hidden="true"></span>
    <button class="m2p-button m2p-button-primary" data-action="recorder" type="button">● 打开录音台</button>
    <button class="m2p-button" data-action="pick" type="button">⌖ 选择页面区域</button>
    <button class="m2p-button m2p-icon-button" data-action="minimize" type="button" aria-label="收起 Demo2Codex">—</button>
  `;

  const hoverHighlight = createHighlight("hover");
  const focusHighlight = createHighlight("focus");
  const pickerHelp = document.createElement("div");
  pickerHelp.className = "m2p-picker-help";
  pickerHelp.textContent = "点击页面元素开始对焦 · 按 Esc 取消";
  const toastElement = document.createElement("div");
  toastElement.className = "m2p-toast";

  shadow.append(style, hoverHighlight.box, focusHighlight.box, pickerHelp, toolbar, toastElement);
  (document.body || document.documentElement).append(host);

  const statusElement = toolbar.querySelector(".m2p-status");
  const titleElement = toolbar.querySelector(".m2p-title");
  const recorderButton = toolbar.querySelector('[data-action="recorder"]');
  const pickButton = toolbar.querySelector('[data-action="pick"]');
  const minimizeButton = toolbar.querySelector('[data-action="minimize"]');
  const miniButton = toolbar.querySelector(".m2p-mini-button");
  const brand = toolbar.querySelector(".m2p-brand");
  const divider = toolbar.querySelector(".m2p-divider");

  function createHighlight(kind) {
    const box = document.createElement("div");
    box.className = "m2p-highlight";
    if (kind === "focus") box.dataset.focused = "true";
    const label = document.createElement("span");
    label.className = "m2p-highlight-label";
    box.append(label);
    return { box, label };
  }

  function showToast(message) {
    toastElement.textContent = message;
    toastElement.dataset.visible = "true";
    window.clearTimeout(showToast.timeout);
    showToast.timeout = window.setTimeout(() => delete toastElement.dataset.visible, 3_500);
  }

  function setMinimized(minimized) {
    state.minimized = minimized;
    toolbar.dataset.minimized = String(minimized);
    miniButton.hidden = !minimized;
    for (const element of [brand, divider, recorderButton, pickButton, minimizeButton]) {
      element.hidden = minimized;
    }
  }

  function sessionDetails(data) {
    if (!data || data.active === false) return null;
    const nested = data.session || {};
    const id = data.sessionId || data.id || nested.id;
    if (!id) return null;
    return {
      id,
      title: data.title || data.projectName || nested.title || nested.projectName || "Demo 评审",
      status: data.status || nested.status || "active",
      recorderLaunchUrl: data.recorderLaunchUrl || nested.recorderLaunchUrl || "",
    };
  }

  async function postEvent(type, payload) {
    if (!state.session?.id || !bridgeKey) return false;
    const url = new URL(`/api/sessions/${encodeURIComponent(state.session.id)}/events`, serverOrigin);
    url.searchParams.set("bridge", bridgeKey);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          timestamp: new Date().toISOString(),
          payload: {
            ...payload,
            page: {
              href: window.location.href,
              pathname: window.location.pathname,
              title: document.title,
            },
          },
        }),
        cache: "no-store",
        keepalive: true,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch (error) {
      console.warn(`[Demo2Codex] Could not send ${type}`, error);
      showToast("本地服务暂时不可用；请保持评审工具运行。 ");
      return false;
    }
  }

  async function refreshActiveSession() {
    try {
      const activeSessionUrl = new URL("/api/active-session", serverOrigin);
      if (bridgeKey) activeSessionUrl.searchParams.set("bridge", bridgeKey);
      const response = await fetch(activeSessionUrl, {
        cache: "no-store",
      });
      if (response.status === 204 || response.status === 404) {
        updateSession(null);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      updateSession(sessionDetails(await response.json()));
    } catch (error) {
      statusElement.textContent = "等待本地服务";
      statusElement.dataset.offline = "true";
    }
  }

  function updateSession(nextSession) {
    if (state.session?.id && nextSession?.id !== state.session.id && state.focus) {
      void endFocus("session.changed");
    }
    state.session = nextSession;
    if (!nextSession) {
      titleElement.textContent = "Demo2Codex";
      statusElement.textContent = "暂无活动评审";
      statusElement.dataset.offline = "true";
      recorderButton.disabled = true;
      pickButton.disabled = true;
      return;
    }
    titleElement.textContent = nextSession.title;
    statusElement.textContent = "评审上下文已连接";
    delete statusElement.dataset.offline;
    recorderButton.disabled = false;
    pickButton.disabled = false;
  }

  function openRecorder() {
    if (!state.session) return;
    const url = state.session.recorderLaunchUrl
      ? new URL(state.session.recorderLaunchUrl, serverOrigin)
      : new URL(`/launch-recorder?bridge=${encodeURIComponent(bridgeKey)}`, serverOrigin);
    state.recorderWindow = window.open(url, "demo2codex-recorder");
    if (!state.recorderWindow) showToast("请允许此页面打开 Demo2Codex 录音台。 ");
    else state.recorderWindow.focus();
  }

  function isDemo2CodexElement(element) {
    return (
      !element ||
      element === host ||
      host.contains(element) ||
      element.closest?.("#demo2codex-root, #meeting2prompt-root")
    );
  }

  function elementAtPoint(x, y) {
    const element = document.elementFromPoint(x, y);
    return isDemo2CodexElement(element) ? null : element;
  }

  function describeElement(element) {
    const rect = element.getBoundingClientRect();
    const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180);
    const framework = frameworkEvidence(element);
    const stableId =
      element.getAttribute("data-d2c-id") ||
      element.getAttribute("data-m2p-id") ||
      element.getAttribute("data-testid") ||
      element.getAttribute("data-test-id") ||
      "";
    const descriptor = {
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      classes: [...element.classList].slice(0, 12),
      text,
      role: element.getAttribute("role") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      componentId: stableId,
      component: framework.component,
      componentStack: framework.componentStack,
      source: framework.source,
      selector: selectorFor(element),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
    descriptor.label = descriptor.ariaLabel || text.slice(0, 52) || descriptor.componentId || descriptor.selector;
    return descriptor;
  }

  function frameworkEvidence(element) {
    const explicitComponent =
      element.getAttribute("data-d2c-component") ||
      element.getAttribute("data-m2p-component") ||
      element.getAttribute("data-component") ||
      "";
    const explicitSource =
      element.getAttribute("data-d2c-source") ||
      element.getAttribute("data-m2p-source") ||
      "";
    const componentStack = [];
    let source = explicitSource;
    if (explicitComponent) componentStack.push(explicitComponent);

    try {
      const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
      let fiber = fiberKey ? element[fiberKey] : null;
      while (fiber && componentStack.length < 8) {
        const type = fiber.type;
        const name =
          (typeof type === "function" && (type.displayName || type.name)) ||
          (type && typeof type === "object" && (type.displayName || type.render?.displayName || type.render?.name)) ||
          "";
        if (name && !componentStack.includes(name)) componentStack.push(name);
        source ||= fiber._debugSource?.fileName || type?.__file || "";
        fiber = fiber.return;
      }
    } catch {
      // React internals are optional development-only evidence.
    }

    try {
      let instance = element.__vueParentComponent;
      while (instance && componentStack.length < 8) {
        const type = instance.type || {};
        const name = type.name || type.__name || "";
        if (name && !componentStack.includes(name)) componentStack.push(name);
        source ||= type.__file || "";
        instance = instance.parent;
      }
    } catch {
      // Vue internals are optional development-only evidence.
    }

    return {
      component: componentStack[0] || "",
      componentStack,
      source: String(source || ""),
    };
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  }

  function attributeSelector(name, value) {
    return `[${name}="${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  }

  function selectorFor(element) {
    if (element.id) return `#${cssEscape(element.id)}`;
    for (const attribute of ["data-d2c-id", "data-m2p-id", "data-testid", "data-test-id"]) {
      const value = element.getAttribute(attribute);
      if (value) return attributeSelector(attribute, value);
    }

    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      if (current === document.body) break;
      current = parent;
    }
    return parts.join(" > ");
  }

  function positionHighlight(highlight, element) {
    if (!element?.isConnected) {
      delete highlight.box.dataset.visible;
      return;
    }
    const rect = element.getBoundingClientRect();
    Object.assign(highlight.box.style, {
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      width: `${Math.max(0, rect.width)}px`,
      height: `${Math.max(0, rect.height)}px`,
    });
    const descriptor = describeElement(element);
    highlight.label.textContent = `${descriptor.tag} · ${descriptor.label}`;
    highlight.box.dataset.visible = "true";
  }

  function beginPicking() {
    if (!state.session) return;
    if (state.focus) {
      void endFocus("user.ended");
      return;
    }
    state.picking = true;
    pickerHelp.dataset.visible = "true";
    pickButton.className = "m2p-button m2p-button-focus";
    pickButton.textContent = "点击页面中的区域";
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("click", onPickClick, true);
    document.addEventListener("keydown", onPickerKeydown, true);
  }

  function cancelPicking() {
    state.picking = false;
    state.hoveredElement = null;
    delete hoverHighlight.box.dataset.visible;
    delete pickerHelp.dataset.visible;
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("click", onPickClick, true);
    document.removeEventListener("keydown", onPickerKeydown, true);
    renderFocusButton();
  }

  function onPointerMove(event) {
    const element = elementAtPoint(event.clientX, event.clientY);
    if (element === state.hoveredElement) return;
    state.hoveredElement = element;
    positionHighlight(hoverHighlight, element);
  }

  function onPickClick(event) {
    const element = elementAtPoint(event.clientX, event.clientY);
    if (!element) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelPicking();
    void startFocus(element);
  }

  function onPickerKeydown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelPicking();
  }

  async function startFocus(element) {
    if (state.focus) await endFocus("focus.replaced");
    const descriptor = describeElement(element);
    const focusId = globalThis.crypto?.randomUUID?.() || `focus-${Date.now()}`;
    state.focusedElement = element;
    state.focus = { id: focusId, element: descriptor, startedAt: new Date().toISOString() };
    positionHighlight(focusHighlight, element);
    renderFocusButton();
    const delivered = await postEvent("focus.start", {
      focusId,
      focus_id: focusId,
      focus: descriptor,
      element: descriptor,
    });
    showToast(
      delivered
        ? `已对焦“${descriptor.label}”，接下来的讨论会归到这个页面区域。`
        : "已在页面标记区域，但暂时无法同步到本地评审。",
    );
  }

  async function endFocus(reason) {
    if (!state.focus) return;
    const previous = state.focus;
    state.focus = null;
    state.focusedElement = null;
    delete focusHighlight.box.dataset.visible;
    renderFocusButton();
    await postEvent("focus.end", {
      focusId: previous.id,
      focus_id: previous.id,
      focus: previous.element,
      element: previous.element,
      startedAt: previous.startedAt,
      reason,
    });
    if (reason === "user.ended") showToast("已结束页面对焦，后续讨论回到整个评审。 ");
  }

  function renderFocusButton() {
    if (state.focus) {
      pickButton.className = "m2p-button m2p-button-danger";
      pickButton.textContent = `■ 结束对焦：${state.focus.element.label.slice(0, 18)}`;
      return;
    }
    pickButton.className = "m2p-button";
    pickButton.textContent = "⌖ 选择页面区域";
  }

  function refreshHighlights() {
    if (state.focusedElement?.isConnected) positionHighlight(focusHighlight, state.focusedElement);
    else if (state.focus) void endFocus("element.removed");
    if (state.picking && state.hoveredElement?.isConnected) {
      positionHighlight(hoverHighlight, state.hoveredElement);
    }
  }

  recorderButton.addEventListener("click", openRecorder);
  pickButton.addEventListener("click", beginPicking);
  minimizeButton.addEventListener("click", () => setMinimized(true));
  miniButton.addEventListener("click", () => setMinimized(false));
  window.addEventListener("scroll", refreshHighlights, true);
  window.addEventListener("resize", refreshHighlights);
  window.addEventListener("pagehide", () => {
    if (state.focus) void postEvent("focus.end", { ...state.focus, reason: "page.hidden" });
  });

  const observer = new MutationObserver(() => {
    if (state.focus && !state.focusedElement?.isConnected) void endFocus("element.removed");
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  updateSession(null);
  void refreshActiveSession();
  window.setInterval(refreshActiveSession, 5_000);
}
