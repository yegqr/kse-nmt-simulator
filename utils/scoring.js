const LETTERS = ['А', 'Б', 'В', 'Г', 'Д'];

function normalizeOpenMath(str) {
  if (str === null || str === undefined) return '';
  const normalized = String(str).trim().toLowerCase().replace(/,/g, '.');
  const num = parseFloat(normalized);
  if (!isNaN(num) && isFinite(num)) return String(num);
  return normalized;
}

function calculateScore(questions, answers) {
  let scoreUkr = 0, scoreMath = 0;

  for (const q of questions) {
    const ans = answers[q.id];
    if (ans === undefined || ans === null) continue;

    let pts = 0;

    if (q.type === 'single') {
      const userSelected = String(ans).trim();
      const correctText = String(q.correct_answer).trim();

      if (userSelected === correctText) {
        pts = q.points || 1;
      } else {
        try {
          const opts = JSON.parse(q.options || '[]');
          const idx = LETTERS.indexOf(userSelected);
          if (idx >= 0 && opts[idx]) {
            const optText = String(opts[idx]).trim();
            const cleanOptText = optText.replace(/^[А-Д]\)\s*/, '').trim();
            const cleanCorrect = correctText.replace(/^[А-Д]\)\s*/, '').trim();
            if (cleanOptText === cleanCorrect || optText === correctText) {
              pts = q.points || 1;
            }
          }
        } catch (_) {}
      }
    } else if (q.type === 'multiple') {
      try {
        const userArr = (Array.isArray(ans) ? ans : JSON.parse(ans)).map(String).sort();
        const corrArr = JSON.parse(q.correct_answer).map(String).sort();
        if (JSON.stringify(userArr) === JSON.stringify(corrArr)) {
          pts = q.points || 1;
        }
      } catch (_) {}
    } else if (q.type === 'match') {
      try {
        const userMap = typeof ans === 'object' ? ans : JSON.parse(ans);
        const corrMap = JSON.parse(q.correct_answer);
        const rightOpts = JSON.parse(q.match_right || '[]');

        for (const key of Object.keys(corrMap)) {
          const userVal = userMap[key];
          const correctVal = corrMap[key];

          if (userVal === correctVal) {
            pts++;
          } else {
            const idx = LETTERS.indexOf(userVal);
            if (idx >= 0 && rightOpts[idx]) {
              const optText = String(rightOpts[idx]).trim();
              const cleanOptText = optText.replace(/^[А-Д]\.\s*/, '').trim();
              const cleanCorrect = String(correctVal).replace(/^[А-Д]\.\s*/, '').trim();
              if (cleanOptText === cleanCorrect || optText === correctVal) {
                pts++;
              }
            }
          }
        }
      } catch (_) {}
    } else if (q.type === 'open') {
      let isCorrect;
      if (q.subject === 'math') {
        isCorrect = normalizeOpenMath(ans) === normalizeOpenMath(q.correct_answer);
      } else {
        isCorrect = String(ans).trim().toLowerCase() === String(q.correct_answer).trim().toLowerCase();
      }
      if (isCorrect) pts = q.points || 1;
    }

    if (q.subject === 'ukrainian') scoreUkr += pts;
    else scoreMath += pts;
  }

  return { scoreUkr, scoreMath };
}

module.exports = { calculateScore, normalizeOpenMath, LETTERS };
