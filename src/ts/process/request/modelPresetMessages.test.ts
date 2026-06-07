import { describe, expect, test, vi } from 'vitest'
import { expandAdapterMessages, toAdapterMessage, toolResponseText, type DecodeToolCall } from './modelPresetMessages'
import type { OpenAIChat } from '../index.svelte'

// A fake store mirroring encodeToolCall/decodeToolCall: a marker
// `<tool_call>ID</tool_call>` resolves to a stored record. Keeps the test free of
// the mcp → database import graph.
function makeDecoder(records: Record<string, { name: string; arg: unknown; text: string }>): DecodeToolCall {
    return async (marker: string) => {
        const id = marker.replace(/^<tool_call>/, '').replace(/<\/tool_call>$/, '').trim()
        const rec = records[id]
        if (!rec) return undefined
        return { call: { id, name: rec.name, arg: rec.arg }, response: [{ type: 'text', text: rec.text }] }
    }
}

describe('expandAdapterMessages', () => {
    test('passes plain messages through unchanged (no tool markers)', async () => {
        const formated: OpenAIChat[] = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ]
        const out = await expandAdapterMessages(formated, makeDecoder({}))
        expect(out).toEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ])
    })

    test('restores a persisted <tool_call> marker into assistant{toolCalls} + tool{result}', async () => {
        const decode = makeDecoder({ 'call-1': { name: 'search', arg: { q: 'x' }, text: 'found it' } })
        const formated: OpenAIChat[] = [
            { role: 'user', content: 'find x' },
            { role: 'assistant', content: 'sure<tool_call>call-1</tool_call>' },
        ]
        const out = await expandAdapterMessages(formated, decode)
        expect(out).toEqual([
            { role: 'user', content: 'find x' },
            { role: 'assistant', content: 'sure', toolCalls: [{ id: 'call-1', name: 'search', arguments: '{"q":"x"}' }] },
            { role: 'tool', content: 'found it', toolCallId: 'call-1', name: 'search' },
        ])
    })

    test('keeps an undecodable marker as literal text (no fabricated tool call)', async () => {
        const formated: OpenAIChat[] = [
            { role: 'assistant', content: 'pre<tool_call>missing</tool_call>post' },
        ]
        const out = await expandAdapterMessages(formated, makeDecoder({}))
        // No decode → marker stays inline, no tool-role message invented.
        expect(out).toHaveLength(1)
        expect(out[0].role).toBe('assistant')
        expect(out[0].content).toContain('<tool_call>missing</tool_call>')
        expect(out[0].toolCalls).toBeUndefined()
    })

    test('classic↔preset history is interchangeable (multiple markers in one turn)', async () => {
        const decode = makeDecoder({
            a: { name: 'roll', arg: {}, text: '6' },
            b: { name: 'roll', arg: {}, text: '3' },
        })
        const formated: OpenAIChat[] = [
            { role: 'assistant', content: 'rolling<tool_call>a</tool_call>and<tool_call>b</tool_call>done' },
        ]
        const out = await expandAdapterMessages(formated, decode)
        // text → call → result → text → call → result → trailing text
        expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'assistant'])
        expect(out[1]).toMatchObject({ toolCallId: 'a', content: '6' })
        expect(out[3]).toMatchObject({ toolCallId: 'b', content: '3' })
        expect(out[4]).toMatchObject({ role: 'assistant', content: 'done' })
    })

    test('decode is only invoked for assistant turns containing a marker', async () => {
        const decode = vi.fn(makeDecoder({}))
        await expandAdapterMessages([
            { role: 'user', content: 'has <tool_call>x</tool_call> but is user' },
            { role: 'assistant', content: 'no marker here' },
        ], decode)
        expect(decode).not.toHaveBeenCalled()
    })
})

describe('toAdapterMessage / toolResponseText', () => {
    test('maps the function role to tool', () => {
        expect(toAdapterMessage({ role: 'function', content: 'r', name: 'x' } as OpenAIChat))
            .toEqual({ role: 'tool', content: 'r', name: 'x' })
    })

    test('joins only text content blocks', () => {
        expect(toolResponseText([
            { type: 'text', text: 'a' },
            { type: 'image', data: 'zzz', mimeType: 'image/png' },
            { type: 'text', text: 'b' },
        ])).toBe('a\nb')
    })
})
