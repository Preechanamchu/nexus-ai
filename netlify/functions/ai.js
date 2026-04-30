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
- If the user asks to create, generate, or draw an image (e.g., "สร้างภาพ...", "draw a..."), you MUST respond with a markdown image using this exact format: ![description](https://image.pollinations.ai/prompt/description?width=3840&height=2160&nologo=true&enhance=true&seed=RANDOM_NUMBER). 
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

  // Add system instruction as first user message (Gemini doesn't have system role in contents)
  // We use systemInstruction field instead
  if (history && history.length) {
    history.forEach(msg => {
      // Skip system messages — handled via systemInstruction
      if (msg.role === 'system') return;
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

  const MAX_RETRIES = 5;
  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          contents,
          systemInstruction: {
            parts: [{ text: DEFAULT_SYSTEM_PROMPT }]
          },
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 4096,
          }
        })
      });

      const responseText = await response.text();
      let data;

      try {
        data = JSON.parse(responseText);
      } catch (e) {
        throw new Error('ระบบได้รับข้อมูลที่ไม่ถูกต้องจาก Google API กรุณาลองใหม่อีกครั้ง');
      }

      if (data.error) {
        const status = data.error.status;
        const msg = data.error.message || '';

        // Retry on Quota / Rate Limit / High Demand (429/503)
        if (status === 'UNAVAILABLE' || status === 'RESOURCE_EXHAUSTED' || 
            msg.includes('Quota exceeded') || msg.includes('high demand') || 
            msg.includes('rate') || response.status === 429 || response.status === 503) {
          
          // Extract retry delay from error message if available
          let retryDelay = 2000 * Math.pow(2, attempt); // Exponential: 2s, 4s, 8s, 16s, 32s
          const retryMatch = msg.match(/retry in ([\d.]+)s/i);
          if (retryMatch) {
            retryDelay = Math.ceil(parseFloat(retryMatch[1]) * 1000) + 500;
          }

          console.warn(`[AI] Gemini Rate Limited (Attempt ${attempt + 1}/${MAX_RETRIES}): waiting ${retryDelay}ms`);
          lastError = new Error(`⏳ ระบบมีผู้ใช้งานจำนวนมาก กำลังลองใหม่... (ครั้งที่ ${attempt + 1}/${MAX_RETRIES})`);
          
          if (attempt < MAX_RETRIES - 1) {
            await sleep(retryDelay);
            continue;
          }
          // Final attempt failed
          throw new Error('⚠️ โควต้าฟรีหมดแล้ว ตรวจสอบ สังกัด API KEY');
        }

        if (status === 'NOT_FOUND') {
          throw new Error(`❌ ไม่พบโมเดล '${model.name}' กรุณาตรวจสอบชื่อโมเดลว่าถูกต้อง (เช่น gemini-2.0-flash, gemini-1.5-pro)`);
        }
        if (status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED') {
          throw new Error('🔑 API Key ไม่ถูกต้อง หรือไม่มีสิทธิ์เข้าถึง กรุณาตรวจสอบ API Key ในหน้าแอดมิน');
        }
        throw new Error(`❌ Google API Error: ${msg || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ'}`);
      }

      if (data.candidates && data.candidates[0] && data.candidates[0].content) {
        return data.candidates[0].content.parts[0].text;
      }
      
      // Check for safety filter block
      if (data.candidates && data.candidates[0] && data.candidates[0].finishReason === 'SAFETY') {
        throw new Error('⚠️ คำตอบถูกบล็อกโดยระบบความปลอดภัยของ Google กรุณาลองถามด้วยคำถามอื่น');
      }

      console.error('[AI] Gemini response structure issue:', responseText.substring(0, 500));
      throw new Error('⚠️ Google API ตอบกลับข้อมูลว่าง กรุณาลองใหม่อีกครั้ง');

    } catch (err) {
      lastError = err;
      // Don't retry on non-retryable errors
      if (err.message.includes('❌') || err.message.includes('🔑')) throw err;
      if (attempt === MAX_RETRIES - 1) throw err;
      await sleep(1500 * (attempt + 1));
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
    const errCode = data.error?.code || data.error?.type || '';

    // ตรวจจับ Quota / Rate Limit สำหรับทุก Provider
    if (response.status === 429 || 
        errCode === 'insufficient_quota' || 
        errCode === 'rate_limit_exceeded' ||
        errMsg.toLowerCase().includes('quota') || 
        errMsg.toLowerCase().includes('rate limit') ||
        errMsg.toLowerCase().includes('exceeded') ||
        errMsg.toLowerCase().includes('billing')) {
      throw new Error('⚠️ โควต้าฟรีหมดแล้ว ตรวจสอบ สังกัด API KEY');
    }

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
