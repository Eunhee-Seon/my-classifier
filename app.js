// app.js — 화면 동작. 기준(criteria.json)과 단어(keywords.json)를 읽어 분류하고,
// 채점할 때만 정답(data/answer.json)을 읽는다.
// 분류·채점 계산은 mask.js, rules.js와 아래 runClassify/runScore의 계산부를 그대로 쓰고,
// 이 파일의 나머지는 화면에 그리는 일만 한다.

(function () {
  const $ = (sel) => document.querySelector(sel);
  const NO_RESULT = "판단 불가";
  let criteria = null;
  let keywords = null;
  let sensitiveCfg = null; // sensitive.json. 없어도 화면은 돈다.
  let routingCfg = null; // routing.json. AI 실패 시 기본 담당·후속 조치에 쓴다.
  let submitType = "general"; // 제출 유형 — 화면 안내에만 쓰고 AI에는 보내지 않는다
  const FALLBACK_SENSITIVE = "확인 불가 · 사람의 검토를 권장합니다";

  // 기술적인 오류를 쉬운 말로 바꾼다. 원문은 '자세히'에 그대로 보여 준다.
  function friendlyError(msg) {
    const m = String(msg || "");
    if (/GEMINI_API_KEY/.test(m)) return "AI 설정이 아직 되어 있지 않습니다.";
    if (/시간 초과/.test(m)) return "AI 응답이 너무 늦어 기다리지 않았습니다.";
    if (/HTTP 429/.test(m)) return "AI 사용량이 잠시 넘쳤습니다. 잠시 후 다시 시도해 주세요.";
    if (/HTTP 50[0-9]/.test(m)) return "AI 서버가 붐비거나 응답하지 않습니다. 1~2분 뒤 다시 시도해 주세요.";
    if (/연결하지 못했/.test(m)) return "AI 서버에 연결하지 못했습니다.";
    if (/모델 이름/.test(m)) return "AI 모델 설정을 확인해야 합니다.";
    return "AI 분석에 실패했습니다.";
  }

  async function loadJSON(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`${path} 를 읽지 못했습니다 (${res.status})`);
    return res.json();
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function highlightMasks(text) {
    return escapeHTML(text).replace(/\[(이름|전화번호|사번|이메일)\]/g, '<mark class="masked">[$1]</mark>');
  }

  const URG_CLASS = { 높음: "u-high", 보통: "u-mid", 낮음: "u-low" };

  function showLoadError(err) {
    const box = $("#load-error");
    box.hidden = false;
    box.innerHTML =
      `<strong>기준 파일을 불러오지 못했습니다.</strong><br>` +
      `index.html 파일을 더블클릭해서 열면 브라우저 보안 때문에 파일을 읽을 수 없습니다. ` +
      `안내서대로 '로컬 서버'를 켠 뒤 <code>http://localhost:8000</code> 으로 열어 주세요.` +
      `<br><small>${escapeHTML(err.message)}</small>`;
    document.querySelectorAll("button.btn-primary, button.btn-secondary").forEach((b) => (b.disabled = true));
  }

  // ---------- AI(Gemini) 호출 ----------
  // 서버(api/classify.py)에 '가린 문장'과 id만 보낸다. 정답이나 원문은 보내지 않는다. API 키는 서버에만 있다.
  const AI_TIMEOUT_MS = 70000; // 서버의 Gemini 제한시간(60초)보다 조금 길게
  // mode: 생략하면 채점과 같은 기본 지시문, "full"이면 분류 탭 확장 모드
  async function callAI(items, mode) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
    const payload = { items: items.map(({ id, text }) => ({ id, text })) };
    if (mode) payload.mode = mode;
    try {
      const res = await fetch("api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* JSON이 아닌 응답 */ }
      if (!res.ok || !data || data.ok !== true || !Array.isArray(data.results)) {
        throw new Error((data && data.error) || `AI 서버에 연결하지 못했습니다 (HTTP ${res.status})`);
      }
      return data;
    } catch (err) {
      if (err.name === "AbortError") throw new Error("AI 응답 시간 초과");
      if (err instanceof TypeError) throw new Error("AI 서버에 연결하지 못했습니다");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- 탭 ----------
  function setupTabs() {
    const tabs = document.querySelectorAll('[role="tab"]');
    tabs.forEach((tab) =>
      tab.addEventListener("click", () => {
        tabs.forEach((t) => {
          const on = t === tab;
          t.setAttribute("aria-selected", on);
          t.tabIndex = on ? 0 : -1;
          document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
        });
      })
    );
  }

  // ---------- 판정 패널 그리기 ----------
  // hits: rules.js가 돌려준 [{name, words}] (없으면 대기 상태)
  function hitRows(names, hits, winner) {
    const counts = Object.fromEntries((hits || []).map((h) => [h.name, h.words.length]));
    const max = Math.max(1, ...Object.values(counts));
    return names
      .map((name) => {
        const c = counts[name] || 0;
        const on = name === winner;
        return `
          <li class="hit ${on ? "on" : ""}">
            <span class="hit-name">${escapeHTML(name)}</span>
            <span class="hit-bar" aria-hidden="true"><i style="width:${hits ? (c / max) * 100 : 0}%"></i></span>
            <span class="hit-n">${hits ? c : "–"}</span>
          </li>`;
      })
      .join("");
  }

  // ---------- 가상 사건 (브라우저 메모리에만) ----------
  // 저장하지 않는다: 서버·localStorage·sessionStorage·쿠키 어디에도 쓰지 않고, 새로 고치면 처음 상태로 돌아간다.
  // HR 검토 화면과 HR 대시보드는 아래 cases 하나를 함께 읽고 고친다 (같은 데이터).
  // 처리 상태와 담당 배정은 따로 관리한다: status(접수·검토 중·처리 중·처리 완료) / assigned(미배정·배정 완료)
  const STATUSES = ["접수", "검토 중", "처리 중", "처리 완료"];
  const STATUS_HELP = {
    접수: "가상 사례가 목록에 등록됐고, HR이 아직 검토를 시작하지 않은 상태 (실제 회사에 제출된 것이 아님)",
    "검토 중": "HR이 사건 내용, AI 판정, 긴급도, 담당 부서를 확인하는 상태",
    "처리 중": "담당 부서가 실제 후속 조치를 진행하는 상태",
    "처리 완료": "조치 결과를 확인하고 사건 처리를 마무리한 상태",
  };
  const NEXT_BUTTON = { 접수: "검토 시작", "검토 중": "검토 완료 및 담당자 배정", "처리 중": "처리 결과 확인 및 완료", "처리 완료": "완료 내역 보기" };
  const UNASSIGNED = "미배정";
  const SAFE_ROLES = ["지정된 고충처리 담당자", "안전관리 담당자"]; // 민감사안을 맡을 수 있는 역할
  const cases = [];
  let currentCaseId = null; // HR 화면에서 보고 있는 사건
  let lastCaseId = null; // 직원 화면에서 방금 제출한 사건
  let flash = null; // { id, msg, ok } — 막힌 조작이나 바뀐 결과를 한 번만 안내
  const findCase = (id) => cases.find((c) => c.id === id);
  const allRoles = () => (routingCfg && routingCfg.roles) || ["HR 담당자"];

  function defaultRouting(category, type) {
    const rc = routingCfg || {};
    const owner = type === "grievance"
      ? (rc.sensitive_role && rc.sensitive_role.default) || "지정된 고충처리 담당자"
      : (category && rc.category_default_role && rc.category_default_role[category]) || "HR 담당자";
    const actions = (category && rc.fallback_actions && rc.fallback_actions[category]) || ["분류가 불확실하므로 HR 담당자가 원문 맥락을 직접 확인"];
    return { owner, actions };
  }

  // 민감사안일 수 있는 건: 개인 고충·신고로 접수됐거나, 민감사안이 '해당 없음'으로 확정되지 않은 건
  const isProtected = (c) => c.type === "grievance" || c.hr.sensitive !== "해당 없음";
  const aiExtra = (c) => (c.ai.source === "ai" ? c.ai.extra : null);
  const aiSensitive = (c) => { const x = aiExtra(c); return x ? (x.sensitive.review_needed ? "검토 필요" : "해당 없음") : "미정"; };
  const confirmedOwner = (c) => (c.hr.assigned ? c.hr.owner : UNASSIGNED);

  // AI 추천 담당: 민감사안이면 일반 부서가 아니라 지정 담당(고충처리·안전관리)으로 추천한다
  function recommendedOwner(c) {
    const x = aiExtra(c);
    const aiOwner = x ? x.owner_role : null;
    if (isProtected(c)) {
      if (SAFE_ROLES.includes(aiOwner)) return aiOwner;
      const sr = (routingCfg && routingCfg.sensitive_role) || {};
      const t = ((x && x.sensitive.types) || []).find((name) => sr[name]);
      return t ? sr[t] : sr.default || "지정된 고충처리 담당자";
    }
    return aiOwner || defaultRouting(c.hr.category || c.ai.category, c.type).owner;
  }

  function createCase({ type, original, finalText, maskedInfo, nameKept, ai, rule, demo }) {
    const n = cases.length + 1;
    const x = ai.source === "ai" ? ai.extra : null;
    const actions = (x ? x.actions : defaultRouting(ai.category, type).actions).slice(0, 3);
    const c = {
      id: `VD-${String(n).padStart(3, "0")}`,
      createdAt: demo ? "예시 데이터" : new Date().toLocaleString("ko-KR"),
      demo: !!demo,
      type, original, finalText, maskedInfo, nameKept, ai, rule,
      aiActions: actions.slice(), // AI(또는 기본값)가 처음 낸 후속 조치 — 고치지 않는다
      showSummary: false,
      hr: {
        category: ai.category || "",
        urgency: ai.urgency || "",
        sensitive: x ? (x.sensitive.review_needed ? "검토 필요" : "해당 없음") : "미정",
        ownerDraft: "", // 검토 중에 고르는 담당 (아직 확정 아님)
        owner: "", // '검토 완료 및 담당자 배정'을 눌렀을 때 확정
        assigned: false,
        generalOk: false, // 민감사안을 일반 부서에 배정함을 HR이 확인
        status: "접수",
        note: "", // HR 검토 의견
        override: "", // AI와 다르게 정한 이유
        result: "", // 담당 부서의 조치 결과
        resultChecked: false,
        actions: [0, 1, 2].map((i) => ({ text: actions[i] || "", done: false })),
      },
      history: [],
    };
    if (demo) {
      Object.assign(c.hr, {
        status: demo.status || c.hr.status, sensitive: demo.sensitive || c.hr.sensitive,
        note: demo.note || "", override: demo.override || "", result: demo.result || "",
        resultChecked: !!demo.result_checked,
      });
      if (demo.owner) Object.assign(c.hr, { owner: demo.owner, ownerDraft: demo.owner, assigned: !!demo.assigned });
      (demo.done || []).forEach((i) => c.hr.actions[i] && c.hr.actions[i].text && (c.hr.actions[i].done = true));
      c.history.push({ at: "예시", text: "예시 초기 상태 (가상 처리 기록)" });
    }
    cases.push(c);
    return c;
  }

  // 과제용 가상 사례: demo_cases.json (practice.json의 가상 문장 + 미리 받아 둔 실제 Gemini 응답)
  function loadDemoCases(d) {
    (d.cases || []).forEach((dc) => {
      const r = Rules.classify(dc.masked, criteria, keywords);
      const rule = { category: r.category, urgency: r.urgency, reason: r.reason, categoryHits: r.categoryHits };
      const ok = dc.ai && dc.ai.ok;
      const ai = ok
        ? { source: "ai", model: `${d.model} · ${d.analyzed_at} 미리 분석`, category: dc.ai.category, urgency: dc.ai.urgency, reason: dc.ai.reason, extra: dc.ai.extra || null, error: null }
        : { source: "rule", model: null, category: r.category, urgency: r.urgency, reason: r.reason, extra: null, error: (dc.ai && dc.ai.error) || "예시 분석 없음" };
      createCase({ type: dc.type, original: dc.original, finalText: dc.masked, maskedInfo: "예시 문장 · 자동 가림 적용", nameKept: 0, ai, rule, demo: dc.demo_hr || {} });
    });
  }

  // ---------- 사건 바꾸기: 두 화면이 모두 아래 함수만 쓴다 ----------
  const FIELD_NAMES = { category: "분류 칸", urgency: "긴급도", sensitive: "민감사안", ownerDraft: "담당 선택(미확정)", note: "HR 검토 의견", override: "다르게 정한 이유", result: "조치 결과" };
  const now = () => new Date().toLocaleTimeString("ko-KR");
  const log = (c, text) => c.history.push({ at: now(), text });
  const short = (v) => (v && v.length > 20 ? v.slice(0, 20) + "…" : v || "없음");

  function differsFromAI(c) {
    const aiSens = aiSensitive(c);
    return c.hr.category !== (c.ai.category || "") || c.hr.urgency !== (c.ai.urgency || "") ||
      (aiSens !== "미정" && c.hr.sensitive !== aiSens) || (!!c.hr.ownerDraft && c.hr.ownerDraft !== recommendedOwner(c));
  }

  // 편집은 검토 중(분류·담당 선택)과 처리 중(조치·결과)에서만 한다
  const EDITABLE = {
    category: ["검토 중"], urgency: ["검토 중"], sensitive: ["검토 중"], ownerDraft: ["검토 중"], override: ["검토 중"],
    note: ["검토 중", "처리 중"], result: ["처리 중"],
  };

  function updateCase(c, f, after, where) {
    if (!(EDITABLE[f] || []).includes(c.hr.status)) {
      flash = { id: c.id, msg: c.hr.status === "접수" ? "먼저 '검토 시작'을 눌러 주세요." : `'${c.hr.status}' 상태에서는 ${FIELD_NAMES[f]}을(를) 바꿀 수 없습니다.` };
      return refreshViews();
    }
    if (f === "ownerDraft" && where === "dash" && isProtected(c)) {
      flash = { id: c.id, msg: "민감사안일 수 있는 건의 담당은 HR 검토 화면에서 정합니다." };
      return refreshViews();
    }
    const before = c.hr[f];
    if (before === after) return;
    c.hr[f] = after;
    if (f === "ownerDraft") c.hr.generalOk = false;
    const from = where === "dash" ? " (대시보드)" : "";
    log(c, ["note", "override", "result"].includes(f) ? `${FIELD_NAMES[f]} 수정${from}` : `${FIELD_NAMES[f]}: ${short(before)} → ${short(after)}${from}`);
    refreshViews();
  }

  // 상태를 한 단계 앞으로: 버튼과 대시보드 드롭다운이 같은 규칙을 쓴다
  function reviewProblems(c) {
    const p = [];
    if (!c.hr.category) p.push("최종 분류 칸을 정해 주세요.");
    if (!c.hr.urgency) p.push("긴급도를 정해 주세요.");
    if (c.hr.sensitive === "미정") p.push("민감사안 여부를 '검토 필요' 또는 '해당 없음'으로 정해 주세요.");
    if (!c.hr.ownerDraft) p.push("배정할 담당 부서를 골라 주세요.");
    if (c.hr.ownerDraft && isProtected(c) && !SAFE_ROLES.includes(c.hr.ownerDraft) && !c.hr.generalOk)
      p.push("민감사안일 수 있는 건을 일반 부서에 배정하려면 아래 확인란에 체크해 주세요. (권장: 지정된 고충처리 담당자)");
    if (differsFromAI(c) && !c.hr.override.trim()) p.push("AI 추천과 다르게 정한 이유를 적어 주세요.");
    return p;
  }

  function advance(c, where) {
    const s = c.hr.status;
    if (s === "접수") {
      c.hr.status = "검토 중";
      log(c, `검토 시작 · 상태: 접수 → 검토 중${where === "dash" ? " (대시보드)" : ""}`);
    } else if (s === "검토 중") {
      if (where === "dash" && isProtected(c)) { flash = { id: c.id, msg: "민감사안일 수 있는 건은 HR 검토 화면에서 검토를 마치고 배정합니다." }; return refreshViews(); }
      const p = reviewProblems(c);
      if (p.length) { flash = { id: c.id, msg: p.join(" ") }; return refreshViews(); }
      Object.assign(c.hr, { owner: c.hr.ownerDraft, assigned: true, status: "처리 중" });
      log(c, `검토 완료 · 담당자 배정: ${c.hr.owner} · 상태: 검토 중 → 처리 중${where === "dash" ? " (대시보드)" : ""}`);
      if (isProtected(c) && !SAFE_ROLES.includes(c.hr.owner)) log(c, "민감사안일 수 있는 건을 일반 부서에 배정함 · 원문과 민감 정보는 넘기지 않음");
    } else if (s === "처리 중") {
      if (where === "dash") { flash = { id: c.id, msg: "처리 결과는 HR 검토 화면에서 확인하고 완료합니다." }; return refreshViews(); }
      const p = [];
      if (!c.hr.result.trim()) p.push("담당 부서의 조치 결과를 적어 주세요.");
      if (!c.hr.resultChecked) p.push("'실제 조치 결과를 확인했습니다'에 체크해 주세요. 후속 조치 체크만으로는 완료되지 않습니다.");
      if (p.length) { flash = { id: c.id, msg: p.join(" ") }; return refreshViews(); }
      c.hr.status = "처리 완료";
      log(c, "처리 결과 확인 · 상태: 처리 중 → 처리 완료");
    } else {
      c.showSummary = !c.showSummary; // 완료 내역 보기 — 기록을 보여 줄 뿐, 새 접수를 만들지 않는다
    }
    refreshViews();
  }

  function refreshViews() {
    if (!$("#panel-hr").hidden) renderHR();
    if (!$("#panel-dash").hidden) renderDash();
    if (!$("#panel-classify").hidden && lastCaseId) renderEmployeeResult(lastCaseId);
  }

  function takeFlash(id) {
    if (!flash || (id && flash.id !== id)) return "";
    const { msg } = flash;
    flash = null;
    return `<div class="fallback-note blocked-note" role="alert"><strong>다음 단계로 넘어가지 않았습니다.</strong><span>${escapeHTML(msg)}</span></div>`;
  }

  // ---------- 직원 화면: 쉬운 말 안내만 (HR 내부 배정·검토 절차는 보여 주지 않는다) ----------
  const URG_PLAIN = {
    높음: "빠른 확인이 필요한 내용으로 보여, 먼저 검토될 수 있습니다.",
    보통: "검토 후 개선이나 조치가 필요한 내용으로 보입니다.",
    낮음: "건의나 문의로 보여, 순서대로 검토됩니다.",
  };
  const TYPE_LABEL = { general: "일반 건의", grievance: "개인 고충·신고" };
  const EMP_STATUS = { 접수: "접수됨", "검토 중": "검토 중", "처리 중": "처리 중", "처리 완료": "처리 완료" };

  function renderVerdict(state) {
    const out = $("#result");
    const meta = $("#verdict-meta");
    if (meta) meta.textContent = "";
    if (!state || state.loading) {
      out.className = "verdict-panel idle";
      out.innerHTML = `
        <div class="verdict-top">
          <p class="idle-msg">${state && state.loading ? "AI가 의견을 분석하고 있습니다…" : "분석할 의견을 기다리고 있습니다."}</p>
          <p class="reason-sub">의견을 입력하고 AI에 보낼 문장을 확인한 뒤 'AI로 분석'을 누르면 안내가 여기에 나타납니다.</p>
        </div>`;
      return;
    }
    if (state.blocked) {
      out.className = "verdict-panel";
      out.innerHTML = `
        <div class="fallback-note blocked-note" role="alert">
          <strong>개인정보가 남아 있어 AI로 보내지 않았습니다.</strong>
          <span>${escapeHTML(state.message)}</span>
        </div>
        <div class="verdict-top">
          <p class="idle-msg">왼쪽 'AI에 보낼 문장'에서 해당 부분을 지우거나 고친 뒤 다시 'AI로 분석'을 눌러 주세요.</p>
        </div>`;
      return;
    }
    renderEmployeeResult(state.caseId);
  }

  function renderEmployeeResult(caseId) {
    const c = findCase(caseId);
    if (!c) return renderVerdict(null);
    const out = $("#result");
    const isAI = c.ai.source === "ai";
    const extra = c.ai.extra;
    const cat = c.ai.category;
    const sensitive = c.type === "grievance" || (isAI && extra && extra.sensitive.review_needed);
    const guide = (sensitiveCfg && sensitiveCfg.sensitive_guidance) || [];
    const path = (sensitiveCfg && sensitiveCfg.report_path_notice) || "";
    out.className = "verdict-panel";
    out.innerHTML = `
      ${isAI ? "" : `
      <div class="fallback-note" role="status">
        <strong>지금은 AI 분석이 되지 않아, AI 없이 규칙으로 갈랐습니다.</strong>
        <span>아래 안내는 임시이며, HR 담당자가 직접 확인합니다.</span>
      </div>`}
      <div class="verdict-top">
        <p class="micro"><b>RESULT</b>AI 분석 결과</p>
        <p class="emp-topic">${cat ? `<b>${escapeHTML(cat)}</b> 관련 의견으로 보입니다.` : "어떤 분야의 의견인지 자동으로 정하지 못했습니다."}</p>
        ${c.ai.urgency ? `<p class="reason-sub">${escapeHTML(URG_PLAIN[c.ai.urgency] || "")}</p>` : ""}
        ${isAI && c.ai.reason ? `<p class="emp-why">이렇게 본 이유 · ${escapeHTML(c.ai.reason)}</p>` : ""}
      </div>
      <div class="verdict-row">
        <p class="micro"><b>NEXT</b>다음 단계</p>
        <p class="emp-next">HR 담당자가 내용을 확인하고 알맞은 담당 분야로 연결합니다. AI 결과는 참고용이며, 최종 판단은 사람이 합니다.</p>
        <p class="reason-sub">실습용이라 실제 회사에 제출되거나 전달되지 않습니다.</p>
      </div>
      ${sensitive ? `
      <div class="verdict-row care">
        <p class="micro"><b>CARE</b>민감한 내용일 수 있어요</p>
        <ul class="care-list">${guide.map((g) => `<li>${escapeHTML(g)}</li>`).join("")}${path ? `<li>${escapeHTML(path)}</li>` : ""}</ul>
      </div>` : ""}
      <div class="verdict-row hr-box">
        <p class="hr-title">가상 접수번호 ${escapeHTML(c.id)} <span>실습용</span></p>
        <p class="emp-status">진행 상태 · <b>${escapeHTML(EMP_STATUS[c.hr.status] || c.hr.status)}</b></p>
        ${c.hr.status === "처리 완료" && c.hr.result ? `<p class="emp-result">처리 결과 · ${escapeHTML(c.hr.result)}</p>` : ""}
        <button type="button" class="btn-secondary emp-to-hr" data-case="${escapeHTML(c.id)}">HR 검토 화면에서 보기 (시뮬레이션)</button>
      </div>
      <div class="verdict-foot">
        <p class="foot-label">AI 분석에 쓴 문장</p>
        <p class="masked-text">${highlightMasks(c.finalText)}</p>
      </div>`;
    out.querySelector(".emp-to-hr").addEventListener("click", () => openHR(c.id));
  }

  // ---------- 작은 표시 조각 ----------
  const ownerText = (c) => (c.hr.assigned ? escapeHTML(c.hr.owner) : `<span class="unassigned">미배정</span>`);
  const assignBadge = (c) => (c.hr.assigned ? `<span class="rv rv-ok">배정 완료</span>` : `<span class="rv rv-wait">미배정</span>`);
  const sensBadge = (c) =>
    c.hr.sensitive === "검토 필요" ? `<span class="hr-flag">검토 필요</span>`
      : c.hr.sensitive === "미정" ? `<span class="hr-flag unknown">미정</span>` : `<span class="sens-none">해당 없음</span>`;
  const statusBadge = (s) => `<span class="st st-${STATUSES.indexOf(s)}">${escapeHTML(s)}</span>`;

  function options(values, selected, labelFn) {
    return values.map((v) => `<option value="${escapeHTML(v)}" ${v === selected ? "selected" : ""}>${escapeHTML(labelFn ? labelFn(v) : v || "미정")}</option>`).join("");
  }

  function stepper(c) {
    const at = STATUSES.indexOf(c.hr.status);
    return `<ol class="stepper" aria-label="처리 단계">${STATUSES.map((s, i) =>
      `<li class="${i < at ? "past" : i === at ? "now" : ""}" ${i === at ? 'aria-current="step"' : ""}><span>${i + 1}</span>${escapeHTML(s)}</li>`).join("")}</ol>`;
  }

  // ---------- HR 검토 화면 (시뮬레이션) ----------
  function openHR(caseId) {
    currentCaseId = caseId || currentCaseId;
    $("#tab-hr").click();
  }

  function renderHR() {
    const list = $("#hr-list");
    const waiting = cases.filter((c) => c.hr.status === "접수").length;
    $("#hr-count").textContent = cases.length ? `${cases.length}건 · 접수 상태 ${waiting}건` : "";
    if (!cases.length) {
      list.innerHTML = `<li class="hr-empty">아직 등록된 가상 의견이 없습니다. 직원 접수 화면에서 가상 의견을 제출해 보세요.</li>`;
      $("#hr-detail").innerHTML = `<div class="verdict-top"><p class="idle-msg">검토할 의견이 없습니다.</p></div>`;
      $("#hr-meta").textContent = "";
      return;
    }
    if (!findCase(currentCaseId)) currentCaseId = cases[cases.length - 1].id;
    list.innerHTML = cases.slice().reverse().map((c) => `
      <li>
        <button type="button" class="hr-item ${c.id === currentCaseId ? "on" : ""} ${c.hr.status === "접수" ? "unread" : ""}" data-case="${escapeHTML(c.id)}">
          <span class="hr-item-top"><b>${escapeHTML(c.id)}</b><span>${escapeHTML(TYPE_LABEL[c.type] || "")}</span>${c.demo ? `<span class="demo-tag">예시</span>` : ""}<span class="hr-item-st">${statusBadge(c.hr.status)}</span></span>
          <span class="hr-item-text">${escapeHTML(c.finalText)}</span>
          <span class="hr-item-tags">
            <span>${escapeHTML(c.hr.category || "칸 미정")}</span>
            ${c.hr.urgency ? `<span class="u-text ${URG_CLASS[c.hr.urgency] || ""}">${escapeHTML(c.hr.urgency)}</span>` : ""}
            ${c.hr.sensitive === "검토 필요" ? `<span class="hr-flag">민감사안</span>` : c.hr.sensitive === "미정" ? `<span class="hr-flag unknown">민감 미정</span>` : ""}
            <span class="hr-item-owner">${ownerText(c)}</span>
          </span>
        </button>
      </li>`).join("");
    list.querySelectorAll(".hr-item").forEach((b) =>
      b.addEventListener("click", () => {
        currentCaseId = b.dataset.case;
        renderHR();
      })
    );
    renderHRDetail(findCase(currentCaseId));
  }

  function renderHRDetail(c) {
    const box = $("#hr-detail");
    const isAI = c.ai.source === "ai";
    const extra = aiExtra(c);
    const cats = criteria.priority.order;
    const urgs = criteria.urgency_levels.map((u) => u.name);
    const roles = allRoles();
    const aiSens = aiSensitive(c);
    const rec = recommendedOwner(c);
    const prot = isProtected(c);
    const st = c.hr.status;
    const reviewing = st === "검토 중";
    const acting = st === "처리 중";
    const done = st === "처리 완료";
    const aiOwnerRaw = extra ? extra.owner_role : null;
    const dis = (on) => (on ? "" : "disabled");
    const changed = {
      category: c.hr.category !== (c.ai.category || ""),
      urgency: c.hr.urgency !== (c.ai.urgency || ""),
      sensitive: aiSens !== "미정" && c.hr.sensitive !== aiSens,
    };
    const differs = differsFromAI(c);
    const generalPick = prot && c.hr.ownerDraft && !SAFE_ROLES.includes(c.hr.ownerDraft);
    const doneN = c.hr.actions.filter((a) => a.text && a.done).length;
    const actN = c.hr.actions.filter((a) => a.text).length;
    const handoff = c.hr.actions.filter((a) => a.text.trim());
    const cmpRow = (label, f, ai, values) => `
      <tr class="${changed[f] ? "changed" : ""}">
        <th scope="row">${label}</th>
        <td>${escapeHTML(ai || NO_RESULT)}</td>
        <td><select data-f="${f}" aria-label="${label} HR 최종" ${dis(reviewing)}>${options(values, c.hr[f])}</select></td>
      </tr>`;
    const lockedHint = st === "접수" ? `<p class="lock-hint">'검토 시작'을 누르면 수정할 수 있습니다.</p>` : !reviewing ? `<p class="lock-hint">검토를 마치고 배정한 뒤에는 분류와 담당을 바꾸지 않습니다. (확정된 값)</p>` : "";
    $("#hr-meta").textContent = `${c.id} · ${c.createdAt}`;
    box.className = "verdict-panel";
    box.innerHTML = `
      ${takeFlash(c.id)}
      <div class="verdict-top hr-head">
        <div class="hr-head-main">
          <p class="micro"><b>CASE</b>${escapeHTML(c.id)} · ${escapeHTML(TYPE_LABEL[c.type] || "")} · ${escapeHTML(c.createdAt)}${c.demo ? ` <span class="demo-tag">예시</span>` : ""}</p>
          ${stepper(c)}
          <p class="hr-head-state">${assignBadge(c)} <span class="hr-head-owner">담당 부서 · ${ownerText(c)}</span></p>
          <p class="field-hint">${escapeHTML(STATUS_HELP[st])}</p>
        </div>
        <button type="button" id="hr-next" class="${done ? "btn-secondary" : "btn-primary"}">${escapeHTML(done && c.showSummary ? "완료 내역 닫기" : NEXT_BUTTON[st])}</button>
      </div>
      ${done && c.showSummary ? `
      <div class="verdict-row summary-box">
        <p class="micro"><b>SUMMARY</b>완료 내역 <span class="micro-note">기록을 보여 줄 뿐, 새 접수를 만들지 않습니다</span></p>
        <dl class="hr-ai-grid">
          <div><dt>최종 분류 칸 · 긴급도</dt><dd>${escapeHTML(c.hr.category || "미정")} · ${escapeHTML(c.hr.urgency || "미정")}</dd></div>
          <div><dt>민감사안</dt><dd>${escapeHTML(c.hr.sensitive)}</dd></div>
          <div><dt>담당 부서</dt><dd>${ownerText(c)}</dd></div>
          <div><dt>AI 추천과 다르게 정한 이유</dt><dd>${escapeHTML(c.hr.override || "없음")}</dd></div>
        </dl>
        <p class="reason"><span class="lbl">HR 검토 의견</span>${escapeHTML(c.hr.note || "없음")}</p>
        <p class="foot-label hr-sub-title">후속 조치</p>
        <ol class="actions">${handoff.map((a) => `<li>${escapeHTML(a.text)} · ${a.done ? "완료" : "미완료"}</li>`).join("") || "<li>없음</li>"}</ol>
        <p class="reason"><span class="lbl">조치 결과</span>${escapeHTML(c.hr.result || "없음")}</p>
      </div>` : ""}
      ${prot ? `
      <div class="verdict-row care sens-box">
        <p class="micro"><b>SENSITIVE</b>민감사안 검토 필요 · 지정된 고충처리 담당자 우선 검토 대상</p>
        <ul class="care-list">
          <li>AI는 사실관계나 위법 여부를 확정하지 않습니다. 표시는 '의심·검토 필요'라는 뜻입니다.</li>
          <li>일반 담당 부서에 자동으로 배정하지 않습니다. 검토와 배정은 이 화면에서만 합니다.</li>
          <li>실제 사건 조사와 보호 조치는 이 시스템에서 이루어지지 않습니다.</li>
        </ul>
      </div>` : ""}

      <div class="verdict-row info-ai">
        <p class="micro"><b>FOR AI</b>AI 분석용 정보 <span class="micro-note">외부 AI(Gemini)에 보낸 문장 · ${escapeHTML(c.maskedInfo)}</span></p>
        <p class="masked-text">${highlightMasks(c.finalText)}</p>
        ${c.nameKept ? `<p class="more-info"><b>주의</b> 이름일 수 있는 말 ${c.nameKept}곳을 제출자가 '이름 아님'으로 두고 보냈습니다.</p>` : ""}
        <p class="reason-sub">이름·연락처·사번·이메일 같은 식별정보를 줄이고, 사건의 유형과 긴급도를 판단할 맥락만 남긴 문장입니다.</p>
      </div>
      <div class="verdict-row info-hr">
        <p class="micro"><b>FOR HR</b>HR 조사용 정보 <span class="micro-note">시뮬레이션 · 실제 HR에 전달되지 않음</span></p>
        <p class="foot-label">접수 원문</p>
        <p class="hr-original">${escapeHTML(c.original)}</p>
        <details class="mini-disclosure">
          <summary>실제 운영에서 다루는 조사용 정보와 열람 원칙</summary>
          <ul class="care-list">
            <li>신고 원문, 신고 대상자·관련 인물, 사건 일시·장소, 구체적인 경위, 증거·참고자료, 조사·후속 조치 기록</li>
            <li>모든 HR 담당자가 모든 원문을 보지 않습니다. 업무상 필요와 사건별 접근권한에 따라 권한 있는 HR 또는 내부 감사 담당자만 봅니다.</li>
            <li>원문은 보호된 저장소에 두고, 누가 언제 열람했는지 기록해야 합니다.</li>
            <li>이 시뮬레이션에는 원문 저장소·로그인·접근권한 관리가 없습니다. 원문은 이 브라우저 메모리에만 있고 저장되지 않습니다.</li>
          </ul>
        </details>
      </div>

      <div class="verdict-row hr-ai">
        <p class="micro"><b>AI</b>AI 추천 (최초 판정) <span class="micro-note">${isAI ? `Gemini · ${escapeHTML(c.ai.model || "")}` : "AI 없이 규칙으로 갈랐습니다 (임시)"}</span></p>
        ${isAI ? "" : `<p class="reason-sub">${escapeHTML(friendlyError(c.ai.error))} 규칙 분류는 낱말만 비교하며 민감사안을 판단하지 않습니다.</p>`}
        <dl class="hr-ai-grid">
          <div><dt>분류 칸</dt><dd>${escapeHTML(c.ai.category || NO_RESULT)}</dd></div>
          <div><dt>긴급도</dt><dd>${escapeHTML(c.ai.urgency || NO_RESULT)}</dd></div>
          <div><dt>민감사안</dt><dd>${extra ? (extra.sensitive.review_needed ? `검토 필요 ${extra.sensitive.types.map((t) => `<span class="hr-flag">${escapeHTML(t)}</span>`).join(" ")}` : "검토 표시 없음") : escapeHTML((sensitiveCfg && sensitiveCfg.fallback_display) || FALLBACK_SENSITIVE)}</dd></div>
          <div><dt>AI 추천 담당</dt><dd>${escapeHTML(rec)}${aiOwnerRaw && aiOwnerRaw !== rec ? `<span class="hr-changed">AI 원래 추천: ${escapeHTML(aiOwnerRaw)} → 민감사안이라 지정 담당으로 추천</span>` : ""}${!aiOwnerRaw ? `<span class="hr-changed">기본값</span>` : ""}</dd></div>
        </dl>
        ${isAI && c.ai.reason ? `<p class="reason"><span class="lbl">판단 이유</span>${escapeHTML(c.ai.reason)}</p>` : ""}
        ${extra && extra.sensitive.basis ? `<p class="reason-sub">${escapeHTML(extra.sensitive.basis)}</p>` : ""}
        ${extra && extra.needs_more_info ? `<p class="more-info"><b>추가 확인 필요</b> ${escapeHTML(extra.info_to_check || "정확한 상황 확인이 필요합니다.")}</p>` : ""}
        <p class="foot-label hr-sub-title">AI 권장 후속 조치</p>
        <ol class="actions">${c.aiActions.map((a) => `<li>${escapeHTML(a)}</li>`).join("")}</ol>
      </div>

      <div class="verdict-row hr-form ${reviewing ? "stage-on" : ""}">
        <p class="micro"><b>REVIEW</b>검토 · 분류 확정과 담당 부서 선택 <span class="micro-note">AI 추천은 그대로 남고, HR이 정한 값이 최종입니다</span></p>
        ${lockedHint}
        <div class="cmp-wrap">
          <table class="cmp">
            <thead><tr><th scope="col">항목</th><th scope="col">AI 추천</th><th scope="col">HR 최종</th></tr></thead>
            <tbody>
              ${cmpRow("분류 칸", "category", c.ai.category, ["", ...cats])}
              ${cmpRow("긴급도", "urgency", c.ai.urgency, ["", ...urgs])}
              ${cmpRow("민감사안", "sensitive", aiSens === "미정" ? "확인 불가" : aiSens, ["미정", "검토 필요", "해당 없음"])}
            </tbody>
          </table>
        </div>
        <div class="hr-fields">
          <label>배정할 담당 부서 <span class="micro-note">${c.hr.assigned ? "배정 확정됨" : "'검토 완료 및 담당자 배정'을 눌러야 확정됩니다"}</span>
            <select data-f="ownerDraft" ${dis(reviewing)}>${options(["", ...roles], c.hr.assigned ? c.hr.owner : c.hr.ownerDraft, (v) => (!v ? "선택 안 함" : v === rec ? `${v} (AI 추천)` : v))}</select>
            ${reviewing && !c.hr.ownerDraft ? `<button type="button" id="hr-pick-rec" class="btn-link">AI 추천 담당(${escapeHTML(rec)}) 고르기</button>` : ""}
          </label>
          <div class="assign-box">
            <p class="foot-label">담당자 배정</p>
            <p class="assign-state">${assignBadge(c)}</p>
            <p class="field-hint">처리 상태와 따로 관리합니다.</p>
          </div>
        </div>
        ${reviewing && generalPick ? `
        <label class="check-line warn"><input type="checkbox" id="hr-general-ok" ${c.hr.generalOk ? "checked" : ""}> 민감사안일 수 있는 건을 일반 부서(${escapeHTML(c.hr.ownerDraft)})에 배정합니다. 원문과 민감 정보는 넘기지 않습니다.</label>` : ""}
        <label class="hr-wide">AI 추천과 다르게 정한 이유 ${differs ? `<span class="need">AI 추천과 다르게 정했습니다${c.hr.override ? "" : " · 이유를 적어 주세요"}</span>` : `<span class="micro-note">다르게 정할 때 적습니다</span>`}<textarea data-f="override" rows="2" ${dis(reviewing)}>${escapeHTML(c.hr.override)}</textarea></label>
        <label class="hr-wide">HR 검토 의견 <span class="micro-note">이 화면에만 남습니다</span><textarea data-f="note" rows="2" ${dis(reviewing || acting)}>${escapeHTML(c.hr.note)}</textarea></label>
      </div>

      <div class="verdict-row hr-form ${acting ? "stage-on" : ""}">
        <p class="micro"><b>ACTION</b>후속 조치와 처리 결과 <span class="micro-note">${doneN}/${actN} 완료 · 모두 체크해도 자동으로 완료되지 않습니다</span></p>
        <ul class="act-list">
          ${c.hr.actions.map((a, i) => `
            <li class="act ${a.done ? "done" : ""}">
              <input type="checkbox" data-act-done="${i}" ${a.done ? "checked" : ""} ${a.text && (reviewing || acting) ? "" : "disabled"} aria-label="후속 조치 ${i + 1} 완료">
              <input type="text" data-act-text="${i}" value="${escapeHTML(a.text)}" placeholder="후속 조치 ${i + 1} (비어 있음)" aria-label="후속 조치 ${i + 1} 내용" ${dis(reviewing || acting)}>
            </li>`).join("")}
        </ul>
        <label class="hr-wide">담당 부서의 조치 결과 <span class="micro-note">'처리 중'일 때 적습니다 · 처리 완료 후 직원 화면에 보입니다</span><textarea data-f="result" rows="2" ${dis(acting)}>${escapeHTML(c.hr.result)}</textarea></label>
        ${acting ? `<label class="check-line"><input type="checkbox" id="hr-result-ok" ${c.hr.resultChecked ? "checked" : ""}> 담당 부서의 실제 조치 결과를 확인했습니다.</label>` : ""}
      </div>

      <div class="verdict-row dept">
        <p class="micro"><b>HANDOFF</b>담당 부서에 넘길 정보 (미리보기)</p>
        <dl class="hr-ai-grid">
          <div><dt>접수번호</dt><dd>${escapeHTML(c.id)}</dd></div>
          <div><dt>담당</dt><dd>${ownerText(c)}</dd></div>
          <div><dt>분류 칸 · 긴급도</dt><dd>${escapeHTML(c.hr.category || "미정")} · ${escapeHTML(c.hr.urgency || "미정")}</dd></div>
        </dl>
        <p class="masked-text">${highlightMasks(c.finalText)}</p>
        <ol class="actions">${handoff.map((a) => `<li>${escapeHTML(a.text)}${a.done ? " (완료)" : ""}</li>`).join("")}</ol>
        <p class="reason-sub">담당 부서에는 AI 분석용 문장만 넘기고, 원문·제출자 정보·민감사안 유형은 넘기지 않습니다.${prot ? " 민감사안은 권한 있는 HR 또는 지정된 고충처리 담당자가 직접 관리합니다." : ""} (실습용: 실제로 전달되지 않음)</p>
      </div>

      <div class="verdict-foot">
        <details class="mini-disclosure">
          <summary>AI 판단 근거 (내부 정보)</summary>
          <p class="compare-line">규칙 분류기 판정: <b>${escapeHTML(c.rule.category || NO_RESULT)}</b> · <b>${escapeHTML(c.rule.urgency || NO_RESULT)}</b></p>
          <p class="compare-line">${escapeHTML(c.rule.reason)}</p>
          <ol class="hits">${hitRows(cats, c.rule.categoryHits, c.rule.category)}</ol>
          ${c.ai.error ? `<p class="compare-line">AI 오류 원문</p><code class="err-raw">${escapeHTML(c.ai.error)}</code>` : ""}
        </details>
        ${c.history.length ? `
        <p class="foot-label hr-hist-title">변경 기록</p>
        <ol class="hr-history">${c.history.map((h) => `<li><span>${escapeHTML(h.at)}</span> ${escapeHTML(h.text)}</li>`).join("")}</ol>` : ""}
      </div>`;

    box.querySelector("#hr-next").addEventListener("click", () => advance(c, "hr"));
    box.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("change", () => updateCase(c, el.dataset.f, el.value, "hr")));
    const pick = box.querySelector("#hr-pick-rec");
    if (pick) pick.addEventListener("click", (e) => { e.preventDefault(); updateCase(c, "ownerDraft", rec, "hr"); });
    const gok = box.querySelector("#hr-general-ok");
    if (gok) gok.addEventListener("change", () => { c.hr.generalOk = gok.checked; log(c, gok.checked ? "민감사안 일반 부서 배정 확인 체크" : "민감사안 일반 부서 배정 확인 해제"); refreshViews(); });
    const rok = box.querySelector("#hr-result-ok");
    if (rok) rok.addEventListener("change", () => { c.hr.resultChecked = rok.checked; log(c, rok.checked ? "실제 조치 결과 확인 체크" : "실제 조치 결과 확인 해제"); refreshViews(); });
    box.querySelectorAll("[data-act-done]").forEach((el) =>
      el.addEventListener("change", () => {
        const a = c.hr.actions[el.dataset.actDone];
        a.done = el.checked;
        log(c, `후속 조치 ${Number(el.dataset.actDone) + 1} ${a.done ? "완료 체크" : "완료 취소"}`);
        refreshViews();
      })
    );
    box.querySelectorAll("[data-act-text]").forEach((el) =>
      el.addEventListener("change", () => {
        const a = c.hr.actions[el.dataset.actText];
        a.text = el.value.trim().slice(0, 200);
        if (!a.text) a.done = false;
        log(c, `후속 조치 ${Number(el.dataset.actText) + 1} 내용 수정`);
        refreshViews();
      })
    );
  }

  // ---------- HR 대시보드 (시뮬레이션) ----------
  // 숫자는 모두 지금 cases에서 계산한다. 고정된 숫자는 없다.
  const dashFilter = { type: "", category: "", urgency: "", owner: "", status: "", sensitive: "" };

  function renderDash() {
    const box = $("#dash");
    const cats = criteria.priority.order;
    const urgs = criteria.urgency_levels.map((u) => u.name);
    const roles = allRoles();
    const count = (fn) => cases.filter(fn).length;
    const total = cases.length;
    const metrics = [
      ["TOTAL", "전체 접수", total],
      ["RECEIVED", "접수 상태", count((c) => c.hr.status === "접수")],
      ["REVIEW", "검토 중", count((c) => c.hr.status === "검토 중")],
      ["IN PROGRESS", "처리 중", count((c) => c.hr.status === "처리 중")],
      ["DONE", "처리 완료", count((c) => c.hr.status === "처리 완료")],
      ["UNASSIGNED", "담당 미배정", count((c) => !c.hr.assigned)],
      ["SENSITIVE", "민감사안 검토 필요", count((c) => c.hr.sensitive === "검토 필요")],
    ];
    const bar = (k, max) => `<span class="dbar" aria-hidden="true"><i style="width:${max ? (k / max) * 100 : 0}%"></i></span>`;
    const catRows = [...cats, ""].map((name) => ({ name, n: count((c) => c.hr.category === name) })).filter((r) => r.name || r.n);
    const catMax = Math.max(1, ...catRows.map((r) => r.n));
    const ownRows = [...roles, UNASSIGNED].map((name) => ({ name, n: count((c) => confirmedOwner(c) === name), open: count((c) => confirmedOwner(c) === name && c.hr.status !== "처리 완료") }));
    const f = dashFilter;
    const rows = cases.filter((c) =>
      (!f.type || c.type === f.type) && (!f.category || c.hr.category === f.category) && (!f.urgency || c.hr.urgency === f.urgency) &&
      (!f.owner || confirmedOwner(c) === f.owner) && (!f.status || c.hr.status === f.status) && (!f.sensitive || c.hr.sensitive === f.sensitive));
    const sel = (key, label, values, labelFn) => `
      <label class="flt">${label}<select data-flt="${key}"><option value="">전체</option>${values.map((v) => `<option value="${escapeHTML(v)}" ${f[key] === v ? "selected" : ""}>${escapeHTML(labelFn ? labelFn(v) : v)}</option>`).join("")}</select></label>`;
    const filtered = Object.values(f).some(Boolean);
    const nextOf = (s) => STATUSES[STATUSES.indexOf(s) + 1];

    box.innerHTML = `
      ${takeFlash()}
      <div class="scoreboard">
        <div class="sb-head">
          <span class="sb-flag">LIVE</span>
          <span>가상 사건 ${total}건 · 지금 이 브라우저의 데이터에서 계산</span>
          <span class="sb-time">새로 고치면 처음 상태로 돌아갑니다</span>
        </div>
        <div class="metrics dash-metrics">
          ${metrics.map(([en, ko, v]) => `
            <div class="metric">
              <p class="micro"><b>${en}</b>${ko}</p>
              <div class="metric-value">${v}<small>건</small></div>
            </div>`).join("")}
        </div>
      </div>

      <div class="dash-two">
        <div class="matrix-wrap">
          <table class="vs-table dash-table">
            <caption>분류 칸별 현황 <span>HR 최종 기준</span></caption>
            <thead><tr><th scope="col">분류 칸</th><th scope="col">접수</th><th scope="col" class="bar-col"><span class="sr-only">비율</span></th></tr></thead>
            <tbody>${catRows.map((r) => `<tr><th scope="row">${escapeHTML(r.name || "미정")}</th><td>${r.n}</td><td class="bar-col">${bar(r.n, catMax)}</td></tr>`).join("")}</tbody>
          </table>
        </div>
        <div class="matrix-wrap">
          <table class="vs-table dash-table">
            <caption>담당 부서별 현황 <span>배정 확정 기준 · 진행 중 = 처리 완료 전</span></caption>
            <thead><tr><th scope="col">담당 부서</th><th scope="col">접수</th><th scope="col">진행 중</th></tr></thead>
            <tbody>${ownRows.map((r) => `<tr class="${r.name === UNASSIGNED && r.n ? "warn-row" : ""}"><th scope="row">${escapeHTML(r.name)}</th><td>${r.n}</td><td>${r.open}</td></tr>`).join("")}</tbody>
          </table>
        </div>
      </div>

      <h3 class="section-title">접수 건 목록 <span>${rows.length}${filtered ? ` / ${total}` : ""}</span></h3>
      <div class="filters">
        ${sel("type", "접수 유형", ["general", "grievance"], (v) => TYPE_LABEL[v])}
        ${sel("category", "분류 칸", cats)}
        ${sel("urgency", "긴급도", urgs)}
        ${sel("owner", "담당 부서", [...roles, UNASSIGNED])}
        ${sel("status", "처리 상태", STATUSES)}
        ${sel("sensitive", "민감사안", ["검토 필요", "해당 없음", "미정"])}
        ${filtered ? `<button type="button" id="flt-reset" class="btn-link">필터 지우기</button>` : ""}
      </div>
      <div class="matrix-wrap case-wrap">
        <table class="case-table">
          <thead><tr>
            <th scope="col">접수번호</th><th scope="col">접수 유형</th><th scope="col">분류 칸</th><th scope="col">긴급도</th>
            <th scope="col">민감사안</th><th scope="col">담당 부서</th><th scope="col">담당자 배정</th><th scope="col">처리 상태</th>
          </tr></thead>
          <tbody>
            ${rows.length ? rows.map((c) => {
              const prot = isProtected(c);
              const s = c.hr.status;
              const nx = nextOf(s);
              const canOwner = s === "검토 중" && !prot;
              const canStatus = nx && !(prot && s !== "접수") && s !== "처리 중";
              return `<tr class="${s === "접수" ? "unread" : ""}">
                <td><button type="button" class="case-link" data-open="${escapeHTML(c.id)}">${escapeHTML(c.id)}</button>${c.demo ? ` <span class="demo-tag">예시</span>` : ""}</td>
                <td>${escapeHTML(TYPE_LABEL[c.type] || "")}</td>
                <td>${escapeHTML(c.hr.category || "미정")}</td>
                <td><span class="u-text ${URG_CLASS[c.hr.urgency] || ""}">${escapeHTML(c.hr.urgency || "미정")}</span></td>
                <td>${sensBadge(c)}</td>
                <td>${canOwner
                  ? `<select data-dash-owner="${escapeHTML(c.id)}" aria-label="${escapeHTML(c.id)} 배정할 담당 부서">${options(["", ...roles], c.hr.ownerDraft, (v) => v || "선택 안 함")}</select><span class="lock-note">배정은 '처리 중'으로 바꿀 때 확정</span>`
                  : `<span class="locked">${ownerText(c)}</span>${prot && !c.hr.assigned ? `<span class="lock-note">HR 검토에서 배정</span>` : s === "접수" ? `<span class="lock-note">검토 시작 후 선택</span>` : ""}`}</td>
                <td>${assignBadge(c)}</td>
                <td>${canStatus
                  ? `<select data-dash-status="${escapeHTML(c.id)}" aria-label="${escapeHTML(c.id)} 처리 상태">${options([s, nx], s)}</select>`
                  : `${statusBadge(s)}${nx ? `<span class="lock-note">${s === "처리 중" ? "완료는 HR 검토에서 결과 확인 후" : "HR 검토에서 진행"}</span>` : ""}`}</td>
              </tr>`;
            }).join("") : `<tr><td colspan="8" class="empty-row">조건에 맞는 접수 건이 없습니다.</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="reason-sub dash-note">접수번호를 누르면 HR 검토 화면에서 그 건을 엽니다. 상태는 한 단계씩만 앞으로 바꿀 수 있고, HR 검토 화면의 버튼과 같은 규칙을 씁니다. 민감사안일 수 있는 건(개인 고충·신고로 접수됐거나 민감사안이 '해당 없음'으로 확정되지 않은 건)의 담당 배정과 완료는 HR 검토 화면에서만 합니다.</p>`;

    box.querySelectorAll("[data-flt]").forEach((el) => el.addEventListener("change", () => { dashFilter[el.dataset.flt] = el.value; renderDash(); }));
    const reset = box.querySelector("#flt-reset");
    if (reset) reset.addEventListener("click", () => { Object.keys(dashFilter).forEach((k) => (dashFilter[k] = "")); renderDash(); });
    box.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => openHR(el.dataset.open)));
    box.querySelectorAll("[data-dash-owner]").forEach((el) => el.addEventListener("change", () => updateCase(findCase(el.dataset.dashOwner), "ownerDraft", el.value, "dash")));
    box.querySelectorAll("[data-dash-status]").forEach((el) =>
      el.addEventListener("change", () => {
        const c = findCase(el.dataset.dashStatus);
        if (el.value !== c.hr.status) advance(c, "dash");
      })
    );
  }

  // ---------- 직원 화면: 입력 흐름 ----------
  const maskInfoText = (counts) =>
    Object.keys(counts).length
      ? Object.entries(counts).map(([k, n]) => `${k} ${n}개`).join(", ") + " 가림"
      : "가린 정보 없음";

  // 1단계: AI 전송 전 확인 — 외부 AI(Gemini)에 보낼 문장을 직원이 확인하는 단계. 아직 아무것도 보내지 않는다.
  let pv = null; // { original, masked, counts, risks, choices, keptNames:Set, confirmed, problem }
  function runPreview() {
    const input = $("#input").value.trim();
    if (!input) {
      $("#input").focus();
      return;
    }
    const { masked, counts } = Mask.maskText(input);
    const risks = Privacy.findRisks(masked);
    const choices = {};
    risks.forEach((r) => (choices[r.id] = r.suggest ? "generalize" : "keep")); // 기본은 가리기·일반화, 바꿀 수 있음
    pv = { original: input, masked, counts, risks, choices, keptNames: new Set(), confirmed: false, problem: null, draft: null };
    renderPreview();
    renderVerdict(null);
  }

  const nameKeptCount = () => (pv ? pv.risks.filter((r) => r.type === "이름" && pv.choices[r.id] === "keep").length : 0);

  // 최종 문장 재검사: 자동 가림 규칙에 걸리는 식별정보, 또는 '이름 아님'으로 확인받지 않은 이름 후보가 있으면 보내지 않는다
  function finalProblems(text) {
    const { counts } = Mask.maskText(text);
    const names = Privacy.findRisks(text).filter((r) => r.type === "이름" && !pv.keptNames.has(r.text));
    return { counts, names, any: Object.keys(counts).length > 0 || names.length > 0 };
  }

  function renderPreview() {
    const box = $("#preview");
    const { original, masked, counts, risks, choices } = pv;
    const finalText = pv.draft !== null ? pv.draft : Privacy.applyChoices(masked, risks, choices);
    const grievance = submitType === "grievance";
    const autoKinds = Object.entries(counts).map(([k, n]) => `${k} ${n}곳`);
    const riskKinds = [...new Set(risks.map((r) => r.type))];
    const detected = autoKinds.length > 0 || risks.length > 0;
    const kept = nameKeptCount();
    const p = pv.problem;
    box.hidden = false;
    box.innerHTML = `
      <div class="col-head pv-head">
        <span class="no">01</span><span class="col-title">AI 전송 전 확인</span>
        <span class="col-meta">아직 AI로 보내지 않았습니다</span>
      </div>
      <p class="pv-purpose">이 단계에서는 <b>외부 AI(Gemini)에 보낼 문장</b>을 확인합니다. 원래 쓴 문장(원문)은 AI로 보내지 않습니다.</p>
      ${grievance ? `
      <div class="type-notice pv-grievance">
        <span>AI에 전달할 문장을 확인해 주세요. 이름이 가려져 있어도 직책, 관계, 특정 사건의 내용으로 개인이 식별될 수 있습니다.</span>
      </div>` : ""}
      ${detected ? `
      <div class="pv-found">
        <p class="pv-label">감지한 개인정보</p>
        <p class="pv-chips">${autoKinds.map((k) => `<span class="chip chip-auto">${escapeHTML(k)} · 자동으로 가림</span>`).join("")}${riskKinds.map((k) => `<span class="chip chip-risk">${escapeHTML(k)} · 확인 필요</span>`).join("")}</p>
      </div>
      <dl class="pv-list">
        <div><dt>원문 <span>AI로 보내지 않음</span></dt><dd>${escapeHTML(original)}</dd></div>
        <div><dt>개인정보를 가린 AI 분석용 문장 <span>${escapeHTML(maskInfoText(counts))}</span></dt><dd>${highlightMasks(masked)}</dd></div>
      </dl>
      ${risks.length ? `
      <div class="pv-risks">
        <p class="pv-label">추가 확인이 필요한 식별 위험 <span>${risks.length}곳</span></p>
        <ul class="risk-list">
          ${risks.map((r) => `
            <li class="risk ${r.type === "이름" ? "risk-name" : ""}">
              <span class="risk-type">${escapeHTML(r.type)} · ${escapeHTML(r.label)}</span>
              <span class="risk-text"><b>${escapeHTML(r.text)}</b>${r.suggest ? ` → ${escapeHTML(r.suggest)}` : ""}</span>
              ${r.suggest ? `
              <span class="risk-toggle" role="group" aria-label="${escapeHTML(r.text)} 처리">
                <button type="button" data-id="${r.id}" data-v="keep" aria-pressed="${choices[r.id] === "keep"}">${escapeHTML((r.labels && r.labels.keep) || "사건 정보로 유지")}</button>
                <button type="button" data-id="${r.id}" data-v="generalize" aria-pressed="${choices[r.id] === "generalize"}">${escapeHTML((r.labels && r.labels.generalize) || "일반화")}</button>
              </span>` : `<span class="risk-hint">사건 정보로 유지하되, 다른 정보와 합쳐 특정되지 않는지 확인</span>`}
            </li>`).join("")}
        </ul>
        <p class="pv-note">사건을 이해하는 데 필요한 내용은 남겨도 됩니다. 이름은 기본으로 가리며, 실제 이름이 아닐 때만 [이름 아님]을 눌러 주세요.</p>
      </div>` : ""}` : `
      <div class="pv-clear">
        <strong>자동 탐지된 개인정보는 없습니다. 내용을 확인한 후 AI 분석을 진행해 주세요.</strong>
        ${grievance ? "" : `<span>자동 탐지가 모든 개인정보를 찾아내지는 못합니다. 이름·연락처처럼 사람을 알아볼 수 있는 내용이 없는지 한 번 더 봐 주세요.</span>`}
      </div>`}
      <label for="final-text" class="pv-label">AI에 보낼 문장 <span>직접 고칠 수 있습니다 · 보내기 전에 한 번 더 검사합니다</span></label>
      <textarea id="final-text" rows="3">${escapeHTML(finalText)}</textarea>
      ${kept ? `<p class="pv-warn" role="status"><b>확인해 주세요</b> 이름일 수 있는 말 ${kept}곳을 '이름 아님'으로 두고 보냅니다. 실제 사람 이름이라면 [가리기]를 눌러 주세요.</p>` : ""}
      ${p ? `
      <div class="pv-stop" role="alert">
        <strong>AI로 보내지 않았습니다. AI에 보낼 문장에 식별정보가 남아 있을 수 있습니다.</strong>
        ${Object.keys(p.counts).length ? `<span>자동 가림 규칙에 걸린 정보: ${escapeHTML(Object.entries(p.counts).map(([k, n]) => `${k} ${n}곳`).join(", "))}</span>` : ""}
        ${p.names.length ? `<span>이름일 수 있는 말: ${p.names.map((r) => `<b>${escapeHTML(r.text)}</b>`).join(", ")}</span>` : ""}
        <span class="pv-stop-actions">
          <button type="button" id="pv-fix" class="btn-secondary">자동으로 가리기</button>
          ${p.names.length && !Object.keys(p.counts).length ? `<button type="button" id="pv-notname" class="btn-link">이름이 아닙니다 · 그대로 두기</button>` : ""}
        </span>
      </div>` : ""}
      ${grievance ? `<label class="check-line"><input type="checkbox" id="pv-confirm" ${pv.confirmed ? "checked" : ""}> AI에 보낼 문장을 확인했습니다.</label>
      ${pv.confirmed ? "" : `<p class="pv-next">체크한 뒤 'AI로 분석'을 눌러 주세요.</p>`}` : ""}
      <div class="pv-actions">
        <button type="button" id="pv-cancel" class="btn-secondary">다시 쓰기</button>
        <button type="button" id="analyze-btn" class="btn-primary" ${grievance && !pv.confirmed ? "disabled" : ""}>AI로 분석</button>
      </div>`;
    const ta = $("#final-text");
    ta.addEventListener("input", () => { pv.draft = ta.value; });
    box.querySelectorAll(".risk-toggle button").forEach((b) =>
      b.addEventListener("click", () => {
        pv.choices[b.dataset.id] = b.dataset.v;
        const r = pv.risks[b.dataset.id];
        if (r && r.type === "이름") b.dataset.v === "keep" ? pv.keptNames.add(r.text) : pv.keptNames.delete(r.text);
        pv.draft = null; // 고르기를 바꾸면 최종 문장을 다시 만든다
        pv.problem = null;
        renderPreview();
      })
    );
    const conf = $("#pv-confirm");
    if (conf) conf.addEventListener("change", () => { pv.confirmed = conf.checked; renderPreview(); });
    const fix = $("#pv-fix");
    if (fix) fix.addEventListener("click", () => {
      let t = Mask.maskText(ta.value).masked;
      const names = Privacy.findRisks(t).filter((r) => r.type === "이름" && !pv.keptNames.has(r.text));
      t = Privacy.applyChoices(t, names, Object.fromEntries(names.map((r) => [r.id, "generalize"])));
      pv.draft = t;
      pv.problem = null;
      renderPreview();
    });
    const notName = $("#pv-notname");
    if (notName) notName.addEventListener("click", () => {
      pv.problem.names.forEach((r) => pv.keptNames.add(r.text));
      pv.problem = null;
      renderPreview();
    });
    $("#pv-cancel").addEventListener("click", () => {
      box.hidden = true;
      pv = null;
      renderVerdict(null);
      $("#input").focus();
    });
    $("#analyze-btn").addEventListener("click", runAnalyze);
  }

  // 2단계: 확인한 최종 문장만 서버로 보낸다 → 가상 사건을 만들어 직원 안내와 HR 화면에 보여 준다
  async function runAnalyze() {
    const finalInput = ($("#final-text").value || "").trim();
    if (!finalInput) {
      $("#final-text").focus();
      return;
    }
    pv.draft = finalInput;
    // 최종 문장을 직접 고치며 개인정보를 다시 넣었을 수 있으므로 보내기 전에 다시 검사하고, 남아 있으면 보내지 않는다
    const prob = finalProblems(finalInput);
    if (prob.any) {
      pv.problem = prob;
      renderPreview();
      return;
    }
    pv.problem = null;
    const masked = finalInput; // 재검사를 통과한 문장 (자동 가림 규칙에 걸리는 것이 없음)
    const generalized = pv.risks.filter((r) => pv.choices[r.id] === "generalize" && r.suggest).length;
    const maskedInfo = maskInfoText(pv.counts) + (generalized ? ` · 주의 항목 ${generalized}곳 가림·일반화` : "");
    const rule = Rules.classify(masked, criteria, keywords); // HR 화면의 비교용 + AI 실패 시 대체용
    const btn = $("#analyze-btn");
    btn.disabled = true;
    btn.textContent = "분석 중…";
    renderVerdict({ loading: true });
    let ai;
    try {
      const data = await callAI([{ id: "input", text: masked }], "full"); // 직원 화면은 확장 모드
      const x = data.results.find((it) => it.id === "input");
      if (x && x.blocked) {
        renderVerdict({ blocked: true, message: x.error });
        return;
      }
      if (!x || !x.ok) throw new Error((x && x.error) || "AI 응답에 결과가 없습니다");
      ai = { source: "ai", model: data.model, category: x.category, urgency: x.urgency, reason: x.reason, extra: x.extra || null, error: null };
    } catch (err) {
      // AI가 실패하면 규칙 분류기로 임시 분류한다
      ai = { source: "rule", model: null, category: rule.category, urgency: rule.urgency, reason: rule.reason, extra: null, error: err.message };
    } finally {
      btn.disabled = false;
      btn.textContent = "AI로 분석";
    }
    const c = createCase({
      type: submitType,
      original: pv.original,
      finalText: masked,
      maskedInfo,
      nameKept: Privacy.findRisks(masked).filter((r) => r.type === "이름").length,
      ai,
      rule: { category: rule.category, urgency: rule.urgency, reason: rule.reason, categoryHits: rule.categoryHits },
    });
    lastCaseId = c.id;
    currentCaseId = c.id;
    renderVerdict({ caseId: c.id });
  }

  // ---------- 채점 탭 ----------
  function confusionTable(rows, label = "규칙 판정") {
    const names = criteria.priority.order;
    const short = (s) => s.split(/[·\s]/)[0].slice(0, 2);
    const cols = rows.some((x) => !x.r.category) ? [...names, null] : names;
    const cell = (a, p) => rows.filter((x) => x.a.category === a && x.r.category === p).length;
    return `
      <div class="matrix-wrap">
        <table class="matrix">
          <caption>칸별 정답 × ${escapeHTML(label)} <span>대각선(진하게 표시)이 맞힌 문장입니다</span></caption>
          <thead>
            <tr><th scope="col" class="corner">정답 \\ 판정</th>
              ${cols.map((p) => `<th scope="col" title="${escapeHTML(p || NO_RESULT)}">${escapeHTML(p ? short(p) : "불가")}</th>`).join("")}
              <th scope="col">정확</th></tr>
          </thead>
          <tbody>
            ${names
              .map((a) => {
                const total = rows.filter((x) => x.a.category === a).length;
                const ok = cell(a, a);
                return `<tr><th scope="row">${escapeHTML(a)}</th>
                  ${cols
                    .map((p) => {
                      const v = cell(a, p);
                      const diag = p === a;
                      return `<td class="${diag ? "diag" : ""} ${v ? "has" : ""} ${!diag && v ? "off" : ""}">${v || "·"}</td>`;
                    })
                    .join("")}
                  <td class="acc">${ok}/${total}</td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>`;
  }

  async function runScore() {
    const btn = $("#score-btn");
    const out = $("#score");
    btn.disabled = true;
    out.hidden = false;
    out.innerHTML = `<p class="empty">채점 중…</p>`;
    try {
      const answers = await loadJSON("data/answer.json"); // 채점할 때만 읽는다
      const rows = answers.map((a) => {
        const { masked } = Mask.maskText(a.text);
        const r = Rules.classify(masked, criteria, keywords);
        return { a, r, catOK: r.category === a.category, urgOK: r.urgency === a.urgency };
      });
      const n = rows.length;
      const catOK = rows.filter((x) => x.catOK).length;
      const urgOK = rows.filter((x) => x.urgOK).length;
      const both = rows.filter((x) => x.catOK && x.urgOK).length;
      const sensitive = "개인 고충·갈등";
      const sensTotal = rows.filter((x) => x.a.category === sensitive).length;
      const sensMiss = rows.filter((x) => x.a.category === sensitive && !x.catOK).length;
      const noMatch = rows.filter((x) => !x.r.category || !x.r.urgency).length;
      const pct = (k) => (n ? ((k / n) * 100).toFixed(1) : "0.0");
      const wrong = rows.filter((x) => !(x.catOK && x.urgOK));
      const when = new Date().toLocaleString("ko-KR");

      const bar = (k) => `<div class="bar" aria-hidden="true"><i style="width:${n ? (k / n) * 100 : 0}%"></i></div>`;
      out.innerHTML = `
        <div class="scoreboard">
          <div class="sb-head">
            <span class="sb-flag">BASELINE</span>
            <span>규칙 분류기 · 정답 ${n}문장</span>
            <span class="sb-time">${escapeHTML(when)}</span>
          </div>
          <div class="metrics">
            <div class="metric">
              <p class="micro"><b>CATEGORY</b>칸 정확도</p>
              <div class="metric-value">${pct(catOK)}<small>%</small></div>
              <div class="metric-sub">${catOK} / ${n} 문장</div>
              ${bar(catOK)}
            </div>
            <div class="metric">
              <p class="micro"><b>URGENCY</b>긴급도 정확도</p>
              <div class="metric-value">${pct(urgOK)}<small>%</small></div>
              <div class="metric-sub">${urgOK} / ${n} 문장</div>
              ${bar(urgOK)}
            </div>
            <div class="metric">
              <p class="micro"><b>BOTH</b>둘 다 맞힘</p>
              <div class="metric-value">${both}<small>/${n}</small></div>
              <div class="metric-sub">칸·긴급도 모두 일치</div>
              ${bar(both)}
            </div>
          </div>
        </div>
        <div class="callout ${sensMiss ? "" : "ok"}">
          <strong>가장 피해야 할 오류</strong> 정답이 '개인 고충·갈등'인 ${sensTotal}문장 중
          <strong>${sensMiss}문장</strong>을 다른 칸으로 판정했습니다.
        </div>
        ${confusionTable(rows)}
        <details class="disclosure conditions">
          <summary>측정 조건</summary>
          <ul>
            <li>측정 시각: ${escapeHTML(when)}</li>
            <li>분류기: 규칙 기반 (AI 미사용) · 같은 입력이면 매번 같은 결과가 나옵니다</li>
            <li>정답: data/answer.json ${n}문장 (판단이 갈린 문장도 이 파일의 정답 그대로 채점)</li>
            <li>기준: criteria.json version ${escapeHTML(criteria.version)} · 분류 단어: keywords.json version ${escapeHTML(keywords.version)}</li>
            <li>문장은 개인정보를 가린 뒤 분류 · '판단 불가'(일치 단어 없음)는 틀린 것으로 셈 (${noMatch}문장)</li>
          </ul>
        </details>
        <h3 class="section-title">틀린 문장 <span>${wrong.length}</span></h3>
        <ol class="miss-list">
          <li class="miss miss-headrow" aria-hidden="true">
            <span>문장</span><span>정답</span><span>규칙 판정</span>
          </li>
          ${wrong.map(({ a, r, catOK, urgOK }) => `
            <li class="miss">
              <div class="miss-main">
                <div class="miss-head">
                  <span class="mid">${escapeHTML(a.id)}</span>
                  ${a.note ? `<span class="tag">${escapeHTML(a.note)}</span>` : ""}
                </div>
                <p class="miss-text">${escapeHTML(a.text)}</p>
                <p class="miss-reason">${escapeHTML(r.reason)}</p>
              </div>
              <div class="miss-cell" data-label="정답">
                <span>${escapeHTML(a.category)}</span>
                <span class="u-text ${URG_CLASS[a.urgency] || ""}">${escapeHTML(a.urgency)}</span>
              </div>
              <div class="miss-cell" data-label="규칙 판정">
                <span class="${catOK ? "" : "bad"}">${escapeHTML(r.category || NO_RESULT)}</span>
                <span class="u-text ${urgOK ? URG_CLASS[r.urgency] || "" : "bad"}">${escapeHTML(r.urgency || NO_RESULT)}</span>
              </div>
            </li>`).join("")}
        </ol>`;
    } catch (err) {
      out.innerHTML = `<p class="empty error">${escapeHTML(err.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- AI 채점 ----------
  const AI_BATCH = 10;

  function tally(rows) {
    const n = rows.length;
    const catOK = rows.filter((x) => x.catOK).length;
    const urgOK = rows.filter((x) => x.urgOK).length;
    const both = rows.filter((x) => x.catOK && x.urgOK).length;
    const sensitive = "개인 고충·갈등";
    const sensTotal = rows.filter((x) => x.a.category === sensitive).length;
    const sensMiss = rows.filter((x) => x.a.category === sensitive && !x.catOK).length;
    const pct = (k) => (n ? Number(((k / n) * 100).toFixed(1)) : 0);
    return { n, catOK, urgOK, both, sensTotal, sensMiss, catPct: pct(catOK), urgPct: pct(urgOK) };
  }

  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function runAIScore() {
    const aiBtn = $("#ai-score-btn");
    const ruleBtn = $("#score-btn");
    const out = $("#score");
    aiBtn.disabled = ruleBtn.disabled = true;
    out.hidden = false;
    try {
      const answers = await loadJSON("data/answer.json"); // 채점할 때만 읽는다
      const prepared = answers.map((a) => ({ a, masked: Mask.maskText(a.text).masked }));
      const n = prepared.length;
      const progress = (k) => (out.innerHTML = `<p class="progress" role="status">AI 채점 중… ${k}/${n}</p>`);
      progress(0);

      // 10개씩 나눠 요청한다. 보내는 것은 id와 가린 문장뿐이고, 정답(category·urgency)은 보내지 않는다.
      const aiById = {};
      let model = null;
      for (let i = 0; i < n; i += AI_BATCH) {
        const batch = prepared.slice(i, i + AI_BATCH);
        try {
          const data = await callAI(batch.map((p) => ({ id: p.a.id, text: p.masked })));
          model = data.model || model;
          data.results.forEach((x) => (aiById[x.id] = x));
        } catch (err) {
          batch.forEach((p) => (aiById[p.a.id] = { ok: false, error: err.message }));
        }
        progress(Math.min(i + AI_BATCH, n));
      }

      // 같은 30문장·같은 정답으로 규칙 분류기도 채점해 나란히 비교한다.
      const ruleRows = prepared.map(({ a, masked }) => {
        const r = Rules.classify(masked, criteria, keywords);
        return { a, r, catOK: r.category === a.category, urgOK: r.urgency === a.urgency };
      });
      // AI 응답을 받지 못한 문장은 규칙으로 대체하지 않고 오답으로 센다.
      const aiRows = prepared.map(({ a }) => {
        const x = aiById[a.id] || { ok: false, error: "응답 없음" };
        const r = x.ok
          ? { category: x.category, urgency: x.urgency, reason: x.reason }
          : { category: null, urgency: null, reason: x.error || "응답 실패" };
        return { a, r, failed: !x.ok, catOK: x.ok && r.category === a.category, urgOK: x.ok && r.urgency === a.urgency };
      });
      const R = tally(ruleRows);
      const A = tally(aiRows);
      const failed = aiRows.filter((x) => x.failed).length;
      const now = new Date();
      const when = now.toLocaleString("ko-KR");
      const wrong = aiRows.filter((x) => !(x.catOK && x.urgOK));
      const diff = (a, b, unit = "%p") => {
        const d = Number((a - b).toFixed(1));
        return `<span class="${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${d}${unit}</span>`;
      };
      const bar = (k) => `<div class="bar" aria-hidden="true"><i style="width:${n ? (k / n) * 100 : 0}%"></i></div>`;

      const report = {
        model: model || "(응답 없음)",
        scored_at: now.toISOString(),
        scored_at_local: when,
        answer_file: "data/answer.json",
        total: n,
        category_accuracy: A.catPct,
        urgency_accuracy: A.urgPct,
        both_correct: A.both,
        failed_count: failed,
        note: "AI 응답을 받지 못한 문장은 오답으로 계산했습니다. 정답 데이터는 AI에 보내지 않았습니다.",
        items: aiRows.map(({ a, r, failed: f, catOK, urgOK }) => ({
          id: a.id,
          text: a.text,
          answer: { category: a.category, urgency: a.urgency, ...(a.note ? { note: a.note } : {}) },
          ai: f ? null : { category: r.category, urgency: r.urgency },
          reason: r.reason,
          correct: { category: catOK, urgency: urgOK, both: catOK && urgOK },
          failed: f,
        })),
      };

      out.innerHTML = `
        <div class="scoreboard">
          <div class="sb-head">
            <span class="sb-flag">GEMINI</span>
            <span>${escapeHTML(model || "모델 응답 없음")} · 정답 ${n}문장 · 응답 실패 ${failed}건</span>
            <span class="sb-time">${escapeHTML(when)}</span>
          </div>
          <div class="metrics">
            <div class="metric">
              <p class="micro"><b>CATEGORY</b>칸 정확도</p>
              <div class="metric-value">${A.catPct.toFixed(1)}<small>%</small></div>
              <div class="metric-sub">${A.catOK} / ${n} 문장</div>
              ${bar(A.catOK)}
            </div>
            <div class="metric">
              <p class="micro"><b>URGENCY</b>긴급도 정확도</p>
              <div class="metric-value">${A.urgPct.toFixed(1)}<small>%</small></div>
              <div class="metric-sub">${A.urgOK} / ${n} 문장</div>
              ${bar(A.urgOK)}
            </div>
            <div class="metric">
              <p class="micro"><b>BOTH</b>둘 다 맞힘</p>
              <div class="metric-value">${A.both}<small>/${n}</small></div>
              <div class="metric-sub">칸·긴급도 모두 일치</div>
              ${bar(A.both)}
            </div>
          </div>
        </div>

        <div class="matrix-wrap">
          <table class="vs-table">
            <caption>규칙 vs Gemini <span>같은 ${n}문장 · 같은 정답(data/answer.json)</span></caption>
            <thead><tr><th scope="col">항목</th><th scope="col">규칙</th><th scope="col">Gemini</th><th scope="col">차이</th></tr></thead>
            <tbody>
              <tr><th scope="row">칸 정확도</th><td>${R.catPct.toFixed(1)}%</td><td>${A.catPct.toFixed(1)}%</td><td>${diff(A.catPct, R.catPct)}</td></tr>
              <tr><th scope="row">긴급도 정확도</th><td>${R.urgPct.toFixed(1)}%</td><td>${A.urgPct.toFixed(1)}%</td><td>${diff(A.urgPct, R.urgPct)}</td></tr>
              <tr><th scope="row">둘 다 맞힘</th><td>${R.both}/${n}</td><td>${A.both}/${n}</td><td>${diff(A.both, R.both, "")}</td></tr>
              <tr><th scope="row">개인 고충을 다른 칸으로 판정</th><td>${R.sensMiss}/${R.sensTotal}</td><td>${A.sensMiss}/${A.sensTotal}</td><td>${A.sensMiss === R.sensMiss ? "같음" : A.sensMiss < R.sensMiss ? `<span class="up">${R.sensMiss - A.sensMiss}건 적음</span>` : `<span class="down">${A.sensMiss - R.sensMiss}건 많음</span>`}</td></tr>
              <tr><th scope="row">AI 응답 실패</th><td>–</td><td>${failed}건</td><td></td></tr>
            </tbody>
          </table>
        </div>

        <div class="callout ${A.sensMiss ? "" : "ok"}">
          <strong>가장 피해야 할 오류</strong> Gemini는 정답이 '개인 고충·갈등'인 ${A.sensTotal}문장 중
          <strong>${A.sensMiss}문장</strong>을 다른 칸으로 판정했습니다.
        </div>

        <div class="download-row">
          <button id="ai-download-btn" class="btn-secondary">AI 채점 결과 내려받기</button>
          <span>ai_채점결과.json · 내 컴퓨터에만 저장됩니다</span>
        </div>

        ${confusionTable(aiRows, "Gemini 판정")}

        <details class="disclosure conditions">
          <summary>측정 조건</summary>
          <ul>
            <li>측정 시각: ${escapeHTML(when)} · 모델: ${escapeHTML(model || "모델 응답 없음")}</li>
            <li>정답: data/answer.json ${n}문장 (판단이 갈린 문장도 이 파일의 정답 그대로 채점)</li>
            <li>AI에 보낸 것: 문장 id와 개인정보를 가린 문장, criteria.json 기준 (정답은 보내지 않음)</li>
            <li>10문장씩 ${Math.ceil(n / AI_BATCH)}회 요청 · 응답을 받지 못한 문장은 오답으로 셈 (${failed}건) · 규칙으로 대체하지 않음</li>
            <li>AI는 같은 문장에도 측정할 때마다 결과가 조금 달라질 수 있습니다. 두 번 이상 측정해 변동 폭을 확인하세요.</li>
          </ul>
        </details>

        <h3 class="section-title">Gemini가 틀린 문장 <span>${wrong.length}</span></h3>
        <ol class="miss-list">
          <li class="miss miss-headrow" aria-hidden="true">
            <span>문장</span><span>정답</span><span>Gemini 판정</span>
          </li>
          ${wrong.map(({ a, r, failed: f, catOK, urgOK }) => `
            <li class="miss">
              <div class="miss-main">
                <div class="miss-head">
                  <span class="mid">${escapeHTML(a.id)}</span>
                  ${a.note ? `<span class="tag">${escapeHTML(a.note)}</span>` : ""}
                  ${f ? `<span class="tag tag-fail">응답 실패</span>` : ""}
                </div>
                <p class="miss-text">${escapeHTML(a.text)}</p>
                <p class="miss-reason">${escapeHTML(r.reason || "")}</p>
              </div>
              <div class="miss-cell" data-label="정답">
                <span>${escapeHTML(a.category)}</span>
                <span class="u-text ${URG_CLASS[a.urgency] || ""}">${escapeHTML(a.urgency)}</span>
              </div>
              <div class="miss-cell" data-label="Gemini 판정">
                <span class="${catOK ? "" : "bad"}">${escapeHTML(f ? "응답 실패" : r.category)}</span>
                <span class="u-text ${urgOK ? URG_CLASS[r.urgency] || "" : "bad"}">${escapeHTML(f ? "–" : r.urgency)}</span>
              </div>
            </li>`).join("")}
        </ol>`;

      $("#ai-download-btn").addEventListener("click", () => downloadJSON("ai_채점결과.json", report));
    } catch (err) {
      out.innerHTML = `<p class="empty error">${escapeHTML(err.message)}</p>`;
    } finally {
      aiBtn.disabled = ruleBtn.disabled = false;
    }
  }

  async function init() {
    setupTabs();
    $("#classify-btn").addEventListener("click", runPreview);
    $("#input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runPreview();
    });
    $("#score-btn").addEventListener("click", runScore);
    $("#ai-score-btn").addEventListener("click", runAIScore);
    // 탭을 바꿀 때 HR 화면과 직원 안내(진행 상태 반영)를 다시 그린다
    $("#tab-hr").addEventListener("click", () => criteria && renderHR());
    $("#tab-dash").addEventListener("click", () => criteria && renderDash());
    $("#tab-classify").addEventListener("click", () => lastCaseId && renderEmployeeResult(lastCaseId));
    try {
      [criteria, keywords] = await Promise.all([loadJSON("criteria.json"), loadJSON("keywords.json")]);
      $("#cat-list").innerHTML = criteria.categories
        .map((c) => `<li><strong>${escapeHTML(c.name)}</strong><span>${escapeHTML(c.definition)}</span></li>`)
        .join("");
      renderVerdict(null);
    } catch (err) {
      showLoadError(err);
    }
    try { sensitiveCfg = await loadJSON("sensitive.json"); } catch (_) { sensitiveCfg = null; }
    try { routingCfg = await loadJSON("routing.json"); } catch (_) { routingCfg = null; }
    // 과제용 가상 사례를 HR 화면·대시보드에 미리 넣는다 (메모리에만, 새로 고치면 처음 상태)
    if (criteria && keywords) {
      try { loadDemoCases(await loadJSON("demo_cases.json")); } catch (_) { /* 예시가 없어도 화면은 돈다 */ }
    }

    // 제출 유형 선택 — 화면 안내에만 쓴다 (AI로 보내지 않음)
    document.querySelectorAll(".type-toggle button").forEach((b) =>
      b.addEventListener("click", () => {
        submitType = b.dataset.type;
        document.querySelectorAll(".type-toggle button").forEach((x) => x.setAttribute("aria-pressed", x === b));
        $("#type-notice").hidden = submitType !== "grievance";
        if (pv && !$("#preview").hidden) renderPreview(); // 유형에 맞는 확인 안내로 바꾼다
      })
    );
  }

  document.addEventListener("DOMContentLoaded", init);
})();
