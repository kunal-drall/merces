import { describe, expect, it } from 'vitest';
import { buildSpec } from '../src/openapi/build.ts';
import { publicTermsSchema } from '../../services/src/terms/service.ts';

describe('draft terms OpenAPI integration', () => {
  it('documents every accepted public input, including fields with defaults', () => {
    const spec = buildSpec();
    const schema = spec.components!.schemas!.PublicDraftTerms as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(publicTermsSchema.shape).sort());
    expect(schema.required.sort()).toEqual(Object.entries(publicTermsSchema.shape).filter(([, field]) => !field.safeParse(undefined).success).map(([key]) => key).sort());
  });
  it('uses the same schema for validation and saving a draft', () => {
    const spec = buildSpec() as any;
    for (const [path, method] of [['/terms/validate', 'post'], ['/drafts/{draftId}/terms', 'put']] as const) {
      expect(spec.paths[path][method].requestBody.content['application/json'].schema.properties.public)
        .toEqual({ $ref: '#/components/schemas/PublicDraftTerms' });
    }
  });
});
