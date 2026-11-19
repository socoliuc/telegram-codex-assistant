import { createHash } from 'node:crypto';

export function questionChoices(item) {
  if (Array.isArray(item?.questions) && item.questions.length <= 8) {
    return item.questions.map((q, index) => ({ index, title: String(q.title || q.question || '').trim(),
      options: q.isSecret || !Array.isArray(q.options) || q.options.length > 8 ? [] : q.options.map(o =>
        typeof o === 'string' ? o : o?.label).filter(o => typeof o === 'string' && o.trim() && o.length <= 2000) }));
  }
  if (!item?.id?.startsWith('call_') || typeof item.text !== 'string') return [];
  const blocks = item.text.trim().split(/\n\s*\n/);
  if (blocks.length > 8) return [];
  const groups = blocks.map((block, index) => {
    const lines = block.split('\n'), firstChoice = lines.findIndex(line => /^[-•] /u.test(line));
    if (firstChoice < 1 || !lines.slice(firstChoice).every(line => /^[-•] \S.*$/u.test(line))) return null;
    const options = lines.slice(firstChoice).map(line => line.slice(2));
    if (options.length > 8 || options.some(o => o.length > 2000)) return null;
    return { index, title: lines.slice(0, firstChoice).join('\n').trim(), options };
  });
  // A mixed/multiline shape may hide a question boundary. Keep text replies
  // rather than inventing indexes or converting arbitrary prose into choices.
  return groups.every(Boolean) ? groups : [];
}

export const choiceRevision = questions => createHash('sha256').update(JSON.stringify(questions)).digest('hex').slice(0, 8);
export const questionAnswered = (question, answers = []) => answers.some(answer => answer.index === question.index &&
  typeof answer.question === 'string' && answer.question.trim() === question.title);

export function reconcileSavedChoices(item, questions) {
  for (const [index, saved] of Object.entries(item.choiceSubmissions || {})) {
    const question = questions.find(q => q.index === Number(index));
    // Only an unsubmitted selection can be discarded and chosen again.
    if (saved.status === 'saved' && (!question || saved.questionRevision !== choiceRevision([question])))
      delete item.choiceSubmissions[index];
  }
}
