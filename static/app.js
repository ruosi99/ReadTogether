const state = {
  activeUserId: "you",
  users: [],
  books: [],
  currentBook: null,
  currentThreads: [],
  currentChapterIndex: 0,
  currentPageIndex: 0,
  currentPageCount: 1,
  currentPages: [],
  pageCache: {},
  theme: "paper",
  pendingSelection: null,
  noteDraft: "",
  commentDrafts: {},
  lastEventId: 0,
  activeReaderPanel: null,
  pendingAvatarDataUrl: null,
  touchStart: null,
  selectionCaptureTimer: null,
  selectionListenersBound: false,
  lastRouteHash: "",
  touchSelectionActive: false,
};

const userSwitcher = document.getElementById("user-switcher");
const app = document.getElementById("app");

bootstrap();
window.addEventListener("hashchange", safeRender);
window.addEventListener("popstate", safeRender);
window.addEventListener("resize", handleViewportResize);
window.setInterval(watchRouteChanges, 250);

async function bootstrap() {
  const bootstrapData = await api("/api/bootstrap");
  state.users = bootstrapData.users;
  state.books = bootstrapData.books;
  renderUserSwitcher();
  state.lastRouteHash = window.location.hash || "#/";
  safeRender();
  startEventLoop();
}

function safeRender() {
  render().catch((error) => {
    console.error(error);
    app.innerHTML = `
      <section class="page-grid">
        <div class="empty-card">
          <h3>打开阅读页时出了点问题</h3>
          <p>${escapeHtml(error?.message || "未知错误")}</p>
          <button class="primary-button" id="retry-render">重新进入</button>
        </div>
      </section>
    `;
    document.getElementById("retry-render")?.addEventListener("click", () => safeRender());
  });
}

function watchRouteChanges() {
  const nextHash = window.location.hash || "#/";
  if (nextHash !== state.lastRouteHash) {
    state.lastRouteHash = nextHash;
    safeRender();
  }
}

function navigateTo(hash) {
  const normalized = hash.startsWith("#") ? hash : `#${hash}`;
  if (window.location.hash !== normalized) {
    window.location.hash = normalized;
  }
  state.lastRouteHash = normalized;
  safeRender();
}

function activeUser() {
  return state.users.find((user) => user.id === state.activeUserId) || state.users[0];
}

function partnerUser() {
  return state.users.find((user) => user.id !== state.activeUserId) || state.users[0];
}

function avatarMarkup(user, extraClass = "") {
  if (user?.avatarUrl) {
    return `<span class="avatar ${extraClass}" style="background-image:url('${user.avatarUrl}')"></span>`;
  }
  const fallback = escapeHtml((user?.name || "?").slice(0, 1));
  return `<span class="avatar avatar-fallback ${extraClass}" style="background:${user?.accent || "#9b5b3d"}">${fallback}</span>`;
}

function renderUserSwitcher() {
  userSwitcher.innerHTML = "";
  state.users.forEach((user) => {
    const button = document.createElement("button");
    button.className = `user-chip ${state.activeUserId === user.id ? "is-active" : ""}`;
    button.innerHTML = `${avatarMarkup(user, "avatar-small")}<span>${escapeHtml(user.name)}</span>`;
    button.addEventListener("click", () => {
      state.activeUserId = user.id;
      clearPendingSelection();
      state.activeReaderPanel = null;
      renderUserSwitcher();
      render();
    });
    userSwitcher.appendChild(button);
  });
}

function route() {
  const hash = window.location.hash || "#/";
  const segments = hash.slice(2).split("/").filter(Boolean);
  if (segments[0] === "books" && segments[1] && segments[2] === "read") {
    return { name: "reader", bookId: segments[1] };
  }
  if (segments[0] === "books" && segments[1]) {
    return { name: "detail", bookId: segments[1] };
  }
  return { name: "home" };
}

async function render() {
  const currentRoute = route();
  document.body.classList.toggle("reader-mode", currentRoute.name === "reader");
  if (currentRoute.name !== "reader") {
    clearPendingSelection();
  }
  if (currentRoute.name === "home") {
    renderHome();
    return;
  }
  if (currentRoute.name === "detail") {
    await renderDetail(currentRoute.bookId);
    return;
  }
  await renderReader(currentRoute.bookId);
}

function renderHome() {
  app.innerHTML = document.getElementById("home-template").innerHTML;
  const me = activeUser();
  const partner = partnerUser();
  document.getElementById("book-count").textContent = `${state.books.length} 本书在共享书架中`;

  const summaryGrid = document.getElementById("summary-grid");
  summaryGrid.innerHTML = [renderPerspectiveSummary(me, true), renderPerspectiveSummary(partner, false)].join("");

  const bookGrid = document.getElementById("book-grid");
  if (!state.books.length) {
    bookGrid.innerHTML =
      '<div class="empty-card"><h3>先上传第一本书</h3><p>上传成功后，你们两个人都可以进入同一本书阅读、标注和同步进度。</p></div>';
  } else {
    bookGrid.innerHTML = state.books.map((book) => renderBookCard(book, me, partner)).join("");
  }

  document.getElementById("book-upload").addEventListener("change", uploadBook);
}

function renderPerspectiveSummary(user, isPrimary) {
  const progressItems = state.books.flatMap((book) => book.progress || []).filter((item) => item.userId === user.id);
  const average = progressItems.length
    ? Math.round(progressItems.reduce((sum, item) => sum + item.progressPercent, 0) / progressItems.length)
    : 0;
  return `
    <article class="stat-card ${isPrimary ? "is-primary" : ""}">
      <span>${escapeHtml(user.name)}${isPrimary ? " 的主视角" : " 的陪读视角"}</span>
      <strong>${average}%</strong>
      <small>${isPrimary ? "当前主要阅读进度" : "对方的平均阅读进度"}</small>
    </article>
  `;
}

function renderBookCard(book, me, partner) {
  const myProgress = (book.progress || []).find((item) => item.userId === me.id);
  const partnerProgress = (book.progress || []).find((item) => item.userId === partner.id);
  return `
    <a class="book-card" href="#/books/${book.id}">
      <div class="book-cover"><span>${escapeHtml(book.title.slice(0, 2))}</span></div>
      <div class="book-meta">
        <h3>${escapeHtml(book.title)}</h3>
        <p>${escapeHtml(book.author)}</p>
        <div class="progress-pair">
          <div class="progress-panel is-primary">
            <span>${escapeHtml(me.name)}</span>
            <strong>${Math.round(myProgress?.progressPercent || 0)}%</strong>
            <small>${progressChapter(book, myProgress)}</small>
          </div>
          <div class="progress-panel">
            <span>${escapeHtml(partner.name)}</span>
            <strong>${Math.round(partnerProgress?.progressPercent || 0)}%</strong>
            <small>${progressChapter(book, partnerProgress)}</small>
          </div>
        </div>
        <small>标注 ${book.annotationCount || 0} 条 · ${formatTime(book.uploadedAt)}</small>
      </div>
    </a>
  `;
}

async function renderDetail(bookId) {
  state.currentBook = await api(`/api/books/${bookId}`);
  state.currentThreads = (await api(`/api/books/${bookId}/threads`)).threads;
  const me = activeUser();
  const partner = partnerUser();
  app.innerHTML = document.getElementById("detail-template").innerHTML;
  document.getElementById("detail-cover-text").textContent = state.currentBook.title.slice(0, 2);
  document.getElementById("detail-title").textContent = state.currentBook.title;
  document.getElementById("detail-author").textContent = state.currentBook.author;
  const readHref = `#/books/${bookId}/read`;
  const readLink = document.getElementById("read-link");
  readLink.href = readHref;
  readLink.addEventListener("click", (event) => {
    event.preventDefault();
    navigateTo(readHref);
  });
  document.getElementById("detail-uploaded-at").textContent = `上传时间：${formatTime(state.currentBook.uploadedAt)}`;

  document.querySelectorAll("[data-export-user]").forEach((button) => {
    const exportUserId = button.dataset.exportUser;
    const targetUser = state.users.find((user) => user.id === exportUserId) || me;
    button.textContent = `导出${targetUser.name}的笔记`;
    button.classList.toggle("is-primary", exportUserId === me.id);
    button.addEventListener("click", () => {
      window.location.href = `/api/books/${bookId}/export.md?userId=${exportUserId}`;
    });
  });

  const myProgress = (state.currentBook.progress || []).find((item) => item.userId === me.id);
  const partnerProgress = (state.currentBook.progress || []).find((item) => item.userId === partner.id);
  document.getElementById("detail-stats").innerHTML = `
    <article class="stat-card is-primary">
      <span>${escapeHtml(me.name)}的主视角</span>
      <strong>${Math.round(myProgress?.progressPercent || 0)}%</strong>
      <small>${progressChapter(state.currentBook, myProgress)}</small>
    </article>
    <article class="stat-card">
      <span>${escapeHtml(partner.name)}的陪读进度</span>
      <strong>${Math.round(partnerProgress?.progressPercent || 0)}%</strong>
      <small>${progressChapter(state.currentBook, partnerProgress)}</small>
    </article>
    <article class="stat-card">
      <span>总标注数</span>
      <strong>${state.currentBook.annotationCount || 0}</strong>
      <small>包含仅高亮和带批注的标注</small>
    </article>
  `;

  const detailThreads = document.getElementById("detail-threads");
  if (!state.currentThreads.length) {
    detailThreads.innerHTML =
      '<div class="empty-card"><h3>还没有标注</h3><p>进入阅读器后选中一句喜欢的内容，你们的共读互动就会出现在这里。</p></div>';
    return;
  }
  detailThreads.innerHTML = state.currentThreads.slice(0, 8).map((thread) => renderThreadCard(thread, me.id, false)).join("");
}

async function renderReader(bookId) {
  state.currentBook = await api(`/api/books/${bookId}/content`);
  state.currentThreads = (await api(`/api/books/${bookId}/threads`)).threads;
  const currentProgress = (state.currentBook.progress || []).find((item) => item.userId === state.activeUserId);
  state.currentChapterIndex = currentProgress?.chapterIndex || 0;
  state.currentPageIndex = currentProgress?.pageIndex || 0;
  state.currentPageCount = Math.max(1, currentProgress?.pageCount || 1);
  state.pageCache = {};
  app.innerHTML = document.getElementById("reader-template").innerHTML;
  attachReaderControls();
  ensureReaderSelectionListeners();
  drawReaderPage();
}

function attachReaderControls() {
  document.getElementById("reader-back").href = `#/books/${state.currentBook.id}`;
  document.querySelectorAll("[data-reader-panel]").forEach((button) => {
    button.addEventListener("click", () => toggleReaderPanel(button.dataset.readerPanel));
  });
  const surface = document.getElementById("reader-surface");
  surface.addEventListener("touchstart", handleTouchStart, { passive: true });
  surface.addEventListener("touchend", handleTouchEnd, { passive: true });
  document.querySelectorAll("[data-hotzone]").forEach((zone) => {
    zone.addEventListener("click", () => stepReaderPage(zone.dataset.hotzone === "next" ? 1 : -1));
  });
  document.getElementById("reader-progress-range").addEventListener("input", handleProgressJump);
}

function ensureReaderSelectionListeners() {
  if (state.selectionListenersBound) {
    return;
  }
  document.addEventListener("selectionchange", () => {
    if (route().name !== "reader") {
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      if (state.pendingSelection?.source === "selection") {
        clearPendingSelection(false);
      }
      return;
    }
  });
  state.selectionListenersBound = true;
}

function currentChapter() {
  return state.currentBook?.chapters?.[state.currentChapterIndex];
}

function getCurrentPages() {
  const chapter = currentChapter();
  if (!chapter) {
    return [];
  }
  const cacheKey = `${state.currentBook.id}:${state.currentChapterIndex}:${readerViewportSignature()}`;
  if (!state.pageCache[cacheKey]) {
    state.pageCache = { [cacheKey]: paginateChapter(chapter, getReaderMetrics()) };
  }
  return state.pageCache[cacheKey];
}

function drawReaderPage() {
  const chapter = currentChapter();
  if (!chapter) {
    return;
  }
  state.currentPages = getCurrentPages();
  state.currentPageCount = Math.max(1, state.currentPages.length);
  state.currentPageIndex = clamp(state.currentPageIndex, 0, state.currentPageCount - 1);
  const page = state.currentPages[state.currentPageIndex];
  const surface = document.getElementById("reader-surface");
  const content = document.getElementById("reader-content");
  surface.className = `reader-surface theme-${state.theme}`;

  content.innerHTML = renderReaderPageMarkup(chapter, page);
  bindSelectionSurface();
  applyHighlights(content, currentPageThreads(page), page);
  renderReaderProgress();
  renderReaderPanel();
  scheduleProgressSync();
}

function renderReaderPageMarkup(chapter, page) {
  const fragmentsHtml = page.fragments
    .map(
      (fragment, index) => `
        <p
          class="reader-page-fragment"
          data-fragment-start="${fragment.startOffset}"
          data-fragment-end="${fragment.endOffset}"
          data-fragment-index="${index}"
        >${escapeHtml(fragment.text)}</p>
      `
    )
    .join("");

  return `
    <section class="reader-page-card">
      <header class="reader-page-head">
        <span class="eyebrow">第 ${state.currentChapterIndex + 1} 章</span>
        <h1>${escapeHtml(chapter.title)}</h1>
        <small>第 ${state.currentPageIndex + 1} / ${state.currentPageCount} 页</small>
      </header>
      <div class="reader-page-body" id="reader-page-body">${fragmentsHtml}</div>
    </section>
  `;
}

function bindSelectionSurface() {
  const body = document.getElementById("reader-page-body");
  if (!body) {
    return;
  }
  ["mouseup", "touchend", "pointerup"].forEach((eventName) => {
    body.addEventListener(eventName, queueSelectionCapture, { passive: true });
  });
}

function queueSelectionCapture() {
  if (state.selectionCaptureTimer) {
    clearTimeout(state.selectionCaptureTimer);
  }
  state.selectionCaptureTimer = window.setTimeout(captureSelection, 180);
}

function captureSelection() {
  if (route().name !== "reader") {
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    state.touchSelectionActive = false;
    return;
  }
  const range = selection.getRangeAt(0);
  const body = document.getElementById("reader-page-body");
  if (!body || !body.contains(range.commonAncestorContainer)) {
    return;
  }
  const startOffset = absoluteOffsetFromNode(range.startContainer, range.startOffset);
  const endOffset = absoluteOffsetFromNode(range.endContainer, range.endOffset);
  if (startOffset == null || endOffset == null || startOffset === endOffset) {
    return;
  }
  const quote = selection.toString().trim();
  if (!quote || quote.length < 2) {
    state.touchSelectionActive = false;
    return;
  }
  state.touchSelectionActive = true;
  state.pendingSelection = {
    source: "selection",
    chapterIndex: state.currentChapterIndex,
    startOffset: Math.min(startOffset, endOffset),
    endOffset: Math.max(startOffset, endOffset),
    quote,
  };
  state.noteDraft = "";
  state.activeReaderPanel = null;
  renderReaderPanel();
}

function absoluteOffsetFromNode(node, offset) {
  const element =
    node.nodeType === Node.ELEMENT_NODE ? node.closest?.("[data-fragment-start]") : node.parentElement?.closest?.("[data-fragment-start]");
  if (!element) {
    return null;
  }
  let total = Number(element.dataset.fragmentStart || 0);
  if (node.nodeType === Node.ELEMENT_NODE) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let childIndex = 0;
    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      while (node.childNodes[childIndex] && !node.childNodes[childIndex].contains?.(textNode) && node.childNodes[childIndex] !== textNode) {
        childIndex += 1;
      }
      if (childIndex >= offset) {
        return total;
      }
      total += textNode.nodeValue.length;
    }
    return total;
  }
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    if (textNode === node) {
      return total + offset;
    }
    total += textNode.nodeValue.length;
  }
  return total;
}

function currentPageThreads(page) {
  return state.currentThreads.filter((thread) => {
    if (thread.highlight.chapterIndex !== state.currentChapterIndex) {
      return false;
    }
    return thread.highlight.endOffset > page.startOffset && thread.highlight.startOffset < page.endOffset;
  });
}

function applyHighlights(container, threads, page) {
  const sortedThreads = [...threads].sort((left, right) => right.highlight.startOffset - left.highlight.startOffset);
  sortedThreads.forEach((thread) => {
    container.querySelectorAll("[data-fragment-start]").forEach((fragmentElement) => {
      const fragmentStart = Number(fragmentElement.dataset.fragmentStart);
      const fragmentEnd = Number(fragmentElement.dataset.fragmentEnd);
      const localStart = Math.max(thread.highlight.startOffset, fragmentStart);
      const localEnd = Math.min(thread.highlight.endOffset, fragmentEnd);
      if (localEnd <= localStart) {
        return;
      }
      wrapTextRange(
        fragmentElement,
        localStart - fragmentStart,
        localEnd - fragmentStart,
        thread.highlight.color,
        (thread.annotation?.userId || thread.highlight.userId) === state.activeUserId,
        Boolean(thread.annotation)
      );
    });
  });
}

function wrapTextRange(root, start, end, color, isPrimary, hasNote) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = 0;
  const segments = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const next = current + node.nodeValue.length;
    if (end <= current) {
      break;
    }
    if (start < next && end > current) {
      segments.push({
        node,
        start: Math.max(0, start - current),
        end: Math.min(node.nodeValue.length, end - current),
      });
    }
    current = next;
  }

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const range = document.createRange();
    range.setStart(segment.node, segment.start);
    range.setEnd(segment.node, segment.end);
    const mark = document.createElement("mark");
    mark.className = `reader-highlight ${hasNote ? "has-note" : "highlight-only"} ${isPrimary ? "is-primary" : ""}`;
    mark.style.backgroundColor = `${color}${isPrimary ? "99" : "4d"}`;
    try {
      range.surroundContents(mark);
    } catch {
      const fragment = range.extractContents();
      mark.appendChild(fragment);
      range.insertNode(mark);
    }
  }
}

function renderReaderProgress() {
  const me = activeUser();
  const partner = partnerUser();
  const myProgress = (state.currentBook.progress || []).find((item) => item.userId === me.id);
  const partnerProgress = (state.currentBook.progress || []).find((item) => item.userId === partner.id);
  const currentPercent = computeCurrentPercent();
  const progressRange = document.getElementById("reader-progress-range");
  progressRange.value = String(Math.round(currentPercent));
  document.getElementById("reader-progress-value").textContent = `${Math.round(currentPercent)}%`;
  document.getElementById("reader-progress-markers").innerHTML = `
    <button class="progress-avatar is-primary" style="left:${currentPercent}%;" title="${escapeHtml(me.name)}">
      ${avatarMarkup(me)}
    </button>
    <button class="progress-avatar" style="left:${Math.round(partnerProgress?.progressPercent || 0)}%;" title="${escapeHtml(partner.name)}">
      ${avatarMarkup(partner)}
    </button>
  `;
  document.getElementById("reader-progress-meta").innerHTML = `
    <span>${escapeHtml(progressChapter(state.currentBook, myProgress))}</span>
    <span>${escapeHtml(partner.name)} ${Math.round(partnerProgress?.progressPercent || 0)}%</span>
  `;
}

function renderReaderPanel() {
  const panelRoot = document.getElementById("reader-panel-root");
  panelRoot.classList.toggle("is-open", Boolean(state.activeReaderPanel || state.pendingSelection));
  if (state.pendingSelection) {
    panelRoot.innerHTML = renderSelectionSheet();
    bindSelectionSheet();
    return;
  }
  if (!state.activeReaderPanel) {
    panelRoot.innerHTML = "";
    return;
  }
  if (state.activeReaderPanel === "toc") {
    panelRoot.innerHTML = renderTocSheet();
    bindTocSheet();
    return;
  }
  if (state.activeReaderPanel === "notes") {
    panelRoot.innerHTML = renderNotesSheet();
    bindNotesSheet();
    return;
  }
  panelRoot.innerHTML = renderSettingsSheet();
  bindSettingsSheet();
}

function toggleReaderPanel(panelName) {
  clearPendingSelection();
  state.activeReaderPanel = state.activeReaderPanel === panelName ? null : panelName;
  renderReaderPanel();
}

function renderSelectionSheet() {
  const isExistingHighlight = Boolean(state.pendingSelection.highlightId);
  return `
    <div class="reader-sheet">
      <div class="sheet-head">
        <strong>${isExistingHighlight ? "补写批注" : "保存标注"}</strong>
        <button class="small-button" data-close-sheet="true">关闭</button>
      </div>
      <p class="quote-text">${escapeHtml(state.pendingSelection.quote)}</p>
      <textarea id="note-draft" placeholder="${isExistingHighlight ? "写下这条高亮的想法..." : "如果想写批注，可以直接输入内容..."}">${escapeHtml(state.noteDraft)}</textarea>
      <div class="selection-actions">
        ${
          isExistingHighlight
            ? ""
            : '<button class="secondary-button" id="save-highlight-only">仅高亮</button>'
        }
        <button class="primary-button" id="save-note">${isExistingHighlight ? "保存批注" : "高亮并写批注"}</button>
      </div>
    </div>
  `;
}

function bindSelectionSheet() {
  document.querySelector("[data-close-sheet]")?.addEventListener("click", () => clearPendingSelection());
  document.getElementById("note-draft")?.addEventListener("input", (event) => {
    state.noteDraft = event.target.value;
  });
  document.getElementById("save-highlight-only")?.addEventListener("click", saveHighlightOnly);
  document.getElementById("save-note")?.addEventListener("click", saveAnnotation);
}

function renderTocSheet() {
  return `
    <div class="reader-sheet">
      <div class="sheet-head">
        <strong>目录</strong>
        <button class="small-button" data-close-sheet="true">关闭</button>
      </div>
      <div class="toc-list">
        ${state.currentBook.chapters
          .map(
            (chapter, index) => `
              <button class="toc-item ${index === state.currentChapterIndex ? "is-active" : ""}" data-chapter-index="${index}">
                <span>第 ${index + 1} 章</span>
                <strong>${escapeHtml(chapter.title)}</strong>
              </button>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function bindTocSheet() {
  document.querySelector("[data-close-sheet]")?.addEventListener("click", () => {
    state.activeReaderPanel = null;
    renderReaderPanel();
  });
  document.querySelectorAll("[data-chapter-index]").forEach((button) => {
    button.addEventListener("click", () => jumpToChapter(Number(button.dataset.chapterIndex), 0));
  });
}

function renderNotesSheet() {
  return `
    <div class="reader-sheet">
      <div class="sheet-head">
        <strong>标注与互动</strong>
        <button class="small-button" data-close-sheet="true">关闭</button>
      </div>
      <div class="thread-stack">
        ${
          state.currentThreads.length
            ? state.currentThreads.map((thread) => renderThreadCard(thread, state.activeUserId, true)).join("")
            : '<p class="muted-text">还没有标注，先在正文里选一句你们想留下来的内容吧。</p>'
        }
      </div>
    </div>
  `;
}

function bindNotesSheet() {
  document.querySelector("[data-close-sheet]")?.addEventListener("click", () => {
    state.activeReaderPanel = null;
    renderReaderPanel();
  });
  document.querySelectorAll("[data-comment-annotation]").forEach((button) => {
    const annotationId = button.dataset.commentAnnotation;
    document.querySelector(`[data-comment-input="${annotationId}"]`)?.addEventListener("input", (event) => {
      state.commentDrafts[annotationId] = event.target.value;
    });
    button.addEventListener("click", async () => {
      const body = (state.commentDrafts[annotationId] || "").trim();
      if (!body) {
        return;
      }
      await api("/api/comments", {
        method: "POST",
        body: JSON.stringify({
          annotationId,
          bookId: state.currentBook.id,
          userId: state.activeUserId,
          body,
        }),
      });
      state.commentDrafts[annotationId] = "";
      await refreshThreads();
      renderReaderPanel();
    });
  });
  document.querySelectorAll("[data-note-highlight]").forEach((button) => {
    const highlightId = button.dataset.noteHighlight;
    button.addEventListener("click", () => {
      const thread = state.currentThreads.find((item) => item.highlight.id === highlightId);
      if (!thread) {
        return;
      }
      state.pendingSelection = {
        source: "highlight",
        highlightId: thread.highlight.id,
        chapterIndex: thread.highlight.chapterIndex,
        startOffset: thread.highlight.startOffset,
        endOffset: thread.highlight.endOffset,
        quote: thread.highlight.quote,
      };
      state.noteDraft = "";
      state.activeReaderPanel = null;
      renderReaderPanel();
    });
  });
}

function renderSettingsSheet() {
  const me = activeUser();
  return `
    <div class="reader-sheet">
      <div class="sheet-head">
        <strong>阅读设置</strong>
        <button class="small-button" data-close-sheet="true">关闭</button>
      </div>
      <div class="toolbar-group">
        <button class="small-button ${state.theme === "paper" ? "is-active" : ""}" data-theme="paper">纸感</button>
        <button class="small-button ${state.theme === "night" ? "is-active" : ""}" data-theme="night">夜读</button>
        <button class="small-button ${state.theme === "forest" ? "is-active" : ""}" data-theme="forest">林间</button>
      </div>
      <div class="profile-editor">
        <div class="profile-preview">
          ${avatarMarkup(me, "avatar-large")}
          <div>
            <strong>${escapeHtml(me.name)}</strong>
            <small>用于进度条和标注归属显示</small>
          </div>
        </div>
        <label class="profile-field">
          <span>昵称</span>
          <input id="profile-name-input-sheet" value="${escapeHtml(me.name)}" />
        </label>
        <label class="profile-field">
          <span>头像</span>
          <input id="profile-avatar-input-sheet" type="file" accept="image/*" />
        </label>
        <button class="primary-button" id="profile-save-sheet">保存个人信息</button>
      </div>
    </div>
  `;
}

function bindSettingsSheet() {
  document.querySelector("[data-close-sheet]")?.addEventListener("click", () => {
    state.activeReaderPanel = null;
    renderReaderPanel();
  });
  document.querySelectorAll(".reader-sheet [data-theme]").forEach((button) => {
    button.addEventListener("click", () => {
      state.theme = button.dataset.theme;
      drawReaderPage();
    });
  });
  document.getElementById("profile-avatar-input-sheet")?.addEventListener("change", handleAvatarPick);
  document.getElementById("profile-save-sheet")?.addEventListener("click", saveProfile);
}

async function refreshThreads() {
  state.currentThreads = (await api(`/api/books/${state.currentBook.id}/threads`)).threads;
}

async function refreshBookSummary(bookId) {
  const detail = await api(`/api/books/${bookId}`);
  const existingIndex = state.books.findIndex((book) => book.id === bookId);
  if (existingIndex >= 0) {
    state.books[existingIndex] = { ...state.books[existingIndex], ...detail };
  }
  if (state.currentBook && state.currentBook.id === bookId) {
    state.currentBook = { ...state.currentBook, ...detail, chapters: state.currentBook.chapters };
  }
}

async function uploadBook(event) {
  const file = event.target.files[0];
  if (!file) {
    return;
  }
  const formData = new FormData();
  formData.set("file", file);
  formData.set("uploadedBy", state.activeUserId);
  const uploadLabel = document.getElementById("upload-label");
  uploadLabel.textContent = "正在导入 EPUB...";
  try {
    const response = await fetch("/api/books/upload", { method: "POST", body: formData });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "上传失败");
    }
    state.books = [payload.book, ...state.books.filter((book) => book.id !== payload.book.id)];
    navigateTo(`#/books/${payload.book.id}`);
  } catch (error) {
    alert(error.message);
  } finally {
    uploadLabel.textContent = "上传 EPUB 到共享书架";
    event.target.value = "";
  }
}

async function saveHighlightOnly() {
  if (!state.pendingSelection) {
    return;
  }
  await api("/api/highlights", {
    method: "POST",
    body: JSON.stringify({
      bookId: state.currentBook.id,
      userId: state.activeUserId,
      chapterIndex: state.pendingSelection.chapterIndex,
      startOffset: state.pendingSelection.startOffset,
      endOffset: state.pendingSelection.endOffset,
      quote: state.pendingSelection.quote,
      color: activeUser().accent,
    }),
  });
  clearPendingSelection();
  await refreshThreads();
  await refreshBookSummary(state.currentBook.id);
  drawReaderPage();
}

async function saveAnnotation() {
  if (!state.pendingSelection) {
    return;
  }
  if (!state.noteDraft.trim()) {
    alert("先写一点批注内容再保存。");
    return;
  }
  const payload = {
    bookId: state.currentBook.id,
    userId: state.activeUserId,
    body: state.noteDraft.trim(),
  };
  if (state.pendingSelection.highlightId) {
    payload.highlightId = state.pendingSelection.highlightId;
  } else {
    payload.chapterIndex = state.pendingSelection.chapterIndex;
    payload.startOffset = state.pendingSelection.startOffset;
    payload.endOffset = state.pendingSelection.endOffset;
    payload.quote = state.pendingSelection.quote;
    payload.color = activeUser().accent;
  }
  await api("/api/annotations", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  clearPendingSelection();
  await refreshThreads();
  await refreshBookSummary(state.currentBook.id);
  drawReaderPage();
}

function clearPendingSelection(shouldRender = true) {
  state.pendingSelection = null;
  state.noteDraft = "";
  state.touchSelectionActive = false;
  try {
    window.getSelection()?.removeAllRanges();
  } catch {}
  if (shouldRender && route().name === "reader") {
    renderReaderPanel();
  }
}

function scheduleProgressSync() {
  if (state.scrollSyncTimer) {
    clearTimeout(state.scrollSyncTimer);
  }
  state.scrollSyncTimer = setTimeout(syncProgress, 80);
}

async function syncProgress() {
  if (!state.currentBook) {
    return;
  }
  const chapterProgress = state.currentPageCount <= 1 ? 1 : state.currentPageIndex / Math.max(1, state.currentPageCount - 1);
  const progressPercent = computeCurrentPercent();
  const response = await api("/api/progress", {
    method: "POST",
    body: JSON.stringify({
      bookId: state.currentBook.id,
      userId: state.activeUserId,
      chapterIndex: state.currentChapterIndex,
      pageIndex: state.currentPageIndex,
      pageCount: state.currentPageCount,
      chapterProgress,
      progressPercent,
    }),
  });
  const nextProgress = response.progress;
  const remaining = (state.currentBook.progress || []).filter((item) => item.userId !== state.activeUserId);
  state.currentBook.progress = [...remaining, nextProgress];
  const summaryBook = state.books.find((item) => item.id === state.currentBook.id);
  if (summaryBook) {
    summaryBook.progress = [...(summaryBook.progress || []).filter((item) => item.userId !== state.activeUserId), nextProgress];
  }
  renderReaderProgress();
}

function computeCurrentPercent() {
  const chapterCount = Math.max(1, state.currentBook?.chapters?.length || 1);
  const chapterShare = state.currentChapterIndex / chapterCount;
  const withinChapter = state.currentPageCount <= 1 ? 1 : state.currentPageIndex / Math.max(1, state.currentPageCount - 1);
  return Math.min(100, Math.max(0, Math.round((chapterShare + withinChapter / chapterCount) * 100)));
}

function stepReaderPage(step) {
  const target = state.currentPageIndex + step;
  if (target < 0) {
    jumpToChapter(state.currentChapterIndex - 1, 1);
    return;
  }
  if (target >= state.currentPageCount) {
    jumpToChapter(state.currentChapterIndex + 1, 0);
    return;
  }
  state.currentPageIndex = target;
  clearPendingSelection(false);
  drawReaderPage();
}

function jumpToChapter(chapterIndex, pageFraction = 0) {
  const nextChapter = clamp(chapterIndex, 0, state.currentBook.chapters.length - 1);
  state.currentChapterIndex = nextChapter;
  state.currentPages = getCurrentPages();
  state.currentPageCount = Math.max(1, state.currentPages.length);
  state.currentPageIndex = clamp(Math.round(pageFraction * Math.max(0, state.currentPageCount - 1)), 0, state.currentPageCount - 1);
  clearPendingSelection(false);
  state.activeReaderPanel = null;
  drawReaderPage();
}

function handleProgressJump(event) {
  const percent = Number(event.target.value);
  const chapterCount = Math.max(1, state.currentBook.chapters.length);
  const overall = Math.min(chapterCount - 0.001, (percent / 100) * chapterCount);
  const chapterIndex = Math.floor(overall);
  const within = overall - chapterIndex;
  jumpToChapter(chapterIndex, within);
}

function handleTouchStart(event) {
  const touch = event.changedTouches?.[0];
  if (!touch) {
    return;
  }
  state.touchStart = {
    x: touch.clientX,
    y: touch.clientY,
    startedInPageBody: Boolean(event.target?.closest?.("#reader-page-body")),
    startedAt: Date.now(),
  };
}

function handleTouchEnd(event) {
  const touch = event.changedTouches?.[0];
  if (!touch || !state.touchStart) {
    return;
  }
  const selectedText = window.getSelection?.()?.toString().trim() || "";
  if (state.pendingSelection || state.touchSelectionActive || selectedText.length >= 2) {
    queueSelectionCapture();
    state.touchStart = null;
    return;
  }
  const dx = touch.clientX - state.touchStart.x;
  const dy = touch.clientY - state.touchStart.y;
  const duration = Date.now() - state.touchStart.startedAt;
  if (state.touchStart.startedInPageBody && duration > 180) {
    state.touchStart = null;
    return;
  }
  if (state.touchStart.startedInPageBody && Math.abs(dx) < 24 && Math.abs(dy) < 24) {
    state.touchStart = null;
    return;
  }
  if (state.touchStart.startedInPageBody && Math.abs(dx) < 72) {
    state.touchStart = null;
    return;
  }
  if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy)) {
    stepReaderPage(dx < 0 ? 1 : -1);
  }
  state.touchStart = null;
}

function handleViewportResize() {
  if (route().name !== "reader" || !state.currentBook) {
    return;
  }
  const pageFraction = state.currentPageCount <= 1 ? 0 : state.currentPageIndex / Math.max(1, state.currentPageCount - 1);
  state.pageCache = {};
  state.currentPages = getCurrentPages();
  state.currentPageCount = Math.max(1, state.currentPages.length);
  state.currentPageIndex = clamp(Math.round(pageFraction * Math.max(0, state.currentPageCount - 1)), 0, state.currentPageCount - 1);
  drawReaderPage();
}

async function handleAvatarPick(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  state.pendingAvatarDataUrl = await readFileAsDataUrl(file);
}

async function saveProfile() {
  const input = document.getElementById("profile-name-input-sheet");
  const response = await api(`/api/users/${state.activeUserId}`, {
    method: "POST",
    body: JSON.stringify({
      name: input?.value || activeUser().name,
      avatarUrl: state.pendingAvatarDataUrl ?? activeUser().avatarUrl ?? null,
    }),
  });
  const updated = response.user;
  state.users = state.users.map((user) => (user.id === updated.id ? updated : user));
  state.pendingAvatarDataUrl = null;
  renderUserSwitcher();
  if (route().name === "reader") {
    renderReaderPanel();
    renderReaderProgress();
  } else {
    render();
  }
}

function renderThreadCard(thread, primaryUserId, showComposer) {
  const ownerId = thread.annotation?.userId || thread.highlight.userId;
  const owner = state.users.find((user) => user.id === ownerId) || { name: "成员" };
  const chapterTitle = chapterName(thread.highlight.chapterIndex);
  const isPrimary = ownerId === primaryUserId;
  const hasNote = Boolean(thread.annotation);
  return `
    <article class="thread-card ${isPrimary ? "is-primary" : ""} ${hasNote ? "" : "thread-highlight-only"}">
      <div class="thread-head">
        <span>${avatarMarkup(owner, "avatar-inline")}${escapeHtml(owner.name)}</span>
        <small>${formatTime((thread.annotation || thread.highlight).createdAt)}</small>
      </div>
      <p class="quote-text">${escapeHtml(thread.highlight.quote)}</p>
      ${
        hasNote
          ? `<p>${escapeHtml(thread.annotation.body)}</p>`
          : '<p class="muted-text">这是一条仅高亮标注，还没有批注内容。</p>'
      }
      <small>${escapeHtml(chapterTitle)} · ${hasNote ? `${thread.comments.length} 条评论` : "仅高亮"}</small>
      ${
        hasNote
          ? `
            <div class="comment-list">
              ${thread.comments
                .map((comment) => {
                  const commentOwner = state.users.find((user) => user.id === comment.userId) || { name: "成员" };
                  return `<div class="comment-item"><strong>${avatarMarkup(commentOwner, "avatar-inline")} ${escapeHtml(commentOwner.name)}</strong><p>${escapeHtml(comment.body)}</p></div>`;
                })
                .join("")}
            </div>
          `
          : ""
      }
      ${
        showComposer
          ? hasNote
            ? `<div class="comment-composer">
                 <input data-comment-input="${thread.annotation.id}" placeholder="继续聊聊这段内容..." value="${escapeHtml(state.commentDrafts[thread.annotation.id] || "")}" />
                 <button class="secondary-button ${isPrimary ? "is-primary" : ""}" data-comment-annotation="${thread.annotation.id}">评论</button>
               </div>`
            : `<button class="secondary-button ${isPrimary ? "is-primary" : ""}" data-note-highlight="${thread.highlight.id}">补写批注</button>`
          : ""
      }
    </article>
  `;
}

async function startEventLoop() {
  while (true) {
    try {
      const response = await api(`/api/events?lastEventId=${state.lastEventId}`);
      for (const event of response.events) {
        state.lastEventId = event.id;
        handleEvent(event);
      }
    } catch {
      await delay(1500);
    }
  }
}

function handleEvent(event) {
  if (event.type === "book.created") {
    const exists = state.books.some((book) => book.id === event.payload.book.id);
    if (!exists) {
      state.books.unshift(event.payload.book);
    }
  }
  if (event.type === "user.updated") {
    state.users = state.users.map((user) => (user.id === event.payload.user.id ? event.payload.user : user));
    renderUserSwitcher();
    if (route().name === "reader") {
      renderReaderPanel();
      renderReaderProgress();
    }
  }
  if (event.type === "progress.updated") {
    const book = state.books.find((item) => item.id === event.payload.bookId);
    if (book) {
      const remaining = (book.progress || []).filter((item) => item.userId !== event.payload.progress.userId);
      book.progress = [...remaining, event.payload.progress];
    }
    if (state.currentBook && state.currentBook.id === event.payload.bookId) {
      const remaining = (state.currentBook.progress || []).filter((item) => item.userId !== event.payload.progress.userId);
      state.currentBook.progress = [...remaining, event.payload.progress];
      if (route().name === "reader") {
        renderReaderProgress();
      }
    }
  }
  if (event.type === "highlight.created" || event.type === "annotation.created" || event.type === "comment.created") {
    refreshBookSummary(event.payload.bookId).then(() => {
      if (state.currentBook && state.currentBook.id === event.payload.bookId) {
        refreshThreads().then(() => {
          if (route().name === "reader") {
            drawReaderPage();
          } else if (route().name === "detail") {
            renderDetail(state.currentBook.id);
          }
        });
      } else if (route().name === "home") {
        renderHome();
      }
    });
  }
  if (route().name === "home") {
    renderHome();
  }
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
}

function progressChapter(book, progress) {
  if (!progress || progress.chapterIndex == null) {
    return "还没开始阅读";
  }
  return book.chapters?.[progress.chapterIndex]?.title || `第 ${progress.chapterIndex + 1} 章`;
}

function chapterName(index) {
  if (index == null || !state.currentBook?.chapters?.[index]) {
    return "还没开始阅读";
  }
  return state.currentBook.chapters[index].title;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readerViewportSignature() {
  const metrics = getReaderMetrics();
  return `${metrics.width}x${metrics.height}`;
}

function getReaderMetrics() {
  const surface = document.getElementById("reader-surface");
  const width = Math.min(760, Math.max(260, (surface?.clientWidth || window.innerWidth) - 40));
  const height = Math.max(320, window.innerHeight - 74 - 124 - 44);
  return { width, height };
}

function paginateChapter(chapter, metrics) {
  const fragments = extractParagraphs(chapter.plainText || "");
  if (!fragments.length) {
    return [{ startOffset: 0, endOffset: 0, fragments: [{ text: "", startOffset: 0, endOffset: 0 }] }];
  }
  const pages = [];
  let pageFragments = [];
  const maxCharsPerPage = estimateCharsPerPage(metrics);
  let currentChars = 0;

  function pushPage() {
    if (!pageFragments.length) {
      return;
    }
    pages.push({
      startOffset: pageFragments[0].startOffset,
      endOffset: pageFragments[pageFragments.length - 1].endOffset,
      fragments: pageFragments,
    });
    pageFragments = [];
  }

  fragments.forEach((fragment) => {
    let remainingText = fragment.text;
    let remainingStart = fragment.startOffset;
    while (remainingText.length) {
      const normalizedLength = Math.max(1, remainingText.length);
      if (currentChars + normalizedLength <= maxCharsPerPage) {
        pageFragments.push({
          text: remainingText,
          startOffset: remainingStart,
          endOffset: remainingStart + remainingText.length,
        });
        currentChars += normalizedLength + 1;
        remainingText = "";
        continue;
      }
      const available = Math.max(80, maxCharsPerPage - currentChars);
      if (available <= 80 && pageFragments.length) {
        pushPage();
        currentChars = 0;
        continue;
      }
      const chosenLength = normalizeSliceLength(remainingText, Math.min(remainingText.length, available));
      const sliceText = remainingText.slice(0, chosenLength);
      pageFragments.push({
        text: sliceText,
        startOffset: remainingStart,
        endOffset: remainingStart + sliceText.length,
      });
      currentChars += sliceText.length + 1;
      pushPage();
      currentChars = 0;
      const trimmed = trimLeadingWhitespace(remainingText.slice(chosenLength));
      remainingStart += chosenLength + trimmed.trimmedCount;
      remainingText = trimmed.text;
    }
  });
  pushPage();
  return pages.length ? pages : [{ startOffset: 0, endOffset: 0, fragments: [] }];
}

function extractParagraphs(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const blocks = [];
  const pattern = /[\s\S]*?(?:\n\s*\n|$)/g;
  let match;
  while ((match = pattern.exec(normalized))) {
    if (!match[0]) {
      break;
    }
    const raw = match[0].replace(/\n\s*\n$/, "");
    const leading = raw.match(/^\s*/)?.[0].length || 0;
    const trailing = raw.match(/\s*$/)?.[0].length || 0;
    const textValue = raw.slice(leading, Math.max(leading, raw.length - trailing));
    if (!textValue) {
      continue;
    }
    const startOffset = match.index + leading;
    blocks.push({
      text: textValue,
      startOffset,
      endOffset: startOffset + textValue.length,
    });
  }
  return blocks;
}

function estimateCharsPerPage(metrics) {
  const charsPerLine = Math.max(12, Math.floor(metrics.width / 18));
  const lineHeight = 31;
  const usableHeight = Math.max(220, metrics.height - 84);
  const lineCount = Math.max(8, Math.floor(usableHeight / lineHeight));
  return charsPerLine * lineCount;
}

function normalizeSliceLength(text, length) {
  const start = Math.max(1, length - 24);
  for (let index = length; index >= start; index -= 1) {
    if (/[\s，。！？；、,.!?;:]/.test(text[index] || "")) {
      return index + 1;
    }
  }
  return Math.max(1, length);
}

function trimLeadingWhitespace(text) {
  const match = text.match(/^\s*/)?.[0] || "";
  return { text: text.slice(match.length), trimmedCount: match.length };
}
