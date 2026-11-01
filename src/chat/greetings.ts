export type GreetingPreferences = { english?: boolean; concise: boolean; remember: boolean };
const zh = ['今天有什么想先处理的？', '有什么需要帮忙的？', '今天想从哪里开始？', '想先聊点什么？', '有什么想一起看看？', '我们先从哪件事开始？'];
const shortZh = ['需要帮忙吗？', '想聊什么？', '从哪开始？', '想看什么？', '先办哪件事？', '今天聊什么？'];
const en = ['How can I help today?', 'Where shall we start?', 'What is on your mind?', 'What can I help with?', 'What shall we look at?', 'How can I assist?'];
const shortEn = ['Need a hand?', 'How can I help?', 'Where to start?', 'What first?', 'Shall we begin?', 'What is next?'];

export function greetingPrefix(now: Date, zone: string | undefined, english: boolean) {
  let hour = -1;
  try {
    if (zone) hour = Number(new Intl.DateTimeFormat('en', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(now));
  } catch { /* Unknown zone uses a neutral greeting. */ }
  const slot = hour < 5 || hour >= 23 ? 0 : hour < 11 ? 1 : hour < 14 ? 2 : hour < 18 ? 3 : 4;
  return (english ? ['Hello', 'Good morning', 'Hello', 'Good afternoon', 'Good evening'] : ['你好', '早上好', '中午好', '下午好', '晚上好'])[slot];
}

// Save only template indices. No chat text or third-party profile values enter a greeting.
type Choice = { prefix: string; variant: number; english: boolean; concise: boolean; at: number };
function render(choice: Choice) {
  const { english, concise, prefix, variant } = choice;
  const bodies = english ? (concise ? shortEn : en) : (concise ? shortZh : zh);
  const prefixes = english ? ['Hello', 'Good morning', 'Good afternoon', 'Good evening'] : ['你好', '早上好', '中午好', '下午好', '晚上好'];
  if (!prefixes.includes(prefix) || !Number.isInteger(variant) || !bodies[variant]) return '';
  const value = prefix + (english ? '! ' : '！') + bodies[variant];
  return Array.from(value).length <= 50 ? value : '';
}

export function sessionGreeting(userId: string, sessionId: string, preferences: GreetingPreferences) {
  const english = preferences.english ?? /^en\b/i.test(globalThis.navigator?.language || '');
  const fallback = english ? 'Hello! How can I help?' : '你好！有什么可以帮你？';
  const started = performance.now();
  function measured(text: string, source: 'template' | 'fallback', repeated = false, zoneKnown = false) {
    const name = 'puma.greeting';
    try {
      if (performance.getEntriesByName(name).length >= 100) performance.clearMeasures(name);
      performance.measure(name, { start: started, detail: { source, repeated, zoneKnown, length: [...text].length } });
    } catch { /* Older browsers may not support User Timing details. */ }
    return text;
  }
  try {
    const key = 'bank-greeting:' + userId + ':';
    const storage = preferences.remember ? localStorage : sessionStorage;
    if (!preferences.remember) {
      for (const name of Object.keys(localStorage)) if (name.startsWith(key)) localStorage.removeItem(name);
    }
    const stored = storage.getItem(key + sessionId);
    if (stored) {
      const cached = render(JSON.parse(stored));
      if (cached) return cached;
    }
    const now = new Date();
    const history: Choice[] = JSON.parse(storage.getItem(key + 'recent') || '[]');
    const recent = history.slice(-5).filter(c => c.at >= now.getTime() - 7 * 86400000);
    const previous = recent.map(render);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const prefix = greetingPrefix(now, zone, english);
    const choices = zh.map((_, variant) => ({ english, concise: preferences.concise, prefix, variant, at: now.getTime() }));
    const choice = choices.find(c => !previous.includes(render(c))) || choices[0];
    storage.setItem(key + sessionId, JSON.stringify(choice));
    storage.setItem(key + 'recent', JSON.stringify([...recent.slice(-4), choice]));
    const text = render(choice);
    return measured(text || fallback, text ? 'template' : 'fallback', previous.includes(text), Boolean(zone));
  } catch { return measured(fallback, 'fallback'); }
}

export function draftGreetingId(userId: string, fresh = false) {
  const key = 'bank-greeting-draft:' + userId;
  try {
    const previous = sessionStorage.getItem(key);
    if (fresh && previous) forgetGreeting(userId, previous);
    const id = !fresh && previous || crypto.randomUUID();
    sessionStorage.setItem(key, id);
    return id;
  } catch { return 'draft'; }
}

export function forgetGreeting(userId: string, sessionId: string) {
  try {
    const key = 'bank-greeting:' + userId + ':' + sessionId;
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  } catch { /* Storage can be disabled. */ }
}

export function bindGreeting(userId: string, draftId: string, sessionId: string, remember: boolean) {
  try {
    const key = 'bank-greeting:' + userId + ':';
    const storage = remember ? localStorage : sessionStorage;
    const choice = storage.getItem(key + draftId);
    if (choice && !storage.getItem(key + sessionId)) storage.setItem(key + sessionId, choice);
  } catch { /* Storage may be unavailable in private browsing. */ }
}
