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

  function urgencyScale(levels, value) {
    return `
      <div class="scale" role="img" aria-label="긴급도 ${escapeHTML(value || NO_RESULT)}">
        ${levels
          .map((u) => `<span class="seg ${URG_CLASS[u] || ""} ${u === value ? "on" : ""}"><b>${escapeHTML(u)}</b></span>`)
          .join("")}
      </div>`;
  }

  // 민감사안 줄 — AI가 실패했거나 확장 항목을 확인할 수 없으면 늘 '확인 불가 · 사람 검토'
  function sensitiveRow(isAI, extra) {
    const unknown = (sensitiveCfg && sensitiveCfg.fallback_display) || FALLBACK_SENSITIVE;
    if (!isAI || !extra) {
      return `
      <div class="verdict-row">
        <p class="micro"><b>SENSITIVE</b>민감사안</p>
        <p class="sensitive-unknown">${escapeHTML(unknown)}</p>
        <p class="reason-sub">${isAI ? "AI가 민감사안 항목을 정해진 형식으로 돌려주지 않았습니다." : "규칙 분류는 민감사안을 판단하지 않습니다."} 괴롭힘·안전 등이 의심되거나 분류가 불확실하면 사람이 직접 검토해 주세요.</p>
      </div>`;
    }
    const s = extra.sensitive;
    if (!s.review_needed) {
      return `
      <div class="verdict-row">
        <p class="micro"><b>SENSITIVE</b>민감사안</p>
        <p class="sensitive-none">검토 표시 없음</p>
        <p class="reason-sub">AI가 민감사안 유형을 찾지 못했다는 뜻이며, 안전하다는 판정은 아닙니다.</p>
      </div>`;
    }
    return `
      <div class="verdict-row sensitive-on">
        <p class="micro"><b>SENSITIVE</b>민감사안</p>
        <p class="sensitive-flag">${escapeHTML((sensitiveCfg && sensitiveCfg.label) || "민감사안 검토 필요")}</p>
        ${s.types.length ? `<p class="sensitive-types">${s.types.map((t) => `<span>${escapeHTML(t)}</span>`).join("")}</p>` : ""}
        ${s.basis ? `<p class="reason-sub">${escapeHTML(s.basis)}</p>` : ""}
      </div>`;
  }

  // 권장 검토 담당 · 권장 후속 조치 · 고충 안내 · HR 검토 대기
  function supportRows(isAI, extra, category) {
    const rc = routingCfg || {};
    let role, actions, isDefault = false;
    if (isAI && extra) {
      role = extra.owner_role;
      actions = extra.actions;
    } else {
      // AI 실패 시: routing.json의 기본값. 고충을 골랐다면 지정된 고충처리 담당자를 권한다.
      isDefault = true;
      role = submitType === "grievance"
        ? (rc.sensitive_role && rc.sensitive_role.default) || "지정된 고충처리 담당자"
        : (category && rc.category_default_role && rc.category_default_role[category]) || "HR 담당자";
      actions = (category && rc.fallback_actions && rc.fallback_actions[category]) || ["분류가 불확실하므로 HR 담당자가 원문 맥락을 직접 확인"];
    }
    const sensitiveCase = submitType === "grievance" || (isAI && extra && extra.sensitive.review_needed);
    const guide = (sensitiveCfg && sensitiveCfg.sensitive_guidance) || [];
    const path = (sensitiveCfg && sensitiveCfg.report_path_notice) || "";
    return `
      <div class="verdict-row">
        <p class="micro"><b>OWNER</b>권장 검토 담당 ${isDefault ? `<span class="tmp-tag">기본값</span>` : ""}</p>
        <p class="owner">${escapeHTML(role)}</p>
      </div>
      <div class="verdict-row">
        <p class="micro"><b>NEXT</b>권장 후속 조치 ${isDefault ? `<span class="tmp-tag">기본값</span>` : ""}</p>
        <ol class="actions">${actions.map((a) => `<li>${escapeHTML(a)}</li>`).join("")}</ol>
      </div>
      ${sensitiveCase ? `
      <div class="verdict-row care">
        <p class="micro"><b>CARE</b>민감한 고충 안내</p>
        <ul class="care-list">${guide.map((g) => `<li>${escapeHTML(g)}</li>`).join("")}${path ? `<li>${escapeHTML(path)}</li>` : ""}</ul>
      </div>` : ""}
      <div class="verdict-row hr-box">
        <p class="hr-title">HR 검토 대기 <span>실습용</span></p>
        <p class="reason-sub">실제 서비스에서는 권한 있는 HR 담당자가 이 결과를 검토하고 배정합니다. ${escapeHTML(rc.notice || "권장 담당과 후속 조치는 참고 정보이며 자동으로 배정되지 않습니다.")} 이 화면은 내용을 전송하거나 저장하지 않습니다.</p>
      </div>`;
  }

  function renderVerdict(state) {
    const catNames = criteria ? criteria.priority.order : [];
    const urgNames = criteria ? criteria.urgency_levels.map((u) => u.name) : [];
    const out = $("#result");
    const meta = $("#verdict-meta");

    if (!state || state.loading) {
      out.className = "verdict-panel idle";
      if (meta) meta.textContent = "Gemini 판정 · 실패 시 규칙";
      out.innerHTML = `
        <div class="verdict-top">
          <p class="micro"><b>CATEGORY</b>분류 칸</p>
          <p class="idle-msg">${state && state.loading ? "AI가 의견을 분석하고 있습니다…" : "분석할 의견을 기다리고 있습니다."}</p>
        </div>
        <div class="verdict-row">
          <p class="micro"><b>URGENCY</b>긴급도</p>
          ${urgencyScale(urgNames, null)}
        </div>`;
      return;
    }

    if (state.blocked) {
      // 서버 재검사에서 직접 식별정보가 발견돼 AI로 보내지 않은 경우 — 분류하지 않고 수정을 안내한다
      out.className = "verdict-panel";
      if (meta) meta.textContent = "AI로 보내지 않음";
      out.innerHTML = `
        <div class="fallback-note blocked-note" role="alert">
          <strong>개인정보가 남아 있어 AI로 보내지 않았습니다.</strong>
          <span>${escapeHTML(state.message)}</span>
        </div>
        <div class="verdict-top">
          <p class="idle-msg">왼쪽 '최종 문장'에서 해당 부분을 지우거나 고친 뒤 다시 'AI로 분석'을 눌러 주세요.</p>
        </div>`;
      return;
    }

    const { r, masked, maskedInfo, source, model, aiError, rule, extra } = state;
    const isAI = source === "ai";
    if (meta) meta.textContent = isAI ? `Gemini 판정 · ${model || ""}` : "규칙 기반 임시 분류 · AI 미사용";
    const tmp = isAI ? "" : `<span class="tmp-tag">임시</span>`;
    out.className = "verdict-panel";
    out.innerHTML = `
      ${isAI ? "" : `
      <div class="fallback-note" role="status">
        <strong>AI 분석 실패 — AI 없이 규칙으로 갈랐습니다.</strong>
        <span>${escapeHTML(friendlyError(aiError))} 아래는 규칙 기반 임시 분류로, 낱말만 비교하므로 정확도가 낮습니다.</span>
        ${aiError ? `<details class="err-detail"><summary>오류 자세히</summary><code>${escapeHTML(aiError)}</code></details>` : ""}
      </div>`}
      <div class="verdict-top">
        <p class="micro"><b>CATEGORY</b>분류 칸 ${tmp}</p>
        <div class="verdict-cat ${r.category ? "" : "none"}">${escapeHTML(r.category || NO_RESULT)}</div>
      </div>
      <div class="verdict-row">
        <p class="micro"><b>URGENCY</b>긴급도 ${tmp}</p>
        ${urgencyScale(urgNames, r.urgency)}
      </div>
      ${sensitiveRow(isAI, extra)}
      <div class="verdict-row">
        <p class="micro"><b>REASON</b>판단 이유</p>
        <p class="reason">${escapeHTML(r.reason)}</p>
        ${isAI && extra && extra.needs_more_info ? `<p class="more-info"><b>추가 확인 필요</b> ${escapeHTML(extra.info_to_check || "정확한 상황 확인이 필요합니다.")}</p>` : ""}
      </div>
      ${supportRows(isAI, extra, r.category)}
      <div class="verdict-foot">
        <p class="foot-label">분류에 쓴 최종 문장 <span>${escapeHTML(maskedInfo)}</span></p>
        <p class="masked-text">${highlightMasks(masked)}</p>
        ${isAI && rule ? `
        <p class="compare-line">규칙 분류기 판정: <b>${escapeHTML(rule.category || NO_RESULT)}</b> · <b>${escapeHTML(rule.urgency || NO_RESULT)}</b></p>` : ""}
        ${(rule || r).categoryHits ? `
        <details class="mini-disclosure">
          <summary>규칙 분류기의 칸별 일치 단어 수</summary>
          <ol class="hits">${hitRows(catNames, (rule || r).categoryHits, (rule || r).category)}</ol>
        </details>` : ""}
      </div>`;
  }

  // ---------- 분류 탭 ----------
  const maskInfoText = (counts) =>
    Object.keys(counts).length
      ? Object.entries(counts).map(([k, n]) => `${k} ${n}개`).join(", ") + " 가림"
      : "가린 정보 없음";

  // 1단계: 전송 전 확인 — 아직 아무것도 서버로 보내지 않는다
  let pv = null; // { original, masked, counts, risks, choices }
  function runPreview() {
    const input = $("#input").value.trim();
    if (!input) {
      $("#input").focus();
      return;
    }
    const { masked, counts } = Mask.maskText(input);
    const risks = Privacy.findRisks(masked);
    const choices = {};
    risks.forEach((r) => (choices[r.id] = r.suggest ? "generalize" : "keep")); // 기본은 일반화, 바꿀 수 있음
    pv = { original: input, masked, counts, risks, choices };
    renderPreview();
    renderVerdict(null);
  }

  function renderPreview() {
    const box = $("#preview");
    const { original, masked, counts, risks, choices } = pv;
    const finalText = Privacy.applyChoices(masked, risks, choices);
    box.hidden = false;
    box.innerHTML = `
      <div class="col-head pv-head">
        <span class="no">01</span><span class="col-title">전송 전 확인</span>
        <span class="col-meta">아직 AI로 보내지 않았습니다</span>
      </div>
      <dl class="pv-list">
        <div><dt>원래 문장</dt><dd>${escapeHTML(original)}</dd></div>
        <div><dt>개인정보를 가린 문장 <span>${escapeHTML(maskInfoText(counts))}</span></dt><dd>${highlightMasks(masked)}</dd></div>
      </dl>
      <div class="pv-risks">
        <p class="pv-label">추가로 식별 위험이 있을 수 있는 부분 <span>${risks.length}곳</span></p>
        ${risks.length ? `
        <ul class="risk-list">
          ${risks.map((r) => `
            <li class="risk">
              <span class="risk-type">${escapeHTML(r.type)} · ${escapeHTML(r.label)}</span>
              <span class="risk-text"><b>${escapeHTML(r.text)}</b>${r.suggest ? ` → ${escapeHTML(r.suggest)}` : ""}</span>
              ${r.suggest ? `
              <span class="risk-toggle" role="group" aria-label="${escapeHTML(r.text)} 처리">
                <button type="button" data-id="${r.id}" data-v="keep" aria-pressed="${choices[r.id] === "keep"}">사건 정보로 유지</button>
                <button type="button" data-id="${r.id}" data-v="generalize" aria-pressed="${choices[r.id] === "generalize"}">일반화</button>
              </span>` : `<span class="risk-hint">사건 정보로 유지하되, 다른 정보와 합쳐 특정되지 않는지 확인</span>`}
            </li>`).join("")}
        </ul>` : `<p class="pv-none">자동으로 찾은 부분은 없습니다. 그래도 사람을 알아볼 수 있는 내용이 없는지 한 번 더 확인해 주세요.</p>`}
        <p class="pv-note">사건을 이해하는 데 필요한 내용은 남겨도 됩니다. 이 확인을 거쳐도 익명이 완전히 보장되지는 않습니다.</p>
      </div>
      <label for="final-text" class="pv-label">AI에 보낼 최종 문장 <span>직접 고칠 수 있습니다</span></label>
      <textarea id="final-text" rows="3">${escapeHTML(finalText)}</textarea>
      <div class="pv-actions">
        <button type="button" id="pv-cancel" class="btn-secondary">다시 쓰기</button>
        <button type="button" id="analyze-btn" class="btn-primary">AI로 분석</button>
      </div>`;
    box.querySelectorAll(".risk-toggle button").forEach((b) =>
      b.addEventListener("click", () => {
        pv.choices[b.dataset.id] = b.dataset.v;
        renderPreview();
      })
    );
    $("#pv-cancel").addEventListener("click", () => {
      box.hidden = true;
      pv = null;
      renderVerdict(null);
      $("#input").focus();
    });
    $("#analyze-btn").addEventListener("click", runAnalyze);
  }

  // 2단계: 확인한 최종 문장만 서버로 보낸다
  async function runAnalyze() {
    const finalInput = ($("#final-text").value || "").trim();
    if (!finalInput) {
      $("#final-text").focus();
      return;
    }
    // 최종 문장을 직접 고치며 개인정보를 다시 넣었을 수 있으므로 한 번 더 가린다
    const { masked, counts } = Mask.maskText(finalInput);
    const all = { ...(pv ? pv.counts : {}) };
    Object.entries(counts).forEach(([k, n]) => (all[k] = (all[k] || 0) + n));
    const generalized = pv ? pv.risks.filter((r) => pv.choices[r.id] === "generalize" && r.suggest).length : 0;
    const maskedInfo = maskInfoText(all) + (generalized ? ` · 주의 항목 ${generalized}곳 일반화` : "");
    const rule = Rules.classify(masked, criteria, keywords); // 비교용 + AI 실패 시 대체용
    const btn = $("#analyze-btn");
    btn.disabled = true;
    btn.textContent = "분석 중…";
    renderVerdict({ loading: true });
    try {
      const data = await callAI([{ id: "input", text: masked }], "full"); // 분류 탭은 확장 모드
      const x = data.results.find((it) => it.id === "input");
      if (x && x.blocked) {
        renderVerdict({ blocked: true, message: x.error });
        return;
      }
      if (!x || !x.ok) throw new Error((x && x.error) || "AI 응답에 결과가 없습니다");
      renderVerdict({
        source: "ai", model: data.model, rule, masked, maskedInfo, extra: x.extra || null,
        r: { category: x.category, urgency: x.urgency, reason: x.reason },
      });
    } catch (err) {
      // AI가 실패하면 규칙 분류기로 임시 분류한다
      renderVerdict({ source: "rule", r: rule, masked, maskedInfo, aiError: err.message });
    } finally {
      btn.disabled = false;
      btn.textContent = "AI로 분석";
    }
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

    // 제출 유형 선택 — 화면 안내에만 쓴다 (AI로 보내지 않음)
    document.querySelectorAll(".type-toggle button").forEach((b) =>
      b.addEventListener("click", () => {
        submitType = b.dataset.type;
        document.querySelectorAll(".type-toggle button").forEach((x) => x.setAttribute("aria-pressed", x === b));
        $("#type-notice").hidden = submitType !== "grievance";
      })
    );
  }

  document.addEventListener("DOMContentLoaded", init);
})();
