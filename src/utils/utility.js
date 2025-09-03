import { invoke } from '@forge/bridge';

const pick = (o, p, fb = null) => {
  try { return p.split('.').reduce((x, k) => x?.[k], o) ?? fb; } catch { return fb; }
};

/* -------------------------- Data Fetch -------------------------- */

const findAC = (fields = {}, names = {}) => {
  const hit = Object.entries(names).find(([, d]) =>
    String(d || '').toLowerCase().includes('acceptance criteria')
  );
  return hit ? fields[hit[0]] ?? null : null;
};

export async function getEpicTestData(epicKey) {
  // If epicKey is missing, resolvers use Jira context automatically
  const payload = epicKey ? { epicKey } : {};

  // 1) Epic (raw)
  const epicRaw = await invoke('getEpicRaw', payload);

  // 2) Children (try parent= first, fallback to "Epic Link")
  const byParent = await invoke('searchChildrenByParentRaw', payload);
  const hasChildrenViaParent = (byParent?.issues?.length ?? 0) > 0;
  const childrenRaw = hasChildrenViaParent
    ? byParent
    : await invoke('searchChildrenByEpicLinkRaw', payload);

  // 3) Shape data (keep AC for epic; children AC left null unless you expand names per issue)
  const f = epicRaw.fields || {};
  const epic = {
    key: epicRaw.key,
    summary: f.summary || '',
    description: f.description ?? null,
    acceptanceCriteria: findAC(f, epicRaw.names || {})
  };

  const children = (childrenRaw.issues || []).map(issue => {
    const cf = issue.fields || {};
    return {
      key: issue.key,
      type: pick(cf, 'issuetype.name') || null,
      summary: cf.summary || '',
      description: cf.description ?? null,
      acceptanceCriteria: null, // keep null unless you expand names per child
      parentKey: pick(cf, 'parent.key') || null
    };
  });

  return {
    epic,
    children,
    counts: {
      totalChildren: children.length,
      byType: children.reduce((acc, c) => {
        const t = c.type || 'Unknown';
        acc[t] = (acc[t] || 0) + 1;
        return acc;
      }, {})
    }
  };
}

/* -------------------------- Small helpers -------------------------- */

// Safely extract plaintext from ADF or pass-through string
export function extractPlainText(adfOrString) {
  if (!adfOrString) return '';
  if (typeof adfOrString === 'string') return adfOrString;

  if (typeof adfOrString !== 'object' || adfOrString.type !== 'doc') return '';
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'text' && node.text) out.push(node.text);
    else if (node.type === 'hardBreak') out.push('\n');
    else if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  (adfOrString.content || []).forEach(walk);
  return out.join('').trim();
}

const clean = (s) => extractPlainText(s).replace(/\s+/g, ' ').trim();

/* --------------------------- LLM plumbing --------------------------- */
/**
 * Backend resolver 'aiGenerate' must accept { system, prompt, temperature, maxTokens } and return { text }.
 */
async function askLLM({ system, prompt, temperature = 0.2, maxTokens = 1400 }) {
  const res = await invoke('aiGenerate', { system, prompt, temperature, maxTokens });
  return (res && res.text) || '';
}

/* --------------------------- Prompt builders ------------------------- */

function buildTestCasesPrompt({ epic, child }) {
  const system = [
    'You are a senior QA engineer.',
    'Write concise, practical test cases with clear preconditions, steps, and expected results.',
    'Prefer bullet points. Include both positive and negative paths.',
    'Assume Jira Sub-task creation later; return JSON only as specified.'
  ].join(' ');

  const epicSummary = clean(epic.summary);
  const epicDesc = clean(epic.description);
  const epicAC = clean(epic.acceptanceCriteria);

  const childType = child.type || 'Task';
  const childSummary = clean(child.summary);
  const childDesc = clean(child.description);
  const childAC = clean(child.acceptanceCriteria);

  const prompt = `
Epic:
- Key: ${epic.key}
- Summary: ${epicSummary}
- Description: ${epicDesc || '(none)'}
- Acceptance Criteria: ${epicAC || '(none)'}

Child (${childType}):
- Key: ${child.key}
- Summary: ${childSummary}
- Description: ${childDesc || '(none)'}
- Acceptance Criteria: ${childAC || '(none)'}
- Labels:

Return a compact JSON object with this shape ONLY:
{
  "subtasks": [
    {
      "testCaseId": "Task-123",
      "title": "Short descriptive title of the test case",
      "description": "This test case verifies that the feedback mechanism can be set up successfully.",
      "environment": "OS, Browser, Device",
      "preconditions": ["Precondition 1", "Precondition 2"],
      "testSteps": ["Step 1", "Step 2", "Step 3"],
      "expectedResult": "Expected outcome after steps",
      "actualResult": ""
    }
  ]
}

Guidelines:
- Return **exactly ONE** item in "subtasks" array (size must be 1). If multiple ideas exist, pick the most critical.
- testCaseId = use the child issue key (e.g., ${child.key}-TC1).
- Title: under 90 chars, unique, specific to scenario.
- Environment: realistic OS + Browser/Device.
- Preconditions: list setup needs (e.g., user logged in).
- Test Steps: numbered actions, one per line.
- Expected Result: a single concise outcome statement.
- Actual Result: always leave blank ("").
- Avoid duplicates; no external URLs; no code blocks.
`;

  return { system, prompt };
}

function buildImpactPrompt({ epic, children }) {
  const system = [
    'You are a software risk analyst.',
    'Return JSON ONLY with concise items.',
    'Each list must have EXACTLY 3 items (no more).'
  ].join(' ');

  const epicSummary = clean(epic.summary);
  const epicDesc = clean(epic.description);
  const epicAC = clean(epic.acceptanceCriteria);

  const childBullets = children.map(c => {
    const s = clean(c.summary);
    const d = clean(c.description);
    return `- [${c.type || 'Task'}] ${c.key}: ${s}${d ? ` | ${d.slice(0, 160)}...` : ''}`;
  }).join('\n');

  const prompt = `
Epic:
- Key: ${epic.key}
- Summary: ${epicSummary}
- Description: ${epicDesc || '(none)'}
- Acceptance Criteria: ${epicAC || '(none)'}

Children:
${childBullets || '(none)'}

Return a compact JSON object with this shape ONLY:
{
  "impactAreas": ["A","B","C"],
  "riskAssessment": [
    {"area":"A","risk":"High|Medium|Low","reason":"..."},
    {"area":"B","risk":"...","reason":"..."},
    {"area":"C","risk":"...","reason":"..."}
  ],
  "regressionHotspots": ["A","B","C"],
  "dataConcerns": ["A","B","C"],
  "mitigations": ["A","B","C"],
  "smokeSuite": ["A","B","C"]
}
Guidelines:
- Exactly 3 items per list.
- Be specific but concise; no prose outside JSON.
`;
  return { system, prompt };
}

/* --------------------------- Main orchestrator --------------------------- */

export async function generateEpicTestArtifacts(epicKey, {
  includeTypes = ['Story', 'Task', 'Bug'],      // children types to cover
  temperature = 0.2,
  perChildMaxTokens = 900,
  impactMaxTokens = 600
} = {}) {
  // 1) Fetch epic+children
  const data = await getEpicTestData(epicKey);
  const { epic, children } = data;

  // 2) Filter children by type if needed
  const targetChildren = (children || []).filter(c =>
    includeTypes.length === 0 || includeTypes.includes(c.type || '')
  );

  // 3) Per-child test cases (single suggestion per child)
  const subtaskPacks = [];
  for (const child of targetChildren) {
    const { system, prompt } = buildTestCasesPrompt({ epic, child });
    const text = await askLLM({ system, prompt, temperature, maxTokens: perChildMaxTokens });
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = { subtasks: [] }; }
    const one = Array.isArray(parsed.subtasks)
      ? parsed.subtasks.slice(0, 1)
      : (parsed.subtasks && typeof parsed.subtasks === 'object' ? [parsed.subtasks] : []);
    subtaskPacks.push({ parentKey: child.key, type: child.type || null, suggestions: one });
  }

  // 4) Epic-level Impact Analysis
  const { system, prompt } = buildImpactPrompt({ epic, children: targetChildren });
  const impactText = await askLLM({ system, prompt, temperature, maxTokens: impactMaxTokens });
  const cap = (arr) => Array.isArray(arr) ? arr.slice(0, 3) : [];
  let impact = null;
  try { impact = JSON.parse(impactText); } catch { impact = {}; }
  impact = {
    impactAreas: cap(impact.impactAreas),
    riskAssessment: cap(impact.riskAssessment),
    regressionHotspots: cap(impact.regressionHotspots),
    dataConcerns: cap(impact.dataConcerns),
    mitigations: cap(impact.mitigations),
    smokeSuite: cap(impact.smokeSuite)
  };

  // 5) Return envelope
  return {
    epic: { key: epic.key, summary: clean(epic.summary) },
    counts: data.counts,
    subtaskPacks,
    impact
  };
}

/* --------------------------- Creation helpers --------------------------- */

/** Choose issue type (prefer Sub-task, fallback to Task) */
async function pickIssueType(projectKey, { subTaskIssueTypeId, subTaskIssueTypeName } = {}) {
  const meta = await invoke('getCreateMeta', { projectKey });
  const types = meta?.projects?.[0]?.issuetypes || [];

  if (subTaskIssueTypeId) {
    const t = types.find(x => String(x.id) === String(subTaskIssueTypeId));
    if (t) return t;
  }
  if (subTaskIssueTypeName) {
    const t = types.find(x => (x.name || '').toLowerCase() === subTaskIssueTypeName.toLowerCase());
    if (t) return t;
  }
  return types.find(t => t.subtask) || types.find(t => (t.name || '').toLowerCase() === 'task') || null;
}

/** Merge suggestions → summary */
function buildSummary({ parentSummary, parentKey, suggestions, summaryPrefix = '', summarySuffix = '' }) {
  const base = parentSummary || (suggestions[0]?.title ?? 'Test cases');
  const n = suggestions.length;
  let s = `${summaryPrefix ? summaryPrefix + ' ' : ''}${base} — ${n} case${n > 1 ? 's' : ''} (${parentKey})${summarySuffix ? ' ' + summarySuffix : ''}`;
  return s.slice(0, 255);
}

/** ADF: titles + numbered steps + expected result (structured-only) */
function buildTextNode(text) { return { type: 'text', text }; }
function paragraph(text = '') { return ({ type: 'paragraph', content: text ? [buildTextNode(text)] : [] }); }
function heading(level, text) { return ({ type: 'heading', attrs: { level }, content: [buildTextNode(text)] }); }
function bulletList(items = []) {
  return ({
    type: 'bulletList',
    content: items.map(t => ({ type: 'listItem', content: [paragraph(String(t))] }))
  });
}
function orderedList(items = []) {
  return ({
    type: 'orderedList',
    content: items.map(t => ({ type: 'listItem', content: [paragraph(String(t))] }))
  });
}

export function buildDescriptionAdf(suggestions = []) {
  const content = [];
  (suggestions || []).forEach((s, idx) => {
    const title         = s.title || 'Untitled case';
    const testCaseId    = (s.testCaseId || `TC-${idx + 1}`).trim();
    const environment   = s.environment || '';
    const description   = s.description || '';
    const preconditions = Array.isArray(s.preconditions) ? s.preconditions : [];
    const testSteps     = Array.isArray(s.testSteps) ? s.testSteps : [];
    const expected      = s.expectedResult || '';

    content.push(
      heading(3, `${idx + 1}. ${title}`),

      // 1. Description
      heading(4, ''),
      paragraph(description || '(none)'),

      paragraph(`Test Case ID: ${testCaseId}`),
      paragraph(`Environment: ${environment || 'N/A'}`),

      // 2. Preconditions
      heading(4, '1. Preconditions'),
      preconditions.length ? bulletList(preconditions) : paragraph('(none)'),

      // 3. Test Steps
      heading(4, '2. Test Steps'),
      testSteps.length ? orderedList(testSteps) : paragraph('(none)'),

      // 4. Expected Result
      heading(4, '3. Expected Result'),
      paragraph(expected || '(none)'),

      // 5. Actual Result (blank)
      heading(4, 'Actual Result'),
      paragraph("To be filled")
    );
  });

  return { type: 'doc', version: 1, content };
}

/** derive labels/priority (KEPT) */
function uniq(arr) { return Array.from(new Set((arr || []).filter(Boolean))); }
export function deriveLabelsPriority(suggestions) {
  const labels = uniq(suggestions.flatMap(s => Array.isArray(s.tags) ? s.tags : [])).slice(0, 50);

  const rank = { high: 3, medium: 2, low: 1 };
  let best = 'Medium';
  for (const s of (suggestions || [])) {
    const p = String(s.priority || '').toLowerCase();
    if (rank[p] && (!rank[best.toLowerCase()] || rank[p] > rank[best.toLowerCase()])) best = s.priority;
  }
  return { labels, priorityName: best || 'Medium' };
}

/** Build final fields payload (respects sub-task vs task) */
export async function buildCreateFieldsForCombinedChild({
  parentKey,
  suggestions,
  summaryPrefix = '',
  summarySuffix = '',
  subTaskIssueTypeId,
  subTaskIssueTypeName
}) {
  // parent → project + summary
  const parent = await invoke('getEpicRaw', { epicKey: parentKey }); // or a lighter getIssue resolver if you add one
  const projectKey = parent?.fields?.project?.key;
  const parentSummary = parent?.fields?.summary || '';
  if (!projectKey) throw new Error(`No project found for ${parentKey}`);

  // choose issue type
  const issueType = await pickIssueType(projectKey, { subTaskIssueTypeId, subTaskIssueTypeName });
  if (!issueType) throw new Error(`No Sub-task or Task issue type in ${projectKey}`);

  // merge content
  const summary = buildSummary({ parentSummary, parentKey, suggestions, summaryPrefix, summarySuffix });
  const description = buildDescriptionAdf(suggestions);
  const { labels, priorityName } = deriveLabelsPriority(suggestions);

  // fields
  const fields = {
    project: { key: projectKey },
    issuetype: { id: issueType.id },
    summary,
    description,
    priority: { name: priorityName }
  };
  if (issueType.subtask) fields.parent = { key: parentKey };
  if (labels.length) fields.labels = labels;

  return { fields, isSubtask: !!issueType.subtask };
}

/** One call from UI: build fields → call thin resolver */
export async function createSubtasksFromPack(subtaskPack) {
  if (!subtaskPack?.parentKey) throw new Error('parentKey missing in subtaskPack');
  const {
    parentKey, suggestions, summaryPrefix, summarySuffix,
    subTaskIssueTypeId, subTaskIssueTypeName, linkTypeName
  } = subtaskPack;

  const { fields, isSubtask } = await buildCreateFieldsForCombinedChild({
    parentKey, suggestions, summaryPrefix, summarySuffix, subTaskIssueTypeId, subTaskIssueTypeName
  });

  return await invoke('createSubtasks', { parentKey, fields, isSubtask, linkTypeName });
}

/* --------------------------------------------------------------------------
   NEW: Epic-level test case helpers (create a Task linked to the Epic)
   -------------------------------------------------------------------------- */

/** Prefer a non-subtask issue type (Task if available) */
async function pickNonSubtaskIssueType(projectKey) {
  const meta = await invoke('getCreateMeta', { projectKey });
  const types = meta?.projects?.[0]?.issuetypes || [];
  const task = types.find(t => !t.subtask && (t.name || '').toLowerCase() === 'task');
  if (task) return task;
  return types.find(t => !t.subtask) || null;
}

/** Build a single-JSON prompt for Epic-level test case generation */
function buildEpicTestCasePrompt(epic) {
  const system = [
    'You are a senior QA engineer.',
    'Write ONE concise, practical test case (single item) with clear preconditions, steps, expected results.',
    'Return JSON ONLY in the specified shape.'
  ].join(' ');

  const epicSummary = clean(epic.summary);
  const epicDesc    = clean(epic.description);
  const epicAC      = clean(epic.acceptanceCriteria);

  const prompt = `
Epic:
- Key: ${epic.key}
- Summary: ${epicSummary}
- Description: ${epicDesc || '(none)'}
- Acceptance Criteria: ${epicAC || '(none)'}

Return a compact JSON object with this shape ONLY:
{
  "subtasks": [
    {
      "testCaseId": "${epic.key}-TC1",
      "title": "Short descriptive title of the test case",
      "description": "High-level intent of the test",
      "environment": "OS, Browser/Device",
      "preconditions": ["Precondition 1", "Precondition 2"],
      "testSteps": ["Step 1", "Step 2", "Step 3"],
      "expectedResult": "Expected outcome after steps",
      "actualResult": ""
    }
  ]
}

Guidelines:
- Return EXACTLY ONE item in "subtasks".
- Title < 90 chars; realistic environment.
- Steps: one action per line; concise.
- Expected Result: single clear outcome.
- Actual Result must be "".
- No extra prose outside JSON.
`;
  return { system, prompt };
}

/** Generate one Epic-level test case suggestion (LLM) */
export async function generateEpicLevelTestCase(epicKey) {
  // Reuse existing fetcher to get epic details
  const data = await getEpicTestData(epicKey);
  const { epic } = data;

  const { system, prompt } = buildEpicTestCasePrompt(epic);
  const text = await askLLM({ system, prompt, temperature: 0.2, maxTokens: 900 });

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { subtasks: [] }; }
  const one = Array.isArray(parsed.subtasks)
    ? parsed.subtasks.slice(0, 1)
    : (parsed.subtasks && typeof parsed.subtasks === 'object' ? [parsed.subtasks] : []);

  // Always return a single suggestion object (or null)
  return { epic, suggestion: one[0] || null };
}

/** Build final fields payload for a Task linked to the Epic (never subtask) */
export async function buildCreateFieldsForEpicTask({ epicKey, suggestion, summaryPrefix = '', summarySuffix = '' }) {
  if (!epicKey) throw new Error('buildCreateFieldsForEpicTask: epicKey is required');
  if (!suggestion) throw new Error('buildCreateFieldsForEpicTask: suggestion is required');

  const epicRaw = await invoke('getEpicRaw', { epicKey });
  const projectKey = epicRaw?.fields?.project?.key;
  const epicSummary = epicRaw?.fields?.summary || '';
  if (!projectKey) throw new Error(`No project found for epic ${epicKey}`);

  const issueType = await pickNonSubtaskIssueType(projectKey);
  if (!issueType) throw new Error(`No non-subtask issue type found in project ${projectKey}`);

  const summary = buildSummary({
    parentSummary: epicSummary,
    parentKey: epicKey,
    suggestions: [suggestion],
    summaryPrefix,
    summarySuffix
  });

  const description = buildDescriptionAdf([suggestion]);
  const { labels, priorityName } = deriveLabelsPriority([suggestion]);

  const fields = {
    project:   { key: projectKey },
    issuetype: { id: issueType.id },       // non-subtask type (e.g., Task)
    summary,
    description,
    priority:  { name: priorityName || 'Medium' }
  };
  if (labels.length) fields.labels = labels;

  return { fields };
}

/** Create a Task for the Epic and link it back (Relates/Blocks/Tests/etc.) */
export async function createEpicTestCaseTask({
  epicKey,
  suggestion,
  linkTypeName = 'Relates',
  summaryPrefix = '',
  summarySuffix = ''
}) {
  const { fields } = await buildCreateFieldsForEpicTask({
    epicKey, suggestion, summaryPrefix, summarySuffix
  });

  // Force non-subtask path; backend will create Task and link it to the Epic
  return await invoke('createSubtasks', {
    parentKey: epicKey,
    fields,
    isSubtask: false,
    linkTypeName
  });
}