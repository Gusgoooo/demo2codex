const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session") || params.get("sessionId") || "";
const token = params.get("token") || "";
const language = params.get("lang") || "zh-CN";
const serverOrigin = window.location.origin;

const AUDIO_SLICE_MS = 5_000;
const DB_NAME = "demo2codex-recorder";
const DB_VERSION = 1;
const CHUNK_STORE = "audioChunks";

const elements = {
  backupStatus: document.querySelector("#backupStatus"),
  closeDialogButton: document.querySelector("#closeDialogButton"),
  connectionBadge: document.querySelector("#connectionBadge"),
  emptyTranscript: document.querySelector("#emptyTranscript"),
  finishButton: document.querySelector("#finishButton"),
  finishDialog: document.querySelector("#finishDialog"),
  finishDialogText: document.querySelector("#finishDialogText"),
  finishDialogTitle: document.querySelector("#finishDialogTitle"),
  finishSpinner: document.querySelector("#finishSpinner"),
  focusSummary: document.querySelector("#focusSummary"),
  interimText: document.querySelector("#interimText"),
  interimTranscript: document.querySelector("#interimTranscript"),
  levelBar: document.querySelector("#levelBar"),
  levelTrack: document.querySelector(".level-track"),
  pauseButton: document.querySelector("#pauseButton"),
  pauseButtonText: document.querySelector("#pauseButtonText"),
  recordingState: document.querySelector("#recordingState"),
  recordingStateText: document.querySelector("#recordingStateText"),
  resultCard: document.querySelector("#resultCard"),
  resultForm: document.querySelector("#resultForm"),
  resultSavedAt: document.querySelector("#resultSavedAt"),
  resultStatus: document.querySelector("#resultStatus"),
  resultWaiting: document.querySelector("#resultWaiting"),
  reviewSummary: document.querySelector("#reviewSummary"),
  sessionLabel: document.querySelector("#sessionLabel"),
  speechSupportText: document.querySelector("#speechSupportText"),
  speechToggle: document.querySelector("#speechToggle"),
  startButton: document.querySelector("#startButton"),
  timer: document.querySelector("#timer"),
  toastRegion: document.querySelector("#toastRegion"),
  todoList: document.querySelector("#todoList"),
  addTodoButton: document.querySelector("#addTodoButton"),
  transcriptCountLabel: document.querySelector("#transcriptCountLabel"),
  transcriptList: document.querySelector("#transcriptList"),
};

const state = {
  analyser: null,
  audioContext: null,
  db: null,
  elapsedBeforeSegment: 0,
  eventPromises: new Set(),
  finalChunkQueued: false,
  finishing: false,
  finishRequestPayload: null,
  finishSubmitted: false,
  finishSubmissionPromise: null,
  levelAnimationFrame: null,
  mediaRecorder: null,
  mediaStream: null,
  memoryChunks: new Map(),
  nextSequence: 0,
  recognition: null,
  recognitionRunning: false,
  recordingId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
  recordingStatus: "idle",
  resultDirty: false,
  resultLoaded: false,
  resultPollInterval: null,
  segmentStartedAt: 0,
  speechEnabled: true,
  timerInterval: null,
  transcriptCount: 0,
  uploadPromise: null,
  writePromises: new Set(),
};

function apiUrl(pathname, query = {}) {
  const url = new URL(pathname, serverOrigin);
  if (token) url.searchParams.set("token", token);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Demo2Codex-Token"] = token;
  }
  return headers;
}

function toast(message, type = "info") {
  const item = document.createElement("div");
  item.className = `toast${type === "error" ? " toast-error" : ""}`;
  item.textContent = message;
  elements.toastRegion.append(item);
  window.setTimeout(() => item.remove(), 5_000);
}

function setConnectionStatus(status, label) {
  elements.connectionBadge.dataset.state = status;
  elements.connectionBadge.querySelector("span:last-child").textContent = label;
}

function setRecordingStatus(status, label) {
  state.recordingStatus = status;
  elements.recordingState.dataset.state = status;
  elements.recordingStateText.textContent = label;
}

function setFocusSummary(focus) {
  const label =
    focus?.label || focus?.element?.label || focus?.element?.text || focus?.selector || "";
  if (label) {
    elements.focusSummary.dataset.active = "true";
    elements.focusSummary.querySelector("span:last-child").textContent = `正在对焦：${label}`;
  } else {
    delete elements.focusSummary.dataset.active;
    elements.focusSummary.querySelector("span:last-child").textContent = "当前为全局评审记录";
  }
}

function setResultStatus(stateValue, label) {
  elements.resultStatus.dataset.state = stateValue;
  elements.resultStatus.textContent = label;
}

function showResultSection() {
  elements.resultCard.hidden = false;
  if (!state.resultPollInterval) {
    state.resultPollInterval = window.setInterval(refreshReviewResult, 3_000);
  }
}

function createTodoItem(task = {}) {
  const item = document.createElement("div");
  item.className = "todo-item";
  item.dataset.todoId = task.id || globalThis.crypto?.randomUUID?.() || `todo-${Date.now()}`;

  const content = document.createElement("textarea");
  content.className = "todo-content";
  content.rows = 2;
  content.placeholder = "直接描述需要修改什么";
  content.value = task.content || "";

  const actions = document.createElement("div");
  actions.className = "todo-actions";

  if (task.module_hint) {
    const tooltip = document.createElement("span");
    tooltip.className = "tooltip";

    const location = document.createElement("button");
    location.type = "button";
    location.className = "button button-ghost button-icon";
    location.setAttribute("aria-label", "查看大概模块位置");
    location.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"></path><circle cx="12" cy="10" r="2"></circle></svg>';

    const hint = document.createElement("span");
    hint.className = "tooltip-content";
    hint.setAttribute("role", "tooltip");
    const label = document.createElement("strong");
    label.textContent = task.module_hint.label || "相关模块";
    hint.append(label);
    for (const modulePath of task.module_hint.paths || []) {
      const pathLabel = document.createElement("code");
      pathLabel.textContent = modulePath;
      hint.append(pathLabel);
    }
    tooltip.append(location, hint);
    actions.append(tooltip);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button button-ghost button-icon todo-remove";
  remove.setAttribute("aria-label", "删除这条 TODO");
  remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"></path></svg>';
  actions.append(remove);

  item.append(content, actions);
  return item;
}

function renderReviewResult(result) {
  if (state.resultDirty) return;
  elements.reviewSummary.value = result.review_summary || "";
  elements.todoList.replaceChildren(...(result.tasks || []).map(createTodoItem));
  elements.resultWaiting.hidden = true;
  elements.resultForm.hidden = false;
  elements.resultSavedAt.textContent = result.updated_at
    ? `更新于 ${new Date(result.updated_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
    : "";
  setResultStatus("ready", "可编辑");
  state.resultLoaded = true;
  if (state.resultPollInterval) {
    window.clearInterval(state.resultPollInterval);
    state.resultPollInterval = null;
  }
}

async function refreshReviewResult() {
  if (!sessionId || !token || state.resultDirty) return;
  try {
    const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/result`), {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    showResultSection();
    if (result.status === "ready") {
      renderReviewResult(result);
    } else {
      elements.resultWaiting.hidden = false;
      elements.resultForm.hidden = true;
      setResultStatus("waiting", "等待生成");
    }
  } catch (error) {
    console.warn("[Demo2Codex] Could not load review result", error);
  }
}

function collectTodos() {
  return [...elements.todoList.querySelectorAll(".todo-item")].map((item) => ({
    id: item.dataset.todoId,
    content: item.querySelector(".todo-content").value.trim(),
  }));
}

async function saveReviewResult() {
  const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/result`), {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      review_summary: elements.reviewSummary.value.trim(),
      tasks: collectTodos(),
    }),
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  state.resultDirty = false;
  renderReviewResult(body);
  toast("会后总结和 TODO 已保存。");
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = String(Math.floor(seconds / 3_600)).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3_600) / 60)).padStart(2, "0");
  const remainingSeconds = String(seconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${remainingSeconds}`;
}

function getElapsedMilliseconds() {
  if (state.recordingStatus === "recording") {
    return state.elapsedBeforeSegment + (performance.now() - state.segmentStartedAt);
  }
  return state.elapsedBeforeSegment;
}

function renderTimer() {
  const milliseconds = getElapsedMilliseconds();
  elements.timer.textContent = formatDuration(milliseconds);
  elements.timer.dateTime = `PT${Math.floor(milliseconds / 1_000)}S`;
}

function startTimer() {
  window.clearInterval(state.timerInterval);
  renderTimer();
  state.timerInterval = window.setInterval(renderTimer, 250);
}

function pauseTimer() {
  if (state.recordingStatus === "recording") {
    state.elapsedBeforeSegment += performance.now() - state.segmentStartedAt;
  }
  renderTimer();
}

function resumeTimer() {
  state.segmentStartedAt = performance.now();
  renderTimer();
}

function stopTimer() {
  pauseTimer();
  window.clearInterval(state.timerInterval);
  state.timerInterval = null;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("此浏览器不支持 IndexedDB"));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error("无法打开本地录音备份"));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const store = db.createObjectStore(CHUNK_STORE, { keyPath: "id" });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function databaseRequest(mode, operation) {
  return new Promise((resolve, reject) => {
    if (!state.db) {
      reject(new Error("本地备份未就绪"));
      return;
    }

    const transaction = state.db.transaction(CHUNK_STORE, mode);
    const store = transaction.objectStore(CHUNK_STORE);
    let result;

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error("本地备份失败"));
    transaction.onabort = () => reject(transaction.error || new Error("本地备份已取消"));

    try {
      const request = operation(store);
      if (request) {
        request.onsuccess = () => {
          result = request.result;
        };
      }
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  });
}

function putChunk(record) {
  return databaseRequest("readwrite", (store) => store.put(record));
}

function deleteChunk(id) {
  return databaseRequest("readwrite", (store) => store.delete(id));
}

function getStoredChunks() {
  return databaseRequest("readonly", (store) => {
    const index = store.index("sessionId");
    return index.getAll(IDBKeyRange.only(sessionId));
  });
}

async function allPendingChunks() {
  const byId = new Map(state.memoryChunks);
  if (state.db) {
    try {
      const stored = await getStoredChunks();
      for (const record of stored) byId.set(record.id, record);
    } catch (error) {
      console.warn("[Demo2Codex] Failed to read audio backup", error);
    }
  }
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

async function updateBackupStatus() {
  const pending = await allPendingChunks();
  if (!state.db) {
    elements.backupStatus.textContent = pending.length
      ? `${pending.length} 条待同步`
      : "备份不可用";
    return;
  }
  elements.backupStatus.textContent = pending.length
    ? `${pending.length} 条待同步`
    : "已备份";
}

function nextSequence() {
  const sequence = state.nextSequence;
  state.nextSequence += 1;
  try {
    window.localStorage.setItem(`d2c.audio-sequence.${sessionId}`, String(state.nextSequence));
  } catch {
    // A blocked localStorage does not prevent recording because IndexedDB remains primary.
  }
  return sequence;
}

function trackWrite(promise) {
  state.writePromises.add(promise);
  promise.then(
    () => state.writePromises.delete(promise),
    () => state.writePromises.delete(promise),
  );
  return promise;
}

function enqueueAudioChunk(blob, final = false) {
  if (!blob || (!blob.size && !final)) return Promise.resolve();

  const sequence = nextSequence();
  const record = {
    id: `${sessionId}:${state.recordingId}:${sequence}`,
    sessionId,
    recordingId: state.recordingId,
    sequence,
    final,
    mimeType: blob.type || state.mediaRecorder?.mimeType || "application/octet-stream",
    createdAt: new Date().toISOString(),
    elapsedMs: Math.round(getElapsedMilliseconds()),
    blob,
  };

  state.memoryChunks.set(record.id, record);

  const write = (async () => {
    if (state.db) {
      try {
        await putChunk(record);
      } catch (error) {
        console.warn("[Demo2Codex] Failed to back up chunk", error);
        toast("这个录音片段未能写入浏览器备份，将保留在当前页面并继续上传。", "error");
      }
    }
    await updateBackupStatus();
    void flushPendingUploads();
  })();

  return trackWrite(write);
}

async function uploadChunk(record) {
  const response = await fetch(
    apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/audio`, {
      seq: record.sequence,
      final: record.final ? 1 : 0,
    }),
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": record.mimeType }),
      body: record.blob,
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`音频上传失败（HTTP ${response.status}）`);
  }
}

async function flushPendingUploads() {
  if (state.uploadPromise) return state.uploadPromise;

  state.uploadPromise = (async () => {
    if (!navigator.onLine) return;

    const pending = await allPendingChunks();
    for (const record of pending) {
      try {
        await uploadChunk(record);
        state.memoryChunks.delete(record.id);
        if (state.db) {
          try {
            await deleteChunk(record.id);
          } catch (error) {
            console.warn("[Demo2Codex] Uploaded chunk could not be removed", error);
          }
        }
        setConnectionStatus("online", "已连接");
      } catch (error) {
        console.warn("[Demo2Codex] Audio remains queued", error);
        setConnectionStatus("offline", "连接中");
        break;
      }
    }
    await updateBackupStatus();
  })().finally(() => {
    state.uploadPromise = null;
  });

  return state.uploadPromise;
}

async function waitForPendingWrites() {
  while (state.writePromises.size) {
    await Promise.allSettled([...state.writePromises]);
  }
}

function sendEvent(type, payload = {}) {
  if (!sessionId || !token) return Promise.resolve(false);
  const delivery = (async () => {
    try {
      const response = await fetch(
        apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/events`),
        {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            type,
            timestamp: new Date().toISOString(),
            elapsedMs: Math.round(getElapsedMilliseconds()),
            payload,
          }),
          cache: "no-store",
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch (error) {
      console.warn(`[Demo2Codex] Event ${type} was not delivered`, error);
      return false;
    }
  })();
  state.eventPromises.add(delivery);
  delivery.finally(() => state.eventPromises.delete(delivery));
  return delivery;
}

async function waitForPendingEvents() {
  while (state.eventPromises.size) {
    await Promise.allSettled([...state.eventPromises]);
  }
}

function appendTranscript(text, source) {
  const cleaned = text.trim();
  if (!cleaned) return;

  elements.emptyTranscript?.remove();
  state.transcriptCount += 1;
  elements.transcriptCountLabel.textContent = `${state.transcriptCount} 条`;

  const entry = document.createElement("article");
  entry.className = "transcript-entry";

  const time = document.createElement("time");
  time.className = "transcript-time";
  time.textContent = formatDuration(getElapsedMilliseconds()).slice(3);

  const body = document.createElement("p");
  body.className = "transcript-body";
  body.textContent = cleaned;

  entry.append(time, body);
  elements.transcriptList.append(entry);
  elements.transcriptList.scrollTop = elements.transcriptList.scrollHeight;

  void sendEvent("transcript", {
    text: cleaned,
    source,
    final: true,
    language: source === "speech" ? language : undefined,
  });
}

function hideInterimTranscript() {
  elements.interimTranscript.hidden = true;
  elements.interimText.textContent = "";
}

function speechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function configureSpeechRecognition() {
  const Recognition = speechRecognitionConstructor();
  if (!Recognition) {
    state.speechEnabled = false;
    elements.speechToggle.checked = false;
    elements.speechToggle.disabled = true;
    elements.speechSupportText.textContent = "不可用";
    return;
  }

  elements.speechSupportText.textContent = "可用";
  const recognition = new Recognition();
  recognition.lang = language;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    state.recognitionRunning = true;
  };

  recognition.onresult = (event) => {
    let interim = "";
    let finalText = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript || "";
      if (result.isFinal) finalText += text;
      else interim += text;
    }

    if (finalText.trim()) appendTranscript(finalText, "speech");
    elements.interimText.textContent = interim.trim();
    elements.interimTranscript.hidden = !interim.trim();
  };

  recognition.onerror = (event) => {
    if (["aborted", "no-speech"].includes(event.error)) return;
    console.warn("[Demo2Codex] Speech recognition error", event.error);
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      state.speechEnabled = false;
      elements.speechToggle.checked = false;
      toast("实时转写未获授权，录音仍会继续。", "error");
    }
  };

  recognition.onend = () => {
    state.recognitionRunning = false;
    hideInterimTranscript();
    if (
      state.speechEnabled &&
      state.recordingStatus === "recording" &&
      !state.finishing
    ) {
      window.setTimeout(startSpeechRecognition, 250);
    }
  };

  state.recognition = recognition;
}

function startSpeechRecognition() {
  if (
    !state.recognition ||
    state.recognitionRunning ||
    !state.speechEnabled ||
    state.recordingStatus !== "recording"
  ) {
    return;
  }
  try {
    state.recognition.start();
  } catch (error) {
    if (error?.name !== "InvalidStateError") {
      console.warn("[Demo2Codex] Speech recognition could not start", error);
    }
  }
}

function stopSpeechRecognition() {
  hideInterimTranscript();
  if (!state.recognition || !state.recognitionRunning) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(finish, 1_500);
    state.recognition.addEventListener("end", finish, { once: true });
    try {
      state.recognition.stop();
    } catch (error) {
      console.warn("[Demo2Codex] Speech recognition could not stop", error);
      finish();
    }
  });
}

function selectRecorderMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((type) => window.MediaRecorder.isTypeSupported(type)) || "";
}

function startLevelMeter(stream) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  state.audioContext = new AudioContext();
  const source = state.audioContext.createMediaStreamSource(stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 256;
  state.analyser.smoothingTimeConstant = 0.78;
  source.connect(state.analyser);

  const samples = new Uint8Array(state.analyser.fftSize);
  const draw = () => {
    if (!state.analyser) return;
    state.analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / samples.length);
    const percentage = state.recordingStatus === "paused" ? 0 : Math.min(100, rms * 360);
    elements.levelBar.style.width = `${percentage}%`;
    elements.levelTrack.setAttribute("aria-valuenow", String(Math.round(percentage)));
    state.levelAnimationFrame = requestAnimationFrame(draw);
  };
  draw();
}

function stopLevelMeter() {
  cancelAnimationFrame(state.levelAnimationFrame);
  state.levelAnimationFrame = null;
  state.analyser = null;
  elements.levelBar.style.width = "0%";
  elements.levelTrack.setAttribute("aria-valuenow", "0");
  if (state.audioContext && state.audioContext.state !== "closed") {
    void state.audioContext.close();
  }
  state.audioContext = null;
}

function mediaRecorderStopped() {
  return new Promise((resolve) => {
    const recorder = state.mediaRecorder;
    if (!recorder || recorder.state === "inactive") {
      resolve();
      return;
    }
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.stop();
  });
}

async function startRecording() {
  if (!sessionId || !token) {
    toast("缺少 session 或 token，请从 Codex 重新打开这场评审。", "error");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast("当前浏览器不支持录音，请使用最新版 Chrome、Edge 或 Safari。", "error");
    return;
  }

  elements.startButton.disabled = true;
  setRecordingStatus("idle", "正在请求麦克风");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });

    state.mediaStream = stream;
    const mimeType = selectRecorderMimeType();
    state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.finalChunkQueued = false;
    state.finishing = false;
    state.elapsedBeforeSegment = 0;
    state.segmentStartedAt = performance.now();

    state.mediaRecorder.addEventListener("dataavailable", (event) => {
      const isFinal = state.finishing && !state.finalChunkQueued;
      if (isFinal) state.finalChunkQueued = true;
      void enqueueAudioChunk(event.data, isFinal);
    });

    state.mediaRecorder.addEventListener("error", (event) => {
      const message = event.error?.message || "浏览器录音发生错误";
      toast(message, "error");
    });

    state.mediaRecorder.start(AUDIO_SLICE_MS);
    setRecordingStatus("recording", "正在录音");
    startTimer();
    startLevelMeter(stream);
    startSpeechRecognition();

    elements.pauseButton.disabled = false;
    elements.finishButton.disabled = false;
    elements.pauseButtonText.textContent = "暂停";
    await sendEvent("recorder_state", {
      state: "recording",
      recordingId: state.recordingId,
      mimeType: state.mediaRecorder.mimeType,
      sliceMs: AUDIO_SLICE_MS,
    });
  } catch (error) {
    elements.startButton.disabled = false;
    setRecordingStatus("idle", "麦克风不可用");
    const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
    toast(
      denied
        ? "没有获得麦克风权限。请允许此本地页面使用麦克风后重试。"
        : `无法开始录音：${error?.message || "未知错误"}`,
      "error",
    );
  }
}

async function togglePause() {
  const recorder = state.mediaRecorder;
  if (!recorder || state.finishing) return;

  if (recorder.state === "recording") {
    pauseTimer();
    setRecordingStatus("paused", "录音已暂停");
    recorder.pause();
    stopSpeechRecognition();
    elements.pauseButtonText.textContent = "继续";
    void sendEvent("recorder_state", { state: "paused" });
    return;
  }

  if (recorder.state === "paused") {
    recorder.resume();
    setRecordingStatus("recording", "正在录音");
    resumeTimer();
    startSpeechRecognition();
    elements.pauseButtonText.textContent = "暂停";
    void sendEvent("recorder_state", { state: "recording" });
  }
}

function renderFinishedMessage() {
  setRecordingStatus("finished", "已结束");
  elements.finishSpinner.classList.add("is-done");
  elements.finishDialogTitle.textContent = "已保存";
  elements.finishDialogText.textContent = "已保存，等待 Codex 生成结果。";
  elements.closeDialogButton.hidden = false;
  showResultSection();
  void refreshReviewResult();
}

async function submitFinishWhenAudioIsReady() {
  if (!state.finishing || state.finishSubmitted || !state.finishRequestPayload) return;
  if (state.finishSubmissionPromise) return state.finishSubmissionPromise;

  state.finishSubmissionPromise = (async () => {
    await flushPendingUploads();
    const remaining = await allPendingChunks();
    if (remaining.length) {
      const error = new Error(`${remaining.length} audio chunks are still pending`);
      error.code = "AUDIO_PENDING";
      throw error;
    }

    const response = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/finish`),
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(state.finishRequestPayload),
        cache: "no-store",
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.finishSubmitted = true;
    renderFinishedMessage();
  })().finally(() => {
    state.finishSubmissionPromise = null;
  });

  return state.finishSubmissionPromise;
}

async function retryDeferredFinish() {
  if (!state.finishing || state.finishSubmitted || !state.finishRequestPayload) return;
  try {
    await submitFinishWhenAudioIsReady();
  } catch (error) {
    if (error?.code !== "AUDIO_PENDING") {
      console.warn("[Demo2Codex] Deferred finish is still waiting", error);
    }
  }
}

async function finishRecording() {
  if (!state.mediaRecorder || state.finishing) return;
  state.finishing = true;
  stopTimer();
  const speechStopped = stopSpeechRecognition();
  setRecordingStatus("finished", "正在保存");
  elements.pauseButton.disabled = true;
  elements.finishButton.disabled = true;

  elements.finishDialog.showModal();
  try {
    await mediaRecorderStopped();
    await speechStopped;

    if (!state.finalChunkQueued) {
      state.finalChunkQueued = true;
      await enqueueAudioChunk(
        new Blob([], { type: state.mediaRecorder.mimeType || "application/octet-stream" }),
        true,
      );
    }

    for (const track of state.mediaStream?.getTracks?.() || []) track.stop();
    stopLevelMeter();
    await waitForPendingWrites();
    await flushPendingUploads();
    await waitForPendingEvents();
    await sendEvent("recorder_state", { state: "stopped" });

    state.finishRequestPayload = {
      recordingId: state.recordingId,
      durationMs: Math.round(getElapsedMilliseconds()),
      transcriptCount: state.transcriptCount,
      finishedAt: new Date().toISOString(),
    };
    await submitFinishWhenAudioIsReady();
  } catch (error) {
    console.error("[Demo2Codex] Failed to finish review", error);
    setRecordingStatus("finished", "本机已保存");
    elements.finishSpinner.classList.add("is-done");
    elements.finishDialogTitle.textContent = "录音已保存在本机";
    elements.finishDialogText.textContent =
      "暂时无法通知本地 Demo2Codex 服务。请保持此页面打开；连接恢复后会继续上传录音。";
    elements.closeDialogButton.hidden = false;
    toast("未能提交整理，但本地录音备份仍然保留。", "error");
  }
}

async function refreshSessionState() {
  if (!sessionId || !token) return;
  try {
    const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}`), {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    setConnectionStatus("online", "已连接");

    const activeId = data.sessionId || data.id || data.session?.id;
    const title = data.title || data.session?.title || data.projectName || "";
    elements.sessionLabel.textContent = title || "Demo 评审";
    if (!activeId || activeId === sessionId) {
      setFocusSummary(
        data.currentFocus ||
        data.current_focus ||
        data.focus ||
        data.session?.currentFocus ||
        data.session?.current_focus,
      );
    }
    const session = data.session || data;
    if (session.status === "finished") {
      showResultSection();
      void refreshReviewResult();
    }
    if (
      session.finish_requested_at &&
      !state.finishing &&
      state.mediaRecorder &&
      ["recording", "paused"].includes(state.recordingStatus)
    ) {
      void finishRecording();
    }
  } catch (error) {
    setConnectionStatus("offline", navigator.onLine ? "连接中" : "离线");
  }
}

async function initialiseLocalBackup() {
  try {
    state.db = await openDatabase();
    const pending = await getStoredChunks();
    const maximumStoredSequence = pending.reduce(
      (maximum, chunk) => Math.max(maximum, Number(chunk.sequence) || 0),
      -1,
    );
    let persistedSequence = 0;
    try {
      persistedSequence = Number(
        window.localStorage.getItem(`d2c.audio-sequence.${sessionId}`) || 0,
      );
    } catch {
      // Private browsing may block localStorage while IndexedDB remains available.
    }
    state.nextSequence = Math.max(persistedSequence, maximumStoredSequence + 1);
    await updateBackupStatus();
    if (pending.length) {
      toast(`发现 ${pending.length} 个未同步的本地录音片段，正在继续上传。`);
      void flushPendingUploads();
    }
  } catch (error) {
    console.warn("[Demo2Codex] IndexedDB is unavailable", error);
    state.db = null;
    elements.backupStatus.textContent = "备份不可用";
    toast("无法使用浏览器本地备份；录音仍可上传，但请不要刷新此页面。", "error");
  }
}

function validateSession() {
  if (sessionId && token) {
    elements.sessionLabel.textContent = "Demo 评审";
    return true;
  }
  elements.sessionLabel.textContent = "缺少会话凭证，请从 Codex 重新打开录音页";
  setConnectionStatus("offline", "未连接");
  elements.startButton.disabled = true;
  toast("录音页 URL 缺少 session 或 token。", "error");
  return false;
}

elements.startButton.addEventListener("click", startRecording);
elements.pauseButton.addEventListener("click", togglePause);
elements.finishButton.addEventListener("click", finishRecording);

elements.addTodoButton.addEventListener("click", () => {
  elements.todoList.append(createTodoItem());
  state.resultDirty = true;
});

elements.todoList.addEventListener("click", (event) => {
  const remove = event.target.closest(".todo-remove");
  if (!remove) return;
  remove.closest(".todo-item")?.remove();
  state.resultDirty = true;
});

elements.resultForm.addEventListener("input", () => {
  state.resultDirty = true;
});

elements.resultForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveReviewResult();
  } catch (error) {
    toast(error.message || "保存失败", "error");
  }
});

elements.speechToggle.addEventListener("change", () => {
  state.speechEnabled = elements.speechToggle.checked;
  if (state.speechEnabled) {
    startSpeechRecognition();
    toast("实时转写已开启。");
  } else {
    stopSpeechRecognition();
    toast("实时转写已关闭。");
  }
});

window.addEventListener("online", () => {
  setConnectionStatus("neutral", "连接中");
  if (state.finishing) void retryDeferredFinish();
  else void flushPendingUploads();
  void refreshSessionState();
});

window.addEventListener("offline", () => {
  setConnectionStatus("offline", "离线");
  void updateBackupStatus();
});

window.addEventListener("beforeunload", (event) => {
  if (["recording", "paused"].includes(state.recordingStatus)) {
    event.preventDefault();
    event.returnValue = "录音仍在进行中。";
  }
});

configureSpeechRecognition();
if (validateSession()) {
  void initialiseLocalBackup();
  void refreshSessionState();
  window.setInterval(refreshSessionState, 5_000);
  window.setInterval(() => {
    if (state.finishing) void retryDeferredFinish();
    else void flushPendingUploads();
  }, 8_000);
}
