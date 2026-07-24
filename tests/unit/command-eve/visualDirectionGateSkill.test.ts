import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const skillRoot = path.resolve(process.cwd(), 'resources/bundled-skills/visual-direction-gate');
const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');

describe('visual-direction-gate Hermes skill', () => {
  it('owns the three-option selection loop instead of requiring a Desktop state machine', () => {
    expect(skill).toContain('Use the built-in `aionui_image_generation` tool exactly three times.');
    expect(skill).toContain('Then ask only which direction to build: `1, 2 oder 3?`');
    expect(skill).toContain('Do not start the build');
    expect(skill).toContain('The selected image governs typography roles');
  });

  it('shows real local image artifacts and never falls back to an Ollama install', () => {
    expect(skill).toContain('![Richtung 1](/absolute/path/to/first.png)');
    expect(skill).toContain('![Richtung 2](/absolute/path/to/second.png)');
    expect(skill).toContain('![Richtung 3](/absolute/path/to/third.png)');
    expect(skill).toContain('Never install Ollama for this managed design-direction workflow.');
  });

  it('ships its discovery metadata next to the executable SKILL.md', () => {
    const metadata = fs.readFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8');
    expect(metadata).toMatch(/display_name:\s+['"]Visual Direction Gate['"]/);
    expect(metadata).toContain('$visual-direction-gate');
  });
});
