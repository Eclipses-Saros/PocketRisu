import type { AdapterStreamEvent } from './types'

export async function* parseSseStream(
    input: ReadableStream<Uint8Array>,
): AsyncGenerator<AdapterStreamEvent, void, void> {
    const reader = input.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            for (const ev of drainEvents(buffer, false)) yield ev
            buffer = remainderAfterDrain(buffer)
        }
        buffer += decoder.decode()
        for (const ev of drainEvents(buffer, true)) yield ev
    } finally {
        reader.releaseLock()
    }
}

export function parseSseEventBlock(raw: string): AdapterStreamEvent | null {
    if (raw.length === 0) return null
    const lines = raw.split(/\r\n|\n|\r/)
    let eventName: string | undefined
    let id: string | undefined
    const dataLines: string[] = []
    let sawField = false

    for (const line of lines) {
        if (line.length === 0) continue
        if (line.startsWith(':')) continue
        sawField = true
        const colonIdx = line.indexOf(':')
        let field: string
        let value: string
        if (colonIdx === -1) {
            field = line
            value = ''
        } else {
            field = line.slice(0, colonIdx)
            value = line.slice(colonIdx + 1)
            if (value.startsWith(' ')) value = value.slice(1)
        }
        switch (field) {
            case 'event':
                eventName = value
                break
            case 'data':
                dataLines.push(value)
                break
            case 'id':
                id = value
                break
            case 'retry':
            default:
                break
        }
    }

    if (!sawField) return null
    return {
        event: eventName,
        data: dataLines.join('\n'),
        id,
    }
}

function* drainEvents(buffer: string, flushTrailing: boolean): Generator<AdapterStreamEvent, void, void> {
    let scan = buffer
    while (true) {
        const boundary = findEventBoundary(scan)
        if (boundary === null) {
            if (flushTrailing && scan.length > 0) {
                const ev = parseSseEventBlock(scan)
                if (ev) yield ev
            }
            return
        }
        const raw = scan.slice(0, boundary.start)
        scan = scan.slice(boundary.end)
        const ev = parseSseEventBlock(raw)
        if (ev) yield ev
    }
}

function remainderAfterDrain(buffer: string): string {
    let scan = buffer
    while (true) {
        const boundary = findEventBoundary(scan)
        if (boundary === null) return scan
        scan = scan.slice(boundary.end)
    }
}

function findEventBoundary(buffer: string): { start: number; end: number } | null {
    let best: { start: number; end: number } | null = null
    for (const delim of ['\r\n\r\n', '\n\n', '\r\r']) {
        const idx = buffer.indexOf(delim)
        if (idx !== -1 && (best === null || idx < best.start)) {
            best = { start: idx, end: idx + delim.length }
        }
    }
    return best
}
