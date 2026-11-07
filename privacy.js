// privacy.js — 전송 전 확인 단계에서 '추가로 식별 위험이 있을 수 있는 부분'을 찾는다.
// mask.js(자동 가림)는 그대로 두고, 이 파일은 표시와 일반화 제안만 한다. 지우는 것은 사용자가 고른다.
//
// 한계: 낱말 모양으로 찾기 때문에 놓치거나, 위험하지 않은 말을 표시할 수 있다.
//       여러 정보가 합쳐져 사람이 좁혀지는 경우(예: 팀 + 나이 + 휴직 시기)는 사용자가 직접 판단해야 한다.
//       이 단계를 거쳐도 익명이 보장되지는 않는다.

(function () {
  // 팀·부서 이름에서 일반 표현은 빼고 본다 ("같은 팀", "우리 팀" 등은 사람을 좁히지 않는다)
  const GENERIC_UNITS = new Set(["같은", "우리", "다른", "저희", "타", "각", "전", "모든", "여러", "해당", "그", "이", "협업하는", "팀"]);

  const RULES = [
    {
      type: "조직", label: "팀·부서 이름", suggest: "[팀]",
      re: /(?<![가-힣A-Za-z0-9○])([가-힣A-Za-z0-9○]{1,12})(팀|그룹|본부|파트|센터|사업부|실)(?=[^가-힣]|[은는이가을를의에와과도만랑]|$)/g,
      keep: (m) => !GENERIC_UNITS.has(m[1]),
    },
    { type: "조직", label: "직책", suggest: "[직책]", re: /(?<![가-힣])(그룹장|본부장|실장|센터장|대표|임원|팀장)(?=님|[^가-힣]|[은는이가을를의에와과도께]|$)/g },
    { type: "시간", label: "날짜", suggest: "최근", re: /\d{4}\s?[-./년]\s?\d{1,2}\s?[-./월]\s?\d{1,2}일?|\d{1,2}\s?월\s?\d{1,2}\s?일|(?:지난|이번|다음)\s?주?\s?[월화수목금토일]요일/g },
    { type: "시간", label: "시각", suggest: "[시간]", re: /(?:오전|오후|새벽|밤)\s?\d{1,2}\s?시(?:\s?\d{1,2}\s?분)?|\d{1,2}:\d{2}/g },
    { type: "장소", label: "층·호실", suggest: "[장소]", re: /(?<![0-9])\d{1,3}\s?층|\d{2,4}\s?호(?![가-힣])/g },
    { type: "장소", label: "회의실·좌석", suggest: "[장소]", re: /[A-Z0-9]{1,3}\s?(?:룸|회의실)|(?:회의실|좌석|자리|포커스룸|폰부스)\s?[A-Z0-9][A-Z0-9-]*/g },
    { type: "개인 특성", label: "나이", suggest: "[개인 특성]", re: /\d{1,2}\s?(?:살|세)(?![가-힣])|\d0\s?대(?![가-힣])/g },
    { type: "개인 특성", label: "성별", suggest: "[개인 특성]", re: /(?:여성|남성|여자|남자|여직원|남직원)(?:\s?(?:팀원|직원|동료))?/g },
    { type: "개인 특성", label: "가족관계", suggest: "[가족]", re: /(?:아내|남편|와이프|자녀|아이|애|딸|아들|부모님|아버지|어머니|부친|모친|장인|장모|시부모)(?=[^가-힣]|[가-힣]{0,2}(?:이|가|을|를|의|는|은|도|랑|와|과|때문|등원|상))/g },
    { type: "개인 특성", label: "건강·임신·휴직", suggest: "[개인 사정]", re: /정신과|우울증|공황|임신|출산|육아휴직|병가|입원|수술|장애|질병|암 진단/g },
    { type: "사건", label: "프로젝트·사건 이름", suggest: "[프로젝트]", re: /[가-힣A-Za-z0-9]{2,15}\s?프로젝트|프로젝트\s?[A-Za-z0-9가-힣]{1,12}(?=[^가-힣]|[은는이가을를의에]|$)/g },
    { type: "제3자", label: "제3자 지칭", suggest: null, re: /목격자|가해자|피해자|신고\s?대상자?/g },
  ];

  // 겹치는 표시는 먼저 찾은(더 긴) 쪽을 남긴다
  function findRisks(text) {
    const s = String(text || "");
    const found = [];
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(s))) {
        if (rule.keep && !rule.keep(m)) continue;
        const start = m.index, end = m.index + m[0].length;
        if (s.slice(Math.max(0, start - 1), start) === "[") continue; // [이름] 같은 가린 자리는 건너뜀
        found.push({ type: rule.type, label: rule.label, text: m[0], start, end, suggest: rule.suggest });
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const out = [];
    for (const f of found) {
      if (out.length && f.start < out[out.length - 1].end) continue;
      out.push(f);
    }
    return out.map((f, i) => ({ id: i, ...f }));
  }

  // choices: { [id]: "generalize" | "keep" } — 일반화를 고른 항목만 제안 문구로 바꾼다
  function applyChoices(text, risks, choices) {
    let out = "", pos = 0;
    for (const r of risks) {
      out += text.slice(pos, r.start);
      out += choices[r.id] === "generalize" && r.suggest ? r.suggest : text.slice(r.start, r.end);
      pos = r.end;
    }
    return out + text.slice(pos);
  }

  window.Privacy = { findRisks, applyChoices };
})();
