import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let prompt = '';
for await (const line of lines) prompt += `${line}\n`;
const trimmed = prompt.trim();
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
emit({ type: 'thread.started', thread_id: 'synthetic-local-thread' });
emit({ type: 'turn.started' });
emit({ type: 'item.started', item: { id: 'synthetic-1', type: 'analysis', status: 'in_progress' } });
emit({ type: 'item.completed', item: { id: 'synthetic-1', type: 'agent_message', text: `Lokaler Testagent hat eine Aufgabe mit ${trimmed.length} Zeichen verarbeitet. Es wurden keine externen Tools oder Netzwerke verwendet.` } });
emit({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, source: 'synthetic' } });
