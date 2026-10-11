import { describe, expect, it } from 'vitest';
import { renderChangelog } from '../../../scripts/api-changelog.mjs';

describe('API changelog', () => {
  it('diffs operation semantics, inherited parameters and nested component fields without order noise', () => {
    const before = { paths: { '/a': { parameters: [{ name: 'id' }], get: { responses: { '200': { description: 'ok' } } }, delete: {} } }, components: { schemas: { Item: { required: ['amount'], properties: { amount: { type: 'integer' }, old: { type: 'string' }, nested: { type: 'object', properties: { value: { type: 'number' } } } } } } } };
    const after = { paths: { '/a': { parameters: [{ name: 'key' }], get: { responses: { '200': { description: 'ok' } } }, post: {} } }, components: { schemas: { Item: { properties: { amount: { type: 'string' }, added: { type: 'boolean' }, nested: { type: 'object', properties: { value: { type: 'string' } } } } } } } };
    const out = renderChangelog(before, after);
    for (const value of ['Operations added', 'POST /a', 'Operations removed', 'DELETE /a', 'Operations changed', 'GET /a', 'Item.added', 'Item.old', 'Item.nested.value', 'integer (required) → string (optional)']) expect(out).toContain(value);
    expect(renderChangelog({ paths: { '/a': { get: { summary: 'a', description: 'b' } } } }, { paths: { '/a': { get: { description: 'b', summary: 'a' } } } })).toContain('No operation');
  });
  it('follows local schema refs and allOf without recursing forever', () => {
    const doc = { components: { schemas: { Node: { allOf: [{ properties: { value: { type: 'string' } } }, { properties: { next: { $ref: '#/components/schemas/Node' } } }] } } } };
    expect(renderChangelog({}, doc)).toContain('Node.value');
    expect(renderChangelog(doc, doc)).toContain('No operation');
  });
});
