import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const skillRoot = path.resolve(process.cwd(), 'resources/bundled-skills/presentation-studio');
const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');

describe('presentation-studio Hermes skill', () => {
  it('routes redesigns through the three-direction Human Gate', () => {
    expect(skill).toContain('invoke `visual-direction-gate` first');
    expect(skill).toContain('label them 1, 2, and 3');
    expect(skill).toMatch(/wait for the user.+selection/i);
    expect(skill).toContain('Do not silently choose a direction');
  });

  it('keeps PowerPoint output editable and validates every finished slide', () => {
    expect(skill).toMatch(/complete editable deck/i);
    expect(skill).toMatch(/Never flatten a complete slide into a screenshot/i);
    expect(skill).toMatch(/Render every finished slide/i);
    expect(skill).toMatch(/reopen it before delivery/i);
  });

  it('hides implementation dependencies and never routes routine work to Ollama', () => {
    expect(skill).toMatch(/never ask a consumer to install OfficeCLI/i);
    expect(skill).toMatch(/must not trigger an Ollama or installation prompt/i);
    expect(skill).not.toMatch(/curl\s+[^\n]*\|\s*(?:ba)?sh/i);
  });

  it('ships discovery metadata next to the executable skill', () => {
    const metadata = fs.readFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8');
    expect(metadata).toMatch(/display_name:\s+['"]Presentation Studio['"]/);
    expect(metadata).toContain('$presentation-studio');
  });
});
