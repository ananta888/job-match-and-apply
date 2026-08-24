#!/usr/bin/env node
import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write('acp-synthetic 0.1.0\n');
  process.exit(0);
}

const holdPrompt = process.argv.includes('--hold-prompt');
let cancelled = false;
let pendingPrompt;

const write = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const completePrompt = (message) => {
  const sessionId = message.params?.sessionId ?? 'sess-synthetic';
  write({
    jsonrpc: '2.0', method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'synthetic acp result' },
      },
    },
  });
  write({
    jsonrpc: '2.0', id: message.id,
    result: { stopReason: cancelled ? 'cancelled' : 'end_turn' },
  });
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try { message = JSON.parse(trimmed); } catch { return; }
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (message.method === 'session/cancel') {
    cancelled = true;
    if (pendingPrompt) {
      completePrompt(pendingPrompt);
      pendingPrompt = undefined;
    }
    return;
  }
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    write({
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        agentInfo: { name: 'acp-synthetic', title: 'Synthetic ACP', version: '0.1.0' },
        authMethods: [],
      },
    });
    return;
  }
  if (message.method === 'session/new') {
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess-synthetic' } });
    return;
  }
  if (message.method === 'session/prompt') {
    if (holdPrompt && !cancelled) {
      pendingPrompt = message;
      return;
    }
    completePrompt(message);
  }
});
