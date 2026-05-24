import { describe, expect, test } from 'vitest'
import { parseSseEventBlock, parseSseStream } from './sse'

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let i = 0
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(encoder.encode(chunks[i]))
                i++
            } else {
                controller.close()
            }
        },
    })
}

async function collect<T>(gen: AsyncGenerator<T, void, void>): Promise<T[]> {
    const out: T[] = []
    for await (const ev of gen) out.push(ev)
    return out
}

describe('parseSseEventBlock', () => {
    test('parses event/data/id fields with single-space prefix trim', () => {
        const ev = parseSseEventBlock('event: message\ndata: hello\nid: 1')
        expect(ev).toEqual({ event: 'message', data: 'hello', id: '1' })
    })

    test('joins multi-line data with \\n', () => {
        const ev = parseSseEventBlock('data: line1\ndata: line2')
        expect(ev?.data).toBe('line1\nline2')
    })

    test('ignores comment lines starting with colon', () => {
        const ev = parseSseEventBlock(': ping\ndata: ok')
        expect(ev).toEqual({ event: undefined, data: 'ok', id: undefined })
    })

    test('returns null for empty or comment-only blocks', () => {
        expect(parseSseEventBlock('')).toBeNull()
        expect(parseSseEventBlock(': heartbeat')).toBeNull()
    })

    test('treats field-with-no-colon as field with empty value', () => {
        const ev = parseSseEventBlock('data')
        expect(ev?.data).toBe('')
    })

    test('ignores unknown fields and retry', () => {
        const ev = parseSseEventBlock('retry: 1000\nxyz: 1\ndata: ok')
        expect(ev?.data).toBe('ok')
    })
})

describe('parseSseStream', () => {
    test('yields events delimited by blank lines (\\n\\n)', async () => {
        const stream = streamFromChunks([
            'event: message\ndata: hello\n\n',
            'data: world\n\n',
        ])
        const events = await collect(parseSseStream(stream))
        expect(events).toEqual([
            { event: 'message', data: 'hello', id: undefined },
            { event: undefined, data: 'world', id: undefined },
        ])
    })

    test('handles CRLF event boundaries', async () => {
        const stream = streamFromChunks(['data: one\r\n\r\ndata: two\r\n\r\n'])
        const events = await collect(parseSseStream(stream))
        expect(events.map((e) => e.data)).toEqual(['one', 'two'])
    })

    test('handles chunks that split an event mid-line', async () => {
        const stream = streamFromChunks(['data: hel', 'lo\n\n'])
        const events = await collect(parseSseStream(stream))
        expect(events).toEqual([{ event: undefined, data: 'hello', id: undefined }])
    })

    test('handles chunks that split the boundary across reads', async () => {
        const stream = streamFromChunks(['data: a\n', '\ndata: b\n\n'])
        const events = await collect(parseSseStream(stream))
        expect(events.map((e) => e.data)).toEqual(['a', 'b'])
    })

    test('flushes trailing event without final blank line', async () => {
        const stream = streamFromChunks(['data: trailing'])
        const events = await collect(parseSseStream(stream))
        expect(events).toEqual([{ event: undefined, data: 'trailing', id: undefined }])
    })

    test('handles \\r\\r boundary', async () => {
        const stream = streamFromChunks(['data: x\r\rdata: y\r\r'])
        const events = await collect(parseSseStream(stream))
        expect(events.map((e) => e.data)).toEqual(['x', 'y'])
    })

    test('ignores empty boundary-only fragments', async () => {
        const stream = streamFromChunks(['\n\n', 'data: only\n\n'])
        const events = await collect(parseSseStream(stream))
        expect(events.map((e) => e.data)).toEqual(['only'])
    })
})
