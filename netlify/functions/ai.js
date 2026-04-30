const { Pool } = require('pg');

/**
 * AI API Proxy Function (Netlify)
 * Supports multiple providers: Google Gemini, OpenAI, MiMo, DeepSeek, Groq
 */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- Constants & Config ---
const DEFAULT_SYSTEM_PROMPT = `You are Nexus AI, a highly intelligent assistant. 
- If the user asks to create, generate, or draw an image (e.g., "สร้างภาพ...", "draw a..."), you MUST respond with a markdown image using this exact format: ![description](https://image.pollinations.ai/prompt/description?width=1024&height=1024&nologo=true&seed=RANDOM_NUMBER). 
- Replace "description" with a detailed English prompt for the image. 
- Replace "RANDOM_NUMBER" with a random number to ensure unique results.
- Always provide a brief text description along with the image.
- You can answer in any language the user uses.`;

// --- Utility Functions ---

/**
 * Exponential Backoff Sleep
 */
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/**
 * Map internal model names to actual provider model identifiers
 */
function resolveModelName(model) {
  const provider = model.provider.toLowerCase();
  const name = model.name.trim();

  // Google Gemini
  if (provider.includes('google') || provider.includes('gemini')) {
    // Check for common typos or futuristic names
    let cleanName = name.replace(/^models\//i, '');
    if (cleanName.includes('2.5')) cleanName = cleanName.replace('2.5', '1.5'); 
    return `models/${cleanName}`;
  }

  // MiMo / Xiaomi
  if (provider.includes('mimo') || provider.includes('xiaomi')) {
    if (name.includes('pro')) return 'mimo-v2.5-pro';
    if (name.includes('flash')) return 'mimo-v2-flash';
    if (name.includes('2.5')) return 'mimo-v2.5';
    return 'mimo-v2.5';
  }

  // DeepSeek
  if (provider.includes('deepseek')) {
    if (name.includes('coder')) return 'deepseek-coder';
    if (name.includes('r1')) return 'deepseek-reasoner';
    return 'deepseek-chat';
  }

  // Groq
  if (provider.includes('groq')) {
    if (name.includes('llama')) return 'llama-3.3-70b-versatile';
    if (name.includes('mixtral')) return 'mixtral-8x7b-32768';
    return 'llama-3.3-70b-versatile';
  }

  // OpenAI
  if (provider.includes('openai')) {
    if (name.includes('gpt-4o')) return 'gpt-4o';
    if (name.includes('o1')) return 'o1-preview';
    return 'gpt-4o-mini';
  }

  return model.name;
}

// --- Provider Handlers ---

/**
 * Handle Google Gemini (Generative Language API) with Retry Logic
 */
async function handleGoogleGemini(model, prompt, history, apiKey) {
  const actualModelName = resolveModelName(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/${actualModelName}:generateContent?key=${apiKey}`;

  console.log(`[AI] Calling Google Gemini: ${actualModelName}`);

  // Transform messages to Gemini format
  const contents = [];
  if (history && history.length) {
    history.forEach(msg => {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      });
    });
  }
  contents.push({
    role: 'user',
    parts: [{ text: prompt }]
  });

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048,
          }
        })
      });

      const responseText = await response.text();
      let data;

      try {
        data = JSON.parse(responseText);
      } catch (e) {
        throw new Error('Google API returned invalid JSON response.');
      }

      if (data.error) {
        const status = data.error.status;
        const msg = data.error.message || '';

        // Retry on "High Demand" (429/503) or "Internal Error"
        if (status === 'UNAVAILABLE' || status === 'RESOURCE_EXHAUSTED' || msg.includes('high demand') || response.status === 429 || response.status === 503) {
          console.warn(`[AI] Gemini High Demand (Attempt ${attempt + 1}/3): ${msg}`);
          lastError = new Error(`Google API Error: ${msg} (กำลังรอคิวและลองใหม่...)`);
          if (attempt < 2) {
            await sleep(1500 * (attempt + 1)); // Exponential backoff
            continue;
          }
          throw lastError;
        }

        if (status === 'NOT_FOUND') {
          throw new Error(`Google API Error: Model '${actualModelName}' not found. Please ensure the model name is correct (e.g., gemini-1.5-flash, gemini-1.5-pro).`);
        }
        if (status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED') {
          throw new Error('Google API Error: Invalid API Key or Permission Denied.');
        }
        throw new Error(`Google API Error: ${msg || 'Unknown error'}`);
      }

      if (data.candidates && data.candidates[0] && data.candidates[0].content) {
        return data.candidates[0].content.parts[0].text;
      }
      
      console.error('[AI] Gemini response structure issue:', responseText);
      throw new Error('Google API returned an empty or restricted response (Safety Filter).');

    } catch (err) {
      lastError = err;
      if (attempt === 2) throw err;
      await sleep(1000);
    }
  }
  throw lastError;
}

/**
 * Handle OpenAI Compatible APIs (OpenAI, DeepSeek, Groq, MiMo)
 */
async function handleOpenAICompatible(model, prompt, history, apiKey) {
  const provider = model.provider.toLowerCase();
  const actualModelName = resolveModelName(model);

  // Determine Base URL
  let baseUrl = model.base_url || 'https://api.openai.com/v1';
  if (!model.base_url) {
    if (provider.includes('mimo') || provider.includes('xiaomi')) baseUrl = 'https://api.xiaomimimo.com/v1';
    else if (provider.includes('deepseek')) baseUrl = 'https://api.deepseek.com/v1';
    else if (provider.includes('groq')) baseUrl = 'https://api.groq.com/openai/v1';
  }

  baseUrl = baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  console.log(`[AI] Calling OpenAI Compatible (${provider}): ${actualModelName} at ${url}`);

  const requestBody = {
    model: actualModelName,
    messages: [
      { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
      ...(history || []),
      { role: 'user', content: prompt }
    ],
    temperature: 0.7
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  const contentType = response.headers.get('content-type') || '';
  const responseText = await response.text();

  if (!contentType.includes('application/json')) {
    console.error(`[AI] Non-JSON response from ${provider} (${response.status}):`, responseText.substring(0, 500));
    throw new Error(`API returned non-JSON response (HTTP ${response.status}). Check Base URL and API Key.`);
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch (e) {
    throw new Error(`Failed to parse JSON response from ${provider}.`);
  }

  if (data.error) {
    const errMsg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
    throw new Error(`${provider.toUpperCase()} API Error: ${errMsg}`);
  }

  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }

  throw new Error(`${provider.toUpperCase()} API returned unexpected response structure.`);
}

// --- Main Handler ---

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { model_id, prompt, chat_history } = JSON.parse(event.body);

    // 1. Fetch model from DB
    const result = await pool.query('SELECT * FROM api_models WHERE model_id = $1', [model_id]);
    
    if (result.rowCount === 0) {
      return { 
        statusCode: 404, 
        body: JSON.stringify({ error: 'Model configuration not found.' }) 
      };
    }

    const model = result.rows[0];
    const provider = model.provider.toLowerCase();
    const apiKey = model.api_key;

    // 2. Delegate to specific provider handler
    let content = '';
    
    if (provider.includes('google') || provider.includes('gemini')) {
      content = await handleGoogleGemini(model, prompt, chat_history, apiKey);
    } else {
      content = await handleOpenAICompatible(model, prompt, chat_history, apiKey);
    }

    // 3. Return success
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        model_name: model.name,
        model_type: model.model_type
      })
    };

  } catch (error) {
    console.error('[AI Proxy Error]', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'AI Process Failed', 
        details: error.message 
      })
    };
  }
};
