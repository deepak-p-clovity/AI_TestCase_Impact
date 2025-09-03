


import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';



const resolver = new Resolver();



const EPIC_FIELDS =
  'project,summary,description,priority,labels,issuelinks'; // lean, but enough for current flow


const CHILD_FIELDS =
  'key,issuetype,summary,description,parent';

/* --------------------------- Context helpers --------------------------- */
function getContextEpicKey(payload, context) {
  return payload?.epicKey || context?.extension?.issue?.key || context?.issue?.key || null;
}
// --------------site URL-----------------------
resolver.define('getSiteUrl', async () => {
  const res = await api.asApp().requestJira(route`/rest/api/3/serverInfo`);
  const data = await res.json();
  const base = data?.baseUrl;
  return base;
});
/* --------------------------- Jira fetchers --------------------------- */

resolver.define('getEpicRaw', async ({ payload, context }) => {
  const epicKey = getContextEpicKey(payload, context);
  if (!epicKey) throw new Error('No epicKey in payload or context.');
  const res = await api.asApp().requestJira(
    route`/rest/api/3/issue/${epicKey}?expand=names&fields=${EPIC_FIELDS}`
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`getEpicRaw failed: ${res.status} ${text}`);
  return JSON.parse(text);
}); // :contentReference[oaicite:1]{index=1}

resolver.define('searchChildrenByParentRaw', async ({ payload, context }) => {
  const epicKey = getContextEpicKey(payload, context);
  if (!epicKey) throw new Error('No epicKey in payload or context.');
  const jql = `parent=${JSON.stringify(epicKey)}`; // → parent="KEY"
  const res = await api.asApp().requestJira(
    route`/rest/api/3/search?jql=${jql}&maxResults=200&fields=${CHILD_FIELDS}`
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`searchChildrenByParentRaw failed: ${res.status} ${text}`);
  return JSON.parse(text);
}); // :contentReference[oaicite:2]{index=2}

resolver.define('searchChildrenByEpicLinkRaw', async ({ payload, context }) => {
  const epicKey = getContextEpicKey(payload, context);
  if (!epicKey) throw new Error('No epicKey in payload or context.');
  const jql = `"Epic Link"=${JSON.stringify(epicKey)}`;
  const res = await api.asApp().requestJira(
    route`/rest/api/3/search?jql=${jql}&maxResults=200&fields=${CHILD_FIELDS}`
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`searchChildrenByEpicLinkRaw failed: ${res.status} ${text}`);
  return JSON.parse(text);
}); // 【11†source*/

/* --------------------------- AI (LLM) bridge --------------------------- */

resolver.define('aiGenerate', async ({ payload }) => {
  const { system, prompt, temperature = 0.2, maxTokens = 1000 } = payload || {};
  const resp = await api.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system || 'You are a helpful AI assistant.' },
        { role: 'user', content: prompt || '' },
      ],
    }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    // Surface upstream errors clearly to UI
    throw new Error(`aiGenerate failed: ${resp.status} ${text}`);
  }

  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`aiGenerate: invalid JSON from provider: ${text.slice(0, 400)}...`);
  }
  const out = data?.choices?.[0]?.message?.content || '';
  return { text: out };
}); // :contentReference[oaicite:3]{index=3}

/* --------------------------- Createmeta --------------------------- */

resolver.define('getCreateMeta', async ({ payload }) => {
  const { projectKey } = payload || {};
  if (!projectKey) throw new Error('getCreateMeta: projectKey is required');
  const res = await api.asApp().requestJira(
    route`/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes.fields`
  );
  const txt = await res.text();
  if (!res.ok) throw new Error(`getCreateMeta failed: ${res.status} ${txt}`);
  return JSON.parse(txt);
}); 

/* --------------------------- Create Subtasks / Task --------------------------- */





async function fieldIdByName(name) {
  const res = await api.asApp().requestJira(route`/rest/api/3/field`);
  const all = await res.json();
  const f = all.find(x => String(x.name || '').toLowerCase() === name.toLowerCase());
  return f?.id || null;
}




resolver.define('createSubtasks', async ({ payload, context }) => {
  const {
    parentKey,
    fields,                 // prebuilt in utils
    isSubtask = true,       // computed in utils
    linkTypeName = 'Relates'
  } = payload || {};

  if (!parentKey) throw new Error('createSubtasks: parentKey is required.');
  if (!fields)    throw new Error('createSubtasks: fields is required.');

  // ✅ Reporter = real clicking user; Assignee untouched (stays unassigned / project default)
  const currentUserId = context?.accountId;                 // ← who clicked
  if (currentUserId && !fields.reporter) {
    fields.reporter = { id: currentUserId };
  }

  // Normalize labels safely (defensive)
  if (fields.labels) {
    fields.labels = [...new Set(
      fields.labels
        .map(l => String(l).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '').slice(0, 255))
        .filter(Boolean)
    )];
  }

  try {
  // Resolve dynamic field IDs
  const START_DATE_CF =
    (await fieldIdByName('Start date')) || (await fieldIdByName('Planned start'));
  const SPRINT_CF = await fieldIdByName('Sprint');
  console.log('[dates] fieldIds', { START_DATE_CF, SPRINT_CF });

  // 1) Start date = TODAY only (Asia/Kolkata), if the field exists
  let startDateSet = null;
  if (START_DATE_CF) {
    const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
    fields[START_DATE_CF] = todayIso;
    startDateSet = todayIso;
  }
  console.log('[dates] start', { startFieldId: START_DATE_CF, startDateSet });

  // 2) Read child's Due + Sprint (to maybe use sprint end)
  const fieldsQuery = ['duedate', SPRINT_CF].filter(Boolean).join(',');
  let childDue = null, sprintEnd = null;

  const r = await api.asApp().requestJira(
    route`/rest/api/3/issue/${parentKey}?fields=${fieldsQuery}`
  );
  const rTxt = await r.text();
  if (!r.ok) {
    console.log('[dates] parentFetch.error', { status: r.status, body: rTxt });
  } else {
    let pf;
    try { pf = JSON.parse(rTxt).fields || {}; }
    catch (e) { pf = {}; console.log('[dates] parentFetch.parseError', String(e)); }

    childDue = pf.duedate || null;

    if (SPRINT_CF && pf[SPRINT_CF]) {
      const s = Array.isArray(pf[SPRINT_CF]) ? pf[SPRINT_CF] : [pf[SPRINT_CF]];
      const spr = s[s.length - 1] || null;
      sprintEnd = spr?.endDate ? spr.endDate.slice(0, 10) : null;
    }
  }
  console.log('[dates] parentInfo', { parentKey, childDue, sprintEnd });

  // 3) Priority fallback (calendar days; Asia/Kolkata)
  const prName = String(fields?.priority?.name || 'Medium').toLowerCase();
  const daysMap = { highest:3, critical:3, high:5, medium:7, low:14, lowest:21, trivial:21 };
  const slaDays = daysMap[prName] ?? 7;
  const addDaysIST = (n) => {
    const d = new Date(); d.setDate(d.getDate() + n);
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
  };
  const priorityFallback = addDaysIST(slaDays);
  console.log('[dates] priorityCalc', { prName, slaDays, priorityFallback });

  // 4) Decide Due source: child → priority → sprint
  let dueSource = 'none', finalDue = null;
  if (childDue) {
    finalDue = childDue; dueSource = 'child_due';
  } else if (priorityFallback) { // always defined
    finalDue = priorityFallback; dueSource = 'priority_fallback';
  } else if (sprintEnd) {
    finalDue = sprintEnd; dueSource = 'sprint_end';
  } else {
    finalDue = addDaysIST(7); dueSource = 'fallback_default';
  }

  if (!fields.duedate) fields.duedate = finalDue;

  console.log('[dates] chosen', {
    startFieldId: START_DATE_CF,
    startDate: startDateSet,
    dueSource,
    dueDate: fields.duedate
  });
} catch (e) {
  console.log('[dates] block.error', String(e));
  // soft-fail; continue without dates if lookup/fetch fails
}


  // 1) Create the issue (sub-task or task)
  const createRes = await api.asApp().requestJira(route`/rest/api/3/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  const createTxt = await createRes.text();
  if (!createRes.ok) throw new Error(`Create failed: ${createRes.status} ${createTxt}`);
  let created;
  try { created = JSON.parse(createTxt); } catch {
    throw new Error(`Create: invalid JSON: ${createTxt}`);
  }

  // 2) If fallback Task, link it back to parent
  if (!isSubtask && created?.key) {
    const linkRes = await api.asApp().requestJira(route`/rest/api/3/issueLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: { name: linkTypeName },
        inwardIssue: { key: parentKey },
        outwardIssue: { key: created.key }
      })
    });
    if (!linkRes.ok) {
      const linkTxt = await linkRes.text();
      // Don’t fail creation if linking fails; return as partial success with an error message
      return {
        created: [{ key: created.key, id: created.id }],
        errors: [`Linking failed: ${linkRes.status} ${linkTxt}`]
      };
    }
  }

  return {
    created: [{ key: created.key, id: created.id }],
    errors: []
  };
}); // :contentReference[oaicite:5]{index=5}


export const handler = resolver.getDefinitions();
































