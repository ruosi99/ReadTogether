const state = {
  activeUserId: "you",
  users: [],
  books: [],
  currentBook: null,
  currentChapter: null,
  currentThreads: [],
  currentChapterIndex: 0,
  currentPageIndex: 0,
  currentPageCount: 1,
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
  chapterCache: {},
  scrollSyncTimer: null,
};

const app = document.getElementById("app");
const userSwitcher = document.getElementById("user-switcher");

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

function safeRender() {
  render().catch((error) => {
    console.error(error);
    app.innerHTML = `
      <section class="page-grid">
        <div class="empty-card">
          <h3>打开页面时出了点问题</h3>
          <p>${escapeHtml(error?.message || "未知错误")}</p>
          <button class="primary-button" id="retry-render">重新加载</button>
        </div>
      </section>
    `;
    document.getElementById("retry-render")?.addEventListener("click", safeRender);
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

function renderUserSwitcher() {
  userSwitcher.innerHTML = "";
  state.users.forEach((user) => {
    const button = document.createElement("button");
    button.className = `user-chip ${user.id === state.activeUserId ? "is-active" : ""}`;
    button.innerHTML = `${avatarMarkup(user, "avatar-small")}<span>${escapeHtml(user.name)}</span>`;
    button.addEventListener("click", async () => {
      state.activeUserId = user.id;
      clearPendingSelection(false);
      state.activeReaderPanel = null;
      renderUserSwitcher();
      if (route().name === "reader" && state.currentBook) {
        const progress = findProgress(state.currentBook, state.activeUserId);
        await loadCurrentChapter(progress?.chapterIndex || 0, progress?.pageIndex || 0);
      } else {
        safeRender();
      }
    });
    userSwitcher.appendChild(button);
  });
}

async function render() {
  const currentRoute = route();
  document.body.classList.toggle("reader-mode", currentRoute.name === "reader");
  if (currentRoute.name !== "reader") {
    clearPendingSelection(false);
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

  document.getElementById("summary-grid").innerHTML = [
    renderPerspectiveSummary(me, true),
    renderPerspectiveSummary(partner, false),
  ].join("");

  const bookGrid = document.getElementById("book-grid");
  if (!state.books.length) {
    bookGrid.innerHTML = `
      <div class="empty-card">
        <h3>先上传第一本书</h3>
        <p>上传 EPUB 后，你们就可以一起阅读、标注、评论和同步进度。</p>
      </div>
    `;
  } else {
    bookGrid.innerHTML = state.books.map((book) => renderBookCard(book, me, partner)).join("");
  }
  document.getElementById("book-upload")?.addEventListener("change", uploadBook);
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
  const myProgress = findProgress(book, me.id);
  const otherProgress = findProgress(book, partner.id);
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
            <small>${escapeHtml(progressChapter(book, myProgress))}</small>
          </div>
          <div class="progress-panel">
            <span>${escapeHtml(partner.name)}</span>
            <strong>${Math.round(otherProgress?.progressPercent || 0)}%</strong>
            <small>${escapeHtml(progressChapter(book, otherProgress))}</small>
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
  const other = partnerUser();

  app.innerHTML = document.getElementById("detail-template").innerHTML;
  document.getElementById("detail-cover-text").textContent = state.currentBook.title.slice(0, 2);
  document.getElementById("detail-title").textContent = state.currentBook.title;
  document.getElementById("detail-author").textContent = state.currentBook.author;
  document.getElementById("detail-uploaded-at").textContent = `上传时间：${formatTime(state.currentBook.uploadedAt)}`;

  const readHref = `#/books/${bookId}/read`;
  const readLink = document.getElementById("read-link");
  readLink.href = readHref;
  readLink.textContent = "开始共读";
  readLink.addEventListener("click", (event) => {
    event.preventDefault();
    navigateTo(readHref);
  });

  document.querySelectorAll("[data-export-user]").forEach((button) => {
    const exportUserId = button.dataset.exportUser;
    const targetUser = state.users.find((user) => user.id === exportUserId) || me;
    button.textContent = `导出${targetUser.name}的笔记`;
    button.classList.toggle("is-primary", exportUserId === me.id);
    button.addEventListener("click", () => {
      window.location.href = `/api/books/${bookId}/export.md?userId=${exportUserId}`;
    });
  });

  const myProgress = findProgress(state.currentBook, me.id);
  const otherProgress = findProgress(state.currentBook, other.id);
  document.getElementById("detail-stats").innerHTML = `
    <article class="stat-card is-primary">
      <span>${escapeHtml(me.name)}的主视角</span>
      <strong>${Math.round(myProgress?.progressPercent || 0)}%</strong>
      <small>${escapeHtml(progressChapter(state.currentBook, myProgress))}</small>
    </article>
    <article class="stat-card">
      <span>${escapeHtml(other.name)}的陪读进度</span>
      <strong>${Math.round(otherProgress?.progressPercent || 0)}%</strong>
      <small>${escapeHtml(progressChapter(state.currentBook, otherProgress))}</small>
    </article>
    <article class="stat-card">
      <span>总标注数</span>
      <strong>${state.currentBook.annotationCount || 0}</strong>
      <small>包含仅高亮和带批注的标注</small>
    </article>
  `;

  const detailThreads = document.getElementById("detail-threads");
  if (!state.currentThreads.length) {
    detailThreads.innerHTML = `
      <div class="empty-card">
        <h3>还没有标注</h3>
        <p>进入阅读器后选中一句内容，就能开始共读互动。</p>
      </div>
    `;
    return;
  }
  detailThreads.innerHTML = state.currentThreads.slice(0, 8).map((thread) => renderThreadCard(thread, me.id, false)).join("");
}

async function renderReader(bookId) {
  state.currentBook = await api(`/api/books/${bookId}`);
  state.currentThreads = (await api(`/api/books/${bookId}/threads`)).threads;
  state.chapterCache = {};

  const currentProgress = findProgress(state.currentBook, state.activeUserId);
  state.currentChapterIndex = currentProgress?.chapterIndex || 0;
  state.currentPageIndex = currentProgress?.pageIndex || 0;
  state.currentPageCount = Math.max(1, currentProgress?.pageCount || 1);
  app.innerHTML = document.getElementById("reader-template").innerHTML;

  attachReaderControls();
  ensureReaderSelectionListeners();
  await loadCurrentChapter(state.currentChapterIndex, state.currentPageIndex);
}

function attachReaderControls() {
  const back = document.getElementById("reader-back");
  if (back) {
    back.href = `#/books/${state.currentBook.id}`;
    back.textContent = "返回";
  }
  document.querySelectorAll("[data-reader-panel]").forEach((button) => {
    if (button.dataset.readerPanel === "toc") {
      button.textContent = "目录";
    }
    if (button.dataset.readerPanel === "notes") {
      button.textContent = "标注";
    }
    if (button.dataset.readerPanel === "settings") {
      button.textContent = "设置";
    }
    button.addEventListener("click", () => toggleReaderPanel(button.dataset.readerPanel));
  });

  const surface = document.getElementById("reader-surface");
  surface?.addEventListener("touchstart", handleTouchStart, { passive: true });
  surface?.addEventListener("touchend", handleTouchEnd, { passive: true });

  document.querySelectorAll("[data-hotzone]").forEach((zone) => {
    zone.addEventListener("click", () => {
      if (window.getSelection?.()?.toString().trim()) {
        return;
      }
      stepReaderPage(zone.dataset.hotzone === "next" ? 1 : -1);
    });
  });

  document.getElementById("reader-progress-range")?.addEventListener("input", handleProgressJump);
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
      state.touchSelectionActive = false;
      return;
    }
    state.touchSelectionActive = true;
  });
  state.selectionListenersBound = true;
}

function currentChapter() {
  return state.currentChapter;
}

async function loadCurrentChapter(chapterIndex, preferredPageIndex = 0) {
  const nextChapterIndex = clamp(chapterIndex, 0, Math.max(0, (state.currentBook?.chapters?.length || 1) - 1));
  state.currentChapterIndex = nextChapterIndex;
  const cacheKey = `${state.currentBook.id}:${nextChapterIndex}`;
  if (!state.chapterCache[cacheKey]) {
    state.chapterCache[cacheKey] = await api(`/api/books/${state.currentBook.id}/chapters/${nextChapterIndex}`);
  }
  state.currentChapter = {
    ...state.chapterCache[cacheKey],
    title: normalizeChapterTitle(state.chapterCache[cacheKey].title, nextChapterIndex),
  };
  state.currentPageIndex = Math.max(0, preferredPageIndex || 0);
  clearPendingSelection(false);
  drawReaderPage();
  await settleChapterPagination();
}

function drawReaderPage() {
  const chapter = currentChapter();
  if (!chapter) {
    return;
  }
  const surface = document.getElementById("reader-surface");
  const content = document.getElementById("reader-content");
  if (!surface || !content) {
    return;
  }
  surface.className = `reader-surface theme-${state.theme}`;
  content.innerHTML = renderReaderPageMarkup(chapter);
  bindSelectionSurface();
  applyHighlights(document.getElementById("reader-page-body"), currentChapterThreads());
  renderReaderProgress();
  renderReaderPanel();
}

function renderReaderPageMarkup(chapter) {
  const title = displayChapterTitle(chapter.title, state.currentChapterIndex);
  return `
    <section class="reader-page-card">
      <header class="reader-page-head">
        <span class="eyebrow">第 ${state.currentChapterIndex + 1} 章</span>
        ${title ? `<h1>${escapeHtml(title)}</h1>` : ""}
        <small>Page ${state.currentPageIndex + 1} / ${state.currentPageCount}</small>
      </header>
      <div class="reader-page-body" id="reader-page-body">
        <div class="reader-page-flow" id="reader-page-flow">${chapter.contentHtml || ""}</div>
      </div>
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

async function settleChapterPagination() {
  await nextFrame();
  const body = document.getElementById("reader-page-body");
  const flow = document.getElementById("reader-page-flow");
  if (!body || !flow) {
    return;
  }

  const bodyWidth = Math.max(1, body.clientWidth);
  const bodyHeight = Math.max(1, body.clientHeight);
  const gap = 24;

  flow.style.setProperty("--reader-page-width", `${bodyWidth}px`);
  flow.style.height = `${bodyHeight}px`;
  flow.style.maxHeight = `${bodyHeight}px`;
  flow.style.minHeight = `${bodyHeight}px`;

  await nextFrame();

  const totalWidth = Math.max(bodyWidth, flow.scrollWidth);
  const computedPageCount = Math.max(1, Math.ceil((totalWidth + gap) / (bodyWidth + gap)));
  state.currentPageCount = computedPageCount;
  state.currentPageIndex = clamp(state.currentPageIndex, 0, computedPageCount - 1);
  flow.style.transform = `translateX(-${state.currentPageIndex * (bodyWidth + gap)}px)`;

  renderReaderProgress();
  renderReaderPanel();
  scheduleProgressSync();
}

function queueSelectionCapture() {
  if (state.selectionCaptureTimer) {
    clearTimeout(state.selectionCaptureTimer);
  }
  state.selectionCaptureTimer = window.setTimeout(captureSelection, 220);
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
  const root = document.getElementById("reader-page-body");
  if (!root) {
    return null;
  }
  let total = 0;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    if (textNode === node) {
      return total + offset;
    }
    total += textNode.nodeValue.length;
  }
  return total;
}

function currentChapterThreads() {
  return state.currentThreads.filter((thread) => thread.highlight.chapterIndex === state.currentChapterIndex);
}

function applyHighlights(container, threads) {
  if (!container) {
    return;
  }
  const sortedThreads = [...threads].sort((left, right) => right.highlight.startOffset - left.highlight.startOffset);
  sortedThreads.forEach((thread) => {
    wrapTextRange(
      container,
      thread.highlight.startOffset,
      thread.highlight.endOffset,
      thread.highlight.color,
      (thread.annotation?.userId || thread.highlight.userId) === state.activeUserId,
      Boolean(thread.annotation),
    );
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
  const other = partnerUser();
  const myProgress = findProgress(state.currentBook, me.id);
  const otherProgress = findProgress(state.currentBook, other.id);
  const currentPercent = computeCurrentPercent();

  const range = document.getElementById("reader-progress-range");
  if (range) {
    range.value = String(Math.round(currentPercent));
  }
  document.getElementById("reader-progress-value").textContent = `${Math.round(currentPercent)}%`;
  document.getElementById("reader-progress-markers").innerHTML = `
    <button class="progress-avatar is-primary" style="left:${currentPercent}%;" title="${escapeHtml(me.name)}">
      ${avatarMarkup(me)}
    </button>
    <button class="progress-avatar" style="left:${Math.round(otherProgress?.progressPercent || 0)}%;" title="${escapeHtml(other.name)}">
      ${avatarMarkup(other)}
    </button>
  `;
  document.getElementById("reader-progress-meta").innerHTML = `
    <span>${escapeHtml(progressChapter(state.currentBook, myProgress))}</span>
    <span>${escapeHtml(other.name)} ${Math.round(otherProgress?.progressPercent || 0)}%</span>
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
  clearPendingSelection(false);
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
      <textarea id="note-draft" placeholder="${isExistingHighlight ? "给这条高亮补一句批注..." : "如果想写批注，可以直接输入内容..."}">${escapeHtml(state.noteDraft)}</textarea>
      <div class="selection-actions">
        ${isExistingHighlight ? "" : '<button class="secondary-button" id="save-highlight-only">仅高亮</button>'}
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
          .map((chapter, index) => {
            const title = normalizeChapterTitle(chapter.title, index);
            return `
              <button class="toc-item ${index === state.currentChapterIndex ? "is-active" : ""}" data-chapter-index="${index}">
                <span>第 ${index + 1} 章</span>
                <strong>${escapeHtml(title)}</strong>
              </button>
            `;
          })
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
    button.addEventListener("click", async () => {
      await jumpToChapter(Number(button.dataset.chapterIndex), 0);
    });
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
            : '<p class="muted-text">还没有标注，先在正文里选一句内容吧。</p>'
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

  document.querySelectorAll("[data-comment-input]").forEach((input) => {
    input.addEventListener("input", (event) => {
      state.commentDrafts[input.dataset.commentInput] = event.target.value;
    });
  });

  document.querySelectorAll("[data-comment-annotation]").forEach((button) => {
    button.addEventListener("click", async () => {
      const annotationId = button.dataset.commentAnnotation;
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
    button.addEventListener("click", () => {
      const thread = state.currentThreads.find((item) => item.highlight.id === button.dataset.noteHighlight);
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
            <small>用于底部进度条和标注归属显示</small>
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
    button.addEventListener("click", async () => {
      state.theme = button.dataset.theme;
      drawReaderPage();
      await settleChapterPagination();
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
  const index = state.books.findIndex((book) => book.id === bookId);
  if (index >= 0) {
    state.books[index] = { ...state.books[index], ...detail };
  }
  if (state.currentBook && state.currentBook.id === bookId) {
    state.currentBook = detail;
  }
}

async function uploadBook(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  const formData = new FormData();
  formData.set("file", file);
  formData.set("uploadedBy", state.activeUserId);
  const uploadLabel = document.getElementById("upload-label");
  if (uploadLabel) {
    uploadLabel.textContent = "正在导入 EPUB...";
  }
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
    if (uploadLabel) {
      uploadLabel.textContent = "上传 EPUB 到共享书架";
    }
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
  state.scrollSyncTimer = window.setTimeout(syncProgress, 80);
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
  shiftReaderPage();
}

async function jumpToChapter(chapterIndex, pageFraction = 0) {
  const nextChapter = clamp(chapterIndex, 0, state.currentBook.chapters.length - 1);
  const fallbackPage = clamp(
    Math.round(pageFraction * Math.max(0, state.currentPageCount - 1)),
    0,
    Math.max(0, state.currentPageCount - 1),
  );
  state.activeReaderPanel = null;
  await loadCurrentChapter(nextChapter, fallbackPage);
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
  const body = document.getElementById("reader-page-body");
  const rect = body?.getBoundingClientRect();
  const leftSafe = rect ? touch.clientX - rect.left <= 56 : false;
  const rightSafe = rect ? rect.right - touch.clientX <= 24 : false;
  state.touchStart = {
    x: touch.clientX,
    y: touch.clientY,
    startedInPageBody: Boolean(event.target?.closest?.("#reader-page-body")),
    startedAt: Date.now(),
    startedNearSelectionEdge: leftSafe,
    startedNearRightEdge: rightSafe,
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

  if (state.touchStart.startedInPageBody) {
    if (state.touchStart.startedNearSelectionEdge) {
      state.touchStart = null;
      return;
    }
    if (duration > 140) {
      state.touchStart = null;
      return;
    }
    if (Math.abs(dy) > Math.abs(dx)) {
      state.touchStart = null;
      return;
    }
    if (Math.abs(dx) < 90) {
      state.touchStart = null;
      return;
    }
  }

  if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.25) {
    stepReaderPage(dx < 0 ? 1 : -1);
  }
  state.touchStart = null;
}

function handleViewportResize() {
  if (route().name !== "reader" || !state.currentBook) {
    return;
  }
  settleChapterPagination();
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
    safeRender();
  }
}

function renderThreadCard(thread, primaryUserId, showComposer) {
  const ownerId = thread.annotation?.userId || thread.highlight.userId;
  const owner = state.users.find((user) => user.id === ownerId) || { name: "成员", accent: "#9b5b3d" };
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
                  const commentOwner = state.users.find((user) => user.id === comment.userId) || { name: "成员", accent: "#9b5b3d" };
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
            ? `
                <div class="comment-composer">
                  <input data-comment-input="${thread.annotation.id}" placeholder="继续聊聊这段内容..." value="${escapeHtml(state.commentDrafts[thread.annotation.id] || "")}" />
                  <button class="secondary-button ${isPrimary ? "is-primary" : ""}" data-comment-annotation="${thread.annotation.id}">评论</button>
                </div>
              `
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
    refreshBookSummary(event.payload.bookId).then(async () => {
      if (state.currentBook && state.currentBook.id === event.payload.bookId) {
        await refreshThreads();
        if (route().name === "reader") {
          drawReaderPage();
        } else if (route().name === "detail") {
          renderDetail(state.currentBook.id);
        }
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

function findProgress(book, userId) {
  return (book?.progress || []).find((item) => item.userId === userId);
}

function progressChapter(book, progress) {
  if (!progress || progress.chapterIndex == null) {
    return "还没开始阅读";
  }
  return chapterTitleFromBook(book, progress.chapterIndex);
}

function chapterName(index) {
  if (index == null) {
    return "还没开始阅读";
  }
  return chapterTitleFromBook(state.currentBook, index);
}

function chapterTitleFromBook(book, index) {
  const rawTitle = book?.chapters?.[index]?.title;
  return normalizeChapterTitle(rawTitle, index);
}

function normalizeChapterTitle(title, chapterIndex) {
  const cleaned = String(title || "").trim();
  if (!cleaned) {
    return `第 ${chapterIndex + 1} 节`;
  }
  const lower = cleaned.toLowerCase();
  if (cleaned === "未知" || cleaned.includes("未命名") || lower === "unknown" || lower === "untitled" || lower === "untitled chapter") {
    return `第 ${chapterIndex + 1} 节`;
  }
  return cleaned;
}

function displayChapterTitle(title, chapterIndex) {
  const cleaned = String(title || "").trim();
  if (!cleaned) {
    return "";
  }
  const normalized = normalizeChapterTitle(cleaned, chapterIndex);
  if (normalized === `第 ${chapterIndex + 1} 节`) {
    return "";
  }
  return normalized;
}

function shiftReaderPage() {
  const body = document.getElementById("reader-page-body");
  const flow = document.getElementById("reader-page-flow");
  if (!body || !flow) {
    return;
  }
  const gap = 24;
  flow.style.transform = `translateX(-${state.currentPageIndex * (body.clientWidth + gap)}px)`;
  renderReaderProgress();
  scheduleProgressSync();
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
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nextFrame() {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function avatarMarkup(user, extraClass = "") {
  if (user?.avatarUrl) {
    return `<span class="avatar ${extraClass}" style="background-image:url('${user.avatarUrl}')"></span>`;
  }
  const fallback = escapeHtml((user?.name || "?").slice(0, 1));
  return `<span class="avatar avatar-fallback ${extraClass}" style="background:${user?.accent || "#9b5b3d"}">${fallback}</span>`;
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
