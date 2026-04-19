const state = {
  activeUserId: "you",
  users: [],
  books: [],
  currentBook: null,
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
  pendingPageFraction: null,
  scrollSyncTimer: null,
  pendingAvatarDataUrl: null,
  touchStart: null,
};

const userSwitcher = document.getElementById("user-switcher");
const app = document.getElementById("app");

bootstrap();
window.addEventListener("hashchange", render);
window.addEventListener("resize", () => {
  if (route().name === "reader") {
    restoreReaderScroll(false);
    renderReaderProgress();
  }
});

async function bootstrap() {
  const bootstrapData = await api("/api/bootstrap");
  state.users = bootstrapData.users;
  state.books = bootstrapData.books;
  renderUserSwitcher();
  render();
  startEventLoop();
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
      state.pendingSelection = null;
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
  document.getElementById("book-count").textContent = `${state.books.length} 本书已加入共读空间`;

  const summaryGrid = document.getElementById("summary-grid");
  summaryGrid.innerHTML = [renderPerspectiveSummary(me, true), renderPerspectiveSummary(partner, false)].join("");

  const bookGrid = document.getElementById("book-grid");
  if (!state.books.length) {
    bookGrid.innerHTML =
      '<div class="empty-card"><h3>先上传第一本书吧</h3><p>上传成功后，你们两个人都能进入同一本书阅读、批注和同步进度。</p></div>';
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
      <span>${isPrimary ? `${escapeHtml(user.name)}的主视角` : `${escapeHtml(user.name)}的陪读信息`}</span>
      <strong>${average}%</strong>
      <small>${isPrimary ? "当前主要阅读进度" : "对方当前平均进度"}</small>
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
        <small>批注 ${book.annotationCount} 条 · ${formatTime(book.uploadedAt)}</small>
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
  document.getElementById("read-link").href = `#/books/${bookId}/read`;
  document.getElementById("detail-uploaded-at").textContent = `上传时间：${formatTime(state.currentBook.uploadedAt)}`;

  document.querySelectorAll("[data-export-user]").forEach((button) => {
    const isPrimary = button.dataset.exportUser === me.id;
    button.textContent = isPrimary ? `导出${me.name}的笔记` : `导出${partner.name}的笔记`;
    button.classList.toggle("is-primary", isPrimary);
    button.addEventListener("click", () => {
      window.location.href = `/api/books/${bookId}/export.md?userId=${button.dataset.exportUser}`;
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
      <span>${escapeHtml(partner.name)}的陪读信息</span>
      <strong>${Math.round(partnerProgress?.progressPercent || 0)}%</strong>
      <small>${progressChapter(state.currentBook, partnerProgress)}</small>
    </article>
    <article class="stat-card">
      <span>批注线程</span>
      <strong>${state.currentThreads.length}</strong>
      <small>默认同时展示你们两个人的互动</small>
    </article>
  `;

  const detailThreads = document.getElementById("detail-threads");
  if (!state.currentThreads.length) {
    detailThreads.innerHTML =
      '<div class="empty-card"><h3>还没有批注</h3><p>进入阅读器后划线并写下第一条感受，这里就会出现你们的共读互动。</p></div>';
    return;
  }
  detailThreads.innerHTML = state.currentThreads
    .slice(0, 8)
    .map((thread) => renderThreadCard(thread, me.id, false))
    .join("");
}

async function renderReader(bookId) {
  state.currentBook = await api(`/api/books/${bookId}/content`);
  state.currentThreads = (await api(`/api/books/${bookId}/threads`)).threads;
  const currentProgress = (state.currentBook.progress || []).find((item) => item.userId === state.activeUserId);
  state.currentChapterIndex = currentProgress?.chapterIndex || 0;
  state.currentPageIndex = currentProgress?.pageIndex || 0;
  state.currentPageCount = Math.max(1, currentProgress?.pageCount || 1);
  state.activeReaderPanel ||= null;
  app.innerHTML = document.getElementById("reader-template").innerHTML;

  attachReaderControls();
  drawReaderContent(true);
}

function attachReaderControls() {
  document.getElementById("reader-back").href = `#/books/${state.currentBook.id}`;
  document.querySelectorAll("[data-reader-panel]").forEach((button) => {
    button.addEventListener("click", () => toggleReaderPanel(button.dataset.readerPanel));
  });
  document.querySelectorAll("[data-theme]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.theme === state.theme);
    button.addEventListener("click", () => {
      state.theme = button.dataset.theme;
      document.getElementById("reader-surface").className = `reader-surface theme-${state.theme}`;
    });
  });

  const surface = document.getElementById("reader-surface");
  surface.addEventListener("scroll", handleReaderScroll, { passive: true });
  surface.addEventListener("touchstart", handleTouchStart, { passive: true });
  surface.addEventListener("touchend", handleTouchEnd, { passive: true });

  document.querySelectorAll("[data-hotzone]").forEach((zone) => {
    zone.addEventListener("click", () => stepReaderPage(zone.dataset.hotzone === "next" ? 1 : -1));
  });

  document.getElementById("reader-progress-range").addEventListener("input", handleProgressJump);
}

function drawReaderContent(initialLoad = false) {
  const chapter = state.currentBook.chapters[state.currentChapterIndex];
  const container = document.getElementById("reader-content");
  container.innerHTML = `
    <div class="reader-header-card">
      <span class="eyebrow">${escapeHtml(activeUser().name)}的主视角</span>
      <h1>${escapeHtml(chapter.title)}</h1>
    </div>
    ${chapter.contentHtml}
  `;
  applyHighlights(
    container,
    state.currentThreads.filter((thread) => thread.highlight.chapterIndex === chapter.index)
  );
  container.addEventListener("mouseup", captureSelection);
  requestAnimationFrame(() => {
    restoreReaderScroll(initialLoad);
    renderReaderProgress();
    renderReaderPanel();
    scheduleProgressSync();
  });
}

function restoreReaderScroll(initialLoad) {
  const surface = document.getElementById("reader-surface");
  if (!surface) {
    return;
  }
  const maxScroll = Math.max(0, surface.scrollHeight - surface.clientHeight);
  const pageCount = Math.max(1, Math.ceil(surface.scrollHeight / Math.max(1, surface.clientHeight)));
  state.currentPageCount = pageCount;

  let targetPage = state.currentPageIndex;
  if (state.pendingPageFraction != null) {
    targetPage = Math.round(state.pendingPageFraction * Math.max(0, pageCount - 1));
    state.pendingPageFraction = null;
  }
  targetPage = Math.max(0, Math.min(pageCount - 1, targetPage));
  const targetScroll = pageCount <= 1 ? 0 : Math.min(maxScroll, targetPage * surface.clientHeight);
  surface.scrollTop = targetScroll;
  state.currentPageIndex = Math.round(surface.scrollTop / Math.max(1, surface.clientHeight));
  if (!initialLoad) {
    scheduleProgressSync();
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
  state.pendingSelection = null;
  state.activeReaderPanel = state.activeReaderPanel === panelName ? null : panelName;
  renderReaderPanel();
}

function renderSelectionSheet() {
  return `
    <div class="reader-sheet">
      <div class="sheet-head">
        <strong>保存划线</strong>
        <button class="small-button" data-close-sheet="true">关闭</button>
      </div>
      <p class="quote-text">${escapeHtml(state.pendingSelection.quote)}</p>
      <textarea id="note-draft" placeholder="把 ${escapeHtml(activeUser().name)} 的感受写下来...">${escapeHtml(state.noteDraft)}</textarea>
      <button class="primary-button" id="save-note">保存${escapeHtml(activeUser().name)}的划线批注</button>
    </div>
  `;
}

function bindSelectionSheet() {
  document.querySelector("[data-close-sheet]")?.addEventListener("click", () => {
    state.pendingSelection = null;
    renderReaderPanel();
  });
  document.getElementById("note-draft")?.addEventListener("input", (event) => {
    state.noteDraft = event.target.value;
  });
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
        <strong>批注互动</strong>
        <button class="small-button" data-close-sheet="true">关闭</button>
      </div>
      <div class="thread-stack">
        ${
          state.currentThreads.length
            ? state.currentThreads.map((thread) => renderThreadCard(thread, state.activeUserId, true)).join("")
            : '<p class="muted-text">还没有批注，先划出第一段你想和对方分享的句子吧。</p>'
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
            <small>用于底部进度条和互动显示</small>
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
      document.getElementById("reader-surface").className = `reader-surface theme-${state.theme}`;
      renderReaderPanel();
    });
  });
  document.getElementById("profile-avatar-input-sheet")?.addEventListener("change", handleAvatarPick);
  document.getElementById("profile-save-sheet")?.addEventListener("click", async () => {
    document.getElementById("profile-name-input").value =
      document.getElementById("profile-name-input-sheet").value;
    await saveProfile();
  });
}

async function refreshThreads() {
  state.currentThreads = (await api(`/api/books/${state.currentBook.id}/threads`)).threads;
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
    window.location.hash = `#/books/${payload.book.id}`;
  } catch (error) {
    alert(error.message);
  } finally {
    uploadLabel.textContent = "上传 EPUB 到共享书架";
    event.target.value = "";
  }
}

function captureSelection() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return;
  }
  const range = selection.getRangeAt(0);
  const reader = document.getElementById("reader-content");
  if (!reader.contains(range.commonAncestorContainer)) {
    return;
  }
  const offsets = computeOffsets(reader, range);
  if (!offsets) {
    return;
  }
  state.pendingSelection = {
    chapterIndex: state.currentChapterIndex,
    startOffset: offsets.start,
    endOffset: offsets.end,
    quote: selection.toString().trim(),
  };
  state.noteDraft = "";
  state.activeReaderPanel = null;
  renderReaderPanel();
}

async function saveAnnotation() {
  if (!state.pendingSelection || !state.noteDraft.trim()) {
    return;
  }
  await api("/api/annotations", {
    method: "POST",
    body: JSON.stringify({
      bookId: state.currentBook.id,
      userId: state.activeUserId,
      chapterIndex: state.pendingSelection.chapterIndex,
      startOffset: state.pendingSelection.startOffset,
      endOffset: state.pendingSelection.endOffset,
      quote: state.pendingSelection.quote,
      color: activeUser().accent,
      body: state.noteDraft.trim(),
    }),
  });
  state.pendingSelection = null;
  state.noteDraft = "";
  await refreshThreads();
  drawReaderContent();
}

function handleReaderScroll() {
  const surface = document.getElementById("reader-surface");
  if (!surface) {
    return;
  }
  state.currentPageCount = Math.max(1, Math.ceil(surface.scrollHeight / Math.max(1, surface.clientHeight)));
  state.currentPageIndex = Math.max(0, Math.min(state.currentPageCount - 1, Math.round(surface.scrollTop / Math.max(1, surface.clientHeight))));
  renderReaderProgress();
  scheduleProgressSync();
}

function scheduleProgressSync() {
  if (state.scrollSyncTimer) {
    clearTimeout(state.scrollSyncTimer);
  }
  state.scrollSyncTimer = setTimeout(syncProgress, 120);
}

async function syncProgress() {
  const surface = document.getElementById("reader-surface");
  if (!surface || !state.currentBook) {
    return;
  }
  const maxScroll = Math.max(1, surface.scrollHeight - surface.clientHeight);
  const chapterProgress = maxScroll <= 1 ? 1 : Math.min(1, surface.scrollTop / maxScroll);
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
  scrollToPage(target);
}

function scrollToPage(pageIndex) {
  const surface = document.getElementById("reader-surface");
  if (!surface) {
    return;
  }
  const target = Math.max(0, Math.min(state.currentPageCount - 1, pageIndex));
  surface.scrollTo({
    top: target * surface.clientHeight,
    behavior: "smooth",
  });
  state.currentPageIndex = target;
  renderReaderProgress();
  scheduleProgressSync();
}

function jumpToChapter(chapterIndex, pageFraction = 0) {
  const nextChapter = Math.max(0, Math.min(state.currentBook.chapters.length - 1, chapterIndex));
  if (nextChapter === state.currentChapterIndex && state.currentPageCount > 1) {
    scrollToPage(Math.round(pageFraction * Math.max(0, state.currentPageCount - 1)));
    state.activeReaderPanel = null;
    renderReaderPanel();
    return;
  }
  state.currentChapterIndex = nextChapter;
  state.currentPageIndex = 0;
  state.pendingPageFraction = pageFraction;
  state.pendingSelection = null;
  state.activeReaderPanel = null;
  drawReaderContent();
}

function handleProgressJump(event) {
  const percent = Number(event.target.value);
  const chapterCount = Math.max(1, state.currentBook.chapters.length);
  const overall = Math.min(99.999, percent / 100 * chapterCount);
  const chapterIndex = Math.min(chapterCount - 1, Math.floor(overall));
  const within = overall - chapterIndex;
  jumpToChapter(chapterIndex, within);
}

function handleTouchStart(event) {
  const touch = event.changedTouches?.[0];
  if (!touch) {
    return;
  }
  state.touchStart = { x: touch.clientX, y: touch.clientY };
}

function handleTouchEnd(event) {
  const touch = event.changedTouches?.[0];
  if (!touch || !state.touchStart) {
    return;
  }
  const dx = touch.clientX - state.touchStart.x;
  const dy = touch.clientY - state.touchStart.y;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
    stepReaderPage(dx < 0 ? 1 : -1);
  }
  state.touchStart = null;
}

async function handleAvatarPick(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  state.pendingAvatarDataUrl = await readFileAsDataUrl(file);
}

async function saveProfile() {
  const input = document.getElementById("profile-name-input-sheet") || document.getElementById("profile-name-input");
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

function applyHighlights(container, threads) {
  const sorted = [...threads].sort((a, b) => b.highlight.startOffset - a.highlight.startOffset);
  sorted.forEach((thread) => {
    wrapTextRange(
      container,
      thread.highlight.startOffset,
      thread.highlight.endOffset,
      thread.highlight.color,
      thread.annotation.userId === state.activeUserId
    );
  });
}

function wrapTextRange(root, start, end, color, isPrimary) {
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
    mark.style.backgroundColor = `${color}${isPrimary ? "88" : "45"}`;
    try {
      range.surroundContents(mark);
    } catch {
      const fragment = range.extractContents();
      mark.appendChild(fragment);
      range.insertNode(mark);
    }
  }
}

function computeOffsets(root, range) {
  const start = textOffset(root, range.startContainer, range.startOffset);
  const end = textOffset(root, range.endContainer, range.endOffset);
  if (start == null || end == null || start === end) {
    return null;
  }
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function textOffset(root, container, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node === container) {
      return total + offset;
    }
    if (node.contains && node.contains(container)) {
      return total + offset;
    }
    total += node.nodeValue.length;
  }
  return null;
}

function renderThreadCard(thread, primaryUserId, showComposer) {
  const owner = state.users.find((user) => user.id === thread.annotation.userId) || { name: "成员" };
  const chapterTitle = chapterName(thread.highlight.chapterIndex);
  const isPrimary = thread.annotation.userId === primaryUserId;
  return `
    <article class="thread-card ${isPrimary ? "is-primary" : ""}">
      <div class="thread-head">
        <span>${avatarMarkup(owner, "avatar-inline")}${escapeHtml(owner.name)}${isPrimary ? " · 当前主视角" : ""}</span>
        <small>${formatTime(thread.annotation.createdAt)}</small>
      </div>
      <p class="quote-text">${escapeHtml(thread.highlight.quote)}</p>
      <p>${escapeHtml(thread.annotation.body)}</p>
      <small>${escapeHtml(chapterTitle)} · ${thread.comments.length} 条评论</small>
      <div class="comment-list">
        ${thread.comments
          .map((comment) => {
            const commentOwner = state.users.find((user) => user.id === comment.userId) || { name: "成员" };
            return `<div class="comment-item"><strong>${avatarMarkup(commentOwner, "avatar-inline")} ${escapeHtml(commentOwner.name)}</strong><p>${escapeHtml(comment.body)}</p></div>`;
          })
          .join("")}
      </div>
      ${
        showComposer
          ? `<div class="comment-composer">
               <input data-comment-input="${thread.annotation.id}" placeholder="继续聊聊这段内容..." value="${escapeHtml(state.commentDrafts[thread.annotation.id] || "")}" />
               <button class="secondary-button ${isPrimary ? "is-primary" : ""}" data-comment-annotation="${thread.annotation.id}">评论</button>
             </div>`
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
      const remaining = (state.currentBook.progress || []).filter(
        (item) => item.userId !== event.payload.progress.userId
      );
      state.currentBook.progress = [...remaining, event.payload.progress];
      if (route().name === "reader") {
        renderReaderProgress();
      }
    }
  }
  if (event.type === "annotation.created" || event.type === "comment.created") {
    if (state.currentBook && state.currentBook.id === event.payload.bookId) {
      refreshThreads().then(() => {
        if (route().name === "reader") {
          drawReaderContent();
        } else if (route().name === "detail") {
          renderDetail(state.currentBook.id);
        }
      });
    }
    const homeBook = state.books.find((item) => item.id === event.payload.bookId);
    if (homeBook && event.type === "annotation.created") {
      homeBook.annotationCount += 1;
    }
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
