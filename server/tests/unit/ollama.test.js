import { describe, expect, it, vi } from 'vitest'
import { createAiProvider, parseModelJson, toOllamaMessage } from '../../src/services/ai.service.js'
import { buildTextPdf, wrapText } from '../../src/utils/pdf.js'

const config = { AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://ollama.test:11434/', OLLAMA_MODEL: 'llama3.1:8b', OLLAMA_VISION_MODEL: 'llama3.2-vision', AI_TIMEOUT_MS: 5000, AI_MAX_RETRIES: 1 }
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })

describe('Ollama provider', () => {
  it('sends the schema as the output format and parses the JSON reply', async () => {
    const fetchImpl = vi.fn(async () => reply({ model: 'llama3.1:8b', message: { content: '```json\n{"ok":true}\n```' }, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }))
    const ai = createAiProvider(config, { fetchImpl })
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } }
    const out = await ai.generateJson({ system: 'S', content: [{ type: 'text', text: 'hello' }], schema })
    expect(out).toEqual({ data: { ok: true }, model: 'llama3.1:8b', usage: { inputTokens: 10, outputTokens: 5 } })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://ollama.test:11434/api/chat')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ model: 'llama3.1:8b', stream: false, format: schema, options: { temperature: 0 } })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' })
  })

  it('uses the vision model for images and refuses PDFs', async () => {
    const fetchImpl = vi.fn(async () => reply({ message: { content: '{}' }, done_reason: 'stop' }))
    const ai = createAiProvider(config, { fetchImpl })
    await ai.generateJson({ system: 'S', content: [{ type: 'image', source: { data: 'aGk=' } }, { type: 'text', text: 'read' }], schema: {} })
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.model).toBe('llama3.2-vision')
    expect(body.messages[1].images).toEqual(['aGk='])
    expect(() => toOllamaMessage([{ type: 'document', source: {} }])).toThrow(/cannot read PDF/)
  })

  it('explains a missing model and an unreachable server', async () => {
    const missing = createAiProvider(config, { fetchImpl: async () => reply({ error: 'model "llama3.1:8b" not found, try pulling it first' }, 404) })
    await expect(missing.generateJson({ system: 'S', content: 'x', schema: {} })).rejects.toMatchObject({ code: 'AI_MODEL_MISSING', message: expect.stringContaining('ollama pull llama3.1:8b') })
    const unpaid = createAiProvider(config, { fetchImpl: async () => reply({ error: 'Add usage credits to use cloud models' }, 402) })
    await expect(unpaid.generateJson({ system: 'S', content: 'x', schema: {} })).rejects.toMatchObject({ code: 'AI_PROVIDER_QUOTA' })
    const down = createAiProvider(config, { fetchImpl: async () => { throw new TypeError('fetch failed') } })
    await expect(down.generateJson({ system: 'S', content: 'x', schema: {} })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' })
  })

  it('retries a server error, and reports a truncated answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply({ error: 'busy' }, 500)).mockResolvedValueOnce(reply({ message: { content: '{"a":1}' }, done_reason: 'length' }))
    const ai = createAiProvider(config, { fetchImpl })
    await expect(ai.generateJson({ system: 'S', content: 'x', schema: {} })).rejects.toMatchObject({ code: 'AI_INCOMPLETE' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(() => parseModelJson('not json')).toThrow(/not valid JSON/)
  })
})

describe('letter PDF', () => {
  it('wraps long text and writes a valid multi-page PDF with rupees as Rs.', () => {
    expect(wrapText('word '.repeat(50), 20).every((l) => l.length <= 20)).toBe(true)
    const pdf = buildTextPdf(`Settlement of ₹7,800\n${'A long line of text. '.repeat(400)}`)
    const text = pdf.toString('latin1')
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text).toContain('Rs. 7,800')
    expect(Number(/\/Count (\d+)/.exec(text)[1])).toBeGreaterThan(1)
  })
})
