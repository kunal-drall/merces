import { z } from 'zod';
import { eventPayloads, domainEventSchema } from './events.ts';
import { commandGroups } from './commands.ts';

/** Machine-readable schema for DOMAIN_EVENTS.md (JSON Schema draft 2020-12), generated from the zod sources. */
export function domainJsonSchema(): Record<string, unknown> {
  const events: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(eventPayloads)) events[name] = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  const commands: Record<string, unknown> = {};
  for (const { commands: group } of commandGroups) {
    for (const [name, schema] of Object.entries(group)) commands[name] = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://merces.dev/schema/domain-v0.json',
    title: 'Merces canonical domain model v0',
    version: '0.4.0',
    envelope: z.toJSONSchema(domainEventSchema, { target: 'draft-2020-12' }),
    events,
    commands,
  };
}
