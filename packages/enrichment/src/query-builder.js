/**
 * Builds a recall query from cwd + prompt + recent topics.
 * Strategy: project name + last ~3 keywords from prompt + recent topics.
 */
import { deriveWorkspace } from './workspace-deriver.js';

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','with','of','to','for','in','on',
  'at','by','from','is','are','was','were','be','been','being','have','has','had','do',
  'does','did','will','would','could','should','can','may','might','i','you','we','they',
  'he','she','it','this','that','these','those','my','your','our','their','its','as',
  'so','not','no','yes','please','help','me','about','what','when','how','why','which',
  'where','who','there','here','also'
]);

const MAX_QUERY_CHARS = 200;
const MAX_PROMPT_KEYWORDS = 3;

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function lastNUnique(tokens, n) {
  const seen = new Set();
  const out = [];
  for (let i = tokens.length - 1; i >= 0 && out.length < n; i--) {
    const t = tokens[i];
    if (seen.has(t)) continue;
    seen.add(t);
    out.unshift(t);
  }
  return out;
}

/**
 * @param {{cwd?:string, prompt?:string, recentTopics?:string[]}} input
 * @returns {string}
 */
export function buildRecallQuery({ cwd, prompt = '', recentTopics = [] } = {}) {
  const ws = cwd ? deriveWorkspace(cwd) : null;
  const projectName = ws && ws.id !== 'personal' ? ws.name : '';

  const tokens = tokenize(prompt);
  const keywords = lastNUnique(tokens, MAX_PROMPT_KEYWORDS);

  const topics = (Array.isArray(recentTopics) ? recentTopics : [])
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim());

  const parts = [];
  if (projectName) parts.push(projectName);
  parts.push(...keywords);
  parts.push(...topics);

  let query = parts.join(' ').trim();
  if (!query) {
    query = projectName || 'personal context';
  }
  if (query.length > MAX_QUERY_CHARS) {
    query = query.slice(0, MAX_QUERY_CHARS);
  }
  return query;
}
