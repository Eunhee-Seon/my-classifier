// rules.js — AI 없이 단어와 규칙만으로 분류한다.
// 분류 칸·우선순위·긴급도는 criteria.json, 분류 단어는 keywords.json에서 받는다. (이 파일에 기준을 직접 적지 않는다.)
//
// 판정 방법 (keywords.json의 method와 같다)
//  1. 가린 문장의 낱말마다 첫 두 글자를 만든다. 가린 자리([이름] 등)는 뺀다.
//  2. 칸마다 일치한 단어 수를 센다. 가장 많이 일치한 칸이 그 문장에 해당하는 칸이다.
//     일치 수가 같은 칸이 여럿이면 criteria.json의 우선순위(앞 칸)를 따른다.
//  3. 긴급도도 같은 방식이고, 일치 수가 같으면 더 심각한 쪽을 따른다.
//  4. 일치하는 단어가 하나도 없으면 기준에 정해진 처리가 없으므로 '판단 불가'(null)로 둔다.

(function () {
  function wordStarts(text) {
    const cleaned = String(text).replace(/\[[^\]]*\]/g, " ");
    const set = new Set();
    for (const tok of cleaned.match(/[가-힣]+/g) || []) {
      if (tok.length >= 2) set.add(tok.slice(0, 2));
    }
    return set;
  }

  // labels: 우선순위 순서대로 정렬된 이름 목록, table: {이름: {words: [...]}}
  function pick(starts, labels, table) {
    const hits = labels.map((name) => ({
      name,
      words: ((table[name] && table[name].words) || []).filter((w) => starts.has(w)),
    }));
    const best = Math.max(0, ...hits.map((h) => h.words.length));
    if (best === 0) return { winner: null, tied: [], hits };
    const tied = hits.filter((h) => h.words.length === best); // labels 순서 = 우선순위 순서
    return { winner: tied[0], tied, hits };
  }

  function quote(words, n = 3) {
    const shown = words.slice(0, n).map((w) => `'${w}'`).join(", ");
    return words.length > n ? `${shown} 등 ${words.length}개` : shown;
  }

  function classify(maskedText, criteria, keywords) {
    const starts = wordStarts(maskedText);
    const catOrder = criteria.priority.order;
    const urgOrder = criteria.urgency_levels.map((u) => u.name); // 높음 → 보통 → 낮음 (심각한 순)

    const cat = pick(starts, catOrder, keywords.categories);
    const urg = pick(starts, urgOrder, keywords.urgency);

    let catPart;
    if (!cat.winner) {
      catPart = "칸: 일치하는 분류 단어가 없어 판단 불가";
    } else if (cat.tied.length > 1) {
      catPart = `칸: ${cat.tied.map((t) => t.name).join("·")}이(가) 동점(${cat.winner.words.length}개)이라 우선순위에 따라 ${cat.winner.name}`;
    } else {
      catPart = `칸: ${quote(cat.winner.words)} 일치 → ${cat.winner.name}`;
    }

    let urgPart;
    if (!urg.winner) {
      urgPart = "긴급도: 일치하는 단어가 없어 판단 불가";
    } else if (urg.tied.length > 1) {
      urgPart = `긴급도: ${urg.tied.map((t) => t.name).join("·")} 동점이라 더 심각한 ${urg.winner.name}`;
    } else {
      urgPart = `긴급도: ${quote(urg.winner.words)} 일치 → ${urg.winner.name}`;
    }

    return {
      category: cat.winner ? cat.winner.name : null,
      urgency: urg.winner ? urg.winner.name : null,
      reason: `${catPart} / ${urgPart}`,
      categoryHits: cat.hits,
      urgencyHits: urg.hits,
    };
  }

  window.Rules = { classify };
})();
