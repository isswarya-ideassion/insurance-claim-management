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
  'Set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY=<your key> in server/.env (never in client/.env), then restart the API.',
  'Optional: AI_MODEL (default claude-opus-5-5), AI_TIMEOUT_MS (default 90000), AI_MAX_RETRIES (default 2).',
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

export function createAiProvider(config) {
  return config.AI_PROVIDER === 'anthropic' ? createAnthropicProvider(config) : createDisabledProvider()
}

export function aiStatus(provider) {
  return {
    configured: provider.configured,
    provider: provider.name,
    model: provider.model,
    setup: provider.configured ? [] : AI_SETUP_INSTRUCTIONS,
  }
}
