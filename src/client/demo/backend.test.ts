import { describe, expect, it } from 'vitest';
import type { SyncResponse } from '@shared/types';
import { DEMO_CREDENTIALS } from '../lib/runtime';
import { createDemoBackend } from './backend';

const ORIGIN = 'http://demo.local';
const JSON_HEADERS = { 'content-type': 'application/json' };

function send(backend: ReturnType<typeof createDemoBackend>, path: string, init?: RequestInit): Promise<Response> {
    return backend.fetch(new Request(`${ORIGIN}${path}`, init));
}

async function signIn(backend: ReturnType<typeof createDemoBackend>): Promise<void> {
    const response = await send(backend, '/api/auth/login', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(DEMO_CREDENTIALS),
    });
    expect(response.status).toBe(200);
}

describe('demo sync', () => {
    it('marks the facet snapshot complete only when the payload actually carries it', async () => {
        const backend = createDemoBackend();
        await signIn(backend);
        const folderId = `01j${'0'.repeat(22)}1`;
        const created = await send(backend, '/api/folders', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ id: folderId, name: 'Inbox', parentId: null }),
        });
        expect(created.status).toBe(201);

        const changed = await (await send(backend, '/api/sync?since=0')).json() as SyncResponse;
        expect(changed.full).toBe(true);
        expect(changed.facetsFull).toBe(true);
        expect(changed.folders.map((folder) => folder.id)).toContain(folderId);

        // 追齐请求不带 facet 数据，仍声明 facetsFull 会让客户端清空 folders/tags 并踢回「所有笔记」。
        const unchanged = await (await send(backend, `/api/sync?since=${changed.cursor}`)).json() as SyncResponse;
        expect(unchanged.full).toBe(false);
        expect(unchanged.facetsFull).toBe(false);
        expect(unchanged.folders).toEqual([]);
        expect(unchanged.tags).toEqual([]);
    });
});
