import fs from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const [fixturePath, auditPath] = process.argv.slice(2);
if (!fixturePath || !auditPath) throw new Error('Fixture and audit paths are required.');

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const server = new McpServer({ name: 'command-eve-bonsai-eval', version: '1.0.0' });

server.tool(
  'lookup_case',
  'Look up the current operational case. Use the returned facts exactly; do not invent replacements.',
  {
    case_id: z.string().describe('The exact case ID requested by the user.'),
  },
  async ({ case_id }) => {
    fs.appendFileSync(auditPath, `${JSON.stringify({ called_at: new Date().toISOString(), case_id })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (case_id !== fixture.case_id) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'case_not_found' }) }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(fixture) }],
    };
  }
);

await server.connect(new StdioServerTransport());
