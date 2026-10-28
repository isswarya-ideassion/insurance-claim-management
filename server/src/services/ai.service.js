import Anthropic from '@anthropic-ai/sdk'
import { AppError } from '../utils/errors.js'

/**
 * AI provider abstraction used by the automation module. Every provider exposes
 * `generateJson({ system, content, schema, effort, maxTokens })` and returns
 * `{ data, usage, model }` where `data` is parsed JSON that the caller must
 * still validate. Providers never take actions: no tools are offered to the model.
 */

export const AI_SETUP_INSTRUCTIONS = [
  'AI automation is not configured, so no AI results are produced.',
  'Local models: install Ollama, run "ollama pull llama3.1:8b", then set AI_PROVIDER=ollama in server/.env (optional: OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_VISION_MODEL) and restart the API.',
  'Claude API: set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY=<your key> in server/.env (never in client/.env), then restart the API.',
  'Optional: AI_MODEL (Claude model, default claude-opus-5-5), AI_TIMEOUT_MS (default 90000), AI_MAX_RETRIES (default 2).',
  'Missing-document checks and deadline reminders are rule-based and keep working without an AI provider.',
]

export function aiNotConfigured() {
  return new AppError(503, 'AI_NOT_CONFIGURED', 'AI automation is not configured on this server.', {
    setup: AI_SETUP_INSTRUCTIONS,
  })
}

export const aiError = (status, code, message, retryable = false) =>
  new AppError(status, code, message, { retryable })

function createDisabledProvider() {
  return {
    name: 'none',
    model: null,
    configured: false,
    async generateJson() {
      throw aiNotConfigured()
    },
  }
}

function createAnthropicProvider(config) {
  const client = new Anthropic({
    // Undefined lets the SDK resolve credentials from its standard environment sources.
    apiKey: config.ANTHROPIC_API_KEY || undefined,
    timeout: config.AI_TIMEOUT_MS,
    maxRetries: config.AI_MAX_RETRIES,
  })

  return {
    name: 'anthropic',
    model: config.AI_MODEL,
    configured: true,
    async generateJson({ system, content, schema, effort = 'medium', maxTokens = 16000 }) {
      let response
      try {
        response = await client.beta.messages.create({
          model: config.AI_MODEL,
          max_tokens: maxTokens,
          // Re-run a safety-declined request on Anthropic's recommended fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system,
          messages: [{ role: 'user', content }],
          output_config: { effort, format: { type: 'json_schema', schema } },
        })
      } catch (err) {
        throw mapAnthropicError(err)
      }

      if (response.stop_reason === 'refusal') {
        throw aiError(422, 'AI_REFUSED', 'The AI service declined to process this request. Review the material manually.')
      }
      if (response.stop_reason === 'max_tokens') {
        throw aiError(502, 'AI_INCOMPLETE', 'The AI response was cut off before it finished. Try again.', true)
      }
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw aiError(502, 'AI_INVALID_OUTPUT', 'The AI service returned a response that is not valid JSON.', true)
      }
      return {
        data,
        model: response.model,
        usage: { inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null },
      }
    },
  }
}

/** Maps SDK errors (most specific first) to API errors. Messages never echo provider payloads. */
export function mapAnthropicError(err) {
  if (err instanceof AppError) return err
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return aiError(504, 'AI_TIMEOUT', 'The AI service did not respond in time. Try again.', true)
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return aiError(503, 'AI_UNAVAILABLE', 'The AI service could not be reached. Try again shortly.', true)
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return aiError(502, 'AI_PROVIDER_AUTH', 'The AI service rejected the server credentials. An administrator must check ANTHROPIC_API_KEY.')
  }
  if (err instanceof Anthropic.RateLimitError) {
    return aiError(503, 'AI_RATE_LIMITED', 'The AI service is busy. Try again in a minute.', true)
  }
  if (err instanceof Anthropic.BadRequestError) {
    return aiError(502, 'AI_BAD_REQUEST', 'The AI service could not process this input (for example an unreadable or oversized file).')
  }
  if (err instanceof Anthropic.APIError) {
    const retryable = !err.status || err.status >= 500
    return aiError(502, 'AI_PROVIDER_ERROR', 'The AI service returned an error.', retryable)
  }
  return aiError(502, 'AI_PROVIDER_ERROR', 'The AI request failed unexpectedly.', true)
}

/** Splits provider-neutral content blocks into Ollama's text and base64 images. */
export function toOllamaMessage(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  const text = []
  const images = []
  for (const block of blocks) {
    if (block.type === 'text') text.push(block.text)
    else if (block.type === 'image') images.push(block.source.data)
    else {
      throw aiError(422, 'AI_UNSUPPORTED_INPUT', 'The local AI model cannot read PDF files. Upload the document as an image (JPEG, PNG or WebP), or review it manually.')
    }
  }
  return { content: text.join('\n\n'), images }
}

/** Small local models sometimes wrap JSON in a Markdown code fence; accept that, nothing else. */
export function parseModelJson(text) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')
  try {
    return JSON.parse(trimmed)
  } catch {
    throw aiError(502, 'AI_INVALID_OUTPUT', 'The AI service returned a response that is not valid JSON.', true)
  }
}

/**
 * Ollama (local models). Structured output: the JSON schema is passed as
 * `format`, so the model is constrained to it; the caller still validates.
 */
function createOllamaProvider(config, fetchImpl = globalThis.fetch) {
  const baseUrl = config.OLLAMA_BASE_URL.replace(/\/+$/, '')

  async function call(body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.AI_TIMEOUT_MS)
    let res
    try {
      res = await fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(config.OLLAMA_API_KEY ? { authorization: `Bearer ${config.OLLAMA_API_KEY}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      if (err?.name === 'AbortError') throw aiError(504, 'AI_TIMEOUT', 'The local AI model did not respond in time. Try again, or use a smaller model.', true)
      throw aiError(503, 'AI_UNAVAILABLE', `Ollama could not be reached at ${baseUrl}. Start it with "ollama serve" and try again.`, true)
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (res.status === 404 && /not found/i.test(detail)) {
        throw aiError(502, 'AI_MODEL_MISSING', `The model "${body.model}" is not installed in Ollama. Run: ollama pull ${body.model}`)
      }
      if (res.status === 402) {
        throw aiError(503, 'AI_PROVIDER_QUOTA', 'The Ollama account has no usage credits left. An administrator must add credits at ollama.com/plans.')
      }
      if (res.status === 401 || res.status === 403) {
        throw aiError(502, 'AI_PROVIDER_AUTH', 'The Ollama server rejected the request. An administrator must check OLLAMA_API_KEY.')
      }
      throw aiError(502, 'AI_PROVIDER_ERROR', 'The local AI service returned an error.', res.status >= 500)
    }
    return res.json()
  }

  return {
    name: 'ollama',
    model: config.OLLAMA_MODEL,
    configured: true,
    async generateJson({ system, content, schema, maxTokens = 4096 }) {
      const message = toOllamaMessage(content)
      const model = message.images.length ? config.OLLAMA_VISION_MODEL : config.OLLAMA_MODEL
      const body = {
        model,
        stream: false,
        format: schema,
        options: { temperature: 0, num_predict: Math.min(maxTokens, 8192) },
        messages: [
          { role: 'system', content: `${system}\n\nRespond with a single JSON object that matches the required schema. No other text.` },
          { role: 'user', content: message.content, ...(message.images.length ? { images: message.images } : {}) },
        ],
      }
      let response
      for (let attempt = 0; ; attempt += 1) {
        try {
          response = await call(body)
          break
        } catch (err) {
          if (!err.details?.retryable || attempt >= config.AI_MAX_RETRIES || err.code === 'AI_UNAVAILABLE') throw err
        }
      }
      if (response.done_reason === 'length') {
        throw aiError(502, 'AI_INCOMPLETE', 'The AI response was cut off before it finished. Try again.', true)
      }
      return {
        data: parseModelJson(response.message?.content),
        model: response.model || model,
        usage: { inputTokens: response.prompt_eval_count ?? null, outputTokens: response.eval_count ?? null },
      }
    },
  }
}

export function createAiProvider(config, { fetchImpl } = {}) {
  if (config.AI_PROVIDER === 'anthropic') return createAnthropicProvider(config)
  if (config.AI_PROVIDER === 'ollama') return createOllamaProvider(config, fetchImpl)
  return createDisabledProvider()
}

export function aiStatus(provider) {
  return {
    configured: provider.configured,
    provider: provider.name,
    model: provider.model,
    setup: provider.configured ? [] : AI_SETUP_INSTRUCTIONS,
  }
}
