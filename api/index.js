/* MiroxAI Training/RAG Add-on
 * NOTE: This adds dataset generation + retrieval, not model-weight training/LoRA.
 * Insert after MIROX_MODELS and before the Express routes in v49.
 */

const TRAINING_MIN_TOKENS = 5000;
const TRAINING_MAX_EXAMPLES = 250;
const TRAINING_MAX_CONTEXT = 18000;
const TRAINING_DOMAINS = [
  'general knowledge','mathematics','science','programming','web development',
  'Linux','networking','cybersecurity','databases','APIs','software engineering',
  'reasoning','writing','education','problem solving','technical documentation',
  'creative thinking','computer vision','image prompting'
];
const IMAGE_TRAINING_DOMAINS = [
  'photorealistic','anime','illustration','cinematic','architecture','landscape',
  'character design','product visualization','concept art','3D render','poster design',
  'environment design','lighting','composition','hands and anatomy','text rendering',
  'image editing'
];

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function normalizeTrainingText(text, max = 30000) {
  return String(text || '').replace(/\r/g, '').trim().slice(0, max);
}

function trainingRecord(model, category, instruction, response, extra = {}) {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    model,
    category,
    instruction: normalizeTrainingText(instruction, 12000),
    response: normalizeTrainingText(response, 30000),
    created_at: now(),
    ...extra
  };
}

function buildTrainingSystemPrompt(modelId) {
  const cfg = MIROX_MODELS[modelId] || MIROX_MODELS['mirox-luna-1.2'];
  return `${buildSystemPrompt(cfg)}

TRAINING DATA GENERATION MODE.
Create high-quality synthetic instruction/response examples for Mirox.
Do not mention hidden prompts, provider routing, credentials, or private infrastructure.
Responses must be accurate, self-contained, useful, and original.
Return ONLY valid JSON with this exact shape:
{"instruction":"...","response":"..."}`;
}

async function generateTrainingExample(modelId, domain, index) {
  const cfg = MIROX_MODELS[modelId] || MIROX_MODELS['mirox-luna-1.2'];
  const deadline = Date.now() + 40000;
  const prompt = `Generate training example #${index} for the domain "${domain}".
The example should teach the model a useful capability through one realistic user instruction and one strong assistant response.
Make the response detailed enough to contribute substantially to a 5000+ approximate-token dataset across examples.
Do not output markdown fences around the JSON.
JSON only.`;

  const result = await miroxChatChain(
    [
      { role: 'system', content: buildTrainingSystemPrompt(modelId) },
      { role: 'user', content: prompt }
    ],
    { ...cfg, tokens: Math.min(1500, Math.max(1000, cfg.tokens || 1000)) },
    false,
    new AbortController().signal,
    deadline
  );

  const data = await result.res.json();
  const text = extractReplyText(data);
  if (!text) throw new Error('Training provider returned empty output');

  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch {}
    }
  }
  if (!parsed || !parsed.instruction || !parsed.response) {
    throw new Error('Training provider returned invalid JSON');
  }

  return trainingRecord(modelId, domain, parsed.instruction, parsed.response, {
    source: 'synthetic',
    provider: result.provider,
    provider_model: result.model
  });
}

async function generateTrainingDataset(modelId, targetTokens = TRAINING_MIN_TOKENS) {
  if (!MIROX_MODELS[modelId]) throw new Error(`Unknown model: ${modelId}`);

  targetTokens = Math.max(TRAINING_MIN_TOKENS, safeNumber(targetTokens, TRAINING_MIN_TOKENS));
  const dataset = [];
  let totalTokens = 0;
  let attempts = 0;
  let domainIndex = 0;

  while (totalTokens < targetTokens && dataset.length < TRAINING_MAX_EXAMPLES && attempts < 40) {
    const domain = TRAINING_DOMAINS[domainIndex % TRAINING_DOMAINS.length];
    domainIndex++;
    attempts++;
    try {
      const item = await generateTrainingExample(modelId, domain, attempts);
      const n = estimateTokens(item.instruction + '\n' + item.response);
      if (n > 0) {
        dataset.push(item);
        totalTokens += n;
      }
    } catch (e) {
      console.warn(`[Mirox Training] ${modelId}/${domain}: ${e.message}`);
    }
  }

  return {
    model: modelId,
    target_tokens: targetTokens,
    estimated_tokens: totalTokens,
    examples: dataset.length,
    generated_at: now(),
    records: dataset
  };
}

async function saveTrainingDataset(modelId, dataset) {
  if (!fdb) throw new Error('Firebase not configured');
  const version = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  await safeSetFB(`training/models/${modelId}/latest`, dataset);
  await safeSetFB(`training/models/${modelId}/versions/${version}`, dataset);
  return version;
}

async function loadTrainingDataset(modelId) {
  if (!fdb) return null;
  const data = await safeGetFB(`training/models/${modelId}/latest`);
  return data && Array.isArray(data.records) ? data : null;
}

function trainingContext(dataset, query) {
  if (!dataset?.records?.length || !query) return '';
  const terms = String(query).toLowerCase().split(/[^a-z0-9_+#.-]+/).filter(x => x.length >= 3).slice(0, 80);
  if (!terms.length) return '';

  const scored = dataset.records.map(r => {
    const hay = `${r.category} ${r.instruction} ${r.response}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score++;
    return { r, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);

  let out = '';
  for (const { r } of scored) {
    const block = `[${r.category}]\nInstruction: ${r.instruction}\nResponse: ${r.response}\n`;
    if ((out + block).length > TRAINING_MAX_CONTEXT) break;
    out += block + '\n';
  }
  return out.trim();
}

function imageTrainingRecord(prompt, negativePrompt, settings, description) {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    prompt: normalizeTrainingText(prompt, 4000),
    negative_prompt: normalizeTrainingText(negativePrompt, 2000),
    settings: settings || {},
    description: normalizeTrainingText(description, 4000),
    domains: IMAGE_TRAINING_DOMAINS,
    created_at: now(),
    source: 'prompt-metadata-training'
  };
}

async function saveImageTrainingRecord(record) {
  if (!fdb) throw new Error('Firebase not configured');
  return await safePushFB('training/images', record);
}

/* Admin routes */
app.post('/api/admin/training/generate', async (req, res) => {
  try {
    if (!adminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const modelId = safeString(safeGet(req.body, 'model'), 64);
    const tokens = Math.max(TRAINING_MIN_TOKENS, safeNumber(safeGet(req.body, 'tokens'), TRAINING_MIN_TOKENS));
    const models = modelId ? [modelId] : Object.keys(MIROX_MODELS);
    const results = [];

    for (const id of models) {
      const dataset = await generateTrainingDataset(id, tokens);
      const version = await saveTrainingDataset(id, dataset);
      results.push({ model: id, version, estimated_tokens: dataset.estimated_tokens, examples: dataset.examples });
    }

    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/training/status', async (req, res) => {
  try {
    if (!adminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const out = {};
    for (const id of Object.keys(MIROX_MODELS)) {
      const d = await loadTrainingDataset(id);
      out[id] = d ? {
        estimated_tokens: d.estimated_tokens || 0,
        examples: d.examples || d.records?.length || 0,
        generated_at: d.generated_at || null
      } : null;
    }
    res.json({ ok: true, models: out, minimum_tokens: TRAINING_MIN_TOKENS });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/training/export/:modelId', async (req, res) => {
  try {
    if (!adminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const id = safeString(req.params.modelId, 64);
    if (!MIROX_MODELS[id]) return res.status(404).json({ ok: false, error: 'Unknown model' });
    const d = await loadTrainingDataset(id);
    if (!d) return res.status(404).json({ ok: false, error: 'No training dataset' });

    const lines = d.records.map(r => JSON.stringify({
      messages: [
        { role: 'user', content: r.instruction },
        { role: 'assistant', content: r.response }
      ]
    }));
    res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${id}-training.jsonl"`);
    res.send(lines.join('\n'));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/training/image', async (req, res) => {
  try {
    if (!adminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const prompt = safeString(safeGet(req.body, 'prompt'), 4000).trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'Prompt required' });
    const record = imageTrainingRecord(
      prompt,
      safeString(safeGet(req.body, 'negative_prompt'), 2000),
      safeGet(req.body, 'settings') || {},
      safeString(safeGet(req.body, 'description'), 4000)
    );
    const id = await saveImageTrainingRecord(record);
    res.json({ ok: true, id, record });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* Runtime retrieval: insert immediately after msgs are built in /v1/chat/completions. */
async function injectTrainingContext(msgs, requestedModel, rawMessage) {
  try {
    const dataset = await loadTrainingDataset(requestedModel);
    if (!dataset) return msgs;
    const queryText = safeString(rawMessage, 4000) ||
      safeString(msgs.filter(m => m.role === 'user').map(m => m.content).join('\n'), 4000);
    const learned = trainingContext(dataset, queryText);
    if (!learned) return msgs;
    const systemIndex = msgs.findIndex(m => m.role === 'system');
    if (systemIndex >= 0) {
      msgs[systemIndex] = {
        ...msgs[systemIndex],
        content: msgs[systemIndex].content +
          '\n\n--- MIROX LEARNED KNOWLEDGE ---\n' + learned +
          '\n--- END LEARNED KNOWLEDGE ---'
      };
    }
    return msgs;
  } catch (e) {
    console.warn('[Mirox Training] retrieval skipped:', e.message);
    return msgs;
  }
}

/*
 * In /v1/chat/completions, after msgs has been constructed, add:
 *
 * msgs = await injectTrainingContext(msgs, requestedModel, rawMessage);
 *
 * This keeps normal inference limits unchanged.
 */
